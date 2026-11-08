import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { migration } from '../packages/fleet/src/schema.js';
import { twoStepWorkflow } from './fixtures/session-workflow.js';
import { postgresUrl } from './fixtures/state.js';
const { mainEnvironment, readSnapshot, remoteProgram, validateInput } = await import(
  new URL('../deploy/hosted-native-observe.mjs', import.meta.url).href
);

test('observer refuses implicit targets and shell/identifier injection before SSH', () => {
  const valid = {
    host: 'ResearchSuite_Control',
    projectId: 'project_example',
    instanceId: 'wf_example',
  };
  assert.deepEqual(validateInput(valid), valid);
  for (const bad of [
    { host: '-ProxyCommand=bad' },
    { host: 'host; env' },
    { projectId: "project_a'" },
    { instanceId: 'x\nSELECT' },
    { projectId: undefined },
  ])
    assert.throws(() => validateInput({ ...valid, ...bad }));
  assert.doesNotThrow(
    () =>
      new Function(`return async () => {${remoteProgram(valid).replace(/^import .*;$/gm, '')}}`),
  );
});

test('observer queries actual Main schema read-only and reads immutable session workspace facts', async (t) => {
  const f = await twoStepWorkflow(t, 'observer');
  await f.app.ctx.state.migrate('fleet', [migration]);
  const unit = await f.start();
  const { session, input } = await f.offer(unit.id);
  await f.sessions.authenticate(input.secret);
  const attachment = {
    headOid: '1'.repeat(40),
    treeOid: '2'.repeat(40),
    submission: {
      sessionId: 'session_producer',
      parentOid: '3'.repeat(40),
      treeOid: '4'.repeat(40),
    },
    credential: 'must-not-appear',
  };
  await f.app.ctx.state.transaction((tx) =>
    tx.run(
      'INSERT INTO session_workspaces(session_id,attachment_json,result_json) VALUES(?,?,?)',
      session.id,
      JSON.stringify(attachment),
      JSON.stringify({ headOid: '5'.repeat(40), credential: 'must-not-appear' }),
    ),
  );
  const schema = await f.app.ctx.state.read((sql) =>
    sql.get<{ name: string }>('SELECT current_schema() AS name'),
  );
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  t.after(() => client.end());
  const queries: string[] = [];
  const observedClient = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push(sql);
      return client.query(sql, params);
    },
  };
  const report = await readSnapshot(
    observedClient,
    schema!.name,
    { projectId: f.owner.projectId, instanceId: unit.id },
    'main',
  );
  assert.equal(report.read_only, 'on');
  assert.equal(report.activity.active_sessions, '1');
  assert.equal(report.sessions[0].thread_id, session.threadId);
  assert.ok(report.sessions[0].activated_at);
  assert.equal(report.sessions[0].attached_head, attachment.headOid);
  assert.equal(report.sessions[0].submission_tree, attachment.submission.treeOid);
  assert.equal(report.sessions[0].result_head, '5'.repeat(40));
  assert.ok(!JSON.stringify(report).includes('must-not-appear'));
  assert.deepEqual(report.truncated, []);
  assert.match(queries[0]!, /READ ONLY$/);
  assert.equal(queries.at(-1), 'ROLLBACK');
  assert.ok(queries.every((sql) => /^(SELECT|SET LOCAL|BEGIN |ROLLBACK)/.test(sql)));
  await assert.rejects(
    readSnapshot(
      client,
      schema!.name,
      { projectId: f.owner.projectId, instanceId: 'wf_wrong_project' },
      'main',
    ),
  );
  assert.equal(
    (await client.query("SELECT current_setting('transaction_read_only') AS value")).rows[0].value,
    'off',
    'failed observation rolled back',
  );
});
