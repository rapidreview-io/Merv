import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APPS,
  GATES,
  STAGING_APPS,
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

test('the drain waits on Pi turns, launches and machines, never on those Fleet rents for workflow steps', () => {
  const seen = py(
    `queries = []
def main_read(query, *params, write=False, url=None):
    queries.append(query)
    if url == 'SANDBOXES_DATABASE_URL':
        assert not write
        return {'machines': '["sbx_w", "sbx_p"]', 'bootstraps': '["rln_w"]'}
    return {'turns': '[]', 'launches': '["flt_pi"]', 'kept': '[["sbx_w", "rln_w"], [null, null]]'}
vm.main_read = main_read
print(json.dumps([vm.busy(), queries]))`,
  );
  assert.deepEqual(seen[0], { launches: ['flt_pi'], machines: ['sbx_p'] });
  assert.match(seen[1][0], /NOT \(data_json::jsonb#>>'\{owner,kind\}' = 'workflow'\)/);
  assert.equal(seen[1].length, 2);
  assert.match(seen[1][1], /FROM public\.sandboxes/);
  assert.match(seen[1][1], /FROM public\.runtime_bootstraps/);
});

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

test('inquiry and review gates allow root mount setup while retaining Docker seccomp', () => {
  for (const name of ['linux-workflow-gate.py', 'linux-review-gate.py']) {
    const flags = py('print(json.dumps(vm.GATES[i][0]))', name);
    assert.equal(flags[flags.indexOf('--cap-add') + 1], 'SYS_ADMIN');
    assert.ok(!flags.includes('--privileged'));
    assert.ok(!flags.includes('seccomp=unconfined'));
  }
});

test('boundary gate profile is unattached, selected only for mount gates, and removed after its container', () => {
  const calls = py(`calls=[]
vm.Path.read_text=lambda path:''
vm.gate_seccomp=lambda path:str(path)
vm.read=lambda path:{'lane':'boundary','candidate':'sha256:candidate'}
vm.gate_passed=lambda *args:True
def run(command,payload=None,**kwargs):
    calls.append([command,payload.decode() if payload else None]);return b''
vm.run=run
def remove(command,**kwargs):
    calls.append([command,None]);return type('Result',(),{'returncode':1,'stderr':b'No such container: gone'})()
vm.subprocess.run=remove
vm.Step(vm.Path('/run/gate'),{}).gates(None)
print(json.dumps(calls))`);
  const [inspect, add, ...rest] = calls;
  assert.deepEqual(add[0], ['apparmor_parser', '--skip-cache', '--add']);
  const profile = add[1].match(/profile (merv-hosted-gate-[a-f0-9]{16}) flags=/)[1];
  assert.deepEqual(inspect[0], [
    'docker',
    'ps',
    '-a',
    '--filter',
    `name=^/${profile}$`,
    '--format',
    '{{.ID}}',
  ]);
  assert.equal(add[1], `abi <abi/4.0>,\nprofile ${profile} flags=(unconfined) {\n  userns,\n}\n`);
  const gates = rest.slice(0, 4).map(([command]) => command);
  assert.equal(gates.length, 4);
  assert.deepEqual(
    gates.map((command) => command.includes('seccomp=/run/gate/gate-seccomp.json')),
    [false, true, false, true],
  );
  for (const command of gates) {
    assert.equal(command[command.indexOf('--name') + 1], profile);
    assert.equal(command.includes(`apparmor=${profile}`), command.includes('SYS_ADMIN'));
    assert.ok(!command.includes('--privileged') && !command.includes('seccomp=unconfined'));
  }
  assert.ok(
    gates[3].includes(
      '/run/gate/bundle/review-launch-fixture.mjs:/opt/merv/runtime/review-launch-fixture.mjs:ro',
    ),
  );
  assert.deepEqual(rest.slice(4), [
    [['docker', 'rm', '-f', profile], null],
    [['apparmor_parser', '--skip-cache', '--remove'], add[1]],
  ]);
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

test('gate profile collision refuses to replace existing host policy', () => {
  const result = python(`vm.secrets.token_hex=lambda size:'a'*16
vm.Path.read_text=lambda path:'merv-hosted-gate-aaaaaaaaaaaaaaaa (unconfined)\\n'
vm.run=lambda *args,**kwargs:(_ for _ in ()).throw(Exception('must not load'))
with vm.gate_environment(True): pass`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gate AppArmor profile already exists/);
  assert.doesNotMatch(result.stderr, /must not load/);
});

test('gate container collision refuses without loading a profile or removing the existing container', () => {
  const result = py(`calls=[]
vm.Path.read_text=lambda path:''
vm.run=lambda command,**kwargs:calls.append(command) or b'existing-container'
vm.subprocess.run=lambda *args,**kwargs:(_ for _ in ()).throw(Exception('must not remove'))
try:
    with vm.gate_environment(True): pass
except RuntimeError as error: reason=str(error)
print(json.dumps({'calls':calls,'reason':reason}))`);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.calls[0].slice(0, 3), ['docker', 'ps', '-a']);
  assert.match(result.reason, /gate container already exists/);
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

test('every boundary image must prove it can be a work host before its release switches', () => {
  // Main rents every workflow machine as a work host. The workflow gate, run against the exact
  // candidate, enrols the image's supervisor with a work-host bootstrap and runs Codex steps on
  // one retained cwd, resetting between them through the supervisor's own launcher.
  const text = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const gate = text('scripts/hosted-runner/linux-workflow-gate.py');
  const supervisor = text('scripts/hosted-runner/smoke-supervisor.ts');
  const launcher = supervisor.match(/const launcher = '([^']+)'/)[1];
  assert.match(supervisor, /workInstanceId: z\.string\(\)\.min\(1\)\.max\(200\),/);
  assert.match(supervisor, /execute\(launcher, \['--reset'\]/);
  assert.match(gate, /supervise\(\{'workInstanceId': work_instance\}\)/);
  assert.ok(gate.includes(`['${launcher}', '--reset']`), 'the gate resets as the supervisor does');
  assert.match(gate, /'retainedCodexLaunches': 2/);
  // Main answers the enrollment, so the image's supervisor builds its runner with the work-host
  // config and runs one step through to its release: Codex launched by the runner, calling the
  // relay with the step's own bearer, and presence naming exactly the enrolled capabilities.
  assert.match(gate, /return self\.reply\(\{'controlToken': control_token\}\)/);
  assert.match(gate, /assert step_released\.wait\(\d+\)/);
  assert.match(gate, /assert step_relayed\.is_set\(\)/);
  const enrolled = text('packages/fleet/src/hosted-codex.ts').match(
    /hostedCodexCapabilities = Object\.freeze\((\[[^\]]*\])\)/,
  )[1];
  // And `inquiry.1`, which only the image can say: it runs inquiry visits as such.
  const capabilities = [
    ...JSON.parse(enrolled.replaceAll("'", '"')),
    'workflow.workhost.1',
    'inquiry.1',
  ].sort();
  assert.ok(
    gate.includes(
      `b['capabilities'] == ${JSON.stringify(capabilities).replaceAll('"', "'").replaceAll(',', ', ')}`,
    ),
    capabilities.join(),
  );
  assert.match(gate, /'workHostStepRan': True/);
  // The step runs the image's own probed launcher, attestation and all, as itself (argv[0] is
  // pinned): only the local fake Main's loopback listener is hidden from the probe. A stand-in
  // that skipped the attestation let an image whose real ancestry the probe refused ship
  // (2026-10-06: every hosted workflow launch exited 70). The original comes back.
  assert.match(
    text('scripts/hosted-runner/assignment-probed.py'),
    /attest_workflow\(Path\.cwd\(\)\)/,
  );
  assert.match(gate, /REAL_LAUNCHER\.write_bytes\(original_launcher\)/);
  assert.match(gate, /exec\(compile\(open\(%r\)\.read\(\), %r, 'exec'\)/);
  assert.match(
    gate,
    /isolation_probe\._listeners = lambda: \[entry for entry in listeners\(\)\n\s+if entry != '0100007F:%%04X 0' %% port\]/,
  );
  assert.match(
    gate,
    /assert set\(receipt\['roots'\]\) == \{'supervisor', 'guardian', 'subreaper', 'group'\}/,
  );
  assert.match(gate, /'workHostStepAttested': True/);
  // A person's question to the step's agent runs on the same work host as an inquiry visit:
  // the same attested launcher, a read-only sandbox, the step's conversation resumed, none kept.
  assert.match(gate, /== \['read-only'\]/);
  assert.match(gate, /\['resume', kept\['facts'\]\['conversationId'\], '-'\]/);
  assert.match(gate, /'conversation' not in inquiry_calls/);
  assert.match(gate, /'inquiryAttested': True, 'inquiryReadOnlySandbox': True/);
  assert.match(gate, /finally:\n    LAUNCHER\.write_bytes\(original_launcher\)/);
  assert.ok(GATES.boundary.includes('linux-workflow-gate.py'));
  // A worker-lane image differs only in the Pi worker, so it keeps its gated supervisor and reset.
  assert.deepEqual(py('print(json.dumps(vm.WORKER_FILES))'), [
    '/opt/merv/pi/worker-main.mjs',
    '/opt/merv/pi/compile-cache/',
  ]);
});

test("the workflow gate's Main answers every call a step settles through, so its host leases again", () => {
  // The runner holds a work host until its visit settled: a stream, transcript or conversation
  // call answered with a bodiless 404 is retried for minutes, so the inquiry the gate offers next
  // is never leased (2026-10-07, run 20261007T104952Z-f3e7c72a). The gate's own fake Main, as
  // the runner calls it in order, must answer each as Sessions does and the runner's client reads.
  const gate = new URL('../scripts/hosted-runner/linux-workflow-gate.py', import.meta.url).pathname;
  const r = spawnSync(
    'python3',
    [
      '-c',
      `import ast, json, threading, time
tree = ast.parse(open(${JSON.stringify(gate)}).read())
g = {'json': json, 'time': time, 'base': 'http://127.0.0.1:9', 'work_instance': 'gate_work_x',
     'step_id': 'session_gate_x', 'inquiry_id': 'session_gate_inquiry_x', 'step_secret': [],
     'inquiry_secret': [], 'control_calls': [], 'inquiry_calls': [], 'kept': {}, 'printed': {},
     'streams': {}, 'step_state': {}, 'inquiry_state': {}, 'step_released': threading.Event(),
     'inquiry_released': threading.Event(), 'inquiry_ready': threading.Event()}
fns = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ('step_session', 'control_reply')]
exec(compile(ast.Module(body=fns, type_ignores=[]), 'gate', 'exec'), g)
class H:
    pass
def call(path, body=None):
    h = H()
    h.path = path
    return g['control_reply'](h, 'POST', body)
out = {}
out['lease'] = call('/sessions/lease', {'runnerId': 'r', 'secret': 's1'})['session']['id']
call('/sessions/session_gate_x/attach', {'runnerId': 'r', 'hostRef': 'launch_1'})
batch = {'runnerId': 'r', 'hostRef': 'launch_1', 'from': 0, 'to': 120, 'events': [{'kind': 'status'}]}
out['stream'] = call('/sessions/session_gate_x/stream', batch)
out['restream'] = call('/sessions/session_gate_x/stream', batch)
log = {'runnerId': 'r', 'hostRef': 'launch_1', 'sha256': 'a' * 64, 'size': 120, 'logBytes': 120, 'truncated': False}
chat = {'runnerId': 'r', 'hostRef': 'launch_1', 'harness': 'codex', 'conversationId': 'c', 'sha256': 'b' * 64, 'size': 9}
out['transcript'] = call('/sessions/session_gate_x/transcript', log)
out['conversation'] = call('/sessions/session_gate_x/conversation', chat)
call('/sessions/session_gate_x/release', {'runnerId': 'r', 'outcome': 'completed'})
out['transcriptUpload'] = call('/sessions/session_gate_x/transcript', {**log, 'deliver': True})
out['conversationUpload'] = call('/sessions/session_gate_x/conversation', {**chat, 'deliver': True})
g['inquiry_ready'].set()
out['next'] = call('/sessions/lease', {'runnerId': 'r', 'secret': 's2'})['session']['id']
print(json.dumps(out))`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.lease, 'session_gate_x');
  // How far Sessions holds the stream; a batch sent again is held, not taken twice.
  assert.deepEqual(out.stream, { stream: { until: 120 } });
  assert.deepEqual(out.restream, { stream: { until: 120 } });
  // Declared, then delivered: each names this session and file, with a PUT to this Main.
  for (const [kind, sha256, size] of [
    ['transcript', 'a'.repeat(64), 120],
    ['conversation', 'b'.repeat(64), 9],
  ]) {
    assert.deepEqual(out[kind], {
      [kind]: { sessionId: 'session_gate_x', sha256, size, uploadedAt: null },
    });
    const upload = out[`${kind}Upload`]?.[kind]?.upload;
    assert.match(upload?.url ?? '', /^http:\/\/127\.0\.0\.1:9\/gate-/, kind);
  }
  assert.equal(out.next, 'session_gate_inquiry_x');
});

test("the workflow gate's Main answers a running visit's control poll as Sessions does", () => {
  // A started launch's tick polls GET /sessions/<id>/control and reads its `control` fields; any
  // other answer is invalid_control_response, retried each tick, so the step never settles and
  // is never released (2026-10-07, run 20261007T165252Z-06d804cb). The gate's fake Main, as a
  // step and an inquiry call it in order, must answer the route with exactly the fields Sessions'
  // SessionControlView picks, and the whole session with its `kind` as Sessions keeps it.
  const gate = new URL('../scripts/hosted-runner/linux-workflow-gate.py', import.meta.url).pathname;
  const types = readFileSync(new URL('../packages/sessions/src/types.ts', import.meta.url), 'utf8');
  const picked = /export type SessionControlView = Pick<\s*Session,([^>]*)>/.exec(types)?.[1];
  const fields = [...(picked ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
  assert.ok(fields.includes('status') && fields.includes('outcome'), picked);
  const r = spawnSync(
    'python3',
    [
      '-c',
      `import ast, json, threading, time
tree = ast.parse(open(${JSON.stringify(gate)}).read())
g = {'json': json, 'time': time, 'base': 'http://127.0.0.1:9', 'work_instance': 'gate_work_x',
     'step_id': 'session_gate_x', 'inquiry_id': 'session_gate_inquiry_x', 'step_secret': [],
     'inquiry_secret': [], 'control_calls': [], 'inquiry_calls': [], 'kept': {}, 'printed': {},
     'streams': {}, 'step_state': {}, 'inquiry_state': {}, 'step_released': threading.Event(),
     'inquiry_released': threading.Event(), 'inquiry_ready': threading.Event()}
fns = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ('step_session', 'control_reply')]
exec(compile(ast.Module(body=fns, type_ignores=[]), 'gate', 'exec'), g)
class H:
    pass
def call(method, path, body=None):
    h = H()
    h.path = path
    return g['control_reply'](h, method, body)
out = {}
for visit, sid in (('step', 'session_gate_x'), ('inquiry', 'session_gate_inquiry_x')):
    if visit == 'inquiry':
        g['inquiry_ready'].set()
    call('POST', '/sessions/lease', {'runnerId': 'r', 'secret': visit})
    out[visit + 'Kind'] = call('GET', '/sessions/' + sid)['session'].get('kind')
    call('POST', '/sessions/' + sid + '/attach', {'runnerId': 'r', 'hostRef': 'launch_' + visit})
    out[visit + 'Running'] = call('GET', '/sessions/' + sid + '/control')
    if visit == 'step':
        call('POST', '/sessions/' + sid + '/conversation', {'runnerId': 'r', 'hostRef': 'launch_step',
             'harness': 'codex', 'conversationId': 'c', 'sha256': 'b' * 64, 'size': 9})
    call('POST', '/sessions/' + sid + '/release', {'runnerId': 'r', 'outcome': 'host_failed'})
    out[visit + 'Released'] = call('GET', '/sessions/' + sid + '/control')
print(json.dumps(out))`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
  for (const [visit, id, kind] of [
    ['step', 'session_gate_x', 'work'],
    ['inquiry', 'session_gate_inquiry_x', 'inquiry'],
  ]) {
    assert.equal(out[`${visit}Kind`], kind, visit);
    for (const [when, status, closeReason, outcome] of [
      ['Running', 'offered', null, null],
      ['Released', 'released', 'released', 'host_failed'],
    ]) {
      const control = out[visit + when]?.control;
      assert.deepEqual(Object.keys(out[visit + when] ?? {}), ['control'], visit + when);
      assert.deepEqual(Object.keys(control).sort(), fields, visit + when);
      const { expiresAt, hardDeadline, ...rest } = control;
      assert.match(expiresAt, iso);
      assert.match(hardDeadline, iso);
      assert.deepEqual(rest, {
        id,
        projectId: 'project_workflow_gate',
        runnerId: 'r',
        hostRef: `launch_${visit}`,
        status,
        closeReason,
        outcome,
      });
    }
  }
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

test('the raw shared catalog appends, prunes only unprotected releases and preserves other bytes', () => {
  const release = (hex) => releaseEntry(image(hex), LIVE_EXECUTABLE);
  const raw = `OTHER={"literal":"$VALUE#'"}\nSANDBOXES_RUNTIME_RELEASES=${JSON.stringify([release('1'), release('2')])}\n`;
  const edit =
    'd,c=vm.with_release(i["raw"].encode(),i["entry"],keep=i.get("keep",16),protect=i.get("protect",()));print(json.dumps([d.decode(),c]))';
  const [doc, changed] = py(edit, { raw, entry: release('3') });
  assert.equal(changed, true);
  assert.equal(doc.split('\n')[0], raw.split('\n')[0]);
  const catalog = (raw) => JSON.parse(raw.split('\n')[1].split('=').slice(1).join('='));
  assert.deepEqual(catalog(doc), [release('1'), release('2'), release('3')]);
  assert.deepEqual(py(edit, { raw: doc, entry: release('3') }), [doc, false]);
  const [pruned] = py(edit, {
    raw: doc,
    entry: release('4'),
    keep: 2,
    protect: [release('1').image_digest],
  });
  assert.deepEqual(catalog(pruned), [release('1'), release('3'), release('4')]);
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
  const reuse = `MERV_FLEET_WORKFLOW_REUSE_WORK_HOSTS=true\nMERV_FLEET_WORKFLOW_REUSABLE_RUNTIME_PROFILE_IDS='["srp_${'a'.repeat(64)}"]'\n`;
  const env = `${raw}${quoted(runtimes('rt1_old', 'rt1_oldL'))}\nC=2\n${reuse}`;
  const releases = { 'cloudflare-fleet': 'rt1_new', 'cloudflare-fleet-large': 'rt1_newL' };
  assert.equal(
    edit(env, releases),
    `${out}${quoted(runtimes('rt1_new', 'rt1_newL'))}\nC=2\n${reuse}`,
  );
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

test('the drain releases each Pi machine that goes idle while it waits, and ends only once none is up', () => {
  // Alice's turn runs as the drain starts and ends at 5 s; a page warms a machine at 15 s. Main
  // releases a machine at its first pass after the drain ended its host's idle clock.
  const out = py(`import types
clock=[0.0];hosts={'alice':{'turn':True,'idle':None,'up':True}};released=[]
vm.time=types.SimpleNamespace(monotonic=lambda:clock[0],sleep=lambda s:clock.__setitem__(0,clock[0]+s))
def main_read(q,*p,write=False,url=None):
    if url == 'SANDBOXES_DATABASE_URL': return {'machines':'[]','bootstraps':'[]'}
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

test('a rollback’s drain, and staging’s, wait on work machines alone, under the same hold', () => {
  const out = py(`import types
clock=[0.0];work=['flt_w'];queries=[];settles=[True]
vm.time=types.SimpleNamespace(monotonic=lambda:clock[0],sleep=lambda s:clock.__setitem__(0,clock[0]+s))
def never(**_): raise AssertionError('a work drain read Pi')
vm.sbx=never
def main_read(q,*p,write=False):
    queries.append([q,write])
    if q==vm.UNHOLD: return {'lifted':True}
    if clock[0]>=10 and work and settles[0]: work.pop()
    return {'work':json.dumps(work)}
vm.main_read=main_read
res={'drained':vm.Step(None,{'drainSeconds':900}).drain({'work':True}),'at':clock[0]}
res['held']=all(q.startswith('WITH '+vm.HOLD) and w for q,w in queries)
work[:]=['flt_long'];clock[0]=0;queries.clear();settles[0]=False
try: vm.work_drain(30)
except RuntimeError as e: res['gaveUp']=str(e)
res['liftedAfter']=queries[-1]==[vm.UNHOLD,True]
print(json.dumps(res))`);
  assert.deepEqual([out.drained, out.at, out.held], [{ drained: true }, 10, true]);
  assert.match(
    out.gaveUp,
    /^not_drained_after_30s \{"work": \["flt_long"\]\}: a work step was still running/,
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

test('the pin check reads the apps of the machines Main or the env file names, and claims nothing', () => {
  const out = py(
    `${scratch}vm.ENV=t/'typescript.env'
runtimes=json.dumps([{'provider':'cloudflare-fleet','releaseId':'${OLD}'},{'provider':'cloudflare-fleet-large','releaseId':'${OLD_L}'}])
vm.ENV.write_text(f"{vm.KEY}=${OLD}\\n{vm.RUNTIMES}='{runtimes}'\\n")
vm.env_of=lambda n:{vm.KEY:'${OLD}',vm.CATALOG:'[]'}
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
vm.env_of=lambda n:{vm.KEY:live['main'],vm.CATALOG:json.dumps(live['catalog'])}
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
vm.env_of=lambda n:{vm.KEY:'${NEW}',vm.RUNTIMES:runtimes.strip("'"),vm.CATALOG:json.dumps(catalog)}
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

const profileId = (p) =>
  `srp_${createHash('sha256')
    .update(
      JSON.stringify([p.provider, p.offerId, p.releaseId, p.leaseSeconds, p.ttlSeconds ?? 300]),
    )
    .digest('hex')}`;

test("the canary resolves Fleet's release-bound profile IDs from Main's rendered config", () => {
  const dir = mkdtempSync(join(tmpdir(), 'merv-canary-profiles-'));
  try {
    const config = join(dir, 'config.json');
    const standard = {
      key: 'standard',
      provider: 'cloudflare-fleet',
      offerId: 'standard-1:cloudflare',
      releaseId: OLD,
      leaseSeconds: 900,
    };
    const profiles = [
      standard,
      {
        ...standard,
        key: 'large',
        provider: 'cloudflare-fleet-large',
        releaseId: OLD_L,
        ttlSeconds: 600,
      },
    ];
    writeFileSync(config, JSON.stringify({ plugins: [{ id: 'fleet', config: { profiles } }] }));
    const source = py('print(json.dumps(vm.FLEET_PROFILES))').replace(
      "'/tmp/merv-config.json'",
      JSON.stringify(config),
    );
    const result = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', source],
      {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
      },
    );
    assert.deepEqual(
      JSON.parse(result),
      Object.fromEntries(profiles.map((p) => [profileId(p), p.releaseId])),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the canary releases a Pi v2 machine as its person would, then checks it served the release', () => {
  const out = py(
    `${scratch}${twoApps}vm.credential=lambda path:{'projectId':'p'};vm.whoami=lambda c:None
vm.secrets.token_hex=lambda n:'beef'
clock=[0];vm.time.monotonic=lambda:clock[0]
vm.time.sleep=lambda seconds:clock.__setitem__(0,clock[0]+seconds)
for app in apps.values(): app['health']={'errors':[],'instances':{'failed':0}}
vm.run=lambda command:json.dumps({'srp_old':'${OLD}','srp_new':'${NEW}'})
def canary(v2=True,releases=True,stopped=True,release_after=0,recorded='srp_old'):
    clock[0]=0
    calls,phase=[],['active']
    def tool(c,name,body,tries=12):
        calls.append(name)
        if name=='pi.machine.stop' and not v2: raise RuntimeError('pi.machine.stop_http_404_None')
        if name==('pi.machine.stop' if v2 else 'pi.stop') and releases: phase[0]='released'
        command={'id':'cmd1','status':'completed','runtimeId':'fa_1','messages':[{'role':'assistant','text':'canary-beef'}]}
        return {'pi.create':{'id':'conv1'},'pi.send':{'id':'cmd1'},'pi.snapshot':{'commands':[command]}}.get(name,{})
    def main_read(query,*p):
        if 'profileId' in query: return {'n':int(p==('fa_1',['srp_old']) and recorded=='srp_old')}
        assert \"phase = 'released'\" in query and \"->'runtime'->>'state' = 'stopped'\" in query
        return {'n':int(p==('fa_1',) and phase[0]=='released' and stopped and clock[0]>=release_after)}
    vm.tool,vm.main_read=tool,main_read
    vm.unhold=lambda:calls.append('unhold')
    try: return [step.canary({'releaseId':'${OLD}'}),calls]
    except RuntimeError as e: return [str(e),calls]
res={'v2':canary(),'v1':canary(v2=False),'held':canary(releases=False),
     'phaseOnly':canary(stopped=False),'late':canary(release_after=327),'deadline':canary(release_after=601),
     'wrongRelease':canary(recorded='srp_new')}
apps['cloudflare-fleet-large']['image']='reg@sha256:old';res['large']=canary()
step.plan.update({'stagingCutover':True,'cutover':True,'current':{'image':'accepted@sha256:abc'}})
vm.Step.staging_accept=lambda *a:None
vm.native=lambda *a:(_ for _ in ()).throw(Exception('staging cannot read production locally'))
res['staging']=canary()
print(json.dumps(res))`,
  );
  const [v2, calls] = out.v2;
  // A release that passed its canary stays: only then may work machines rent and take steps again.
  assert.deepEqual(calls, [
    'pi.create',
    'pi.send',
    'pi.snapshot',
    'pi.stop',
    'pi.machine.stop',
    'unhold',
  ]);
  assert.equal(v2.servedByRelease && v2.released && v2.reply, true);
  assert.equal(out.staging[0].released && out.staging[0].servedByRelease, true);
  assert.ok(!out.staging[1].includes('unhold'));
  assert.deepEqual(out.staging[0].apps, {});
  assert.deepEqual(v2.apps, { 'cloudflare-fleet-large': true });
  // Pi v1 has no machine to release: its pi.stop releases the conversation's.
  assert.equal(out.v1[0].released, true);
  assert.match(out.held[0], /^canary_failed .*"released": false/);
  // A failed canary keeps the hold for the rollback, which redeploys every app.
  assert.ok(!out.held[1].includes('unhold'));
  assert.match(out.phaseOnly[0], /^canary_failed .*"released": false/);
  assert.match(out.wrongRelease[0], /^canary_failed .*"servedByRelease": false/);
  assert.ok(!out.wrongRelease[1].includes('unhold'));
  assert.equal(out.late[0].released, true);
  assert.equal(out.late[0].seconds, 327);
  assert.match(out.deadline[0], /^canary_failed .*"released": false/);
  assert.match(out.deadline[0], /"seconds": 600/);
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

test('hosted steps exclude recovery capture and refuse pending snapshot restart', () => {
  const out = py(`${scratch}import fcntl
vm.os.geteuid=lambda:0
r.chmod(0o700)
original_stat=vm.Path.stat
def root_stat(path,*a,**k):
    value=original_stat(path,*a,**k)
    if path==r:
        fields=list(value);fields[4]=0;return vm.os.stat_result(fields)
    return value
vm.Path.stat=root_stat
(r/'plan.json').write_text('{}')
vm.Step.guard=lambda self,arg:{'guard':'ran'}
res={}
with vm.MAINTENANCE.open('a') as held:
    fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
    res['busy']=vm.step('guard',r,{})
vm.RECOVERY_PENDING.write_text('{}')
try: vm.step('guard',r,{})
except RuntimeError as e: res['pending']=str(e)
vm.RECOVERY_PENDING.unlink()
res['ready']=vm.step('guard',r,{})
print(json.dumps(res))`);
  assert.deepEqual(out.busy, { guard: 'busy' });
  assert.match(out.pending, /recovery snapshot restart is pending/);
  assert.deepEqual(out.ready, { guard: 'ran' });
});

test('each staging template is its app as wrangler created it, otherwise Standard’s or Large’s', () => {
  const staging = Object.fromEntries(
    Object.entries(STAGING_APPS).map(([p, f]) => [p, read(f.slice(7))]),
  );
  const shape = (t) => [t.name, t.containers[0].name, t.vars.SHAPE, t.containers[0].max_instances];
  assert.deepEqual(shape(staging['cloudflare-fleet-staging']), [
    'merv-fleet-staging',
    'merv-fleet-staging-sandboxcontainer',
    'standard-1',
    5,
  ]);
  assert.deepEqual(shape(staging['cloudflare-fleet-staging-large']), [
    'merv-fleet-staging-large',
    'merv-fleet-staging-large-sandboxcontainer',
    'standard-3',
    2,
  ]);
  for (const [provider, live] of [
    ['cloudflare-fleet-staging', 'cloudflare-fleet'],
    ['cloudflare-fleet-staging-large', 'cloudflare-fleet-large'],
  ]) {
    const [t, p] = [staging[provider], templates[live]];
    for (const key of ['account_id', 'main', 'compatibility_date', 'durable_objects', 'migrations'])
      assert.deepEqual(t[key], p[key], key);
    assert.equal(t.containers[0].instance_type, p.containers[0].instance_type);
    assert.ok(wranglerConfig(t, image('c'), '/w'));
  }
});

test('staging takes a release only for the staging apps Sandboxes serves', () => {
  const out = py(
    `${scratch}vm.env_of=lambda n:{'SANDBOXES_PROVIDERS':json.dumps([{'name':'cloudflare-fleet'},{'name':'cloudflare-fleet-staging'}])}
step=vm.Step(r,{});seen=[]
step.add_releases=lambda arg,backup,broken=None:seen.append([arg,backup.name]) or {'releases':arg['releases']}
entry=lambda p:{'provider':p,'image_digest':'sha256:'+'d'*64}
res={'out':step.stage({'entries':[entry('cloudflare-fleet-staging'),entry('cloudflare-fleet-staging-large')],
  'releases':{'cloudflare-fleet-staging':'rt1_s','cloudflare-fleet-staging-large':'rt1_l'}}),'seen':seen}
vm.env_of=lambda n:{'SANDBOXES_PROVIDERS':'[]'}
try: step.stage({'entries':[entry('cloudflare-fleet-staging')],'releases':{'cloudflare-fleet-staging':'rt1_s'}})
except RuntimeError as e: res['none']=str(e)
print(json.dumps(res))`,
  );
  assert.deepEqual(out.out.releases, { 'cloudflare-fleet-staging': 'rt1_s' });
  assert.deepEqual(
    out.seen[0][0].entries.map((e) => e.provider),
    ['cloudflare-fleet-staging'],
  );
  assert.equal(out.seen[0][1], 'stage.before');
  assert.match(out.none, /Sandboxes serves no staging app/);
});

test('on the staging host Main names the staging releases, leaving every other pin as it was', () => {
  const [S, SL, P] = ['e', 'f', '0'].map((c) => `rt1_${c.repeat(64)}`);
  const out = py(
    `${scratch}env=t/'typescript.env';vm.ENV=env
machine=lambda k,p,i:{'key':k,'provider':p,'releaseId':i}
line=lambda s,l:vm.RUNTIMES+"='"+json.dumps([machine('standard','cloudflare-fleet-staging',s),machine('large','cloudflare-fleet-staging-large',l)],separators=(',',':'))+"'"
env.write_text(f"{vm.KEY}=${P}\\n{line('${OLD}','${OLD_L}')}\\nC=2\\n")
vm.inspect=lambda n:{'Image':'sha256:img','Config':{'Labels':{'com.docker.compose.project.working_dir':str(t)}}}
vm.healthy=lambda *a:None;vm.main_release_running=lambda:False
main={};calls=[]
def recreate():
    f=vm.file_env(env.read_bytes());main.clear();main.update({vm.KEY:f[vm.KEY],vm.RUNTIMES:f[vm.RUNTIMES].strip("'")})
recreate();vm.env_of=lambda n:dict(main)
vm.run=lambda c,**k:calls.append(c[4]) or (recreate() if 'up' in c else None) or b''
vm.unhold=lambda:calls.append('unhold')
both={'cloudflare-fleet-staging':'${S}','cloudflare-fleet-staging-large':'${SL}'}
res={'result':vm.staging(both)['changed'],'env':env.read_text(),'calls':calls,'again':vm.staging(both)}
for bad in ({'cloudflare-fleet':'${S}'},{'cloudflare-fleet-staging':'latest'}):
    try: vm.staging(bad)
    except RuntimeError as e: res.setdefault('refused',[]).append(str(e))
print(json.dumps(res))`,
  );
  const line = (s, l) =>
    `MERV_FLEET_RUNTIMES='[{"key":"standard","provider":"cloudflare-fleet-staging","releaseId":"${s}"},{"key":"large","provider":"cloudflare-fleet-staging-large","releaseId":"${l}"}]'`;
  assert.equal(out.result, true);
  assert.equal(out.env, `MERV_FLEET_RUNTIME_RELEASE_ID=${P}\n${line(S, SL)}\nC=2\n`);
  // The render first, then the recreate; staging's drain hold is lifted once Main names them.
  assert.deepEqual(out.calls, ['run', 'up', 'unhold', 'unhold']);
  assert.deepEqual(out.again, { changed: false });
  assert.match(out.refused[0], /staging Main runs no machine on these apps/);
  assert.match(out.refused[1], /invalid release id/);
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

test('cutover checkpoint binds Main and every hosted pin; resume requires actual maintenance removal', () => {
  const result = py(`${scratch}${twoApps}
import io
step.plan['cutover']=True
# Use literal line bytes, not the JS template's newline escape.
vm.ENV=t/'typescript.env';vm.ENV.write_bytes(b'MERV_BOOT_MAINTENANCE=1'+bytes([10]))
vm.ENV=t/'typescript.env'
main={'MERV_BOOT_MAINTENANCE':'1'};image=['sha256:main'];health={'status':'ok','maintenance':True}
vm.env_of=lambda _:main
vm.inspect=lambda _:{'Image':image[0]}
vm.urllib.request.urlopen=lambda *a,**k:io.BytesIO(json.dumps(health).encode())
pre=vm.read(r/'preflight.json');pre['cutoverMainImage']=image[0];vm.atomic(r/'preflight.json',json.dumps(pre).encode())
vm.Step.pins=lambda self:{'releases':vm.read(r/'catalog.json')['releases'],'fileReleases':vm.read(r/'catalog.json')['releases'],
 'mainReleaseId':'${NEW}','fileReleaseId':'${NEW}','apps':apps,
 'catalog':[{'provider':p,'id':v,'digest':'sha256:new'} for p,v in vm.read(r/'catalog.json')['releases'].items()]}
vm.busy=lambda release=False:{}
reads=[]
vm.main_read=lambda query,*a,**k:reads.append(k) or {'ids':'[]'}
prepared=step.prepare_cutover({})
res={'prepared':prepared,'checkpoint':vm.read(r/'progress.json'),'reads':reads}
try: step.accept_cutover({})
except RuntimeError as e: res['fenced']=str(e)
main['MERV_BOOT_MAINTENANCE']='0';vm.ENV.write_bytes(b'MERV_BOOT_MAINTENANCE=0'+bytes([10]));health.pop('maintenance')
res['accepted']=step.accept_cutover({})
image[0]='sha256:other'
try: step.accept_cutover({})
except RuntimeError as e: res['changed']=str(e)
image[0]='sha256:main';apps['cloudflare-fleet-large']['image']='reg@sha256:old'
try: step.accept_cutover({})
except RuntimeError as e: res['runnerChanged']=str(e)
vm.main_read=lambda *a,**k:{'ids':'["real-work"]'}
try: step.cutover_census()
except RuntimeError as e: res['busy']=str(e)
print(json.dumps(res))`);
  assert.equal(result.prepared.mainImage, 'sha256:main');
  assert.deepEqual(result.checkpoint.cutoverPrepared, result.prepared);
  assert.deepEqual(result.reads, [{}]);
  assert.match(result.fenced, /maintenance removed/);
  assert.deepEqual(result.accepted, { accepted: true });
  assert.match(result.changed, /Main image changed/);
  assert.match(result.runnerChanged, /hosted image changed/);
  assert.match(result.busy, /ownership is not empty/);
});

test('cutover switch failure keeps candidate env and never recreates old pins', () => {
  const result = py(`${scratch}
vm.ENV=t/'typescript.env';vm.ENV.write_bytes(b'old')
vm.inspect=lambda _:{'Image':'sha256:main','Config':{'Labels':{'com.docker.compose.project.working_dir':str(t)}}}
vm.main_release_running=lambda:False
calls=[]
def fail(command,**kwargs):
    calls.append(command)
    raise RuntimeError('render failed')
vm.run=fail
try: vm.recreate(b'old',b'candidate',r/'env.before',restore=False)
except RuntimeError as e: error=str(e)
print(json.dumps({'env':vm.ENV.read_text(),'before':(r/'env.before').read_text(),'calls':len(calls),'error':error}))`);
  assert.deepEqual(result, { env: 'candidate', before: 'old', calls: 1, error: 'render failed' });
});

test('cutover guard cannot restore old pins and its drain is read-only', () => {
  const result = py(`${scratch}
vm.owner=lambda:r.name
step=vm.Step(r,{'cutover':True})
vm.native=lambda *a:(_ for _ in ()).throw(Exception('guard must not switch'))
res={'guard':step.guard({})}
vm.Step.cutover_maintenance=lambda self,active:None
vm.busy=lambda release=False:{} if not release else (_ for _ in ()).throw(Exception('must not release'))
vm.main_read=lambda *a,**k:{'ids':'[]'} if not k.get('write') else (_ for _ in ()).throw(Exception('must not write'))
res['drain']=step.drain({})
try: step.abandon({})
except RuntimeError as e:res['abandon']=str(e)
print(json.dumps(res))`);
  assert.match(result.guard.guard, /preserve pins/);
  assert.equal(result.drain.readOnly, true);
  assert.match(result.abandon, /cannot be abandoned/);
});

test('cutover preflight defers ordinary HTTP identity checks but requires maintenance and empty ownership', () => {
  const result = py(`${scratch}
vm.claim=lambda _:None;vm.main_release_running=lambda:False
vm.shutil.disk_usage=lambda _:type('Space',(),{'free':16<<30})()
vm.run=lambda *a,**k:b''
vm.credential=lambda _: {'actorId':'canary-reader'}
vm.whoami=lambda _:(_ for _ in ()).throw(Exception('HTTP is fenced'))
vm.inspect=lambda _:{'Image':'sha256:main','Config':{'Labels':{'org.merv.native-git-protocol':'1'}}}
vm.Step.pins=lambda self:{}
calls=[]
vm.Step.cutover_maintenance=lambda self,active:calls.append(['maintenance',active])
vm.Step.cutover_census=lambda self:calls.append(['census'])
step=vm.Step(r,{'cutover':True,'current':{'localId':'old'},'canary':{'credential':'/private'}})
print(json.dumps({'preflight':step.preflight({}),'calls':calls}))`);
  assert.deepEqual(result.calls, [['maintenance', true], ['census']]);
  assert.equal(result.preflight.cutoverMainImage, 'sha256:main');
  assert.equal(result.preflight.canaryActor, 'canary-reader');
});

test('staging checkpoint requires native Main, exact providers, empty ownership and unchanged Main on reopening', () => {
  const result = py(`${scratch}
import io
vm.ENV=t/'env'
target={p:'rt1_'+str(n)*64 for n,p in enumerate(vm.STAGING_PROVIDERS,1)}
main={vm.RUNTIMES:json.dumps([{'key':str(i),'provider':p,'releaseId':rid} for i,(p,rid) in enumerate(target.items())]),
      vm.KEY:target[vm.STAGING_PROVIDERS[0]],'MERV_BOOT_MAINTENANCE':'1','MERV_TS_DB_SCHEMA':'merv_ts_staging'}
def save():vm.ENV.write_text(''.join(k+'='+v+'\\n' for k,v in main.items()))
save();image=['sha256:main'];label=['1'];health={'status':'ok','maintenance':True}
vm.env_of=lambda _:dict(main)
vm.inspect=lambda _:{'Image':image[0],'Config':{'Labels':{'org.merv.native-git-protocol':label[0]}}}
vm.urllib.request.urlopen=lambda *a,**k:io.BytesIO(json.dumps(health).encode())
vm.claim=lambda _:None;vm.owner=lambda:'';vm.main_release_running=lambda:False
vm.credential=lambda _:{'projectId':'staging','actorId':'reader'}
vm.run=lambda *a,**k:json.dumps([{'id':n} for n in ['sandboxes-host','sandboxes-integration','fleet','fleet-workflow','pi','pi-api','pi-tools']]).encode()
queries=[];counts={'worker_sessions':0}
vm.main_read=lambda q,*a,**k:queries.append([q,k]) or dict(counts)
step=vm.Step(r,{'cutover':True,'stagingCutover':True,'current':{'image':'accepted@sha256:abc'},
 'stagingReleases':target,'canary':{'credential':'/private','projectId':'staging'}})
res={}
label[0]='0'
try:step.staging_preflight({})
except RuntimeError as e:res['legacy']=str(e)
label[0]='1';counts['worker_sessions']=1
try:step.staging_preflight({})
except RuntimeError as e:res['busy']=str(e)
counts['worker_sessions']=0
before=step.staging_preflight({});vm.atomic(r/'preflight.json',json.dumps(before).encode())
res['prepared']=step.staging_prepare({})
try:step.staging_accept({})
except RuntimeError as e:res['fenced']=str(e)
main['MERV_BOOT_MAINTENANCE']='0';health.pop('maintenance');save()
res['accepted']=step.staging_accept({})
image[0]='sha256:other'
try:step.staging_accept({})
except RuntimeError as e:res['changed']=str(e)
image[0]='sha256:main';main[vm.KEY]='wrong';save()
try:step.staging_accept({})
except RuntimeError as e:res['pins']=str(e)
res['queries']=queries
print(json.dumps(res))`);
  assert.match(result.legacy, /native-compatible/);
  assert.match(result.busy, /ownership/);
  assert.match(result.fenced, /maintenance removed/);
  assert.deepEqual(result.accepted, { accepted: true });
  assert.match(result.changed, /Main image changed/);
  assert.match(result.pins, /Standard pin changed/);
  assert.ok(result.queries.every(([, flags]) => !flags.write));
  for (const table of [
    'worker_sessions',
    'wf_leases',
    'code_workspaces',
    'code_operations',
    'pi_hosts',
    'managed_compute_runs',
    'code_base_cleanup',
    'session_managed_runners',
  ])
    assert.ok(result.queries[0][0].includes(table));
});

test('staging switch failure preserves new pins and cannot roll back or unhold', () => {
  const out = py(`${scratch}
vm.ENV=t/'env';target={p:'rt1_'+str(n)*64 for n,p in enumerate(vm.STAGING_PROVIDERS,1)}
raw=(vm.KEY+'=old\\n'+vm.RUNTIMES+"='"+json.dumps([{'provider':p,'releaseId':'rt1_'+'0'*64} for p in target])+"'\\n").encode()
vm.ENV.write_bytes(raw);vm.atomic(r/'preflight.json',json.dumps({'cutoverMainImage':'sha256:main'}).encode())
vm.inspect=lambda _:{'Image':'sha256:main','Config':{'Labels':{'com.docker.compose.project.working_dir':str(t)}}}
vm.main_release_running=lambda:False
vm.Step.cutover_maintenance=lambda *a:None;vm.Step.staging_census=lambda *a:None
calls=[]
def fail(command,**k):calls.append(command);raise RuntimeError('recreate failed')
vm.run=fail
step=vm.Step(r,{'cutover':True,'stagingCutover':True,'stagingReleases':target})
try:step.staging_switch({})
except RuntimeError as e:error=str(e)
print(json.dumps({'calls':len(calls),'saved':vm.pins(vm.file_env(vm.ENV.read_bytes())),
 'backup':(r/'env.before').read_bytes()==raw,'error':error}))`);
  assert.equal(out.calls, 1);
  assert.equal(out.backup, true);
  assert.equal(out.saved[0], 'rt1_' + '1'.repeat(64));
  assert.equal(out.saved[1]['cloudflare-fleet-staging-large'], 'rt1_' + '2'.repeat(64));
});

test('staging provider census refuses unknown live machines, pending bootstraps and native instances', () => {
  const out = py(`${scratch}
queries=[];values=[0,0]
vm.main_read=lambda q,*a,**k:queries.append([q,a,k]) or {'n':values.pop(0)}
vm.native=lambda p:{'health':{'errors':[],'instances':dict(active=0,assigned=0,healthy=5,stopped=0,failed=0,scheduling=0,starting=0)}}
vm.sbx=lambda **k:dict(empty=True,liveEmpty=True,instances=0,durableObjects=0,assignedObjects=0,dormantObjects=0,pages=1)
res={'idle':vm.staging_provider_census()}
for name,pair in [('machine',[1,0]),('bootstrap',[0,1])]:
    values[:]=pair
    try:vm.staging_provider_census()
    except RuntimeError as e:res[name]=str(e)
values[:]=[0,0];vm.native=lambda p:{'health':{'errors':[],'instances':dict(active=1,assigned=0,healthy=5,stopped=0,failed=0,scheduling=0,starting=0)}}
try:vm.staging_provider_census()
except RuntimeError as e:res['native']=str(e)
res['queries']=queries
print(json.dumps(res))`);
  assert.equal(out.idle.readOnly, true);
  assert.match(out.machine, /ownership/);
  assert.match(out.bootstrap, /ownership/);
  assert.match(out.native, /instances/);
  assert.ok(
    out.queries.every(
      ([, args, flags]) => args[0].every((p) => p.includes('staging')) && !flags.write,
    ),
  );
});

test('staging source requires a completed native acceptance receipt and matching live production pins', () => {
  const out = py(`${scratch}
vm.RUNS=t/'runs';proof=vm.RUNS/'accepted';proof.mkdir(parents=True)
current={'image':'registry.cloudflare.com/acct/worker@sha256:'+'a'*64,'releaseId':'rt1_prod',
 'releases':{vm.PROVIDER:'rt1_prod'},'sourceCommit':'source','sandboxesCommit':'sandboxes'}
vm.atomic(vm.HOME/'state.json',json.dumps({'current':current}).encode())
vm.atomic(proof/'plan.json',json.dumps({'cutover':True,'sourceCommit':'source','sandboxesCommit':'sandboxes'}).encode())
vm.atomic(proof/'push.json',json.dumps({'image':current['image']}).encode())
vm.atomic(proof/'progress.json',json.dumps({'cutoverPrepared':{'image':current['image']}}).encode())
vm.atomic(proof/'finish.json',json.dumps({'result':'pass'}).encode())
vm.owner=lambda:'';vm.main_release_running=lambda:False
vm.inspect=lambda _:{'Config':{'Labels':{'org.merv.native-git-protocol':'1'}}}
entry={'provider':vm.PROVIDER,'image_digest':'sha256:'+'a'*64,'executable_sha256':'b'*64}
vm.env_of=lambda _:{vm.CATALOG:json.dumps([entry])}
vm.release_ids=lambda entries:['rt1_prod' if e['provider']==vm.PROVIDER else 'rt1_'+e['provider'] for e in entries]
live={'releases':current['releases'],'fileReleases':current['releases'],'mainReleaseId':'rt1_prod','fileReleaseId':'rt1_prod',
 'apps':{vm.PROVIDER:{'image':current['image'],'rollout':None}}}
vm.Step.pins=lambda _:live
res={'source':vm.staging_source()}
live['fileReleaseId']='drift'
try:vm.staging_source()
except RuntimeError as e:res['drift']=str(e)
live['fileReleaseId']='rt1_prod';vm.atomic(proof/'finish.json',json.dumps({'result':'failed'}).encode())
try:vm.staging_source()
except RuntimeError as e:res['unaccepted']=str(e)
vm.owner=lambda:'production-run'
try:vm.staging_source()
except RuntimeError as e:res['active']=str(e)
print(json.dumps(res))`);
  assert.equal(out.source.acceptedRun, 'accepted');
  assert.deepEqual(
    out.source.entries.map((e) => e.provider),
    Object.keys(STAGING_APPS),
  );
  assert.match(out.drift, /pins drifted/);
  assert.match(out.unaccepted, /no completed acceptance/);
  assert.match(out.active, /release is in progress/);
});

test('staging catalog gateway reuses forward-only transaction without changing production state or pins', () => {
  const out = py(`${scratch}
source={'current':{'image':'registry.cloudflare.com/acct/worker@sha256:'+'a'*64},
 'entries':[{'provider':p} for p in vm.STAGING_PROVIDERS], 'releases':{p:'rt1_'+p for p in vm.STAGING_PROVIDERS}}
vm.os.geteuid=lambda:0;vm.staging_source=lambda *a:source;vm.staging_provider_census=lambda:None
vm.inspect=lambda c:{'Image':c+'-image'};vm.verify_catalog_recovery=lambda _:None
vm.env_of=lambda _:{'SANDBOXES_PROVIDERS':json.dumps([{'name':p} for p in vm.STAGING_PROVIDERS])}
calls=[]
def add(self,arg,backup):
    calls.append({'plan':self.plan,'entries':arg['entries'],'backup':str(backup)})
    raise RuntimeError('catalog recreate failed')
vm.Step.add_releases=add
vm.atomic(vm.HOME/'state.json',b'production-state')
try:vm.staging_gateway({'action':'catalog','source':source,'run':'20261021T000000Z-1234abcd-staging'})
except RuntimeError as e:error=str(e)
print(json.dumps({'calls':calls,'state':(vm.HOME/'state.json').read_text(),'active':vm.owner(),'error':error}))`);
  assert.equal(out.state, 'production-state');
  assert.equal(out.active, '20261021T000000Z-1234abcd-staging');
  assert.equal(out.calls[0].plan.cutover, true);
  assert.deepEqual(
    out.calls[0].entries.map((e) => e.provider),
    Object.keys(STAGING_APPS),
  );
  assert.match(out.error, /catalog recreate failed/);
});

test('stdin production gateway carries the committed Sandboxes probe without a host checkout', () => {
  const out = py(`vm.__file__='/nonexistent/host.py'
vm._STAGING_PROBE=b'committed probe'
seen=[]
vm.run=lambda command,**kwargs:seen.append(kwargs['payload'].decode()) or b'{}'
vm.sbx(MERV_PROVIDER='cloudflare-fleet-staging')
print(json.dumps(seen))`);
  assert.deepEqual(out, ['committed probe']);
});

test('staging census accepts healthy summary only with concrete empty inventory; all live or unknown states fail closed', () => {
  const out = py(`${scratch}
counts=dict(active=0,assigned=0,healthy=5,stopped=0,failed=0,scheduling=0,starting=0)
inventory=dict(empty=True,liveEmpty=True,instances=0,durableObjects=0,assignedObjects=0,dormantObjects=0,pages=1)
status={'health':{'errors':[],'instances':counts}}
vm.main_read=lambda *a,**k:{'n':0}
vm.native=lambda _:status
vm.sbx=lambda **k:inventory
res={'idle':vm.staging_provider_census(),'denied':[]}
inventory.update(empty=False,durableObjects=103,dormantObjects=103)
res['dormant']=vm.staging_provider_census()
inventory.update(empty=True,durableObjects=0,dormantObjects=0)
for key in ['active','assigned','starting','scheduling','failed','stopped','unknown']:
    counts[key]=1
    try:vm.staging_provider_census()
    except RuntimeError:res['denied'].append(key)
    if key=='unknown':del counts[key]
    else:counts[key]=0
for key,value in [('active',False),('assigned','0'),('healthy',-1)]:
    saved=counts[key];counts[key]=value
    try:vm.staging_provider_census()
    except RuntimeError:res['denied'].append('malformed-'+key)
    counts[key]=saved
for field in ['instances','durableObjects','assignedObjects']:
    inventory[field]=1
    try:vm.staging_provider_census()
    except RuntimeError:res['denied'].append(field)
    inventory[field]=0
status['rollout']='pending'
try:vm.staging_provider_census()
except RuntimeError:res['denied'].append('rollout')
del status['rollout'];status['health']['errors']=['error']
try:vm.staging_provider_census()
except RuntimeError:res['denied'].append('health')
print(json.dumps(res))`);
  assert.equal(out.idle.readOnly, true);
  assert.equal(out.dormant.readOnly, true);
  assert.deepEqual(out.denied, [
    'active',
    'assigned',
    'starting',
    'scheduling',
    'failed',
    'stopped',
    'unknown',
    'malformed-active',
    'malformed-assigned',
    'malformed-healthy',
    'instances',
    'durableObjects',
    'assignedObjects',
    'rollout',
    'health',
  ]);
});

test('staging hosted readiness refuses missing or disabled plugins despite generic health', () => {
  const result = py(`${scratch}
step=vm.Step(r,{})
required=['sandboxes-host','sandboxes-integration','fleet','fleet-workflow','pi','pi-api','pi-tools']
plugins=[{'id':n} for n in required]
vm.run=lambda *a,**k:json.dumps(plugins).encode()
passed=step.hosted_plugins()
refused=[]
for missing in required:
 plugins=[{'id':n} for n in required if n!=missing]
 try:step.hosted_plugins()
 except RuntimeError:refused.append(missing)
plugins=[{'id':n,'disabled':n=='pi'} for n in required]
try:step.hosted_plugins()
except RuntimeError:refused.append('disabled')
print(json.dumps({'passed':passed,'refused':refused}))`);
  assert.equal(result.passed.requiredPlugins.length, 7);
  assert.equal(result.refused.length, 8);
});
