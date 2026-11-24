import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

// Real Excalidraw with the board page's own pen (Player) and stage, in Chromium; no user board is
// touched. A shape of a kind this page does not know, and one its code cannot take at all, come
// among ordinary ones: everything after them must still land, as the page's live view of a board
// must always reach what Board holds (the founder's board froze at revision ~379 of 460).
test('a shape the page cannot draw never stops what comes after it from landing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merv-converge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await build({
    stdin: {
      contents: `
    import React, {useState, useEffect} from 'react';
    import {createRoot} from 'react-dom/client';
    import {Excalidraw} from '@excalidraw/excalidraw';
    import {Player, stageOf} from './packages/ui/web/views/board-player';
    window.errors = [];
    addEventListener('error', (e) => window.errors.push(String(e.message)));
    addEventListener('unhandledrejection', (e) => window.errors.push(String(e.reason)));
    let n = 0;
    const shape = (type, extra = {}) => ({
      id: 'shape' + ++n, type, x: 40 + n * 70, y: 80, width: 60, height: 40, angle: 0,
      strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2,
      strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null,
      seed: n, version: 1, versionNonce: n, isDeleted: false, boundElements: null, updated: 1,
      link: null, locked: false, index: null, customData: { by: 'agent' }, ...extra,
    });
    // Code this page cannot take: reading it at all throws, as a shape from a newer Board might.
    const broken = () => {
      const el = shape('rectangle');
      Object.defineProperty(el, 'strokeColor', { enumerable: true, get() { throw new Error('cannot read this shape'); } });
      return el;
    };
    function App() {
      const [api, setApi] = useState(null);
      useEffect(() => {
        if (!api) return;
        const player = new Player(stageOf(api, () => false, () => {}, () => {}), document.getElementById('ink'), 45000);
        window.feed = (kind) => {
          const batch = kind === 'unknown' ? [shape('hologram'), shape('rectangle')]
            : kind === 'broken' ? [broken(), shape('ellipse')]
            : [shape('rectangle'), shape('diamond')];
          player.add(batch);
          return batch.map((el) => el.id);
        };
        window.waiting = () => player.waiting;
        window.live = () => api.getSceneElements().map((el) => ({ id: el.id, type: el.type, locked: el.locked, placeholder: el.customData?.placeholder }));
        window.ready = true;
      }, [api]);
      return <div style={{position: 'relative', width: 1000, height: 600}}>
        <Excalidraw excalidrawAPI={setApi}/>
        <canvas id="ink" style={{position: 'absolute', inset: 0, pointerEvents: 'none'}}/>
      </div>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `,
      resolveDir: resolve('.'),
      loader: 'tsx',
    },
    bundle: true,
    conditions: ['production'],
    outfile: join(dir, 'app.js'),
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.css': 'empty' },
    logLevel: 'silent',
  });
  const server = createServer((req, res) => {
    if (req.url === '/app.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(readFileSync(join(dir, 'app.js')));
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<body style="margin:0"><div id="root"></div><script src="/app.js"></script>');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  await page.addInitScript('window.__name = fn => fn');
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
  await page.waitForFunction('window.ready === true', null, { timeout: 30_000 });

  const fed: string[][] = [];
  for (const kind of ['plain', 'unknown', 'broken', 'plain', 'plain'])
    fed.push(await page.evaluate((k) => (window as any).feed(k), kind));
  await page.waitForFunction('window.waiting() === 0', null, { timeout: 60_000 });
  const live = (await page.evaluate(() => (window as any).live())) as {
    id: string;
    type: string;
    locked: boolean;
    placeholder?: string;
  }[];
  const ids = new Set(live.map((el) => el.id));
  const [, [unknown, afterUnknown], [broken, afterBroken], last1, last2] = fed as [
    string[],
    string[],
    string[],
    string[],
    string[],
  ];
  for (const id of [...fed[0]!, afterUnknown!, afterBroken!, ...last1!, ...last2!])
    assert.ok(ids.has(id), `${id} landed`);
  const standIn = live.find((el) => el.id === unknown);
  assert.ok(standIn, 'a kind this page does not know stands as a placeholder, where it is');
  assert.equal(standIn.type, 'rectangle');
  assert.equal(standIn.placeholder, 'hologram');
  assert.equal(standIn.locked, true, 'locked, so it is never saved back as a box');
  assert.ok(!ids.has(broken!), 'the one shape that cannot be read at all is left out, alone');
  assert.deepEqual(await page.evaluate(() => (window as any).errors), []);
});
