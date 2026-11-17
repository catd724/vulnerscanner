'use client';

import { useState } from 'react';
import { useStore } from '@/lib/store';

/**
 * terminal.ai - blocking SSH prompts and transient notices.
 *
 * The host-key dialog is the reason connections are safe now: the previous
 * build accepted any key silently, so a man in the middle was undetectable.
 * The handshake waits here until the user answers.
 */

function HostKeyPrompt({ prompt, onAnswer }) {
  return (
    <div className="modal-backdrop">
      <div className={`modal modal-prompt ${prompt.changed ? 'modal-danger' : ''}`} role="alertdialog">
        <header className="modal-header">
          <h2>{prompt.changed ? 'Host key has changed' : 'Verify host key'}</h2>
        </header>

        <div className="modal-body">
          {prompt.changed ? (
            <p className="prompt-danger">
              The key offered by {prompt.host}:{prompt.port} does not match the one you trusted.
              This happens after a legitimate server rebuild - or when someone is intercepting
              the connection. Do not continue unless you know which.
            </p>
          ) : (
            <p className="prompt-text">
              You have not connected to {prompt.host}:{prompt.port} before. Check that this
              fingerprint matches the server.
            </p>
          )}

          <dl className="fingerprint-block">
            <dt>Type</dt>
            <dd>{prompt.keyType}</dd>
            <dt>Fingerprint</dt>
            <dd>
              <code>{prompt.fingerprint}</code>
            </dd>
            {prompt.knownFingerprint && (
              <>
                <dt>Previously trusted</dt>
                <dd>
                  <code>{prompt.knownFingerprint}</code>
                </dd>
              </>
            )}
          </dl>

          <p className="panel-note">
            Compare with <code>ssh-keyscan -t {prompt.keyType} {prompt.host}</code> run somewhere
            you trust, or with the fingerprint your provider published.
          </p>
        </div>

        <footer className="modal-footer">
          <button className="btn btn-ghost" onClick={() => onAnswer({ decision: 'reject' })}>
            Cancel
          </button>
          <button className="btn btn-ghost" onClick={() => onAnswer({ decision: 'once' })}>
            Accept once
          </button>
          <button
            className={`btn ${prompt.changed ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => onAnswer({ decision: 'accept' })}
          >
            Trust and save
          </button>
        </footer>
      </div>
    </div>
  );
}

function KeyboardInteractivePrompt({ prompt, onAnswer }) {
  const [responses, setResponses] = useState(prompt.prompts.map(() => ''));

  return (
    <div className="modal-backdrop">
      <form
        className="modal modal-prompt"
        onSubmit={(e) => {
          e.preventDefault();
          onAnswer({ responses });
        }}
      >
        <header className="modal-header">
          <h2>{prompt.name || 'Authentication required'}</h2>
        </header>

        <div className="modal-body">
          {prompt.instructions && <p className="prompt-text">{prompt.instructions}</p>}
          {prompt.prompts.map((item, index) => (
            <label className="field" key={index}>
              <span className="field-label">{item.prompt}</span>
              <input
                className="input"
                type={item.echo ? 'text' : 'password'}
                value={responses[index]}
                autoFocus={index === 0}
                onChange={(e) => {
                  const next = [...responses];
                  next[index] = e.target.value;
                  setResponses(next);
                }}
              />
            </label>
          ))}
        </div>

        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={() => onAnswer({ responses: [] })}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Continue
          </button>
        </footer>
      </form>
    </div>
  );
}

export function Prompts() {
  const prompts = useStore((s) => s.prompts);
  const answerPrompt = useStore((s) => s.answerPrompt);

  // One at a time: an SSH handshake blocks on exactly one question.
  const prompt = prompts[0];
  if (!prompt) return null;

  const onAnswer = (answer) => answerPrompt(prompt, answer);

  if (prompt.kind === 'hostkey') return <HostKeyPrompt prompt={prompt} onAnswer={onAnswer} />;
  if (prompt.kind === 'keyboard-interactive') {
    // Keyed by promptId so the next challenge gets fresh inputs: without it
    // React reuses the instance and the previous answers stay in the fields.
    return (
      <KeyboardInteractivePrompt key={prompt.promptId} prompt={prompt} onAnswer={onAnswer} />
    );
  }
  return null;
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismissToast = useStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          className={`toast toast-${toast.kind}`}
          onClick={() => dismissToast(toast.id)}
        >
          {toast.message}
        </button>
      ))}
    </div>
  );
}
