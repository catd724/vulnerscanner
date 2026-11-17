/**
 * terminal.ai - custom Next.js server.
 *
 * Boots the shared runtime (vault, storage, SSH manager) before Next starts so
 * route handlers and the Socket.IO layer resolve the same singletons, then
 * serves the app and the terminal transport from one port.
 *
 * Binds to 127.0.0.1 by default: this process can open authenticated SSH
 * sessions and bind local tunnel ports, so it has no business listening on a
 * public interface. Override with HOST=0.0.0.0 only if you know why.
 */

const { createServer } = require('http');
const { parse } = require('url');
const { join } = require('path');
const next = require('next');
const { Server } = require('socket.io');
const serveStatic = require('serve-static');

const core = require('./server/core');
const { attachSocketApi } = require('./server/core/socketApi');

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT, 10) || 3000;
const hostname = process.env.HOST || '127.0.0.1';

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

async function main() {
  await core.ready;
  await app.prepare();

  const scriptsStatic = serveStatic(join(__dirname, 'scripts'), {
    index: false,
    dotfiles: 'ignore',
  });

  const httpServer = createServer((req, res) => {
    const parsed = parse(req.url, true);
    if (parsed.pathname.startsWith('/scripts/')) {
      // Strip the /scripts prefix so serve-static resolves from the scripts dir.
      req.url = parsed.pathname.slice('/scripts'.length) + (parsed.search || '');
      scriptsStatic(req, res, () => handle(req, res, parsed));
      return;
    }
    handle(req, res, parsed);
  });

  const io = new Server(httpServer, {
    // Same-origin only: the UI is served from this very process.
    cors: { origin: false },
    maxHttpBufferSize: 1e7,
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  attachSocketApi(io);

  httpServer.listen(port, hostname, () => {
    const status = core.vault.isUnlocked ? 'unlocked' : 'locked';
    console.log(`\n  AI Terminal  ready on http://${hostname}:${port}`);
    console.log(`  storage: ${core.db.dbPath}`);
    console.log(`  vault:   ${status}\n`);
  });

  const shutdown = async (signal) => {
    console.log(`\n[server] ${signal} - closing SSH sessions...`);
    try {
      await core.ssh.closeAll();
    } catch (err) {
      console.error('[server] Error during shutdown:', err.message);
    }
    httpServer.close(() => process.exit(0));
    // Do not hang forever on a stuck socket.
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
