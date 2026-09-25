// Drives the real hosted-release.mjs end to end against a fake host (an ssh on PATH that plays
// hosted-release-vm.py's steps from a JSON file) and a fake wrangler. The repository is a
// committed snapshot of this working tree, so the pipeline's own clean-tree check passes.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseEntry, releaseId } from './hosted-release.mjs';

const merv = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const T = mkdtempSync(join(tmpdir(), 'merv-hosted-run-'));
const git = (cwd, ...a) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], {
    encoding: 'utf8',
  }).trim();
const repo = join(T, 'repo');
const sandboxes = join(T, 'sandboxes');
const REGISTRY = 'registry.cloudflare.com/acct/merv-hosted-codex';
const LIVE = { image: `${REGISTRY}@sha256:${'a'.repeat(64)}`, localId: `sha256:${'1'.repeat(64)}` };
LIVE.releaseId = releaseId(releaseEntry(LIVE.image, 'b'.repeat(64)));
const NEXT = `${REGISTRY}@sha256:${'d'.repeat(64)}`;
const NEXT_ID = releaseId(releaseEntry(NEXT, 'e'.repeat(64)));
const NATIVE = {
  name: 'merv-fleet-codex-20260923-sandboxcontainer',
  image: LIVE.image,
  version: 14,
  maxInstances: 50,
  ssh: false,
  keys: 0,
  rollout: null,
  health: { errors: [], instances: { failed: 0, scheduling: 0, starting: 0 } },
};
// Production once a run has deployed its release and switched Main to it.
const ON_NEXT = {
  main: NEXT_ID,
  releases: { [LIVE.releaseId]: LIVE.image, [NEXT_ID]: NEXT },
  catalog: [LIVE.image.split('@')[1], NEXT.split('@')[1]],
  native: { ...NATIVE, image: NEXT, version: 15 },
};
const DEPLOYED = {
  build: {
    candidate: `sha256:${'c'.repeat(64)}`,
    lane: 'boundary',
    executableSha256: 'e'.repeat(64),
  },
  gates: { 'linux-pi-gate.py': 'pass' },
  push: { image: NEXT },
  catalog: { releaseId: NEXT_ID },
};
let c1, head;

