'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { call } from '@/lib/socket';
import { useStore } from '@/lib/store';
import {
  RefreshIcon,
  FolderPlusIcon,
  UploadIcon,
  DownloadIcon,
  CloseIcon,
  EditIcon,
  GearIcon,
  TrashIcon,
  FolderIcon,
  FileIcon,
  LinkIcon,
} from './Icons';
import FileEditorModal from './FileEditorModal';

/**
 * terminal.ai - SFTP file manager.
 *
 * Runs beside the terminal on the *same* SSH connection - opening it costs one
 * SFTP subsystem channel, not a second login. Directory operations go over the
 * socket; transfers use the streaming HTTP routes so large files never sit in
 * memory or in a base64 frame.
 */

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  if (!bytes) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

function parentOf(path) {
  if (!path || path === '/') return '/';
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx);
}

function joinPath(dir, name) {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'html', 'htm', 'css', 'scss', 'sass', 'xml', 'svg',
  'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1',
  'py', 'rb', 'php', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'config', 'env',
  'sql', 'log', 'dockerfile', 'makefile', 'gitignore', 'editorconfig'
]);

function isEditableFile(name) {
  if (!name) return false;
  if (!name.includes('.')) return true; // Dockerfile, Makefile, etc.
  const ext = name.split('.').pop().toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * Recursively scan dropped DataTransfer items to collect files with relative directory paths
 */
async function scanDataTransferEntries(items) {
  const result = [];
  async function traverse(entry, curRelPath = '') {
    if (entry.isFile) {
      await new Promise((resolve) => {
        entry.file((file) => {
          result.push({ file, relPath: curRelPath ? `${curRelPath}/${file.name}` : file.name });
          resolve();
        });
      });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const entries = await new Promise((resolve) => {
        reader.readEntries((ents) => resolve(ents || []));
      });
      for (const child of entries) {
        await traverse(child, curRelPath ? `${curRelPath}/${entry.name}` : entry.name);
      }
    }
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item.webkitGetAsEntry === 'function') {
      const entry = item.webkitGetAsEntry();
      if (entry) await traverse(entry, '');
    } else if (item.getAsFile) {
      const file = item.getAsFile();
      if (file) result.push({ file, relPath: file.name });
    }
  }
  return result;
}

/**
 * Resolves which session the panel is browsing and remounts the browser when
 * that changes. Keying on sessionId means each session starts from clean state
 * instead of an effect having to reset half a dozen fields.
 */
export default function SftpPanel({ tab }) {
  const sessionId = tab.panes[tab.activePaneId]?.sessionId;
  const toggleSftp = useStore((s) => s.toggleSftp);

  if (!sessionId) {
    return (
      <aside className="sftp">
        <header className="sftp-header">
          <span className="sftp-title">Files</span>
          <button className="icon-btn" title="Close" onClick={() => toggleSftp(tab.id, false)}>
            <CloseIcon size={14} />
          </button>
        </header>
        <div className="sftp-empty">Connect a pane to browse files.</div>
      </aside>
    );
  }

  return <SftpBrowser key={sessionId} sessionId={sessionId} tab={tab} />;
}

