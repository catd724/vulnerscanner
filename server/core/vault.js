'use strict';

/**
 * terminal.ai - vault lifecycle.
 *
 * Holds the derived master key in process memory only. Nothing here ever
 * returns a decrypted secret to an HTTP response; only the SSH layer calls
 * open() and it hands the result straight to ssh2.
 */

const { EventEmitter } = require('events');
const db = require('./db');
const crypto = require('./crypto');
const totp = require('./totp');

const DEFAULT_AUTOLOCK_MINUTES = 0; // 0 = never

/** A rejected credential, not a server fault: the API layer answers 400. */
function authError(message, code) {
  const err = new Error(message);
  err.code = code;
  err.status = 400;
  return err;
}

class Vault extends EventEmitter {
  constructor() {
    super();
    this.key = null;
    this.autoLockTimer = null;
    this.autoLockMinutes = DEFAULT_AUTOLOCK_MINUTES;
    // Enrolment secret, held only between "show me the setup key" and the
    // confirming code. Never written to disk until a code proves the phone
    // actually has it, so a half-finished setup cannot lock anyone out.
    this.pendingTotpSecret = null;
  }

  get isUnlocked() {
    return this.key !== null;
  }

  async isInitialised() {
    await db.init();
    const row = await db.get('SELECT id FROM vault_meta WHERE id = 1');
    return !!row;
  }

  async meta() {
    await db.init();
    return db.get('SELECT * FROM vault_meta WHERE id = 1');
  }

  async status() {
    const meta = await this.meta();
    return {
      initialised: !!meta,
      unlocked: this.isUnlocked,
      autoLockMinutes: this.autoLockMinutes,
      // The gate needs this before anyone authenticates, so it can ask for the
      // code in the same submit rather than bouncing the user twice.
      totpEnabled: !!(meta && meta.totpBlob),
    };
  }

  /** First-run setup. Fails loudly rather than silently re-keying an existing vault. */
  async initialise(masterPassword) {
    await db.init();
    if (await this.isInitialised()) {
      throw new Error('Vault is already initialised');
    }
    if (!masterPassword || String(masterPassword).length < 4) {
      throw new Error('Master password must be at least 4 characters');
    }

    const salt = crypto.randomSalt();
    const key = await crypto.deriveKey(masterPassword, salt);
    const verifier = crypto.makeVerifier(key);

    await db.run(
      `INSERT INTO vault_meta (id, kdf, kdf_salt, kdf_params, verifier)
       VALUES (1, ?, ?, ?, ?)`,
      [crypto.KDF, salt, JSON.stringify(crypto.KDF_PARAMS), verifier]
    );

    this.key = key;
    this.armAutoLock();
    this.emit('unlocked');
    return true;
  }

  /**
   * Unlock with the master password, plus a Google Authenticator code when the
   * second factor is enrolled. The code is checked after the password, against
   * a secret that only the password could decrypt - so 2FA cannot be stripped
   * by editing the database, and a stolen phone alone gets nowhere.
   */
  async unlock(masterPassword, code = null) {
    await db.init();
    const meta = await db.get('SELECT * FROM vault_meta WHERE id = 1');
    if (!meta) throw new Error('Vault is not initialised');

    const params = JSON.parse(meta.kdf_params);
    const key = await crypto.deriveKey(masterPassword, meta.kdf_salt, params);

    if (!crypto.checkVerifier(key, meta.verifier)) {
      throw new Error('Incorrect master password');
    }

    if (meta.totpBlob) {
      const secret = crypto.decryptJson(key, meta.totpBlob).secret;
      if (!code) {
        throw authError(
          'A verification code from your authenticator app is required',
          'TOTP_REQUIRED'
        );
      }
      if (!totp.verify(secret, code)) {
        throw authError('Incorrect verification code', 'TOTP_INVALID');
      }
    }

    this.key = key;
    this.armAutoLock();
    this.emit('unlocked');
    return true;
  }

  /* --- second factor ------------------------------------------------------ */

  /**
   * Start enrolment: mint a secret and hand back the setup key plus the
   * otpauth:// URI. Nothing is stored until enableTotp() sees a working code.
   */
  beginTotpEnrolment(account = 'vault') {
    this.requireKey();
    this.pendingTotpSecret = totp.generateSecret();
    const uri = totp.otpauthUri({ secret: this.pendingTotpSecret, account });
    return {
      secret: this.pendingTotpSecret,
      uri,
      // Rendered here rather than in the browser: the QR is just the URI in
      // another encoding, and drawing it server-side keeps the secret out of
      // one more layer of client-side code.
      qr: totp.qrDataUri(uri),
      digits: totp.DEFAULT_DIGITS,
      step: totp.DEFAULT_STEP,
    };
  }

