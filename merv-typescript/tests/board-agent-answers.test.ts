import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { BoardElement, BoardScene } from '@merv/board';
import type { Caller } from '@merv/contracts';
import { httpApp } from './fixtures/app.js';

type Shape = { id: string; text?: string; changedBy?: string; by?: string; at: number[] };
type Read = {
  since: number;
  shapes: Shape[];
  arrows: { id: string; from?: string; to?: string; label?: string; changedBy?: string }[];
  frames: unknown[];
  deleted?: { id: string; changedBy: string }[];
  truncated?: boolean;
};
type Drawn = {
  board: { id: string };
  created: Record<string, string>;
  placed: Record<string, number[]>;
  overlaps?: Record<string, string[]>;
  note?: string;
};
type El = BoardElement & { [field: string]: any };

async function fixture(t: test.TestContext) {
  const f = await httpApp(t, 'board-answers-');
  const boot = await f.app.ctx.scope.credentials.bootstrap({
    projectName: 'Sketches',
    actorName: 'Owner',
  });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const { tools } = f.app.ctx;
  const board = (await f.app.ctx.board.create(owner, 'Sketch')).id;
  const draw = async (ops: unknown[], on = board) =>
    (await tools.call('board.write:draw', owner, { board: on, ops })) as Drawn;
  const read = async (input: object = {}, on = board) =>
    (await tools.call('board.read:get', owner, { board: on, ...input })) as Read;
  const scene = async (on = board) =>
    ((await tools.call('board.scene', owner, { id: on })) as BoardScene).elements as El[];
  const agent = new Client({ name: 'claude-code', version: '1' });
  t.after(() => agent.close());
  await agent.connect(
    new StreamableHTTPClientTransport(new URL(`${f.app.ctx.api.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${boot.token}` } },
    }),
  );
  const agentDraw = async (ops: unknown[]) =>
    JSON.parse(
      (
        (await agent.callTool({
          name: 'board.write',
          arguments: { action: 'draw', draw: { board, ops } },
        })) as { content: { text: string }[] }
      ).content[0]!.text,
    ) as Drawn;
  const save = (elements: El[]) => tools.call('board.save', owner, { id: board, elements });
  return { ...f, tools, owner, board, draw, read, scene, agent, agentDraw, save };
}

test('since answers what changed after it and who, and only the ids of what is gone', async (t) => {
  const f = await fixture(t);
  const first = await f.draw([
    { op: 'box', key: 'a', text: 'mine', at: [0, 0] },
    { op: 'note', key: 'b', text: 'erase me', at: [400, 0] },
    { op: 'box', key: 'c', text: 'still', at: [800, 0] },
  ]);
  const { since } = await f.read();

  // An outside agent's drawing is marked as its own; a page's save of a shape as a person's.
  const drawn = await f.agentDraw([{ op: 'note', key: 'n', text: 'from the agent', at: [0, 400] }]);
  const made = (await f.scene()).find((el) => el.id === drawn.created.n)!;
  assert.equal(made.customData.by, 'agent');
  const label = (await f.scene()).find((el) => el.text === 'still')!;
  await f.save([{ ...label, version: label.version + 1, versionNonce: 1, text: 'still here' }]);
  // Erased through the page: the tombstone holds the text, which no reader of `since` is given.
  const held = (await f.scene()).filter(
    (el) => el.id === first.created.b || el.containerId === first.created.b,
  );
  await f.save(held.map((el) => ({ ...el, version: el.version + 1, isDeleted: true })));

  const read = await f.read({ since });
  assert.deepEqual(
    read.shapes.map(({ id, changedBy }) => [id, changedBy]).sort(),
    [
      [drawn.created.n, 'agent'],
      [first.created.c, 'person'],
    ].sort(),
  );
  assert.deepEqual(read.deleted, [{ id: first.created.b, changedBy: 'person' }]);
  assert.doesNotMatch(JSON.stringify(read), /erase me/);
  assert.deepEqual(await f.read({ since: read.since }).then(({ shapes }) => shapes), []);
  // Without since, the whole board and the value to pass next time.
  const whole = await f.read();
  assert.equal(whole.since, read.since);
  assert.equal(whole.shapes.length, 3);
  assert.equal(whole.deleted, undefined);
  assert.ok(whole.shapes.every((shape) => shape.changedBy === undefined));
  // A person's change to what the agent drew is the person's, though the agent still drew it.
  const note = (await f.scene()).find((el) => el.id === drawn.created.n)!;
  await f.save([{ ...note, version: note.version + 1, versionNonce: 2, x: 5 }]);
  const [moved] = (await f.read({ since: read.since })).shapes;
  assert.deepEqual([moved!.by, moved!.changedBy], ['agent', 'person']);
});

