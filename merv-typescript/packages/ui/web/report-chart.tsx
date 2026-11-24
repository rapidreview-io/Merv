import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  chartHeights,
  compileSpec,
  loadRows,
  validateSpec,
  ROLES,
  type ChartSpec,
} from '@merv/reports/format/spec';
import { CodeHead } from './code-block';
import { Icon } from './icons';
import { onWorn, worn } from './theme';

/**
 * A report's ```chart block, drawn. Reports write charts in their own small grammar
 * (@merv/reports/format/spec); the report's PDF draws them through `compileSpec` and Vega, and
 * this draws them the same way, with the same colour roles, so a chart reads alike on the page
 * and on paper. Only a chart whose rows are written inline is drawn here: one that names a
 * report file or an artifact for its data, or that the grammar refuses, is shown as written.
 * Vega loads the first time a chart is shown. It draws to an SVG string (no DOM, no listeners),
 * which is the one HTML this hands the browser: Vega escapes every label it writes.
 */

/** Where Vega comes from: a seam, as Mermaid's is. */
export const chartLoader = {
  load: () =>
    Promise.all([import('vega'), import('vega-lite')]).then(([vega, vegaLite]) => ({
      vega,
      vegaLite,
    })),
};

/** The spec a block holds, when it is a chart this page can draw; null shows it as written. */
export function readChart(source: string): ChartSpec | null {
  let spec: unknown;
  try {
    spec = JSON.parse(source);
  } catch {
    return null;
  }
  if (validateSpec(spec).some((issue) => issue.level === 'error')) return null;
  const s = spec as ChartSpec;
  const inline = (data: { values?: unknown } | undefined) => !data || Array.isArray(data.values);
  return Array.isArray(s.data?.values) && s.layer.every((l: ChartSpec) => inline(l.data))
    ? s
    : null;
}

/** The page's ink and greys for the report theme's, in the dark; the colour roles stay. */
const DARK: Record<string, string> = {
  [ROLES.ink]: '#E8E8EC',
  '#6B6B70': '#A3A3AB',
};
/** The page's own faces (styles.css --font-body, --font-mono): it does not load Geist. */
const FONTS: Record<string, string> = {
  Geist: '-apple-system, BlinkMacSystemFont, Inter, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
  'Geist Mono': 'SF Mono, ui-monospace, JetBrains Mono, Menlo, Consolas, monospace',
};

/** The Vega-Lite spec for one chart at a width, in the theme the page wears. */
export function chartSpec(spec: ChartSpec, width: number, theme: 'light' | 'dark') {
  const rows = loadRows(spec.data, new Map());
  const { base } = chartHeights(spec, rows);
  const compiled = compileSpec(spec, { width, height: base, files: new Map(), criteria: [] });
  const config = JSON.parse(JSON.stringify(compiled.config), (key, value) =>
    typeof value === 'string' && /font$/i.test(key) ? (FONTS[value] ?? value) : value,
  );
  const out = { ...compiled, config };
  if (theme === 'light') return out;
  // Only the theme's inks change: validateSpec refuses a hex colour anywhere in a chart, its
  // rows included, so every hex string here is the theme's own.
  return JSON.parse(JSON.stringify(out), (_key, value) =>
    typeof value === 'string' && DARK[value] ? DARK[value] : value,
  );
}

/** Draws one chart to SVG markup. */
export async function drawChart(spec: ChartSpec, width: number, theme: 'light' | 'dark') {
  const { vega, vegaLite } = await chartLoader.load();
  const compiled = vegaLite.compile(chartSpec(spec, width, theme) as never).spec;
  const view = new vega.View(vega.parse(compiled), { renderer: 'none' });
  try {
    return await view.toSVG();
  } finally {
    view.finalize();
  }
}

const WIDTH = 560;

/** A chart block `readChart` accepted, drawn; its source is read once, not on every render. */
export function ReportChart({ source }: { source: string }) {
  const spec = useMemo(() => readChart(source), [source])!;
  const theme = useSyncExternalStore(onWorn, worn);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(WIDTH);
  const [drawn, setDrawn] = useState<{ svg?: string; error?: string }>();
  const [raw, setRaw] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(([entry]) => {
      const next = Math.floor(entry?.contentRect.width ?? 0);
      if (next > 120) setWidth((was) => (Math.abs(was - next) > 8 ? next : was));
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  useEffect(() => {
    let live = true;
    drawChart(spec, width, theme).then(
      (svg) => live && setDrawn({ svg }),
      (error: unknown) =>
        live &&
        setDrawn({
          error: `This chart could not be drawn: ${String(error instanceof Error ? error.message : error).split('\n')[0]}`,
        }),
    );
    return () => {
      live = false;
    };
  }, [spec, width, theme]);
  const showSource = raw || !drawn?.svg;
  return (
    <figure className="code-block report-chart">
      <CodeHead label="Chart" copy={source}>
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
      <figcaption className="report-chart-message">{spec.message}</figcaption>
      <div ref={box} className="report-chart-view">
        {showSource ? (
          drawn && (
            <pre className="code-body">
              <code>{source}</code>
            </pre>
          )
        ) : (
          <div
            role="img"
            aria-label={spec.message}
            dangerouslySetInnerHTML={{ __html: drawn.svg! }}
          />
        )}
      </div>
      {drawn?.error && (
        <p className="mermaid-error" role="status">
          {drawn.error}
        </p>
      )}
    </figure>
  );
}
