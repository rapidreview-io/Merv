import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { col, stamp, type Column } from '../components';
import { elapsed } from '../liveness';

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
/** A column of figures. */
export const fig = <T,>(key: string, label: string, render: (row: T) => ReactNode): Column<T> => ({
  ...col(key, label, render),
  num: true,
});
/** What a page counted, under its title: `3 running`, the count in ink, a bad one in red. */
export const Facts = ({ facts }: { facts: (false | [number, string, boolean?])[] }) => (
  <span className="lede-facts">
    {facts.map(
      (fact) =>
        fact && (
          <span key={fact[1]} className={fact[2] ? 'status--bad' : undefined}>
            <b>{fact[0]}</b> {fact[1]}
          </span>
        ),
    )}
  </span>
);
/** `used of limit`, the limit faint. */
export const Of = ({ used, of }: { used: ReactNode; of?: ReactNode }) => (
  <span>
    {used}
    {of !== undefined && of !== null && (
      <span className="faint">
        {' '}
        of{'\u00a0'}
        {of}
      </span>
    )}
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
