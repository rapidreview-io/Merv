import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { z } from 'zod';
import { digest, MervError, type Caller, type Scope, type State } from '@merv/contracts';
import { errorFacts, type IssueReport, type Issues } from '@merv/contracts/issues';
import { ApiServer } from '../packages/api/src/http.js';
import { ToolRegistry } from '../packages/api/src/registry.js';
import { recoverLegacyOperation, seedLegacyOperation } from './fixtures/code-store.js';
import { writerFixture } from './fixtures/code-writers.js';

const exec = promisify(execFile);
const caller: Caller = { actorId: 'alice', projectId: 'project-a' };

/** Captures reports; with a state, as Issues holds them: until their transaction commits. */
function capture(state?: State): Issues & { reports: IssueReport[] } {
  const reports: IssueReport[] = [];
  return {
    reports,
    report: (issue) => (state ? state.afterCommit(() => reports.push(issue)) : reports.push(issue)),
    resolve() {},
  };
}

function registry() {
  const scope = { require: async () => ({}) } as unknown as Scope;
  const tools = new ToolRegistry(scope);
  const issues = (tools.issues = capture());
  const failing = (error: unknown) => () => {
    throw error;
  };
  tools.register({
    name: 'item.write',
    description: 'Writes an item',
    tier: 'core',
    inputSchema: z.object({ id: z.string() }).strict(),
    handler: failing(new MervError('item_conflict', 'Item 7 is taken', 409)),
  });
  const wait = Object.assign(new MervError('state_busy', 'Not yet', 503), { wait: true });
  tools.register({
    name: 'item.wait',
    description: 'Not yet',
    tier: 'core',
    inputSchema: z.object({}).strict(),
    handler: failing(wait),
  });
  tools.register({
    name: 'item.crash',
    description: 'Faults',
    tier: 'core',
    inputSchema: z.object({}).strict(),
    handler: failing(new Error('secret connection string')),
  });
  tools.register({
    name: 'item.mounted',
    description: 'Returns its own failure',
    tier: 'core',
    inputSchema: z.object({}).strict(),
    handler: () => ({}),
    present: () => ({
      isError: true,
      content: [
        { type: 'text', text: JSON.stringify({ error: { code: 'sandbox_quota', status: 402 } }) },
      ],
    }),
  });
  tools.register({
    name: 'item.nested',
    description: 'Calls item.write',
    tier: 'core',
    inputSchema: z.object({}).strict(),
    handler: (caller) => tools.invoke('item.write', caller, { id: 'x' }, true),
  });
  return { tools, issues };
}

test('an agent refusal is a notice keyed by its arguments, and a wait is never reported', async () => {
  const { tools, issues } = registry();
  await assert.rejects(tools.invoke('item.write', caller, { id: 'x' }, true, undefined, 'codex'), {
    code: 'item_conflict',
  });
  await assert.rejects(tools.invoke('item.wait', caller, {}, true), { code: 'state_busy' });
  assert.equal(issues.reports.length, 1);
  const [report] = issues.reports;
  assert.deepEqual(
    { ...report, error: undefined },
    {
      class: 'tool',
      where: 'item.write',
      code: 'item_conflict',
      status: 409,
      level: 'notice',
      subject: `alice:${digest(['item.write', { id: 'x' }]).slice(0, 16)}`,
      refs: {
        projectId: 'project-a',
        actorId: 'alice',
        client: 'codex',
        sessionId: undefined,
        threadId: undefined,
        invocationId: undefined,
        conversationId: undefined,
        commandId: undefined,
        allocationId: undefined,
      },
      error: undefined,
    },
  );
  assert.ok(tools.reported.has(report!.error as object));
});

test('a nested call that fails is reported once, by the innermost call', async () => {
  const { tools, issues } = registry();
  await assert.rejects(tools.invoke('item.nested', caller, {}, true), { code: 'item_conflict' });
  assert.deepEqual(
    issues.reports.map(({ where }) => where),
    ['item.write'],
  );
});

test("a person's refusal is not reported, but a fault is, severe, and the API does not repeat it", async () => {
  const { tools, issues } = registry();
  await assert.rejects(tools.invoke('item.write', caller, { id: 'x' }), { code: 'item_conflict' });
  assert.equal(issues.reports.length, 0);
  await assert.rejects(tools.invoke('item.crash', caller, {}), /secret/);
  assert.deepEqual(
    issues.reports.map(({ code, status, level }) => ({ code, status, level })),
    [{ code: 'internal_error', status: 500, level: 'severe' }],
  );
  assert.ok(!('message' in errorFacts(issues.reports[0]!.error)!));
  const api = new ApiServer({} as Scope, tools);
  const platform = (api.issues = capture());
  const failed = (error: unknown, status: number) =>
    (api as unknown as { failed(...a: unknown[]): void }).failed(error, status, 'x', 'mcp');
  failed(issues.reports[0]!.error, 500);
  assert.deepEqual(platform.reports, []);
  const unseen = new Error('elsewhere');
  failed(unseen, 500);
  assert.deepEqual(
    platform.reports.map(({ class: kind, where, key, status }) => ({ kind, where, key, status })),
    [{ kind: 'platform', where: 'api_error', key: 'mcp', status: 500 }],
  );
  await tools.close();
});

