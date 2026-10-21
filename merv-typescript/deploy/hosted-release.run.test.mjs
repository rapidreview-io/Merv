// Drives the real hosted-release.mjs end to end against a fake host (an ssh on PATH that plays
// hosted-release-vm.py's steps from a JSON file) and a fake wrangler. The repository is a
// small committed repository with the real release scripts and Git archive path.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
// After the Pi host cutover: the Large app serves Main's second machine, with Standard's release
// copied to its provider.
const [CF, LARGE] = ['cloudflare-fleet', 'cloudflare-fleet-large'];
const large = (image, hex) =>
  releaseId({ ...releaseEntry(image, hex.repeat(64)), provider: LARGE });
const [LIVE_L, NEXT_L] = [large(LIVE.image, 'b'), large(NEXT, 'e')];
const held = (provider, image, id) => ({ provider, digest: image.split('@')[1], id });
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
const TWO = {
  others: {
    [LARGE]: {
      ...NATIVE,
      name: 'merv-sandboxes-bridge-large-sandboxcontainer-large',
      maxInstances: 10,
      version: 2,
    },
  },
  machines: { [CF]: LIVE.releaseId, [LARGE]: LIVE_L },
  releases: { [LIVE.releaseId]: LIVE.image, [LIVE_L]: LIVE.image },
  catalog: [held(CF, LIVE.image, LIVE.releaseId), held(LARGE, LIVE.image, LIVE_L)],
};
// Staging's own apps and Main, which production's Sandboxes serves as two more providers.
const [STG, STG_L] = ['cloudflare-fleet-staging', 'cloudflare-fleet-staging-large'];
const copy = (provider, image, hex) =>
  releaseId({ ...releaseEntry(image, hex.repeat(64)), provider });