test('since tells a part’s change as its shape’s, by the newest hand', async (t) => {
  const f = await fixture(t);
  const drawn = await f.agentDraw([
    { op: 'box', key: 'a', text: 'labelled', at: [0, 0] },
    { op: 'box', key: 'b', text: 'loses its words', at: [400, 0] },
    {
      op: 'sketch',
      key: 's',
      at: [0, 400],
      strokes: [{ path: 'M0 0 L10 10' }, { path: 'M20 0 L30 10' }],
    },
  ]);
  const { since } = await f.read();
  const later = Date.now() + 1000;
  const els = await f.scene();
  // A person fills the agent's box, whose older label stacks above it.
  const box = els.find((el) => el.id === drawn.created.a)!;
  const label = els.find((el) => el.containerId === drawn.created.b)!;
  const stroke = els.find((el) => el.customData?.sketch === drawn.created.s)!;
  const save = (el: El, fields: object) =>
    f.save([{ ...el, version: el.version + 1, versionNonce: 1, updated: later, ...fields }]);
  await save(box, { backgroundColor: '#ffffff' });
  await save(label, { isDeleted: true });
  await save(stroke, { isDeleted: true });
  const read = await f.read({ since });
  assert.deepEqual(read.deleted, [], 'a label or one stroke of two is no shape gone');
  assert.deepEqual(
    read.shapes.map(({ id, changedBy }) => [id, changedBy]).sort(),
    [
      [drawn.created.a, 'person'],
      [drawn.created.b, 'person'],
      [drawn.created.s, 'person'],
    ].sort(),
  );
});

test('text and region reach past the 600 shapes a read holds', async (t) => {
  const f = await fixture(t);
  for (let page = 0; page < 7; page++)
    await f.draw(
      Array.from({ length: 100 }, (_, i) => ({
        op: 'text',
        text: `card ${page * 100 + i}`,
        at: [i * 200, page * 100],
      })),
    );
  assert.equal((await f.read()).truncated, true);
  const found = await f.read({ text: 'CARD 650' });
  assert.deepEqual(
    found.shapes.map((shape) => shape.text),
    ['card 650'],
  );
  assert.equal(found.truncated, undefined);
  const there = await f.read({ region: { x: 9_990, y: 590, width: 50, height: 50 } });
  assert.deepEqual(
    there.shapes.map((shape) => shape.text),
    ['card 650'],
  );
});

test('a draw says where its shapes landed and what they landed on', async (t) => {
  const f = await fixture(t);
  const one = await f.draw([
    { op: 'box', key: 'a', text: 'A', at: [0, 0], width: 200, height: 100 },
    {
      op: 'sketch',
      key: 's',
      at: [500, 0],
      size: 's',
      strokes: [{ path: 'M0 0 L100 0 L100 100' }],
    },
  ]);
  assert.deepEqual(one.placed.a, [0, 0, 200, 100]);
  assert.deepEqual(one.placed.s!.slice(0, 2), [500, 0]);
  assert.equal(one.overlaps, undefined);
  assert.equal(one.note, undefined);

  const exact = await f.draw([{ op: 'note', key: 'n', text: 'on A', at: [20, 20] }]);
  assert.deepEqual(exact.overlaps, { n: ['a'] });
  assert.match(exact.note!, /^n landed on another shape: at places exactly and checks nothing/);
  // Inside a pen stroke's box but off its line is not on it.
  assert.equal((await f.draw([{ op: 'text', text: 'x', at: [510, 80] }])).overlaps, undefined);
  // A move answers too; near finds room, so it has nothing to report.
  const near = await f.draw([{ op: 'move', id: 'n', near: 'a', side: 'below' }]);
  assert.equal(near.overlaps, undefined);
  assert.equal(near.placed.n![1]! >= 100, true);
});

test('near treats an arrow as occupied and keeps to the side it was asked for', async (t) => {
  const f = await fixture(t);
  await f.draw([
    { op: 'box', key: 'a', text: 'A', at: [0, 0], width: 200, height: 100 },
    { op: 'box', key: 'b', text: 'B', at: [900, 0], width: 200, height: 100 },
    { op: 'arrow', from: 'a', to: 'b', label: 'writes' },
  ]);
  const { placed } = await f.draw([
    { op: 'note', key: 'n', text: 'beside', near: 'a', side: 'right' },
  ]);
  const [x, y, , height] = placed.n!;
  assert.ok(x! >= 200, `${x} stays to the right`);
  assert.ok(y! + height! < 50 || y! > 50, `${y} clear of the arrow's line at 50`);
});

test('an edit grows the shape to hold its words and takes its arrows along', async (t) => {
  const f = await fixture(t);
  const { created } = await f.draw([
    { op: 'box', key: 'a', text: 'short', at: [0, 0] },
    { op: 'box', key: 'b', text: 'other', at: [600, 400] },
    { op: 'arrow', key: 'x', from: 'a', to: 'b' },
  ]);
  const long = 'This box now says something a good deal longer than it did. '.repeat(3);
  const { placed } = await f.draw([{ op: 'edit', id: 'a', text: long }]);
  const els = await f.scene();
  const box = els.find((el) => el.id === created.a)!;
  const text = els.find((el) => el.containerId === created.a)!;
  assert.deepEqual(placed.a, [0, 0, box.width, box.height]);
  assert.ok(box.height >= text.height, `${text.height} fits in ${box.height}`);
  assert.equal(box.width, 320);
  const arrow = els.find((el) => el.id === created.x)!;
  assert.ok(arrow.x >= box.x && arrow.y >= box.y + box.height / 2);
  // What is placed in the same call goes around what grew.
  const { overlaps } = await f.draw([
    { op: 'edit', id: 'b', text: long },
    { op: 'note', text: 'clear', near: 'a', side: 'right' },
  ]);
  assert.equal(overlaps, undefined);
});

