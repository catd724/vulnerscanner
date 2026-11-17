import 'server-only';

/**
 * terminal.ai - bridge from Next route handlers to the shared runtime.
 *
 * server.js requires server/core before Next starts and pins it to globalThis,
 * so route handlers reach the same vault instance and the same SshManager
 * rather than a second, permanently locked copy inside the Next bundle.
 *
 * The bindings below are lazy on purpose. Next imports every route module at
 * build time to read its segment config, and at that point no server has run,
 * so resolving eagerly would fail the build. Nothing here touches the runtime
 * until a request actually calls into it.
 */

const KEY = '__TERMINALAI_CORE__';

function core() {
  const instance = globalThis[KEY];
  if (!instance) {
    throw new Error(
      'AI Terminal runtime is not loaded. Start the app with `npm run dev` or ' +
        '`npm start` (which run server.js); `next dev` on its own does not boot ' +
        'the vault or the SSH transport.'
    );
  }
  return instance;
}

/**
 * A live view onto one runtime singleton.
 * Methods are bound to the real object so `this` inside the vault and the SSH
 * manager still refers to the instance, not to the proxy.
 */
function bind(name) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        const owner = core()[name];
        const value = owner[prop];
        return typeof value === 'function' ? value.bind(owner) : value;
      },
      set(_target, prop, value) {
        core()[name][prop] = value;
        return true;
      },
      has(_target, prop) {
        return prop in core()[name];
      },
    }
  );
}

export const db = bind('db');
export const vault = bind('vault');
export const repo = bind('repo');
export const legacy = bind('legacy');
export const ssh = bind('ssh');

export function isRuntimeReady() {
  return !!globalThis[KEY];
}

const runtime = { db, vault, repo, legacy, ssh };

export default runtime;
