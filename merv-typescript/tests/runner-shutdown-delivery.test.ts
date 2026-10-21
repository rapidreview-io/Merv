import { sha256Hex } from '@merv/contracts';
import { MachineRunner } from '@merv/runner';
import { LocalLedger } from '@merv/runner/ledger';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

/** A released visit with durable files still owed, as at the hosted gate's SIGTERM. */
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'merv-shutdown-delivery-')));
  const directory = join(root, 'runner');
  const assignments = join(root, 'assignments');
  mkdirSync(assignments, { mode: 0o700 });
  const credentialEnv = `MERV_SHUTDOWN_TEST_${randomUUID().replaceAll('-', '')}`;
  const source = `mr_${'1'.repeat(64)}`;
  process.env[credentialEnv] = source;
  const baseUrl = 'http://127.0.0.1:12345';
  const sessionId = 'session_shutdown';
  const files = {
    transcript: Buffer.from('The completed visit printed this.\n'),
    conversation: Buffer.from('{"type":"response_item","payload":{"text":"kept turn"}}\n'),
  };
  const facts = (kind: keyof typeof files) => ({
    sha256: sha256Hex(files[kind]),
    size: files[kind].length,
  });
  const ledger = new LocalLedger({
    directory,
    binding: { baseUrl, projectId: 'project_shutdown', sourceId: sha256Hex(source) },
  });
  const record = ledger.reserve({
    id: 'launch_shutdown',
    sessionId,
    deadline: Date.now() + 60_000,
    metadata: {
      session: { instanceId: 'work_shutdown' },
      remoteClosed: true,
      usageReported: true,
      transcript: { state: 'owed', ...facts('transcript') },
      conversation: {
        state: 'owed',
        ...facts('conversation'),
        harness: 'codex',
        conversationId: randomUUID(),
      },
    },
  });
  writeFileSync(join(record.runDirectory, 'stdout.log'), files.transcript);
  writeFileSync(join(record.runDirectory, 'conversation.jsonl'), files.conversation);
  ledger.end(record.id, 'exit', 'reserved');
  ledger.close();

  let releasePut!: () => void;
  const hold = new Promise<void>((resolve) => {
    releasePut = resolve;
  });
  let aborted = false;
  let leases = 0;
  const puts: string[] = [];
  const confirmed = new Set<string>();
  const stored = new Set<string>();
  const runner = new MachineRunner(
    {
      directory,
      baseUrl,
      projectId: 'project_shutdown',
      credentialEnv,
      capacity: 1,
      workInstanceId: 'work_shutdown',
      assignmentWorkspaceDirectory: assignments,
      profiles: [
        {
          name: 'worker',
          harness: 'codex',
          executable: '/bin/false',
          isolatedLauncher: '/bin/false',
          hosted: true,
          enabled: true,
          parallelism: 1,
        },
      ],
    },
    {
      autoPoll: false,
      resetAssignment: async () => {},
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
        if (path === '/sessions/runners/heartbeat')
          return Response.json({
            runner: {
              runnerId: body.runnerId,
              desiredVersion: 0,
              desiredSettings: { platforms: [] },
            },
          });
        if (path === '/sessions/lease') {
          leases++;
          return Response.json({ session: null, reason: 'no_candidates' });
        }
        const kind = path.split('/').at(-1) as keyof typeof files;
        assert.ok(kind in files, `Unexpected request ${path}`);
        if (init?.method === 'PUT') {
          puts.push(kind);
          assert.deepEqual(Buffer.from(init.body as Uint8Array), files[kind]);
          if (puts.length === 1)
            await Promise.race([
              hold,
              new Promise<never>((_, reject) =>
                init.signal!.addEventListener(
                  'abort',
                  () => {
                    aborted = true;
                    reject(init.signal!.reason);
                  },
                  { once: true },
                ),
              ),
            ]);
          stored.add(kind);
          return new Response(null, { status: 200 });
        }
        assert.equal(body.deliver, true);
        if (stored.has(kind)) confirmed.add(kind);
        return Response.json({
          [kind]: {
            sessionId,
            ...facts(kind),
            uploadedAt: stored.has(kind) ? new Date().toISOString() : null,
            upload: {
              url: `${baseUrl}/store/${kind}`,
              headers: {},
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          },
        });
      },
    },
  );
  t.after(async () => {
    await runner.stop();
    releasePut();
    delete process.env[credentialEnv];
    rmSync(root, { recursive: true, force: true });
  });
  return { runner, releasePut, puts, confirmed, leases: () => leases, aborted: () => aborted };
}

test('planned shutdown drains owed transcript and conversation without admitting another visit', async (t) => {
  const f = fixture(t);
  await f.runner.start();
  assert.deepEqual(f.puts, ['transcript']);
  await assert.rejects(f.runner.prepareShutdown(), /not fully settled/);
  f.releasePut();
  let receipt;
  for (let tries = 0; tries < 30 && !receipt; tries++) {
    await delay(10);
    await f.runner.tick();
    try {
      receipt = await f.runner.prepareShutdown();
    } catch (error) {
      assert.match(String(error), /not fully settled/);
    }
  }
  assert.deepEqual(receipt, { captures: [], empty: true });
  assert.deepEqual(f.puts, ['transcript', 'conversation']);
  assert.deepEqual([...f.confirmed], ['transcript', 'conversation']);
  assert.equal(f.runner.snapshot().launches[0]!.transcriptPending, false);
  assert.equal(f.leases(), 0);
  assert.equal(f.aborted(), false);
});

test('ordinary stop after a pending planned shutdown aborts upload and preserves owed delivery', async (t) => {
  const f = fixture(t);
  await f.runner.start();
  assert.deepEqual(f.puts, ['transcript']);
  await assert.rejects(f.runner.prepareShutdown(), /not fully settled/);
  await f.runner.stop();
  await assert.rejects(f.runner.prepareShutdown(), /Runner must be open/);
  assert.equal(f.aborted(), true);
  assert.deepEqual(f.puts, ['transcript']);
  assert.equal(f.confirmed.size, 0);
  assert.equal(f.runner.snapshot().launches[0]!.transcriptPending, true);
  assert.equal(f.leases(), 0);
});
