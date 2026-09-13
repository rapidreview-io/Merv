import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { finished } from 'node:stream/promises';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import type { Caller } from '@merv/contracts';
import { verifyLiveEvidence } from './live-evidence.js';

// Real model calls: this is intentionally separate from the deterministic test suite.
const runDirectory = resolve(
  process.argv[2] ?? join('live-runs', new Date().toISOString().replaceAll(':', '-')),
);
mkdirSync(dirname(runDirectory), { recursive: true });
// Never overwrite or mistake a previous attempt's report for this run.
mkdirSync(runDirectory, { mode: 0o700 });
const workingDirectory = join(runDirectory, 'agent-workspace');
mkdirSync(workingDirectory, { recursive: true });
type Phase = 'producer' | 'reviewer' | 'observer';
interface ObservedCall {
  tool: string;
  status: string;
  errorCode?: string;
  transportError?: string;
}
const summary: {
  phase: Phase;
  threadId: string;
  exitCode: number;
  toolCalls: number;
  calls: ObservedCall[];
}[] = [];
const readTools = [
  'actor.whoami',
  'project.get',
  'task.get',
  'task.list',
  'review.get',
  'review.list',
  'artifact.get',
  'artifact.read',
  'artifact.list',
  'workflow.get',
  'workflow.history',
];
const phaseWrites: Record<Phase, string[]> = {
  producer: ['artifact.create', 'task.create', 'task.submit_delivery', 'review.start'],
  reviewer: ['review.start', 'review.submit', 'artifact.create'],
  observer: ['actor.create'],
};

async function codex(phase: Phase, token: string, url: string, prompt: string) {
  const output = createWriteStream(join(runDirectory, `${phase}.jsonl`), { mode: 0o600 });
  const errors = createWriteStream(join(runDirectory, `${phase}.stderr.log`), { mode: 0o600 });
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
    workingDirectory,
    '-c',
    'approval_policy="never"',
    '-c',
    'features.apps=false',
    '-c',
    'features.shell_tool=false',
    '-c',
    `mcp_servers.merv_typescript.url=${JSON.stringify(url + '/mcp')}`,
    '-c',
    'mcp_servers.merv_typescript.bearer_token_env_var="MERV_TEST_TOKEN"',
    '-c',
    'mcp_servers.merv_typescript.required=true',
    '-c',
    `mcp_servers.merv_typescript.enabled_tools=${JSON.stringify([...readTools, ...phaseWrites[phase]])}`,
    // These writes are the expressly requested synthetic acceptance scenario.
    // This per-process policy never changes the user's persistent CLI settings;
    // server-side role checks still reject the negative permission probes.
    '-c',
    `mcp_servers.merv_typescript.tools={${phaseWrites[phase].map((name) => `${JSON.stringify(name)}={approval_mode="approve"}`).join(',')}}`,
    '-o',
    join(runDirectory, `${phase}.final.txt`),
    '-',
  ];
  // Keep account discovery and executable lookup, but do not inherit arbitrary
  // API keys, application secrets, or endpoint overrides from the parent shell.
  const childEnv: NodeJS.ProcessEnv = { MERV_TEST_TOKEN: token };
  for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'CODEX_HOME']) {
    if (process.env[key] !== undefined) childEnv[key] = process.env[key];
  }
  const child = spawn(process.env.MERV_CODEX_BIN ?? 'codex', args, {
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  console.log(JSON.stringify({ phase, status: 'started', pid: child.pid }));
  let buffer = '',
    threadId = '';
  const calls: ObservedCall[] = [];
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
          let errorCode: string | undefined;
          for (const content of item.result?.content ?? []) {
            if (content.type === 'text')
              try {
                errorCode = JSON.parse(content.text)?.error?.code ?? errorCode;
              } catch {
                /* Text output need not be JSON. */
              }
          }
          calls.push({
            tool: item.tool,
            status: item.status,
            ...(errorCode ? { errorCode } : {}),
            ...(item.error ? { transportError: item.error.message } : {}),
          });
          console.log(JSON.stringify({ phase, ...calls.at(-1) }));
        }
      } catch {
        /* Keep raw output for debugging. */
      }
    }
  });
  child.stderr.pipe(errors);
  child.stdin.end(
    `You are testing the new Merv TypeScript application. Use ONLY the merv_typescript MCP tools to interact with it. Do not inspect the database or server source, do not edit any files, and do not invoke shell commands. Treat tool failures as test observations; report them accurately.\n\n${prompt}\n\nEnd with a concise account of what you actually verified and the task/review IDs.`,
  );
  const timeout = setTimeout(() => child.kill('SIGTERM'), 600_000);
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? -1));
  }).finally(async () => {
    clearTimeout(timeout);
    output.end();
    errors.end();
    await Promise.all([finished(output), finished(errors)]);
  });
  summary.push({ phase, threadId, exitCode, toolCalls: calls.length, calls });
  console.log(JSON.stringify({ phase, status: 'finished', exitCode, toolCalls: calls.length }));
  assert.equal(exitCode, 0, `${phase}: Codex exited unsuccessfully; inspect ${runDirectory}`);
  assert.ok(threadId, `${phase}: no fresh Codex session observed`);
  const required: Record<Phase, string[]> = {
    producer: ['artifact.create', 'task.create', 'task.submit_delivery', 'task.get'],
    reviewer: ['task.get', 'review.get', 'artifact.read', 'review.start', 'review.submit'],
    observer: ['task.get', 'review.get', 'workflow.history', 'artifact.read'],
  };
  for (const tool of required[phase])
    assert.ok(
      calls.some(
        (call) =>
          call.tool === tool &&
          call.status === 'completed' &&
          !call.errorCode &&
          !call.transportError,
      ),
      `${phase}: missing successful ${tool}`,
    );
  const refused: Record<Phase, string> = {
    producer: 'review.start',
    reviewer: 'artifact.create',
    observer: 'actor.create',
  };
  assert.ok(
    calls.some((call) => call.tool === refused[phase] && call.errorCode === 'forbidden'),
    `${phase}: missing server-enforced permission denial for ${refused[phase]}`,
  );
}

