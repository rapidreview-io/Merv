import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APPS,
  GATES,
  LEASE,
  WATCH,
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
  // The build recipe builds too: the host's Dockerfiles, Go image and worker tests, NODE_IMAGE and
  // the TypeScript settings. The host's image diff decides the lane.
  for (const recipe of [
    'deploy/hosted-release-vm.py',
    'deploy/source-archive.mjs',
    'tsconfig.json',
  ])
    assert.ok(WATCH.includes(recipe), recipe);
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
  // The release of 2026-09-25T02:00Z as Sandboxes derived it; the seed moves on with each release.
  const live = `registry.cloudflare.com/ac27350cd4a42855004ab960c906b6d5/merv-hosted-codex@sha256:3ca9ef18a5fe95d65b0277963098cc938b0908bbb61e80cf6185bfc1d10720a6`;
  assert.equal(
    releaseId(releaseEntry(live, LIVE_EXECUTABLE)),
    'rt1_4166a6347f29f54b8109107638c9d39175ed38117051c7c2cc7a1a767ab31d3b',
  );
  assert.throws(() =>
    releaseEntry('registry.cloudflare.com/acct/merv-hosted-codex:latest', LIVE_EXECUTABLE),
  );
  assert.throws(() => releaseEntry(image('a'), 'not-a-hash'));
});

