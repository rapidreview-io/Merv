"""Root-side steps of deploy/hosted-release.mjs on the production host; read that file first.

Each step runs from the run's own copy of committed HEAD:
  sudo python3 <run>/source/deploy/hosted-release-vm.py <step> <run>   ({"driver", "arg"} on stdin)
and prints one JSON line. Results land in <run>/<step>.json, so an interrupted run resumes.
One run at a time holds HOME/active from preflight to finish; release.mjs's Main job refuses to
start while it exists. One driver at a time holds the run's lease: a running step keeps it fresh,
and a lease unseen for LEASE seconds may be taken over. SIGHUP is ignored, so a dropped SSH
session does not stop a step. From the first deploy attempt until finish every step arms an
enabled systemd timer, unless it runs, so a reboot keeps it; it runs `guard`: when the driver has
gone silent it points each of Main's machines at the release its Cloudflare app runs, so a lost
laptop never leaves Pi refusing every launch. `abandon` lets the driver close a run that can neither
finish nor roll back. The live apps are those serving Main's machines (MERV_FLEET_RUNTIMES, else the
one Standard machine), as preflight read them; a run's release is Standard's entry and its copy for
each other app, only the provider changed, and its releaseId is always Standard's.
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
GUARD = Path('/etc/systemd/system/merv-hosted-guard')  # .service and .timer, for the open run
KEY, RUNTIMES = 'MERV_FLEET_RUNTIME_RELEASE_ID', 'MERV_FLEET_RUNTIMES'  # Standard's legacy key; every machine
CATALOG, PROVIDER = 'SANDBOXES_RUNTIME_RELEASES', 'cloudflare-fleet'  # PROVIDER: the Standard app
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
GATE_FACTS, GATE_FALSE = {'prestarted', 'codexSandboxOnHost'}, {'actualProtectedWorkflow', 'cloudflareEvidence'}
RECORDED = ('plan', 'preflight', 'build', 'gates', 'push', 'catalog', 'progress', 'finish')
STEPS = {'preflight', 'build', 'gates', 'push', 'catalog', 'drain', 'native', 'switch', 'canary', 'note', 'finish',
         'status', 'guard', 'abandon', 'mint_canary', 'pins'}
# One row from Main's database, read only unless MERV_W is set; {s} is Main's schema.
MAIN_READ = r'''import pg from 'pg';
const c=new pg.Client({connectionString:process.env.MERV_DB_URL});await c.connect();const w=!!process.env.MERV_W;
try{await c.query(w?'BEGIN':'BEGIN READ ONLY');const s=(process.env.MERV_TS_DB_SCHEMA??'merv_ts').replace(/[^a-z0-9_]/g,'');
const r=await c.query(process.env.MERV_Q.replaceAll('{s}',s),JSON.parse(process.env.MERV_P));
console.log(JSON.stringify(r.rows[0]));await c.query(w?'COMMIT':'ROLLBACK')}finally{await c.end()}'''
# Ends each idle Pi host's idle clock: Main releases its machine at its next pass, as at the idle
# timeout, instead of a rollout killing it. A host that took a turn meanwhile keeps it.
IDLE = ("WITH e AS (UPDATE {s}.pi_hosts SET data_json = jsonb_set(data_json::jsonb, '{idleSince}', "
        "to_jsonb('1970-01-01T00:00:00.000Z'::text))::text WHERE status = 'live' AND "
        "data_json::jsonb->>'idleSince' IS NOT NULL) ")
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
        elif os.environ.get('MERV_RELEASES'):
            from merv_sandboxes.runtimes.releases import RuntimeRelease
            print(json.dumps([RuntimeRelease(**{**e,'arguments':tuple(e.get('arguments',()))}).release_id
                              for e in json.loads(os.environ['MERV_RELEASES'])]))
        else:
            # The host-configured app itself, whichever namespaces it serves.
            b=c.providers._host.get(os.environ['MERV_PROVIDER'])
            if not b:
                raise SystemExit(os.environ['MERV_PROVIDER']+' is not an enabled Sandboxes provider')
            d=b.driver
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


def main_read(query, *params, write=False):
    return json.loads(run(['docker', 'exec', '-e', 'MERV_Q=' + query, '-e', 'MERV_P=' + json.dumps(params),
                           *(['-e', 'MERV_W=1'] if write else []), '-w', '/app', MAIN, 'node',
                           '--input-type=module', '-e', MAIN_READ]))


def sbx(**env):
    flags = [part for key, value in env.items() for part in ('-e', f'{key}={value}')]
    return json.loads(run(['docker', 'exec', *flags, CONTROL, 'python', '-c', SBX], timeout=60))


def native(provider=PROVIDER):
    return sbx(MERV_PROVIDER=provider)


def release_ids(entries):
    return sbx(MERV_RELEASES=json.dumps(entries))


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


def arm(directory, arg):
    """From the first deploy attempt, the guard timer for this run, unless it already runs: installed
    and enabled, so a reboot keeps it. The first deploy never goes ahead without it; any later step
    re-arms it as best it can."""
    if not (arg.get('deployAttempted') or (read(directory / 'progress.json') or {}).get('deployAttempted')):
        return
    timer = GUARD.name + '.timer'
    units = {GUARD.with_suffix('.service'): '[Service]\nType=oneshot\n'
             f'ExecStart={sys.executable} {Path(__file__).resolve()} guard {directory}\n',
             GUARD.with_suffix('.timer'): '[Timer]\nOnActiveSec=300\nOnUnitActiveSec=120\n'
             '[Install]\nWantedBy=timers.target\n'}
    if all(p.exists() and p.read_text() == text for p, text in units.items()) and \
            subprocess.run(['systemctl', 'is-active', '--quiet', timer], capture_output=True).returncode == 0:
        return
    try:
        for path, text in units.items():
            atomic(path, text.encode(), 0o644)
        run(['systemctl', 'daemon-reload'])
        run(['systemctl', 'enable', '--now', timer])
    except (RuntimeError, OSError):
        if arg.get('deployAttempted'):
            raise


@contextlib.contextmanager
def leased(directory, driver):
    """One driver per run; the step refreshes the lease while it runs, and a finished run drops it."""
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
        if (directory / 'finish.json').exists():
            path.unlink(missing_ok=True)
        else:
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


def file_env(raw):
    return dict(line.split('=', 1) for line in raw.decode().splitlines() if '=' in line and not line.startswith('#'))


def machines(env):
    """{provider: releaseId} of Main's machines: MERV_FLEET_RUNTIMES, else the one legacy Standard machine."""
    if RUNTIMES not in env:
        return {PROVIDER: env.get(KEY)}
    out = {}
    for machine in json.loads(env[RUNTIMES].strip("'")):
        need(out.setdefault(machine['provider'], machine['releaseId']) == machine['releaseId'],
             'two machines on one app name different releases')
    return out


