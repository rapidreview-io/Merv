import { useEffect, useRef, type ReactNode } from 'react';
import { accountRequest } from '../api';
import { PageHeader, Word, col, cx, toneOf, useSidebarEscape } from '../components';
import { typing } from '../list-filters';
import { useCommand } from '../mutations';

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
/** A count a person reads at a glance: 940, 12.5K, 3.1M. */
export const count = (n: number) =>
  n.toLocaleString('en', { notation: 'compact', maximumFractionDigits: 1 });
/** A column whose row may not have its fact: the dash stands where it has none. */
export const fact = <T,>(key: string, label: string, render: (row: T) => ReactNode) =>
  col(key, label, (row: T) => render(row) ?? <None />);
/** A column of figures, where a row without its figure draws nothing. */
export const figure = <T,>(key: string, label: string, render: (row: T) => ReactNode) => ({
  ...col(key, label, render),
  num: true,
});
/** A column of figures, the dash standing where a row has none. */
export const fig = <T,>(key: string, label: string, render: (row: T) => ReactNode) =>
  figure(key, label, (row: T) => render(row) ?? <None />);
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

/** A list's drawer, open on the row `openId` names: Escape closes it, ↑ and ↓ open the row above
 *  or below, and closing hands the cursor back to the `selector` control (by its `data-id`) that
 *  opened it. */
export function useDrawer<T extends { id: string }>(
  rows: T[],
  openId: string | undefined,
  setOpen: (id?: string) => void,
  selector: string,
) {
  useSidebarEscape(!!openId, () => setOpen(undefined));
  const last = useRef<string>();
  // Where the open row stands: one that left the list (resolved, or filtered out) goes on from there.
  const at = useRef(-1);
  const index = rows.findIndex((row) => row.id === openId);
  if (index >= 0) at.current = index;
  useEffect(() => {
    if (!openId && last.current) {
      const names = [...document.querySelectorAll<HTMLElement>(selector)];
      (
        names.find((name) => name.dataset.id === last.current) ??
        names[Math.min(at.current, names.length - 1)]
      )?.focus();
    }
    last.current = openId;
  }, [openId, selector]);
  const held = useRef(rows);
  held.current = rows;
  useEffect(() => {
    if (!openId) return;
    const onKey = (event: KeyboardEvent) => {
      const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      if (!step || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      const index = held.current.findIndex((row) => row.id === openId);
      const next = held.current[index >= 0 ? index + step : at.current + Math.min(step, 0)];
      if (!next) return;
      event.preventDefault();
      setOpen(next.id);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openId, setOpen]);
}
