import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createService, type Caller } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import { NativeConnections } from '../packages/sandboxes/src/native-connections.js';
import { NativeEvidence } from '../packages/sandboxes/src/native-evidence.js';
import {
  nativeMigrations,
  type NativeConnectionRow,
  type NativeWorkRow,
} from '../packages/sandboxes/src/native-schema.js';
import { openState } from './fixtures/state.js';

// These fields mirror native storage.models.ObjectRecord. The evidence endpoint
// adds evidence_held, while download returns the unwrapped native ObjectRecord.
function file(id: string, size = 12) {
  return {
    id,
    namespace: 'ns_work',
    name: id,
    version: 1,
    kind: 'file',
    state: 'available',
    sha256: 'a'.repeat(64),
    size_bytes: size,
    content_type: 'application/octet-stream',
    entries: [] as any[],
    producer_pipeline_id: 'wf_capture',
    producer_job_id: 'job_train',
    error: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    expires_at: null,
    evidence_held: true,
  };
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-native-evidence-'));
  const state = await openState(directory);
  const scope = await createService(new ProjectScope(state));
  const blobs = new DiskBlobs(join(directory, 'blobs'));
  let byteWrites = 0;
  const put = blobs.put.bind(blobs);
  blobs.put = async (...args) => {
    byteWrites++;
    return put(...args);
  };
  const artifacts = await createService(new ArtifactStore(state, scope, blobs));
  await state.migrate('native-evidence-test', nativeMigrations);
  t.after(async () => {
    await state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const boot = await scope.credentials.bootstrap({ projectName: 'Evidence', actorName: 'Owner' });
  const caller: Caller = { projectId: boot.project.id, actorId: boot.actor.id };
  const objects = new Map<string, ReturnType<typeof file>>();
  const captures: {
    id: string;
    state: string;
    result: { outputs: Record<string, string>; output_state: string | null };
  }[] = [];
  const receipts = new Map<string, { name: string; object_id: string }[]>();
  const calls: string[] = [];
  const authorizations: (string | null)[] = [];
  let onDownload: (() => Promise<void>) | undefined;
  let downloadObjectOverride: unknown;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(state.ambient, undefined);
    assert.equal(init?.method, 'GET');
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    authorizations.push(new Headers(init?.headers).get('authorization'));
    assert.ok(url.pathname.startsWith('/v1/delegations/works/grant_work/'));
    let value: unknown;
    if (url.pathname.endsWith('/captures')) {
      assert.equal(url.searchParams.get('limit'), '128');
      const start = url.searchParams.has('after')
        ? captures.findIndex((c) => c.id === url.searchParams.get('after')) + 1
        : 0;
      // Shorter pages than asked for, so paging is still exercised.
      const page = captures.slice(start, start + 2);
      value = { captures: page, next: start + 2 < captures.length ? page.at(-1)!.id : null };
    } else if (url.pathname.endsWith('/files')) {
      assert.equal(url.searchParams.get('limit'), '500');
      const values = receipts.get(url.pathname.split('/').at(-2)!) ?? [];
      const start = Number(url.searchParams.get('after') ?? 0);
      value = {
        files: values.slice(start, start + 500),
        next: start + 500 < values.length ? String(start + 500) : null,
      };
    } else {
      const objectId = url.pathname.split('/').at(url.pathname.endsWith('/download') ? -2 : -1)!;
      assert.ok(objects.has(objectId), `unexpected object ${objectId}`);
      if (url.pathname.endsWith('/download')) {
        await onDownload?.();
        const { evidence_held, ...object } = objects.get(objectId)!;
        value = {
          object: downloadObjectOverride ?? object,
          url: 'https://storage.example/private?signature=synthetic',
        };
      } else value = objects.get(objectId);
    }
    return Response.json(value);
  }) as typeof fetch;
  const connections = new NativeConnections(
    state,
    scope,
    {
      applicationId: 'app',
      applicationSecretEnv: 'APP',
      encryptionKeyEnv: 'KEY',
      publicOrigin: 'https://merv.example',
    },
    'https://sandboxes.example',
    { KEY: randomBytes(32).toString('base64url') },
    fetcher,
  );
  await state.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO sandbox_native_connections(id,project_id,root_id,account_id,member_id,credentials,connected_at) VALUES('connection',?,'root','account','member',?,?)`,
      caller.projectId,
      connections.credentials.seal({ bearer: `sbxt_${'r'.repeat(43)}` }, 'connection:connection'),
      new Date().toISOString(),
    );
    await tx.run(
      `INSERT INTO sandbox_native_work(project_id,work_kind,work_id,connection_id,native_grant_id,namespace,desired_attempt) VALUES(?,'task','task_work','connection','grant_work','ns_work','1')`,
      caller.projectId,
    );
  });
  const connection = (await state.read((sql) =>
    sql.get<NativeConnectionRow>("SELECT * FROM sandbox_native_connections WHERE id='connection'"),
  ))!;
  const work = (await state.read((sql) =>
    sql.get<NativeWorkRow>("SELECT * FROM sandbox_native_work WHERE work_id='task_work'"),
  ))!;
  const time = { now: Date.parse('2026-10-01T00:00:00Z') };
  const evidence = new NativeEvidence(state, scope, artifacts, connections, () => time.now);
  artifacts.registerFileProvider('sandboxes-native', {
    download: (project, reference) => evidence.download(project, reference),
  });
  const workflow = {
    id: 'wf_capture',
    name: 'Training',
    namespace: 'ns_work',
    state: 'completed',
    origin_grant_id: 'assignment_token',
    attempt_ref: '1',
    admission_profile: 'execute',
    cancel_requested: false,
    finished_at: '2026-10-01T00:00:00Z',
    evidence_limitations: [],
  };
  const publish = () => evidence.publish(work, connection, workflow);
  const reference = async () => {
    const row = await state.read((sql) =>
      sql.get<{ file_refs_json: { reference: string }[] }>(
        'SELECT file_refs_json FROM artifacts WHERE project_id=?',
        caller.projectId,
      ),
    );
    return row!.file_refs_json[0]!.reference;
  };
  return {
    time,
    state,
    scope,
    artifacts,
    caller,
    objects,
    captures,
    receipts,
    calls,
    connection,
    connections,
    authorizations,
    work,
    evidence,
    workflow,
    publish,
    reference,
    byteWrites: () => byteWrites,
    onDownload: (fn: () => Promise<void>) => {
      onDownload = fn;
    },
    overrideDownload: (obj: unknown) => {
      downloadObjectOverride = obj;
    },
  };
}

test('one directory capture becomes one atomic immutable collection with no captured byte copies', async (t) => {
  const f = await fixture(t);
  const first = file('obj_a'),
    second = file('obj_b', 3);
  f.objects.set(first.id, first);
  f.objects.set(second.id, second);
  f.objects.set('obj_dir', {
    ...file('obj_dir', 15),
    kind: 'directory',
    entries: [
      {
        path: 'logs/result.txt',
        object_id: first.id,
        sha256: first.sha256,
        size_bytes: 12,
        content_type: 'text/plain',
        executable: false,
      },
      {
        path: 'model.bin',
        object_id: second.id,
        sha256: second.sha256,
        size_bytes: 3,
        content_type: 'application/octet-stream',
        executable: false,
      },
    ],
  });
  f.captures.push({
    id: 'capture',
    state: 'succeeded',
    result: { outputs: { outputs: 'obj_dir' }, output_state: 'committed' },
  });
  f.receipts.set('capture', [
    { name: 'outputs/logs/result.txt', object_id: 'obj_a' },
    { name: 'outputs/model.bin', object_id: 'obj_b' },
  ]);
  await Promise.all([f.publish(), f.publish()]);
  const read = f.calls.length;
  await f.publish();
  assert.equal(f.calls.length, read, 'a settled workflow is not listed again');
  const all = await f.artifacts.list(f.caller);
  assert.equal(all.length, 1);
  assert.deepEqual(
    all[0]!.files?.map((file) => file.name),
    ['outputs/logs/result.txt', 'outputs/model.bin'],
  );
  assert.equal(f.byteWrites(), 0);
  assert.ok(!f.calls.some((call) => call.endsWith('/download')));
  assert.equal(
    (await f.state.read((sql) => sql.all('SELECT * FROM sandbox_native_captures'))).length,
    1,
  );
  assert.equal(all[0]!.metadata?.captureState, 'succeeded');
  assert.ok(f.calls.every((call) => !call.includes('sbxt_')));
  await f.state.transaction((tx) =>
    tx.run(
      "UPDATE sandbox_native_work SET closed_at=? WHERE work_id='task_work'",
      new Date().toISOString(),
    ),
  );
  assert.match(
    (await f.artifacts.download(f.caller, all[0]!.id, 'outputs/logs/result.txt')).download.url,
    /storage.example/,
  );
  await assert.rejects(f.evidence.download('different_project', await f.reference()), {
    code: 'not_found',
  });
});

test('failed partial Capture receipts page independently into one collection and retain failure state', async (t) => {
  const f = await fixture(t);
  f.objects.set('obj_shared', file('obj_shared', 1));
  f.captures.push({
    id: 'capture',
    state: 'failed',
    result: { outputs: {}, output_state: 'partial' },
  });
  f.receipts.set(
    'capture',
    Array.from({ length: 501 }, (_, i) => ({
      name: `partial/file_${i}.txt`,
      object_id: 'obj_shared',
    })),
  );
  await f.publish();
  const all = await f.artifacts.list(f.caller);
  assert.equal(all.length, 1);
  assert.equal(all[0]!.files?.length, 501);
  assert.equal(all[0]!.metadata?.captureState, 'failed');
  assert.equal(all[0]!.metadata?.outputState, 'partial');
  assert.ok(f.calls.some((call) => call.includes('after=500')));
  assert.equal(f.byteWrites(), 0);
});

test('empty-directory and failed no-output captures remain distinct explicit evidence artifacts', async (t) => {
  const f = await fixture(t);
  f.objects.set('obj_empty', { ...file('obj_empty', 0), kind: 'directory' });
  f.captures.push(
    {
      id: 'capture_empty',
      state: 'succeeded',
      result: { outputs: { empty: 'obj_empty' }, output_state: 'committed' },
    },
    { id: 'capture_failed', state: 'failed', result: { outputs: {}, output_state: 'partial' } },
  );
  await f.publish();
  const all = await f.artifacts.list(f.caller);
  assert.equal(all.length, 2);
  assert.ok(all.every((a) => a.files?.length === 0));
  assert.deepEqual(
    new Set(all.map((a) => a.metadata?.captureState)),
    new Set(['succeeded', 'failed']),
  );
});

for (const flaw of ['namespace', 'producer', 'hold', 'traversal', 'conflict', 'symlink'] as const)
  test(`capture ${flaw} mismatch never registers granted evidence`, async (t) => {
    const f = await fixture(t);
    const value = file('obj');
    if (flaw === 'namespace') value.namespace = 'other';
    if (flaw === 'producer') value.producer_pipeline_id = 'other';
    if (flaw === 'hold') value.evidence_held = false;
    if (flaw === 'symlink') {
      value.kind = 'directory';
      value.entries = [
        {
          path: 'link',
          object_id: 'obj_other',
          sha256: value.sha256,
          size_bytes: 12,
          kind: 'symlink',
        },
      ];
    }
    f.objects.set('obj', value);
    f.objects.set('obj_other', file('obj_other'));
    f.captures.push({
      id: 'capture',
      state: 'succeeded',
      result: { outputs: { safe: 'obj' }, output_state: 'committed' },
    });
    if (flaw === 'traversal') f.receipts.set('capture', [{ name: '../escape', object_id: 'obj' }]);
    if (flaw === 'conflict') f.receipts.set('capture', [{ name: 'safe', object_id: 'obj_other' }]);
    await assert.rejects(f.publish(), { code: 'sandbox_evidence_invalid' });
    assert.deepEqual(await f.artifacts.list(f.caller), []);
    // Its row only counts the failure: nothing is registered or refused yet.
    assert.deepEqual(
      await f.state.read((sql) =>
        sql.all('SELECT artifact_id,error,failures FROM sandbox_native_captures'),
      ),
      [{ artifact_id: null, error: null, failures: 1 }],
    );
  });

test('connection revocation during signing withholds the URL; changed download identity is rejected', async (t) => {
  const f = await fixture(t);
  f.objects.set('obj', file('obj'));
  f.captures.push({
    id: 'capture',
    state: 'succeeded',
    result: { outputs: { out: 'obj' }, output_state: 'committed' },
  });
  await f.publish();
  const ref = await f.reference();
  f.overrideDownload({ ...file('obj'), namespace: 'wrong_namespace' });
  await assert.rejects(f.evidence.download(f.caller.projectId, ref), {
    code: 'sandbox_evidence_invalid',
  });
  f.overrideDownload(undefined);
  f.onDownload(() =>
    f.state
      .transaction((tx) =>
        tx.run(
          "UPDATE sandbox_native_connections SET revoked_at=? WHERE id='connection'",
          new Date().toISOString(),
        ),
      )
      .then(() => {}),
  );
  await assert.rejects(f.evidence.download(f.caller.projectId, ref), {
    code: 'sandbox_access_revoked',
  });
  const count = f.calls.length;
  await assert.rejects(f.evidence.download(f.caller.projectId, ref), {
    code: 'sandbox_access_revoked',
  });
  assert.equal(f.calls.length, count);
});

test('capture evidence freezes only after workflow cleanup recovers committed file receipts', async (t) => {
  const f = await fixture(t);
  f.captures.push({
    id: 'capture',
    state: 'failed',
    result: { outputs: {}, output_state: 'partial' },
  });
  for (const state of ['running', 'cleaning_up']) {
    f.workflow.state = state;
    await f.publish();
    assert.deepEqual(await f.artifacts.list(f.caller), []);
    assert.deepEqual(
      await f.state.read((sql) => sql.all('SELECT * FROM sandbox_native_captures')),
      [],
    );
  }
  assert.equal(f.calls.length, 0, 'unsettled capture receipts must not be read or registered');
  // Native storage recovery finds an available object whose progress checkpoint was lost.
  f.objects.set('obj_recovered', file('obj_recovered'));
  f.receipts.set('capture', [{ name: 'outputs/recovered.bin', object_id: 'obj_recovered' }]);
  f.workflow.state = 'failed';
  await f.publish();
  await f.publish();
  const artifacts = await f.artifacts.list(f.caller);
  assert.equal(artifacts.length, 1);
  assert.deepEqual(
    artifacts[0]!.files?.map((entry) => entry.name),
    ['outputs/recovered.bin'],
  );
  assert.equal(artifacts[0]!.metadata?.captureState, 'failed');
  assert.equal(artifacts[0]!.metadata?.outputState, 'partial');
  assert.equal(
    (await f.state.read((sql) => sql.all('SELECT * FROM sandbox_native_captures'))).length,
    1,
  );
  assert.equal(f.byteWrites(), 0);
});

test("a capture whose workflow names no attempt is registered under its launching assignment's attempt", async (t) => {
  const f = await fixture(t);
  f.objects.set('obj', file('obj'));
  f.captures.push({
    id: 'capture',
    state: 'succeeded',
    result: { outputs: { outputs: 'obj' }, output_state: 'committed' },
  });
  f.receipts.set('capture', [{ name: 'outputs/obj', object_id: 'obj' }]);
  // The workflow was launched under attempt 1's assignment; the work has since moved on.
  await f.state.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO sandbox_native_assignments(lease_id,session_id,project_id,work_kind,work_id,attempt_ref,profile,expires_at,credentials,native_token_id)
       VALUES('lease_one','ses_one',?,'task','task_work','1','execute',?,'sealed','assignment_token')`,
      f.caller.projectId,
      new Date().toISOString(),
    );
    await tx.run("UPDATE sandbox_native_work SET desired_attempt='2'");
  });
  // A workflow no assignment of this work launched is not delegated Merv evidence.
  await f.evidence.publish(f.work, f.connection, {
    ...f.workflow,
    id: 'wf_foreign',
    origin_grant_id: 'someone_else',
    attempt_ref: null,
  });
  await f.evidence.publish(f.work, f.connection, { ...f.workflow, attempt_ref: null });
  assert.deepEqual(
    await f.state.read((sql) =>
      sql.all('SELECT workflow_id,attempt_ref FROM sandbox_native_captures'),
    ),
    [{ workflow_id: 'wf_capture', attempt_ref: '1' }],
  );
});

