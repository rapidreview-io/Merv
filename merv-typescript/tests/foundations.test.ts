import { createService } from '@merv/contracts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from 'cordis';
import { SqliteState, statePlugin } from '@merv/state';
import { DiskBlobs, blobsPlugin } from '@merv/blobs';
import { ProjectScope, scopePlugin } from '@merv/scope';
import { ArtifactStore, artifactsPlugin } from '@merv/artifacts';
import type { Transaction } from '@merv/contracts';

async function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'merv-foundation-'));
  const state = new SqliteState(join(dir, 'state.sqlite'));
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
      async (sql) => await sql.get("SELECT name FROM sqlite_master WHERE name='undone'"),
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
  const second = new SqliteState(join(dir, 'state.sqlite'));
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
test('events commit with the transaction and survive reopening', async (t) => {
  const { state, caller, dir } = await fixture(t);
  const before = (await state.events(caller.projectId)).length;
  await assert.rejects(
    async () =>
      await state.transaction(async (tx) => {
        await state.appendEvent(tx, { ...caller, type: 'rollback', subjectId: 'x', data: {} });
        throw new Error('abort');
      }),
  );
  assert.equal((await state.events(caller.projectId)).length, before);
  await state.transaction(
    async (tx) =>
      await state.appendEvent(tx, {
        ...caller,
        type: 'committed',
        subjectId: 'y',
        data: { number: 1 },
      }),
  );
  const second = new SqliteState(join(dir, 'state.sqlite'));
  try {
    assert.equal((await second.events(caller.projectId)).at(-1)?.type, 'committed');
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
    /immutable/,
  );
  await assert.rejects(
    async () =>
      await state.transaction(
        async (tx) =>
          await tx.run(
            'INSERT OR REPLACE INTO artifacts SELECT id,project_id,created_by,?,media_type,hash,size,created_at FROM artifacts WHERE id=?',
            'replaced',
            value.id,
          ),
      ),
    /immutable/,
  );
  const other = await scope.bootstrap({ projectName: 'Other', actorName: 'Other' });
  await assert.rejects(
    async () =>
      await artifacts.get({ actorId: other.actor.id, projectId: other.project.id }, value.id),
    /not found/,
  );
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
  const provider = await ctx.plugin(statePlugin, { path: join(dir, 'state.sqlite') });
  await scope.await();
  await art.await();
  const credentials = await ctx.scope.bootstrap({ projectName: 'Independent', actorName: 'User' });
  const caller = { actorId: credentials.actor.id, projectId: credentials.project.id };
  const saved = await ctx.artifacts.create(caller, { title: 'One', content: 'survives unload' });
  await provider.dispose();
  assert.equal(ctx.get('artifacts'), undefined);
  await ctx.plugin(statePlugin, { path: join(dir, 'state.sqlite') });
  await scope.await();
  await art.await();
  assert.equal((await ctx.artifacts.read(caller, saved.id)).content, 'survives unload');
});

test('table rebuild migrations retain referenced history and restore foreign-key enforcement on success and rollback', async (t) => {
  const { state } = await fixture(t);
  const initial = {
    version: 1,
    sql: `
    CREATE TABLE rebuild_parent(id TEXT PRIMARY KEY, actor TEXT UNIQUE);
    CREATE TABLE rebuild_child(parent TEXT REFERENCES rebuild_parent(id));
    INSERT INTO rebuild_parent VALUES('execution-a','agent-a');
    INSERT INTO rebuild_child VALUES('execution-a');
  `,
  };
  await state.migrate('rebuild_test', [initial]);
  const migration = {
    version: 2,
    rebuild: true,
    sql: `
    CREATE TEMP TABLE rebuild_backup AS SELECT * FROM rebuild_parent;
    DROP TABLE rebuild_parent;
    CREATE TABLE rebuild_parent(id TEXT PRIMARY KEY, actor TEXT);
    INSERT INTO rebuild_parent SELECT * FROM rebuild_backup;
    DROP TABLE rebuild_backup;
  `,
  };
  await state.migrate('rebuild_test', [initial, migration]);
  await state.transaction(
    async (tx) => await tx.run("INSERT INTO rebuild_parent VALUES('execution-b','agent-a')"),
  );
  assert.deepEqual(await state.read(async (sql) => await sql.all('PRAGMA foreign_key_check')), []);
  assert.equal(
    (
      await state.read(
        async (sql) => await sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM rebuild_parent'),
      )
    )?.n,
    2,
  );
  await assert.rejects(
    async () =>
      await state.transaction(
        async (tx) => await tx.run("INSERT INTO rebuild_child VALUES('missing')"),
      ),
    /FOREIGN KEY/,
  );
  await assert.rejects(
    async () =>
      await state.migrate('rebuild_test', [
        initial,
        migration,
        { version: 3, rebuild: true, sql: "DELETE FROM rebuild_parent WHERE id='execution-a';" },
      ]),
    { code: 'migration_foreign_key' },
  );
  assert.equal(
    (
      await state.read(
        async (sql) =>
          await sql.get<{ id: string }>("SELECT id FROM rebuild_parent WHERE id='execution-a'"),
      )
    )?.id,
    'execution-a',
  );
  await assert.rejects(
    async () =>
      await state.transaction(
        async (tx) => await tx.run("INSERT INTO rebuild_child VALUES('still-missing')"),
      ),
    /FOREIGN KEY/,
  );
});
