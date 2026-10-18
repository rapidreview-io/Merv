import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from 'cordis';
import { ArtifactStore } from '@merv/artifacts';
import { SandboxEvidence } from '@merv/sandboxes/sandbox-evidence';
import { sandboxIntegrationPlugin } from '@merv/sandboxes/integration';
import { DiskBlobs } from '@merv/blobs';
import { createService, sha256Hex } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { sandboxRunMigrations } from '@merv/sandboxes/sandbox-runs';
import type { CaptureSummary, SbxPipelines, WorkflowRecord } from '@sandboxes/pipelines';
import type { EvidenceRecord, SbxObjects } from '@sandboxes/storage';
import type { SbxAccounts } from '@sandboxes/accounts';
import { NotFoundError } from '@sandboxes/kernel';
import { openState } from './fixtures/state.js';

async function fixture(t: TestContext, registerProvider = true) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-sbx-evidence-'));
  const state = await openState(directory);
  t.after(async () => {
    await state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const scope = await createService(new ProjectScope(state));
  const artifacts = await createService(new ArtifactStore(state, scope, new DiskBlobs(directory)));
  await state.migrate('sandbox-runs', sandboxRunMigrations);
  const owner = await scope.credentials.bootstrap({ projectName: 'Evidence', actorName: 'Owner' });
  const caller = { projectId: owner.project.id, actorId: owner.actor.id };
  const source = {
    namespace: 'original',
    account_id: 'account',
    work_ref: 'work',
    attempt_ref: 'epoch-1',
    label: 'run-1',
  };
  await state.transaction((tx) =>
    tx.run(
      `INSERT INTO sandbox_run_intents(project_id,namespace,account_id,work_ref,attempt_ref,run_ref)
     VALUES(?,?,?,?,?,?)`,
      caller.projectId,
      source.namespace,
      source.account_id,
      source.work_ref,
      source.attempt_ref,
      source.label,
    ),
  );
  const workflows = new Map<string, WorkflowRecord>();
  const captures = new Map<string, CaptureSummary[]>();
  const files = new Map<string, { name: string; object_id: string }[]>();
  const retained = new Map<string, EvidenceRecord>();
  const calls: string[] = [];
  let held = true;
  let namespaceAccount = source.account_id;
  function outside(call: string) {
    assert.equal(state.ambient, undefined, call);
    assert.equal(state.readScope, false, call);
    calls.push(call);
  }
  const pipelines: Pick<SbxPipelines, 'list' | 'captures' | 'captureFiles'> = {
    async list(namespace, options) {
      outside('list');
      assert.equal(namespace, source.namespace);
      assert.equal(options?.workRef, source.work_ref);
      return { workflows: [...workflows.values()], next: null };
    },
    async captures(_namespace, workflow) {
      outside('captures');
      return { captures: captures.get(workflow) ?? [], next: null };
    },
    async captureFiles(_namespace, workflow, node) {
      outside('captureFiles');
      return { files: files.get(`${workflow}/${node}`) ?? [], next: null };
    },
  };
  const objects: Pick<SbxObjects, 'evidence' | 'download'> = {
    async evidence(namespace, objectId) {
      outside('evidence');
      assert.equal(namespace, source.namespace);
      if (!held || !retained.has(objectId)) throw new NotFoundError('Evidence hold pending');
      return retained.get(objectId)!;
    },
    async download(_namespace, objectId) {
      outside('download');
      return { object: retained.get(objectId)!, url: 'https://storage.example/file' };
    },
  };
  const accounts: Pick<SbxAccounts, 'namespace'> = {
    async namespace(name) {
      outside('namespace');
      assert.equal(name, source.namespace);
      return {
        name,
        account_id: namespaceAccount,
        default_member_id: 'member',
        merv_project_id: caller.projectId,
      };
    },
  };
  let pendingJobs = false;
  function service() {
    return new SandboxEvidence(state, scope, artifacts, pipelines, objects, accounts, Date.now, {
      listPage: async () => ({ jobs: pendingJobs ? [{} as never] : [], next: null }),
    });
  }
  const evidence = await createService(service());
  if (registerProvider) artifacts.registerFileProvider('sbx-evidence', evidence);
  function workflow(id = 'pipeline-1', attempt = source.attempt_ref) {
    const value = {
      id,
      namespace: source.namespace,
      work_ref: source.work_ref,
      attempt_ref: attempt,
      origin_token_id: `token-${id}`,
      state: 'completed',
      name: 'Training',
      evidence_limitations: [],
      request: { nodes: [{ id: 'output', kind: 'capture' }] },
      nodes: { output: { state: 'succeeded' } },
    } as unknown as WorkflowRecord;
    workflows.set(id, value);
    captures.set(id, [
      {
        id: 'output',
        state: 'succeeded',
        result: { outputs: { 'metrics.json': 'object' }, output_state: 'committed' },
      },
    ]);
    files.set(`${id}/output`, [{ name: 'metrics.json', object_id: 'object' }]);
    retained.set('object', {
      id: 'object',
      namespace: source.namespace,
      kind: 'file',
      state: 'available',
      sha256: sha256Hex(Buffer.from('metric')),
      size_bytes: 6,
      producer_pipeline_id: id,
      evidence_held: true,
      expires_at: null,
      entries: [],
    } as unknown as EvidenceRecord);
    return value;
  }
  const read = (attempts?: string[]) =>
    state.snapshotTransaction((tx) =>
      evidence.evidence(
        caller.projectId,
        [{ instanceId: 'work', attempts }, { instanceId: 'empty' }],
        tx,
      ),
    );
  return {
    pendingJobs: (value: boolean) => {
      pendingJobs = value;
    },
    state,
    scope,
    pipelines,
    objects,
    accounts,
    caller,
    source,
    artifacts,
    evidence,
    service,
    workflows,
    captures,
    files,
    retained,
    calls,
    workflow,
    read,
    held: (value: boolean) => {
      held = value;
    },
    account: (value: string) => {
      namespaceAccount = value;
    },
  };
}

test('replay and crash backfill create one immutable collection; bulk epoch reads stay in Merv', async (t) => {
  const f = await fixture(t);
  f.workflow();
  await Promise.all([f.evidence.reconcile(), f.evidence.reconcile()]);
  const restarted = await createService(f.service());
  await restarted.reconcile();
  const collections = await f.artifacts.list(f.caller);
  assert.equal(collections.length, 1);
  assert.equal(collections[0]!.files![0]!.provider, 'sbx-evidence');
  const reads = f.calls.length;
  const evidence = await f.read(['epoch-1']);
  assert.deepEqual(evidence.get('work'), { artifactIds: [collections[0]!.id], refused: [] });
  assert.deepEqual(evidence.get('empty'), { artifactIds: [], refused: [] });
  assert.deepEqual((await f.read(['epoch-2'])).get('work'), { artifactIds: [], refused: [] });
  assert.equal(f.calls.length, reads);
  await f.state.snapshotTransaction(async (tx) => {
    assert.deepEqual(await f.evidence.captures(f.caller.projectId, 'work', tx, ['epoch-1']), [
      collections[0]!.id,
    ]);
    await assert.rejects(f.evidence.reconcile(), { code: 'sandbox_evidence_transaction' });
  });
  assert.equal(
    (await f.artifacts.download(f.caller, collections[0]!.id, 'metrics.json')).download.url,
    'https://storage.example/file',
  );
});

test('an unfinished capture waits, failed captures retain partial files, and empty captures remain explicit', async (t) => {
  const f = await fixture(t);
  const original = f.workflow();
  f.workflows.set(original.id, {
    ...original,
    state: 'cleaning_up',
    nodes: { output: { state: 'running' } },
  } as unknown as WorkflowRecord);
  await f.evidence.reconcile();
  assert.deepEqual(await f.artifacts.list(f.caller), []);
  assert.equal(f.calls.includes('captures'), false);
  f.workflows.set(original.id, { ...original, state: 'failed' });
  f.captures.set(original.id, [
    { id: 'partial', state: 'failed', result: { outputs: {}, output_state: 'partial' } },
    { id: 'empty', state: 'skipped', result: { outputs: {}, output_state: null } },
  ]);
  f.files.set(`${original.id}/partial`, [{ name: 'partial/output.json', object_id: 'object' }]);
  await f.evidence.reconcile();
  const collections = await f.artifacts.list(f.caller);
  assert.equal(collections.length, 2);
  const partial = collections.find((a) => a.metadata?.captureNode === 'partial')!;
  const empty = collections.find((a) => a.metadata?.captureNode === 'empty')!;
  assert.equal(partial.files!.length, 1);
  assert.equal(empty.files!.length, 0);
  // Where they are listed they say they are records of a failure, not evidence of results.
  assert.equal(
    partial.title,
    'Compute capture pipeline-1 / partial (failed, 1 file retained) — Training',
  );
  assert.equal(
    empty.title,
    'Compute capture pipeline-1 / empty (skipped, nothing retained) — Training',
  );
  assert.equal(
    empty.metadata?.outputState,
    'failed',
    'nothing was retained, so nothing is partial',
  );
  assert.equal(partial.metadata?.outputState, 'partial');
});

test('a capture registers once its node ends, while the rest of its workflow still runs', async (t) => {
  const f = await fixture(t);
  const original = f.workflow();
  const running = (nodes: Record<string, string>) =>
    f.workflows.set(original.id, {
      ...original,
      state: 'running',
      request: {
        nodes: Object.keys(nodes).map((id) => ({ id, kind: id === 'train' ? 'run' : 'capture' })),
      },
      nodes: Object.fromEntries(Object.entries(nodes).map(([id, state]) => [id, { state }])),
    } as unknown as WorkflowRecord);
  const captureReads = () => f.calls.filter((call) => call === 'captures').length;
  running({ output: 'running', train: 'succeeded', later: 'pending' });
  await f.evidence.reconcile();
  assert.equal(captureReads(), 0, 'no capture has ended');
  running({ output: 'succeeded', train: 'succeeded', later: 'running' });
  await f.evidence.reconcile();
  const [collection, ...rest] = await f.artifacts.list(f.caller);
  assert.equal(rest.length, 0);
  assert.equal(collection!.title, 'Compute capture pipeline-1 / output — Training');
  assert.equal(collection!.metadata?.workflowId, 'pipeline-1');
  assert.deepEqual((await f.read()).get('work')!.artifactIds, [collection!.id]);
  const reads = captureReads();
  await f.evidence.reconcile();
  assert.equal(
    captureReads(),
    reads,
    'a running workflow whose ended captures are kept is not read',
  );
  const settled = () =>
    f.state.snapshotTransaction((tx) =>
      f.evidence.settled(f.caller.projectId, 'work', 'epoch-1', new Date(0).toISOString(), tx),
    );
  await f.state.transaction((tx) => tx.run('UPDATE sandbox_run_intents SET retired=1,target=1'));
  await f.evidence.reconcile();
  assert.equal(await settled(), false, 'its workflow has not finished');
  f.workflows.set(original.id, original);
  await f.evidence.reconcile();
  assert.equal(await settled(), true);
  assert.equal((await f.artifacts.list(f.caller)).length, 1);
});

test('bulk receipts retain both epochs and select only the requested attempts', async (t) => {
  const f = await fixture(t);
  f.workflow();
  await f.evidence.reconcile();
  const first = (await f.artifacts.list(f.caller))[0]!;
  f.source.attempt_ref = 'epoch-2';
  f.source.label = 'run-2';
  f.workflow('pipeline-2');
  await f.evidence.reconcile();
  const second = (await f.artifacts.list(f.caller)).find((artifact) => artifact.id !== first.id)!;
  assert.deepEqual((await f.read(['epoch-1'])).get('work')!.artifactIds, [first.id]);
  assert.deepEqual((await f.read(['epoch-2'])).get('work')!.artifactIds, [second.id]);
  assert.equal((await f.read()).get('work')!.artifactIds.length, 2);
  assert.deepEqual((await f.read([])).get('work')!.artifactIds, []);
});

test('an unsafe capture path is refused once, durably', async (t) => {
  const f = await fixture(t);
  f.workflow();
  f.files.set('pipeline-1/output', [{ name: '../escape', object_id: 'object' }]);
  await f.evidence.reconcile();
  assert.equal((await f.artifacts.list(f.caller)).length, 0);
  assert.equal((await f.read()).get('work')!.refused[0]!.captureNode, 'output');
  await (await createService(f.service())).reconcile();
  assert.equal(
    (await f.state.events(f.caller.projectId)).filter((e) => e.type === 'sandboxes.capture_refused')
      .length,
    1,
  );
});

test('a missing hold is refused on the first pass and a restart records no second event', async (t) => {
  const f = await fixture(t);
  f.workflow();
  f.held(false);
  await f.evidence.reconcile();
  const projected = (await f.read()).get('work')!;
  assert.equal(projected.artifactIds.length, 0);
  assert.equal(projected.refused[0]!.captureNode, 'output');
  assert.equal(
    (await f.state.events(f.caller.projectId)).filter((e) => e.type === 'sandboxes.capture_refused')
      .length,
    1,
  );
  await (await createService(f.service())).reconcile();
  assert.equal(
    (await f.state.events(f.caller.projectId)).filter((e) => e.type === 'sandboxes.capture_refused')
      .length,
    1,
  );
});

test('a not-yet-available held object is retried', async (t) => {
  const f = await fixture(t);
  f.workflow();
  const ready = f.retained.get('object')!;
  f.retained.set('object', { ...ready, state: 'uploading' });
  await f.evidence.reconcile();
  assert.deepEqual((await f.read()).get('work'), { artifactIds: [], refused: [] });
  f.retained.set('object', ready);
  await f.evidence.reconcile();
  assert.equal((await f.artifacts.list(f.caller)).length, 1);
});

test('a released work is read until its captures settle, then never again, after a restart too', async (t) => {
  const f = await fixture(t);
  f.workflow();
  await f.state.transaction((tx) => tx.run('UPDATE sandbox_run_intents SET target=3,retired=3'));
  const ready = f.retained.get('object')!;
  f.retained.set('object', { ...ready, state: 'uploading' });
  await (await createService(f.service())).reconcile();
  f.retained.set('object', ready);
  await (await createService(f.service())).reconcile();
  assert.equal((await f.artifacts.list(f.caller)).length, 1);
  const lists = () => f.calls.filter((call) => call === 'list').length;
  assert.equal(lists(), 2, 'the unsettled capture kept the work in the pass');
  await (await createService(f.service())).reconcile();
  assert.equal(lists(), 2, 'a settled released work is not read again');
});

test('downloads refuse a released hold and a moved namespace', async (t) => {
  const f = await fixture(t);
  f.workflow();
  await f.evidence.reconcile();
  const collection = (await f.artifacts.list(f.caller))[0]!;
  const download = () => f.artifacts.download(f.caller, collection.id, 'metrics.json');
  await f.state.snapshotTransaction(async () => {
    await assert.rejects(download(), { code: 'sandbox_evidence_transaction' });
  });
  f.held(false);
  await assert.rejects(download(), { code: 'sandbox_not_found' });
  f.held(true);
  f.account('different-account');
  await assert.rejects(download(), { code: 'sandbox_access_revoked' });
});

test('the integration projection backfills startup and reconciles an interval pass', async (t) => {
  const f = await fixture(t, false);
  f.workflow();
  t.mock.timers.enable({ apis: ['setInterval'] });
  const ctx = new Context();
  ctx.provide('state', f.state);
  ctx.provide('scope', f.scope);
  ctx.provide('artifacts', f.artifacts);
  ctx.provide('workflows', {} as Context['workflows']);
  ctx.provide('domainEvents', {
    subscribe: async () => () => {},
  } as unknown as Context['domainEvents']);
  ctx.provide('sessions', {
    registerLaunchConnections: () => () => {},
  } as unknown as Context['sessions']);
  ctx.provide('sbxMerv', {} as Context['sbxMerv']);
  ctx.provide('sbxPipelines', f.pipelines as Context['sbxPipelines']);
  ctx.provide('sbxObjects', f.objects as Context['sbxObjects']);
  ctx.provide('sbxAccounts', f.accounts as Context['sbxAccounts']);
  ctx.provide('sbxJobs', {
    listPage: async () => ({ jobs: [], next: null }),
  } as unknown as Context['sbxJobs']);
  const plugin = ctx.plugin(sandboxIntegrationPlugin);
  try {
    await plugin.await();
    await ctx.sandboxEvidence.close();
    assert.equal((await f.artifacts.list(f.caller)).length, 1);
    f.workflow('pipeline-2');
    t.mock.timers.tick(5000);
    await ctx.sandboxEvidence.close();
    assert.equal((await f.artifacts.list(f.caller)).length, 2);
    assert.equal(
      (await f.state.events(f.caller.projectId)).filter(
        (event) => event.type === 'artifact.created',
      ).length,
      2,
    );
  } finally {
    await plugin.dispose();
    t.mock.timers.reset();
  }
});

test('customer finalization waits for retirement, remote jobs, and published evidence', async (t) => {
  const f = await fixture(t);
  const w = f.workflow();
  const settled = () =>
    f.state.snapshotTransaction((tx) =>
      f.evidence.settled(f.caller.projectId, 'work', 'epoch-1', new Date(0).toISOString(), tx),
    );
  await f.evidence.reconcile();
  assert.equal(await settled(), false);
  await f.state.transaction((tx) => tx.run('UPDATE sandbox_run_intents SET retired=1,target=1'));
  f.pendingJobs(true);
  await f.evidence.reconcile();
  assert.equal(await settled(), false);
  f.pendingJobs(false);
  await f.evidence.reconcile();
  assert.equal(await settled(), true);
  f.workflows.set('running', { ...f.workflow('running'), state: 'running' });
  await f.evidence.reconcile();
  assert.equal(await settled(), false);
});
