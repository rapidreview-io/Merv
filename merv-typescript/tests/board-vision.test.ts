import test from 'node:test';
import assert from 'node:assert/strict';
import { Drawing } from '../packages/board/src/elements.js';
import { BoardRenderer } from '../packages/board/src/renderer.js';
import { camera, viewSchema } from '../packages/contracts/src/board-view.js';
import { screenImage } from '../packages/pi/src/tool-image.js';
import { fit } from '../packages/pi/src/fit.js';
import { piResponsesSchema } from '../packages/pi/src/relay-schema.js';

test('camera fit, region, pan, zoom preserve a bounded board-coordinate viewport', () => {
  const bounds = { x: 10, y: 20, width: 200, height: 100 };
  const first = camera(bounds);
  assert.deepEqual(camera(bounds, first), first);
  assert.equal(camera(bounds, first, { action: 'pan', dx: 50, dy: 10 }).x, 20);
  assert.equal(camera(bounds, first, { action: 'zoom', factor: 2 }).width, 140);
  assert.deepEqual(camera(bounds, first, { action: 'region', x: 0, y: 0, width: 10, height: 20 }), {
    x: 0,
    y: 0,
    width: 10,
    height: 20,
  });
  assert.equal(camera(bounds, { ...first, width: 1 }, { action: 'zoom', factor: 4 }).width, 1);
  assert.equal(viewSchema.safeParse({ action: 'zoom', factor: 0 }).success, false);
});
test('image transport bypasses text clipping only for a bounded screen result', () => {
  const result = {
    seen: 'board',
    image: { mimeType: 'image/jpeg', data: Buffer.alloc(100000).toString('base64') },
  };
  assert.equal(fit('screen.look', result), result);
  assert.equal(fit('board.look', result), result);
  assert.notEqual(fit('board.read', result), result);
  assert.equal(
    screenImage({ ...result, image: { ...result.image, data: 'A'.repeat(700001) } }),
    null,
  );
  assert.equal(
    screenImage({ ...result, image: { ...result.image, data: 'https://example.com' } }),
    null,
  );
  const request = {
    model: 'gpt-6.1-sol',
    store: false,
    stream: true,
    input: [
      {
        type: 'function_call_output',
        call_id: 'c',
        output: [{ type: 'input_image', detail: 'auto', image_url: 'https://example.com' }],
      },
    ],
  };
  assert.equal(piResponsesSchema.safeParse(request).success, false);
});
test('actual Excalidraw exports native sketches and ordinary board shapes without mutating scene', async (t) => {
  const renderer = new BoardRenderer(process.env.MERV_TEST_CHROME);
  t.after(() => renderer.close());
  const d = new Drawing([], true);
  d.apply({ op: 'box', key: 'b', text: 'Hello board', at: [0, 0] });
  d.apply({
    op: 'sketch',
    key: 's',
    at: [300, 0],
    strokes: [{ path: 'M0 0 L100 0 L100 100', width: 'thin' }],
  });
  const elements = d.result();
  for (const fontFamily of [1, 2, 3, 6, 7, 8, 9]) {
    const text = elements.find((e) => e.type === 'text')!;
    elements.push({
      ...text,
      id: `font-${fontFamily}`,
      containerId: null,
      fontFamily,
      x: 0,
      y: 100 + fontFamily * 40,
      text: 'Font test 世界',
    });
  }
  const before = JSON.stringify(elements);
  const result = await renderer.render(elements);
  assert.equal(result.image.mimeType, 'image/jpeg');
  assert.equal(Buffer.from(result.image.data, 'base64')[0], 255);
  assert.ok(result.width <= 1600 && result.height <= 1600);
  const moved = await renderer.render(elements, result.viewport, { action: 'pan', dx: 100, dy: 0 });
  assert.equal(moved.viewport.x, result.viewport.x + 100);
  await assert.rejects(renderer.render(elements, undefined, undefined, 'missing'), /No shape/);
  assert.equal(JSON.stringify(elements), before);
  await (await (renderer as any).browser).close();
  assert.equal((await renderer.render(elements)).image.mimeType, 'image/jpeg');
});

test('render deadline closes the stuck page and next queued request can render', async (t) => {
  const renderer = new BoardRenderer(undefined, 20);
  t.after(() => renderer.close());
  let closed = 0;
  let pageNumber = 0;
  (renderer as any).browser = Promise.resolve({
    isConnected: () => true,
    close: async () => {},
    newPage: async () => {
      const first = ++pageNumber === 1;
      let calls = 0;
      return {
        setDefaultTimeout: () => {},
        route: async () => {},
        setContent: async () => {},
        addScriptTag: async () => {},
        close: async () => {
          closed++;
        },
        evaluate: async () => {
          calls++;
          if (calls === 1) return;
          if (calls === 2) return { x: 0, y: 0, width: 100, height: 100 };
          if (first) return new Promise(() => {});
          return { bytes: [255, 216, 255], pixels: { width: 180, height: 180 } };
        },
      };
    },
  });
  await assert.rejects(renderer.render([]), /took too long/);
  assert.equal(closed, 1);
  assert.equal((await renderer.render([])).image.data, '/9j/');
  assert.equal(closed, 2);
});
