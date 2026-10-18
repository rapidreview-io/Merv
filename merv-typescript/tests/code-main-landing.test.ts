import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { CodeUnitService } from '../packages/code-work/src/units.js';
import { MainLanding } from '../packages/code-work/src/landing.js';
import type { CodeRepositories } from '@merv/code/store/repository';
import type { Transaction } from '@merv/contracts';
import { git } from './fixtures/code-store.js';
import { codePublishFixture } from './fixtures/code-publish.js';
import { baseResolutionFixture } from './fixtures/base-resolution.js';
import { baseKey } from '../packages/code-work/src/base-plan.js';

/**
 * Accepted work lands on Merv's main (founder decision 2026-10-11): in a hosted project with no
 * linked GitHub repository every accepted unit with code is carried into main, oldest first.
 */
type Fixture = Awaited<ReturnType<typeof codePublishFixture>>;
const landingOf = (code: unknown) => (code as { landing: MainLanding }).landing;
const enable = (landing: MainLanding) => ((landing as { enabled: boolean }).enabled = true);

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
      f.code.github,
      f.workflows,
      true,
    );
  return { ...f, landing, project, drive, main, status, subject, parents, commitOn, restarted };
}
const outcomes = (status: { landed: { unitId: string; outcome: string }[] }) =>
  status.landed.map((item) => [item.unitId, item.outcome]);

test('main moves forward from the initial commit, then a clean merge names the work it lands', async (t) => {
  const f = await fixture(t);
  const first = await f.declare('First');
  await f.accept(first, f.feature);
  await f.drive();
  assert.equal(await f.main(), f.feature);
  const second = await f.declare('Second');
  await f.accept(second, f.moved);
  await f.drive();
  const merged = await f.main();
  assert.deepEqual(f.parents(merged), [f.feature, f.moved].sort());
  assert.equal(f.subject(merged), `Land input: Second (${second.id})`);
  const status = await f.status();
  assert.equal(status.enabled, true);
  assert.equal(status.current, null);
  assert.deepEqual(status.waiting, []);
  assert.deepEqual(outcomes(status), [
    [second.id, 'merged'],
    [first.id, 'ff'],
  ]);
  assert.equal(status.landed[0].resultOid, merged);
  const landed = (await f.state.events(f.project)).filter((e) => e.type === 'code.main_landed');
  assert.deepEqual(
    landed.map((event) => [event.subjectId, event.data.outcome, event.data.main]),
    [
      [first.id, 'ff', f.feature],
      [second.id, 'merged', merged],
    ],
  );
  // Main means all accepted work, so nothing is left that main is missing.
  assert.deepEqual((await f.code.acceptedSince(f.admin)).unitIds, []);
  // Later work with no dependencies starts from that main.
  const later = await f.declare('Later');
  assert.equal((await f.pin(later)).reference, merged);
});

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

test('a main a bind moved settles the open landing superseded, and the next takes the new main', async (t) => {
  const f = await fixture(t);
  t.mock.method(f.landing, 'soon', () => {});
  const first = await f.declare('First');
  await f.accept(first, f.feature);
  await f.drive();
  const second = await f.declare('Second');
  await f.accept(second, f.moved);
  await f.landing.work(f.project);
  await f.setMain(f.root0);
  await f.drive();
  const status = await f.status();
  assert.deepEqual(outcomes(status), [
    [second.id, 'merged'],
    [first.id, 'ff'],
    [second.id, 'superseded'],
    [first.id, 'ff'],
  ]);
  assert.equal(status.landed[2].reason, 'main_moved');
  assert.deepEqual(f.parents(await f.main()), [f.feature, f.moved].sort());
});

