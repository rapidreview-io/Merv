import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createService } from '@merv/contracts';
import type { Caller, WorkflowDefinition } from '@merv/contracts';
import { PostgresState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { openState } from './fixtures/state.js';

const graph: WorkflowDefinition = {
  name: 'lean_atomicity',
  version: 1,
  initial: 'active',
  states: ['active', 'done'],
  terminal: ['done'],
  edges: [
    { from: 'active', action: 'tick', to: 'active' },
    { from: 'active', action: 'finish', to: 'done' },
  ],
};

async function setup(key = ':memory:') {
  const state = await openState(key);
  const scope = await createService(new ProjectScope(state));
  const credentials = await scope.bootstrap({ projectName: 'Atomicity', actorName: 'Operator' });
  const caller: Caller = { actorId: credentials.actor.id, projectId: credentials.project.id };
  const workflows = await createService(new WorkflowsService(state, scope));
  const program = await workflows.register(graph);
  return { state, caller, workflows, program };
}

async function ledger(state: PostgresState, caller: Caller) {
  const receiptCount = await state.transaction(async (tx) => {
    const row = await tx.get<{ count: string }>(
      'SELECT COUNT(*) AS count FROM wf_requests WHERE project_id = ?',
      caller.projectId,
    );
    return Number(row?.count);
  });
  const eventCount = (await state.events(caller.projectId)).filter(
    (event) => event.type === 'workflow.transition',
  ).length;
  return { receiptCount, eventCount };
}

const errorCode = (expected: string) => (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === expected;

test('competing connections serialize a self-loop and leave the loser retryable', async (t) => {
  const key = join(tmpdir(), `merv-lean-atomicity-${randomUUID()}`);
  const { state, caller, workflows, program } = await setup(key);
  t.after(async () => await state.close());
  const otherState = await openState(key);
  t.after(async () => await otherState.close());
  const other = await createService(
    new WorkflowsService(otherState, await createService(new ProjectScope(otherState))),
  );
  const otherProgram = await other.register(graph);
  const initial = await program.start(caller, { workflow: graph.name, requestId: 'start' });
  const commands = ['writer-a', 'writer-b'].map((requestId) => ({
    instanceId: initial.id,
    requestId,
    action: 'tick',
    expectedRevision: 0,
  }));
  const results = await Promise.allSettled([
    program.transition(caller, commands[0]),
    otherProgram.transition(caller, commands[1]),
  ]);
  const winner = results.findIndex((result) => result.status === 'fulfilled');
  assert.ok(winner === 0 || winner === 1, 'one writer must commit');
  const loser = 1 - winner;
  assert.equal(results[loser].status, 'rejected');
  assert.ok(errorCode('revision_conflict')((results[loser] as PromiseRejectedResult).reason));
  assert.equal((await workflows.get(caller, initial.id)).revision, 1);
  assert.equal((await workflows.history(caller, initial.id)).length, 2);
  assert.deepEqual(await ledger(state, caller), { receiptCount: 2, eventCount: 2 });
  await assert.rejects(
    otherProgram.transition(caller, commands[loser]),
    errorCode('revision_conflict'),
  );
  const retried = await otherProgram.transition(caller, {
    ...commands[loser],
    expectedRevision: 1,
  });
  assert.equal(retried.revision, 2);
  const replay = await program.transition(caller, commands[winner]);
  assert.equal(replay.revision, 1);
  assert.equal((await workflows.get(caller, initial.id)).revision, 2);
  assert.equal((await workflows.history(caller, initial.id)).length, 3);
  assert.deepEqual(await ledger(state, caller), { receiptCount: 3, eventCount: 3 });
});

test('receipt, history, and event insertion failures roll back the entire transition', async (t) => {
  const { state, caller, workflows, program } = await setup();
  t.after(async () => await state.close());
  for (const stage of ['wf_requests', 'wf_history', 'events', 'after_transition'] as const) {
    const initial = await program.start(caller, {
      workflow: graph.name,
      requestId: `start-${stage}`,
    });
    const before = await ledger(state, caller);
    const command = {
      instanceId: initial.id,
      requestId: `finish-${stage}`,
      action: 'finish',
      expectedRevision: 0,
    };
    let injectionFired = false;
    await assert.rejects(
      state.transaction(async (tx) => {
        if (stage !== 'after_transition') {
          const { run, get, all } = tx;
          const target = new RegExp(`^\\s*INSERT\\s+INTO\\s+${stage}\\b`, 'i');
          const inject = (sql: string) => {
            if (target.test(sql)) {
              injectionFired = true;
              throw new Error(`injected ${stage}`);
            }
          };
          Object.assign(tx, {
            run: (sql: string, ...args: never[]) => {
              inject(sql);
              return run(sql, ...args);
            },
            get: (sql: string, ...args: never[]) => {
              inject(sql);
              return get(sql, ...args);
            },
            all: (sql: string, ...args: never[]) => {
              inject(sql);
              return all(sql, ...args);
            },
          });
        }
        await program.transition(caller, command, tx);
        if (stage === 'after_transition') {
          injectionFired = true;
          throw new Error('injected after_transition');
        }
      }),
      /injected/,
    );
    assert.ok(injectionFired, `${stage} injection did not intercept a write`);
    assert.deepEqual(await ledger(state, caller), before, `${stage} left a ledger write behind`);
    assert.equal((await workflows.get(caller, initial.id)).revision, 0);
    assert.equal((await workflows.history(caller, initial.id)).length, 1);
    const committed = await program.transition(caller, command);
    assert.equal(committed.revision, 1, `${stage} left a request receipt behind`);
    assert.deepEqual(await ledger(state, caller), {
      receiptCount: before.receiptCount + 1,
      eventCount: before.eventCount + 1,
    });
  }
});
