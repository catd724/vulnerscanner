'use strict';

/**
 * terminal.ai - minimal SOCKS5 server used for dynamic (-D) port forwarding.
 *
 * Only what an SSH tunnel needs: no-auth negotiation and the CONNECT command.
 * BIND and UDP ASSOCIATE are rejected cleanly rather than left hanging, and
 * each accepted request is handed to `onConnect` which is expected to open the
 * matching direct-tcpip channel on the SSH connection.
 *
 * RFC 1928.
 */

const net = require('net');

const VERSION = 0x05;
const NO_AUTH = 0x00;
const NO_ACCEPTABLE_METHODS = 0xff;

const CMD_CONNECT = 0x01;

const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;

const REP = {
  SUCCESS: 0x00,
  GENERAL_FAILURE: 0x01,
  HOST_UNREACHABLE: 0x04,
  COMMAND_NOT_SUPPORTED: 0x07,
  ADDRESS_NOT_SUPPORTED: 0x08,
};

/** A reply carrying a zeroed BND.ADDR - the client never needs the real one. */
function reply(code) {
  return Buffer.from([VERSION, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]);
}

/**
 * Read exactly `n` bytes from a paused socket.
 * Buffers across TCP segment boundaries, which a naive single 'data' handler
 * gets wrong for domain names split across packets.
 */
function readBytes(socket, n) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);

    const onReadable = () => {
      let chunk;
      while ((chunk = socket.read()) !== null) {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length >= n) {
          socket.removeListener('readable', onReadable);
          socket.removeListener('error', onError);
          socket.removeListener('end', onEnd);
          // Push anything we over-read back for the next reader.
          if (buf.length > n) socket.unshift(buf.subarray(n));
          resolve(buf.subarray(0, n));
          return;
        }
      }
    };
    const onError = (err) => {
      socket.removeListener('readable', onReadable);
      socket.removeListener('end', onEnd);
      reject(err);
    };
    const onEnd = () => {
      socket.removeListener('readable', onReadable);
      socket.removeListener('error', onError);
      reject(new Error('SOCKS client closed during handshake'));
    };

    socket.on('readable', onReadable);
    socket.once('error', onError);
    socket.once('end', onEnd);
    onReadable();
  });
}

async function handshake(socket) {
  // Greeting: VER NMETHODS METHODS...
  const greeting = await readBytes(socket, 2);
  if (greeting[0] !== VERSION) throw new Error('Not a SOCKS5 client');
  const nMethods = greeting[1];
  const methods = await readBytes(socket, nMethods);

  if (!methods.includes(NO_AUTH)) {
    socket.end(Buffer.from([VERSION, NO_ACCEPTABLE_METHODS]));
    throw new Error('SOCKS client offered no supported auth method');
  }
  socket.write(Buffer.from([VERSION, NO_AUTH]));

  // Request: VER CMD RSV ATYP DST.ADDR DST.PORT
  const head = await readBytes(socket, 4);
  if (head[0] !== VERSION) throw new Error('Bad SOCKS5 request version');

  const cmd = head[1];
  const atyp = head[3];

  let destHost;
  if (atyp === ATYP_IPV4) {
    destHost = Array.from(await readBytes(socket, 4)).join('.');
  } else if (atyp === ATYP_DOMAIN) {
    const len = (await readBytes(socket, 1))[0];
    destHost = (await readBytes(socket, len)).toString('utf8');
  } else if (atyp === ATYP_IPV6) {
    const raw = await readBytes(socket, 16);
    const parts = [];
    for (let i = 0; i < 16; i += 2) parts.push(raw.readUInt16BE(i).toString(16));
    destHost = parts.join(':');
  } else {
    socket.end(reply(REP.ADDRESS_NOT_SUPPORTED));
    throw new Error(`Unsupported SOCKS5 address type ${atyp}`);
  }

  const destPort = (await readBytes(socket, 2)).readUInt16BE(0);

  if (cmd !== CMD_CONNECT) {
    socket.end(reply(REP.COMMAND_NOT_SUPPORTED));
    throw new Error(`Unsupported SOCKS5 command ${cmd}`);
  }

  return { destHost, destPort };
}

/**
 * @param {object} opts
 * @param {string} opts.listenHost
 * @param {number} opts.listenPort
 * @param {(destHost: string, destPort: number, srcPort: number) => Promise<import('stream').Duplex>} opts.onConnect
 * @param {(message: string) => void} [opts.onError]
 */
function createSocks5Server({ listenHost, listenPort, onConnect, onError }) {
  const server = net.createServer(async (socket) => {
    socket.on('error', () => socket.destroy());

    let target;
    try {
      target = await handshake(socket);
    } catch (err) {
      onError?.(err.message);
      socket.destroy();
      return;
    }

    try {
      const channel = await onConnect(target.destHost, target.destPort, socket.remotePort);
      socket.write(reply(REP.SUCCESS));
      socket.pipe(channel).pipe(socket);
      channel.on('error', () => socket.destroy());
      channel.on('close', () => socket.end());
    } catch (err) {
      onError?.(`SOCKS5 -> ${target.destHost}:${target.destPort}: ${err.message}`);
      if (!socket.destroyed) socket.end(reply(REP.HOST_UNREACHABLE));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

module.exports = { createSocks5Server };