test("a mounted tool's own failure is a notice with its inner code", async () => {
  const { tools, issues } = registry();
  const result = await tools.invoke('item.mounted', caller, {}, true);
  assert.equal(result.mcp?.isError, true);
  assert.deepEqual(
    issues.reports.map(({ where, code, status, level }) => ({ where, code, status, level })),
    [{ where: 'item.mounted', code: 'sandbox_quota', status: 402, level: 'notice' }],
  );
});

test("a leased call's report names its invocation", async () => {
  const { tools, issues } = registry();
  tools.registerSessionPolicy({
    allowsTool: async () => true,
    prepare: async (caller, tool, input) => ({
      caller: { ...caller, session: { ...caller.session!, invocationId: 'inv_1' } },
      tool,
      input,
    }),
    validate: async () => {},
    run: async (prepared, dispatch) => dispatch(prepared.caller, prepared.input),
    cancel: async () => {},
  });
  const leased = { ...caller, session: { id: 'ses_1', threadId: 'thr_1' } };
  await assert.rejects(tools.invoke('item.write', leased, { id: 'x' }), { code: 'item_conflict' });
  const [report] = issues.reports;
  assert.equal(report!.subject, `ses_1:${digest(['item.write', { id: 'x' }]).slice(0, 16)}`);
  assert.deepEqual(
    [report!.refs?.sessionId, report!.refs?.threadId, report!.refs?.invocationId],
    ['ses_1', 'thr_1', 'inv_1'],
  );
});

/** Code with its native Git remote served, and Issues captured as they commit. */
async function code(t: TestContext) {
  const f = await writerFixture(t);
  const issues = capture(f.state);
  f.core.gitRemote.issues = issues;
  const server = createServer((req, res) => {
    void f.core.gitRemote.handle(req, res, new URL(req.url!, 'http://localhost')).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { ...f, issues, server };
}

test('a rejected push is reported by code, without its message', async (t) => {
  const f = await code(t);
  const { token } = await f.scope.credentials.issueActorCredential(f.admin, {
    actorId: f.admin.actorId,
  });
  const next = f.source.commit({ 'b.txt': 'two\n' }, 'second');
  const url = `http://127.0.0.1:${(f.server.address() as { port: number }).port}/git/${f.admin.projectId}.git`;
  await assert.rejects(
    exec('git', ['push', url, `${next}:refs/heads/merv-main`], {
      cwd: f.source.repository,
      env: {
        PATH: process.env.PATH,
        HOME: f.directory,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `http.${url}.extraHeader`,
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`merv:${token}`).toString('base64')}`,
        GIT_TERMINAL_PROMPT: '0',
      },
    }),
    /reserved|rejected/,
  );
  const [report] = f.issues.reports;
  assert.equal(f.issues.reports.length, 1);
  assert.deepEqual(
    { ...report, error: undefined, refs: { ...report!.refs, pushId: undefined } },
    {
      class: 'tool',
      where: 'git.push',
      code: (report!.error as MervError).code,
      level: 'notice',
      subject: f.admin.projectId,
      refs: {
        projectId: f.admin.projectId,
        pushId: undefined,
        sessionId: undefined,
        instanceId: undefined,
      },
      error: undefined,
    },
  );
  assert.match(report!.refs!.pushId!, /^gpush/);
  assert.ok(!JSON.stringify(errorFacts(report!.error)).includes((report!.error as Error).message));
});

test('a quarantined final capture is reported once it commits, and not when it rolls back', async (t) => {
  const f = await code(t);
  await f.lease('ses_1');
  await f.event('session.workspace_attached', 'ses_1');
  const secret = f.source.commit(
    { 'key.pem': '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n' },
    'merv: capture',
  );
  const bundle = f.source.bundle(secret, [f.root]);
  const id = await seedLegacyOperation(f.code, f.admin, bundle, {
    upload: {
      format: 1,
      source: 'upload',
      actorId: f.admin.actorId,
      kind: 'final',
      runnerId: 'runner-1',
      hostRef: 'launch-ses_1',
      sessionId: 'ses_1',
      leaseId: 'ses_1',
      unitId: f.unitId,
      generation: 1,
      commandId: null,
      expectedHead: f.root,
      tip: bundle.tip,
      treeOid: f.source.git('rev-parse', `${bundle.tip}^{tree}`),
      bundle: { sha256: bundle.sha256, bytes: bundle.bytes },
    },
  });
  const append = f.state.appendEvent.bind(f.state);
  const failing = t.mock.method(f.state, 'appendEvent', (async (tx, event) => {
    if (event.type === 'code.capture_quarantined') throw new Error('rolled back');
    return await append(tx, event);
  }) as State['appendEvent']);
  await assert.rejects(recoverLegacyOperation(f.code, id), /rolled back/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.issues.reports, []);
  failing.mock.restore();
  assert.equal((await recoverLegacyOperation(f.code, id)).error, 'code_capture_quarantined');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.issues.reports, [
    {
      class: 'platform',
      where: 'code.capture_quarantined',
      code: 'capture_quarantined',
      key: f.unitId,
      level: 'severe',
      refs: { projectId: f.admin.projectId, instanceId: f.unitId },
    },
  ]);
});