const SSH = `#!/usr/bin/env node
const fs = require('node:fs');
const sim = JSON.parse(fs.readFileSync(process.env.SIM, 'utf8'));
const save = () => fs.writeFileSync(process.env.SIM, JSON.stringify(sim));
const event = (e) => fs.appendFileSync(process.env.SIM_LOG, e + '\\n');
// down: calls the host is out of reach for, as ssh reports it.
if (sim.down) { sim.down -= 1; save(); process.exit(255); }
const argv = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
const at = argv.indexOf('python3');
if (at < 0) { if (argv.includes('bash')) event('upload'); process.exit(0); }
if (argv[at + 1] === '-') { console.log(JSON.stringify({ state: sim.state, active: sim.active })); process.exit(0); }
const [, step, dir] = argv.slice(at + 1);
const run = dir.split('/').pop();
const R = (sim.runs[run] ??= { rec: {}, progress: {} });
const { driver, arg = {} } = JSON.parse(input || '{}');
const out = (v, record) => { if (record) R.rec[step] = v; save(); console.log(JSON.stringify(v)); process.exit(0); };
const err = (m) => { save(); console.log(JSON.stringify({ error: m })); process.exit(1); };
// staleAfter: status reads until another driver's lease reads as silent.
const counted = R.staleAfter !== undefined && R.staleAfter !== null;
if (step === 'status') {
  if (counted) R.staleAfter -= 1;
  const age = !R.lease ? null : counted ? (R.staleAfter > 0 ? 1 : 999) : (Date.now() - R.lease.seen) / 1000;
  out({ ...R.rec, progress: R.progress, open: sim.active === run, lease: R.lease ?? null, leaseAge: age });
}
event(step + ' ' + (step === 'push' ? Object.keys(arg.credential).join('+') : JSON.stringify(arg).slice(0, 200)));
const stale = counted ? R.staleAfter <= 0 : Date.now() - (R.lease?.seen ?? 0) > 300000;
if (R.lease && R.lease.driver !== driver && !stale) err('driven by another process');
R.lease = { driver, seen: Date.now() }; R.staleAfter = null;
if (!['preflight', 'finish'].includes(step) && sim.active !== run) err('run does not hold the marker');
const fail = sim.fail[step], previous = R.rec.plan?.current;
if (step === 'preflight') {
  if (sim.active && sim.active !== run) err('another run is open');
  sim.active = run; R.rec.plan = arg;
  out({ native: sim.native, mainReleaseId: sim.main, fileReleaseId: sim.main, catalog: sim.catalog }, true);
}
if (step === 'build') {
  if (fail) err(fail);
  out({ candidate: 'sha256:' + 'c'.repeat(64), lane: sim.lane, configChanged: true, changed: [], changedCount: 9,
    executableSha256: 'e'.repeat(64), inputs: ['packages/pi/src/worker.ts'] }, true);
}
if (step === 'gates') out({ 'linux-pi-gate.py': 'pass', 'linux-workflow-gate.py': 'pass' }, true);
if (step === 'push') {
  if (arg.credential?.password !== 'fake-password') err('no credential');
  out({ image: previous.image.split('@')[0] + '@sha256:' + 'd'.repeat(64) }, true);
}
if (step === 'catalog') {
  if (arg.restore) { R.progress.catalogBroken = false; out({ restored: true }); }
  sim.releases[arg.releaseId] = previous.image.split('@')[0] + '@' + arg.entry.image_digest;
  sim.catalog = [...new Set([...sim.catalog, arg.entry.image_digest])];
  out({ releaseId: arg.releaseId, changed: true }, true);
}
if (step === 'drain') out({ drained: true });
if (step === 'note') { R.progress = { ...R.progress, ...arg }; out(R.progress); }
if (step === 'native') out(sim.native);
if (step === 'switch') {
  if (fail && arg.releaseId !== previous.releaseId) err(fail);
  const changed = sim.main !== arg.releaseId; sim.main = arg.releaseId; out({ changed });
}
if (step === 'canary') {
  if (sim.releases[arg.releaseId] !== sim.native.image || sim.main !== arg.releaseId) err('canary_failed pins disagree');
  if (fail === 'all' || (fail && arg.releaseId !== previous.releaseId)) err('canary_failed {"status":"interrupted"}');
  out({ status: 'completed', seconds: 42 });
}
if (step === 'abandon') {
  const target = Object.keys(sim.releases).find((id) => sim.releases[id] === sim.native.image);
  if (sim.main !== target || !sim.catalog.includes(sim.native.image.split('@')[1]))
    err('production disagrees, so the run stays open: Main runs ' + sim.main);
  out({ releaseId: target, image: sim.native.image });
}
if (step === 'finish') {
  if (arg.state) sim.state = arg.state;
  if (sim.active === run) sim.active = null;
  out({ finished: true, result: arg.result }, true);
}
err('unknown step ' + step);
`;
const WRANGLER = `import fs from 'node:fs';
const argv = process.argv.slice(2);
const sim = JSON.parse(fs.readFileSync(process.env.SIM, 'utf8'));
if (argv[0] === 'whoami') process.exit(sim.fail.whoami ? 1 : 0);
if (argv[0] === 'containers') {
  console.log(JSON.stringify({ username: 'fake-user', password: 'fake-password' }));
  process.exit(0);
}
const config = JSON.parse(fs.readFileSync(argv[argv.indexOf('-c') + 1], 'utf8'));
const image = config.containers[0].image;
const worker = fs.readFileSync(config.main, 'utf8').trim();
fs.appendFileSync(process.env.SIM_LOG, 'wrangler ' + image.slice(-4) + ' ' + worker + '\\n');
const which = image === sim.liveImage ? 'previous' : 'next';
if (sim.fail.deploy === 'all' || sim.fail.deploy === which) process.exit(1);
const instances = { failed: sim.fail.settle === which ? 1 : 0, scheduling: 0, starting: 0 };
sim.native = { ...sim.native, image, version: sim.native.version + 1, health: { errors: [], instances } };
if (which === 'next' && sim.reboot) sim.down = sim.reboot; // the host reboots as the image lands
fs.writeFileSync(process.env.SIM, JSON.stringify(sim));
`;

