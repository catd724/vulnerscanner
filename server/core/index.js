'use strict';

/**
 * terminal.ai - shared runtime singletons.
 *
 * server.js requires this directly; Next route handlers reach the same object
 * through src/lib/core.js. Both run in one process, so the instances are
 * pinned to globalThis - otherwise the Next bundle would get its own copy of
 * the vault (locked) and its own SshManager (empty).
 */

const db = require('./db');
const vault = require('./vault');
const repo = require('./repo');
const legacy = require('./legacy');
const { SshManager } = require('./sshManager');

const KEY = '__TERMINALAI_CORE__';

if (!globalThis[KEY]) {
  globalThis[KEY] = {
    db,
    vault,
    repo,
    legacy,
    ssh: new SshManager(),
    ready: db.init(),
  };
}

module.exports = globalThis[KEY];
