import assert from 'node:assert/strict';
import test from 'node:test';
import { backends, optional } from './fixtures/code-store.js';
import { resolutionFixture } from './fixtures/resolution.js';

for (const backend of backends)
  test(
    `${backend}: Sessions retains writing contributors by instance and revision`,
    optional(backend),
    async (t) => {
      const f = await resolutionFixture(t, backend);
      const producer = (await f.scope.issueActor(f.admin, { name: 'Writer', role: 'producer' }))
        .actor;
      await f.state.transaction(async (tx) => {
        for (const [id, instanceId, revision, readOnly] of [
          ['earlier', 'unit', 0, false],
          ['current', 'unit', 2, false],
          ['reader', 'unit', 1, true],
          ['other', 'other-unit', 0, false],
        ] as const) {
          await tx.run(
            "INSERT INTO worker_sessions(id,project_id,actor_id,instance_id,revision,owner_hash,runner_id,request_id,token_hash,fingerprint,status,session_json) VALUES (?,?,?,?,?,?,?,?,?,?,'released',?)",
            id,
            f.admin.projectId,
            producer.id,
            instanceId,
            revision,
            id,
            id,
            id,
            id,
            id,
            JSON.stringify({
              source: { actorId: f.admin.actorId },
              execution: { policy: { readOnly } },
            }),
          );
        }
        const earlier = { ref: 'earlier', actorId: producer.id, authorityId: f.admin.actorId };
        assert.deepEqual(await f.sessions.contributors(f.admin.projectId, 'unit', 2, tx), [
          earlier,
        ]);
        assert.deepEqual(await f.sessions.contributors(f.admin.projectId, 'unit', null, tx), [
          { ...earlier, ref: 'current' },
          earlier,
        ]);
        assert.deepEqual(await f.sessions.contributors('other-project', 'unit', null, tx), []);
        assert.deepEqual(await f.sessions.contributors(f.admin.projectId, 'unit', 0, tx), []);
      });
    },
  );
