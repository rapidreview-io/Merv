import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import {
  frame,
  legendOf,
  number,
  panel,
  scale,
  MUTED,
  PANEL,
  pointsOf,
  type Chart,
  type ChartRun,
} from '@merv/metrics/chart';
import { accountRequest, useScopeVersion, useTool } from '../api';
import { useReferences } from '../markdown';
import { rowOf, useRows } from '../navigation';

export interface MetricsSession {
  url: string;
  runs: number;
}
/** Whether runs were logged, and the Trackio dashboard's address with its view cookie set. */
export function useMetricsSession(enabled: boolean, experimentId?: string) {
  const scope = useScopeVersion();
  const [session, setSession] = useState<{
    scope: number;
    experimentId?: string;
    result: MetricsSession;
  }>();
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const read = () =>
      accountRequest<MetricsSession>('/metrics/session', {
        scoped: true,
        credentials: 'same-origin',
        method: 'POST',
        body: { experimentId },
      }).then(
        (result) => {
          if (!cancelled) setSession({ scope, experimentId, result });
        },
        () => {
          if (!cancelled) setSession(undefined);
        },
      );
    void read();
    const timer = setInterval(read, 60000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, scope, experimentId]);
  return enabled && session?.scope === scope && session.experimentId === experimentId
    ? session.result
    : undefined;
}

const HEIGHT = 240;
function useWidth(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const read = () => setWidth(Math.round(element.getBoundingClientRect().width));
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
/** The point of a series nearest a step. */
function nearest(points: [number, number][], step: number) {
  let [lo, hi] = [0, points.length - 1];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] < step) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && step - points[lo - 1][0] < points[lo][0] - step ? points[lo - 1] : points[lo];
}

/**
 * One metric as Merv draws it: hover reads every run at a step and what Merv recorded there; a
 * drag across it zooms every panel to those steps, which are read again at full detail, where
 * the page offers zoom and a way back from it.
 */
