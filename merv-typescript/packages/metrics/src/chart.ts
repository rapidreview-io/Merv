/**
 * Merv's own charts of Trackio runs. DOM-free, so the page and an agent's picture draw the same
 * SVG. Every text is escaped: run and metric names come from training code, labels from people.
 */
export interface ChartRun {
  id: string;
  run: string;
  experimentId?: string;
  experiment?: string;
  attempt?: number;
  /** The experiment's workflow state, as its record says it. */
  state?: string;
  /** An attempt that was redone, or an experiment that failed: drawn grey, behind the others. */
  muted?: true;
  color: string;
  metrics: Record<string, [number, number][]>;
}
/** Something Merv recorded while a run was logging, at the step that run had reached. */
export interface ChartMark {
  run: string;
  step: number;
  at: string;
  label: string;
}
export interface Chart {
  runs: ChartRun[];
  metrics: string[];
  marks: ChartMark[];
  /** Metrics past the first 60 by name, which a narrower filter shows. */
  omitted?: number;
  /** An experiment shown is running, so the page reads again. */
  live: boolean;
}
export interface Frame {
  x: [number, number];
  y: [number, number];
}

export const PALETTE = [
  '#2563eb',
  '#0f766e',
  '#c81e1e',
  '#b45309',
  '#475569',
  '#0e7490',
  '#4d7c0f',
];
export const MUTED = '#a3a9b3';
export const PANEL = { width: 480, height: 260 };
const M = { left: 52, right: 14, top: 26, bottom: 24 };
/** The picture's own styles; the page styles the same classes for its themes. */
const STYLE =
  '.mc{font-family:Geist,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif}.mc-title{font-size:12px;font-weight:600;fill:#111827}.mc-tick{font-size:10px;fill:#6b7280}.mc-grid{stroke:#eceef1}.mc-axis{stroke:#9ca3af}.mc-when{stroke:#9ca3af;stroke-dasharray:2 3}.mc-legend{font-size:12px;fill:#374151}';

/** A run's points for a metric: its own, never a name every object inherits (`constructor`). */
export const pointsOf = (run: ChartRun, metric: string) =>
  Object.hasOwn(run.metrics, metric) ? run.metrics[metric] : undefined;
const esc = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const r = (value: number) => Math.round(value * 10) / 10;

/** TensorBoard's debiased exponential moving average; weight 0 leaves the points as logged. */
export function smooth(points: [number, number][], weight: number): [number, number][] {
  if (!weight) return points;
  let last = 0;
  return points.map(([x, y], i) => {
    last = last * weight + (1 - weight) * y;
    return [x, last / (1 - weight ** (i + 1))];
  });
}
function ticks([lo, hi]: [number, number], count: number, whole = false) {
  // Steps are whole numbers: no tick falls between two of them.
  const magnitude = Math.max(whole ? 1 : 0, 10 ** Math.floor(Math.log10((hi - lo) / count)));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => (hi - lo) / s <= count)!;
  // By index, at most count + 1 of them: at a magnitude where adding a step changes nothing, a
  // running sum would never pass hi.
  const first = Math.ceil(lo / step);
  return Array.from({ length: count + 1 }, (_, i) =>
    Number(((first + i) * step).toPrecision(12)),
  ).filter((v, i, all) => Number.isFinite(v) && v <= hi && v !== all[i - 1]);
}
export const number = (value: number) =>
  Math.abs(value) >= 1e3
    ? new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 3 }).format(
        value,
      )
    : Math.abs(value) >= 0.01 || value === 0
      ? String(Number(value.toPrecision(3)))
      : value.toExponential(1);

/** The steps and values a metric's panel spans: every run's points as logged. */
export function frame(chart: Chart, metric: string): Frame | undefined {
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const run of chart.runs)
    for (const [x, y] of pointsOf(run, metric) ?? []) {
      [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
    }
  if (x0 > x1) return undefined;
  const pad = (y1 - y0) * 0.06 || Math.abs(y0) * 0.1 || 1;
  return { x: x0 === x1 ? [x0 - 1, x1 + 1] : [x0, x1], y: [y0 - pad, y1 + pad] };
}
export function scale(f: Frame, width: number, height: number) {
  const [w, h] = [width - M.left - M.right, height - M.top - M.bottom];
  return {
    x: (v: number) => M.left + ((v - f.x[0]) / (f.x[1] - f.x[0])) * w,
    y: (v: number) => M.top + (1 - (v - f.y[0]) / (f.y[1] - f.y[0])) * h,
    /** The step under a horizontal position. */
    step: (px: number) => f.x[0] + ((px - M.left) / w) * (f.x[1] - f.x[0]),
  };
}

