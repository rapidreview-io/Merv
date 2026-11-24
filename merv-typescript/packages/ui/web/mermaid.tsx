import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { CodeHead } from './code-block';
import { Icon } from './icons';
import { onWorn, worn } from './theme';

/**
 * A Mermaid diagram, drawn from its source. Mermaid (pinned at 12.1.0 in package.json: a new
 * minor has changed its default look and its parser before, so it moves only on purpose) loads
 * the first time a diagram is shown and draws in the theme of what holds it: the board's own
 * where `DiagramTheme` says it, else the page's, again whenever that changes. It runs at its
 * strict security level, so a diagram's labels are text and its clicks bind nothing. A diagram
 * fits the column and a press shows it at its own size. A source Mermaid cannot read is shown as
 * written, with one plain line saying where it stopped: a broken diagram is never a blank.
 */

/** Where Mermaid comes from: a seam for tests, which cannot lay a diagram out. */
const mermaidLoader = { load: () => import('mermaid').then((module) => module.default) };

/** The theme of the surface a diagram stands on, where that is not the page's (a board's card). */
export const DiagramTheme = createContext<'light' | 'dark' | null>(null);

/** Every drawing needs an element id of its own, and two diagrams may draw at once. */
let drawings = 0;
/** A source still being written is drawn once it has rested this long. */
const REST_MS = 150;

/**
 * Mermaid's settings are global, so one diagram's theme must not leak into another's drawing:
 * each sets them and draws in turn, never interleaved.
 */
let turn: Promise<unknown> = Promise.resolve();
const inTurn = <T,>(work: () => Promise<T>): Promise<T> => {
  const mine = turn.then(work, work);
  turn = mine.catch(() => undefined);
  return mine;
};

/** The board's quiet greys rather than Mermaid's lilac: ink on paper, one line weight. */
const INKS = {
  light: {
    background: '#ffffff',
    primaryColor: '#f6f6f8',
    primaryBorderColor: '#868e96',
    primaryTextColor: '#25252b',
    secondaryColor: '#eef1f4',
    tertiaryColor: '#ffffff',
    lineColor: '#495057',
    textColor: '#25252b',
    edgeLabelBackground: '#ffffff',
    noteBkgColor: '#fff8db',
    noteBorderColor: '#e0c96a',
  },
  dark: {
    background: '#111110',
    primaryColor: '#222221',
    primaryBorderColor: '#707078',
    primaryTextColor: '#e8e8ec',
    secondaryColor: '#2a2a2e',
    tertiaryColor: '#111110',
    lineColor: '#a9a9b3',
    textColor: '#e8e8ec',
    edgeLabelBackground: '#111110',
    noteBkgColor: '#3a3524',
    noteBorderColor: '#7a6a35',
  },
};
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

/**
 * The commonest way an agent's flowchart fails: a label with brackets, a colon or a quote mark in
 * it, unquoted (`A[Upload (local file)]`). Quoting such labels is what the author meant; it is
 * tried only after the source as written failed, and only on flowcharts. Shapes written with an
 * inner bracket (`[(db)]`, `[[sub]]`, `[/lean/]`) are left as they are.
 */
