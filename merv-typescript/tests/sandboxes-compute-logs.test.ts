import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SandboxService } from '../packages/sandboxes/src/index.js';

async function fixture(t: test.TestContext) {
  const tokenEnv = 'MERV_NATIVE_COMPUTE_TEST_GRANT';
  const urlEnv = 'MERV_NATIVE_COMPUTE_TEST_URL';
  process.env[tokenEnv] = 'sbxt_native_test_grant';
  process.env[urlEnv] = 'https://sandbox.example';
  t.after(() => {
    delete process.env[tokenEnv];
    delete process.env[urlEnv];
  });
  let submitted: any;
  const submissions: any[] = [];
  let refusal: 'native_conflict' | 'all_conflict' | 'unavailable' | undefined;
  let workflow: any = { state: 'running', nodes: { run: { result: { job_id: 'job_native' } } } };
  let job: any = {
    name: 'merv-compute-v2',
    state: 'running',
    exit_code: null,
    outputs: [
      { stream: 'stdout', total_length: 12000, available_start: 100, complete: false },
      { stream: 'stderr', total_length: 5, available_start: 0, complete: false },
    ],
  };
  let expired = false;
  const reads: URL[] = [];
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  t.mock.method(globalThis, 'fetch', async (input: any, init: any) => {
    const url = new URL(String(input));
    assert.equal(new Headers(init?.headers).get('x-sandbox-subject'), 'project_a');
    if (url.pathname === '/v1/auth/me') return json({ role: 'consumer', namespace: 'merv-ml' });
    if (url.pathname === '/v1/workflows' && init.method === 'POST') {
      submitted = JSON.parse(init.body);
      submissions.push(submitted);
      if (refusal === 'unavailable') return json({ error: { code: 'provider_unavailable' } }, 503);
      if (
        refusal === 'all_conflict' ||
        (refusal === 'native_conflict' &&
          submitted.nodes.find((node: any) => node.id === 'run').job.name)
      )
        return json(
          {
            error: {
              code: 'idempotency_conflict',
              message: 'workflow idempotency key has different inputs',
            },
          },
          409,
        );
      return json({ id: 'pipe_native' });
    }
    if (url.pathname === '/v1/workflows/pipe_native') return json(workflow);
    if (url.pathname === '/v1/jobs/job_native') return json(job);
    if (url.pathname === '/v1/jobs/job_native/output') {
      reads.push(url);
      if (expired)
        return json(
          { error: { code: 'output_expired', details: { available_start: 20000 } } },
          409,
        );
      const size = Number(url.searchParams.get('end')) - Number(url.searchParams.get('start'));
      return new Response('x'.repeat(size), {
        headers: { 'content-type': 'application/octet-stream' },
      });
    }
    throw new Error(`Unexpected route ${url.pathname}`);
  });
  // Exercise the capability exposed to plugins, not just the internal adapter.
  const service = new SandboxService({
    urlEnv,
    timeoutMs: 1000,
    refreshMs: 60_000,
    connections: [{ projectId: 'project_a', namespace: 'ordinary', tokenEnv }],
    ml: {
      namespace: 'merv-ml',
      tokenEnv,
      since: '2000-01-01T00:00:00Z',
      storageOrigins: [],
    },
  });
  t.after(() => service.close());
  assert.ok(service.compute?.logs, 'Configured Sandboxes service must expose compute logs');
  const adapter = { ...service.compute, logs: service.compute.logs };
  return {
    adapter,
    reads,
    submissions,
    refuse: (value: typeof refusal) => {
      refusal = value;
    },
    get submitted() {
      return submitted;
    },
    workflow: (value: any) => {
      workflow = value;
    },
    job: (value: any) => {
      job = value;
    },
    expire: () => {
      expired = true;
    },
  };
}

