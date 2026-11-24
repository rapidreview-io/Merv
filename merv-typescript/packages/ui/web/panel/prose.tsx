/** An agent's answer stays text, with small controls for what the person wants to use. */
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { useDeskCall, whileBusy } from './desk-calls';
import { commands, filePath, inlineTokens, markdown } from '@merv/protocol/markdown';
import { HighlightedCode, MathContent, MermaidContent } from './rich-content';

function Copy({
  text,
  label = 'Copy',
  className = '',
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [status, setStatus] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      data-find-ignore
      className={`prose-action ${className}`}
      title={status || label}
      aria-label={status || label}
      onClick={async () => {
        clearTimeout(timer.current);
        try {
          await navigator.clipboard.writeText(text);
          setStatus('Copied');
        } catch {
          setStatus('Copy failed');
        }
        timer.current = setTimeout(() => setStatus(''), 1500);
      }}
    >
      {status || (
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          aria-hidden="true"
        >
          <rect x="5" y="5" width="8" height="9" rx="1.5" />
          <path d="M3 11H2.5A1.5 1.5 0 0 1 1 9.5v-7A1.5 1.5 0 0 1 2.5 1h6A1.5 1.5 0 0 1 10 2.5V3" />
        </svg>
      )}
    </button>
  );
}

function CodeBlock({ text, language = '' }: { text: string; language?: string }) {
  return (
    <div className="prose-block">
      <div className="prose-code-head">
        <span>{language}</span>
        <Copy text={text} label="Copy code" />
      </div>
      {language === 'mermaid' ? (
        <MermaidContent text={text} />
      ) : (
        <pre className="prose-code">
          <HighlightedCode text={text} language={language} />
        </pre>
      )}
    </div>
  );
}

interface RunResult {
  output: string;
  code: number | null;
  timedOut: boolean;
  truncated: boolean;
}

function Command({
  text,
  command,
  thread,
  terminal,
}: {
  text: string;
  command?: string;
  thread?: string;
  terminal?: (command: string) => Promise<void>;
}) {
  const call = useDeskCall();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RunResult>();
  const [error, setError] = useState('');
  return (
    <div className="prose-command">
      <div className="prose-command-line">
        <pre className="prose-code">
          <HighlightedCode text={text || ' '} language="bash" />
        </pre>
        {command !== undefined && (
          <div className="prose-command-actions" data-find-ignore>
            <Copy text={command} label="Copy command" />
            {thread && (
              <button
                type="button"
                className="prose-action"
                disabled={busy}
                onClick={async () => {
                  setError('');
                  setResult(undefined);
                  await whileBusy(
                    setBusy,
                    () => setError('Couldn’t run command.'),
                    async () => {
                      setResult(
                        await call<RunResult>(`threads/${encodeURIComponent(thread)}/run`, {
                          command,
                        }),
                      );
                    },
                  );
                }}
              >
                {busy ? 'Running…' : 'Run'}
              </button>
            )}
            {terminal && (
              <button
                type="button"
                className="prose-action"
                onClick={async () => {
                  setError('');
                  try {
                    await terminal(command);
                  } catch {
                    setError('Couldn’t send to terminal.');
                  }
                }}
              >
                Run in terminal
              </button>
            )}
          </div>
        )}
      </div>
      {error && (
        <span data-find-ignore className="prose-error" role="alert">
          {error}
        </span>
      )}
      {result && (
        <details data-find-ignore className="prose-output" open>
          <summary>
            {result.timedOut
              ? 'Timed out'
              : result.code === null
                ? 'Stopped'
                : `Exit ${result.code}`}
            {result.truncated ? ' · output capped' : ''}
          </summary>
          <pre className="prose-code">
            {result.output.replace(/\n$/, '').split('\n').slice(-40).join('\n') || 'No output'}
          </pre>
        </details>
      )}
    </div>
  );
}

