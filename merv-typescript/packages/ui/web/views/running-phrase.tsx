import { createContext, useContext, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type {
  RunningMoney,
  RunningPhrase,
  RunningTarget,
  RunningValue,
} from '@merv/contracts/running';
import { CopyButton, cx, stamp, words } from '../components';
import { ArrowRightIcon, ExternalIcon } from '../icons';
import { clockOf, duration, elapsed, type Clock } from '../liveness';
import { formatMoney } from './remote-fields';

/**
 * The Running page's facts, written for a person. Owners send values — a state, an instant,
 * a count, money, an actor — and never a sentence about time: every clock here is read on
 * the server's own time, through the clock of the payload it arrived in, so no owner writes
 * '3 min ago' and no browser skew reaches a duration. Once that payload is older than its
 * cadence, the clocks stop at the moment it was read rather than counting on past it.
 * Nothing here prints an identifier: a key is only ever where a link goes.
 */
export interface RunningReading {
  /** The server's time, as the payload being drawn was read. */
  now: Clock;
  /** A person's or an agent's name, where this reader may see one. */
  nameOf(id: string): string | undefined;
  /**
   * Opens a key's sidebar. Inside an open sidebar the key is swapped for another in place,
   * so the page's history keeps one entry for it.
   */
  open(key: string): void;
}
export const Reading = createContext<RunningReading>({
  now: clockOf(0),
  nameOf: () => undefined,
  open: () => undefined,
});

/** Now, or — once the payload is stale — the moment it was read. */
const moment = (now: Clock) => (now.stale ? now.at - now.since : now.at);
const parsed = (at: string) => {
  const value = Date.parse(at);
  return Number.isFinite(value) ? value : undefined;
};
const amount = (money: RunningMoney | null | undefined) => {
  const value = money ? Number(money.amount) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
};
const moneyText = ({ money, of, rate }: Extract<RunningValue, { money: unknown }>) =>
  formatMoney(
    amount(money),
    amount(rate),
    money?.currency ?? rate?.currency ?? of?.currency ?? 'USD',
    amount(of),
  );
const actorText = (
  { actor, prefix = '', unnamed }: Extract<RunningValue, { actor: string }>,
  nameOf: (id: string) => string | undefined,
) => {
  const name = nameOf(actor);
  return name ? `${prefix}${name}` : (unnamed ?? '');
};

/** A value's words, as the page draws them. */
export function valueText(value: RunningValue, reading: Omit<RunningReading, 'open'>): string {
  if (typeof value === 'string') return value;
  const at = moment(reading.now);
  if ('mono' in value) return value.mono;
  if ('state' in value) return words(value.state);
  if ('ago' in value) {
    const then = parsed(value.ago);
    return then === undefined ? '' : `${elapsed(at - then)} ago`;
  }
  if ('since' in value) {
    const then = parsed(value.since);
    if (then === undefined) return '';
    return `${elapsed(at - then)}${value.of === undefined ? '' : ` of ${elapsed(value.of * 1000)}`}`;
  }
  if ('until' in value) {
    const then = parsed(value.until);
    if (then === undefined) return '';
    const left = `${duration(Math.max(0, then - at))} left`;
    return `${left}${value.of === undefined ? '' : ` · of ${elapsed(value.of * 1000)}`}`;
  }
  if ('count' in value)
    return value.of === undefined ? `${value.count}` : `${value.count} of ${value.of}`;
  if ('money' in value) return moneyText(value);
  if ('actor' in value) return actorText(value, reading.nameOf);
  return value.text;
}
/** A phrase's words, for a name a screen reader hears and for whether it says anything. */
export const phraseText = (
  phrase: RunningPhrase | undefined,
  reading: Omit<RunningReading, 'open'>,
): string =>
  (phrase ?? [])
    .map((value) => valueText(value, reading))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
/** A phrase that renders nothing — an actor this reader may not name, a missing instant. */
export const silent = (phrase: RunningPhrase | undefined, reading: Omit<RunningReading, 'open'>) =>
  !phraseText(phrase, reading);
/** Whether a value ticks: a phrase's clocks stand outside what a screen reader is told of a change. */
export const ticks = (value: RunningValue) =>
  typeof value === 'object' && ('ago' in value || 'since' in value || 'until' in value);

/**
 * Where a link goes. A key opens that thing's sidebar whether or not it is on the board;
 * a route is a page of this app, and an href opens outside it. The glyph that ends it is
 * the shell's, so no owner writes an arrow.
 */
export function Target({
  to,
  children,
  className,
}: {
  to: RunningTarget;
  children: ReactNode;
  className?: string;
}) {
  const { open } = useContext(Reading);
  if ('key' in to)
    return (
      <button
        type="button"
        className={cx('running-target', className)}
        onClick={() => open(to.key)}
      >
        {children}
        <ArrowRightIcon size={12} />
      </button>
    );
  if ('route' in to)
    return (
      <Link className={cx('running-target', className)} to={to.route}>
        {children}
        <ArrowRightIcon size={12} />
      </Link>
    );
  return (
    <a className={cx('running-target', className)} href={to.href} target="_blank" rel="noreferrer">
      {children}
      <ExternalIcon size={12} />
    </a>
  );
}

/** A clock, read on the payload's own time. */
function Clocked({ at, children }: { at: string; children: ReactNode }) {
  return (
    <time className="tabular" dateTime={at} title={stamp(at)}>
      {children}
    </time>
  );
}

/**
 * Time left, counting down to 0s. Colour on this page means a person is needed, and the
 * owner says when that is: a countdown near its end is not red of itself, so it is drawn in
 * the ink of the row it stands in. Once its read is stale it stops, and a sidebar says how
 * old it is; a card's face leaves that to the page's own stale line.
 */
function Until({
  value,
  aged,
}: {
  value: Extract<RunningValue, { until: string }>;
  aged: boolean;
}) {
  const { now } = useContext(Reading);
  const then = parsed(value.until);
  if (then === undefined) return <span className="ghost">—</span>;
  return (
    <span className="running-until">
      <Clocked at={value.until}>{duration(Math.max(0, then - moment(now)))} left</Clocked>
      {aged && now.stale && <span className="faint"> as of {elapsed(now.since)} ago</span>}
      {value.of !== undefined && ` · of ${elapsed(value.of * 1000)}`}
    </span>
  );
}

function Value({ value, in: place }: { value: RunningValue; in: 'facts' | 'line' | 'cell' }) {
  const reading = useContext(Reading);
  if (typeof value === 'string') return <>{value}</>;
  if ('mono' in value)
    return (
      <>
        <span className="mono">{value.mono}</span>
        {place === 'facts' && <CopyButton text={value.mono} />}
      </>
    );
  if ('state' in value) return <span className="running-state">{words(value.state)}</span>;
  if ('ago' in value || 'since' in value) {
    const at = 'ago' in value ? value.ago : value.since;
    const said = valueText(value, reading);
    return said ? <Clocked at={at}>{said}</Clocked> : null;
  }
  if ('until' in value) return <Until value={value} aged={place !== 'line'} />;
  if ('count' in value || 'money' in value)
    return <span className="tabular">{valueText(value, reading)}</span>;
  if ('actor' in value) return <>{actorText(value, reading.nameOf)}</>;
  // A card is one control, so a link on its face is its words; a sidebar follows it.
  return place === 'line' ? <>{value.text}</> : <Target to={value.link}>{value.text}</Target>;
}

/** A phrase, where it stands: on a card's face, in a sidebar's facts, or in a table's cell. */
export function Phrase({
  value,
  in: place = 'line',
}: {
  value: RunningPhrase;
  in?: 'facts' | 'line' | 'cell';
}) {
  return (
    <>
      {value.map((part, index) => (
        <Value key={index} value={part} in={place} />
      ))}
    </>
  );
}
