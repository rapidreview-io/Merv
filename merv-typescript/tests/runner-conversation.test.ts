import { sha256Hex, type WorkspaceHandle } from '@merv/contracts';
import { MachineRunner, type RunnerConfig } from '@merv/runner';
import { LocalLedger, terminalLaunch } from '@merv/runner/ledger';
import { redactConversation } from '@merv/runner/conversation';
import { buildLaunch } from '@merv/runner/profiles';
import type { Session } from '@merv/sessions/types';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

test('conversation delivery redacts launch credentials and refuses unrecoverable secrets after restart', async () => {
  for (const mode of ['live', 'restart-git', 'restart-private'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'merv-conversation-'));
    const directory = join(root, 'runner');
    const credentialEnv = `MERV_CONVERSATION_${randomUUID().replaceAll('-', '')}`;
    const source = 'mr_' + '1'.repeat(64);
    const native = mode === 'restart-git' ? undefined : 'opaque-native-"-\\-123456789';
    const git = {
      url: 'https://example.invalid/git',
      token: 'mg_' + 'g'.repeat(43),
      branch: 'main',
      startingCommit: '1'.repeat(40),
    };
    const basic = Buffer.from(`merv:${git.token}`).toString('base64');
    const secrets = [source, git.token, basic, ...(native ? [native] : [])];
    process.env[credentialEnv] = source;
    const conversationId = randomUUID();
    const executable = join(root, 'harness');
    writeFileSync(
      executable,
      `#!${process.execPath}
const fs = require('fs'), path = require('path');
const home = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '08');
fs.mkdirSync(home, {recursive:true});
const output = JSON.stringify({git:process.env.MERV_GIT_TOKEN, basic:process.env.GIT_CONFIG_VALUE_0,
  native:process.env.MERV_NATIVE_MCP_TOKEN_0, source:${JSON.stringify(source)}, result:'useful result'});
const line = JSON.stringify({type:'response_item',payload:{type:'function_call_output',output}})+'\\n';
fs.writeFileSync(path.join(home, 'rollout-fixture-${conversationId}.jsonl'), line);
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'${conversationId}'})+'\\n'+line);
`,
      { mode: 0o700 },
    );
    const config: RunnerConfig = {
      directory,
      baseUrl: 'http://127.0.0.1:12345',
      projectId: 'project_conversation',
      credentialEnv,
      profiles: [{ name: 'test', harness: 'codex', executable, enabled: true, parallelism: 1 }],
      capacity: 1,
    };
    const common = {
      instanceId: 'work_conversation',
      projectId: config.projectId,
      actorId: 'actor_test',
      revision: 0,
    };
    const session = {
      ...common,
      id: 'session_conversation',
      kind: 'work',
      role: 'worker',
      status: 'offered',
      runnerId: '',
      hostRef: null as string | null,
      expectedRevision: 0,
      closeReason: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      hardDeadline: new Date(Date.now() + 60_000).toISOString(),
      continuity: {},
      execution: {
        ...common,
        references: {},
        policy: {
          readOnly: false,
          tools: [],
          workspace: {
            mode: 'ephemeral',
            namespace: 'test',
            base: 'reference:base',
            retain: false,
            driver: 'test.git',
          },
        },
      },
      assignment: { ...common, label: 'Test', brief: 'Test', execution: { readOnly: false } },
    };
    let leased = false,
      closed = 0;
    const puts = new Map<string, Buffer>();
    const make = () => {
      const workspace: WorkspaceHandle = {
        path: root,
        retain: false,
        readOnly: false,
        status: 'ready',
      };
      return new MachineRunner(config, {
        autoPoll: false,
        drivers: [
          {
            name: 'test.git',
            create: () => ({
              get: () => workspace,
              prepare: async () => workspace,
              agentGit: () => git,
              capture: async () => undefined,
              close: async () => {
                workspace.status = 'closed';
                closed++;
              },
              dispose: () => {},
            }),
          },
        ],
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
          if (path === '/sessions/runners/heartbeat') {
            session.runnerId = body.runnerId;
            return Response.json({
              runner: {
                runnerId: body.runnerId,
                desiredVersion: 0,
                desiredSettings: { platforms: [] },
              },
            });
          }
          if (path === '/sessions/lease') {
            if (leased) return Response.json({ session: null, reason: 'no_candidates' });
            leased = true;
            return Response.json({ session, reason: 'leased' });
          }
          if (path.endsWith('/attach')) {
            session.status = 'active';
            session.hostRef = body.hostRef;
            return Response.json({ session, prompt: 'Keep useful results.' });
          }
          if (path.endsWith('/launch-connections'))
            return Response.json({
              connections: native
                ? [{ name: 'private', url: 'https://example.invalid/mcp', bearer: native }]
                : [],
            });
          if (path.endsWith('/control')) return Response.json({ control: session });
          if (path.endsWith('/release')) {
            session.status = 'released';
            return Response.json({ session });
          }
          if (path.endsWith('/stream')) return Response.json({ stream: { until: body.until } });
          const kind = path.split('/').at(-1)!;
          if (kind === 'transcript' || kind === 'conversation') {
            if (init?.method === 'PUT') {
              puts.set(kind, Buffer.from(init.body as Uint8Array));
              return new Response(null, { status: 200 });
            }
            return Response.json({
              [kind]: {
                sessionId: session.id,
                sha256: body.sha256,
                size: body.size,
                uploadedAt: puts.has(kind) ? new Date().toISOString() : null,
                upload: {
                  url: config.baseUrl + '/store/' + kind,
                  headers: {},
                  expiresAt: session.expiresAt,
                },
              },
            });
          }
          if (path === '/sessions/' + session.id) return Response.json({ session });
          throw new Error('Unexpected request ' + path);
        },
      });
    };
    let runner = make();
    try {
      if (mode === 'live') {
        // Configured Claude MCP servers also support short opaque credentials; they
        // must not inherit the transcript's minimum-length heuristic.
        const short = 'short-key-123';
        const command = buildLaunch(
          {
            name: 'claude',
            harness: 'claude',
            executable,
            enabled: true,
            parallelism: 1,
            servers: [
              { name: 'private', url: 'https://example.invalid/mcp', bearerEnv: 'TEST_MCP' },
            ],
          },
          {
            session: session as unknown as Session,
            prompt: 'Work',
            secret: 'ms_' + 's'.repeat(43),
            mcpUrl: config.baseUrl + '/mcp',
            cwd: root,
            shellEnvFile: join(root, 'shell-env.sh'),
          },
          { TEST_MCP: short },
        );
        assert.ok(command.secrets.includes(short));
        const record = Buffer.from(
          JSON.stringify({ output: JSON.stringify({ authorization: short }) }) + '\n',
        );
        const redacted = JSON.parse(
          redactConversation(record, [...command.secrets, '']).toString(),
        );
        assert.equal(JSON.parse(redacted.output).authorization, '[REDACTED]');
      }
      await runner.start();
      const ledger = new LocalLedger({
        directory,
        binding: {
          baseUrl: config.baseUrl,
          projectId: config.projectId,
          sourceId: sha256Hex(source),
        },
      });
      const id = 'launch_' + sha256Hex(session.id).slice(0, 32);
      const deadline = Date.now() + 5_000;
      while (!terminalLaunch(ledger.get(id)!)) {
        assert.ok(Date.now() < deadline, 'harness must exit');
        await delay(20);
      }
      const record = ledger.get(id)!;
      assert.equal(record.exitCode, 0);
      assert.ok(record.commandHash, 'an actual supervised command ran');
      const rollout = join(
        record.runDirectory,
        'codex-home',
        'sessions',
        '2026',
        '11',
        '08',
        `rollout-fixture-${conversationId}.jsonl`,
      );
      const raw = readFileSync(rollout);
      assert.ok(raw.includes(basic), 'the harness recorded the real launch credential');
      const stdout = readFileSync(join(record.runDirectory, 'stdout.log'));
      for (const secret of secrets.slice(1)) assert.ok(!stdout.includes(secret));
      if (mode !== 'live') {
        // Crash image before settle: raw harness history and the durable ledger, without
        // the controller's memory. Stop the original before restoring that image.
        const backup = join(root, 'crash.sqlite');
        const db = new DatabaseSync(ledger.path);
        db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
        db.close();
        ledger.close();
        await runner.stop();
        copyFileSync(backup, join(directory, 'ledger.sqlite'));
        mkdirSync(dirname(rollout), { recursive: true });
        writeFileSync(rollout, raw);
        puts.clear();
        closed = 0;
        session.status = 'active';
        runner = make();
        await runner.start();
      } else ledger.close();
      for (
        let tries = 0;
        tries < 50 &&
        (!closed ||
          !puts.has('transcript') ||
          (mode !== 'restart-private' && !puts.has('conversation')));
        tries++
      ) {
        await runner.tick();
        await delay(20);
      }
      assert.ok(closed, 'the workspace finishes even if conversation retention is refused');
      assert.ok(puts.has('transcript'), 'already redacted stdout remains deliverable');
      const printed = puts.get('transcript')!.toString().trim().split('\n').at(-1)!;
      const printedOutput = JSON.parse(JSON.parse(printed).payload.output);
      assert.equal(printedOutput.git, '[REDACTED]');
      assert.equal(printedOutput.basic, 'Authorization: Basic [REDACTED]');
      if (native) assert.equal(printedOutput.native, '[REDACTED]');
      if (mode === 'restart-private') assert.equal(puts.has('conversation'), false);
      else {
        const kept = puts.get('conversation')!.toString();
        assert.ok(kept.includes('useful result'));
        assert.doesNotThrow(() => JSON.parse(kept.trim()));
        for (const secret of secrets) assert.ok(!kept.includes(secret));
        if (native) assert.equal(JSON.parse(JSON.parse(kept).payload.output).native, '[REDACTED]');
      }
      const reopened = new LocalLedger({
        directory,
        binding: {
          baseUrl: config.baseUrl,
          projectId: config.projectId,
          sourceId: sha256Hex(source),
        },
      });
      if (mode === 'restart-private')
        assert.deepEqual(reopened.get(id)!.metadata.conversation, {
          state: 'refused',
          code: 'conversation_secrets_unavailable',
        });
      for (const secret of secrets) assert.ok(!JSON.stringify(reopened.get(id)).includes(secret));
      reopened.close();
    } finally {
      await runner.stop();
      delete process.env[credentialEnv];
      rmSync(root, { recursive: true, force: true });
    }
  }
});
