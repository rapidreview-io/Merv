import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { MainLanding } from '../packages/code-work/src/landing.js';
import type { CodeUnitService } from '../packages/code-work/src/units.js';
import { baseResolutionFixture } from './fixtures/base-resolution.js';
import { codePublishFixture } from './fixtures/code-publish.js';
import { git } from './fixtures/code-store.js';
const landingOf = (code: unknown) => (code as { landing: MainLanding }).landing;

async function fixture(t: TestContext, connected = false, enabled = true) {
  const f = await codePublishFixture(t, connected, connected, 0, { mainLanding: enabled });
  const landing = landingOf(f.code);
  const project = f.admin.projectId;
  /** Lands and merges until nothing moves; the passes are what timers and hooks would run. */
  const drive = async () => {
    for (let round = 0; round < 6; round++) {
      await landing.work(project);
      await f.bases.work(project);
    }
  };
  const main = async () => (await f.code.status(f.admin)).project!.main.oid;
  const status = async () => (await f.code.status(f.admin)).landing!;
  const subject = (oid: string) => git(f.bare, ['log', '-1', '--format=%s', oid]);
  const parents = (oid: string) =>
    git(f.bare, ['rev-list', '--parents', '-n', '1', oid]).split(' ').slice(1).sort();
  const commitOn = (parent: string, files: Record<string, string>, name: string) => {
    // A parent the server merged exists only in its repository.
    git(f.bare, ['update-ref', `refs/heads/parent-${name}`, parent]);
    f.source.git('fetch', '-q', f.bare, `refs/heads/parent-${name}`);
    f.source.git('checkout', '--detach', parent);
    const commit = f.source.commit(files);
    f.publishGitRef(name, commit);
    return commit;
  };
  /** The same journal over the same state: what a restarted server reads. */
  const restarted = () =>
    new MainLanding(
      f.state,
      (f.code as unknown as { unitStore: CodeUnitService }).unitStore,
      f.repositories,
      f.workflows,
      true,
    );
  return { ...f, landing, project, drive, main, status, subject, parents, commitOn, restarted };
}
const outcomes = (status: { landed: { unitId: string; outcome: string }[] }) =>
  status.landed.map((item) => [item.unitId, item.outcome]);

test('racing acceptances land in acceptance order, one open landing at a time', async (t) => {
  const f = await fixture(t);
  t.mock.method(f.landing, 'soon', () => {});
  const units = [];
  for (const [name, commit] of [
    ['First', f.feature],
    ['Second', f.moved],
  ] as const) {
    const work = await f.declare(name);
    await f.accept(work, commit);
    units.push(work);
  }
  await Promise.allSettled([
    f.landing.work(f.project),
    f.landing.work(f.project),
    f.restarted().work(f.project),
  ]);
  const open = () =>
    f.state.read((sql) =>
      sql.all(
        'SELECT unit_id FROM code_main_landings WHERE project_id=? AND outcome IS NULL',
        f.project,
      ),
    );
  assert.deepEqual(await open(), [{ unit_id: units[1].id }]);
  const current = (await f.status()).current!;
  assert.equal(current.unitId, units[1].id);
  assert.equal(current.state, 'merging');
  assert.equal(current.mainOid, f.feature);
  // The journal itself refuses a second open landing in a project.
  await assert.rejects(
    f.state.transaction((tx) =>
      tx.run(
        "INSERT INTO code_main_landings(project_id,landing_key,seq,unit_id,acceptance_hash,main_oid,head_oid,created_at) VALUES (?,'second',99,'x','x','x','x','now')",
        f.project,
      ),
    ),
  );
  await f.drive();
  assert.deepEqual(outcomes(await f.status()), [
    [units[1].id, 'merged'],
    [units[0].id, 'ff'],
  ]);
  assert.deepEqual(await open(), []);
});

test('a restart resumes the open landing before and after its merge', async (t) => {
  const f = await fixture(t);
  t.mock.method(f.landing, 'soon', () => {});
  const first = await f.declare('First');
  await f.accept(first, f.feature);
  await f.drive();
  for (const [name, commit, merged] of [
    ['Before', f.moved, false],
    ['After', f.commitOn(f.root0, { 'after.txt': 'after\n' }, 'after'), true],
  ] as const) {
    const work = await f.declare(name);
    await f.accept(work, commit);
    const before = await f.main();
    await f.landing.work(f.project);
    // The server stops here: the landing is open, its base merged or not yet.
    if (merged) await f.bases.work(f.project);
    assert.equal(await f.main(), before);
    const restarted = f.restarted();
    await restarted.work(f.project);
    await f.bases.work(f.project);
    await restarted.work(f.project);
    assert.deepEqual(f.parents(await f.main()), [before, commit].sort());
    assert.deepEqual(outcomes(await f.status())[0], [work.id, 'merged']);
  }
});

test('code-less and quarantined work never lands', async (t) => {
  const f = await fixture(t);
  const scratch = await f.declare('Scratch');
  const done = await f.move(scratch);
  await f.state.transaction((tx) =>
    f.code.acceptUnit(
      f.admin,
      {
        unitId: scratch.id,
        terminalRevision: done.revision,
        submissionRef: 'scratch',
        reviewRef: 'scratch',
        codeRef: null,
        reviewSessionId: null,
      },
      tx,
    ),
  );
  const held = await f.declare('Held');
  t.mock.method(f.landing, 'soon', () => {});
  await f.accept(held, f.feature);
  await f.state.transaction((tx) =>
    tx.run("UPDATE code_units SET quarantine_base_key='quarantined' WHERE unit_id=?", held.id),
  );
  await f.landing.work(f.project);
  assert.equal(await f.main(), f.root0);
  const status = await f.status();
  assert.deepEqual(status.waiting, []);
  assert.deepEqual(status.landed, []);
});

test('a conflict with main is one resolution task, and main takes its reviewed result', async (t) => {
  const f = await baseResolutionFixture(t, false, { mainLanding: true });
  const landing = landingOf(f.code);
  const project = f.admin.projectId;
  const drive = async () => {
    for (let round = 0; round < 6; round++) {
      await landing.work(project);
      await f.bases.work(project);
    }
  };
  const main = async () => (await f.code.status(f.admin)).project!.main.oid;
  // A, C and D were accepted on main in that order; A and C clash on f.txt.
  await drive();
  let status = (await f.code.status(f.admin)).landing!;
  assert.equal(await main(), f.a);
  assert.equal(status.current?.unitId, f.right.id);
  assert.equal(status.current?.state, 'awaiting_resolution');
  const task = (await f.record([f.a, f.c]))!.resolutionTaskId!;
  assert.equal(status.current?.resolutionTaskId, task);
  await drive();
  const tasks = await f.state.read((sql) =>
    sql.all('SELECT resolution_task_id FROM code_bases WHERE resolution_task_id IS NOT NULL'),
  );
  assert.equal(tasks.length, 1, 'one task, however many passes see the conflict');
  assert.deepEqual(
    status.waiting.map((item) => item.unitId),
    [f.extra.id],
  );
  const resolved = await f.resolveCommit();
  await f.acceptResolution(resolved);
  await drive();
  status = (await f.code.status(f.admin)).landing!;
  assert.deepEqual(outcomes(status), [
    [f.extra.id, 'merged'],
    [f.right.id, 'resolved'],
    [f.left.id, 'ff'],
  ]);
  assert.equal(status.landed[1].resultOid, resolved);
  assert.deepEqual(
    git(f.bare, ['rev-list', '--parents', '-n', '1', await main()])
      .split(' ')
      .slice(1)
      .sort(),
    [resolved, f.d].sort(),
  );
});
