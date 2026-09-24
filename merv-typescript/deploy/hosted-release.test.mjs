import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  GATES,
  classify,
  describePlan,
  finalLane,
  ledgerRow,
  pinProblems,
  releaseEntry,
  releaseId,
  rollbackSteps,
  unsettled,
  wranglerConfig,
} from './hosted-release.mjs';

const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const state = read('hosted-release.json');
const template = read('hosted-wrangler.json');
const LIVE_EXECUTABLE = 'b3f871dcee261fd66d6ccdbbe4d8e589a8ef1014646c920087da4bbc866da49d';
const image = (hex) => `registry.cloudflare.com/acct/merv-hosted-codex@sha256:${hex.repeat(64)}`;
const settled = {
  name: template.containers[0].name,
  image: state.current.image,
  version: 14,
  maxInstances: 50,
  ssh: false,
  keys: 0,
  rollout: null,
  health: {
    errors: [],
    instances: { active: 0, failed: 0, scheduling: 0, starting: 0, healthy: 7 },
  },
};

test('changed paths pick the lane and its gates', () => {
  assert.equal(classify([]), 'none');
  assert.equal(classify(['packages/pi/src/worker.ts', 'package-lock.json']), 'worker');
  assert.equal(
    classify(['packages/pi/src/worker.ts', 'scripts/hosted-runner/start-runtime.py']),
    'boundary',
  );
  assert.equal(classify(['packages/runner/src/supervisor.mjs']), 'boundary');
  assert.equal(classify([], ['scripts/hosted-runner/Dockerfile']), 'base');
  assert.deepEqual(GATES.worker, ['linux-pi-gate.py']);
  assert.deepEqual(GATES.boundary, [
    'linux-pi-gate.py',
    'linux-workflow-gate.py',
    'linux-isolation-probe-gate.mjs',
  ]);
});

test('the installed-file diff decides between current, worker-only and the boundary', () => {
  const worker = ['/opt/merv/pi/worker-main.mjs'];
  assert.equal(finalLane('worker', { changed: [], configChanged: false }), 'none');
  assert.equal(finalLane('worker', { changed: worker, configChanged: false }), 'worker');
  assert.equal(finalLane('boundary', { changed: worker, configChanged: false }), 'boundary');
  assert.equal(
    finalLane('worker', {
      changed: [...worker, '/opt/merv/runner/smoke-supervisor.mjs'],
      configChanged: false,
    }),
    'boundary',
  );
  assert.equal(finalLane('worker', { changed: worker, configChanged: true }), 'boundary');
  assert.equal(finalLane('worker', { changed: [], configChanged: true }), 'boundary');
});

test('release ids match the live Sandboxes catalog and require a digest', () => {
  const entry = releaseEntry(state.current.image, LIVE_EXECUTABLE);
  assert.equal(
    releaseId(entry),
    'rt1_ae4b27ada35598ec5f4fa688373de3a45fe6c0c9eaf53db13597872ef1d5b608',
  );
  assert.equal(releaseId(entry), state.current.releaseId);
  assert.deepEqual(Object.keys(entry).sort(), [
    'arguments',
    'enrollment_timeout_seconds',
    'executable',
    'executable_sha256',
    'image_digest',
    'provider',
  ]);
  assert.throws(() =>
    releaseEntry('registry.cloudflare.com/acct/merv-hosted-codex:latest', LIVE_EXECUTABLE),
  );
  assert.throws(() => releaseEntry(image('a'), 'not-a-hash'));
});

test('the wrangler config changes only the image and the Worker path', () => {
  const config = wranglerConfig(template, image('c'), '/abs/worker/src/index.ts');
  assert.deepEqual(
    { ...config, main: template.main, containers: [{ ...config.containers[0], image: '' }] },
    template,
  );
  assert.equal(config.containers[0].image, image('c'));
  assert.equal(config.main, '/abs/worker/src/index.ts');
  assert.equal(config.containers[0].max_instances, 50);
  assert.deepEqual(config.containers[0].ssh, { enabled: false, port: 2223 });
  assert.throws(() => wranglerConfig(template, 'registry.cloudflare.com/acct/x:latest', '/w'));
  const withKey = {
    ...template,
    containers: [{ ...template.containers[0], authorized_keys: ['ssh-ed25519 AAAA'] }],
  };
  assert.throws(() => wranglerConfig(withKey, image('c'), '/w'));
  const withSsh = {
    ...template,
    containers: [{ ...template.containers[0], ssh: { enabled: true } }],
  };
  assert.throws(() => wranglerConfig(withSsh, image('c'), '/w'));
});

