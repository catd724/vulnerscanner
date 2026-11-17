'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal as XtermTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { SerializeAddon } from '@xterm/addon-serialize';

import { onShellData, send } from '@/lib/socket';
import { useStore } from '@/lib/store';
import { themeFor, fontFor, DEFAULT_THEME, DEFAULT_FONT } from '@/lib/themes';
import {
  SparkIcon,
  SearchIcon,
  SplitRightIcon,
  SplitDownIcon,
  CloseIcon,
  ArrowUpIcon,
  ArrowDownIcon,
} from './Icons';
import { Address, StatusDot } from './Address';

/**
 * terminal.ai - a single terminal pane.
 *
 * Owns exactly one xterm instance bound to one remote shell channel. Output
 * arrives through a direct socket subscription rather than React state, so a
 * flood of output costs zero re-renders.
 *
 * The AI assistant is an overlay rather than the old inline `-ai ` interceptor.
 * That interceptor tracked a guessed copy of the remote line and erased it with
 * synthetic backspaces, which corrupted the line whenever tab-completion, a
 * multi-line prompt, or a full-screen program was involved. The overlay reads
 * scrollback for context and *inserts* the suggestion at the prompt without
 * pressing Enter, so nothing runs until you approve it.
 */

export default function TerminalPane({ tabId, pane, host, isActive, onFocus }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const searchRef = useRef(null);
  const serializeRef = useRef(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [aiOpen, setAiOpen] = useState(false);
  const [aiMode, setAiMode] = useState('command'); // 'command' | 'diagnose'
  const [aiQuery, setAiQuery] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState(null);
  const [diagResult, setDiagResult] = useState(null);
  const [shareContext, setShareContext] = useState(true);

  const toast = useStore((s) => s.toast);
  const closePane = useStore((s) => s.closePane);
  const aiEnabled = useStore((s) => s.settings?.aiEnabled);

  const themeName = host?.theme || DEFAULT_THEME;
  const fontSize = host?.fontSize || 14;
  const { sessionId, paneId } = pane;

  /* --- xterm lifecycle --------------------------------------------------- */

  useEffect(() => {
    if (!containerRef.current || !sessionId) return undefined;

    const term = new XtermTerminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize,
      fontFamily: fontFor(host?.font || DEFAULT_FONT),
      lineHeight: 1.2,
      letterSpacing: 0,
      scrollback: 10000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: themeFor(themeName),
    });

    const fit = new FitAddon();
    const search = new SearchAddon();
    const serialize = new SerializeAddon();

    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(serialize);
    term.loadAddon(new WebLinksAddon());

    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = '11';

    term.open(containerRef.current);

    // WebGL is a large win on fast-scrolling output but is unavailable in some
    // GPU/driver combinations; fall back silently rather than failing to render.
    (async () => {
      try {
        const { WebglAddon } = await import('@xterm/addon-webgl');
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        /* canvas/DOM renderer is fine */
      }
    })();

    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;
    serializeRef.current = serialize;

    const pushResize = () => {
      if (!fitRef.current || !termRef.current) return;
      try {
        fitRef.current.fit();
      } catch {
        return;
      }
      send('shell:resize', {
        sessionId,
        paneId,
        cols: termRef.current.cols,
        rows: termRef.current.rows,
      });
    };

    const dataDisposable = term.onData((data) => {
      send('shell:input', { sessionId, paneId, data });
    });

    // Paste of a large blob goes through as one write rather than per keystroke.
    const binaryDisposable = term.onBinary((data) => {
      send('shell:input', { sessionId, paneId, data });
    });

    const unsubscribe = onShellData(sessionId, paneId, (chunk) => term.write(chunk));

    // ResizeObserver catches pane splits and drags, which a window listener misses.
    const observer = new ResizeObserver(() => pushResize());
    observer.observe(containerRef.current);

    const initialFit = setTimeout(pushResize, 60);

    return () => {
      clearTimeout(initialFit);
      observer.disconnect();
      unsubscribe();
      dataDisposable.dispose();
      binaryDisposable.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      serializeRef.current = null;
    };
    // Recreating the terminal on a theme change would wipe scrollback, so theme
    // and font size are applied in the effect below instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, paneId]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = themeFor(themeName);
    term.options.fontSize = fontSize;
    term.options.fontFamily = fontFor(host?.font || DEFAULT_FONT);
    try {
      fitRef.current?.fit();
    } catch {
      /* container not laid out yet */
    }
    // A new font size changes how many columns fit, and the remote side has no
    // way to notice. Without this the shell keeps wrapping to the old width.
    if (sessionId) {
      send('shell:resize', { sessionId, paneId, cols: term.cols, rows: term.rows });
    }
  }, [themeName, fontSize, host?.font, sessionId, paneId]);

  useEffect(() => {
    if (isActive) termRef.current?.focus();
  }, [isActive]);

  /* --- search ------------------------------------------------------------ */

  const runSearch = useCallback(
    (direction) => {
      if (!searchRef.current || !searchTerm) return;
      const opts = { decorations: { activeMatchColorOverrideColor: '#00f2fe' } };
      if (direction === 'prev') searchRef.current.findPrevious(searchTerm, opts);
      else searchRef.current.findNext(searchTerm, opts);
    },
    [searchTerm]
  );

  useEffect(() => {
    if (!searchOpen && searchRef.current) searchRef.current.clearDecorations?.();
  }, [searchOpen]);

  /* --- ai ---------------------------------------------------------------- */

  const askAi = useCallback(
    async (overrideMode) => {
      const mode = overrideMode || aiMode;
      if (mode === 'command' && !aiQuery.trim()) return;
      if (aiBusy) return;

      setAiBusy(true);
      setAiError(null);
      setDiagResult(null);

      let context = '';
      if (shareContext && termRef.current) {
        try {
          const buffer = termRef.current.buffer.active;
          const lines = [];
          for (let i = Math.max(0, buffer.length - 60); i < buffer.length; i++) {
            const line = buffer.getLine(i);
            if (line) lines.push(line.translateToString(true));
          }
          context = lines.join('\n').trim();
        } catch {
          context = '';
        }
      }

      try {
        const response = await fetch('/api/ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: aiQuery, context, mode }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Request failed');

        if (mode === 'diagnose') {
          setDiagResult(data);
        } else {
          // Insert at the prompt without a trailing newline: the user presses Enter.
          send('shell:input', { sessionId, paneId, data: data.command });
          setAiOpen(false);
          setAiQuery('');
          termRef.current?.focus();
        }
      } catch (err) {
        setAiError(err.message);
      } finally {
        setAiBusy(false);
      }
    },
    [aiQuery, aiBusy, aiMode, shareContext, sessionId, paneId]
  );

  /* --- pane-level shortcuts ---------------------------------------------- */

  const onKeyDown = (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod || !event.shiftKey) return;

    const key = event.key.toLowerCase();
    if (key === 'f') {
      event.preventDefault();
      setSearchOpen((open) => !open);
    } else if (key === 'i' && aiEnabled) {
      event.preventDefault();
      setAiMode('command');
      setAiOpen((open) => !open);
    } else if (key === 'd' && aiEnabled) {
      event.preventDefault();
      setAiMode('diagnose');
      setAiOpen(true);
    } else if (key === 'e') {
      event.preventDefault();
      useStore.getState().splitPane(tabId, paneId, 'row');
    } else if (key === 'o') {
      event.preventDefault();
      useStore.getState().splitPane(tabId, paneId, 'col');
    } else if (key === 'w') {
      event.preventDefault();
      closePane(tabId, paneId);
    }
  };

  /* --- render ------------------------------------------------------------ */

  if (pane.status === 'connecting') {
    return (
      <div className="pane pane-state" onMouseDown={onFocus}>
        <span className="pulse-dot" />
        <p className="pane-state-title">Connecting</p>
        {host ? (
          <Address user={host.username || null} host={host.hostname} port={host.port} />
        ) : (
          <p className="pane-state-detail">{pane.label}</p>
        )}
      </div>
    );
  }

  if (pane.status === 'error') {
    return (
      <div className="pane pane-state pane-state-error" onMouseDown={onFocus}>
        <p className="pane-state-title">Connection failed</p>
        {host && (
          <Address user={host.username || null} host={host.hostname} port={host.port} />
        )}
        <p className="pane-state-detail">{pane.error}</p>
        <div className="pane-state-actions">
          <button className="btn btn-ghost" onClick={() => closePane(tabId, paneId)}>
            Close pane
          </button>
          {host && (
            <button
              className="btn btn-secondary"
              onClick={() => useStore.getState().openEditor({ kind: 'host', data: host })}
            >
              Edit Host
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={() => useStore.getState().openHost(pane.hostId, { intoTabId: tabId, intoPaneId: paneId })}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`pane ${isActive ? 'pane-active' : ''}`}
      onMouseDown={onFocus}
      onKeyDown={onKeyDown}
      style={{ background: themeFor(themeName).background }}
    >
      <div className="pane-toolbar">
        <span className="pane-title">
          <StatusDot status={pane.status === 'connected' ? 'live' : pane.status} />
          <span className="pane-name">{pane.label}</span>
          {host && (
            <Address
              className="pane-addr"
              user={host.username || null}
              host={host.hostname}
              port={host.port}
            />
          )}
        </span>
        <span className="pane-toolbar-actions">
          {aiEnabled && (
            <button
              className="icon-btn"
              title="Ask the AI assistant (Ctrl+Shift+I)"
              onClick={() => {
                setAiMode('command');
                setAiOpen((o) => !o);
              }}
            >
              <SparkIcon size={14} />
            </button>
          )}
          <button
            className="icon-btn"
            title="Search scrollback (Ctrl+Shift+F)"
            onClick={() => setSearchOpen((o) => !o)}
          >
            <SearchIcon size={14} />
          </button>
          <button
            className="icon-btn"
            title="Split right (Ctrl+Shift+E)"
            onClick={() => useStore.getState().splitPane(tabId, paneId, 'row')}
          >
            <SplitRightIcon size={14} />
          </button>
          <button
            className="icon-btn"
            title="Split down (Ctrl+Shift+O)"
            onClick={() => useStore.getState().splitPane(tabId, paneId, 'col')}
          >
            <SplitDownIcon size={14} />
          </button>
          <button
            className="icon-btn icon-btn-danger"
            title="Close pane (Ctrl+Shift+W)"
            onClick={() => closePane(tabId, paneId)}
          >
            <CloseIcon size={14} />
          </button>
        </span>
      </div>

      {pane.status === 'closed' && (
        <div className="pane-disconnected">
          <span>Session closed. Scrollback is kept until you close the pane.</span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() =>
              useStore.getState().openHost(pane.hostId, { intoTabId: tabId, intoPaneId: paneId })
            }
          >
            Reconnect
          </button>
        </div>
      )}

      {searchOpen && (
        <div className="pane-overlay pane-search">
          <input
            autoFocus
            className="input input-sm"
            placeholder="Find in scrollback"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch(e.shiftKey ? 'prev' : 'next');
              if (e.key === 'Escape') setSearchOpen(false);
            }}
          />
          <button className="btn btn-ghost btn-sm" title="Previous match" onClick={() => runSearch('prev')}>
            <ArrowUpIcon size={14} />
          </button>
          <button className="btn btn-ghost btn-sm" title="Next match" onClick={() => runSearch('next')}>
            <ArrowDownIcon size={14} />
          </button>
          <button className="btn btn-ghost btn-sm" title="Close" onClick={() => setSearchOpen(false)}>
            <CloseIcon size={14} />
          </button>
        </div>
      )}

      {aiOpen && aiEnabled && (
        <div className="pane-overlay pane-ai">
          <div className="pane-ai-tabs">
            <button
              className={`pane-ai-tab ${aiMode === 'command' ? 'is-active' : ''}`}
              onClick={() => {
                setAiMode('command');
                setAiError(null);
              }}
            >
              Generate Command
            </button>
            <button
              className={`pane-ai-tab ${aiMode === 'diagnose' ? 'is-active' : ''}`}
              onClick={() => {
                setAiMode('diagnose');
                setAiError(null);
                if (!diagResult) askAi('diagnose');
              }}
            >
              Diagnose & Fix Error
            </button>
          </div>

          {aiMode === 'command' ? (
            <div className="pane-ai-row">
              <span className="pane-ai-label">Ask</span>
              <input
                autoFocus
                className="input input-sm"
                placeholder="e.g. show the 10 largest files under /var"
                value={aiQuery}
                onChange={(e) => setAiQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') askAi('command');
                  if (e.key === 'Escape') {
                    setAiOpen(false);
                    termRef.current?.focus();
                  }
                }}
              />
              <button className="btn btn-primary btn-sm" onClick={() => askAi('command')} disabled={aiBusy}>
                {aiBusy ? 'Thinking...' : 'Insert'}
              </button>
            </div>
          ) : (
            <div className="pane-ai-row">
              <span className="pane-ai-label">Error</span>
              <input
                autoFocus
                className="input input-sm"
                placeholder="Optional hint (e.g. failed to start service)"
                value={aiQuery}
                onChange={(e) => setAiQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') askAi('diagnose');
                  if (e.key === 'Escape') {
                    setAiOpen(false);
                    termRef.current?.focus();
                  }
                }}
              />
              <button className="btn btn-primary btn-sm" onClick={() => askAi('diagnose')} disabled={aiBusy}>
                {aiBusy ? 'Diagnosing...' : 'Diagnose'}
              </button>
            </div>
          )}

          {diagResult && (
            <div className="pane-ai-diag-result">
              <p className="diag-explanation">{diagResult.explanation}</p>
              {diagResult.fixCommand && (
                <div className="diag-command-box">
                  <span className="diag-command-label">Suggested Fix:</span>
                  <pre className="diag-command-code">{diagResult.fixCommand}</pre>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => {
                      send('shell:input', { sessionId, paneId, data: diagResult.fixCommand });
                      setAiOpen(false);
                      termRef.current?.focus();
                    }}
                  >
                    Insert Fix at Prompt
                  </button>
                </div>
              )}
            </div>
          )}

          <label className="pane-ai-context">
            <input
              type="checkbox"
              checked={shareContext}
              onChange={(e) => setShareContext(e.target.checked)}
            />
            Send recent terminal output as context
          </label>
          {aiError && <p className="pane-ai-error">{aiError}</p>}
          <p className="pane-ai-hint">
            {aiMode === 'command'
              ? 'The suggestion is typed at your prompt. Nothing runs until you press Enter.'
              : 'Analyzes recent terminal error output to diagnose issues and provide 1-click fixes.'}
          </p>
        </div>
      )}

      <div ref={containerRef} className="pane-xterm" />
    </div>
  );
}
