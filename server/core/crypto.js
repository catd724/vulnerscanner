'use strict';

/**
 * terminal.ai - envelope encryption for the identity vault.
 *
 * Master password --scrypt--> 32-byte master key (memory only, never stored).
 * Each secret is sealed independently with AES-256-GCM under a fresh IV, so a
 * leaked ciphertext reveals nothing and records can be rewritten in place.
 *
 * Blob format: v1.<iv b64>.<authTag b64>.<ciphertext b64>
 */

const crypto = require('crypto');

const KDF = 'scrypt';
const KDF_PARAMS = { N: 32768, r: 8, p: 1, keylen: 32 };
// 128 * N * r = ~33.5 MiB, above node's 32 MiB default, so raise the ceiling.
const SCRYPT_MAXMEM = 96 * 1024 * 1024;

const VERIFIER_PLAINTEXT = 'terminal.ai/vault/v1';

function randomSalt(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64');
}

/** Derive the master key. Deliberately slow - never call it per request. */
function deriveKey(password, saltB64, params = KDF_PARAMS) {
  return new Promise((resolve, reject) => {
    const salt = Buffer.from(saltB64, 'base64');
    crypto.scrypt(
      Buffer.from(String(password), 'utf8'),
      salt,
      params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([
    cipher.update(Buffer.from(String(plaintext), 'utf8')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

function decrypt(key, blob) {
  if (typeof blob !== 'string') throw new Error('Vault blob is not a string');
  const parts = blob.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Unrecognised vault blob format');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivB64, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]);
  return pt.toString('utf8');
}

function encryptJson(key, value) {
  return encrypt(key, JSON.stringify(value));
}

function decryptJson(key, blob) {
  return JSON.parse(decrypt(key, blob));
}

function makeVerifier(key) {
  return encrypt(key, VERIFIER_PLAINTEXT);
}

/** Constant-time-ish check: GCM auth failure throws, so a wrong key never matches. */
function checkVerifier(key, verifier) {
  try {
    return decrypt(key, verifier) === VERIFIER_PLAINTEXT;
  } catch {
    return false;
  }
}

module.exports = {
  KDF,
  KDF_PARAMS,
  randomSalt,
  deriveKey,
  encrypt,
  decrypt,
  encryptJson,
  decryptJson,
  makeVerifier,
  checkVerifier,
};
