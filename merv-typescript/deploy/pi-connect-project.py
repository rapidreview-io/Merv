"""Connect one Merv project to Sandboxes, and set up the Pi host project that rents every Pi machine.

Run on the production host as root, in a quiet window, one phase after the other:
  python3 pi-connect-project.py sandboxes <projectId> [--rehome]
  python3 pi-connect-project.py main <projectId> [--rehome]
  python3 pi-connect-project.py ml --ceiling 10000
(these two also run as `python3 - <phase> <projectId> < pi-connect-project.py`; `large` reads its
bridge from stdin and `machines` finds the renderer beside this file, so both run from a file). The
first phase creates the namespace and a 30-day consumer grant, scopes cloudflare-fleet to every
merv-pi-* namespace, allowlists the grant and recreates Sandboxes control and pipelines-worker. The
second adds the connection and the grant variable to Main's env and recreates Main. Each recreate
stops live work, so both phases refuse unless Main and Sandboxes are drained. --rehome moves a
project off the shared fleet-cloudflare-canary namespace.

The Pi host is set up once, by these phases around the two above run for <hostId>:
  python3 pi-connect-project.py host
  python3 pi-connect-project.py large <hostId> --release <standard rt1_> --application <uuid> < bridge.json
  python3 pi-connect-project.py machines <hostId>
`host` creates the host project in Main's database with its reader key, and no member. `large` adds the
cloudflare-fleet-large provider (the Large Cloudflare app, whose bridge_url and bridge_token come as JSON
on stdin, with a cloudflare_api_token that defaults to Standard's), its copy of the Standard release, and
the host namespace's limits, then recreates Sandboxes. `machines` writes the host, the machine catalog and the host's Fleet
limit into Main's env and dry-runs both the running image's render and this directory's, without
recreating Main: the release that reads them does. Run it from that release's deploy directory.
Both refuse unless Main and its env still name that Standard release and both apps run its image.
Every phase refuses while a hosted-image run is open, and holds that pipeline's host lock.
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
import urllib.request
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

if not __debug__:
    sys.exit('every guard here is an assert: run without -O')
_, PHASE, PROJECT, *FLAGS = sys.argv + [''] * (3 - len(sys.argv))
if PHASE == 'ml':
    PROJECT, FLAGS = '', [PROJECT, *FLAGS] if PROJECT else FLAGS
REHOME = FLAGS == ['--rehome']
OPTIONS = dict(zip(FLAGS[::2], FLAGS[1::2]))
assert (PHASE in ('sandboxes', 'main') and FLAGS in ([], ['--rehome'])
        or PHASE == 'host' and PROJECT == '' and not FLAGS
        or PHASE == 'ml' and PROJECT == '' and len(FLAGS) == 2 and list(OPTIONS) == ['--ceiling']
        and re.fullmatch(r'[1-9][0-9]*', OPTIONS['--ceiling'])
        or PHASE == 'large' and len(FLAGS) == 4 and sorted(OPTIONS) == ['--application', '--release']
        or PHASE == 'machines' and not FLAGS), __doc__
assert PHASE in ('host', 'ml') or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}', PROJECT), 'invalid_project_id'
# The host phase has no project yet; '_host' can never be a project id.
HOST_ROOT = Path('/var/lib/merv-fleet-pilot/pi-connect/_host')
ROOT = HOST_ROOT if PHASE == 'host' else HOST_ROOT.parent / ('_ml' if PHASE == 'ml' else PROJECT)
ENV = Path('/etc/merv/typescript.env')
HOSTED = Path('/var/lib/merv-fleet-pilot/hosted-release')  # deploy/hosted-release-vm.py's lock and open-run marker
MAIN, CONTROL, PIPELINE = 'merv-typescript-control-1', 'sandboxes-control-1', 'sandboxes-pipelines-worker-1'
SUFFIX = hashlib.sha256(PROJECT.encode()).hexdigest()[:20]
NAMESPACE = 'merv-ml' if PHASE == 'ml' else 'merv-pi-' + SUFFIX
TOKEN_ENV = 'MERV_SANDBOXES_ML_TOKEN' if PHASE == 'ml' else 'MERV_PI_PROJECT_' + SUFFIX.upper()
CANARY, PROVIDER = 'fleet-cloudflare-canary', 'cloudflare-fleet'
# Merv's Sandboxes account and the member every merv-pi-* namespace belongs to.
ACCOUNT, MEMBER = 'acct_c330sof3z6zju9zw', 'member_w6rb4wzgs4revzh7'
# The Large Pi machine: the second Cloudflare app (wrangler env large) and its bridge credential variable.
LARGE, LARGE_CREDENTIAL_ENV, LARGE_SHAPE = 'cloudflare-fleet-large', 'FLEET_CLOUDFLARE_BRIDGE_LARGE', 'standard-3'
# standard-3's hourly price in merv_sandboxes/providers/cloudflare.py: a lower cap on the host refuses Large.
LARGE_RATE = Decimal('0.220032')
# Every Pi machine runs in the host namespace: at most 50 at once, a day each, none dearer than Large.
HOST_LIMIT_ID = 'pi-host-' + SUFFIX
HOST_LIMIT = {'scope': 'namespace', 'target': NAMESPACE, 'max_concurrent': 50, 'max_lifetime_seconds': 86400,
              'max_hourly_price': {'currency': 'USD', 'amount': '0.23'}}

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

SBX_ML = r'''import asyncio,hashlib,json,sys
from decimal import Decimal
from urllib.parse import urlsplit
from sqlalchemy import func,select
from merv_sandboxes.billing import Policy
from merv_sandboxes.config import Settings
from merv_sandboxes.db.schema import api_tokens,infra_members,infra_namespaces,users
from merv_sandboxes.resource_limits import ResourceLimit,ResourceLimitService
from merv_sandboxes.runtime import Container
from merv_sandboxes.storage.models import ObjectUploadRequest
async def main():
    ceiling=Decimal(sys.stdin.read())
    c=Container(Settings.load())
    try:
        assert c.settings.hatchet_token, 'workflows_not_configured'
        async with c.db.connect() as conn:
            assert not await conn.scalar(select(infra_namespaces.c.name).where(infra_namespaces.c.name=='merv-ml')), 'ml_namespace_exists'
            assert not await conn.scalar(select(users.c.id).where(users.c.namespace=='merv-ml')), 'ml_user_exists'
            assert not await conn.scalar(select(api_tokens.c.id).where(api_tokens.c.namespace=='merv-ml')), 'ml_grant_exists'
        ns=await c.accounts.ensure_native_namespace('merv-ml')
        account,member=ns['account_id'],ns['default_member_id']
        async with c.db.connect() as conn:
            assert await conn.scalar(select(func.count()).select_from(infra_members).where(infra_members.c.account_id==account))==1, 'ml_account_not_fresh'
        billing=c.registry.billing
        await billing.set_policy(account,'merv-ml-monthly',Policy(scope='account',target=account,window='month',cap=ceiling))
        await billing.set_policy(account,'merv-ml-project',Policy(scope='member_default',target=account,window='month',cap=Decimal('50')))
        await billing.set_policy(account,'native-monthly:merv-ml',Policy(scope='namespace',target='merv-ml',window='month',cap=ceiling))
        await ResourceLimitService(c.db,c.clock).set(account,'merv-ml-machines',ResourceLimit(scope='account',target=account,max_concurrent=20,max_lifetime_seconds=86400))
        issued=await c.tokens.create(namespace='merv-ml',role='consumer',account_id=account,member_id=member,application_id='merv-ml',open_subjects=True,label='Merv ML')
        origin=None
        if c.objects.enabled:
            probe=await c.objects.begin_upload(namespace='merv-ml',request=ObjectUploadRequest(name='ml-origin-probe',sha256=hashlib.sha256(b'x').hexdigest(),size_bytes=1))
            try:
                url=urlsplit(probe.parts[0].url)
                assert url.scheme=='https' and url.netloc, 'ml_storage_origin_invalid'
                origin=url.scheme+'://'+url.netloc
            finally:
                await c.objects.delete(namespace='merv-ml',object_id=probe.object.id)
        print(json.dumps({'accountId':account,'memberId':member,'tokenId':issued.token_id,'token':issued.secret,'storageOrigin':origin}))
    finally:
        await c.stop()
asyncio.run(main())'''

SBX_ML_RESOLVE = r'''import asyncio,json
from merv_sandboxes.config import Settings
from merv_sandboxes.runtime import Container
async def main():
    c=Container(Settings.load())
    try:
        print(json.dumps({name:(await c.providers.resolve('merv-ml',name)).source for name in ('lambda','thunder_compute')}))
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

# Release IDs as Sandboxes derives them from catalog entries.
SBX_RELEASES = r'''import json,sys
from merv_sandboxes.runtimes.releases import RuntimeRelease
print(json.dumps([RuntimeRelease(**{**r,'arguments':tuple(r.get('arguments',()))}).release_id for r in json.load(sys.stdin)]))'''

# The account's resource limits, after setting one when asked; with `check`, also how the namespace
# resolves that provider, its offers, and the release IDs the running control loaded.
SBX_LIMITS = r'''import asyncio,json,sys
from merv_sandboxes.config import Settings
from merv_sandboxes.runtime import Container
from merv_sandboxes.resource_limits import ResourceLimit,ResourceLimitService
async def main():
    v=json.load(sys.stdin)
    c=Container(Settings.load())
    try:
        limits=ResourceLimitService(c.db,c.clock)
        if v.get('set'):
            await limits.set(v['account'],v['id'],ResourceLimit(**v['set']))
        out={'limits':json.loads(json.dumps(await limits.list(v['account']),default=str))}
        if v.get('check'):
            out['resolved']=(await c.providers.resolve(v['namespace'],v['check'])).source
            out['offers']=[o.offer_id for o in await c.providers.offers(v['namespace'],provider=v['check'],refresh=True)]
            out['releases']=[r.release_id for r in c.settings.runtime_releases]
        print(json.dumps(out))
    finally:
        await c.stop()
asyncio.run(main())'''

# The image each named Cloudflare app runs, read natively through its Sandboxes provider.
SBX_IMAGES = r'''import asyncio,json,sys
from merv_sandboxes.config import Settings
from merv_sandboxes.runtime import Container
async def main():
    c=Container(Settings.load())
    try:
        out={}
        for name in json.load(sys.stdin):
            d=c.providers._host[name].driver
            a,_=await d._native_result(f'/accounts/{d._account_id}/containers/applications/{d._application_id}')
            out[name]=(a.get('configuration') or {}).get('image')
        print(json.dumps(out))
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

# In Main's database: the Pi host project, with a reader key that only rents machines. Its setup operator
# cannot retire itself, so a second one that lapses in five minutes, and is never kept, retires it.
HOST_CREATE = r'''import { PostgresState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
const state=await PostgresState.open({connectionString:process.env.MERV_DB_URL,schema:process.env.MERV_TS_DB_SCHEMA??'merv_ts'});
try{
const scope=new ProjectScope(state);
await scope.initialize();
const setup=await scope.bootstrap({projectName:'Pi host',actorName:'Pi host setup'});
const as=(i)=>({actorId:i.actor.id,projectId:setup.project.id,credentialId:i.credential.id});
const host=await scope.issueActor(as(setup),{name:'Pi host',role:'reader',expiresAt:null});
const closer=await scope.issueActor(as(setup),{name:'Pi host setup',role:'operator',expiresAt:new Date(Date.now()+300000).toISOString()});
await scope.revokeActor(as(closer),setup.actor.id);
const actor=await scope.authenticate(host.token);
console.log(JSON.stringify({projectId:actor.projectId,actorId:actor.id,role:actor.role,credentialId:host.credential.id,token:host.token}));
}finally{await state.close();}'''


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def exclusive():
    """The hosted-image pipeline's host lock, for the whole phase: both edit the env or the catalog, or work in Main."""
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
    assert main['fleet'] == main['commands'] == 0 and (PHASE == 'ml' or main['project'] == 1), ('main_not_drained_or_project_unknown', main)
    return sbx['namespaces']


