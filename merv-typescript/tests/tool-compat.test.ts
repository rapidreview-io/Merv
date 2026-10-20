/**
 * Every name the noun tools retire keeps executing, compared with the contract captured before
 * any rename (tests/fixtures/tool-contracts.json, from origin/main 5e4f210a5 on a seeded project):
 * called by a person's agent over MCP, by a page over POST /tools, by a leased worker under a
 * published policy (whose listing is name for name the base one), and by a Pi turn frozen before
 * the release. Results are compared with the captured shapes, never with the noun actions.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Context } from 'cordis';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Caller } from '@merv/contracts';
import { taskToolsPlugin } from '../packages/tasks/src/tools.js';
import { codeToolsPlugin } from '../packages/code-work/src/tools.js';
import { httpApp } from './fixtures/app.js';
import { waitForManagedCode } from './fixtures/managed-code.js';
import { fixture as piFixture } from './fixtures/pi.js';

interface Outcome {
  ok?: unknown;
  status?: number;
  error?: string;
}
interface Contract {
  input: Record<string, unknown>;
  owner: Outcome;
  reader: Outcome;
}
const captured = JSON.parse(
  readFileSync(new URL('./fixtures/tool-contracts.json', import.meta.url), 'utf8'),
) as {
  listings: { mcp: string[]; worker: string[]; page: string[] };
  contracts: Record<string, Contract>;
};

/** The names each noun retired, by the commit that retired them. */
const retired = {
  code: [
    'code.files',
    'code.log',
    'code.status',
    'code.unit.get',
    'code.operation',
    ...['retry', 'suspend', 'resume', 'cancel', 'quarantine', 'release', 'repair'].map(
      (action) => `code.base.${action}`,
    ),
    'code.unit.fence',
    'code.mirror.retry',
    'code.repository.import',
    'code.repository.configure',
    'code.repository.prepare',
    'code.publication.sync',
    'code.publication.merge',
    'code.publication.control',
  ],
  experiment: [
    'experiment.list',
    'experiment.get_state',
    'experiment.exhibit',
    'experiment.create',
    'experiment.attach',
    'experiment.transition',
  ],
  board: ['board.look', 'board.draw'],
  paper: ['paper.patch', 'paper.cite'],
  artifact: [
    'artifact.create',
    'artifact.get',
    'artifact.list',
    'artifact.storage_status',
    'artifact.upload_begin',
    'artifact.upload_resume',
    'artifact.upload_complete',
  ],
  task: ['task.list', 'task.get', 'task.create', 'task.mark_failed'],
  review: ['review.list', 'review.get', 'review.start', 'review.submit', 'review.release'],
  research: ['list', 'get', 'lineage', 'create', 'replan', 'advance', 'end'].map(
    (action) => `research.${action}`,
  ),
  reflection: ['list', 'get', 'lens', 'create', 'end'].map((action) => `reflection.${action}`),
};
/** Names a noun kept, which still take their old flat input (`name#case` for a second one). */
const kept = ['board.read', 'board.read#get'];
const all = Object.values(retired).flat();
/** Retired with no executable path: they answer tool_renamed. */
const removed = ['code.local.bind', 'code.repository.rebind'];
const nouns = [
  'code.read',
  'code.write',
  'experiment.read',
  'experiment.write',
  'board.write',
  'paper.write',
  'artifact.write',
  'task.read',
  'task.write',
  'review.read',
  'review.write',
  'research.read',
  'research.write',
  'reflection.read',
  'reflection.write',
  'report.read',
];

/** A result's key shape, as the contract was captured. */
const shape = (value: unknown): unknown =>
  Array.isArray(value)
    ? { array: value.length ? shape(value[0]) : 'empty' }
    : value && typeof value === 'object'
      ? Object.keys(value).sort()
      : typeof value;

