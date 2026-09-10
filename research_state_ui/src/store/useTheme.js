/**
 * Theme controller. Three modes: 'light' | 'dark' | 'system'.
 *
 * The effective theme lands on <html data-theme="...">, which is what
 * global.css keys its dark token set on. index.html runs the same
 * resolution pre-paint so a dark-mode reload never flashes light; this
 * module owns it from mount onward (including reacting to OS theme
 * changes while in 'system' mode).
 *
 * Persistence: explicit choices are stored under 'rsui:theme'; 'system'
 * is represented by the absence of the key.
 */
import { useCallback, useSyncExternalStore } from 'react';

// The toggle's cycle, shared by the desktop sidebar and the mobile shell.
export const NEXT_THEME_MODE = { light: 'dark', dark: 'system', system: 'light' };

const KEY = 'rsui:theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

function storedMode() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

let mode = storedMode();
const listeners = new Set();

function effectiveTheme() {
  return mode === 'system' ? (media.matches ? 'dark' : 'light') : mode;
}

function apply() {
  document.documentElement.dataset.theme = effectiveTheme();
  for (const fn of listeners) fn();
}

media.addEventListener('change', () => {
  if (mode === 'system') apply();
});

// Idempotent re-application at module load: index.html already set the
// attribute pre-paint, but this covers environments that skip that script.
apply();

export function setThemeMode(next) {
  mode = next === 'light' || next === 'dark' ? next : 'system';
  try {
    if (mode === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch {
    /* persistence is best-effort */
  }
  apply();
}

export function useTheme() {
  const subscribe = useCallback((fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  const themeMode = useSyncExternalStore(subscribe, () => mode);
  const theme = useSyncExternalStore(subscribe, effectiveTheme);
  return { mode: themeMode, theme, setMode: setThemeMode };
}