def live_release(release, digest=None, apps=()):
    """Main and its env file name `release` as Standard's (the legacy key), and each of `apps` runs the
    image `digest` pins, as its provider reads it: another release in between would leave them stale."""
    main = dict(item.split('=', 1) for item in inspect(MAIN)['Config']['Env'])
    named = [env.get('MERV_FLEET_RUNTIME_RELEASE_ID') for env in (env_values(ENV.read_bytes()), main)]
    assert named == [release, release], ('release_not_live', named)
    if apps:
        images = json.loads(run(['docker', 'exec', '-i', CONTROL, 'python', '-c', SBX_IMAGES], json.dumps(apps).encode()))
        assert all(str(images[app]).endswith('@' + digest) for app in apps), ('image_not_live', images)


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


def sandbox_catalog(prefix):
    """The Compose catalog Sandboxes control and pipelines-worker both run, backed up, and their one image."""
    labels = inspect(CONTROL)['Config']['Labels']
    catalog_path, project = Path(labels['com.docker.compose.project.config_files']), labels['com.docker.compose.project']
    assert catalog_path.is_file(), ('catalog_unexpected', str(catalog_path))
    catalog_raw = catalog_path.read_bytes()
    save(prefix + 'before-catalog.private.json', catalog_raw)
    image = inspect(CONTROL)['Image']
    for name in (CONTROL, PIPELINE):
        state = inspect(name)
        assert state['Image'] == image and state['State']['Running'], ('sandbox_image_drift', name)
    return catalog_path, project, catalog_raw, image


