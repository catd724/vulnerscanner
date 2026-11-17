import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // sqlite3 and ssh2 load native bindings at runtime. Bundling them into the
  // server chunks breaks those requires, so hand them to node directly.
  serverExternalPackages: ['sqlite3', 'ssh2', 'cpu-features'],

  // Pin the workspace root. Without it Turbopack walks up and can pick a
  // lockfile in a parent directory as the root.
  turbopack: {
    root: projectRoot,
  },

  // The app is a local tool; source maps in the browser are not a leak here
  // and make the terminal engine debuggable.
  productionBrowserSourceMaps: true,
};

export default nextConfig;