before(() => {
  // A committed snapshot of this working tree, with its node_modules.
  const top = resolve(merv, '..');
  mkdirSync(join(repo, 'merv-typescript'), { recursive: true });
  const files = git(top, 'ls-files', '-co', '--exclude-standard', '--', 'merv-typescript');
  for (const file of files.split('\n').filter((f) => existsSync(join(top, f)))) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), readFileSync(join(top, file)));
  }
  symlinkSync(join(merv, 'node_modules'), join(repo, 'merv-typescript/node_modules'));
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'snapshot');
  head = git(repo, 'rev-parse', 'HEAD');
  // The Sandboxes checkout: the deployed commit, then HEAD with a changed bridge Worker.
  for (const [file, text] of [
    ['agent/main.go', 'package main'],
    ['deploy/cloudflare-sandbox/Dockerfile', 'FROM debian'],
    ['deploy/cloudflare-sandbox/worker/src/index.ts', 'worker v1'],
    ['control/src/merv_sandboxes/__init__.py', ''],
    ['control/src/merv_sandboxes/errors.py', ''],
    ['control/src/merv_sandboxes/runtimes/__init__.py', ''],
  ]) {
    mkdirSync(dirname(join(sandboxes, file)), { recursive: true });
    writeFileSync(join(sandboxes, file), text);
  }
  git(sandboxes, 'init', '-q');
  git(sandboxes, 'add', '-A');
  git(sandboxes, 'commit', '-qm', 'deployed');
  c1 = git(sandboxes, 'rev-parse', 'HEAD');
  writeFileSync(join(sandboxes, 'deploy/cloudflare-sandbox/worker/src/index.ts'), 'worker v2');
  git(sandboxes, 'commit', '-qam', 'head');
  mkdirSync(join(T, 'bin'));
  writeFileSync(join(T, 'bin/ssh'), SSH, { mode: 0o755 });
  writeFileSync(join(T, 'bin/scp'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(T, 'wrangler.mjs'), WRANGLER);
});
after(() => rmSync(T, { recursive: true, force: true }));

function simulate(name, patch = {}, { detached = false, args = [], dir } = {}) {
  dir ??= mkdtempSync(join(T, `${name}-`));
  const file = join(dir, 'sim.json');
  if (!existsSync(file))
    writeFileSync(
      file,
      JSON.stringify({
        state: {
          current: { ...LIVE, sourceCommit: '0'.repeat(40), sandboxesCommit: c1 },
          inputs: [],
        },
        active: null,
        main: LIVE.releaseId,
        releases: { [LIVE.releaseId]: LIVE.image },
        catalog: [LIVE.image.split('@')[1]],
        liveImage: LIVE.image,
        native: NATIVE,
        runs: {},
        fail: {},
        lane: 'boundary',
        ...patch,
      }),
    );
  const env = {
    ...process.env,
    PATH: `${join(T, 'bin')}:${process.env.PATH}`,
    SIM: file,
    SIM_LOG: join(dir, 'events.log'),
    MERV_HOSTED_RECORDS: dir,
    MERV_HOSTED_POLL_MS: '20',
  };
  if (detached) delete env.MERV_HOSTED_DRIVER;
  else env.MERV_HOSTED_DRIVER = '1';
  const script = join(repo, 'merv-typescript/deploy/hosted-release.mjs');
  const flags = ['--host', 'fake', '--sandboxes', sandboxes, '--wrangler', join(T, 'wrangler.mjs')];
  const r = spawnSync(process.execPath, [script, ...flags, ...args], { encoding: 'utf8', env });
  const text = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
  const events = text('events.log').split('\n').filter(Boolean);
  return {
    dir,
    status: r.status,
    out: r.stdout + r.stderr,
    sim: JSON.parse(readFileSync(file, 'utf8')),
    events,
    steps: events.map((e) => e.split(' ')[0]),
    ledger: text('HOSTED_RELEASES.md'),
    record: text('hosted-release.json'),
  };
}
// An open run whose driver fell silent, recorded up to `rec`.
const openRun = (current, progress = {}, rec = {}, sourceCommit = head) => ({
  active: 'R1',
  runs: {
    R1: {
      rec: {
        plan: { run: 'R1', sourceCommit, sandboxesCommit: c1, lane: 'boundary', current },
        preflight: { native: { version: 14 } },
        ...rec,
      },
      progress,
      lease: { driver: 'gone', seen: Date.now() - 400_000 },
    },
  },
});
const order = (steps, ...names) => {
  const at = names.map((n) => steps.indexOf(n));
  assert.ok(
    at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1])),
    `${names} in ${steps}`,
  );
};