def apply_catalog(prefix, catalog_path, project, catalog_raw, image, catalog, keys, verify):
    """Recreate both services on `catalog`, prove they run its `keys`, then verify(); else restore both."""
    candidate = (json.dumps(catalog, indent=2) + '\n').encode()
    save(prefix + 'candidate-catalog.private.json', candidate)
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
            for key in keys:
                assert json.loads(actual[key]) == json.loads(expected[key]), ('env_mismatch', name, key)
        return verify()
    except BaseException:
        atomic(catalog_path, catalog_raw, mode)
        run(up, timeout=180)
        raise


def sandboxes():
    assert not ROOT.exists(), 'pi_connect_root_exists'
    ROOT.mkdir(mode=0o700, parents=True)
    env_raw = ENV.read_bytes()
    save('before-env.private', env_raw)
    catalog_path, project, catalog_raw, image = sandbox_catalog('')
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

    def verify():
        check = json.loads(run(['docker', 'exec', '-i', CONTROL, 'python', '-c', SBX_RESOLVE], json.dumps(names + [CANARY]).encode()))
        assert all(v == 'host' for v in check['resolved'].values()), ('resolve_failed', check['resolved'])
        assert issued['tokenId'] in check['grantAllowed'], 'grant_not_allowlisted'
    apply_catalog('', catalog_path, project, catalog_raw, image, catalog,
                  ('SANDBOXES_PROVIDERS', 'SANDBOXES_RUNTIME_LAUNCH_GRANTS'), verify)
    expires = datetime.fromisoformat(issued['expiresAt'])
    receipt = {'phase': 'sandboxes-done', 'projectId': PROJECT, 'namespace': NAMESPACE, 'tokenId': issued['tokenId'],
               'expiresAt': issued['expiresAt'], 'renewBy': (expires - timedelta(days=7)).isoformat(),
               'fleetNamespaces': len(fleet['namespaces']), 'image': image, 'catalogSha256Before': sha(catalog_raw),
               'catalogSha256After': sha(catalog_path.read_bytes()), 'at': now()}
    record('sandboxes.receipt.json', receipt)
    print(json.dumps(receipt))


