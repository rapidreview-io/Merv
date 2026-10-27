import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256Hex, type State } from '@merv/contracts';
import type { IssueReport, SessionTrace } from '@merv/contracts/issues';
import { IssueStore } from '@merv/issues';
import { slackSink, type AlertDigest, type AlertSink } from '@merv/issues/alerts';
import { issueMigrations } from '@merv/issues/schema';
import { floods, pin, quiet } from '@merv/issues/watch';
import { readFirst } from '@merv/sessions/common';
import { openState } from './fixtures/state.js';

const MINUTE = 60_000;
const settle = () => new Promise((resolve) => setImmediate(resolve));
const constraint = (error: { code?: string; cause?: { sqlstate?: string } }) =>
  error.code === 'state_constraint' && error.cause?.sqlstate === '23514';

/** A migrated store on a fresh schema, its clock in the test's hand. */
async function bed(sinks: AlertSink[] = []) {
  const state = await openState();
  await state.migrate('issues', issueMigrations);
  const clock = { now: Date.parse('2026-10-27T10:00:30.000Z') };
  const time = () => clock.now;
  const store = new IssueStore(state, sinks, time);
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
    name: 'test',
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
  const read = await f.store.platformIssues();
  assert.deepEqual([read.open, read.severe, read.rows[0]!.projects], [1, 0, ['p1']]);
  assert.equal((await f.store.close(id, 'Ada')).resolvedBy, 'Ada');
  await assert.rejects(f.store.close('issue_unknown', 'Ada'), { code: 'not_found' });
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

test('cases are sampled: 20 a flush, all up to 50, then a new subject or one every ten minutes', async () => {
  const f = await bed();
  const id = idOf(tool);
  const report = (...subjects: string[]) =>
    subjects.forEach((subject) => f.store.report({ ...tool, subject }));
  report(...Array.from({ length: 25 }, (_, i) => `s${i}`));
  await f.flush();
  assert.deepEqual([(await f.row(id)).count, (await f.cases(id)).length], [25, 20]);
  report(...Array.from({ length: 20 }, (_, i) => `t${i}`));
  await f.flush();
  report(...Array.from({ length: 10 }, (_, i) => `u${i}`));
  await f.flush();
  assert.equal((await f.row(id)).stored, 50);
  report('u9');
  await f.flush();
  report('fresh');
  await f.flush();
  report('fresh');
  await f.flush();
  assert.equal((await f.cases(id)).length, 51);
  f.clock.now += 10 * MINUTE;
  report('fresh');
  await f.flush();
  const kept = await f.cases(id);
  assert.deepEqual([kept.length, kept.at(-1)!.subject], [52, 'fresh']);
  const detail = (await f.store.platformIssue(id))!;
  assert.deepEqual([detail.cases.length, detail.cases.at(-1)!.subject], [51, 's0']);
});

test('the 15th report of one subject in ten minutes is a loop; standing and subjectless never are', async () => {
  const f = await bed();
  const repeat = (n: number, r: IssueReport) => {
    for (let i = 0; i < n; i++) f.store.report(r);
  };
  repeat(14, { ...tool, subject: 'visit' });
  await f.flush();
  assert.deepEqual(
    [(await f.row(idOf(tool))).loop, (await f.row(idOf(tool))).level],
    [false, 'warn'],
  );
  repeat(1, { ...tool, subject: 'visit' });
  await f.flush();
  const looped = await f.row(idOf(tool));
  assert.deepEqual([looped.loop, looped.level, looped.alerted_at], [true, 'severe', null]);
  const standing = { ...tool, code: 'standing' };
  repeat(20, { ...standing, subject: 'visit', standing: true });
  const bare = { ...tool, code: 'bare' };
  repeat(20, bare);
  await f.flush();
  assert.equal((await f.row(idOf(standing))).loop, false);
  assert.equal((await f.row(idOf(standing))).count, 1);
  assert.deepEqual([(await f.row(idOf(bare))).loop, (await f.row(idOf(bare))).count], [false, 20]);
});

test('ten platform reports in an hour are a spike, which re-arms its alert once an hour', async () => {
  const { sent, own } = sink();
  const f = await bed([own]);
  const platform: IssueReport = {
    class: 'platform',
    where: 'sessions.launch',
    code: 'host_failed',
  };
  const id = idOf(platform);
  const repeat = (n: number) => {
    for (let i = 0; i < n; i++) f.store.report(platform);
  };
  repeat(9);
  await f.flush();
  assert.equal((await f.row(id)).level, 'warn');
  repeat(1);
  await f.flush();
  assert.deepEqual([(await f.row(id)).level, (await f.row(id)).hour_count], ['severe', 10]);
  await f.store.alertPass();
  assert.equal(sent.length, 1);
  repeat(5);
  await f.flush();
  assert.notEqual((await f.row(id)).alerted_at, null);
  f.clock.now += 60 * MINUTE;
  repeat(10);
  await f.flush();
  const row = await f.row(id);
  assert.deepEqual([row.alerted_at, row.peak_hour, row.count], [null, 15, 25]);
});

test('quiet resolution: a standing condition ten minutes after its last report, others short of severe after a day', async () => {
  const f = await bed();
  const standing: IssueReport = {
    class: 'platform',
    where: 'fleet.queued',
    code: 'queued',
    standing: true,
  };
  const severe = { ...tool, code: 'severe', level: 'severe' as const };
  for (const r of [standing, standing, tool, severe]) f.store.report(r);
  await f.flush();
  f.store.report(standing);
  await f.flush();
  assert.equal((await f.row(idOf(standing))).count, 1);
  f.clock.now += 9 * MINUTE;
  await quiet(f.state, f.time);
  assert.equal((await f.row(idOf(standing))).state, 'open');
  f.clock.now += 2 * MINUTE;
  await quiet(f.state, f.time);
  assert.deepEqual(
    [(await f.row(idOf(standing))).state, (await f.row(idOf(standing))).resolved_by],
    ['resolved', 'quiet'],
  );
  assert.equal((await f.row(idOf(tool))).state, 'open');
  f.clock.now += 1440 * MINUTE;
  await quiet(f.state, f.time);
  assert.equal((await f.row(idOf(tool))).state, 'resolved');
  assert.equal((await f.row(idOf(severe))).state, 'open');
});

test('guards keep issues and cases: no delete, no identity change, a trace written once', async () => {
  const f = await bed();
  f.store.report({ ...tool, refs: { sessionId: 'ses_1' } });
  await f.flush();
  const id = idOf(tool);
  const run = (sql: string, ...params: string[]) =>
    f.state.transaction((tx) => tx.run(sql, ...params));
  await assert.rejects(run('DELETE FROM issues WHERE id=?', id), constraint);
  await assert.rejects(run("UPDATE issues SET code='other' WHERE id=?", id), constraint);
  await assert.rejects(run('UPDATE issues SET count=0 WHERE id=?', id), constraint);
  await assert.rejects(run('DELETE FROM issue_occurrences WHERE issue_id=?', id), constraint);
  await assert.rejects(
    run("UPDATE issue_occurrences SET note='x' WHERE issue_id=?", id),
    constraint,
  );
  await run("UPDATE issue_occurrences SET trace_json='{}' WHERE issue_id=?", id);
  await assert.rejects(
    run(`UPDATE issue_occurrences SET trace_json='{"a":1}' WHERE issue_id=?`, id),
    constraint,
  );
});

test('the flood scan counts each window of events once', async () => {
  const f = await bed();
  const scan = await floods(f.state, f.store);
  const emit = (n: number) =>
    f.state.transaction(async (tx) => {
      for (let i = 0; i < n; i++)
        await f.state.appendEvent(tx, {
          projectId: 'p1',
          actorId: 'a',
          type: 'code.main_landed',
          subjectId: 'wf_1',
          data: {},
        });
    });
  await emit(160);
  await scan();
  await scan();
  await f.flush();
  const id = idOf({
    class: 'platform',
    where: 'events',
    code: 'event_flood',
    key: 'code.main_landed wf_1',
  });
  assert.deepEqual([(await f.row(id)).count, (await f.row(id)).loop], [160, true]);
  await emit(160);
  await scan();
  await f.flush();
  const row = await f.row(id);
  assert.deepEqual([row.count, row.level], [320, 'severe']);
  const windows = (await f.cases(id)).map((c) => JSON.parse(c.refs_json).eventIds);
  assert.deepEqual(windows, [
    [1, 160],
    [161, 320],
  ]);
});

test('a case pins its visit once, after the visit ended or a day on', async () => {
  const f = await bed();
  for (const sessionId of ['ses_closed', 'ses_open', 'ses_unknown'])
    f.store.report({ ...tool, subject: sessionId, refs: { sessionId } });
  await f.flush();
  const trace = (closedAt?: string): SessionTrace => ({
    projectId: 'p1',
    threadId: 'thr',
    instanceId: 'wf',
    revision: 1,
    role: 'producer',
    status: closedAt ? 'closed' : 'active',
    createdAt: '2026-10-27T09:00:00.000Z',
    ...(closedAt && { closedAt }),
  });
  let traces = new Map([
    ['ses_closed', trace('2026-10-27T10:00:00.000Z')],
    ['ses_open', trace()],
  ]);
  const pinned = async () =>
    Object.fromEntries((await f.cases(idOf(tool))).map((c) => [c.session_id, c.trace_json]));
  await pin(f.state, async () => traces, f.time);
  assert.deepEqual(Object.values(await pinned()), [null, null, null], 'younger than a minute');
  f.clock.now += 2 * MINUTE;
  await pin(f.state, () => undefined, f.time);
  assert.deepEqual(Object.values(await pinned()), [null, null, null], 'Sessions absent');
  await pin(f.state, async () => traces, f.time);
  let now = await pinned();
  assert.deepEqual(JSON.parse(now.ses_closed), traces.get('ses_closed'));
  assert.deepEqual([now.ses_open, now.ses_unknown], [null, '{}']);
  traces = new Map([
    ['ses_closed', trace('2026-10-27T11:00:00.000Z')],
    ['ses_open', trace()],
  ]);
  f.clock.now += 1440 * MINUTE;
  await pin(f.state, async () => traces, f.time);
  now = await pinned();
  assert.equal(JSON.parse(now.ses_closed).closedAt, '2026-10-27T10:00:00.000Z', 'written once');
  assert.equal(JSON.parse(now.ses_open).status, 'active');
  const cases = (await f.store.platformIssue(idOf(tool)))!.cases;
  assert.deepEqual(
    cases.map((c) => c.trace?.status ?? null),
    [null, 'active', 'closed'],
  );
});

test('alerts: one digest per five minutes, owed until sent, never for Issues itself, at boot and at stop', async () => {
  const { sent, failing, own } = sink();
  const f = await bed([own]);
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
  const next = new IssueStore(f.state, [own], f.time);
  await next.alertPass();
  assert.equal(sent.at(-1)!.issues[0]!.title, 'experiment write create · third');
  f.clock.now += 5 * MINUTE;
  next.report({ ...tool, code: 'fourth', level: 'severe' });
  await settle();
  await next.stop();
  assert.equal(sent.at(-1)!.issues[0]!.title, 'experiment write create · fourth');
});

test('while the database is away, 30 failed flushes with a severe report say so once', async () => {
  const { sent, own } = sink();
  const f = await bed();
  const down = Object.assign(Object.create(f.state) as State, {
    transaction: async () => {
      throw new Error('down');
    },
  });
  const store = new IssueStore(down, [own], f.time);
  store.report({ ...tool, level: 'severe' });
  await settle();
  for (let i = 0; i < 29; i++) await store.flush();
  assert.equal(sent.length, 0);
  await store.flush();
  await store.flush();
  assert.deepEqual(
    sent.map((d) => d.issues[0]!.title),
    ['issues cannot be recorded'],
  );
});

test('the Slack sink posts codes and links, and fails without its webhook or on a refusal', async (t) => {
  const posts: { url: string; body: any }[] = [];
  let status = 200;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    posts.push({ url, body: JSON.parse(String(init.body)) });
    return new Response('ok', { status });
  });
  const slack = slackSink({
    webhookEnv: 'MERV_TEST_ISSUES_SLACK',
    publicOrigin: 'https://merv.test',
  });
  const digest: AlertDigest = {
    at: '2026-10-27T10:05:00.000Z',
    issues: [
      {
        id: 'issue_1',
        title: 'git push · a<b',
        level: 'severe',
        loop: true,
        count: 1880,
        openedAt: '2026-10-27T10:00:00.000Z',
      },
    ],
  };
  delete process.env.MERV_TEST_ISSUES_SLACK;
  await assert.rejects(slack.send(digest), { code: 'slack_unavailable' });
  process.env.MERV_TEST_ISSUES_SLACK = 'https://hooks.slack.test/T/B/x';
  t.after(() => delete process.env.MERV_TEST_ISSUES_SLACK);
  await slack.send(digest);
  assert.equal(posts[0]!.url, 'https://hooks.slack.test/T/B/x');
  assert.equal(posts[0]!.body.text, 'Merv · git push · a<b');
  assert.equal(
    posts[0]!.body.blocks[0].text.text,
    '<https://merv.test/ui/admin/issues?issue=issue_1|git push · a&lt;b> · 1,880 · since 2026-10-27 10:00 UTC',
  );
  status = 500;
  await assert.rejects(slack.send(digest), { code: 'slack_refused' });
});
