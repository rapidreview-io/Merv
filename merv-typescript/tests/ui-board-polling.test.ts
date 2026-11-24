import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { sameStamp, stampOf } from '../packages/ui/web/views/board-stamps.js';

// Run the actual effect against a document, clock and deferred transport. Excalidraw's
// rendering isn't needed to check whether hidden responses mutate its scene or revision.
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
function effect(marker: string) {
  let body: string | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(parsed) === 'useEffect' &&
      node.arguments[0]?.getText(parsed).includes(marker)
    )
      body = node.arguments[0].getText(parsed);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.ok(body, `effect containing ${marker}`);
  return ts.transpile(`(${body})()`, { target: ts.ScriptTarget.ES2022 });
}
const poll = effect('pull.current = ask'),
  flush = effect('const flush =');
const ref = <T>(current: T) => ({ current });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const settle = async () => {
  for (let n = 0; n < 8; n++) await Promise.resolve();
};
const scene = (revision: number) => ({
  board: { revision },
  elements: [{ id: 'ink', version: revision, versionNonce: 0 }],
  looking: {},
});
function fixture(hidden = false) {
  const document = Object.assign(new EventTarget(), {
    hidden,
    visibilityState: hidden ? 'hidden' : 'visible',
  });
  const requests: {
    since: number;
    unsaid?: number;
    reply: ReturnType<typeof deferred<ReturnType<typeof scene>>>;
  }[] = [];
  const applied: unknown[] = [];
  let held: { id: string; version: number; versionNonce: number }[] = [];
  let tick!: () => void,
    now = 10_000,
    heard = 0,
    finished = 0,
    boards = 0,
    saves = 0,
    reloads = 0,
    stopped = false,
    handBusy = false;
  let fonts = async () => {};
  const revision = ref(0),
    pull = ref<undefined | (() => Promise<void>)>(undefined);
  const context = {
    holdStaleBuild: () => () => {},
    scene: ref([]),
    worn: () => 'dark',
    document,
    sameStamp,
    id: 'board',
    revision,
    pull,
    CaptureUpdateAction: { NEVER: 'never' },
    api: {
      getSceneElementsIncludingDeleted: () => held,
      updateScene(update: { elements: typeof held }) {
        held = update.elements;
      },
    },
    call: (_name: string, input: { since: number; unsaid?: number }) => {
      const reply = deferred<ReturnType<typeof scene>>();
      requests.push({ since: input.since, unsaid: input.unsaid, reply });
      return reply.promise;
    },
    ensureBoardFonts: () => fonts(),
    onSummary: () => boards++,
    setLook() {},
    setPaper() {},
    setProblem() {},
    presence: ref({ heard: () => heard++, doing: () => ({}), drew: () => false }),
    waiting: ref(0),
    busy: () => handBusy,
    known: ref(new Map()),
    stacked: (elements: unknown[]) => elements,
    player: ref({
      stage: { show: (elements: unknown[]) => applied.push(...elements) },
      finish: () => finished++,
      add: (elements: unknown[]) => applied.push(...elements),
      hurry() {},
      waiting: false,
    }),
    follow: ref({ visible() {}, expect() {} }),
    drawers: ref(new Map()),
    telling: ref(() => ({})),
    inked: ref(() => {}),
    turning: ref(false),
    turned: ref(0),
    voiced: ref(false),
    Date: { now: () => now },
    ASK_DRAWING_MS: 400,
    ASK_MS: 10000,
    ASK_VOICE_MS: 1500,
    DRAWING_MS: 20_000,
    LAST_INK_MS: 3000,
    setInterval: (fn: () => void) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {
      stopped = true;
    },
    save: async () => {
      saves++;
    },
    timer: ref(undefined),
    clearTimeout() {},
    input: ref<undefined | { active(): boolean }>(undefined),
    resync: ref<null | { force: boolean }>(null),
    within: (promise: Promise<unknown>) => promise.catch(() => undefined),
    LOOK_MS: 20_000,
    FONTS_MS: 4000,
    MOST_FAILED_LOOKS: 2,
    reloadWhenSafe: () => {
      reloads++;
    },
    console: { warn() {} },
  };
  const cleanup = runInNewContext(poll, context) as () => void;
  return {
    requests,
    applied,
    revision,
    pull,
    cleanup,
    context,
    scene: (elements: typeof held) => {
      held = elements;
    },
    held: () => held,
    tick: (ms = 10000) => {
      now += ms;
      if (!stopped) tick();
    },
    visibility: (hidden: boolean) => {
      document.hidden = hidden;
      document.visibilityState = hidden ? 'hidden' : 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    },
    fonts: (next: () => Promise<void>) => {
      fonts = next;
    },
    busy: (value: boolean) => {
      handBusy = value;
    },
    counts: () => ({ heard, finished, boards, saves, reloads }),
  };
}

