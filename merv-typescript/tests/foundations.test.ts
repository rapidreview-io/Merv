import { createService } from '@merv/contracts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from 'cordis';
import { statePlugin } from '@merv/state';
import { DiskBlobs, blobsPlugin } from '@merv/blobs';
import { ProjectScope, scopePlugin } from '@merv/scope';
import { ArtifactStore, artifactsPlugin } from '@merv/artifacts';
import type { Transaction } from '@merv/contracts';
import { openState, stateConfig } from './fixtures/state.js';

async function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'merv-foundation-'));
  const state = await openState(dir);
  t.after(async () => {
    await state.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const scope = await createService(new ProjectScope(state)),
    blobs = new DiskBlobs(join(dir, 'blobs')),
    artifacts = await createService(new ArtifactStore(state, scope, blobs));
  const admin = await scope.bootstrap({ projectName: 'First project', actorName: 'Operator' });
  const caller = { actorId: admin.actor.id, projectId: admin.project.id };
  return { dir, state, scope, blobs, artifacts, admin, caller };
}
test('component migrations are independent, immutable, atomic and persistent', async (t) => {
  const { dir, state } = await fixture(t);
  const a = [{ version: 1, sql: 'CREATE TABLE sample(id TEXT PRIMARY KEY);' }];
  await state.migrate('sample', a);
  await state.migrate('sample', a);
  await state.migrate('other', [{ version: 1, sql: 'CREATE TABLE other(id TEXT PRIMARY KEY);' }]);
  await assert.rejects(
    async () =>
      await state.migrate('sample', [{ version: 1, sql: 'CREATE TABLE changed(id TEXT);' }]),
    /changed/,
  );
  await assert.rejects(
    async () =>
      await state.migrate('failure', [
        { version: 1, sql: 'CREATE TABLE undone(id TEXT); INSERT INTO missing VALUES(1);' },
      ]),
  );
  assert.equal(
    await state.read(
      async (sql) =>
        await sql.get(
          "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='undone'",
        ),
    ),
    undefined,
  );
  let tx: Transaction | undefined;
  await assert.rejects(
    async () =>
      await state.transaction(async (current) => {
        tx = current;
        await current.run('INSERT INTO sample VALUES(?)', 'rollback');
        throw new Error('abort');
      }),
    /abort/,
  );
  await assert.rejects(
    async () => await tx!.run('INSERT INTO sample VALUES(?)', 'late'),
    /no longer active/,
  );
  assert.equal(await state.read(async (sql) => await sql.get('SELECT * FROM sample')), undefined);
  await assert.rejects(
    async () =>
      await state.transaction(async () => {
        await Promise.resolve();
        throw new Error('asynchronous rollback');
      }),
    /asynchronous rollback/,
  );
  await assert.rejects(
    async () => await state.transaction(() => Promise.reject(new Error('contained rejection'))),
    /contained rejection/,
  );
  await state.transaction(async (tx) => await tx.run('INSERT INTO sample VALUES(?)', 'retained'));
  const second = await openState(dir);
  try {
    assert.equal(
      (await second.read(async (sql) => await sql.get<{ id: string }>('SELECT id FROM sample')))
        ?.id,
      'retained',
    );
  } finally {
    await second.close();
  }
});
test('credentials enforce roles, project boundaries and revocation', async (t) => {
  const { scope, caller, admin } = await fixture(t);
  assert.equal((await scope.authenticate(admin.token)).id, caller.actorId);
  const reviewer = await scope.issueActor(caller, { name: 'Reviewer', role: 'reviewer' });
  const rc = { actorId: reviewer.actor.id, projectId: caller.projectId };
  await scope.require(rc, 'review');
  await assert.rejects(async () => await scope.require(rc, 'write'), /lacks write/);
  const other = await scope.bootstrap({ projectName: 'Second project', actorName: 'Other' });
  await assert.rejects(
    async () => await scope.require({ ...caller, projectId: other.project.id }, 'read'),
    /cannot access/,
  );
  await assert.rejects(
    async () => await scope.issueActor(rc, { name: 'Escalated', role: 'operator' }),
    /lacks admin/,
  );
  await scope.revokeActor(caller, reviewer.actor.id);
  await assert.rejects(async () => await scope.authenticate(reviewer.token), /revoked/);
  await assert.rejects(async () => await scope.require(rc, 'read'), /cannot access/);
});
test('artifacts retain exact bytes, reject mutation, scope reads and detect corruption', async (t) => {
  const { artifacts, blobs, caller, state, scope, dir } = await fixture(t);
  const value = await artifacts.create(caller, { title: 'Evidence', content: 'retained content' });
  assert.equal((await artifacts.read(caller, value.id)).content, 'retained content');
  assert.equal(
    (await artifacts.create(caller, { title: 'Same content', content: 'retained content' })).hash,
    value.hash,
  );
  await assert.rejects(
    async () =>
      await state.transaction(
        async (tx) => await tx.run('UPDATE artifacts SET title=? WHERE id=?', 'changed', value.id),
      ),
    { code: 'state_constraint' },
  );
  await assert.rejects(
    async () =>
      await state.transaction(
        async (tx) =>
          await tx.run(
            'INSERT INTO artifacts SELECT id,project_id,created_by,?,media_type,hash,size,created_at FROM artifacts WHERE id=? ON CONFLICT (id) DO UPDATE SET title=excluded.title',
            'replaced',
            value.id,
          ),
      ),
    { code: 'state_constraint' },
  );
  assert.equal((await artifacts.get(caller, value.id)).title, 'Evidence');
  const other = await scope.bootstrap({ projectName: 'Other', actorName: 'Other' });
  await assert.rejects(
    async () =>
      await artifacts.get({ actorId: other.actor.id, projectId: other.project.id }, value.id),
    /not found/,
  );
  const pendingCaller = { ...caller };
  const creating = artifacts.create(pendingCaller, {
    title: 'Pinned',
    content: 'Original project',
  });
  pendingCaller.actorId = other.actor.id;
  pendingCaller.projectId = other.project.id;
  const pinned = await creating;
  assert.equal(pinned.projectId, caller.projectId);
  assert.equal(pinned.createdBy, caller.actorId);
  assert.equal((await artifacts.read(caller, pinned.id)).content, 'Original project');
  await assert.rejects(async () => await blobs.get('../escape', value.hash), /namespace/);
  await assert.rejects(
    async () =>
      await artifacts.create(caller, { title: 'Bad', content: '!!!', encoding: 'base64' }),
    /base64/,
  );
  const binary = await artifacts.create(caller, {
    title: 'Invalid UTF8',
    content: '/w==',
    encoding: 'base64',
    mediaType: 'text/plain',
  });
  assert.deepEqual(await artifacts.read(caller, binary.id), {
    artifact: binary,
    content: '/w==',
    encoding: 'base64',
  });
  writeFileSync(
    join(dir, 'blobs', caller.projectId, value.hash.slice(0, 2), value.hash),
    'tampered',
  );
  await assert.rejects(async () => await artifacts.read(caller, value.id), /integrity/);
});
test('artifact queries retain the project checked during authorization', async (t) => {
  const { artifacts, caller, scope } = await fixture(t);
  const own = await artifacts.create(caller, { title: 'Own', content: 'Own evidence' });
  const other = await scope.bootstrap({ projectName: 'Other', actorName: 'Other' });
  const secret = await artifacts.create(
    { actorId: other.actor.id, projectId: other.project.id },
    { title: 'Private', content: 'Other project evidence' },
  );
  const changing = { ...caller };
  const authorize = scope.require.bind(scope);
  t.mock.method(scope, 'require', async (...args: Parameters<typeof authorize>) => {
    const actor = await authorize(...args);
    changing.projectId = other.project.id;
    return actor;
  });
  await assert.rejects(artifacts.get(changing, secret.id), { code: 'not_found' });
  changing.projectId = caller.projectId;
  assert.deepEqual(await artifacts.list(changing), [own]);
});
test('artifact reads cannot replace a revoked caller while storage is pending', async (t) => {
  const { artifacts, blobs, caller, state, scope } = await fixture(t);
  const artifact = await artifacts.create(caller, { title: 'Evidence', content: 'Retained' });
  for (const mode of ['read', 'download'] as const) {
    const reader = await scope.issueActor(caller, { name: mode, role: 'reader' });
    const changing = { actorId: reader.actor.id, projectId: caller.projectId };
    const replace = async () => {
      await scope.revokeActor(caller, reader.actor.id);
      changing.actorId = caller.actorId;
    };
    const store = await createService(
      new ArtifactStore(state, scope, {
        put: blobs.put.bind(blobs),
        get: async (namespace, hash) => {
          const bytes = await blobs.get(namespace, hash);
          await replace();
          return bytes;
        },
        download: async () => {
          await replace();
          return { url: 'https://storage.example/download', expiresAt: '2099-01-01T00:00:00.000Z' };
        },
      }),
    );
    await assert.rejects(store[mode](changing, artifact.id), { code: 'forbidden' });
  }
});
test('Cordis activates independent components from declared dependencies and unwinds provider withdrawal', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merv-cordis-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const art = ctx.plugin(artifactsPlugin),
    scope = ctx.plugin(scopePlugin);
  await ctx.plugin(blobsPlugin, { root: join(dir, 'blobs') });
  await art;
  assert.equal(ctx.get('artifacts'), undefined);
  const provider = await ctx.plugin(statePlugin, stateConfig(dir));
  await scope.await();
  await art.await();
  const credentials = await ctx.scope.bootstrap({ projectName: 'Independent', actorName: 'User' });
  const caller = { actorId: credentials.actor.id, projectId: credentials.project.id };
  const saved = await ctx.artifacts.create(caller, { title: 'One', content: 'survives unload' });
  await provider.dispose();
  assert.equal(ctx.get('artifacts'), undefined);
  await ctx.plugin(statePlugin, stateConfig(dir));
  await scope.await();
  await art.await();
  assert.equal((await ctx.artifacts.read(caller, saved.id)).content, 'survives unload');
});
