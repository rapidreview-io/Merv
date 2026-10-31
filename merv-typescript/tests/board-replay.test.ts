import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Caller } from '@merv/contracts';
import type { BoardElement } from '@merv/board';
import { boardAt, stacked, type BoardChange } from '@merv/board/models';
import { httpApp } from './fixtures/app.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

const shape = (id: string, version = 1, more: Partial<BoardElement> = {}): BoardElement => ({
  id,
  type: 'rectangle',
  version,
  versionNonce: version,
  isDeleted: false,
  x: version,
  y: 0,
  width: 10,
  height: 10,
  ...more,
});

async function fixture(t: test.TestContext) {
  const f = await httpApp(t, 'board-replay-');
  const boot = await f.app.ctx.scope.credentials.bootstrap({
    projectName: 'Sketches',
    actorName: 'Owner',
  });
  const other = await f.app.ctx.scope.credentials.bootstrap({
    projectName: 'Other',
    actorName: 'Stranger',
  });
  const caller = (made: typeof other): Caller => ({
    projectId: made.project.id,
    actorId: made.actor.id,
    credentialId: made.credential.id,
  });
  const owner = caller(boot);
  const colleague = await f.app.ctx.scope.credentials.issueActor(owner, {
    name: 'Colleague',
    role: 'reader',
  });
  const board = f.app.ctx.board;
  const made = await board.create(owner, 'Sketch');
  const rows = async (id = made.id, who = owner) => {
    const all: BoardChange[] = [];
    let after: number | undefined;
    do {
      const page = await board.history(who, id, after);
      all.push(...page.changes);
      after = page.next;
    } while (after !== undefined);
    return all;
  };
  const sql = (text: string, ...params: unknown[]) =>
    f.app.ctx.state.transaction(async (tx) => await tx.run(text, ...(params as never[])));
  return {
    ...f,
    board,
    boot,
    other,
    owner,
    colleague: { projectId: owner.projectId, actorId: colleague.actor.id } as Caller,
    stranger: caller(other),
    made,
    rows,
    sql,
  };
}

test('history is written in the same transaction as the shapes, or neither is', async (t) => {
  const f = await fixture(t);
  await f.board.save(f.owner, f.made.id, [shape('kept')]);
  // The last write of a change fails, after both the shapes and history were written.
  await f.sql(
    `CREATE FUNCTION refuse_change() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'no'; END $$ LANGUAGE plpgsql`,
  );
  await f.sql(
    'CREATE TRIGGER refuse BEFORE UPDATE ON boards FOR EACH ROW EXECUTE FUNCTION refuse_change()',
  );
  await assert.rejects(f.board.save(f.owner, f.made.id, [shape('lost')]));
  await assert.rejects(
    f.board.draw(f.owner, { board: f.made.id, ops: [{ op: 'note', text: 'x' }] }),
  );
  await f.sql('DROP TRIGGER refuse ON boards');
  await f.sql('DROP FUNCTION refuse_change');
  const scene = await f.board.scene(f.owner, f.made.id);
  assert.deepEqual(
    scene.elements.map((el) => el.id),
    ['kept'],
  );
  assert.deepEqual(
    (await f.rows()).flatMap((row) => row.shapes.map((el) => el.id)),
    ['kept'],
  );
  // And a save that changes nothing is no step.
  await f.board.save(f.owner, f.made.id, [shape('kept')]);
  assert.equal((await f.rows()).length, 1);
});