function FileLink({
  text,
  thread,
  label = text,
}: {
  text: string;
  thread?: string;
  label?: string;
}) {
  const call = useDeskCall();
  const [failed, setFailed] = useState(false);
  const file = filePath(text);
  if (!thread || !file) return <code>{label}</code>;
  return (
    <>
      <button
        type="button"
        className="prose-file"
        title="Open in editor"
        onClick={async () => {
          setFailed(false);
          try {
            await call(`threads/${encodeURIComponent(thread)}/open`, file);
          } catch {
            setFailed(true);
          }
        }}
      >
        <code>{label}</code>
      </button>
      {failed && (
        <span data-find-ignore className="prose-error" role="alert">
          {' '}
          Couldn’t open file.
        </span>
      )}
    </>
  );
}

function inline(text: string, key: string, thread?: string): ReactNode[] {
  return inlineTokens(text).map((token, n) => {
    const id = `${key}${n}`;
    if (token.kind === 'code' || token.kind === 'file')
      return <FileLink key={id} text={token.text} thread={thread} />;
    if (token.kind === 'math') return <MathContent key={id} text={token.text} />;
    if (token.kind === 'strong')
      return <strong key={id}>{inline(token.text, `${id}-`, thread)}</strong>;
    if (token.kind === 'link') {
      return /^https?:\/\//i.test(token.href) ? (
        <a key={id} href={token.href} target="_blank" rel="noreferrer">
          {token.text}
        </a>
      ) : filePath(token.href) ? (
        <FileLink key={id} text={token.href} label={token.text} thread={thread} />
      ) : (
        <span key={id}>{token.text}</span>
      );
    }
    if (token.kind === 'url')
      return (
        <a key={id} href={token.text} target="_blank" rel="noreferrer">
          {token.text}
        </a>
      );
    return token.text;
  });
}

export const Prose = memo(function Prose({
  text,
  thread,
  terminal,
}: {
  text: string;
  thread?: string;
  terminal?: (command: string) => Promise<void>;
}) {
  return (
    <div className="prose">
      <Copy text={text} label="Copy message" className="prose-copy-message" />
      {markdown(text).map((block, i) => {
        if (block.kind === 'code') {
          const lines = commands(block.language, block.text);
          return lines ? (
            <div key={i} className="prose-block">
              <div className="prose-code-head">
                <span>{block.language || 'shell'}</span>
              </div>
              {lines.map((line, n) => (
                <Command
                  key={`${thread}-${n}-${line.text}`}
                  {...line}
                  thread={thread}
                  terminal={terminal}
                />
              ))}
            </div>
          ) : (
            <CodeBlock key={i} text={block.text} language={block.language} />
          );
        }
        if (block.kind === 'math') return <MathContent key={i} text={block.text} display />;
        if (block.kind === 'table')
          return (
            <div key={i} className="prose-table" tabIndex={0} role="region" aria-label="Table">
              <table>
                <thead>
                  <tr>
                    {block.head.map((cell, n) => (
                      <th key={n} scope="col" style={{ textAlign: block.align[n] ?? undefined }}>
                        {inline(cell, `${i}-h${n}-`, thread)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, n) => (
                    <tr key={n}>
                      {row.map((cell, c) => (
                        <td key={c} style={{ textAlign: block.align[c] ?? undefined }}>
                          {inline(cell, `${i}-${n}-${c}-`, thread)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        if (block.kind === 'list') {
          const items = block.items.map((item, n) => (
            <li key={n}>{inline(item, `${i}-${n}-`, thread)}</li>
          ));
          return block.ordered ? (
            <ol key={i} className="prose-list" start={block.start}>
              {items}
            </ol>
          ) : (
            <ul key={i} className="prose-list">
              {items}
            </ul>
          );
        }
        return (
          <p key={i} className={block.kind === 'heading' ? 'prose-heading' : undefined}>
            {inline(block.text, `${i}-`, thread)}
          </p>
        );
      })}
    </div>
  );
});
