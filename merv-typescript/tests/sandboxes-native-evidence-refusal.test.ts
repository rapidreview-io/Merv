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

// Refusals of native evidence that can never register: kept across restarts, counted for the
// workflow as a whole too, and said where its producer and owner see them.

type Mode = 'object404' | 'tooManyCaptures';

async function harness(t: TestContext, mode: Mode) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-native-refusal-'));
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
  let calls = 0;
  const fetcher = (async (input: string | URL | Request) => {
    calls++;
    const url = new URL(String(input));
    if (url.pathname.endsWith('/captures')) {
      if (mode === 'tooManyCaptures') {
        // 129 capture nodes, more than one workflow may register.
        const after = Number(url.searchParams.get('after') ?? '-1') + 1;
        const size = Number(url.searchParams.get('limit'));
        const ids = Array.from({ length: Math.min(size, 129 - after) }, (_, i) => after + i);
        return Response.json({
          captures: ids.map((id) => ({
            id: `n${id}`,
            state: 'succeeded',
            result: { outputs: {} },
          })),
          next: ids.at(-1)! < 128 ? String(ids.at(-1)) : null,
        });
      }
      return Response.json({
        captures: [{ id: 'node', state: 'succeeded', result: { outputs: { out: 'obj' } } }],
        next: null,
      });
    }
    if (url.pathname.endsWith('/files')) return Response.json({ files: [], next: null });
    return Response.json({ error: 'not found' }, { status: 404 });
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
  const workflow = {
    id: 'wf',
    name: 'Training',
    namespace: 'ns_work',
    state: 'completed',
    origin_grant_id: 'token',
    attempt_ref: '1',
  };
  const time = { now: Date.parse('2026-10-07T00:00:00Z') };
  const evidence = () => new NativeEvidence(state, scope, artifacts, connections, () => time.now);
  const refused = () =>
    state.read((sql) =>
      sql.all<{ node_id: string; error: string }>(
        'SELECT node_id,error FROM sandbox_native_captures WHERE error IS NOT NULL ORDER BY node_id',
      ),
    );
  return { state, caller, work, connection, workflow, time, evidence, refused, calls: () => calls };
}

test('a restart does not begin a capture’s refusal count again', async (t) => {
  const h = await harness(t, 'object404');
  // Three processes, each restarted after 25 minutes of passes every 30 s.
  for (let process = 0; process < 3; process++) {
    const evidence = h.evidence();
    for (let pass = 0; pass < 50; pass++, h.time.now += 30_000)
      await evidence.publish(h.work, h.connection, h.workflow).catch(() => undefined);
  }
  assert.deepEqual(
    (await h.refused()).map((row) => row.node_id),
    ['node'],
  );
});