test("an agent's every call is its own step, in order, and what it drew keeps the order it drew", async (t) => {
  const f = await fixture(t);
  const texts = ['first', 'second', 'third'];
  for (const text of texts)
    await f.board.draw(f.owner, {
      board: f.made.id,
      ops: [
        { op: 'text', key: 'a', text: `${text} a` },
        { op: 'sketch', strokes: [{ path: 'M0 0 L50 50' }, { path: 'M0 50 L50 0' }] },
        { op: 'note', key: 'b', text: `${text} b` },
      ],
    });
  const rows = await f.rows();
  assert.deepEqual(
    rows.map((row) => row.kind),
    ['draw', 'draw', 'draw'],
  );
  assert.deepEqual(
    rows.map((row) => row.revision),
    [1, 2, 3],
  );
  const said = (shapes: BoardElement[]) =>
    shapes.flatMap((el) => (el.type === 'text' ? [el.text] : []));
  assert.deepEqual(
    rows.map((row) => said(row.shapes)),
    texts.map((text) => [`${text} a`, `${text} b`]),
  );
  // The page is handed the same order: by fractional index, every shape after the last one drawn.
  for (const row of rows)
    assert.deepEqual(
      stacked(row.shapes).map((el) => el.id),
      row.shapes.map((el) => el.id),
    );
  const delta = await f.board.scene(f.owner, f.made.id, 0);
  assert.deepEqual(
    delta.elements.map((el) => el.id),
    rows.flatMap((row) => row.shapes.map((el) => el.id)),
  );
});

test("one person's rapid saves are one step; another actor, a draw or time ends it, order kept", async (t) => {
  const f = await fixture(t);
  await f.board.save(f.owner, f.made.id, [shape('a')]);
  await f.board.save(f.owner, f.made.id, [shape('b')]);
  await f.board.save(f.owner, f.made.id, [shape('a', 2)]);
  let rows = await f.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.revision, 3);
  // The newest of each shape, where it first came.
  assert.deepEqual(
    rows[0]!.shapes.map((el) => [el.id, el.version]),
    [
      ['a', 2],
      ['b', 1],
    ],
  );

  await f.board.save(f.colleague, f.made.id, [shape('c')]);
  await f.board.save(f.owner, f.made.id, [shape('d')]);
  await f.board.draw(f.owner, { board: f.made.id, ops: [{ op: 'text', text: 'said' }] });
  await f.board.save(f.owner, f.made.id, [shape('e')]);
  rows = await f.rows();
  assert.deepEqual(
    rows.map((row) => [row.kind, row.actorId]),
    [
      ['save', f.owner.actorId],
      ['save', f.colleague.actorId],
      ['save', f.owner.actorId],
      ['draw', f.owner.actorId],
      ['save', f.owner.actorId],
    ],
  );
  assert.deepEqual(
    rows.map((row) => row.revision),
    [3, 4, 5, 6, 7],
  );

  // Once the moment has passed, the next save starts a step; the step began when it began.
  const began = rows.at(-1)!.at;
  await f.board.save(f.owner, f.made.id, [shape('f')]);
  assert.equal((await f.rows()).at(-1)!.at, began);
  await f.sql(
    `UPDATE board_history SET began_at=? WHERE revision=8`,
    new Date(Date.now() - 6000).toISOString(),
  );
  await f.board.save(f.owner, f.made.id, [shape('g')]);
  assert.deepEqual(
    (await f.rows()).at(-1)!.shapes.map((el) => el.id),
    ['g'],
  );

  // A step too large to grow is left as it is.
  await f.sql(
    `UPDATE board_history SET shapes=? WHERE revision=9`,
    JSON.stringify([shape('g', 1, { pad: 'x'.repeat(1_000_001) })]),
  );
  await f.board.save(f.owner, f.made.id, [shape('h')]);
  assert.deepEqual(
    (await f.rows()).at(-1)!.shapes.map((el) => el.id),
    ['h'],
  );
});

