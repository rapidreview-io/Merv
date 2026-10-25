import assert from 'node:assert/strict';
import test from 'node:test';
import { baseResolutionFixture } from './fixtures/base-resolution.js';

for (const native of [false, true]) {
  test(`late ${native ? 'native submission' : 'commit'} acceptance records a resolution without another workflow event`, async (t) => {
    const f = await baseResolutionFixture(t);
    await f.waiter();
    await f.bases.work(f.admin.projectId);
    assert.equal((await f.record())!.state, 'awaiting_resolution');
    const commit = await f.resolveCommit();
    await f.acceptResolution(commit, undefined, { native, reconcile: false });
    const taskId = (await f.record())!.resolutionTaskId;
    const retained = await f.state.read((sql) =>
      sql.get<{ resolution_commit: string }>(
        'SELECT resolution_commit FROM code_bases WHERE project_id=? AND resolution_task_id=?',
        f.admin.projectId,
        taskId,
      ),
    );
    assert.equal(retained!.resolution_commit, commit);
    await f.bases.work(f.admin.projectId);
    assert.equal((await f.record())!.state, 'resolved');
    assert.equal((await f.record())!.result!.commit, commit);
  });
}

test('startup reconciliation recovers a retained acceptance whose resolution was never queued', async (t) => {
  const f = await baseResolutionFixture(t);
  await f.waiter();
  await f.bases.work(f.admin.projectId);
  const commit = await f.resolveCommit();
  // Model a persisted acceptance from the old implementation: its base has no recorded
  // resolution commit. The normal startup reconciliation must discover it from storage.
  const missed = t.mock.method(f.bases, 'recordAcceptance', async () => {});
  await f.acceptResolution(commit, undefined, { native: true, reconcile: false });
  missed.mock.restore();
  assert.equal((await f.record())!.state, 'awaiting_resolution');
  await f.code.reconcileAll();
  await f.bases.work(f.admin.projectId);
  assert.equal((await f.record())!.state, 'resolved');
  assert.equal((await f.record())!.result!.commit, commit);
});

test('acceptance arriving after a terminal transition refreshes cached dependent blockers', async (t) => {
  const f = await baseResolutionFixture(t);
  const input = await f.tasks.create(f.admin, {
    title: 'Delayed input',
    goal: 'Retain code after the terminal event',
    checks: ['Code works'],
    workspace: 'git',
    requestId: 'delayed-input',
  });
  await f.state.transaction(async (tx) => {
    await tx.run("UPDATE wf_instances SET state='done',revision=revision+1 WHERE id=?", input.id);
  });
  const ended = await f.workflows.get(f.admin, input.id);
  const waiter = await f.waiter([f.left, ended]);
  const blockers = () => f.workflows.blockers(f.admin, waiter.id);
  assert.ok((await blockers()).some((item) => item.code === 'code_base_pending'));
  await f.accept(ended, f.d);
  assert.equal(
    (await blockers()).some((item) => item.code === 'code_base_pending'),
    false,
  );
});
