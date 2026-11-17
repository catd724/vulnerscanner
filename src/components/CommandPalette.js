'use client';

import { useMemo, useState } from 'react';
import { useStore } from '@/lib/store';

/**
 * terminal.ai - quick connect and command palette (Ctrl+K).
 *
 * Searches hosts, snippets and actions in one list so connecting never needs a
 * trip through the sidebar.
 *
 * The body is a separate component that only exists while the palette is open,
 * so the query and the highlighted row reset by unmounting rather than by an
 * effect that writes state on every open.
 */

export default function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  if (!open) return null;
  return <PaletteBody />;
}

function PaletteBody() {
  const togglePalette = useStore((s) => s.togglePalette);
  const hosts = useStore((s) => s.hosts);
  const snippets = useStore((s) => s.snippets);
  const openHost = useStore((s) => s.openHost);
  const openEditor = useStore((s) => s.openEditor);
  const toggleSnippetRunner = useStore((s) => s.toggleSnippetRunner);
  const setNav = useStore((s) => s.setNav);
  const settings = useStore((s) => s.settings);
  const toggleAi = useStore((s) => s.toggleAi);

  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();

    const hostItems = hosts.map((host) => ({
      id: `host-${host.id}`,
      kind: 'Host',
      label: host.label,
      detail: `${host.username ? `${host.username}@` : ''}${host.hostname}`,
      keywords: `${host.label} ${host.hostname} ${host.tags.join(' ')} ${host.groupName || ''}`,
      run: () => openHost(host.id).catch(() => {}),
    }));

    const snippetItems = snippets.map((snippet) => ({
      id: `snippet-${snippet.id}`,
      kind: 'Snippet',
      label: snippet.label,
      detail: snippet.body.split('\n')[0],
      keywords: `${snippet.label} ${snippet.body}`,
      run: () => toggleSnippetRunner(true),
    }));

    const actions = [
      {
        id: 'action-host',
        kind: 'Action',
        label: 'New host',
        detail: 'Add a server to the vault',
        keywords: 'new host add server create',
        run: () => openEditor({ kind: 'host', data: null }),
      },
      {
        id: 'action-identity',
        kind: 'Action',
        label: 'New identity',
        detail: 'Store a key or password in the keychain',
        keywords: 'new identity key password credential keychain',
        run: () => openEditor({ kind: 'identity', data: null }),
      },
      {
        id: 'action-forward',
        kind: 'Action',
        label: 'New forwarding rule',
        detail: 'Local, remote or dynamic SOCKS5',
        keywords: 'tunnel port forward socks proxy',
        run: () => openEditor({ kind: 'forward', data: null }),
      },
      {
        id: 'action-keychain',
        kind: 'Action',
        label: 'Open keychain',
        detail: 'Manage stored credentials',
        keywords: 'keychain identities secrets',
        run: () => setNav('keychain'),
      },
      {
        id: 'action-toggle-ai',
        kind: 'Action',
        label: settings?.aiEnabled ? 'Turn AI Assistant OFF' : 'Turn AI Assistant ON',
        detail: settings?.aiEnabled ? 'Disable AI command & diagnosis features' : 'Enable AI command & diagnosis features',
        keywords: 'ai assistant toggle enable disable copilot artificial intelligence',
        run: () => toggleAi(),
      },
    ];

    const all = [...hostItems, ...snippetItems, ...actions];
    if (!q) return all.slice(0, 12);
    return all.filter((item) => item.keywords.toLowerCase().includes(q)).slice(0, 20);
  }, [query, hosts, snippets, settings, toggleAi, openHost, openEditor, toggleSnippetRunner, setNav]);

  const choose = (item) => {
    togglePalette(false);
    item.run();
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => togglePalette(false)}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          placeholder="Connect to a host, run a snippet, or type a command"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            // A new query re-ranks the list, so the highlight goes back to the top.
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(items.length - 1, c + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (e.key === 'Enter' && items[cursor]) {
              choose(items[cursor]);
            } else if (e.key === 'Escape') {
              togglePalette(false);
            }
          }}
        />

        <div className="palette-list">
          {items.map((item, index) => (
            <button
              key={item.id}
              className={`palette-item ${index === cursor ? 'is-cursor' : ''}`}
              onMouseEnter={() => setCursor(index)}
              onClick={() => choose(item)}
            >
              <span className="palette-kind">{item.kind}</span>
              <span className="palette-label">{item.label}</span>
              <span className="palette-detail">{item.detail}</span>
            </button>
          ))}
          {items.length === 0 && <div className="palette-empty">Nothing matches “{query}”</div>}
        </div>
      </div>
    </div>
  );
}
