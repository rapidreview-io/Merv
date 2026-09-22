import test from 'node:test';
import assert from 'node:assert/strict';
import { backends, codeStoreFixture, optional } from './fixtures/code-store.js';

for (const backend of backends)
  test(
    `${backend}: Code receipts survive concurrent replay, isolate principals and roll back with their mutation`,
    optional(backend),
    async (t) => {
      const f = await codeStoreFixture(t, backend);
      const request = {
        denyGlobs: ['private/**'],
        secretExemptGlobs: [],
        check: null,
        requestId: 'shared-request',
      };
      const [first, raced] = await Promise.all([
        f.code.configureRepository(f.admin, request),
        f.code.configureRepository(f.admin, request),
      ]);
      assert.deepEqual(raced, first);
      const receipts = () =>
        f.state.read((sql) =>
          sql.all<{ id: string; principal_scope: string; result_json: string }>(
            'SELECT id,principal_scope,result_json FROM code_operations WHERE request_id=?',
            request.requestId,
          ),
        );
      assert.equal((await receipts()).length, 1, 'concurrent retries retain one receipt');
      assert.equal(
        (await f.state.events(f.admin.projectId)).filter(
          (event) => event.type === 'code.repository_configured',
        ).length,
        1,
      );
      await assert.rejects(f.code.configureRepository(f.admin, { ...request, denyGlobs: [] }), {
        code: 'request_conflict',
        status: 409,
      });

      const human = await f.human();
      await f.code.configureRepository(human, { ...request, denyGlobs: [] });
      assert.equal(
        (await receipts()).length,
        2,
        'another principal owns its own request namespace',
      );
      assert.deepEqual(
        await f.code.configureRepository(f.admin, request),
        first,
        'replay returns the retained answer even after current configuration changes',
      );
      await assert.rejects(
        f.code.fenceUnit(human, { unitId: 'missing-unit', requestId: request.requestId }),
        { code: 'request_conflict' },
      );

      const producer = await f.scope.issueActor(f.admin, { name: 'Producer', role: 'producer' });
      await assert.rejects(
        f.code.configureRepository(
          {
            projectId: f.admin.projectId,
            actorId: producer.actor.id,
            credentialId: producer.credential.id,
          },
          request,
        ),
        { code: 'forbidden' },
      );
      const append = f.state.appendEvent.bind(f.state);
      f.state.appendEvent = async (tx, event) => {
        if (event.type === 'code.repository_configured') throw new Error('event write failed');
        return append(tx, event);
      };
      const retried = { ...request, requestId: 'rolled-back' };
      try {
        await assert.rejects(f.code.configureRepository(f.admin, retried), /event write failed/);
      } finally {
        f.state.appendEvent = append;
      }
      const rolledBack = await f.state.read(async (sql) => ({
        operation: await sql.get(
          'SELECT id FROM code_operations WHERE request_id=?',
          retried.requestId,
        ),
        project: await sql.get<{ limits_json: string }>(
          'SELECT limits_json FROM code_projects WHERE project_id=?',
          f.admin.projectId,
        ),
      }));
      assert.equal(rolledBack.operation, undefined);
      assert.deepEqual(
        JSON.parse(rolledBack.project!.limits_json).denyGlobs,
        [],
        'the receipt and configuration roll back together',
      );
      assert.deepEqual(
        await f.code.configureRepository(f.admin, retried),
        first,
        'the same request remains retryable after rollback',
      );
    },
  );