test('hidden canvases suspend periodic and manual polls, catch up immediately, and still flush saves', async () => {
  const f = fixture(true);
  const cleanFlush = runInNewContext(flush, f.context) as () => void;
  f.tick();
  await f.pull.current!();
  assert.equal(f.requests.length, 0);
  f.visibility(false);
  assert.equal(f.requests.length, 1);
  f.requests[0].reply.resolve(scene(3));
  await settle();
  assert.equal(f.revision.current, 3);
  f.visibility(true);
  f.tick();
  await settle();
  assert.equal(f.requests.length, 1);
  assert.equal(f.counts().saves, 1);
  assert.equal(f.counts().finished, 1);
  cleanFlush();
  f.cleanup();
});

test('whole snapshots remove only exact acknowledged identities, preserving nonce edits and reused IDs', async () => {
  const f = fixture();
  f.scene([
    { id: 'nonce', version: 2, versionNonce: 20 },
    { id: 'clean', version: 2, versionNonce: 10 },
    { id: 'reused', version: 1, versionNonce: 1 },
  ]);
  f.context.known.current.set('nonce', stampOf({ version: 2, versionNonce: 10 }));
  f.context.known.current.set('clean', stampOf({ version: 2, versionNonce: 10 }));
  f.context.known.current.set('reused', stampOf({ version: 9, versionNonce: 1 }));
  f.tick();
  f.requests[0].reply.resolve(Object.assign(scene(1), { elements: [], whole: true }));
  await settle();
  assert.deepEqual(
    Array.from(f.held(), (element) => element.id),
    ['nonce', 'reused'],
  );
  assert.equal(f.revision.current, 1);
  f.cleanup();
});

