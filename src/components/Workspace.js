'use client';

import { useMemo } from 'react';
import { useStore } from '@/lib/store';
import PaneTree from './PaneTree';
import SftpPanel from './SftpPanel';
import TunnelBar from './TunnelBar';
import Brand from './Brand';
import { PlusIcon, CloseIcon, FolderIcon } from './Icons';
import { Address } from './Address';

/**
 * terminal.ai - the tabbed workspace.
 *
 * Every tab stays mounted and is hidden with CSS rather than unmounted, so
 * switching tabs never disposes an xterm instance or drops scrollback.
 */

function EmptyWorkspace() {
  const hosts = useStore((s) => s.hosts);
  const openHost = useStore((s) => s.openHost);
  const openEditor = useStore((s) => s.openEditor);
  const togglePalette = useStore((s) => s.togglePalette);

  const recent = useMemo(
    () =>
      [...hosts]
        .filter((h) => h.lastUsedAt)
        .sort((a, b) => new Date(b.lastUsedAt) - new Date(a.lastUsedAt))
        .slice(0, 6),
    [hosts]
  );

  return (
    <div className="workspace-empty">
      <Brand size={56} wordmarkSize="lg" />
      <p className="workspace-empty-tagline">
        SSH, SFTP, AI assistance, and vulnerability scanning in one place.
      </p>

      {recent.length > 0 && (
        <div className="recent-grid">
          <span className="recent-title">Recent</span>
          {recent.map((host) => (
            <button key={host.id} className="recent-card" onClick={() => openHost(host.id)}>
              <span className="recent-label">{host.label}</span>
              <Address user={host.username || null} host={host.hostname} port={host.port} />
            </button>
          ))}
        </div>
      )}

      <div className="workspace-empty-actions">
        <button className="btn btn-primary" onClick={() => openEditor({ kind: 'host', data: null })}>
          New host
        </button>
        <button className="btn btn-ghost" onClick={() => togglePalette(true)}>
          Quick connect <kbd>Ctrl</kbd>+<kbd>K</kbd>
        </button>
      </div>

      <ul className="shortcut-list">
        <li>
          <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> split right
        </li>
        <li>
          <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd> split down
        </li>
        <li>
          <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> find in scrollback
        </li>
        <li>
          <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd> ask the AI assistant
        </li>
      </ul>
    </div>
  );
}

export default function Workspace() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const closeTab = useStore((s) => s.closeTab);
  const toggleSftp = useStore((s) => s.toggleSftp);
  const togglePalette = useStore((s) => s.togglePalette);
  const hosts = useStore((s) => s.hosts);

  const hostsById = useMemo(
    () => Object.fromEntries(hosts.map((h) => [h.id, h])),
    [hosts]
  );

  return (
    <section className="workspace">
      <header className="tabbar">
        <div className="tabbar-tabs">
          {tabs.map((tab) => {
            const paneCount = Object.keys(tab.panes).length;
            return (
              <div
                key={tab.id}
                className={`tab ${activeTabId === tab.id ? 'is-active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <span className="tab-title">{tab.title}</span>
                {paneCount > 1 && <span className="tab-badge">{paneCount}</span>}
                <button
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  aria-label={`Close ${tab.title}`}
                >
                  <CloseIcon size={12} />
                </button>
              </div>
            );
          })}
          <button className="tab-add" title="Quick connect (Ctrl+K)" onClick={() => togglePalette(true)}>
            <PlusIcon size={14} />
          </button>
        </div>

        {activeTabId && (
          <div className="tabbar-actions">
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => toggleSftp(activeTabId)}
              title="Toggle the file manager"
            >
              <FolderIcon size={14} />
              Files
            </button>
          </div>
        )}
      </header>

      <div className="workspace-body">
        {tabs.length === 0 && <EmptyWorkspace />}

        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="tab-surface"
            // Hidden, not unmounted: unmounting would dispose every xterm in it.
            style={{ display: activeTabId === tab.id ? 'flex' : 'none' }}
          >
            <div className="tab-main">
              <div className="pane-area">
                <PaneTree tab={tab} node={tab.layout} hostsById={hostsById} />
              </div>
              <TunnelBar tab={tab} />
            </div>
            {tab.sftpOpen && <SftpPanel tab={tab} />}
          </div>
        ))}
      </div>
    </section>
  );
}
