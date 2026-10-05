import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { CodeHead } from './code-block';
import { SourceIcon } from './icons';
import { onWorn, worn } from './theme';

/**
 * A Mermaid diagram, drawn from its source. Mermaid loads the first time a diagram
 * is shown and draws in the theme the page wears, again whenever that changes. It
 * runs at its strict security level, so a diagram's labels are text and its
 * clicks bind nothing. A source Mermaid cannot read is shown as written, with the
 * first line of Mermaid's complaint under it: a broken diagram is never a blank.
 */

/** Where Mermaid comes from: a seam for tests, which cannot lay a diagram out. */
export const mermaidLoader = { load: () => import('mermaid').then((module) => module.default) };

/** Every drawing needs an element id of its own, and two diagrams may draw at once. */
let drawings = 0;
/** A source still being written is drawn once it has rested this long. */
const REST_MS = 150;

interface Drawn {
  svg?: string;
  /** The natural width Mermaid gave the diagram, so a wide one scrolls rather than shrinks. */
  width?: string;
  error?: string;
}

export function Mermaid({ source }: { source: string }) {
  const theme = useSyncExternalStore(onWorn, worn);
  const [drawn, setDrawn] = useState<Drawn>();
  const [raw, setRaw] = useState(false);
  useEffect(() => {
    let live = true;
    const id = `mermaid-${++drawings}`;
    const timer = setTimeout(async () => {
      try {
        const mermaid = await mermaidLoader.load();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: theme === 'dark' ? 'dark' : 'default',
        });
        const { svg } = await mermaid.render(id, source);
        const width = /max-width:\s*([\d.]+px)/.exec(svg)?.[1];
        if (live) setDrawn({ svg, width });
      } catch (error) {
        // What Mermaid left in the page while it failed goes with the failure.
        for (const left of [id, `d${id}`]) document.getElementById(left)?.remove();
        const said = error instanceof Error ? error.message : String(error);
        if (live) setDrawn({ error: said.split('\n').find((line) => line.trim()) ?? 'Unreadable' });
      }
    }, REST_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [source, theme]);
  const showSource = raw || !!drawn?.error || !drawn?.svg;
  return (
    <div className="code-block mermaid">
      <CodeHead label="Mermaid" copy={source}>
        {drawn?.svg && (
          <button
            type="button"
            className="btn-icon btn-icon--inline"
            aria-pressed={raw}
            aria-label="View source"
            title="View source"
            onClick={() => setRaw(!raw)}
          >
            <SourceIcon size={14} />
          </button>
        )}
      </CodeHead>
      {showSource ? (
        <pre className="code-body">
          <code>{source}</code>
        </pre>
      ) : (
        <div className="mermaid-view">
          {/* Mermaid's SVG is the one string besides KaTeX's handed to the browser as HTML:
              at securityLevel 'strict' Mermaid escapes every label and runs its output
              through DOMPurify, so nothing the source says becomes a script or a handler. */}
          <div
            style={drawn.width ? ({ width: drawn.width } as CSSProperties) : undefined}
            dangerouslySetInnerHTML={{ __html: drawn.svg! }}
          />
        </div>
      )}
      {drawn?.error && (
        <p className="mermaid-error" role="status">
          Diagram not drawn: {drawn.error.slice(0, 200)}
        </p>
      )}
    </div>
  );
}
