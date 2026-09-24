"""Root-side steps of deploy/hosted-release.mjs on the production host; read that file first.

The orchestrator runs each step from the run's own copy of committed HEAD:
  sudo python3 <run>/source/deploy/hosted-release-vm.py <step> <run>   (one JSON object on stdin)
and reads one JSON line back. Every step is idempotent or recorded in <run>/<step>.json, and a
dropped SSH session does not stop a step (SIGHUP is ignored), so --resume can pick it up.
Never prints a secret: the registry credential and the canary token stay inside this process,
and every backup of the env file or the Sandboxes catalog is root-private inside the run.
"""
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
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

MAIN, CONTROL, PIPELINE = 'merv-typescript-control-1', 'sandboxes-control-1', 'sandboxes-pipelines-worker-1'
ENV = Path('/etc/merv/typescript.env')
HOME = Path('/var/lib/merv-fleet-pilot/hosted-release')  # lock + the open run's id
KEY, CATALOG, PROVIDER = 'MERV_FLEET_RUNTIME_RELEASE_ID', 'SANDBOXES_RUNTIME_RELEASES', 'cloudflare-fleet'
NAMESPACE = 'fleet-cloudflare-canary'  # resolves the provider for native reads
ACTIVE = ('waiting', 'starting', 'working', 'saving')
KEEP = 16  # releases per provider; every protected launch copies them into a 32-entry VM file
CANARY_NAME = 'Hosted release canary'
# Installed paths of the one overlay layer, with the modes the original image gave them.
OVERLAY = {
    '/opt/merv/runner/': ('0644', ['smoke-supervisor.mjs', 'supervisor.mjs']),
    '/opt/merv/pi/': ('0644', ['pi/worker-main.mjs', 'pi/package.json']),
    '/opt/merv/runtime/': ('0755', ['start-runtime.py', 'assignment-probed.py']),
    '/opt/merv/runtime/isolation_probe.py': ('0644', ['isolation_probe.py']),
    '/opt/merv/runtime/start-runner': ('0755', ['start']),
    '/usr/share/merv/hosted-inputs.json': ('0444', ['input-hashes.json']),
}
INSTALLED = [t + f.split('/')[-1] if t.endswith('/') else t for t, (_, files) in OVERLAY.items() for f in files]
STEPS = {'preflight', 'build', 'gates', 'push', 'catalog', 'drain', 'native', 'switch', 'canary', 'note', 'finish',
         'status', 'mint_canary'}
GATES = {  # name: (docker run flags, mount targets, command, expected gate)
    'linux-pi-gate.py': (['--cap-add', 'SYS_PTRACE', '--tmpfs', '/run/merv-runtime:mode=0700',
                          '--entrypoint', '/usr/bin/python3.11'],
                         ['/opt/merv/runtime/probe.py'], '/opt/merv/runtime/probe.py', 'linux-pi-protected-launch'),
    'linux-workflow-gate.py': (['--tmpfs', '/run/merv-runtime:mode=0700', '--entrypoint', '/usr/bin/python3.11'],
                               ['/opt/merv/runtime/probe.py'], '/opt/merv/runtime/probe.py', 'linux-workflow-dispatch'),
    'linux-isolation-probe-gate.mjs': (['--entrypoint', '/usr/local/bin/node'],
                                       ['/opt/merv/runner/supervisor.mjs', '/opt/merv/runner/smoke-supervisor.mjs'],
                                       '/opt/merv/runner/smoke-supervisor.mjs', 'linux-isolation-probe-synthetic-ancestry'),
}
WALK = r'''import hashlib,json,os,stat
out={}
for d,dirs,files in os.walk('/opt/merv',followlinks=False):
 for n in sorted(dirs+files):
  p=os.path.join(d,n);i=os.lstat(p);m=i.st_mode;r=[i.st_uid,i.st_gid,stat.S_IMODE(m)]
  if stat.S_ISREG(m):
   with open(p,'rb') as f: r+=['file',hashlib.file_digest(f,'sha256').hexdigest()]
  elif stat.S_ISLNK(m): r+=['link',os.readlink(p)]
  else: r+=['dir' if stat.S_ISDIR(m) else 'other']
  out[p]=r
print(json.dumps(out,sort_keys=True))'''
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