const STAGING = {
  staging: {
    apps: {
      [STG]: {
        ...NATIVE,
        name: 'merv-fleet-staging-sandboxcontainer',
        maxInstances: 5,
        version: 3,
      },
      [STG_L]: {
        ...NATIVE,
        name: 'merv-fleet-staging-large-sandboxcontainer',
        maxInstances: 2,
        version: 3,
      },
    },
    machines: { [STG]: copy(STG, LIVE.image, 'b'), [STG_L]: copy(STG_L, LIVE.image, 'b') },
  },
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
// Staging Main's switch on its own host: this file's committed host script arrives on stdin.
if (argv[at + 1] === '-' && argv[at + 2] === 'staging-flow') {
  const arg=JSON.parse(argv[at+3].slice(1,-1));
  const out=value=>{save();console.log(JSON.stringify(value));process.exit(0)};
  event('flow-'+arg.action);
  if(arg.action==='begin') {
    if(sim.stagingOwner && sim.stagingOwner!==arg.run) out({error:'staging is owned by '+sim.stagingOwner});
    sim.stagingOwner=arg.run;out({reserved:true});
  }
  if(sim.stagingOwner!==arg.run) out({error:'not staging owner'});
  if(arg.action==='drain') {event('staging-drain '+arg.seconds);if(sim.fail.stagingDrain)out({error:sim.fail.stagingDrain});}
  if(arg.action==='switch') {
    event('staging '+JSON.stringify(arg.releases));
    if(sim.fail.stagingSwitch)out({error:sim.fail.stagingSwitch});
    sim.staging.machines=arg.releases;out({changed:true});
  }
  if(arg.action==='finish') {sim.stagingOwner=null;event('staging-unhold');}
  out({reserved:true});
}
if (argv[at + 1] === '-' && argv[at + 2] === 'staging-gateway') {
  const arg = JSON.parse(argv[at + 3].slice(1, -1));
  event('gateway-' + arg.action);
  const out = value => { save(); console.log(JSON.stringify(value)); process.exit(0); };
  if (sim.fail['gateway-' + arg.action]) out({error:sim.fail['gateway-' + arg.action]});
  if (arg.action === 'source') out(sim.acceptedSource);
  if (JSON.stringify(arg.source) !== JSON.stringify(sim.acceptedSource)) out({error:'production source changed'});
  if (arg.action === 'native') out(sim.staging.apps[arg.provider]);
  if (arg.action === 'catalog') {
    for (const e of arg.source.entries) sim.releases[arg.source.releases[e.provider]] = arg.source.current.image;
    out({releases:arg.source.releases});
  }
  out({drained:true});
}
if (argv[at + 1] === '-' && argv[at + 2] === 'staging') {
  if (!input.includes('def staging(')) process.exit(2);
  const releases = JSON.parse(argv[at + 3].slice(1, -1));
  event('staging ' + JSON.stringify(releases));
  if (sim.fail.stagingSwitch) { save(); console.log(JSON.stringify({ error: sim.fail.stagingSwitch })); process.exit(1); }
  const changed = Object.entries(releases).some(([p, id]) => sim.staging.machines[p] !== id);
  Object.assign(sim.staging.machines, releases); save();
  console.log(JSON.stringify({ changed })); process.exit(0);
}
// Staging Main's work drain before its apps take the image, and the lift of its hold.
if (argv[at + 1] === '-' && ['staging-drain', 'staging-unhold'].includes(argv[at + 2])) {
  if (!input.includes('def work_drain(')) process.exit(2);
  event(argv[at + 2] + ' ' + argv[at + 3].slice(1, -1));
  if (argv[at + 2] === 'staging-drain' && sim.fail.stagingDrain) { save(); console.log(JSON.stringify({ error: sim.fail.stagingDrain })); process.exit(1); }
  console.log(JSON.stringify(argv[at + 2] === 'staging-drain' ? { drained: true } : { lifted: true })); process.exit(0);
}
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
if (!['preflight', 'staging_preflight', 'finish', 'pins'].includes(step) && sim.active !== run) err('run does not hold the marker');
const fail = sim.fail[step], previous = R.rec.plan?.current;
// others: the apps besides Standard; machines: Main's MERV_FLEET_RUNTIMES, absent before the cutover.
const CF = 'cloudflare-fleet', apps = () => ({ [CF]: sim.native, ...sim.others });
const machines = () => sim.machines ?? { [CF]: sim.main };
if (step === 'staging_preflight') {
  if (fail) err(fail);
  if (!sim.maintenance) err('staging maintenance required');
  sim.active=run; R.rec.plan=arg;
  R.rec.preflight={releases:sim.staging.machines,cutoverMainImage:sim.mainImage};
  out(R.rec.preflight);
}
if (step === 'staging_switch') {
  if (fail) err(fail);
  sim.staging.machines=R.rec.plan.stagingReleases;
  out({changed:true});
}
if (step === 'staging_prepare') {
  if (!sim.maintenance) err('staging maintenance required');
  R.progress.cutoverPrepared={mainImage:sim.mainImage,releases:sim.staging.machines};
  out(R.progress.cutoverPrepared);
}
if (step === 'staging_accept') {
  if (sim.maintenance) err('staging maintenance must be removed');
  const before=R.progress.cutoverPrepared;
  if (!before || before.mainImage!==sim.mainImage || JSON.stringify(before.releases)!==JSON.stringify(sim.staging.machines)) err('prepared staging pair changed');
  out({accepted:true});
}
if (step === 'canary' && R.rec.plan.stagingCutover) {
  if (fail || sim.maintenance) err(fail || 'canary fenced');
  if (sim.staging.machines['cloudflare-fleet-staging']!==arg.releaseId) err('staging canary release mismatch');
  out({status:'completed',seconds:12,released:true});
}
if (step === 'preflight') {
  if (sim.active && sim.active !== run) err('another run is open');
  sim.active = run; R.rec.plan = arg;
  out({ apps: apps(), mainReleaseId: sim.main, fileReleaseId: sim.main, releases: machines(),
    fileReleases: machines(), catalog: sim.catalog }, true);
}
// file: the env file's pins where they differ from Main's, which a release has yet to recreate.
if (step === 'pins') {
  const file = { main: sim.main, machines: machines(), ...sim.file };
  out({ apps: apps(), mainReleaseId: sim.main, fileReleaseId: file.main, releases: machines(),
    fileReleases: file.machines, catalog: sim.catalog });
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
  for (const e of arg.entries) {
    const id = arg.releases[e.provider];
    sim.releases[id] = previous.image.split('@')[0] + '@' + e.image_digest;
    sim.catalog.push({ provider: e.provider, digest: e.image_digest, id });
  }
  out({ releaseId: arg.releaseId, releases: arg.releases, changed: true }, true);
}
// staging: the staging apps production's Sandboxes serves, and staging Main's machines.
if (step === 'staging_apps') out({providers:Object.keys(sim.staging?.apps??{})});
if (step === 'stage') {
  if (fail) err(fail);
  const served = arg.entries.filter((e) => sim.staging?.apps[e.provider]);
  if (!served.length) err('Sandboxes serves no staging app');
  for (const e of served) sim.catalog.push({ provider: e.provider, digest: e.image_digest, id: arg.releases[e.provider] });
  out({ releases: Object.fromEntries(served.map((e) => [e.provider, arg.releases[e.provider]])), changed: true });
}
if (step === 'drain') { if (fail) err(fail); out({ drained: true }); }
if (step === 'note') { R.progress = { ...R.progress, ...arg }; out(R.progress); }
// unread: {provider: reads left before Sandboxes can no longer read that app}.
if (step === 'native') {
  const left = sim.unread?.[arg.provider];
  if (left !== undefined && (sim.unread[arg.provider] = left - 1) < 0) err(arg.provider + ' is not an enabled Sandboxes provider');
  out(apps()[arg.provider ?? CF] ?? sim.staging.apps[arg.provider]);
}
if (step === 'switch') {
  // A machine the switch leaves out keeps the release Main runs.
  const releases = { ...machines(), ...(arg.releases ?? { [CF]: arg.releaseId }) };
  if (fail && releases[CF] !== previous.releaseId) err(fail);
  const changed = sim.main !== releases[CF]; sim.main = releases[CF];
  if (sim.machines) sim.machines = releases;
  out({ changed });
}
if (step === 'prepare_cutover') {
  if (!sim.maintenance) err('maintenance must be enabled');
  R.progress.cutoverPrepared = { image: sim.native.image, release: sim.main };
  out(R.progress.cutoverPrepared);
}
if (step === 'accept_cutover') {
  if (sim.maintenance) err('maintenance must be removed');
  if (fail) err(fail);
  const checkpoint = R.progress.cutoverPrepared;
  if (!checkpoint || checkpoint.image !== sim.native.image || checkpoint.release !== sim.main) err('prepared pair changed');
  out({ accepted: true });
}
if (step === 'canary') {
  if (sim.maintenance) err('ordinary canary is fenced');
  const each = Object.entries(machines()).every(([p, id]) => sim.releases[id] === apps()[p].image);
  if (!each || sim.main !== arg.releaseId) err('canary_failed pins disagree');
  if (fail === 'all' || (fail && arg.releaseId !== previous.releaseId)) err('canary_failed {"status":"interrupted"}');
  out({ status: 'completed', seconds: 42 });
}
if (step === 'propagation_ready') out({image:sim.native.image,releaseId:sim.main});
if (step === 'abandon') {
  const known = { [previous.image]: R.rec.preflight.releases, [R.rec.push?.image]: R.rec.catalog?.releases };
  const target = known[sim.native.image];
  const agree = target && Object.values(apps()).every((a) => a.image === sim.native.image) &&
    JSON.stringify(machines()) === JSON.stringify(target) && sim.main === target[CF] &&
    Object.entries(target).every(([p, id]) => sim.catalog.some((c) => c.provider === p && c.id === id));
  if (!agree) err('production disagrees, so the run stays open: Main runs ' + sim.main);
  out({ releaseId: target[CF], releases: target, image: sim.native.image });
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
const [{ image, name }] = config.containers;
const worker = fs.readFileSync(config.main, 'utf8').trim();
const staging = name.includes('staging') && (name.includes('large') ? 'cloudflare-fleet-staging-large' : 'cloudflare-fleet-staging');
const large = !staging && name.includes('large') && 'cloudflare-fleet-large';
fs.appendFileSync(process.env.SIM_LOG, 'wrangler ' + image.slice(-4) + ' ' + worker + (large ? ' large' : '') + (staging ? ' ' + staging : '') + '\\n');
if (staging) {
  if (sim.fail.deploy === 'staging') process.exit(1);
  const app = sim.staging.apps[staging];
  sim.staging.apps[staging] = { ...app, image, version: app.version + 1 };
  fs.writeFileSync(process.env.SIM, JSON.stringify(sim));
  process.exit(0);
}
const which = image === sim.liveImage ? 'previous' : 'next';
if (sim.fail.deploy === 'all' || sim.fail.deploy === which) process.exit(1);
const instances = { failed: sim.fail.settle === which ? 1 : 0, scheduling: 0, starting: 0 };
const app = large ? sim.others[large] : sim.native;
const now = { ...app, image, version: app.version + 1, health: { errors: [], instances } };
if (large) sim.others[large] = now;
else sim.native = now;
if (which === 'next' && sim.reboot) sim.down = sim.reboot; // the host reboots as the image lands
fs.writeFileSync(process.env.SIM, JSON.stringify(sim));
`;

before(() => {
  // Exercise real Git pinning and packaging without hashing the whole application on
  // every simulated rollout. Host execution is supplied by SSH above.
  const fixture = join(repo, 'merv-typescript');
  for (const file of [
    'deploy/hosted-release.mjs',
    'deploy/hosted-release.json',
    'deploy/hosted-release-vm.py',
    'deploy/hosted-sandboxes-probe.mjs',
    'deploy/source-archive.mjs',
    'deploy/hosted-wrangler.json',
    'deploy/hosted-wrangler-large.json',
    'deploy/hosted-wrangler-staging.json',
    'deploy/hosted-wrangler-staging-large.json',
  ]) {
    mkdirSync(dirname(join(fixture, file)), { recursive: true });
    writeFileSync(join(fixture, file), readFileSync(join(merv, file)));
  }
  cpSync(join(merv, '../clients'), join(repo, 'clients'), { recursive: true });
  writeFileSync(join(fixture, 'package.json'), '{"name":"release-fixture","private":true}');
  mkdirSync(join(fixture, 'src'));
  writeFileSync(join(fixture, 'src/cli.ts'), 'export const fixture = true;');
  const vendor = join(fixture, 'vendor/merv-sandboxes');
  for (const dir of ['typescript/packages', 'typescript/hosts/merv', 'typescript/patches']) {
    mkdirSync(join(vendor, dir), { recursive: true });
    writeFileSync(join(vendor, dir, 'fixture.txt'), dir);
  }
  git(vendor, 'init', '-q');
  git(vendor, 'add', '-A');
  git(vendor, 'commit', '-qm', 'vendor fixture');
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'snapshot');
  head = git(repo, 'rev-parse', 'HEAD');
  // The Sandboxes checkout: the deployed commit, then HEAD with a changed bridge Worker.
  for (const [file, text] of [
    ['agent/main.go', 'package main'],
    ['deploy/cloudflare-sandbox/Dockerfile', 'FROM debian'],
    ['deploy/cloudflare-sandbox/worker/src/index.ts', 'worker v1'],
    ['typescript/packages/runtimes/assets/python/merv_sandboxes/__init__.py', ''],
    ['typescript/packages/runtimes/assets/python/merv_sandboxes/errors.py', ''],
    ['typescript/packages/runtimes/assets/python/merv_sandboxes/runtimes/__init__.py', ''],
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
  // Formatting is checked by CI, not by every simulated release ledger write.
  // Keep the real driver and its files; avoid starting npm/Prettier for each note.
  writeFileSync(
    join(T, 'bin/npx'),
    '#!/bin/sh\n[ "$1" = prettier ] && [ "$2" = --write ] && [ -f "$3" ]\n',
    { mode: 0o755 },
  );
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
        catalog: [held(CF, LIVE.image, LIVE.releaseId)],
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
const order = (steps, ...names) => {
  const at = names.map((n) => steps.indexOf(n));
  assert.ok(
    at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1])),
    `${names} in ${steps}`,
  );
};

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

test('after the cutover a release deploys both apps, switches every machine, and settles both', () => {
  const r = simulate('two', TWO);
  assert.equal(r.status, 0, r.out);
  order(r.steps, 'catalog', 'drain', 'note', 'wrangler', 'switch', 'canary', 'finish');
  assert.deepEqual(
    r.events.filter((e) => e.startsWith('wrangler')),
    ['wrangler dddd worker v2', 'wrangler dddd worker v2 large'],
  );
  // Main names both releases once both apps run the image, then waits for both to settle.
  const [deployed, switched] = [r.steps.lastIndexOf('wrangler'), r.steps.indexOf('switch')];
  assert.deepEqual(r.steps.slice(deployed + 1, switched), ['native', 'native']);
  assert.deepEqual(r.sim.machines, { [CF]: NEXT_ID, [LARGE]: NEXT_L });
  assert.equal(r.sim.others[LARGE].image, NEXT);
  assert.deepEqual(r.sim.catalog.slice(2), [held(CF, NEXT, NEXT_ID), held(LARGE, NEXT, NEXT_L)]);
  assert.deepEqual(r.sim.state.current.releases, { [CF]: NEXT_ID, [LARGE]: NEXT_L });
  // The legacy key and the record agree on Standard, as the previous pipeline reads them when the
  // runbook rolls Main back with release.mjs.
  assert.equal(r.sim.main, r.sim.state.current.releaseId);
  assert.match(r.ledger, /\| v15 v3 \| 2 pass \| completed in 42s \| pass \|/);
});

test('after the cutover a failed canary rolls both apps and every machine back, in order', () => {
  const r = simulate('two-back', { ...TWO, fail: { canary: 'new' } });
  assert.equal(r.status, 1, r.out);
  const back = r.events.slice(r.steps.indexOf('canary') + 1);
  assert.deepEqual(
    back.filter((e) => /^(wrangler|switch|canary)/.test(e)).map((e) => e.slice(0, 40)),
    [
      'wrangler aaaa worker v1',
      'wrangler aaaa worker v1 large',
      `switch {"releaseId":"${LIVE.releaseId}`.slice(0, 40),
      `canary {"releaseId":"${LIVE.releaseId}`.slice(0, 40),
    ],
  );
  assert.deepEqual(r.sim.machines, TWO.machines);
  assert.deepEqual([r.sim.native.image, r.sim.others[LARGE].image], [LIVE.image, LIVE.image]);
  assert.equal(r.sim.active, null);
  assert.match(r.ledger, /\| FAILED \| canary: .*rolled back and verified by a canary \|/);
});

