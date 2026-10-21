#!/usr/bin/env python3
"""Parent-operated, forward-only two-host handoff. stdin is a JSON request, never secrets.
Install alongside the reviewed hosted-release-vm.py. Execute reserve on BOTH hosts, then
source relinquish, privately transfer its receipt, and destination enable. Every invocation
reacquires the maintenance/hosted locks; durable active markers fence the gaps and crashes.
"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

spec = importlib.util.spec_from_file_location('hosted_vm', Path(__file__).parents[1] / 'hosted-release-vm.py')
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)
ROOT = Path('/var/lib/merv-fleet-pilot/staging-isolation')
NAME = 'staging-isolation-handoff'
APPS = vm.STAGING_APPS


def validate(plan):
    vm.need(plan.get('version') == 1 and plan.get('apps') == APPS, 'exact two staging apps required')
    vm.need(plan['source']['database'] != plan['destination']['database'] and
            plan['destination']['database']['database'] == 'sandboxes_staging', 'database isolation required')
    vm.need(plan.get('historySha256') and plan.get('restoreRehearsal') and plan.get('relay'), 'preservation evidence missing')
    vm.need(plan['publicOrigin'].startswith('https://') and plan['publicOrigin'] != 'https://sandboxes.rapidreview.io', 'staging origin required')


def env_target(raw):
    """Only designated aliases and their catalog entries leave production; all other bytes survive."""
    providers = json.loads(vm.env_value(raw, 'SANDBOXES_PROVIDERS'))
    catalog = json.loads(vm.env_value(raw, vm.CATALOG))
    vm.need({p['name'] for p in providers} >= set(APPS), 'source lacks designated apps')
    vm.need(all(p['settings']['application_id'] == APPS[p['name']] for p in providers if p['name'] in APPS), 'source app identity mismatch')
    vm.need(all(p.get('namespaces') == ['merv-stg-pi-da7c4bfa4d89860eee24'] and not p.get('namespace_prefixes') for p in providers if p['name'] in APPS), 'source namespace allowlist drift')
    raw = vm.with_env(raw, 'SANDBOXES_PROVIDERS', json.dumps([p for p in providers if p['name'] not in APPS], separators=(',', ':')))
    return vm.with_env(raw, vm.CATALOG, json.dumps([e for e in catalog if e['provider'] not in APPS], separators=(',', ':')))


def stable_identity(expected, main=True):
    vm.need(all(vm.inspect(c)['Image'] == image for c, image in expected['images'].items()), 'reader image drift')
    if main:
        actual = vm.isolated_read("SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,current_user AS role,inet_server_addr()::text AS address,inet_server_port() AS port", url='SANDBOXES_DATABASE_URL')
        vm.need(actual == expected['database'], 'database identity drift')


def operator_module(filename, mode, key):
    effective = vm.env_of(vm.MAIN)
    effective[key] = mode
    networks=list(vm.inspect(vm.MAIN).get('NetworkSettings',{}).get('Networks',{})) or ['sandboxes_default']
    return json.loads(vm.run(['docker','run','--rm','-i',*[part for n in networks for part in ('--network',n)],
                             '-w','/app',*[part for k in effective for part in ('-e',k)],
                             '--entrypoint','node',vm.inspect(vm.MAIN)['Image'],'--input-type=module','-'],
                            payload=Path(__file__).with_name(filename).read_bytes(),
                            env=dict(os.environ, **effective)))


def source_fence(apply=False):
    result = operator_module('source-fence.mjs','apply' if apply else 'inspect','MERV_SOURCE_FENCE')
    vm.need(not result.get('error'), 'source admission fence failed')
    return result


def pi_admission(action):
    result = operator_module('pi-admission.mjs',action,'MERV_PI_HANDOFF')
    vm.need(not result.get('error'), 'Pi admission barrier failed')
    return result


def pi_drained(limit=900):
    deadline=time.monotonic()+limit
    while True:
        state=pi_admission('inspect')
        vm.need(state['active'], 'Pi admission barrier lost')
        if state['commands']==state['hosts']==state['allocations']==0:
            return state
        vm.need(time.monotonic()<deadline, 'Pi drain timed out; barrier retained, no work cancelled; resume or restore-admission')
        time.sleep(5)


def execute(action, role, plan, peer=None):
    validate(plan)
    vm.need(role in ('source', 'destination'), 'invalid handoff role')
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    intent = {'plan': plan, 'role': role}
    previous = vm.read(ROOT / 'intent.json')
    vm.need(previous is None or previous == intent, 'handoff intent changed')
    vm.HOME.mkdir(mode=0o700, parents=True, exist_ok=True)
    with vm.MAINTENANCE.open('a') as maintenance, (vm.HOME / 'lock').open('a') as lock:
        vm.need(vm.locked(maintenance, 60) and vm.locked(lock, 60), 'deployment owner busy')
        vm.need(not vm.main_release_running() and not vm.RECOVERY_PENDING.exists(), 'release or recovery running')
        vm.need(vm.owner() in ('', NAME), 'another hosted owner holds deployment')
        if action == 'reserve':
            if not previous:
                # Originals always precede the durable ownership marker and every mutation.
                vm.atomic(ROOT / 'shared.original', vm.SHARED.read_bytes())
                vm.atomic(ROOT / 'main.original', vm.ENV.read_bytes())
                vm.atomic(ROOT / 'intent.json', json.dumps(intent).encode())
            if role == 'destination':
                providers = json.loads(vm.env_of(vm.CONTROL)['SANDBOXES_PROVIDERS'])
                vm.need(not any(p.get('enabled', True) for p in providers), 'destination controller already enabled')
            vm.claim(NAME)
            receipt = {'phase': 'reserved', 'role': role, 'planHash': vm.sha(json.dumps(plan, sort_keys=True).encode())}
            vm.atomic(ROOT / 'reserved.json', json.dumps(receipt).encode())
            return receipt
        if action == 'release' and vm.owner() == '' and vm.read(ROOT / 'released.json') == peer:
            return {'released':True,'planHash':peer['planHash']}
        vm.need(previous == intent and vm.owner() == NAME, 'reserve this owner first')
        plan_hash = vm.sha(json.dumps(plan, sort_keys=True).encode())
        if action == 'restore-admission':
            vm.need(role == 'source', 'source admission only')
            receipt=pi_admission('restore')
            vm.atomic(ROOT / 'pi-admission.restored.json', json.dumps(receipt).encode())
            return receipt
        if action == 'relinquish':
            vm.need(role == 'source' and peer == {'phase':'reserved','role':'destination','planHash':plan_hash}, 'destination reservation required')
            stable_identity(plan['source'])
            if not (ROOT / 'source-admission.original.json').exists():
                vm.atomic(ROOT / 'source-admission.original.json', json.dumps(source_fence()).encode())
            vm.need(source_fence(apply=True)['denied'], 'source persistent admission is not fenced')
            vm.atomic(ROOT / 'source-admission.denied.json', json.dumps(source_fence()).encode())
            target = ROOT / 'source.target'
            if not target.exists():
                vm.isolated_census()
                raw = vm.SHARED.read_bytes()
                vm.need(raw == (ROOT / 'shared.original').read_bytes(), 'source env changed after reservation')
                vm.atomic(target, env_target(raw))
                vm.atomic(ROOT / 'source-intent.json', json.dumps({'target':vm.sha(target.read_bytes())}).encode())
            expected_target = env_target((ROOT / 'shared.original').read_bytes())
            vm.need(target.read_bytes() == expected_target, 'source target changed')
            if not (ROOT / 'source-intent.json').exists():
                vm.atomic(ROOT / 'source-intent.json', json.dumps({'target':vm.sha(expected_target)}).encode())
            vm.need(vm.SHARED.read_bytes() in ((ROOT / 'shared.original').read_bytes(), expected_target), 'source file drift')
            vm.need(vm.sha(target.read_bytes()) == vm.read(ROOT / 'source-intent.json')['target'], 'source target changed')
            if not (ROOT / 'pi-admission.original.json').exists():
                original=pi_admission('inspect')
                vm.need(not original['active'], 'unexpected existing Pi barrier')
                vm.atomic(ROOT / 'pi-admission.original.json', json.dumps(original).encode())
            vm.atomic(ROOT / 'pi-admission.intent.json', b'{"active":true}')
            vm.need(pi_admission('apply')['active'], 'Pi barrier missing')
            pi_drained()
            # Existing helper recreates both readers on their exact images. Never rollback on interruption.
            # Wait for current production turns/launches; do not release customer allocations.
            vm.quiet(900, database_reader=vm.reader_read)
            vm.Step(ROOT, {}).sandboxes_file(network_none=True, before_recreate=lambda: pi_drained())[1](target.read_bytes())
            stable_identity(plan['source'])
            for service in (vm.MAIN, vm.CONTROL):
                env = vm.env_of(service)
                vm.need(not set(APPS) & {p['name'] for p in json.loads(env['SANDBOXES_PROVIDERS'])}, 'source still reconciles staging')
                vm.need(not set(APPS) & {e['provider'] for e in json.loads(env[vm.CATALOG])}, 'source still admits staging catalog')
            # The readers no longer admit this work. Recheck complete inventories using ONLY
            # the old two provider descriptors; the probe is read-only and receives settings on stdin.
            providers = [p for p in json.loads(vm.env_value((ROOT / 'shared.original').read_bytes(), 'SANDBOXES_PROVIDERS')) if p['name'] in APPS]
            probe = Path(vm.__file__).with_name('hosted-sandboxes-probe.mjs').read_bytes()
            vm._STAGING_PROBE = ('process.env.SANDBOXES_PROVIDERS=' + json.dumps(json.dumps(providers)) + ';\n').encode() + probe
            try:
                vm.isolated_census()
            finally:
                del vm._STAGING_PROBE
            vm.need(source_fence()['denied'], 'source persistent fence drifted')
            restored=pi_admission('restore')
            vm.need(not restored['active'], 'Pi admission was not restored')
            vm.atomic(ROOT / 'pi-admission.restored.json', json.dumps(restored).encode())
            receipt = {'phase':'source-relinquished','role':'source','planHash':plan_hash,'apps':APPS}
            vm.atomic(ROOT / 'relinquished.json', json.dumps(receipt).encode())
            return receipt
        if action == 'enable':
            vm.need(role == 'destination' and peer == {'phase':'source-relinquished','role':'source','planHash':plan_hash,'apps':APPS}, 'source relinquishment required')
            # Destination Main/controller must first be bootstrapped with providers disabled.
            stable_identity(plan['destination'])
            vm.need(vm.env_of(vm.MAIN).get('MERV_BOOT_MAINTENANCE') == '1', 'destination Main is not fenced')
            vm.atomic(ROOT / 'source-receipt.json', json.dumps(peer).encode())
            target = ROOT / 'destination.target'
            vm.need(target.is_file() and vm.sha(target.read_bytes()) == plan['destination']['targetSha256'], 'reviewed destination target missing')
            target_env = vm.file_env(target.read_bytes())
            original_env = vm.file_env((ROOT / 'shared.original').read_bytes())
            vm.need({k:v for k,v in target_env.items() if k != 'SANDBOXES_PROVIDERS'} == {k:v for k,v in original_env.items() if k != 'SANDBOXES_PROVIDERS'}, 'destination target changed database/vault/origins or other settings')
            expected_providers = [{**p, 'enabled': True} for p in json.loads(original_env['SANDBOXES_PROVIDERS'])]
            providers = json.loads(target_env['SANDBOXES_PROVIDERS'])
            vm.need(providers == expected_providers, 'destination target changed provider identity/scope')
            vm.need({p['name'] for p in providers} == set(APPS), 'destination contains other apps')
            vm.need(all(p['settings']['application_id'] == APPS[p['name']] and p.get('namespaces') and '*' not in p['namespaces'] for p in providers), 'destination app/namespace identity mismatch')
            vm.atomic(ROOT / 'enable-intent.json', json.dumps({'planHash':plan_hash}).encode())
            vm.Step(ROOT, {}).sandboxes_file(network_none=True)[1](target.read_bytes())
            stable_identity(plan['destination'])
            vm.isolated_census()
            receipt = {'phase':'destination-enabled','apps':APPS,'sourceRelinquished':True,
                       'database':plan['destination']['database'],'images':plan['destination']['images'],
                       'publicOrigin':plan['publicOrigin'],'historySha256':plan['historySha256'],
                       'restoreRehearsal':plan['restoreRehearsal'],'relay':plan['relay'],'planHash':plan_hash}
            vm.atomic(ROOT / 'accepted.json', json.dumps(receipt).encode())
            return receipt
        if action == 'release':
            vm.need(peer and peer.get('phase') == 'destination-enabled' and peer.get('planHash') == plan_hash, 'destination receipt required')
            vm.need((ROOT / ('relinquished.json' if role == 'source' else 'accepted.json')).is_file(), 'handoff incomplete')
            vm.atomic(ROOT / 'released.json', json.dumps(peer).encode())
            (vm.HOME / 'active').unlink()
            vm.durable_directory(vm.HOME)
            return {'released':True,'planHash':plan_hash}
        raise RuntimeError('unknown handoff action')


if __name__ == '__main__':
    os.umask(0o077)
    vm.need(os.geteuid() == 0, 'root operator required')
    try:
        request=json.load(sys.stdin)
        print(json.dumps(execute(**request)))
    except Exception:
        # No exception details: subprocess errors can include credentials. Durable intent stays held.
        print(json.dumps({'error':'handoff refused; retain fences and inspect private evidence'}))
        sys.exit(1)
