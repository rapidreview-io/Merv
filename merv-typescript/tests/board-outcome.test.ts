import assert from 'node:assert/strict';
import test from 'node:test';
import type { Caller } from '@merv/contracts';
import { httpApp } from './fixtures/app.js';
import { boardApp } from './fixtures/board.js';

async function fixture(t: test.TestContext, full = false) {
  const f = full
    ? await httpApp(t, 'board-outcome-')
    : await boardApp(t, 'board-outcome-', { artifacts: true });
  const boot = await f.app.ctx.scope.credentials.bootstrap({
    projectName: 'Sketches',
    actorName: 'Owner',
  });
  const stranger = await f.app.ctx.scope.credentials.bootstrap({
    projectName: 'Other',
    actorName: 'Stranger',
  });
  const caller = (made: typeof boot): Caller => ({
    projectId: made.project.id,
    actorId: made.actor.id,
    credentialId: made.credential.id,
  });
  const owner = caller(boot);
  const board = f.app.ctx.board;
  const made = await board.create(owner, 'Sketch');
  const tool = (name: string, who: Caller, input: unknown) =>
    f.app.ctx.tools.call(name, who, input) as Promise<never>;
  return { board, owner, stranger: caller(stranger), id: made.id, tool, f: f.app.ctx };
}
const coded = (code: string) => (error: { code?: string }) => error.code === code;

test('an outcome is written by edits at any revision, and whole only at its own', async (t) => {
  const { board, owner, id } = await fixture(t);
  await assert.rejects(board.writeOutcome(owner, { board: id }), coded('invalid_board_input'));
  const made = await board.writeOutcome(owner, {
    board: id,
    title: 'Plan',
    content: 'one two two',
  });
  assert.equal(made.revision, 1);
  const outcome = { board: id, outcome: made.id };
  await assert.rejects(
    board.writeOutcome(owner, { ...outcome, edits: [{ find: 'two', replace: 'x' }] }),
    coded('board_outcome_conflict'),
    'a find occurring twice is refused',
  );
  await assert.rejects(
    board.writeOutcome(owner, { ...outcome, edits: [{ find: 'nine', replace: 'x' }] }),
    coded('board_outcome_conflict'),
  );
  const edited = await board.writeOutcome(owner, {
    ...outcome,
    edits: [{ find: 'one', replace: 'zero' }],
  });
  assert.equal(edited.revision, 2);
  await assert.rejects(
    board.writeOutcome(owner, { ...outcome, content: 'stale', expectedRevision: 1 }),
    coded('board_outcome_conflict'),
    'whole text at a stale revision is refused',
  );
  await assert.rejects(
    board.writeOutcome(owner, { ...outcome, content: 'none' }),
    coded('board_outcome_conflict'),
  );
  await assert.rejects(
    board.writeOutcome(owner, {
      ...outcome,
      content: 'both',
      expectedRevision: 2,
      edits: [{ find: 'one', replace: 'x' }],
    }),
    coded('invalid_board_input'),
  );
  const whole = await board.writeOutcome(owner, {
    ...outcome,
    content: 'new',
    expectedRevision: 2,
  });
  assert.equal(whole.revision, 3);
  assert.equal((await board.outcome(owner, id, made.id)).text, 'new');
  // Nothing changed is no revision.
  const same = await board.writeOutcome(owner, {
    ...outcome,
    title: 'Plan',
    edits: [{ find: 'new', replace: 'new' }],
  });
  assert.equal(same.revision, 3);
  const [line] = (await board.scene(owner, id, Number.MAX_SAFE_INTEGER)).outcomes;
  assert.deepEqual([line!.id, line!.title, line!.revision], [made.id, 'Plan', 3]);
  assert.equal('text' in line!, false, 'the poll carries no text');
});

test('an outcome stays in its project', async (t) => {
  const { board, owner, stranger, id, f } = await fixture(t);
  const made = await board.writeOutcome(owner, { board: id, title: 'Plan', content: 'text' });
  const reader = await f.scope.credentials.issueActor(owner, { name: 'R', role: 'reader' });
  await assert.rejects(
    board.outcomeSent(
      { ...owner, actorId: reader.actor.id, credentialId: reader.credential.id },
      { board: id, outcome: made.id, how: 'copy', artifactId: 'art_forged', revision: 1 },
    ),
    coded('forbidden'),
    'a reader notes no send',
  );
  await assert.rejects(board.outcome(stranger, id, made.id), coded('not_found'));
  await assert.rejects(
    board.writeOutcome(stranger, {
      board: id,
      outcome: made.id,
      content: 'x',
      expectedRevision: 1,
    }),
    coded('not_found'),
  );
});

test('freezing an unchanged outcome twice gives the same file through the tools', async (t) => {
  const { owner, id, tool } = await fixture(t);
  const { outcome } = (await tool('board.write:outcome', owner, {
    board: id,
    title: 'Plan',
    content: '# Plan',
  })) as { outcome: { id: string; revision: number } };
  const file = () =>
    tool('artifact.write:create', owner, {
      title: 'Plan',
      content: '# Plan',
      mediaType: 'text/markdown',
      requestId: `${outcome.id}:${outcome.revision}`,
    }) as Promise<{ id: string }>;
  assert.equal((await file()).id, (await file()).id);
  const read = (await tool('board.read:get', owner, { board: id })) as {
    outcomes: { id: string }[];
  };
  assert.deepEqual(
    read.outcomes.map((one) => one.id),
    [outcome.id],
  );
});

test('a send to Fleet learns its task from the first task whose goal names its file', async (t) => {
  const { board, owner, id, tool, f } = await fixture(t, true);
  const made = await board.writeOutcome(owner, { board: id, title: 'Plan', content: 'Do it.' });
  const artifactId = 'art_frozen-1';
  const send = (how: 'fleet' | 'copy') =>
    board.outcomeSent(owner, { board: id, outcome: made.id, how, artifactId, revision: 1 });
  await send('copy');
  await send('fleet');
  const task = (goal: string) =>
    tool('task.write:create', owner, {
      title: 'Plan',
      goal,
      checks: ['Done'],
      requestId: goal,
    }) as Promise<{ id: string }>;
  const sends = async () => {
    await f.domainEvents.drain();
    return (await board.outcome(owner, id, made.id)).sent;
  };
  await task('Nothing to read here.');
  assert.ok((await sends()).every((one) => !one.taskId));
  const first = await task(`Read ${artifactId} first.`);
  const linked = await sends();
  assert.equal(linked.find((one) => one.how === 'fleet')?.taskId, first.id);
  assert.equal(linked.find((one) => one.how === 'copy')?.taskId, undefined, 'only what Fleet took');
  await task(`See also ${artifactId}.`);
  assert.equal((await sends()).find((one) => one.how === 'fleet')?.taskId, first.id, 'the first');
  await send('fleet');
  assert.equal((await sends()).find((one) => one.how === 'fleet')?.taskId, undefined, 'sent anew');
});
