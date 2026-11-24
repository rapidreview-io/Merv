import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { BoardRenderer } from '../packages/board/src/renderer.js';
import { deferred } from './fixtures/deferred.js';
import type { BoardElement } from '../packages/board/src/models.js';

const executable = process.env.MERV_TEST_CHROMIUM ?? chromium.executablePath();
const fonts = new URL('../packages/board/dist/fonts.json', import.meta.url);
const available =
  fs.existsSync(executable) &&
  fs.existsSync(fonts) &&
  fs.existsSync(new URL('../packages/board/dist/renderer.js', import.meta.url));

test(
  'unicode subsets export exactly the full font manifest pixels across scripts and defaults',
  {
    skip: available
      ? false
      : 'Build renderer assets and provide Chrome via MERV_TEST_CHROMIUM to run this integration check',
  },
  async (t) => {
    const manifest = JSON.parse(fs.readFileSync(fonts, 'utf8')) as {
      family: string;
      data: string;
      range?: string;
    }[];
    const fullBytes = JSON.stringify(manifest).length;
    // The baseline injects the original complete manifest at the actual browser transfer boundary.
    // Everything else, including font loading, fresh pages, layout and export, is production code.
    let baseline = true;
    let transferred = { records: 0, bytes: 0 };
    const launch = chromium.launch.bind(chromium);
    t.mock.method(chromium, 'launch', async (...args: Parameters<typeof chromium.launch>) => {
      assert.deepEqual(
        [args[0]?.handleSIGINT, args[0]?.handleSIGTERM, args[0]?.handleSIGHUP],
        [false, false, false],
        'application shutdown owns browser signals',
      );
      const browser = await launch({ ...args[0], headless: true });
      const newPage = browser.newPage.bind(browser);
      t.mock.method(browser, 'newPage', async (...options: Parameters<typeof browser.newPage>) => {
        const page = await newPage(...options);
        const evaluate = page.evaluate.bind(page);
        t.mock.method(page, 'evaluate', async (fn: any, input: any) => {
          if (Array.isArray(input?.fonts)) {
            assert.deepEqual(
              input.families,
              [...new Set(manifest.map((font) => font.family))],
              'font loading still visits every original family',
            );
            if (baseline) input = { ...input, fonts: manifest };
            transferred = {
              records: input.fonts.length,
              bytes: JSON.stringify(input.fonts).length,
            };
          }
          return evaluate(fn, input);
        });
        return page;
      });
      return browser;
    });
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const handlers = signals.map((signal) => process.listeners(signal));
    const renderer = new BoardRenderer(executable);
    t.after(() => renderer.close());
    const shape = (
      id: string,
      type: string,
      extra: Record<string, unknown> = {},
    ): BoardElement => ({
      id,
      type,
      x: 0,
      y: 0,
      width: 500,
      height: 60,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      seed: 1,
      ...extra,
    });
    const text = (
      value: string,
      family: number | undefined = 5,
      extra: Record<string, unknown> = {},
    ) =>
      shape('text', 'text', {
        text: value,
        originalText: value,
        fontFamily: family,
        fontSize: 24,
        lineHeight: 1.25,
        ...extra,
      });
    const scenes: Record<string, BoardElement[]> = {
      multilingual: [text('Hello café Ελληνικά Привет 中文 한국어 😀 العربية')],
      bound: [
        shape('box', 'rectangle', {
          width: 180,
          height: 120,
          boundElements: [{ id: 'text', type: 'text' }],
        }),
        text('e\u0301 한글 wrapping a bound text label', 5, {
          containerId: 'box',
          width: 170,
          height: 100,
        }),
      ],
    };
    for (const [name, scene] of Object.entries(scenes)) {
      baseline = true;
      const full = await renderer.render(
        scene,
        undefined,
        undefined,
        undefined,
        undefined,
        1_000_000,
      );
      assert.equal(transferred.bytes, fullBytes);
      baseline = false;
      const at = performance.now();
      const subset = await renderer.render(
        scene,
        undefined,
        undefined,
        undefined,
        undefined,
        1_000_000,
      );
      assert.deepEqual(
        subset,
        full,
        `${name}: PNG bytes, viewport and dimensions match all-font export`,
      );
      assert.ok(
        transferred.bytes < fullBytes / 5,
        `${name}: the transfer actually omits unused subsets`,
      );
      t.diagnostic(
        `${name}: ${transferred.records}/${manifest.length} font records, ${transferred.bytes}/${fullBytes} bytes, ${(performance.now() - at).toFixed(1)}ms`,
      );
    }
    assert.deepEqual(
      signals.map((signal) => process.listeners(signal)),
      handlers,
      'the board renderer installs no process-wide shutdown handlers',
    );
  },
);

