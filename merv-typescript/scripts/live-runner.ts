import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MachineRunner } from '@merv/runner';
import { createApp } from '../src/app.js';

// Explicit real-model acceptance, separate from the deterministic test suite.
const directory = resolve(process.argv[2] ?? `live-runs/runner-${Date.now()}`);
mkdirSync(directory, { recursive: false, mode: 0o700 });
const app = await createApp({ directory: join(directory, 'server'), api: true, port: 0 });
const boot = await app.ctx.scope.bootstrap({
  projectName: 'Synthetic native runner acceptance',
  actorName: 'Owner',
});
const source = {
  projectId: boot.project.id,
  actorId: boot.actor.id,
  credentialId: boot.credential.id,
};
const credentialEnv = 'MERV_LIVE_RUNNER_SOURCE';
const previous = process.env[credentialEnv];
process.env[credentialEnv] = boot.token;
const runner = new MachineRunner({
  directory: join(directory, 'machine'),
  baseUrl: app.ctx.api.url!,
  projectId: boot.project.id,
  credentialEnv,
  profiles: [
    {
      name: 'native-codex',
      harness: 'codex',
      executable: process.env.MERV_CODEX_BIN ?? 'codex',
      enabled: true,
      parallelism: 1,
    },
  ],
  capacity: 1,
  pollIntervalMs: 500,
});
try {
  const task = await app.ctx.tasks.create(source, {
    title: 'Calculate and independently review two small arithmetic results',
    goal: 'Use the local shell to calculate the results, preserve reproducible Markdown evidence through artifact.create, and submit the task with one met confirmation and evidence reference per criterion. The reviewer must independently calculate both results using its read-only shell, inspect pinned evidence, and submit a structured pass verdict only if both checks are verified. This is a synthetic test; no external research is needed.',
    checks: ['Show that adding 2 and 3 gives 5.', 'Show that multiplying 6 by 7 gives 42.'],
    requestId: 'native-runner-task',
  });
  await runner.start();
  assert.equal(runner.snapshot().launches.length, 0, 'Dispatch defaults off');
  await app.ctx.sessions.setDispatch(source, { enabled: true });
  const deadline = Date.now() + 12 * 60_000;
  let last = '';
  while ((await app.ctx.tasks.get(source, task.id)).workflow.state !== 'done') {
    const snapshot = runner.snapshot();
    const summary = JSON.stringify({
      state: (await app.ctx.tasks.get(source, task.id)).workflow.state,
      runner: snapshot,
    });
    if (summary !== last) {
      console.log(summary);
      last = summary;
    }
    assert.ok(
      Date.now() < deadline,
      'Native workflow did not finish within its acceptance deadline',
    );
    assert.ok(
      snapshot.launches.length <= 4,
      'Repeated failed launches; inspect retained private logs',
    );
    await delay(1000);
  }
  await app.ctx.sessions.setDispatch(source, { enabled: false });
  await runner.tick();
  await runner.stop();
  await app.ctx.sessions.sweep();
  await app.ctx.domainEvents.drain();
  const finalTask = await app.ctx.tasks.get(source, task.id);
  const review = await app.ctx.reviews.get(source, finalTask.reviewId!);
  const sessions = await app.ctx.sessions.list(source);
  assert.equal(sessions.length, 2, 'Exactly one producer and one reviewer');
  assert.notEqual(review.producerId, review.reviewerId);
  assert.ok(sessions.every((session) => session.actorId !== source.actorId));
  assert.ok(
    runner.snapshot().launches.every((launch) => ['exited', 'stopped'].includes(launch.status)),
  );
  const starts = await app.ctx.workflows.workStarts(source, task.id);
  assert.equal(starts.length, 2);
  const walk = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)],
    );
  const phases = walk(join(directory, 'machine'))
    .filter((path) => path.endsWith('/stdout.log'))
    .map((path) => {
      const events = readFileSync(path, 'utf8')
        .split('\n')
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
      return {
        log: path,
        threadId: events.find((event) => event.type === 'thread.started')?.thread_id,
        shellCalls: events.filter(
          (event) => event.type === 'item.completed' && event.item?.type === 'command_execution',
        ).length,
        calls: events
          .filter(
            (event) => event.type === 'item.completed' && event.item?.type === 'mcp_tool_call',
          )
          .map((event) => ({
            tool: event.item.tool,
            status: event.item.status,
            failed: !!event.item.error || event.item.result?.isError === true,
          })),
      };
    });
  assert.equal(new Set(phases.map((phase) => phase.threadId).filter(Boolean)).size, 2);
  assert.ok(
    phases.every((phase) => phase.shellCalls > 0),
    'Both profiles must execute their bounded local shell',
  );
  const report = {
    passed: true,
    task: finalTask,
    review,
    starts,
    sessions,
    runner: runner.snapshot(),
    phases,
  };
  const serialized = JSON.stringify(report, null, 2);
  assert.ok(!serialized.includes(boot.token));
  writeFileSync(join(directory, 'report.json'), serialized + '\n', { mode: 0o600 });
  console.log(
    JSON.stringify({
      passed: true,
      agents: phases.length,
      shellCalls: phases.reduce((sum, phase) => sum + phase.shellCalls, 0),
      toolCalls: phases.reduce((sum, phase) => sum + phase.calls.length, 0),
      report: join(directory, 'report.json'),
    }),
  );
} finally {
  await runner.stop();
  await app.stop();
  if (previous === undefined) delete process.env[credentialEnv];
  else process.env[credentialEnv] = previous;
}