test('once production passes, staging takes the release: catalog copies, its apps, then its Main', () => {
  const r = simulate('staging', STAGING);
  assert.equal(r.status, 0, r.out);
  order(r.steps, 'switch', 'canary', 'stage');
  order(
    r.steps.slice(r.steps.indexOf('stage')),
    'stage',
    'staging-drain',
    'wrangler',
    'staging',
    'finish',
  );
  // Staging's work visits end before its apps are replaced, within --drain-minutes.
  assert.ok(r.events.includes('staging-drain 900'), r.events.join('\n'));
  order(r.steps, 'flow-begin', 'stage', 'flow-switch', 'flow-finish', 'staging-unhold');
  const staged = r.steps.indexOf('stage');
  assert.deepEqual(
    r.events.slice(staged).filter((e) => e.startsWith('wrangler')),
    [`wrangler dddd worker v2 ${STG}`, `wrangler dddd worker v2 ${STG_L}`],
  );
  // Staging Main names the releases only once both its apps run the image.
  const switched = r.steps.indexOf('staging');
  assert.deepEqual(r.steps.slice(r.steps.lastIndexOf('wrangler') + 1, switched), [
    'native',
    'native',
    'flow-switch',
  ]);
  const next = { [STG]: copy(STG, NEXT, 'e'), [STG_L]: copy(STG_L, NEXT, 'e') };
  assert.deepEqual(r.sim.staging.machines, next);
  assert.deepEqual(r.sim.catalog.slice(-2), [
    held(STG, NEXT, next[STG]),
    held(STG_L, NEXT, next[STG_L]),
  ]);
  assert.deepEqual(
    Object.values(r.sim.staging.apps).map((a) => a.image),
    [NEXT, NEXT],
  );
  // Production's record is production's alone.
  assert.deepEqual(r.sim.state.current.releases, { [CF]: NEXT_ID });
  assert.match(
    r.ledger,
    new RegExp(`\\| pass \\| Sandboxes \\w+; staging ${STG} \\+ ${STG_L} switched on it \\|`),
  );
});

