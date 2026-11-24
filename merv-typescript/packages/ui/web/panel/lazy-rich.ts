import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

type Job = { signal: AbortSignal; run: (signal: AbortSignal) => Promise<void> };
const pending = new Set<Job>();
let working = false;

/** One enrichment per idle turn, including its import. A long transcript never starts a burst. */
function drain() {
  if (working || !pending.size) return;
  working = true;
  const next = () => {
    const job = pending.values().next().value;
    if (job) pending.delete(job);
    Promise.resolve()
      .then(() => (job && !job.signal.aborted ? job.run(job.signal) : undefined))
      .catch(() => {
        /* Plain source remains readable after a failed optional enhancement. */
      })
      .finally(() => {
        working = false;
        drain();
      });
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(next, { timeout: 250 });
  else setTimeout(next, 32);
}

/** The source paints first. Offscreen content does no loading or parsing until it approaches view. */
function scheduleRichRender(element: Element, run: Job['run']): () => void {
  const controller = new AbortController();
  const job: Job = { signal: controller.signal, run };
  let painted = false,
    nearby = typeof IntersectionObserver === 'undefined',
    queued = false;
  let observer: IntersectionObserver | undefined;
  let frame: number | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const enqueue = () => {
    if (!painted || !nearby || queued || controller.signal.aborted) return;
    queued = true;
    observer?.disconnect();
    pending.add(job);
    drain();
  };
  if (!nearby) {
    observer = new IntersectionObserver(
      (entries) => {
        nearby = entries.some((entry) => entry.isIntersecting);
        enqueue();
      },
      { rootMargin: '240px' },
    );
    observer.observe(element);
  }
  const afterPaint = () => {
    painted = true;
    enqueue();
  };
  if (typeof requestAnimationFrame === 'function') {
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(afterPaint);
    });
  } else timer = setTimeout(afterPaint, 32);
  return () => {
    controller.abort();
    observer?.disconnect();
    pending.delete(job);
    if (frame !== undefined && typeof cancelAnimationFrame === 'function')
      cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
}

/** Keyed results cannot briefly display a previous streamed source while an effect catches up. */
export function useLazyRich<T>(
  key: string,
  run: (signal: AbortSignal) => Promise<T | undefined>,
  enabled = true,
) {
  const element = useRef<HTMLElement | null>(null);
  const task = useRef(run);
  const pendingCommit = useRef(false);
  task.current = run;
  const [result, setResult] = useState<{ key: string; value: T }>();
  useEffect(() => {
    if (!enabled || !element.current) return;
    const render = task.current;
    return scheduleRichRender(element.current, async (signal) => {
      const value = await render(signal);
      if (!signal.aborted && value !== undefined) {
        const node = element.current;
        node?.dispatchEvent(new CustomEvent('merv-rich-before-update', { bubbles: true }));
        pendingCommit.current = true;
        // Read, replaced and put back in one task: a scroll between them would be undone.
        flushSync(() => setResult({ key, value }));
        // A result that changed nothing on screen still closes what the announcement opened.
        if (pendingCommit.current) {
          pendingCommit.current = false;
          node?.dispatchEvent(new CustomEvent('merv-rich-after-update', { bubbles: true }));
        }
      }
    });
  }, [key, enabled]);
  // Ref attachment runs after DOM mutation, including when a streaming source replaces a result.
  const ref = useCallback(
    (node: HTMLElement | null) => {
      element.current = node;
      if (node && pendingCommit.current) {
        pendingCommit.current = false;
        node.dispatchEvent(new CustomEvent('merv-rich-after-update', { bubbles: true }));
      }
    },
    [result, key],
  );
  return { ref, value: result?.key === key ? result.value : undefined };
}
