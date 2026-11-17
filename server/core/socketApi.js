'use strict';

/**
 * terminal.ai - Socket.IO transport.
 *
 * Everything interactive rides one multiplexed socket: terminal I/O for every
 * pane, SFTP directory operations, tunnel control and auth prompts. File
 * transfers deliberately do not - they stream over HTTP so large uploads and
 * downloads never sit in a base64 frame (see src/app/api/sftp/*).
 *
 * The browser only ever sends a hostId. Credentials are resolved server-side
 * from the vault, so a compromised page cannot read them back.
 */

const posix = require('path').posix;
const core = require('./index');

// Keep sessions alive briefly after the last window goes away so a page reload
// does not tear down live shells and tunnels.
const ORPHAN_GRACE_MS = 60000;

function fileEntry(item) {
  const attrs = item.attrs || {};
  const mode = attrs.mode || 0;
  return {
    name: item.filename,
    longname: item.longname,
    size: attrs.size ?? 0,
    mtime: attrs.mtime ? attrs.mtime * 1000 : null,
    mode,
    permissions: (mode & 0o777).toString(8).padStart(3, '0'),
    isDirectory: typeof attrs.isDirectory === 'function' ? attrs.isDirectory() : false,
    isSymlink: typeof attrs.isSymbolicLink === 'function' ? attrs.isSymbolicLink() : false,
  };
}

