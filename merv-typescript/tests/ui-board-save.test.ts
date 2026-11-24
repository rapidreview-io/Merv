import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  needsSave,
  sameStamp,
  stampOf,
  type ShapeStamp,
} from '../packages/ui/web/views/board-stamps.js';

// Execute the real save and landing callbacks. Excalidraw owns mutable element objects; the
// transport snapshots JSON at dispatch, just as accountRequest does before its first await.
const source = readFileSync(
  new URL('../packages/ui/web/views/board-canvas.tsx', import.meta.url),
  'utf8',
);
const parsed = ts.createSourceFile(
  'board-canvas.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function callback(name: string) {
  let found: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === name && node.initializer) {
      const initializer = node.initializer;
      found = (ts.isCallExpression(initializer) ? initializer.arguments[0]! : initializer).getText(
        parsed,
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.ok(found, `${name} callback`);
  return ts.transpile(`(${found})`, { target: ts.ScriptTarget.ES2022 });
}
const saveCallback = callback('save'),
  landCallback = callback('land');
type Shape = ShapeStamp & {
  id: string;
  type: string;
  isDeleted: boolean;
  x: number;
  width: number;
  fileId?: string;
};
const shape = (id = 'ink', version = 2, versionNonce = 10): Shape => ({
  id,
  version,
  versionNonce,
  type: 'rectangle',
  isDeleted: false,
  x: 100,
  width: 20,
});
const ref = <T>(current: T) => ({ current });
function deferred() {
  let resolve!: () => void, reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const settle = () => new Promise<void>((done) => setImmediate(done));
function fixture(elements = [shape()], id = 'board') {
  const known = ref(new Map<string, ShapeStamp>()),
    scene = ref(elements),
    saving = ref<Promise<void> | null>(null);
  const sent: { id: string; elements: Shape[] }[] = [],
    problems: (string | null)[] = [],
    order: string[] = [];
  const files = ref<Record<string, { dataURL: string }>>({}),
    onBoard = ref(new Set<string>());
  let transport = async (_input: { id: string; elements: Shape[] }) => {},
    upload = async () => {};
  const context = {
    id,
    owner: null,
    known,
    scene,
    saving,
    needsSave,
    sameStamp,
    stampOf,
    files,
    onBoard,
    fetch,
    unsavedAfterFailure: ref(false),
    CaptureUpdateAction: { NEVER: 'never' },
    fileOf: (el: Shape) => (el.type === 'image' ? (el.fileId ?? null) : null),
    imageAt: (file: string) => `/board-images/${file}`,
    pointing: ref(null),
    presence: ref(null),
    setProblem: (value: string | null) => problems.push(value),
    api: {
      updateScene: (update: { elements: Shape[] }) => {
        scene.current = update.elements;
      },
    },
    newElementWith: (el: Shape, change: Partial<Shape>) => ({
      ...el,
      ...change,
      version: el.version + 1,
    }),
    call: async (_name: string, input: { id: string; elements: Shape[] }) => {
      sent.push(JSON.parse(JSON.stringify(input)));
      order.push('save');
      await transport(input);
    },
    accountRequest: async () => {
      order.push('image');
      await upload();
    },
  };
  const save = runInNewContext(saveCallback, context) as () => Promise<void>;
  const land = runInNewContext(landCallback, context) as (elements: Shape[]) => void;
  return {
    known,
    scene,
    saving,
    sent,
    problems,
    files,
    onBoard,
    order,
    save,
    land,
    unsavedAfterFailure: context.unsavedAfterFailure,
    transport: (next: (input: { id: string; elements: Shape[] }) => Promise<void>) => {
      transport = next;
    },
    upload: (next: () => Promise<void>) => {
      upload = next;
    },
  };
}

test('purged IDs may be reused at lower versions without perpetual dirty state', async () => {
  const f = fixture([shape('ink', 1, 1)]);
  f.known.current.set('ink', stampOf(shape('ink', 9, 1)));
  await f.save();
  await f.save();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.known.current.get('ink'), { version: 1, versionNonce: 1 });
  f.known.current.set('ink', stampOf(shape('ink', 9, 1)));
  f.land(f.scene.current);
  await f.save();
  assert.equal(f.sent.length, 1);
});

test('a failed image upload preserves edits and the retry saves only after its bytes land', async () => {
  const local = { ...shape(), type: 'image', fileId: 'image' },
    f = fixture([local]),
    pending = deferred();
  f.files.current.image = { dataURL: 'data:image/png;base64,Ynl0ZXM=' };
  f.upload(async () => {
    throw Object.assign(new Error('Try again'), { status: 503 });
  });
  await f.save();
  assert.equal(f.unsavedAfterFailure.current, true);
  assert.equal(f.scene.current[0]!.isDeleted, false);
  assert.equal(f.known.current.size, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.problems.length, 1);
  f.upload(() => pending.promise);
  const save = f.save();
  await settle();
  assert.deepEqual(f.order, ['image', 'image']);
  Object.assign(local, { version: 3, versionNonce: 30 });
  pending.resolve();
  await save;
  assert.deepEqual(f.order, ['image', 'image', 'save']);
  assert.equal(f.onBoard.current.has('image'), true);
  assert.deepEqual(f.known.current.get('ink'), { version: 3, versionNonce: 30 });
  assert.equal(f.sent[0]!.elements[0]!.version, 3);
});

test('401 refresh may send a newer mutable shape but cannot acknowledge an unsent edit', async (t) => {
  const api = await import('../packages/ui/web/api.js');
  const local = shape(),
    f = fixture([local]),
    refresh = deferred();
  const versions: number[] = [];
  let refreshing = false;
  api.setToken('old');
  api.setProject('project');
  api.setTokenRefresher(async () => {
    refreshing = true;
    await refresh.promise;
    return 'new';
  });
  t.after(() => {
    api.setTokenRefresher(undefined);
    api.setToken(null);
    api.setProject(null);
  });
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    versions.push(JSON.parse(String(init.body)).elements[0].version);
    return new Response(
      JSON.stringify(
        versions.length === 1
          ? { error: { code: 'unauthorized', message: 'expired' } }
          : { result: {} },
      ),
      { status: versions.length === 1 ? 401 : 200 },
    );
  });
  f.transport(async (input) => {
    await api.call('board.save', input);
  });
  const saving = f.save();
  for (let i = 0; i < 30 && !refreshing; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshing, true);
  Object.assign(local, { version: 3, versionNonce: 30 });
  refresh.resolve();
  await saving;
  assert.deepEqual(versions, [2, 3]);
  assert.deepEqual(f.known.current.get('ink'), { version: 2, versionNonce: 10 });
  await f.save();
  await f.save();
  assert.deepEqual(versions, [2, 3, 3]);
  assert.deepEqual(f.known.current.get('ink'), stampOf(local));
});

