"""Root-side steps of deploy/hosted-release.mjs on the production host; read that file first.

Each step runs from the run's own copy of committed HEAD:
  sudo python3 <run>/source/deploy/hosted-release-vm.py <step> <run>   ({"driver", "arg"} on stdin)
and prints one JSON line. Results land in <run>/<step>.json, so an interrupted run resumes.
One run at a time holds HOME/active from preflight to finish; release.mjs's Main job refuses to
start while it exists. One driver at a time holds the run's lease: a running step keeps it fresh,
and a lease unseen for LEASE seconds may be taken over. SIGHUP is ignored, so a dropped SSH
session does not stop a step. From the Cloudflare deploy until finish a systemd timer runs
`guard`: when the driver has gone silent it points Main at whichever release Cloudflare runs, so
a lost laptop never leaves Pi refusing every launch.
Never prints a secret: the registry credential and the canary token stay inside this process,
and every backup of the env file or the Sandboxes catalog is root-private inside the run.
"""
import contextlib
import fcntl
import hashlib
import json
import os
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

MAIN, CONTROL, PIPELINE = 'merv-typescript-control-1', 'sandboxes-control-1', 'sandboxes-pipelines-worker-1'
ENV = Path('/etc/merv/typescript.env')
HOME = Path('/var/lib/merv-fleet-pilot/hosted-release')  # lock, the open run's marker, the live pins
KEY, CATALOG, PROVIDER = 'MERV_FLEET_RUNTIME_RELEASE_ID', 'SANDBOXES_RUNTIME_RELEASES', 'cloudflare-fleet'
NAMESPACE = 'fleet-cloudflare-canary'  # resolves the provider for native reads
ACTIVE = ('waiting', 'starting', 'working', 'saving')
KEEP = 16  # releases per provider; every protected launch copies them into a 32-entry VM file
LEASE = 300
CANARY_NAME = 'Hosted release canary'
GO_IMAGE = 'golang:1.27.0-bookworm@sha256:ded31c68586d2e49e760acc2e65a884b23d032e9bbbed0ae0c55abd3fcaf4452'
WORKER_TESTS = 'tests/pi-worker.test.ts tests/pi-worker-relay-protocol.test.ts tests/pi-relay.test.ts'
# All a worker-lane release may change in the image: the Pi worker bundle and its compile cache.
WORKER_FILES = ('/opt/merv/pi/worker-main.mjs', '/opt/merv/pi/compile-cache/')
LANES = ('none', 'worker', 'boundary')
GATES = {  # name: (docker run flags, mount targets, command, expected gate, report lines)
    'linux-pi-gate.py': (['--cap-add', 'SYS_PTRACE', '--tmpfs', '/run/merv-runtime:mode=0700',
                          '--entrypoint', '/usr/bin/python3.11'],
                         ['/opt/merv/runtime/probe.py'], '/opt/merv/runtime/probe.py', 'linux-pi-protected-launch', 2),
    'linux-workflow-gate.py': (['--tmpfs', '/run/merv-runtime:mode=0700', '--entrypoint', '/usr/bin/python3.11'],
                               ['/opt/merv/runtime/probe.py'], '/opt/merv/runtime/probe.py', 'linux-workflow-dispatch', 1),
    'linux-isolation-probe-gate.mjs': (['--entrypoint', '/usr/local/bin/node'],
                                       ['/opt/merv/runner/supervisor.mjs', '/opt/merv/runner/smoke-supervisor.mjs'],
                                       '/opt/merv/runner/smoke-supervisor.mjs', 'linux-isolation-probe-synthetic-ancestry', 1),
}
LANE_GATES = {'worker': ['linux-pi-gate.py'], 'boundary': list(GATES)}
GATE_FACTS, GATE_FALSE = {'prestarted'}, {'actualProtectedWorkflow', 'cloudflareEvidence'}
RECORDED = ('plan', 'preflight', 'build', 'gates', 'push', 'catalog', 'progress', 'finish')
STEPS = {'preflight', 'build', 'gates', 'push', 'catalog', 'drain', 'native', 'switch', 'canary', 'note', 'finish',
         'status', 'guard', 'mint_canary'}