test('native verification waits for the pinned image to settle and flags drift', () => {
  const expect = {
    image: state.current.image,
    minVersion: 14,
    name: settled.name,
    maxInstances: 50,
  };
  assert.deepEqual(unsettled(settled, expect), []);
  assert.deepEqual(unsettled({ ...settled, version: 13 }, expect), ['version 13 < 14']);
  const moving = {
    ...settled,
    rollout: 'rollout-1',
    health: { errors: [], instances: { ...settled.health.instances, scheduling: 3 } },
  };
  assert.deepEqual(unsettled(moving, expect), ['rollout in progress', 'scheduling 3']);
  assert.ok(unsettled({ ...settled, ssh: true }, expect).length);
  const pre = {
    native: settled,
    mainReleaseId: state.current.releaseId,
    fileReleaseId: state.current.releaseId,
  };
  const live = { ...pre, catalog: [state.current.image.split('@')[1]] };
  assert.deepEqual(pinProblems(state.current, template, live), []);
  assert.deepEqual(
    pinProblems(state.current, template, { ...live, mainReleaseId: 'rt1_x', catalog: [] }),
    ['Main runs rt1_x', 'the Sandboxes catalog lacks the live digest'],
  );
  // Pre-warmed or transient launches do not block the drift check; only the settle wait.
  const busy = {
    ...live,
    native: { ...settled, health: { errors: [], instances: { starting: 1 } } },
  };
  assert.deepEqual(pinProblems(state.current, template, busy), []);
});

test('rollback undoes exactly what was attempted, then verifies with a canary', () => {
  const previous = { image: image('a'), releaseId: 'rt1_old' };
  assert.deepEqual(rollbackSteps({}, previous), []);
  assert.deepEqual(rollbackSteps({ deployAttempted: true }, previous), [
    ['deploy', previous.image],
    ['canary', 'rt1_old'],
  ]);
  assert.deepEqual(rollbackSteps({ deployAttempted: true, switched: true }, previous), [
    ['deploy', previous.image],
    ['switch', 'rt1_old'],
    ['canary', 'rt1_old'],
  ]);
});

test('ledger rows and the dry-run plan carry pins, never secrets', () => {
  const row = ledgerRow({
    at: '2026-09-25T10:11:12.000Z',
    run: '20260925T101112Z-abcdef12',
    sourceCommit: 'abcdef1234567890',
    contentSha256: '0123456789abcdef',
    lane: 'boundary',
    image: image('d'),
    releaseId: `rt1_${'e'.repeat(64)}`,
    version: 15,
    gates: '3 pass',
    canary: 'completed in 52s',
    result: 'FAILED',
    note: 'switch: health_timeout | detail\nsecond line',
  });
  assert.equal(
    row,
    '| 2026-09-25T10:11Z | `20260925T101112Z-abcdef12` | `abcdef12` `0123456789ab` | boundary | `dddddddddddd` | `eeeeeeeeeeee` | v15 | 3 pass | completed in 52s | FAILED | switch: health_timeout   detail second line |\n',
  );
  const plan = {
    run: 'r',
    sourceCommit: 'f'.repeat(40),
    changed: ['scripts/hosted-runner/start-runtime.py'],
    lane: 'boundary',
    current: state.current,
  };
  const text = describePlan(plan);
  assert.match(text, /lane {6}supervisor\/bootstrap boundary/);
  assert.match(text, /linux-pi-gate\.py, linux-workflow-gate\.py, linux-isolation-probe-gate\.mjs/);
  assert.doesNotMatch(describePlan({ ...plan, lane: 'none', changed: [] }), /gates/);
});

