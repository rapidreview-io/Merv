import { useEffect, useState } from 'react';

/**
 * A ticking clock, for the labels that age on screen: uptime, "expires in",
 * "5m ago". Returns epoch ms and re-renders the caller every `intervalMs`.
 *
 * A falsy `intervalMs` freezes the clock at its last value — pass one when
 * nothing on screen is moving, so an idle page does not re-render at 1Hz.
 */
export function useNow(intervalMs = 30000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!intervalMs) return undefined;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
