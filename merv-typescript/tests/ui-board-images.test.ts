import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const source = readFileSync(
  new URL('../packages/ui/web/views/board-player.ts', import.meta.url),
  'utf8',
);
const tree = ts.createSourceFile('board-player.ts', source, ts.ScriptTarget.Latest, true);
let body = '';
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'imageBringer')
    body = node.initializer!.getText(tree);
  ts.forEachChild(node, visit);
}
visit(tree);
const settle = async () => {
  for (let n = 0; n < 15; n++) await Promise.resolve();
};
function fixture() {
  const requests: { id: string; resolve(value: unknown): void; reject(error: unknown): void }[] =
    [];
  const held: Record<string, any> = {};
  const retries = new Map<number, () => void>();
  let timer = 0;
  const state = { scrollX: 0, scrollY: 0, zoom: { value: 1 }, width: 1000, height: 800 };
  const bring = runInNewContext(ts.transpile(`(${body})`, { target: ts.ScriptTarget.ES2022 }), {
    accountRequest: (id: string) =>
      new Promise((resolve, reject) => requests.push({ id, resolve, reject })),
    imageAt: (id: string) => id,
    fileOf: (el: any) => (el.type === 'image' ? el.fileId : null),
    getDataURL: async () => 'data:image/png;base64,fixture',
    Date,
    AbortSignal,
    setTimeout: (fn: () => void) => {
      retries.set(++timer, fn);
      return timer;
    },
    clearTimeout: (id: number) => retries.delete(id),
  })(
    {
      getAppState: () => state,
      getSceneElements: () => [image(1)],
      getFiles: () => held,
      addFiles: (rows: any[]) => rows.forEach((row) => (held[row.id] = row)),
    },
    undefined,
    true,
  );
  return { requests, held, state, bring, retries };
}
const image = (i: number, x = 0) => ({
  id: `shape-${i}`,
  type: 'image',
  fileId: `image-${i}`,
  x,
  y: 0,
  width: 100,
  height: 100,
});
test('images stay lazy until visible, load four at a time, and reuse bytes', async () => {
  const f = fixture(),
    elements = Array.from({ length: 10 }, (_, i) => image(i));
  f.bring([...elements, image(99, 10000)], f.held);
  assert.equal(f.requests.length, 4);
  f.bring(elements, f.held);
  assert.equal(f.requests.length, 4);
  f.requests[0].resolve({ type: 'image/png' });
  await settle();
  assert.equal(f.requests.length, 5);
  assert.ok(f.held['image-0']);
  f.bring(elements, f.held);
  assert.equal(f.requests.length, 5);
  f.bring.dispose();
  for (const request of f.requests.slice(1)) request.resolve({ type: 'image/png' });
  await settle();
  assert.equal(f.requests.length, 5);
  assert.equal(Object.keys(f.held).length, 1);
});
test('transient image failure retries after backoff; removed images never load', async () => {
  const f = fixture();
  f.bring([image(1), { ...image(2), isDeleted: true }], f.held);
  f.requests[0].reject({ status: 503 });
  await settle();
  assert.equal(f.requests.length, 1);
  f.bring([image(1)], f.held);
  assert.equal(f.requests.length, 1);
  for (const retry of f.retries.values()) retry();
  assert.equal(f.requests.length, 2);
  f.requests[1].reject({ status: 404 });
  await settle();
  f.bring([image(1)], f.held);
  assert.equal(f.requests.length, 2);
  f.bring.dispose();
});

test('image deadlines reach fetch so hung downloads release a concurrency slot', async (t) => {
  const { accountRequest } = await import('../packages/ui/web/api.js');
  const signal = AbortSignal.timeout(5);
  let received: AbortSignal | null | undefined;
  const keepAlive = setInterval(() => {}, 100);
  t.after(() => clearInterval(keepAlive));
  t.mock.method(globalThis, 'fetch', async (_path: unknown, init: RequestInit) => {
    received = init.signal;
    return new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason)),
    );
  });
  await assert.rejects(
    accountRequest('/fixture-image', { bytes: true, signal }),
    /The Merv server did not answer/,
  );
  assert.equal(received, signal);
  assert.equal(signal.aborted, true);
});

// Execute the image scheduling block from the canvas's actual onChange callback. Calling
// imageBringer directly misses the regression: the canvas used to call it only on shape edits.
const canvasSource = readFileSync(
  new URL('../packages/ui/web/views/board-canvas.tsx', import.meta.url),
  'utf8',
);
const start = canvasSource.indexOf('const version = hashElementsVersion(elements);');
const end = canvasSource.indexOf('// The person has taken up the pen:', start);
assert.ok(start >= 0 && end > start);