test('a release drains, deploys the new digest with the HEAD Worker, switches Main and passes a canary', () => {
  const r = simulate('pass', {}, { detached: true });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /closing this terminal or Ctrl-C only stops following/);
  order(
    r.steps,
    'upload',
    'preflight',
    'build',
    'gates',
    'push',
    'catalog',
    'drain',
    'note',
    'wrangler',
    'switch',
    'canary',
    'finish',
  );
  // Main names the release as soon as Cloudflare runs its image, and only then waits for a settle.
  const [deployed, switched] = [r.steps.indexOf('wrangler'), r.steps.indexOf('switch')];
  assert.deepEqual(r.steps.slice(deployed + 1, switched), ['native']);
  order(r.steps.slice(switched), 'switch', 'native', 'canary');
  assert.deepEqual(
    r.events.filter((e) => e.startsWith('wrangler')),
    ['wrangler dddd worker v2'],
  );
  assert.equal(r.sim.main, NEXT_ID);
  assert.equal(r.sim.native.image, NEXT);
  assert.deepEqual(r.sim.state.current, {
    image: NEXT,
    releaseId: NEXT_ID,
    localId: `sha256:${'c'.repeat(64)}`,
    sourceCommit: head,
    sandboxesCommit: git(sandboxes, 'rev-parse', 'HEAD'),
  });
  assert.equal(r.sim.active, null);
  assert.match(
    r.ledger,
    /\| boundary \| `dddddddddddd` \|.*\| v15 \| 2 pass \| completed in 42s \| pass \|/,
  );
  assert.equal(JSON.parse(r.record).current.image, NEXT);
  assert.ok(r.events.some((e) => e === 'push username+password'));
  assert.doesNotMatch(r.out + r.ledger + r.events.join('\n'), /fake-password/);
});

test('a failed canary rolls back to the previous digest, Worker and release, and checks it', () => {
  const r = simulate('canary', { fail: { canary: 'new' } });
  assert.equal(r.status, 1, r.out);
  const back = r.steps.lastIndexOf('wrangler');
  assert.equal(r.events[back], 'wrangler aaaa worker v1');
  order(
    r.steps.slice(r.steps.indexOf('canary') + 1),
    'note',
    'wrangler',
    'switch',
    'canary',
    'finish',
  );
  assert.equal(r.sim.main, LIVE.releaseId);
  assert.equal(r.sim.native.image, LIVE.image);
  assert.equal(r.sim.state.current.image, LIVE.image);
  assert.equal(r.sim.active, null);
  assert.match(
    r.ledger,
    /\| FAILED \| canary: canary_failed .*rolled back and verified by a canary \|/,
  );
  assert.equal(r.record, '');
});

test('a failed build changes nothing and keeps command output out of the ledger', () => {
  const r = simulate('build', {
    fail: { build: 'command_failed: docker build :: npm ERR mk_abc123' },
  });
  assert.equal(r.status, 1, r.out);
  assert.ok(!r.steps.includes('catalog') && !r.steps.includes('wrangler'));
  assert.equal(r.sim.active, null);
  assert.match(r.ledger, /\| FAILED \| build: command_failed: docker build; nothing changed \|/);
  assert.doesNotMatch(r.ledger, /mk_abc|npm ERR/);
});