/** One metric: each run's line in its colour, Merv's marks along the foot with what they say. */
export function panel(
  chart: Chart,
  metric: string,
  { width = PANEL.width, height = PANEL.height, smoothing = 0, at = [0, 0] } = {},
) {
  const head = `<svg xmlns="http://www.w3.org/2000/svg" class="mc" x="${at[0]}" y="${at[1]}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(metric)}"><text class="mc-title" x="${M.left}" y="16">${esc(metric)}</text>`;
  const f = frame(chart, metric);
  if (!f) return `${head}</svg>`;
  const s = scale(f, width, height);
  const foot = height - M.bottom;
  const parts = [
    ...ticks(f.y, 5).map(
      (v) =>
        `<line class="mc-grid" x1="${M.left}" x2="${width - M.right}" y1="${r(s.y(v))}" y2="${r(s.y(v))}"/><text class="mc-tick" x="${M.left - 6}" y="${r(s.y(v) + 3.5)}" text-anchor="end">${number(v)}</text>`,
    ),
    `<line class="mc-axis" x1="${M.left}" x2="${width - M.right}" y1="${foot}" y2="${foot}"/>`,
    ...ticks(f.x, 5, true).map(
      (v) =>
        `<text class="mc-tick" x="${r(s.x(v))}" y="${foot + 15}" text-anchor="middle">${number(v)}</text>`,
    ),
  ];
  const line = (points: [number, number][]) =>
    'M' + points.map(([x, y]) => `${r(s.x(x))},${r(s.y(y))}`).join('L');
  // Grey runs first, so the current ones are drawn over them.
  for (const run of [...chart.runs].sort((a, b) => Number(!a.muted) - Number(!b.muted))) {
    const points = pointsOf(run, metric);
    if (!points?.length) continue;
    const color = run.muted ? MUTED : run.color;
    if (points.length === 1)
      parts.push(
        `<circle cx="${r(s.x(points[0][0]))}" cy="${r(s.y(points[0][1]))}" r="2.5" fill="${color}"/>`,
      );
    else if (smoothing)
      parts.push(
        `<path d="${line(points)}" fill="none" stroke="${color}" stroke-opacity="0.22" stroke-width="1"/>`,
        `<path d="${line(smooth(points, smoothing))}" fill="none" stroke="${color}" stroke-width="1.6"/>`,
      );
    else parts.push(`<path d="${line(points)}" fill="none" stroke="${color}" stroke-width="1.6"/>`);
  }
  const runs = new Map(chart.runs.map((run) => [run.id, run]));
  for (const mark of chart.marks) {
    const run = runs.get(mark.run);
    if (!(run && pointsOf(run, metric)?.length) || mark.step < f.x[0] || mark.step > f.x[1])
      continue;
    const x = r(s.x(mark.step));
    parts.push(
      `<g><title>${esc(`${mark.label} (${run.run}, step ${mark.step})`)}</title><line class="mc-when" x1="${x}" x2="${x}" y1="${M.top}" y2="${foot}"/><path d="M${x},${foot - 7}l-4.5,7h9z" fill="${run.muted ? MUTED : run.color}"/></g>`,
    );
  }
  return `${head}${parts.join('')}</svg>`;
}

export const legendOf = (run: ChartRun) =>
  [
    run.run,
    run.experiment,
    run.attempt !== undefined && `attempt ${run.attempt}`,
    run.state?.replaceAll('_', ' '),
  ]
    .filter(Boolean)
    .join(' · ');

/** An agent's picture: which run is which colour, over a grid of at most `limit` panels. */
export function sheet(chart: Chart, { smoothing = 0, limit = 12 } = {}) {
  const [w, h, gap, pad] = [400, 230, 12, 16];
  const shown = chart.metrics.slice(0, limit);
  const columns = Math.max(1, Math.min(3, shown.length));
  const top = pad + chart.runs.length * 18 + 8;
  const width = pad * 2 + columns * w + (columns - 1) * gap;
  const height = top + Math.ceil(shown.length / columns) * (h + gap) + pad - gap;
  const legend = chart.runs.map(
    (run, i) =>
      `<rect x="${pad}" y="${pad + i * 18 + 3}" width="10" height="10" rx="2" fill="${run.muted ? MUTED : run.color}"/><text class="mc-legend" x="${pad + 16}" y="${pad + i * 18 + 12}">${esc(legendOf(run))}</text>`,
  );
  const panels = shown.map((metric, i) =>
    panel(chart, metric, {
      width: w,
      height: h,
      smoothing,
      at: [pad + (i % columns) * (w + gap), top + Math.floor(i / columns) * (h + gap)],
    }),
  );
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" class="mc" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>${STYLE}</style><rect width="100%" height="100%" fill="#fff"/>${legend.join('')}${panels.join('')}</svg>`,
    shown,
    width,
    height,
  };
}
