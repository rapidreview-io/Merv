import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from 'cordis';
import { createService } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { DiskBlobs } from '@merv/blobs/disk';
import { sessionsPlugin } from '@merv/sessions';
import type { Artifacts, Scope, StoredEvent, Transaction, Workflows } from '@merv/contracts';
import { SandboxRuns, sandboxRunMigrations } from '@merv/sandboxes/sandbox-runs';
import { sandboxIntegrationPlugin } from '@merv/sandboxes/integration';
import type { WorkSession } from '@merv/sessions/types';
import type { MervRunScope, MervWorkScope, SbxMerv } from '@sandboxes/merv-host/types';
import type { SbxPipelines } from '@sandboxes/pipelines';
import type { SbxObjects } from '@sandboxes/storage';
import type { SbxAccounts } from '@sandboxes/accounts';
import { openState } from './fixtures/state.js';
import { deferred as gate } from './fixtures/deferred.js';

async function fixture(t: TestContext) {
  const state = await openState();
  t.after(() => state.close());
  await state.migrate('sandbox-runs', sandboxRunMigrations);
  await state.transaction(async (tx) => {
    await tx.run(
      'CREATE TABLE work(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,state TEXT NOT NULL,data_json TEXT NOT NULL)',
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

test('returning to an epoch retires only the old run and preserves its successor', async (t) => {
  const f = await fixture(t);
  const first = await f.session();
  await f.runs.launchConnections(first);
  await f.close(first.id);
  await f.transition(2, 'attempt-2');
  await f.transition(3, 'attempt-1');
  const second = await f.session('run-2', 3);
  await f.runs.launchConnections(second);
  await f.runs.reconcile();
  assert.equal(f.tokens.size, 1);
  assert.equal([...f.tokens.values()][0].runRef, second.id);
  assert.deepEqual(
    f.retired.map((call) => call.kind),
    ['run'],
  );
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

test('closed or excluded assignments cannot issue connections', async (t) => {
  const f = await fixture(t);
  const session = await f.session();
  for (const change of [
    { references: {} },
    { references: { computeKind: 'task', computeProfile: 'none' } },
  ]) {
    assert.deepEqual(
      await f.runs.launchConnections({
        ...session,
        execution: { ...session.execution, ...change },
      } as WorkSession),
      [],
    );
  }
  assert.equal(f.linkReads(), 0);
  await f.runs.launchConnections(session);
  await f.close(session.id);
  await assert.rejects(f.runs.launchConnections(session), { code: 'session_closed' });
  await f.runs.reconcile();
  assert.equal(f.tokens.size, 0);
});

test('Sandboxes integration issues connections and follows committed session and workflow events', async (t) => {
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const workflows = await createService(new WorkflowsService(state, scope));
  const events = await createService(new DurableEvents(state));
  const directory = mkdtempSync(join(tmpdir(), 'merv-sandbox-runs-'));
  const blobs = new DiskBlobs(directory);
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    await events.close();
    await workflows.close();
    await blobs.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const retired: MervRunScope[] = [],
    released: MervWorkScope[] = [];
  ctx.provide('state', state);
  ctx.provide('scope', scope);
  ctx.provide('workflows', workflows);
  ctx.provide('domainEvents', events);
  ctx.provide('blobs', blobs);
  ctx.provide('sbxMerv', {
    linked: async () => ({ namespace: 'linked', account_id: 'account', member_id: 'member' }),
    launchConnection: async () => ({
      name: 'sandboxes',
      url: 'https://sandboxes.example/mcp',
      bearer: `sbxt_${'a'.repeat(43)}`,
    }),
    retireRun: async (_caller: unknown, run: MervRunScope) => {
      retired.push(run);
    },
    retireAttempt: async () => {},
    releaseWork: async (_caller: unknown, work: MervWorkScope) => {
      released.push(work);
      return true;
    },
  } as unknown as SbxMerv);
  ctx.provide('artifacts', {
    registerFileProvider: () => () => {},
  } as unknown as Artifacts);
  ctx.provide('sbxPipelines', {
    list: async () => ({ workflows: [], next: null }),
  } as unknown as SbxPipelines);
  ctx.provide('sbxObjects', {} as SbxObjects);
  ctx.provide('sbxAccounts', {} as SbxAccounts);
  await ctx.plugin(sessionsPlugin, { sweepIntervalMs: 60_000 });
  ctx.provide('sbxJobs', {
    listPage: async () => ({ jobs: [], next: null }),
  } as unknown as Context['sbxJobs']);
  await ctx.plugin(sandboxIntegrationPlugin);
  const boot = await scope.credentials.bootstrap({ projectName: 'Runs', actorName: 'Owner' });
  const caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const program = await workflows.register(
    {
      name: 'runs',
      version: 1,
      initial: 'working',
      states: ['working', 'done'],
      terminal: ['done'],
      edges: [{ from: 'working', action: 'finish', to: 'done' }],
    },
    {
      actions: [
        {
          name: 'finish',
          states: ['working'],
          transitions: ['finish'],
          tool: 'finish',
          instruction: 'Finish',
          check: () => {},
        },
      ],
      assignments: [
        {
          state: 'working',
          check: () => {},
          build: () => ({
            role: 'producer',
            label: 'Work',
            brief: 'Work',
            references: [],
            handoff: { instruction: 'Finish', tools: ['finish'] },
            execution: { readOnly: false, tools: [] },
            context: null,
          }),
          execution: { readOnly: false, tools: [] },
          references: () => ({ computeKind: 'task' }),
          lease: {
            role: () => 'producer',
            acquire: () => ({}),
            check: () => {},
            release: () => {},
          },
        },
      ],
    },
  );
  const instance = await program.start(caller, { workflow: 'runs', requestId: 'work' });
  const session = await ctx.sessions.offer(caller, {
    instanceId: instance.id,
    expectedRevision: instance.revision,
    runnerId: 'runner',
    requestId: 'run',
    secret: `ms_${randomBytes(32).toString('base64url')}`,
  });
  const input = { sessionId: session.id, runnerId: 'runner', hostRef: 'host' };
  await ctx.sessions.attach(caller, input);
  const connection = await ctx.sessions.launchConnections(caller, input);
  assert.equal(connection.connections[0]?.name, 'sandboxes');
  await ctx.sessions.release(caller, { sessionId: session.id, runnerId: 'runner' });
  await events.drain();
  const waitFor = async (check: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!check()) {
      assert.ok(Date.now() < deadline, 'Sandbox cleanup did not run');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  await waitFor(() => retired.length > 0);
  assert.equal(retired[0].runRef, session.id);
  await program.transition(caller, {
    instanceId: instance.id,
    expectedRevision: instance.revision,
    action: 'finish',
    requestId: 'done',
  });
  await events.drain();
  await waitFor(() => released.length > 0);
  assert.equal(released[0].workRef, instance.id);
});