test('new compute shell preserves command quoting, native exit and live stdout/stderr without a result file', async (t) => {
  const f = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), 'merv-native-compute-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // This stand-in only forwards argv: the assertion exercises our exact shell quoting,
  // stream inheritance and exit propagation without waiting a real five-minute timeout.
  await writeFile(join(dir, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 });
  await f.adapter.submit('project_a', {
    experimentId: 'exp_one',
    idempotencyKey: 'native',
    provider: 'test',
    offerId: 'gpu',
    command: `printf '%s\\n' "a 'quoted' value"; printf 'error\\n' >&2; exit 7`,
    minutes: 5,
    maxUsd: 1,
  });
  const run = f.submitted.nodes.find((node: any) => node.id === 'run');
  assert.equal(run.job.name, 'merv-compute-v2');
  assert.equal(run.job.timeout_seconds, 600);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH}` };
  delete env.SBX_RESULT_PATH;
  const result = spawnSync('sh', ['-c', run.job.command], { env, encoding: 'utf8' });
  assert.equal(result.status, 7);
  assert.equal(result.stdout, "a 'quoted' value\n");
  assert.equal(result.stderr, 'error\n');
  await assert.rejects(access(join(dir, 'merv-run', 'out.log')));
});

test('a lost legacy admission reply recovers the exact old request under the same key; unrelated failures do not retry', async (t) => {
  const f = await fixture(t);
  const spec = {
    experimentId: 'exp_one',
    idempotencyKey: 'already-admitted',
    provider: 'test',
    offerId: 'gpu',
    command: 'exit 9',
    minutes: 5,
    maxUsd: 1,
    outputs: { files: [{ name: 'evidence', path: '/tmp/evidence.txt' }], maxBytes: 100 },
  };
  f.refuse('native_conflict');
  assert.equal(await f.adapter.submit('project_a', spec), 'pipe_native');
  assert.equal(f.submissions.length, 2);
  const [native, legacy] = f.submissions;
  const legacyRun = legacy.nodes.find((node: any) => node.id === 'run');
  assert.deepEqual(legacyRun.job, {
    timeout_seconds: 600,
    command: [
      'set -u',
      '[ -n "${SBX_RESULT_PATH:-}" ] || exit 125',
      'd="$HOME/merv-run"',
      'mkdir -p "$d" || exit 121',
      'cd "$d" || exit 121',
      "timeout 300 sh -c 'exit 9' >out.log 2>&1; code=$?",
      `printf '{"exit":%s,"bytes":%s,"head64":"%s","tail64":"%s"}' "$code" "$(wc -c <out.log | tr -d ' ')" "$(head -c 8000 out.log | base64 | tr -d '\\n')" "$(tail -c 8000 out.log | base64 | tr -d '\\n')" > "$SBX_RESULT_PATH"`,
      'exit 0',
    ].join('\n'),
  });
  native.nodes.find((node: any) => node.id === 'run').job = legacyRun.job;
  assert.deepEqual(
    native,
    legacy,
    'only the execution protocol changes; same key, inputs and capture graph',
  );
  f.refuse('all_conflict');
  await assert.rejects(f.adapter.submit('project_a', spec), {
    code: 'sandbox_idempotency_conflict',
  });
  assert.equal(f.submissions.length, 4, 'a genuine input mismatch is not retried indefinitely');
  f.refuse('unavailable');
  await assert.rejects(f.adapter.submit('project_a', spec), {
    code: 'sandbox_provider_unavailable',
  });
  assert.equal(
    f.submissions.length,
    5,
    'an unavailable service does not trigger a second admission',
  );
});

test('native outcomes ignore custom result JSON; legacy and idempotency-recovered jobs retain inner exits', async (t) => {
  const f = await fixture(t);
  f.workflow({ state: 'failed', nodes: { run: { result: { job_id: 'job_native' } } } });
  f.job({
    name: 'merv-compute-v2',
    state: 'failed',
    exit_code: 7,
    result: { exit: 0, head64: 'b2s=' },
  });
  assert.deepEqual((await f.adapter.get('project_a', 'pipe_native')).result, { exit: 7 });
  assert.equal(f.reads.length, 0, 'routine status must not fetch or inject log content');
  f.job({
    name: 'legacy-wrapper',
    exit_code: 0,
    result: { exit: 127, bytes: 3, head64: 'YmFk', tail64: 'YmFk', name: 'merv-compute-v2' },
  });
  assert.deepEqual((await f.adapter.get('project_a', 'pipe_native')).result, {
    exit: 127,
    bytes: 3,
    head: 'bad',
    tail: 'bad',
  });
  f.job({ name: 'merv-compute-v2', state: 'cancelled', exit_code: null, result: { exit: 0 } });
  assert.equal(
    (await f.adapter.get('project_a', 'pipe_native')).result,
    null,
    'no inferred success without a native exit',
  );
});

test('live logs read bounded tails, report retention races and explain legacy buffering', async (t) => {
  const f = await fixture(t);
  const logs: any = await f.adapter.logs('project_a', 'pipe_native');
  assert.equal(logs.state, 'running');
  assert.equal(logs.mode, 'native');
  assert.equal(logs.streams.stdout.text.length, 8000);
  assert.equal(logs.streams.stdout.start, 4000);
  assert.equal(logs.streams.stdout.truncated, true);
  assert.equal(logs.streams.stderr.text.length, 5);
  assert.equal(logs.streams.stderr.complete, false);
  for (const url of f.reads) assert.ok(Number(url.searchParams.get('max_bytes')) <= 8000);
  f.expire();
  const unavailable: any = await f.adapter.logs('project_a', 'pipe_native');
  assert.ok(unavailable.streams.stdout.unavailable);
  assert.equal(
    unavailable.streams.stdout.text,
    undefined,
    'an expired log is not an empty successful read',
  );
  f.job({ name: 'legacy-wrapper', state: 'running', outputs: [] });
  const old: any = await f.adapter.logs('project_a', 'pipe_native');
  assert.equal(old.mode, 'legacy');
  assert.match(old.notice, /buffers command output/);
  f.workflow({ state: 'running', nodes: {} });
  assert.deepEqual(await f.adapter.logs('project_a', 'pipe_native'), {
    state: 'running',
    mode: 'pending',
  });
});
