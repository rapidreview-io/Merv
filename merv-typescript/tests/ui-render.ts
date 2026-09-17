/**
 * The repository's first render harness: a jsdom document, a clock that can be
 * moved, and a fixture server behind the real fetch layer.
 *
 * Nothing here replaces a module. The views run their own `api.ts` — its
 * keep-the-last-good-answer, its visibility gate, its scope fencing — against a
 * server this file can make flap, so "a failed poll must not blank the list" and
 * "the countdown must not outrun its data" are testable as behaviour rather than
 * as the shape of a function. The clock is shifted rather than faked, so the
 * timers a view installs keep running while the time they read jumps.
 *
 * Globals are installed as this module is evaluated, before React or any view is
 * loaded, because `list-filters.tsx` reads `window.matchMedia` at module scope.
 * That is why every consumer imports this module first and everything else with
 * a dynamic import.
 */
import { JSDOM } from 'jsdom';
import type { ReactElement } from 'react';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const win = dom.window as unknown as Window & Record<string, unknown>;
const define = (key: string, value: unknown) => {
  try {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  } catch {
    /* a runtime that will not surrender the name keeps its own */
  }
};
win.matchMedia = ((query: string) => ({
  matches: true,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
})) as unknown as Window['matchMedia'];
for (const key of [
  'window',
  'document',
  'navigator',
  'location',
  'history',
  'Element',
  'HTMLElement',
  'HTMLButtonElement',
  'HTMLAnchorElement',
  'HTMLInputElement',
  'SVGElement',
  'Node',
  'NodeList',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'KeyboardEvent',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'sessionStorage',
  'localStorage',
])
  define(key, (win as Record<string, unknown>)[key]);
define('IS_REACT_ACT_ENVIRONMENT', true);

/** A clock that moves without stopping the timers that read it. */
const Real = Date;
let offset = 0;
class Shifted extends Real {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(...args: any[]) {
    if (args.length === 0) super(Real.now() + offset);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    else super(...(args as [any]));
  }
  static now() {
    return Real.now() + offset;
  }
}
define('Date', Shifted);

/** What the fixture server answers: a response, or a connection that drops. */
export type Reply = { status?: number; body?: unknown } | { network: true };
const handlers = new Map<string, (call: number) => Reply>();
const counts = new Map<string, number>();
/** Every request the views made, newest last, as `METHOD path`. */
export const requests: string[] = [];
export const serve = (path: string, reply: Reply | ((call: number) => Reply)) =>
  handlers.set(path, typeof reply === 'function' ? reply : () => reply);
define('fetch', async (input: unknown, init: { method?: string } = {}) => {
  const path = String(input);
  requests.push(`${init.method ?? 'GET'} ${path}`);
  const call = (counts.get(path) ?? 0) + 1;
  counts.set(path, call);
  const reply = handlers.get(path)?.(call) ?? {
    status: 404,
    body: { error: { code: 'no_fixture', message: `No fixture for ${path}` } },
  };
  if ('network' in reply) throw new TypeError('fetch failed');
  const status = reply.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: `HTTP ${status}`,
    json: async () => reply.body,
  };
});

// The test runner compiles these .tsx views with the classic JSX transform, which
// names `React` in every rendered file; the bundler uses the automatic one. The
// global is how the two agree without a second build configuration.
define('React', await import('react'));
const { createRoot } = await import('react-dom/client');
const { act } = await import('react-dom/test-utils');
type Root = ReturnType<typeof createRoot>;

let root: Root | undefined;
let host: HTMLElement | undefined;

/** Let React, the pending fetches and any timer due within `ms` finish. */
export const settle = async (ms = 0) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};
/** Move the clock the views read, then let what that changed render. */
export const jump = async (ms: number, thenWait = 1200) => {
  offset += ms;
  await settle(thenWait);
};
export async function mount(element: ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(element);
  });
  await settle(0);
}
export async function unmount(): Promise<void> {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  handlers.clear();
  counts.clear();
  requests.length = 0;
  offset = 0;
}
/** What a person reads on the page, which is what every assertion here is about. */
export const text = (): string => host?.textContent ?? '';
export async function click(label: string): Promise<void> {
  const control = [...(host?.querySelectorAll('button') ?? [])].find((button) =>
    (button.textContent ?? '').includes(label),
  );
  if (!control) throw new Error(`No control reading “${label}”. Page: ${text().slice(0, 600)}`);
  await act(async () => {
    control.click();
  });
  await settle(0);
}