test(
  '--dry-run prints the plan and touches nothing',
  { skip: !hasCommit(state.current.sourceCommit) },
  () => {
    const result = spawnSync(
      process.execPath,
      [
        new URL('hosted-release.mjs', import.meta.url).pathname,
        '--dry-run',
        '--host',
        'unreachable.invalid',
      ],
      {
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^hosted release \d{8}T\d{6}Z-[0-9a-f]{8}$/m);
    assert.match(
      result.stdout,
      /lane {6}(none|worker-only|supervisor\/bootstrap boundary|base image: refused)/,
    );
    assert.doesNotMatch(result.stdout + result.stderr, /sbxt_|mk_[A-Za-z0-9]|Bearer |password/i);
  },
);

function hasCommit(commit) {
  return spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`]).status === 0;
}

// The catalog and env edits run as root on the host, in Python; their pure parts are tested here.
const vm = new URL('hosted-release-vm.py', import.meta.url).pathname;
const python = (body, input) => {
  const code = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('vm',${JSON.stringify(vm)})
vm=importlib.util.module_from_spec(spec);spec.loader.exec_module(vm)
i=json.load(sys.stdin)
${body}`;
  const r = spawnSync('python3', ['-c', code], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test('the catalog edit appends to both services, keeps earlier releases and is idempotent', () => {
  const release = (hex) => ({
    ...releaseEntry(image(hex), LIVE_EXECUTABLE),
    provider: 'cloudflare-fleet',
  });
  const services = (list) => ({
    services: Object.fromEntries(
      ['control', 'pipelines-worker'].map((name) => [
        name,
        { environment: { SANDBOXES_RUNTIME_RELEASES: JSON.stringify(list), OTHER: 'kept' } },
      ]),
    ),
  });
  const edit =
    'd,c=vm.with_release(i["doc"],i["entry"],keep=i.get("keep",16),protect=i.get("protect",()));print(json.dumps([d,c]))';
  const [doc, changed] = python(edit, {
    doc: services([release('1'), release('2')]),
    entry: release('3'),
  });
  assert.equal(changed, true);
  for (const service of Object.values(doc.services)) {
    assert.deepEqual(JSON.parse(service.environment.SANDBOXES_RUNTIME_RELEASES), [
      release('1'),
      release('2'),
      release('3'),
    ]);
    assert.equal(service.environment.OTHER, 'kept');
  }
  assert.deepEqual(python(edit, { doc, entry: release('3') }), [doc, false]);
  // Beyond `keep`, the oldest go first, but never the release Main still runs.
  const [pruned] = python(edit, {
    doc,
    entry: release('4'),
    keep: 2,
    protect: [release('1').image_digest],
  });
  const kept = JSON.parse(pruned.services.control.environment.SANDBOXES_RUNTIME_RELEASES);
  assert.deepEqual(kept, [release('1'), release('3'), release('4')]);
  const split = services([release('1')]);
  split.services['pipelines-worker'].environment.SANDBOXES_RUNTIME_RELEASES = '[]';
  const refused = spawnSync(
    'python3',
    [
      '-c',
      `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('vm',${JSON.stringify(vm)})
vm=importlib.util.module_from_spec(spec);spec.loader.exec_module(vm)
vm.with_release(json.load(sys.stdin),{})`,
    ],
    { input: JSON.stringify(split), encoding: 'utf8' },
  );
  assert.match(refused.stderr, /catalog_services_differ/);
});

test('the env edit replaces exactly one release id line', () => {
  const raw = 'A=1\nMERV_FLEET_RUNTIME_RELEASE_ID=rt1_old\nB=\'{"x":1}\'\n';
  const out = python(
    'print(json.dumps(vm.with_env(i.encode(),"MERV_FLEET_RUNTIME_RELEASE_ID","rt1_new").decode()))',
    raw,
  );
  assert.equal(out, 'A=1\nMERV_FLEET_RUNTIME_RELEASE_ID=rt1_new\nB=\'{"x":1}\'\n');
  const twice = spawnSync(
    'python3',
    [
      '-c',
      `import importlib.util
spec=importlib.util.spec_from_file_location('vm',${JSON.stringify(vm)})
vm=importlib.util.module_from_spec(spec);spec.loader.exec_module(vm)
vm.with_env(b'K=1\\nK=2\\n','K','3')`,
    ],
    { encoding: 'utf8' },
  );
  assert.match(twice.stderr, /env_key_not_unique/);
});
