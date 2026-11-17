'use client';

import { create } from 'zustand';
import { api, call, send, getSocket, onSessionEvent } from './socket';

/**
 * terminal.ai - workspace state.
 *
 * Replaces the single 342-line page component that used to own connections,
 * sessions, tabs and filters at once. Terminal *output* deliberately does not
 * live here (see socket.js) - only structure does: which tabs exist, how each
 * tab's panes are split, and what the server told us about each session.
 */

/* -------------------------------------------------------------------------- */
/* pane layout tree                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A tab's layout is a binary tree:
 *   { type: 'leaf', paneId }
 *   { type: 'split', dir: 'row' | 'col', ratio, a, b }
 * 'row' splits side by side (vertical divider), 'col' stacks (horizontal).
 */

let idCounter = 0;
const uid = (prefix) => `${prefix}${++idCounter}-${Math.random().toString(36).slice(2, 7)}`;

export function splitLayout(layout, targetPaneId, dir, newPaneId) {
  if (layout.type === 'leaf') {
    if (layout.paneId !== targetPaneId) return layout;
    return {
      type: 'split',
      dir,
      ratio: 0.5,
      a: { type: 'leaf', paneId: targetPaneId },
      b: { type: 'leaf', paneId: newPaneId },
    };
  }
  return {
    ...layout,
    a: splitLayout(layout.a, targetPaneId, dir, newPaneId),
    b: splitLayout(layout.b, targetPaneId, dir, newPaneId),
  };
}

/** Remove a pane and collapse the split that held it. Returns null if empty. */
export function removeFromLayout(layout, paneId) {
  if (layout.type === 'leaf') return layout.paneId === paneId ? null : layout;
  const a = removeFromLayout(layout.a, paneId);
  const b = removeFromLayout(layout.b, paneId);
  if (!a) return b;
  if (!b) return a;
  return { ...layout, a, b };
}

export function setLayoutRatio(layout, nodeId, ratio) {
  if (layout.type === 'leaf') return layout;
  if (layout.nodeId === nodeId) return { ...layout, ratio };
  return {
    ...layout,
    a: setLayoutRatio(layout.a, nodeId, ratio),
    b: setLayoutRatio(layout.b, nodeId, ratio),
  };
}

export function collectPaneIds(layout, out = []) {
  if (!layout) return out;
  if (layout.type === 'leaf') {
    out.push(layout.paneId);
    return out;
  }
  collectPaneIds(layout.a, out);
  collectPaneIds(layout.b, out);
  return out;
}

/** Give every split node a stable id so drag handles can address it. */
function withNodeIds(layout) {
  if (!layout || layout.type === 'leaf') return layout;
  return {
    ...layout,
    nodeId: layout.nodeId || uid('n'),
    a: withNodeIds(layout.a),
    b: withNodeIds(layout.b),
  };
}

/* -------------------------------------------------------------------------- */

const EMPTY_DATA = {
  hosts: [],
  groups: [],
  identities: [],
  snippets: [],
  forwards: [],
  knownHosts: [],
};