test('ordinary staging failures retain both owners and resume only staging forward', () => {
  for (const fail of [
    { deploy: 'staging' },
    { stagingSwitch: 'Main did not take the release' },
    { stagingDrain: 'not_drained_after_900s {"work": ["flt_w"]}' },
  ]) {
    const first = simulate('staging-fails', { ...STAGING, fail });
    assert.equal(first.status, 3, first.out);
    assert.ok(first.sim.active && first.sim.stagingOwner);
    assert.equal(first.sim.main, NEXT_ID);
    assert.equal(first.sim.native.image, NEXT);
    assert.ok(!first.steps.includes('staging-unhold'));
    assert.ok(!first.steps.includes('finish'));
    editRun(first, (sim) => {
      sim.fail = {};
    });
    const resumed = simulate('staging-fails', {}, { dir: first.dir, args: ['--resume'] });
    assert.equal(resumed.status, 0, resumed.out);
    const steps = resumed.steps.slice(first.steps.length);
    assert.ok(!steps.includes('switch') && !steps.includes('canary') && !steps.includes('build'));
    assert.equal(resumed.sim.active, null);
    assert.equal(resumed.sim.stagingOwner, null);
    assert.ok(!resumed.events.some((e) => e.startsWith('wrangler aaaa')));
  }
  const none = simulate('no-staging');
  assert.equal(none.status, 0, none.out);
  assert.match(none.ledger, /STAGING NOT UPDATED: Sandboxes serves no staging app \|/);
});