test('queued exports share their deadline instead of each adding another render timeout', async (t) => {
  // Hold an existing export while three more requests arrive in the queue.
  const first = deferred();
  const renderer = new BoardRenderer(undefined, 60_000);
  renderer['queue'] = first.promise;
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const pending = Array.from({ length: 3 }, () =>
    assert.rejects(renderer.render([]), { code: 'board_render_timeout' }),
  );
  now += 60_001;
  first.resolve();
  await Promise.all(pending);
  await renderer.close();
});

for (const stalled of ['setup', 'cleanup', 'images'])
  test(`queued callers time out while browser ${stalled} remains stalled`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    const entered = deferred(),
      release = deferred<any>();
    const renderer = new BoardRenderer(undefined, 60_000);
    let draws = 0;
    renderer['fonts'] = [];
    const page = {
      setDefaultTimeout() {},
      route: async () => {},
      setContent: async () => {},
      addScriptTag: async () => {},
      evaluate: async (_fn: unknown, input: any) => {
        if (input.mimeType) {
          draws++;
          return { bytes: [1], pixels: { width: 10, height: 10 } };
        }
        return input.elements ? { x: 0, y: 0, width: 10, height: 10 } : undefined;
      },
      close: async () => {
        if (stalled === 'cleanup') {
          entered.resolve();
          await release.promise;
        }
      },
    };
    renderer['browser'] = Promise.resolve({
      isConnected: () => true,
      close: async () => {},
      newPage: async () => {
        if (stalled === 'setup') {
          entered.resolve();
          await release.promise;
        }
        return page;
      },
    } as any);
    const images =
      stalled === 'images'
        ? async () => {
            entered.resolve();
            await release.promise;
            return {};
          }
        : undefined;
    const pending = Array.from({ length: 3 }, () =>
      assert.rejects(renderer.render([], undefined, undefined, undefined, images), {
        code: 'board_render_timeout',
      }),
    );
    await entered.promise;
    t.mock.timers.tick(60_000);
    await Promise.all(pending);
    // A fresh export recovers before the stalled transport completes.
    const recovered = { ...page, close: async () => {} };
    renderer['browser'] = Promise.resolve({
      isConnected: () => true,
      close: async () => {},
      newPage: async () => recovered,
    } as any);
    assert.equal((await renderer.render([])).width, 10);
    const beforeRelease = draws;
    release.resolve(undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      draws,
      beforeRelease,
      'cancelled image reads never serialize or draw after their deadline',
    );
    await renderer['queue'];
    await renderer.close();
  });

test('recovery refuses another browser while two retired processes remain alive', async (t) => {
  const renderer = new BoardRenderer(undefined, 60_000);
  renderer['fonts'] = [];
  const first = deferred(),
    second = deferred();
  renderer['retiring'].add(first.promise);
  renderer['retiring'].add(second.promise);
  let launches = 0;
  t.mock.method(chromium, 'launch', async () => {
    launches++;
    throw new Error('must not launch');
  });
  await assert.rejects(renderer.render([]), { code: 'board_renderer_unavailable' });
  assert.equal(launches, 0);
  first.resolve();
  second.resolve();
  await renderer.close();
});
