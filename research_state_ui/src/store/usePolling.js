import { useCallback, useEffect, useRef, useState } from 'react';
import { useProjectStore } from './useProjectStore';

/**
 * Poll GET /home every `intervalMs` while:
 *   - a projectId is set
 *   - `enabled` (the SSE stream is not covering us)
 *   - document.visibilityState === 'visible'
 *
 * Pauses on tab-hide, resumes on tab-show (with an immediate refresh so the
 * user never sees stale state right after returning to the tab). Flipping
 * `enabled` back on also refreshes immediately — it means the stream just
 * dropped, so the poller must catch whatever the stream would have pushed.
 */
export function usePolling(intervalMs = 3000, { enabled = true } = {}) {
  const projectId = useProjectStore(s => s.projectId);
  const refreshHome = useProjectStore(s => s.refreshHome);
  const setPolling = useProjectStore(s => s.setPolling);
  const intervalRef = useRef(null);

  useEffect(() => {
    if (!projectId || !enabled) {
      setPolling(false);
      return undefined;
    }

    let cancelled = false;

    const start = () => {
      if (intervalRef.current) return;
      setPolling(true);
      intervalRef.current = setInterval(() => {
        if (!cancelled) refreshHome();
      }, intervalMs);
    };
    const stop = () => {
      if (!intervalRef.current) return;
      clearInterval(intervalRef.current);
      intervalRef.current = null;
      setPolling(false);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        refreshHome();
        start();
      } else {
        stop();
      }
    };

    // Kick once immediately + start polling if visible.
    refreshHome();
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [projectId, intervalMs, enabled, refreshHome, setPolling]);
}

/**
 * Call `fn` now, then every `intervalMs` while the tab is visible — the plain
 * poll a page runs for its own endpoint, next to usePolling's /home loop and
 * useStreamAwarePoll's stream-aware one. `fn` must be memoized by the caller.
 *
 * `enabled: false` stops the timer (the poll is off, not the page); pass
 * `immediate: false` when the caller already fetches on its own.
 */
export function useIntervalPoll(fn, intervalMs, { enabled = true, immediate = true } = {}) {
  useEffect(() => {
    if (immediate) fn();
    if (!enabled) return undefined;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') fn();
    }, intervalMs);
    return () => clearInterval(t);
  }, [fn, intervalMs, enabled, immediate]);
}

/**
 * setState updater that keeps the previous value when the poll returned the
 * same thing, so an unchanged payload re-renders nothing downstream.
 */
export const keepIfUnchanged = (next) => (prev) => (
  JSON.stringify(prev) === JSON.stringify(next) ? prev : next
);

/**
 * One fetch per key change, with the in-flight answer dropped when the key
 * moves first. Returns `[data, error]` — both null while the fetch is in
 * flight, so a caller shows its loading state on `!data && !error`. A null
 * `fetcher` means "nothing to fetch yet" and leaves both null.
 */
export function useAsyncData(fetcher, deps) {
  const [state, setState] = useState([null, null]);
  useEffect(() => {
    setState([null, null]);
    if (!fetcher) return undefined;
    let cancelled = false;
    Promise.resolve().then(fetcher).then(
      (data) => { if (!cancelled) setState([data, null]); },
      (err) => { if (!cancelled) setState([null, err?.message || String(err)]); },
    );
    return () => { cancelled = true; };
  }, deps);
  return state;
}

/**
 * A workflow record's status document, refetched on demand. An unchanged
 * payload keeps its state identity, so an idle poll tick re-renders nothing
 * (the same guard the figure uses on its own document). Returns
 * `[data, error, refetch, reset]`; `reset` blanks it when the caller moves to
 * another record without unmounting.
 */
export function useRecordStatus(fetcher, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const lastJson = useRef(null);
  const refetch = useCallback(async () => {
    try {
      const next = await fetcher();
      const json = JSON.stringify(next);
      if (lastJson.current !== json) {
        lastJson.current = json;
        setData(next);
      }
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, deps);
  const reset = useCallback(() => { lastJson.current = null; setData(null); }, []);
  return [data, error, refetch, reset];
}