test('an incomplete rollback leaves the run open, and the next run finishes it', () => {
  const first = simulate('rollback', { fail: { canary: 'new', deploy: 'previous' } });
  assert.equal(first.status, 3, first.out);
  const run = first.sim.active;
  assert.ok(run);
  assert.match(first.ledger, /ROLLBACK FAILED/);
  assert.equal(first.sim.native.image, NEXT);
  // Fix the cause; the next plain run resumes the open run once its driver has gone silent.
  const sim = { ...first.sim, fail: {} };
  sim.runs[run].lease.seen -= 400_000;
  writeFileSync(join(first.dir, 'sim.json'), JSON.stringify(sim));
  const second = simulate('rollback', {}, { dir: first.dir });
  assert.equal(second.status, 1, second.out);
  assert.match(second.out, new RegExp(`hosted run ${run} is open; finishing it`));
  const resumed = second.steps.slice(first.steps.length);
  assert.ok(!resumed.includes('upload') && !resumed.includes('build'));
  order(resumed, 'wrangler', 'switch', 'canary', 'finish');
  assert.equal(second.sim.main, LIVE.releaseId);
  assert.equal(second.sim.native.image, LIVE.image);
  assert.equal(second.sim.active, null);
  assert.match(
    second.ledger.split('\n').at(-2),
    /\| FAILED \| .*rolled back and verified by a canary \|/,
  );
});

test('a run another process drives is waited for, then taken over and finished', () => {
  const plan = {
    run: 'R1',
    sourceCommit: head,
    sandboxesCommit: c1,
    lane: 'worker',
    current: { ...LIVE, sourceCommit: '0'.repeat(40), sandboxesCommit: c1 },
    drainSeconds: 900,
  };
  const pre = { native: { version: 14 } };
  const runs = {
    R1: {
      rec: { plan, preflight: pre },
      progress: {},
      lease: { driver: 'other', seen: Date.now() },
      staleAfter: 2,
    },
  };
  const r = simulate('takeover', { active: 'R1', runs, lane: 'worker' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /hosted run R1 is driven by another process; waiting/);
  order(r.steps, 'build', 'gates', 'push', 'catalog', 'wrangler', 'switch', 'canary', 'finish');
  assert.ok(!r.steps.includes('upload') && !r.steps.includes('preflight'));
  assert.equal(r.sim.main, NEXT_ID);
});

test('an image identical to the deployed one advances the recorded commits and deploys nothing', () => {
  const r = simulate('current', { lane: 'none' });
  assert.equal(r.status, 0, r.out);
  assert.ok(!r.steps.includes('gates') && !r.steps.includes('wrangler'));
  assert.equal(r.sim.state.current.image, LIVE.image);
  assert.equal(r.sim.state.current.sourceCommit, head);
  assert.equal(r.ledger, '');
});

test('a canary failing on the previous release too is reported apart, with the run closed', () => {
  const r = simulate('both', { fail: { canary: 'all' } });
  assert.equal(r.status, 4, r.out);
  assert.equal(r.sim.active, null);
  assert.equal(r.sim.main, LIVE.releaseId);
  assert.match(r.ledger, /ROLLED BACK, CANARY FAILED/);
});

test('--resume with nothing open does nothing, and an edited pipeline is refused', () => {
  const idle = simulate('idle', {}, { args: ['--resume'] });
  assert.equal(idle.status, 0, idle.out);
  assert.match(idle.out, /No hosted run is open/);
  const script = join(repo, 'merv-typescript/deploy/hosted-release.mjs');
  const original = readFileSync(script);
  writeFileSync(script, `${original}\n// a peer's uncommitted edit\n`);
  try {
    const r = simulate('dirty');
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /differs from HEAD/);
    assert.ok(!r.steps.includes('upload'));
  } finally {
    writeFileSync(script, original);
  }
});

test("the reviewer's probe: no run starts unless a rollback could redeploy the previous Worker", () => {
  // The deployed Sandboxes commit is not in this checkout, and the new release's canary would fail.
  const current = { ...LIVE, sourceCommit: '0'.repeat(40), sandboxesCommit: 'f'.repeat(40) };
  const r = simulate('missing', { state: { current, inputs: [] }, fail: { canary: 'new' } });
  assert.equal(r.status, 2, r.out);
  assert.match(
    r.out,
    /refused, nothing changed: a rollback needs deploy\/cloudflare-sandbox\/worker\/src\/index.ts at the deployed Sandboxes commit, and ffffffff has none in /,
  );
  assert.deepEqual(r.steps, []);
  assert.equal(r.sim.active, null);
  const signedOut = simulate('signed-out', { fail: { whoami: true } });
  assert.equal(signedOut.status, 2, signedOut.out);
  assert.match(signedOut.out, /a rollback needs \S+wrangler\.mjs, signed in \(whoami exit 1\)/);
  assert.deepEqual(signedOut.steps, []);
});

