'use strict';

/**
 * terminal.ai - data access.
 *
 * Every read that crosses the wire to the browser goes through a `public*`
 * projection. secretBlob has no path out of this module: only resolveAuth()
 * decrypts, and its result is consumed by the SSH layer in-process.
 */

const db = require('./db');
const vault = require('./vault');
const totp = require('./totp');

const { run, all, get } = db;

const NOW = "datetime('now')";

/* -------------------------------------------------------------------------- */
/* groups                                                                     */
/* -------------------------------------------------------------------------- */

const groups = {
  async list() {
    return all('SELECT * FROM groups ORDER BY sortOrder ASC, name ASC');
  },

  async create({ name, parentId = null, color = null, sortOrder = 0 }) {
    if (!name || !name.trim()) throw new Error('Group name is required');
    const res = await run(
      'INSERT INTO groups (name, parentId, color, sortOrder) VALUES (?, ?, ?, ?)',
      [name.trim(), parentId || null, color || null, sortOrder || 0]
    );
    return get('SELECT * FROM groups WHERE id = ?', [res.lastID]);
  },

  async descendantIds(id) {
    const rows = await all('SELECT id, parentId FROM groups');
    const out = [];
    const walk = (parent) => {
      for (const row of rows) {
        if (Number(row.parentId) === Number(parent)) {
          out.push(row.id);
          walk(row.id);
        }
      }
    };
    walk(id);
    return out;
  },

  async update(id, patch) {
    const existing = await get('SELECT * FROM groups WHERE id = ?', [id]);
    if (!existing) throw new Error('Group not found');

    const { name, color, sortOrder } = patch;
    // parentId has to distinguish "not mentioned" from "move to the top level",
    // so it is read from the patch rather than defaulted: treating an absent
    // key as null used to fling a nested group back to the root on every rename.
    const parentId =
      patch.parentId !== undefined ? patch.parentId || null : existing.parentId;

    // Re-parenting a group under its own descendant would orphan the subtree.
    if (parentId) {
      if (Number(parentId) === Number(id)) {
        throw new Error('A group cannot be its own parent');
      }
      const descendants = await groups.descendantIds(id);
      if (descendants.includes(Number(parentId))) {
        throw new Error('Cannot move a group inside one of its own children');
      }
    }
    await run(
      `UPDATE groups SET
         name = COALESCE(?, name),
         parentId = ?,
         color = COALESCE(?, color),
         sortOrder = COALESCE(?, sortOrder)
       WHERE id = ?`,
      [name ?? null, parentId, color ?? null, sortOrder ?? null, id]
    );
    return get('SELECT * FROM groups WHERE id = ?', [id]);
  },

  async remove(id) {
    // Child groups cascade via the FK; hosts fall back to "Ungrouped".
    await run('UPDATE hosts SET groupId = NULL WHERE groupId = ?', [id]);
    await run('DELETE FROM groups WHERE id = ?', [id]);
    return true;
  },
};

/* -------------------------------------------------------------------------- */
/* identities                                                                 */
/* -------------------------------------------------------------------------- */

/** Strip the sealed blob. This projection is the only shape the client sees. */
function publicIdentity(row) {
  if (!row) return null;
  const { secretBlob, ...rest } = row;
  return { ...rest, hasSecret: !!secretBlob };
}

/**
 * Accept a TOTP secret the way an authenticator app displays it - spaced,
 * lowercase, or pasted straight out of an otpauth:// URI - and reject anything
 * that would silently produce wrong codes at connect time.
 */
function normaliseTotpSecret(value) {
  if (value === null || value === undefined) return null;
  let raw = String(value).trim();
  if (!raw) return null;

  if (raw.toLowerCase().startsWith('otpauth://')) {
    const fromUri = new URL(raw).searchParams.get('secret');
    if (!fromUri) throw new Error('That otpauth link carries no secret');
    raw = fromUri;
  }

  const cleaned = raw.replace(/[\s-]/g, '').toUpperCase();
  if (!totp.isValidSecret(cleaned)) {
    throw new Error('Two-factor secret must be base32, as shown by your authenticator app');
  }
  return cleaned;
}

