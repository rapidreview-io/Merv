import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GATES,
  LEASE,
  classify,
  describePlan,
  ledgerRow,
  pinProblems,
  releaseEntry,
  releaseId,
  rollbackSteps,
  unsettled,
  wranglerConfig,
} from './hosted-release.mjs';

const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const seed = read('hosted-release.json');
const template = read('hosted-wrangler.json');
const LIVE_EXECUTABLE = 'b3f871dcee261fd66d6ccdbbe4d8e589a8ef1014646c920087da4bbc866da49d';
const image = (hex) => `registry.cloudflare.com/acct/merv-hosted-codex@sha256:${hex.repeat(64)}`;
const settled = {
  name: template.containers[0].name,
  image: seed.current.image,
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

// The host-side steps run as root on the host, in Python; their logic is tested here, with the
// module's host commands replaced where a step needs them.
const vm = new URL('hosted-release-vm.py', import.meta.url).pathname;
const python = (body, input = null) => {
  const code = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('vm',${JSON.stringify(vm)})
vm=importlib.util.module_from_spec(spec);spec.loader.exec_module(vm)
i=json.load(sys.stdin)
${body}`;
  return spawnSync('python3', ['-c', code], { input: JSON.stringify(input), encoding: 'utf8' });
};
const py = (body, input) => {
  const r = python(body, input);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test('changed paths pick the source lane, and both sides agree on gates and the lease', () => {
  assert.equal(classify([], []), 'none');
  assert.equal(classify(['packages/pi/src/worker.ts', 'package-lock.json'], []), 'worker');
  assert.equal(
    classify(['packages/pi/src/worker.ts', 'scripts/hosted-runner/start-runtime.py'], []),
    'boundary',
  );
  assert.equal(classify(['scripts/hosted-runner/Dockerfile'], []), 'boundary');
  assert.equal(classify(['packages/pi/worker-runtime/package-lock.json'], []), 'boundary');
  assert.equal(classify([], ['deploy/cloudflare-sandbox/entrypoint.sh']), 'boundary');
  assert.equal(classify(null, []), 'boundary'); // the deployed commit is unknown here
  assert.equal(classify([], null), 'boundary');
  assert.deepEqual(py('print(json.dumps([vm.LANE_GATES, vm.LEASE]))'), [GATES, LEASE]);
});

test('the host decides the lane from the whole image; the source lane is only a floor', () => {
  const lane = (plan, changed, configChanged = false) =>
    py('print(json.dumps(vm.final_lane(*i)))', [plan, changed, configChanged]);
  const worker = ['/opt/merv/pi/worker-main.mjs', '/opt/merv/pi/compile-cache/v22-12001/abc'];
  const plan = { lane: 'worker', sandboxChanged: [] };
  assert.equal(lane(plan, []), 'none');
  assert.equal(lane(plan, worker), 'worker');
  assert.equal(lane({ ...plan, lane: 'boundary' }, worker), 'boundary');
  assert.equal(lane(plan, [...worker, '/opt/merv/runtime/boot']), 'boundary');
  assert.equal(lane(plan, ['/var/lib/dpkg/status']), 'boundary');
  assert.equal(lane(plan, worker, true), 'boundary');
  assert.equal(lane(plan, [], true), 'boundary');
  // A bridge Worker change is deployed even when the image is unchanged.
  const bridge = { ...plan, sandboxChanged: ['deploy/cloudflare-sandbox/worker/src/index.ts'] };
  assert.equal(lane(bridge, []), 'boundary');
  assert.equal(lane({ ...plan, sandboxChanged: null }, []), 'boundary');
});

test('a gate passes only when every report line passes', () => {
  const passed = (output, name) =>
    py('g=vm.GATES[i[1]];print(json.dumps(vm.gate_passed(i[0],g[3],g[4])))', [output, name]);
  const pi = (prestarted, extra = {}) =>
    JSON.stringify({
      gate: 'linux-pi-protected-launch',
      prestarted,
      uid: 12001,
      noNewPrivileges: true,
      parentPtraceDenied: true,
      workerAlive: true,
      ...extra,
    });
  assert.equal(passed(`${pi(false)}\n${pi(true)}\n`, 'linux-pi-gate.py'), true);
  assert.equal(
    passed(`${pi(false, { parentPtraceDenied: false })}\n${pi(true)}\n`, 'linux-pi-gate.py'),
    false,
  );
  assert.equal(passed(`${pi(true)}\n`, 'linux-pi-gate.py'), false);
  const probe = (extra) =>
    JSON.stringify({
      gate: 'linux-isolation-probe-synthetic-ancestry',
      report: { ok: true },
      actualProtectedWorkflow: false,
      cloudflareEvidence: false,
      ...extra,
    });
  const isolation = 'linux-isolation-probe-gate.mjs';
  assert.equal(passed(`guardian says hello\n${probe({})}\n`, isolation), true);
  assert.equal(passed(probe({ cloudflareEvidence: true }), isolation), false);
  assert.equal(passed(probe({ report: { ok: false } }), isolation), false);
  assert.equal(passed('', isolation), false);
});

test('release ids match the live Sandboxes catalog and require a digest', () => {
  const entry = releaseEntry(seed.current.image, LIVE_EXECUTABLE);
  assert.equal(
    releaseId(entry),
    'rt1_ae4b27ada35598ec5f4fa688373de3a45fe6c0c9eaf53db13597872ef1d5b608',
  );
  assert.equal(releaseId(entry), seed.current.releaseId);
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
  assert.throws(() => wranglerConfig(template, 'registry.cloudflare.com/acct/x:latest', '/w'));
  for (const change of [{ authorized_keys: ['ssh-ed25519 AAAA'] }, { ssh: { enabled: true } }]) {
    const unsafe = { ...template, containers: [{ ...template.containers[0], ...change }] };
    assert.throws(() => wranglerConfig(unsafe, image('c'), '/w'));
  }
});

test('native verification waits for the pinned image to settle and flags drift', () => {
  const expect = {
    image: seed.current.image,
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
  const live = {
    native: settled,
    mainReleaseId: seed.current.releaseId,
    fileReleaseId: seed.current.releaseId,
    catalog: [seed.current.image.split('@')[1]],
  };
  assert.deepEqual(pinProblems(seed.current, template, live), []);
  assert.deepEqual(
    pinProblems(seed.current, template, { ...live, mainReleaseId: 'rt1_x', catalog: [] }),
    ['Main runs rt1_x', 'the Sandboxes catalog lacks the live digest'],
  );
  // Pre-warmed or transient launches do not block the drift check; only the settle wait.
  const busy = {
    ...live,
    native: { ...settled, health: { errors: [], instances: { starting: 1 } } },
  };
  assert.deepEqual(pinProblems(seed.current, template, busy), []);
});

test('rollback undoes what was attempted, then verifies with a canary', () => {
  const previous = { image: image('a'), releaseId: 'rt1_old', sandboxesCommit: 'c1' };
  assert.deepEqual(rollbackSteps({}, previous), []);
  assert.deepEqual(rollbackSteps({ catalogBroken: true }, previous), [['catalog']]);
  // The switch is always undone after a deploy: the host guard may have switched Main meanwhile.
  assert.deepEqual(rollbackSteps({ deployAttempted: true }, previous), [
    ['deploy', previous],
    ['switch', 'rt1_old'],
    ['canary', 'rt1_old'],
  ]);
});

test('ledger rows and the plan carry pins, never secrets', () => {
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
    sandboxesCommit: 'a'.repeat(40),
    changed: ['scripts/hosted-runner/start-runtime.py'],
    sandboxChanged: null,
    lane: 'boundary',
    current: seed.current,
  };
  const text = describePlan(plan);
  assert.match(text, /lane {6}supervisor\/bootstrap boundary/);
  assert.match(text, /sandboxes unknown to this checkout/);
  assert.match(text, /linux-pi-gate\.py, linux-workflow-gate\.py, linux-isolation-probe-gate\.mjs/);
  assert.doesNotMatch(describePlan({ ...plan, lane: 'none', changed: [] }), /gates/);
});

test('--dry-run plans without a host and prints no secrets', () => {
  const sandboxes = mkdtempSync(join(tmpdir(), 'merv-sandboxes-'));
  try {
    const git = (...a) => spawnSync('git', ['-C', sandboxes, ...a], { encoding: 'utf8' });
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');
    const result = spawnSync(
      process.execPath,
      [
        new URL('hosted-release.mjs', import.meta.url).pathname,
        '--dry-run',
        '--host',
        'unreachable.invalid',
        '--sandboxes',
        sandboxes,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /planning from deploy\/hosted-release\.json at HEAD/);
    assert.match(result.stdout, /^hosted release \d{8}T\d{6}Z-[0-9a-f]{8}$/m);
    // The seed's Sandboxes commit is not in this repository: the boundary, as a precaution.
    assert.match(result.stdout, /lane {6}supervisor\/bootstrap boundary/);
    assert.doesNotMatch(result.stdout + result.stderr, /sbxt_|mk_[A-Za-z0-9]|Bearer |password/i);
  } finally {
    rmSync(sandboxes, { recursive: true, force: true });
  }
});

test('the catalog edit appends to both services, keeps earlier releases and is idempotent', () => {
  const release = (hex) => releaseEntry(image(hex), LIVE_EXECUTABLE);
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
  const [doc, changed] = py(edit, {
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
  assert.deepEqual(py(edit, { doc, entry: release('3') }), [doc, false]);
  // Beyond `keep`, the oldest go first, but never the release Main still runs.
  const [pruned] = py(edit, {
    doc,
    entry: release('4'),
    keep: 2,
    protect: [release('1').image_digest],
  });
  const kept = JSON.parse(pruned.services.control.environment.SANDBOXES_RUNTIME_RELEASES);
  assert.deepEqual(kept, [release('1'), release('3'), release('4')]);
  const split = services([release('1')]);
  split.services['pipelines-worker'].environment.SANDBOXES_RUNTIME_RELEASES = '[]';
  assert.match(python('vm.with_release(i,{})', split).stderr, /catalog_services_differ/);
});

test('the env edit replaces exactly one release id line', () => {
  const raw = 'A=1\nMERV_FLEET_RUNTIME_RELEASE_ID=rt1_old\nB=\'{"x":1}\'\n';
  const out = py(
    'print(json.dumps(vm.with_env(i.encode(),"MERV_FLEET_RUNTIME_RELEASE_ID","rt1_new").decode()))',
    raw,
  );
  assert.equal(out, 'A=1\nMERV_FLEET_RUNTIME_RELEASE_ID=rt1_new\nB=\'{"x":1}\'\n');
  assert.match(python("vm.with_env(b'K=1\\nK=2\\n','K','3')").stderr, /env_key_not_unique/);
});

// A scratch HOME and run directory, with the module's docker/pgrep calls replaced.
const scratch = `import pathlib,tempfile,time
t=pathlib.Path(tempfile.mkdtemp());vm.HOME=t/'home';vm.HOME.mkdir();r=t/'run1';r.mkdir()
`;

test('one run holds the host marker, one driver the lease, and a silent lease can be taken over', () => {
  const out = py(
    `${scratch}res={}
def attempt(key,f):
    try: f(); res[key]='ok'
    except RuntimeError as e: res[key]=str(e)
vm.claim('run1');attempt('same run',lambda:vm.claim('run1'));attempt('other run',lambda:vm.claim('run2'))
res['marker']=vm.owner()
with vm.leased(r,'a'): pass
def second():
    with vm.leased(r,'b'): pass
attempt('fresh lease',second)
(r/'lease.json').write_text(json.dumps({'driver':'a','seen':time.time()-vm.LEASE-1}))
attempt('silent lease',second)
res['holder']=json.loads((r/'lease.json').read_text())['driver']
with vm.leased(r,'b'): (r/'finish.json').write_text('{}')
res['finished']=(r/'lease.json').exists()
print(json.dumps(res))`,
  );
  assert.equal(out['same run'], 'ok');
  assert.match(out['other run'], /hosted run run1 is open/);
  assert.equal(out.marker, 'run1');
  assert.match(out['fresh lease'], /driven by another process/);
  assert.equal(out['silent lease'], 'ok');
  assert.equal(out.holder, 'b');
  assert.equal(out.finished, false); // a finished run drops its lease
});

test('the switch never waits for a drain and refuses while a Main release runs', () => {
  const out = py(
    `${scratch}env=t/'typescript.env';env.write_bytes(b'A=1\\nMERV_FLEET_RUNTIME_RELEASE_ID=rt1_${'a'.repeat(64)}\\n')
vm.ENV=env;calls=[];live={'id':'rt1_${'a'.repeat(64)}'}
def never(*_): raise AssertionError('the switch waited for a drain')
vm.quiet=vm.busy=never
vm.inspect=lambda n:{'Image':'sha256:img','Config':{'Labels':{'com.docker.compose.project.working_dir':str(t)}}}
vm.env_of=lambda n:{vm.KEY:live['id']}
vm.healthy=lambda *a:None
def run(c,**k):
    calls.append(' '.join(map(str,c[:4])))
    if 'up' in c: live['id']=vm.env_value(env.read_bytes(),vm.KEY)
    return b''
vm.run=run;vm.main_release_running=lambda:False
step=vm.Step(r,{'drainSeconds':900})
new='rt1_${'b'.repeat(64)}'
res={'result':step.switch({'releaseId':new}),'env':env.read_text(),'calls':calls,'again':step.switch({'releaseId':new})}
vm.main_release_running=lambda:True
try: step.switch({'releaseId':'rt1_${'c'.repeat(64)}'})
except RuntimeError as e: res['busy']=str(e)
print(json.dumps(res))`,
  );
  assert.equal(out.result.changed, true);
  assert.match(out.env, new RegExp(`^A=1\nMERV_FLEET_RUNTIME_RELEASE_ID=rt1_${'b'.repeat(64)}\n$`));
  assert.deepEqual(out.calls, ['docker compose -f compose.yml', 'docker compose -f compose.yml']);
  assert.deepEqual(out.again, { changed: false });
  assert.match(out.busy, /a Main release job is running/);
});

test('the guard points Main at the release Cloudflare runs once the driver falls silent', () => {
  const out = py(
    `${scratch}import os
vm.claim('run1');old,new='rt1_${'a'.repeat(64)}','rt1_${'b'.repeat(64)}'
(r/'catalog.json').write_text(json.dumps({'releaseId':new}))
(r/'push.json').write_text(json.dumps({'image':'reg@sha256:new'}))
switched=[];vm.Step.switch=lambda self,a:switched.append(a['releaseId']) or {'changed':True}
vm.native=lambda:{'image':'reg@sha256:new','rollout':None}
step=vm.Step(r,{'current':{'image':'reg@sha256:old','releaseId':old}})
(r/'lease.json').write_text(json.dumps({'driver':'a','seen':time.time()}))
res={'alive':step.guard({})}
(r/'lease.json').write_text(json.dumps({'driver':'a','seen':time.time()-vm.LEASE-1}))
res['silent']=step.guard({})
vm.native=lambda:{'image':'reg@sha256:other','rollout':None}
res['unknown']=step.guard({})
res['switched']=switched;res['progress']=json.loads((r/'progress.json').read_text())
print(json.dumps(res))`,
  );
  assert.deepEqual(out.alive, { guard: 'driver alive' });
  assert.equal(out.silent.guard, 'switched');
  assert.equal(out.unknown.guard, 'waiting for Cloudflare to settle');
  assert.deepEqual(out.switched, [`rt1_${'b'.repeat(64)}`]);
  assert.equal(out.progress.guard.releaseId, `rt1_${'b'.repeat(64)}`);
});

test('every step from the first deploy attempt re-arms the guard timer unless it runs', () => {
  const out = py(
    `${scratch}calls,timer=[],{'active':False}
class Done:
    def __init__(self,code): self.returncode=code
def systemctl(c,**k):
    calls.append(c[1]);return Done(0 if timer['active'] else 3)
def run(c,**k):
    calls.append(c[0]);timer['active']=True
vm.subprocess.run,vm.run=systemctl,run
def arm(arg):
    calls.clear();vm.arm(r,arg);return calls[:]
res={'before':arm({}),'first':arm({'deployAttempted':True})}
(r/'progress.json').write_text(json.dumps({'deployAttempted':True}))
res['armed']=arm({})
timer['active']=False  # a host reboot drops the transient timer
res['rebooted']=arm({})
def broken(c,**k): raise RuntimeError('command_failed: systemd-run')
vm.run,timer['active']=broken,False
res['later']=arm({})
try: arm({'deployAttempted':True})
except RuntimeError as e: res['deploy']=str(e)
print(json.dumps(res))`,
  );
  const armed = ['is-active', 'stop', 'systemd-run'];
  assert.deepEqual(out.before, []);
  assert.deepEqual(out.first, armed);
  assert.deepEqual(out.armed, ['is-active']);
  assert.deepEqual(out.rebooted, armed);
  // A later step, a rollback's included, goes on without the timer; a first deploy never does.
  assert.deepEqual(out.later, ['is-active', 'stop']);
  assert.match(out.deploy, /systemd-run/);
});

test('abandon names the release production agrees on, or says what disagrees', () => {
  const [old, next] = [`rt1_${'a'.repeat(64)}`, `rt1_${'b'.repeat(64)}`];
  const out = py(
    `${scratch}old,new='${old}','${next}'
(r/'catalog.json').write_text(json.dumps({'releaseId':new}))
(r/'push.json').write_text(json.dumps({'image':'reg@sha256:new'}))
vm.ENV=t/'typescript.env'
live={'native':{'image':'reg@sha256:new','rollout':None},'main':new,
      'catalog':[{'provider':'cloudflare-fleet','image_digest':'sha256:new'}]}
vm.native=lambda:live['native']
vm.env_of=lambda n:{vm.KEY:live['main']} if n==vm.MAIN else {vm.CATALOG:json.dumps(live['catalog'])}
vm.sbx=lambda **e:{'sha256:new':new,'sha256:old':old}[json.loads(e['MERV_RELEASE'])['image_digest']]
step=vm.Step(r,{'current':{'image':'reg@sha256:old','releaseId':old}})
def attempt():
    vm.ENV.write_text(f'A=1\\n{vm.KEY}={new}\\n')
    try: return step.abandon({})
    except RuntimeError as e: return str(e)
res={'agreed':attempt()}
live['main']=old;res['main']=attempt()
live['main'],live['catalog']=new,[];res['catalog']=attempt()
live['native']={'image':'reg@sha256:other','rollout':'r1'};res['other']=attempt()
print(json.dumps(res))`,
  );
  assert.deepEqual(out.agreed, { releaseId: next, image: 'reg@sha256:new' });
  assert.equal(out.main, `production disagrees, so the run stays open: Main runs ${old}`);
  assert.match(out.catalog, /: the Sandboxes catalog lacks that release$/);
  assert.match(out.other, /neither release of this run; a Cloudflare rollout is in progress; Main/);
});

test('the push refuses an unreadable tag probe and pins a manifest despite a trailing newline', () => {
  const out = py(
    `${scratch}import hashlib
manifest=b'{"schemaVersion":2}';digest='sha256:'+hashlib.sha256(manifest).hexdigest()
(r/'build.json').write_text(json.dumps({'candidate':digest}))
mkdtemp=tempfile.mkdtemp;vm.tempfile.mkdtemp=lambda **k:mkdtemp()  # no /run here
probe={'stderr':b'ERROR: manifest unknown'}
class Done:
    def __init__(self): self.returncode,self.stderr=1,probe['stderr']
vm.subprocess.run=lambda c,**k:Done()
def run(c,**k):
    return {'push':f'latest: digest: {digest} size: 1\\n'.encode(),'buildx':manifest+b'\\n'}.get(c[1],b'')
vm.run=run
step=vm.Step(r,{'current':{'image':'reg/x@sha256:old'}})
push=lambda:step.push({'credential':{'username':'u','password':'p'}})
res={'pushed':push()['image']==f'reg/x@{digest}'}
probe['stderr']=b'ERROR: unauthorized: authentication required; manifest unknown'
try: push()
except RuntimeError as e: res['unauthorized']=str(e)
print(json.dumps(res))`,
  );
  assert.equal(out.pushed, true);
  assert.match(out.unauthorized, /^push tag probe failed :: ERROR: unauthorized/);
});

test('pi-connect-project.py holds the hosted host lock and refuses while a hosted run is open', () => {
  const connect = new URL('pi-connect-project.py', import.meta.url).pathname;
  const out = py(
    `import fcntl,pathlib,tempfile
sys.argv=['pi-connect-project.py','main','project_1']
spec=importlib.util.spec_from_file_location('connect',${JSON.stringify(connect)})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.HOSTED=pathlib.Path(tempfile.mkdtemp())/'hosted';res={}
with m.exclusive():
    with (m.HOSTED/'lock').open('a') as step:
        try: fcntl.flock(step,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: res['held']=True
    try: m.exclusive()
    except SystemExit as e: res['busy']=str(e)
(m.HOSTED/'active').write_text('run1')
try: m.exclusive()
except AssertionError as e: res['open']=str(e)
print(json.dumps(res))`,
  );
  assert.equal(out.held, true);
  assert.match(out.busy, /a hosted-release step holds the host lock/);
  assert.match(out.open, /^hosted_run_open/);
});
