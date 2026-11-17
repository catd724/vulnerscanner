'use client';

import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/lib/store';
import { SparkIcon, SendIcon, TrashIcon, TerminalIcon } from './Icons';

const MODES = [
  { key: 'chat', label: 'Ask' },
  { key: 'command', label: 'Command' },
  { key: 'diagnose', label: 'Diagnose' },
  { key: 'vuln-analyze', label: 'Analyze' },
];

export default function AiSidebar() {
  const messages = useStore((s) => s.aiMessages);
  const busy = useStore((s) => s.aiBusy);
  const addAiMessage = useStore((s) => s.addAiMessage);
  const clearAiMessages = useStore((s) => s.clearAiMessages);
  const setAiBusy = useStore((s) => s.setAiBusy);
  const sendToActivePane = useStore((s) => s.sendToActivePane);
  const activePaneContext = useStore((s) => s.getActivePaneContext);

  const [mode, setMode] = useState(() => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    return lastUser?.mode && MODES.some((m) => m.key === lastUser.mode) ? lastUser.mode : 'chat';
  });
  const [query, setQuery] = useState('');
  const [shareContext, setShareContext] = useState(true);
  const [error, setError] = useState(null);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const autoSentRef = useRef(new Set());

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy, error]);

  const runRequest = async (userText, requestMode, contextOverride) => {
    setError(null);
    setAiBusy(true);

    try {
      const context = contextOverride ?? (shareContext ? activePaneContext() : '');
      const response = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: userText, context, mode: requestMode }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Request failed');

      addAiMessage({
        role: 'assistant',
        mode: requestMode,
        content:
          data.command || data.fixCommand || data.analysis || data.answer || data.explanation || '',
        command: data.command,
        fixCommand: data.fixCommand,
        explanation: data.explanation,
        analysis: data.analysis,
        model: data.model,
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setAiBusy(false);
    }
  };

  // Auto-send queued messages pushed by TerminalPane shortcuts.
  useEffect(() => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser?.autoSend && !autoSentRef.current.has(lastUser.id) && !busy) {
      autoSentRef.current.add(lastUser.id);
      runRequest(lastUser.content, lastUser.mode, lastUser.context);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, busy]);

  const ask = async () => {
    if (!query.trim() || busy) return;

    const userText = query.trim();
    const context = shareContext ? activePaneContext() : '';
    setQuery('');

    addAiMessage({
      role: 'user',
      mode,
      content: userText,
      context,
    });

    await runRequest(userText, mode, context);
  };

  const insertAtPrompt = (text) => {
    sendToActivePane(text);
  };

  const captureContext = () => {
    const context = activePaneContext();
    if (!context) return;
    setQuery((q) => (q ? `${q}\n\n${context}` : context));
    inputRef.current?.focus();
  };

  return (
    <>
      <header className="panel-header">
        <h2 className="panel-title">AI Assistant</h2>
        <span className="panel-header-actions">
          <button
            className="icon-btn"
            title="Capture terminal context"
            onClick={captureContext}
          >
            <TerminalIcon size={14} />
          </button>
          <button
            className="icon-btn icon-btn-danger"
            title="Clear conversation"
            onClick={clearAiMessages}
          >
            <TrashIcon size={14} />
          </button>
        </span>
      </header>

      <div className="ai-mode-bar">
        {MODES.map((m) => (
          <button
            key={m.key}
            className={`ai-mode-btn ${mode === m.key ? 'is-active' : ''}`}
            onClick={() => setMode(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="ai-messages">
        {messages.length === 0 && (
          <div className="empty-state">
            <SparkIcon size={32} />
            <p className="empty-title">Ask the AI</p>
            <p className="empty-detail">
              Generate commands, diagnose errors, analyze scans, or ask questions. Output appears
              here instead of in the terminal.
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`ai-message ai-message-${msg.role}`}>
            <div className="ai-message-meta">
              <span className="ai-message-role">
                {msg.role === 'user' ? 'You' : 'AI'}
              </span>
              {msg.mode && (
                <span className="ai-message-mode">{msg.mode}</span>
              )}
              {msg.model && (
                <span className="ai-message-model">{msg.model}</span>
              )}
            </div>

            {msg.role === 'user' && msg.context && (
              <details className="ai-context-details">
                <summary>Terminal context sent</summary>
                <pre className="ai-context-pre">{msg.context}</pre>
              </details>
            )}

            <div className="ai-message-body">
              {msg.mode === 'command' && msg.command ? (
                <div className="ai-command-block">
                  <pre className="ai-command-code">{msg.command}</pre>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => insertAtPrompt(msg.command)}
                  >
                    Insert at prompt
                  </button>
                </div>
              ) : msg.mode === 'diagnose' && (msg.explanation || msg.fixCommand) ? (
                <div className="ai-diagnose-block">
                  <p className="ai-diagnose-text">{msg.explanation}</p>
                  {msg.fixCommand && (
                    <div className="ai-command-block">
                      <pre className="ai-command-code">{msg.fixCommand}</pre>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => insertAtPrompt(msg.fixCommand)}
                      >
                        Insert fix
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="ai-prose">{msg.content}</div>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div className="ai-message ai-message-assistant ai-message-busy">
            <div className="ai-message-meta">
              <span className="ai-message-role">AI</span>
              <span className="ai-message-mode">{mode}</span>
            </div>
            <div className="ai-busy-dots">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}

        {error && (
          <div className="ai-message ai-message-error">
            <p>{error}</p>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <div className="ai-input-area">
        <label className="ai-context-toggle">
          <input
            type="checkbox"
            checked={shareContext}
            onChange={(e) => setShareContext(e.target.checked)}
          />
          Send terminal context
        </label>
        <div className="ai-input-row">
          <input
            ref={inputRef}
            className="input input-sm"
            placeholder={
              mode === 'command'
                ? 'e.g. show largest files under /var'
                : mode === 'diagnose'
                ? 'Optional hint...'
                : mode === 'vuln-analyze'
                ? 'Paste scan output or ask about a scan'
                : 'Ask anything...'
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                ask();
              }
            }}
          />
          <button className="btn btn-primary btn-sm" onClick={ask} disabled={busy || !query.trim()}>
            <SendIcon size={14} />
          </button>
        </div>
      </div>
    </>
  );
}