function quoteLabels(source: string): string | null {
  if (!/^\s*(?:%%.*\n\s*)*(?:flowchart|graph)\b/i.test(source)) return null;
  const quoted = source.replace(
    /(\b[\w-]+)(\[|\{)(?![[({/\\"])([^\]}"\n]*?[():;|][^\]}"\n]*?)(\]|\})/g,
    (whole, id: string, open: string, label: string, close: string) =>
      (open === '[') !== (close === ']')
        ? whole
        : `${id}${open}"${label.replaceAll('"', '#quot;')}"${close}`,
  );
  return quoted === source ? null : quoted;
}

/**
 * One line a person can act on, from Mermaid's complaint: the line of the source it stopped at,
 * quoted, rather than its parser's list of expected tokens.
 */
function diagramError(said: string, source: string): string {
  const at = Number(/\bline (\d+)/i.exec(said)?.[1]);
  if (at > 0) {
    // Past the last line, the diagram ended before it was finished: name the last line written.
    const lines = source.split('\n').slice(0, at);
    let index = lines.length - 1;
    while (index > 0 && !lines[index]!.trim()) index--;
    const line = lines[index]?.trim();
    if (line)
      return index + 1 < at
        ? `Mermaid could not read past line ${index + 1}, where it stopped unfinished: ${line.slice(0, 120)}`
        : `Mermaid could not read line ${at}: ${line.slice(0, 120)}`;
  }
  if (/no diagram type detected/i.test(said))
    return 'Mermaid did not recognise the diagram type on the first line';
  const first = said
    .split('\n')
    .find((text) => text.trim())
    ?.trim();
  return first
    ? `Mermaid could not draw this: ${first.slice(0, 160)}`
    : 'Mermaid could not draw this';
}

interface Drawn {
  svg?: string;
  /** The natural width Mermaid gave the diagram: it is never drawn wider, and a press shows it so. */
  width?: string;
  error?: string;
}

export function Mermaid({ source }: { source: string }) {
  const page = useSyncExternalStore(onWorn, worn);
  const theme = useContext(DiagramTheme) ?? page;
  const [drawn, setDrawn] = useState<Drawn>();
  const [raw, setRaw] = useState(false);
  const [full, setFull] = useState(false);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(async () => {
      const draw = (text: string) =>
        inTurn(async () => {
          const id = `mermaid-${++drawings}`;
          try {
            const mermaid = await mermaidLoader.load();
            // Labels are measured as they are drawn: in the fonts the page has, once they are in.
            await document.fonts?.ready;
            mermaid.initialize({
              startOnLoad: false,
              securityLevel: 'strict',
              theme: 'base',
              look: 'classic',
              fontFamily: FONT,
              themeVariables: { ...INKS[theme], fontFamily: FONT, fontSize: '15px' },
              suppressErrorRendering: true,
            } as Parameters<typeof mermaid.initialize>[0]);
            const { svg } = await mermaid.render(id, text);
            return { svg, width: /max-width:\s*([\d.]+px)/.exec(svg)?.[1] };
          } finally {
            // What Mermaid left in the page while it drew goes with the drawing, failed or not.
            for (const left of [`d${id}`, `i${id}`]) document.getElementById(left)?.remove();
          }
        });
      try {
        const result = await draw(source);
        if (live) setDrawn(result);
      } catch (error) {
        const said = error instanceof Error ? error.message : String(error);
        const repaired = quoteLabels(source);
        const result = repaired ? await draw(repaired).catch(() => undefined) : undefined;
        if (live) setDrawn(result ?? { error: diagramError(said, source) });
      }
    }, REST_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [source, theme]);
  useEffect(() => {
    if (!full) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setFull(false);
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [full]);
  const showSource = raw || !!drawn?.error || !drawn?.svg;
  const natural = drawn?.width ? ({ width: drawn.width } as CSSProperties) : undefined;
  // A wide diagram shrinks to its column, but never below half its size: past that it scrolls.
  const fitted = drawn?.width
    ? ({
        width: drawn.width,
        maxWidth: `max(100%, ${parseFloat(drawn.width) / 2}px)`,
      } as CSSProperties)
    : undefined;
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
            <Icon name="source" size={14} />
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
          <button
            type="button"
            className="mermaid-fit"
            aria-label="Show the diagram at full size"
            title="Show at full size"
            style={fitted}
            onClick={() => setFull(true)}
          >
            <div dangerouslySetInnerHTML={{ __html: drawn.svg! }} />
          </button>
        </div>
      )}
      {drawn?.error && (
        <p className="mermaid-error" role="status">
          {drawn.error}
        </p>
      )}
      {full &&
        drawn?.svg &&
        createPortal(
          <div
            className={`md-lightbox md-lightbox-diagram is-${theme}`}
            role="dialog"
            aria-modal="true"
            aria-label="Diagram"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setFull(false)}
          >
            <div style={natural} dangerouslySetInnerHTML={{ __html: drawn.svg }} />
          </div>,
          document.body,
        )}
    </div>
  );
}
