import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createService, sha256Hex } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import type { ObjectRecord, SbxObjects } from '@sandboxes/storage';
import { historicalEvidenceDownloads } from '@merv/sandboxes/historical-evidence';
import { countWrites, openState } from './fixtures/state.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-historical-evidence-'));
  const state = await openState(directory);
  t.after(async () => {
    await state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const scope = await createService(new ProjectScope(state));
  const artifacts = await createService(new ArtifactStore(state, scope, new DiskBlobs(directory)));
  const owner = await scope.credentials.bootstrap({ projectName: 'History', actorName: 'Owner' });
  const caller = { projectId: owner.project.id, actorId: owner.actor.id };
  // Retained ownership is sufficient: no old work/capture/grant state is needed or revived.
  await state.migrate('historical-test', {
    1: `CREATE TABLE sandbox_native_connections(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,revoked_at TEXT);
        CREATE TABLE sandbox_native_projects(project_id TEXT PRIMARY KEY,connection_id TEXT);`,
  });
  await state.transaction(async (tx) => {
    await tx.run(
      "INSERT INTO sandbox_native_connections VALUES('historical-connection',?,'2026-10-01')",
      caller.projectId,
    );
    await tx.run(
      "INSERT INTO sandbox_native_projects VALUES(?,'different-current-connection')",
      caller.projectId,
    );
  });
  const objectsById = new Map<string, ObjectRecord>();
  const object = {
    id: 'object-native',
    namespace: 'mw-historical-work',
    kind: 'file',
    state: 'available',
    sha256: sha256Hex(Buffer.from('metric')),
    size_bytes: 6,
  } as ObjectRecord;
  objectsById.set(object.id, object);
  const calls: string[] = [];
  const objects: Pick<SbxObjects, 'get' | 'download'> = {
    async get(namespace, objectId) {
      assert.equal(state.ambient, undefined);
      assert.equal(state.readScope, false);
      calls.push(`get:${namespace}/${objectId}`);
      return objectsById.get(objectId)!;
    },
    async download(namespace, objectId, options) {
      calls.push(`download:${namespace}/${objectId}`);
      assert.equal(options?.ttlSeconds, 240);
      return { object: objectsById.get(objectId)!, url: 'https://storage.example/signed-history' };
    },
  };
  const provider = historicalEvidenceDownloads(state, objects, 'configured-legacy-namespace');
  artifacts.registerFileProvider('sandboxes-native', provider);
  artifacts.registerFileProvider('sandboxes', provider);
  const reference = JSON.stringify([
    1,
    'historical-connection',
    object.namespace,
    'experiment',
    'work',
    'pipeline',
    'capture',
    object.id,
    object.sha256,
    object.size_bytes,
  ]);
  const collection = (provider: string, reference: string) =>
    artifacts.createCollection(caller, {
      title: 'Retained capture',
      sourceKey: `${provider}-history`,
      files: [{ name: 'metric.json', hash: object.sha256, size: 6, provider, reference }],
    });
  return { state, caller, artifacts, object, objectsById, calls, provider, reference, collection };
}

test('a native reference downloads for its historical project after reconnect without writes', async (t) => {
  const f = await fixture(t);
  const artifact = await f.collection('sandboxes-native', f.reference);
  const writes = countWrites(f.state);
  const result = await f.artifacts.download(f.caller, artifact.id, 'metric.json');
  assert.equal(result.download.url, 'https://storage.example/signed-history');
  assert.deepEqual(f.calls, [
    'get:mw-historical-work/object-native',
    'download:mw-historical-work/object-native',
  ]);
  assert.equal(writes(), 0);
});

test('a native reference refuses a different project before reading storage', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.provider.download('wrong-project', f.reference), { code: 'not_found' });
  assert.deepEqual(f.calls, []);
});

test('historical downloads refuse digest and size mismatches before signing', async (t) => {
  const f = await fixture(t);
  for (const changed of [
    { ...f.object, sha256: 'a'.repeat(64) },
    { ...f.object, size_bytes: 7 },
  ]) {
    f.objectsById.set(f.object.id, changed);
    await assert.rejects(f.provider.download(f.caller.projectId, f.reference), {
      code: 'sandbox_evidence_invalid',
    });
  }
  assert.equal(
    f.calls.some((call) => call.startsWith('download:')),
    false,
  );
});

test('a legacy bare id uses its configured namespace and owning manifest digest and size', async (t) => {
  const f = await fixture(t);
  f.objectsById.set('object-legacy', {
    ...f.object,
    id: 'object-legacy',
    namespace: 'configured-legacy-namespace',
  });
  const artifact = await f.collection('sandboxes', 'object-legacy');
  const writes = countWrites(f.state);
  assert.equal(
    (await f.artifacts.download(f.caller, artifact.id, 'metric.json')).download.url,
    'https://storage.example/signed-history',
  );
  assert.deepEqual(f.calls, [
    'get:configured-legacy-namespace/object-legacy',
    'download:configured-legacy-namespace/object-legacy',
  ]);
  await assert.rejects(f.provider.download('wrong-project', 'object-legacy'), {
    code: 'not_found',
  });
  assert.equal(writes(), 0);
});
