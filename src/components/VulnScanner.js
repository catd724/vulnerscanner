'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useStore } from '@/lib/store';
import { send } from '@/lib/socket';
import {
  ScannerIcon,
  TrashIcon,
  SparkIcon,
  PlayIcon,
  CloseIcon,
  RefreshIcon,
} from './Icons';

const SCAN_TYPES = [
  {
    key: 'services',
    label: 'Services status',
    flag: '--services',
    desc: 'List running, failed, and stopped systemd services.',
  },
  {
    key: 'docker',
    label: 'Docker status',
    flag: '--docker',
    desc: 'Check Docker daemon, containers, and image vulnerabilities via OSV.',
  },
  {
    key: 'pm2',
    label: 'PM2 status',
    flag: '--pm2',
    desc: 'List PM2 processes, uptime, and restart counts.',
  },
  {
    key: 'library_vulns',
    label: 'Library vulnerabilities',
    flag: '--library-vulns',
    desc: 'Enumerate installed packages and query OSV for known CVEs.',
  },
  {
    key: 'full',
    label: 'Full scan',
    flag: '--full',
    desc: 'Run all checks and produce one combined JSON report.',
  },
];

const DEFAULT_SCRIPT_URL =
  typeof window !== 'undefined'
    ? `${window.location.origin}/scripts/vulnscan.sh`
    : 'http://127.0.0.1:3000/scripts/vulnscan.sh';

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function getSeverityColor(sev) {
  const s = String(sev).toUpperCase();
  if (s === 'CRITICAL') return '#ff3366';
  if (s === 'HIGH') return '#ff6b6b';
  if (s === 'MEDIUM') return '#ffbd2e';
  if (s === 'LOW') return '#00ff87';
  return '#9ca3af';
}

function countVulns(scan) {
  const summary = scan?.summary || {};
  return {
    critical: summary.critical || 0,
    high: summary.high || 0,
    medium: summary.medium || 0,
    low: summary.low || 0,
    unknown: summary.unknown || 0,
  };
}

