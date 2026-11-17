'use client';

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '@/lib/store';
import { call } from '@/lib/socket';

/**
 * terminal.ai - tunnel control for the active session.
 *
 * Saved rules for the host appear here and start against the session that is
 * already open, so a forward costs no extra authentication. Ad-hoc tunnels can
 * be started without saving a rule first.
 */

export default function TunnelBar({ tab }) {
  const pane = tab.panes[tab.activePaneId];
  const sessionId = pane?.sessionId;

  const forwards = useStore((s) => s.forwards);
  const sessions = useStore((s) => s.sessions);
  const openEditor = useStore((s) => s.openEditor);
  const toast = useStore((s) => s.toast);

  const [running, setRunning] = useState([]);
  const [busyKey, setBusyKey] = useState(null);

  const saved = forwards.filter((f) => f.hostId === pane?.hostId);

  // Bumped by the store whenever the server reports a tunnel event, which is
  // what re-triggers the refresh below. Extracted so the dependency array
  // stays statically checkable.
  const forwardsUpdatedAt = sessionId ? sessions[sessionId]?.forwardsUpdatedAt : null;

  const refreshTunnels = useCallback(async () => {
    if (!sessionId) return;
    try {
      setRunning(await call('tunnel:list', { sessionId }));
    } catch {
      setRunning([]);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return undefined;
    let cancelled = false;

    call('tunnel:list', { sessionId })
      .then((list) => {
        if (!cancelled) setRunning(list);
      })
      .catch(() => {
        if (!cancelled) setRunning([]);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, forwardsUpdatedAt]);

  if (!sessionId) return null;

  const start = async (forward) => {
    setBusyKey(`saved-${forward.id}`);
    try {
      await call('tunnel:start', { sessionId, forwardId: forward.id });
      await refreshTunnels();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const stop = async (forwardKey) => {
    setBusyKey(forwardKey);
    try {
      await call('tunnel:stop', { sessionId, forwardKey });
      await refreshTunnels();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const isRunning = (forward) => running.find((r) => r.forwardId === forward.id);

  return (
    <div className="tunnel-bar">
      <span className="tunnel-bar-label">Tunnels</span>

      <div className="tunnel-chips">
        {saved.map((forward) => {
          const live = isRunning(forward);
          const key = `saved-${forward.id}`;
          return (
            <button
              key={forward.id}
              className={`tunnel-chip ${live ? 'is-running' : ''}`}
              disabled={busyKey === key}
              onClick={() => (live ? stop(live.forwardKey) : start(forward))}
              title={
                forward.type === 'dynamic'
                  ? `SOCKS5 on ${forward.listenHost}:${forward.listenPort}`
                  : `${forward.listenHost}:${forward.listenPort} → ${forward.destHost}:${forward.destPort}`
              }
            >
              <span className={`badge badge-${forward.type}`}>{forward.type[0].toUpperCase()}</span>
              {forward.label}
              <span className="tunnel-chip-state">
                {busyKey === key ? '...' : live ? `● ${live.connections}` : '○'}
              </span>
            </button>
          );
        })}

        {running
          .filter((r) => !r.forwardId)
          .map((r) => (
            <button
              key={r.forwardKey}
              className="tunnel-chip is-running"
              onClick={() => stop(r.forwardKey)}
              title="Ad-hoc tunnel - click to stop"
            >
              <span className={`badge badge-${r.type}`}>{r.type[0].toUpperCase()}</span>
              {r.label}
              <span className="tunnel-chip-state">● {r.connections}</span>
            </button>
          ))}

        {saved.length === 0 && running.length === 0 && (
          <span className="tunnel-empty">No rules for this host</span>
        )}
      </div>

      <button
        className="btn btn-ghost btn-sm"
        onClick={() => openEditor({ kind: 'forward', data: { hostId: pane.hostId } })}
      >
        Add rule
      </button>
    </div>
  );
}
