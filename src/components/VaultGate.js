'use client';

import { useState } from 'react';
import { useStore } from '@/lib/store';
import Brand, { BrandWordmark } from './Brand';

/**
 * terminal.ai - master password gate.
 *
 * Nothing behind this screen loads until the vault is open: the workspace
 * stays empty and every secret-touching route returns 423. On first run it
 * creates the vault and imports any hosts saved by the previous version.
 */

export default function VaultGate() {
  const vault = useStore((s) => s.vault);
  const unlockVault = useStore((s) => s.unlockVault);

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Normally driven by the vault status, but a server that answers
  // TOTP_REQUIRED wins: that means 2FA was enrolled after this page loaded.
  const [needsCode, setNeedsCode] = useState(false);

  const firstRun = !vault.initialised;
  const askForCode = !firstRun && (needsCode || vault.totpEnabled);

  const submit = async (event) => {
    event.preventDefault();
    setError(null);

    if (firstRun) {
      if (password.length < 4) {
        setError('Use at least 4 characters.');
        return;
      }
      if (password !== confirmation) {
        setError('The two passwords do not match.');
        return;
      }
    }

    if (askForCode && code.trim().length < 6) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }

    setBusy(true);
    try {
      await unlockVault(password, firstRun, askForCode ? code.trim() : null);
      setPassword('');
      setConfirmation('');
      setCode('');
    } catch (err) {
      if (err.code === 'TOTP_REQUIRED') setNeedsCode(true);
      // A wrong code is not a wrong password: keep what was typed and let the
      // next 30-second code be entered on its own.
      if (err.code === 'TOTP_INVALID') setCode('');
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <div className="gate-glow" aria-hidden="true" />

      <form className="gate-card" onSubmit={submit}>
        <div className="gate-brand">
          <Brand size={48} showWordmark={false} />
          <BrandWordmark size="lg" />
        </div>

        <p className="gate-tagline">
          {firstRun
            ? 'Choose a master password. It encrypts every credential you save and is never stored anywhere.'
            : 'Unlock your vault to reach your hosts and keys.'}
        </p>

        <label className="field">
          <span className="field-label">Master password</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            autoComplete={firstRun ? 'new-password' : 'current-password'}
          />
        </label>

        {firstRun && (
          <label className="field">
            <span className="field-label">Confirm password</span>
            <input
              className="input"
              type="password"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              autoComplete="new-password"
            />
          </label>
        )}

        {askForCode && (
          <label className="field">
            <span className="field-label">Authenticator code</span>
            <input
              className="input input-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))}
            />
          </label>
        )}

        {error && <p className="gate-error">{error}</p>}

        {firstRun && (
          <p className="gate-warning">
            There is no recovery. If you lose this password, the sealed credentials cannot be
            read again.
          </p>
        )}

        {!firstRun && vault.legacyPending > 0 && (
          <p className="gate-note">
            {vault.legacyPending} connection{vault.legacyPending === 1 ? '' : 's'} from the
            previous version will be imported and encrypted on unlock.
          </p>
        )}

        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? 'Deriving key...' : firstRun ? 'Create vault' : 'Unlock'}
        </button>

        <p className="gate-footer">
          AES-256-GCM · scrypt N=32768 · local only{askForCode ? ' · 2FA' : ''}
        </p>
      </form>
    </div>
  );
}
