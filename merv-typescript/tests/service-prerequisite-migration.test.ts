import assert from 'node:assert/strict';
import test from 'node:test';
import type { Sql } from '@merv/contracts';
import { backends, optional, type Backend } from './fixtures/code-store.js';
import { resolutionFixture } from './fixtures/resolution.js';

const indexes = (sql: Sql, backend: Backend, table: string) =>
  sql.all<{ name: string; definition: string }>(
    backend === 'sqlite'
      ? "SELECT name,sql AS definition FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL ORDER BY name"
      : 'SELECT indexname AS name,indexdef AS definition FROM pg_indexes WHERE schemaname=current_schema() AND tablename=? ORDER BY indexname',
    table,
  );

for (const backend of backends) {
  test(
    `${backend}: workflow prerequisites upgrade populated v6 dependencies without changing declared contracts`,
    optional(backend),
    async (t) => {
      const f = await resolutionFixture(t, backend, { workflows: 6 });
      const handle = await f.workflows.register(
        {
          name: 'migration',
          version: 1,
          managed: true,
          initial: 'working',
          states: ['working', 'done', 'failed'],
          terminal: ['done', 'failed'],
          edges: [
            { from: 'working', action: 'finish', to: 'done' },
            { from: 'working', action: 'fail', to: 'failed' },
          ],
        },
        {
          successStates: ['done'],
          dependencyFailureAction: 'fail',
          actions: [
            {
              name: 'finish',
              tool: 'migration.finish',
              instruction: 'Finish.',
              states: ['working'],
              transitions: ['finish'],
              requiresDependencies: true,
              check: () => {},
            },
            {
              name: 'fail',
              tool: 'migration.fail',
              instruction: 'Fail.',
              states: ['working'],
              transitions: ['fail'],
              suggested: false,
              check: () => {},
            },
          ],
        },
      );
      const a = await handle.start(f.admin, { workflow: 'migration', requestId: 'a' });
      const b = await handle.start(f.admin, { workflow: 'migration', requestId: 'b' });
      const c = await handle.start(f.admin, { workflow: 'migration', requestId: 'c' });
      // The preceding release wrote these columns, before kind and owner existed.
      for (const [source, target] of [
        [c.id, b.id],
        [b.id, a.id],
        [c.id, a.id],
      ])
        await f.state.transaction((tx) =>
          tx.run(
            'INSERT INTO wf_dependencies(project_id,source_id,target_id,target_workflow,target_version,target_success_json,target_terminal_json,created_at) VALUES (?,?,?,?,?,?,?,?)',
            f.admin.projectId,
            source,
            target,
            'migration',
            1,
            '["done"]',
            '["done","failed"]',
            'before-upgrade',
          ),
        );
      const before = await f.state.read((sql) =>
        sql.all('SELECT * FROM wf_dependencies ORDER BY source_id,target_id'),
      );
      const beforeIndexes = await f.state.read((sql) => indexes(sql, backend, 'wf_dependencies'));
      await f.workflows.initialize();
      await f.workflows.initialize();
      const after = await f.state.read((sql) =>
        sql.all<{ kind: string; owner: string }>(
          'SELECT * FROM wf_dependencies ORDER BY source_id,target_id',
        ),
      );
      assert.deepEqual(
        after.map(({ kind, owner, ...row }) => {
          assert.equal(kind, 'declared');
          assert.equal(owner, '');
          return row;
        }),
        before.map((row) => ({ ...(row as Record<string, unknown>) })),
      );
      const afterIndexes = await f.state.read((sql) => indexes(sql, backend, 'wf_dependencies'));
      for (const name of ['wf_dependencies_source', 'wf_dependencies_target'])
        assert.deepEqual(
          afterIndexes.find((index) => index.name === name),
          beforeIndexes.find((index) => index.name === name),
        );
      assert.deepEqual(
        afterIndexes
          .filter((index) => /wf_dependencies_(source|target)$/.test(index.name))
          .map((index) => index.name),
        ['wf_dependencies_source', 'wf_dependencies_target'],
      );
      const read = (await f.workflows.dependencies(f.admin, b.id)).dependencies;
      assert.deepEqual(read, [
        {
          id: a.id,
          workflow: 'migration',
          version: 1,
          name: 'migration',
          state: 'working',
          settled: false,
          failed: false,
        },
      ]);
      await assert.rejects(f.workflows.checkDependencies(f.admin, b.id), {
        code: 'dependencies_pending',
      });
      await assert.rejects(
        f.state.transaction((tx) =>
          tx.run(
            'INSERT INTO wf_dependencies SELECT * FROM wf_dependencies WHERE source_id=? AND target_id=?',
            b.id,
            a.id,
          ),
        ),
      );
      await assert.rejects(
        f.state.transaction((tx) =>
          tx.run("UPDATE wf_dependencies SET kind='system',owner='code' WHERE source_id=?", b.id),
        ),
      );
      await handle.transition(f.admin, {
        instanceId: a.id,
        action: 'finish',
        expectedRevision: 0,
        requestId: 'finish-a',
      });
      await f.workflows.checkDependencies(f.admin, b.id);
      await handle.transition(f.admin, {
        instanceId: b.id,
        action: 'fail',
        expectedRevision: 0,
        requestId: 'fail-b',
      });
      assert.equal((await f.workflows.evaluate(f.admin, c.id)).currentGate, 'dependency_failed');
      // The widened key permits a provider's edge beside the old declared row.
      await f.state.transaction((tx) =>
        f.workflows.systemPrerequisites('code').replace(
          {
            projectId: f.admin.projectId,
            instanceId: c.id,
            dependencies: [b.id],
            requestId: 'system',
          },
          tx,
        ),
      );
      assert.equal((await f.workflows.dependencies(f.admin, c.id)).dependencies.length, 3);
      await handle.addDependencies(f.admin, {
        instanceId: c.id,
        expectedRevision: 0,
        dependsOn: [],
        drop: [b.id],
        requestId: 'drop',
      });
      const remaining = (await f.workflows.dependencies(f.admin, c.id)).dependencies;
      assert.equal(remaining.length, 2);
      assert.equal(remaining.find((edge) => edge.id === b.id)!.kind, 'system');
      assert.equal((await f.workflows.evaluate(f.admin, c.id)).currentGate, 'dependencies_pending');
      await handle.addDependencies(f.admin, {
        instanceId: c.id,
        expectedRevision: 1,
        dependsOn: [b.id],
        requestId: 'add',
      });
      assert.equal((await f.workflows.dependencies(f.admin, c.id)).dependencies.length, 3);
    },
  );

  test(
    `${backend}: service actor guards upgrade populated scope v7 and retain ordinary credentials and indexes`,
    optional(backend),
    async (t) => {
      const f = await resolutionFixture(t, backend, { scope: 7 });
      const writer = await f.scope.issueActor(f.admin, { name: 'Writer', role: 'producer' });
      const reviewer = await f.scope.issueActor(f.admin, { name: 'Reviewer', role: 'reviewer' });
      const rows = () =>
        f.state.read(async (sql) => ({
          actors: await sql.all('SELECT * FROM actors ORDER BY id'),
          credentials: await sql.all('SELECT * FROM actor_credentials ORDER BY id'),
          indexes: [
            ...(await indexes(sql, backend, 'actors')),
            ...(await indexes(sql, backend, 'actor_credentials')),
          ],
        }));
      const before = await rows();
      await f.scope.initialize();
      await f.scope.initialize();
      const after = await rows();
      assert.deepEqual(
        after.actors.map((row) => {
          const { service_owner, ...old } = row as Record<string, unknown>;
          assert.equal(service_owner, null);
          return old;
        }),
        before.actors.map((row) => ({ ...(row as Record<string, unknown>) })),
      );
      assert.deepEqual(after.credentials, before.credentials);
      assert.deepEqual(
        after.indexes.filter((index) => index.name !== 'actors_service'),
        before.indexes,
      );
      assert.ok(after.indexes.some((index) => index.name === 'actors_service'));
      for (const issued of [writer, reviewer])
        assert.equal((await f.scope.authenticate(issued.token)).id, issued.actor.id);
      const caller = { projectId: f.admin.projectId, actorId: writer.actor.id };
      await f.scope.require(caller, 'write');
      await assert.rejects(f.scope.require(caller, 'admin'), { code: 'forbidden' });
      await f.scope.revokeCredential(f.admin, writer.credential.id);
      await assert.rejects(f.scope.authenticate(writer.token), { code: 'unauthorized' });
      await assert.rejects(
        f.state.transaction((tx) =>
          tx.run('DELETE FROM actor_credentials WHERE id=?', reviewer.credential.id),
        ),
      );
      const service = await f.state.transaction((tx) =>
        f.scope.serviceActor('code', f.admin.projectId, tx),
      );
      assert.deepEqual(
        await f.state.transaction((tx) => f.scope.serviceActor('code', f.admin.projectId, tx)),
        service,
      );
      for (const column of ['session_id', 'agent_id'])
        await assert.rejects(
          f.state.transaction((tx) =>
            tx.run(`UPDATE actors SET ${column}=? WHERE id=?`, 'forbidden', service.actorId),
          ),
          backend === 'sqlite'
            ? /Service actors are credential-free producers/
            : { code: /^state_/ },
        );
      await assert.rejects(
        f.state.transaction((tx) =>
          tx.run("UPDATE actors SET role='operator' WHERE id=?", service.actorId),
        ),
      );
      await assert.rejects(f.scope.issueActorCredential(f.admin, { actorId: service.actorId }), {
        code: 'member_actor',
      });
    },
  );
}