test('a move keeps a bent arrow’s bends, and reverse turns an arrow around', async (t) => {
  const f = await fixture(t);
  const { created } = await f.draw([
    { op: 'box', key: 'a', text: 'A', at: [0, 0] },
    { op: 'box', key: 'b', text: 'B', at: [600, 200] },
    { op: 'arrow', key: 'x', from: 'a', to: 'b', label: 'go' },
  ]);
  const arrow = (await f.scene()).find((el) => el.id === created.x)!;
  const bends = [
    [100, 300],
    [300, 300],
  ];
  const points = [[0, 0], ...bends, arrow.points.at(-1)];
  await f.save([{ ...arrow, version: arrow.version + 1, versionNonce: 1, points }]);
  await f.draw([{ op: 'move', id: 'b', at: [700, 300] }]);
  const moved = (await f.scene()).find((el) => el.id === created.x)!;
  assert.equal(moved.points.length, 4);
  // Where each bend stands on the board has not changed.
  assert.deepEqual(
    moved.points
      .slice(1, -1)
      .map(([x, y]: number[]) => [Math.round(x! + moved.x), Math.round(y! + moved.y)]),
    bends.map(([x, y]) => [Math.round(x! + arrow.x), Math.round(y! + arrow.y)]),
  );
  const box = (await f.scene()).find((el) => el.id === created.b)!;
  assert.ok(Math.abs(moved.x + moved.points.at(-1)[0] - box.x) < box.width + 1);

  await f.draw([{ op: 'edit', id: 'x', reverse: true }]);
  const [turned] = (await f.read()).arrows;
  assert.deepEqual([turned!.from, turned!.to, turned!.label], [created.b, created.a, 'go']);
  const flipped = (await f.scene()).find((el) => el.id === created.x)!;
  assert.deepEqual(
    [flipped.x + flipped.points.at(-1)[0], flipped.y + flipped.points.at(-1)[1]].map(Math.round),
    [moved.x, moved.y].map(Math.round),
  );
  assert.equal(flipped.endArrowhead, 'arrow');
  await assert.rejects(f.draw([{ op: 'edit', id: 'a', reverse: true }]), {
    code: 'board_not_an_arrow',
  });
  // An arrow a page saved with no points has nothing to turn, and turning it fails nothing.
  await f.save([{ ...flipped, version: flipped.version + 1, versionNonce: 1, points: undefined }]);
  await f.draw([{ op: 'edit', id: 'x', reverse: true }]);
});

test('keys last past their call, the newest shape holding a key used again', async (t) => {
  const f = await fixture(t);
  const one = await f.draw([
    { op: 'box', key: 'show', text: 'first', at: [0, 0] },
    { op: 'sketch', key: 'pen', at: [400, 0], strokes: [{ path: 'M0 0 L10 10' }] },
  ]);
  const two = await f.draw([
    { op: 'note', key: 'n', text: 'beside', near: 'show' },
    { op: 'arrow', from: 'show', to: 'n' },
    { op: 'move', id: 'pen', at: [900, 900] },
  ]);
  assert.equal(two.overlaps, undefined);
  assert.equal((await f.read()).arrows[0]!.from, one.created.show);
  const pen = (await f.scene()).filter((el) => el.customData?.sketch === one.created.pen);
  assert.deepEqual([pen[0]!.x, pen[0]!.y], [900, 900]);
  const three = await f.draw([{ op: 'box', key: 'show', text: 'second', at: [0, 800] }]);
  await f.draw([{ op: 'edit', id: 'show', color: 'red' }]);
  const painted = (await f.scene()).find((el) => el.id === three.created.show)!;
  assert.notEqual(painted.backgroundColor, 'transparent');
  await assert.rejects(f.draw([{ op: 'edit', id: 'never', color: 'red' }]), {
    code: 'board_shape_not_found',
  });
});

test('a field beside the action’s object is told where it goes', async (t) => {
  const f = await fixture(t);
  for (const input of [{ draw: { ops: [] } }, {}])
    await assert.rejects(
      f.tools.call('board.write', f.owner, { action: 'draw', board: f.board, ...input }),
      (error: { details: { path: string[]; message: string }[] }) => {
        assert.deepEqual(
          error.details.map(({ path, message }) => [path.join('.'), message]),
          [['board', '"board" goes inside "draw": {"action":"draw","draw":{"board":…}}']],
        );
        return true;
      },
    );
});
