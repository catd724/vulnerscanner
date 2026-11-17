import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { posix } from 'node:path';

import { ssh } from '@/lib/core';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Ensure remote directory hierarchy exists (mkdir -p over SFTP).
 */
async function ensureDir(sftp, targetDir) {
  const segments = targetDir.split('/').filter(Boolean);
  let current = targetDir.startsWith('/') ? '/' : '';

  for (const segment of segments) {
    current = posix.join(current, segment);
    const exists = await new Promise((resolve) => {
      sftp.stat(current, (err, stats) => {
        resolve(!err && typeof stats.isDirectory === 'function' && stats.isDirectory());
      });
    });

    if (!exists) {
      await new Promise((resolve) => {
        sftp.mkdir(current, () => resolve());
      });
    }
  }
}

/**
 * Stream an uploaded file to the remote host.
 * Supports both direct files and nested relative paths from folder uploads.
 */
export const POST = route(async (request) => {
  const params = request.nextUrl.searchParams;
  const sessionId = params.get('sessionId');
  const dir = params.get('dir');
  const name = params.get('name');
  const relPath = params.get('relPath'); // optional relative path (e.g. "subfolder/test.txt")
  const mode = params.get('mode');

  if (!sessionId || !dir || (!name && !relPath)) {
    throw new Error('sessionId, dir, and name or relPath are required');
  }

  const targetRelative = relPath || name;

  // Protect against directory traversal
  const normalized = posix.normalize(targetRelative.replace(/\\/g, '/'));
  if (normalized.startsWith('..') || normalized.includes('/../') || posix.isAbsolute(normalized)) {
    throw new Error('Invalid file path');
  }

  if (!request.body) throw new Error('Request has no body');

  const session = ssh.require(sessionId);
  const sftp = await session.sftp();
  const remotePath = posix.join(dir, normalized);

  // Ensure parent directories exist
  const parentDir = posix.dirname(remotePath);
  if (parentDir && parentDir !== dir) {
    await ensureDir(sftp, parentDir);
  }

  const writeStream = sftp.createWriteStream(remotePath, {
    mode: mode ? parseInt(mode, 8) : 0o644,
  });

  await pipeline(Readable.fromWeb(request.body), writeStream);

  const stats = await new Promise((resolve, reject) => {
    sftp.stat(remotePath, (err, s) => (err ? reject(err) : resolve(s)));
  });

  return { path: remotePath, size: stats.size ?? 0 };
});
