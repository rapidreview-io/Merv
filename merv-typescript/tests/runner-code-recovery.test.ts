import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { MachineRunner, type RunnerConfig } from '@merv/runner';
import type { WorkflowExecutionPolicy } from '@merv/contracts';
import { createApp } from '../src/app.js';
import type {} from '@merv/code/types';

test(
  'a lost dispatch reply followed by worker closure is reconciled and acknowledged across controller restart',
  { timeout: 45_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'merv-code-recovery-'));
    const repository = join(directory, 'source');
    mkdirSync(repository);
    const git = (...args: string[]) =>
      execFileSync('/usr/bin/git', ['-C', repository, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: '/usr/bin:/bin',
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
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'Initial',
    );
    const initial = git('rev-parse', 'HEAD');
    const app = await createApp({ directory: join(directory, 'server'), api: true, port: 0 });
    const boot = await app.ctx.scope.bootstrap({
      projectName: 'Lost commit dispatch',
      actorName: 'Controller',
    });
    const source = {
      actorId: boot.actor.id,
      projectId: boot.project.id,
      credentialId: boot.credential.id,
    };
    const credentialEnv = 'MERV_CODE_RECOVERY_SOURCE';
    const previous = process.env[credentialEnv];
    process.env[credentialEnv] = boot.token;
    const execution: WorkflowExecutionPolicy = {
      readOnly: false,
      tools: ['code.commit', 'code.operation'].map((name) => ({ name, alternatives: [{}] })),
      workspace: {
        mode: 'persistent',
        namespace: 'code',
        base: 'central',
        perBase: false,
        retain: true,
        advancesCentral: false,
      },
    };
    const program = await app.ctx.workflows.register(
      {
        name: 'lost-code-command',
        version: 1,
        managed: true,
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
            tool: 'step.finish',
            instruction: 'Finish',
            check: async () => {},
          },
        ],
        assignments: [
          {
            state: 'work',
            check: async () => {},
            references: () => ({}),
            execution,
            build: async () => ({
              role: 'producer',
              label: 'Commit recovery',
              brief: 'Write then commit.',
              references: [],
              handoff: { instruction: 'Stop after the test closes the lease.', tools: [] },
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
    await program.start(source, { workflow: 'lost-code-command', requestId: 'start' });
    const config: RunnerConfig = {
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
          args: [fileURLToPath(new URL('./fixtures/runner-code-worker.mjs', import.meta.url))],
          enabled: true,
          parallelism: 1,
        },
      ],
    };
    let lost = false,
      completionAttempts = 0,
      unavailable = true;
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/code/commands/complete')) {
        completionAttempts++;
        if (unavailable)
          return new Response(JSON.stringify({ error: { code: 'synthetic_outcome_outage' } }), {
            status: 503,
          });
      }
      const response = await fetch(input, init);
      if (!lost && String(input).endsWith('/code/commands/next') && response.ok) {
        const value = (await response.clone().json()) as {
          command: { sessionId: string; runnerId: string } | null;
        };
        if (value.command) {
          lost = true;
          await app.ctx.sessions.setDispatch(source, { enabled: false });
          await app.ctx.sessions.release(source, {
            sessionId: value.command.sessionId,
            runnerId: value.command.runnerId,
          });
          throw new TypeError('The dispatched command reply was lost before local journaling');
        }
      }
      return response;
    };
    let runner = new MachineRunner(config, { autoPoll: false, fetch: fetcher });
    t.after(async () => {
      unavailable = false;
      await runner.stop();
      program.dispose();
      await app.stop();
      if (previous === undefined) delete process.env[credentialEnv];
      else process.env[credentialEnv] = previous;
      rmSync(directory, { recursive: true, force: true });
    });
    await runner.start();
    await app.ctx.sessions.setDispatch(source, { enabled: true });
    const deadline = Date.now() + 30_000;
    while (!lost || !completionAttempts) {
      await runner.tick();
      if (lost && runner.snapshot().launches[0]?.workspace?.status === 'closed') break;
      assert.ok(Date.now() < deadline, JSON.stringify(runner.snapshot()));
      await delay(40);
    }
    assert.ok(lost);
    assert.ok(
      completionAttempts > 0,
      'a dispatched command with a lost reply must be recovered even after the worker closes',
    );
    assert.equal(
      runner.snapshot().launches[0]?.workspace?.status,
      'captured',
      'outcome acknowledgment retains checkout ownership',
    );
    await runner.stop();
    unavailable = false;
    runner = new MachineRunner(config, { autoPoll: false, fetch: fetcher });
    await runner.start();
    while (runner.snapshot().launches[0]?.workspace?.status !== 'closed') {
      await runner.tick();
      assert.ok(Date.now() < deadline, JSON.stringify(runner.snapshot()));
      await delay(40);
    }
    const operation = (await app.ctx.code.list(source))[0];
    assert.equal(operation.status, 'failed');
    assert.equal(operation.error, 'workspace_process_not_running');
    assert.equal(
      operation.receipt,
      null,
      'final WIP capture must not masquerade as this unexecuted command',
    );
    assert.ok((await app.ctx.sessions.list(source))[0].workspace!.result);
    assert.equal(git('rev-parse', 'HEAD'), initial);
    assert.equal(runner.snapshot().launches.length, 1);
  },
);
