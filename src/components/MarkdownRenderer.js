'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useStore } from '@/lib/store';
import { PlayIcon, TerminalIcon } from './Icons';

function CodeBlock({ language, children }) {
  const code = String(children).replace(/\n$/, '');
  const sendToActivePane = useStore((s) => s.sendToActivePane);

  if (!code.trim()) return null;

  const insert = () => sendToActivePane(code);
  const run = () => sendToActivePane(`${code}\n`);

  return (
    <div className="ai-code-block">
      <div className="ai-code-header">
        <span className="ai-code-lang">{language || 'bash'}</span>
        <span className="ai-code-actions">
          <button className="icon-btn" title="Insert at prompt" onClick={insert}>
            <TerminalIcon size={13} />
          </button>
          <button className="icon-btn" title="Run in terminal" onClick={run}>
            <PlayIcon size={13} />
          </button>
        </span>
      </div>
      <pre className="ai-code-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export default function MarkdownRenderer({ children }) {
  const sendToActivePane = useStore((s) => s.sendToActivePane);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ node, inline, className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '');
          const language = match ? match[1] : '';
          if (!inline && language) {
            return <CodeBlock language={language}>{children}</CodeBlock>;
          }
          if (!inline && String(children).includes('\n')) {
            return <CodeBlock language="">{children}</CodeBlock>;
          }
          return (
            <code className="ai-inline-code" {...props}>
              {children}
            </code>
          );
        },
        pre({ children }) {
          return <>{children}</>;
        },
        a({ href, children }) {
          return (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          );
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
