import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { finished } from 'node:stream/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import type { IssuedUserKey, Project, Task } from '@merv/contracts';
import type { Session, SessionsProjectStatus } from '@merv/sessions/types';
import { createApp } from '../src/app.js';
import type { ApplicationConfig } from '../src/config.js';
import { useRunSchema } from './database.js';
import { startProtocolProxy } from './protocol-proxy.js';

// Explicit real-model acceptance run, separate from deterministic tests. No real project data.
const runDirectory = resolve(
  process.argv.slice(2).find((arg) => arg !== '--automatic') ?? `live-runs/sessions-${Date.now()}`,
);
const schema = useRunSchema(runDirectory);
const automatic = process.argv.includes('--automatic');
mkdirSync(runDirectory, { recursive: false, mode: 0o700 });
const workspace = join(runDirectory, 'agent-workspace');
mkdirSync(workspace, { mode: 0o700 });
const secretEnv = 'MERV_LIVE_SESSIONS_IDENTITY_SECRET';
const previousSecret = process.env[secretEnv];
process.env[secretEnv] = randomBytes(48).toString('base64url');
const config = JSON.parse(
  readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
) as ApplicationConfig;
config.plugins = config.plugins.filter((entry) => entry.id !== 'ui' && !entry.id.endsWith('-ui'));
config.plugins.find((entry) => entry.id === 'identity')!.config = {
  supabaseUrl: 'https://live-sessions.example.test',
  mode: 'hs256',
  secretEnv,
};
const open = () => createApp({ directory: join(runDirectory, 'data'), config, port: 0 });
let app: Awaited<ReturnType<typeof createApp>> | undefined;
const phases: {
  phase: string;
  threadId: string;
  exitCode: number;
  calls: { tool: string; status: string; failed: boolean }[];
  protocol: unknown;
}[] = [];

async function agent(phase: 'producer' | 'reviewer', token: string, session: Session) {
  assert.ok(app);
  const proxy = await startProtocolProxy(app.ctx.api.url!);
  const output = createWriteStream(join(runDirectory, `${phase}.jsonl`), { mode: 0o600 });
  const errors = createWriteStream(join(runDirectory, `${phase}.stderr.log`), { mode: 0o600 });
  const names = session.execution.policy.tools.map((tool) => tool.name);
  const childEnv: NodeJS.ProcessEnv = { MERV_TEST_TOKEN: token };
  for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'CODEX_HOME'])
    if (process.env[key] !== undefined) childEnv[key] = process.env[key];
  const args = [
    'exec',
    '--ignore-user-config',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--json',
    '--color',
    'never',
    '-C',
    workspace,
    '-c',
    'approval_policy="never"',
    '-c',
    'features.apps=false',
    '-c',
    'features.shell_tool=false',
    '-c',
    `mcp_servers.merv_typescript.url=${JSON.stringify(proxy.url + '/mcp')}`,
    '-c',
    'mcp_servers.merv_typescript.bearer_token_env_var="MERV_TEST_TOKEN"',
    '-c',
    'mcp_servers.merv_typescript.required=true',
    '-c',
    `mcp_servers.merv_typescript.tools={${names.map((name) => `${JSON.stringify(name)}={approval_mode="approve"}`).join(',')}}`,
    '-o',
    join(runDirectory, `${phase}.final.txt`),
    '-',
  ];
  const child = spawn(process.env.MERV_CODEX_BIN ?? 'codex', args, {
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  console.log(JSON.stringify({ phase, status: 'started', pid: child.pid }));
  let buffer = '',
    threadId = '';
  const calls: { tool: string; status: string; failed: boolean }[] = [];
  child.stdout.on('data', (chunk) => {
    output.write(chunk);
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const event = JSON.parse(line);
        if (event.type === 'thread.started') threadId = event.thread_id;
        if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call') {
          const item = event.item;
          calls.push({
            tool: item.tool,
            status: item.status,
            failed: !!item.error || item.result?.isError === true,
          });
          console.log(JSON.stringify({ phase, ...calls.at(-1) }));
        }
      } catch {
        /* Retain complete raw output without guessing malformed events. */
      }
    }
  });
  child.stderr.pipe(errors);
  const work =
    phase === 'producer'
      ? 'Create an immutable Markdown evidence artifact that independently demonstrates each acceptance check. Read it back. Build task.context. Submit task.submit_delivery with a separate met confirmation, evidence ID, and specific verification notes for each check.'
      : 'Use review.start to inspect your already-reserved claim, review.get and artifact.read to inspect every pinned evidence artifact, and task.context for your assignment. Independently calculate each result. Submit review.submit with pass only if every criterion is verified, with one finding per criterion and a concise evidence-based synopsis.';
  child.stdin.end(
    `You are a fresh ${phase} agent testing a synthetic workflow using ONLY the merv_typescript MCP tools. Your session is already assigned to task ${session.instanceId}, revision ${session.expectedRevision}. Do not use shell, files, external tools, or inspect server internals. Start with workflow.status_and_next and workflow.assignment for that task, then task.get. The server restricts your tools and binds task, revision and claim arguments automatically; use the assignment's IDs when a schema requires them. ${work} After the successful handoff, stop calling tools: this lease ends when the workflow revision changes. End with a concise report of what you actually verified. This task contains no real customer/project data.`,
  );
  const timeout = setTimeout(() => child.kill('SIGTERM'), 600_000);
  let exitCode = -1;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? -1));
    });
  } finally {
    clearTimeout(timeout);
    output.end();
    errors.end();
    await Promise.all([finished(output), finished(errors)]);
    await proxy.close();
  }
  phases.push({ phase, threadId, exitCode, calls, protocol: proxy.observations });
  writeFileSync(join(runDirectory, 'phases.json'), JSON.stringify(phases, null, 2) + '\n', {
    mode: 0o600,
  });
  assert.equal(exitCode, 0, `${phase} process failed`);
  assert.ok(threadId, 'Expected a fresh agent context');
  const required = [
    'workflow.status_and_next',
    'workflow.assignment',
    'task.get',
    'task.context',
    'artifact.read',
    ...(phase === 'producer'
      ? ['artifact.create', 'task.submit_delivery']
      : ['review.start', 'review.get', 'review.submit']),
  ];
  for (const name of required)
    assert.ok(
      calls.some((call) => call.tool === name && call.status === 'completed' && !call.failed),
      `Missing successful ${phase} ${name}`,
    );
}

