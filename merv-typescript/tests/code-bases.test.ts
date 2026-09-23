import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeBases } from '../packages/code/src/base-merge.js';
import { baseKey, members } from '../packages/code/src/base-plan.js';
import { baseFixture as fixture } from './fixtures/code-bases.js';

test('three units waiting on the same two commits are one record, one merge and one commit', async (t) => {
  const f = await fixture(t);
  const { a, b } = f.commits;
  // Each waiter asks in its own transaction, in whatever order it knows the commits.
  const asked = [];
  for (const set of [
    [a, b],
    [b, a],
    [a, b, a],
  ])
    asked.push(await f.state.transaction(async (tx) => await f.bases.ensure(tx, f.projectId, set)));
  assert.deepEqual(new Set(asked.map((record) => record.key)), new Set([baseKey([a, b])]));
  assert.equal((await f.rows()).length, 1);
  assert.equal(asked[0]!.state, 'queued');
  await Promise.all([
    f.bases.work(f.projectId),
    f.bases.work(f.projectId),
    f.bases.work(f.projectId),
  ]);
  const done = (await f.state.read(async (sql) => await f.bases.find(sql, f.projectId, [a, b])))!;
  assert.equal(done.state, 'resolved');
  assert.equal(done.result!.method, 'auto');
  assert.deepEqual(f.parents(done.result!.commit).sort(), [a, b].sort());
  assert.equal(done.attempts, 1, 'the merge ran once');
  assert.equal(f.changed(), 1, 'and whoever waits is told once');
});

test('{A,B} then {A,B,D}: the reconciled pair is reused, and only D is merged into it', async (t) => {
  const f = await fixture(t);
  const { a, b, d } = f.commits;
  await f.state.transaction(async (tx) => await f.bases.ensure(tx, f.projectId, [a, b]));
  await f.bases.work(f.projectId);
  const pair = (await f.state.read(async (sql) => await f.bases.find(sql, f.projectId, [a, b])))!;
  const triple = await f.state.transaction(
    async (tx) => await f.bases.ensure(tx, f.projectId, [a, b, d]),
  );
  assert.deepEqual([triple.left, triple.right].sort(), [pair.key, baseKey([d])].sort());
  assert.equal((await f.rows()).length, 2, 'no second record for the pair');
  await f.bases.work(f.projectId);
  const made = (await f.state.read(
    async (sql) => await f.bases.find(sql, f.projectId, [a, b, d]),
  ))!;
  assert.equal(made.state, 'resolved');
  assert.deepEqual(f.parents(made.result!.commit).sort(), [pair.result!.commit, d].sort());
  // What the two inputs stand for is answered where the whole project is in hand, and
  // nowhere else: one row on its own is not worth the two reads it would take.
  assert.equal(made.parents, undefined);
  const all = await f.state.read(async (sql) => await f.bases.records(sql, f.projectId));
  assert.deepEqual(
    [...all.find((record) => record.key === made.key)!.parents!].sort(),
    [pair.result!.commit, d].sort(),
  );
});

test('a larger set asked first writes every union on the way, and a later waiter on the pair finds it', async (t) => {
  const f = await fixture(t);
  const { a, b, d } = f.commits;
  await f.state.transaction(async (tx) => await f.bases.ensure(tx, f.projectId, [a, b, d]));
  const written = await f.rows();
  assert.deepEqual(written.map((row) => row.state).sort(), ['queued', 'waiting_inputs']);
  // An input that has no usable result yet is a null, which is a different answer from
  // a record that was never asked what its inputs stand for.
  const waiting = (await f.state.read(async (sql) => await f.bases.records(sql, f.projectId))).find(
    (record) => record.state === 'waiting_inputs',
  )!;
  assert.equal(waiting.parents!.filter((commit) => commit === null).length, 1);
  await f.bases.work(f.projectId);
  assert.deepEqual(
    (await f.rows()).map((row) => row.state),
    ['resolved', 'resolved'],
  );
  const pairKey = written.find((row) => row.state === 'queued')!.base_key;
  const pair = await f.state.read(async (sql) => {
    for (const set of [
      [a, b],
      [a, d],
      [b, d],
    ])
      if (baseKey(set) === pairKey) return await f.bases.find(sql, f.projectId, set);
    return null;
  });
  assert.equal(pair?.state, 'resolved');
});

