'use strict';

/**
 * terminal.ai - one-shot import of the pre-vault `connections` table.
 *
 * The original build stored name/host/port/username plus plaintext password,
 * privateKey and passphrase in a single flat table. Those secrets cannot be
 * sealed until a master key exists, so the import runs on the first successful
 * vault unlock rather than at schema time.
 *
 * Each legacy row becomes: a group (from `category`), an identity (holding the
 * credentials, now encrypted) and a host that links the two.
 */

const db = require('./db');
const repo = require('./repo');

const FLAG = 'legacyConnectionsImported';

async function hasLegacyTable() {
  const row = await db.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connections'"
  );
  return !!row;
}

async function pending() {
  if (!(await hasLegacyTable())) return 0;
  if ((await db.getSetting(FLAG)) === '1') return 0;
  const row = await db.get('SELECT COUNT(*) AS n FROM connections');
  return row ? row.n : 0;
}

/**
 * Import every legacy row. Requires an unlocked vault.
 * Returns a summary; safe to call repeatedly (the flag short-circuits it).
 */
async function importLegacy() {
  if (!(await hasLegacyTable())) return { imported: 0, skipped: 0, alreadyDone: true };
  if ((await db.getSetting(FLAG)) === '1') {
    return { imported: 0, skipped: 0, alreadyDone: true };
  }

  const rows = await db.all('SELECT * FROM connections ORDER BY id ASC');
  const groupCache = new Map();
  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      let groupId = null;
      const category = (row.category || '').trim();
      if (category) {
        if (!groupCache.has(category)) {
          const existing = (await repo.groups.list()).find(
            (g) => g.name.toLowerCase() === category.toLowerCase()
          );
          const group = existing || (await repo.groups.create({ name: category }));
          groupCache.set(category, group.id);
        }
        groupId = groupCache.get(category);
      }

      const identity = await repo.identities.create({
        label: `${row.name || row.host} credentials`,
        username: row.username || '',
        authType: row.authMethod === 'privateKey' ? 'key' : 'password',
        password: row.password || null,
        privateKey: row.privateKey || null,
        passphrase: row.passphrase || null,
      });

      await repo.hosts.create({
        label: row.name || `${row.username}@${row.host}`,
        hostname: row.host,
        port: row.port || 22,
        groupId,
        identityId: identity.id,
        username: row.username || null,
        tags: row.tags || null,
      });

      imported += 1;
    } catch (err) {
      console.error(`[legacy] Skipped connection #${row.id}:`, err.message);
      skipped += 1;
    }
  }

  // Only call it done if something actually landed. A run where every row
  // failed - a locked vault, a disk error - must stay repeatable, or the flag
  // below plus the scrub underneath would destroy the only copy of the data.
  if (imported === 0 && skipped > 0) {
    console.error(`[legacy] Imported nothing (${skipped} failed) - leaving the table in place`);
    return { imported, skipped, alreadyDone: false };
  }

  await db.setSetting(FLAG, '1');

  // Archive the old table so the import is auditable, but scrub the plaintext
  // credentials out of it first - leaving them in the same file would defeat
  // the vault entirely. VACUUM then rewrites the database so the freed pages
  // that still held those bytes are not left behind on disk.
  try {
    await db.run('ALTER TABLE connections RENAME TO connections_legacy_backup');
    await db.run(
      'UPDATE connections_legacy_backup SET password = NULL, privateKey = NULL, passphrase = NULL'
    );
    // VACUUM rebuilds the database so the freed pages holding those bytes are
    // gone, and the TRUNCATE checkpoint pushes the rebuild into the main file
    // and empties the WAL - without it the old plaintext pages survive in both.
    await db.run('VACUUM');
    await db.run('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (err) {
    console.error('[legacy] Could not archive the connections table:', err.message);
  }

  return { imported, skipped, alreadyDone: false };
}

module.exports = { pending, importLegacy, FLAG };
