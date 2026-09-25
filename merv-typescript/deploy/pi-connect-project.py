"""Connect one Merv project to hosted Pi: its own Sandboxes namespace, consumer grant and connection.

Run on the production host as root, in a quiet window, one phase after the other:
  python3 pi-connect-project.py sandboxes <projectId> [--rehome]
  python3 pi-connect-project.py main <projectId> [--rehome]
(or `python3 - <phase> <projectId> < pi-connect-project.py`). The first phase creates the namespace and a
30-day consumer grant, scopes cloudflare-fleet to every merv-pi-* namespace, allowlists the grant and
recreates Sandboxes control and pipelines-worker. The second adds the connection and the grant variable to
Main's env and recreates Main. Each recreate stops live work, so both phases refuse unless Main and
Sandboxes are drained, and while a hosted-image run is open; each holds that pipeline's host lock.
--rehome moves a project off the shared fleet-cloudflare-canary namespace.
Never prints a secret. Every mutation follows a root-private backup and is undone on failure; the backups
hold secrets, so shred ROOT once the connection is verified and recorded. See deploy/PI_OPERATIONS.md.
"""
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

if not __debug__:
    sys.exit('every guard here is an assert: run without -O')
_, PHASE, PROJECT, *FLAGS = sys.argv + [''] * (3 - len(sys.argv))
REHOME = FLAGS == ['--rehome']
assert PHASE in ('sandboxes', 'main') and FLAGS in ([], ['--rehome']), __doc__
assert re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}', PROJECT), 'invalid_project_id'
ROOT = Path('/var/lib/merv-fleet-pilot/pi-connect') / PROJECT
ENV = Path('/etc/merv/typescript.env')
HOSTED = Path('/var/lib/merv-fleet-pilot/hosted-release')  # deploy/hosted-release-vm.py's lock and open-run marker
MAIN, CONTROL, PIPELINE = 'merv-typescript-control-1', 'sandboxes-control-1', 'sandboxes-pipelines-worker-1'
SUFFIX = hashlib.sha256(PROJECT.encode()).hexdigest()[:20]
NAMESPACE = 'merv-pi-' + SUFFIX
TOKEN_ENV = 'MERV_PI_PROJECT_' + SUFFIX.upper()
CANARY, PROVIDER = 'fleet-cloudflare-canary', 'cloudflare-fleet'
# Merv's Sandboxes account and the member every merv-pi-* namespace belongs to.
ACCOUNT, MEMBER = 'acct_c330sof3z6zju9zw', 'member_w6rb4wzgs4revzh7'

SBX_DRAIN = r'''import asyncio,json
from sqlalchemy import text
from merv_sandboxes.config import Settings
from merv_sandboxes.runtime import Container
async def main():
    c=Container(Settings.load())
    try:
        async with c.db.connect() as conn:
            await conn.execute(text('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'))
            drain=(await conn.execute(text("SELECT json_build_object('sandboxes',(SELECT count(*) FROM sandboxes WHERE state <> 'stopped'),'jobs',(SELECT count(*) FROM jobs WHERE state NOT IN ('succeeded','failed','cancelled','timed_out')),'workflows',(SELECT count(*) FROM pipelines WHERE state NOT IN ('completed','failed','cancelled')),'lifecycle',(SELECT count(*) FROM work_items WHERE state IN ('queued','running')),'dispatch',(SELECT count(*) FROM pipeline_outbox WHERE dispatched_at IS NULL),'snapshots',(SELECT count(*) FROM snapshots WHERE state='pending'))"))).scalar_one()
            names=[r[0] for r in (await conn.execute(text("SELECT name FROM infra_namespaces WHERE name LIKE 'merv-pi-%' ORDER BY name"))).fetchall()]
        print(json.dumps({'drain':drain,'namespaces':names}))
    finally:
        await c.stop()
asyncio.run(main())'''

SBX_ISSUE = r'''import asyncio,json,sys
from merv_sandboxes.config import Settings
from merv_sandboxes.runtime import Container
async def main():
    v=json.load(sys.stdin)
    c=Container(Settings.load())
    try:
        if v['create']:
            await c.accounts.add_namespace(v['account'],v['namespace'],v['member'])
        issued=await c.tokens.create(namespace=v['namespace'],label='Merv Pi '+v['projectId'],ttl_seconds=30*86400,role='consumer',account_id=v['account'],member_id=v['member'],application_id='merv-pi',namespaces=[v['namespace']],members=[v['member']])
        principal=await c.tokens.authenticate(issued.secret,namespace=v['namespace'])
        assert principal.token_id==issued.token_id and principal.namespace==v['namespace']
        print(json.dumps({'tokenId':issued.token_id,'token':issued.secret,'expiresAt':issued.expires_at.isoformat()}))
    finally:
        await c.stop()
asyncio.run(main())'''

