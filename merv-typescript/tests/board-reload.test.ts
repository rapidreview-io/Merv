import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { geometry } from './fixtures/board-geometry.js';
import { Drawing } from '../packages/board/src/elements.js';
import { boardFontManifest } from '../scripts/board-font-manifest.mjs';

// Runs the actual BoardCanvas against an in-memory API; browser font loads are deliberately slow.
test('BoardCanvas waits for fonts and preserves text metrics across cold reload and warm remount', async (t) => {
  const fonts = boardFontManifest();
  const directory = mkdtempSync(join(tmpdir(), 'board-reload-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const require = createRequire(import.meta.url),
    native = require.resolve('@excalidraw/excalidraw');
  const bundle = join(directory, 'test.js');
  await build({
    stdin: {
      contents: `import React from 'react';import{createRoot}from'react-dom/client';import{MemoryRouter}from'react-router-dom';import BoardCanvas from './packages/ui/web/views/board-canvas.tsx';const root=createRoot(document.getElementById('root'));window.mount=()=>root.render(React.createElement(MemoryRouter,null,React.createElement(BoardCanvas,{id:'board_test'})));window.unmount=()=>root.render(null);window.mount();`,
      resolveDir: process.cwd(),
    },
    outfile: bundle,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'empty', '.woff2': 'dataurl' },
    plugins: [
      {
        name: 'board-test-dependencies',
        setup(b) {
          b.onResolve({ filter: /^@excalidraw\/excalidraw\/index\.css$/ }, () => ({
            path: 'css',
            namespace: 'mock',
          }));
          b.onResolve({ filter: /^virtual:board-fonts$/ }, () => ({
            path: 'font-manifest',
            namespace: 'mock',
          }));
          b.onResolve({ filter: /^@excalidraw\/excalidraw$/ }, (args) =>
            args.importer.endsWith('board-canvas.tsx')
              ? { path: 'native-wrapper', namespace: 'mock' }
              : undefined,
          );
          b.onResolve(
            { filter: /^(\.\.\/api|\.\.\/navigation|\.\.\/theme|\.\/pi-screen)$/ },
            (args) =>
              args.importer.endsWith('board-canvas.tsx')
                ? { path: args.path, namespace: 'mock' }
                : undefined,
          );
          b.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
            loader: 'js',
            resolveDir: process.cwd(),
            contents:
              path === 'css'
                ? ''
                : path === 'font-manifest'
                  ? 'export default ' +
                    JSON.stringify(
                      fonts.map(({ family, url, range }: any) => ({ family, url, range })),
                    )
                  : path === 'native-wrapper'
                    ? `import React from'react';import*as Native from ${JSON.stringify(native)};export*from ${JSON.stringify(native)};export const Excalidraw=props=>React.createElement(Native.Excalidraw,{...props,excalidrawAPI:api=>{window.boardApi=api;props.excalidrawAPI(api)}});`
                    : path === '../api'
                      ? `export async function call(name,input){if(name==='board.scene')return{board:{id:'board_test',revision:1},elements:input.since?window.delta.splice(0):structuredClone(window.saved)};if(name==='board.save'){for(const e of input.elements){const i=window.saved.findIndex(x=>x.id===e.id);if(i<0)window.saved.push(e);else window.saved[i]=structuredClone(e)}return{accepted:input.elements.length}}throw Error(name)}`
                      : path === '../navigation'
                        ? 'export const useRows=()=>[];'
                        : path === '../theme'
                          ? `export const onWorn=()=>()=>{};export const worn=()=>window.testTheme||'light';`
                          : 'export const placeOf=async()=>"unused";',
          }));
        },
      },
    ],
    logLevel: 'silent',
  });
  const d = new Drawing([], true);
  d.apply({
    op: 'text',
    text: 'Interpretability + steering: from ideas to reliable control',
    size: 'l',
  });
  d.apply({
    op: 'box',
    shape: 'diamond',
    at: [0, 200],
    text: 'Café readiness: does the owner have a recovery plan?',
    color: 'yellow',
  });
  d.apply({
    op: 'box',
    shape: 'ellipse',
    at: [0, 700],
    text: 'MMMM WWWW: explicit\nnewlines stay intact',
    color: 'green',
  });
  d.apply({ op: 'note', text: 'Note: 한국어', at: [1200, 200] });
  d.apply({ op: 'link', text: 'Reference', target: 'https://example.com', at: [1200, 600] });
  d.apply({
    op: 'flow',
    at: [0, 1500],
    nodes: [
      { key: 'a', text: 'Start' },
      { key: 'b', text: 'Done' },
    ],
    edges: [{ from: 'a', to: 'b' }],
  });
  const supplied = process.env.MERV_BOARD_RELOAD_FIXTURE;
  const source = supplied ? JSON.parse(readFileSync(supplied, 'utf8')) : null;
  const saved = source?.body?.result?.elements ?? [...d.elements.values()];
  const browser = await chromium.launch({
    executablePath: process.env.MERV_TEST_CHROME,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const font = fonts.find((f: any) => f.url === url.pathname);
    if (font) {
      await new Promise((r) => setTimeout(r, 80));
      return route.fulfill({ body: readFileSync(font.path), contentType: 'font/woff2' });
    }
    if (url.pathname === '/test.js')
      return route.fulfill({ body: readFileSync(bundle), contentType: 'text/javascript' });
    if (url.pathname === '/style.css')
      return route.fulfill({
        body: readFileSync(resolve('node_modules/@excalidraw/excalidraw/dist/prod/index.css')),
        contentType: 'text/css',
      });
    return route.fulfill({
      contentType: 'text/html',
      body: `<html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="root" style="height:950px"></div><script>window.saved=${JSON.stringify(saved)};window.delta=[];</script><script src="/test.js"></script></body></html>`,
    });
  });
  const metrics = () =>
    page
      .evaluate(() =>
        (globalThis as any).boardApi
          .getSceneElements()
          .filter((e: any) => e.type === 'text')
          .map((e: any) => ({
            id: e.id,
            text: e.text,
            originalText: e.originalText,
            width: e.width,
            height: e.height,
            fontFamily: e.fontFamily,
          })),
      )
      .then((x) => x.sort((a: any, b: any) => a.id.localeCompare(b.id)));
  await page.goto('http://board.test/');
  await page.waitForFunction(() => !!(globalThis as any).boardApi);
  await page.waitForTimeout(200);
  const cold = await metrics();
  const verifyGlyphs = async () => {
    const measured = await page.evaluate(() => {
      const family: Record<number, string> = {
        1: 'Virgil',
        2: 'Helvetica',
        3: 'Cascadia',
        5: 'Excalifont',
        6: 'Nunito',
        7: 'Lilita One',
        8: 'Comic Shanns',
        9: 'Liberation Sans',
      };
      const ctx = document.createElement('canvas').getContext('2d')!;
      return (globalThis as any).boardApi
        .getSceneElements()
        .filter((e: any) => e.type === 'text')
        .map((e: any) => {
          ctx.font = `${e.fontSize}px "${family[e.fontFamily]}", "Xiaolai"`;
          return {
            id: e.id,
            width: e.width,
            measured: Math.max(
              ...e.text.split('\n').map((line: string) => ctx.measureText(line).width),
            ),
            loaded: document.fonts.check(`${e.fontSize}px "${family[e.fontFamily]}"`, e.text),
          };
        });
    });
    for (const m of measured) {
      assert.ok(m.loaded, `font ready ${m.id}`);
      assert.ok(
        Math.abs(m.width - m.measured) < 1.1,
        `glyph width ${m.id}: ${m.width} vs ${m.measured}`,
      );
    }
  };
  await verifyGlyphs();
  const restored = await page.evaluate(() => (globalThis as any).boardApi.getSceneElements());
  if (!supplied) assert.deepEqual(geometry(restored), []);

  assert.equal(cold.length, saved.filter((e: any) => e.type === 'text').length);
  for (const e of cold) {
    const original = saved.find((s: any) => s.id === e.id);
    assert.equal(e.originalText, original.originalText);
  }
  await page.evaluate(() => {
    (globalThis as any).unmount();
  });
  await page.waitForTimeout(30);
  await page.evaluate(() => {
    (globalThis as any).boardApi = null;
    (globalThis as any).mount();
  });
  await page.waitForFunction(() => !!(globalThis as any).boardApi);
  await page.waitForTimeout(200);
  assert.deepEqual(await metrics(), cold, 'warm remount');
  await page.reload();
  await page.waitForFunction(() => !!(globalThis as any).boardApi);
  await page.waitForTimeout(200);
  assert.deepEqual(await metrics(), cold, 'cold reload');
  await verifyGlyphs();
  // A parent-only delta must retain the label held locally; a subsequent label-only
  // font edit must load the new family before full-scene binding repair/measurement.
  const target = restored.find(
    (e: any) =>
      e.type === 'text' &&
      e.containerId &&
      restored.find((p: any) => p.id === e.containerId && p.type !== 'arrow'),
  );
  const parent = restored.find((e: any) => e.id === target.containerId);
  await page.evaluate((body: any) => {
    (globalThis as any).delta.push({ ...body, version: body.version + 20, versionNonce: 1234 });
  }, parent);
  await page.waitForTimeout(1800);
  const afterParent = await page.evaluate(() => (globalThis as any).boardApi.getSceneElements());
  assert.ok(
    afterParent
      .find((e: any) => e.id === parent.id)
      .boundElements.some((b: any) => b.id === target.id),
  );
  await page.evaluate((label: any) => {
    (globalThis as any).delta.push({
      ...label,
      fontFamily: 6,
      version: label.version + 40,
      versionNonce: 4321,
    });
  }, target);
  await page.waitForTimeout(1800);
  const afterLabel = await page.evaluate(() => (globalThis as any).boardApi.getSceneElements());
  const changed = afterLabel.find((e: any) => e.id === target.id);
  assert.equal(changed.fontFamily, 6);
  assert.equal(changed.originalText, target.originalText);
  assert.equal(changed.containerId, parent.id);
  assert.ok(
    afterLabel
      .find((e: any) => e.id === parent.id)
      .boundElements.some((b: any) => b.id === target.id),
  );
  await verifyGlyphs();
  await page.reload();
  await page.waitForFunction(() => !!(globalThis as any).boardApi);
  await page.waitForTimeout(200);
  if (process.env.MERV_BOARD_RELOAD_OUTPUT) {
    const output = process.env.MERV_BOARD_RELOAD_OUTPUT;
    writeFileSync(
      output + '.json',
      JSON.stringify(
        {
          textMetrics: cold,
          elements: await page.evaluate(() => (globalThis as any).boardApi.getSceneElements()),
        },
        null,
        2,
      ),
    );
    await page.screenshot({ path: output + '-light.png' });
    await page.evaluate(() => {
      (globalThis as any).boardApi.updateScene({ appState: { theme: 'dark' } });
    });
    await page.waitForTimeout(100);
    await page.screenshot({ path: output + '-dark.png' });
  }
});
