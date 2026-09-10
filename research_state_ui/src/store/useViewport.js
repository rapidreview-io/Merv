import { createStore } from './createStore';

/**
 * Surface gate: decides whether the app renders the mobile shell or the
 * desktop sidebar shell. Module-level singleton + useSyncExternalStore,
 * same pattern as useTheme.
 *
 * Auto-detection is capability + smaller-screen-dimension, not current
 * width alone: a touch-first device whose smaller screen side is phone-sized
 * stays on the mobile shell even rotated to landscape, while an iPad stays
 * on desktop. A narrow window on any device also gets the mobile shell —
 * the desktop shell (260px sidebar + 1120px stage) is unusable there.
 *
 * localStorage 'rsui:surface' = 'mobile' | 'desktop' overrides detection
 * (the More-sheet "Use desktop layout" escape hatch for tablets and
 * disagreements).
 */
const SURFACE_KEY = 'rsui:surface';
const COARSE_MQ = '(pointer: coarse)';
const PHONE_MIN_DIM = 768;
const NARROW_VIEWPORT = 700;

function readOverride() {
  try { return localStorage.getItem(SURFACE_KEY) || null; } catch { return null; }
}

function compute() {
  if (typeof window === 'undefined') return false;
  const override = readOverride();
  if (override === 'mobile') return true;
  if (override === 'desktop') return false;
  let coarse = false;
  try { coarse = window.matchMedia(COARSE_MQ).matches; } catch {}
  const minScreenDim = Math.min(
    window.screen?.width || Infinity,
    window.screen?.height || Infinity,
  );
  const coarsePhone = coarse && minScreenDim <= PHONE_MIN_DIM;
  return coarsePhone || window.innerWidth <= NARROW_VIEWPORT;
}

const store = createStore(compute());

function emit() {
  const next = compute();
  if (next !== store.get()) store.set(next);
}

if (typeof window !== 'undefined') {
  window.addEventListener('resize', emit);
  window.addEventListener('orientationchange', emit);
  // Override changed from another tab / devtools.
  window.addEventListener('storage', emit);
  try { window.matchMedia(COARSE_MQ).addEventListener('change', emit); } catch {}
}

export function useViewport() {
  return store.use();
}

export function setSurfaceOverride(mode) {
  try {
    if (mode) localStorage.setItem(SURFACE_KEY, mode);
    else localStorage.removeItem(SURFACE_KEY);
  } catch {}
  emit();
}