SBX_RESOLVE = r'''import asyncio,json,sys
from merv_sandboxes.config import Settings
from merv_sandboxes.runtime import Container
async def main():
    names=json.load(sys.stdin)
    c=Container(Settings.load())
    try:
        out={}
        for n in names:
            try:
                out[n]=(await c.providers.resolve(n,'cloudflare-fleet')).source
            except Exception as e:
                out[n]=type(e).__name__
        print(json.dumps({'resolved':out,'grantAllowed':sorted(c.settings.runtime_launch_grants)}))
    finally:
        await c.stop()
asyncio.run(main())'''

MAIN_DRAIN = r'''import pg from 'pg';
const c=new pg.Client({connectionString:process.env.MERV_DB_URL});
await c.connect();
try{
await c.query('BEGIN READ ONLY');
const s=(process.env.MERV_TS_DB_SCHEMA??'merv_ts').replace(/[^a-z0-9_]/g,'');
const f=await c.query(`SELECT count(*)::int n FROM ${s}.fleet_allocations WHERE phase <> 'released'`);
const p=await c.query(`SELECT count(*)::int n FROM ${s}.pi_commands WHERE data_json::jsonb->>'status' IN ('waiting','starting','working','saving')`);
const j=await c.query(`SELECT count(*)::int n FROM ${s}.projects WHERE id=$1`,[process.env.MERV_CONNECT_PROJECT]);
console.log(JSON.stringify({fleet:f.rows[0].n,commands:p.rows[0].n,project:j.rows[0].n}));
await c.query('ROLLBACK');
}finally{await c.end();}'''