export const useStore = create((set, get) => ({
  ready: false,
  error: null,
  vault: { initialised: false, unlocked: false, legacyPending: 0 },
  ...EMPTY_DATA,

  // UI
  nav: 'hosts',
  search: '',
  tagFilter: null,
  collapsedGroups: {},
  editor: null,
  paletteOpen: false,
  snippetRunnerOpen: false,
  toasts: [],
  settings: { aiEnabled: false, uiTheme: 'dark' },

  // Vulnerability scanner
  scans: [],
  activeScanId: null,

  // Sessions and tabs
  sessions: {},
  tabs: [],
  activeTabId: null,
  prompts: [],

  /* --- data ------------------------------------------------------------- */

  async bootstrap() {
    try {
      const data = await api('/api/bootstrap');
      set({
        ready: true,
        error: null,
        vault: data.vault,
        settings: data.settings || { aiEnabled: false },
        hosts: data.hosts,
        groups: data.groups,
        identities: data.identities,
        snippets: data.snippets,
        forwards: data.forwards,
        knownHosts: data.knownHosts,
      });
      get().loadScans();
    } catch (err) {
      set({ ready: true, error: err.message });
    }
  },

  async refresh() {
    const data = await api('/api/bootstrap');
    set({
      vault: data.vault,
      settings: data.settings || get().settings,
      hosts: data.hosts,
      groups: data.groups,
      identities: data.identities,
      snippets: data.snippets,
      forwards: data.forwards,
      knownHosts: data.knownHosts,
    });
  },

  async toggleAi(enabled) {
    const nextVal = enabled !== undefined ? enabled : !get().settings?.aiEnabled;
    set((s) => ({ settings: { ...s.settings, aiEnabled: nextVal } }));
    try {
      await api('/api/settings', {
        method: 'POST',
        body: { aiEnabled: nextVal },
      });
      get().toast(nextVal ? 'AI features enabled' : 'AI features disabled', 'info');
    } catch (err) {
      get().toast(`Could not update settings: ${err.message}`, 'error');
    }
  },

  async setUiTheme(uiTheme) {
    set((s) => ({ settings: { ...s.settings, uiTheme } }));
    try {
      await api('/api/settings', {
        method: 'POST',
        body: { uiTheme },
      });
    } catch (err) {
      get().toast(`Could not update theme: ${err.message}`, 'error');
    }
  },

  /* --- vulnerability scanner -------------------------------------------- */

  loadScans() {
    try {
      const raw = localStorage.getItem('vuln-scanner-scans');
      if (raw) {
        const scans = JSON.parse(raw);
        set({ scans: Array.isArray(scans) ? scans : [] });
      }
    } catch {
      /* ignore */
    }
  },

  saveScans(scans) {
    try {
      localStorage.setItem('vuln-scanner-scans', JSON.stringify(scans));
    } catch {
      /* ignore */
    }
  },

  addScan(scan) {
    set((s) => {
      const scans = [scan, ...s.scans].slice(0, 100);
      get().saveScans(scans);
      return { scans, activeScanId: scan.id };
    });
  },

  deleteScan(id) {
    set((s) => {
      const scans = s.scans.filter((sc) => sc.id !== id);
      get().saveScans(scans);
      return { scans, activeScanId: s.activeScanId === id ? (scans[0]?.id || null) : s.activeScanId };
    });
  },

  clearScans() {
    set({ scans: [], activeScanId: null });
    get().saveScans([]);
  },

  setActiveScan(id) {
    set({ activeScanId: id });
  },

  /* --- vault ------------------------------------------------------------ */

  async unlockVault(masterPassword, initialise = false, code = null) {
    const result = await api('/api/vault', {
      method: 'POST',
      body: { action: initialise ? 'init' : 'unlock', masterPassword, code },
    });
    set({ vault: result });
    if (result.imported?.imported > 0) {
      get().toast(
        `Imported ${result.imported.imported} connection${
          result.imported.imported === 1 ? '' : 's'
        } from the previous version`,
        'success'
      );
    }
    await get().refresh();
    return result;
  },

  async lockVault() {
    const result = await api('/api/vault', { method: 'POST', body: { action: 'lock' } });
    set({ vault: result, ...EMPTY_DATA, tabs: [], activeTabId: null, sessions: {} });
  },

  /* --- toasts ----------------------------------------------------------- */

  toast(message, kind = 'info') {
    const id = uid('t');
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, kind === 'error' ? 8000 : 4000);
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  /* --- ui --------------------------------------------------------------- */

  setNav: (nav) => set({ nav }),
  setSearch: (search) => set({ search }),
  setTagFilter: (tagFilter) => set({ tagFilter }),
  openEditor: (editor) => set({ editor }),
  closeEditor: () => set({ editor: null }),
  togglePalette: (open) => set((s) => ({ paletteOpen: open ?? !s.paletteOpen })),
  toggleSnippetRunner: (open) => set((s) => ({ snippetRunnerOpen: open ?? !s.snippetRunnerOpen })),

  toggleGroup(groupId) {
    set((s) => ({
      collapsedGroups: { ...s.collapsedGroups, [groupId]: !s.collapsedGroups[groupId] },
    }));
  },

  /* --- sessions and tabs ------------------------------------------------ */

  /** Open a host in a new tab, or in the given pane when replacing one. */
  async openHost(hostId, { intoTabId = null, intoPaneId = null } = {}) {
    const host = get().hosts.find((h) => h.id === hostId);
    const label = host ? host.label : `host ${hostId}`;

    const tabId = intoTabId || uid('tab');
    const paneId = intoPaneId || uid('pane');

    // Show the tab immediately so the connect progress is visible.
    if (!intoTabId) {
      set((s) => ({
        tabs: [
          ...s.tabs,
          {
            id: tabId,
            title: label,
            hostId,
            layout: { type: 'leaf', paneId },
            panes: { [paneId]: { paneId, hostId, sessionId: null, label, status: 'connecting' } },
            activePaneId: paneId,
            sftpOpen: false,
            sftpPath: null,
          },
        ],
        activeTabId: tabId,
      }));
    } else {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id !== tabId
            ? t
            : {
                ...t,
                panes: {
                  ...t.panes,
                  [paneId]: { paneId, hostId, sessionId: null, label, status: 'connecting' },
                },
              }
        ),
      }));
    }

    try {
      const session = await call('session:open', { hostId });
      await call('shell:open', { sessionId: session.sessionId, paneId, cols: 80, rows: 24 });

      set((s) => ({
        sessions: { ...s.sessions, [session.sessionId]: session },
        tabs: s.tabs.map((t) =>
          t.id !== tabId
            ? t
            : {
                ...t,
                panes: {
                  ...t.panes,
                  [paneId]: {
                    ...t.panes[paneId],
                    sessionId: session.sessionId,
                    status: 'connected',
                  },
                },
              }
        ),
      }));

      // Run the host's startup snippet once the shell is live.
      if (host?.startupSnippetId) {
        const snippet = get().snippets.find((sn) => sn.id === host.startupSnippetId);
        if (snippet) {
          setTimeout(() => {
            call('snippet:run', {
              targets: [{ sessionId: session.sessionId, paneId }],
              body: snippet.body,
            }).catch(() => {});
          }, 400);
        }
      }

      return { sessionId: session.sessionId, paneId, tabId };
    } catch (err) {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id !== tabId
            ? t
            : {
                ...t,
                panes: {
                  ...t.panes,
                  [paneId]: { ...t.panes[paneId], status: 'error', error: err.message },
                },
              }
        ),
      }));
      get().toast(`${label}: ${err.message}`, 'error');
      throw err;
    }
  },

  setActiveTab: (activeTabId) => set({ activeTabId }),

  setActivePane(tabId, paneId) {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, activePaneId: paneId } : t)),
    }));
  },

  /** Split the active pane and open the same host in the new half. */
  async splitPane(tabId, paneId, dir) {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const source = tab.panes[paneId];
    if (!source) return;

    const newPaneId = uid('pane');

    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id !== tabId
          ? t
          : {
              ...t,
              layout: withNodeIds(splitLayout(t.layout, paneId, dir, newPaneId)),
              panes: {
                ...t.panes,
                [newPaneId]: {
                  paneId: newPaneId,
                  hostId: source.hostId,
                  sessionId: null,
                  label: source.label,
                  status: 'connecting',
                },
              },
              activePaneId: newPaneId,
            }
      ),
    }));

    try {
      // Reuse the existing SSH connection: a split is another channel, not
      // another handshake.
      if (source.sessionId) {
        await call('shell:open', {
          sessionId: source.sessionId,
          paneId: newPaneId,
          cols: 80,
          rows: 24,
        });
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id !== tabId
              ? t
              : {
                  ...t,
                  panes: {
                    ...t.panes,
                    [newPaneId]: {
                      ...t.panes[newPaneId],
                      sessionId: source.sessionId,
                      status: 'connected',
                    },
                  },
                }
          ),
        }));
      } else {
        await get().openHost(source.hostId, { intoTabId: tabId, intoPaneId: newPaneId });
      }
    } catch (err) {
      get().toast(err.message, 'error');
    }
  },

  closePane(tabId, paneId) {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const pane = tab.panes[paneId];
    if (pane?.sessionId) {
      call('shell:close', { sessionId: pane.sessionId, paneId }).catch(() => {});
    }

    const layout = removeFromLayout(tab.layout, paneId);
    if (!layout) {
      get().closeTab(tabId);
      return;
    }

    const remaining = { ...tab.panes };
    delete remaining[paneId];

    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id !== tabId
          ? t
          : {
              ...t,
              layout,
              panes: remaining,
              activePaneId:
                t.activePaneId === paneId ? collectPaneIds(layout)[0] : t.activePaneId,
            }
      ),
    }));
  },

  setPaneRatio(tabId, nodeId, ratio) {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, layout: setLayoutRatio(t.layout, nodeId, ratio) } : t
      ),
    }));
  },

  closeTab(tabId) {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;

    // Close each distinct session backing this tab's panes.
    const sessionIds = new Set(
      Object.values(tab.panes).map((p) => p.sessionId).filter(Boolean)
    );
    const stillUsed = new Set(
      get()
        .tabs.filter((t) => t.id !== tabId)
        .flatMap((t) => Object.values(t.panes).map((p) => p.sessionId))
        .filter(Boolean)
    );
    for (const sessionId of sessionIds) {
      if (!stillUsed.has(sessionId)) {
        call('session:close', { sessionId }).catch(() => {});
      }
    }

    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== tabId);
      return {
        tabs,
        activeTabId:
          s.activeTabId === tabId ? (tabs.length ? tabs[tabs.length - 1].id : null) : s.activeTabId,
      };
    });
  },

  toggleSftp(tabId, open) {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, sftpOpen: open ?? !t.sftpOpen } : t)),
    }));
  },

  setSftpPath(tabId, sftpPath) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, sftpPath } : t)) }));
  },

  /* --- prompts (host key / keyboard-interactive) ------------------------ */

  answerPrompt(prompt, answer) {
    call('prompt:answer', { sessionId: prompt.sessionId, promptId: prompt.promptId, ...answer })
      .catch((err) => get().toast(err.message, 'error'))
      .finally(() => {
        set((s) => ({ prompts: s.prompts.filter((p) => p.promptId !== prompt.promptId) }));
      });
  },

  /* --- wiring ----------------------------------------------------------- */

  /** Subscribe to server-pushed session events. Call once, from the shell. */
  connect() {
    getSocket();

    return onSessionEvent((event) => {
      const { type, sessionId, payload } = event;

      if (type === 'vault-locked') {
        set({ vault: { ...get().vault, unlocked: false }, tabs: [], activeTabId: null });
        get().toast('Vault locked - sessions closed', 'info');
        return;
      }

      if (type === 'prompt') {
        set((s) => ({ prompts: [...s.prompts, { sessionId, ...payload }] }));
        return;
      }

      if (type === 'status') {
        set((s) => ({
          sessions: {
            ...s.sessions,
            [sessionId]: { ...(s.sessions[sessionId] || { sessionId }), ...payload },
          },
        }));
        if (payload.status === 'error') get().toast(payload.message, 'error');
        return;
      }

      if (type === 'shell-close') {
        set((s) => ({
          tabs: s.tabs.map((t) => {
            const pane = t.panes[payload.paneId];
            if (!pane) return t;
            return {
              ...t,
              panes: { ...t.panes, [payload.paneId]: { ...pane, status: 'closed' } },
            };
          }),
        }));
        return;
      }

      if (type === 'closed') {
        set((s) => {
          const sessions = { ...s.sessions };
          delete sessions[sessionId];
          // Panes on this session have no shell any more. Leaving them marked
          // connected left a dead terminal that still accepted keystrokes.
          return {
            sessions,
            tabs: s.tabs.map((t) => {
              const stale = Object.values(t.panes).filter((p) => p.sessionId === sessionId);
              if (stale.length === 0) return t;
              const panes = { ...t.panes };
              for (const pane of stale) {
                panes[pane.paneId] = { ...pane, status: 'closed' };
              }
              return { ...t, panes };
            }),
          };
        });
        return;
      }

      if (type === 'tunnel') {
        const { event: kind, message, meta } = payload;
        if (kind === 'error') get().toast(`Tunnel: ${message}`, 'error');
        if (kind === 'started') get().toast(`Tunnel "${meta.label}" is listening`, 'success');
        set((s) => ({
          sessions: {
            ...s.sessions,
            [sessionId]: {
              ...(s.sessions[sessionId] || { sessionId }),
              forwardsUpdatedAt: Date.now(),
            },
          },
        }));
        return;
      }

      if (type === 'banner') {
        get().toast(String(payload).trim().slice(0, 200), 'info');
      }
    });
  },
}));

export { uid, send };
