/**
 * Sandboxes' compute waiter for Sessions (`session.await_compute`): where a waiting visit's jobs
 * and workflows stand, read for its own work and attempt from its run intent, over Merv's real
 * state and capture index, with fakes for the Sandboxes services it reads outside transactions.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Artifacts, Scope } from '@merv/contracts';
import type { ComputeTarget } from '@merv/sessions/types';
import { SandboxComputeWaits } from '@merv/sandboxes/compute-waits';
import { SandboxEvidence } from '@merv/sandboxes/sandbox-evidence';
import { sandboxRunMigrations } from '@merv/sandboxes/sandbox-runs';
import type { JobRecord } from '@sandboxes/jobs';
import { Instant, NotFoundError } from '@sandboxes/kernel';
import type { WorkflowRecord } from '@sandboxes/pipelines';
import type { SandboxRecord } from '@sandboxes/registry';
import { openState } from './fixtures/state.js';

async function fixture(t: TestContext) {
  const state = await openState();
  t.after(() => state.close());
  await state.migrate('sandbox-runs', sandboxRunMigrations);
  // Only its capture index is read here.
  const evidence = new SandboxEvidence(
    state,
    {} as Scope,
    {} as Artifacts,
    {} as never,
    {} as never,
    {} as never,
  );
  await evidence.initialize();
  await state.transaction((tx) =>
    tx.run(
      `INSERT INTO sandbox_run_intents(run_ref,project_id,namespace,account_id,work_ref,attempt_ref)
       VALUES('visit','project','ns','account','work','epoch-1')`,
    ),
  );
  let now = Date.parse('2026-10-18T12:00:00.000Z');
  const jobs = new Map<string, JobRecord>();
  const workflows = new Map<string, WorkflowRecord>();
  const machines: SandboxRecord[] = [];
  let linked: { namespace: string } | null = { namespace: 'ns' };
  let linkReads = 0;
  let failing: Error | undefined;
  const outside = () => {
    assert.equal(state.ambient, undefined, 'Sandboxes is read outside Merv transactions');
    assert.equal(state.readScope, false, 'Sandboxes is read outside Merv snapshots');
  };
  const waiter = new SandboxComputeWaits(
    state,
    {
      linked: async () => {
        outside();
        linkReads++;
        return linked as never;
      },
    },
    {
      find: async (id) => {
        outside();
        return jobs.get(id) ?? null;
      },
    },
    {
      get: async (namespace, id) => {
        outside();
        if (failing) throw failing;
        const found = workflows.get(id);
        if (!found || found.namespace !== namespace) throw new NotFoundError('workflow not found');
        return found;
      },
    },
    {
      list: async (namespace, options) => {
        outside();
        assert.equal(options?.workRef, 'work');
        return machines.filter(
          (machine) => machine.namespace === namespace && machine.state !== 'stopped',
        );
      },
    },
    evidence,
    () => now,
  );
  const at = (ms: number) => Instant.fromMillis(now + ms);
  const ours = { namespace: 'ns', work_ref: 'work', attempt_ref: 'epoch-1' };
  return {
    advance: (ms: number) => {
      now += ms;
    },
    at: (ms: number) => new Date(now + ms).toISOString(),
    link: (value: { namespace: string } | null) => {
      linked = value;
    },
    linkReads: () => linkReads,
    fail: (error?: Error) => {
      failing = error;
    },
    waiter,
    ask: (targets: ComputeTarget[], sessionId = 'visit') =>
      waiter.states({ projectId: 'project', instanceId: 'work', sessionId, targets }),
    job: (id: string, fields: Partial<JobRecord> = {}) =>
      jobs.set(id, {
        ...ours,
        id,
        sandbox_id: 'sbx_a',
        state: 'running',
        exit_code: null,
        started_at: at(-60_000),
        request: { timeout_seconds: 0 },
        ...fields,
      } as JobRecord),
    workflow: (id: string, fields: Partial<WorkflowRecord> = {}) =>
      workflows.set(id, {
        ...ours,
        id,
        state: 'running',
        request: { nodes: [{ id: 'output', kind: 'capture' }] },
        nodes: { output: { state: 'pending', result: {} } },
        capture_deadline_at: at(3_600_000),
        ...fields,
      } as unknown as WorkflowRecord),
    machine: (id: string, fields: Partial<SandboxRecord> = {}) =>
      machines.push({
        ...ours,
        id,
        state: 'ready',
        lease_expires_at: at(7_200_000),
        ...fields,
      } as SandboxRecord),
    /** The capture index row the evidence pass writes for one capture node. */
    index: (
      workflowId: string,
      node: string,
      row: { artifact?: string; error?: string; stalled?: true },
    ) =>
      state.transaction((tx) =>
        tx.run(
          `INSERT INTO sandbox_capture_index(project_id,namespace,work_ref,workflow_id,node_id,attempt_ref,artifact_id,error,stalled) VALUES(?,?,?,?,?,?,?,?,${!!row.stalled})`,
          'project',
          'ns',
          'work',
          workflowId,
          node,
          'epoch-1',
          row.artifact ?? null,
          row.error ?? null,
        ),
      ),
  };
}
const job = (id: string): ComputeTarget => ({ kind: 'job', id });
const workflow = (id: string): ComputeTarget => ({ kind: 'workflow', id });

