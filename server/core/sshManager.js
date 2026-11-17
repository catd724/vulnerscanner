'use strict';

/**
 * terminal.ai - SSH session manager.
 *
 * One ssh2.Client per session, multiplexing everything the UI needs over that
 * single authenticated connection:
 *
 *   - N shell channels (one per terminal pane, so a split view costs one TCP
 *     connection, not one per pane)
 *   - one lazily-opened SFTP subsystem shared by the file manager
 *   - any number of local / remote / dynamic port forwards
 *
 * Credentials are resolved here from the vault and handed straight to ssh2;
 * they are never returned to a caller.
 */

const { EventEmitter } = require('events');
const net = require('net');
const crypto = require('crypto');
const { Client, utils } = require('ssh2');

const repo = require('./repo');
const totp = require('./totp');
const { createSocks5Server } = require('./socks5');

const HOSTKEY_PROMPT_TIMEOUT_MS = 120000;
const AUTH_PROMPT_TIMEOUT_MS = 120000;
const MAX_JUMP_DEPTH = 5;

let sessionCounter = 0;
const nextSessionId = () => `s${++sessionCounter}-${Date.now().toString(36)}`;

/** OpenSSH-style fingerprint of a raw public key blob. */
function fingerprintOf(keyBuffer) {
  const digest = crypto.createHash('sha256').update(keyBuffer).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

function keyTypeOf(keyBuffer) {
  try {
    const parsed = utils.parseKey(keyBuffer);
    if (!(parsed instanceof Error) && parsed.type) return parsed.type;
  } catch {
    /* fall through */
  }
  // The blob starts with a length-prefixed algorithm name.
  try {
    const len = keyBuffer.readUInt32BE(0);
    return keyBuffer.subarray(4, 4 + len).toString('ascii');
  } catch {
    return 'unknown';
  }
}

/* -------------------------------------------------------------------------- */

class SshSession extends EventEmitter {
  constructor(id, { hostId, label, hostname, port, username }) {
    super();
    this.id = id;
    this.hostId = hostId;
    this.label = label;
    this.hostname = hostname;
    this.port = port;
    this.username = username;

    this.client = null;
    this.status = 'idle';
    this.shells = new Map(); // paneId -> ssh2 channel
    this.forwards = new Map(); // forwardKey -> { meta, close() }
    this.remoteForwards = new Map(); // "addr:port" -> forwardKey, for routing 'tcp connection'
    this.sftpWrapper = null;
    this.sftpPending = null;
    this.pendingPrompts = new Map();
    this.closed = false;
  }

  describe() {
    return {
      sessionId: this.id,
      hostId: this.hostId,
      label: this.label,
      hostname: this.hostname,
      port: this.port,
      username: this.username,
      status: this.status,
      panes: Array.from(this.shells.keys()),
      forwards: Array.from(this.forwards.values()).map((f) => f.meta),
      sftpReady: !!this.sftpWrapper,
    };
  }

  setStatus(status, message) {
    this.status = status;
    this.emit('status', { status, message });
  }

  /* --- interactive prompts ------------------------------------------------ */

  /**
   * Ask the UI a question and wait. Used for unknown host keys and
   * keyboard-interactive auth; both must block the SSH handshake.
   */
  ask(kind, payload, timeoutMs) {
    const promptId = `${kind}-${crypto.randomBytes(6).toString('hex')}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPrompts.delete(promptId);
        reject(new Error(`Timed out waiting for a response to the ${kind} prompt`));
      }, timeoutMs);
      timer.unref?.();

      this.pendingPrompts.set(promptId, (answer) => {
        clearTimeout(timer);
        this.pendingPrompts.delete(promptId);
        resolve(answer);
      });

      this.emit('prompt', { kind, promptId, ...payload });
    });
  }

  answerPrompt(promptId, answer) {
    const resolver = this.pendingPrompts.get(promptId);
    if (!resolver) return false;
    resolver(answer);
    return true;
  }

  /* --- lifecycle ---------------------------------------------------------- */

  attachClient(client) {
    this.client = client;

    client.on('banner', (message) => this.emit('banner', message));

    client.on('error', (err) => {
      this.setStatus('error', err.message);
    });

    client.on('end', () => {
      if (!this.closed) this.setStatus('disconnected', 'Connection ended by the remote host');
    });

    client.on('close', () => {
      if (!this.closed) this.setStatus('disconnected', 'Connection closed');
      this.teardown();
    });

    // Remote (-R) forwards all surface here; route by the bound address:port.
    client.on('tcp connection', (info, accept, reject) => {
      const key =
        this.remoteForwards.get(`${info.destIP}:${info.destPort}`) ||
        this.remoteForwards.get(`*:${info.destPort}`) ||
        this.remoteForwards.get(`0.0.0.0:${info.destPort}`);
      const entry = key ? this.forwards.get(key) : null;

      if (!entry) {
        reject();
        return;
      }

      const { destHost, destPort } = entry.meta;
      const local = net.connect(destPort, destHost, () => {
        const channel = accept();
        entry.meta.connections += 1;
        this.emit('tunnel', { forwardKey: key, event: 'connection', meta: entry.meta });
        channel.pipe(local).pipe(channel);
        channel.on('close', () => local.destroy());
      });
      local.on('error', (err) => {
        this.emit('tunnel', { forwardKey: key, event: 'error', message: err.message });
        reject();
      });
    });
  }

  /* --- shells ------------------------------------------------------------- */

  openShell(paneId, { cols = 80, rows = 24, term = 'xterm-256color' } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('Session is not connected'));
      if (this.shells.has(paneId)) return resolve(this.shells.get(paneId));

      this.client.shell({ term, cols, rows }, (err, stream) => {
        if (err) return reject(err);

        this.shells.set(paneId, stream);

        stream.on('data', (data) => {
          this.emit('shell-data', { paneId, data: data.toString('utf8') });
        });
        stream.stderr?.on('data', (data) => {
          this.emit('shell-data', { paneId, data: data.toString('utf8') });
        });
        stream.on('close', () => {
          this.shells.delete(paneId);
          this.emit('shell-close', { paneId });
          // Last pane gone and nothing else in flight: drop the connection.
          if (this.shells.size === 0 && this.forwards.size === 0 && !this.sftpWrapper) {
            this.close();
          }
        });

        resolve(stream);
      });
    });
  }

  writeShell(paneId, data) {
    const stream = this.shells.get(paneId);
    if (!stream) return false;
    stream.write(data);
    return true;
  }

  resizeShell(paneId, cols, rows) {
    const stream = this.shells.get(paneId);
    if (!stream || typeof stream.setWindow !== 'function') return false;
    try {
      stream.setWindow(rows, cols, 0, 0);
      return true;
    } catch {
      return false;
    }
  }

  closeShell(paneId) {
    const stream = this.shells.get(paneId);
    if (!stream) return false;
    stream.end();
    this.shells.delete(paneId);
    return true;
  }

  /* --- sftp --------------------------------------------------------------- */

  sftp() {
    if (this.sftpWrapper) return Promise.resolve(this.sftpWrapper);
    if (this.sftpPending) return this.sftpPending;

    this.sftpPending = new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('Session is not connected'));
      this.client.sftp((err, wrapper) => {
        this.sftpPending = null;
        if (err) return reject(err);
        this.sftpWrapper = wrapper;
        wrapper.on('close', () => {
          this.sftpWrapper = null;
        });
        resolve(wrapper);
      });
    });

    return this.sftpPending;
  }

  /* --- port forwarding ---------------------------------------------------- */

  /** Open a direct-tcpip channel; the promise form the tunnels want. */
  forwardOut(srcHost, srcPort, destHost, destPort) {
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('Session is not connected'));
      this.client.forwardOut(srcHost, srcPort, destHost, destPort, (err, channel) =>
        err ? reject(err) : resolve(channel)
      );
    });
  }

  async startForward(config) {
    const meta = {
      forwardKey: config.forwardKey || `f-${crypto.randomBytes(4).toString('hex')}`,
      forwardId: config.forwardId ?? null,
      sessionId: this.id,
      label: config.label || 'Tunnel',
      type: config.type,
      listenHost: config.listenHost || '127.0.0.1',
      listenPort: Number(config.listenPort),
      destHost: config.destHost || null,
      destPort: config.destPort ? Number(config.destPort) : null,
      connections: 0,
      startedAt: new Date().toISOString(),
    };

    if (this.forwards.has(meta.forwardKey)) {
      throw new Error(`Tunnel "${meta.label}" is already running`);
    }

    if (meta.type === 'local') {
      const server = await this.listenLocal(meta, async (socket) => {
        const channel = await this.forwardOut(
          socket.remoteAddress || '127.0.0.1',
          socket.remotePort || 0,
          meta.destHost,
          meta.destPort
        );
        return channel;
      });
      this.forwards.set(meta.forwardKey, {
        meta,
        close: () => new Promise((r) => server.close(r)),
      });
    } else if (meta.type === 'dynamic') {
      const server = await createSocks5Server({
        listenHost: meta.listenHost,
        listenPort: meta.listenPort,
        onConnect: async (destHost, destPort, srcPort) => {
          meta.connections += 1;
          this.emit('tunnel', { forwardKey: meta.forwardKey, event: 'connection', meta });
          return this.forwardOut('127.0.0.1', srcPort || 0, destHost, destPort);
        },
        onError: (message) =>
          this.emit('tunnel', { forwardKey: meta.forwardKey, event: 'error', message }),
      });
      this.forwards.set(meta.forwardKey, {
        meta,
        close: () => new Promise((r) => server.close(r)),
      });
    } else if (meta.type === 'remote') {
      await new Promise((resolve, reject) => {
        this.client.forwardIn(meta.listenHost, meta.listenPort, (err, boundPort) => {
          if (err) return reject(err);
          // Port 0 asks the server to allocate; record what it actually bound.
          if (boundPort) meta.listenPort = boundPort;
          resolve();
        });
      });
      const routeKey = `${meta.listenHost}:${meta.listenPort}`;
      this.remoteForwards.set(routeKey, meta.forwardKey);
      this.forwards.set(meta.forwardKey, {
        meta,
        close: () =>
          new Promise((resolve) => {
            this.remoteForwards.delete(routeKey);
            try {
              this.client.unforwardIn(meta.listenHost, meta.listenPort, () => resolve());
            } catch {
              resolve();
            }
          }),
      });
    } else {
      throw new Error(`Unknown forward type "${meta.type}"`);
    }

    this.emit('tunnel', { forwardKey: meta.forwardKey, event: 'started', meta });
    return meta;
  }

  /** Local listener shared by -L and the SOCKS path's error handling. */
  listenLocal(meta, openChannel) {
    const server = net.createServer(async (socket) => {
      socket.on('error', () => socket.destroy());
      try {
        const channel = await openChannel(socket);
        meta.connections += 1;
        this.emit('tunnel', { forwardKey: meta.forwardKey, event: 'connection', meta });
        socket.pipe(channel).pipe(socket);
        channel.on('error', () => socket.destroy());
        channel.on('close', () => socket.end());
      } catch (err) {
        this.emit('tunnel', {
          forwardKey: meta.forwardKey,
          event: 'error',
          message: err.message,
        });
        socket.destroy();
      }
    });

    return new Promise((resolve, reject) => {
      server.once('error', (err) => {
        reject(
          err.code === 'EADDRINUSE'
            ? new Error(`Port ${meta.listenPort} on ${meta.listenHost} is already in use`)
            : err
        );
      });
      server.listen(meta.listenPort, meta.listenHost, () => {
        server.removeAllListeners('error');
        server.on('error', (err) =>
          this.emit('tunnel', {
            forwardKey: meta.forwardKey,
            event: 'error',
            message: err.message,
          })
        );
        resolve(server);
      });
    });
  }

  async stopForward(forwardKey) {
    const entry = this.forwards.get(forwardKey);
    if (!entry) return false;
    await entry.close();
    this.forwards.delete(forwardKey);
    this.emit('tunnel', { forwardKey, event: 'stopped', meta: entry.meta });
    return true;
  }

  listForwards() {
    return Array.from(this.forwards.values()).map((f) => f.meta);
  }

  /* --- teardown ----------------------------------------------------------- */

  async teardown() {
    for (const [key, entry] of this.forwards) {
      try {
        await entry.close();
      } catch {
        /* best effort */
      }
      this.forwards.delete(key);
    }
    this.remoteForwards.clear();
    for (const stream of this.shells.values()) {
      try {
        stream.end();
      } catch {
        /* best effort */
      }
    }
    this.shells.clear();
    this.sftpWrapper = null;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.teardown();
    try {
      this.client?.end();
    } catch {
      /* best effort */
    }
    this.setStatus('closed', 'Session closed');
    this.emit('closed');
  }
}

/* -------------------------------------------------------------------------- */

class SshManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
  }

  get(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  require(sessionId) {
    const session = this.get(sessionId);
    if (!session) throw new Error(`Unknown session "${sessionId}"`);
    return session;
  }

  list() {
    return Array.from(this.sessions.values()).map((s) => s.describe());
  }

  /**
   * Open a session for a saved host. Resolves once authentication succeeds,
   * so the caller can immediately open shells / SFTP / tunnels.
   */
  async open(hostId, { onEvent } = {}) {
    const { host, options, totpSecret } = await repo.hosts.resolveAuth(hostId);

    const session = new SshSession(nextSessionId(), {
      hostId: host.id,
      label: host.label,
      hostname: host.hostname,
      port: host.port,
      username: options.username,
    });

    this.sessions.set(session.id, session);
    if (onEvent) this.wire(session, onEvent);

    session.once('closed', () => this.sessions.delete(session.id));

    try {
      session.setStatus('connecting', `Connecting to ${host.hostname}:${host.port}`);
      const sock = await this.buildJumpChain(host, session, 0);
      await this.authenticate(session, options, sock, totpSecret);
      session.setStatus('connected', 'Authenticated');
      await repo.hosts.touch(host.id);
      return session;
    } catch (err) {
      session.setStatus('error', err.message);
      await session.close();
      this.sessions.delete(session.id);
      throw err;
    }
  }

  /** Forward every session event to a single sink (the socket layer). */
  wire(session, onEvent) {
    const relay = (type) => (payload) => onEvent({ type, sessionId: session.id, payload });
    session.on('status', relay('status'));
    session.on('shell-data', relay('shell-data'));
    session.on('shell-close', relay('shell-close'));
    session.on('prompt', relay('prompt'));
    session.on('banner', relay('banner'));
    session.on('tunnel', relay('tunnel'));
    session.on('closed', relay('closed'));
  }

  /**
   * Walk the jumpHostId chain and return a Duplex to the final target, or
   * undefined when the host is reached directly.
   */
  async buildJumpChain(host, session, depth) {
    if (!host.jumpHostId) return undefined;
    if (depth >= MAX_JUMP_DEPTH) {
      throw new Error(`Jump host chain deeper than ${MAX_JUMP_DEPTH} hops`);
    }

    const jump = await repo.hosts.resolveAuth(host.jumpHostId);
    session.setStatus('connecting', `Connecting via jump host ${jump.host.label}`);

    const jumpSock = await this.buildJumpChain(jump.host, session, depth + 1);
    const jumpSession = new SshSession(nextSessionId(), {
      hostId: jump.host.id,
      label: jump.host.label,
      hostname: jump.host.hostname,
      port: jump.host.port,
      username: jump.options.username,
    });
    // Trust prompts from a jump hop must still reach the same UI.
    jumpSession.on('prompt', (p) => session.emit('prompt', p));

    await this.authenticate(jumpSession, jump.options, jumpSock, jump.totpSecret);

    const channel = await jumpSession.forwardOut('127.0.0.1', 0, host.hostname, host.port);
    // Keep the hop alive for as long as the session that rides on it.
    session.once('closed', () => jumpSession.close());
    return channel;
  }

  /**
   * Connect + authenticate one ssh2.Client, including host-key trust.
   * `totpSecret` is the identity's one-time-code secret, if it has one; it
   * answers the server's verification-code prompt without a round trip to the
   * UI, and is never passed to ssh2 itself.
   */
  authenticate(session, options, sock, totpSecret = null) {
    return new Promise((resolve, reject) => {
      const client = new Client();
      session.attachClient(client);

      let settled = false;
      const settle = (fn, arg) => {
        if (settled) return;
        settled = true;
        fn(arg);
      };

      client.on('ready', () => settle(resolve));
      client.on('error', (err) => settle(reject, err));

      // A code is only good for one login: Google Authenticator's PAM module
      // remembers the last one used and rejects a replay. Re-sending the same
      // code after a failure would just fail again, so once a code has been
      // spent the remaining attempts go to the user.
      let spentOtpCode = null;

      client.on('keyboard-interactive', async (name, instructions, lang, prompts, finish) => {
        // Answer what the vault already knows - the stored password, and the
        // current TOTP code when the identity carries a secret - and only ask
        // the user about prompts nothing here can fill in.
        const answers = prompts.map((p) => {
          if (totp.looksLikeOtpPrompt(p.prompt) && totpSecret) {
            const code = totp.generate(totpSecret);
            if (code === spentOtpCode) return null;
            spentOtpCode = code;
            return code;
          }
          // Checked after the OTP test on purpose: "One-time password:" is a
          // code prompt, not a request for the stored account password.
          if (
            options.password &&
            (/password|passcode/i.test(p.prompt) || (prompts.length === 1 && !p.echo))
          ) {
            return options.password;
          }
          return null;
        });

        const unanswered = prompts
          .map((p, index) => ({ prompt: p.prompt, echo: p.echo, index }))
          .filter((p) => answers[p.index] === null);

        if (unanswered.length === 0) {
          finish(answers);
          return;
        }

        try {
          const answer = await session.ask(
            'keyboard-interactive',
            {
              name,
              instructions,
              prompts: unanswered.map((p) => ({ prompt: p.prompt, echo: p.echo })),
            },
            AUTH_PROMPT_TIMEOUT_MS
          );
          const responses = Array.isArray(answer?.responses) ? answer.responses : [];
          unanswered.forEach((p, i) => {
            answers[p.index] = responses[i] ?? '';
          });
          finish(answers.map((a) => a ?? ''));
        } catch (err) {
          settle(reject, err);
        }
      });

      const connectOptions = {
        ...options,
        sock,
        tryKeyboard: true,
        readyTimeout: 30000,
        algorithms: {
          serverHostKey: [
            'ssh-ed25519',
            'ecdsa-sha2-nistp256',
            'ecdsa-sha2-nistp384',
            'ecdsa-sha2-nistp521',
            'rsa-sha2-512',
            'rsa-sha2-256',
            'ssh-rsa',
          ],
        },
        hostVerifier: (keyBuffer, callback) => {
          this.verifyHostKey(session, keyBuffer)
            .then(callback)
            .catch((err) => {
              settle(reject, err);
              callback(false);
            });
        },
      };
      delete connectOptions.agentForward;

      if (options.agentForward && process.env.SSH_AUTH_SOCK) {
        connectOptions.agent = process.env.SSH_AUTH_SOCK;
        connectOptions.agentForward = true;
      }

      // ssh2 rejects an explicitly-undefined `sock`, so only pass a real one.
      if (!sock) delete connectOptions.sock;

      try {
        client.connect(connectOptions);
      } catch (err) {
        settle(reject, err);
      }
    });
  }

  /**
   * TOFU host-key check against the known_hosts table.
   * Unknown or changed keys stop the handshake and ask the user.
   */
  async verifyHostKey(session, keyBuffer) {
    const keyType = keyTypeOf(keyBuffer);
    const fingerprint = fingerprintOf(keyBuffer);
    const known = await repo.knownHosts.lookup(session.hostname, session.port, keyType);

    if (known && known.fingerprint === fingerprint) return true;

    const answer = await session.ask(
      'hostkey',
      {
        host: session.hostname,
        port: session.port,
        keyType,
        fingerprint,
        knownFingerprint: known ? known.fingerprint : null,
        changed: !!known,
      },
      HOSTKEY_PROMPT_TIMEOUT_MS
    );

    if (answer?.decision === 'accept') {
      await repo.knownHosts.trust(session.hostname, session.port, keyType, fingerprint);
      return true;
    }
    if (answer?.decision === 'once') return true;
    return false;
  }

  async close(sessionId) {
    const session = this.get(sessionId);
    if (!session) return false;
    await session.close();
    this.sessions.delete(sessionId);
    return true;
  }

  async closeAll() {
    await Promise.all(Array.from(this.sessions.keys()).map((id) => this.close(id)));
  }
}

module.exports = { SshManager, SshSession, fingerprintOf, keyTypeOf };