for (const action of ['cancel', 'quarantine'] as const)
  test(`a ${action}led base is skipped once and the next unit lands`, async (t) => {
    const f = await fixture(t);
    const first = await f.declare('First');
    await f.accept(first, f.feature);
    const clash = await f.declare('Clash');
    await f.accept(clash, f.clashing);
    const third = await f.declare('Third');
    await f.accept(third, f.moved);
    await f.drive();
    const current = (await f.status()).current!;
    assert.equal(current.unitId, clash.id);
    assert.equal(current.state, 'awaiting_resolution');
    assert.ok(current.resolutionTaskId);
    assert.deepEqual(
      (await f.status()).waiting.map((item) => item.unitId),
      [third.id],
    );
    await f.code.controlBase(f.admin, {
      key: current.baseKey!,
      action,
      reason: 'The clash is handled elsewhere.',
      requestId: `base-${action}`,
    });
    await f.drive();
    const status = await f.status();
    assert.deepEqual(outcomes(status), [
      [third.id, 'merged'],
      [clash.id, 'skipped'],
      [first.id, 'ff'],
    ]);
    assert.equal(
      status.landed[1].reason,
      action === 'cancel' ? 'base_cancelled' : 'base_quarantined',
    );
    // A skipped landing is never offered again.
    assert.deepEqual(status.waiting, []);
    assert.deepEqual(f.parents(await f.main()), [f.feature, f.moved].sort());
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

test('a quarantine that commits while landing works is read with the move of main', async (t) => {
  const f = await fixture(t);
  t.mock.method(f.landing, 'soon', () => {});
  const first = await f.declare('First');
  await f.accept(first, f.feature);
  await f.landing.work(f.project);
  // A base quarantined after its merge, as its landing settles, is skipped and never landed.
  const second = await f.declare('Second');
  await f.accept(second, f.moved);
  await f.landing.work(f.project);
  await f.bases.work(f.project);
  const key = (await f.status()).current!.baseKey!;
  const standing = f.landing.standing.bind(f.landing);
  let calls = 0;
  t.mock.method(f.landing, 'standing', async (sql: Parameters<typeof standing>[0], id: string) => {
    if (++calls === 2)
      await (sql as unknown as Transaction).run(
        "UPDATE code_bases SET health='quarantined',operator_reason='Late alarm' WHERE base_key=?",
        key,
      );
    return await standing(sql, id);
  });
  await f.landing.work(f.project);
  assert.deepEqual(outcomes(await f.status()), [
    [second.id, 'skipped'],
    [first.id, 'ff'],
  ]);
  // Work quarantined while Git says main fast-forwards to it is not fast-forwarded to.
  const third = await f.declare('Third');
  await f.accept(third, f.commitOn(f.feature, { 'third.txt': 'third\n' }, 'third'));
  const git = (f.landing as unknown as { repositories: CodeRepositories }).repositories.git;
  const run = git.run.bind(git);
  t.mock.method(git, 'run', async (...args: Parameters<typeof run>) => {
    if (args[0].includes('--is-ancestor'))
      await f.state.transaction((tx) =>
        tx.run("UPDATE code_units SET quarantine_base_key='late' WHERE unit_id=?", third.id),
      );
    return await run(...args);
  });
  await f.landing.work(f.project);
  assert.equal(await f.main(), f.feature);
  assert.equal((await f.status()).landed.length, 2);
});

test('a project linked to GitHub is left to its pull requests', async (t) => {
  const f = await fixture(t, true);
  const work = await f.declare('Linked');
  await f.accept(work, f.feature);
  await f.landing.work(f.project);
  await f.landing.tick();
  assert.equal(await f.main(), f.root0);
  const status = await f.status();
  assert.equal(status.enabled, false);
  assert.equal(status.reason, 'github_linked');
  assert.deepEqual(
    status.waiting.map((item) => item.unitId),
    [work.id],
  );
});

test('switched off nothing lands, and waiting is the order a first start would backfill', async (t) => {
  const f = await fixture(t, false, false);
  const a = await f.declare('A');
  await f.accept(a, f.feature);
  const b = await f.declare('B');
  await f.accept(b, f.moved);
  // D builds on A's accepted commit, so it is accepted after A and lands after it.
  const d = await f.declare('D', [a.id]);
  const child = f.commitOn(f.feature, { 'child.txt': 'child\n' }, 'child');
  await f.accept(d, child);
  await f.landing.work(f.project);
  assert.equal(await f.main(), f.root0);
  const off = await f.status();
  assert.equal(off.enabled, false);
  assert.equal(off.reason, 'disabled');
  assert.deepEqual(
    off.waiting.map((item) => item.unitId),
    [a.id, b.id, d.id],
  );
  enable(f.landing);
  await f.landing.tick();
  await f.drive();
  const on = await f.status();
  assert.deepEqual(outcomes(on).reverse(), [
    [a.id, 'ff'],
    [b.id, 'merged'],
    [d.id, 'merged'],
  ]);
  const main = await f.main();
  for (const commit of [f.feature, f.moved, child])
    git(f.bare, ['merge-base', '--is-ancestor', commit, main]);
});

test('local publication counts a main that already holds its head, and waits while landing merges a moved one', async (t) => {
  const f = await fixture(t);
  t.mock.method(f.landing, 'soon', () => {});
  const published = await f.declare('Contained');
  await f.publishes(published);
  await f.pin(published);
  await f.accept(published, f.feature);
  const other = await f.declare('Other');
  await f.accept(other, f.moved);
  await f.drive();
  const merged = await f.main();
  const [integrated] = await f.sync();
  assert.equal(integrated.verified, true);
  assert.equal(integrated.merge?.mainParent, merged);
  assert.equal(await f.main(), merged, 'a contained head never moves main back');

  const moved = await f.declare('Moved');
  await f.publishes(moved);
  await f.pin(moved);
  const own = f.commitOn(merged, { 'moved.txt': 'moved\n' }, 'own');
  await f.accept(moved, own);
  const bound = f.commitOn(merged, { 'bound.txt': 'bound\n' }, 'bound');
  await f.setMain(bound);
  const pending = (await f.sync()).find((item) => item.instanceId === moved.id)!;
  assert.equal(pending.stale, false);
  assert.equal(pending.verified, false);
  await f.drive();
  assert.deepEqual(f.parents(await f.main()), [bound, own].sort());
  const done = (await f.sync()).find((item) => item.instanceId === moved.id)!;
  assert.equal(done.verified, true);
  assert.equal((await f.code.unit(f.admin, moved.id)).publication?.state, 'published');
});

test('a local publication whose landing was skipped settles stale instead of waiting for it', async (t) => {
  const f = await fixture(t);
  t.mock.method(f.landing, 'soon', () => {});
  const moved = await f.declare('Moved');
  await f.publishes(moved);
  await f.pin(moved);
  await f.accept(moved, f.commitOn(f.root0, { 'moved.txt': 'moved\n' }, 'own'));
  await f.setMain(f.commitOn(f.root0, { 'bound.txt': 'bound\n' }, 'bound'));
  await f.landing.work(f.project);
  await f.code.controlBase(f.admin, {
    key: (await f.status()).current!.baseKey!,
    action: 'cancel',
    reason: 'Handled by successor work.',
    requestId: 'cancel-landing',
  });
  await f.drive();
  assert.deepEqual(outcomes(await f.status()), [[moved.id, 'skipped']]);
  const publication = (await f.sync()).find((item) => item.instanceId === moved.id)!;
  assert.equal(publication.stale, true);
  assert.deepEqual(
    (await f.blockers(moved.id)).map((item) => item.code),
    ['code_publication_stale'],
  );
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

/**
 * A, C and E clash on f.txt, D touches g.txt, all accepted; main is A, and C's landing waits on
 * its resolution, which work that needs all four builds on.
 */
async function siblings(t: TestContext) {
  const f = await baseResolutionFixture(t, false, { mainLanding: true });
  const landing = landingOf(f.code);
  const project = f.admin.projectId;
  const drive = async () => {
    for (let round = 0; round < 8; round++) {
      await landing.work(project);
      await f.bases.work(project);
    }
  };
  const main = async () => (await f.code.status(f.admin)).project!.main.oid;
  const tasks = () =>
    f.state.read((sql) =>
      sql.all<{ base_key: string; members_json: string; state: string }>(
        'SELECT base_key,members_json,state FROM code_bases WHERE resolution_task_id IS NOT NULL ORDER BY base_key',
      ),
    );
  f.source.git('checkout', '--detach', f.main);
  const e = f.source.commit({ 'f.txt': 'E\n' });
  f.source.git('push', f.bare, `${e}:refs/heads/e`);
  const fifth = await f.input('E', e);
  await drive();
  assert.equal(await main(), f.a);
  await f.waiter([f.left, f.right, f.extra, fifth]);
  await drive();
  await f.acceptResolution(await f.resolveCommit());
  await drive();
  return { ...f, landing, project, drive, main, tasks, e, fifth };
}

test('work a dependent’s base already merges on top of main lands through it, so no conflict is resolved twice', async (t) => {
  const f = await siblings(t);
  // D and E land through that work's base: E's clash is one task, for the work and main alike.
  const open = (await f.tasks()).filter((task) => task.state === 'awaiting_resolution');
  assert.equal((await f.tasks()).length, 2);
  assert.equal(open.length, 1);
  const members = JSON.parse(open[0]!.members_json) as string[];
  // One side of this step is a server merge, which only the project's repository holds.
  const [left, right] = await f.state.read(async (sql) =>
    f.bases.inputs(sql, f.project, (await f.record(members))!),
  );
  const resolved = git(f.bare, [
    'commit-tree',
    `${f.a}^{tree}`,
    '-p',
    left!,
    '-p',
    right!,
    '-m',
    'Resolve E',
  ]);
  await f.acceptResolution(resolved, members);
  await f.drive();
  assert.equal((await f.tasks()).length, 2);
  assert.equal(await f.main(), (await f.record([f.a, f.c, f.d, f.e]))!.result!.commit);
});

test('a landing whose joined base is cancelled is offered again and lands on its own', async (t) => {
  const f = await siblings(t);
  t.mock.method(f.landing, 'soon', () => {});
  const open = (await f.tasks()).find((task) => task.state === 'awaiting_resolution')!;
  const current = (await f.code.status(f.admin)).landing!.current!;
  assert.notEqual(current.baseKey, baseKey([current.mainOid, current.headOid]));
  await f.code.controlBase(f.admin, {
    key: open.base_key,
    action: 'cancel',
    reason: 'The dependent work is replanned.',
    requestId: 'cancel-joined',
  });
  await f.drive();
  const status = (await f.code.status(f.admin)).landing!;
  const superseded = status.landed.find((item) => item.unitId === current.unitId)!;
  assert.equal(superseded.outcome, 'superseded');
  assert.equal(superseded.reason, 'base_cancelled');
  // The unit is not given up: it now lands on main through its own base.
  const again = status.current!;
  assert.equal(again.unitId, current.unitId);
  assert.equal(again.baseKey, baseKey([again.mainOid, again.headOid]));
});

test('history says which work each commit came from, though Git carries no record names', async (t) => {
  const f = await fixture(t);
  const first = await f.declare('First');
  await f.accept(first, f.feature);
  const second = await f.declare('Second');
  await f.accept(second, f.moved);
  await f.drive();
  const history = await f.code.history(f.admin, {});
  assert.equal(history.ref, 'main');
  const merge = history.commits[0]!;
  assert.equal(merge.subject, `Land input: Second (${second.id})`, 'the landing names its work');
  const own = (oid: string) => history.commits.find((commit) => commit.oid === oid)?.unit;
  assert.deepEqual(own(f.feature), { id: first.id, kind: 'input', title: 'First' });
  assert.deepEqual(own(f.moved), { id: second.id, kind: 'input', title: 'Second' });
  assert.equal(merge.unit, undefined, 'a server merge is no unit’s own work');
  const one = await f.code.history(f.admin, { ref: first.id, limit: 1 });
  assert.equal(one.commits.length, 1);
  assert.equal(one.commits[0]!.oid, f.feature);
});

test('a merge of accepted work for work that depends on it names that work, not its key', async (t) => {
  const f = await fixture(t, false, false);
  const first = await f.declare('First');
  await f.accept(first, f.feature);
  const second = await f.declare('Second');
  await f.accept(second, f.moved);
  await f.declare('Third', [first.id, second.id]);
  for (let round = 0; round < 4; round++) await f.bases.work(f.project);
  const merged = (await f.code.status(f.admin)).bases?.find((base) => base.result)?.result;
  assert.ok(merged, 'the two accepted commits were merged for the work that waits on both');
  assert.equal(f.subject(merged.commit), 'Merge First + Second');
});