try {
  app = await open();
  const human = await new SignJWT({ role: 'authenticated', is_anonymous: false })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('https://live-sessions.example.test/auth/v1')
    .setSubject('synthetic-shared-owner')
    .setAudience('authenticated')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env[secretEnv]!));
  async function post<T>(
    path: string,
    bearer: string,
    body: unknown,
    projectId?: string,
    method = 'POST',
  ): Promise<T> {
    const response = await fetch(`${app!.ctx.api.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        ...(projectId ? { 'x-merv-project-id': projectId } : {}),
      },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result as T;
  }
  const { project } = await post<{ project: Project }>('/projects', human, {
    name: 'Synthetic leased-agent acceptance',
    requestId: 'project',
  });
  const key = await post<IssuedUserKey>('/account/keys', human, {
    projectId: project.id,
    label: 'Same source for independent leased workers',
  });
  const source = async () =>
    await app!.ctx.scope.caller(
      { kind: 'key', key: await app!.ctx.scope.authenticateKey(key.token) },
      project.id,
    );
  const { result: task } = await post<{ result: Task }>(
    '/tools/task.create',
    key.token,
    {
      title: 'Verify small arithmetic independently',
      goal: 'Produce and independently review reproducible evidence for two arithmetic results.',
      checks: ['Show that adding 2 and 3 gives 5.', 'Show that multiplying 6 by 7 gives 42.'],
      requestId: 'task',
    },
    project.id,
  );
  const offered: Session[] = [];
  const dispatchChecks: string[] = [];
  const runnerId = automatic ? 'live-dispatch' : 'live-sessions';
  const platform = { name: 'acceptance-codex', harness: 'codex' as const };
  if (automatic) {
    const disabled = await post<{ session: Session | null; reason: string }>(
      '/sessions/lease',
      key.token,
      {
        runnerId,
        requestId: 'default-disabled',
        secret: `ms_${randomBytes(32).toString('base64url')}`,
        platform,
      },
      project.id,
    );
    assert.equal(disabled.session, null);
    assert.equal(disabled.reason, 'dispatch_disabled');
    assert.equal((await app.ctx.sessions.list(await source())).length, 0);
    dispatchChecks.push('Automatic dispatch starts disabled and creates no lease');
  }
  for (const phase of ['producer', 'reviewer'] as const) {
    const current: Task = await app.ctx.tasks.get(await source(), task.id);
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    if (automatic) {
      await post(
        '/sessions/runners/heartbeat',
        key.token,
        {
          runnerId,
          machine: {
            hostname: 'synthetic-acceptance',
            system: process.platform,
            architecture: process.arch,
          },
          platforms: [{ ...platform, enabled: true, parallelism: 1 }],
          capacity: 1,
        },
        project.id,
      );
      await post('/sessions/dispatch', human, { enabled: true }, project.id, 'PUT');
    }
    const input = {
      ...(automatic
        ? { platform }
        : { instanceId: task.id, expectedRevision: current.workflow.revision }),
      runnerId,
      requestId: phase,
      secret,
    };
    const { session } = await post<{ session: Session | null }>(
      automatic ? '/sessions/lease' : '/sessions/offer',
      key.token,
      input,
      project.id,
    );
    assert.ok(session);
    assert.equal(session.status, 'offered');
    assert.equal(session.instanceId, task.id);
    assert.equal(session.expectedRevision, current.workflow.revision);
    if (automatic) {
      const retry = await post<{ session: Session | null }>(
        '/sessions/lease',
        key.token,
        input,
        project.id,
      );
      assert.equal(retry.session?.id, session.id);
      await post('/sessions/dispatch', human, { enabled: false }, project.id, 'PUT');
      assert.equal((await app.ctx.sessions.get(await source(), session.id)).status, 'offered');
      dispatchChecks.push(
        `${phase}: server selected the revision, retry retained one lease, pause preserved it`,
      );
    }
    offered.push(session);
    await app.stop();
    app = await open();
    await agent(phase, secret, session);
    if (automatic)
      assert.equal((await app.ctx.sessions.projectStatus(await source())).dispatch.enabled, false);
    assert.equal(
      (await app.ctx.tasks.get(await source(), task.id)).workflow.state,
      phase === 'producer' ? 'in_review' : 'done',
    );
  }
  await app.ctx.sessions.sweep();
  await app.ctx.domainEvents.drain();
  const finalTask = await app.ctx.tasks.get(await source(), task.id);
  const review = await app.ctx.reviews.get(await source(), finalTask.reviewId!);
  assert.equal(review.producerId, offered[0].actorId);
  assert.equal(review.reviewerId, offered[1].actorId);
  assert.notEqual(review.producerId, review.reviewerId);
  assert.deepEqual(offered[0].source, offered[1].source);
  const starts = await app.ctx.workflows.workStarts(await source(), task.id);
  assert.equal(starts.length, 2);
  let projectStatus: SessionsProjectStatus | undefined;
  if (automatic) {
    const response = await fetch(`${app.ctx.api.url}/sessions/status`, {
      headers: { authorization: `Bearer ${human}`, 'x-merv-project-id': project.id },
    });
    assert.equal(response.status, 200);
    projectStatus = (await response.json()) as SessionsProjectStatus;
    assert.equal(projectStatus.dispatch.enabled, false);
    assert.equal(projectStatus.sessions.length, 2);
    assert.equal(projectStatus.queueTotal, 0);
    dispatchChecks.push(
      'Human operator can inspect machine-key jobs; done task is absent from the queue',
    );
  }
  const report = {
    passed: true,
    schema,
    automatic,
    dispatchChecks,
    ...(projectStatus ? { projectStatus } : {}),
    restarts: 2,
    sourceKeyId: key.key.id,
    task: finalTask,
    review,
    starts,
    sessions: await app.ctx.sessions.list(await source()),
    phases,
  };
  const serialized = JSON.stringify(report, null, 2);
  assert.ok(
    !serialized.includes(key.token) && !serialized.includes(human),
    'Do not retain source bearer credentials in report',
  );
  writeFileSync(join(runDirectory, 'report.json'), serialized + '\n', { mode: 0o600 });
  console.log(
    JSON.stringify({
      passed: true,
      state: finalTask.workflow.state,
      agents: phases.length,
      calls: phases.reduce((sum, phase) => sum + phase.calls.length, 0),
      report: join(runDirectory, 'report.json'),
    }),
  );
} finally {
  await app?.stop();
  if (previousSecret === undefined) delete process.env[secretEnv];
  else process.env[secretEnv] = previousSecret;
}
