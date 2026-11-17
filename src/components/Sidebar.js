'use client';

import { useMemo } from 'react';
import { useStore } from '@/lib/store';
import { UI_THEMES } from '@/lib/themes';
import Brand from './Brand';
import VulnScanner from './VulnScanner';
import AiSidebar from './AiSidebar';
import { Address, StatusDot } from './Address';
import {
  HostsIcon,
  SnippetsIcon,
  TunnelsIcon,
  KeychainIcon,
  ShieldCheckIcon,
  ScannerIcon,
  TwoFactorIcon,
  LockIcon,
  EditIcon,
  TrashIcon,
  ConnectIcon,
  FolderPlusIcon,
  ChevronIcon,
  SparkIcon,
  AiIcon,
  OsBadge,
} from './Icons';

/**
 * terminal.ai - navigation rail and host tree.
 *
 * Replaces the flat category grid. Groups nest to arbitrary depth via
 * parentId, hosts inherit their group's position in the tree, and tag +
 * search filters apply across the whole hierarchy at once.
 */

// `label` is the caption under the icon and must stay short enough for the
// rail; `title` is the full description for the tooltip.
const NAV_ITEMS = [
  { key: 'hosts', label: 'Hosts', title: 'Hosts', Icon: HostsIcon },
  { key: 'scanner', label: 'Scanner', title: 'Vulnerability scanner', Icon: ScannerIcon },
  { key: 'ai', label: 'AI', title: 'AI assistant', Icon: AiIcon },
  { key: 'snippets', label: 'Snippets', title: 'Snippets', Icon: SnippetsIcon },
  { key: 'tunnels', label: 'Tunnels', title: 'Port forwarding', Icon: TunnelsIcon },
  { key: 'keychain', label: 'Keychain', title: 'Keychain (stored credentials)', Icon: KeychainIcon },
  { key: 'knownHosts', label: 'Trusted', title: 'Known hosts (trusted host keys)', Icon: ShieldCheckIcon },
];

function matchesHost(host, search, tagFilter) {
  const q = search.trim().toLowerCase();
  const hitsSearch =
    !q ||
    host.label.toLowerCase().includes(q) ||
    host.hostname.toLowerCase().includes(q) ||
    (host.username || '').toLowerCase().includes(q) ||
    (host.groupName || '').toLowerCase().includes(q) ||
    host.tags.some((t) => t.includes(q));

  const hitsTag = !tagFilter || host.tags.includes(tagFilter);
  return hitsSearch && hitsTag;
}

function HostRow({ host, live, onOpen, onEdit, onDelete }) {
  const userText = host.username || host.identityUsername || 'root';

  return (
    <div
      className={`termius-host-card ${live ? 'is-live' : ''}`}
      onDoubleClick={() => onOpen(host)}
      title={live ? 'Connected - Double click to switch' : 'Double click to connect'}
    >
      <div className="host-card-left">
        <OsBadge os={host.osType || 'ubuntu'} size={32} />
        {live && <span className="host-card-live-dot" title="Live session" />}
      </div>

      <div className="host-card-info">
        <div className="host-card-title-row">
          <span className="host-card-title">{host.label}</span>
          {host.tags?.length > 0 && (
            <span className="host-tags">
              {host.tags.slice(0, 2).map((tag) => (
                <span key={tag} className="tag">
                  {tag}
                </span>
              ))}
              {host.tags.length > 2 && (
                <span className="tag tag-more" title={host.tags.join(', ')}>
                  +{host.tags.length - 2}
                </span>
              )}
            </span>
          )}
        </div>
        <div className="host-card-subtitle">
          <span className="host-card-protocol">ssh</span>, <span className="host-card-user">{userText}</span>
          <span className="host-card-host-ip"> · {host.hostname}</span>
        </div>
      </div>

      <div className="host-card-actions">
        <button
          className="icon-btn"
          title="Connect"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(host);
          }}
        >
          <ConnectIcon size={14} />
        </button>
        <button
          className="icon-btn"
          title="Edit"
          onClick={(e) => {
            e.stopPropagation();
            onEdit(host);
          }}
        >
          <EditIcon size={14} />
        </button>
        <button
          className="icon-btn icon-btn-danger"
          title="Delete"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(host);
          }}
        >
          <TrashIcon size={14} />
        </button>
      </div>
    </div>
  );
}