function ChartPanel({
  chart,
  metric,
  smoothing,
  onZoom,
}: {
  chart: Chart;
  metric: string;
  smoothing: number;
  onZoom?(range?: [number, number]): void;
}) {
  const box = useRef<HTMLDivElement>(null);
  // Measured before the first paint; a page without layout (a test) draws the default width.
  const width = useWidth(box) || PANEL.width;
  const [at, setAt] = useState<number>();
  const [drag, setDrag] = useState<[number, number]>();
  const f = frame(chart, metric);
  const s = f && scale(f, width, HEIGHT);
  const svg = useMemo(
    () => panel(chart, metric, { width, height: HEIGHT, smoothing }),
    [chart, metric, width, smoothing],
  );
  const x = (event: { clientX: number }) =>
    event.clientX - (box.current?.getBoundingClientRect().left ?? 0);
  const step = at !== undefined && s ? s.step(at) : undefined;
  // A drag that starts or ends outside the plot zooms to its edge.
  const stepAt = (px: number) => Math.min(f!.x[1], Math.max(f!.x[0], s!.step(px)));
  const marks =
    s && at !== undefined
      ? chart.marks.filter(
          (mark) =>
            chart.runs.some((run) => run.id === mark.run && pointsOf(run, metric)) &&
            Math.abs(s.x(mark.step) - at) < 6,
        )
      : [];
  return (
    <div
      ref={box}
      className="metrics-chart"
      onPointerMove={(event) => {
        setAt(x(event));
        if (drag) setDrag([drag[0], x(event)]);
      }}
      onPointerLeave={() => {
        setAt(undefined);
        setDrag(undefined);
      }}
      onPointerDown={(event) => onZoom && setDrag([x(event), x(event)])}
      onPointerUp={() => {
        if (drag && s && Math.abs(drag[1] - drag[0]) > 6)
          onZoom?.([Math.floor(stepAt(Math.min(...drag))), Math.ceil(stepAt(Math.max(...drag)))]);
        setDrag(undefined);
      }}
      onDoubleClick={() => onZoom?.(undefined)}
    >
      <div dangerouslySetInnerHTML={{ __html: svg }} />
      {drag && (
        <div
          className="metrics-drag"
          style={{ left: Math.min(...drag), width: Math.abs(drag[1] - drag[0]) }}
        />
      )}
      {step !== undefined && at !== undefined && s && step >= f!.x[0] && step <= f!.x[1] && (
        <>
          <div className="metrics-cursor" style={{ left: at }} />
          <div
            className={`metrics-tip${at > width / 2 ? ' metrics-tip--left' : ''}`}
            style={{ left: at }}
          >
            <strong>step {Math.round(step)}</strong>
            {chart.runs.flatMap((run) => {
              const points = pointsOf(run, metric);
              // A run that had not started or had already ended at this step says nothing here.
              if (!points?.length || step < points[0][0] || step > points[points.length - 1][0])
                return [];
              const [x, value] = nearest(points, step);
              return [
                <span key={run.id}>
                  <i style={{ background: run.muted ? MUTED : run.color }} />
                  {run.run} {number(value)}
                  {Math.round(step) !== x && <em> @{x}</em>}
                </span>,
              ];
            })}
            {marks.map((mark) => (
              <span key={`${mark.run}:${mark.at}`} className="metrics-tip-mark">
                {mark.label}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Runs' charts with their place in Merv: every run names its experiment and attempt and opens
 * it; a redone attempt is grey. Chart controls wait behind a quiet Filter.
 */
export function MetricsCharts({
  experimentId,
  runs,
  trackio,
  more,
  compact,
}: {
  experimentId?: string;
  runs?: string[];
  /** The project's page of every experiment's runs. */
  more?: string;
  /** Trackio's own dashboard, for what Merv does not draw (media, histograms, traces). */
  trackio?: string;
  /** Inside a board's card: this many panels, no controls. */
  compact?: number;
}) {
  const [range, setRange] = useState<[number, number]>();
  const [filtering, setFiltering] = useState(false);
  const [filter, setFilter] = useState('');
  const [smoothing, setSmoothing] = useState(0);
  const [only, setOnly] = useState<string>();
  const experiments = rowOf(useRows(), 'experiment')?.path;
  const { data, error } = useTool<Chart>(
    'metrics.chart',
    {
      ...(experimentId && { experimentId }),
      ...(runs && { runs }),
      ...(filter && { metrics: filter }),
      ...(range && { from: range[0], to: range[1] }),
    },
    // Live runs are read every 10 s; otherwise once a minute, so a run that starts is found.
    { every: (chart) => (chart?.live ? 10000 : 60000) },
  );
  // A changed filter or zoom keeps the last charts on screen until its own answer comes.
  const last = useRef<Chart>();
  if (data) last.current = data;
  const shown = data ?? (error ? undefined : last.current);
  const chart = useMemo(
    () =>
      shown && only && shown.runs.some((run) => run.id === only)
        ? { ...shown, runs: shown.runs.filter((run) => run.id === only) }
        : shown,
    [shown, only],
  );
  if (compact && !chart) return null;
  const label = (run: ChartRun) =>
    experimentId ? legendOf({ ...run, experiment: undefined, state: undefined }) : legendOf(run);
  const metrics = chart && (compact ? chart.metrics.slice(0, compact) : chart.metrics);
  return (
    <div className={`metrics-charts${compact ? ' metrics-charts--compact' : ''}`}>
      {!compact && (
        <div className="metrics-head">
          {range && (
            <button type="button" className="btn-text" onClick={() => setRange(undefined)}>
              Steps {range[0]}–{range[1]} ×
            </button>
          )}
          <button
            type="button"
            className="btn-text"
            aria-pressed={filtering}
            onClick={() => setFiltering(!filtering)}
          >
            Filter
          </button>
          {more && (
            <Link className="btn-text" to={more}>
              All runs
            </Link>
          )}
          {trackio && (
            <a className="btn-text" href={trackio} target="_blank" rel="noopener noreferrer">
              Open in Trackio ↗
            </a>
          )}
        </div>
      )}
      {filtering && !compact && (
        <div className="metrics-filter">
          <input
            type="search"
            placeholder="Metrics matching…"
            aria-label="Metrics matching"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <label>
            Smoothing
            <input
              type="range"
              min={0}
              max={0.99}
              step={0.01}
              value={smoothing}
              onChange={(event) => setSmoothing(Number(event.target.value))}
            />
          </label>
        </div>
      )}
      {!chart ? (
        error?.code === 'not_found' ? (
          <p className="muted">No runs logged yet.</p>
        ) : error ? (
          <p className="pi-error">{error.message}</p>
        ) : (
          <p className="muted">Reading the runs…</p>
        )
      ) : (
        <>
          <ul className="metrics-legend">
            {shown!.runs.map((run) => (
              <li
                key={run.id}
                className={run.muted || (only && only !== run.id) ? 'is-muted' : undefined}
              >
                <button
                  type="button"
                  aria-pressed={only === run.id}
                  title={only === run.id ? 'Show every run' : 'Show only this run'}
                  onClick={() => setOnly(only === run.id ? undefined : run.id)}
                >
                  <i style={{ background: run.muted ? MUTED : run.color }} />
                  {label(run)}
                </button>
                {!experimentId && run.experimentId && experiments && (
                  <Link
                    to={`${experiments}/${run.experimentId}`}
                    aria-label={`Open ${run.experiment}`}
                  >
                    →
                  </Link>
                )}
              </li>
            ))}
          </ul>
          <div className="metrics-grid">
            {metrics!.map((metric) => (
              <ChartPanel
                key={metric}
                chart={chart}
                metric={metric}
                smoothing={smoothing}
                onZoom={compact ? undefined : setRange}
              />
            ))}
          </div>
          {!compact && chart.omitted && (
            <p className="muted">{chart.omitted} more metrics: filter to draw them.</p>
          )}
          {compact && chart.metrics.length > metrics!.length && experimentId && experiments && (
            <Link className="btn-text" to={`${experiments}/${experimentId}`}>
              {chart.metrics.length - metrics!.length} more on the record →
            </Link>
          )}
        </>
      )}
    </div>
  );
}

interface Run {
  id: string;
  experimentId?: string;
  experiment?: string;
}
/**
 * Every experiment's runs: the list picks whose curves are drawn (the newest runs until one is
 * picked) and names each experiment with its state, opening its record.
 */
export function MetricsView() {
  const { data: runs } = useTool<Run[]>('metrics.read:runs', {}, { every: 30000 });
  const session = useMetricsSession(true);
  const experiments = rowOf(useRows(), 'experiment')?.path;
  const [picked, setPicked] = useState<string[]>([]);
  const listed = useMemo(() => {
    const by = new Map<string, { id: string; name: string; runs: string[] }>();
    for (const run of runs ?? [])
      if (run.experimentId) {
        const entry = by.get(run.experimentId) ?? {
          id: run.experimentId,
          name: run.experiment ?? run.experimentId,
          runs: [],
        };
        entry.runs.push(run.id);
        by.set(run.experimentId, entry);
      }
    return [...by.values()];
  }, [runs]);
  const named = useReferences(
    useMemo(() => listed.map((entry) => entry.id), [listed]),
    30000,
  );
  const chosen = picked.length
    ? listed
        .filter((entry) => picked.includes(entry.id))
        .flatMap((entry) => entry.runs)
        .slice(0, 20)
    : undefined;
  return (
    <div className="page-stage metrics-page">
      {listed.length > 0 && (
        <ul className="metrics-experiments" aria-label="Experiments">
          {listed.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                aria-pressed={picked.includes(entry.id)}
                onClick={() =>
                  setPicked(
                    picked.includes(entry.id)
                      ? picked.filter((id) => id !== entry.id)
                      : [...picked, entry.id],
                  )
                }
              >
                <span>{named.get(entry.id)?.name ?? entry.name}</span>
                <small>
                  {[named.get(entry.id)?.state?.replaceAll('_', ' '), `${entry.runs.length} runs`]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              </button>
              {experiments && (
                <Link to={`${experiments}/${entry.id}`} aria-label={`Open ${entry.name}`}>
                  →
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
      <MetricsCharts key={chosen?.join() ?? ''} runs={chosen} trackio={session?.url} />
    </div>
  );
}