test('a conflict is recorded once with its paths, waits for resolution, and holds what is built on it', async (t) => {
  const f = await fixture(t);
  const { a, c, d } = f.commits;
  await f.state.transaction(async (tx) => await f.bases.ensure(tx, f.projectId, [a, c]));
  await f.bases.work(f.projectId);
  const conflicted = (await f.state.read(
    async (sql) => await f.bases.find(sql, f.projectId, [a, c]),
  ))!;
  assert.equal(conflicted.state, 'awaiting_resolution');
  assert.deepEqual(conflicted.conflict!.paths, ['f.txt']);
  assert.equal(conflicted.result, null);
  // The automatic merge never restarts for that key, and a superset waits behind it
  // rather than being planned round it.
  await f.bases.work(f.projectId);
  assert.equal(
    (await f.state.read(async (sql) => await f.bases.find(sql, f.projectId, [a, c])))!.attempts,
    1,
  );
  const above = await f.state.transaction(
    async (tx) => await f.bases.ensure(tx, f.projectId, [a, c, d]),
  );
  assert.ok([above.left, above.right].includes(conflicted.key));
  assert.equal(above.state, 'waiting_inputs');
  await f.bases.work(f.projectId);
  assert.equal(
    (await f.state.read(async (sql) => await f.bases.find(sql, f.projectId, [a, c, d])))!.state,
    'waiting_inputs',
  );
});

test('a plan, sponsors and result are frozen, and records are retained', async (t) => {
  const f = await fixture(t);
  const { a, b } = f.commits;
  await f.state.transaction(async (tx) => await f.bases.ensure(tx, f.projectId, [a, b]));
  await f.bases.work(f.projectId);
  for (const sql of [
    "UPDATE code_bases SET left_key='x'",
    "UPDATE code_bases SET sponsors_json='[]'",
    `UPDATE code_bases SET result_json='{"commit":"x"}'`,
    'DELETE FROM code_bases',
  ])
    await assert.rejects(f.state.transaction(async (tx) => await tx.run(sql)));
});

for (const boundary of ['before merge', 'after ref'] as const)
  test(`a crash ${boundary} settles its old epoch once and recovers the same base`, async (t) => {
    const f = await fixture(t);
    const { a, b } = f.commits;
    const base = await f.state.transaction((tx) => f.bases.ensure(tx, f.projectId, [a, b]));
    const input = {
      provider: 'code',
      operationId: `${f.projectId}:${base.key}`,
      executionEpoch: 1,
      projectId: f.projectId,
      sponsors: base.sponsors,
      deadline: new Date(f.clock() + 100).toISOString(),
    };
    await f.state.transaction(async (tx) => {
      assert.equal((await f.sessions.serviceWork.admit(tx, input)).admitted, true);
      await tx.run(
        "UPDATE code_bases SET state='running',attempts=1,execution_epoch=1,deadline=? WHERE project_id=? AND base_key=?",
        input.deadline,
        f.projectId,
        base.key,
      );
    });
    if (boundary === 'after ref') {
      const inputs = await f.state.read((sql) => f.bases.inputs(sql, f.projectId, base));
      const outcome = await mergeBases(
        f.repositories.git,
        f.repositories.environment(f.projectId),
        inputs[0]!,
        inputs[1]!,
        base.key,
      );
      assert.notEqual(outcome.outcome, 'conflict');
      if (outcome.outcome !== 'conflict')
        await f.repositories.git.ok(
          ['update-ref', `refs/merv/bases/${base.key}`, outcome.commit, ''],
          { env: f.repositories.environment(f.projectId) },
        );
    }
    const restarted = f.worker();
    await restarted.initialize();
    await restarted.work(f.projectId);
    assert.equal(
      (await f.state.read((sql) => restarted.find(sql, f.projectId, [a, b])))!.executionEpoch,
      1,
      'an unexpired reservation is not duplicated',
    );
    f.advance(101);
    await restarted.work(f.projectId);
    f.advance(3000);
    await restarted.work(f.projectId);
    const result = (await f.state.read((sql) => restarted.find(sql, f.projectId, [a, b])))!;
    assert.equal(result.state, 'resolved');
    assert.equal(result.executionEpoch, 2);
    await restarted.work(f.projectId);
    const usage = await f.state.read((sql) =>
      sql.all<{ execution_epoch: number; outcome: string; wall_ms: number }>(
        'SELECT execution_epoch,outcome,wall_ms FROM session_service_work ORDER BY execution_epoch',
      ),
    );
    assert.deepEqual(
      usage.map((row) => ({ ...row })),
      [
        { execution_epoch: 1, outcome: 'expired', wall_ms: 100 },
        { execution_epoch: 2, outcome: 'completed', wall_ms: 0 },
      ],
    );
  });