test('an open run is driven forward only while a rollback could run from here', () => {
  const current = { ...LIVE, sourceCommit: '0'.repeat(40), sandboxesCommit: 'f'.repeat(40) };
  const untouched = simulate('unready-untouched', openRun(current));
  assert.equal(untouched.status, 1, untouched.out);
  assert.match(
    untouched.out,
    /R1 closed, production unchanged: a rollback needs deploy\/cloudflare-sandbox\/worker\/src\/index.ts at the deployed/,
  );
  assert.deepEqual(untouched.events, ['finish {"result":"refused"}']);
  assert.equal(untouched.sim.active, null);
  const run = openRun(current, { deployAttempted: true }, DEPLOYED);
  const deployed = simulate('unready-deployed', { ...run, ...ON_NEXT });
  assert.equal(deployed.status, 3, deployed.out);
  assert.match(deployed.out, /R1 left open, not driven: .*hosted-release\.mjs --abandon/);
  assert.deepEqual(deployed.steps, []);
  assert.equal(deployed.sim.active, 'R1');
});

test('an open run begun with another pipeline is rolled back, never driven forward', () => {
  const current = { ...LIVE, sourceCommit: '0'.repeat(40), sandboxesCommit: c1 };
  const run = openRun(current, { deployAttempted: true }, DEPLOYED, '0'.repeat(40));
  const r = simulate('moved', { ...run, ...ON_NEXT });
  assert.equal(r.status, 1, r.out);
  order(r.steps, 'note', 'wrangler', 'switch', 'canary', 'finish');
  assert.deepEqual(
    r.events.filter((e) => /^(wrangler|switch|canary)/.test(e)),
    [
      'wrangler aaaa worker v1',
      `switch {"releaseId":"${LIVE.releaseId}"}`,
      `canary {"releaseId":"${LIVE.releaseId}"}`,
    ],
  );
  assert.equal(r.sim.main, LIVE.releaseId);
  assert.equal(r.sim.native.image, LIVE.image);
  assert.equal(r.sim.active, null);
  assert.match(
    r.ledger,
    /\| FAILED \| the release pipeline differs from the one this run began with; rolled back and verified by a canary \|/,
  );
});

test('a release that does not settle after the switch rolls back in the same order', () => {
  const r = simulate('unsettled', { fail: { settle: 'next' } });
  assert.equal(r.status, 1, r.out);
  const switched = r.steps.indexOf('switch');
  assert.equal(r.events[switched], `switch {"releaseId":"${NEXT_ID}"}`);
  const back = r.steps.slice(switched + 1);
  assert.ok(back.indexOf('native') < back.indexOf('note'), back.join());
  order(back, 'note', 'wrangler', 'switch', 'canary', 'finish');
  const again = back.indexOf('switch');
  assert.deepEqual(back.slice(back.indexOf('wrangler') + 1, again), ['native']);
  assert.ok(back.slice(again, back.indexOf('canary')).includes('native'));
  assert.equal(r.events.filter((e) => e.startsWith('wrangler')).at(-1), 'wrangler aaaa worker v1');
  assert.ok(!r.events.includes(`canary {"releaseId":"${NEXT_ID}"}`));
  assert.equal(r.sim.main, LIVE.releaseId);
  assert.equal(r.sim.native.image, LIVE.image);
  assert.equal(r.sim.active, null);
  assert.match(
    r.ledger,
    /\| FAILED \| Cloudflare did not settle on \S+: failed 1; rolled back and verified by a canary \|/,
  );
});