/** Wrap a node-style sftp call as a promise. */
function sftpCall(wrapper, method, ...args) {
  return new Promise((resolve, reject) => {
    wrapper[method](...args, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

function attachSocketApi(io) {
  const { ssh, repo, vault } = core;

  let orphanTimer = null;

  const broadcast = (event) => io.emit('session:event', event);

  const cancelOrphanTimer = () => {
    if (orphanTimer) {
      clearTimeout(orphanTimer);
      orphanTimer = null;
    }
  };

  /** Uniform ack shape so the client never has to guess. */
  const handle = (fn) => async (payload, ack) => {
    try {
      const data = await fn(payload || {});
      if (typeof ack === 'function') ack({ ok: true, data });
    } catch (err) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: err.message, code: err.code || null });
      }
    }
  };

  const requireSession = (sessionId) => ssh.require(sessionId);

  const requireSftp = async (sessionId) => {
    const session = requireSession(sessionId);
    return session.sftp();
  };

  io.on('connection', (socket) => {
    cancelOrphanTimer();

    socket.emit('hello', {
      sessions: ssh.list(),
      vault: { unlocked: vault.isUnlocked },
    });

    /* --- sessions -------------------------------------------------------- */

    socket.on(
      'session:open',
      handle(async ({ hostId }) => {
        if (!hostId) throw new Error('hostId is required');
        if (!vault.isUnlocked) {
          const err = new Error('Vault is locked');
          err.code = 'VAULT_LOCKED';
          throw err;
        }
        const session = await ssh.open(hostId, { onEvent: broadcast });
        broadcast({ type: 'opened', sessionId: session.id, payload: session.describe() });
        return session.describe();
      })
    );

    socket.on('session:list', handle(async () => ssh.list()));

    socket.on(
      'session:close',
      handle(async ({ sessionId }) => ssh.close(sessionId))
    );

    socket.on(
      'prompt:answer',
      handle(async ({ sessionId, promptId, ...answer }) => {
        const session = requireSession(sessionId);
        return session.answerPrompt(promptId, answer);
      })
    );

    /* --- shells ---------------------------------------------------------- */

    socket.on(
      'shell:open',
      handle(async ({ sessionId, paneId, cols, rows }) => {
        if (!paneId) throw new Error('paneId is required');
        const session = requireSession(sessionId);
        await session.openShell(paneId, { cols, rows });
        return { paneId };
      })
    );

    // High-frequency, no ack: keystrokes must not wait on a round trip.
    socket.on('shell:input', ({ sessionId, paneId, data }) => {
      const session = ssh.get(sessionId);
      if (session) session.writeShell(paneId, data);
    });

    socket.on('shell:resize', ({ sessionId, paneId, cols, rows }) => {
      const session = ssh.get(sessionId);
      if (session) session.resizeShell(paneId, cols, rows);
    });

    socket.on(
      'shell:close',
      handle(async ({ sessionId, paneId }) => {
        const session = ssh.get(sessionId);
        return session ? session.closeShell(paneId) : false;
      })
    );

    /* --- snippets -------------------------------------------------------- */

    socket.on(
      'snippet:run',
      handle(async ({ targets, body, appendNewline = true }) => {
        if (!body) throw new Error('Snippet body is empty');
        if (!Array.isArray(targets) || targets.length === 0) {
          throw new Error('Pick at least one target pane');
        }
        const text = appendNewline && !body.endsWith('\n') ? `${body}\n` : body;

        const results = targets.map(({ sessionId, paneId }) => {
          const session = ssh.get(sessionId);
          if (!session) return { sessionId, paneId, ok: false, error: 'Session not found' };
          const ok = session.writeShell(paneId, text);
          return { sessionId, paneId, ok, error: ok ? null : 'Pane has no shell' };
        });

        return { results, delivered: results.filter((r) => r.ok).length };
      })
    );

    /* --- sftp ------------------------------------------------------------ */

    socket.on(
      'sftp:list',
      handle(async ({ sessionId, path: dir }) => {
        const sftp = await requireSftp(sessionId);
        const target = dir && dir.trim() ? dir : await sftpCall(sftp, 'realpath', '.');
        const entries = await sftpCall(sftp, 'readdir', target);
        return {
          path: posix.normalize(target),
          entries: entries
            .map(fileEntry)
            .filter((e) => e.name !== '.' && e.name !== '..')
            .sort((a, b) => {
              if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
              return a.name.localeCompare(b.name);
            }),
        };
      })
    );

    socket.on(
      'sftp:home',
      handle(async ({ sessionId }) => {
        const sftp = await requireSftp(sessionId);
        return { path: await sftpCall(sftp, 'realpath', '.') };
      })
    );

    socket.on(
      'sftp:mkdir',
      handle(async ({ sessionId, path: dir }) => {
        const sftp = await requireSftp(sessionId);
        await sftpCall(sftp, 'mkdir', dir);
        return { path: dir };
      })
    );

    socket.on(
      'sftp:rename',
      handle(async ({ sessionId, from, to }) => {
        const sftp = await requireSftp(sessionId);
        await sftpCall(sftp, 'rename', from, to);
        return { from, to };
      })
    );

    socket.on(
      'sftp:remove',
      handle(async ({ sessionId, path: target, isDirectory }) => {
        const sftp = await requireSftp(sessionId);
        await sftpCall(sftp, isDirectory ? 'rmdir' : 'unlink', target);
        return { path: target };
      })
    );

    socket.on(
      'sftp:chmod',
      handle(async ({ sessionId, path: target, mode }) => {
        const sftp = await requireSftp(sessionId);
        const parsed = typeof mode === 'string' ? parseInt(mode, 8) : mode;
        if (Number.isNaN(parsed)) throw new Error('Mode must be octal, e.g. 644');
        await sftpCall(sftp, 'chmod', target, parsed);
        return { path: target, mode: parsed };
      })
    );

    /* --- tunnels --------------------------------------------------------- */

    socket.on(
      'tunnel:start',
      handle(async ({ sessionId, forwardId, config }) => {
        const session = requireSession(sessionId);

        let spec;
        if (forwardId) {
          const saved = await repo.forwards.find(forwardId);
          if (!saved) throw new Error('Saved port forward not found');
          spec = {
            forwardKey: `saved-${saved.id}`,
            forwardId: saved.id,
            label: saved.label,
            type: saved.type,
            listenHost: saved.listenHost,
            listenPort: saved.listenPort,
            destHost: saved.destHost,
            destPort: saved.destPort,
          };
        } else {
          const v = repo.forwards.validate(config || {});
          spec = { label: config.label || 'Ad-hoc tunnel', ...v };
        }

        return session.startForward(spec);
      })
    );

    socket.on(
      'tunnel:stop',
      handle(async ({ sessionId, forwardKey }) => {
        const session = requireSession(sessionId);
        return session.stopForward(forwardKey);
      })
    );

    socket.on(
      'tunnel:list',
      handle(async ({ sessionId }) => {
        if (sessionId) return requireSession(sessionId).listForwards();
        return ssh
          .list()
          .flatMap((s) => (ssh.get(s.sessionId) ? ssh.get(s.sessionId).listForwards() : []));
      })
    );

    /* --- teardown -------------------------------------------------------- */

    socket.on('disconnect', () => {
      if (io.engine.clientsCount > 0) return;
      cancelOrphanTimer();
      orphanTimer = setTimeout(async () => {
        if (io.engine.clientsCount > 0) return;
        console.log('[socket] No windows left - closing SSH sessions');
        await ssh.closeAll();
      }, ORPHAN_GRACE_MS);
      orphanTimer.unref?.();
    });
  });

  // A locked vault must not leave authenticated connections running.
  vault.on('locked', () => {
    ssh.closeAll().catch(() => {});
    io.emit('vault:locked');
  });

  return io;
}

module.exports = { attachSocketApi, fileEntry, sftpCall };