# One read-only row from Main's database; {s} is Main's schema.
MAIN_READ = r'''import pg from 'pg';
const c=new pg.Client({connectionString:process.env.MERV_DB_URL});await c.connect();
try{await c.query('BEGIN READ ONLY');const s=(process.env.MERV_TS_DB_SCHEMA??'merv_ts').replace(/[^a-z0-9_]/g,'');
const r=await c.query(process.env.MERV_Q.replaceAll('{s}',s),JSON.parse(process.env.MERV_P));
console.log(JSON.stringify(r.rows[0]));await c.query('ROLLBACK')}finally{await c.end()}'''
SBX = r'''import asyncio,json,os
from sqlalchemy import text
from merv_sandboxes.config import Settings
from merv_sandboxes.runtime import Container
async def main():
    c=Container(Settings.load())
    try:
        if os.environ.get('MERV_Q'):
            async with c.db.connect() as conn:
                print(json.dumps((await conn.execute(text(os.environ['MERV_Q']))).scalar_one()))
        elif os.environ.get('MERV_RELEASE'):
            from merv_sandboxes.runtimes.releases import RuntimeRelease
            e=json.loads(os.environ['MERV_RELEASE'])
            print(json.dumps(RuntimeRelease(**{**e,'arguments':tuple(e['arguments'])}).release_id))
        else:
            d=(await c.providers.resolve(os.environ['MERV_NAMESPACE'],'cloudflare-fleet')).driver
            a,_=await d._native_result(f'/accounts/{d._account_id}/containers/applications/{d._application_id}')
            g=a.get('configuration') or {}
            print(json.dumps({'id':a.get('id'),'name':a.get('name'),'version':a.get('version'),'image':g.get('image'),
              'maxInstances':a.get('max_instances'),'ssh':bool((g.get('wrangler_ssh') or {}).get('enabled')),
              'keys':len(g.get('authorized_keys') or [])+len(g.get('trusted_user_ca_keys') or []),
              'rollout':a.get('active_rollout_id'),'health':a.get('health')}))
    finally:
        await c.stop()
asyncio.run(main())'''
# Mints the canary's reader key inside Main with Main's own scope service, as the pilot's operator.
MINT = r'''import { PostgresState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { deploymentSchema } from '/app/deploy/schema.mjs';
const projectId=process.env.MERV_CANARY_PROJECT, name=process.env.MERV_CANARY_NAME;
const state=await PostgresState.open({connectionString:process.env.MERV_DB_URL,schema:deploymentSchema(),maxConnections:2,readConnections:1});
try{const scope=new ProjectScope(state);await scope.initialize();
const actors=await state.transaction((tx)=>tx.all("SELECT id,name,role,active FROM actors WHERE project_id=? AND session_id IS NULL AND service_owner IS NULL ORDER BY id",projectId));
const operator=actors.find((a)=>a.role==='operator'&&a.active);
if(!operator)throw new Error('the project has no active operator actor');
const caller={projectId,actorId:operator.id}, existing=actors.find((a)=>a.name===name&&a.role==='reader'&&a.active);
const issued=existing?await scope.issueActorCredential(caller,{actorId:existing.id,expiresAt:null}):await scope.issueActor(caller,{name,role:'reader',expiresAt:null});
// A lost file is replaced, never left beside a second live token.
if(existing)for(const c of await scope.actorCredentials(caller,existing.id))if(c.id!==issued.credential.id&&!c.revokedAt)await scope.revokeCredential(caller,c.id);
process.stdout.write(JSON.stringify({projectId,actorId:issued.actor.id,credentialId:issued.credential.id,token:issued.token}));
}finally{await state.close()}'''