test('--abandon closes a stuck run once production agrees on one of its releases, not before', () => {
  // A failed canary whose rollback cannot redeploy leaves the run open on the new release.
  const stuck = simulate('abandon', { fail: { canary: 'new', deploy: 'previous' } });
  assert.equal(stuck.status, 3, stuck.out);
  const run = stuck.sim.active;
  const silent = (sim) => {
    sim.runs[run].lease.seen -= 400_000;
    writeFileSync(join(stuck.dir, 'sim.json'), JSON.stringify(sim));
  };
  const abandon = () => simulate('abandon', {}, { dir: stuck.dir, args: ['--abandon'] });
  silent({ ...stuck.sim, fail: {}, main: LIVE.releaseId }); // Main pointed back by hand
  const refused = abandon();
  assert.equal(refused.status, 2, refused.out);
  assert.match(refused.out, /stays open: abandon: production disagrees.*Main runs rt1_/);
  assert.equal(refused.sim.active, run);
  silent({ ...refused.sim, main: NEXT_ID });
  const closed = abandon();
  assert.equal(closed.status, 0, closed.out);
  assert.equal(closed.sim.active, null);
  assert.deepEqual(closed.sim.state.current, {
    image: NEXT,
    releaseId: NEXT_ID,
    localId: `sha256:${'c'.repeat(64)}`,
    sourceCommit: head,
    sandboxesCommit: git(sandboxes, 'rev-parse', 'HEAD'),
  });
  assert.equal(JSON.parse(closed.record).current.image, NEXT);
  // The run's own release never passed a canary, so the abandon runs one.
  assert.equal(closed.steps.at(-2), 'canary');
  assert.match(
    closed.ledger.split('\n').at(-2),
    /\| completed in 42s \| abandoned \| production agrees on the new release \|/,
  );
  assert.match(abandon().out, /No hosted run is open/);
});

test("the reviewer's probe: a release abandoned after a failed canary stays unverified until one passes", () => {
  const stuck = simulate('unverified', { fail: { canary: 'new', deploy: 'previous' } });
  assert.equal(stuck.status, 3, stuck.out);
  const again = (patch, args = []) => {
    const sim = JSON.parse(readFileSync(join(stuck.dir, 'sim.json'), 'utf8'));
    for (const run of Object.values(sim.runs)) run.lease.seen -= 400_000;
    writeFileSync(join(stuck.dir, 'sim.json'), JSON.stringify({ ...sim, ...patch }));
    return simulate('unverified', {}, { dir: stuck.dir, args });
  };
  const abandoned = again({ fail: { canary: 'all' } }, ['--abandon']);
  assert.equal(abandoned.status, 4, abandoned.out);
  assert.equal(abandoned.sim.active, null);
  // Production runs it, so it is the live pins, but marked unverified, on the host and in Git.
  assert.equal(abandoned.sim.state.current.releaseId, NEXT_ID);
  assert.equal(abandoned.sim.state.current.verified, false);
  assert.equal(JSON.parse(abandoned.record).current.verified, false);
  assert.match(
    abandoned.ledger.split('\n').at(-2),
    /\| — \| ABANDONED, CANARY FAILED \| production agrees on the new release; canary: canary_failed/,
  );
  // The next run from the same HEAD has no hosted change, yet rebuilds and canaries it again.
  const failing = again({ lane: 'none' });
  assert.equal(failing.status, 4, failing.out);
  assert.match(failing.out, /UNVERIFIED: it failed its canary\n(.*\n)*.*lane {6}none/);
  order(failing.steps.slice(abandoned.steps.length), 'upload', 'build', 'canary', 'finish');
  assert.equal(failing.sim.state.current.verified, false);
  assert.match(failing.ledger.split('\n').at(-2), /\| RECHECKED, CANARY FAILED \|/);
  const passing = again({ fail: {} });
  assert.equal(passing.status, 0, passing.out);
  assert.equal(passing.sim.state.current.releaseId, NEXT_ID);
  assert.equal('verified' in passing.sim.state.current, false);
  assert.ok(!passing.steps.slice(failing.steps.length).includes('wrangler'));
  assert.match(passing.ledger.split('\n').at(-2), /\| completed in 42s \| rechecked \|/);
});

test('a host that reboots as the image lands is waited out, and the release finishes', () => {
  const r = simulate('reboot', { reboot: 3 });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.out.match(/fake is out of reach \(ssh exit 255\); retrying/g).length, 3);
  assert.equal(r.sim.main, NEXT_ID);
  assert.equal(r.sim.active, null);
  // One out of reach for longer is waited out for a bounded time, then leaves the run open.
  const gone = simulate('gone', { reboot: 1e6 });
  assert.equal(gone.status, 3, gone.out);
  assert.match(gone.out, /ROLLBACK INCOMPLETE: status: no result \(ssh exit 255\)/);
});