def pins(env):
    """What an env names: Standard's release in the legacy key, and each machine's."""
    return [env.get(KEY), machines(env)]


def with_releases(raw, releases):
    """The env file naming releases[provider] for each machine and Standard's in the legacy key."""
    raw = with_env(raw, KEY, releases[PROVIDER])
    if RUNTIMES not in file_env(raw):
        return raw
    profiles = json.loads(env_value(raw, RUNTIMES).strip("'"))
    need(all(m['provider'] in releases for m in profiles), 'no release for every machine in ' + RUNTIMES)
    for machine in profiles:
        machine['releaseId'] = releases[machine['provider']]
    return with_env(raw, RUNTIMES, "'" + json.dumps(profiles, separators=(',', ':')) + "'")


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


def busy(release=False):
    """Pi turns and launches in flight, by id; idle warm runtimes do not count. With `release` (the
    drain) the same statement first releases idle Pi hosts (IDLE), and every Pi machine up for a
    host, which a turn could still land on, counts until Main has released it. Machines Fleet rents
    for workflow steps never count: they outlive a release by design, and a switch stops them."""
    agg = "coalesce((SELECT json_agg({}) FROM {} WHERE {}), '[]'::json)::text"
    workflow = "data_json::jsonb#>>'{owner,kind}' = 'workflow'"
    reads = {'turns': ("conversation_id || '/' || id", '{s}.pi_commands', f"status IN {ACTIVE}"),
             'launches': ('id', '{s}.fleet_allocations',
                          f"phase IN ('queued','provisioning','launching','starting') AND NOT ({workflow})"),
             'kept': ("json_build_array(data_json::jsonb#>>'{runtime,sandboxId}', "
                      "data_json::jsonb#>>'{runtime,launch,launchId}')",
                      '{s}.fleet_allocations', f"phase <> 'released' AND {workflow}"),
             **({'warm': ('id', '{s}.fleet_allocations', "phase <> 'released' AND data_json::jsonb->>'intent' = "
                          "'run' AND data_json::jsonb#>>'{owner,kind}' = 'pi-host'")} if release else {})}
    main = main_read((IDLE if release else '') + 'SELECT ' +
                     ', '.join(agg.format(*read) + ' AS ' + key for key, read in reads.items()), write=release)
    kept = {part for pair in json.loads(main.pop('kept', '[]')) for part in pair if part}
    lists = {**main,
             'machines': sbx(MERV_Q='SELECT ' + agg.format('id', 'sandboxes', "provider LIKE 'cloudflare-fleet%' AND "
                                                                             "state IN ('provisioning','deleting')")),
             'bootstraps': sbx(MERV_Q='SELECT ' + agg.format('launch_id', 'runtime_bootstraps',
                                                            "state='pending' AND expires_at > now()"))}
    return {key: ids for key, ids in ((k, [i for i in json.loads(v) if i not in kept]) for k, v in lists.items())
            if ids}