  /** Finish enrolment by proving the authenticator app holds the same secret. */
  async enableTotp(code) {
    const key = this.requireKey();
    if (!this.pendingTotpSecret) {
      throw new Error('Start two-factor setup before confirming a code');
    }
    if (!totp.verify(this.pendingTotpSecret, code)) {
      throw authError('That code does not match - check your app and try again', 'TOTP_INVALID');
    }

    await db.run('UPDATE vault_meta SET totpBlob = ? WHERE id = 1', [
      crypto.encryptJson(key, { secret: this.pendingTotpSecret, enrolledAt: Date.now() }),
    ]);
    this.pendingTotpSecret = null;
    return this.status();
  }

  /** Turning the second factor off needs both factors, like any other unlock. */
  async disableTotp(masterPassword, code) {
    this.requireKey();
    const meta = await db.get('SELECT * FROM vault_meta WHERE id = 1');
    if (!meta || !meta.totpBlob) throw new Error('Two-factor is not enabled');

    const params = JSON.parse(meta.kdf_params);
    const key = await crypto.deriveKey(masterPassword, meta.kdf_salt, params);
    if (!crypto.checkVerifier(key, meta.verifier)) {
      throw new Error('Incorrect master password');
    }
    const secret = crypto.decryptJson(key, meta.totpBlob).secret;
    if (!totp.verify(secret, code)) {
      throw authError('Incorrect verification code', 'TOTP_INVALID');
    }

    await db.run('UPDATE vault_meta SET totpBlob = NULL WHERE id = 1');
    this.pendingTotpSecret = null;
    return this.status();
  }

  lock() {
    if (this.key) this.key.fill(0);
    this.key = null;
    this.pendingTotpSecret = null;
    if (this.autoLockTimer) {
      clearTimeout(this.autoLockTimer);
      this.autoLockTimer = null;
    }
    this.emit('locked');
    return true;
  }

  setAutoLockMinutes(minutes) {
    this.autoLockMinutes = Number(minutes) || 0;
    this.armAutoLock();
  }

  /** Called on every vault touch so activity keeps the vault open. */
  armAutoLock() {
    if (this.autoLockTimer) clearTimeout(this.autoLockTimer);
    this.autoLockTimer = null;
    if (!this.autoLockMinutes || !this.isUnlocked) return;
    this.autoLockTimer = setTimeout(
      () => this.lock(),
      this.autoLockMinutes * 60 * 1000
    );
    this.autoLockTimer.unref?.();
  }

  requireKey() {
    if (!this.key) {
      const err = new Error('Vault is locked');
      err.code = 'VAULT_LOCKED';
      throw err;
    }
    this.armAutoLock();
    return this.key;
  }

  /** Encrypt an arbitrary JSON-serialisable secret bundle. */
  seal(value) {
    return crypto.encryptJson(this.requireKey(), value);
  }

  open(blob) {
    if (!blob) return null;
    return crypto.decryptJson(this.requireKey(), blob);
  }

  /**
   * Re-key every stored secret under a new master password.
   * Decrypt-then-encrypt runs inside one transaction so a crash cannot leave
   * half the identities readable with the old key and half with the new one.
   */
  async changeMasterPassword(currentPassword, newPassword) {
    const meta = await db.get('SELECT * FROM vault_meta WHERE id = 1');
    if (!meta) throw new Error('Vault is not initialised');
    if (!newPassword || String(newPassword).length < 4) {
      throw new Error('New master password must be at least 4 characters');
    }

    const params = JSON.parse(meta.kdf_params);
    const oldKey = await crypto.deriveKey(currentPassword, meta.kdf_salt, params);
    if (!crypto.checkVerifier(oldKey, meta.verifier)) {
      throw new Error('Incorrect current master password');
    }

    const newSalt = crypto.randomSalt();
    const newKey = await crypto.deriveKey(newPassword, newSalt);

    const rows = await db.all(
      'SELECT id, secretBlob FROM identities WHERE secretBlob IS NOT NULL'
    );
    const rewritten = rows.map((row) => ({
      id: row.id,
      blob: crypto.encryptJson(newKey, crypto.decryptJson(oldKey, row.secretBlob)),
    }));

    // The TOTP secret is sealed under the same key, so it has to move with the
    // identities - missing it would leave the second factor undecryptable and
    // lock the vault shut for good.
    const totpBlob = meta.totpBlob
      ? crypto.encryptJson(newKey, crypto.decryptJson(oldKey, meta.totpBlob))
      : null;

    await db.run('BEGIN IMMEDIATE');
    try {
      for (const item of rewritten) {
        await db.run('UPDATE identities SET secretBlob = ? WHERE id = ?', [
          item.blob,
          item.id,
        ]);
      }
      await db.run(
        'UPDATE vault_meta SET kdf_salt = ?, kdf_params = ?, verifier = ?, totpBlob = ? WHERE id = 1',
        [newSalt, JSON.stringify(crypto.KDF_PARAMS), crypto.makeVerifier(newKey), totpBlob]
      );
      await db.run('COMMIT');
    } catch (err) {
      await db.run('ROLLBACK');
      throw err;
    }

    if (this.key) this.key.fill(0);
    this.key = newKey;
    this.armAutoLock();
    return true;
  }
}

module.exports = new Vault();
