import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { posix } from 'node:path';

import { ssh } from '@/lib/core';
import { route, body } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_EDIT_SIZE = 5 * 1024 * 1024; // 5 MB

/**
 * Check if a buffer appears to be binary.
 */
function isBinary(buffer) {
  const checkLen = Math.min(buffer.length, 8000);
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Read remote text file for in-app editing.
 */
export const GET = route(async (request) => {
  const params = request.nextUrl.searchParams;
  const sessionId = params.get('sessionId');
  const remotePath = params.get('path');

  if (!sessionId || !remotePath) {
    throw new Error('sessionId and path are required');
  }

  const session = ssh.require(sessionId);
  const sftp = await session.sftp();

  const stats = await new Promise((resolve, reject) => {
    sftp.stat(remotePath, (err, s) => (err ? reject(err) : resolve(s)));
  });

  if (typeof stats.isDirectory === 'function' && stats.isDirectory()) {
    throw new Error('Cannot edit a directory');
  }

  if (stats.size > MAX_EDIT_SIZE) {
    throw new Error(
      `File is too large to edit in the browser (${(stats.size / 1024 / 1024).toFixed(1)} MB > 5 MB limit). Use Download instead.`
    );
  }

  const chunks = [];
  const readStream = sftp.createReadStream(remotePath);

  for await (const chunk of readStream) {
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);
  if (isBinary(buffer)) {
    throw new Error('Binary file detected. This file cannot be edited in the text editor.');
  }

  return {
    path: remotePath,
    name: posix.basename(remotePath),
    size: stats.size,
    mtime: stats.mtime ? stats.mtime * 1000 : null,
    content: buffer.toString('utf8'),
  };
});

/**
 * Save updated text file content back to remote host.
 */
export const PUT = route(async (request) => {
  const { sessionId, path: remotePath, content } = await body(request);

  if (!sessionId || !remotePath) {
    throw new Error('sessionId and path are required');
  }
  if (typeof content !== 'string') {
    throw new Error('content must be a string');
  }

  const session = ssh.require(sessionId);
  const sftp = await session.sftp();

  const buffer = Buffer.from(content, 'utf8');
  if (buffer.length > MAX_EDIT_SIZE) {
    throw new Error('Content exceeds maximum file size limit (5 MB)');
  }

  const inStream = Readable.from(buffer);
  const writeStream = sftp.createWriteStream(remotePath);

  await pipeline(inStream, writeStream);

  const stats = await new Promise((resolve, reject) => {
    sftp.stat(remotePath, (err, s) => (err ? reject(err) : resolve(s)));
  });

  return {
    ok: true,
    path: remotePath,
    size: stats.size,
    mtime: stats.mtime ? stats.mtime * 1000 : Date.now(),
  };
});
