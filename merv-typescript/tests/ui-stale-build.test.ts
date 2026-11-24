import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { holdStaleBuild, reloadStaleBuild, watchStaleBuild } from '../packages/ui/web/stale-build';

const html = (build: string) =>
  `<script type="module" src="/ui/assets/index-${build}.js"></script>`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function page(t: TestContext) {
  const cleanups: (() => void)[] = [];
  const after = (run: () => void) => {
    cleanups.push(run);
  };
  t.after(() => {
    for (const run of cleanups.reverse()) run();
  });
  const dom = new JSDOM(html('old'), { url: 'https://runmerv.com/ui/', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'DOMParser'] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
    after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  after(() => dom.window.close());
  return { win: dom.window, after };
}

test('a returned phone tab discovers a deploy without a missing chunk, waits for edits, and reloads once', async (t) => {
  const { win, after } = page(t);
  let build = 'old',
    reads = 0,
    reloads = 0,
    editing = true;
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, '/ui/');
    assert.equal(options.cache, 'no-store');
    reads++;
    return new Response(html(build), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  after(holdStaleBuild(() => editing));
  const stop = watchStaleBuild(true, () => {
    reloads++;
    return true;
  });
  after(stop);
  win.dispatchEvent(new win.Event('focus'));
  await settle();
  assert.equal(reads, 1);
  assert.equal(reloads, 0, 'same build stays');
  build = 'new';
  win.dispatchEvent(new win.Event('pageshow'));
  await settle();
  assert.equal(reads, 2);
  assert.equal(reloads, 0, 'unsaved work holds the update');
  editing = false;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(reloads, 1, 'safe tab takes the new code automatically');
  stop();
  win.dispatchEvent(new win.Event('focus'));
  await settle();
  assert.equal(reads, 2, 'unmount removes update listeners');
});

test('reload remains bounded when storage works and fails closed when storage is blocked', () => {
  const saved = new Map<string, string>();
  let reloads = 0;
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value);
    },
  };
  assert.equal(
    reloadStaleBuild(new Event('update'), storage, () => reloads++, 100_000),
    true,
  );
  assert.equal(
    reloadStaleBuild(new Event('update'), storage, () => reloads++, 100_001),
    false,
  );
  assert.equal(reloads, 1);
  assert.equal(
    reloadStaleBuild(
      new Event('update'),
      {
        getItem() {
          throw new Error('blocked');
        },
        setItem() {},
      },
      () => reloads++,
      200_000,
    ),
    false,
  );
});