test('a running job is running, bounded by its machine’s lease and its deadline; one that finished says how', async (t) => {
  const f = await fixture(t);
  f.machine('sbx_a');
  f.job('job_a', { request: { timeout_seconds: 3600 } as JobRecord['request'] });
  assert.deepEqual(await f.ask([job('job_a')]), {
    targets: [{ kind: 'job', id: 'job_a', status: 'running', state: 'running' }],
    lease: { machine: 'sbx_a', endsAt: f.at(7_200_000) },
    deadline: { target: job('job_a'), at: f.at(-60_000 + 3_600_000) },
    idle: [],
  });
  // What ended says how, with its exit code; with nothing left running, nothing bounds a wait.
  f.job('job_b', { state: 'succeeded', exit_code: 0 });
  f.job('job_c', { state: 'timed_out', exit_code: 137 });
  assert.deepEqual(await f.ask([job('job_b'), job('job_c')]), {
    targets: [
      { kind: 'job', id: 'job_b', status: 'succeeded', state: 'succeeded', exitCode: 0 },
      { kind: 'job', id: 'job_c', status: 'failed', state: 'timed_out', exitCode: 137 },
    ],
    idle: [],
  });
  // One with no timeout leaves no time by which all must have ended.
  f.job('job_d', { sandbox_id: 'sbx_a' });
  const read = await f.ask([job('job_a'), job('job_d')]);
  assert.equal(read.deadline, undefined);
  assert.deepEqual(read.lease, { machine: 'sbx_a', endsAt: f.at(7_200_000) });
  // A workflow's job runs within that workflow's deadline, on its machines: they bound nothing.
  f.job('job_e', {
    sandbox_id: 'sbx_a',
    request: { timeout_seconds: 600, workflow_id: 'pipe_x' } as JobRecord['request'],
  });
  assert.equal((await f.ask([job('job_e')])).lease, undefined);
});

test('another work’s or attempt’s job or workflow, a missing one, and a visit with no run of its own are unknown', async (t) => {
  const f = await fixture(t);
  f.job('job_ns', { namespace: 'other' });
  f.job('job_work', { work_ref: 'other' });
  f.job('job_attempt', { attempt_ref: 'epoch-0' });
  f.workflow('pipe_attempt', { attempt_ref: 'epoch-0' });
  f.job('job_a');
  const targets = [
    job('job_ns'),
    job('job_work'),
    job('job_attempt'),
    job('job_missing'),
    workflow('pipe_attempt'),
    workflow('pipe_missing'),
  ];
  assert.deepEqual(
    (await f.ask(targets)).targets.map((target) => [target.id, target.status]),
    targets.map((target) => [target.id, 'unknown']),
  );
  assert.deepEqual(await f.ask([job('job_a')], 'another-visit'), {
    targets: [{ kind: 'job', id: 'job_a', status: 'unknown' }],
    idle: [],
  });
});

