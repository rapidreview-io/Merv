/**
 * Backdrop visibility. Default on; storing 'off' under 'rsui:backdrop'
 * disables the ambient canvas entirely (the component unmounts, so a
 * disabled backdrop costs nothing). Same external-store idiom as useTheme.
 */
import { createStore } from './createStore';

const KEY = 'rsui:backdrop';

const store = createStore((() => {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
})());

export function setBackdrop(next) {
  const on = !!next;
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, 'off');
  } catch {
    /* persistence is best-effort */
  }
  store.set(on);
}

export function useBackdrop() {
  return store.use();
}
