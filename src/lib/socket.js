'use client';

import { io } from 'socket.io-client';

/**
 * terminal.ai - client transport.
 *
 * One Socket.IO connection for the whole window. The original build opened a
 * socket per terminal tab, which meant a split view of four panes held four
 * TCP connections and four SSH handshakes; here every pane, the SFTP browser
 * and the tunnel panel share this one.
 *
 * Shell output is dispatched through a direct key -> listener map rather than
 * React state, so a fast-scrolling `tail -f` never triggers a re-render.
 */

let socket = null;

const shellListeners = new Map(); // `${sessionId}:${paneId}` -> Set<fn>
const eventListeners = new Set(); // everything that is not shell data

function dispatchShell(sessionId, paneId, data) {
  const set = shellListeners.get(`${sessionId}:${paneId}`);
  if (!set) return;
  for (const fn of set) fn(data);
}

export function getSocket() {
  if (socket) return socket;

  socket = io({
    transports: ['websocket', 'polling'],
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000,
  });

  socket.on('session:event', (event) => {
    if (event.type === 'shell-data') {
      dispatchShell(event.sessionId, event.payload.paneId, event.payload.data);
      return;
    }
    for (const fn of eventListeners) fn(event);
  });

  socket.on('vault:locked', () => {
    for (const fn of eventListeners) fn({ type: 'vault-locked' });
  });

  return socket;
}

/** Emit and await the server ack, throwing on the error branch. */
export function call(event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`"${event}" timed out after 30s`)),
      30000
    );
    getSocket().emit(event, payload, (response) => {
      clearTimeout(timer);
      if (!response) return reject(new Error(`"${event}" returned no response`));
      if (response.ok) return resolve(response.data);
      const err = new Error(response.error || 'Request failed');
      err.code = response.code;
      reject(err);
    });
  });
}

/** Fire and forget - used for keystrokes and resize, where an ack would add latency. */
export function send(event, payload) {
  getSocket().emit(event, payload);
}

export function onShellData(sessionId, paneId, handler) {
  const key = `${sessionId}:${paneId}`;
  if (!shellListeners.has(key)) shellListeners.set(key, new Set());
  shellListeners.get(key).add(handler);

  return () => {
    const set = shellListeners.get(key);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) shellListeners.delete(key);
  };
}

export function onSessionEvent(handler) {
  eventListeners.add(handler);
  return () => eventListeners.delete(handler);
}

/** REST helper with the same error shape as `call`. */
export async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const err = new Error(data?.error || `${response.status} ${response.statusText}`);
    err.status = response.status;
    err.code = data?.code;
    throw err;
  }
  return data;
}
