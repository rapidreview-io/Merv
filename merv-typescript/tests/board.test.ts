import { createService, MervError, type Caller } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectScope } from '@merv/scope';
import { BoardService, boardPlugin, type BoardElement } from '@merv/board';
import { boardToolsPlugin } from '@merv/board/tools';
import { boardUiPlugin } from '@merv/board/ui';
import { Drawing, summarize } from '@merv/board/elements';
import { openState } from './fixtures/state.js';

const refused = (code: string) => (error: unknown) =>
  error instanceof MervError && error.code === code;

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'board-'));
  const state = await openState(dir);
  const scope = await createService(new ProjectScope(state));
  const board = await createService(new BoardService(state, scope));
  const boot = await scope.credentials.bootstrap({ projectName: 'Boards', actorName: 'Owner' });
  const operator: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const actor = async (role: 'producer' | 'reviewer' | 'reader') => {
    const a = await scope.credentials.issueActor(operator, { name: role, role });
    return { projectId: operator.projectId, actorId: a.actor.id, credentialId: a.credential.id };
  };
  t.after(async () => {
    board.close();
    await state.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    board,
    operator,
    producer: await actor('producer'),
    reviewer: await actor('reviewer'),
    reader: await actor('reader'),
  };
}

test('an agent draws ideas, links and a flow on a new board, and reads back what it says', async (t) => {
  const f = await fixture(t);
  const drawn = await f.board.draw(f.producer, {
    title: 'Calibration angles',
    ops: [
      { op: 'note', key: 'idea', text: 'Temperature per head, fit on dev only' },
      {
        op: 'link',
        key: 'task',
        target: 'wf_5f922aa95d8a42b1a871b8bb73d43d67',
        text: 'Synthesis task',
        near: 'idea',
      },
      { op: 'arrow', from: 'idea', to: 'task', label: 'feeds' },
      { op: 'frame', key: 'area', title: 'Next experiment', holds: ['idea', 'task'] },
      {
        op: 'flow',
        nodes: [
          { key: 'a', text: 'Base' },
          { key: 'b', text: 'KL distill' },
          { key: 'c', text: 'Evaluate' },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
        ],
      },
    ],
  });
  assert.equal(drawn.board.title, 'Calibration angles');
  assert.equal(drawn.board.revision, 1, 'one call is one revision');
  assert.deepEqual(Object.keys(drawn.created).sort(), ['a', 'area', 'b', 'c', 'idea', 'task']);
  const scene = await f.board.scene(f.reader, drawn.board.id);
  const read = summarize(scene.elements);
  const shape = (key: string) => read.shapes.find((s) => s.id === drawn.created[key])!;
  assert.equal(shape('idea').kind, 'note');
  assert.equal(shape('idea').text, 'Temperature per head, fit on dev only');
  assert.equal(shape('task').kind, 'link');
  assert.equal(shape('task').target, 'wf_5f922aa95d8a42b1a871b8bb73d43d67');
  assert.equal(shape('idea').frame, drawn.created.area, 'held shapes stand in their frame');
  assert.deepEqual(
    read.frames.map((frame) => frame.title),
    ['Next experiment'],
  );
  const feeds = read.arrows.find((arrow) => arrow.label === 'feeds')!;
  assert.deepEqual([feeds.from, feeds.to], [drawn.created.idea, drawn.created.task]);
  assert.equal(read.arrows.length, 3);
  const link = scene.elements.find((el) => el.id === drawn.created.task)!;
  assert.equal(
    link.link,
    'merv:wf_5f922aa95d8a42b1a871b8bb73d43d67',
    'a card keeps only the id it opens',
  );
  // Nothing new overlaps anything else that stands on its own.
  const standing = scene.elements.filter(
    (el) => !el.containerId && !['arrow', 'frame'].includes(el.type),
  );
  for (const a of standing)
    for (const b of standing)
      if (a !== b)
        assert.ok(
          a.x + a.width <= b.x ||
            b.x + b.width <= a.x ||
            a.y + a.height <= b.y ||
            b.y + b.height <= a.y,
          `${a.id} overlaps ${b.id}`,
        );
  const flow = ['a', 'b', 'c'].map((key) =>
    scene.elements.find((el) => el.id === drawn.created[key])!,
  );
  assert.ok(flow[0]!.x < flow[1]!.x && flow[1]!.x < flow[2]!.x, 'a flow reads left to right');
});

