import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Caller } from '@merv/contracts';
import type { BoardElement } from '@merv/board';
import { boardAt, type BoardChange } from '@merv/board/models';
import { boardApp } from './fixtures/board.js';

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

test('the live-shape cap applies to the accepted batch, including deletions and restores', async (t) => {
  const f = await fixture(t);
  const save = (elements: BoardElement[]) => f.board.save(f.owner, f.made.id, elements);
  for (let start = 0; start < 5000; start += 500)
    await save(Array.from({ length: 500 }, (_, i) => shape(`s${start + i}`)));
  await save([shape('s0', 2, { isDeleted: true }), shape('replacement')]);
  await save([shape('replacement', 2, { isDeleted: true }), shape('s0', 3)]);
  assert.equal((await f.board.scene(f.owner, f.made.id)).elements.length, 5000);
  // A stale or unknown deletion frees no slot; a rejected batch changes neither scene nor history.
  const before = await f.board.scene(f.owner, f.made.id);
  for (const tombstone of [
    shape('s0', 2, { isDeleted: true }),
    shape('unknown', 1, { isDeleted: true }),
  ])
    await assert.rejects(save([tombstone, shape('overflow')]), { code: 'board_full' });
  assert.deepEqual(await f.board.scene(f.owner, f.made.id), before);
  assert.equal((await f.rows()).at(-1)!.revision, before.board.revision);
});

async function fixture(t: test.TestContext) {
  const f = await boardApp(t, 'board-replay-');
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
