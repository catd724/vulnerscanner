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

  const toast = useStore((s) => s.toast);
  const closePane = useStore((s) => s.closePane);
  const aiEnabled = useStore((s) => s.settings?.aiEnabled);
  const setNav = useStore((s) => s.setNav);
  const addAiMessage = useStore((s) => s.addAiMessage);
  const getActivePaneContext = useStore((s) => s.getActivePaneContext);

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

    // Expose the xterm instance so the AI sidebar can read real scrollback.
    containerRef.current.__xterm = term;

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
      if (containerRef.current) containerRef.current.__xterm = null;
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

  const openAiSidebar = useCallback(
    (mode = 'chat') => {
      setNav('ai');
      const context = getActivePaneContext();
      if (context) {
        addAiMessage({
          role: 'user',
          mode,
          content: mode === 'diagnose' ? 'Diagnose this terminal output' : 'Analyze this terminal output',
          context,
          autoSend: true,
        });
      }
    },
    [setNav, addAiMessage, getActivePaneContext]
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
      openAiSidebar('command');
    } else if (key === 'd' && aiEnabled) {
      event.preventDefault();
      openAiSidebar('diagnose');
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
              title="Open AI assistant (Ctrl+Shift+I)"
              onClick={() => openAiSidebar('chat')}
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

      <div ref={containerRef} className="pane-xterm" data-pane-id={paneId} />
    </div>
  );
}
