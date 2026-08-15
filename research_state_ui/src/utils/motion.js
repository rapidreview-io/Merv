/**
 * One answer to "how long should this animate?", for every graph canvas.
 *
 * Two cases collapse a duration to zero, and both used to be handled ad hoc:
 * the OS reduced-motion setting (the map honoured it, nobody else did), and a
 * hidden tab (WaveFigure/WaveFlow honoured that, the map did not). The hidden
 * case matters because animated react-flow moves ride requestAnimationFrame,
 * which browsers throttle to "never" in a background tab — an animated camera
 * move started there parks half-way and never arrives.
 */
export function motionMs(ms) {
  if (typeof window === 'undefined') return 0;
  if (typeof document !== 'undefined' && document.hidden) return 0;
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : ms;
}

/** Convenience for react-flow's `{ duration }` option bag. */
export function motionOpts(ms) {
  return { duration: motionMs(ms) };
}
