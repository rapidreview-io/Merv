import { useLayoutEffect, useMemo, useRef, useState } from 'react';

/** Output stays inside its step, with the latest line in view while it runs. */
export function CommandOutput({
  text,
  running,
  exitCode,
}: {
  text: string;
  running: boolean;
  exitCode?: number;
}) {
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState('Copy');
  const scroller = useRef<HTMLPreElement>(null);
  const shown = useMemo(
    () =>
      search
        ? text
            .split('\n')
            .filter((line) => line.toLowerCase().includes(search.toLowerCase()))
            .join('\n')
        : text,
    [text, search],
  );

  useLayoutEffect(() => {
    if (running && !search && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [shown, running, search]);

  return (
    <div className="command-output">
      <div className="command-output-head">
        <input
          type="search"
          aria-label="Search command output"
          placeholder="Search output"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {exitCode !== undefined && exitCode !== 0 && (
          <span className="command-exit-failed">Exit {exitCode}</span>
        )}
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied('Copied');
            } catch {
              setCopied('Copy failed');
            }
          }}
          onBlur={() => setCopied('Copy')}
        >
          {copied}
        </button>
      </div>
      <pre ref={scroller} tabIndex={0}>
        {shown || (search ? 'No matching lines' : running ? 'Waiting for output…' : 'No output')}
      </pre>
    </div>
  );
}