test('the real player retains authoritative queued ink through a hidden gesture and drains on its next free frame', async () => {
  const playerSource = readFileSync(
    new URL('../packages/ui/web/views/board-player.ts', import.meta.url),
    'utf8',
  );
  const tree = ts.createSourceFile('board-player.ts', playerSource, ts.ScriptTarget.Latest, true);
  const declaration = tree.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === 'Player',
  );
  assert.ok(declaration);
  let frame: ((at: number) => void) | undefined;
  const f = fixture();
  const Player = runInNewContext(
    ts.transpile(`(${declaration.getText(tree).replace('export ', '')})`, {
      target: ts.ScriptTarget.ES2022,
    }),
    {
      document: Object.assign(f.context.document, { createElement: () => ({}) }),
      performance: { now: () => 0 },
      matchMedia: () => ({ matches: false }),
      requestAnimationFrame: (fn: (at: number) => void) => {
        frame = fn;
        return 1;
      },
      cancelAnimationFrame() {},
      penUnits: (shapes: unknown[]) => [{ shapes, steps: [{ rest: 100, ms: 100 }], ms: 200 }],
      penMs: () => 200,
      PEN: { pause: 0 },
      FAR: 10,
      MOST_SPEED: 3,
      SPEED_EASE_MS: 100,
    },
  );
  const local = { id: 'ink', version: 3, versionNonce: 10, x: 200 };
  const remote = { id: 'ink', version: 9, versionNonce: 20, x: 900 };
  f.scene([local]);
  f.context.known.current.set('ink', stampOf(local));
  let protectedGesture = false;
  const player = new Player(
    {
      held: () => protectedGesture,
      standing: () => new Set(['ink']),
      show: (shapes: (typeof remote)[]) => {
        for (const shape of shapes) f.context.known.current.set(shape.id, stampOf(shape));
        // Model Excalidraw's protected-element branch; the browser replay uses real reconciliation.
        if (!protectedGesture) f.scene(shapes);
      },
    },
    {},
    10_000,
  );
  player.draw = () => {}; // Pixels are covered by the real Chromium replay, not this clock test.
  f.context.player.current = player;
  f.tick();
  f.requests[0].reply.resolve({ ...scene(1), elements: [remote] });
  await settle();
  assert.equal(player.waiting, 1);
  assert.equal(f.revision.current, 1);
  protectedGesture = true;
  f.busy(true);
  player.hurry();
  f.visibility(true);
  assert.equal(player.waiting, 1);
  // A rejected hidden save can acknowledge v3, but must not discard the queued server winner.
  f.context.known.current.set('ink', stampOf(local));
  frame!(16);
  assert.equal(player.waiting, 1);
  protectedGesture = false;
  f.busy(false);
  frame!(32); // No new poll, edit, or explicit finish is needed after release.
  assert.equal(player.waiting, 0);
  assert.equal(f.requests.length, 1);
  assert.equal(f.held()[0], remote);
  assert.deepEqual(f.context.known.current.get('ink'), stampOf(remote));
  f.cleanup();
});

test('without motion every line is still said, in order, each waiting its turn with the voice', () => {
  const playerSource = readFileSync(
    new URL('../packages/ui/web/views/board-player.ts', import.meta.url),
    'utf8',
  );
  const tree = ts.createSourceFile('board-player.ts', playerSource, ts.ScriptTarget.Latest, true);
  const declaration = tree.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === 'Player',
  )!;
  let frame: ((at: number) => void) | undefined;
  const lineOf = (unit: { shapes: { say?: string }[] }) => unit.shapes[0]?.say;
  const Player = runInNewContext(
    ts.transpile(`(${declaration.getText(tree).replace('export ', '')})`, {
      target: ts.ScriptTarget.ES2022,
    }),
    {
      document: { hidden: false, createElement: () => ({}) },
      performance: { now: () => 0 },
      matchMedia: () => ({ matches: true }),
      requestAnimationFrame: (fn: (at: number) => void) => {
        frame = fn;
        return 1;
      },
      cancelAnimationFrame() {},
      penUnits: (shapes: unknown[]) =>
        shapes.map((shape) => ({ shapes: [shape], steps: [], ms: 30 })),
      penMs: () => 0,
      lineOf,
      PEN: { pause: 0 },
      FAR: 10,
      MOST_SPEED: 3,
      SPEED_EASE_MS: 100,
    },
  );
  const said: string[] = [],
    shown: string[] = [];
  let voiceBusy = false;
  const player = new Player(
    {
      held: () => voiceBusy,
      standing: () => new Set(),
      show: (shapes: { id: string }[]) => shown.push(...shapes.map((shape) => shape.id)),
    },
    {},
    10_000,
  );
  player.draw = () => {};
  // The voice takes one line at a time: the pen waits while one is waiting to be said.
  player.say = (line: string) => {
    said.push(line);
    voiceBusy = true;
  };
  player.add([
    { id: 'a', say: 'One.' },
    { id: 'b' },
    { id: 'c', say: 'Two.' },
    { id: 'd', say: 'Three.' },
  ]);
  assert.equal(player.unsaid, 3);
  frame!(16);
  assert.deepEqual(said, ['One.'], 'the first line, and the pen waits with it');
  assert.deepEqual(shown, []);
  for (let at = 32; said.length < 3 && at < 400; at += 16) {
    voiceBusy = false;
    frame!(at);
  }
  voiceBusy = false;
  frame!(999);
  assert.deepEqual(said, ['One.', 'Two.', 'Three.'], 'every line, none skipped');
  assert.deepEqual(shown, ['a', 'b', 'c', 'd']);
  assert.equal(player.unsaid, 0);
});