def quiet(limit, release=False):
    """Wait, bounded, until nothing is in flight for 10 s."""
    deadline, calm = time.monotonic() + limit, None
    while True:
        now = busy(release)
        if now:
            calm = None
        elif calm is None:
            calm = time.monotonic()
        elif time.monotonic() - calm >= 10:
            return {'drained': True}
        need(time.monotonic() < deadline, f'not_drained_after_{limit}s {json.dumps({k: v[:5] for k, v in now.items()})}'
             f"{': idle Agent machines were released, nothing else changed' if release else ': nothing was changed by this step'}"
             '; rerun when Pi is quieter, or raise --drain-minutes')
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
            return {**self.pins(), 'canaryActor': cred['actorId']}
        except BaseException:
            if owner() == self.run.name:
                (HOME / 'active').unlink()
            raise

    def pins(self, _=None):
        """The live pins, reading only: each app serving Main's or the env file's machines, natively,
        the releases both name, and the catalog's release ids."""
        catalog = json.loads(env_of(CONTROL)[CATALOG])
        need(catalog == json.loads(env_of(PIPELINE)[CATALOG]), 'catalog_services_differ')
        main, raw = env_of(MAIN), ENV.read_bytes()
        releases, file_releases = machines(main), machines(file_env(raw))
        return {'apps': {p: native(p) for p in {**releases, **file_releases}}, 'mainReleaseId': main.get(KEY),
                'fileReleaseId': env_value(raw, KEY), 'releases': releases, 'fileReleases': file_releases,
                'catalog': [{'provider': r['provider'], 'digest': r['image_digest'], 'id': i}
                            for r, i in zip(catalog, release_ids(catalog))]}

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
            need(probe.returncode, 'push tag exists')
            need(re.search(rb'not found|manifest unknown', probe.stderr, re.I) and
                 not re.search(rb'unauthorized|forbidden|denied', probe.stderr, re.I),
                 'push tag probe failed :: ' + probe.stderr.decode(errors='replace')[-300:])
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
            need(digest in {'sha256:' + sha(raw), 'sha256:' + sha(raw.removesuffix(b'\n'))},
                 'registry manifest does not hash to its digest')
            return {'image': f'{repo}@{digest}', 'tag': target, 'index': candidate}
        finally:
            subprocess.run(['docker', 'logout', 'registry.cloudflare.com'], env=env, capture_output=True)
            shutil.rmtree(config, ignore_errors=True)

    def catalog(self, arg):
        """Adds the release, an entry per live app, to both Sandboxes services, keeping earlier releases,
        and recreates them. {"restore": true} puts back the file this run replaced, for a restore that failed."""
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
        entries, releases = arg['entries'], arg['releases']
        need(release_ids(entries) == [releases[e['provider']] for e in entries] and
             releases[PROVIDER] == arg['releaseId'], 'Sandboxes derives a different release id')
        raw = path.read_bytes()
        doc, changed = json.loads(raw), False
        for entry in entries:
            doc, added = with_release(doc, entry, protect=arg['protect'])
            changed = changed or added
        result = {'releaseId': arg['releaseId'], 'releases': releases, 'digest': entries[0]['image_digest'],
                  'size': len(json.loads(doc['services']['control']['environment'][CATALOG]))}
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
        """Waits until nothing is in flight and no Pi machine is up, releasing each idle one at every
        poll: one whose turn ends, or that a page warms, while the drain waits goes too."""
        return quiet(self.plan['drainSeconds'], release=True)

    def native(self, arg):
        return native(arg.get('provider', PROVIDER))

    def switch(self, arg):
        """Points each of Main's machines at its app's release ({provider: releaseId}; a releaseId alone
        is Standard's; a machine left out keeps the release Main runs) and recreates Main on its own
        image; restores the env on failure. It never waits for a drain: by now Cloudflare runs the
        release and Main must name it."""
        named = arg['releases'] if 'releases' in arg else {PROVIDER: arg['releaseId']}
        releases = {**machines(env_of(MAIN)), **named}
        need(all(re.fullmatch(r'rt1_[0-9a-f]{64}', r or '') for r in releases.values()), 'invalid release id')
        raw = ENV.read_bytes()
        want = with_releases(raw, releases)
        if want == raw and pins(env_of(MAIN)) == pins(file_env(raw)):
            return {'changed': False}
        need(not main_release_running(), 'a Main release job is running')
        state = inspect(MAIN)
        image, directory = state['Image'], state['Config']['Labels']['com.docker.compose.project.working_dir']
        if not (self.run / 'env.before').exists():
            atomic(self.run / 'env.before', raw)
        env = dict(os.environ, MERV_TS_IMAGE=image)
        up = ['docker', 'compose', '-f', 'compose.yml', 'up', '-d', '--force-recreate']
        atomic(ENV, want)
        try:
            # The image's own render refuses a bad env before Main is recreated on it.
            run(['docker', 'compose', '-f', 'compose.yml', 'run', '--rm', '--no-deps', '-T', '--entrypoint', 'node',
                 'control', '/app/deploy/render-config.mjs', '/tmp/hosted-release-render.json'], env=env,
                cwd=directory, timeout=120)
            run(up, env=env, cwd=directory, timeout=240)
            healthy(MAIN, 60, 4)
            need(inspect(MAIN)['Image'] == image and pins(env_of(MAIN)) == pins(file_env(want)),
                 'Main did not take the release')
        except BaseException:
            atomic(ENV, raw)
            run(up, env=env, cwd=directory, timeout=240)
            raise
        return {'changed': True, 'image': image, 'envSha256Before': sha(raw), 'envSha256After': sha(ENV.read_bytes())}

    def canary(self, arg):
        """One real Pi turn as the canary reader on Standard; proves the release served it and its
        machine was released, and that every other live app runs the same image, healthy."""
        cred, target = credential(Path(self.plan['canary']['credential'])), arg['releaseId']
        whoami(cred)
        nonce = secrets.token_hex(4)
        word, started = 'canary-' + nonce, time.monotonic()
        conversation = tool(cred, 'pi.create', {'requestId': 'hosted-' + nonce, 'title': CANARY_NAME})['id']
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
            # Pi v2 shares the person's machine and keeps it 10 idle minutes, so the canary releases it
            # as a person would (Release machine); v1 has no such tool, and its pi.stop releases it.
            for name, body in (('pi.stop', {'id': conversation}), ('pi.machine.stop', {})):
                with contextlib.suppress(RuntimeError):
                    tool(cred, name, body, tries=3)
        allocation = command.get('runtimeId')  # the machine that served the turn
        served = main_read("SELECT count(*)::int AS n FROM {s}.fleet_allocations WHERE id = $1 AND "
                           "data_json::jsonb->'runtime'->'launch'->>'releaseId' = $2", allocation, target)['n']
        for _ in range(60):
            live = main_read("SELECT count(*)::int AS n FROM {s}.fleet_allocations WHERE id = $1 AND "
                             "phase <> 'released'", allocation)['n']
            if not live:
                break
            time.sleep(3)
        image = native()['image']
        apps = {p: native(p) for p in self.apps() if p != PROVIDER}
        result = {'conversation': conversation, 'status': command.get('status'), 'error': command.get('error'),
                  'reply': any(word in m.get('text', '') for m in command.get('messages', [])
                               if m.get('role') == 'assistant'),
                  'servedByRelease': served > 0, 'released': not live,
                  'apps': {p: n['image'] == image and not n.get('rollout') and (n.get('health') or {}).get(
                      'errors') == [] and not n['health'].get('instances', {}).get('failed') for p, n in apps.items()},
                  'seconds': round(time.monotonic() - started)}
        need(result['status'] == 'completed' and result['reply'] and result['servedByRelease'] and result['released']
             and all(result['apps'].values()), 'canary_failed ' + json.dumps(result))
        return result

    def note(self, arg):
        """Records progress; step() arms the guard timer before a first deployAttempted is recorded."""
        path = self.run / 'progress.json'
        before = read(path) or {}
        atomic(path, json.dumps({**before, **arg}).encode())
        return {**before, **arg}

    def finish(self, arg):
        """Closes the run: the new pins (on success), the guard, the backups, the marker."""
        if arg.get('state'):
            atomic(HOME / 'state.json', json.dumps(arg['state']).encode())
        for name in ('catalog.before', 'env.before'):  # they hold secrets
            if (self.run / name).exists():
                subprocess.run(['shred', '-u', self.run / name], capture_output=True)
        if owner() == self.run.name:  # the guard timer is the open run's
            subprocess.run(['systemctl', 'disable', '--now', GUARD.name + '.timer'], capture_output=True)
            (HOME / 'active').unlink()
        for tidy in (['docker', 'image', 'rm', 'merv-hosted-sandbox:' + self.run.name],
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
        LEASE seconds, points each of Main's machines at the release its app settled on; a machine
        whose app Sandboxes cannot read keeps its release. The run stays open for the next
        hosted-release.mjs to canary or roll back."""
        if (self.run / 'finish.json').exists() or owner() != self.run.name:
            subprocess.run(['systemctl', 'disable', '--now', GUARD.name + '.timer'], capture_output=True)
            return {'guard': 'closed'}
        lease = read(self.run / 'lease.json') or {}
        if time.time() - lease.get('seen', 0) < LEASE:
            return {'guard': 'driver alive'}
        apps, live, known = self.apps(), {}, self.releases()
        for provider in apps:
            with contextlib.suppress(Exception):
                live[provider] = native(provider)
        if any(n.get('rollout') or n['image'] not in known for n in live.values()):
            return {'guard': 'waiting for Cloudflare to settle'}
        target = {p: known[n['image']][p] for p, n in live.items()}
        result = self.switch({'releases': target})
        self.note({'guard': {'at': time.time(), 'releases': target}})
        return {'guard': 'switched' if result['changed'] else 'consistent', 'releases': target,
                'unread': [p for p in apps if p not in live]}

    def apps(self):
        """The providers whose apps serve Main's machines, as preflight read them."""
        return list((read(self.run / 'preflight.json') or {}).get('releases') or [PROVIDER])

    def releases(self):
        """This run's releases by image, each {provider: releaseId}: the previous one (Main's machines
        at preflight) and, once catalogued, its own."""
        current, catalog = self.plan['current'], read(self.run / 'catalog.json')
        before = (read(self.run / 'preflight.json') or {}).get('releases') or {PROVIDER: current['releaseId']}
        targets = {current['image']: before}
        if catalog:
            targets[read(self.run / 'push.json')['image']] = catalog['releases']
        return targets

    def abandon(self, _):
        """Changes nothing: names the release production agrees on, so the driver may close the run
        without finishing or rolling it back. Every live app runs one of this run's images with no
        rollout, Main and the env file name its releases, and both Sandboxes services' catalog holds them."""
        live = {p: native(p) for p in self.apps()}
        image = live[PROVIDER]['image']
        target, catalog = self.releases().get(image), json.loads(env_of(CONTROL)[CATALOG])
        held = {(r['provider'], i) for r, i in zip(catalog, release_ids(catalog))
                if r['image_digest'] == image.split('@')[-1]}
        want = [target[PROVIDER], target] if target else None
        main, file = pins(env_of(MAIN)), pins(file_env(ENV.read_bytes()))
        names = lambda p: ', '.join(dict.fromkeys([p[0], *p[1].values()]))
        problems = [p for p in (
            not target and f'Cloudflare runs {image}, neither release of this run',
            any(n['image'] != image for n in live.values()) and 'the Cloudflare apps run different images',
            any(n.get('rollout') for n in live.values()) and 'a Cloudflare rollout is in progress',
            main != want and f'Main runs {names(main)}',
            file != want and f'the env file names {names(file)}',
            not set((target or {PROVIDER: None}).items()) <= held and 'the Sandboxes catalog lacks that release',
            catalog != json.loads(env_of(PIPELINE)[CATALOG]) and 'the two Sandboxes services hold different catalogs',
        ) if p]
        need(not problems, 'production disagrees, so the run stays open: ' + '; '.join(problems))
        return {'releaseId': target[PROVIDER], 'releases': target, 'image': image}

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
    if name in ('preflight', 'mint_canary', 'pins'):  # the plan arrives with the first step of a run
        atomic(directory / 'plan.json', json.dumps(arg).encode())
        arg = {}
    work = Step(directory, json.loads((directory / 'plan.json').read_bytes()))
    HOME.mkdir(mode=0o700, parents=True, exist_ok=True)
    if name in ('status', 'pins'):  # reads only, and holds nothing
        result = getattr(work, name)(arg)
        if name == 'pins' and directory.name.endswith('-check'):  # a --check run keeps no copy
            shutil.rmtree(directory)
        return result
    with (HOME / 'lock').open('a') as lock:
        if not locked(lock, 0 if name == 'guard' else 1200):
            need(name == 'guard', 'another hosted-release step held the host lock for 20 minutes')
            return {'guard': 'busy'}
        if name == 'guard':
            return work.guard(arg)
        if name not in ('preflight', 'mint_canary', 'finish'):
            need(owner() == directory.name, f'hosted run {directory.name} does not hold {HOME / "active"}')
        with leased(directory, driver) if name != 'mint_canary' else contextlib.nullcontext():
            if name != 'finish':
                arm(directory, arg)
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
