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
/** One item's key metric, as a card's sparkline and live curve draw it. */
export interface ItemMetrics {
  /** The metric the item is read by (`keyMetric`). */
  metric: string;
  /** Every scalar its runs logged, by name. */
  metrics: string[];
  runs: {
    id: string;
    run: string;
    attempt?: number;
    color: string;
    muted?: true;
    points: [number, number][];
  }[];
  /** The newest current run's last value of the key metric. */
  last?: number;
  /** Where the runs say they ran (`machine` in their config, or the one connect was told). */
  machine?: string;
  /** What the runs say they cost so far, in US dollars (their `cost_usd` metric's last values). */
  costUsd?: number;
}

export interface Frame {
  x: [number, number];
  y: [number, number];
}

/**
 * Each run's colour, by the order it first logged (never by rank, so a filter repaints nothing).
 * Eight categorical slots validated for colour-vision deficiency on light and dark surfaces;
 * pages swap in the dark steps through `--mc-<slot>`, a picture keeps the light ones.
 */
export const PALETTE = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#6250d6',
  '#e34948',
];
export const PALETTE_DARK = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
];
/** A run's stroke: the page's themed slot where it defines one, else the light step. */
export const ink = (color: string) => {
  const slot = PALETTE.indexOf(color);
  return slot < 0 ? color : `var(--mc-${slot + 1}, ${color})`;
};
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
    const color = run.muted ? MUTED : ink(run.color);
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
      `<g><title>${esc(`${mark.label} (${run.run}, step ${mark.step})`)}</title><line class="mc-when" x1="${x}" x2="${x}" y1="${M.top}" y2="${foot}"/><path d="M${x},${foot - 7}l-4.5,7h9z" fill="${run.muted ? MUTED : ink(run.color)}"/></g>`,
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

/** What a run logs about its own cost or bookkeeping, never what it measures. */
const BOOKKEEPING =
  /(^|[/_.-])(cost|usd|lr|learning[_-]?rate|epoch|step|steps|time|seconds|throughput|tokens?[_/-]?per|samples?[_/-]?per|grad[_-]?norm|memory|gpu|cpu)([/_.-]|$)|^_|^system/i;
/** The metric a run reports its cost in, US dollars so far, read as its last value. */
export const COST_METRIC = /^(cost[/_.-]?usd|usd[/_.-]?cost|cost)$/i;
const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);

/**
 * The one metric an item is read by: the plan's primary measure where a metric's name says it
 * (`Primary measure: validation accuracy` picks `val/acc`), else a held-out accuracy or loss,
 * else any accuracy or loss, else the first measured metric by name. Bookkeeping (cost, the
 * learning rate, steps, timings) is never the key unless it is all a run logged.
 */
export function keyMetric(metrics: readonly string[], hint?: string): string | undefined {
  const measured = metrics.filter((metric) => !BOOKKEEPING.test(metric));
  const pool = measured.length ? measured : metrics.filter((m) => !COST_METRIC.test(m));
  if (!pool.length) return undefined;
  const sorted = [...pool].sort();
  if (hint) {
    const said = new Set(
      words(hint).flatMap((word) =>
        word === 'validation'
          ? [word, 'val', 'valid']
          : word === 'accuracy'
            ? [word, 'acc']
            : [word],
      ),
    );
    let best: string | undefined;
    let score = 0;
    for (const metric of sorted) {
      const got = words(metric).filter((word) => said.has(word)).length;
      if (got > score) [best, score] = [metric, got];
    }
    if (best) return best;
  }
  for (const pattern of [
    /(^|[/_.-])(val|valid|validation|eval|test|heldout)[/_.-]?.*(acc|accuracy|loss|f1|bleu|score)/i,
    /(^|[/_.-])(val|valid|validation|eval|test|heldout)([/_.-]|$)/i,
    /acc|accuracy|f1|score/i,
    /loss/i,
  ]) {
    const found = sorted.find((metric) => pattern.test(metric));
    if (found) return found;
  }
  return sorted[0];
}

/** Whether a metric's better values are lower: losses, errors and perplexities. */
export const lowerIsBetter = (metric: string) =>
  /loss|err|perplex|ppl|mse|mae|rmse|wer|cer/i.test(metric);

/**
 * A sparkline's paths: every run's line of one metric on one shared frame, in a box of this
 * size, with no axes. Returns nothing where no run logged two points.
 */
export function sparkPaths(
  runs: readonly { id: string; color: string; muted?: boolean; points: [number, number][] }[],
  { width = 96, height = 24, pad = 2 } = {},
) {
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const run of runs)
    for (const [x, y] of run.points)
      [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
  if (!(x1 > x0)) return [];
  const span = y1 - y0 || 1;
  const X = (x: number) => r(pad + ((x - x0) / (x1 - x0)) * (width - 2 * pad));
  const Y = (y: number) => r(pad + (1 - (y - y0) / span) * (height - 2 * pad));
  return [...runs]
    .sort((a, b) => Number(!a.muted) - Number(!b.muted))
    .filter((run) => run.points.length > 1)
    .map((run) => ({
      id: run.id,
      color: run.muted ? MUTED : ink(run.color),
      muted: !!run.muted,
      d: 'M' + run.points.map(([x, y]) => `${X(x)},${Y(y)}`).join('L'),
      end: [X(run.points.at(-1)![0]), Y(run.points.at(-1)![1])] as [number, number],
    }));
}

/**
 * The figure an item keeps when it ends: its key metric with every run overlaid on one frame
 * (seeds, arms, attempts), a legend that names each run in its colour, white paper, so it reads
 * the same in a report, the paper and on a board. A second metric, when the item logged one
 * worth reading beside the key (its loss beside an accuracy), stands to its right.
 */
export function figure(
  chart: Chart,
  { title, metrics }: { title: string; metrics: string[] },
): { svg: string; width: number; height: number } {
  const shown = metrics.filter((metric) => chart.metrics.includes(metric)).slice(0, 2);
  const [w, h, pad, gap] = [560, 300, 20, 16];
  const legendRows = Math.ceil(chart.runs.length / 3);
  const top = pad + 26 + legendRows * 20 + 6;
  const width = pad * 2 + shown.length * w + (shown.length - 1) * gap;
  const height = top + h + pad;
  const legend = chart.runs.map((run, i) => {
    const x = pad + (i % 3) * Math.floor((width - 2 * pad) / 3);
    const y = pad + 26 + Math.floor(i / 3) * 20;
    return `<rect x="${x}" y="${y + 2}" width="14" height="4" rx="2" fill="${run.muted ? MUTED : run.color}"/><text class="mc-legend" x="${x + 20}" y="${y + 8}">${esc(legendOf({ ...run, state: undefined, experiment: undefined }))}</text>`;
  });
  // The picture keeps the light steps: its paper is white wherever it is shown.
  const flat: Chart = { ...chart, marks: [], runs: chart.runs.map((run) => ({ ...run })) };
  const panels = shown.map((metric, i) =>
    panel(flat, metric, { width: w, height: h, at: [pad + i * (w + gap), top] }).replace(
      /var\(--mc-\d+, (#[0-9a-f]{6})\)/g,
      '$1',
    ),
  );
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" class="mc" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>${STYLE}.mc-head{font-size:15px;font-weight:600;fill:#111827}</style><rect width="100%" height="100%" fill="#fff"/><text class="mc-head" x="${pad}" y="${pad + 12}">${esc(title)}</text>${legend.join('')}${panels.join('')}</svg>`,
    width,
    height,
  };
}