def need(ok, reason):
    if not ok:
        raise RuntimeError(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def run(command, payload=None, timeout=120, env=None, cwd=None, log=None):
    result = subprocess.run([str(c) for c in command], input=payload, capture_output=True, timeout=timeout,
                            env=env, cwd=cwd)
    if log:
        log.write_bytes(result.stdout + result.stderr)
    # No command here writes a secret to stderr; cap it anyway.
    need(result.returncode == 0, 'command_failed: ' + ' '.join(map(str, command[:3])) + ' :: ' +
         result.stderr.decode(errors='replace')[-600:])
    return result.stdout


def atomic(path, raw, mode=0o600):
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.hosted-release-')
    with os.fdopen(fd, 'wb') as out:
        out.write(raw)
        out.flush()
        os.fsync(out.fileno())
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def read(path):
    return json.loads(path.read_bytes()) if path.exists() else None


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def env_of(container):
    return dict(item.split('=', 1) for item in inspect(container)['Config']['Env'])


def healthy(name, tries, pause):
    for _ in range(tries):
        if inspect(name)['State'].get('Health', {}).get('Status') == 'healthy':
            return
        time.sleep(pause)
    raise RuntimeError('health_timeout: ' + name)


def main_read(query, *params):
    return json.loads(run(['docker', 'exec', '-e', 'MERV_Q=' + query, '-e', 'MERV_P=' + json.dumps(params),
                           '-w', '/app', MAIN, 'node', '--input-type=module', '-e', MAIN_READ]))


def sbx(**env):
    flags = [part for key, value in env.items() for part in ('-e', f'{key}={value}')]
    return json.loads(run(['docker', 'exec', *flags, CONTROL, 'python', '-c', SBX], timeout=60))


def native():
    return sbx(MERV_NAMESPACE=NAMESPACE)


def owner():
    try:
        return (HOME / 'active').read_text().strip()
    except FileNotFoundError:
        return ''


def claim(name):
    """Takes HOME/active for this run, atomically and with its content already written."""
    staged = HOME / f'.active-{name}'
    staged.write_text(name)
    try:
        os.link(staged, HOME / 'active')
    except FileExistsError:
        need(owner() == name, f'hosted run {owner()} is open; `node deploy/hosted-release.mjs` finishes it first')
    finally:
        staged.unlink()


def main_release_running():
    # release.mjs's job is visible here before it reads HOME/active, and this run claims HOME/active
    # before looking: one of the two always sees the other.
    return subprocess.run(['pgrep', '-f', '/opt/merv-typescript/releases/.*/release-job.sh'],
                          capture_output=True).returncode == 0


def guard_unit(directory):
    return 'merv-hosted-guard-' + directory.name


@contextlib.contextmanager
def leased(directory, driver):
    """One driver per run; the step refreshes the lease while it runs."""
    path, held = directory / 'lease.json', read(directory / 'lease.json') or {}
    age = time.time() - held.get('seen', 0)
    need(driver and (held.get('driver') in (None, driver) or age > LEASE),
         f'hosted run {directory.name} is driven by another process (seen {age:.0f}s ago)')

    def beat():
        atomic(path, json.dumps({'driver': driver, 'seen': time.time()}).encode())
    def beating():
        while not stop.wait(30):
            beat()
    stop, thread = threading.Event(), threading.Thread(target=beating, daemon=True)
    beat()
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join()
        beat()


def env_value(raw, key):
    values = [line.split('=', 1)[1] for line in raw.decode().splitlines() if line.startswith(key + '=')]
    need(len(values) == 1, 'env_key_not_unique: ' + key)
    return values[0]


def with_env(raw, key, value):
    """The env file with exactly one KEY=value line replaced; every other byte kept."""
    env_value(raw, key)
    return b''.join(key.encode() + b'=' + value.encode() + b'\n' if line.startswith(key.encode() + b'=') else line
                    for line in raw.splitlines(keepends=True))


def with_release(doc, entry, keep=KEEP, protect=()):
    """Add entry to both services' catalogs, keeping earlier releases; returns (doc, changed).

    Oldest releases of the same provider beyond `keep` are pruned, except protected digests.
    """
    services = [doc['services'][name]['environment'] for name in ('control', 'pipelines-worker')]
    lists = [json.loads(service[CATALOG]) for service in services]
    need(lists[0] == lists[1], 'catalog_services_differ')
    if entry in lists[0]:
        return doc, False
    releases = lists[0] + [entry]
    same = [r for r in releases if r['provider'] == entry['provider']]
    drop = [r for r in same[:max(0, len(same) - keep)] if r['image_digest'] not in (*protect, entry['image_digest'])]
    releases = [r for r in releases if r not in drop]
    for service in services:
        service[CATALOG] = json.dumps(releases, separators=(',', ':'))
    return doc, True


def image_lane(changed, config_changed):
    if not changed and not config_changed:
        return 'none'
    worker = not config_changed and all(p == WORKER_FILES[0] or p.startswith(WORKER_FILES[1]) for p in changed)
    return 'worker' if worker else 'boundary'


def final_lane(plan, changed, config_changed):
    """The image diff decides; the plan's source lane is a floor and a bridge Worker change is the boundary."""
    bridge = plan.get('sandboxChanged') is None or any(
        p.startswith('deploy/cloudflare-sandbox/worker/') for p in plan['sandboxChanged'])
    lane = image_lane(changed, config_changed)
    if lane == 'none' and not bridge:
        return 'none'
    return LANES[max(LANES.index(lane), LANES.index(plan['lane']), 2 if bridge else 0)]


def gate_passed(output, expected, lines):
    """Every report line of a gate passes: its checks true, its synthetic-evidence flags false."""
    reports = []
    for line in output.splitlines():
        with contextlib.suppress(ValueError):
            report = json.loads(line)
            if isinstance(report, dict) and 'gate' in report:
                reports.append(report)
    return len(reports) == lines and all(
        r['gate'] == expected and r.get('report', {'ok': True}).get('ok') is True and
        all(v is (k not in GATE_FALSE) for k, v in r.items() if isinstance(v, bool) and k not in GATE_FACTS)
        for r in reports)


def rootfs(image):
    """Every path in the image: type, owner, mode and content hash or link target; mtimes ignored."""
    container = run(['docker', 'create', image]).decode().strip()
    try:
        export = subprocess.Popen(['docker', 'export', container], stdout=subprocess.PIPE)
        entries = {}
        with tarfile.open(fileobj=export.stdout, mode='r|') as tar:
            for m in tar:
                content = m.linkname
                if m.isreg():
                    digest, stream = hashlib.sha256(), tar.extractfile(m)
                    for chunk in iter(lambda: stream.read(1 << 20), b''):
                        digest.update(chunk)
                    content = digest.hexdigest()
                entries['/' + m.name.removeprefix('./').rstrip('/')] = [m.type.decode(), m.uid, m.gid, m.mode, content]
        need(export.wait() == 0, 'docker export failed: ' + image)
        return entries
    finally:
        subprocess.run(['docker', 'rm', container], capture_output=True)


def busy():
    """Pi turns and launches in flight, by id; idle warm runtimes do not count."""
    agg = "coalesce((SELECT json_agg({}) FROM {} WHERE {}), '[]'::json)::text"
    main = main_read('SELECT ' + agg.format("conversation_id || '/' || id", '{s}.pi_commands',
                                            f"status IN {ACTIVE}") + ' AS turns, ' +
                     agg.format('id', '{s}.fleet_allocations',
                                "phase IN ('queued','provisioning','launching','starting')") + ' AS launches')
    lists = {**main,
             'machines': sbx(MERV_Q='SELECT ' + agg.format('id', 'sandboxes', "provider='cloudflare-fleet' AND "
                                                                             "state IN ('provisioning','deleting')")),
             'bootstraps': sbx(MERV_Q='SELECT ' + agg.format('launch_id', 'runtime_bootstraps',
                                                            "state='pending' AND expires_at > now()"))}
    return {key: ids for key, ids in ((k, json.loads(v)) for k, v in lists.items()) if ids}


def quiet(limit):
    """Wait, bounded, until nothing is in flight for 10 s."""
    deadline, calm = time.monotonic() + limit, None
    while True:
        now = busy()
        if now:
            calm = None
        elif calm is None:
            calm = time.monotonic()
        elif time.monotonic() - calm >= 10:
            return {'drained': True}
        need(time.monotonic() < deadline, f'not_drained_after_{limit}s {json.dumps({k: v[:5] for k, v in now.items()})}'
             ': nothing was changed by this step; rerun when Pi is quieter, or raise --drain-minutes')
        time.sleep(5)


def credential(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        raise RuntimeError(f'canary credential {path} is missing. Create it once with '
                           '`node deploy/hosted-release.mjs --mint-canary`; it mints a reader key for the service '
                           'pilot inside Main and stores it root-only') from None
    need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600,
         f'canary credential {path} must be a root-owned 0600 regular file')
    value = json.loads(path.read_bytes())
    need(set(value) == {'projectId', 'actorId', 'credentialId', 'token'}, 'canary credential has an unexpected shape')
    return value


def tool(cred, name, body, tries=12):
    """One Main tool call as the canary; retries while Main or Pi is still starting."""
    request = urllib.request.Request('http://127.0.0.1:3081/tools/' + name, data=json.dumps(body).encode(), headers={
        'Authorization': 'Bearer ' + cred['token'], 'Content-Type': 'application/json',
        'X-Merv-Project-Id': cred['projectId']})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)['result']
        except urllib.error.HTTPError as error:
            try:
                code = (json.loads(error.read()).get('error') or {}).get('code')
            except ValueError:
                code = None
            if (error.code < 500 and code != 'pi_runtime_releasing') or attempt == tries - 1:
                raise RuntimeError(f'{name}_http_{error.code}_{code}') from None
        except (urllib.error.URLError, TimeoutError):
            if attempt == tries - 1:
                raise RuntimeError(f'{name}_unreachable') from None
        time.sleep(5)