test('a capture title cut at its limit never ends in half a character', async (t) => {
  const f = await fixture(t);
  f.objects.set('obj', file('obj'));
  f.captures.push({
    id: 'capture',
    state: 'succeeded',
    result: { outputs: { outputs: 'obj' }, output_state: 'committed' },
  });
  f.receipts.set('capture', [{ name: 'outputs/obj', object_id: 'obj' }]);
  const prefix = 'Compute capture — ';
  // The emoji straddles the title's 200th code unit.
  const name = `${'x'.repeat(200 - prefix.length - 1)}🧪 run`;
  await f.evidence.publish(f.work, f.connection, { ...f.workflow, name });
  const [collection] = await f.artifacts.list(f.caller);
  assert.equal(collection?.title, `${prefix}${'x'.repeat(200 - prefix.length - 1)}`);
});

test('a capture that can never register is refused after five failed passes over half an hour, and the rest register', async (t) => {
  const f = await fixture(t);
  f.captures.push(
    { id: 'broken', state: 'succeeded', result: { outputs: { safe: 'obj' }, output_state: null } },
    { id: 'good', state: 'succeeded', result: { outputs: { kept: 'kept' }, output_state: null } },
  );
  f.receipts.set('broken', [{ name: '../escape', object_id: 'obj' }]);
  f.objects.set('kept', file('kept'));
  const rows = () =>
    f.state.read((sql) =>
      sql.all(
        'SELECT node_id,artifact_id,error FROM sandbox_native_captures WHERE artifact_id IS NOT NULL OR error IS NOT NULL ORDER BY node_id',
      ),
    );
  // An unreachable service says nothing about the capture: those passes never count.
  for (let pass = 0; pass < 6; pass++)
    await assert.rejects(f.publish(), { code: 'sandbox_unavailable' });
  f.objects.set('obj', file('obj'));
  // Five quick passes are not enough: a failure must last half an hour before it refuses.
  for (let pass = 0; pass < 5; pass++)
    await assert.rejects(f.publish(), { code: 'sandbox_evidence_invalid' });
  f.time.now += 29 * 60_000;
  await assert.rejects(f.publish(), { code: 'sandbox_evidence_invalid' });
  assert.deepEqual(await rows(), []);
  f.time.now += 60_000;
  await f.publish();
  const [refused, good] = (await rows()) as {
    node_id: string;
    artifact_id: string | null;
    error: string | null;
  }[];
  assert.deepEqual(refused, {
    node_id: 'broken',
    artifact_id: null,
    error: 'sandbox_evidence_invalid: Invalid native capture files page',
  });
  assert.equal(good?.node_id, 'good');
  assert.ok(good.artifact_id);
  assert.deepEqual(
    (await f.artifacts.list(f.caller)).map((artifact) => artifact.id),
    [good.artifact_id],
  );
  // The refusal is recorded, so a later instance reads the workflow and registers nothing more.
  const again = new NativeEvidence(f.state, f.scope, f.artifacts, f.connections);
  const calls = f.calls.length;
  await again.publish(f.work, f.connection, f.workflow);
  assert.ok(f.calls.slice(calls).every((call) => call.includes('/captures?')));
  assert.equal((await rows()).length, 2);
});