test('nonce-only dirt schedules a save when the version sum is unchanged and no timer remains', async () => {
  let tail: string | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(parsed) === 'onChange' &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression &&
      ts.isArrowFunction(node.initializer.expression) &&
      ts.isBlock(node.initializer.expression.body)
    ) {
      const statements = node.initializer.expression.body.statements;
      const start = statements.findIndex(
        (statement) =>
          ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some(
            (decl) => decl.name.getText(parsed) === 'dirt',
          ),
      );
      if (start >= 0)
        tail = statements
          .slice(start)
          .map((statement) => statement.getText(parsed))
          .join('\n');
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.ok(tail);
  const f = fixture(),
    timer = ref<unknown>(undefined);
  let scheduled: (() => void) | undefined;
  f.land([shape('ink', 2, 20)]);
  const change = runInNewContext(
    ts.transpile(`(elements) => { ${tail} }`, { target: ts.ScriptTarget.ES2022 }),
    {
      sameStamp,
      known: f.known,
      timer,
      unsaved: ref(2),
      save: f.save,
      SAVE_MS: 600,
      clearTimeout: () => {},
      setTimeout: (fn: () => void) => {
        scheduled = fn;
        return 1;
      },
    },
  );
  change(f.scene.current);
  assert.ok(scheduled);
  scheduled();
  await settle();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.elements[0]!.versionNonce, 10);
});

test('queued requests retry only the unacknowledged chunk after a partial failure', async () => {
  const f = fixture(Array.from({ length: 501 }, (_, i) => shape(`ink-${i}`))),
    first = deferred();
  f.transport(async () => {
    if (f.sent.length === 1) await first.promise;
    if (f.sent.length === 2) throw new Error('response lost');
  });
  const started = f.save();
  await settle();
  const queued = [f.save(), f.save()];
  first.resolve();
  await Promise.all([started, ...queued]);
  assert.deepEqual(
    f.sent.map((part) => part.elements.length),
    [500, 1, 1],
  );
  assert.equal(f.known.current.size, 501);
});