test('ordinary propagation defers before any staging mutation when a cutover is prepared or accepting', () => {
  for (const owner of ['prepared-staging-cutover', 'accepting-staging-cutover']) {
    const result = simulate('staging-owner', { ...STAGING, stagingOwner: owner });
    assert.equal(result.status, 0, result.out);
    assert.equal(result.sim.stagingOwner, owner);
    assert.ok(!result.steps.includes('stage'));
    assert.ok(!result.steps.includes('staging-drain'));
    assert.ok(!result.steps.includes('staging-unhold'));
    assert.ok(!result.events.some((e) => e.startsWith('wrangler') && e.includes('staging')));
    assert.deepEqual(result.sim.staging.machines, STAGING.staging.machines);
    assert.match(result.ledger, /staging is owned by/);
  }
});

const editRun = (result, change) => {
  const sim = result.sim;
  sim.runs[sim.active].lease.seen -= 400_000;
  change(sim);
  writeFileSync(join(result.dir, 'sim.json'), JSON.stringify(sim));
};
test('cutover preparation pauses the real driver before canary; ordinary resume cannot accept; explicit reopening resumes', () => {
  const first = simulate(
    'cutover-prepare',
    { ...TWO, maintenance: true },
    { args: ['--prepare-cutover'] },
  );
  assert.equal(first.status, 5, first.out);
  assert.equal(first.sim.main, NEXT_ID);
  assert.equal(first.sim.native.image, NEXT);
  assert.ok(first.sim.active);
  assert.ok(!first.steps.includes('canary'));
  assert.ok(!first.steps.includes('stage'));
  assert.ok(!first.steps.includes('finish'));
  assert.match(first.ledger, /PREPARED/);
  order(first.steps, 'catalog', 'drain', 'wrangler', 'switch', 'prepare_cutover');
  editRun(first, () => {});
  const plain = simulate('cutover-prepare', {}, { dir: first.dir, args: ['--resume'] });
  assert.equal(plain.status, 5, plain.out);
  assert.ok(!plain.steps.includes('canary'));
  editRun(plain, () => {});
  const fenced = simulate(
    'cutover-prepare',
    {},
    { dir: first.dir, args: ['--resume', '--accept-cutover'] },
  );
  assert.equal(fenced.status, 3, fenced.out);
  assert.equal(fenced.sim.native.image, NEXT);
  assert.ok(!fenced.steps.includes('canary'));
  assert.ok(!fenced.steps.includes('finish'));
  editRun(fenced, (sim) => {
    sim.maintenance = false;
  });
  const accepted = simulate(
    'cutover-prepare',
    {},
    { dir: first.dir, args: ['--resume', '--accept-cutover'] },
  );
  assert.equal(accepted.status, 0, accepted.out);
  order(accepted.steps, 'prepare_cutover', 'accept_cutover', 'canary', 'finish');
  assert.equal(accepted.sim.active, null);
  assert.equal(accepted.sim.main, NEXT_ID);
  assert.ok(!accepted.steps.includes('stage'));
  assert.match(accepted.out, /DEFERRED/);
});