function SftpBrowser({ sessionId, tab }) {
  const toast = useStore((s) => s.toast);
  const setSftpPath = useStore((s) => s.setSftpPath);
  const toggleSftp = useStore((s) => s.toggleSftp);

  const [path, setPath] = useState(tab.sftpPath || null);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [transfers, setTransfers] = useState([]);
  const [dropActive, setDropActive] = useState(false);
  const [editingPath, setEditingPath] = useState(null);

  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const initialPathRef = useRef(tab.sftpPath || null);
  const tabIdRef = useRef(tab.id);

  const load = useCallback(
    async (target) => {
      if (!sessionId) return;
      setLoading(true);
      setError(null);
      try {
        const result = await call('sftp:list', { sessionId, path: target });
        setEntries(result.entries);
        setPath(result.path);
        setSftpPath(tab.id, result.path);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    [sessionId, setSftpPath, tab.id]
  );

  useEffect(() => {
    if (!sessionId) return undefined;
    let cancelled = false;

    call('sftp:list', { sessionId, path: initialPathRef.current })
      .then((result) => {
        if (cancelled) return;
        setEntries(result.entries);
        setPath(result.path);
        setError(null);
        setSftpPath(tabIdRef.current, result.path);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, setSftpPath]);

  const trackTransfer = (entry) => {
    setTransfers((t) => [...t, entry]);
    return (patch) =>
      setTransfers((t) => t.map((x) => (x.id === entry.id ? { ...x, ...patch } : x)));
  };

  const upload = async (items) => {
    for (const item of items) {
      const file = item.file || item;
      const relPath = item.relPath || file.webkitRelativePath || file.name;
      const id = `${Date.now()}-${relPath}`;
      const update = trackTransfer({
        id,
        name: relPath,
        direction: 'up',
        status: 'running',
      });
      try {
        const params = new URLSearchParams({ sessionId, dir: path, relPath });
        const response = await fetch(`/api/sftp/upload?${params}`, {
          method: 'POST',
          body: file,
          duplex: 'half',
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Upload failed');
        update({ status: 'done' });
      } catch (err) {
        update({ status: 'error', error: err.message });
        toast(`Upload of ${relPath} failed: ${err.message}`, 'error');
      }
    }
    setTimeout(() => setTransfers((t) => t.filter((x) => x.status === 'running')), 4000);
    load(path);
  };

  const download = (entry) => {
    const params = new URLSearchParams({ sessionId, path: joinPath(path, entry.name) });
    window.location.assign(`/api/sftp/download?${params}`);
  };

  const remove = async (entry) => {
    if (!confirm(`Delete ${entry.isDirectory ? 'directory' : 'file'} "${entry.name}"?`)) return;
    try {
      await call('sftp:remove', {
        sessionId,
        path: joinPath(path, entry.name),
        isDirectory: entry.isDirectory,
      });
      load(path);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const rename = async (entry) => {
    const next = prompt('Rename to', entry.name);
    if (!next || next === entry.name) return;
    try {
      await call('sftp:rename', {
        sessionId,
        from: joinPath(path, entry.name),
        to: joinPath(path, next),
      });
      load(path);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const chmod = async (entry) => {
    const mode = prompt(`Permissions for "${entry.name}" (octal)`, entry.permissions);
    if (!mode) return;
    try {
      await call('sftp:chmod', { sessionId, path: joinPath(path, entry.name), mode });
      load(path);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const mkdir = async () => {
    const name = prompt('New folder name');
    if (!name) return;
    try {
      await call('sftp:mkdir', { sessionId, path: joinPath(path, name) });
      load(path);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const handleDoubleClick = (entry) => {
    if (entry.isDirectory) {
      load(joinPath(path, entry.name));
    } else if (isEditableFile(entry.name)) {
      setEditingPath(joinPath(path, entry.name));
    } else {
      download(entry);
    }
  };

  const crumbs = (path || '/').split('/').filter(Boolean);

  return (
    <>
      <aside
        className={`sftp ${dropActive ? 'sftp-drop' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDropActive(true);
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setDropActive(false);
          if (e.dataTransfer.items?.length) {
            const files = await scanDataTransferEntries(e.dataTransfer.items);
            if (files.length) upload(files);
          } else if (e.dataTransfer.files?.length) {
            upload(Array.from(e.dataTransfer.files));
          }
        }}
      >
        <header className="sftp-header">
          <span className="sftp-title">Files</span>
          <span className="sftp-header-actions">
            <button className="icon-btn" title="Refresh" onClick={() => load(path)}>
              <RefreshIcon size={14} />
            </button>
            <button className="icon-btn" title="New folder" onClick={mkdir}>
              <FolderPlusIcon size={14} />
            </button>
            <button
              className="icon-btn"
              title="Upload folder"
              onClick={() => folderInputRef.current?.click()}
            >
              <FolderIcon size={14} />
            </button>
            <button
              className="icon-btn"
              title="Upload files"
              onClick={() => fileInputRef.current?.click()}
            >
              <UploadIcon size={14} />
            </button>
            <button className="icon-btn" title="Close" onClick={() => toggleSftp(tab.id, false)}>
              <CloseIcon size={14} />
            </button>
          </span>
        </header>

        <nav className="sftp-breadcrumb">
          <button className="crumb" onClick={() => load('/')}>
            /
          </button>
          {crumbs.map((crumb, i) => (
            <button
              key={`${crumb}-${i}`}
              className="crumb"
              onClick={() => load(`/${crumbs.slice(0, i + 1).join('/')}`)}
            >
              {crumb}
            </button>
          ))}
        </nav>

        {error && <div className="sftp-error">{error}</div>}

        <div className="sftp-list">
          {loading && <div className="sftp-loading">Loading...</div>}

          {!loading && path !== '/' && (
            <button
              className="sftp-row sftp-row-up"
              onDoubleClick={() => load(parentOf(path))}
              onClick={() => load(parentOf(path))}
            >
              <span className="sftp-name">.. </span>
            </button>
          )}

          {!loading &&
            entries.map((entry) => (
              <div
                key={entry.name}
                className={`sftp-row ${selected === entry.name ? 'is-selected' : ''}`}
                onClick={() => setSelected(entry.name)}
                onDoubleClick={() => handleDoubleClick(entry)}
              >
                <span className="sftp-icon">
                  {entry.isDirectory ? (
                    <FolderIcon size={14} />
                  ) : entry.isSymlink ? (
                    <LinkIcon size={14} />
                  ) : (
                    <FileIcon size={14} />
                  )}
                </span>
                <span className="sftp-name" title={entry.name}>
                  {entry.name}
                </span>
                <span className="sftp-size">{entry.isDirectory ? '-' : formatSize(entry.size)}</span>
                <span className="sftp-perms">{entry.permissions}</span>
                <span className="sftp-date">{formatDate(entry.mtime)}</span>
                <span className="sftp-row-actions">
                  {!entry.isDirectory && isEditableFile(entry.name) && (
                    <button
                      className="icon-btn"
                      title="Edit file"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingPath(joinPath(path, entry.name));
                      }}
                    >
                      <EditIcon size={14} />
                    </button>
                  )}
                  <button
                    className="icon-btn"
                    title={entry.isDirectory ? 'Download folder (.zip)' : 'Download file'}
                    onClick={(e) => {
                      e.stopPropagation();
                      download(entry);
                    }}
                  >
                    <DownloadIcon size={14} />
                  </button>
                  <button
                    className="icon-btn"
                    title="Rename"
                    onClick={(e) => {
                      e.stopPropagation();
                      rename(entry);
                    }}
                  >
                    <EditIcon size={14} />
                  </button>
                  <button
                    className="icon-btn"
                    title="Permissions"
                    onClick={(e) => {
                      e.stopPropagation();
                      chmod(entry);
                    }}
                  >
                    <GearIcon size={14} />
                  </button>
                  <button
                    className="icon-btn icon-btn-danger"
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(entry);
                    }}
                  >
                    <TrashIcon size={14} />
                  </button>
                </span>
              </div>
            ))}

          {!loading && entries.length === 0 && !error && (
            <div className="sftp-loading">Empty directory</div>
          )}
        </div>

        {transfers.length > 0 && (
          <div className="sftp-transfers">
            {transfers.map((t) => (
              <div key={t.id} className={`transfer transfer-${t.status}`}>
                <span className="transfer-dir">
                  {t.direction === 'up' ? <UploadIcon size={12} /> : <DownloadIcon size={12} />}
                </span>
                <span className="transfer-name">{t.name}</span>
                <span className="transfer-status">{t.error || t.status}</span>
              </div>
            ))}
          </div>
        )}

        <footer className="sftp-footer">Drop files or folders here to upload to {path}</footer>

        {/* Regular file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) upload(Array.from(e.target.files));
            e.target.value = '';
          }}
        />

        {/* Folder input */}
        <input
          ref={folderInputRef}
          type="file"
          webkitdirectory=""
          directory=""
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) {
              const files = Array.from(e.target.files).map((f) => ({
                file: f,
                relPath: f.webkitRelativePath || f.name,
              }));
              upload(files);
            }
            e.target.value = '';
          }}
        />
      </aside>

      {editingPath && (
        <FileEditorModal
          sessionId={sessionId}
          filePath={editingPath}
          onClose={() => setEditingPath(null)}
          onSaved={() => load(path)}
        />
      )}
    </>
  );
}