test('history rebuilds the exact board at every step, whatever was edited, deleted or brought back', async (t) => {
  const f = await fixture(t);
  const at = new Map<number, BoardElement[]>();
  const seen = async () => {
    const scene = await f.board.scene(f.owner, f.made.id);
    at.set(scene.board.revision, scene.elements);
  };
  const draw = (ops: never[]) => f.board.draw(f.owner, { board: f.made.id, ops }).then(seen);
  const drawn = await f.board.draw(f.owner, {
    board: f.made.id,
    ops: [
      { op: 'note', key: 'n', text: 'A note', at: [0, 0] },
      { op: 'box', key: 'b', text: 'A box', at: [300, 0] },
    ],
  });
  await seen();
  await draw([{ op: 'arrow', from: drawn.created.n, to: drawn.created.b, label: 'to' }] as never);
  await f.board.save(f.colleague, f.made.id, [
    shape('stroke', 1, {
      type: 'freedraw',
      points: [
        [0, 0],
        [5, 5],
      ],
      pressures: [],
    }),
  ]);
  await seen();
  await f.board.save(f.colleague, f.made.id, [
    shape('stroke', 2, {
      type: 'freedraw',
      x: 40,
      points: [
        [0, 0],
        [5, 5],
      ],
      pressures: [],
    }),
  ]);
  await seen();
  await draw([{ op: 'move', id: drawn.created.n, at: [50, 500] }] as never);
  await draw([{ op: 'delete', ids: [drawn.created.b] }] as never);
  await f.board.save(f.owner, f.made.id, [
    shape('stroke', 3, {
      type: 'freedraw',
      isDeleted: true,
      points: [
        [0, 0],
        [5, 5],
      ],
      pressures: [],
    }),
  ]);
  await seen();
  await f.board.save(f.colleague, f.made.id, [
    shape('stroke', 4, {
      type: 'freedraw',
      x: 90,
      points: [
        [0, 0],
        [5, 5],
      ],
      pressures: [],
    }),
  ]);
  await seen();

  const rows = await f.rows();
  assert.ok(rows.length >= 6);
  rows.forEach((row, i) => {
    const board = at.get(row.revision);
    assert.ok(board, `seen at ${row.revision}`);
    const byId = (shapes: BoardElement[]) => [...shapes].sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(byId(boardAt(rows.slice(0, i + 1))), byId(board), `step ${i}`);
  });
  assert.deepEqual(
    boardAt(rows)
      .map((el) => el.id)
      .sort(),
    (await f.board.scene(f.owner, f.made.id)).elements.map((el) => el.id).sort(),
  );
});

test('a board older than history starts it from how it stood, and invents nothing before', async (t) => {
  const f = await fixture(t);
  await f.board.save(f.owner, f.made.id, [shape('old'), shape('gone')]);
  await f.board.save(f.owner, f.made.id, [shape('gone', 2, { isDeleted: true })]);
  await f.sql('DELETE FROM board_history');
  assert.deepEqual(await f.rows(), []);
  assert.equal((await f.board.history(f.owner, f.made.id)).total, 0);

  await f.board.save(f.colleague, f.made.id, [shape('new')]);
  const rows = await f.rows();
  assert.deepEqual(
    rows.map((row) => [row.kind, row.revision, row.shapes.map((el) => el.id)]),
    [
      ['before', 2, ['old']],
      ['save', 3, ['new']],
    ],
  );
  assert.deepEqual(boardAt(rows), (await f.board.scene(f.owner, f.made.id)).elements);
});

