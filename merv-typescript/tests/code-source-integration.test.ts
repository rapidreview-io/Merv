import assert from 'node:assert/strict';
import test from 'node:test';
import { codePublishFixture } from './fixtures/code-publish.js';

test('a pushed user branch requires one reviewed integration and leaves main and existing pins intact', async (t) => {
  const f = await codePublishFixture(t, false, true);
  const original = await f.declare('Pinned before source update');
  const base = await f.pin(original);
  f.publishGitRef('user-feature', f.feature);
  const input = {
    baseBranch: 'user-feature',
    headOid: f.feature,
    expectedMainOid: f.root0,
    requestId: 'integrate-source',
  };
  const first = await f.code.prepareRepository(f.admin, input);
  assert.equal(first.state, 'review_required');
  assert.ok(first.taskId);
  assert.deepEqual(await f.code.prepareRepository(f.admin, input), first);
  assert.equal((await f.code.status(f.admin)).project!.main.oid, f.root0);
  assert.deepEqual(await f.pin(original), base);
  const task = await f.tasks.get(f.admin, first.taskId!);
  assert.match(task.title, /Integrate source user-feature/);
  const pinned = await f.state.read((sql) => sql.all('SELECT * FROM code_repository_sync'));
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].remote_oid, f.feature);
  f.source.git('checkout', '--detach', f.feature);
  f.publishGitRef('user-feature', f.source.commit({ 'new.txt': 'later content\n' }));
  await assert.rejects(f.code.prepareRepository(f.admin, input), { code: 'code_branch_changed' });
  assert.equal((await f.code.status(f.admin)).project!.main.oid, f.root0);
});
