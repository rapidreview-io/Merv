import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { BoardElement, BoardScene } from '@merv/board';
import type { Caller } from '@merv/contracts';
import { boardApp } from './fixtures/board.js';

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
  const f = await boardApp(t, 'board-answers-');
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

test('moves adopt their destination frame while a carried frame keeps its children', async (t) => {
  const f = await fixture(t);
  const { created } = await f.draw([
    { op: 'frame', key: 'frame', title: 'Group' },
    { op: 'box', key: 'box', text: 'Held', in: 'frame' },
  ]);
  const parts = async () => (await f.scene()).filter((el) => el.id !== created.frame);
  await f.draw([{ op: 'move', id: created.frame, at: [1000, 1000] }]);
  assert.ok((await parts()).every((el) => el.frameId === created.frame));
  await f.draw([{ op: 'move', id: created.box, at: [3000, 3000] }]);
  assert.ok((await parts()).every((el) => el.frameId === null));
  await f.draw([{ op: 'move', id: created.box, in: created.frame }]);
  assert.ok((await parts()).every((el) => el.frameId === created.frame));
  const target = await f.draw([{ op: 'box', key: 'outside', text: 'Outside', at: [5000, 0] }]);
  await f.draw([{ op: 'move', id: created.box, near: target.created.outside }]);
  assert.ok((await parts()).every((el) => el.frameId === null));
});