def ml():
    assert not ROOT.exists(), 'ml_setup_already_started'
    env_raw = ENV.read_bytes()
    values = env_values(env_raw)
    assert TOKEN_ENV not in values, 'ml_grant_already_configured'
    ROOT.mkdir(mode=0o700, parents=True)
    save('before-env.private', env_raw)
    drains()
    catalog_path, project, catalog_raw, image = sandbox_catalog('')
    catalog = json.loads(catalog_raw)
    services = [catalog['services'][name]['environment'] for name in ('control', 'pipelines-worker')]
    for settings in services:
        providers = json.loads(settings['SANDBOXES_PROVIDERS'])
        for name in ('lambda', 'thunder_compute'):
            [provider] = [p for p in providers if p['name'] == name]
            assert isinstance(provider.get('namespaces'), list), ('ml_provider_not_explicit', name)
            assert NAMESPACE not in provider['namespaces'], ('ml_provider_already_configured', name)
            provider['namespaces'].append(NAMESPACE)
        settings['SANDBOXES_PROVIDERS'] = json.dumps(providers)
    issued = json.loads(run(['docker', 'exec', '-i', CONTROL, 'python', '-c', SBX_ML],
                            OPTIONS['--ceiling'].encode()))

    def verify():
        resolved = json.loads(run(['docker', 'exec', '-i', CONTROL, 'python', '-c', SBX_ML_RESOLVE]))
        assert resolved == {'lambda': 'host', 'thunder_compute': 'host'}, ('ml_provider_unavailable', resolved)
    apply_catalog('', catalog_path, project, catalog_raw, image, catalog, ('SANDBOXES_PROVIDERS',), verify)
    put = {'MERV_SANDBOXES_ML_NAMESPACE': NAMESPACE, TOKEN_ENV: issued['token'],
           'MERV_SANDBOXES_ML_SINCE': now()}
    if issued['storageOrigin']:
        put['MERV_SANDBOXES_ML_STORAGE_ORIGIN'] = issued['storageOrigin']
    candidate = ('\n'.join(env_raw.decode().splitlines() + [key + '=' + value for key, value in put.items()]) + '\n').encode()
    save('candidate-env.private', candidate)
    state = inspect(MAIN)
    compose_env = dict(os.environ, MERV_TS_IMAGE=state['Image'])
    atomic(ENV, candidate)
    try:
        dry_render(compose_env, state['Config']['Labels']['com.docker.compose.project.working_dir'])
    except BaseException:
        atomic(ENV, env_raw)
        raise
    receipt = {'phase': 'ml-done', 'namespace': NAMESPACE, 'accountId': issued['accountId'],
               'memberId': issued['memberId'], 'tokenId': issued['tokenId'],
               'ceilingUsd': OPTIONS['--ceiling'], 'objectStore': bool(issued['storageOrigin']),
               'image': image, 'catalogSha256Before': sha(catalog_raw),
               'catalogSha256After': sha(catalog_path.read_bytes()), 'envSha256Before': sha(env_raw),
               'envSha256After': sha(candidate), 'at': now()}
    record('ml.receipt.json', receipt)
    print(json.dumps(receipt))


