/**
 * A project's main thread, on the web or a phone: the one conversation the person's own desktop
 * agent and Merv cloud both continue. The words are the page. While their Mac has the thread it
 * is read here; while the Mac is away, what they write is answered by Merv cloud.
 */
import { useEffect, useRef, useState } from 'react';
import { call, refreshTools, useTool } from '../api';
import { Markdown } from '../markdown';
import type { ViewProps } from './index';

interface Item {
  seq: number;
  engine: string;
  kind: 'person' | 'answer' | 'ready';
  text: string;
  at?: string;
}
interface Point {
  step: number;
  values: Record<string, number>;
}
/** An experiment as the person's Mac last reported it. */
interface Card {
  id: string;
  at: string;
  body: {
    title?: string;
    why?: string;
    state?: 'proposed' | 'starting' | 'running' | 'done' | 'failed' | 'stopped';
    status?: string;
    gpu?: string;
    minutes?: number;
    estimate?: number;
    cost?: number;
    result?: string;
    code?: string;
    points?: Point[];
  };
}
interface Page {
  items: Item[];
  cards?: Card[];
  engine: 'mac' | 'cloud';
  available: boolean;
}

const dollars = (cost: number) => `$${cost.toFixed(2)}`;
const short = (value: number) => Number(value.toPrecision(4)).toString();
const INKS = ['currentColor', '#c0392b', '#8a6d00'];

/** Every metric on one scale, as a line each. */
function Curve({ points }: { points: Point[] }) {
  const series = new Map<string, [number, number][]>();
  let left = Infinity,
    right = -Infinity,
    low = Infinity,
    high = -Infinity;
  for (const { step, values } of points)
    for (const [name, value] of Object.entries(values)) {
      if (!Number.isFinite(step) || !Number.isFinite(value)) continue;
      series.set(name, [...(series.get(name) ?? []), [step, value]]);
      left = Math.min(left, step);
      right = Math.max(right, step);
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
  if (!series.size) return null;
  const x = (step: number) => (right === left ? 4 : 4 + (340 * (step - left)) / (right - left));
  const y = (value: number) => (high === low ? 45 : 84 - (78 * (value - low)) / (high - low));
  return (
    <figure className="main-curve">
      <svg viewBox="0 0 348 90" role="img" aria-label="Metrics by step">
        {[...series].map(([name, samples], i) => (
          <path
            key={name}
            d={samples
              .sort((a, b) => a[0] - b[0])
              .map(
                ([step, value], j) =>
                  `${j ? 'L' : 'M'}${x(step).toFixed(1)},${y(value).toFixed(1)}`,
              )
              .join(' ')}
            fill="none"
            stroke={INKS[i % INKS.length]}
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </svg>
      <figcaption>
        {[...series].map(([name, samples], i) => (
          <span key={name} style={{ color: INKS[i % INKS.length] }}>
            {name} {short(samples.at(-1)![1])}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/** One experiment: its plan before it runs, its curve while it runs, its result after. */
function ExperimentCard({ card }: { card: Card }) {
  const { title, why, state, status, gpu, minutes, estimate, cost, result, code, points } =
    card.body;
  const live = state === 'starting' || state === 'running';
  const plan = [
    gpu && gpu !== 'none' ? gpu : 'CPU',
    minutes !== undefined && `about ${minutes} min`,
    estimate !== undefined && `about ${dollars(estimate)}`,
  ]
    .filter(Boolean)
    .join(' · ');
  const receipt = [
    cost !== undefined && (live ? `${dollars(cost)} so far` : `Cost ${dollars(cost)}`),
    !live && code && `code ${code.slice(0, 7)}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <article className="main-card" aria-label={title}>
      <h3>{title}</h3>
      {state === 'proposed' ? (
        <>
          {why && <p>{why}</p>}
          <p className="main-mark">{plan} · press Run on your Mac</p>
        </>
      ) : (
        <>
          <p className={live ? 'main-live' : undefined}>
            {live ? status || 'Running' : result || status}
          </p>
          <Curve points={points ?? []} />
          {receipt && <p className="main-mark">{receipt}</p>}
        </>
      )}
    </article>
  );
}

export function MainThreadView(_: ViewProps) {
  const page = useTool<Page>('main.read', { action: 'page', page: {} }, { every: 3000 });
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState<string>();
  const [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const items = page.data?.items ?? [];
  // Words and experiments in the order they happened.
  const rows = [
    ...items.map((item) => ({ at: item.at ?? '', item })),
    ...(page.data?.cards ?? []).map((card) => ({ at: card.at, card })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const last = items.at(-1)?.seq;
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [last, sending]);
  const mac = page.data?.engine === 'mac';

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(text);
    setDraft('');
    setError('');
    try {
      await call('main.write', { action: 'say', say: { text, requestId: crypto.randomUUID() } });
      refreshTools('main.read');
    } catch (failed) {
      setDraft(text);
      setError((failed as Error).message);
    } finally {
      setSending(undefined);
    }
  }

  return (
    <div className="main-thread">
      <p className="main-engine" data-engine={page.data?.engine}>
        <i aria-hidden="true" />
        {page.data ? (mac ? 'Your Mac' : 'Merv cloud') : ''}
      </p>
      <div className="main-lines">
        {rows.map((row) => {
          if ('card' in row) return <ExperimentCard key={'card:' + row.card.id} card={row.card} />;
          const item = row.item;
          return item.kind === 'ready' ? (
            <p key={item.seq} className="main-mark">
              {item.text}
            </p>
          ) : item.kind === 'person' ? (
            <p key={item.seq} className="main-said">
              {item.text}
            </p>
          ) : (
            <div key={item.seq} className="main-answer">
              {item.engine === 'pi' && <span className="main-by">Merv cloud</span>}
              <Markdown source={item.text} />
            </div>
          );
        })}
        {sending && (
          <>
            <p className="main-said">{sending}</p>
            <p className="main-mark">Merv cloud is answering…</p>
          </>
        )}
        {page.data && !rows.length && !sending && (
          <p className="main-mark">Nothing said yet. Start on your Mac, or here.</p>
        )}
        <div ref={end} />
      </div>
      {error && (
        <p className="main-mark main-error" role="alert">
          {error}
        </p>
      )}
      <form
        className="main-reply"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={draft}
          rows={1}
          placeholder={mac ? 'Your Mac has this conversation' : 'Reply…'}
          disabled={mac || !!sending || page.data?.available === false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
      </form>
    </div>
  );
}