test('an unmounted dirty canvas releases its stale-build hold after the final save fails', async () => {
  const f = fixture(),
    pending = deferred<void>();
  let released = false;
  const cleanup = runInNewContext(flush, {
    ...f.context,
    save: () => pending.promise,
    scene: ref([{ id: 'unsaved' }]),
    needsSave: () => true,
    holdStaleBuild: () => () => {
      released = true;
    },
  });
  cleanup();
  assert.equal(released, false);
  // save catches transport failures and resolves with the dirty stamps retained.
  pending.resolve();
  await settle();
  assert.equal(released, true);
  f.cleanup();
});

// The founder's board (2026-11-19) froze in an open page while Board went on to revision 460: the
// page's looks could stall or fail to apply with no way back, and replay's Now showed that stale
// page. These hold the page to converge on Board's latest whatever went wrong on the way.
test('a change that does not apply is read again whole, and the board converges on the latest', async () => {
  const f = fixture();
  const player = f.context.player.current as { add: (elements: unknown[]) => void };
  const add = player.add;
  let fail = 1;
  player.add = (elements) => {
    if (fail-- > 0) throw new Error('cannot take this shape');
    add(elements);
  };
  f.context.known.current.set('gone', stampOf({ version: 1, versionNonce: 0 }));
  f.scene([{ id: 'gone', version: 1, versionNonce: 0 }]);
  f.tick();
  f.requests[0].reply.resolve(scene(5));
  await settle();
  assert.equal(f.revision.current, 0, 'a change not taken in never moves the revision past it');
  assert.equal(f.requests.length, 2, 'it reads again at once');
  assert.equal(f.requests[1].since, undefined, 'and reads all of the board');
  f.requests[1].reply.resolve(scene(6));
  await settle();
  assert.equal(f.revision.current, 6);
  assert.deepEqual(
    f.applied.map((el) => (el as { id: string }).id),
    ['ink'],
    'what Board holds lands',
  );
  assert.deepEqual(
    f.held().map((el) => el.id),
    [],
    'and what Board no longer holds goes',
  );
  assert.equal(f.context.resync.current, null);
  f.tick();
  assert.equal(f.requests[2].since, 6, 'then it goes on from the latest');
  assert.equal(f.counts().reloads, 0);
  f.cleanup();
});

test('a look that never answers is given up, and the next look still asks', async () => {
  const source = effect('pull.current = ask');
  const f = fixture();
  let give: (() => void) | undefined;
  const cleanup = runInNewContext(source, {
    ...f.context,
    // Board's answer never comes; the bound gives the look up.
    within: (_promise: Promise<unknown>, _ms: number, otherwise: unknown) =>
      new Promise((done) => {
        give = () => done(otherwise);
      }),
  }) as () => void;
  f.cleanup();
  const asked = f.requests.length;
  f.context.pull.current!();
  await settle();
  assert.equal(f.requests.length, asked + 1);
  await f.context.pull.current!();
  assert.equal(f.requests.length, asked + 1, 'one look at a time');
  give!();
  await settle();
  assert.equal(f.requests.length, asked + 2, 'the given-up look lets the next one ask');
  cleanup();
});

test('a forced resync respects a real pointer even when stale replay flags may be bypassed', async () => {
  const f = fixture();
  f.context.input.current = { active: () => true };
  f.context.resync.current = { force: true };
  f.tick();
  f.requests[0].reply.resolve(scene(8));
  await settle();
  assert.equal(f.applied.length, 0);
  assert.equal(f.revision.current, 0);
  f.context.input.current = undefined;
  f.tick();
  f.requests[1].reply.resolve(scene(9));
  await settle();
  assert.equal(f.revision.current, 9);
  assert.equal(f.applied.length, 1);
  f.cleanup();
});
