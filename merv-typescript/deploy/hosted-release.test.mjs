import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  APPS,
  WATCH,
  classify,
  describePlan,
  ledgerRow,
  pinProblems,
  rollbackSteps,
  unsettled,
} from './hosted-release.mjs';
import { publishLedgers } from './source-archive.mjs';

const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const seed = read('hosted-release.json');
const templates = Object.fromEntries(Object.entries(APPS).map(([p, f]) => [p, read(f.slice(7))]));
const template = templates['cloudflare-fleet'];
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
  // Where the host refuses Codex's own sandbox the report says so; it may not claim the sandbox's check.
  const workflow = (extra) =>
    JSON.stringify({ gate: 'linux-workflow-dispatch', codexCalledOnlyTheRelay: true, ...extra });
  const dispatch = 'linux-workflow-gate.py';
  assert.equal(passed(workflow({ codexSandboxOnHost: false }), dispatch), true);
  assert.equal(
    passed(
      workflow({ codexSandboxOnHost: true, sessionBearerUnreadableFromShell: true }),
      dispatch,
    ),
    true,
  );
  assert.equal(passed(workflow({ sessionBearerUnreadableFromShell: false }), dispatch), false);
  assert.equal(passed(workflow({ workHostStepRan: false }), dispatch), false);
  const reviewChecks = py('print(json.dumps(vm.REVIEW_CHECKS))');
  const review = {
    gate: 'linux-review-readonly',
    ...Object.fromEntries(reviewChecks.map((key) => [key, true])),
    actualProtectedWorkflow: false,
    cloudflareEvidence: false,
  };
  assert.equal(passed(JSON.stringify(review), 'linux-review-gate.py'), true);
  for (const key of [...reviewChecks, 'actualProtectedWorkflow', 'cloudflareEvidence']) {
    const missing = { ...review };
    delete missing[key];
    assert.equal(passed(JSON.stringify(missing), 'linux-review-gate.py'), false, key);
    assert.equal(
      passed(JSON.stringify({ ...review, [key]: !review[key] }), 'linux-review-gate.py'),
      false,
      key,
    );
  }
});

test('gate failure cleans up; a container removal failure retains its AppArmor profile', () => {
  for (const cleanupFails of [false, true]) {
    const result = py(
      `calls=[]
vm.Path.read_text=lambda path:''
vm.run=lambda command,**kwargs:calls.append(command) or b''
def remove(command,**kwargs):
    calls.append(command);return type('Result',(),{'returncode':1 if i else 0,'stderr':b'daemon unavailable'})()
vm.subprocess.run=remove
try:
    with vm.gate_environment(True): raise RuntimeError('original gate failure')
except RuntimeError as error: reason=str(error)
print(json.dumps({'calls':calls,'reason':reason}))`,
      cleanupFails,
    );
    assert.equal(result.calls.length, cleanupFails ? 3 : 4);
    assert.match(result.reason, cleanupFails ? /gate cleanup failed/ : /original gate failure/);
    if (cleanupFails) assert.ok(result.reason.includes(result.calls[2].at(-1)));
  }
  assert.deepEqual(
    py(`vm.run=lambda *args,**kwargs:(_ for _ in ()).throw(Exception('must not load'))
with vm.gate_environment(False) as profile: print(json.dumps(profile))`),
    null,
  );
});

test('workflow seccomp preserves the exact pinned default and adds only pivot_root', () => {
  const result = py(`import tempfile
def run(command):
    return json.dumps({'Version':'29.6.0','GitCommit':'70eaf5e'} if command[1]=='version' else ['name=seccomp,profile=builtin']).encode()
vm.run=run
with tempfile.TemporaryDirectory() as directory:
    path=vm.Path(directory)/'seccomp.json'
    assert vm.gate_seccomp(path)==str(path)
    print(path.read_text())`);
  const raw = readFileSync(new URL('vendor/docker-seccomp/default.json', import.meta.url));
  assert.equal(
    createHash('sha256').update(raw).digest('hex'),
    '536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74',
  );
  const baseline = JSON.parse(raw);
  assert.ok(!baseline.syscalls.some((rule) => rule.names.includes('pivot_root')));
  baseline.syscalls.push({ names: ['pivot_root'], action: 'SCMP_ACT_ALLOW' });
  assert.deepEqual(result, baseline);
  assert.ok(WATCH.includes('deploy/vendor/docker-seccomp/'));
  assert.equal(classify(['deploy/vendor/docker-seccomp/default.json'], []), 'boundary');
});