def whoami(cred):
    who = tool(cred, 'actor.whoami', {})
    need(who.get('role') == 'reader' and who.get('projectId') == cred['projectId'] and
         who.get('id') == cred['actorId'], 'canary identity is not the recorded reader of its project')
    return who


class Step:
    def __init__(self, run, plan):
        self.run, self.plan = run, plan

    def preflight(self, _):
        """Claims the host for this run, then reads the live pins; changes nothing else."""
        claim(self.run.name)
        try:
            need(not main_release_running(), 'a Main release job is running')
            need(shutil.disk_usage('/').free >= 8 << 30, 'less than 8 GiB free on /')
            run(['docker', 'image', 'inspect', '--format', '{{.Id}}', self.plan['current']['localId']])
            cred = credential(Path(self.plan['canary']['credential']))
            whoami(cred)
            catalog = json.loads(env_of(CONTROL)[CATALOG])
            need(catalog == json.loads(env_of(PIPELINE)[CATALOG]), 'catalog_services_differ')
            return {'native': native(), 'mainReleaseId': env_of(MAIN).get(KEY),
                    'fileReleaseId': env_value(ENV.read_bytes(), KEY), 'canaryActor': cred['actorId'],
                    'catalog': [r['image_digest'] for r in catalog if r['provider'] == PROVIDER]}
        except BaseException:
            if owner() == self.run.name:
                (HOME / 'active').unlink()
            raise

    def build(self, _):
        """The whole image from committed sources: the Sandboxes base (with its agent built from Go
        source), the compiled bundle with the worker tests, then scripts/hosted-runner/Dockerfile.
        Its filesystem and config, diffed against the deployed image, decide the lane."""
        plan, work = self.plan, self.run
        tag, base, sandboxes = 'merv-hosted-codex:' + work.name, 'merv-hosted-sandbox:' + work.name, work / 'sandboxes'

        def build(dockerfile, context, *flags, log):
            run(['docker', 'build', '--platform', 'linux/amd64', '-f', dockerfile, *flags, context], timeout=1800,
                log=work / log)
        (work / 'agent.Dockerfile').write_text(
            f'FROM {GO_IMAGE} AS agent\nWORKDIR /src\nCOPY agent/ .\nRUN CGO_ENABLED=0 go build -trimpath -ldflags '
            f'"-s -w -X main.version={plan["sandboxesCommit"][:7]}" -o /out/sandboxes-agent-linux-amd64 '
            './cmd/sandboxes-agent\nFROM scratch\nCOPY --from=agent /out/ /\n')
        build(work / 'agent.Dockerfile', sandboxes, '--output',
              f'type=local,dest={sandboxes}/deploy/cloudflare-sandbox/bin', log='build-agent.log')
        build(sandboxes / 'deploy/cloudflare-sandbox/Dockerfile', sandboxes, '-t', base, log='build-sandbox.log')
        (work / 'bundle.Dockerfile').write_text(
            f'FROM {plan["nodeImage"]} AS build\nWORKDIR /app\nCOPY . .\nRUN --mount=type=cache,target=/root/.npm '
            'npm ci --no-audit --no-fund && node scripts/hosted-runner/build.mjs /bundle \\\n'
            f' && node --import tsx --test {WORKER_TESTS}\nFROM scratch\nCOPY --from=build /bundle/ /\n')
        build(work / 'bundle.Dockerfile', work / 'source', '--output', f'type=local,dest={work}/bundle',
              log='build-bundle.log')
        build(work / 'source/scripts/hosted-runner/Dockerfile', work / 'bundle', '--build-arg', 'SANDBOX_IMAGE=' + base,
              '--label', 'org.merv.hosted.source-commit=' + plan['sourceCommit'],
              '--label', 'org.merv.hosted.source-sha256=' + plan['contentSha256'],
              '--label', 'org.merv.hosted.sandboxes-commit=' + plan['sandboxesCommit'], '-t', tag, log='build.log')
        deployed, candidate = inspect(plan['current']['localId']), inspect(tag)
        need(candidate['Architecture'] == 'amd64', 'candidate is not linux/amd64')
        before, after = rootfs(plan['current']['localId']), rootfs(tag)
        changed = sorted(p for p in before.keys() | after.keys() if before.get(p) != after.get(p))
        config_changed = [{k: v for k, v in i['Config'].items() if k != 'Labels'} for i in (deployed, candidate)]
        config_changed = config_changed[0] != config_changed[1]
        inputs = json.loads((work / 'bundle/input-hashes.json').read_bytes())
        return {'candidate': candidate['Id'], 'tag': tag, 'lane': final_lane(plan, changed, config_changed),
                'imageLane': image_lane(changed, config_changed), 'configChanged': config_changed,
                'changed': changed[:100], 'changedCount': len(changed),
                'executableSha256': after['/opt/merv/runtime/start-runner'][4],
                'inputs': sorted(k for k in inputs if not k.startswith(('node_modules/', '../')))}

    def gates(self, _):
        """The Linux gates of the lane this host decided, against the exact candidate, failing closed."""
        build = read(self.run / 'build.json')
        results = {}
        for name in LANE_GATES[build['lane']]:
            flags, targets, command, expected, lines = GATES[name]
            gate = self.run / 'source/scripts/hosted-runner' / name
            mounts = [part for target in targets for part in ('-v', f'{gate}:{target}:ro')]
            out = run(['docker', 'run', '--rm', '--network', 'none', *flags, *mounts, build['candidate'], command],
                      timeout=300, log=self.run / f'gate-{name}.log').decode()
            need(gate_passed(out, expected, lines), 'gate_failed: ' + name)
            results[name] = 'pass'
        return results

    def push(self, arg):
        """Pushes the gated candidate with a short-lived credential kept in RAM, then pins its amd64 digest."""
        cred, candidate = arg['credential'], read(self.run / 'build.json')['candidate']
        repo = self.plan['current']['image'].split('@')[0]
        target = f'{repo}:hosted-{self.run.name}'
        config = tempfile.mkdtemp(dir='/run', prefix='merv-hosted-docker-')  # /run is tmpfs: never on disk
        env = dict(os.environ, DOCKER_CONFIG=config)
        inspect_raw = lambda ref: run(['docker', 'buildx', 'imagetools', 'inspect', '--raw', ref], env=env)
        try:
            run(['docker', 'login', 'registry.cloudflare.com', '--username', cred['username'], '--password-stdin'],
                payload=cred['password'].encode(), env=env)
            del cred, arg['credential']
            probe = subprocess.run(['docker', 'buildx', 'imagetools', 'inspect', '--raw', target], env=env,
                                   capture_output=True, timeout=60)
            need(probe.returncode and re.search(rb'not found|manifest unknown', probe.stderr, re.I), 'push tag exists')
            run(['docker', 'tag', candidate, target])
            pushed = re.findall(r'digest: (sha256:[0-9a-f]{64})', run(['docker', 'push', target], env=env,
                                                                       timeout=1800).decode())
            need(pushed == [candidate], 'pushed digest differs from the gated image')
            raw = inspect_raw(f'{repo}@{candidate}')
            digest = candidate
            manifests = json.loads(raw).get('manifests')
            if manifests is not None:
                [digest] = [m['digest'] for m in manifests if m.get('platform', {}).get('os') == 'linux'
                            and m['platform'].get('architecture') == 'amd64']
                raw = inspect_raw(f'{repo}@{digest}')
            need('sha256:' + sha(raw) == digest, 'registry manifest does not hash to its digest')
            return {'image': f'{repo}@{digest}', 'tag': target, 'index': candidate}
        finally:
            subprocess.run(['docker', 'logout', 'registry.cloudflare.com'], env=env, capture_output=True)
            shutil.rmtree(config, ignore_errors=True)

    def catalog(self, arg):
        """Adds the release to both Sandboxes services, keeping earlier releases, and recreates them.
        {"restore": true} puts back the file this run replaced, for a restore that failed."""
        labels = inspect(CONTROL)['Config']['Labels']
        path, project = Path(labels['com.docker.compose.project.config_files']), labels['com.docker.compose.project']
        need(path.is_file(), 'catalog file is not a single file')
        need(not main_release_running(), 'a Main release job is running')
        up = ['docker', 'compose', '-p', project, '-f', path, 'up', '-d', '--no-deps', 'control', 'pipelines-worker']
        mode, backup = stat.S_IMODE(path.stat().st_mode), self.run / 'catalog.before'

        def apply(raw):
            atomic(path, raw, mode)
            run(up, timeout=240)
            healthy(CONTROL, 90, 2)
            expected = json.loads(json.loads(raw)['services']['control']['environment'][CATALOG])
            for name in (CONTROL, PIPELINE):
                need(inspect(name)['State']['Running'] and json.loads(env_of(name)[CATALOG]) == expected,
                     'catalog not live in ' + name)
        if arg.get('restore'):
            if backup.exists():
                apply(backup.read_bytes())
            self.note({'catalogBroken': False})
            return {'restored': backup.exists()}
        entry = arg['entry']
        need(sbx(MERV_RELEASE=json.dumps(entry)) == arg['releaseId'], 'Sandboxes derives a different release id')
        raw = path.read_bytes()
        doc, changed = with_release(json.loads(raw), entry, protect=arg['protect'])
        result = {'releaseId': arg['releaseId'], 'digest': entry['image_digest'],
                  'releases': len(json.loads(doc['services']['control']['environment'][CATALOG]))}
        if not changed and all(json.loads(env_of(c)[CATALOG]) == json.loads(doc['services']['control']['environment']
                                                                              [CATALOG]) for c in (CONTROL, PIPELINE)):
            return {**result, 'changed': False}
        quiet(self.plan['drainSeconds'])
        if not backup.exists():
            atomic(backup, raw)
        try:
            apply((json.dumps(doc, indent=2) + '\n').encode())
        except BaseException:
            try:
                apply(raw)
            except BaseException as error:
                self.note({'catalogBroken': True})
                raise RuntimeError(f'catalog restore failed too: {error}') from None
            raise
        return {**result, 'changed': True, 'sha256Before': sha(raw), 'sha256After': sha(path.read_bytes())}

    def drain(self, _):
        return quiet(self.plan['drainSeconds'])

    def native(self, _):
        return native()

    def switch(self, arg):
        """Points Main at a release id and recreates it on its own image; restores the env on failure.
        It never waits for a drain: by now Cloudflare runs one release and Main must name it."""
        target = arg['releaseId']
        need(re.fullmatch(r'rt1_[0-9a-f]{64}', target), 'invalid release id')
        raw = ENV.read_bytes()
        if env_value(raw, KEY) == target and env_of(MAIN).get(KEY) == target:
            return {'changed': False}
        need(not main_release_running(), 'a Main release job is running')
        state = inspect(MAIN)
        image, directory = state['Image'], state['Config']['Labels']['com.docker.compose.project.working_dir']
        if not (self.run / 'env.before').exists():
            atomic(self.run / 'env.before', raw)
        env = dict(os.environ, MERV_TS_IMAGE=image)
        up = ['docker', 'compose', '-f', 'compose.yml', 'up', '-d', '--force-recreate']
        atomic(ENV, with_env(raw, KEY, target))
        try:
            # The image's own render refuses a bad env before Main is recreated on it.
            run(['docker', 'compose', '-f', 'compose.yml', 'run', '--rm', '--no-deps', '-T', '--entrypoint', 'node',
                 'control', '/app/deploy/render-config.mjs', '/tmp/hosted-release-render.json'], env=env,
                cwd=directory, timeout=120)
            run(up, env=env, cwd=directory, timeout=240)
            healthy(MAIN, 60, 4)
            need(inspect(MAIN)['Image'] == image and env_of(MAIN).get(KEY) == target, 'Main did not take the release')
        except BaseException:
            atomic(ENV, raw)
            run(up, env=env, cwd=directory, timeout=240)
            raise
        return {'changed': True, 'image': image, 'envSha256Before': sha(raw), 'envSha256After': sha(ENV.read_bytes())}

    def canary(self, arg):
        """One real Pi turn as the canary reader; proves the release served it and its machine was released."""
        cred, target = credential(Path(self.plan['canary']['credential'])), arg['releaseId']
        whoami(cred)
        nonce = secrets.token_hex(4)
        word, started = 'canary-' + nonce, time.monotonic()
        conversation = tool(cred, 'pi.create', {'requestId': 'hosted-' + nonce, 'title': CANARY_NAME})['id']
        owner_id = conversation + ':%'
        command = {}
        try:
            sent = tool(cred, 'pi.send', {'id': conversation, 'commandId': word,
                                          'text': f'Reply with exactly: {word}. Do not use any tools.'})
            while time.monotonic() - started < 420:
                snapshot = tool(cred, 'pi.snapshot', {'id': conversation})
                command = next(c for c in snapshot['commands'] if c['id'] == sent['id'])
                if command['status'] not in ACTIVE:
                    break
                time.sleep(3)
        finally:
            with contextlib.suppress(RuntimeError):
                tool(cred, 'pi.stop', {'id': conversation}, tries=3)
        served = main_read("SELECT count(*)::int AS n FROM {s}.fleet_allocations WHERE data_json::jsonb->'owner'->>'id' "
                           "LIKE $1 AND data_json::jsonb->'runtime'->'launch'->>'releaseId' = $2", owner_id, target)['n']
        for _ in range(60):
            live = main_read("SELECT count(*)::int AS n FROM {s}.fleet_allocations WHERE "
                             "data_json::jsonb->'owner'->>'id' LIKE $1 AND phase <> 'released'", owner_id)['n']
            if not live:
                break
            time.sleep(3)
        result = {'conversation': conversation, 'status': command.get('status'), 'error': command.get('error'),
                  'reply': any(word in m.get('text', '') for m in command.get('messages', [])
                               if m.get('role') == 'assistant'),
                  'servedByRelease': served > 0, 'released': not live,
                  'seconds': round(time.monotonic() - started)}
        need(result['status'] == 'completed' and result['reply'] and result['servedByRelease'] and result['released'],
             'canary_failed ' + json.dumps(result))
        return result

    def note(self, arg):
        """Records progress; the first deployAttempted arms the guard timer before it is recorded."""
        path = self.run / 'progress.json'
        before = read(path) or {}
        if arg.get('deployAttempted') and not before.get('deployAttempted'):
            run(['systemd-run', '--unit', guard_unit(self.run), '--on-active=300', '--on-unit-active=120',
                 sys.executable, Path(__file__).resolve(), 'guard', self.run])
        atomic(path, json.dumps({**before, **arg}).encode())
        return {**before, **arg}

    def finish(self, arg):
        """Closes the run: the new pins (on success), the guard, the backups, the marker."""
        if arg.get('state'):
            atomic(HOME / 'state.json', json.dumps(arg['state']).encode())
        for name in ('catalog.before', 'env.before'):  # they hold secrets
            if (self.run / name).exists():
                subprocess.run(['shred', '-u', self.run / name], capture_output=True)
        if owner() == self.run.name:
            (HOME / 'active').unlink()
        for tidy in (['systemctl', 'stop', guard_unit(self.run) + '.timer'],
                     ['docker', 'image', 'rm', 'merv-hosted-sandbox:' + self.run.name],
                     ['docker', 'builder', 'prune', '-f', '--filter', 'until=168h']):  # best effort
            with contextlib.suppress(subprocess.SubprocessError):
                subprocess.run(tidy, capture_output=True, timeout=600)
        return {'finished': True, 'result': arg.get('result')}

    def status(self, _):
        out = {p.stem: read(p) for p in sorted(self.run.glob('*.json')) if p.stem in RECORDED}
        lease = read(self.run / 'lease.json')
        return {**out, 'open': owner() == self.run.name, 'lease': lease,
                'leaseAge': lease and time.time() - lease['seen']}

    def guard(self, _):
        """Systemd timer from the Cloudflare deploy until finish. When the driver has been silent for
        LEASE seconds, points Main at whichever release Cloudflare settled on; the run stays open
        for the next hosted-release.mjs to canary or roll back."""
        if (self.run / 'finish.json').exists() or owner() != self.run.name:
            subprocess.run(['systemctl', 'stop', guard_unit(self.run) + '.timer'], capture_output=True)
            return {'guard': 'closed'}
        lease = read(self.run / 'lease.json') or {}
        if time.time() - lease.get('seen', 0) < LEASE:
            return {'guard': 'driver alive'}
        live, catalog, current = native(), read(self.run / 'catalog.json'), self.plan['current']
        targets = {current['image']: current['releaseId']}
        if catalog:
            targets[read(self.run / 'push.json')['image']] = catalog['releaseId']
        target = targets.get(live['image'])
        if not target or live.get('rollout'):
            return {'guard': 'waiting for Cloudflare to settle'}
        result = self.switch({'releaseId': target})
        self.note({'guard': {'at': time.time(), 'releaseId': target}})
        return {'guard': 'switched' if result['changed'] else 'consistent', 'releaseId': target}

    def mint_canary(self, _):
        """Once: a non-expiring reader key for the service pilot, minted inside Main and stored root-only."""
        path = Path(self.plan['canary']['credential'])
        need(path.is_absolute() and not str(path).startswith('/var/lib/merv-ts'), 'keep the credential outside Main')
        if path.exists() or path.is_symlink():
            cred = credential(path)
            whoami(cred)
            return {'existing': True, 'actorId': cred['actorId'], 'credentialId': cred['credentialId']}
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(path.parent, 0o700)
        issued = json.loads(run(['docker', 'exec', '-e', 'MERV_CANARY_PROJECT=' + self.plan['canary']['projectId'],
                                 '-e', 'MERV_CANARY_NAME=' + CANARY_NAME, '-w', '/app', MAIN, 'node',
                                 '--input-type=module', '-e', MINT], timeout=120))
        need(issued.get('projectId') == self.plan['canary']['projectId'], 'minted for another project')
        atomic(path, json.dumps(issued).encode())
        whoami(credential(path))
        return {'existing': False, 'actorId': issued['actorId'], 'credentialId': issued['credentialId']}