# From Main, with Main's own env: the grant authenticates as a consumer of the namespace, and a launch
# lookup answers 404 (allowlisted) rather than 403 (not allowlisted). Only statuses are printed.
MAIN_PROBE = r'''const secret=process.env[process.env.MERV_CONNECT_TOKEN_ENV];
const headers={authorization:`Bearer ${secret}`,'x-sandbox-namespace':process.env.MERV_CONNECT_NAMESPACE,accept:'application/json'};
const get=(path)=>fetch(new URL(path,process.env.MERV_SANDBOXES_URL),{headers,redirect:'manual',signal:AbortSignal.timeout(15000)});
const me=await get('/v1/auth/me');
const identity=me.status===200?await me.json():{};
const launch=await get('/v1/runtime/launches/rln_'+'0'.repeat(32));
console.log(JSON.stringify({me:me.status,role:identity.role,namespace:identity.namespace,launch:launch.status}));'''


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def exclusive():
    """The hosted-image pipeline's host lock, for the whole phase: both edit the env and the catalog."""
    HOSTED.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = (HOSTED / 'lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit('a hosted-release step holds the host lock; rerun when it ends')
    assert not (HOSTED / 'active').exists(), 'hosted_run_open: `node deploy/hosted-release.mjs` finishes it first'
    return lock


def now():
    return datetime.now(timezone.utc).isoformat()


def run(command, payload=None, timeout=90, env=None, cwd=None):
    result = subprocess.run(command, input=payload, capture_output=True, timeout=timeout, env=env, cwd=cwd)
    if result.returncode:
        # stderr of these commands carries no secrets; cap it anyway
        raise RuntimeError('command_failed: ' + ' '.join(command[:4]) + ' :: ' + result.stderr.decode(errors='replace')[-600:])
    return result.stdout


def save(name, raw, exclusive=True):
    with (ROOT / name).open('xb' if exclusive else 'wb') as out:
        out.write(raw)
        out.flush()
        os.fsync(out.fileno())


def record(name, value):
    save(name, (json.dumps(value, sort_keys=True, indent=1) + '\n').encode(), exclusive=False)


def atomic(path, raw, mode=0o600):
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.pi-connect-')
    with os.fdopen(fd, 'wb') as out:
        out.write(raw)
        out.flush()
        os.fsync(out.fileno())
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def healthy(name, tries, pause):
    for _ in range(tries):
        if inspect(name)['State'].get('Health', {}).get('Status') == 'healthy':
            return
        time.sleep(pause)
    raise RuntimeError('health_timeout: ' + name)


def drains():
    sbx = json.loads(run(['docker', 'exec', '-i', CONTROL, 'python', '-c', SBX_DRAIN]))
    main = json.loads(run(['docker', 'exec', '-i', '-e', 'MERV_CONNECT_PROJECT=' + PROJECT, '-w', '/app', MAIN,
                           'node', '--input-type=module', '-e', MAIN_DRAIN]))
    assert all(v == 0 for v in sbx['drain'].values()), ('sandboxes_not_drained', sbx['drain'])
    assert main == {'fleet': 0, 'commands': 0, 'project': 1}, ('main_not_drained_or_project_unknown', main)
    return sbx['namespaces']


def env_values(raw):
    values = {}
    for line in raw.decode().splitlines():
        if line and not line.startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            values[key] = value[1:-1] if len(value) >= 2 and value[0] in '"\'' and value[-1] == value[0] else value
    return values


def others(values):
    """The other projects' connections; a rehome drops this project's shared canary entry."""
    connections = json.loads(values['MERV_SANDBOXES_CONNECTIONS'])
    current = [c['namespace'] for c in connections if c['projectId'] == PROJECT]
    assert TOKEN_ENV not in values and current == ([CANARY] if REHOME else []), ('connection_state_unexpected', current)
    return [c for c in connections if c['projectId'] != PROJECT]


def sandboxes():
    assert not ROOT.exists(), 'pi_connect_root_exists'
    ROOT.mkdir(mode=0o700, parents=True)
    labels = inspect(CONTROL)['Config']['Labels']
    catalog_path, project = Path(labels['com.docker.compose.project.config_files']), labels['com.docker.compose.project']
    assert catalog_path.is_file(), ('catalog_unexpected', str(catalog_path))
    env_raw, catalog_raw = ENV.read_bytes(), catalog_path.read_bytes()
    save('before-env.private', env_raw)
    save('before-catalog.private.json', catalog_raw)
    image = inspect(CONTROL)['Image']
    for name in (CONTROL, PIPELINE):
        state = inspect(name)
        assert state['Image'] == image and state['State']['Running'], ('sandbox_image_drift', name)
    existing = drains()
    names = sorted(set(existing + [NAMESPACE]))
    others(env_values(env_raw))
    # Shape the catalog before issuing, so a surprise here leaves no orphan grant behind.
    catalog = json.loads(catalog_raw)
    services = [catalog['services'][s]['environment'] for s in ('control', 'pipelines-worker')]
    grants = [json.loads(settings['SANDBOXES_RUNTIME_LAUNCH_GRANTS']) for settings in services]
    for settings in services:
        providers = json.loads(settings['SANDBOXES_PROVIDERS'])
        # An explicit namespace list is exclusive: a merv-pi-* namespace missing from it cannot resolve
        # the provider, and its first Pi send fails (2026-09-24: 33 projects until 19:33Z).
        [fleet] = [p for p in providers if p['name'] == PROVIDER]
        assert CANARY in fleet['namespaces']
        fleet['namespaces'] = fleet['namespaces'] + [n for n in names if n not in fleet['namespaces']]
        settings['SANDBOXES_PROVIDERS'] = json.dumps(providers)
    record('issue.intent.json', {'projectId': PROJECT, 'namespace': NAMESPACE, 'tokenEnv': TOKEN_ENV, 'at': now()})
    # A rerun or a reconnect reuses the namespace; tokens.create refuses one another account owns.
    issue = {'account': ACCOUNT, 'member': MEMBER, 'namespace': NAMESPACE, 'projectId': PROJECT, 'create': NAMESPACE not in existing}
    issued_raw = run(['docker', 'exec', '-i', CONTROL, 'python', '-c', SBX_ISSUE], json.dumps(issue).encode())
    save('issue.private.json', issued_raw)
    issued = json.loads(issued_raw)
    assert NAMESPACE in json.loads(run(['docker', 'exec', '-i', CONTROL, 'python', '-c', SBX_DRAIN]))['namespaces']
    for settings, allowed in zip(services, grants):
        settings['SANDBOXES_RUNTIME_LAUNCH_GRANTS'] = json.dumps(allowed + [issued['tokenId']])
    candidate = (json.dumps(catalog, indent=2) + '\n').encode()
    save('candidate-catalog.private.json', candidate)
    mode = os.stat(catalog_path).st_mode & 0o777
    up = ['docker', 'compose', '-p', project, '-f', str(catalog_path), 'up', '-d', '--no-deps', 'control', 'pipelines-worker']
    atomic(catalog_path, candidate, mode)
    try:
        run(up, timeout=180)
        healthy(CONTROL, 90, 2)
        for name, service in ((CONTROL, 'control'), (PIPELINE, 'pipelines-worker')):
            state = inspect(name)
            assert state['Image'] == image and state['State']['Running'], ('sandbox_not_running', name)
            actual = dict(item.split('=', 1) for item in state['Config']['Env'])
            expected = catalog['services'][service]['environment']
            for key in ('SANDBOXES_PROVIDERS', 'SANDBOXES_RUNTIME_LAUNCH_GRANTS'):
                assert json.loads(actual[key]) == json.loads(expected[key]), ('env_mismatch', name, key)
        check = json.loads(run(['docker', 'exec', '-i', CONTROL, 'python', '-c', SBX_RESOLVE], json.dumps(names + [CANARY]).encode()))
        assert all(v == 'host' for v in check['resolved'].values()), ('resolve_failed', check['resolved'])
        assert issued['tokenId'] in check['grantAllowed'], 'grant_not_allowlisted'
    except BaseException:
        atomic(catalog_path, catalog_raw, mode)
        run(up, timeout=180)
        raise
    expires = datetime.fromisoformat(issued['expiresAt'])
    receipt = {'phase': 'sandboxes-done', 'projectId': PROJECT, 'namespace': NAMESPACE, 'tokenId': issued['tokenId'],
               'expiresAt': issued['expiresAt'], 'renewBy': (expires - timedelta(days=7)).isoformat(),
               'fleetNamespaces': len(fleet['namespaces']), 'image': image, 'catalogSha256Before': sha(catalog_raw),
               'catalogSha256After': sha(catalog_path.read_bytes()), 'at': now()}
    record('sandboxes.receipt.json', receipt)
    print(json.dumps(receipt))


def main_phase():
    assert (ROOT / 'sandboxes.receipt.json').is_file() and not (ROOT / 'main.receipt.json').exists()
    issued = json.loads((ROOT / 'issue.private.json').read_bytes())
    state = inspect(MAIN)
    image, directory = state['Image'], state['Config']['Labels']['com.docker.compose.project.working_dir']
    drains()
    env_raw = ENV.read_bytes()
    connections = others(env_values(env_raw)) + [{'projectId': PROJECT, 'namespace': NAMESPACE, 'tokenEnv': TOKEN_ENV}]
    line = "MERV_SANDBOXES_CONNECTIONS='" + json.dumps(connections, separators=(',', ':')) + "'\n"
    candidate = ''.join(line if raw.split('=', 1)[0] == 'MERV_SANDBOXES_CONNECTIONS' else raw
                        for raw in env_raw.decode().splitlines(keepends=True))
    if not candidate.endswith('\n'):
        candidate += '\n'
    candidate += TOKEN_ENV + '=' + issued['token'] + '\n'
    save('before-main-env.private', env_raw, exclusive=False)
    save('candidate-env.private', candidate.encode(), exclusive=False)
    compose_env = dict(os.environ, MERV_TS_IMAGE=image)
    up = ['docker', 'compose', '-f', 'compose.yml', 'up', '-d', '--force-recreate']
    atomic(ENV, candidate.encode())
    try:
        # The image's own render refuses a bad env before Main is recreated on it.
        run(['docker', 'compose', '-f', 'compose.yml', 'run', '--rm', '--no-deps', '-T', '--entrypoint', 'node', 'control',
             '/app/deploy/render-config.mjs', '/tmp/pi-connect-render.json'], env=compose_env, cwd=directory, timeout=120)
        run(up, env=compose_env, cwd=directory, timeout=180)
        healthy(MAIN, 60, 4)
        state = inspect(MAIN)
        assert state['Image'] == image
        actual = dict(item.split('=', 1) for item in state['Config']['Env'])
        assert actual.get(TOKEN_ENV) and any(c['projectId'] == PROJECT for c in json.loads(actual['MERV_SANDBOXES_CONNECTIONS']))
        probe = json.loads(run(['docker', 'exec', '-e', 'MERV_CONNECT_TOKEN_ENV=' + TOKEN_ENV, '-e', 'MERV_CONNECT_NAMESPACE=' + NAMESPACE,
                                MAIN, 'node', '--input-type=module', '-e', MAIN_PROBE]))
        assert probe == {'me': 200, 'role': 'consumer', 'namespace': NAMESPACE, 'launch': 404}, ('grant_probe_failed', probe)
    except BaseException:
        atomic(ENV, env_raw)
        run(up, env=compose_env, cwd=directory, timeout=180)
        raise
    ready = [l for l in run(['docker', 'logs', MAIN], timeout=60).decode(errors='replace').splitlines() if '"status":"ready"' in l]
    plugins = json.loads(ready[-1])['plugins'] if ready else []
    receipt = {'phase': 'main-done', 'projectId': PROJECT, 'connections': len(connections), 'image': image,
               'plugins': '%d/%d' % (sum(p['state'] == 'active' for p in plugins), len(plugins)),
               'envSha256Before': sha(env_raw), 'envSha256After': sha(ENV.read_bytes()), 'at': now()}
    record('main.receipt.json', receipt)
    print(json.dumps(receipt))


if __name__ == '__main__':
    assert os.geteuid() == 0
    os.umask(0o077)
    with exclusive():
        {'sandboxes': sandboxes, 'main': main_phase}[PHASE]()
