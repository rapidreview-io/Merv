import type { Scope, StoredEvent, Transaction, Workflows } from '@merv/contracts';

import { SandboxRuns, sandboxRunMigrations } from '@merv/sandboxes/sandbox-runs';

import type { WorkSession } from '@merv/sessions/types';

import { initializeNativeMigrations } from '@merv/workflows/native-migration';

import type { MervRunScope, MervWorkScope, SbxMerv } from '@sandboxes/merv-host/types';

import assert from 'node:assert/strict';

import test, { type TestContext } from 'node:test';
import { deferred as gate } from './fixtures/deferred.js';
import { openState } from './fixtures/state.js';

async function fixture(t: TestContext) {
  const state = await openState();
  t.after(() => state.close());
  await state.migrate('sandbox-runs', sandboxRunMigrations);
  await initializeNativeMigrations(state);
  await state.transaction(async (tx) => {
    await tx.run(
      'CREATE TABLE work(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,state TEXT NOT NULL,data_json TEXT NOT NULL)',
    );
    await tx.run(
      "CREATE VIEW wf_instances AS SELECT *, 'project'::text AS project_id, 46 AS version FROM work",
    );
    await tx.run(
      "INSERT INTO work VALUES('work',1,'open',?)",
      JSON.stringify({ computeEpoch: 'attempt-1' }),
    );
  });
  const workflows = {
    async relations(_project: string, id: string, tx: Transaction) {
      const row = await tx.get<{ revision: number; state: string; data_json: string }>(
        'SELECT * FROM work WHERE id=?',
        id,
      );
      return (
        row && {
          instance: {
            ...row,
            workflow: 'task',
            version: 1,
            terminal: row.state === 'done',
            data: JSON.parse(row.data_json),
          },
        }
      );
    },
  } as unknown as Workflows;
  let link = { namespace: 'original', account_id: 'account', member_id: 'member' };
  const tokens = new Map<string, MervRunScope>();
  const retired: { kind: string; scope: MervWorkScope }[] = [];
  let beforeIssue: (() => Promise<void>) | undefined;
  let lostReply = false;
  let finalized = true;
  let linkReads = 0;
  const outside = () => {
    assert.equal(state.ambient, undefined, 'Sandboxes must run outside Merv transactions');
    assert.equal(state.readScope, false, 'Sandboxes must run outside Merv snapshots');
  };
  const host = {
    async linked() {
      outside();
      linkReads++;
      return link;
    },
    async launchConnection(_caller: unknown, run: MervRunScope) {
      outside();
      const persisted = await state.read((sql) =>
        sql.get<Record<string, unknown>>(
          'SELECT * FROM sandbox_run_intents WHERE run_ref=?',
          run.runRef,
        ),
      );
      assert.equal(persisted?.namespace, run.namespace, 'scope is durable before issuing');
      assert.equal(persisted?.account_id, run.accountId);
      assert.equal(persisted?.work_ref, run.workRef);
      assert.equal(persisted?.attempt_ref, run.attemptRef);
      await beforeIssue?.();
      const bearer = `sbxt_${tokens.size + 1}_${run.runRef}`;
      tokens.set(bearer, run);
      if (lostReply) throw new Error('reply lost after mint');
      return { name: 'sandboxes', url: 'https://sandboxes.example/mcp', bearer };
    },
    async retireRun(_caller: unknown, run: MervRunScope) {
      outside();
      retired.push({ kind: 'run', scope: run });
      for (const [token, scope] of tokens) if (scope.runRef === run.runRef) tokens.delete(token);
    },
    async retireAttempt(_caller: unknown, run: MervRunScope) {
      outside();
      retired.push({ kind: 'attempt', scope: run });
      for (const [token, scope] of tokens)
        if (scope.attemptRef === run.attemptRef) tokens.delete(token);
    },
    async releaseWork(_caller: unknown, run: MervWorkScope) {
      outside();
      retired.push({ kind: 'work', scope: run });
      tokens.clear();
      return finalized;
    },
  } as unknown as SbxMerv;
  const scope = {
    serviceActor: async (_provider: string, projectId: string) => ({
      projectId,
      actorId: 'service',
    }),
  } as Scope;
  let now = Date.now();
  const create = () => new SandboxRuns(state, scope, workflows, host, () => now);
  const runs = create();
  async function session(id = 'run-1', revision = 1) {
    const session = {
      id,
      projectId: 'project',
      instanceId: 'work',
      expectedRevision: revision,
      hardDeadline: new Date(Date.now() + 3600_000).toISOString(),
      execution: {
        workflow: 'task',
        references: { computeKind: 'task' },
        policy: { readOnly: false, workspace: { mode: 'persistent' } },
      },
    } as unknown as WorkSession;
    return session;
  }
  async function close(id: string) {
    await event('session.closed', id);
  }
  async function transition(revision: number, epoch: string, status = 'open') {
    await state.transaction((tx) =>
      tx.run(
        'UPDATE work SET revision=?,state=?,data_json=?',
        revision,
        status,
        JSON.stringify({ computeEpoch: epoch }),
      ),
    );
    await event('workflow.transition', 'work');
  }
  async function event(type: string, subjectId: string) {
    await state.transaction((tx) =>
      runs.event({ type, subjectId, projectId: 'project', data: {} } as StoredEvent, tx),
    );
  }
  return {
    state,
    runs,
    create,
    tokens,
    retired,
    session,
    close,
    transition,
    event,
    onIssue(fn: () => Promise<void>) {
      beforeIssue = fn;
    },
    loseReply() {
      lostReply = true;
    },
    relink() {
      link = { ...link, namespace: 'replacement', account_id: 'replacement-account' };
    },
    finalized(value: boolean) {
      finalized = value;
    },
    linkReads: () => linkReads,
    advance(ms: number) {
      now += ms;
    },
  };
}

