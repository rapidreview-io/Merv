import type { MouseEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Loaded } from '../api';
import { Ago, LoadState, cx, stamp } from '../components';
import { elapsed } from '../liveness';

/** A page's title line: its name, what it counted, and the controls it opens at the end. */
export function Lede({
  title,
  facts,
  children,
}: {
  title: ReactNode;
  facts?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="page-lede admin-lede">
      <h1 className="lede-line">
        <span className="lede-here">{title}</span>
      </h1>
      {facts && <p className="lede-facts">{facts}</p>}
      {children && <div className="admin-lede-end">{children}</div>}
    </header>
  );
}

/**
 * Where a read stands when it has nothing to draw, or failed to refresh what it drew: the
 * skeleton, the server's refusal, or one faint line saying when the shown data arrived.
 */
export function Loading({ read, columns }: { read: Loaded<unknown>; columns: number }) {
  if (read.error && read.data !== undefined)
    return (
      <p className="faint admin-stale" title={`${read.error.message} (${read.error.code})`}>
        Could not refresh · {read.loadedAt ? <Ago at={read.loadedAt} /> : 'earlier'}
      </p>
    );
  if (read.error)
    return (
      <p className="error-message" role="alert">
        {read.error.message} <span className="mono">({read.error.code})</span>
      </p>
    );
  return <LoadState loading={read.loading} columns={columns} />;
}

/** The quiet control that reads a page again, for the pages that do not poll. */
export const Refresh = ({ read }: { read: Loaded<unknown> }) => (
  <button type="button" className="btn btn--quiet" onClick={read.reload}>
    Refresh
  </button>
);

/** Dollars as a table states them: two places, more where a sub-dime amount would read 0. */
export function usd(value: string | number | null | undefined): string {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) return '—';
  const places = n && Math.abs(n) < 0.1 ? 3 : 2;
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: places,
  });
}
/** A count a person reads at a glance: 940, 12.5k, 3.1M. */
export function count(n: number): string {
  const [div, unit] = n >= 1e6 ? [1e6, 'M'] : n >= 1e3 ? [1e3, 'k'] : [1, ''];
  const v = n / div;
  return `${unit && v < 100 ? +v.toFixed(1) : Math.round(v)}${unit}`;
}
/** `used of limit`, the limit faint. */
export const Of = ({ used, of }: { used: ReactNode; of?: ReactNode }) => (
  <>
    {used}
    {of !== undefined && of !== null && <span className="faint"> of {of}</span>}
  </>
);
/** A state word in its tone, with the dot every state word wears. */
export const Tone = ({
  tone,
  children,
  title,
}: {
  tone: string;
  children: ReactNode;
  title?: string;
}) => (
  <span className={cx('status', `status--${tone}`)} title={title}>
    <span className="status-dot" aria-hidden="true" />
    {children}
  </span>
);
/** A time still to come, as a row reads it: in 3h. */
export const In = ({ at }: { at: string }) => (
  <time dateTime={at} title={stamp(at)}>
    in {elapsed(Date.parse(at) - Date.now())}
  </time>
);
/** A fact the row does not have. */
export const None = () => <span className="ghost">—</span>;

/** Where a row goes: a drill-in is its own app, loaded whole; a page of this one is routed. */
export const Go = ({ to, children }: { to: string; children: ReactNode }) =>
  to.startsWith('/ui/') ? (
    <a className="admin-name" href={to}>
      {children}
    </a>
  ) : (
    <Link className="admin-name" to={to}>
      {children}
    </Link>
  );
/** A press anywhere on a row that is not on a control of its own is a press on its link. */
export function openRow(event: MouseEvent<HTMLElement>) {
  const pressed = event.target as HTMLElement;
  if (pressed.closest('a, button, input, select, summary') || window.getSelection()?.toString())
    return;
  event.currentTarget.querySelector<HTMLElement>('a.admin-name')?.click();
}
