import { useEffect, useState } from 'react';

/** A link that dropped is nearly always back within a minute (a desk restart, a replaced link, a phone waking): for
 *  that minute nothing is said about it. This is what is shown only; sending, retrying and queueing are unchanged. */
export const QUIET_MS = 60_000;

/** Whether a link gone since `since` (a time, or none: since it was first seen gone here) has been gone over a minute,
 *  so its notice shows. Re-renders on its own when the minute is up; false the moment the link is back. */
export function useLongGone(gone: boolean, since?: string | number | null): boolean {
  const [seen, setSeen] = useState<number>();
  const [, tick] = useState(0);
  useEffect(() => {
    setSeen(gone ? Date.now() : undefined);
  }, [gone]);
  const given = typeof since === 'string' ? Date.parse(since) : (since ?? NaN);
  const from = Number.isFinite(given) ? given : (seen ?? Date.now());
  const left = from + QUIET_MS - Date.now();
  useEffect(() => {
    if (!gone || left < 0) return;
    const timer = setTimeout(() => tick((n) => n + 1), left + 1);
    return () => clearTimeout(timer);
  }, [gone, from]);
  return gone && left < 0;
}