test('launch scope is durable before issuance and contains no returned secret', async (t) => {
  const f = await fixture(t);
  const session = await f.session();
  const [connection] = await f.runs.launchConnections(session);
  assert.equal(connection.name, 'sandboxes');
  assert.equal(f.tokens.size, 1);
  const row = await f.state.read((sql) => sql.get('SELECT * FROM sandbox_run_intents'));
  assert.equal(JSON.stringify(row).includes(connection.bearer), false);
  await f.runs.reconcile();
  assert.deepEqual(f.retired, []);
});

test('close while issuing withholds the connection and retires again after issuance settles', async (t) => {
  const f = await fixture(t);
  const session = await f.session();
  const entered = gate(),
    finish = gate();
  f.onIssue(async () => {
    entered.resolve();
    await finish.promise;
  });
  const issued = f.runs.launchConnections(session);
  const refused = assert.rejects(issued, { code: 'session_closed' });
  await entered.promise;
  await f.close(session.id);
  await f.runs.reconcile();
  assert.equal(f.retired.length, 1);
  finish.resolve();
  await refused;
  assert.equal(f.retired.length, 2);
  assert.equal(f.tokens.size, 0);
  assert.deepEqual(
    f.retired.map((call) => call.kind),
    ['run', 'run'],
  );
});

test('handoff preserves the successor while a changed epoch retires the old attempt', async (t) => {
  const f = await fixture(t);
  const first = await f.session();
  await f.runs.launchConnections(first);
  await f.close(first.id);
  await f.transition(2, 'attempt-1');
  const second = await f.session('run-2', 2);
  await f.runs.launchConnections(second);
  await f.runs.reconcile();
  assert.equal(f.tokens.size, 1);
  assert.equal([...f.tokens.values()][0].runRef, second.id);
  assert.deepEqual(
    f.retired.map((call) => call.kind),
    ['run'],
  );
  await f.transition(3, 'attempt-2');
  await f.runs.reconcile();
  assert.equal(f.tokens.size, 0);
  assert.ok(f.retired.some((call) => call.kind === 'attempt'));
  const third = await f.session('run-3', 3);
  await f.runs.launchConnections(third);
  await f.event('workflow.transition', 'work');
  await f.runs.reconcile();
  assert.equal(f.tokens.size, 1);
  assert.equal([...f.tokens.values()][0].attemptRef, 'attempt-2');
});

test('crash recovery cleans the recorded scope after relinking and retries work finalization', async (t) => {
  const f = await fixture(t);
  const session = await f.session();
  f.loseReply();
  await assert.rejects(f.runs.launchConnections(session), /reply lost/);
  assert.equal(f.tokens.size, 1);
  f.relink();
  f.finalized(false);
  await f.transition(2, 'attempt-1', 'done');
  const recovered = f.create();
  await recovered.reconcile();
  assert.equal(f.tokens.size, 0);
  // A finalization put off (its pipelines still finishing) is asked again 15 s later, not sooner.
  await recovered.reconcile();
  assert.equal(f.retired.length, 1);
  f.advance(15_000);
  await recovered.reconcile();
  assert.equal(f.retired.length, 2);
  f.finalized(true);
  f.advance(15_000);
  await recovered.reconcile();
  await recovered.reconcile();
  assert.equal(f.retired.length, 3);
  assert.ok(
    f.retired.every(
      (call) =>
        call.kind === 'work' &&
        call.scope.namespace === 'original' &&
        call.scope.accountId === 'account',
    ),
  );
  assert.equal(f.linkReads(), 1, 'recovery never reads the current project link');
});