test('workflow seccomp refuses Docker upgrades, custom defaults and modified baseline bytes', () => {
  for (const failure of ['version', 'custom', 'bytes']) {
    const result = py(
      `import tempfile
def run(command):
    return json.dumps({'Version':'new' if i=='version' else '29.6.0','GitCommit':'70eaf5e'} if command[1]=='version' else ['name=seccomp,profile=custom' if i=='custom' else 'name=seccomp,profile=builtin']).encode()
vm.run=run
if i=='bytes': vm.Path.read_bytes=lambda path:b'{}'
with tempfile.TemporaryDirectory() as directory:
    path=vm.Path(directory)/'seccomp.json'
    try: vm.gate_seccomp(path)
    except RuntimeError as error: print(json.dumps({'reason':str(error),'exists':path.exists()}))`,
      failure,
    );
    assert.equal(result.exists, false);
    assert.match(result.reason, /seccomp baseline/);
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
  const digest = seed.current.image.split('@')[1];
  const standard = { 'cloudflare-fleet': seed.current.releaseId };
  const live = {
    apps: { 'cloudflare-fleet': settled },
    mainReleaseId: seed.current.releaseId,
    fileReleaseId: seed.current.releaseId,
    releases: standard,
    fileReleases: standard,
    catalog: [{ provider: 'cloudflare-fleet', digest, id: seed.current.releaseId }],
  };
  assert.deepEqual(pinProblems(seed.current, templates, live), []);
  assert.deepEqual(
    pinProblems(seed.current, templates, {
      ...live,
      mainReleaseId: 'rt1_x',
      releases: { 'cloudflare-fleet': 'rt1_x' },
      catalog: [],
    }),
    [
      'Main runs rt1_x',
      'the env file names other machine releases than Main runs',
      "the Sandboxes catalog lacks cloudflare-fleet's live release",
    ],
  );
  // Pre-warmed or transient launches do not block the drift check; only the settle wait.
  const busy = {
    ...live,
    apps: {
      'cloudflare-fleet': { ...settled, health: { errors: [], instances: { starting: 1 } } },
    },
  };
  assert.deepEqual(pinProblems(seed.current, templates, busy), []);
  // After the Pi host cutover: Large runs the live image too, and Main names its copy.
  const big = { ...settled, name: 'merv-sandboxes-bridge-large-sandboxcontainer-large' };
  const both = { ...standard, 'cloudflare-fleet-large': 'rt1_large' };
  const cutover = {
    ...live,
    apps: { ...live.apps, 'cloudflare-fleet-large': { ...big, maxInstances: 10 } },
    releases: both,
    fileReleases: both,
    catalog: [...live.catalog, { provider: 'cloudflare-fleet-large', digest, id: 'rt1_large' }],
  };
  assert.deepEqual(pinProblems(seed.current, templates, cutover), []);
  const drifted = {
    ...cutover,
    apps: { ...cutover.apps, 'cloudflare-fleet-large': { ...big, image: 'x', maxInstances: 10 } },
    fileReleases: standard,
    catalog: live.catalog,
  };
  assert.deepEqual(pinProblems(seed.current, templates, drifted), [
    'cloudflare-fleet-large image x',
    'the env file names other machine releases than Main runs',
    "the Sandboxes catalog lacks cloudflare-fleet-large's live release",
  ]);
  const unknown = { ...cutover, apps: { ...cutover.apps, 'other-app': big } };
  assert.deepEqual(pinProblems(seed.current, templates, unknown), [
    'no template deploys other-app',
  ]);
});

test('rollback undoes what was attempted in the forward order, then verifies with a canary', () => {
  const releases = { 'cloudflare-fleet': 'rt1_old', 'cloudflare-fleet-large': 'rt1_oldL' };
  const previous = { image: image('a'), releaseId: 'rt1_old', releases, sandboxesCommit: 'c1' };
  assert.deepEqual(rollbackSteps({}, previous), []);
  assert.deepEqual(rollbackSteps({ catalogBroken: true }, previous), [['catalog']]);
  // The switch is always undone after a deploy: the host guard may have switched Main meanwhile.
  // Main follows the image at once; the settle comes after, as on the way forward.
  assert.deepEqual(rollbackSteps({ deployAttempted: true }, previous), [
    ['deploy', previous],
    ['switch', { releaseId: 'rt1_old', releases }],
    ['settle', image('a')],
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
  assert.match(
    ledgerRow({ at: '2026-09-25T10:11Z', sourceCommit: 'a', lane: 'worker', version: [16, 2] }),
    /\| v16 v2 \|/,
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

// A run on both apps: Main's machines at preflight, and the run's own releases once catalogued.
const [OLD, NEW] = ['a', 'b'].map((c) => `rt1_${c.repeat(64)}`);
const [OLD_L, NEW_L] = ['c', 'd'].map((c) => `rt1_${c.repeat(64)}`);
const twoApps = `(r/'preflight.json').write_text(json.dumps({'releases':{'cloudflare-fleet':'${OLD}','cloudflare-fleet-large':'${OLD_L}'}}))
(r/'catalog.json').write_text(json.dumps({'releaseId':'${NEW}','releases':{'cloudflare-fleet':'${NEW}','cloudflare-fleet-large':'${NEW_L}'}}))
(r/'push.json').write_text(json.dumps({'image':'reg@sha256:new'}))
step=vm.Step(r,{'current':{'image':'reg@sha256:old','releaseId':'${OLD}'},'canary':{'credential':'/c'}})
apps={'cloudflare-fleet':{'image':'reg@sha256:new','rollout':None},'cloudflare-fleet-large':{'image':'reg@sha256:new','rollout':None}}
vm.native=lambda p='cloudflare-fleet':apps[p]
`;

// A scratch HOME and run directory, with the module's docker/pgrep calls replaced.
const scratch = `import pathlib,tempfile,time
t=pathlib.Path(tempfile.mkdtemp());vm.MAINTENANCE=t/'maintenance.lock';vm.RECOVERY_PENDING=t/'resume.json';vm.HOME=t/'home';vm.HOME.mkdir();r=t/'run1';r.mkdir()
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

test('the drain holds work machines and waits until Fleet has released each, or gives up lifting its hold', () => {
  // Two work steps run as the drain starts; their machines settle and Fleet releases them at 20 s
  // and 25 s. A Cloudflare rollout replaces every running container, so none may still be up.
  const out = py(`import types
clock=[0.0];work=['flt_w1','flt_w2'];queries=[];settles=[True]
vm.time=types.SimpleNamespace(monotonic=lambda:clock[0],sleep=lambda s:clock.__setitem__(0,clock[0]+s))
def main_read(q,*p,write=False,url=None):
    if url == 'SANDBOXES_DATABASE_URL': return {'machines':'[]','bootstraps':'[]'}
    queries.append([q,write])
    if q==vm.UNHOLD: return {'lifted':True}
    if clock[0]>=20 and work and settles[0]: work.pop()
    out={'turns':'[]','launches':'[]','kept':json.dumps([['sbx_'+w,'rln_'+w] for w in work])}
    if 'AS warm' in q: out.update(warm='[]',work=json.dumps(work))
    return out
vm.main_read=main_read
res={'catalog':vm.busy(),'drained':vm.Step(None,{'drainSeconds':900}).drain({}),'at':clock[0],'left':list(work)}
res['held']=all(vm.HOLD in q and vm.IDLE in q and w for q,w in queries[1:])
res['catalogHeld']=vm.HOLD in queries[0][0];res['lifted']=any(q==vm.UNHOLD for q,_ in queries)
work[:]=['flt_long'];clock[0]=0;queries.clear();settles[0]=False
try: vm.Step(None,{'drainSeconds':60}).drain({})
except RuntimeError as e: res['gaveUp']=str(e)
res['liftedAfter']=queries[-1]==[vm.UNHOLD,True]
print(json.dumps(res))`);
  // The catalog's wait neither holds nor waits on work machines; their steps run for hours.
  assert.deepEqual([out.catalog, out.catalogHeld], [{}, false]);
  assert.deepEqual(
    [out.drained, out.left, out.held, out.lifted],
    [{ drained: true }, [], true, false],
  );
  assert.ok(out.at >= 25, String(out.at));
  // A step that runs past --drain-minutes: the drain gives up, lifting its hold, nothing deployed.
  assert.match(
    out.gaveUp,
    /^not_drained_after_60s \{"work": \["flt_long"\]\}.*a work step was still running/,
  );
  assert.equal(out.liftedAfter, true);
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
vm.run=run;vm.main_release_running=lambda:False;vm.unhold=lambda:calls.append('unhold')
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
  // The drain's hold on work machines outlasts the switch: a canary that fails rolls back, and a
  // step admitted meanwhile would hold that rollback up until it ends. The canary lifts it.
  assert.deepEqual(out.calls, ['docker compose -f compose.yml', 'docker compose -f compose.yml']);
  assert.deepEqual(out.again, { changed: false });
  assert.match(out.busy, /a Main release job is running/);
});

test('the switch names every machine its release, and restores the env when Main does not take it', () => {
  const out = py(
    `${scratch}env=t/'typescript.env';vm.ENV=env
machine=lambda k,p,i:{'key':k,'provider':p,'releaseId':i}
line=lambda s,l:vm.RUNTIMES+"='"+json.dumps([machine('standard','cloudflare-fleet',s),machine('large','cloudflare-fleet-large',l)],separators=(',',':'))+"'"
env.write_text(f"{vm.KEY}=${OLD}\\n{line('${OLD}','${OLD_L}')}\\n")
vm.inspect=lambda n:{'Image':'sha256:img','Config':{'Labels':{'com.docker.compose.project.working_dir':str(t)}}}
vm.healthy=lambda *a:None;vm.main_release_running=lambda:False
main={};take=[True]
def recreate():
    f=vm.file_env(env.read_bytes());main.clear()
    if take[0]: main.update({vm.KEY:f[vm.KEY],vm.RUNTIMES:f[vm.RUNTIMES].strip("'")})
recreate();vm.env_of=lambda n:dict(main)
vm.run=lambda c,**k:(recreate() if 'up' in c else None) or b''
step=vm.Step(r,{})
both={'cloudflare-fleet':'${NEW}','cloudflare-fleet-large':'${NEW_L}'}
res={'result':step.switch({'releaseId':'${NEW}','releases':both})['changed'],'env':env.read_text()}
res['again']=step.switch({'releaseId':'${NEW}','releases':both})
res['partial']=step.switch({'releases':{'cloudflare-fleet':'${OLD}'}})['changed'];res['kept']=env.read_text()
take[0]=False
try: step.switch({'releases':{'cloudflare-fleet':'${OLD}','cloudflare-fleet-large':'${OLD_L}'}})
except RuntimeError as e: res['refused']=str(e)
res['restored']=env.read_text()
print(json.dumps(res))`,
  );
  const line = (s, l) =>
    `MERV_FLEET_RUNTIMES='[{"key":"standard","provider":"cloudflare-fleet","releaseId":"${s}"},{"key":"large","provider":"cloudflare-fleet-large","releaseId":"${l}"}]'`;
  assert.equal(out.result, true);
  assert.equal(out.env, `MERV_FLEET_RUNTIME_RELEASE_ID=${NEW}\n${line(NEW, NEW_L)}\n`);
  assert.deepEqual(out.again, { changed: false });
  // A machine the switch leaves out keeps the release Main runs.
  assert.equal(out.partial, true);
  assert.equal(out.kept, `MERV_FLEET_RUNTIME_RELEASE_ID=${OLD}\n${line(OLD, NEW_L)}\n`);
  assert.match(out.refused, /Main did not take the release/);
  assert.equal(out.restored, out.kept);
});

test('the guard points each machine at the release its app runs once the driver falls silent', () => {
  const out = py(
    `${scratch}vm.claim('run1')
${twoApps}switched=[];vm.Step.switch=lambda self,a:switched.append(a['releases']) or {'changed':True}
(r/'lease.json').write_text(json.dumps({'driver':'a','seen':time.time()}))
res={'alive':step.guard({})}
(r/'lease.json').write_text(json.dumps({'driver':'a','seen':time.time()-vm.LEASE-1}))
apps['cloudflare-fleet-large']['image']='reg@sha256:old'  # Large not deployed yet
res['silent']=step.guard({})
apps['cloudflare-fleet']['image']='reg@sha256:other'
res['unknown']=step.guard({})
res['progress']=json.loads((r/'progress.json').read_text())
# Sandboxes cannot read Large (its provider disabled): Standard's machine still follows its app.
apps['cloudflare-fleet']['image']='reg@sha256:old'
def unreadable(p='cloudflare-fleet'):
    if p=='cloudflare-fleet-large': raise RuntimeError('cloudflare-fleet-large is not an enabled Sandboxes provider')
    return apps[p]
vm.native=unreadable;res['unread']=step.guard({});res['switched']=switched
print(json.dumps(res))`,
  );
  assert.deepEqual(out.alive, { guard: 'driver alive' });
  assert.equal(out.silent.guard, 'switched');
  assert.equal(out.unknown.guard, 'waiting for Cloudflare to settle');
  const each = { 'cloudflare-fleet': NEW, 'cloudflare-fleet-large': OLD_L };
  assert.deepEqual(out.progress.guard.releases, each);
  // The switch keeps the release Main runs for the machine it leaves out.
  assert.deepEqual(out.switched, [each, { 'cloudflare-fleet': OLD }]);
  assert.deepEqual(out.unread, {
    guard: 'switched',
    releases: { 'cloudflare-fleet': OLD },
    unread: ['cloudflare-fleet-large'],
  });
});

const profileId = (p) =>
  `srp_${createHash('sha256')
    .update(
      JSON.stringify([p.provider, p.offerId, p.releaseId, p.leaseSeconds, p.ttlSeconds ?? 300]),
    )
    .digest('hex')}`;

test("a production ledger is committed by path and pushed only from origin/main's tip", () => {
  const t = mkdtempSync(join(tmpdir(), 'merv-ledger-'));
  const git = (cwd, ...a) =>
    execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], {
      encoding: 'utf8',
    }).trim();
  try {
    const [origin, work] = [join(t, 'origin.git'), join(t, 'work')];
    git(t, 'init', '-q', '--bare', '-b', 'main', origin);
    git(t, 'clone', '-q', origin, work);
    for (const [key, value] of [
      ['user.email', 't@t'],
      ['user.name', 't'],
    ])
      git(work, 'config', key, value);
    const ledgers = ['RELEASES.md', 'hosted-release.json'].map((f) => join(work, f));
    for (const file of [...ledgers, join(work, 'peer.txt')]) writeFileSync(file, 'v1\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-qm', 'base');
    git(work, 'push', '-q', 'origin', 'HEAD:main');
    for (const file of [...ledgers, join(work, 'peer.txt')]) writeFileSync(file, 'v2\n');
    publishLedgers(ledgers, 'Record run R1');
    assert.equal(git(origin, 'log', '-1', '--format=%s', 'main'), 'Record run R1 [skip ci]');
    assert.equal(
      git(origin, 'show', '--name-only', '--format=', 'main'),
      ledgers.map((f) => f.slice(work.length + 1)).join('\n'),
    );
    assert.equal(git(work, 'status', '--porcelain'), 'M peer.txt'); // a peer's edit stays
    // Behind or ahead of origin/main, the ledgers stay in the working tree.
    git(work, 'commit', '-qm', 'local', '--', 'peer.txt');
    writeFileSync(ledgers[0], 'v3\n');
    publishLedgers(ledgers, 'Record run R2');
    assert.equal(git(origin, 'log', '-1', '--format=%s', 'main'), 'Record run R1 [skip ci]');
    assert.equal(git(work, 'status', '--porcelain'), 'M RELEASES.md');
    // A peer commit made while ls-remote runs lands under the ledger commit, so neither is pushed.
    git(work, 'reset', '-q', '--hard', 'origin/main');
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const peer = `${real} -C ${work} commit -qm peer -- peer.txt`;
    writeFileSync(
      join(t, 'git'),
      `#!/bin/sh\ncase "$*" in *ls-remote*) ${peer};; esac\nexec ${real} "$@"\n`,
    );
    execFileSync('chmod', ['+x', join(t, 'git')]);
    for (const file of [...ledgers, join(work, 'peer.txt')]) writeFileSync(file, 'v4\n');
    const path = process.env.PATH;
    process.env.PATH = `${t}:${path}`;
    try {
      publishLedgers(ledgers, 'Record run R3');
    } finally {
      process.env.PATH = path;
    }
    assert.equal(git(origin, 'log', '-1', '--format=%s', 'main'), 'Record run R1 [skip ci]');
    assert.equal(git(work, 'log', '-2', '--format=%s'), 'Record run R3 [skip ci]\npeer');
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('catalog changes validate both readers before recreating and restore both after failure', () => {
  const out = py(`${scratch}import types
raw=b'OTHER=$literal\\nSANDBOXES_RUNTIME_RELEASES=[]\\n'
state={'raw':raw}; calls=[]; fail=[True]
vm.SHARED=types.SimpleNamespace(stat=lambda:types.SimpleNamespace(st_uid=0,st_gid=0,st_mode=0o100600),read_bytes=lambda:state['raw'])
vm.atomic=lambda path,data,*args:state.update(raw=data)
vm.main_release_running=lambda:False
vm.inspect=lambda n:{'Image':n+'-image','Config':{'Labels':{'com.docker.compose.project':n,'com.docker.compose.project.config_files':'/compose.yml',
    'com.docker.compose.project.working_dir':'/'}}}
def run(c,**kwargs):
    calls.append([c,kwargs['env'].get('MERV_TS_IMAGE') or kwargs['env'].get('SANDBOXES_TS_IMAGE')])
    if 'up' in c and vm.MAIN in c and fail[0]:
        fail[0]=False;raise RuntimeError('recreate failed')
vm.run=run;vm.healthy=lambda *a:None
vm.env_of=lambda n:{vm.CATALOG:vm.env_value(state['raw'],vm.CATALOG)}
vm.release_ids=lambda entries:['rt1_new'];vm.quiet=lambda *a:None
step=vm.Step(r,{'drainSeconds':10});entry={'provider':vm.PROVIDER,'image_digest':'sha256:new'}
try:step.add_releases({'entries':[entry],'releases':{vm.PROVIDER:'rt1_new'}},r/'catalog.before')
except RuntimeError as e: error=str(e)
print(json.dumps({'calls':calls,'restored':state['raw']==raw,'error':error}))`);
  assert.equal(out.error, 'recreate failed');
  assert.equal(out.restored, true);
  const commands = out.calls.map(([args]) => args);
  const firstUp = commands.findIndex((args) => args.includes('up'));
  assert.ok(commands.slice(0, firstUp).some((args) => args.includes('--status')));
  assert.ok(
    commands.slice(0, firstUp).some((args) => args.includes('/app/deploy/render-config.mjs')),
  );
  assert.equal(commands.filter((args) => args.includes('up')).length, 4);
  for (const [args, image] of out.calls) assert.equal(image, args[3] + '-image');
});

test('host state refresh cannot drop an outstanding staging deferral', () => {
  const result = py(`${scratch}
vm.owner=lambda:'';vm.unhold=lambda:None;vm.subprocess.run=lambda *a,**k:None
old={'status':'deferred','reason':'Storage pending','sourceRun':'earlier','image':'old-image','releaseId':'old-release'}
vm.atomic(vm.HOME/'state.json',json.dumps({'current':{'image':'old-image'},'staging':old}).encode())
step=vm.Step(r,{})
for status in ['current','rechecked','rechecked, canary failed','pass']:
 step.finish({'result':status,'state':{'current':{'image':'new-image'},'inputs':[]}})
 assert vm.read(vm.HOME/'state.json')['staging']==old
print(json.dumps(vm.read(vm.HOME/'state.json')))`);
  assert.equal(result.current.image, 'new-image');
  assert.equal(result.staging.status, 'deferred');
  assert.equal(result.staging.sourceRun, 'earlier');
});
