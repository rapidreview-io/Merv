/**
 * Board outcomes are retired for page cards (founder, 2026-11-18): every outcome kept becomes a
 * page card on its own board, once; no tool or prompt offers outcomes any more; and a page card
 * drawn by an agent still lands and reads back with its words.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Caller } from '@merv/contracts';
import { httpApp } from './fixtures/app.js';

async function fixture(t: test.TestContext) {
  const f = await httpApp(t, 'board-outcome-pages-');
  const boot = await f.app.ctx.scope.credentials.bootstrap({
    projectName: 'Plans',
    actorName: 'Owner',
  });
  const caller: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const board = f.app.ctx.board;
  const sql = (text: string, ...params: unknown[]) =>
    f.app.ctx.state.transaction(async (tx) => await tx.run(text, ...(params as never[])));
  const rows = <T>(text: string, ...params: unknown[]) =>
    f.app.ctx.state.transaction(async (tx) => await tx.all<T>(text, ...(params as never[])));
  /** An outcome as the retired pane kept it; the tables are read-only now, so the guard steps aside. */
  const outcome = async (
    boardId: string,
    id: string,
    title: string,
    text: string,
    at = '2026-11-01T00:00:00.000Z',
  ) =>
    await f.app.ctx.state.transaction(async (tx) => {
      await tx.run('ALTER TABLE board_outcomes DISABLE TRIGGER board_outcomes_read_only');
      await tx.run(
        'INSERT INTO board_outcomes(board_id,id,revision,record,text) VALUES(?,?,?,?,?)',
        boardId,
        id,
        3,
        JSON.stringify({
          title,
          createdAt: at,
          updatedAt: at,
          createdBy: caller.actorId,
          updatedBy: caller.actorId,
          sent: [],
        }),
        text,
      );
      await tx.run('ALTER TABLE board_outcomes ENABLE TRIGGER board_outcomes_read_only');
    });
  const pages = async (boardId: string) =>
    (await board.scene(caller, boardId)).elements
      .filter(
        (el) =>
          !el.isDeleted &&
          (el.customData as { details?: unknown })?.details &&
          el.type === 'rectangle',
      )
      .map((el) => (el.customData as { details: { title: string; text: string } }).details);
  return { ...f, caller, board, sql, rows, outcome, pages };
}

test('every kept outcome becomes a page card on its own board, titled the same with its whole text, once', async (t) => {
  const f = await fixture(t);
  const plan = await f.board.create(f.caller, 'Plan board');
  const other = await f.board.create(f.caller, 'Other board');
  await f.board.draw(f.caller, { board: plan.id, ops: [{ op: 'box', text: 'Already here' }] });
  const text = '# Retrieval ablation\n\n- Remove the recall layer\n- Score answer F1\n';
  await f.outcome(plan.id, 'outcome_a', 'Retrieval plan', text);
  await f.outcome(plan.id, 'outcome_b', 'Empty draft', '', '2026-11-02T00:00:00.000Z');
  await f.outcome(
    other.id,
    'outcome_c',
    'Long PRD',
    `${'word '.repeat(19_999)}\n${'more '.repeat(19_999)}\n${'end '.repeat(5_000)}`,
  );

  assert.equal(await f.board.pageOutcomes(), 3);
  const onPlan = await f.pages(plan.id);
  assert.deepEqual(onPlan, [
    { title: 'Retrieval plan', text },
    { title: 'Empty draft', text: 'Empty draft' },
  ]);
  // Past a card's 100,000 characters an outcome is cut into numbered cards, and nothing is lost.
  const onOther = await f.pages(other.id);
  assert.deepEqual(
    onOther.map((page) => page.title),
    ['Long PRD (1/3)', 'Long PRD (2/3)', 'Long PRD (3/3)'],
  );
  const long = (
    await f.rows<{ text: string }>("SELECT text FROM board_outcomes WHERE id='outcome_c'")
  )[0]!.text;
  assert.equal(onOther.map((page) => page.text).join(''), long);

  // Placed in free space: no new card overlaps the box already there.
  const scene = await f.board.scene(f.caller, plan.id);
  const box = scene.elements.find(
    (el) => el.type === 'rectangle' && !(el.customData as { details?: unknown })?.details,
  )!;
  for (const card of scene.elements.filter(
    (el) => (el.customData as { details?: unknown })?.details,
  ))
    assert.ok(
      card.x >= box.x + box.width ||
        card.y >= box.y + box.height ||
        card.x + card.width <= box.x ||
        card.y + card.height <= box.y,
    );

  // A second start moves nothing again, and what was moved is remembered with its cards.
  assert.equal(await f.board.pageOutcomes(), 0);
  assert.equal((await f.pages(plan.id)).length, 2);
  const moved = await f.rows<{ outcome_id: string; elements: string }>(
    'SELECT outcome_id,elements FROM board_outcome_pages ORDER BY outcome_id',
  );
  assert.deepEqual(
    moved.map((row) => row.outcome_id),
    ['outcome_a', 'outcome_b', 'outcome_c'],
  );
  assert.equal(JSON.parse(moved[2]!.elements).length, 3);
  // The old rows stay, read-only, for one release.
  assert.equal((await f.rows('SELECT id FROM board_outcomes')).length, 3);
  await assert.rejects(
    f.sql("UPDATE board_outcomes SET text='changed' WHERE id='outcome_a'"),
    /rejected/,
  );
  await assert.rejects(
    f.sql(
      'INSERT INTO board_outcomes(board_id,id,revision,record,text) VALUES(?,?,?,?,?)',
      plan.id,
      'outcome_new',
      1,
      '{}',
      'x',
    ),
    /rejected/,
  );
});
