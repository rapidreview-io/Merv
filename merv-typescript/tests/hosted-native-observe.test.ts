import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migration } from '../packages/fleet/src/schema.js';
import { twoStepWorkflow } from './fixtures/session-workflow.js';
import { postgresUrl, schemaFor } from './fixtures/state.js';
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

test('observer selects only the running Main environment and refuses ambiguous runtime identity', () => {
  const files: Record<string, string> = {
    '/proc/1/task/1/children': '7 9',
    '/proc/1/cmdline': '/sbin/docker-init\0--\0/bin/sh\0',
    '/proc/7/cmdline':
      'node\0--import\0tsx\0/app/dist/src/cli.js\0serve\0--config\0/tmp/merv-config.json\0',
    '/proc/9/cmdline': 'node\0--input-type=module\0-\0',
    '/proc/7/environ':
      'MERV_DB_URL=runtime-db\0UNRELATED_TOKEN=must-not-appear\0MERV_MODEL_KEY=runtime-key\0',
  };
  const read = (path: string) => {
    assert.ok(path in files);
    return files[path];
  };
  const result = mainEnvironment(read, ['MERV_DB_URL']);
  assert.deepEqual(result, { pid: '7', selected: { MERV_DB_URL: 'runtime-db' } });
  assert.ok(!JSON.stringify(result).includes('must-not-appear'));
  files['/proc/9/cmdline'] = files['/proc/7/cmdline']!;
  assert.throws(() => mainEnvironment(read, ['MERV_DB_URL']), /identify/);
  files['/proc/7/cmdline'] = files['/proc/9/cmdline'] = 'node\0unrelated.js\0';
  assert.throws(() => mainEnvironment(read, ['MERV_DB_URL']), /identify/);
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

test('observer registry SQL matches the published Sandboxes schema without selecting secrets', async (t) => {
  const schema = schemaFor();
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  t.after(() => client.end());
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path="${schema}"`);
  await client.query(
    await readFile(
      new URL(
        '../vendor/merv-sandboxes/typescript/packages/db/migrations/0001_baseline.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const queries: string[] = [];
  const observedClient = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push(sql);
      return client.query(sql, params);
    },
  };
  const report = await readSnapshot(
    observedClient,
    schema,
    { sandboxIds: ['sb_example'], launchIds: ['launch_example'] },
    'sandboxes',
  );
  assert.equal(report.read_only, 'on');
  assert.deepEqual(report.sandboxes, []);
  assert.deepEqual(report.truncated, []);
  assert.ok(
    !queries.join('\n').match(/secret|token|payload_json|endpoint_json|request_json|SELECT \*/),
  );
});

test('preflight separates only retired mirror journals while prepared uploads still block readiness', async (t) => {
  const f = await twoStepWorkflow(t, 'observerretired');
  await f.app.ctx.state.migrate('fleet', [migration]);
  const schema = await f.app.ctx.state.read((sql) =>
    sql.get<{ name: string }>('SELECT current_schema() AS name'),
  );
  // Stop every fixture service and callback before taking the baseline. All subsequent
  // setup and observations use the retained real schema through this direct PG client.
  await f.app.stop();
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  t.after(() => client.end());
  await client.query(`SET search_path="${schema!.name}"`);
  const put = async (id: string, kind: string) =>
    client.query(
      `INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,phase,created_at)
       VALUES($1,$2,'system:observer',$1,$3,'test','{}','prepared',$4,$5)`,
      [
        id,
        f.owner.projectId,
        kind,
        kind === 'upload' ? 'receiving' : 'queued',
        new Date().toISOString(),
      ],
    );
  const input = { projectId: f.owner.projectId };
  const baseline = Number(
    (await readSnapshot(client, schema!.name, input, 'main')).activity.unfinished_code_operations,
  );
  await put('cop_legacy', 'mirror-accepted');
  const legacy = await readSnapshot(client, schema!.name, input, 'main');
  assert.equal(Number(legacy.activity.unfinished_code_operations), baseline);
  assert.equal(legacy.retainedLegacyMirrors.count, '1');
  assert.deepEqual(
    legacy.retainedLegacyMirrors.operations.map((op: { id: string }) => op.id),
    ['cop_legacy'],
  );
  assert.ok(!('retainedLegacyMirrors' in legacy.activity));
  await put('cop_upload', 'upload');
  const pending = await readSnapshot(client, schema!.name, input, 'main');
  assert.equal(
    Number(pending.activity.unfinished_code_operations),
    baseline + 1,
    'actual pending upload remains a blocker',
  );
  assert.equal(pending.retainedLegacyMirrors.count, '1');
  await put('cop_other_mirror', 'mirror-work');
  const other = await readSnapshot(client, schema!.name, input, 'main');
  assert.equal(
    Number(other.activity.unfinished_code_operations),
    baseline + 2,
    'no blanket exclusion of other mirror kinds',
  );
  await client.query(
    `INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,phase,created_at)
    SELECT 'cop_extra_'||n,$1,'system:observer','extra_'||n,'mirror-accepted','test','{}','prepared','queued',$2
    FROM generate_series(1,100) n`,
    [f.owner.projectId, new Date().toISOString()],
  );
  const bounded = await readSnapshot(client, schema!.name, input, 'main');
  assert.equal(bounded.retainedLegacyMirrors.count, '101');
  assert.equal(bounded.retainedLegacyMirrors.operations.length, 100);
  assert.deepEqual(bounded.truncated, ['retainedLegacyMirrors']);
  assert.equal(Number(bounded.activity.unfinished_code_operations), baseline + 2);
  assert.equal(
    (
      await client.query(
        "SELECT count(*) FROM code_operations WHERE kind='mirror-accepted' AND status='prepared'",
      )
    ).rows[0].count,
    '101',
    'observer does not retire historical rows',
  );
});
