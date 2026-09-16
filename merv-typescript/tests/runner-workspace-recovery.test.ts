import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { MachineRunner, type RunnerConfig } from '@merv/runner';
import type { WorkflowAssignmentRule, WorkflowExecutionPolicy } from '@merv/contracts';
import { createApp } from '../src/app.js';

test(
  'pending Git capture acknowledgment retains runner capacity across restart before successor checkout reuse',
  { timeout: 50_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'merv-workspace-recovery-'));
    const repository = join(directory, 'source');
    mkdirSync(repository);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repository, ...args], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      }).trim();
    git('init', '-b', 'main');
    writeFileSync(join(repository, 'seed.txt'), 'original checkout\n');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'Initial',
    );
    const initial = git('rev-parse', 'HEAD');
    const app = await createApp({ directory: join(directory, 'server'), api: true, port: 0 });
    const boot = await app.ctx.scope.bootstrap({
      projectName: 'Capture recovery',
      actorName: 'Owner',
    });
    const source = {
      actorId: boot.actor.id,
      projectId: boot.project.id,
      credentialId: boot.credential.id,
    };
    const credentialEnv = 'MERV_WORKSPACE_RECOVERY_TEST_SOURCE';
    const previous = process.env[credentialEnv];
    process.env[credentialEnv] = boot.token;
    const execution: WorkflowExecutionPolicy = {
      readOnly: false,
      workspace: {
        mode: 'persistent',
        namespace: 'recovery',
        base: 'reference:code',
        perBase: false,
        retain: true,
        advancesCentral: false,
      },
      tools: [
        { name: 'artifact.create', alternatives: [{}] },
        {
          name: 'step.finish',
          alternatives: [
            {
              instanceId: { kind: 'target', field: 'instanceId' },
              expectedRevision: { kind: 'target', field: 'revision' },
            },
          ],
        },
      ],
    };
    const assignment = (state: string): WorkflowAssignmentRule => ({
      state,
      check: async () => {},
      references: () => ({ code: initial }),
      execution,
      build: async () => ({
        role: 'producer',
        label: state,
        brief: 'Write code and hand off.',
        references: [],
        handoff: { instruction: 'Call step.finish.', tools: ['step.finish'] },
        execution: { readOnly: false, tools: [] },
        context: null,
      }),
      lease: {
        role: async (): Promise<'operator' | 'producer' | 'reviewer' | 'reader'> => 'producer',
        acquire: async () => ({}),
        check: async () => {},
        release: async () => {},
      },
    });
    const program = await app.ctx.workflows.register(
      {
        name: 'workspace-successor',
        version: 1,
        initial: 'first',
        states: ['first', 'second', 'done'],
        terminal: ['done'],
        edges: [
          { from: 'first', action: 'finish', to: 'second' },
          { from: 'second', action: 'finish', to: 'done' },
        ],
      },
      {
        actions: [
          {
            name: 'finish',
            states: ['first', 'second'],
            transitions: ['finish'],
            tool: 'step.finish',
            instruction: 'Finish',
            check: async () => {},
          },
        ],
        assignments: [assignment('first'), assignment('second')],
      },
    );
    const target = await program.start(source, {
      workflow: 'workspace-successor',
      requestId: 'start',
    });
    const unregister = app.ctx.tools.register({
      name: 'step.finish',
      description: 'Finish one bound test state.',
      inputSchema: z.object({ instanceId: z.string(), expectedRevision: z.number() }).strict(),
      handler: async (caller, input) =>
        await program.transition(caller, {
          ...input,
          action: 'finish',
          requestId: `finish-${input.expectedRevision}`,
        }),
    });
    const config: RunnerConfig = {
      directory: join(directory, 'machine'),
      baseUrl: app.ctx.api.url!,
      projectId: boot.project.id,
      credentialEnv,
      workspace: { repository, baseRef: 'refs/heads/main' },
      capacity: 1,
      profiles: [
        {
          name: 'worker',
          harness: 'command',
          executable: process.execPath,
          args: [fileURLToPath(new URL('./fixtures/runner-git-worker.mjs', import.meta.url))],
          enabled: true,
          parallelism: 1,
        },
      ],
    };
    let unavailable = true,
      reportAttempts = 0;
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/workspace-result')) {
        reportAttempts++;
        if (unavailable)
          return new Response(JSON.stringify({ error: { code: 'synthetic_report_outage' } }), {
            status: 503,
          });
      }
      return fetch(input, init);
    };
    let runner = new MachineRunner(config, { autoPoll: false, fetch: fetcher });
    t.after(async () => {
      unavailable = false;
      await runner.stop();
      await unregister();
      program.dispose();
      await app.stop();
      if (previous === undefined) delete process.env[credentialEnv];
      else process.env[credentialEnv] = previous;
      rmSync(directory, { recursive: true, force: true });
    });
    const until = async (condition: () => boolean | Promise<boolean>, label: string) => {
      const deadline = Date.now() + 25_000;
      while (!(await condition())) {
        await runner.tick();
        assert.ok(Date.now() < deadline, `${label}: ${JSON.stringify(runner.snapshot())}`);
        await delay(30);
      }
    };
    await runner.start();
    await app.ctx.sessions.setDispatch(source, { enabled: true });
    await until(() => reportAttempts > 0, 'First final capture reaches reporting');
    const first = (await app.ctx.sessions.list(source))[0];
    assert.equal((await app.ctx.workflows.get(source, target.id)).state, 'second');
    assert.ok(first.workspace?.attachment);
    assert.equal(first.workspace.result, null);
    assert.equal(runner.snapshot().launches[0].workspace?.status, 'captured');
    for (let i = 0; i < 3; i++) await runner.tick();
    assert.equal(
      (await app.ctx.sessions.list(source)).length,
      1,
      'A terminal process still occupies capacity until its owned capture is acknowledged',
    );
    assert.equal(runner.snapshot().launches.length, 1);
    await runner.stop();
    runner = new MachineRunner(config, { autoPoll: false, fetch: fetcher });
    await runner.start();
    await runner.tick();
    assert.equal(
      (await app.ctx.sessions.list(source)).length,
      1,
      'Restart must retain the same pending capture and occupied slot',
    );
    assert.equal(runner.snapshot().launches[0].workspace?.status, 'captured');
    unavailable = false;
    await until(
      async () =>
        (await app.ctx.sessions.list(source)).length === 2 &&
        runner.snapshot().launches.every((launch) => launch.workspace?.status === 'closed'),
      'Successor runs only after the first capture is acknowledged',
    );
    const [earlier, later] = await app.ctx.sessions.list(source);
    assert.ok(earlier.workspace?.result);
    assert.ok(later.workspace?.result);
    assert.equal(later.workspace.attachment.workspaceId, earlier.workspace.attachment.workspaceId);
    assert.equal(later.workspace.attachment.headOid, earlier.workspace.result.headOid);
    assert.equal((await app.ctx.workflows.get(source, target.id)).state, 'done');
    assert.equal(
      (await app.ctx.state.events(source.projectId)).filter(
        (event) => event.type === 'session.workspace_result',
      ).length,
      2,
    );
    assert.equal(
      (await app.ctx.sessions.list(source)).some(
        (session) => session.outcome === 'workspace_failed',
      ),
      false,
    );
    assert.equal(git('rev-parse', 'HEAD'), initial);
    assert.equal(git('status', '--porcelain'), '');
  },
);