def dry_render(compose_env, directory, mounts=()):
    """Main's image renders the env file in a throwaway container; `mounts` put another renderer in place."""
    run(['docker', 'compose', '-f', 'compose.yml', 'run', '--rm', '--no-deps', '-T', *mounts, '--entrypoint', 'node',
         'control', '/app/deploy/render-config.mjs', '/tmp/pi-connect-render.json'], env=compose_env, cwd=directory,
        timeout=120)


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
        dry_render(compose_env, directory)
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


def host():
    assert not ROOT.exists(), 'pi_host_root_exists'
    assert 'MERV_PI_HOST_PROJECT_ID' not in env_values(ENV.read_bytes()), 'pi_host_configured'
    state = inspect(MAIN)
    assert state['State']['Running'], 'main_not_running'
    ROOT.mkdir(mode=0o700, parents=True)
    record('host.intent.json', {'image': state['Image'], 'at': now()})
    created_raw = run(['docker', 'exec', '-i', '-w', '/app', MAIN, 'node', '--input-type=module', '-e', HOST_CREATE])
    save('host.private.json', created_raw)
    created = json.loads(created_raw)
    assert created['role'] == 'reader' and re.fullmatch(r'[A-Za-z0-9_-]{1,200}', created['projectId']), 'host_unexpected'
    receipt = {'phase': 'host-done', 'projectId': created['projectId'], 'actorId': created['actorId'],
               'credentialId': created['credentialId'], 'image': state['Image'], 'at': now()}
    record('host.receipt.json', receipt)
    print(json.dumps(receipt))


