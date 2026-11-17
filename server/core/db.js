'use strict';

/**
 * terminal.ai - storage layer
 *
 * Thin promise wrapper over sqlite3 (kept from the original src/lib/db.js API:
 * run / all / get) plus the full schema for hosts, groups, identities,
 * snippets, port forwards and known hosts.
 *
 * This module is CommonJS on purpose: it is required by server.js (plain node)
 * and reached from Next route handlers through server/core/index.js, so both
 * sides share exactly one sqlite handle and one connection pool.
 */

const sqlite3 = require('sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.resolve(process.cwd(), 'connections.db');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('[db] Error opening SQLite database:', err.message);
  }
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

/** ALTER TABLE ADD COLUMN that stays quiet when the column already exists. */
async function addColumn(table, definition) {
  try {
    await run(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) throw err;
  }
}

const SCHEMA = [
  // --- vault ----------------------------------------------------------------
  // Exactly one row. Holds the KDF salt/params and a verifier blob used to
  // check a master password without ever storing the key itself.
  `CREATE TABLE IF NOT EXISTS vault_meta (
     id          INTEGER PRIMARY KEY CHECK (id = 1),
     kdf         TEXT NOT NULL,
     kdf_salt    TEXT NOT NULL,
     kdf_params  TEXT NOT NULL,
     verifier    TEXT NOT NULL,
     totpBlob    TEXT,
     createdAt   DATETIME DEFAULT CURRENT_TIMESTAMP
   )`,

  // --- organisation ---------------------------------------------------------
  // parentId gives arbitrary-depth hierarchy (Termius "groups" behaviour).
  `CREATE TABLE IF NOT EXISTS groups (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     name       TEXT NOT NULL,
     parentId   INTEGER REFERENCES groups(id) ON DELETE CASCADE,
     color      TEXT,
     sortOrder  INTEGER NOT NULL DEFAULT 0,
     createdAt  DATETIME DEFAULT CURRENT_TIMESTAMP
   )`,

  // --- identity vault -------------------------------------------------------
  // secretBlob is the AES-256-GCM envelope produced by core/crypto.js; it is
  // never returned to the browser by any route handler.
  `CREATE TABLE IF NOT EXISTS identities (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     label       TEXT NOT NULL,
     username    TEXT NOT NULL DEFAULT '',
     authType    TEXT NOT NULL DEFAULT 'password',
     secretBlob  TEXT,
     hasPassword INTEGER NOT NULL DEFAULT 0,
     hasKey      INTEGER NOT NULL DEFAULT 0,
     hasTotp     INTEGER NOT NULL DEFAULT 0,
     keyType     TEXT,
     fingerprint TEXT,
     createdAt   DATETIME DEFAULT CURRENT_TIMESTAMP,
     updatedAt   DATETIME DEFAULT CURRENT_TIMESTAMP
   )`,

  // --- hosts ----------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS hosts (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     label          TEXT NOT NULL,
     hostname       TEXT NOT NULL,
     port           INTEGER NOT NULL DEFAULT 22,
     groupId        INTEGER REFERENCES groups(id) ON DELETE SET NULL,
     identityId     INTEGER REFERENCES identities(id) ON DELETE SET NULL,
     username       TEXT,
     jumpHostId     INTEGER REFERENCES hosts(id) ON DELETE SET NULL,
     tags           TEXT,
     color          TEXT,
     theme          TEXT,
     font           TEXT,
     fontSize       INTEGER,
     startupSnippetId INTEGER REFERENCES snippets(id) ON DELETE SET NULL,
     agentForwarding INTEGER NOT NULL DEFAULT 0,
     keepaliveSeconds INTEGER NOT NULL DEFAULT 30,
     secretBlob     TEXT,
     hasPassword    INTEGER NOT NULL DEFAULT 0,
     hasKey         INTEGER NOT NULL DEFAULT 0,
     osType         TEXT DEFAULT 'ubuntu',
     notes          TEXT,
     createdAt      DATETIME DEFAULT CURRENT_TIMESTAMP,
     updatedAt      DATETIME DEFAULT CURRENT_TIMESTAMP,
     lastUsedAt     DATETIME
   )`,

  // --- snippets -------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS snippets (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     label       TEXT NOT NULL,
     body        TEXT NOT NULL,
     description TEXT,
     tags        TEXT,
     createdAt   DATETIME DEFAULT CURRENT_TIMESTAMP,
     updatedAt   DATETIME DEFAULT CURRENT_TIMESTAMP
   )`,

  // --- port forwarding ------------------------------------------------------
  // type: 'local' (-L) | 'remote' (-R) | 'dynamic' (-D, SOCKS5)
  `CREATE TABLE IF NOT EXISTS port_forwards (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     hostId     INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
     label      TEXT NOT NULL,
     type       TEXT NOT NULL DEFAULT 'local',
     listenHost TEXT NOT NULL DEFAULT '127.0.0.1',
     listenPort INTEGER NOT NULL,
     destHost   TEXT,
     destPort   INTEGER,
     autoStart  INTEGER NOT NULL DEFAULT 0,
     createdAt  DATETIME DEFAULT CURRENT_TIMESTAMP
   )`,

  // --- trust store ----------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS known_hosts (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     host        TEXT NOT NULL,
     port        INTEGER NOT NULL DEFAULT 22,
     keyType     TEXT NOT NULL,
     fingerprint TEXT NOT NULL,
     createdAt   DATETIME DEFAULT CURRENT_TIMESTAMP,
     UNIQUE (host, port, keyType)
   )`,

  `CREATE TABLE IF NOT EXISTS settings (
     key   TEXT PRIMARY KEY,
     value TEXT
   )`,

  `CREATE INDEX IF NOT EXISTS idx_hosts_group ON hosts(groupId)`,
  `CREATE INDEX IF NOT EXISTS idx_hosts_identity ON hosts(identityId)`,
  `CREATE INDEX IF NOT EXISTS idx_forwards_host ON port_forwards(hostId)`,
  `CREATE INDEX IF NOT EXISTS idx_groups_parent ON groups(parentId)`,
];

let initPromise = null;

/** Idempotent. Safe to await from every entry point. */
function init() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await run('PRAGMA foreign_keys = ON');
    await run('PRAGMA journal_mode = WAL');

    for (const stmt of SCHEMA) {
      await run(stmt);
    }

    // The original build stored hosts in `connections` with plaintext secrets.
    // Keep the table untouched here: core/legacy.js imports and encrypts it the
    // first time the vault is unlocked, then marks it done in `settings`.
    // Added after the first release; existing vaults need it backfilled.
    await addColumn('hosts', 'font TEXT');

    // Two-factor support, added after the first release.
    // vault_meta.totpBlob holds the sealed TOTP secret guarding the unlock
    // screen; identities.hasTotp is the public flag for "this identity can
    // answer a server's verification-code prompt" (the secret itself lives
    // inside the identity's existing sealed bundle, never in its own column).
    await addColumn('vault_meta', 'totpBlob TEXT');
    await addColumn('identities', 'hasTotp INTEGER NOT NULL DEFAULT 0');

    // Direct host credentials and OS icon support (Termius style)
    await addColumn('hosts', 'secretBlob TEXT');
    await addColumn('hosts', 'hasPassword INTEGER NOT NULL DEFAULT 0');
    await addColumn('hosts', 'hasKey INTEGER NOT NULL DEFAULT 0');
    await addColumn('hosts', 'osType TEXT DEFAULT "ubuntu"');

    const legacy = await get(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connections'`
    );
    if (legacy) {
      await addColumn('connections', 'category TEXT');
      await addColumn('connections', 'tags TEXT');
    }

    return true;
  })();

  return initPromise;
}

async function getSetting(key, fallback = null) {
  const row = await get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  await run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}

module.exports = { db, dbPath, run, all, get, init, getSetting, setSetting };