test('nondelegated admin workflows do not publish Merv evidence or stall closure', async (t) => {
  const f = await fixture(t);
  f.captures.push({
    id: 'capture',
    state: 'succeeded',
    result: { outputs: {}, output_state: 'committed' },
  });
  await f.evidence.publish(f.work, f.connection, { ...f.workflow, origin_grant_id: null });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.artifacts.list(f.caller), []);
  assert.deepEqual(
    await f.state.read((sql) => sql.all('SELECT * FROM sandbox_native_captures')),
    [],
  );
});

test('retained evidence reconnect uses only a live root for the same account and project', async (t) => {
  const f = await fixture(t);
  f.objects.set('obj', file('obj'));
  f.captures.push({
    id: 'capture',
    state: 'succeeded',
    result: { outputs: { out: 'obj' }, output_state: 'committed' },
  });
  await f.publish();
  const ref = await f.reference();
  await f.state.transaction(async (tx) => {
    await tx.run(
      "UPDATE sandbox_native_connections SET revoked_at='2026-10-01' WHERE id='connection'",
    );
    await tx.run("UPDATE sandbox_native_work SET closed_at='2026-10-01' WHERE work_id='task_work'");
    await tx.run(
      `INSERT INTO sandbox_native_connections(id,project_id,root_id,account_id,member_id,credentials,connected_at)
      VALUES('reconnected',?,'new_root','account','new_member',?,'2026-10-01')`,
      f.caller.projectId,
      f.connections.credentials.seal(
        { bearer: 'sbxt_reconnected_secret' },
        'connection:reconnected',
      ),
    );
    await tx.run(
      "INSERT INTO sandbox_native_projects(project_id,connection_id) VALUES(?,'reconnected')",
      f.caller.projectId,
    );
  });
  const count = f.calls.length;
  assert.match(
    (await f.evidence.download(f.caller.projectId, ref)).url,
    /^https:\/\/storage.example/,
  );
  assert.deepEqual(f.authorizations.slice(count), [
    'Bearer sbxt_reconnected_secret',
    'Bearer sbxt_reconnected_secret',
  ]);
  assert.ok(
    f.calls
      .slice(count)
      .every((path) => path.startsWith('/v1/delegations/works/grant_work/evidence/')),
  );
  await f.state.transaction((tx) =>
    tx.run("UPDATE sandbox_native_connections SET account_id='foreign' WHERE id='reconnected'"),
  );
  const before = f.calls.length;
  await assert.rejects(f.evidence.download(f.caller.projectId, ref), {
    code: 'sandbox_access_revoked',
  });
  assert.equal(f.calls.length, before);
  await f.state.transaction((tx) =>
    tx.run(
      "UPDATE sandbox_native_connections SET account_id='account',revoke_pending=TRUE WHERE id='reconnected'",
    ),
  );
  await assert.rejects(f.evidence.download(f.caller.projectId, ref), {
    code: 'sandbox_access_revoked',
  });
  assert.equal(f.calls.length, before);
});