function GroupNode({ group, tree, hostsByGroup, depth, handlers, liveHostIds }) {
  const collapsed = useStore((s) => s.collapsedGroups[group.id]);
  const toggleGroup = useStore((s) => s.toggleGroup);

  const children = tree.get(group.id) || [];
  const hosts = hostsByGroup.get(group.id) || [];
  const count = hosts.length + children.length;

  return (
    <div className="group-node" style={{ '--depth': depth }}>
      <button className="group-header" onClick={() => toggleGroup(group.id)}>
        <span className={`group-caret ${collapsed ? '' : 'is-open'}`}>
          <ChevronIcon size={12} />
        </span>
        <span className="group-name">{group.name}</span>
        <span className="group-count">{count}</span>
      </button>

      {!collapsed && (
        <div className="group-children">
          {children.map((child) => (
            <GroupNode
              key={child.id}
              group={child}
              tree={tree}
              hostsByGroup={hostsByGroup}
              depth={depth + 1}
              handlers={handlers}
              liveHostIds={liveHostIds}
            />
          ))}
          {hosts.map((host) => (
            <HostRow
              key={host.id}
              host={host}
              live={liveHostIds.has(host.id)}
              {...handlers}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function Sidebar() {
  const nav = useStore((s) => s.nav);
  const setNav = useStore((s) => s.setNav);
  const search = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);
  const tagFilter = useStore((s) => s.tagFilter);
  const setTagFilter = useStore((s) => s.setTagFilter);
  const hosts = useStore((s) => s.hosts);
  const groups = useStore((s) => s.groups);
  const openHost = useStore((s) => s.openHost);
  const openEditor = useStore((s) => s.openEditor);
  const refresh = useStore((s) => s.refresh);
  const toast = useStore((s) => s.toast);
  const lockVault = useStore((s) => s.lockVault);
  const vault = useStore((s) => s.vault);
  const tabs = useStore((s) => s.tabs);
  const settings = useStore((s) => s.settings);
  const toggleAi = useStore((s) => s.toggleAi);
  const setUiTheme = useStore((s) => s.setUiTheme);

  // A host is "live" when any open pane is connected to it. This is what ties
  // the sidebar to the workspace: you can see what you are already in.
  const liveHostIds = useMemo(() => {
    const ids = new Set();
    for (const tab of tabs) {
      for (const pane of Object.values(tab.panes)) {
        if (pane.sessionId && pane.status === 'connected') ids.add(pane.hostId);
      }
    }
    return ids;
  }, [tabs]);

  const visibleHosts = useMemo(
    () => hosts.filter((h) => matchesHost(h, search, tagFilter)),
    [hosts, search, tagFilter]
  );

  const allTags = useMemo(
    () => Array.from(new Set(hosts.flatMap((h) => h.tags))).sort(),
    [hosts]
  );

  // parentId -> child groups, and groupId -> hosts, both filtered.
  const { tree, roots, hostsByGroup, ungrouped } = useMemo(() => {
    const byParent = new Map();
    for (const group of groups) {
      const key = group.parentId || null;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(group);
    }
    const byGroup = new Map();
    const loose = [];
    for (const host of visibleHosts) {
      if (!host.groupId) loose.push(host);
      else {
        if (!byGroup.has(host.groupId)) byGroup.set(host.groupId, []);
        byGroup.get(host.groupId).push(host);
      }
    }
    return {
      tree: byParent,
      roots: byParent.get(null) || [],
      hostsByGroup: byGroup,
      ungrouped: loose,
    };
  }, [groups, visibleHosts]);

  const handlers = {
    onOpen: (host) => openHost(host.id).catch(() => {}),
    onEdit: (host) => openEditor({ kind: 'host', data: host }),
    onDelete: async (host) => {
      if (!confirm(`Delete host "${host.label}"? Saved tunnels for it are removed too.`)) return;
      try {
        await fetch(`/api/hosts/${host.id}`, { method: 'DELETE' });
        await refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    },
  };

  return (
    <div className="sidebar">
      <nav className="rail">
        <div className="rail-brand" title="AI Terminal">
          <Brand size={30} showWordmark={false} />
        </div>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            className={`rail-btn ${nav === item.key ? 'is-active' : ''}`}
            title={item.title}
            aria-current={nav === item.key ? 'page' : undefined}
            onClick={() => setNav(item.key)}
          >
            <item.Icon size={19} />
            <span className="rail-label">{item.label}</span>
          </button>
        ))}
        <button
          className={`rail-btn rail-btn-bottom ${settings?.aiEnabled ? 'is-on' : ''}`}
          title={
            settings?.aiEnabled
              ? 'AI Assistant is enabled - Click to disable'
              : 'AI Assistant is disabled - Click to enable'
          }
          onClick={() => toggleAi()}
        >
          <SparkIcon size={19} />
          <span className="rail-label">AI {settings?.aiEnabled ? 'ON' : 'OFF'}</span>
        </button>
        <button
          className={`rail-btn ${vault.totpEnabled ? 'is-on' : ''}`}
          title={
            vault.totpEnabled
              ? 'Two-factor is on for this vault'
              : 'Add a second factor to the vault (Google Authenticator)'
          }
          onClick={() => openEditor({ kind: 'twofactor' })}
        >
          <TwoFactorIcon size={19} />
          <span className="rail-label">2FA</span>
        </button>
        <button
          className="rail-btn rail-btn-danger"
          title="Lock the vault and close all sessions"
          onClick={lockVault}
        >
          <LockIcon size={19} />
          <span className="rail-label">Lock</span>
        </button>
      </nav>

      <div className="sidebar-panel">
        {nav === 'hosts' && (
          <>
            <header className="panel-header">
              <h2 className="panel-title">Hosts</h2>
              <span className="panel-header-actions">
                <button
                  className="icon-btn"
                  title="New group"
                  onClick={() => openEditor({ kind: 'group', data: null })}
                >
                  <FolderPlusIcon size={15} />
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => openEditor({ kind: 'host', data: null })}
                >
                  New host
                </button>
              </span>
            </header>

            <div className="panel-search">
              <input
                className="input"
                placeholder="Search hosts, addresses, tags"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {allTags.length > 0 && (
              <div className="tag-filter">
                <button
                  className={`tag-btn ${tagFilter === null ? 'is-active' : ''}`}
                  onClick={() => setTagFilter(null)}
                >
                  All
                </button>
                {allTags.map((tag) => (
                  <button
                    key={tag}
                    className={`tag-btn ${tagFilter === tag ? 'is-active' : ''}`}
                    onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}

            <div className="panel-body">
              {roots.map((group) => (
                <GroupNode
                  key={group.id}
                  group={group}
                  tree={tree}
                  hostsByGroup={hostsByGroup}
                  depth={0}
                  handlers={handlers}
                  liveHostIds={liveHostIds}
                />
              ))}

              {ungrouped.length > 0 && (
                <div className="group-node">
                  <div className="group-header group-header-static">
                    <span className="group-name">Ungrouped</span>
                    <span className="group-count">{ungrouped.length}</span>
                  </div>
                  <div className="group-children">
                    {ungrouped.map((host) => (
                      <HostRow
                        key={host.id}
                        host={host}
                        live={liveHostIds.has(host.id)}
                        {...handlers}
                      />
                    ))}
                  </div>
                </div>
              )}

              {visibleHosts.length === 0 && (
                <div className="empty-state">
                  <Brand size={40} showWordmark={false} />
                  <p className="empty-title">
                    {hosts.length === 0 ? 'No hosts yet' : 'Nothing matches that filter'}
                  </p>
                  <p className="empty-detail">
                    {hosts.length === 0
                      ? 'Add a host to start a session.'
                      : 'Try a different search or clear the tag filter.'}
                  </p>
                  {hosts.length === 0 && (
                    <button
                      className="btn btn-primary"
                      onClick={() => openEditor({ kind: 'host', data: null })}
                    >
                      Add your first host
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {nav !== 'hosts' && <SidePanel nav={nav} />}

        <div className="sidebar-footer">
          <label className="sidebar-footer-label">Theme</label>
          <select
            className="sidebar-theme-select"
            value={settings?.uiTheme || 'dark'}
            onChange={(e) => setUiTheme(e.target.value)}
          >
            {Object.entries(UI_THEMES).map(([key, theme]) => (
              <option key={key} value={key}>
                {theme.name}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* secondary panels                                                           */
/* -------------------------------------------------------------------------- */

function SidePanel({ nav }) {
  const snippets = useStore((s) => s.snippets);
  const identities = useStore((s) => s.identities);
  const forwards = useStore((s) => s.forwards);
  const knownHosts = useStore((s) => s.knownHosts);
  const openEditor = useStore((s) => s.openEditor);
  const refresh = useStore((s) => s.refresh);
  const toast = useStore((s) => s.toast);
  const toggleSnippetRunner = useStore((s) => s.toggleSnippetRunner);

  if (nav === 'scanner') {
    return <VulnScanner />;
  }

  if (nav === 'ai') {
    return <AiSidebar />;
  }

  const del = async (path, id, label) => {
    if (!confirm(`Delete "${label}"?`)) return;
    try {
      await fetch(`${path}/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  if (nav === 'snippets') {
    return (
      <>
        <header className="panel-header">
          <h2 className="panel-title">Snippets</h2>
          <span className="panel-header-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => toggleSnippetRunner(true)}>
              Run on...
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => openEditor({ kind: 'snippet', data: null })}
            >
              New
            </button>
          </span>
        </header>
        <div className="panel-body">
          {snippets.map((snippet) => (
            <div key={snippet.id} className="list-row">
              <div className="list-row-main">
                <span className="list-row-title">{snippet.label}</span>
                <code className="list-row-code">{snippet.body.split('\n')[0]}</code>
                {snippet.description && (
                  <span className="list-row-sub">{snippet.description}</span>
                )}
              </div>
              <span className="host-row-actions">
                <button
                  className="icon-btn"
                  title="Edit"
                  onClick={() => openEditor({ kind: 'snippet', data: snippet })}
                >
                  <EditIcon size={14} />
                </button>
                <button
                  className="icon-btn icon-btn-danger"
                  title="Delete"
                  onClick={() => del('/api/snippets', snippet.id, snippet.label)}
                >
                  <TrashIcon size={14} />
                </button>
              </span>
            </div>
          ))}
          {snippets.length === 0 && (
            <div className="empty-state">
              <p className="empty-title">No snippets</p>
              <p className="empty-detail">
                Save a command once, then run it on one pane or on every open session at once.
              </p>
            </div>
          )}
        </div>
      </>
    );
  }

  if (nav === 'keychain') {
    return (
      <>
        <header className="panel-header">
          <h2 className="panel-title">Keychain</h2>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => openEditor({ kind: 'identity', data: null })}
          >
            New identity
          </button>
        </header>
        <div className="panel-body">
          <p className="panel-note">
            Passwords, keys and passphrases are sealed with AES-256-GCM under your master
            password. They are never sent to the browser.
          </p>
          {identities.map((identity) => (
            <div key={identity.id} className="list-row">
              <div className="list-row-main">
                <span className="list-row-title">{identity.label}</span>
                <span className="list-row-sub">
                  {identity.username || 'no default user'}
                  {' · '}
                  {identity.hasKey ? identity.keyType || 'key' : 'password'}
                </span>
                {identity.fingerprint && (
                  <code className="list-row-code">{identity.fingerprint}</code>
                )}
              </div>
              <span className="host-row-actions">
                <button
                  className="icon-btn"
                  title="Edit"
                  onClick={() => openEditor({ kind: 'identity', data: identity })}
                >
                  <EditIcon size={14} />
                </button>
                <button
                  className="icon-btn icon-btn-danger"
                  title="Delete"
                  onClick={() => del('/api/identities', identity.id, identity.label)}
                >
                  <TrashIcon size={14} />
                </button>
              </span>
            </div>
          ))}
          {identities.length === 0 && (
            <div className="empty-state">
              <p className="empty-title">Keychain is empty</p>
              <p className="empty-detail">
                Add an identity to reuse one credential across many hosts.
              </p>
            </div>
          )}
        </div>
      </>
    );
  }

  if (nav === 'tunnels') {
    return (
      <>
        <header className="panel-header">
          <h2 className="panel-title">Port forwarding</h2>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => openEditor({ kind: 'forward', data: null })}
          >
            New rule
          </button>
        </header>
        <div className="panel-body">
          {forwards.map((forward) => (
            <div key={forward.id} className="list-row">
              <div className="list-row-main">
                <span className="list-row-title">
                  <span className={`badge badge-${forward.type}`}>{forward.type}</span>
                  {forward.label}
                </span>
                <code className="list-row-code">
                  {forward.type === 'dynamic'
                    ? `socks5://${forward.listenHost}:${forward.listenPort}`
                    : `${forward.listenHost}:${forward.listenPort} → ${forward.destHost}:${forward.destPort}`}
                </code>
                <span className="list-row-sub">via {forward.hostLabel}</span>
              </div>
              <span className="host-row-actions">
                <button
                  className="icon-btn"
                  title="Edit"
                  onClick={() => openEditor({ kind: 'forward', data: forward })}
                >
                  <EditIcon size={14} />
                </button>
                <button
                  className="icon-btn icon-btn-danger"
                  title="Delete"
                  onClick={() => del('/api/forwards', forward.id, forward.label)}
                >
                  <TrashIcon size={14} />
                </button>
              </span>
            </div>
          ))}
          {forwards.length === 0 && (
            <div className="empty-state">
              <p className="empty-title">No forwarding rules</p>
              <p className="empty-detail">
                Local (-L), remote (-R) and dynamic SOCKS5 (-D) tunnels are configured here and
                started from a live session.
              </p>
            </div>
          )}
        </div>
      </>
    );
  }

  if (nav === 'knownHosts') {
    return (
      <>
        <header className="panel-header">
          <h2 className="panel-title">Known hosts</h2>
        </header>
        <div className="panel-body">
          <p className="panel-note">
            Host keys accepted on first connection. Delete one to be asked again.
          </p>
          {knownHosts.map((entry) => (
            <div key={entry.id} className="list-row">
              <div className="list-row-main">
                <span className="list-row-title">
                  {entry.host}:{entry.port}
                </span>
                <span className="list-row-sub">{entry.keyType}</span>
                <code className="list-row-code">{entry.fingerprint}</code>
              </div>
              <button
                className="icon-btn icon-btn-danger"
                title="Forget"
                onClick={() => del('/api/known-hosts', entry.id, entry.host)}
              >
                <TrashIcon size={14} />
              </button>
            </div>
          ))}
          {knownHosts.length === 0 && (
            <div className="empty-state">
              <p className="empty-title">No trusted host keys yet</p>
              <p className="empty-detail">
                The first connection to a host asks you to verify its fingerprint.
              </p>
            </div>
          )}
        </div>
      </>
    );
  }

  return null;
}
