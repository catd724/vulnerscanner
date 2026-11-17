'use client';

import { useEffect } from 'react';
import { useStore } from '@/lib/store';
import { UI_THEMES, DEFAULT_UI_THEME } from '@/lib/themes';
import Sidebar from '@/components/Sidebar';
import Workspace from '@/components/Workspace';
import Editors from '@/components/Editors';
import CommandPalette from '@/components/CommandPalette';
import SnippetRunner from '@/components/SnippetRunner';
import VaultGate from '@/components/VaultGate';
import { Prompts, Toasts } from '@/components/Prompts';

/**
 * AI Terminal - application shell.
 *
 * Bootstraps the workspace in one request, subscribes to server session events
 * once, and owns the global shortcuts. Everything below is either the sidebar
 * or the tabbed workspace.
 */

export default function Home() {
  const ready = useStore((s) => s.ready);
  const error = useStore((s) => s.error);
  const vault = useStore((s) => s.vault);
  const settings = useStore((s) => s.settings);
  const bootstrap = useStore((s) => s.bootstrap);
  const connect = useStore((s) => s.connect);
  const togglePalette = useStore((s) => s.togglePalette);

  useEffect(() => {
    bootstrap();
    return connect();
  }, [bootstrap, connect]);

  // Apply UI theme CSS variables to the document root.
  useEffect(() => {
    const themeName = settings?.uiTheme || DEFAULT_UI_THEME;
    const theme = UI_THEMES[themeName] || UI_THEMES[DEFAULT_UI_THEME];
    const root = document.documentElement;
    for (const [key, value] of Object.entries(theme.variables)) {
      root.style.setProperty(key, value);
    }
    root.setAttribute('data-ui-theme', themeName);

    // Sync meta theme-color for mobile browsers.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme.variables['--bg-primary']);
  }, [settings?.uiTheme]);

  useEffect(() => {
    const onKey = (event) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        togglePalette();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePalette]);

  if (!ready) {
    return (
      <div className="boot">
        <span className="pulse-dot" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="boot boot-error">
        <p className="empty-title">Could not reach the local server</p>
        <p className="empty-detail">{error}</p>
        <button className="btn btn-primary" onClick={() => bootstrap()}>
          Retry
        </button>
      </div>
    );
  }

  if (!vault.unlocked) return <VaultGate />;

  return (
    <div className="app">
      <Sidebar />
      <Workspace />

      <Editors />
      <CommandPalette />
      <SnippetRunner />
      <Prompts />
      <Toasts />
    </div>
  );
}