test('a deadline overrun abandons the job and refuses its late result after a new epoch seals', async (t) => {
  const f = await fixture(t);
  const { a, b } = f.commits;
  await f.state.transaction((tx) => f.bases.ensure(tx, f.projectId, [a, b]));
  const git = f.repositories.git.run.bind(f.repositories.git);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let hold = true;
  t.mock.method(f.repositories.git, 'run', async (...args: Parameters<typeof git>) => {
    if (hold && args[0].includes('merge-tree')) {
      hold = false;
      entered();
      await held;
      return git(args[0], { ...args[1], signal: undefined });
    }
    return git(...args);
  });
  const worker = f.worker(true, 1000);
  await worker.initialize();
  const running = worker.work(f.projectId);
  await started;
  f.advance(1001);
  await running;
  assert.equal(
    (await f.state.read((sql) => worker.find(sql, f.projectId, [a, b])))!.state,
    'retry_wait',
  );
  f.advance(3000);
  await worker.work(f.projectId);
  const sealed = (await f.state.read((sql) => worker.find(sql, f.projectId, [a, b])))!;
  assert.equal(sealed.state, 'resolved');
  assert.equal(sealed.executionEpoch, 2);
  release();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await f.state.read((sql) => worker.find(sql, f.projectId, [a, b])), sealed);
});
test('admission absence, capacity and budgets wait visibly without consuming attempts', async (t) => {
  const f = await fixture(t);
  const { a, b } = f.commits;
  await f.state.transaction((tx) => f.bases.ensure(tx, f.projectId, [a, b]));
  const absent = f.worker(false);
  await absent.initialize();
  await absent.work(f.projectId);
  let base = (await f.state.read((sql) => f.bases.find(sql, f.projectId, [a, b])))!;
  assert.equal(base.blocker, 'sessions_unavailable');
  assert.equal(base.attempts, 0);
  const other = {
    provider: 'other',
    operationId: 'held',
    executionEpoch: 1,
    projectId: f.projectId,
    sponsors: ['root-a'],
    deadline: new Date(f.clock() + 100_000).toISOString(),
  };
  await f.state.transaction((tx) => f.sessions.serviceWork.admit(tx, other));
  f.advance(6000);
  await f.bases.work(f.projectId);
  base = (await f.state.read((sql) => f.bases.find(sql, f.projectId, [a, b])))!;
  assert.equal(base.blocker, 'capacity_full');
  assert.equal(base.attempts, 0);
  f.advance(60_000);
  await f.state.transaction((tx) => f.sessions.serviceWork.settle(tx, other, 'completed'));
  await f.sessions.setBudget(f.admin, { maxWallMinutes: 1 });
  await f.bases.work(f.projectId);
  base = (await f.state.read((sql) => f.bases.find(sql, f.projectId, [a, b])))!;
  assert.equal(base.blocker, 'budget_exceeded');
  assert.equal(base.attempts, 0);
  await f.sessions.setBudget(f.admin, { maxWallMinutes: null });
  f.advance(6000);
  await f.bases.work(f.projectId);
  assert.equal(
    (await f.state.read((sql) => f.bases.find(sql, f.projectId, [a, b])))!.state,
    'resolved',
  );
});
test('five infrastructure failures block one retained record and an idempotent operator retry revives it', async (t) => {
  const f = await fixture(t);
  const { a, b } = f.commits;
  const base = await f.state.transaction((tx) => f.bases.ensure(tx, f.projectId, [a, b]));
  const git = f.repositories.git.run.bind(f.repositories.git);
  const mock = t.mock.method(f.repositories.git, 'run', async () => {
    throw new Error('disk unavailable');
  });
  for (let i = 0; i < 5; i++) {
    await f.bases.work(f.projectId);
    f.advance(100_000);
  }
  const blocked = (await f.state.read((sql) => f.bases.find(sql, f.projectId, [a, b])))!;
  assert.equal(blocked.state, 'blocked_infra');
  assert.equal(blocked.attempts, 5);
  assert.match(blocked.blocker!, /disk unavailable/);
  await f.bases.work(f.projectId);
  assert.equal(mock.mock.callCount(), 5);
  await f.bases.control(f.scope, f.admin, {
    key: base.key,
    action: 'suspend',
    reason: 'Investigating',
    requestId: 'suspend',
  });
  const resumed = await f.bases.control(f.scope, f.admin, {
    key: base.key,
    action: 'resume',
    reason: 'Investigation complete',
    requestId: 'resume',
  });
  assert.equal(
    resumed.state,
    'blocked_infra',
    'resume cannot bypass the exhausted infrastructure allowance',
  );
  assert.equal(resumed.attempts, 5);
  const input = { key: base.key, action: 'retry', reason: 'Disk repaired', requestId: 'retry' };
  const receipt = await f.bases.control(f.scope, f.admin, input);
  assert.equal(receipt.attempts, 0);
  assert.equal(receipt.state, 'queued');
  assert.deepEqual(await f.bases.control(f.scope, f.admin, input), receipt);
  await assert.rejects(f.bases.control(f.scope, f.admin, { ...input, reason: 'Changed' }), {
    code: 'request_conflict',
  });
  t.mock.method(f.repositories.git, 'run', git);
  await f.bases.work(f.projectId);
  assert.equal(
    (await f.state.read((sql) => f.bases.find(sql, f.projectId, [a, b])))!.state,
    'resolved',
  );
  const count = await f.state.read((sql) =>
    sql.get<{ n: number }>("SELECT COUNT(*) AS n FROM code_operations WHERE kind='base-control'"),
  );
  assert.equal(count!.n, 3);
});