def quiet(limit):
    """Wait, bounded, until no Pi turn or runtime launch is in flight for 10 s; idle runtimes may stay."""
    deadline, calm = time.monotonic() + limit, None
    while True:
        counts = {**main_read("SELECT (SELECT count(*) FROM {s}.pi_commands WHERE data_json::jsonb->>'status' IN "
                              "('waiting','starting','working','saving'))::int AS turns, (SELECT count(*) FROM "
                              "{s}.fleet_allocations WHERE phase IN ('queued','provisioning','launching','starting'))"
                              "::int AS launches"),
                  'machines': sbx(MERV_Q="SELECT (SELECT count(*) FROM sandboxes WHERE provider='cloudflare-fleet' "
                                  "AND state IN ('provisioning','deleting')) + (SELECT count(*) FROM runtime_bootstraps "
                                  "WHERE state='pending' AND expires_at > now())")}
        if any(counts.values()):
            calm = None
        elif calm and time.monotonic() - calm >= 10:
            return counts
        else:
            calm = calm or time.monotonic()
        need(time.monotonic() < deadline, f'not_drained_after_{limit}s {json.dumps(counts)}: nothing was changed '
             'by this step; rerun when Pi is quieter, or raise --drain-minutes')
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
        open_run = (HOME / 'active').read_text().strip() if (HOME / 'active').exists() else ''
        need(open_run in ('', self.run.name), f'hosted rollout {open_run} is still open: '
             f'node deploy/hosted-release.mjs --resume {open_run}')
        need(subprocess.run(['pgrep', '-f', '/opt/merv-typescript/releases/.*/release-job.sh'],
                            capture_output=True).returncode != 0, 'a Main release job is running')
        need(shutil.disk_usage('/').free >= 5 << 30, 'less than 5 GiB free on /')
        for image in {self.plan['base']['localId'], self.plan['current']['localId']}:
            run(['docker', 'image', 'inspect', '--format', '{{.Id}}', image])
        cred = credential(Path(self.plan['canary']['credential']))
        whoami(cred)
        catalog = json.loads(env_of(CONTROL)[CATALOG])
        need(catalog == json.loads(env_of(PIPELINE)[CATALOG]), 'catalog_services_differ')
        return {'native': native(), 'mainReleaseId': env_of(MAIN).get(KEY),
                'fileReleaseId': env_value(ENV.read_bytes(), KEY), 'canaryActor': cred['actorId'],
                'catalog': [r['image_digest'] for r in catalog if r['provider'] == PROVIDER]}

    def build(self, _):
        """One layer of Merv's compiled hosted files on the pinned base; diffed against the deployed image."""
        plan, base = self.plan, 'merv-hosted-codex:base'
        run(['docker', 'tag', plan['base']['localId'], base])
        if subprocess.run(['docker', 'image', 'inspect', plan['nodeImage']], capture_output=True).returncode:
            run(['docker', 'pull', plan['nodeImage']], timeout=600)
        copies = '\n'.join(f'COPY --from=build --chmod={mode} {" ".join("/bundle/" + f for f in files)} {target}'
                           for target, (mode, files) in OVERLAY.items())
        (self.run / 'Dockerfile.hosted').write_text(
            f'FROM {plan["nodeImage"]} AS build\nWORKDIR /app\nCOPY . .\n'
            'RUN npm ci --no-audit --no-fund && node scripts/hosted-runner/build.mjs /bundle \\\n'
            ' && node --import tsx --test tests/pi-worker.test.ts tests/pi-worker-relay-protocol.test.ts tests/pi-relay.test.ts\n'
            f'FROM {base}\n{copies}\n')
        tag = 'merv-hosted-codex:' + self.run.name
        run(['docker', 'build', '--pull=false', '--platform', 'linux/amd64', '-f', self.run / 'Dockerfile.hosted',
             '--label', 'org.merv.hosted.source-commit=' + plan['sourceCommit'],
             '--label', 'org.merv.hosted.source-sha256=' + plan['contentSha256'],
             '-t', tag, self.run / 'source'], timeout=1800, log=self.run / 'build.log')
        deployed, candidate = inspect(plan['current']['localId']), inspect(tag)
        need(candidate['Architecture'] == 'amd64', 'candidate is not linux/amd64')
        before, after = (json.loads(run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint',
                                         '/usr/bin/python3.11', image, '-c', WALK], timeout=180))
                         for image in (plan['current']['localId'], tag))
        bare = [{k: v for k, v in image['Config'].items() if k != 'Labels'} for image in (deployed, candidate)]
        inputs = json.loads(run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'cat', tag,
                                 '/usr/share/merv/hosted-inputs.json']))
        return {'candidate': candidate['Id'], 'tag': tag, 'configChanged': bare[0] != bare[1],
                'changed': sorted(p for p in before.keys() | after.keys() if before.get(p) != after.get(p)),
                'executableSha256': after['/opt/merv/runtime/start-runner'][4],
                'bundleSha256': sha(''.join(f'{after[p][4]}  {p}\n' for p in sorted(INSTALLED) if p in after).encode()),
                'inputs': sorted(k for k in inputs if not k.startswith(('node_modules/', '../')))}

    def gates(self, arg):
        """The Linux gates of this change's lane against the exact candidate, failing closed."""
        candidate, results = json.loads((self.run / 'build.json').read_bytes())['candidate'], {}
        for name in arg['gates']:
            flags, targets, command, expected = GATES[name]
            gate = self.run / 'source/scripts/hosted-runner' / name
            mounts = [part for target in targets for part in ('-v', f'{gate}:{target}:ro')]
            out = run(['docker', 'run', '--rm', '--network', 'none', *flags, *mounts, candidate, command],
                      timeout=300, log=self.run / f'gate-{name}.log').decode().strip().splitlines()
            report = json.loads(out[-1]) if out else {}
            flags_ok = all(v is True for k, v in report.items() if isinstance(v, bool)
                           and k not in ('actualProtectedWorkflow', 'cloudflareEvidence'))
            need(report.get('gate') == expected and flags_ok and report.get('cloudflareEvidence') is not True and
                 report.get('report', {'ok': True}).get('ok') is True, 'gate_failed: ' + name)
            results[name] = 'pass'
        return results

    def push(self, arg):
        """Pushes the gated candidate with a short-lived credential kept in RAM, then pins its amd64 digest."""
        cred, candidate = arg['credential'], json.loads((self.run / 'build.json').read_bytes())['candidate']
        repo = self.plan['base']['image'].split('@')[0]
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
        """Adds the release to both Sandboxes services, keeping earlier releases, and recreates them."""
        # From here until finish this run owns the pins: release.mjs refuses to recreate Main meanwhile.
        atomic(HOME / 'active', self.run.name.encode())
        entry, labels = arg['entry'], inspect(CONTROL)['Config']['Labels']
        need(sbx(MERV_RELEASE=json.dumps(entry)) == arg['releaseId'], 'Sandboxes derives a different release id')
        path, project = Path(labels['com.docker.compose.project.config_files']), labels['com.docker.compose.project']
        need(path.is_file(), 'catalog file is not a single file')
        raw = path.read_bytes()
        doc, changed = with_release(json.loads(raw), entry, protect=arg['protect'])
        expected = json.loads(doc['services']['control']['environment'][CATALOG])
        if not changed and all(json.loads(env_of(c)[CATALOG]) == expected for c in (CONTROL, PIPELINE)):
            return {'changed': False, 'releases': len(expected)}
        quiet(self.plan['drainSeconds'])
        backup = self.run / 'catalog.before'
        if not backup.exists():
            atomic(backup, raw)
        up = ['docker', 'compose', '-p', project, '-f', path, 'up', '-d', '--no-deps', 'control', 'pipelines-worker']
        atomic(path, (json.dumps(doc, indent=2) + '\n').encode(), stat.S_IMODE(path.stat().st_mode))
        try:
            run(up, timeout=240)
            healthy(CONTROL, 90, 2)
            for name in (CONTROL, PIPELINE):
                need(inspect(name)['State']['Running'] and json.loads(env_of(name)[CATALOG]) == expected,
                     'catalog not live in ' + name)
        except BaseException:
            atomic(path, raw, stat.S_IMODE(path.stat().st_mode))
            run(up, timeout=240)
            raise
        return {'changed': True, 'releases': len(expected), 'sha256Before': sha(raw), 'sha256After': sha(path.read_bytes())}

    def drain(self, _):
        return quiet(self.plan['drainSeconds'])

    def native(self, _):
        return native()

    def switch(self, arg):
        """Points Main at a release id and recreates it on its own image; restores the env on failure."""
        target = arg['releaseId']
        need(re.fullmatch(r'rt1_[0-9a-f]{64}', target), 'invalid release id')
        raw = ENV.read_bytes()
        if env_value(raw, KEY) == target and env_of(MAIN).get(KEY) == target:
            return {'changed': False}
        if arg.get('wait', True):
            quiet(self.plan['drainSeconds'])
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
        owner = conversation + ':%'
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
            try:
                tool(cred, 'pi.stop', {'id': conversation}, tries=3)
            except RuntimeError:
                pass
        served = main_read("SELECT count(*)::int AS n FROM {s}.fleet_allocations WHERE data_json::jsonb->'owner'->>'id' "
                           "LIKE $1 AND data_json::jsonb->'runtime'->'launch'->>'releaseId' = $2", owner, target)['n']
        for _ in range(60):
            live = main_read("SELECT count(*)::int AS n FROM {s}.fleet_allocations WHERE "
                             "data_json::jsonb->'owner'->>'id' LIKE $1 AND phase <> 'released'", owner)['n']
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
        path = self.run / 'progress.json'
        value = {**(json.loads(path.read_bytes()) if path.exists() else {}), **arg}
        atomic(path, json.dumps(value).encode())
        return value

    def finish(self, _):
        for name in ('catalog.before', 'env.before'):  # they hold secrets
            if (self.run / name).exists():
                subprocess.run(['shred', '-u', self.run / name], capture_output=True)
        if (HOME / 'active').exists() and (HOME / 'active').read_text().strip() == self.run.name:
            (HOME / 'active').unlink()
        return {'finished': True}

    def status(self, _):
        return {p.stem: json.loads(p.read_bytes()) for p in sorted(self.run.glob('*.json'))
                if p.stem in ('plan', 'preflight', 'build', 'gates', 'push', 'progress', 'finish')}

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


def step(name, directory, arg):
    need(os.geteuid() == 0, 'run as root')
    need(name in STEPS, 'unknown step')
    need(directory.is_dir(), f'no hosted run at {directory}')
    need(directory.stat().st_uid == 0 and directory.stat().st_mode & 0o077 == 0, 'run directory must be root-private')
    if name in ('preflight', 'mint_canary'):  # the plan arrives with the first step of a run
        atomic(directory / 'plan.json', json.dumps(arg).encode())
        arg = {}
    plan = json.loads((directory / 'plan.json').read_bytes())
    HOME.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (HOME / 'lock').open('a') as lock:
        if name != 'status':
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError('another hosted-release step is running on this host') from None
        result = getattr(Step(directory, plan), name)(arg)
    if name in ('preflight', 'build', 'gates', 'push', 'finish'):
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