test('a workflow runs until it has finished and each capture that ended is registered or refused for good', async (t) => {
  const f = await fixture(t);
  const state = async (id: string) => (await f.ask([workflow(id)])).targets[0];
  // Running, it is bounded by its capture deadline and keeps the machine it adopted, whose lease
  // bounds the wait; the machine it rented itself is its own to delete.
  f.machine('sbx_rented');
  f.machine('sbx_own', { lease_expires_at: Instant.fromMillis(Date.parse(f.at(3_600_000))) });
  f.workflow('pipe_run', {
    request: {
      nodes: [
        { id: 'own', kind: 'provision' },
        { id: 'rented', kind: 'use_vm' },
        { id: 'output', kind: 'capture' },
      ],
    } as unknown as WorkflowRecord['request'],
    nodes: {
      own: { state: 'succeeded', result: { sandbox_id: 'sbx_own' } },
      rented: { state: 'succeeded', result: { sandbox_id: 'sbx_rented' } },
      output: { state: 'pending', result: {} },
    } as unknown as WorkflowRecord['nodes'],
  });
  assert.deepEqual(await f.ask([workflow('pipe_run')]), {
    targets: [{ kind: 'workflow', id: 'pipe_run', status: 'running', state: 'running' }],
    lease: { machine: 'sbx_rented', endsAt: f.at(7_200_000) },
    deadline: { target: workflow('pipe_run'), at: f.at(3_600_000) },
    idle: [],
  });
  // Finished, it waits for its captures, and a stalled one is still retried.
  const done = {
    state: 'completed',
    nodes: { output: { state: 'succeeded', result: {} } },
  } as unknown as Partial<WorkflowRecord>;
  f.workflow('pipe_done', done);
  assert.deepEqual(await state('pipe_done'), {
    kind: 'workflow',
    id: 'pipe_done',
    status: 'running',
    state: 'registering_captures',
  });
  await f.index('pipe_done', 'output', { error: 'Not registered yet', stalled: true });
  assert.equal((await state('pipe_done'))!.status, 'running');
  f.workflow('pipe_registered', done);
  await f.index('pipe_registered', 'output', { artifact: 'art_1' });
  assert.deepEqual(await state('pipe_registered'), {
    kind: 'workflow',
    id: 'pipe_registered',
    status: 'succeeded',
    state: 'completed',
  });
  f.workflow('pipe_refused', done);
  await f.index('pipe_refused', 'output', { error: 'Unsafe capture path' });
  assert.deepEqual(await state('pipe_refused'), {
    kind: 'workflow',
    id: 'pipe_refused',
    status: 'failed',
    state: 'capture_refused',
  });
  f.workflow('pipe_failed', { ...done, state: 'failed' });
  await f.index('pipe_failed', 'output', { artifact: 'art_2' });
  assert.deepEqual(await state('pipe_failed'), {
    kind: 'workflow',
    id: 'pipe_failed',
    status: 'failed',
    state: 'failed',
  });
  // A capture that never ran has nothing to register; a workflow with none has settled at once.
  f.workflow('pipe_none', {
    state: 'completed',
    request: { nodes: [] } as unknown as WorkflowRecord['request'],
    nodes: {},
  });
  assert.equal((await state('pipe_none'))!.status, 'succeeded');
  f.workflow('pipe_skipped', {
    state: 'cancelled',
    nodes: { output: { state: 'pending', result: {} } } as unknown as WorkflowRecord['nodes'],
  });
  assert.deepEqual(await state('pipe_skipped'), {
    kind: 'workflow',
    id: 'pipe_skipped',
    status: 'failed',
    state: 'cancelled',
  });
});

test('the work’s other live machines of this attempt are idle; another attempt’s, one deleting and a workflow’s own are not', async (t) => {
  const f = await fixture(t);
  f.job('job_a');
  f.machine('sbx_a');
  f.machine('sbx_idle');
  f.machine('sbx_kept', { attempt_ref: 'epoch-0' });
  f.machine('sbx_deleting', { state: 'deleting' });
  f.machine('sbx_own');
  f.workflow('pipe_b', {
    request: {
      nodes: [
        { id: 'own', kind: 'provision' },
        { id: 'output', kind: 'capture' },
      ],
    } as unknown as WorkflowRecord['request'],
    nodes: {
      own: { state: 'succeeded', result: { sandbox_id: 'sbx_own' } },
      output: { state: 'pending', result: {} },
    } as unknown as WorkflowRecord['nodes'],
  });
  assert.deepEqual((await f.ask([job('job_a'), workflow('pipe_b')])).idle, ['sbx_idle']);
  // A job of the work that was not named keeps its machine busy only once it is named.
  f.job('job_c', { sandbox_id: 'sbx_idle' });
  assert.deepEqual((await f.ask([job('job_a'), job('job_c'), workflow('pipe_b')])).idle, []);
});

test('a Sandboxes read that fails for any reason but not found fails the whole answer', async (t) => {
  const f = await fixture(t);
  f.workflow('pipe_a');
  f.fail(new Error('The Sandboxes database is away'));
  await assert.rejects(f.ask([workflow('pipe_a')]), /database is away/);
});

test('whether a project is linked is read at most once a minute', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.waiter.offers('project'), true);
  assert.equal(await f.waiter.offers('project'), true);
  assert.equal(f.linkReads(), 1);
  f.link(null);
  f.advance(60_000);
  assert.equal(await f.waiter.offers('project'), false);
  assert.equal(f.linkReads(), 2);
});