def large():
    assert json.loads((HOST_ROOT / 'host.receipt.json').read_bytes())['projectId'] == PROJECT, 'not_the_pi_host'
    assert (ROOT / 'main.receipt.json').is_file() and not (ROOT / 'large.receipt.json').exists(), 'phase_order'
    release, application = OPTIONS['--release'], OPTIONS['--application']
    assert re.fullmatch(r'rt1_[0-9a-f]{64}', release), 'invalid_release'
    assert re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', application), 'invalid_application'
    live_release(release)
    # The Large bridge's URL and token, and a native verification token that covers the Large app:
    # unless given, Standard's, which must then cover both apps.
    raw = sys.stdin.read(16385)
    assert len(raw) <= 16384, 'credential_too_large'
    credential = json.loads(raw)
    assert set(credential) - {'cloudflare_api_token'} == {'bridge_url', 'bridge_token'} and all(
        isinstance(v, str) and v and v.strip() == v for v in credential.values()), 'credential_unexpected'
    assert re.fullmatch(r'https://[a-z0-9.-]+', credential['bridge_url']), 'bridge_url_unexpected'
    # Cloudflare refuses Python's default User-Agent (error 1010) before the Worker sees the call.
    health = urllib.request.Request(credential['bridge_url'] + '/health',
                                    headers={'authorization': 'Bearer ' + credential['bridge_token'],
                                             'user-agent': 'merv-pi-connect/1'})
    with urllib.request.urlopen(health, timeout=15) as response:
        assert json.load(response).get('shape') == LARGE_SHAPE, 'bridge_not_large'
    drains()
    limits = json.loads(run(['docker', 'exec', '-i', CONTROL, 'python', '-c', SBX_LIMITS],
                            json.dumps({'account': ACCOUNT}).encode()))['limits']
    # Limits and provider controls name the plugin, `cloudflare`, never the app: every cap on the host
    # namespace's Cloudflare machines binds Large too, so one below Large's price makes Large unrentable.
    caps = [l for l in limits if l['id'] != HOST_LIMIT_ID and l['provider'] in (None, 'cloudflare')
            and l['source'] in (None, 'host')
            and (l['scope'], l['target']) in {('account', ACCOUNT), ('member', MEMBER), ('namespace', NAMESPACE)}]
    cheap = [l['id'] for l in caps if l['max_hourly_price'] and (
        l['max_hourly_price']['currency'] != 'USD' or Decimal(l['max_hourly_price']['amount']) < LARGE_RATE)]
    assert not cheap, ('price_cap_refuses_large', cheap)
    catalog_path, project, catalog_raw, image = sandbox_catalog('large-')
    catalog = json.loads(catalog_raw)
    services = [catalog['services'][s]['environment'] for s in ('control', 'pipelines-worker')]
    releases = json.loads(services[0]['SANDBOXES_RUNTIME_RELEASES'])
    [fleet] = [p for p in json.loads(services[0]['SANDBOXES_PROVIDERS']) if p['name'] == PROVIDER]
    # Server-side and never printed: the token Standard's provider verifies its app with.
    credential.setdefault('cloudflare_api_token', json.loads(
        services[0][fleet['credential'].removeprefix('env:')])['cloudflare_api_token'])
    ids = json.loads(run(['docker', 'exec', '-i', CONTROL, 'python', '-c', SBX_RELEASES], json.dumps(releases).encode()))
    standard = [r for r, i in zip(releases, ids) if i == release and r['provider'] == PROVIDER]
    assert len(standard) == 1, 'standard_release_not_in_catalog'
    # The same image, executable and arguments, sold by the Large app: only the provider differs.
    copy = dict(standard[0], provider=LARGE)
    [large_id] = json.loads(run(['docker', 'exec', '-i', CONTROL, 'python', '-c', SBX_RELEASES], json.dumps([copy]).encode()))
    assert large_id not in ids, 'large_release_exists'
    for settings in services:
        assert json.loads(settings['SANDBOXES_RUNTIME_RELEASES']) == releases, 'release_catalogs_differ'
        assert LARGE_CREDENTIAL_ENV not in settings, 'large_credential_exists'
        providers = json.loads(settings['SANDBOXES_PROVIDERS'])
        assert all(p['name'] != LARGE for p in providers), 'large_provider_exists'
        [fleet] = [p for p in providers if p['name'] == PROVIDER]
        providers.append({'name': LARGE, 'plugin': 'cloudflare', 'credential': 'env:' + LARGE_CREDENTIAL_ENV,
                          'access': 'tunnel', 'namespaces': [NAMESPACE],
                          'settings': {'shapes': LARGE_SHAPE, 'account_id': fleet['settings']['account_id'],
                                       'application_id': application}})
        settings['SANDBOXES_PROVIDERS'] = json.dumps(providers)
        settings['SANDBOXES_RUNTIME_RELEASES'] = json.dumps(releases + [copy])
        settings[LARGE_CREDENTIAL_ENV] = json.dumps(credential)

    def verify():
        check = json.loads(run(['docker', 'exec', '-i', CONTROL, 'python', '-c', SBX_LIMITS],
                               json.dumps({'account': ACCOUNT, 'namespace': NAMESPACE, 'check': LARGE}).encode()))
        assert check['resolved'] == 'host' and LARGE_SHAPE + ':cloudflare' in check['offers'], 'large_not_offered'
        assert {release, large_id} <= set(check['releases']), 'release_not_loaded'
        live_release(release, standard[0]['image_digest'], [PROVIDER, LARGE])
        # Last, so a failure before it leaves the limits as they were.
        after = json.loads(run(['docker', 'exec', '-i', CONTROL, 'python', '-c', SBX_LIMITS], json.dumps(
            {'account': ACCOUNT, 'id': HOST_LIMIT_ID, 'set': HOST_LIMIT}).encode()))['limits']
        assert [l['max_concurrent'] for l in after if l['id'] == HOST_LIMIT_ID] == [HOST_LIMIT['max_concurrent']]
    apply_catalog('large-', catalog_path, project, catalog_raw, image, catalog,
                  ('SANDBOXES_PROVIDERS', 'SANDBOXES_RUNTIME_RELEASES', LARGE_CREDENTIAL_ENV), verify)
    receipt = {'phase': 'large-done', 'projectId': PROJECT, 'namespace': NAMESPACE, 'provider': LARGE,
               'applicationId': application, 'standardReleaseId': release, 'largeReleaseId': large_id,
               'releaseDigest': standard[0]['image_digest'],
               'hostLimit': HOST_LIMIT_ID,
               # The most machines every concurrency cap on the host namespace lets it hold at once.
               'hostConcurrency': min([l['max_concurrent'] for l in caps if l['max_concurrent'] is not None]
                                      + [HOST_LIMIT['max_concurrent']]),
               'image': image, 'catalogSha256Before': sha(catalog_raw),
               'catalogSha256After': sha(catalog_path.read_bytes()), 'at': now()}
    record('large.receipt.json', receipt)
    print(json.dumps(receipt))


