/**
 * A page left open across a release asks for code the release renamed (Vite hashes every lazy
 * chunk), and the server no longer has it: a diagram, a highlighter or a page then fails with
 * "Failed to fetch dynamically imported module". The page loads the new build instead, once a
 * minute at most, so a chunk that is truly missing still shows its error rather than looping.
 */
const RELOADED = 'merv:stale-build-reload';
const ONCE_MS = 60_000;

export function reloadStaleBuild(
  event: Event,
  storage: Pick<Storage, 'getItem' | 'setItem'> = sessionStorage,
  reload: () => void = () => window.location.reload(),
  now = Date.now(),
): boolean {
  try {
    if (now - Number(storage.getItem(RELOADED) ?? 0) < ONCE_MS) return false;
    storage.setItem(RELOADED, String(now));
  } catch {
    return false;
  }
  event.preventDefault();
  reload();
  return true;
}

export const watchStaleBuild = () =>
  window.addEventListener('vite:preloadError', (event) => void reloadStaleBuild(event));
