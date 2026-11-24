import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

// Real BoardPages, styles, React reconciliation and Chromium frames; no user board is changed.
for (const mode of ['desktop-same-origin', 'desktop-external', 'web-external'])
  test(`live cards preserve their visible document through interaction, idle and loading (${mode})`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'merv-page-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    await build({
      stdin: {
        contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {BoardPages} from './packages/ui/web/views/board-pages';
    let elements=[{id:'card',version:1,x:100,y:100,width:800,height:500,customData:{browser:(location.search.includes('external')?location.origin.replace('127.0.0.1','localhost'):location.origin)+'/content'}}];
    let state={scrollX:0,scrollY:0,zoom:{value:1},offsetLeft:0,offsetTop:0,width:1200,height:900,selectedElementIds:{}};
    const listeners=new Set();
    const api={getSceneElements:()=>elements,getAppState:()=>state,onChange:fn=>{listeners.add(fn);return ()=>listeners.delete(fn)},updateScene:next=>{elements=next.elements??elements;listeners.forEach(fn=>fn(elements,state))}};
    window.change=(x=0,width=800,height=500,zoom=1)=>{state={...state,scrollX:x,zoom:{value:zoom}};elements=elements.map(el=>({...el,width,height,version:el.version+1}));listeners.forEach(fn=>fn(elements,state))};
    const root=createRoot(document.getElementById('root'));
    window.renderCards=n=>{
      elements=Array.from({length:n},(_,i)=>({id:'card'+i,version:1,x:100+i*900,y:100,width:800,height:500,customData:{browser:location.origin.replace('127.0.0.1','localhost')+'/content'}}));
      root.render(n ? <BoardPages key={n} api={api} board="board"/> : null);
    };
    root.render(<BoardPages api={api} board="board"/>);
  `,
        resolveDir: resolve('.'),
        loader: 'tsx',
      },
      bundle: true,
      outfile: join(dir, 'app.js'),
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
    });
    let requests = 0;
    const server = createServer((req, res) => {
      if (req.url === '/content') {
        requests++;
        res.setHeader('Content-Type', 'text/html');
        setTimeout(
          () =>
            res.end(
              '<body style="background:#ffd43b"><input value="kept"><b id="tick">0</b><script>let n=0;setInterval(()=>document.querySelector("b").textContent=++n,50)</script>',
            ),
          300,
        );
        return;
      }
      if (req.url === '/app.js' || req.url === '/app.css') {
        res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css');
        res.end(readFileSync(join(dir, req.url.slice(1))));
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<link rel="stylesheet" href="/app.css"><div id="root"></div><script>window.shots=0;if(!location.search.includes("web-"))window.mervApp={onPage(){},pages(){},snap:async()=>{window.shots++;return "data:image/png;base64,fixture"}}</script><script src="/app.js"></script>',
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    t.after(
      () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    );
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.addInitScript(() => {
      (window as any).__name = (fn: unknown) => fn;
      const registrations: { target: EventTarget; type: string; fn: unknown; capture: boolean }[] =
        [];
      const add = EventTarget.prototype.addEventListener,
        remove = EventTarget.prototype.removeEventListener;
      const activity = new Set([
        'pointermove',
        'pointerdown',
        'pointerup',
        'pointercancel',
        'click',
        'wheel',
        'focusin',
        'focusout',
        'visibilitychange',
        'pointerleave',
        'merv:pages-visible',
        'blur',
        'focus',
      ]);
      const capture = (options: any) =>
        typeof options === 'boolean' ? options : !!options?.capture;
      EventTarget.prototype.addEventListener = function (type, fn, options) {
        if (
          (this === document || this === window) &&
          activity.has(type) &&
          !registrations.some(
            (r) =>
              r.target === this && r.type === type && r.fn === fn && r.capture === capture(options),
          )
        )
          registrations.push({ target: this, type, fn, capture: capture(options) });
        const target = this;
        if (typeof options === 'object')
          options?.signal?.addEventListener(
            'abort',
            () => {
              const i = registrations.findIndex(
                (r) =>
                  r.target === target &&
                  r.type === type &&
                  r.fn === fn &&
                  r.capture === capture(options),
              );
              if (i >= 0) registrations.splice(i, 1);
            },
            { once: true },
          );
        return add.call(this, type, fn, options);
      };
      EventTarget.prototype.removeEventListener = function (type, fn, options) {
        const i = registrations.findIndex(
          (r) =>
            r.target === this && r.type === type && r.fn === fn && r.capture === capture(options),
        );
        if (i >= 0) registrations.splice(i, 1);
        return remove.call(this, type, fn, options);
      };
      (window as any).listenerCount = () => registrations.length;
    });
    await page.goto(`http://127.0.0.1:${(server.address() as any).port}/?${mode}`);
    if (mode === 'web-external') {
      assert.equal(requests, 0, 'unopened web pages cost no renderer or network work');
      await page.evaluate(() => {
        (window as any).canvasWheels = 0;
        document.body.addEventListener('wheel', () => (window as any).canvasWheels++);
      });
      await page.mouse.move(1150, 850);
      await page.mouse.down();
      await page.mouse.move(300, 300, { steps: 10 });
      await page.waitForTimeout(1200);
      assert.equal(
        await page.locator('.is-live').count(),
        0,
        'a drag across a page never activates it',
      );
      assert.equal(requests, 0);
      await page.mouse.up();
      await page.mouse.move(1150, 850);
      await page.mouse.move(300, 300);
      for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, 10);
        await page.waitForTimeout(250);
      }
      assert.equal(
        await page.evaluate(() => (window as any).canvasWheels),
        5,
        'the canvas receives every wheel event',
      );
      assert.equal(await page.locator('.is-live').count(), 0, 'trackpad scrolling resets dwell');
      await page.mouse.move(1150, 850);
      await page.mouse.move(300, 300);
      await page.waitForTimeout(650);
      assert.equal(await page.locator('.is-live').count(), 0);
      await page.waitForTimeout(500);
      assert.equal(await page.locator('.is-live').count(), 1, 'one second of rest activates');
      await page.mouse.move(1150, 850);
      await page.mouse.wheel(0, 10);
      await page.waitForFunction(() => !document.querySelector('.is-live'), undefined, {
        timeout: 500,
      });
      assert.equal(
        await page.locator('.is-live').count(),
        0,
        'canvas wheel revokes grace-period input immediately',
      );
      await page.mouse.move(300, 300);
      await page.mouse.wheel(0, 10);
      assert.equal(
        await page.locator('.is-live').count(),
        0,
        'crossing during canvas scrolling cannot grab the wheel',
      );
      await page.waitForTimeout(1300);
      assert.equal(await page.locator('.is-live').count(), 1);
      await page.mouse.move(1150, 850);
      await page.waitForTimeout(1150);
      assert.equal(await page.locator('.is-live').count(), 0, 'leaving releases input after grace');
      const original = await page.locator('iframe').evaluate((el: HTMLIFrameElement) => {
        (window as any).heldFrame = el;
        return el.src;
      });
      await page.mouse.click(300, 300);
      assert.equal(
        await page.locator('.is-live').count(),
        1,
        'a deliberate click activates without a dwell',
      );
      assert.equal(
        await page.evaluate(() => document.activeElement?.tagName),
        'BODY',
        'the activation click never reaches the frame',
      );
      assert.equal(await page.locator('iframe').getAttribute('src'), original);
      assert.equal(
        await page.evaluate(() => document.querySelector('iframe') === (window as any).heldFrame),
        true,
      );
    } else {
      await page.mouse.move(300, 300);
      await page.waitForTimeout(1100);
    }
    const frame = page.frameLocator('iframe');
    await frame.locator('input').waitFor();
    await frame.locator('input').fill('preserved state');
    await page.locator('input[aria-label="Address"]').focus();
    await page.mouse.move(1190, 890);
    await page.waitForTimeout(2800);
    assert.equal(
      await page.locator('iframe').evaluate((el) => getComputedStyle(el).visibility),
      'visible',
      'idle must not swap the live document for captured board pixels',
    );
    const first = await frame.locator('#tick').textContent();
    await page.evaluate(() => {
      (window as any).original = document.querySelector('iframe');
    });
    for (const args of [
      [10, 800, 500, 1],
      [-400, 800, 500, 1],
      [-2000, 800, 500, 1],
      [0, 900, 600, 0.7],
      [20, 800, 500, 1],
    ]) {
      await page.evaluate((args) => (window as any).change(...args), args);
      await page.waitForTimeout(80);
      assert.equal(
        await page.evaluate(() => document.querySelector('iframe') === (window as any).original),
        true,
      );
      assert.equal(await frame.locator('input').inputValue(), 'preserved state');
      assert.equal(
        await page.locator('iframe').evaluate((el) => getComputedStyle(el).visibility),
        'visible',
      );
    }
    await page.getByRole('button', { name: 'Full screen', exact: true }).click();
    await page.getByRole('button', { name: 'Exit full screen', exact: true }).click();
    assert.equal(
      await page.evaluate(() => document.querySelector('iframe') === (window as any).original),
      true,
    );
    assert.notEqual(await frame.locator('#tick').textContent(), first);
    assert.equal(requests, 1, 'board interaction never navigates');
    assert.equal(await page.evaluate(() => (window as any).shots), 0);
    const pixels = (await page.locator('iframe').screenshot()).toString('base64');
    const center = await page.evaluate(async (png) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      return [...ctx.getImageData(image.width / 2, image.height / 2, 1, 1).data];
    }, pixels);
    assert.deepEqual(
      center,
      [255, 212, 59, 255],
      'the live page is actually painted after interaction',
    );
    assert.equal(
      await page.frames()[1]!.evaluate(() => {
        try {
          localStorage.getItem('x');
          return false;
        } catch {
          return true;
        }
      }),
      mode === 'desktop-same-origin',
      'only same-origin frames lose access to their own storage',
    );
    await page.getByRole('button', { name: 'Reload', exact: true }).click();
    await frame.locator('input').waitFor();
    assert.equal(await frame.locator('input').inputValue(), 'kept');
    assert.equal(requests, 2, 'explicit reload still creates a new document');
    if (mode === 'desktop-external') {
      const counts: Record<string, number> = {};
      for (const n of [0, 2, 0, 40, 0, 40, 0]) {
        await page.evaluate((n) => (window as any).renderCards(n), n);
        await page.waitForFunction(
          (n) => document.querySelectorAll('.canvas-page').length === n,
          n,
        );
        await page.waitForTimeout(50);
        const count = await page.evaluate(() => (window as any).listenerCount());
        if (n === 0 && counts.empty !== undefined)
          assert.equal(count, counts.empty, 'unmount returns all activity listeners');
        if (n === 40 && counts['40'] !== undefined)
          assert.equal(count, counts['40'], 'remount does not leak activity listeners');
        counts[n === 0 ? 'empty' : String(n)] = count;
      }
      console.log('P1 listeners', JSON.stringify(counts));
      assert.ok(counts['2']! - counts.empty! <= 13);
      assert.equal(
        counts['40']! - counts.empty!,
        counts['2']! - counts.empty!,
        'one board tracker regardless of card count',
      );
      await page.evaluate(() => (window as any).renderCards(2));
      await page.waitForFunction(() => document.querySelectorAll('.canvas-page').length === 2);
      await page.waitForTimeout(50);
      await page.mouse.move(300, 300);
      await page.waitForTimeout(1100);
      await page.getByRole('button', { name: 'Full screen', exact: true }).first().click();
      await page.evaluate(() => {
        (document.activeElement as HTMLElement)?.blur();
        window.dispatchEvent(new CustomEvent('merv:pages-visible', { detail: false }));
      });
      await page.waitForFunction(() => !document.querySelector('.is-live'));
      await page.evaluate(() =>
        window.dispatchEvent(new CustomEvent('merv:pages-visible', { detail: true })),
      );
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.mouse.click(1300, 400);
      await page.waitForTimeout(1100);
      assert.equal(
        await page.locator('.is-full.is-live').count(),
        1,
        'full screen receives activation ahead of a later card behind it',
      );
      assert.equal(await page.locator('.canvas-page:not(.is-full).is-live').count(), 0);
    }
  });