def machines():
    host = json.loads((HOST_ROOT / 'host.private.json').read_bytes())
    large = json.loads((ROOT / 'large.receipt.json').read_bytes())
    assert host['projectId'] == PROJECT == large['projectId'], 'not_the_pi_host'
    assert not (ROOT / 'machines.receipt.json').exists(), 'phase_order'
    here = Path(__file__).resolve().parent
    renderer = [here / name for name in ('render-config.mjs', 'schema.mjs')]
    assert all(path.is_file() for path in renderer), 'run_from_the_release_deploy_directory'
    state = inspect(MAIN)
    image, directory = state['Image'], state['Config']['Labels']['com.docker.compose.project.working_dir']
    env_raw = ENV.read_bytes()
    values = env_values(env_raw)
    connected = [c['projectId'] for c in json.loads(values['MERV_SANDBOXES_CONNECTIONS'])]
    assert values.get('MERV_PI_ENABLED') == 'true' and PROJECT in connected, 'host_not_connected'
    live_release(large['standardReleaseId'], large['releaseDigest'], [PROVIDER, LARGE])
    lease = int(values['MERV_FLEET_RUNTIME_LEASE_SECONDS'])
    catalog = [
        {'key': 'standard', 'label': 'Standard', 'slots': 3, 'provider': values['MERV_FLEET_RUNTIME_PROVIDER'],
         'offerId': values['MERV_FLEET_RUNTIME_OFFER_ID'], 'releaseId': large['standardReleaseId'], 'leaseSeconds': lease},
        {'key': 'large', 'label': 'Large', 'slots': 4, 'agent': True, 'provider': LARGE,
         'offerId': LARGE_SHAPE + ':cloudflare', 'releaseId': large['largeReleaseId'], 'leaseSeconds': lease},
    ]
    compact = lambda value: "'" + json.dumps(value, separators=(',', ':')) + "'"
    # The MERV_FLEET_RUNTIME_* lines stay, so the image this replaces still renders if it comes back.
    put = {'MERV_FLEET_RUNTIMES': compact(catalog), 'MERV_FLEET_PROJECT_LIMITS': compact({PROJECT: 50}),
           # A host moves to a fresh machine 15 minutes before its allocation's deadline.
           'MERV_FLEET_ALLOCATION_TIMEOUT_SECONDS': '86400',
           'MERV_PI_HOST_PROJECT_ID': PROJECT, 'MERV_PI_HOST_KEY_ENV': 'MERV_PI_HOST_KEY',
           'MERV_PI_HOST_KEY': host['token'], 'MERV_PI_RUNTIME_KEY': 'project', 'MERV_PI_AGENT_MOVES': 'true'}
    kept = [line for line in env_raw.decode().splitlines() if line.split('=', 1)[0] not in put]
    candidate = ('\n'.join(kept + [key + '=' + value for key, value in put.items()]) + '\n').encode()
    save('before-machines-env.private', env_raw)
    save('candidate-machines-env.private', candidate)
    compose_env = dict(os.environ, MERV_TS_IMAGE=image)
    atomic(ENV, candidate)
    try:
        # The running image still renders it, and so does this release's renderer mounted over it.
        dry_render(compose_env, directory)
        dry_render(compose_env, directory, [flag for path in renderer
                                            for flag in ('-v', '%s:/app/deploy/%s:ro' % (path, path.name))])
    except BaseException:
        atomic(ENV, env_raw)
        raise
    receipt = {'phase': 'machines-done', 'projectId': PROJECT, 'machines': [m['key'] for m in catalog],
               'image': image, 'envSha256Before': sha(env_raw), 'envSha256After': sha(ENV.read_bytes()), 'at': now()}
    record('machines.receipt.json', receipt)
    print(json.dumps(receipt))


if __name__ == '__main__':
    assert os.geteuid() == 0
    os.umask(0o077)
    with exclusive():
        {'host': host, 'sandboxes': sandboxes, 'main': main_phase, 'large': large, 'machines': machines, 'ml': ml}[PHASE]()
