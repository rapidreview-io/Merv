import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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

// A native 404 (a route missing during a deploy, an object not yet visible) for five passes,
// about 25 s at the 5 s tick while the work moves, must not refuse real evidence for ever.
test('a transient native 404 never refuses a capture that later registers', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'merv-native-transient-'));
  const state = await openState(directory);
  const scope = await createService(new ProjectScope(state));
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  await state.migrate('native-evidence-test', nativeMigrations);
  t.after(async () => {
    await state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const boot = await scope.credentials.bootstrap({ projectName: 'E', actorName: 'Owner' });
  const caller: Caller = { projectId: boot.project.id, actorId: boot.actor.id };
  let outage = true;
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/captures'))
      return Response.json({
        captures: [{ id: 'node', state: 'succeeded', result: { outputs: { out: 'obj' } } }],
        next: null,
      });
    if (url.pathname.endsWith('/files')) return Response.json({ files: [], next: null });
    if (outage) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json({
      id: 'obj',
      namespace: 'ns_work',
      kind: 'file',
      state: 'available',
      sha256: 'a'.repeat(64),
      size_bytes: 3,
      producer_pipeline_id: 'wf',
      entries: [],
      evidence_held: true,
      expires_at: null,
    });
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
  const evidence = new NativeEvidence(state, scope, artifacts, connections);
  const workflow = {
    id: 'wf',
    name: 'Training',
    namespace: 'ns_work',
    state: 'completed',
    origin_grant_id: 'token',
    attempt_ref: '1',
  };
  for (let pass = 0; pass < 5; pass++)
    await evidence.publish(work, connection, workflow).catch(() => undefined);
  outage = false;
  await evidence.publish(work, connection, workflow).catch(() => undefined);
  const row = await state.read((sql) =>
    sql.get<{ artifact_id: string | null; error: string | null }>(
      'SELECT artifact_id,error FROM sandbox_native_captures',
    ),
  );
  assert.equal(row?.error ?? null, null, `capture was refused: ${row?.error}`);
  assert.ok(row?.artifact_id, 'the capture registers once the service answers again');
});
