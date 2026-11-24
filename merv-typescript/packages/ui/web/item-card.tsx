/**
 * A task's or an experiment's card, in merv-desktop's job language: one mark for where it
 * stands, the question it answers in a line, its plan as a little flow, then either its live
 * Trackio curve (or, without metrics, a calm trail of its stages) or, once it has ended, its
 * result: what it found, the key figure, pass or fail, cost and a receipt. The compact card is
 * the list's and the board's; the full one heads the item's own page. An item that logged no
 * metrics shows nothing of Trackio at all.
 */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  MUTED,
  PANEL,
  ink,
  legendOf,
  lowerIsBetter,
  number,
  panel,
  sparkPaths,
  type Chart,
  type ItemMetrics,
} from '@merv/metrics/chart';
import { useTool } from './api';
import { Ago, cx } from './components';
import { ArtifactFigure } from './artifact-figure';
import { useRows } from './navigation';
import {
  STATE_WORDS,
  type Arm,
  type ItemState,
  type Step,
  isMetricsFigure,
  usd,
} from './item-model';
import './item-card.css';

/** One mark per state, the same shape wherever an item is shown; its name for whoever cannot see it. */
export function ItemMark({ state, size = 16 }: { state: ItemState; size?: number }) {
  return (
    <svg
      className={`item-mark is-${state}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      role="img"
      aria-label={STATE_WORDS[state]}
    >
      <title>{STATE_WORDS[state]}</title>
      {state === 'working' && (
        <>
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.22"
            strokeWidth="2"
          />
          <path
            className="item-mark-spin"
            d="M8 2a6 6 0 0 1 6 6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </>
      )}
      {state === 'needs' && <path d="M8 1.6 14.4 8 8 14.4 1.6 8Z" fill="currentColor" />}
      {state === 'failed' && (
        <>
          <circle cx="8" cy="8" r="6.6" fill="currentColor" />
          <path
            d="M8 4.6v4.2M8 11.3v.1"
            stroke="var(--bg-elev)"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </>
      )}
      {state === 'done' && (
        <>
          <circle cx="8" cy="8" r="6.6" fill="currentColor" />
          <path
            d="m5.2 8.2 1.9 1.9 3.8-4"
            fill="none"
            stroke="var(--bg-elev)"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  );
}

/** Whether this deployment keeps metrics: without the Metrics page, no card asks Trackio. */
export function useHasMetrics() {
  return useRows().some((row) => row.id === 'metrics');
}
/**
 * Many items' key curves in one read. Running items are read every 10 s so their curves move
 * in place; otherwise once a minute, so a run that starts is found. Nothing when no id is given.
 */
export function useItemMetrics(
  ids: readonly string[],
  {
    hints,
    live = false,
    points,
  }: { hints?: Record<string, string>; live?: boolean; points?: number } = {},
) {
  const enabled = useHasMetrics() && ids.length > 0;
  const read = useTool<Record<string, ItemMetrics>>(
    enabled ? 'metrics.items' : null,
    {
      ids: [...ids].sort().slice(0, 100),
      ...(hints && Object.keys(hints).length && { hints }),
      ...(points && { points }),
    },
    { every: live ? 10_000 : 60_000 },
  );
  return read.data ?? {};
}

/** Every run of the key metric as a thin line on one shared frame, no axes: the list's glance. */
export function Sparkline({
  metrics,
  width = 96,
  height = 26,
}: {
  metrics: ItemMetrics;
  width?: number;
  height?: number;
}) {
  const paths = sparkPaths(metrics.runs, { width, height, pad: 3 });
  if (!paths.length) return null;
  const head = paths.at(-1)!;
  return (
    <svg
      className="item-spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${metrics.metric}: ${metrics.runs.length} ${metrics.runs.length === 1 ? 'run' : 'runs'}, last ${number(metrics.last ?? NaN)}`}
    >
      {paths.map((path) => (
        <path
          key={path.id}
          d={path.d}
          fill="none"
          stroke={path.color}
          strokeWidth={path.muted ? 1 : 1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
      <circle cx={head.end[0]} cy={head.end[1]} r="2.2" fill={head.color} />
    </svg>
  );
}

/** The metric's name and its newest value, the words beside a sparkline. */
export function KeyValue({ metrics }: { metrics: ItemMetrics }) {
  return (
    <span className="item-key">
      <span className="item-key-name">{metrics.metric}</span>
      {metrics.last !== undefined && (
        <span className="item-key-value tabular">{number(metrics.last)}</span>
      )}
    </span>
  );
}

const asChart = (metrics: ItemMetrics, live: boolean): Chart => ({
  metrics: [metrics.metric],
  marks: [],
  live,
  runs: metrics.runs.map((run) => ({
    id: run.id,
    run: run.run,
    ...(run.attempt !== undefined && { attempt: run.attempt }),
    color: run.color,
    ...(run.muted && { muted: run.muted }),
    metrics: { [metrics.metric]: run.points },
  })),
});
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
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
  }, []);
  return [ref, width] as const;
}

/**
 * The key metric's curve, every run overlaid on one frame, with a legend that names each run
 * in its colour. Live, it says so and is redrawn in place as the runs log.
 */
export function KeyCurve({
  metrics,
  live,
  height = 220,
}: {
  metrics: ItemMetrics;
  live: boolean;
  height?: number;
}) {
  const [ref, measured] = useWidth();
  const width = measured || PANEL.width;
  const chart = useMemo(() => asChart(metrics, live), [metrics, live]);
  const svg = useMemo(
    () => panel(chart, metrics.metric, { width, height }),
    [chart, metrics.metric, width, height],
  );
  const better = lowerIsBetter(metrics.metric) ? 'lower is better' : 'higher is better';
  return (
    <figure className="item-curve" aria-label={`${metrics.metric} curve`}>
      <figcaption className="item-curve-head">
        {live && (
          <span className="item-live" role="status">
            <i aria-hidden="true" /> Live
          </span>
        )}
        <span className="item-curve-title">{metrics.metric}</span>
        <span className="item-curve-aside">{better}</span>
      </figcaption>
      <div ref={ref} className="item-curve-plot" dangerouslySetInnerHTML={{ __html: svg }} />
      {metrics.runs.length > 1 && (
        <ul className="item-legend">
          {metrics.runs.map((run) => (
            <li key={run.id} className={cx(run.muted && 'is-muted')}>
              <i style={{ background: run.muted ? MUTED : ink(run.color) }} />
              {legendOf({ ...run, metrics: {} })}
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

/**
 * The plan as a little flow. Arms fan out from the question and meet at the measure, so
 * baseline against ablation, or three seeds, reads at a glance; without arms, the steps run
 * left to right, each done, now or still to come.
 */
export function PlanFlow({
  arms,
  steps,
  measure,
  compact,
}: {
  arms?: Arm[];
  steps?: Step[];
  measure?: string;
  compact?: boolean;
}) {
  if (arms && arms.length > 1) {
    const n = arms.length;
    const fan = (out: boolean) => (
      <svg
        className="plan-fan"
        viewBox={`0 0 24 ${n * 10}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {arms.map((_, i) => (
          <path
            key={i}
            d={
              out
                ? `M0 ${n * 5} C12 ${n * 5} 12 ${i * 10 + 5} 24 ${i * 10 + 5}`
                : `M0 ${i * 10 + 5} C12 ${i * 10 + 5} 12 ${n * 5} 24 ${n * 5}`
            }
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
    );
    return (
      <div
        className={cx('plan-flow plan-flow--arms', compact && 'plan-flow--compact')}
        aria-label="Plan"
      >
        <span className="plan-dot" aria-hidden="true" />
        {fan(true)}
        <ol className="plan-arms">
          {arms.map((arm) => (
            <li key={arm.name} className="plan-node" title={arm.detail}>
              <span>{arm.name}</span>
              {arm.detail && !compact && <small>{arm.detail}</small>}
            </li>
          ))}
        </ol>
        {fan(false)}
        <span className="plan-node plan-node--measure" title={measure}>
          {measure ? shortMeasure(measure) : 'Compare'}
        </span>
      </div>
    );
  }
  if (!steps?.length) return null;
  return (
    <ol
      className={cx('plan-flow plan-flow--steps', compact && 'plan-flow--compact')}
      aria-label="Steps"
    >
      {steps.map((step, i) => (
        <li key={`${step.label}:${i}`} className={`plan-step is-${step.at}`}>
          <span className="plan-step-dot" aria-hidden="true" />
          <span className="plan-step-label">{step.label}</span>
          {step.at === 'now' && <span className="sr-only"> (now)</span>}
        </li>
      ))}
    </ol>
  );
}
const shortMeasure = (text: string) => {
  const words = text.replace(/\(.*?\)/g, '').trim();
  return words.length > 28 ? `${words.slice(0, 27).trimEnd()}…` : words;
};

/** Passed or failed against its success check, said with a sign, never by colour alone. */
export function Verdict({ verdict, success }: { verdict: 'pass' | 'fail'; success?: string }) {
  return (
    <p className={`item-verdict is-${verdict}`}>
      <span className="item-verdict-sign" aria-hidden="true">
        {verdict === 'pass' ? '✓' : '✕'}
      </span>
      <strong>{verdict === 'pass' ? 'Passed' : 'Did not pass'}</strong>
      {success && <span className="item-verdict-check">{success}</span>}
    </p>
  );
}

export interface ItemReceipt {
  commit?: string;
  /** Where its code lives, for the commit's link. */
  commitTo?: string;
  data?: { id: string; title: string }[];
  machine?: string;
  costUsd?: number;
}
/** Where it ran, what it cost and what it kept, one quiet line. */
export function Receipt({ receipt }: { receipt: ItemReceipt }) {
  const parts: ReactNode[] = [];
  const cost = usd(receipt.costUsd);
  if (cost) parts.push(<span key="cost">{cost}</span>);
  if (receipt.machine) parts.push(<span key="machine">{receipt.machine}</span>);
  if (receipt.commit)
    parts.push(
      <code key="commit" title={receipt.commit}>
        {receipt.commit.slice(0, 7)}
      </code>,
    );
  for (const file of receipt.data ?? [])
    parts.push(
      <Link key={file.id} to={`/artifacts/${file.id}`} className="item-receipt-file">
        {file.title.split('/').at(-1)}
      </Link>,
    );
  if (!parts.length) return null;
  return (
    <p className="item-receipt" aria-label="Receipt">
      {parts}
    </p>
  );
}

/** Its latest moves, one line each: the calm trail a running item without metrics shows. */
export function Trail({ lines }: { lines: { text: string; at?: string }[] }) {
  if (!lines.length) return null;
  return (
    <ol className="item-trail" aria-label="Latest">
      {lines.map((line, i) => (
        <li key={i}>
          <span className="item-trail-dot" aria-hidden="true" />
          <span>{line.text}</span>
          {line.at && <Ago at={line.at} className="item-trail-at" />}
        </li>
      ))}
    </ol>
  );
}

export interface ItemSummaryProps {
  kind: 'experiment' | 'task';
  state: ItemState;
  /** Where it stands in its own words: "Results review". */
  stage?: string;
  question: string;
  arms?: Arm[];
  /** The plan's steps where it has no arms: a task's checks, or the item's stages. */
  steps: Step[];
  /** Its stages, where the plan above is not already them: the progress trail's line. */
  stages?: Step[];
  measure?: string;
  metrics?: ItemMetrics;
  finding?: string;
  verdict?: 'pass' | 'fail';
  success?: string;
  figureId?: string;
  receipt: ItemReceipt;
  trail: { text: string; at?: string }[];
}

/**
 * The full card: the question, the plan, and then what the item is doing or what it found.
 * While it works, its live curve or, without metrics, its stages and latest moves; once it
 * has ended, the result card with the figure it kept.
 */
export function ItemSummary(props: ItemSummaryProps) {
  const { state, metrics } = props;
  const ended = state === 'done' || state === 'failed';
  return (
    <section className={`item-summary is-${state}`} aria-label="Summary">
      <header className="item-summary-head">
        <ItemMark state={state} size={18} />
        <span className="item-summary-state">{STATE_WORDS[state]}</span>
        {props.stage && !ended && <span className="item-summary-stage">· {props.stage}</span>}
        <span className="item-summary-kind">{props.kind === 'task' ? 'Task' : 'Experiment'}</span>
      </header>
      <p className="item-question">{props.question}</p>
      <PlanFlow
        arms={props.arms}
        steps={props.arms?.length ? undefined : props.steps}
        measure={props.measure}
      />
      {ended ? (
        <ResultCard {...props} />
      ) : (
        <div className="item-progress">
          {props.stages && <PlanFlow steps={props.stages} compact />}
          {metrics ? <KeyCurve metrics={metrics} live /> : <Trail lines={props.trail} />}
        </div>
      )}
    </section>
  );
}

/** What it found, its figure, pass or fail, and the receipt. */
export function ResultCard({
  finding,
  verdict,
  success,
  figureId,
  metrics,
  receipt,
  state,
}: ItemSummaryProps) {
  return (
    <div className={`item-result is-${state}`}>
      {finding && <p className="item-finding">{finding}</p>}
      {figureId ? (
        <figure className="item-figure">
          <ArtifactFigure artifactId={figureId} alt={metrics?.metric ?? 'Key figure'} />
        </figure>
      ) : (
        metrics && <KeyCurve metrics={metrics} live={false} />
      )}
      {verdict && <Verdict verdict={verdict} success={success} />}
      <Receipt
        receipt={{
          ...receipt,
          costUsd: receipt.costUsd ?? metrics?.costUsd,
          machine: receipt.machine ?? metrics?.machine,
        }}
      />
    </div>
  );
}

/**
 * The compact card: mark, name, question, and its sparkline with the key value beside it, or,
 * ended, what it found. The list's row and the board's card both are this.
 */
export function ItemCard({
  name,
  kind,
  state,
  question,
  finding,
  verdict,
  metrics,
  at,
  to,
  onOpen,
  stage,
  aside,
  titleProps,
}: {
  /** What the name's button carries besides its words: a list's own hooks. */
  titleProps?: Record<string, string | undefined>;
  name: string;
  kind: 'experiment' | 'task';
  state: ItemState;
  question?: string;
  finding?: string;
  verdict?: 'pass' | 'fail';
  metrics?: ItemMetrics;
  at?: string;
  to?: string;
  onOpen?: () => void;
  stage?: string;
  aside?: ReactNode;
}) {
  const ended = state === 'done' || state === 'failed';
  const title = onOpen ? (
    <button
      type="button"
      {...titleProps}
      className={cx('item-card-name', titleProps?.className)}
      onClick={onOpen}
      title={name}
    >
      {name}
    </button>
  ) : to ? (
    <Link className="item-card-name" to={to} title={name}>
      {name}
    </Link>
  ) : (
    <span className="item-card-name">{name}</span>
  );
  return (
    <article className={`item-card is-${state}`} aria-label={`${name}, ${STATE_WORDS[state]}`}>
      <ItemMark state={state} />
      <div className="item-card-main">
        <div className="item-card-top">
          {title}
          {aside}
        </div>
        {ended && finding ? (
          <p className="item-card-line">
            {verdict && (
              <span
                className={`item-card-verdict is-${verdict}`}
                aria-label={verdict === 'pass' ? 'Passed' : 'Did not pass'}
              >
                {verdict === 'pass' ? '✓' : '✕'}
              </span>
            )}
            {finding}
          </p>
        ) : (
          question && <p className="item-card-line item-card-question">{question}</p>
        )}
        <p className="item-card-meta">
          <span>{kind === 'task' ? 'Task' : 'Experiment'}</span>
          <span>{ended ? STATE_WORDS[state] : (stage ?? STATE_WORDS[state])}</span>
          {at && <Ago at={at} />}
        </p>
      </div>
      {metrics && (
        <div className="item-card-curve">
          <Sparkline metrics={metrics} />
          <KeyValue metrics={metrics} />
        </div>
      )}
    </article>
  );
}

/** The figure an item kept, among its evidence or delivery files, by the path export gives it. */
export function figureOf(
  files: readonly { path?: string; title?: string; artifactId?: string; id?: string }[],
) {
  const found = [...files]
    .reverse()
    .find(
      (file) =>
        isMetricsFigure(file.path ?? file.title ?? '') &&
        !/\.svg$/i.test(file.path ?? file.title ?? ''),
    );
  return found ? (found.artifactId ?? found.id) : undefined;
}