test('cutover canary failure preserves candidate and resumable checkpoint without rollback', () => {
  const prepared = simulate('cutover-fail', { maintenance: true }, { args: ['--prepare-cutover'] });
  assert.equal(prepared.status, 5, prepared.out);
  editRun(prepared, (sim) => {
    sim.maintenance = false;
    sim.fail.canary = 'new';
  });
  const failed = simulate(
    'cutover-fail',
    {},
    { dir: prepared.dir, args: ['--resume', '--accept-cutover'] },
  );
  assert.equal(failed.status, 3, failed.out);
  assert.equal(failed.sim.native.image, NEXT);
  assert.equal(failed.sim.main, NEXT_ID);
  assert.ok(failed.sim.active);
  assert.ok(!failed.steps.includes('finish'));
  assert.ok(!failed.events.some((e) => e.includes('"restore":true')));
  editRun(failed, (sim) => {
    sim.fail = {};
  });
  const retry = simulate(
    'cutover-fail',
    {},
    { dir: prepared.dir, args: ['--resume', '--accept-cutover'] },
  );
  assert.equal(retry.status, 0, retry.out);
  assert.equal(retry.sim.main, NEXT_ID);
});

test('partial cutover switch failure never deploys the previous image and can finish preparation forward', () => {
  const failed = simulate(
    'cutover-switch',
    { maintenance: true, fail: { switch: 'cannot recreate Main' } },
    { args: ['--prepare-cutover'] },
  );
  assert.equal(failed.status, 3, failed.out);
  assert.equal(failed.sim.native.image, NEXT);
  assert.ok(failed.sim.active);
  assert.ok(!failed.steps.includes('canary'));
  assert.ok(!failed.steps.includes('finish'));
  assert.equal(failed.steps.filter((s) => s === 'wrangler').length, 1);
  editRun(failed, (sim) => {
    sim.fail = {};
  });
  const resumed = simulate('cutover-switch', {}, { dir: failed.dir, args: ['--resume'] });
  assert.equal(resumed.status, 5, resumed.out);
  assert.equal(resumed.sim.main, NEXT_ID);
});

