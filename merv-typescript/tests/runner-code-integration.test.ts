import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { MachineRunner } from '@merv/runner';
import { createApp } from '../src/app.js';
import type {} from '@merv/code/types';

test(
  'live producer commits through MCP, retains authorship and recovers a lost command acknowledgement after handoff',
  { timeout: 45_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'merv-code-integration-'));
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
      'Initial',
    );
    const initialOid = git('rev-parse', 'HEAD');
    const app = await createApp({ directory: join(directory, 'server'), api: true, port: 0 });
    const boot = await app.ctx.scope.bootstrap({
      projectName: 'Code protocol',
      actorName: 'Controller',
    });
    const source = {
      actorId: boot.actor.id,
      projectId: boot.project.id,
      credentialId: boot.credential.id,
    };
    const credentialEnv = 'MERV_CODE_INTEGRATION_SOURCE';
    const previous = process.env[credentialEnv];
    process.env[credentialEnv] = boot.token;
    let reviewId: string | undefined;
    const execution = {
      readOnly: false,
      tools: ['code.commit', 'code.operation', 'artifact.create', 'step.finish'].map((name) => ({
        name,
        alternatives: [{}],
      })),
      workspace: {
        mode: 'persistent' as const,
        namespace: 'code',
        base: 'central' as const,
        perBase: false,
        retain: true,
        advancesCentral: false,
      },
    };
    const program = await app.ctx.workflows.register(
      {
        name: 'code-operation-proof',
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
            instruction: 'Commit and seal evidence.',
            check: async ({ caller, tx }) => {
              await app.ctx.scope.require(caller, 'write', tx);
            },
          },
        ],
        assignments: [
          {
            state: 'work',
            check: async () => {},
            execution,
            references: () => ({}),
            build: async () => ({
              role: 'producer',
              label: 'Checkpoint real code',
              brief: 'Commit and preserve evidence while alive.',
              references: [],
              handoff: { instruction: 'Call step.finish.', tools: ['step.finish'] },
              execution: {
                readOnly: false,
                tools: execution.tools.map(({ name }) => ({ name, arguments: {} })),
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
    const target = await program.start(source, {
      workflow: 'code-operation-proof',
      requestId: 'start',
    });
    const registration = app.ctx.tools.register({
      name: 'step.finish',
      description: 'Seal the checkpoint under its real producer.',
      inputSchema: z.object({ commandId: z.string(), artifactId: z.string() }).strict(),
      handler: async (caller, input) =>
        await app.ctx.state.transaction(async (tx) => {
          const operation = await app.ctx.code.operation(caller, input.commandId);
          assert.equal(operation.status, 'succeeded');
          assert.equal(operation.command.actorId, caller.actorId);
          const review = await app.ctx.reviews.request(
            caller,
            {
              subjectId: target.id,
              subjectRevision: 0,
              producerId: caller.actorId,
              artifactIds: [input.artifactId],
              criteria: ['Inspect the exact immutable commit receipt and its answer.'],
              requestId: 'review-checkpoint',
            },
            tx,
          );
          reviewId = review.id;
          return await program.transition(
            caller,
            { instanceId: target.id, expectedRevision: 0, action: 'finish', requestId: 'finish' },
            tx,
          );
        }),
    });
    let completions = 0;
    let dropped = false;
    const config = {
      directory: join(directory, 'machine'),
      baseUrl: app.ctx.api.url!,
      projectId: boot.project.id,
      credentialEnv,
      workspace: { repository, baseRef: 'refs/heads/main' },
      profiles: [
        {
          name: 'fixture',
          harness: 'command' as const,
          executable: process.execPath,
          args: [fileURLToPath(new URL('./fixtures/runner-code-worker.mjs', import.meta.url))],
          enabled: true,
          parallelism: 1,
        },
      ],
    };
    let runner = new MachineRunner(config, {
      autoPoll: false,
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (String(input).endsWith('/code/commands/complete') && response.ok) {
          completions++;
          if (!dropped) {
            dropped = true;
            throw new TypeError('Lost successful commit acknowledgement');
          }
        }
        return response;
      },
    });
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
    const deadline = Date.now() + 30_000;
    while (true) {
      await runner.tick();
      if (reviewId && runner.snapshot().launches[0]?.workspace?.status === 'closed') break;
      assert.ok(Date.now() < deadline, JSON.stringify(runner.snapshot()));
      await delay(50);
    }
    assert.ok(dropped);
    assert.ok(completions >= 2);
    const operation = (await app.ctx.code.list(source))[0];
    assert.equal(operation.status, 'succeeded');
    const session = (await app.ctx.sessions.list(source))[0];
    assert.equal(operation.command.actorId, session.actorId);
    assert.notEqual(operation.receipt!.headOid, initialOid);
    assert.notEqual(session.workspace!.result!.headOid, operation.receipt!.headOid);
    const review = await app.ctx.reviews.get(source, reviewId!);
    assert.equal(review.producerId, session.actorId);
    assert.equal(
      (await app.ctx.artifacts.get(source, review.artifactIds[0])).createdBy,
      session.actorId,
    );
    assert.equal(git('rev-parse', 'HEAD'), initialOid);
    assert.equal(git('status', '--porcelain'), '');
    assert.equal(runner.snapshot().launches.length, 1);
    await runner.stop();
    runner = new MachineRunner(config, { autoPoll: false });
    await runner.start();
    assert.equal(runner.snapshot().launches.length, 1);
    assert.equal(
      (await app.ctx.code.operation(source, operation.command.id)).receipt!.headOid,
      operation.receipt!.headOid,
    );
  },
);