export default function VulnScanner() {
  const scans = useStore((s) => s.scans);
  const activeScanId = useStore((s) => s.activeScanId);
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const addScan = useStore((s) => s.addScan);
  const setActiveScan = useStore((s) => s.setActiveScan);
  const deleteScan = useStore((s) => s.deleteScan);
  const clearScans = useStore((s) => s.clearScans);
  const toast = useStore((s) => s.toast);
  const aiEnabled = useStore((s) => s.settings?.aiEnabled);

  const [scriptUrl, setScriptUrl] = useState(() => {
    try {
      return localStorage.getItem('vuln-scanner-url') || DEFAULT_SCRIPT_URL;
    } catch {
      return DEFAULT_SCRIPT_URL;
    }
  });
  const [running, setRunning] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);

  // Persist script URL preference.
  useEffect(() => {
    try {
      localStorage.setItem('vuln-scanner-url', scriptUrl);
    } catch {
      /* ignore */
    }
  }, [scriptUrl]);

  const activeSession = useMemo(() => {
    if (!activeTabId) return null;
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return null;
    const pane = tab.panes[tab.activePaneId];
    if (!pane || pane.status !== 'connected' || !pane.sessionId) return null;
    return { sessionId: pane.sessionId, paneId: pane.paneId, label: pane.label };
  }, [tabs, activeTabId]);

  const activeScan = useMemo(
    () => scans.find((s) => s.id === activeScanId) || scans[0] || null,
    [scans, activeScanId]
  );

  const runScan = useCallback(
    async (type) => {
      if (!activeSession) {
        toast('Open a terminal session first', 'error');
        return;
      }
      if (scriptUrl.includes('<your-org>')) {
        toast('Set the script URL in the Scanner panel first', 'error');
        return;
      }

      setRunning(type.key);

      // Run via process substitution so nothing is written to disk on the target server.
      const command = `bash <(curl -sL "${scriptUrl}") ${type.flag}\n`;

      send('shell:input', {
        sessionId: activeSession.sessionId,
        paneId: activeSession.paneId,
        data: command,
      });

      // The scan output streams directly to the terminal. Nothing is saved on the server.
      setTimeout(() => setRunning(null), 1500);

      // Keep a lightweight history entry so the user knows a scan was launched.
      addScan({
        id: uid(),
        type: type.key,
        typeLabel: type.label,
        host: activeSession.label,
        sessionId: activeSession.sessionId,
        paneId: activeSession.paneId,
        timestamp: new Date().toISOString(),
        result: {
          scan_type: type.key,
          timestamp: new Date().toISOString(),
          host: activeSession.label,
          ok: true,
          note: 'Output streamed to terminal. Nothing saved on the remote server.',
        },
      });

      toast('Scan command sent to terminal', 'success');
    },
    [activeSession, scriptUrl, addScan, toast]
  );

  const analyzeWithAi = useCallback(async () => {
    if (!activeScan) return;
    if (!aiEnabled) {
      toast('Enable AI features in the sidebar first', 'error');
      return;
    }
    setAiBusy(true);
    try {
      const response = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'vuln-analyze',
          context: JSON.stringify(activeScan.result, null, 2).slice(0, 6000),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'AI request failed');

      const analysisScan = {
        id: uid(),
        type: 'ai_analysis',
        typeLabel: 'AI Analysis',
        host: activeScan.host,
        sessionId: activeScan.sessionId,
        paneId: activeScan.paneId,
        timestamp: new Date().toISOString(),
        parentScanId: activeScan.id,
        result: {
          scan_type: 'ai_analysis',
          timestamp: new Date().toISOString(),
          host: activeScan.host,
          ok: true,
          analysis: data.analysis,
        },
      };
      addScan(analysisScan);
      toast('AI analysis complete', 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setAiBusy(false);
    }
  }, [activeScan, aiEnabled, addScan, toast]);

  const copyCommand = useCallback(
    (type) => {
      if (scriptUrl.includes('<your-org>')) {
        toast('Set the script URL first', 'error');
        return;
      }
      const cmd = `bash <(curl -sL "${scriptUrl}") ${type.flag}`;
      navigator.clipboard.writeText(cmd).then(
        () => toast('Command copied to clipboard', 'success'),
        () => toast('Failed to copy command', 'error')
      );
    },
    [scriptUrl, toast]
  );

  return (
    <div className="vuln-scanner">
      <header className="panel-header">
        <h2 className="panel-title">
          <ScannerIcon size={18} /> Vulnerability Scanner
        </h2>
      </header>

      <div className="vuln-scanner-body">
        <div className="vuln-section">
          <label className="vuln-label">Script URL</label>
          <input
            className="input input-sm"
            value={scriptUrl}
            onChange={(e) => setScriptUrl(e.target.value)}
            placeholder="https://raw.githubusercontent.com/.../vulnscan.sh"
          />
          <p className="vuln-hint">
            Defaults to the local scripts folder served by this app. You can still point it at a GitHub raw URL.
          </p>
        </div>

        <div className="vuln-section">
          <label className="vuln-label">Target session</label>
          {activeSession ? (
            <span className="vuln-session">
              <span className="status-marker is-live" /> {activeSession.label}
            </span>
          ) : (
            <span className="vuln-session vuln-session-none">
              No active terminal session
            </span>
          )}
        </div>

        <div className="vuln-section">
          <label className="vuln-label">Run check</label>
          <div className="vuln-grid">
            {SCAN_TYPES.map((type) => (
              <div key={type.key} className="vuln-card">
                <div className="vuln-card-title">{type.label}</div>
                <p className="vuln-card-desc">{type.desc}</p>
                <div className="vuln-card-actions">
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={!activeSession || running === type.key}
                    onClick={() => runScan(type)}
                  >
                    {running === type.key ? (
                      <>
                        <RefreshIcon size={12} className="spin" /> Running…
                      </>
                    ) : (
                      <>
                        <PlayIcon size={12} /> Run
                      </>
                    )}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => copyCommand(type)}
                    title="Copy manual command"
                  >
                    Copy
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="vuln-section">
          <div className="vuln-history-header">
            <label className="vuln-label">Scan history ({scans.length})</label>
            {scans.length > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={clearScans}>
                <TrashIcon size={12} /> Clear
              </button>
            )}
          </div>

          {scans.length === 0 && (
            <p className="vuln-empty">No scans yet. Run a check on the active session.</p>
          )}

          {scans.length > 0 && (
            <div className="vuln-history">
              {scans.map((scan) => {
                const counts = countVulns(scan.result);
                const isActive = activeScan?.id === scan.id;
                const date = new Date(scan.timestamp).toLocaleString();
                return (
                  <button
                    key={scan.id}
                    className={`vuln-history-item ${isActive ? 'is-active' : ''}`}
                    onClick={() => setActiveScan(scan.id)}
                  >
                    <span className="vuln-history-title">{scan.typeLabel}</span>
                    <span className="vuln-history-meta">{scan.host}</span>
                    <span className="vuln-history-meta">{date}</span>
                    <span className="vuln-history-badges">
                      {counts.critical > 0 && (
                        <span className="badge badge-critical">{counts.critical} C</span>
                      )}
                      {counts.high > 0 && (
                        <span className="badge badge-high">{counts.high} H</span>
                      )}
                      {counts.medium > 0 && (
                        <span className="badge badge-medium">{counts.medium} M</span>
                      )}
                      {counts.low > 0 && (
                        <span className="badge badge-low">{counts.low} L</span>
                      )}
                      {!counts.critical && !counts.high && !counts.medium && !counts.low && (
                        <span className="badge badge-ok">OK</span>
                      )}
                    </span>
                    <span
                      className="icon-btn vuln-history-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteScan(scan.id);
                      }}
                      title="Delete scan"
                    >
                      <CloseIcon size={12} />
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {activeScan && (
          <div className="vuln-section vuln-result">
            <div className="vuln-result-header">
              <h3 className="vuln-result-title">
                {activeScan.typeLabel} — {activeScan.host}
              </h3>
              {activeScan.type !== 'ai_analysis' && aiEnabled && (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={analyzeWithAi}
                  disabled={aiBusy}
                >
                  {aiBusy ? (
                    'Analyzing…'
                  ) : (
                    <>
                      <SparkIcon size={12} /> Analyze with AI
                    </>
                  )}
                </button>
              )}
            </div>
            <ScanResultView scan={activeScan} />
          </div>
        )}
      </div>
    </div>
  );
}

function ScanResultView({ scan }) {
  const result = scan.result || {};

  if (scan.type === 'ai_analysis') {
    return (
      <div className="vuln-ai-analysis">
        <pre>{result.analysis}</pre>
      </div>
    );
  }

  if (result.note) {
    return (
      <div className="vuln-note">
        <p>{result.note}</p>
        <p className="vuln-hint">
          Switch to the active terminal pane to see the full scan output.
        </p>
      </div>
    );
  }

  if (!result.ok) {
    return (
      <div className="vuln-error">
        <p>Scan failed: {result.error || 'Unknown error'}</p>
        {result.raw && (
          <pre className="vuln-raw">{String(result.raw).slice(0, 2000)}</pre>
        )}
      </div>
    );
  }

  const summary = result.summary || {};
  const details = result.details || {};

  return (
    <div className="vuln-result-body">
      <div className="vuln-summary">
        {Object.entries(summary).map(([key, value]) => (
          <div key={key} className="vuln-summary-item">
            <span className="vuln-summary-key">{key.replace(/_/g, ' ')}</span>
            <span className="vuln-summary-value">{String(value)}</span>
          </div>
        ))}
      </div>

      {result.scan_type === 'library_vulns' && Array.isArray(details) && (
        <div className="vuln-list">
          <h4>Vulnerable packages</h4>
          {details.filter((p) => p.vulnerability_count > 0).length === 0 && (
            <p>No vulnerable packages found.</p>
          )}
          {details
            .filter((p) => p.vulnerability_count > 0)
            .map((pkg) => (
              <div key={pkg.name} className="vuln-package">
                <div className="vuln-package-header">
                  <span className="vuln-package-name">{pkg.name}</span>
                  <span className="vuln-package-version">{pkg.version}</span>
                  <span className="vuln-package-eco">{pkg.ecosystem}</span>
                </div>
                <div className="vuln-cves">
                  {pkg.vulnerabilities.map((v) => (
                    <span
                      key={v.id}
                      className="vuln-cve"
                      style={{ borderColor: getSeverityColor(v.severity) }}
                      title={v.summary}
                    >
                      {v.id}{' '}
                      <span style={{ color: getSeverityColor(v.severity) }}>
                        {v.severity}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}

      {result.scan_type === 'docker' && details.images && (
        <div className="vuln-list">
          <h4>Docker images</h4>
          {details.images.map((img) => (
            <div key={img.ID || `${img.Repository}:${img.Tag}`} className="vuln-image">
              <div className="vuln-image-header">
                <span className="vuln-image-repo">
                  {img.Repository}:{img.Tag}
                </span>
                <span className="vuln-image-id">{img.ID}</span>
                <span className="vuln-image-size">{img.Size}</span>
              </div>
              {Array.isArray(img.vulnerabilities) && img.vulnerabilities.length > 0 && (
                <div className="vuln-cves">
                  {img.vulnerabilities.map((v) => (
                    <span
                      key={v.id}
                      className="vuln-cve"
                      style={{ borderColor: getSeverityColor(v.severity) }}
                      title={v.summary}
                    >
                      {v.id}{' '}
                      <span style={{ color: getSeverityColor(v.severity) }}>
                        {v.severity}
                      </span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {(result.scan_type === 'services' || result.scan_type === 'pm2') && Array.isArray(details) && (
        <div className="vuln-list">
          <h4>Items ({details.length})</h4>
          {details.slice(0, 50).map((item, idx) => (
            <pre key={idx} className="vuln-raw-line">
              {JSON.stringify(item, null, 2)}
            </pre>
          ))}
          {details.length > 50 && <p>…and {details.length - 50} more</p>}
        </div>
      )}

      {result.scan_type === 'full' && (
        <div className="vuln-list">
          <h4>Full scan results</h4>
          <pre className="vuln-raw">{JSON.stringify(result.results, null, 2)}</pre>
        </div>
      )}

      <details className="vuln-raw-details">
        <summary>Raw JSON</summary>
        <pre className="vuln-raw">{JSON.stringify(result, null, 2)}</pre>
      </details>
    </div>
  );
}
