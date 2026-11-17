'use client';

import { useEffect, useState } from 'react';
import { useStore } from '@/lib/store';
import { api } from '@/lib/socket';
import { THEMES, FONT_STACKS, DEFAULT_THEME } from '@/lib/themes';
import {
  CloseIcon,
  EyeIcon,
  EyeOffIcon,
  UserIcon,
  KeyIcon,
  OsBadge,
  OS_OPTIONS,
  FolderIcon,
  ChevronIcon,
  ConnectIcon,
} from './Icons';

/**
 * terminal.ai - record editors.
 *
 * One modal host for the five editable record types. Every form posts through
 * the REST layer and then refreshes the workspace, so the sidebar, palette and
 * tunnel panel all stay in step without any of them re-fetching individually.
 */

function Modal({ title, onClose, children, footer, wide = false }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className={`modal ${wide ? 'modal-wide' : ''}`}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={15} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        <footer className="modal-footer">{footer}</footer>
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/* -------------------------------------------------------------------------- */

function HostForm({ data, onDone }) {
  const groups = useStore((s) => s.groups);
  const identities = useStore((s) => s.identities);
  const hosts = useStore((s) => s.hosts);
  const snippets = useStore((s) => s.snippets);
  const toast = useStore((s) => s.toast);
  const openHost = useStore((s) => s.openHost);

  const [form, setForm] = useState({
    label: data?.label || '',
    hostname: data?.hostname || '',
    port: data?.port || 22,
    username: data?.username || '',
    password: '',
    privateKey: '',
    passphrase: '',
    osType: data?.osType || 'ubuntu',
    groupId: data?.groupId || '',
    identityId: data?.identityId || '',
    jumpHostId: data?.jumpHostId || '',
    tags: (data?.tags || []).join(', '),
    theme: data?.theme || DEFAULT_THEME,
    font: data?.font || 'firaCode',
    fontSize: data?.fontSize || 14,
    startupSnippetId: data?.startupSnippetId || '',
    agentForwarding: !!data?.agentForwarding,
    keepaliveSeconds: data?.keepaliveSeconds ?? 30,
    notes: data?.notes || '',
    color: data?.color || '',
  });

  const [showPassword, setShowPassword] = useState(false);
  const [showKeySection, setShowKeySection] = useState(!!(data?.hasKey || data?.identityId));
  const [showMore, setShowMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);

  const set = (key) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
  };

  const readKeyFile = async (file) => {
    if (!file) return;
    const text = await file.text();
    setForm((f) => ({ ...f, privateKey: text }));
  };

  const save = async (shouldConnect = false) => {
    if (!form.hostname.trim()) {
      setError('Hostname or IP is required');
      return;
    }
    setBusy(true);
    if (shouldConnect) setConnecting(true);
    setError(null);
    try {
      const payload = {
        ...form,
        label: form.label.trim() || form.hostname.trim(),
        hostname: form.hostname.trim(),
        username: form.username.trim(),
        port: Number(form.port) || 22,
        groupId: form.groupId ? Number(form.groupId) : null,
        identityId: form.identityId ? Number(form.identityId) : null,
        jumpHostId: form.jumpHostId ? Number(form.jumpHostId) : null,
        startupSnippetId: form.startupSnippetId ? Number(form.startupSnippetId) : null,
        fontSize: Number(form.fontSize) || 14,
        keepaliveSeconds: Number(form.keepaliveSeconds) || 30,
      };

      if (!form.password) delete payload.password;
      if (!form.privateKey) delete payload.privateKey;
      if (!form.passphrase) delete payload.passphrase;

      const res = await api(data ? `/api/hosts/${data.id}` : '/api/hosts', {
        method: data ? 'PUT' : 'POST',
        body: payload,
      });

      await onDone();
      toast(data ? 'Host updated' : 'Host created', 'success');

      if (shouldConnect) {
        const targetId = res?.id || data?.id;
        if (targetId) {
          openHost(targetId).catch(() => {});
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setConnecting(false);
    }
  };

  return (
    <Modal
      wide
      title={data ? `Edit ${data.label || data.hostname}` : 'New host'}
      onClose={onDone}
      footer={
        <div className="termius-modal-footer">
          {error && <span className="modal-error">{error}</span>}
          <div className="termius-footer-actions">
            <button className="btn btn-ghost" onClick={onDone} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-secondary" onClick={() => save(false)} disabled={busy}>
              {busy && !connecting ? 'Saving...' : 'Save host'}
            </button>
            <button
              className="btn btn-termius-connect"
              onClick={() => save(true)}
              disabled={busy}
            >
              <ConnectIcon size={16} />
              {connecting ? 'Connecting...' : 'Connect'}
            </button>
          </div>
        </div>
      }
    >
      <div className="termius-form">
        {/* Address & OS Hero Card */}
        <div className="termius-section">
          <label className="termius-section-title">Address</label>
          <div className="termius-address-card">
            <div className="termius-os-selector-wrap">
              <OsBadge os={form.osType} size={38} />
              <select
                className="termius-os-select"
                value={form.osType}
                onChange={set('osType')}
                title="Select OS Badge"
              >
                {OS_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="termius-address-input-wrap">
              <input
                className="termius-address-input"
                placeholder="79.143.186.40 or hostname"
                value={form.hostname}
                onChange={set('hostname')}
                autoFocus
              />
            </div>
          </div>
        </div>

        {/* General Section */}
        <div className="termius-section">
          <label className="termius-section-title">General</label>
          <div className="termius-input-group">
            <input
              className="termius-input"
              placeholder="Label / Server name (e.g. Digital_twin)"
              value={form.label}
              onChange={set('label')}
            />
          </div>

          <div className="termius-row-2">
            <div className="termius-select-with-icon">
              <FolderIcon size={15} className="termius-field-icon" />
              <select className="termius-select" value={form.groupId} onChange={set('groupId')}>
                <option value="">Ungrouped</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
            <input
              className="termius-input"
              placeholder="Tags (comma separated)"
              value={form.tags}
              onChange={set('tags')}
            />
          </div>
        </div>

        {/* SSH Connection Row */}
        <div className="termius-section">
          <label className="termius-section-title">Connection</label>
          <div className="termius-ssh-bar">
            <span className="termius-ssh-label">SSH on</span>
            <input
              className="termius-port-input"
              type="number"
              value={form.port}
              onChange={set('port')}
              placeholder="22"
            />
            <span className="termius-ssh-label">port</span>

            <div className="termius-jump-wrap">
              <span className="termius-jump-label">Jump host:</span>
              <select className="termius-select-sm" value={form.jumpHostId} onChange={set('jumpHostId')}>
                <option value="">Direct</option>
                {hosts
                  .filter((h) => h.id !== data?.id)
                  .map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.label}
                    </option>
                  ))}
              </select>
            </div>
          </div>
        </div>

        {/* Credentials Section */}
        <div className="termius-section">
          <label className="termius-section-title">Credentials</label>

          {/* Direct Username */}
          <div className="termius-input-with-icon">
            <UserIcon size={16} className="termius-field-icon" />
            <input
              className="termius-field-inner"
              placeholder="Username (e.g. ubuntu, root, admin)"
              value={form.username}
              onChange={set('username')}
            />
          </div>

          {/* Direct Password with Eye toggle */}
          <div className="termius-input-with-icon" style={{ marginTop: '8px' }}>
            <KeyIcon size={16} className="termius-field-icon" />
            <input
              className="termius-field-inner"
              type={showPassword ? 'text' : 'password'}
              placeholder={
                data?.hasPassword
                  ? '•••••••••••••••• (Saved - leave blank to keep)'
                  : 'Enter password'
              }
              value={form.password}
              onChange={set('password')}
              autoComplete="new-password"
            />
            <button
              type="button"
              className="termius-eye-btn"
              onClick={() => setShowPassword(!showPassword)}
              title={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
            </button>
          </div>

          {/* Key / Keychain Toggle Button */}
          <div className="termius-key-toggle-row">
            <button
              type="button"
              className="termius-key-toggle-btn"
              onClick={() => setShowKeySection(!showKeySection)}
            >
              {showKeySection ? '− Hide SSH Key / Keychain' : '+ SSH Key, Identity, Certificate'}
            </button>
          </div>

          {/* Key / Keychain Section */}
          {showKeySection && (
            <div className="termius-key-box">
              <Field label="Keychain Identity" hint="Or link credentials from Keychain">
                <select className="input" value={form.identityId} onChange={set('identityId')}>
                  <option value="">None (Use direct password/key above)</option>
                  {identities.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.label}
                      {i.username ? ` (${i.username})` : ''}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="Direct Private Key"
                hint={data?.hasKey ? 'Stored. Paste new key to replace.' : 'OpenSSH private key'}
              >
                <textarea
                  className="input textarea textarea-key"
                  value={form.privateKey}
                  onChange={set('privateKey')}
                  placeholder={
                    data?.hasKey
                      ? '(Saved key stored. Leave blank to keep unchanged)'
                      : '-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----'
                  }
                />
              </Field>

              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '10px' }}>
                <label className="btn btn-ghost btn-sm file-btn" style={{ margin: 0 }}>
                  Load from file
                  <input
                    type="file"
                    hidden
                    onChange={(e) => readKeyFile(e.target.files?.[0])}
                  />
                </label>
                <input
                  className="input"
                  style={{ flex: 1 }}
                  type="password"
                  placeholder="Key passphrase (if encrypted)"
                  value={form.passphrase}
                  onChange={set('passphrase')}
                />
              </div>
            </div>
          )}
        </div>

        {/* Show More / Show Less Accordion */}
        <div className="termius-show-more-row">
          <button
            type="button"
            className="termius-show-more-btn"
            onClick={() => setShowMore(!showMore)}
          >
            <span>{showMore ? 'Show less' : 'Show more'}</span>
            <ChevronIcon size={13} className={`termius-caret ${showMore ? 'is-open' : ''}`} />
          </button>
        </div>

        {showMore && (
          <div className="termius-more-box">
            <div className="form-grid">
              <Field label="Theme">
                <select className="input" value={form.theme} onChange={set('theme')}>
                  {Object.entries(THEMES).map(([key, value]) => (
                    <option key={key} value={key}>
                      {value.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Font">
                <select className="input" value={form.font} onChange={set('font')}>
                  {Object.entries(FONT_STACKS).map(([key, value]) => (
                    <option key={key} value={key}>
                      {value.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Font size">
                <input
                  className="input"
                  type="number"
                  min="8"
                  max="32"
                  value={form.fontSize}
                  onChange={set('fontSize')}
                />
              </Field>

              <Field label="Keepalive (seconds)">
                <input
                  className="input"
                  type="number"
                  value={form.keepaliveSeconds}
                  onChange={set('keepaliveSeconds')}
                />
              </Field>

              <Field label="Startup snippet" hint="Runs once the shell opens">
                <select
                  className="input"
                  value={form.startupSnippetId}
                  onChange={set('startupSnippetId')}
                >
                  <option value="">None</option>
                  {snippets.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </Field>

              <label className="field field-inline field-span">
                <input
                  type="checkbox"
                  checked={form.agentForwarding}
                  onChange={set('agentForwarding')}
                />
                <span>
                  Forward the SSH agent
                  <span className="field-hint">Requires SSH_AUTH_SOCK in the server environment</span>
                </span>
              </label>

              <Field label="Notes">
                <textarea className="input textarea" value={form.notes} onChange={set('notes')} />
              </Field>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */

function IdentityForm({ data, onDone }) {
  const toast = useStore((s) => s.toast);
  const [form, setForm] = useState({
    label: data?.label || '',
    username: data?.username || '',
    authType: data?.authType || 'password',
    password: '',
    privateKey: '',
    passphrase: '',
    totpSecret: '',
  });
  const [clearTotp, setClearTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // On edit, only send secret fields the user actually filled in - the
      // server merges, so blanks leave the stored secret untouched.
      const payload = { label: form.label, username: form.username, authType: form.authType };
      if (!data || form.password) payload.password = form.password;
      if (!data || form.privateKey) payload.privateKey = form.privateKey;
      if (!data || form.passphrase) payload.passphrase = form.passphrase;
      if (clearTotp) payload.totpSecret = null;
      else if (!data || form.totpSecret) payload.totpSecret = form.totpSecret;

      await api(data ? `/api/identities/${data.id}` : '/api/identities', {
        method: data ? 'PUT' : 'POST',
        body: payload,
      });
      await onDone();
      toast(data ? 'Identity updated' : 'Identity created', 'success');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const readKeyFile = async (file) => {
    if (!file) return;
    const text = await file.text();
    setForm((f) => ({ ...f, privateKey: text, authType: 'key' }));
  };

  return (
    <Modal
      title={data ? `Edit ${data.label}` : 'New identity'}
      onClose={onDone}
      footer={
        <>
          {error && <span className="modal-error">{error}</span>}
          <button className="btn btn-ghost" onClick={onDone}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Sealing...' : 'Save identity'}
          </button>
        </>
      }
    >
      <Field label="Label">
        <input className="input" value={form.label} onChange={set('label')} autoFocus />
      </Field>
      <Field label="Default username">
        <input className="input" value={form.username} onChange={set('username')} />
      </Field>

      <div className="segmented">
        {['password', 'key', 'agent'].map((type) => (
          <button
            key={type}
            className={`segmented-btn ${form.authType === type ? 'is-active' : ''}`}
            onClick={() => setForm((f) => ({ ...f, authType: type }))}
          >
            {type === 'key' ? 'SSH key' : type === 'agent' ? 'Agent' : 'Password'}
          </button>
        ))}
      </div>

      {form.authType === 'password' && (
        <Field
          label="Password"
          hint={data?.hasPassword ? 'Stored. Leave blank to keep it unchanged.' : undefined}
        >
          <input
            className="input"
            type="password"
            value={form.password}
            onChange={set('password')}
            placeholder={data?.hasPassword ? '••••••••' : ''}
          />
        </Field>
      )}

      {form.authType === 'key' && (
        <>
          <Field
            label="Private key"
            hint={data?.hasKey ? 'Stored. Leave blank to keep it unchanged.' : undefined}
          >
            <textarea
              className="input textarea textarea-key"
              value={form.privateKey}
              onChange={set('privateKey')}
              placeholder={
                data?.hasKey
                  ? '(unchanged)'
                  : '-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----'
              }
            />
          </Field>
          <label className="btn btn-ghost btn-sm file-btn">
            Load from file
            <input
              type="file"
              hidden
              onChange={(e) => readKeyFile(e.target.files?.[0])}
            />
          </label>
          <Field label="Key passphrase" hint="Only if the key is encrypted">
            <input
              className="input"
              type="password"
              value={form.passphrase}
              onChange={set('passphrase')}
            />
          </Field>
        </>
      )}

      {form.authType === 'agent' && (
        <p className="panel-note">
          Authentication is delegated to the SSH agent from the server environment
          (SSH_AUTH_SOCK). No secret is stored for this identity.
        </p>
      )}

      <Field
        label="Verification code secret"
        hint={
          data?.hasTotp
            ? 'Stored. Leave blank to keep it, or tick below to remove it.'
            : 'Optional. For servers that ask for a code from Google Authenticator (the base32 setup key, or an otpauth:// link).'
        }
      >
        <input
          className="input input-mono"
          type="password"
          value={form.totpSecret}
          onChange={set('totpSecret')}
          disabled={clearTotp}
          placeholder={data?.hasTotp ? '••••••••' : 'JBSWY3DPEHPK3PXP'}
          autoComplete="off"
        />
      </Field>

      {data?.hasTotp && (
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={clearTotp}
            onChange={(e) => setClearTotp(e.target.checked)}
          />
          Remove the stored code secret
        </label>
      )}

      <p className="panel-note">
        Secrets are encrypted with AES-256-GCM under your master password before they touch
        disk, and are never returned to this page. When a server asks for a verification code,
        AI Terminal generates it from this secret instead of interrupting you.
      </p>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */

function SnippetForm({ data, onDone }) {
  const toast = useStore((s) => s.toast);
  const [form, setForm] = useState({
    label: data?.label || '',
    body: data?.body || '',
    description: data?.description || '',
    tags: (data?.tags || []).join(', '),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(data ? `/api/snippets/${data.id}` : '/api/snippets', {
        method: data ? 'PUT' : 'POST',
        body: form,
      });
      await onDone();
      toast(data ? 'Snippet updated' : 'Snippet created', 'success');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={data ? `Edit ${data.label}` : 'New snippet'}
      onClose={onDone}
      footer={
        <>
          {error && <span className="modal-error">{error}</span>}
          <button className="btn btn-ghost" onClick={onDone}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving...' : 'Save snippet'}
          </button>
        </>
      }
    >
      <Field label="Label">
        <input className="input" value={form.label} onChange={set('label')} autoFocus />
      </Field>
      <Field label="Command" hint="Multi-line scripts are sent line by line">
        <textarea
          className="input textarea textarea-code"
          value={form.body}
          onChange={set('body')}
          spellCheck={false}
        />
      </Field>
      <Field label="Description">
        <input className="input" value={form.description} onChange={set('description')} />
      </Field>
      <Field label="Tags" hint="Comma separated">
        <input className="input" value={form.tags} onChange={set('tags')} />
      </Field>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */

function ForwardForm({ data, onDone }) {
  const hosts = useStore((s) => s.hosts);
  const toast = useStore((s) => s.toast);
  const [form, setForm] = useState({
    hostId: data?.hostId || '',
    label: data?.label || '',
    type: data?.type || 'local',
    listenHost: data?.listenHost || '127.0.0.1',
    listenPort: data?.listenPort || '',
    destHost: data?.destHost || '',
    destPort: data?.destPort || '',
    autoStart: !!data?.autoStart,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (key) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(data ? `/api/forwards/${data.id}` : '/api/forwards', {
        method: data ? 'PUT' : 'POST',
        body: { ...form, hostId: Number(form.hostId) },
      });
      await onDone();
      toast(data ? 'Rule updated' : 'Rule created', 'success');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const explain = {
    local: 'Traffic to the listen address on this machine is tunnelled out to the destination, reached from the remote host. Equivalent to ssh -L.',
    remote: 'The remote host listens, and connections it receives are tunnelled back here and delivered to the destination. Equivalent to ssh -R.',
    dynamic: 'Runs a SOCKS5 proxy locally; each client request picks its own destination, resolved from the remote host. Equivalent to ssh -D.',
  }[form.type];

  return (
    <Modal
      title={data ? `Edit ${data.label}` : 'New forwarding rule'}
      onClose={onDone}
      footer={
        <>
          {error && <span className="modal-error">{error}</span>}
          <button className="btn btn-ghost" onClick={onDone}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving...' : 'Save rule'}
          </button>
        </>
      }
    >
      <div className="segmented segmented-wide">
        {['local', 'remote', 'dynamic'].map((type) => (
          <button
            key={type}
            className={`segmented-btn ${form.type === type ? 'is-active' : ''}`}
            onClick={() => setForm((f) => ({ ...f, type }))}
          >
            {type === 'local' ? 'Local (-L)' : type === 'remote' ? 'Remote (-R)' : 'Dynamic (-D)'}
          </button>
        ))}
      </div>

      <p className="panel-note">{explain}</p>

      <div className="tunnel-diagram">
        {form.type === 'dynamic' ? (
          <>
            <span className="node">SOCKS client</span>
            <span className="arrow">→</span>
            <span className="node node-accent">
              {form.listenHost}:{form.listenPort || '?'}
            </span>
            <span className="arrow">⇢ ssh ⇢</span>
            <span className="node">chosen per request</span>
          </>
        ) : form.type === 'local' ? (
          <>
            <span className="node node-accent">
              {form.listenHost}:{form.listenPort || '?'}
            </span>
            <span className="arrow">⇢ ssh ⇢</span>
            <span className="node">
              {form.destHost || 'destination'}:{form.destPort || '?'}
            </span>
          </>
        ) : (
          <>
            <span className="node">
              remote:{form.listenPort || '?'}
            </span>
            <span className="arrow">⇢ ssh ⇢</span>
            <span className="node node-accent">
              {form.destHost || 'destination'}:{form.destPort || '?'}
            </span>
          </>
        )}
      </div>

      <div className="form-grid">
        <Field label="Label">
          <input className="input" value={form.label} onChange={set('label')} autoFocus />
        </Field>
        <Field label="Host">
          <select className="input" value={form.hostId} onChange={set('hostId')}>
            <option value="">Select a host</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label={form.type === 'remote' ? 'Remote bind address' : 'Listen address'}
          hint={form.type === 'remote' ? 'Use 0.0.0.0 to accept from anywhere' : undefined}
        >
          <input className="input" value={form.listenHost} onChange={set('listenHost')} />
        </Field>
        <Field label="Listen port">
          <input
            className="input"
            type="number"
            value={form.listenPort}
            onChange={set('listenPort')}
          />
        </Field>

        {form.type !== 'dynamic' && (
          <>
            <Field label="Destination host">
              <input className="input" value={form.destHost} onChange={set('destHost')} />
            </Field>
            <Field label="Destination port">
              <input
                className="input"
                type="number"
                value={form.destPort}
                onChange={set('destPort')}
              />
            </Field>
          </>
        )}
      </div>

      <label className="field field-inline">
        <input type="checkbox" checked={form.autoStart} onChange={set('autoStart')} />
        <span>Start automatically when a session to this host opens</span>
      </label>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */

function GroupForm({ data, onDone }) {
  const groups = useStore((s) => s.groups);
  const [form, setForm] = useState({
    name: data?.name || '',
    parentId: data?.parentId || '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(data ? `/api/groups/${data.id}` : '/api/groups', {
        method: data ? 'PUT' : 'POST',
        body: { ...form, parentId: form.parentId ? Number(form.parentId) : null },
      });
      await onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={data ? `Edit ${data.name}` : 'New group'}
      onClose={onDone}
      footer={
        <>
          {error && <span className="modal-error">{error}</span>}
          <button className="btn btn-ghost" onClick={onDone}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving...' : 'Save group'}
          </button>
        </>
      }
    >
      <Field label="Name">
        <input
          className="input"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          autoFocus
        />
      </Field>
      <Field label="Parent group" hint="Groups can nest to any depth">
        <select
          className="input"
          value={form.parentId}
          onChange={(e) => setForm((f) => ({ ...f, parentId: e.target.value }))}
        >
          <option value="">Top level</option>
          {groups
            .filter((g) => g.id !== data?.id)
            .map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
        </select>
      </Field>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */

/**
 * Second factor for the vault itself (Google Authenticator and any other TOTP
 * app). The secret is minted server-side, shown exactly once, and only written
 * to disk once a code proves the phone holds it - so an abandoned setup can
 * never lock anyone out of their own vault.
 */
function TwoFactorForm({ onDone }) {
  const vault = useStore((s) => s.vault);
  const refresh = useStore((s) => s.refresh);
  const toast = useStore((s) => s.toast);

  const [enrolment, setEnrolment] = useState(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const enabled = !!vault.totpEnabled;

  const post = async (bodyPayload) => {
    setBusy(true);
    setError(null);
    try {
      return await api('/api/vault', { method: 'POST', body: bodyPayload });
    } finally {
      setBusy(false);
    }
  };

  const begin = async () => {
    try {
      setEnrolment(await post({ action: 'totp-begin', account: 'vault' }));
    } catch (err) {
      setError(err.message);
    }
  };

  const enable = async () => {
    try {
      await post({ action: 'totp-enable', code: code.trim() });
      await refresh();
      toast('Two-factor authentication is on', 'success');
      onDone();
    } catch (err) {
      setError(err.message);
      setCode('');
    }
  };

  const disable = async () => {
    try {
      await post({ action: 'totp-disable', masterPassword: password, code: code.trim() });
      await refresh();
      toast('Two-factor authentication is off', 'info');
      onDone();
    } catch (err) {
      setError(err.message);
      setCode('');
    }
  };

  // Grouped in fours because that is how it gets typed into a phone.
  const grouped = enrolment ? enrolment.secret.replace(/(.{4})/g, '$1 ').trim() : '';

  return (
    <Modal
      title="Two-factor authentication"
      onClose={onDone}
      footer={
        <>
          {error && <span className="modal-error">{error}</span>}
          <button className="btn btn-ghost" onClick={onDone}>
            Close
          </button>
          {!enabled && enrolment && (
            <button className="btn btn-primary" onClick={enable} disabled={busy || code.length < 6}>
              {busy ? 'Checking...' : 'Turn on'}
            </button>
          )}
          {enabled && (
            <button
              className="btn btn-danger"
              onClick={disable}
              disabled={busy || !password || code.length < 6}
            >
              {busy ? 'Checking...' : 'Turn off'}
            </button>
          )}
        </>
      }
    >
      {enabled ? (
        <>
          <p className="panel-note">
            Unlocking this vault needs your master password <em>and</em> a code from your
            authenticator app. Turning that off asks for both, one last time.
          </p>
          <Field label="Master password">
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
          <Field label="Authenticator code">
            <input
              className="input input-code"
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))}
            />
          </Field>
        </>
      ) : !enrolment ? (
        <>
          <p className="panel-note">
            Add a code from Google Authenticator (or any TOTP app) on top of your master
            password. The secret is sealed in this vault, so it never leaves your machine and
            no account or server is involved.
          </p>
          <button className="btn btn-primary" onClick={begin} disabled={busy}>
            {busy ? 'Generating...' : 'Start setup'}
          </button>
        </>
      ) : (
        <>
          <p className="panel-note">
            Open Google Authenticator, tap <strong>+</strong> &rarr;{' '}
            <strong>Scan a QR code</strong>, then type the code it shows.
          </p>

          <figure className="qr-card">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="qr-code" src={enrolment.qr} alt="Scan this with your authenticator app" width={200} height={200} />
          </figure>

          <details className="qr-fallback">
            <summary>Can&rsquo;t scan it?</summary>
            <Field
              label="Setup key"
              hint="In the app choose &ldquo;Enter a setup key&rdquo; and type this. Shown once."
            >
              <code className="secret-block">{grouped}</code>
            </Field>
            <Field label="Or paste this link" hint="The same secret, in the otpauth:// form apps import.">
              <input
                className="input input-mono"
                readOnly
                value={enrolment.uri}
                onFocus={(e) => e.target.select()}
              />
            </Field>
          </details>

          <Field label="Code from the app">
            <input
              className="input input-code"
              autoFocus
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))}
              onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && enable()}
            />
          </Field>

          <p className="gate-warning">
            Losing both the app and the master password means losing the vault. There is no
            recovery code and no reset.
          </p>
        </>
      )}
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */

export default function Editors() {
  const editor = useStore((s) => s.editor);
  const closeEditor = useStore((s) => s.closeEditor);
  const refresh = useStore((s) => s.refresh);

  if (!editor) return null;

  const onDone = async () => {
    await refresh().catch(() => {});
    closeEditor();
  };

  const props = { data: editor.data, onDone };

  switch (editor.kind) {
    case 'host':
      return <HostForm {...props} />;
    case 'identity':
      return <IdentityForm {...props} />;
    case 'snippet':
      return <SnippetForm {...props} />;
    case 'forward':
      return <ForwardForm {...props} />;
    case 'group':
      return <GroupForm {...props} />;
    case 'twofactor':
      return <TwoFactorForm {...props} />;
    default:
      return null;
  }
}

export { Modal, Field };
