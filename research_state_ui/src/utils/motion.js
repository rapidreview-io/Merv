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
const REDUCED_MQ = '(prefers-reduced-motion: reduce)';

/** Has the reader asked for less motion? */
export function prefersReducedMotion() {
  return !!window.matchMedia?.(REDUCED_MQ).matches;
}

/** The live query, for the canvas that has to react when the setting changes. */
export function reducedMotionQuery() {
  return window.matchMedia(REDUCED_MQ);
}

export function motionMs(ms) {
  if (typeof window === 'undefined') return 0;
  if (typeof document !== 'undefined' && document.hidden) return 0;
  return prefersReducedMotion() ? 0 : ms;
}
