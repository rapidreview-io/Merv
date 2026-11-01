import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRun, AgentsState } from '@merv/board/agents-models';
import boardAgentsPlugin from '@merv/board/agents';
import { agentAudience } from '@merv/api/audience';
import type { Caller } from '@merv/contracts';
import { httpApp } from './fixtures/app.js';

type Polled = { stop: string[]; run?: AgentRun };
const HERE = { name: 'Mac', workspace: 'scratch', harnesses: { claude: { ok: true, detail: '' } } };

async function fixture(t: test.TestContext) {
  const f = await httpApp(t, 'board-agents-');
  const boot = await f.app.ctx.scope.credentials.bootstrap({
    projectName: 'Sketches',
    actorName: 'Owner',
  });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  await f.app.ctx.plugin(boardAgentsPlugin).await();
  const { tools } = f.app.ctx;
  const board = (await f.app.ctx.board.create(owner, 'Sketch')).id;
  const call = <T>(name: string, input: object, caller = owner) =>
    tools.call(name, caller, input) as Promise<T>;
  const state = () => call<AgentsState>('board.agents.state', { board });
  const made = await call<{ task: string; frame: string; status: string }>('board.task', {
    board,
    title: 'Sparkline',
    checks: ['`node spark.mjs loss.csv`', 'Fits one line'],
  });
  return { ...f, owner, board, call, state, made };
}

test('a task is its frame as it stands: a rewritten check and a dropped-in note both count', async (t) => {
  const { board, call, state, made } = await fixture(t);
  const [first] = (await state()).tasks[0]!.checks;
  await call('board.write:draw', {
    board,
    ops: [
      { op: 'edit', id: first!.id, text: '`node --test`' },
      { op: 'note', text: 'Says the plateau', in: made.frame },
    ],
  });
  const { run } = await call<{ run: AgentRun }>('board.agents.handoff', {
    task: made.task,
    harness: 'claude',
  });
  assert.deepEqual(
    run.spec.checks.map(({ text }) => text).sort(),
    ['Fits one line', 'Says the plateau', '`node --test`'],
  );
  assert.equal(run.spec.checks.find(({ text }) => text === '`node --test`')?.command, 'node --test');
});

test('only a person hands off or stops: an agent reading the board cannot start code on a machine', async (t) => {
  const { call, made } = await fixture(t);
  await assert.rejects(
    agentAudience.run(true, () =>
      call('board.agents.handoff', { task: made.task, harness: 'claude' }),
    ),
    /Only a person/,
  );
});

test('a hand-off waits for its own person’s machine, which alone takes it, and verdicts land', async (t) => {
  const { app, owner, call, state, made } = await fixture(t);
  const { run } = await call<{ run: AgentRun }>('board.agents.handoff', {
    task: made.task,
    harness: 'claude',
  });
  const queued = await state();
  assert.equal(queued.waiting, 1);
  assert.equal(queued.connector, null);
  assert.match(queued.tasks[0]!.said, /waits for your machine/);

  const other = await app.ctx.scope.credentials.issueActor(owner, { name: 'Dana', role: 'operator' });
  const dana: Caller = {
    projectId: owner.projectId,
    actorId: other.actor.id,
    credentialId: other.credential.id,
  };
  const theirs = await call<Polled>('board.agents.poll', HERE, dana);
  assert.equal(theirs.run, undefined, 'another member’s machine never takes it');

  const taken = await call<Polled>('board.agents.poll', HERE);
  assert.equal(taken.run?.id, run.id);
  const checks = taken.run!.spec.checks;
  await call('board.agents.report', {
    run: run.id,
    state: 'failed',
    verdicts: checks.map((held, index) => ({
      check: held.id,
      pass: index > 0,
      how: index ? 'judge' : 'command',
      by: index ? 'Codex' : 'exit code',
      reason: index ? 'It fits' : 'exit 1',
    })),
    result: { summary: 'Done', files: ['spark.mjs'], stat: '1 file' },
  });
  const after = await state();
  assert.equal(after.tasks[0]!.latest?.state, 'failed');
  assert.match(after.tasks[0]!.said, /1 of 2 checks fail/);
  assert.equal(after.tasks[0]!.checks[0]!.verdict?.reason, 'exit 1');
  assert.equal(after.connector?.online, true);
});