test('every retired name answers as it did, over MCP, from a page and to a leased worker', async (t) => {
  const { app, tool } = await httpApp(t, 'merv-tool-compat-');
  const boot = await app.ctx.scope.credentials.bootstrap({ projectName: 'C', actorName: 'Owner' });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  await waitForManagedCode(app.ctx.codeWork, owner);
  const reader = await app.ctx.scope.credentials.issueActor(owner, { name: 'R', role: 'reader' });
  const created = await tool('experiment.create', boot.token, {
    name: 'Capture',
    intent: 'Capture the contracts.',
    requestId: 'create',
  });
  const experiment = created.body.result;
  const drawn = await tool('board.write:draw', boot.token, { title: 'Seed', ops: [] });
  const seed = await app.ctx.artifacts.create(owner, { title: 'Seed', content: 'seed' });
  const task = (
    await tool('task.create', boot.token, {
      title: 'Setup',
      goal: 'Set up.',
      checks: ['Set.'],
      requestId: 'setup',
    })
  ).body.result;
  const input = (name: string) =>
    JSON.parse(
      JSON.stringify(captured.contracts[name]!.input)
        .replaceAll('$experiment', experiment.id)
        .replaceAll('$board', drawn.body.result.board.id)
        .replaceAll('$artifact', seed.id)
        .replaceAll('$task', task.id),
    ) as Record<string, unknown>;
  const page = async (name: string, token: string, body = input(name)): Promise<Outcome> => {
    const { status, body: answer } = await tool(name.split('#')[0]!, token, body);
    return status === 200 ? { ok: shape(answer.result) } : { status, error: answer.error?.code };
  };
  const client = new Client({ name: 'compat', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${app.ctx.api.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${boot.token}` } },
    }),
  );
  t.after(() => client.close());
  const mcp = async (name: string, args = input(name)) => {
    const result = await client.callTool({ name: name.split('#')[0]!, arguments: args });
    const [first, ...rest] = result.content as { type: string; text: string }[];
    const value = JSON.parse(first!.text);
    // A look's image comes as an image beside its text, as it always did.
    if (rest.some((part) => part.type === 'image')) value.image = true;
    return result.isError ? { error: value.error.code as string } : { ok: shape(value) };
  };

  for (const name of [...all, ...kept]) {
    const contract = captured.contracts[name]!;
    assert.deepEqual(await page(name, boot.token), contract.owner, `${name} from a page`);
    assert.deepEqual(await page(name, reader.token), contract.reader, `${name} for a reader`);
    const agent = await mcp(name);
    assert.deepEqual(
      agent,
      contract.owner.ok === undefined ? { error: contract.owner.error } : { ok: contract.owner.ok },
      `${name} over MCP`,
    );
  }
  // A kept flat name reads its old flat input as the action it routes to.
  assert.deepEqual(
    (await tool('artifact.read', boot.token, { artifactId: seed.id })).body,
    (await tool('artifact.read:content', boot.token, { artifactId: seed.id })).body,
  );
  for (const name of removed) {
    const refused = await tool(name, boot.token, input(name));
    assert.deepEqual([refused.status, refused.body.error.code], [404, 'tool_renamed'], name);
    assert.equal(refused.body.error.details.tool, 'code.write');
  }

  // One request through the old name and then the noun form replays one result; a different
  // body under the same request is still a conflict.
  const configure = input('code.repository.configure');
  const first = await tool('code.repository.configure', boot.token, configure);
  const again = await tool('code.write', boot.token, {
    action: 'repository_configure',
    repository_configure: configure,
  });
  assert.deepEqual(again.body.result, first.body.result);
  const changed = await tool('code.write:repository_configure', boot.token, {
    ...configure,
    denyGlobs: ['secrets/**'],
  });
  assert.equal(changed.body.error.code, 'request_conflict');

  // A task's guidance names the noun for the owner; mark_failed runs alike in both forms.
  const read = await tool('task.read', boot.token, { action: 'get', get: { taskId: task.id } });
  const marking = read.body.result.guidance.actions.find(
    (action: { action: string }) => action.action === 'mark_failed',
  );
  assert.deepEqual([marking.tool, marking.arguments.action], ['task.write', 'mark_failed']);
  const fail = {
    taskId: task.id,
    expectedRevision: read.body.result.workflow.revision,
    reason: 'Parity',
    requestId: 'parity',
  };
  const failed = await tool('task.write', boot.token, { action: 'mark_failed', mark_failed: fail });
  assert.equal(failed.status, 200);
  assert.deepEqual(
    (await tool('task.mark_failed', boot.token, fail)).body.result,
    failed.body.result,
  );

  // A domain's own verdict field travels inside submit; beside it, the noun refuses it.
  const verdict = input('review.submit');
  const beside = await tool('review.write', boot.token, {
    action: 'submit',
    submit: verdict,
    paperChanges: { documents: [] },
  });
  assert.deepEqual([beside.status, beside.body.error.code], [400, 'invalid_input']);
  const inside = await tool('review.write', boot.token, {
    action: 'submit',
    submit: { ...verdict, paperChanges: { documents: [] } },
  });
  assert.deepEqual([inside.status, inside.body.error.code], [404, 'not_found']);

  // What an agent is listed: the base listing with the retired names traded for the nouns.
  // The report reads are retired too (their captured calls need a renderer); report.open is
  // a worker's now, which no agent is listed.
  const gone = new Set([...all, ...removed, 'report.check', 'report.review_visual']);
  const traded = (base: string[]) =>
    [...base.filter((name) => !gone.has(name)), ...nouns].sort((a, b) => a.localeCompare(b));
  const listed = (await client.listTools()).tools.map(({ name }) => name);
  assert.deepEqual(
    listed,
    traded(captured.listings.mcp).filter((name) => name !== 'report.open'),
  );
  assert.deepEqual(
    (await app.ctx.tools.describe(owner)).map(({ name }) => name),
    traded(captured.listings.page),
  );

  // A planning worker on the published experiment policy is listed exactly the base names.
  await app.ctx.sessions.dispatch.heartbeatRunner(owner, {
    runnerId: 'runner',
    machine: { hostname: 'fixture', system: 'test', architecture: 'test' },
    platforms: [{ name: 'test', harness: 'codex', enabled: true, parallelism: 4 }],
    capacity: 4,
    capabilities: ['code.v2'],
  });
  const secret = `ms_${randomBytes(32).toString('base64url')}`;
  await app.ctx.sessions.offer(owner, {
    instanceId: experiment.id,
    expectedRevision: experiment.workflow.revision,
    runnerId: 'runner',
    requestId: 'offer',
    secret,
  });
  const worker = await app.ctx.sessions.authenticate(secret);
  assert.deepEqual(
    (await app.ctx.tools.describe(worker, true)).map(({ name }) => name),
    captured.listings.worker,
  );
  // It runs the reads it is listed as they ran, and is shown them as it was.
  const reads = ['code.files', 'code.log', 'code.status', 'code.unit.get', 'code.operation'];
  reads.push(
    'experiment.list',
    'experiment.get_state',
    'experiment.exhibit',
    'board.look',
    'task.list',
    'task.get',
  );
  for (const name of [...reads, 'artifact.get', 'artifact.list', ...kept]) {
    const outcome = await app.ctx.tools.invoke(name.split('#')[0]!, worker, input(name), true).then(
      ({ value }) => ({ ok: shape(value) }),
      (error: { status: number; code: string }) => ({ status: error.status, error: error.code }),
    );
    assert.deepEqual(outcome, captured.contracts[name]!.owner, `${name} by a worker`);
  }
  const shown = new Map(
    (await app.ctx.tools.describe(worker, true)).map((tool) => [tool.name, tool.description]),
  );
  assert.match(shown.get('code.status')!, /^Read retained bases/);
  // A kept flat name is listed to a worker as it was, with its old flat schema; an agent is
  // listed it with actions.
  const schema = async (caller: Caller, of = 'paper.read') =>
    Object.keys(
      (await app.ctx.tools.describe(caller, true)).find(({ name }) => name === of)!.inputSchema
        .properties!,
    );
  assert.deepEqual(
    await schema(worker),
    'kind history outline section revision offset length'.split(' '),
  );
  const order = 'artifactId mode fileName fileNames offset length'.split(' ');
  assert.deepEqual(await schema(worker, 'artifact.read'), order);
  assert.ok((await schema(owner)).includes('action') && !(await schema(owner)).includes('kind'));
  // A false flag, as models send one, is the flag left out.
  const paper = await app.ctx.tools.invoke('paper.read', worker, { history: false }, true);
  assert.ok('documents' in (paper.value as object));
  const content = await app.ctx.tools.invoke(
    'artifact.read',
    worker,
    { artifactId: seed.id },
    true,
  );
  assert.equal((content.value as { content: string }).content, 'seed');
  assert.match(shown.get('code.unit.get')!, /waits for code\.unit\.fence/);
  // A kept name is shown its old flat input and text.
  assert.match(shown.get('board.read')!, /^Read the project's whiteboards\. Without board/);
  assert.doesNotMatch(JSON.stringify([...shown.values()]), /code\.(read|write) /);
  // A noun read called by name is a read, admitted as given.
  const status = (await app.ctx.tools.invoke('code.read', worker, { action: 'status' }, true))
    .value;
  assert.deepEqual({ ok: shape(status) }, captured.contracts['code.status']!.owner);

  // Each MCP call of the owner's agent was logged as called, with its outcome; the worker's
  // calls and the pages' were not.
  const rows = () =>
    app.ctx.state.read((sql) =>
      sql.all<{
        tool: string;
        action: string | null;
        outcome: string;
        actor_id: string;
        client: string;
      }>(
        'SELECT tool,action,outcome,actor_id,client FROM agent_tool_calls WHERE project_id=?',
        boot.project.id,
      ),
    );
  for (let tries = 0; (await rows()).length < retired.code.length && tries < 40; tries++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  const logged = await rows();
  assert.ok(logged.every((row) => row.actor_id === owner.actorId));
  // The client as its initialize named it, not as its user agent does.
  assert.ok(logged.every((row) => row.client === 'compat'));
  assert.deepEqual(
    logged
      .filter((row) => row.tool.startsWith('code.'))
      .map((row) => row.tool)
      .sort(),
    [...retired.code].sort(),
  );
  assert.deepEqual(
    logged.find((row) => row.tool === 'code.files'),
    {
      tool: 'code.files',
      action: 'files',
      outcome: 'succeeded',
      actor_id: owner.actorId,
      client: 'compat',
    },
  );
  assert.equal(logged.find((row) => row.tool === 'code.operation')?.outcome, 'failed');
});

test('a Pi turn frozen with a retired name before the release still calls it', async (t) => {
  const f = await piFixture(t);
  const reached: unknown[] = [];
  const codeWork = {
    files: async (_caller: Caller, input: unknown) => {
      reached.push(input);
      return { ref: 'main', commit: 'c'.repeat(40), path: '', kind: 'folder', entries: [] };
    },
  };
  // Before the release: the turn is offered the old flat tool, and its offer is frozen.
  const before = f.tools.register({
    name: 'code.files',
    description: 'Read the code',
    readOnly: true,
    inputSchema: z.object({ ref: z.string().optional(), path: z.string().optional() }).strict(),
    handler: (caller: Caller, input: unknown) => codeWork.files(caller, input),
  });
  const bound = await f.begun(f.operator);
  assert.ok(bound.work.tools.some(({ name }) => name === 'code.files'));
  // The release: the old tool goes, the nouns arrive with it as their retired name.
  await before();
  codeToolsPlugin.apply({
    codeWork,
    tools: f.tools,
    effect: (fn: () => unknown) => fn(),
  } as unknown as Context);
  const call = (name: string, input: object) =>
    f.pi.tool(bound.token, { ...bound.input, name, input });
  const old = await call('code.files', { path: 'src' });
  assert.deepEqual(
    old,
    await f.tools.call('code.read', f.operator, { action: 'files', files: { path: 'src' } }),
  );
  assert.deepEqual(reached, [{ path: 'src' }, { path: 'src' }]);
  // The frozen offer holds only what it held: the noun was not offered in this turn.
  await assert.rejects(call('code.read', { action: 'files' }), { code: 'pi_tool_forbidden' });
  // A new turn is offered the noun, and never the retired name.
  await f.pi.complete(bound.token, f.completion(bound.input));
  const next = (await f.begun(f.operator)).work.tools.map(({ name }) => name);
  assert.ok(next.includes('code.read'));
  assert.ok(!next.includes('code.files'));
});

test('a frozen Pi task.get returns executable task.mark_failed guidance with flat arguments', async (t) => {
  const f = await piFixture(t);
  const args = { taskId: 'task_frozen', expectedRevision: 0 };
  const reached: unknown[] = [];
  const before = ['task.get', 'task.mark_failed'].map((name) =>
    f.tools.register({
      name,
      description: name,
      readOnly: name === 'task.get',
      inputSchema: z
        .object({
          taskId: z.string(),
          expectedRevision: z.number().optional(),
          reason: z.string().optional(),
          requestId: z.string().optional(),
        })
        .strict(),
      handler: () => ({}),
    }),
  );
  const bound = await f.begun(f.operator);
  assert.ok(bound.work.tools.some(({ name }) => name === 'task.mark_failed'));
  await Promise.all([...before, f.removeTaskCreate].map((remove) => remove()));
  taskToolsPlugin.apply({
    tools: f.tools,
    effect: (fn: () => unknown) => fn(),
    tasks: {
      get: async () => ({
        guidance: { nextAction: { tool: 'task.write:mark_failed', arguments: args } },
      }),
      markFailed: async (_caller: Caller, input: unknown) => {
        reached.push(input);
        return { stopped: true };
      },
    },
  } as unknown as Context);
  const call = (name: string, input: object) =>
    f.pi.tool(bound.token, { ...bound.input, name, input });
  const old = (await call('task.get', { taskId: args.taskId })) as any;
  assert.deepEqual(old.guidance.nextAction, { tool: 'task.mark_failed', arguments: args });
  const input = {
    ...old.guidance.nextAction.arguments,
    reason: 'Cannot continue',
    requestId: 'stop',
  };
  assert.deepEqual(await call(old.guidance.nextAction.tool, input), { stopped: true });
  assert.deepEqual(reached, [input]);
  await assert.rejects(call('task.write', { action: 'mark_failed', mark_failed: input }), {
    code: 'pi_tool_forbidden',
  });
  const noun = (await f.tools.call('task.read', f.operator, {
    action: 'get',
    get: { taskId: args.taskId },
  })) as any;
  assert.deepEqual(noun.guidance.nextAction, {
    tool: 'task.write',
    arguments: { action: 'mark_failed', mark_failed: args },
  });
});

test('an operator MCP caller can still open reports by name and legacy task reads keep flat guidance', async (t) => {
  const { app, tool } = await httpApp(t, 'merv-cached-research-');
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Compatibility',
    actorName: 'Owner',
  });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  await waitForManagedCode(app.ctx.codeWork, owner);
  const client = new Client({ name: 'compat', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${app.ctx.api.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${boot.token}` } },
    }),
  );
  t.after(() => client.close());
  const experiment = (
    await tool('experiment.create', boot.token, {
      name: 'Report',
      intent: 'Check the report.',
      requestId: 'experiment',
    })
  ).body.result;
  // The operator's cached report.open still reaches Reports, though MCP no longer lists it.
  const subject = { subjectKind: 'experiment', subjectId: experiment.id };
  const opens: unknown[] = [];
  app.ctx.reports.open = async (caller, input) => {
    assert.equal(caller.actorId, owner.actorId);
    opens.push(input);
    return { reportId: 'compat_report' } as never;
  };
  const opened = await client.callTool({ name: 'report.open', arguments: subject });
  assert.ok(!opened.isError);
  assert.deepEqual(opens, [subject]);
  assert.ok(!(await client.listTools()).tools.some(({ name }) => name === 'report.open'));

  const created = await tool('task.create', boot.token, {
    title: 'Stop',
    goal: 'Check guidance.',
    checks: ['Checked.'],
    requestId: 'task',
  });
  const task = created.body.result;
  const marking = (value: any) =>
    value.guidance.actions.find((step: any) => step.action === 'mark_failed');
  assert.equal(marking(task).tool, 'task.mark_failed');
  const legacy = await tool('task.get', boot.token, { taskId: task.id });
  assert.deepEqual(marking(legacy.body.result).arguments, {
    taskId: task.id,
    expectedRevision: task.workflow.revision,
  });
  const modern = await client.callTool({
    name: 'task.read',
    arguments: { action: 'get', get: { taskId: task.id } },
  });
  assert.ok(!modern.isError);
  const value = JSON.parse((modern.content as { text: string }[])[0]!.text);
  assert.deepEqual(marking(value).arguments, {
    action: 'mark_failed',
    mark_failed: marking(task).arguments,
  });
  assert.equal(marking(value).tool, 'task.write');
});