test('history reads in bounded pages to a project member, and to nobody else', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 130; i++)
    await f.board.draw(f.owner, { board: f.made.id, ops: [{ op: 'text', text: `step ${i}` }] });
  const first = await f.board.history(f.owner, f.made.id);
  assert.equal(first.changes.length, 100);
  assert.equal(first.total, 130);
  const second = await f.board.history(f.colleague, f.made.id, first.next);
  assert.deepEqual(
    second.changes.map((row) => row.revision),
    Array.from({ length: 30 }, (_, i) => 101 + i),
  );
  assert.equal(second.next, undefined);
  assert.deepEqual((await f.board.history(f.owner, f.made.id, 130)).changes, []);

  // A page stops at its bytes, but always holds the next step.
  await f.sql(
    `UPDATE board_history SET shapes=? WHERE revision IN (1,2)`,
    JSON.stringify([shape('a', 1, { pad: 'x'.repeat(2_500_000) })]),
  );
  assert.deepEqual(
    (await f.board.history(f.owner, f.made.id)).changes.map((row) => row.revision),
    [1],
  );
  assert.equal((await f.board.history(f.owner, f.made.id)).next, 1);

  const asTool = (who: { token: string; project: string }) =>
    fetch(`${f.app.ctx.api.url}/tools/board.history`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${who.token}`,
        'x-merv-project-id': who.project,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: f.made.id, after: 120 }),
    });
  const member = await asTool({ token: f.boot.token, project: f.owner.projectId });
  assert.equal(member.status, 200);
  assert.equal(
    ((await member.json()) as { result: { changes: unknown[] } }).result.changes.length,
    10,
  );
  // Someone else naming this project is refused; naming their own, there is no such board.
  assert.equal((await asTool({ token: f.other.token, project: f.owner.projectId })).status, 403);
  assert.equal((await asTool({ token: f.other.token, project: f.stranger.projectId })).status, 404);
  await assert.rejects(f.board.history(f.stranger, f.made.id), { code: 'not_found' });
  // Nor does anyone who reads a project without belonging to it see what people drew and erased.
  const platform = { issuer: 'i', subject: 's', expiresAt: '2099-01-01T00:00:00Z' };
  await assert.rejects(f.board.history({ ...f.owner, platform }, f.made.id), { code: 'forbidden' });
});

test('no agent is offered history, in any tool', async (t) => {
  const f = await fixture(t);
  const client = new Client({ name: 'agent', version: '1' });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${f.app.ctx.api.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${f.boot.token}` } },
    }),
  );
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === 'board.read'));
  assert.ok(!tools.some((tool) => tool.name === 'board.history'));
  assert.doesNotMatch(
    JSON.stringify(tools.filter((tool) => tool.name.startsWith('board.'))),
    /history/i,
  );
  const called = await client
    .callTool({ name: 'board.history', arguments: { id: f.made.id } })
    .catch((error: Error) => error);
  assert.ok(called instanceof Error || called.isError, JSON.stringify(called));
  const listed = await f.app.ctx.tools.describe(f.owner, true);
  assert.ok(!listed.some((tool) => tool.name === 'board.history'));
  assert.doesNotMatch(f.app.ctx.tools.instructions(), /board\.history/);
  // Pages are.
  assert.ok(
    (await f.app.ctx.tools.describe(f.owner)).some((tool) => tool.name === 'board.history'),
  );
});

test('bytes last while history shows them, past the purge of the shape that named them', async (t) => {
  const f = await fixture(t);
  const put = (file: string) => f.board.storeImage(f.owner, file, PNG);
  for (const file of ['erased', 'never-drawn', 'before']) await put(file);
  const image = (id: string, fileId: string, version = 1, more: Partial<BoardElement> = {}) =>
    shape(id, version, { type: 'image', fileId, ...more });
  await f.board.save(f.owner, f.made.id, [image('before', 'before')]);
  // A shape older than history keeps its bytes only through the step that shows how the board stood.
  await f.sql('DELETE FROM board_history');
  await f.sql('DELETE FROM board_history_files');
  await f.board.save(f.owner, f.made.id, [image('a', 'erased')]);
  await f.sql('UPDATE board_history SET began_at=?', new Date(0).toISOString());
  await f.board.save(f.owner, f.made.id, [
    image('a', 'erased', 2, { isDeleted: true }),
    image('before', 'before', 2, { isDeleted: true }),
  ]);
  const long = new Date(Date.now() - 31 * 86_400_000).toISOString();
  await f.sql('UPDATE board_elements SET deleted_at=? WHERE deleted', long);
  await f.sql('UPDATE board_images SET stored_at=?', long);
  await f.board.save(f.owner, f.made.id, [shape('later')]);

  // The shape is gone from the board, as ever, while history and its bytes stay.
  assert.deepEqual(
    (await f.board.scene(f.owner, f.made.id)).elements.map((el) => el.id),
    ['later'],
  );
  const left = await f.app.ctx.state.transaction(
    async (tx) => await tx.all<{ element_id: string }>('SELECT element_id FROM board_elements'),
  );
  assert.deepEqual(
    left.map((row) => row.element_id),
    ['later'],
  );
  const rows = await f.rows();
  assert.deepEqual(
    rows[0]!.shapes.map((el) => el.fileId),
    ['before'],
  );
  assert.deepEqual(
    boardAt(rows.slice(0, 2))
      .map((el) => el.fileId)
      .sort(),
    ['before', 'erased'],
  );
  assert.deepEqual((await f.board.image(f.owner, 'erased')).content, PNG);
  assert.deepEqual((await f.board.image(f.owner, 'before')).content, PNG);
  await assert.rejects(f.board.image(f.owner, 'never-drawn'), { code: 'not_found' });
});
