'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { CloseIcon, RefreshIcon } from './Icons';

/**
 * Format bytes to readable size
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (!bytes) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function FileEditorModal({ sessionId, filePath, onClose, onSaved }) {
  const [content, setContent] = useState('');
  const [initialContent, setInitialContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [statusMessage, setStatusMessage] = useState(null);
  const [fileStats, setFileStats] = useState({ size: 0, name: '' });
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });

  const textareaRef = useRef(null);
  const lineNumbersRef = useRef(null);

  const isDirty = content !== initialContent;

  const loadFile = useCallback(async () => {
    setLoading(true);
    setError(null);
    setStatusMessage(null);
    try {
      const res = await fetch(
        `/api/sftp/file?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(
          filePath
        )}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load file');

      setContent(data.content);
      setInitialContent(data.content);
      setFileStats({ size: data.size, name: data.name });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [sessionId, filePath]);

  useEffect(() => {
    loadFile();
  }, [loadFile]);

  const saveFile = useCallback(async () => {
    if (saving || loading) return;
    setSaving(true);
    setError(null);
    setStatusMessage('Saving...');
    try {
      const res = await fetch('/api/sftp/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, path: filePath, content }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save file');

      setInitialContent(content);
      const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      setStatusMessage(`Saved at ${now}`);
      if (onSaved) onSaved(data);
    } catch (err) {
      setError(`Save failed: ${err.message}`);
      setStatusMessage(null);
    } finally {
      setSaving(false);
    }
  }, [saving, loading, sessionId, filePath, content, onSaved]);

  const handleClose = useCallback(() => {
    if (isDirty) {
      if (!confirm('You have unsaved changes. Are you sure you want to discard them?')) {
        return;
      }
    }
    onClose();
  }, [isDirty, onClose]);

  // Sync scrolling between line numbers and textarea
  const handleScroll = () => {
    if (textareaRef.current && lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  // Track cursor position
  const updateCursorPos = () => {
    if (!textareaRef.current) return;
    const text = textareaRef.current.value;
    const selStart = textareaRef.current.selectionStart;
    const lines = text.slice(0, selStart).split('\n');
    setCursorPos({
      line: lines.length,
      col: lines[lines.length - 1].length + 1,
    });
  };

  // Keyboard shortcuts (Ctrl+S, Tab, Esc)
  const handleKeyDown = (e) => {
    // Ctrl+S / Cmd+S
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveFile();
      return;
    }

    // Esc
    if (e.key === 'Escape') {
      e.preventDefault();
      handleClose();
      return;
    }

    // Tab key indentation
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = textareaRef.current;
      if (!ta) return;

      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const val = ta.value;

      // Single line tab
      if (start === end) {
        const next = val.substring(0, start) + '  ' + val.substring(end);
        setContent(next);
        setTimeout(() => {
          ta.selectionStart = ta.selectionEnd = start + 2;
          updateCursorPos();
        }, 0);
      }
    }
  };

  const lineCount = (content || '').split('\n').length;
  const lineNumbers = Array.from({ length: lineCount }, (_, i) => i + 1);

  return (
    <div className="modal-backdrop" onMouseDown={handleClose}>
      <div
        className="modal modal-file-editor"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="modal-header editor-modal-header">
          <div className="editor-title-group">
            <span className="editor-file-name">{fileStats.name || filePath.split('/').pop()}</span>
            <span className="editor-file-path" title={filePath}>
              {filePath}
            </span>
            {isDirty && (
              <span className="editor-dirty-badge" title="Unsaved changes">
                ● Unsaved
              </span>
            )}
          </div>

          <div className="editor-header-actions">
            <button
              className="icon-btn"
              title="Reload from server"
              onClick={() => {
                if (!isDirty || confirm('Discard unsaved changes and reload?')) loadFile();
              }}
              disabled={loading || saving}
            >
              <RefreshIcon size={14} />
            </button>
            <button
              className={`btn btn-sm ${isDirty ? 'btn-primary' : 'btn-ghost'}`}
              onClick={saveFile}
              disabled={saving || loading || !isDirty}
              title="Save changes (Ctrl+S)"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button className="icon-btn" onClick={handleClose} title="Close (Esc)">
              <CloseIcon size={15} />
            </button>
          </div>
        </header>

        <div className="editor-modal-body">
          {loading && (
            <div className="editor-loading-overlay">
              <span className="pulse-dot" />
              <span>Loading remote file...</span>
            </div>
          )}

          {error && !loading && (
            <div className="editor-error-banner">
              <span>{error}</span>
              <button className="btn btn-ghost btn-sm" onClick={loadFile}>
                Retry
              </button>
            </div>
          )}

          {!loading && !error && (
            <div className="editor-workspace">
              <div ref={lineNumbersRef} className="editor-line-numbers" aria-hidden="true">
                {lineNumbers.map((num) => (
                  <div key={num} className="editor-line-num">
                    {num}
                  </div>
                ))}
              </div>
              <textarea
                ref={textareaRef}
                className="editor-textarea"
                value={content}
                onChange={(e) => {
                  setContent(e.target.value);
                  updateCursorPos();
                }}
                onScroll={handleScroll}
                onKeyDown={handleKeyDown}
                onKeyUp={updateCursorPos}
                onClick={updateCursorPos}
                spellCheck={false}
                autoFocus
              />
            </div>
          )}
        </div>

        <footer className="editor-modal-footer">
          <div className="editor-footer-left">
            <span>
              Ln {cursorPos.line}, Col {cursorPos.col}
            </span>
            <span className="footer-sep">·</span>
            <span>{lineCount} lines</span>
            <span className="footer-sep">·</span>
            <span>{formatBytes(fileStats.size || Buffer.byteLength(content, 'utf8'))}</span>
            <span className="footer-sep">·</span>
            <span>UTF-8</span>
          </div>

          <div className="editor-footer-right">
            {statusMessage && <span className="editor-status-msg">{statusMessage}</span>}
            <span className="editor-shortcut-hint">
              <kbd>Ctrl</kbd>+<kbd>S</kbd> save · <kbd>Esc</kbd> close
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
}