test(
  'shutdown recovers a committed attachment with a lost reply before retiring its final capture',
  { timeout: 35_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'merv-workspace-attach-recovery-'));
    const repository = join(directory, 'source');
    mkdirSync(repository);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repository, ...args], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      }).trim();
    git('init', '-b', 'main');
    writeFileSync(
      join(repository, 'seed.txt'),
      'No worker should start before attach acknowledgment.\n',
    );
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'Initial',
    );
    const initial = git('rev-parse', 'HEAD');
    const app = await createApp({ directory: join(directory, 'server'), api: true, port: 0 });
    const boot = await app.ctx.scope.bootstrap({
      projectName: 'Attachment recovery',
      actorName: 'Owner',
    });
    const source = {
      actorId: boot.actor.id,
      projectId: boot.project.id,
      credentialId: boot.credential.id,
    };
    const credentialEnv = 'MERV_WORKSPACE_ATTACH_RECOVERY_SOURCE';
    const previous = process.env[credentialEnv];
    process.env[credentialEnv] = boot.token;
    const program = await app.ctx.workflows.register(
      {
        name: 'workspace-attach-recovery',
        version: 1,
        initial: 'work',
        states: ['work', 'done'],
        terminal: ['done'],
        edges: [{ from: 'work', action: 'finish', to: 'done' }],
      },
      {
        actions: [
          {
            name: 'finish',
            states: ['work'],
            transitions: ['finish'],
            tool: 'finish',
            instruction: 'Finish',
            check: async () => {},
          },
        ],
        assignments: [
          {
            state: 'work',
            check: async () => {},
            references: () => ({ code: initial }),
            execution: {
              readOnly: false,
              tools: [],
              workspace: {
                mode: 'persistent',
                namespace: 'attach',
                base: 'reference:code',
                perBase: false,
                retain: true,
                advancesCentral: false,
              },
            },
            build: async () => ({
              role: 'producer',
              label: 'Attachment recovery',
              brief: 'Never launched.',
              references: [],
              handoff: { instruction: 'Finish', tools: [] },
              execution: { readOnly: false, tools: [] },
              context: null,
            }),
            lease: {
              role: async (): Promise<'operator' | 'producer' | 'reviewer' | 'reader'> =>
                'producer',
              acquire: async () => ({}),
              check: async () => {},
              release: async () => {},
            },
          },
        ],
      },
    );
    const target = await program.start(source, {
      workflow: 'workspace-attach-recovery',
      requestId: 'start',
    });
    const config: RunnerConfig = {
      directory: join(directory, 'machine'),
      baseUrl: app.ctx.api.url!,
      projectId: boot.project.id,
      credentialEnv,
      workspace: { repository, baseRef: 'refs/heads/main' },
      capacity: 1,
      profiles: [
        {
          name: 'worker',
          harness: 'command',
          executable: process.execPath,
          args: ['-e', 'throw new Error("Must not launch before attachment acknowledgment")'],
          enabled: true,
          parallelism: 1,
        },
      ],
    };
    let lostAttach = false,
      lostRelease = false;
    const fetcher: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (response.ok && String(input).endsWith('/attach') && !lostAttach) {
        lostAttach = true;
        throw new TypeError('Lost committed attachment reply');
      }
      if (response.ok && String(input).endsWith('/release') && !lostRelease) {
        lostRelease = true;
        throw new TypeError('Lost committed closure reply');
      }
      return response;
    };
    let runner = new MachineRunner(config, { autoPoll: false, fetch: fetcher });
    t.after(async () => {
      await runner.stop();
      program.dispose();
      await app.stop();
      if (previous === undefined) delete process.env[credentialEnv];
      else process.env[credentialEnv] = previous;
      rmSync(directory, { recursive: true, force: true });
    });
    await runner.start();
    await app.ctx.sessions.setDispatch(source, { enabled: true });
    await runner.tick();
    assert.equal(lostAttach, true);
    const offered = (await app.ctx.sessions.list(source))[0];
    assert.ok(offered.workspace?.attachment);
    assert.equal(offered.workspace.result, null);
    assert.equal(offered.activatedAt, null);
    await app.ctx.sessions.setDispatch(source, { enabled: false });
    await runner.stop();
    assert.equal(lostRelease, true);
    assert.equal(
      runner.snapshot().launches[0].workspace?.status,
      'captured',
      'Unknown attach/close acknowledgment must retain the immutable local capture',
    );
    assert.equal((await app.ctx.sessions.get(source, offered.id)).status, 'released');
    runner = new MachineRunner(config, { autoPoll: false, fetch: fetcher });
    await runner.start();
    await runner.tick();
    const recovered = await app.ctx.sessions.get(source, offered.id);
    assert.equal(recovered.workspace?.result?.headOid, initial);
    assert.equal(recovered.workspace?.result?.baseOid, initial);
    assert.equal(runner.snapshot().launches[0].workspace?.status, 'closed');
    assert.equal((await app.ctx.workflows.workStarts(source, target.id)).length, 0);
    assert.equal(
      (await app.ctx.state.events(source.projectId)).filter(
        (event) => event.type === 'session.workspace_result',
      ).length,
      1,
    );
    assert.equal((await app.ctx.sessions.list(source)).length, 1);
  },
);