async function run() {
  let app = await createApp({ directory: join(runDirectory, 'data'), api: true, port: 0 });
  try {
    const operator = app.ctx.scope.bootstrap({
      projectName: 'Codex live acceptance',
      actorName: 'Test operator',
    });
    const caller: Caller = { actorId: operator.actor.id, projectId: operator.project.id };
    const producer = app.ctx.scope.issueActor(caller, {
      name: 'Fresh Codex producer',
      role: 'producer',
    });
    const reviewer = app.ctx.scope.issueActor(caller, {
      name: 'Fresh Codex reviewer',
      role: 'reviewer',
    });
    const observer = app.ctx.scope.issueActor(caller, {
      name: 'Fresh Codex observer',
      role: 'reader',
    });
    writeFileSync(
      join(runDirectory, 'credentials.json'),
      JSON.stringify({ operator, producer, reviewer, observer }, null, 2) + '\n',
      { mode: 0o600 },
    );
    await codex(
      'producer',
      producer.token,
      app.ctx.api.url!,
      'You are the producer. Create one task titled "Verify arithmetic evidence". Its goal is "Verify the sum and mean of 2, 4, 6, 8." Its two Done-when checks are exactly "Sum equals 20" and "Mean equals 5". First store an immutable Markdown brief containing that goal and both checks, then create the task using the brief. Compute the result yourself. Store a separate immutable Markdown delivery explaining the calculation and explicitly addressing each check using the exact check wording. Submit the delivery for independent review. Verify the task is in_review. Attempt review.start as this producer, confirm access is refused, and leave the task awaiting a separate reviewer. Use stable unique request IDs and the current task revision. Do not create actor credentials.',
    );
    let task = app.ctx.tasks.list(caller)[0];
    assert.ok(task, 'Producer did not create a task');
    assert.equal(task.workflow.state, 'in_review');
    assert.ok(task.reviewId);
    const firstTaskId = task.id,
      firstReviewId = task.reviewId;
    assert.equal(app.ctx.reviews.get(caller, firstReviewId).status, 'requested');
    await app.stop();
    app = await createApp({ directory: join(runDirectory, 'data'), api: true, port: 0 });
    assert.equal(app.ctx.tasks.get(caller, firstTaskId).reviewId, firstReviewId);
    console.log(
      JSON.stringify({ phase: 'restart-before-review', status: 'verified', taskId: firstTaskId }),
    );
    await codex(
      'reviewer',
      reviewer.token,
      app.ctx.api.url!,
      `You are an independent reviewer of task ${firstTaskId}, review ${firstReviewId}. The server has restarted since submission. Read the task, pinned review criteria, brief, and all delivery artifacts through MCP. Verify the arithmetic independently. Claim the review with review.start and submit pass only if the evidence meets both checks; explain your actual verification in notes. Use the task workflow revision for expectedRevision. Verify the task reaches done. Attempt to create a task artifact as this reviewer and confirm permission is denied. Do not create actor credentials.`,
    );
    task = app.ctx.tasks.get(caller, firstTaskId);
    assert.equal(task.workflow.state, 'done');
    assert.equal(task.workflow.revision, 2);
    const review = app.ctx.reviews.get(caller, firstReviewId);
    assert.equal(review.verdict, 'pass');
    assert.equal(review.reviewerId, reviewer.actor.id);
    assert.notEqual(review.reviewerId, review.producerId);
    await app.stop();
    app = await createApp({ directory: join(runDirectory, 'data'), api: true, port: 0 });
    await codex(
      'observer',
      observer.token,
      app.ctx.api.url!,
      `You are a read-only observer after a second server restart. Read task ${firstTaskId}, review ${firstReviewId}, the workflow history, and the retained delivery content. Verify the task is done at revision 2 and the passing verdict is from a different actor than the producer. Attempt actor.create with role operator and confirm access is denied. Do not perform any successful mutations.`,
    );
    const finalTask = app.ctx.tasks.get(caller, firstTaskId);
    assert.equal(finalTask.workflow.state, 'done');
    assert.equal(app.ctx.tasks.list(caller).length, 1, 'Expected exactly one synthetic task');
    assert.equal(
      new Set(summary.map((phase) => phase.threadId)).size,
      3,
      'Expected three distinct Codex instances',
    );
    const evidenceChecks = verifyLiveEvidence(
      finalTask,
      app.ctx.reviews.get(caller, firstReviewId),
      {
        reviewer: readFileSync(join(runDirectory, 'reviewer.jsonl'), 'utf8'),
        observer: readFileSync(join(runDirectory, 'observer.jsonl'), 'utf8'),
      },
    );
    const events = app.ctx.state.events(caller.projectId);
    const report = {
      status: 'passed',
      directory: runDirectory,
      evidenceChecks,
      phases: summary,
      task: finalTask,
      review: app.ctx.reviews.get(caller, firstReviewId),
      history: app.ctx.workflows.history(caller, firstTaskId),
      events,
    };
    await app.stop();
    writeFileSync(join(runDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(
      JSON.stringify({
        status: 'passed',
        report: join(runDirectory, 'report.json'),
        phases: summary,
        taskId: firstTaskId,
      }),
    );
  } finally {
    await app.stop();
  }
}
run().catch((error) => {
  writeFileSync(
    join(runDirectory, 'failure.json'),
    JSON.stringify({ message: error.message, stack: error.stack, phases: summary }, null, 2) + '\n',
  );
  console.error(error);
  process.exitCode = 1;
});