const stagingFlags = [
  '--staging-cutover',
  '--prepare-cutover',
  '--canary-project',
  'staging-project',
  '--canary-credential',
  '/private/staging-reader.json',
];
const stagingFixture = () => {
  const entries = [STG, STG_L].map((provider) => ({
    ...releaseEntry(NEXT, 'e'.repeat(64)),
    provider,
  }));
  return {
    ...STAGING,
    maintenance: true,
    mainImage: 'sha256:staging-main',
    acceptedSource: {
      current: { ...LIVE, image: NEXT, sourceCommit: 'a'.repeat(40), sandboxesCommit: c1 },
      acceptedRun: 'accepted-production',
      entries,
      releases: Object.fromEntries(entries.map((e) => [e.provider, releaseId(e)])),
    },
  };
};
const resumeStaging = (first, patch = {}, accept = true) => {
  const sim = { ...first.sim, ...patch };
  sim.runs[sim.active].lease.seen -= 400000;
  writeFileSync(join(first.dir, 'sim.json'), JSON.stringify(sim));
  return simulate(
    'staging-resume',
    {},
    {
      dir: first.dir,
      args: ['--staging-cutover', '--resume', ...(accept ? ['--accept-cutover'] : [])],
    },
  );
};

test('staging-only cutover deploys accepted digest, pauses, then accepts with real canary path and separate ledgers', () => {
  const first = simulate('staging-cutover', stagingFixture(), { args: stagingFlags });
  assert.equal(first.status, 5, first.out);
  for (const forbidden of ['build', 'gates', 'push', 'catalog', 'switch', 'stage', 'canary'])
    assert.ok(!first.steps.includes(forbidden), forbidden);
  assert.equal(first.sim.native.image, LIVE.image);
  assert.equal(first.sim.main, LIVE.releaseId);
  for (const app of Object.values(first.sim.staging.apps)) assert.equal(app.image, NEXT);
  assert.equal(first.ledger, '');
  const paused = resumeStaging(first, {}, false);
  assert.equal(paused.status, 5, paused.out);
  const accepted = resumeStaging(paused, { maintenance: false });
  assert.equal(accepted.status, 0, accepted.out);
  assert.equal(accepted.sim.active, null);
  assert.ok(accepted.steps.includes('canary'));
  assert.equal(accepted.record, '');
  const record = JSON.parse(readFileSync(join(first.dir, 'staging-hosted-release.json'), 'utf8'));
  assert.equal(record.current.image, NEXT);
  assert.equal(record.current.sourceCommit, 'a'.repeat(40));
  assert.equal(record.pipelineCommit, head);
});

