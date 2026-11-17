'use client';

import { useMemo, useState } from 'react';
import { useStore } from '@/lib/store';
import { call } from '@/lib/socket';
import { Modal } from './Editors';

/**
 * terminal.ai - broadcast a snippet to one or many live panes.
 *
 * Targets are panes, not hosts, so a split view showing two shells on the same
 * server can be driven independently - and a rollout command can be fired at
 * every open session in one action.
 */

export default function SnippetRunner() {
  const open = useStore((s) => s.snippetRunnerOpen);
  const toggle = useStore((s) => s.toggleSnippetRunner);
  const snippets = useStore((s) => s.snippets);
  const tabs = useStore((s) => s.tabs);
  const toast = useStore((s) => s.toast);

  const [selectedSnippetId, setSelectedSnippetId] = useState('');
  const [body, setBody] = useState('');
  const [targets, setTargets] = useState({});
  const [busy, setBusy] = useState(false);

  // Every pane that currently has a live shell.
  const panes = useMemo(
    () =>
      tabs.flatMap((tab) =>
        Object.values(tab.panes)
          .filter((pane) => pane.sessionId && pane.status === 'connected')
          .map((pane) => ({ ...pane, tabId: tab.id, tabTitle: tab.title }))
      ),
    [tabs]
  );

  if (!open) return null;

  const selectedCount = Object.values(targets).filter(Boolean).length;

  const pickSnippet = (id) => {
    setSelectedSnippetId(id);
    const snippet = snippets.find((s) => String(s.id) === String(id));
    if (snippet) setBody(snippet.body);
  };

  const run = async () => {
    const chosen = panes.filter((p) => targets[p.paneId]);
    if (chosen.length === 0) {
      toast('Select at least one pane', 'error');
      return;
    }
    if (!body.trim()) {
      toast('Nothing to run', 'error');
      return;
    }

    setBusy(true);
    try {
      const result = await call('snippet:run', {
        targets: chosen.map((p) => ({ sessionId: p.sessionId, paneId: p.paneId })),
        body,
      });
      const failed = result.results.filter((r) => !r.ok);
      toast(
        failed.length
          ? `Sent to ${result.delivered} pane(s); ${failed.length} failed`
          : `Sent to ${result.delivered} pane(s)`,
        failed.length ? 'error' : 'success'
      );
      toggle(false);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title="Run a snippet"
      onClose={() => toggle(false)}
      footer={
        <>
          <span className="modal-hint">
            {selectedCount} of {panes.length} pane{panes.length === 1 ? '' : 's'} selected
          </span>
          <button className="btn btn-ghost" onClick={() => toggle(false)}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={run} disabled={busy}>
            {busy ? 'Sending...' : 'Run'}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Saved snippet</span>
        <select
          className="input"
          value={selectedSnippetId}
          onChange={(e) => pickSnippet(e.target.value)}
        >
          <option value="">Write a one-off command</option>
          {snippets.map((snippet) => (
            <option key={snippet.id} value={snippet.id}>
              {snippet.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field-label">Command</span>
        <textarea
          className="input textarea textarea-code"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          spellCheck={false}
          placeholder="systemctl status nginx"
        />
      </label>

      <div className="target-list">
        <div className="target-list-header">
          <span className="field-label">Targets</span>
          <span className="target-list-actions">
            <button
              className="btn btn-ghost btn-sm"
              onClick={() =>
                setTargets(Object.fromEntries(panes.map((p) => [p.paneId, true])))
              }
            >
              All
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setTargets({})}>
              None
            </button>
          </span>
        </div>

        {panes.length === 0 && <p className="panel-note">No connected panes.</p>}

        {panes.map((pane) => (
          <label key={pane.paneId} className="target-row">
            <input
              type="checkbox"
              checked={!!targets[pane.paneId]}
              onChange={(e) =>
                setTargets((t) => ({ ...t, [pane.paneId]: e.target.checked }))
              }
            />
            <span className="target-label">{pane.label}</span>
            <span className="target-sub">{pane.tabTitle}</span>
          </label>
        ))}
      </div>

      <p className="panel-note">
        The command is typed into each pane and executed there. Review it before running
        anything destructive across multiple servers.
      </p>
    </Modal>
  );
}
