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

const busy = new Set<() => boolean>();
/** Keep a stale tab until its live work and unsaved edits are safe to leave. */
export function holdStaleBuild(check: () => boolean) {
  busy.add(check);
  return () => {
    busy.delete(check);
  };
}

const [BOARD_RELOADED, BOARD_ONCE_MS] = ['merv:stale-board-reload', 10 * 60_000];
/** The watcher's way in, while one watches: it waits for what holds the tab, as a missing chunk does. */
let report: ((event: Event) => void) | undefined;
/**
 * The page holds code that can no longer take in what Board sends (a release changed it while the
 * page stayed open): it loads the new build once nothing is being edited, as for a missing chunk.
 */
export function reloadWhenSafe(
  storage: Pick<Storage, 'getItem' | 'setItem'> = sessionStorage,
  now = Date.now(),
) {
  // A board the new build cannot take in either must not reload over and over: once in a while.
  try {
    if (now - Number(storage.getItem(BOARD_RELOADED) ?? 0) < BOARD_ONCE_MS) return false;
    storage.setItem(BOARD_RELOADED, String(now));
  } catch {
    return false;
  }
  const event = new Event('merv:stale-board');
  if (report) report(event);
  else reloadStaleBuild(event);
  return true;
}

export function watchStaleBuild(safe = false, reload = reloadStaleBuild) {
  let pending: Event | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false,
    checking = false;
  // Settings and inline editors can own work outside chat's draft store. Leave an
  // open editor alone, even after blur; the next ordinary view can take the update.
  const editing = () =>
    !!document.querySelector('[contenteditable="true"]') ||
    !!document.activeElement?.matches('input, textarea, select') ||
    Array.from(document.querySelectorAll('textarea')).some((field) => !!field.value);
  const attempt = () => {
    clearTimeout(timer);
    if (!pending) return;
    if (safe && (editing() || [...busy].some((check) => check()))) {
      timer = setTimeout(attempt, 250);
      return;
    }
    reload(pending);
    pending = undefined;
  };
  const stale = (event: Event) => {
    if (!safe) {
      reload(event);
      return;
    }
    pending = event;
    attempt();
  };
  // Let the board flush its saves before considering a hidden tab.
  const hidden = () => {
    if (document.hidden && pending) {
      clearTimeout(timer);
      timer = setTimeout(attempt, 0);
    }
  };
  // An already loaded chat may never ask for another lazy chunk. Compare the page's
  // assets with the current HTML too: immutable assets are correct, but open tabs age.
  const build = (doc: Document) => {
    const entry = doc
      .querySelector<HTMLScriptElement>('script[type="module"][src]')
      ?.getAttribute('src');
    if (!entry?.startsWith('/ui/assets/')) return undefined;
    return [
      entry,
      ...Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'), (link) =>
        link.getAttribute('href'),
      ),
    ].join('\n');
  };
  const loaded = build(document);
  const check = async () => {
    if (!loaded || stopped || checking || pending || document.hidden) return;
    checking = true;
    try {
      const response = await fetch('/ui/', {
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return;
      const current = build(new DOMParser().parseFromString(await response.text(), 'text/html'));
      if (!stopped && current && current !== loaded) stale(new Event('merv:stale-build'));
    } catch {
      /* Offline or deploying: check again when the page returns. */
    } finally {
      checking = false;
    }
  };
  const interval = setInterval(() => void check(), ONCE_MS);
  window.addEventListener('focus', check);
  window.addEventListener('online', check);
  window.addEventListener('pageshow', check);
  document.addEventListener('visibilitychange', check);
  window.addEventListener('vite:preloadError', stale);
  document.addEventListener('visibilitychange', hidden);
  report = stale;
  return () => {
    stopped = true;
    if (report === stale) report = undefined;
    clearTimeout(timer);
    clearInterval(interval);
    window.removeEventListener('focus', check);
    window.removeEventListener('online', check);
    window.removeEventListener('pageshow', check);
    document.removeEventListener('visibilitychange', check);
    window.removeEventListener('vite:preloadError', stale);
    document.removeEventListener('visibilitychange', hidden);
  };
}
