import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { check, type WorkflowAssignmentRule } from '@merv/contracts';
import { MachineRunner } from '@merv/runner';
import { createApp } from '../src/app.js';
import { useRunSchema } from './database.js';

// Real-model acceptance for generic work→capture→read-only verification, using only synthetic data.
const directory = resolve(process.argv[2] ?? `live-runs/git-${Date.now()}`);
const schema = useRunSchema(directory);
mkdirSync(directory, { recursive: false, mode: 0o700 });
const repository = join(directory, 'source');
mkdirSync(repository);
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim();
git('init', '-b', 'main');
writeFileSync(join(repository, 'answer.txt'), '0\n');
git('add', '.');
git(
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.test',
  'commit',
  '-m',
  'Initial input',
);
const initialOid = git('rev-parse', 'HEAD');
const app = await createApp({ directory: join(directory, 'server'), api: true, port: 0 });
const boot = await app.ctx.scope.bootstrap({
  projectName: 'Native Git acceptance',
  actorName: 'Owner',
});
const source = {
  projectId: boot.project.id,
  actorId: boot.actor.id,
  credentialId: boot.credential.id,
};
const credentialEnv = 'MERV_NATIVE_GIT_SOURCE';
const previous = process.env[credentialEnv];
process.env[credentialEnv] = boot.token;
const rule = (state: 'work' | 'verify'): WorkflowAssignmentRule => {
  const readOnly = state === 'verify',
    tool = readOnly ? 'step.verify' : 'step.finish';
  return {
    state,
    check: async () => {},
    references: ({ snapshot }): Record<string, string | string[]> =>
      readOnly ? { code: String(snapshot.data.code) } : {},
    build: async () => ({
      role: readOnly ? 'reviewer' : 'producer',
      label: readOnly ? 'Independently verify the captured commit' : 'Edit the assigned checkout',
      brief: readOnly
        ? 'Use the local shell to read answer.txt and independently calculate 6*7. Check that the file contains exactly 42 followed by a newline. Do not change files. Call step.verify with answer:42 only when verified.'
        : 'Use the local shell to replace answer.txt with exactly 42 followed by a newline. Check the file. The runner will capture your WIP in Git after handoff, so do not run git add or git commit. Call step.finish with answer:42 when your file is ready.',
      references: [],
      handoff: { instruction: `Call ${tool}, then stop.`, tools: [tool] },
      execution: { readOnly, tools: [{ name: tool, arguments: {} }] },
      context: null,
    }),
    execution: {
      readOnly,
      tools: [{ name: tool, alternatives: [{}] }],
      workspace: readOnly
        ? { mode: 'ephemeral', namespace: 'verify', base: 'reference:code', retain: false }
        : {
            mode: 'persistent',
            namespace: 'work',
            base: 'central',
            retain: true,
            perBase: false,
            advancesCentral: false,
          },
    },
    lease: {
      role: async (): Promise<'operator' | 'producer' | 'reviewer' | 'reader'> =>
        readOnly ? 'reviewer' : 'producer',
      acquire: async () => ({}),
      check: async () => {},
      release: async () => {},
    },
  };
};
const program = await app.ctx.workflows.register(
  {
    name: 'native-git-check',
    version: 1,
    managed: true,
    initial: 'work',
    states: ['work', 'capture', 'verify', 'done'],
    terminal: ['done'],
    edges: [
      { from: 'work', action: 'finish', to: 'capture' },
      { from: 'capture', action: 'captured', to: 'verify' },
      { from: 'verify', action: 'verify', to: 'done' },
    ],
  },
  {
    successStates: ['done'],
    actions: [
      {
        name: 'finish',
        states: ['work'],
        transitions: ['finish'],
        tool: 'step.finish',
        instruction: 'Finish code edits.',
        check: async ({ caller, tx }) => {
          await app.ctx.scope.require(caller, 'write', tx);
        },
      },
      {
        name: 'captured',
        states: ['capture'],
        transitions: ['captured'],
        tool: 'capture.internal',
        instruction: 'Wait for durable capture.',
        check: async ({ caller, tx }) => {
          await app.ctx.scope.require(caller, 'admin', tx);
          check(
            caller.actorId === source.actorId && caller.projectId === source.projectId,
            'forbidden',
            'Only the capture consumer may advance this gate',
            403,
          );
        },
      },
      {
        name: 'verify',
        states: ['verify'],
        transitions: ['verify'],
        tool: 'step.verify',
        instruction: 'Verify captured code.',
        check: async ({ caller, tx }) => {
          await app.ctx.scope.require(caller, 'review', tx);
        },
      },
    ],
    assignments: [rule('work'), rule('verify')],
  },
);
const target = await program.start(source, { workflow: 'native-git-check', requestId: 'start' });
const handles = ['finish', 'verify'].map((action) =>
  app.ctx.tools.register({
    name: `step.${action}`,
    description:
      action === 'finish'
        ? 'Hand off the completed file for capture.'
        : 'Confirm independent inspection of the captured file.',
    inputSchema: z.object({ answer: z.literal(42) }).strict(),
    handler: async (caller) => {
      const snapshot = await app.ctx.workflows.get(caller, target.id);
      return await program.transition(caller, {
        instanceId: target.id,
        expectedRevision: snapshot.revision,
        action,
        requestId: action,
      });
    },
  }),
);
const unsubscribe = await app.ctx.domainEvents.subscribe({
  id: 'native-git-capture',
  types: ['session.workspace_result'],
  from: 'now',
  handle: async (event, tx) => {
    if (event.data.instanceId !== target.id || event.data.expectedRevision !== 0) return;
    const workspace = event.data.workspace as { headOid: string };
    check(workspace.headOid !== initialOid, 'missing_change', 'Expected captured changes');
    await program.transition(
      source,
      {
        instanceId: target.id,
        expectedRevision: 1,
        action: 'captured',
        requestId: `capture-${event.id}`,
        data: { code: workspace.headOid },
      },
      tx,
    );
  },
});
const runner = new MachineRunner({
  directory: join(directory, 'machine'),
  baseUrl: app.ctx.api.url!,
  projectId: boot.project.id,
  credentialEnv,
  workspace: { repository, baseRef: 'refs/heads/main' },
  capacity: 1,
  pollIntervalMs: 500,
  profiles: [
    {
      name: 'native-codex',
      harness: 'codex',
      executable: process.env.MERV_CODEX_BIN ?? 'codex',
      enabled: true,
      parallelism: 1,
    },
  ],
});
try {
  await runner.start();
  await app.ctx.sessions.setDispatch(source, { enabled: true });
  const deadline = Date.now() + 12 * 60_000;
  let last = '';
  while (true) {
    await app.ctx.domainEvents.drain();
    const state = (await app.ctx.workflows.get(source, target.id)).state;
    const snapshot = runner.snapshot();
    const summary = JSON.stringify({
      state,
      runnerState: snapshot.state,
      error: snapshot.lastError,
      launches: snapshot.launches.map(({ id, status, workspace }) => ({ id, status, workspace })),
    });
    if (summary !== last) {
      console.log(summary);
      last = summary;
    }
    if (
      state === 'done' &&
      snapshot.launches.length === 2 &&
      snapshot.launches.every((launch) => launch.workspace?.status === 'closed')
    )
      break;
    assert.ok(Date.now() < deadline, 'Native Git workflow timed out');
    assert.ok(snapshot.launches.length <= 3, 'Repeated failed launches');
    await delay(1000);
  }
  await app.ctx.sessions.setDispatch(source, { enabled: false });
  await runner.stop();
  const sessions = (await app.ctx.sessions.list(source)).sort(
    (a, b) => a.expectedRevision - b.expectedRevision,
  );
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0].actorId, sessions[1].actorId);
  assert.equal(sessions[0].workspace!.attachment.baseOid, initialOid);
  const captured = sessions[0].workspace!.result!.headOid;
  assert.notEqual(captured, initialOid);
  assert.equal(sessions[1].workspace!.attachment.baseOid, captured);
  assert.equal(sessions[1].workspace!.result!.headOid, captured);
  assert.equal(git('rev-parse', 'HEAD'), initialOid);
  assert.equal(readFileSync(join(repository, 'answer.txt'), 'utf8'), '0\n');
  const walk = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)],
    );
  const phases = walk(join(directory, 'machine/launches'))
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
  assert.ok(phases.every((phase) => phase.shellCalls > 0));
  const report = {
    passed: true,
    schema,
    initialOid,
    capturedOid: captured,
    sourceUnchanged: true,
    workflow: await app.ctx.workflows.get(source, target.id),
    sessions,
    phases,
    runner: runner.snapshot(),
  };
  const output = JSON.stringify(report, null, 2);
  assert.ok(!output.includes(boot.token));
  writeFileSync(join(directory, 'report.json'), output + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, agents: 2, report: join(directory, 'report.json') }));
} finally {
  await runner.stop();
  await unsubscribe();
  for (const handle of handles) await handle();
  program.dispose();
  await app.stop();
  if (previous === undefined) delete process.env[credentialEnv];
  else process.env[credentialEnv] = previous;
}