for (const [failure, message] of [
  ['gateway-source', 'unaccepted production'],
  ['staging_preflight', 'legacy Main'],
  ['drain', 'in-flight work'],
  ['gateway-census', 'provider ownership'],
]) {
  test(`staging preparation refuses ${message} before deployment`, () => {
    const first = simulate(
      'staging-denied',
      { ...stagingFixture(), fail: { [failure]: message } },
      { args: stagingFlags },
    );
    assert.notEqual(first.status, 0);
    assert.notEqual(first.status, 5);
    assert.ok(!first.steps.includes('wrangler'), first.out);
    assert.equal(first.sim.main, LIVE.releaseId);
  });
}

test('staging deploy failure remains open and resumes forward without rebuilding or touching production pins', () => {
  const first = simulate(
    'staging-failure',
    { ...stagingFixture(), fail: { deploy: 'staging' } },
    { args: stagingFlags },
  );
  assert.equal(first.status, 3, first.out);
  assert.ok(first.sim.active);
  assert.ok(!first.steps.includes('finish'));
  const next = resumeStaging(first, { fail: {} }, false);
  assert.equal(next.status, 5, next.out);
  assert.equal(next.sim.main, LIVE.releaseId);
  assert.equal(next.sim.native.image, LIVE.image);
});

for (const [patch, reason] of [
  [{}, 'fenced'],
  [{ maintenance: false, mainImage: 'sha256:other' }, 'image changed'],
  [{ maintenance: false, fail: { canary: 'failed canary cleanup' } }, 'canary failure'],
]) {
  test(`staging acceptance stays open on ${reason}`, () => {
    const first = simulate('staging-accept-denied', stagingFixture(), { args: stagingFlags });
    assert.equal(first.status, 5, first.out);
    const denied = resumeStaging(first, patch);
    assert.equal(denied.status, 3, denied.out);
    assert.ok(denied.sim.active);
    assert.equal(denied.sim.main, LIVE.releaseId);
    assert.equal(denied.record, '');
  });
}