function describeKey(privateKey) {
  if (!privateKey || !privateKey.trim()) return { keyType: null, fingerprint: null };
  try {
    const { utils } = require('ssh2');
    const parsed = utils.parseKey(privateKey);
    if (parsed instanceof Error) return { keyType: null, fingerprint: null };
    const digest = require('crypto')
      .createHash('sha256')
      .update(parsed.getPublicSSH())
      .digest('base64')
      .replace(/=+$/, '');
    return { keyType: parsed.type, fingerprint: 'SHA256:' + digest };
  } catch {
    return { keyType: null, fingerprint: null };
  }
}

const identities = {
  async list() {
    const rows = await all('SELECT * FROM identities ORDER BY label ASC');
    return rows.map(publicIdentity);
  },

  async find(id) {
    return publicIdentity(await get('SELECT * FROM identities WHERE id = ?', [id]));
  },

  async create({ label, username, authType, password, privateKey, passphrase, totpSecret }) {
    if (!label || !label.trim()) throw new Error('Identity label is required');

    const secret = normaliseTotpSecret(totpSecret);
    const { keyType, fingerprint } = describeKey(privateKey);
    const secretBlob = vault.seal({
      password: password || null,
      privateKey: privateKey || null,
      passphrase: passphrase || null,
      totpSecret: secret,
    });

    const res = await run(
      `INSERT INTO identities
         (label, username, authType, secretBlob, hasPassword, hasKey, hasTotp, keyType, fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        label.trim(),
        username || '',
        authType || 'password',
        secretBlob,
        password ? 1 : 0,
        privateKey ? 1 : 0,
        secret ? 1 : 0,
        keyType,
        fingerprint,
      ]
    );
    return identities.find(res.lastID);
  },

  async update(id, patch) {
    const existing = await get('SELECT * FROM identities WHERE id = ?', [id]);
    if (!existing) throw new Error('Identity not found');

    // Secret fields merge rather than replace: an omitted field in the editor
    // means "leave it alone", so renaming an identity never retypes a key.
    const current = existing.secretBlob ? vault.open(existing.secretBlob) || {} : {};
    const next = {
      password:
        patch.password !== undefined ? patch.password || null : current.password ?? null,
      privateKey:
        patch.privateKey !== undefined ? patch.privateKey || null : current.privateKey ?? null,
      passphrase:
        patch.passphrase !== undefined ? patch.passphrase || null : current.passphrase ?? null,
      totpSecret:
        patch.totpSecret !== undefined
          ? normaliseTotpSecret(patch.totpSecret)
          : current.totpSecret ?? null,
    };

    const { keyType, fingerprint } = describeKey(next.privateKey);

    await run(
      `UPDATE identities SET
         label = COALESCE(?, label),
         username = COALESCE(?, username),
         authType = COALESCE(?, authType),
         secretBlob = ?,
         hasPassword = ?,
         hasKey = ?,
         hasTotp = ?,
         keyType = ?,
         fingerprint = ?,
         updatedAt = ${NOW}
       WHERE id = ?`,
      [
        patch.label ?? null,
        patch.username ?? null,
        patch.authType ?? null,
        vault.seal(next),
        next.password ? 1 : 0,
        next.privateKey ? 1 : 0,
        next.totpSecret ? 1 : 0,
        keyType,
        fingerprint,
        id,
      ]
    );
    return identities.find(id);
  },

  async remove(id) {
    await run('DELETE FROM identities WHERE id = ?', [id]);
    return true;
  },
};

/* -------------------------------------------------------------------------- */
/* hosts                                                                      */
/* -------------------------------------------------------------------------- */

function splitTags(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function serialiseTags(tags) {
  if (tags === null || tags === undefined) return null;
  const list = Array.isArray(tags) ? tags : String(tags).split(',');
  const cleaned = list.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  return cleaned.length ? Array.from(new Set(cleaned)).join(',') : null;
}

function publicHost(row) {
  if (!row) return null;
  const { secretBlob, ...rest } = row;
  return {
    ...rest,
    hasPassword: !!row.hasPassword,
    hasKey: !!row.hasKey,
    osType: row.osType || 'ubuntu',
    tags: splitTags(row.tags),
    agentForwarding: !!row.agentForwarding,
  };
}

const HOST_FIELDS = [
  'label',
  'hostname',
  'port',
  'groupId',
  'identityId',
  'username',
  'osType',
  'jumpHostId',
  'tags',
  'color',
  'theme',
  'font',
  'fontSize',
  'startupSnippetId',
  'agentForwarding',
  'keepaliveSeconds',
  'notes',
];

const hosts = {
  async list() {
    const rows = await all(`
      SELECT h.*, g.name AS groupName, i.label AS identityLabel, i.authType AS identityAuthType
      FROM hosts h
      LEFT JOIN groups g ON g.id = h.groupId
      LEFT JOIN identities i ON i.id = h.identityId
      ORDER BY h.label ASC
    `);
    return rows.map(publicHost);
  },

  async find(id) {
    return publicHost(await get('SELECT * FROM hosts WHERE id = ?', [id]));
  },

  async create(input) {
    if (!input.label || !input.label.trim()) throw new Error('Host label is required');
    if (!input.hostname || !input.hostname.trim()) throw new Error('Hostname is required');

    let secretBlob = null;
    let hasPassword = 0;
    let hasKey = 0;
    if (input.password || input.privateKey || input.passphrase) {
      secretBlob = vault.seal({
        password: input.password || null,
        privateKey: input.privateKey || null,
        passphrase: input.passphrase || null,
      });
      hasPassword = input.password ? 1 : 0;
      hasKey = input.privateKey ? 1 : 0;
    }

    const fields = [...HOST_FIELDS, 'secretBlob', 'hasPassword', 'hasKey'];

    const res = await run(
      `INSERT INTO hosts (${fields.join(', ')})
       VALUES (${fields.map(() => '?').join(', ')})`,
      [
        input.label.trim(),
        input.hostname.trim(),
        parseInt(input.port, 10) || 22,
        input.groupId || null,
        input.identityId || null,
        input.username || null,
        input.osType || 'ubuntu',
        input.jumpHostId || null,
        serialiseTags(input.tags),
        input.color || null,
        input.theme || null,
        input.font || null,
        input.fontSize || null,
        input.startupSnippetId || null,
        input.agentForwarding ? 1 : 0,
        input.keepaliveSeconds ?? 30,
        input.notes || null,
        secretBlob,
        hasPassword,
        hasKey,
      ]
    );
    return hosts.find(res.lastID);
  },

  async update(id, patch) {
    const existing = await get('SELECT * FROM hosts WHERE id = ?', [id]);
    if (!existing) throw new Error('Host not found');

    if (patch.jumpHostId && Number(patch.jumpHostId) === Number(id)) {
      throw new Error('A host cannot be its own jump host');
    }

    const pick = (field, fallbackValue) =>
      patch[field] !== undefined ? patch[field] : fallbackValue;

    const currentSecret = existing.secretBlob ? vault.open(existing.secretBlob) || {} : {};
    let nextSecret = {
      password:
        patch.password !== undefined ? patch.password || null : currentSecret.password ?? null,
      privateKey:
        patch.privateKey !== undefined ? patch.privateKey || null : currentSecret.privateKey ?? null,
      passphrase:
        patch.passphrase !== undefined ? patch.passphrase || null : currentSecret.passphrase ?? null,
    };

    if (patch.clearPassword) nextSecret.password = null;
    if (patch.clearKey) nextSecret.privateKey = null;

    const hasAnySecret = !!(nextSecret.password || nextSecret.privateKey || nextSecret.passphrase);
    const secretBlob = hasAnySecret ? vault.seal(nextSecret) : null;
    const hasPassword = nextSecret.password ? 1 : 0;
    const hasKey = nextSecret.privateKey ? 1 : 0;

    const merged = {
      label: pick('label', existing.label),
      hostname: pick('hostname', existing.hostname),
      port: parseInt(pick('port', existing.port), 10) || 22,
      groupId: patch.groupId !== undefined ? patch.groupId || null : existing.groupId,
      identityId:
        patch.identityId !== undefined ? patch.identityId || null : existing.identityId,
      username: patch.username !== undefined ? patch.username || null : existing.username,
      osType: pick('osType', existing.osType || 'ubuntu'),
      jumpHostId:
        patch.jumpHostId !== undefined ? patch.jumpHostId || null : existing.jumpHostId,
      tags: patch.tags !== undefined ? serialiseTags(patch.tags) : existing.tags,
      color: patch.color !== undefined ? patch.color || null : existing.color,
      theme: patch.theme !== undefined ? patch.theme || null : existing.theme,
      font: patch.font !== undefined ? patch.font || null : existing.font,
      fontSize: patch.fontSize !== undefined ? patch.fontSize || null : existing.fontSize,
      startupSnippetId:
        patch.startupSnippetId !== undefined
          ? patch.startupSnippetId || null
          : existing.startupSnippetId,
      agentForwarding:
        patch.agentForwarding !== undefined
          ? patch.agentForwarding
            ? 1
            : 0
          : existing.agentForwarding,
      keepaliveSeconds: pick('keepaliveSeconds', existing.keepaliveSeconds),
      notes: patch.notes !== undefined ? patch.notes || null : existing.notes,
    };

    const updateFields = [...HOST_FIELDS, 'secretBlob', 'hasPassword', 'hasKey'];

    await run(
      `UPDATE hosts SET ${updateFields.map((f) => f + ' = ?').join(', ')},
         updatedAt = ${NOW}
       WHERE id = ?`,
      [...HOST_FIELDS.map((f) => merged[f]), secretBlob, hasPassword, hasKey, id]
    );
    return hosts.find(id);
  },

  async touch(id) {
    await run(`UPDATE hosts SET lastUsedAt = ${NOW} WHERE id = ?`, [id]);
  },

  async remove(id) {
    await run('DELETE FROM hosts WHERE id = ?', [id]);
    return true;
  },

  /**
   * Turn a host row into ssh2 connect options, decrypting the linked identity
   * or direct host credentials.
   */
  async resolveAuth(hostId) {
    const host = await get('SELECT * FROM hosts WHERE id = ?', [hostId]);
    if (!host) throw new Error('Host not found');

    let secret = {};
    let identity = null;

    // Check direct host credentials first
    if (host.secretBlob) {
      secret = vault.open(host.secretBlob) || {};
    }

    // Fall back or merge with linked identity credentials
    if (host.identityId && (!secret.password && !secret.privateKey)) {
      identity = await get('SELECT * FROM identities WHERE id = ?', [host.identityId]);
      if (identity && identity.secretBlob) {
        const idSecret = vault.open(identity.secretBlob) || {};
        secret = { ...idSecret, ...secret };
      }
    }

    const username = host.username || (identity && identity.username) || '';
    if (!username) {
      throw new Error(
        `No username for "${host.label}" - set one on the host or on its identity`
      );
    }

    return {
      host,
      identity: identity ? publicIdentity(identity) : null,
      totpSecret: secret.totpSecret || null,
      options: {
        host: host.hostname,
        port: host.port || 22,
        username,
        password: secret.password || undefined,
        privateKey: secret.privateKey || undefined,
        passphrase: secret.passphrase || undefined,
        agentForward: !!host.agentForwarding,
        keepaliveInterval: (host.keepaliveSeconds || 30) * 1000,
      },
    };
  },
};

/* -------------------------------------------------------------------------- */
/* snippets                                                                   */
/* -------------------------------------------------------------------------- */

const snippets = {
  async list() {
    const rows = await all('SELECT * FROM snippets ORDER BY label ASC');
    return rows.map((r) => ({ ...r, tags: splitTags(r.tags) }));
  },

  async find(id) {
    const row = await get('SELECT * FROM snippets WHERE id = ?', [id]);
    return row ? { ...row, tags: splitTags(row.tags) } : null;
  },

  async create({ label, body, description, tags }) {
    if (!label || !label.trim()) throw new Error('Snippet label is required');
    if (!body || !body.trim()) throw new Error('Snippet body is required');
    const res = await run(
      'INSERT INTO snippets (label, body, description, tags) VALUES (?, ?, ?, ?)',
      [label.trim(), body, description || null, serialiseTags(tags)]
    );
    return snippets.find(res.lastID);
  },

  async update(id, patch) {
    const existing = await get('SELECT * FROM snippets WHERE id = ?', [id]);
    if (!existing) throw new Error('Snippet not found');

    // COALESCE alone cannot express "clear this field": serialiseTags returns
    // null for an emptied tag list, which used to read as "leave them alone"
    // and made removing the last tag or the description impossible.
    await run(
      `UPDATE snippets SET
         label = COALESCE(?, label),
         body = COALESCE(?, body),
         description = ?,
         tags = ?,
         updatedAt = ${NOW}
       WHERE id = ?`,
      [
        patch.label ?? null,
        patch.body ?? null,
        patch.description !== undefined ? patch.description || null : existing.description,
        patch.tags !== undefined ? serialiseTags(patch.tags) : existing.tags,
        id,
      ]
    );
    return snippets.find(id);
  },

  async remove(id) {
    await run('DELETE FROM snippets WHERE id = ?', [id]);
    return true;
  },
};

/* -------------------------------------------------------------------------- */
/* port forwards                                                              */
/* -------------------------------------------------------------------------- */

const VALID_FORWARD_TYPES = new Set(['local', 'remote', 'dynamic']);

const forwards = {
  async list(hostId) {
    if (hostId) {
      return all('SELECT * FROM port_forwards WHERE hostId = ? ORDER BY label ASC', [hostId]);
    }
    return all(`
      SELECT f.*, h.label AS hostLabel, h.hostname
      FROM port_forwards f
      JOIN hosts h ON h.id = f.hostId
      ORDER BY f.label ASC
    `);
  },

  async find(id) {
    return get('SELECT * FROM port_forwards WHERE id = ?', [id]);
  },

  validate(input) {
    const type = String(input.type || 'local').toLowerCase();
    if (!VALID_FORWARD_TYPES.has(type)) {
      throw new Error(`Unknown forward type "${type}"`);
    }
    const listenPort = parseInt(input.listenPort, 10);
    if (!listenPort || listenPort < 1 || listenPort > 65535) {
      throw new Error('Listen port must be between 1 and 65535');
    }
    // Dynamic (SOCKS5) resolves its destination per request from the SOCKS
    // handshake, so a stored destination would be meaningless.
    if (type !== 'dynamic') {
      const destPort = parseInt(input.destPort, 10);
      if (!input.destHost || !String(input.destHost).trim()) {
        throw new Error(`${type} forwarding needs a destination host`);
      }
      if (!destPort || destPort < 1 || destPort > 65535) {
        throw new Error(`${type} forwarding needs a destination port between 1 and 65535`);
      }
    }
    return {
      type,
      listenHost: input.listenHost || '127.0.0.1',
      listenPort,
      destHost: type === 'dynamic' ? null : String(input.destHost).trim(),
      destPort: type === 'dynamic' ? null : parseInt(input.destPort, 10),
    };
  },

  async create(input) {
    if (!input.hostId) throw new Error('A port forward must belong to a host');
    if (!input.label || !input.label.trim()) throw new Error('Forward label is required');
    const v = forwards.validate(input);
    const res = await run(
      `INSERT INTO port_forwards
         (hostId, label, type, listenHost, listenPort, destHost, destPort, autoStart)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.hostId,
        input.label.trim(),
        v.type,
        v.listenHost,
        v.listenPort,
        v.destHost,
        v.destPort,
        input.autoStart ? 1 : 0,
      ]
    );
    return forwards.find(res.lastID);
  },

  async update(id, patch) {
    const existing = await forwards.find(id);
    if (!existing) throw new Error('Port forward not found');
    const v = forwards.validate({ ...existing, ...patch });
    await run(
      `UPDATE port_forwards SET
         label = COALESCE(?, label), type = ?, listenHost = ?, listenPort = ?,
         destHost = ?, destPort = ?, autoStart = ?
       WHERE id = ?`,
      [
        patch.label ?? null,
        v.type,
        v.listenHost,
        v.listenPort,
        v.destHost,
        v.destPort,
        (patch.autoStart ?? existing.autoStart) ? 1 : 0,
        id,
      ]
    );
    return forwards.find(id);
  },

  async remove(id) {
    await run('DELETE FROM port_forwards WHERE id = ?', [id]);
    return true;
  },
};

/* -------------------------------------------------------------------------- */
/* known hosts                                                                */
/* -------------------------------------------------------------------------- */

const knownHosts = {
  async list() {
    return all('SELECT * FROM known_hosts ORDER BY host ASC');
  },

  async lookup(host, port, keyType) {
    return get('SELECT * FROM known_hosts WHERE host = ? AND port = ? AND keyType = ?', [
      host,
      port,
      keyType,
    ]);
  },

  async trust(host, port, keyType, fingerprint) {
    await run(
      `INSERT INTO known_hosts (host, port, keyType, fingerprint) VALUES (?, ?, ?, ?)
       ON CONFLICT(host, port, keyType) DO UPDATE SET fingerprint = excluded.fingerprint`,
      [host, port, keyType, fingerprint]
    );
    return true;
  },

  async forget(id) {
    await run('DELETE FROM known_hosts WHERE id = ?', [id]);
    return true;
  },
};

module.exports = {
  groups,
  identities,
  hosts,
  snippets,
  forwards,
  knownHosts,
  publicIdentity,
  publicHost,
  serialiseTags,
  splitTags,
};
