import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { request, operator, preflight, proofs, collect } from './hosted-native-acceptance.mjs';

test('immutable request carries the exact probe within the real service text limit', async () => {
  const source = await readFile(
    new URL('../scripts/hosted-runner/native-acceptance-probe.py', import.meta.url),
  );
  const payload = request('oct21', source);
  const encoded = /b64decode\('([^']+)'\)/.exec(payload.details)[1];
  assert.deepEqual(gunzipSync(Buffer.from(encoded, 'base64')), source);
  assert.ok(payload.details.length < 16000);
  assert.deepEqual(payload, request('oct21', source));
  assert.throws(() => request('bad;run', source));
});

test('embedded probe ignores checkout imports, Python environment and PATH shadowing', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'merv-probe-shadow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkout = join(directory, 'checkout');
  const environment = join(directory, 'environment');
  const clean = join(directory, 'clean');
  const bin = join(directory, 'bin');
  await Promise.all([checkout, environment, clean, bin].map((path) => mkdir(path)));
  const forged = JSON.stringify({ passed: true, forged: true });
  const module = `import sys\nprint(${JSON.stringify(forged)})\nsys.exit(0)\n`;
  await Promise.all([
    writeFile(join(checkout, 'base64.py'), module),
    writeFile(join(environment, 'base64.py'), module),
    writeFile(join(environment, 'sitecustomize.py'), module),
    writeFile(join(bin, 'python3'), `#!/bin/sh\nprintf '%s\\n' '${forged}'\n`, { mode: 0o755 }),
  ]);
  const source = await readFile(
    new URL('../scripts/hosted-runner/native-acceptance-probe.py', import.meta.url),
  );
  const command = request('shadow', source)
    .details.split('\n')
    .find((line) => /^(?:\/usr\/bin\/)?python3 /.test(line))
    .replace('--stage STAGE', '--stage planner');
  for (const attack of [
    { cwd: checkout, env: {} },
    { cwd: clean, env: { PYTHONPATH: environment } },
    { cwd: clean, env: { PATH: bin } },
  ]) {
    const result = spawnSync('/bin/sh', ['-c', command], {
      cwd: attack.cwd,
      env: { PATH: '/usr/bin:/bin', ...attack.env },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    const proof = JSON.parse(result.stdout);
    assert.equal(proof.passed, false);
    assert.equal(proof.stage, 'planner');
    assert.ok(
      ['linux_required', 'assignment_identity_invalid', 'assignment_path_invalid'].includes(
        proof.code,
      ),
    );
    assert.equal(proof.forged, undefined);
  }
});

test('operator uses public HTTPS, project scope and nonredirecting credential transport', async () => {
  const calls = [];
  const api = operator(
    'https://example.test',
    'project_test',
    'private-test-token',
    async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ result: { id: 'wf_test' } }) };
    },
  );
  assert.deepEqual(await api.tool('experiment.write', { action: 'create' }), { id: 'wf_test' });
  assert.equal(calls[0].url.pathname, '/tools/experiment.write');
  assert.equal(calls[0].options.headers['x-merv-project-id'], 'project_test');
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].options.body), { action: 'create', create: {} });
  await assert.rejects(api.tool('review.write', { action: 'submit' }));
  await assert.rejects(api.get('/\\outside.test/path'));
  assert.throws(() => operator('http://example.test', 'project_test', 'secret'));
  assert.throws(() => operator('https://example.test/path', 'project_test', 'secret'));
});

test('preflight rejects changed image, runtime, maintenance and existing work, including PG bigint strings', () => {
  const good = {
    complete: true,
    mainContainer: { imageId: 'sha256:test', health: 'healthy', nativeGitProtocol: '1' },
    settings: {
      maintenance: false,
      profiles: [
        {
          key: 'standard',
          provider: 'cloudflare-fleet',
          releaseId: 'rt1_test',
          profileId: 'srp_test',
        },
      ],
    },
    main: {
      dispatch: [{ enabled: '1', own_machines: '0' }],
      activity: { unfinished_workflows: '0', active_sessions: '0' },
    },
  };
  preflight(good, 'sha256:test', 'rt1_test', true);
  for (const change of [
    (s) => (s.settings.maintenance = true),
    (s) => (s.mainContainer.imageId = 'other'),
    (s) => (s.settings.profiles[0].releaseId = 'other'),
    (s) => (s.main.activity.unfinished_workflows = '1'),
    (s) => (s.main.allocations = [{ profile_id: 'other' }]),
    (s) => (s.complete = false),
  ]) {
    const bad = structuredClone(good);
    change(bad);
    assert.throws(() => preflight(bad, 'sha256:test', 'rt1_test', true));
  }
});

test('only untruncated actual tool output is collected as a candidate proof, never prose', () => {
  const proof = {
    passed: true,
    formatVersion: 1,
    prefix: 'acceptance-test',
    launcher: { launchId: 'launch' },
    checkout: { markers: {} },
  };
  const event = { kind: 'tool_result', output: JSON.stringify(proof) };
  const page = {
    visits: [
      {
        sessionId: 'session_test',
        events: [
          { seq: 1, event },
          { seq: 2, event: { ...event, kind: 'text' } },
          { seq: 3, event: { ...event, cut: 1 } },
          { seq: 4, event: { ...event, error: true } },
        ],
      },
    ],
  };
  assert.equal(proofs([page, page], 'acceptance-test').length, 1);
  assert.equal(proofs([page], 'acceptance-other').length, 0);
});

test('evidence collection paginates retained conversations and never claims acceptance or mutates work', async () => {
  const calls = [];
  const api = {
    tool: async (name, input) => {
      calls.push([name, input]);
      assert.ok(name.endsWith('.read'));
      if (input.history) return { items: [{ reviewId: 'review_test' }], next: null };
      if (name === 'session.read') return { messages: [], questions: [] };
      return {};
    },
    get: async (path) => {
      calls.push([path]);
      if (path.startsWith('/sessions/threads?'))
        return { threads: [{ id: 'thread_test', visits: [{ sessionId: 'session_test' }] }] };
      if (path.includes('conversation'))
        return {
          visits: [{ sessionId: 'session_test', events: [] }],
          next: path.includes('before=') ? null : 'session_test:7',
        };
      return { session: { id: 'session_test' } };
    },
  };
  const evidence = await collect(api, { instanceId: 'wf_test', runId: 'test' }, {});
  assert.equal(evidence.conversations.length, 2);
  assert.equal(evidence.acceptanceComplete, false);
  assert.ok(calls.some(([name]) => name === 'review.read'));
  assert.deepEqual(evidence.sessions, [{ id: 'session_test' }]);
});