test('shapes merge by version: a stale save loses, and a page asks only for what changed', async (t) => {
  const f = await fixture(t);
  const { board, created } = await f.board.draw(f.operator, {
    title: 'Merge',
    ops: [{ op: 'box', key: 'b', text: 'One' }],
  });
  const [box] = (await f.board.scene(f.operator, board.id)).elements.filter(
    (el) => el.id === created.b,
  );
  const newer = { ...box!, version: box!.version + 1, versionNonce: 5, x: 500 };
  const saved = await f.board.save(f.producer, board.id, [newer]);
  assert.equal(saved.accepted, 1);
  assert.equal(
    (await f.board.save(f.producer, board.id, [{ ...box!, x: -1 }])).accepted,
    0,
    'an older version is not kept',
  );
  assert.equal(
    (await f.board.save(f.producer, board.id, [{ ...newer, versionNonce: 9 }])).accepted,
    0,
    'a tie keeps the lower nonce',
  );
  assert.equal(
    (await f.board.save(f.producer, board.id, [{ ...newer, versionNonce: 1, x: 7 }])).accepted,
    1,
  );
  const since = (await f.board.scene(f.operator, board.id)).board.revision;
  await f.board.draw(f.operator, { board: board.id, ops: [{ op: 'delete', ids: [created.b!] }] });
  const changed = await f.board.scene(f.operator, board.id, since);
  assert.ok(
    changed.elements.length >= 2 && changed.elements.every((el) => el.isDeleted),
    'a deletion travels as a change',
  );
  assert.equal(
    (await f.board.scene(f.operator, board.id)).elements.length,
    0,
    'a whole read is live shapes only',
  );
});

test('readers and reviewers see boards but cannot draw; archived boards leave the list', async (t) => {
  const f = await fixture(t);
  const made = await f.board.create(f.producer, 'Ideas');
  for (const who of [f.reader, f.reviewer])
    await assert.rejects(
      f.board.draw(who, { board: made.id, ops: [{ op: 'note', text: 'x' }] }),
      refused('forbidden'),
    );
  assert.deepEqual(
    (await f.board.list(f.reader)).map((b) => b.title),
    ['Ideas'],
  );
  await f.board.set(f.operator, made.id, { archived: true });
  assert.deepEqual(await f.board.list(f.reader), []);
});

test('a page cannot save images, embeds or script links, and an agent cannot name a missing shape', async (t) => {
  const f = await fixture(t);
  const made = await f.board.create(f.operator, 'Guarded');
  const base = {
    id: 'e1',
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
  };
  for (const element of [
    { ...base, type: 'image' },
    { ...base, type: 'embeddable' },
    { ...base, type: 'rectangle', link: 'javascript:alert(1)' },
  ])
    await assert.rejects(
      f.board.save(f.operator, made.id, [element as BoardElement]),
      refused('invalid_board_input'),
    );
  await assert.rejects(
    f.board.draw(f.operator, {
      board: made.id,
      ops: [{ op: 'arrow', from: 'nowhere', to: 'either' }],
    }),
    /No shape "nowhere"/,
  );
  assert.equal(
    (await f.board.scene(f.operator, made.id)).board.revision,
    0,
    'a refused call draws nothing',
  );
});

test('deleting a shape takes its text and the arrows that join it', () => {
  const drawing = new Drawing([], true);
  drawing.apply({ op: 'box', key: 'a', text: 'A' });
  drawing.apply({ op: 'box', key: 'b', text: 'B', near: 'a' });
  drawing.apply({ op: 'arrow', from: 'a', to: 'b', label: 'then' });
  const drawn = drawing.result();
  assert.ok(
    drawn.every((el) => (el.customData as { by?: string })?.by === 'agent'),
    'what an agent draws says so',
  );
  const next = new Drawing(drawn, false);
  next.apply({ op: 'delete', ids: [drawing.created.a!] });
  assert.deepEqual(
    summarize(next.result().concat(drawn.filter((el) => !next.changed.has(el.id)))).shapes.map(
      (s) => s.text,
    ),
    ['B'],
  );
});

test('Board depends on State and Scope alone, and links to records only by id', () => {
  assert.deepEqual(boardPlugin.inject, ['state', 'scope']);
  assert.deepEqual(boardToolsPlugin.inject, ['board', 'tools']);
  assert.deepEqual(boardUiPlugin.inject, ['board', 'ui']);
  const src = new URL('../packages/board/src/', import.meta.url);
  const imports = readdirSync(src).flatMap((file) =>
    [...readFileSync(new URL(file, src), 'utf8').matchAll(/from '(@merv\/[^/']+)/g)].map(
      (m) => m[1],
    ),
  );
  assert.deepEqual([...new Set(imports)].sort(), ['@merv/api', '@merv/contracts', '@merv/ui']);
});
