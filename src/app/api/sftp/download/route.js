import { Readable } from 'node:stream';
import { posix } from 'node:path';
import { ZipArchive } from 'archiver';

import { ssh } from '@/lib/core';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Recursively walk a remote SFTP directory and append files to an archiver instance.
 */
async function appendDirectory(sftp, archive, currentPath, prefix = '') {
  const entries = await new Promise((resolve, reject) => {
    sftp.readdir(currentPath, (err, list) => (err ? reject(err) : resolve(list || [])));
  });

  for (const entry of entries) {
    if (entry.filename === '.' || entry.filename === '..') continue;

    const fullPath = posix.join(currentPath, entry.filename);
    const relPath = prefix ? `${prefix}/${entry.filename}` : entry.filename;
    const isDir =
      typeof entry.attrs?.isDirectory === 'function'
        ? entry.attrs.isDirectory()
        : (entry.attrs?.mode & 0o170000) === 0o040000;

    if (isDir) {
      archive.append(null, { name: `${relPath}/` });
      await appendDirectory(sftp, archive, fullPath, relPath);
    } else {
      const fileStream = sftp.createReadStream(fullPath);
      archive.append(fileStream, {
        name: relPath,
        mode: entry.attrs?.mode || 0o644,
        date: entry.attrs?.mtime ? new Date(entry.attrs.mtime * 1000) : new Date(),
      });
    }
  }
}

/**
 * Stream a remote file or entire directory (as .zip) to the browser.
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

  const baseName = posix.basename(remotePath) || 'download';

  // If path is a directory, stream an on-the-fly zip archive
  if (typeof stats.isDirectory === 'function' && stats.isDirectory()) {
    const archive = new ZipArchive({
      zlib: { level: 6 },
    });

    const webStream = Readable.toWeb(archive);
    const zipFilename = `${baseName}.zip`;

    // Process directory walk asynchronously in background while streaming
    (async () => {
      try {
        await appendDirectory(sftp, archive, remotePath, '');
        await archive.finalize();
      } catch (err) {
        console.error('[sftp:download] Error archiving remote directory:', err);
        archive.destroy(err);
      }
    })();

    return new Response(webStream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipFilename.replace(/"/g, '\\"')}"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  // Single file streaming
  const nodeStream = sftp.createReadStream(remotePath);
  const filename = baseName;

  return new Response(Readable.toWeb(nodeStream), {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(stats.size ?? ''),
      'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '\\"')}"`,
      'Cache-Control': 'no-store',
    },
  });
});
