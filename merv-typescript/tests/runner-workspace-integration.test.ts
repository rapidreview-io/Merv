import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { MachineRunner } from '@merv/runner';
import { createApp } from '../src/app.js';

test(
  'real Git worker handoff captures WIP after remote closure and replays a lost result receipt',
  { timeout: 40_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'merv-runner-git-integration-'));
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
    writeFileSync(join(repository, 'seed.txt'), 'initial source\n');
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
      projectName: 'Workspace integration',
      actorName: 'Owner',
    });
    const source = {
      projectId: boot.project.id,
      actorId: boot.actor.id,
      credentialId: boot.credential.id,
    };
    const credentialEnv = 'MERV_GIT_INTEGRATION_SOURCE';
    const previous = process.env[credentialEnv];
    process.env[credentialEnv] = boot.token;
    const execution = {
      readOnly: false,
      workspace: {
        mode: 'persistent' as const,
        namespace: 'integration',
        base: 'reference:code' as const,
        perBase: false,
        retain: true,
        advancesCentral: false,
      },
      tools: [
        { name: 'artifact.create', alternatives: [{}] },
        { name: 'step.finish', alternatives: [{}] },
      ],
    };
    const program = await app.ctx.workflows.register(
      {
        name: 'git-work',
        version: 1,
        initial: 'work',
        states: ['work', 'done'],
        terminal: ['done'],
        edges: [{ from: 'work', action: 'finish', to: 'done' }],
      },
      {
        successStates: ['done'],
        actions: [
          {
            name: 'finish',
            states: ['work'],
            transitions: ['finish'],
            tool: 'step.finish',
            instruction: 'Retain evidence, then finish.',
            check: async () => {},
          },
        ],
        assignments: [
          {
            state: 'work',
            check: async () => {},
            references: () => ({ code: initial }),
            execution,
            build: async () => ({
              role: 'producer',
              label: 'Real code work',
              brief: 'Write and preserve the result.',
              references: [],
              handoff: { instruction: 'Call step.finish.', tools: ['step.finish'] },
              execution: {
                readOnly: false,
                tools: [
                  { name: 'artifact.create', arguments: {} },
                  { name: 'step.finish', arguments: {} },
                ],
              },
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
    const target = await program.start(source, { workflow: 'git-work', requestId: 'start' });
    const registration = app.ctx.tools.register({
      name: 'step.finish',
      description: 'Finish the assigned fixture.',
      inputSchema: z.object({}).strict(),
      handler: async (caller) =>
        await program.transition(caller, {
          instanceId: target.id,
          expectedRevision: 0,
          action: 'finish',
          requestId: 'finish',
        }),
    });
    let dropped = false,
      resultCalls = 0;
    const runner = new MachineRunner(
      {
        directory: join(directory, 'machine'),
        baseUrl: app.ctx.api.url!,
        projectId: boot.project.id,
        credentialEnv,
        workspace: { repository, baseRef: 'refs/heads/main' },
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
      },
      {
        autoPoll: false,
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (String(input).endsWith('/workspace-result') && response.ok) {
            resultCalls++;
            if (!dropped) {
              dropped = true;
              throw new TypeError('Lost successful workspace report reply');
            }
          }
          return response;
        },
      },
    );
    t.after(async () => {
      await runner.stop();
      await registration();
      program.dispose();
      await app.stop();
      if (previous === undefined) delete process.env[credentialEnv];
      else process.env[credentialEnv] = previous;
      rmSync(directory, { recursive: true, force: true });
    });
    await runner.start();
    await app.ctx.sessions.setDispatch(source, { enabled: true });
    const deadline = Date.now() + 25_000;
    while (true) {
      await runner.tick();
      const session = (await app.ctx.sessions.list(source))[0];
      assert.notEqual(session?.outcome, 'workspace_failed', JSON.stringify(runner.snapshot()));
      if (
        session?.workspace?.result &&
        resultCalls >= 2 &&
        runner.snapshot().launches[0]?.workspace?.status === 'closed'
      )
        break;
      assert.ok(Date.now() < deadline, JSON.stringify(runner.snapshot()));
      await delay(50);
    }
    const session = (await app.ctx.sessions.list(source))[0];
    const workspace = session.workspace!;
    assert.equal((await app.ctx.workflows.get(source, target.id)).state, 'done');
    assert.ok(['released', 'expired'].includes(session.status));
    assert.equal(workspace.attachment.baseOid, initial);
    assert.notEqual(workspace.result!.headOid, initial);
    assert.equal(workspace.result!.stats.filesChanged, 1);
    assert.equal((await app.ctx.workflows.workStarts(source, target.id)).length, 1);
    assert.equal(runner.snapshot().launches.length, 1);
    assert.ok(dropped);
    assert.equal(git('rev-parse', 'HEAD'), initial);
    assert.equal(git('status', '--porcelain'), '');
    const status = await app.ctx.sessions.projectStatus(source);
    assert.equal(status.sessions[0].workspace?.result?.headOid, workspace.result!.headOid);
    const db = await app.ctx.state.read(
      async (sql) =>
        await sql.all<{ data_json: string }>(
          "SELECT data_json FROM events WHERE type='session.workspace_result'",
        ),
    );
    assert.equal(db.length, 1, 'Replay must not duplicate the captured event');
  },
);
