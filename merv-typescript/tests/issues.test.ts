import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MervError, sha256Hex, type State } from '@merv/contracts';
import { type IssueReport } from '@merv/contracts/issues';
import { IssueStore } from '@merv/issues';
import { type AlertDigest, type AlertSink } from '@merv/issues/alerts';
import { issueMigrations } from '@merv/issues/schema';

import { readFirst } from '@merv/sessions/common';
import { openState } from './fixtures/state.js';

const MINUTE = 60_000;
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A migrated store on a fresh schema, its clock in the test's hand. */
async function bed(sink?: AlertSink) {
  const state = await openState();
  await state.migrate('issues', issueMigrations);
  const clock = { now: Date.parse('2026-10-27T10:00:30.000Z') };
  const time = () => clock.now;
  const store = new IssueStore(state, sink, time);
  const flush = async () => {
    await settle();
    await store.flush();
  };
  const row = async (id: string) =>
    (await state.read((sql) =>
      sql.get<Record<string, any>>('SELECT * FROM issues WHERE id=?', id),
    ))!;
  const cases = async (id: string) =>
    await state.read((sql) =>
      sql.all<Record<string, any>>(
        'SELECT * FROM issue_occurrences WHERE issue_id=? ORDER BY _merv_rowid',
        id,
      ),
    );
  return { state, store, clock, time, flush, row, cases };
}
const idOf = (r: Pick<IssueReport, 'class' | 'where' | 'code' | 'key'>) =>
  `issue_${sha256Hex(JSON.stringify([r.class, r.where, r.code, r.key ?? null])).slice(0, 32)}`;
const tool: IssueReport = {
  class: 'tool',
  where: 'experiment.write:create',
  code: 'invalid_input',
};
const sink = () => {
  const sent: AlertDigest[] = [];
  const failing = { on: false };
  const own: AlertSink = {
    async send(digest) {
      if (failing.on) throw new Error('down');
      sent.push(digest);
    },
  };
  return { sent, failing, own };
};

test('a fingerprint is one issue; a resolve ends its episode and the next report reopens it', async () => {
  const f = await bed();
  f.store.report({ ...tool, note: `token mk_${'a'.repeat(43)} leaked`, refs: { projectId: 'p1' } });
  await f.flush();
  const id = idOf(tool);
  let row = await f.row(id);
  assert.equal(row.fingerprint, sha256Hex(JSON.stringify(['tool', tool.where, tool.code, null])));
  assert.deepEqual([row.state, row.count, row.reopened, row.level], ['open', 1, 0, 'warn']);
  assert.equal(row.note, 'token [redacted] leaked');
  f.store.resolve(tool);
  f.clock.now += MINUTE;
  f.store.report(tool);
  f.store.resolve(tool);
  await f.flush();
  row = await f.row(id);
  assert.deepEqual(
    [row.state, row.resolved_by, row.count, row.reopened],
    ['resolved', 'owner', 2, 1],
  );
  f.store.report({ ...tool, level: 'notice' });
  await f.flush();
  row = await f.row(id);
  assert.deepEqual([row.state, row.count, row.reopened, row.level], ['open', 3, 2, 'notice']);
  assert.equal(row.opened_at, new Date(f.clock.now).toISOString());
  // The list counts each hour's reports and carries the newest case.
  const read = await f.store.platformIssues();
  const [listed] = read.rows;
  assert.deepEqual([read.open, read.severe, listed!.projects, listed!.visits], [1, 0, ['p1'], 0]);
  assert.deepEqual(listed!.hours, [[new Date(f.clock.now).toISOString().slice(0, 13), 3]]);
  assert.equal(listed!.latest!.at, new Date(f.clock.now).toISOString());
});

test('a report waits for its writer: a rollback drops it and a snapshot attempt does not double it', async () => {
  const f = await bed();
  await f.state.transaction((tx) => tx.run('CREATE TABLE probe (id INTEGER)'));
  await assert.rejects(
    f.state.transaction(async (tx) => {
      await tx.run('INSERT INTO probe VALUES (1)');
      f.store.report({ ...tool, code: 'rolled_back' });
      throw new Error('rollback');
    }),
    /rollback/,
  );
  await readFirst(f.state, async (tx) => {
    await tx.run('INSERT INTO probe VALUES (2)');
    f.store.report(tool);
  });
  await f.flush();
  assert.equal((await f.row(idOf(tool))).count, 1);
  assert.equal(await f.store.platformIssue(idOf({ ...tool, code: 'rolled_back' })), undefined);
});

test('alerts: one digest per five minutes, owed until sent, never for Issues itself, at boot and at stop', async () => {
  const { sent, failing, own } = sink();
  const f = await bed(own);
  const severe = (code: string) => f.store.report({ ...tool, code, level: 'severe' });
  severe('first');
  f.store.report({
    class: 'platform',
    where: 'issues.alert',
    code: 'alert_failed',
    level: 'severe',
  });
  await f.flush();
  await f.store.alertPass();
  assert.deepEqual(
    sent.map((d) => d.issues.map((i) => i.title)),
    [['experiment write create · first']],
  );
  severe('second');
  await f.flush();
  await f.store.alertPass();
  assert.equal(sent.length, 1, 'throttled by the last alert');
  f.clock.now += 5 * MINUTE;
  failing.on = true;
  await f.store.alertPass();
  await f.flush();
  assert.equal(
    (await f.row(idOf({ class: 'platform', where: 'issues.alert', code: 'alert_failed' }))).count,
    2,
  );
  failing.on = false;
  await f.store.alertPass();
  assert.equal(sent.length, 1, 'backing off');
  f.clock.now += MINUTE;
  await f.store.alertPass();
  assert.deepEqual(
    sent.map((d) => d.issues.length),
    [1, 1],
  );
  assert.notEqual((await f.row(idOf({ ...tool, code: 'second' }))).alerted_at, null);
  // A store that stopped before alerting leaves it owed; the next one's boot pass sends it.
  f.clock.now += 5 * MINUTE;
  severe('third');
  await f.flush();
  const next = new IssueStore(f.state, own, f.time);
  await next.alertPass();
  assert.equal(sent.at(-1)!.issues[0]!.title, 'experiment write create · third');
  f.clock.now += 5 * MINUTE;
  next.report({ ...tool, code: 'fourth', level: 'severe' });
  await settle();
  await next.drain();
  assert.equal(sent.at(-1)!.issues[0]!.title, 'experiment write create · fourth');
});

test('a digest sent whose marking fails is not sent again within five minutes', async () => {
  const { sent, own } = sink();
  const f = await bed();
  f.store.report({ ...tool, level: 'severe' });
  await f.flush();
  const stuck = Object.assign(Object.create(f.state) as State, {
    transaction: async () => {
      throw new MervError('state_timeout', 'timed out', 503);
    },
  });
  const store = new IssueStore(stuck, own, f.time);
  await assert.rejects(store.alertPass(), { code: 'state_timeout' });
  f.clock.now += MINUTE / 2;
  await store.alertPass();
  assert.equal(sent.length, 1);
});
