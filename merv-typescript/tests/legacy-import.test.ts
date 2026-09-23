import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Transaction } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import {
  importLegacyFoundation,
  planLegacyFoundation,
  type LegacyFoundationSnapshot,
} from '../src/legacy-import.js';
import { stateConfig } from './fixtures/state.js';

const content = Buffer.from('Immutable evidence from the original research project.');
const hash = createHash('sha256').update(content).digest('hex');
const created = '2026-08-01T12:00:00.000Z';
const issuer = 'https://shared.example/auth/v1';
const snapshot = (): LegacyFoundationSnapshot => ({
  sourceId: 'python-v81-rehearsal',
  schemaVersion: 81,
  issuer,
  projects: [
    {
      id: 'proj_original',
      name: 'Original project',
      summary: 'Existing introduction.',
      created_at: created,
      status: 'active',
    },
  ],
  memberships: [{ project_id: 'proj_original', user_id: 'same-supabase-user', added_at: created }],
  artifacts: [
    {
      id: 'art_original',
      project_id: 'proj_original',
      title: 'Retained evidence',
      path: 'report.md',
      created_by: 'legacy-agent-attribution',
      created_at: created,
      status: 'complete',
      content_type: 'text/markdown',
      content_sha256: hash,
      size_bytes: content.length,
    },
  ],
  claims: [
    {
      id: 'claim_original',
      project_id: 'proj_original',
      statement: 'A bounded original claim.',
      scope: 'Synthetic fixture',
      status: 'active',
      confidence: 'medium',
      created_at: created,
    },
  ],
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-legacy-import-'));
  let app = await createApp({
    directory,
    config: {
      plugins: [
        { id: 'state', name: '@merv/state', config: stateConfig(directory) },
        { id: 'scope', name: '@merv/scope' },
        { id: 'blobs', name: '@merv/blobs', config: { root: join(directory, 'blobs') } },
        { id: 'artifacts', name: '@merv/artifacts' },
      ],
    },
  });
  t.after(async () => {
    await app.stop();
    await rm(directory, { force: true, recursive: true });
  });
  let reads = 0;
  const sourceBlobs = {
    get: async (projectId: string, key: string) => {
      reads++;
      assert.equal(projectId, 'proj_original');
      assert.equal(key, hash);
      return Buffer.from(content);
    },
  };
  const services = { state: app.ctx.state, sourceBlobs, destinationBlobs: app.ctx.blobs };
  const counts = () =>
    app.ctx.state.read(async (sql) => ({
      projects: (await sql.all('SELECT id FROM projects')).length,
      members: (await sql.all('SELECT id FROM project_memberships')).length,
      artifacts: (await sql.all('SELECT id FROM artifacts')).length,
    }));
  return { app, services, counts, reads: () => reads };
}

test('legacy foundation imports the same project and shared account without credentials or fabricated history', async (t) => {
  const f = await fixture(t);
  const receipt = await importLegacyFoundation(f.services, snapshot());
  assert.equal(receipt.researchHistoryImported, false);
  assert.equal(receipt.credentialsImported, false);
  assert.deepEqual(await f.counts(), { projects: 1, members: 1, artifacts: 1 });
  const principal = await f.app.ctx.scope.acceptVerifiedIdentity({
    issuer,
    subject: 'same-supabase-user',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const projects = await f.app.ctx.scope.projects(principal);
  assert.equal(projects[0]!.id, 'proj_original');
  assert.equal(projects[0]!.summary, 'Existing introduction.');
  const caller = await f.app.ctx.scope.caller(principal, 'proj_original');
  assert.equal((await f.app.ctx.scope.require(caller, 'admin')).role, 'operator');
  const artifact = await f.app.ctx.artifacts.read(caller, 'art_original');
  assert.equal(artifact.content, content.toString());
  assert.equal(artifact.artifact.createdBy, 'legacy-agent-attribution');
  // Research claims are retired: the export still carries them, and nothing imports them.
  assert.equal('claims' in receipt, false);
  const claimsTable = await f.app.ctx.state.read((sql) =>
    sql.get<{ name: string | null }>("SELECT to_regclass('claims') AS name"),
  );
  assert.equal(claimsTable?.name ?? null, null);
  const outsider = await f.app.ctx.scope.acceptVerifiedIdentity({
    issuer,
    subject: 'other-user',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  assert.deepEqual(await f.app.ctx.scope.projects(outsider), []);
  await assert.rejects(f.app.ctx.scope.caller(outsider, 'proj_original'), {
    code: 'membership_required',
  });
  assert.equal(
    (await f.app.ctx.state.read((sql) => sql.all('SELECT id FROM actor_credentials'))).length,
    0,
  );
  assert.equal(
    (await f.app.ctx.state.read((sql) => sql.all('SELECT id FROM user_keys'))).length,
    0,
  );
  const reads = f.reads();
  assert.deepEqual(await importLegacyFoundation(f.services, snapshot()), receipt);
  assert.equal(f.reads(), reads, 'An exact replay needs no new remote reads');
  const changed = snapshot();
  changed.projects[0]!.summary = 'Changed input';
  await assert.rejects(importLegacyFoundation(f.services, changed), {
    code: 'legacy_import_conflict',
  });
  await assert.rejects(
    f.app.ctx.state.transaction((tx) => tx.run('DELETE FROM legacy_foundation_imports')),
  );
});

test('foundation validation rejects cross-project references and identifies unsupported large bytes before writing', async (t) => {
  const f = await fixture(t);
  const invalid = snapshot();
  invalid.artifacts[0]!.project_id = 'other-project';
  assert.throws(() => planLegacyFoundation(invalid), { code: 'invalid_legacy_snapshot' });
  const large = snapshot();
  large.artifacts[0]!.size_bytes = 342_327_022;
  assert.deepEqual(planLegacyFoundation(large).oversizedArtifacts, ['art_original']);
  await assert.rejects(importLegacyFoundation(f.services, large), {
    code: 'legacy_large_artifacts_unsupported',
  });
  assert.equal(f.reads(), 0);
  assert.deepEqual(await f.counts(), { projects: 0, members: 0, artifacts: 0 });
});

test('source or destination corruption never commits artifact metadata or project access', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    importLegacyFoundation(
      { ...f.services, sourceBlobs: { get: async () => Buffer.from('wrong') } },
      snapshot(),
    ),
    { code: 'legacy_blob_mismatch' },
  );
  await assert.rejects(
    importLegacyFoundation(
      {
        ...f.services,
        destinationBlobs: {
          put: async () => ({ hash, size: content.length }),
          get: async () => Buffer.from('corrupt destination'),
        },
      },
      snapshot(),
    ),
    { code: 'legacy_blob_mismatch' },
  );
  assert.deepEqual(await f.counts(), { projects: 0, members: 0, artifacts: 0 });
});

test('a late transactional failure rolls back every native row and permits a clean retry', async (t) => {
  const f = await fixture(t);
  const original = f.app.ctx.state.transaction.bind(f.app.ctx.state);
  const mock = t.mock.method(
    f.app.ctx.state,
    'transaction',
    async <T>(fn: (tx: Transaction) => T | Promise<T>) =>
      original(async (tx) => {
        const result = await fn(tx);
        if (await tx.get('SELECT id FROM artifacts WHERE id=?', 'art_original'))
          throw new Error('Injected after final insert');
        return result;
      }),
  );
  await assert.rejects(
    importLegacyFoundation(f.services, snapshot()),
    /Injected after final insert/,
  );
  mock.mock.restore();
  assert.deepEqual(await f.counts(), { projects: 0, members: 0, artifacts: 0 });
  assert.equal(
    (await f.app.ctx.state.read((sql) => sql.all('SELECT * FROM legacy_foundation_imports')))
      .length,
    0,
  );
  assert.equal((await importLegacyFoundation(f.services, snapshot())).artifacts, 1);
});

test('an existing destination is refused before object copying, and duplicate hashes are copied once', async (t) => {
  const f = await fixture(t);
  const duplicate = snapshot();
  duplicate.artifacts.push({ ...duplicate.artifacts[0]!, id: 'art_second_reference' });
  await importLegacyFoundation(f.services, duplicate);
  assert.equal(f.reads(), 1);
  const other = snapshot();
  other.sourceId = 'different-source';
  await assert.rejects(importLegacyFoundation(f.services, other), {
    code: 'legacy_target_not_empty',
  });
  assert.equal(f.reads(), 1);
});

test('artifact verification and transfer finish outside the metadata transaction', async (t) => {
  const f = await fixture(t);
  const transaction = f.app.ctx.state.transaction.bind(f.app.ctx.state);
  let writing = false;
  t.mock.method(
    f.app.ctx.state,
    'transaction',
    async <T>(fn: (tx: Transaction) => T | Promise<T>) =>
      transaction(async (tx) => {
        writing = true;
        try {
          return await fn(tx);
        } finally {
          writing = false;
        }
      }),
  );
  const outside =
    <T extends unknown[], R>(fn: (...args: T) => Promise<R>) =>
    async (...args: T) => {
      assert.equal(writing, false, 'Network I/O must not hold the SQL writer');
      return fn(...args);
    };
  await importLegacyFoundation(
    {
      state: f.services.state,
      sourceBlobs: { get: outside(f.services.sourceBlobs.get) },
      destinationBlobs: {
        get: outside(f.services.destinationBlobs.get.bind(f.services.destinationBlobs)),
        put: outside(f.services.destinationBlobs.put.bind(f.services.destinationBlobs)),
      },
    },
    snapshot(),
  );
});