test('each app template is the app wrangler created: Standard at 50 machines, Large its standard-3 at 10', () => {
  const large = templates['cloudflare-fleet-large'];
  const [standard, big] = [template, large].map((t) => t.containers[0]);
  assert.equal(standard.max_instances, 50); // never lower: the host limit
  assert.deepEqual(
    [large.name, big.name, large.vars.SHAPE, big.instance_type, big.max_instances],
    [
      'merv-sandboxes-bridge-large',
      'merv-sandboxes-bridge-large-sandboxcontainer-large',
      'standard-3',
      'standard-3',
      10,
    ],
  );
  // One bridge Worker, account and Durable Object class; only the app and its shape differ.
  for (const key of ['account_id', 'main', 'compatibility_date', 'durable_objects', 'migrations'])
    assert.deepEqual(large[key], template[key], key);
  assert.deepEqual(
    { ...big, name: '', instance_type: '', max_instances: 0 },
    {
      ...standard,
      name: '',
      instance_type: '',
      max_instances: 0,
    },
  );
  assert.ok(wranglerConfig(large, image('c'), '/w'));
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

test('the env edit replaces exactly one release id line, and each machine release', () => {
  const raw = 'A=1\nMERV_FLEET_RUNTIME_RELEASE_ID=rt1_old\nB=\'{"x":1}\'\n';
  const out = py(
    'print(json.dumps(vm.with_env(i.encode(),"MERV_FLEET_RUNTIME_RELEASE_ID","rt1_new").decode()))',
    raw,
  );
  assert.equal(out, 'A=1\nMERV_FLEET_RUNTIME_RELEASE_ID=rt1_new\nB=\'{"x":1}\'\n');
  assert.match(python("vm.with_env(b'K=1\\nK=2\\n','K','3')").stderr, /env_key_not_unique/);
  const edit = (env, releases) =>
    py('print(json.dumps(vm.with_releases(i[0].encode(),i[1]).decode()))', [env, releases]);
  // Before the cutover the legacy key is Standard's only machine.
  assert.equal(edit(raw, { 'cloudflare-fleet': 'rt1_new' }), out);
  const machine = (key, provider, releaseId) => ({ key, provider, offerId: 'o', releaseId });
  const runtimes = (s, l) => [
    machine('standard', 'cloudflare-fleet', s),
    machine('large', 'cloudflare-fleet-large', l),
  ];
  const quoted = (list) => `MERV_FLEET_RUNTIMES='${JSON.stringify(list)}'`;
  const env = `${raw}${quoted(runtimes('rt1_old', 'rt1_oldL'))}\nC=2\n`;
  const releases = { 'cloudflare-fleet': 'rt1_new', 'cloudflare-fleet-large': 'rt1_newL' };
  assert.equal(edit(env, releases), `${out}${quoted(runtimes('rt1_new', 'rt1_newL'))}\nC=2\n`);
  const machines = py('print(json.dumps(vm.machines(vm.file_env(i.encode()))))', env);
  assert.deepEqual(machines, {
    'cloudflare-fleet': 'rt1_old',
    'cloudflare-fleet-large': 'rt1_oldL',
  });
  const partial = python('vm.with_releases(i.encode(),{"cloudflare-fleet":"rt1_new"})', env);
  assert.match(partial.stderr, /no release for every machine/);
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

test('the drain releases each Pi machine that goes idle while it waits, and ends only once none is up', () => {
  // Alice's turn runs as the drain starts and ends at 5 s; a page warms a machine at 15 s. Main
  // releases a machine at its first pass after the drain ended its host's idle clock.
  const out = py(`import types
clock=[0.0];hosts={'alice':{'turn':True,'idle':None,'up':True}};released=[]
vm.time=types.SimpleNamespace(monotonic=lambda:clock[0],sleep=lambda s:clock.__setitem__(0,clock[0]+s))
vm.sbx=lambda **e:'[]'
def main_read(q,*p,write=False):
    assert write==(vm.IDLE in q)
    for h in hosts.values(): h['up']=h['up'] and h['idle']!=0
    if clock[0]>=5 and hosts['alice']['turn']: hosts['alice'].update(turn=False,idle=clock[0])
    if clock[0]>=15: hosts.setdefault('page',{'turn':False,'idle':clock[0],'up':True})
    up=[k for k,h in hosts.items() if h['up']]
    if write:
        for k in up:
            if hosts[k]['idle']: hosts[k]['idle']=0;released.append([k,clock[0]])
    out={'turns':json.dumps([k for k,h in hosts.items() if h['turn']]),'launches':'[]'}
    return {**out,'warm':json.dumps(up)} if 'AS warm' in q else out if 'turns' in q else {'n':0}
vm.main_read=main_read
res={'catalog':vm.busy(),'drained':vm.Step(None,{'drainSeconds':900}).drain({}),'at':clock[0]}
res['up']=[k for k,h in hosts.items() if h['up'] and h['idle']!=0];res['released']=released
print(json.dumps(res))`);
  assert.deepEqual(out.catalog, { turns: ['alice'] }); // the catalog's wait releases nothing
  assert.deepEqual(out.released, [
    ['alice', 5],
    ['page', 15],
  ]);
  assert.deepEqual([out.drained, out.at, out.up], [{ drained: true }, 30, []]);
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

test('the pin check reads the apps of the machines Main or the env file names, and claims nothing', () => {
  const out = py(
    `${scratch}vm.ENV=t/'typescript.env'
runtimes=json.dumps([{'provider':'cloudflare-fleet','releaseId':'${OLD}'},{'provider':'cloudflare-fleet-large','releaseId':'${OLD_L}'}])
vm.ENV.write_text(f"{vm.KEY}=${OLD}\\n{vm.RUNTIMES}='{runtimes}'\\n")
vm.env_of=lambda n:{vm.KEY:'${OLD}'} if n==vm.MAIN else {vm.CATALOG:'[]'}
vm.native=lambda p:{'image':p};vm.release_ids=lambda entries:[]
pins=vm.Step(r,{}).pins();pins['active']=vm.owner()
print(json.dumps(pins))`,
  );
  // At the cutover the env file names Large before a release recreates Main with it.
  assert.deepEqual(Object.keys(out.apps), ['cloudflare-fleet', 'cloudflare-fleet-large']);
  assert.deepEqual(out.releases, { 'cloudflare-fleet': OLD });
  assert.deepEqual(out.fileReleases, { 'cloudflare-fleet': OLD, 'cloudflare-fleet-large': OLD_L });
  assert.equal(out.active, '');
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

test('from the first deploy attempt every step keeps the open run an enabled guard timer', () => {
  const out = py(
    `${scratch}vm.GUARD=t/'merv-hosted-guard';calls,timer=[],{'active':False}
class Done:
    def __init__(self,code): self.returncode=code
def systemctl(c,**k):
    calls.append(' '.join(c[1:3]));return Done(0 if timer['active'] else 3)
def run(c,**k):
    calls.append(c[1]);timer['active']=True
vm.subprocess.run,vm.run=systemctl,run
def arm(arg,run=r):
    calls.clear();vm.arm(run,arg);return calls[:]
res={'before':arm({}),'first':arm({'deployAttempted':True})}
res['units']=[vm.GUARD.with_suffix(s).read_text() for s in ('.service','.timer')]
(r/'progress.json').write_text(json.dumps({'deployAttempted':True}))
res['armed']=arm({})
timer['active']=False  # stopped by hand
res['stopped']=arm({})
r2=t/'run2';r2.mkdir();res['next run']=arm({'deployAttempted':True},r2)
def broken(c,**k): raise RuntimeError('command_failed: systemctl')
vm.run,timer['active']=broken,False
res['later']=arm({})
try: arm({'deployAttempted':True})
except RuntimeError as e: res['deploy']=str(e)
vm.claim('run2');calls.clear();vm.Step(r,{}).finish({});res['finished other']=calls[:]
calls.clear();vm.Step(r2,{}).finish({});res['finished own']=calls[:1]
print(json.dumps(res))`,
  );
  assert.deepEqual(out.before, []);
  assert.deepEqual(out.first, ['daemon-reload', 'enable']);
  // Installed and enabled, not transient: a reboot starts it again.
  assert.match(out.units[0], /^ExecStart=\S+python\S* \S+hosted-release-vm\.py guard \S+\/run1$/m);
  assert.match(out.units[1], /\[Install\]\nWantedBy=timers\.target/);
  assert.deepEqual(out.armed, ['is-active --quiet']);
  assert.deepEqual(out.stopped, ['is-active --quiet', 'daemon-reload', 'enable']);
  assert.deepEqual(out['next run'], ['daemon-reload', 'enable']);
  // A later step, a rollback's included, goes on without the timer; a first deploy never does.
  assert.deepEqual(out.later, []);
  assert.match(out.deploy, /systemctl/);
  // Only the run that holds the host stops the timer when it finishes.
  assert.ok(!out['finished other'].includes('disable --now'), out['finished other']);
  assert.deepEqual(out['finished own'], ['disable --now']);
});

test('abandon names the release production agrees on, or says what disagrees', () => {
  const [old, next] = [`rt1_${'a'.repeat(64)}`, `rt1_${'b'.repeat(64)}`];
  const out = py(
    `${scratch}old,new='${old}','${next}'
(r/'catalog.json').write_text(json.dumps({'releaseId':new,'releases':{'cloudflare-fleet':new}}))
(r/'push.json').write_text(json.dumps({'image':'reg@sha256:new'}))
vm.ENV=t/'typescript.env'
live={'native':{'image':'reg@sha256:new','rollout':None},'main':new,
      'catalog':[{'provider':'cloudflare-fleet','image_digest':'sha256:new'}]}
vm.native=lambda p='cloudflare-fleet':live['native']
vm.env_of=lambda n:{vm.KEY:live['main']} if n==vm.MAIN else {vm.CATALOG:json.dumps(live['catalog'])}
vm.release_ids=lambda entries:[{'sha256:new':new,'sha256:old':old}[e['image_digest']] for e in entries]
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
  assert.deepEqual(out.agreed, {
    releaseId: next,
    releases: { 'cloudflare-fleet': next },
    image: 'reg@sha256:new',
  });
  assert.equal(out.main, `production disagrees, so the run stays open: Main runs ${old}`);
  assert.match(out.catalog, /: the Sandboxes catalog lacks that release$/);
  assert.match(out.other, /neither release of this run; a Cloudflare rollout is in progress; Main/);
});

test('abandon on two apps needs both on one image and every machine naming its release', () => {
  const out = py(
    `${scratch}${twoApps}vm.ENV=t/'typescript.env'
ids={('cloudflare-fleet','sha256:new'):'${NEW}',('cloudflare-fleet-large','sha256:new'):'${NEW_L}'}
catalog=[{'provider':p,'image_digest':d} for p,d in ids]
vm.release_ids=lambda entries:[ids[e['provider'],e['image_digest']] for e in entries]
runtimes="'"+json.dumps([{'key':'standard','provider':'cloudflare-fleet','releaseId':'${NEW}'},
                         {'key':'large','provider':'cloudflare-fleet-large','releaseId':'${NEW_L}'}])+"'"
vm.ENV.write_text(f"{vm.KEY}=${NEW}\\n{vm.RUNTIMES}={runtimes}\\n")
vm.env_of=lambda n:{vm.KEY:'${NEW}',vm.RUNTIMES:runtimes.strip("'")} if n==vm.MAIN else {vm.CATALOG:json.dumps(catalog)}
res={'agreed':step.abandon({})}
apps['cloudflare-fleet-large']['image']='reg@sha256:old'
try: step.abandon({})
except RuntimeError as e: res['split']=str(e)
print(json.dumps(res))`,
  );
  const releases = { 'cloudflare-fleet': NEW, 'cloudflare-fleet-large': NEW_L };
  assert.deepEqual(out.agreed, { releaseId: NEW, releases, image: 'reg@sha256:new' });
  assert.match(out.split, /stays open: the Cloudflare apps run different images$/);
});

test('the canary releases a Pi v2 machine as its person would, then checks it served the release', () => {
  const out = py(
    `${scratch}${twoApps}vm.credential=lambda path:{'projectId':'p'};vm.whoami=lambda c:None
vm.secrets.token_hex=lambda n:'beef';vm.time.sleep=lambda s:None
for app in apps.values(): app['health']={'errors':[],'instances':{'failed':0}}
def canary(v2=True,releases=True):
    calls,phase=[],['active']
    def tool(c,name,body,tries=12):
        calls.append(name)
        if name=='pi.machine.stop' and not v2: raise RuntimeError('pi.machine.stop_http_404_None')
        if name==('pi.machine.stop' if v2 else 'pi.stop') and releases: phase[0]='released'
        command={'id':'cmd1','status':'completed','runtimeId':'fa_1','messages':[{'role':'assistant','text':'canary-beef'}]}
        return {'pi.create':{'id':'conv1'},'pi.send':{'id':'cmd1'},'pi.snapshot':{'commands':[command]}}.get(name,{})
    def main_read(query,*p):
        if 'launch' in query: return {'n':int(p==('fa_1','${OLD}'))}
        return {'n':int(p==('fa_1',) and phase[0]!='released')}
    vm.tool,vm.main_read=tool,main_read
    try: return [step.canary({'releaseId':'${OLD}'}),calls]
    except RuntimeError as e: return [str(e),calls]
res={'v2':canary(),'v1':canary(v2=False),'held':canary(releases=False)}
apps['cloudflare-fleet-large']['image']='reg@sha256:old';res['large']=canary()
print(json.dumps(res))`,
  );
  const [v2, calls] = out.v2;
  assert.deepEqual(calls, ['pi.create', 'pi.send', 'pi.snapshot', 'pi.stop', 'pi.machine.stop']);
  assert.equal(v2.servedByRelease && v2.released && v2.reply, true);
  assert.deepEqual(v2.apps, { 'cloudflare-fleet-large': true });
  // Pi v1 has no machine to release: its pi.stop releases the conversation's.
  assert.equal(out.v1[0].released, true);
  assert.match(out.held[0], /^canary_failed .*"released": false/);
  assert.match(out.large[0], /^canary_failed .*"apps": \{"cloudflare-fleet-large": false\}/);
});

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

test('the Pi host phases refuse a Standard release another release has since replaced', () => {
  const connect = new URL('pi-connect-project.py', import.meta.url).pathname;
  const env = (legacy) =>
    [
      'MERV_PI_ENABLED=true',
      `MERV_SANDBOXES_CONNECTIONS='[{"projectId":"host_1"}]'`,
      'MERV_FLEET_RUNTIME_LEASE_SECONDS=600',
      'MERV_FLEET_RUNTIME_PROVIDER=cloudflare-fleet',
      'MERV_FLEET_RUNTIME_OFFER_ID=o',
      `MERV_FLEET_RUNTIME_RELEASE_ID=${legacy}\n`,
    ].join('\n');
  const out = py(
    `import contextlib,io,pathlib,tempfile
live={'main':'${OLD}','image':'reg@sha256:old'}
def phase(*argv,large=None,env='${OLD}'):
    sys.argv=['pi-connect-project.py',*argv]
    spec=importlib.util.spec_from_file_location('connect',${JSON.stringify(connect)})
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
    t=pathlib.Path(tempfile.mkdtemp());m.HOST_ROOT,m.ROOT,m.ENV=t/'_host',t/'host_1',t/'env'
    m.HOST_ROOT.mkdir();m.ROOT.mkdir();m.ENV.write_text(i[env])
    for d,n,v in ((m.HOST_ROOT,'host.receipt.json',{'projectId':'host_1'}),(m.HOST_ROOT,'host.private.json',
                  {'projectId':'host_1','token':'k'}),(m.ROOT,'main.receipt.json',{}),(m.ROOT,'large.receipt.json',large)):
        if v is not None: (d/n).write_text(json.dumps(v))
    labels={'com.docker.compose.project.working_dir':str(t)}
    m.inspect=lambda n:{'Image':'img','Config':{'Env':['MERV_FLEET_RUNTIME_RELEASE_ID='+live['main']],'Labels':labels}}
    m.run=lambda c,payload=None,**k:json.dumps({a:live['image'] for a in json.loads(payload)}).encode() if 'python' in c else b''
    try:
        with contextlib.redirect_stdout(io.StringIO()): getattr(m,argv[0])()
        return (m.ROOT/'machines.receipt.json').exists()
    except AssertionError as e: return e.args[0]
receipt={'projectId':'host_1','standardReleaseId':'${OLD}','largeReleaseId':'${OLD_L}','releaseDigest':'sha256:old'}
res={'live':phase('machines','host_1',large=receipt),'moved':phase('machines','host_1',large=receipt,env='${NEW}')}
res['large']=phase('large','host_1','--release','${OLD}','--application','0'*8+'-0000'*3+'-'+'0'*12,env='${NEW}')
live['image']='reg@sha256:new';res['image']=phase('machines','host_1',large=receipt)
print(json.dumps(res))`,
    { [OLD]: env(OLD), [NEW]: env(NEW) },
  );
  assert.equal(out.live, true);
  // The legacy key moved on since the Large copy was made, or since --release was read.
  assert.deepEqual(out.moved, ['release_not_live', [NEW, OLD]]);
  assert.deepEqual(out.large, ['release_not_live', [NEW, OLD]]);
  // Or Cloudflare runs another image than the release pins.
  assert.equal(out.image[0], 'image_not_live');
});

test('the Pi runbook rolls Main back with release.mjs and its hosted run, never an image by hand', () => {
  const runbook = readFileSync(new URL('PI_OPERATIONS.md', import.meta.url), 'utf8');
  const rollback = runbook.slice(
    runbook.indexOf('To roll Main back'),
    runbook.indexOf('**Canary.**'),
  );
  assert.match(
    rollback,
    /run\s+`node deploy\/release\.mjs` at the previous commit, without `--skip-hosted`/,
  );
  assert.doesNotMatch(
    rollback,
    /release\.mjs --skip-hosted|use `deploy\/cloudflare-sandbox\/rollout\.py`/,
  );
});