def locked(lock, seconds):
    for _ in range(max(1, seconds // 2)):
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            time.sleep(2 if seconds else 0)
    return False


def step(name, directory, payload):
    need(os.geteuid() == 0, 'run as root')
    need(name in STEPS, 'unknown step')
    need(directory.is_dir() and not directory.is_symlink(), f'no hosted run at {directory}')
    need(directory.stat().st_uid == 0 and directory.stat().st_mode & 0o077 == 0, 'run directory must be root-private')
    driver, arg = payload.get('driver'), payload.get('arg') or {}
    if name in ('preflight', 'mint_canary'):  # the plan arrives with the first step of a run
        atomic(directory / 'plan.json', json.dumps(arg).encode())
        arg = {}
    work = Step(directory, json.loads((directory / 'plan.json').read_bytes()))
    HOME.mkdir(mode=0o700, parents=True, exist_ok=True)
    if name == 'status':
        return work.status(arg)
    with (HOME / 'lock').open('a') as lock:
        if not locked(lock, 0 if name == 'guard' else 1200):
            need(name == 'guard', 'another hosted-release step held the host lock for 20 minutes')
            return {'guard': 'busy'}
        if name == 'guard':
            return work.guard(arg)
        if name not in ('preflight', 'mint_canary', 'finish'):
            need(owner() == directory.name, f'hosted run {directory.name} does not hold {HOME / "active"}')
        with leased(directory, driver) if name != 'mint_canary' else contextlib.nullcontext():
            result = getattr(work, name)(arg)
    if name in RECORDED and not arg.get('restore'):
        atomic(directory / f'{name}.json', json.dumps(result).encode())
    return result


def main():
    os.umask(0o077)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    try:
        result = step(sys.argv[1], Path(sys.argv[2]), json.loads(sys.stdin.read() or '{}'))
    except Exception as error:
        print(json.dumps({'error': str(error)[-1500:]}), flush=True)
        sys.exit(1)
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
