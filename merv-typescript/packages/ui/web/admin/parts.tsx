import type { ReactNode } from 'react';
import { accountRequest } from '../api';
import { PageHeader, Word, col, cx, toneOf, type Column } from '../components';
import { useCommand } from '../mutations';
import { formatMoney } from '../views/remote-fields';

/** A POST to an /admin route (`path`, the rest its body), sent whole again on a retry: each
 *  body names its own id or is the whole change, so a retry is the same write. */
export const usePost = <T = { id?: unknown },>(
  done: (result: T) => void,
  validate: (result: T) => boolean = (r) => typeof (r as { id?: unknown })?.id === 'string',
) =>
  useCommand<T>({
    tool: 'admin',
    idempotent: true,
    send: ({ path, ...body }) => accountRequest(String(path), { method: 'POST', body }),
    validate,
    onSuccess: done,
  });
/** Dollars as every page states them (`formatMoney`). */
export const usd = (value: string | number) => formatMoney(Number(value), undefined);
/** A count a person reads at a glance: 940, 12.5K, 3.1M. */
export const count = (n: number) =>
  n.toLocaleString('en', { notation: 'compact', maximumFractionDigits: 1 });
/** A column whose row may not have its fact: the dash stands where it has none. */
export const fact = <T,>(key: string, label: string, render: (row: T) => ReactNode) =>
  col(key, label, (row: T) => render(row) ?? <None />);
/** The same, for a column of figures. */
export const fig = <T,>(key: string, label: string, render: (row: T) => ReactNode): Column<T> => ({
  ...fact(key, label, render),
  num: true,
});
/** A page's title, and what it counted under it: `3 running`, the count in ink, a bad one in red. */
export const Head = (props: { title: string; facts?: Fact[]; ends?: ReactNode }) => (
  <PageHeader
    title={props.title}
    actions={props.ends}
    summary={
      props.facts && (
        <span className="lede-facts">
          {props.facts.map(
            (fact) =>
              fact && (
                <span key={fact[1]} className={cx(fact[2] && 'status--bad')}>
                  <b>{fact[0]}</b> {fact[1]}
                </span>
              ),
          )}
        </span>
      )
    }
  />
);
type Fact = false | [count: number, noun: string, bad?: boolean];
/** `used of limit`, the limit faint. */
export const Of = (props: { used: ReactNode; of?: ReactNode; className?: string }) => (
  <span className={props.className}>
    {props.used}
    {props.of != null && <span className="faint"> of&nbsp;{props.of}</span>}
  </span>
);
/** A fact the row does not have. */
export const None = () => <span className="ghost">—</span>;
/** A unit's state: in its need's tone while it waits on someone, else in its word's own, and a
 *  word no table knows is work under way until the unit has ended. */
export const State = (props: { value: string; ended?: boolean; need?: string | false }) => (
  <Word
    tone={props.need || toneOf(props.value).replace('neutral', props.ended ? 'dim' : 'warn')}
    value={props.value}
  />
);