test('a base ref an interrupted execution left behind stops the base until an operator drops it', async (t) => {
  const f = await fixture(t);
  const { a, b, c } = f.commits;
  const base = await f.state.transaction((tx) => f.bases.ensure(tx, f.projectId, [a, b]));
  // An execution can write the ref and then lose its epoch to a deadline or an operator,
  // which leaves the ref behind with no result sealed. Under an engine that merges
  // differently the next attempt then computes another commit and can never settle.
  await f.repositories.git.ok(['update-ref', `refs/merv/bases/${base.key}`, c, ''], {
    env: f.repositories.environment(f.projectId),
  });
  await f.bases.work(f.projectId);
  const stuck = (await f.state.read((sql) => f.bases.find(sql, f.projectId, [a, b])))!;
  assert.equal(stuck.blocker, 'A base ref names another commit');
  assert.equal(stuck.result, null);
  // Retrying recomputes the same commit and meets the same ref, however often it is asked.
  await f.bases.control(f.scope, f.admin, {
    key: base.key,
    action: 'retry',
    reason: 'Try the merge again',
    requestId: 'retry',
  });
  await f.bases.work(f.projectId);
  assert.equal((await f.state.read((sql) => f.bases.find(sql, f.projectId, [a, b])))!.result, null);

  const repaired = await f.bases.control(f.scope, f.admin, {
    key: base.key,
    action: 'repair',
    reason: 'The ref is from an execution that lost its epoch',
    requestId: 'repair',
  });
  assert.equal(repaired.state, 'queued');
  await f.bases.work(f.projectId);
  const settled = (await f.state.read((sql) => f.bases.find(sql, f.projectId, [a, b])))!;
  assert.equal(settled.state, 'resolved');
  assert.deepEqual(f.parents(settled.result!.commit).sort(), [a, b].sort());
  const receipt = await f.state.read((sql) =>
    sql.get<{ payload_json: string }>(
      "SELECT payload_json FROM code_operations WHERE project_id=? AND request_id='repair'",
      f.projectId,
    ),
  );
  assert.equal((JSON.parse(receipt!.payload_json) as { discarded: string }).discarded, c);
  // A settled base is what everything pinned to it names, so its ref is never dropped.
  await assert.rejects(
    f.bases.control(f.scope, f.admin, {
      key: base.key,
      action: 'repair',
      reason: 'Drop the settled ref',
      requestId: 'late',
    }),
    { code: 'code_base_changed' },
  );

  // The ref is dropped before the transaction that records the repair, so a base that
  // transaction would refuse has to be refused first; otherwise the refusal still
  // destroys the ref and writes no receipt to retry against.
  const cancelled = await f.state.transaction((tx) =>
    f.bases.ensure(tx, f.projectId, [c, f.commits.d]),
  );
  const ref = `refs/merv/bases/${cancelled.key}`;
  await f.repositories.git.ok(['update-ref', ref, c, ''], {
    env: f.repositories.environment(f.projectId),
  });
  await f.bases.control(f.scope, f.admin, {
    key: cancelled.key,
    action: 'cancel',
    reason: 'This base is no longer wanted',
    requestId: 'cancel',
  });
  await assert.rejects(
    f.bases.control(f.scope, f.admin, {
      key: cancelled.key,
      action: 'repair',
      reason: 'Drop the ref of a cancelled base',
      requestId: 'repair-cancelled',
    }),
    { code: 'code_base_changed' },
  );
  const held = await f.repositories.git.run(['rev-parse', '--verify', ref], {
    env: f.repositories.environment(f.projectId),
  });
  assert.equal(held.stdout.toString('utf8').trim(), c);
});

test('a base planned with another merge engine is not merged again under this one', async (t) => {
  const f = await fixture(t);
  const { c, d } = f.commits;
  const planned = members([c, d]);
  const at = new Date(f.clock()).toISOString();
  await f.state.transaction((tx) =>
    tx.run(
      "INSERT INTO code_bases (project_id,base_key,members_json,left_key,right_key,engine,state,created_at,updated_at,sponsors_json) VALUES (?,?,?,?,?,'merge-tree@0','queued',?,?,'[]')",
      f.projectId,
      baseKey(planned),
      JSON.stringify(planned),
      baseKey([planned[0]!]),
      baseKey([planned[1]!]),
      at,
      at,
    ),
  );
  await f.bases.work(f.projectId);
  const held = (await f.state.read((sql) => f.bases.find(sql, f.projectId, [c, d])))!;
  assert.equal(held.state, 'blocked_infra');
  assert.match(held.blocker!, /merge-tree@0/);
  assert.equal(held.result, null);
});
