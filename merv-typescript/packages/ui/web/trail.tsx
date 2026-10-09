/**
 * The way back. The shell keeps the tab's own trail of addresses, each with the name its
 * page gave the tab, so a page's back control returns to wherever the reader came from —
 * Work, a task, a review, another file — and says its name, while no page or plugin has
 * to know who linked to it. A page opened cold (a pasted address, a new tab) has no trail
 * and goes back to the place it belongs to instead.
 */
import { useEffect, useSyncExternalStore, type MouseEvent } from 'react';
import { Link, useLocation, useNavigate, useNavigationType } from 'react-router-dom';

interface Step {
  /** The router's key for one entry of the tab's history. */
  key: string;
  path: string;
  /** What the page called itself in the tab's title. */
  title?: string;
}
const KEY = 'merv:trail';
const MOST = 100;
let steps: Step[] = [];
let at = -1;
try {
  const held = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
  if (Array.isArray(held?.steps) && Number.isInteger(held.at)) ({ steps, at } = held);
} catch {
  /* a trail for this page alone */
}
const listeners = new Set<() => void>();
const changed = () => {
  if (steps.length > MOST) {
    at -= steps.length - MOST;
    steps = steps.slice(-MOST);
  }
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ steps, at }));
  } catch {
    /* kept in memory */
  }
  for (const listener of listeners) listener();
};

/** Follows the tab's history; the shell mounts it once. */
export function useTrail() {
  const { key, pathname, search } = useLocation();
  const type = useNavigationType();
  useEffect(() => {
    const path = pathname + search;
    const known = steps.findIndex((step) => step.key === key);
    // Back, forward and a reload land on an entry already walked; a replace rewrites the
    // one the reader is on; anything else is a step forward that drops what lay ahead.
    if (known >= 0) at = known;
    else if (type === 'REPLACE' && at >= 0) steps[at] = { key, path };
    else {
      steps = [...steps.slice(0, at + 1), { key, path }];
      at = steps.length - 1;
    }
    changed();
  }, [key, pathname, search, type]);
  // The shell titles the tab from the page's heading; that first part names the step.
  useEffect(() => {
    const said = () => {
      const title = document.title.split(' · ')[0];
      if (steps[at] && title && steps[at]!.title !== title) {
        steps[at]!.title = title;
        changed();
      }
    };
    const watch = new MutationObserver(said);
    const element = document.querySelector('title');
    if (element) watch.observe(element, { childList: true, characterData: true, subtree: true });
    said();
    return () => watch.disconnect();
  }, []);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
/** Where this tab was before the page it is on, if it was anywhere in the app. */
export function usePrevious(): Step | undefined {
  useSyncExternalStore(subscribe, () => `${at}:${steps[at - 1]?.title ?? ''}`);
  return at > 0 ? steps[at - 1] : undefined;
}

/**
 * ← and the name of where the reader came from; a press goes back through the tab's own
 * history, so that page comes back as it was left. With no trail it goes to `home`.
 */
export function BackLink({ home, label }: { home: string; label: string }) {
  const previous = usePrevious();
  const navigate = useNavigate();
  const back = (event: MouseEvent) => {
    // A modified press opens the address elsewhere, as any link's does.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(-1);
  };
  return previous ? (
    <Link className="back-link" to={previous.path} onClick={back} title={previous.title}>
      ← {previous.title || label}
    </Link>
  ) : (
    <Link className="back-link" to={home}>
      ← {label}
    </Link>
  );
}
