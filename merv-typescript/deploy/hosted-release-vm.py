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
import shlex
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

MAIN, CONTROL = 'merv-typescript-control-1', 'sandboxes-control-1'
RUNS = Path('/opt/merv-typescript/hosted')
SHARED = Path('/etc/sandboxes/shared.env')
ENV = Path('/etc/merv/typescript.env')
HOME = Path('/var/lib/merv-fleet-pilot/hosted-release')  # lock, the open run's marker, the live pins
MAINTENANCE = Path('/run/lock/merv-maintenance.lock')
RECOVERY_PENDING = Path('/var/lib/merv-recovery/resume.json')
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
# The root launcher creates a private read-only mount before dropping every assignment cap.
REVIEW_MOUNTS = ['--cap-add', 'SYS_ADMIN']
GATES = {  # name: (docker run flags, mount targets, command, expected gate, report lines)
    'linux-pi-gate.py': (['--cap-add', 'SYS_PTRACE', '--tmpfs', '/run/merv-runtime:mode=0700',
                          '--entrypoint', '/usr/bin/python3.11'],
                         ['/opt/merv/runtime/probe.py'], '/opt/merv/runtime/probe.py', 'linux-pi-protected-launch', 2),
    'linux-workflow-gate.py': ([*REVIEW_MOUNTS, '--tmpfs', '/run/merv-runtime:mode=0700', '--entrypoint', '/usr/bin/python3.11'],
                               ['/opt/merv/runtime/probe.py'], '/opt/merv/runtime/probe.py', 'linux-workflow-dispatch', 1),
    'linux-isolation-probe-gate.mjs': (['--entrypoint', '/usr/local/bin/node'],
                                       ['/opt/merv/runner/supervisor.mjs', '/opt/merv/runner/smoke-supervisor.mjs'],
                                       '/opt/merv/runner/smoke-supervisor.mjs', 'linux-isolation-probe-synthetic-ancestry', 1),
    'linux-review-gate.py': ([*REVIEW_MOUNTS, '--tmpfs', '/run/merv-runtime:mode=0700', '--entrypoint', '/usr/bin/python3.11'],
                              ['/opt/merv/runtime/probe.py'], '/opt/merv/runtime/probe.py', 'linux-review-readonly', 1),
}
LANE_GATES = {'worker': ['linux-pi-gate.py'], 'boundary': list(GATES)}
GATE_FACTS, GATE_FALSE = {'prestarted', 'codexSandboxOnHost'}, {'actualProtectedWorkflow', 'cloudflareEvidence'}
REVIEW_CHECKS = ('passed', 'actualCodexShell', 'readOnlyProfileWithScratch', 'snapshotUnchanged',
                'planResultsTaskReviewers', 'sameHostReset', 'credentialReadsDenied',
                'gitWritesAndPrivilegeEscapesDenied', 'protectedTargetsPreserved')
RECORDED = ('plan', 'preflight', 'build', 'gates', 'push', 'catalog', 'progress', 'finish')
STAGING_PROVIDERS = ('cloudflare-fleet-staging', 'cloudflare-fleet-staging-large')
STEPS = {'replace_predeploy', 'propagation_ready', 'staging_apps', 'staging_preflight', 'staging_switch', 'staging_prepare', 'staging_accept', 'preflight', 'build', 'gates', 'push', 'catalog', 'drain', 'native', 'switch', 'canary', 'stage', 'note',
         'finish', 'status', 'guard', 'abandon', 'mint_canary', 'pins', 'prepare_cutover', 'accept_cutover'}
# One row from Main's database, read only unless MERV_W is set; {s} is Main's schema.
MAIN_READ = r'''import pg from 'pg';
const c=new pg.Client({connectionString:process.env[process.env.MERV_URL??'MERV_DB_URL']});await c.connect();const w=!!process.env.MERV_W;
try{await c.query(w?'BEGIN':'BEGIN READ ONLY');const s=(process.env.MERV_TS_DB_SCHEMA??'merv_ts').replace(/[^a-z0-9_]/g,'');
const r=await c.query(process.env.MERV_Q.replaceAll('{s}',s),JSON.parse(process.env.MERV_P));
console.log(JSON.stringify(r.rows[0]));await c.query(w?'COMMIT':'ROLLBACK')}finally{await c.end()}'''
# Use Main's rendered profiles (including deployment defaults) and Fleet's own identity function.
# Allocations persist this release-bound profileId, not a releaseId in their runtime launch.
FLEET_PROFILES = r'''import { readFileSync } from 'node:fs';
import { runtimeProfiles, runtimeProfileId } from '@merv/fleet/runtime';
const config=JSON.parse(readFileSync('/tmp/merv-config.json','utf8'));
const profiles=runtimeProfiles.parse(config.plugins.find(p=>p.id==='fleet').config.profiles);
console.log(JSON.stringify(Object.fromEntries(profiles.map(p=>[runtimeProfileId(p),p.releaseId]))));'''
# Ends each idle Pi host's idle clock: Main releases its machine at its next pass, as at the idle
# timeout, instead of a rollout killing it. A host that took a turn meanwhile keeps it.
IDLE = ("e AS (UPDATE {s}.pi_hosts SET data_json = jsonb_set(data_json::jsonb, '{idleSince}', "
        "to_jsonb('1970-01-01T00:00:00.000Z'::text))::text WHERE status = 'live' AND "
        "data_json::jsonb->>'idleSince' IS NOT NULL)")
# A rollout replaces every running container of an app, so a work visit on one would die with it.
# The drain holds Main's work machines (Fleet's fleet_holds): Fleet rents none, admits no new step
# on one, and stops each whose step has settled; the drain waits until none is up. Each look renews
# the hold for an hour; a passed canary, a drain that gives up, or the run's finish lifts it, and
# should none run, it lapses.
HOLD = ("h AS (INSERT INTO {s}.fleet_holds(name, until) VALUES ('hosted-release', to_char(now() AT TIME ZONE "
        "'UTC' + interval '60 minutes', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')) ON CONFLICT (name) DO UPDATE SET "
        "until = EXCLUDED.until)")
UNHOLD = "WITH h AS (DELETE FROM {s}.fleet_holds WHERE name = 'hosted-release') SELECT true AS lifted"
WORKFLOW = "data_json::jsonb#>>'{owner,kind}' = 'workflow'"
WORK = ("SELECT coalesce((SELECT json_agg(id) FROM {s}.fleet_allocations WHERE phase <> 'released' AND "
        + WORKFLOW + "), '[]'::json)::text AS work")
# Mints the canary's reader key inside Main with Main's own scope service, as the pilot's operator.
MINT = r'''import { PostgresState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { deploymentSchema } from '/app/deploy/schema.mjs';
const projectId=process.env.MERV_CANARY_PROJECT, name=process.env.MERV_CANARY_NAME;
const state=await PostgresState.open({connectionString:process.env.MERV_DB_URL,schema:deploymentSchema(),maxConnections:2,readConnections:1});
try{const scope=new ProjectScope(state);await scope.initialize();
const actors=await state.transaction((tx)=>tx.all("SELECT a.id,a.name,a.role,a.active FROM actors a WHERE a.project_id=? AND a.session_id IS NULL AND a.service_owner IS NULL AND NOT EXISTS(SELECT 1 FROM member_actors m WHERE m.actor_id=a.id) ORDER BY a.id",projectId));
const operator=actors.find((a)=>a.role==='operator'&&a.active);
if(!operator)throw new Error('the project has no active independent nonmember operator; have an authorized operator provision the reader through normal authenticated Scope tools');
const caller={projectId,actorId:operator.id}, existing=actors.find((a)=>a.name===name&&a.role==='reader'&&a.active);
const issued=existing?await scope.credentials.issueActorCredential(caller,{actorId:existing.id,expiresAt:null}):await scope.credentials.issueActor(caller,{name,role:'reader',expiresAt:null});
// A lost file is replaced, never left beside a second live token.
if(existing)for(const c of await scope.credentials.actorCredentials(caller,existing.id))if(c.id!==issued.credential.id&&!c.revokedAt)await scope.credentials.revokeCredential(caller,c.id);
process.stdout.write(JSON.stringify({projectId,actorId:issued.actor.id,credentialId:issued.credential.id,token:issued.token}));
}finally{await state.close()}'''


def need(ok, reason):
    if not ok:
        raise RuntimeError(reason)


@contextlib.contextmanager
def gate_environment(boundary):
    """An unattached AppArmor profile for these disposable containers, never production ones.

    Docker's default profile denies the root mount; plain unconfined on Ubuntu denies
    Codex's child user namespace. A named profile permits both, retaining Docker seccomp
    and the launcher's irreversible capability drop. No sysctl or boot policy changes.
    """
    if not boundary:
        yield None
        return
    name = 'merv-hosted-gate-' + secrets.token_hex(8)
    source = f'abi <abi/4.0>,\nprofile {name} flags=(unconfined) {{\n  userns,\n}}\n'.encode()
    parser = ['apparmor_parser', '--skip-cache']
    need(not any(line.startswith(name + ' (') for line in
                 Path('/sys/kernel/security/apparmor/profiles').read_text().splitlines()),
         'gate AppArmor profile already exists: ' + name)
    need(not run(['docker', 'ps', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}']).strip(),
         'gate container already exists: ' + name)
    print('Disposable gate container/AppArmor profile: ' + name, file=sys.stderr, flush=True)
    run([*parser, '--add'], payload=source)
    try:
        yield name
    finally:
        # Killing a timed-out Docker client does not stop its container. Remove this
        # exact container before unloading its profile; retain the profile if removal fails.
        try:
            removed = subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=30)
            need(removed.returncode == 0 or b'No such container:' in removed.stderr,
                 'container removal failed')
            run([*parser, '--remove'], payload=source)
        except Exception as error:
            raise RuntimeError(f'gate cleanup failed; remove container then AppArmor profile: {name}') from error


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def gate_seccomp(path):
    """The pinned Docker default plus the one syscall Codex's nested sandbox needs."""
    server = json.loads(run(['docker', 'version', '--format', '{{json .Server}}']))
    need((server.get('Version'), server.get('GitCommit')) == ('29.6.0', '70eaf5e'),
         'review the hosted gate seccomp baseline for this Docker version')
    need('name=seccomp,profile=builtin' in json.loads(run(['docker', 'info', '--format', '{{json .SecurityOptions}}'])),
         'hosted gates require the reviewed Docker builtin seccomp baseline')
    raw = (Path(__file__).parent / 'vendor/docker-seccomp/default.json').read_bytes()
    need(sha(raw) == '536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74',
         'hosted gate seccomp baseline changed')
    policy = json.loads(raw)
    policy['syscalls'].append({'names': ['pivot_root'], 'action': 'SCMP_ACT_ALLOW'})
    path.write_text(json.dumps(policy))
    return str(path)


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
    # The new name must survive power loss before any caller can start external effects.
    durable_directory(path.parent)


def read(path):
    return json.loads(path.read_bytes()) if path.exists() else None


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


_READER_ORIGINALS = {}
_READER_LABELS = ('com.docker.compose.project','com.docker.compose.project.config_files',
                  'com.docker.compose.project.working_dir','com.docker.compose.service')


def reader_info(name):
    """Metadata only: durable originals can bridge Compose's remove/rename gap.
    Health checks must still use inspect(), never this fallback."""
    original=_READER_ORIGINALS.get(name)
    try:
        actual=inspect(name)
    except RuntimeError:
        if original is None:
            raise
        return original
    if original:
        need(actual['Image']==original['Image'] and
             all(actual['Config'].get('Labels',{}).get(k)==original['Config'].get('Labels',{}).get(k)
                 for k in _READER_LABELS), 'reader image or Compose identity changed: '+name)
    return actual


@contextlib.contextmanager
def reader_recovery(directory, capture=False):
    global _READER_ORIGINALS
    path=directory/'reader-originals.json'
    if not path.exists() and capture:
        atomic(path,json.dumps({name:reader_info(name) for name in (MAIN,CONTROL)}).encode())
    if not path.exists():
        yield
        return
    need(not path.is_symlink() and path.stat().st_uid == os.geteuid() and path.stat().st_mode & 0o077 == 0, 'reader metadata must be private and operator-owned')
    originals=read(path)
    need(set(originals)=={MAIN,CONTROL}, 'incomplete reader metadata')
    previous=_READER_ORIGINALS
    _READER_ORIGINALS=originals
    try:
        # Existing canonical containers are checked; absent ones are never assumed healthy.
        for name in originals: reader_info(name)
        yield
    finally:
        _READER_ORIGINALS=previous


def recover_reader_name(name, raw, directory):
    """Finish Compose's recorded remove/rename gap, only for one fully validated replacement."""
    try:
        inspect(name)
    except RuntimeError:
        pass
    else:
        reader_info(name)
        return
    original=_READER_ORIGINALS.get(name)
    need(original, 'missing reader recovery original')
    labels=original['Config'].get('Labels',{})
    named=run(['docker','ps','-aq','--no-trunc','--filter','name='+name]).decode().split()
    owned=run(['docker','ps','-aq','--no-trunc','--filter','label=com.docker.compose.project='+labels.get('com.docker.compose.project',''),
               '--filter','label=com.docker.compose.service='+labels.get('com.docker.compose.service','')]).decode().split()
    ids=sorted(set(named+owned))
    if not ids:
        return  # Compose can create from its original config; no untrusted object is adopted.
    need(len(ids)==1, 'ambiguous reader replacements')
    replacement=inspect(ids[0])
    labels=original['Config'].get('Labels',{})
    actual_labels=replacement['Config'].get('Labels',{})
    identity=(*_READER_LABELS,'com.docker.compose.container-number','com.docker.compose.oneoff')
    need(replacement['Image']==original['Image'] and all(actual_labels.get(k)==labels.get(k) for k in identity),
         'replacement image or Compose identity changed')
    expected_replace={name, labels.get('com.docker.compose.service','')+'-'+labels.get('com.docker.compose.container-number','')}
    if original.get('Id'): expected_replace.add(original['Id'])  # Compose 2.32 uses the replaced ID.
    need(actual_labels.get('com.docker.compose.replace') in expected_replace, 'replacement lacks Compose replacement identity')
    expected_env=dict(item.split('=',1) for item in original['Config']['Env'])
    expected_env.update(file_env(raw))
    need(dict(item.split('=',1) for item in replacement['Config']['Env'])==expected_env, 'replacement target environment changed')
    for key in ('Entrypoint','Cmd','User','WorkingDir','Healthcheck','ExposedPorts'):
        need(replacement['Config'].get(key)==original['Config'].get(key), 'replacement configuration changed: '+key)
    for key in ('Binds','Mounts','Privileged','CapAdd','CapDrop','SecurityOpt','ReadonlyRootfs','NetworkMode','PortBindings'):
        need(replacement.get('HostConfig',{}).get(key)==original.get('HostConfig',{}).get(key), 'replacement host configuration changed: '+key)
    need(set(replacement.get('NetworkSettings',{}).get('Networks',{}))==set(original.get('NetworkSettings',{}).get('Networks',{})), 'replacement networks changed')
    intent={'id':ids[0],'name':name,'image':original['Image'],'target':sha(raw)}
    path=directory/('reader-rename-'+('main' if name==MAIN else 'control')+'.json')
    need(not path.exists() or read(path)==intent, 'replacement rename intent changed')
    if not path.exists(): atomic(path,json.dumps(intent).encode())
    run(['docker','rename',ids[0],name])
    reader_info(name)  # A canonical name alone is not proof of identity; health follows Compose up.


def env_of(container):
    return dict(item.split('=', 1) for item in reader_info(container)['Config']['Env'])


def healthy(name, tries, pause):
    for _ in range(tries):
        if inspect(name)['State'].get('Health', {}).get('Status') == 'healthy':
            return
        time.sleep(pause)
    raise RuntimeError('health_timeout: ' + name)


def main_read(query, *params, write=False, url=None):
    return json.loads(run(['docker', 'exec', '-e', 'MERV_Q=' + query, '-e', 'MERV_P=' + json.dumps(params),
                           *(['-e', 'MERV_W=1'] if write else []), *(['-e', 'MERV_URL=' + url] if url else []),
                           '-w', '/app', MAIN, 'node',
                           '--input-type=module', '-e', MAIN_READ]))


def durable_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def legacy_preflight_anchor(records, directory, boot_id, uptime):
    expected = ['/usr/bin/python3', str(directory / 'source/deploy/hosted-release-vm.py'), 'preflight', str(directory)]
    anchors = []
    for record in records:
        # Underscore journal fields are supplied by journald, not the message's sender.
        if record.get('_EXE') != '/usr/bin/sudo' or record.get('_COMM') != 'sudo':
            continue
        message = record.get('MESSAGE', '')
        if not isinstance(message, str) or 'COMMAND=' not in message:
            continue
        try:
            command = shlex.split(message.split('COMMAND=', 1)[1])
        except ValueError:
            continue
        if command == expected:
            anchors.append(record)
    need(len(anchors) == 1, 'original preflight has no unique trusted journal anchor')
    anchor = anchors[0]
    monotonic = anchor.get('__MONOTONIC_TIMESTAMP', '')
    need(anchor.get('_BOOT_ID') == boot_id.replace('-', '') and
         isinstance(monotonic, str) and monotonic.isdigit() and 0 < int(monotonic) <= uptime * 1000000,
         'original preflight did not run in the current kernel boot')
    return {'bootId': anchor['_BOOT_ID'], 'monotonicMicroseconds': monotonic,
            'cursor': anchor.get('__CURSOR'), 'command': expected}


def legacy_boot_proof(directory):
    """Legacy receipts lacked directory fsync: accept their absence only without a reboot.
    A trusted sudo journal record anchors the unique original preflight to this
    kernel boot. Birth time is corroboration, never a timestamp-only exception.
    """
    boot_path = Path('/proc/sys/kernel/random/boot_id')
    boot_id = boot_path.read_text().strip()
    need(re.fullmatch(r'[0-9a-f-]{36}', boot_id), 'kernel boot identity unavailable')
    boot = [line.split()[1] for line in Path('/proc/stat').read_text().splitlines() if line.startswith('btime ')]
    need(len(boot) == 1, 'kernel boot time unavailable')
    started = int(boot[0])
    uptime = float(Path('/proc/uptime').read_text().split()[0])
    now = time.time()
    born_raw = run(['stat', '--format=%W', '--', str(directory)]).decode().strip()
    need(re.fullmatch(r'[0-9]+', born_raw), 'filesystem birth time unavailable')
    born = int(born_raw)
    need(abs(now - uptime - started) < 5 and started < born <= now,
         'legacy run predates this boot or its no-reboot evidence is unproven')
    # Search all retained boots, never only the current boot. Resume does not invoke preflight.
    journal = run(['journalctl', '--no-pager', '--output=json', '_COMM=sudo', '--grep=' + directory.name], timeout=60)
    anchor = legacy_preflight_anchor([json.loads(line) for line in journal.splitlines()], directory, boot_id, uptime)
    need(boot_path.read_text().strip() == boot_id, 'kernel boot changed during verification')
    info = directory.stat()
    return {'bootId': boot_id, 'bootTime': started, 'directoryBirthTime': born, 'preflightAnchor': anchor,
            'directoryDevice': info.st_dev, 'directoryInode': info.st_ino}


def durable_tree(path):
    entries = list(path.rglob('*'))
    for file in entries:
        if file.is_file() and not file.is_symlink():
            with file.open('rb') as stream:
                os.fsync(stream.fileno())
    for directory in sorted((p for p in entries if p.is_dir() and not p.is_symlink()), key=lambda p: len(p.parts), reverse=True):
        durable_directory(directory)
    durable_directory(path)


def sbx(**env):
    flags = [part for key, value in env.items() for part in ('-e', f'{key}={value}')]
    source = globals().get('_STAGING_PROBE') or Path(__file__).with_name('hosted-sandboxes-probe.mjs').read_bytes()
    return json.loads(run(['docker', 'exec', '-i', *flags, '-w', '/opt/sandboxes/typescript', CONTROL,
                           'node', '--import', 'tsx', '--input-type=module', '-'], payload=source, timeout=60))


def native(provider=PROVIDER):
    return sbx(MERV_PROVIDER=provider)


def release_ids(entries):
    return sbx(MERV_RELEASES=json.dumps(entries))


def owner():
    try:
        return (HOME / 'active').read_text().strip()
    except FileNotFoundError:
        return ''


AUTHORIZED_OWNER = None


@contextlib.contextmanager
def authorized(name):
    global AUTHORIZED_OWNER
    previous, AUTHORIZED_OWNER = AUTHORIZED_OWNER, name
    try:
        yield
    finally:
        AUTHORIZED_OWNER = previous


def require_owner():
    need(not owner() or owner() == AUTHORIZED_OWNER, 'staging/hosted work is owned by ' + owner())


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
    return with_machines(raw, releases)


def with_machines(raw, releases):
    """The env file naming releases[provider] for each machine of MERV_FLEET_RUNTIMES on those apps."""
    profiles = json.loads(env_value(raw, RUNTIMES).strip("'"))
    for machine in profiles:
        machine['releaseId'] = releases.get(machine['provider'], machine['releaseId'])
    return with_env(raw, RUNTIMES, "'" + json.dumps(profiles, separators=(',', ':')) + "'")


def recreate(raw, want, backup=None, restore=True):
    """Writes `want` over the env file `raw` and recreates Main on its own image, which must render it
    and take its pins; restores `raw` on failure. `backup` keeps `raw` for a later process."""
    need(not main_release_running(), 'a Main release job is running')
    state = inspect(MAIN)
    image, directory = state['Image'], state['Config']['Labels']['com.docker.compose.project.working_dir']
    if backup and not backup.exists():
        atomic(backup, raw)
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
        if restore:
            atomic(ENV, raw)
            run(up, env=env, cwd=directory, timeout=240)
        raise
    return {'changed': True, 'image': image, 'envSha256Before': sha(raw), 'envSha256After': sha(ENV.read_bytes())}


def staging(releases, maintenance_held=False):
    """On the staging host, as root: `ssh <host> sudo -n python3 - staging '<releases>'` with this file on
    stdin. Points staging Main's machines on these apps ({provider: releaseId}) at their releases and
    recreates Main, as `switch` does on production, under the host's maintenance lock."""
    require_owner()
    need(releases and all(re.fullmatch(r'rt1_[0-9a-f]{64}', r) for r in releases.values()), 'invalid release id')
    MAINTENANCE.parent.mkdir(parents=True, exist_ok=True)
    with contextlib.nullcontext() if maintenance_held else MAINTENANCE.open('a') as maintenance:
        need(maintenance_held or locked(maintenance, 1200), 'deployment or recovery snapshot held the maintenance lock for 20 minutes')
        require_owner()
        raw = ENV.read_bytes()
        need(set(releases) & set(machines(file_env(raw))), 'staging Main runs no machine on these apps')
        want = with_machines(raw, releases)
        if want == raw and pins(env_of(MAIN)) == pins(file_env(raw)):
            unhold()
            return {'changed': False}
        result = recreate(raw, want)
        unhold()
        return result


def with_release(raw, entry, keep=KEEP, protect=()):
    """Append to the raw shared env catalog, pruning old unprotected releases of this provider."""
    before = json.loads(env_value(raw, CATALOG))
    if entry in before:
        return raw, False
    releases = before + [entry]
    same = [r for r in releases if r['provider'] == entry['provider']]
    drop = [r for r in same[:max(0, len(same) - keep)] if r['image_digest'] not in (*protect, entry['image_digest'])]
    return with_env(raw, CATALOG, json.dumps([r for r in releases if r not in drop], separators=(',', ':'))), True


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
        (expected != 'linux-review-readonly' or
         all(r.get(key) is True for key in REVIEW_CHECKS) and all(r.get(key) is False for key in GATE_FALSE)) and
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


def busy(release=False, database_reader=None):
    """Pi turns and launches in flight, by id; idle warm runtimes do not count. With `release` (the
    drain) the same statement first releases idle Pi hosts (IDLE) and holds work machines (HOLD):
    every Pi machine up for a host, which a turn could still land on, counts until Main has released
    it, and every work machine Fleet rented for workflow steps until its step has settled and Fleet
    has released it, since a rollout replaces it. Outside the drain (the catalog's wait) work
    machines never count: their steps run for hours, and only the drain's hold ends them."""
    database_reader = database_reader or main_read
    agg = "coalesce((SELECT json_agg({}) FROM {} WHERE {}), '[]'::json)::text"
    reads = {'turns': ("conversation_id || '/' || id", '{s}.pi_commands', f"status IN {ACTIVE}"),
             'launches': ('id', '{s}.fleet_allocations',
                          f"phase IN ('queued','provisioning','launching','starting') AND NOT ({WORKFLOW})"),
             'kept': ("json_build_array(data_json::jsonb#>>'{runtime,sandboxId}', "
                      "data_json::jsonb#>>'{runtime,launch,launchId}')",
                      '{s}.fleet_allocations', f"phase <> 'released' AND {WORKFLOW}"),
             **({'warm': ('id', '{s}.fleet_allocations', "phase <> 'released' AND data_json::jsonb->>'intent' = "
                          "'run' AND data_json::jsonb#>>'{owner,kind}' = 'pi-host'"),
                 'work': ('id', '{s}.fleet_allocations', f"phase <> 'released' AND {WORKFLOW}")} if release else {})}
    main = database_reader((f'WITH {IDLE}, {HOLD} ' if release else '') + 'SELECT ' +
                     ', '.join(agg.format(*read) + ' AS ' + key for key, read in reads.items()), write=release)
    kept = {part for pair in json.loads(main.pop('kept', '[]')) for part in pair if part}
    lists = {**main, **database_reader('SELECT ' + agg.format('id', 'public.sandboxes',
                                 "provider LIKE 'cloudflare-fleet%' AND state IN ('provisioning','deleting')") +
                                 ' AS machines, ' + agg.format('launch_id', 'public.runtime_bootstraps',
                                 "state='pending' AND expires_at > now()") + ' AS bootstraps',
                                 url='SANDBOXES_DATABASE_URL')}
    return {key: ids for key, ids in ((k, [i for i in json.loads(v) if i not in kept]) for k, v in lists.items())
            if ids}


def quiet(limit, release=False, database_reader=None):
    """Wait, bounded, until nothing is in flight for 10 s. The drain (`release`) that gives up lifts
    its hold on work machines first."""
    deadline, calm = time.monotonic() + limit, None
    while True:
        now = busy(release, database_reader) if database_reader else busy(release)
        if now:
            calm = None
        elif calm is None:
            calm = time.monotonic()
        elif time.monotonic() - calm >= 10:
            return {'drained': True}
        if time.monotonic() >= deadline and release:
            unhold()
        need(time.monotonic() < deadline, f'not_drained_after_{limit}s {json.dumps({k: v[:5] for k, v in now.items()})}'
             f"{': idle Agent and work machines were released, nothing else changed' if release else ': nothing was changed by this step'}"
             f"{'; a work step was still running, which a rollout would kill' if 'work' in now else ''}"
             '; rerun when Pi and work are quieter, or raise --drain-minutes')
        time.sleep(5)


def work_drain(limit):
    """The drain of work machines alone, on a host whose apps are about to be replaced: Main holds them
    (HOLD) and this waits, bounded, until Fleet has released every one. One that gives up lifts the
    hold, having changed nothing but the settled machines it stopped."""
    require_owner()
    deadline = time.monotonic() + limit
    while True:
        require_owner()
        work = json.loads(main_read(f'WITH {HOLD} {WORK}', write=True)['work'])
        if not work:
            return {'drained': True}
        if time.monotonic() >= deadline:
            unhold()
            raise RuntimeError(f'not_drained_after_{limit}s {json.dumps({"work": work[:5]})}: a work step was still '
                               'running, which a rollout would kill; nothing else changed. Rerun when work is '
                               'quieter, or raise --drain-minutes')
        time.sleep(5)


def unhold():
    """Lifts the drain's hold: Fleet rents work machines and admits steps again. Best effort: a hold
    that cannot be lifted lapses within the hour."""
    require_owner()
    with contextlib.suppress(Exception):
        main_read(UNHOLD, write=True)


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

    def hosted_plugins(self):
        # Inspect the running Main's rendered config, not enablement flags or generic /health.
        script = "const c=JSON.parse(require('fs').readFileSync('/tmp/merv-config.json','utf8'));console.log(JSON.stringify(c.plugins.map(p=>({id:p.id,disabled:p.disabled===true}))));"
        plugins = json.loads(run(['docker', 'exec', MAIN, 'node', '-e', script]))
        required = {'sandboxes-host', 'sandboxes-integration', 'fleet', 'fleet-workflow', 'pi', 'pi-api', 'pi-tools'}
        need(isinstance(plugins, list) and all(sum(p.get('id') == name and not p.get('disabled') for p in plugins) == 1 for name in required),
             'Main lacks required Sandboxes/Fleet/Pi plugins; generic health is not hosted readiness')
        return {'requiredPlugins': sorted(required)}

    def staging_preflight(self, _):
        need(self.plan.get('stagingCutover') and self.plan.get('cutover'), 'not a staging cutover')
        claim(self.run.name)
        try:
            need(not main_release_running(), 'a Main release job is running')
            self.cutover_maintenance(True)
            state = inspect(MAIN)
            need(state['Config'].get('Labels', {}).get('org.merv.native-git-protocol') == '1',
                 'staging requires native-compatible Main')
            need(env_of(MAIN).get('MERV_TS_DB_SCHEMA') == 'merv_ts_staging', 'not the staging schema')
            self.hosted_plugins()
            if self.plan.get('isolatedStaging'):
                need(isolation_identity() == self.plan.get('isolation'), 'staging isolation changed')
            self.staging_census()
            live, saved = machines(env_of(MAIN)), machines(file_env(ENV.read_bytes()))
            need(set(live) == set(saved) == set(STAGING_PROVIDERS) and live == saved,
                 'staging must name exactly both staging providers consistently')
            cred = credential(Path(self.plan['canary']['credential']))
            need(cred['projectId'] == self.plan['canary']['projectId'], 'staging canary project mismatch')
            return {'releases': live, 'cutoverMainImage': state['Image'], 'canaryActor': cred['actorId']}
        except BaseException:
            if owner() == self.run.name:
                (HOME / 'active').unlink()
            raise

    def staging_census(self, database_reader=None):
        # Local ownership only. Provider ownership is separately read on production, filtered to
        # the two staging apps; never drain unrelated production work to prepare staging.
        conditions = {
            'worker_sessions': "status IN ('offered','active')",
            'wf_leases': 'released_at IS NULL',
            'code_workspaces': "writer_state IN ('reserved','active','closing','recovery_required')",
            'code_commands': "status IN ('queued','dispatched')",
            'code_operations': "status='prepared' AND kind IN ('upload','import','export')",
            'fleet_allocations': "phase <> 'released'",
            'pi_commands': "status IN ('waiting','starting','working','saving')",
            'pi_hosts': "status <> 'ended'",
            'managed_compute_runs': "state NOT IN ('completed','failed','cancelled')",
            'code_bases': "state='running' OR check_state IN ('queued','running') OR check_job_json IS NOT NULL",
            'code_base_cleanup': 'true', 'code_publications': 'lock_id IS NOT NULL',
            'session_managed_runners': "runner_released_at IS NULL AND control_expires_at > to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')",
        }
        counts = (database_reader or main_read)('SELECT ' + ', '.join(
            f'(SELECT count(*)::int FROM {{s}}.{table} WHERE {where}) AS {table}'
            for table, where in conditions.items()))
        need(counts and all(n == 0 for n in counts.values()), 'staging ownership is not empty')
        return {'drained': True, 'readOnly': True}

    def staging_pair(self):
        self.hosted_plugins()
        if self.plan.get('isolatedStaging'):
            need(isolation_identity() == self.plan.get('isolation'), 'prepared isolation changed')
        before = read(self.run / 'preflight.json')
        need(before and inspect(MAIN)['Image'] == before['cutoverMainImage'], 'prepared staging Main image changed')
        target = self.plan['stagingReleases']
        need(set(target) == set(STAGING_PROVIDERS), 'exactly both staging providers are required')
        live, saved = env_of(MAIN), file_env(ENV.read_bytes())
        need(machines(live) == machines(saved) == target, 'prepared staging pins changed')
        need(live.get(KEY) == saved.get(KEY) == target[STAGING_PROVIDERS[0]], 'staging Standard pin changed')
        return {'mainImage': before['cutoverMainImage'], 'image': self.plan['current']['image'], 'releases': target}

    def staging_switch(self, _):
        self.cutover_maintenance(True)
        self.staging_census()
        before = read(self.run / 'preflight.json')
        need(before and inspect(MAIN)['Image'] == before['cutoverMainImage'], 'staging Main image changed')
        target = self.plan['stagingReleases']
        need(set(target) == set(STAGING_PROVIDERS), 'exactly both staging providers are required')
        raw = ENV.read_bytes()
        need(set(machines(file_env(raw))) == set(STAGING_PROVIDERS), 'staging providers changed')
        want = with_env(with_machines(raw, target), KEY, target[STAGING_PROVIDERS[0]])
        result = {'changed': False} if want == raw and pins(env_of(MAIN)) == pins(file_env(raw)) else recreate(
            raw, want, self.run / 'env.before', restore=False)
        self.staging_pair()
        return result

    def staging_prepare(self, _):
        self.cutover_maintenance(True)
        self.staging_census()
        pair = self.staging_pair()
        self.note({'cutoverPrepared': pair})
        return pair

    def staging_accept(self, _):
        checkpoint = (read(self.run / 'progress.json') or {}).get('cutoverPrepared')
        need(checkpoint, 'staging has no preparation checkpoint')
        self.cutover_maintenance(False)
        need(self.staging_pair() == checkpoint, 'prepared staging pair changed')
        return {'accepted': True}

    def migration_proof(self):
        report = json.loads(run(['docker', 'exec', '-w', '/app', MAIN, 'node', '--import', 'tsx',
                                 'deploy/git-cutover-preflight.mjs']))
        need(report.get('ready') is True and report.get('protocolMigrated') is True and
             report.get('alreadyNative') is True, 'native migration is not complete and ready')
        rows = main_read("SELECT (SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text FROM {s}.component_migrations t) AS components, "
                         "(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text FROM {s}.wf_protocol_migrations t) AS protocols")
        need(rows.get('components') and rows.get('protocols'), 'native migration ledger is missing')
        return {'report': report, 'ledgerSha256': sha(json.dumps(rows, sort_keys=True).encode())}

    def replacement_safety(self, before, migration=None):
        self.cutover_maintenance(True)
        self.cutover_census()
        state = inspect(MAIN)
        need(state['Image'] == before['cutoverMainImage'] and
             state['Config'].get('Labels', {}).get('org.merv.native-git-protocol') == '1',
             'native Main image changed')
        proof = self.migration_proof()
        need(migration is None or proof == migration, 'native migration changed since replacement')
        return proof

    def replace_predeploy(self, _):
        """Transfer ownership only from a provably failed gate, retaining all predecessor evidence.
        Caller holds BOTH shared maintenance and hosted locks. The active-file rename is the commit.
        A crash before it leaves an unowned new directory; a crash after it resumes the new run.
        """
        name = self.plan.get('replaces', '')
        need(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,120}', name) and name != self.run.name,
             'invalid replacement predecessor')
        old = RUNS / name
        need(owner() == name and old.is_dir() and not old.is_symlink(), 'predecessor is not the active run')
        need(not main_release_running(), 'a Main release job is running')
        lease = read(old / 'lease.json') or {}
        need(lease.get('seen') is not None and time.time() - lease['seen'] >= LEASE,
             'predecessor driver lease is still fresh or unproven')
        plan, before, build = [read(old / (n + '.json')) for n in ('plan', 'preflight', 'build')]
        need(plan and before and build and plan.get('cutover') is True and not plan.get('stagingCutover'),
             'predecessor is not a built production cutover')
        need(self.plan.get('cutover') is True and not self.plan.get('stagingCutover'), 'replacement must be a production cutover')
        for key in ('current', 'sandboxesCommit', 'canary', 'nodeImage', 'drainSeconds'):
            need(self.plan.get(key) == plan.get(key), 'replacement changed ' + key)
        progress = read(old / 'progress.json') or {}
        need(set(progress) == {'cutoverFailure'} and progress['cutoverFailure'].startswith('gates: '),
             'predecessor is not a failed gate with no later progress')
        for filename in ('gates.json', 'push.json', 'catalog.json', 'finish.json', 'mutation-started.json',
                         'catalog.before', 'catalog.target', 'env.before', 'stage.before'):
            need(not (old / filename).exists(), 'predecessor has later or ambiguous evidence: ' + filename)
        # Audited drivers record gates before push. The legacy driver lacked directory fsync,
        # so receipt absence requires a trusted original-preflight boot anchor plus birth-time evidence.
        baseline = {'hosted-release.mjs': '4d41a34d18f98037764aa2ee59d9c077917b22bf0ec23738c4ab41cbc25aef28',
                    'hosted-release-vm.py': '27df53c765e319b411ea2e0eb04a5530e1a63c2fab604014564594430b3606b9'}
        old_pipeline = {n: sha((old / 'source/deploy' / n).read_bytes()) for n in baseline}
        current_pipeline = {n: sha((self.run / 'source/deploy' / n).read_bytes()) for n in baseline}
        need(old_pipeline in (baseline, current_pipeline), 'predecessor pipeline lacks audited pre-push ordering')
        boot_proof = legacy_boot_proof(old) if old_pipeline == baseline else None
        for archive, key in (('source.tar.gz', 'sourceArchiveSha256'), ('sandboxes.tar.gz', 'sandboxesArchiveSha256')):
            need(re.fullmatch(r'[a-f0-9]{64}', self.plan.get(key, '')) and
                 sha((self.run / archive).read_bytes()) == self.plan[key], 'replacement archive hash mismatch')
        need(self.plan['sandboxesArchiveSha256'] == sha((old / 'sandboxes.tar.gz').read_bytes()),
             'replacement Sandboxes archive changed')
        live = self.pins()
        need(all(live.get(k) == before.get(k) for k in ('apps', 'mainReleaseId', 'fileReleaseId', 'releases', 'fileReleases', 'catalog')),
             'production provider state, catalog or pins changed')
        need(live['apps'] and all(not a.get('rollout') for a in live['apps'].values()), 'provider rollout is active')
        prior = read(old / 'replacement.json')
        need(prior is None or (prior.get('successor') == name and prior.get('migration')), 'invalid predecessor replacement receipt')
        migration = self.replacement_safety(before, prior['migration'] if prior else None)
        # Fresh runs must rebuild and rerun every boundary gate, even for a gate-only source fix.
        need(self.plan.get('lane') == 'boundary', 'replacement must run all boundary gates')
        for filename in ('build.json', 'gates.json', 'push.json', 'catalog.json', 'progress.json', 'finish.json'):
            need(not (self.run / filename).exists(), 'replacement run is not fresh')
        receipt = {'predecessor': name, 'successor': self.run.name, 'sourceCommit': self.plan['sourceCommit'],
                   'oldCandidate': build['candidate'], 'migration': migration, 'predecessorPipeline': old_pipeline,
                   'legacyNoReboot': boot_proof,
                   'evidence': {p.name: sha(p.read_bytes()) for p in old.iterdir() if p.is_file()}}
        atomic(self.run / 'replacement.json', json.dumps(receipt).encode())
        atomic(self.run / 'preflight.json', json.dumps(before).encode())
        # No finish, unhold, cleanup, guard teardown, or edits to the predecessor. Never clear active.
        # Persist every new source/artifact and both directory entries before the owner commit.
        # Without directory fsync, a power loss could retain active but lose its preflight receipt.
        durable_tree(self.run)
        durable_directory(RUNS)
        atomic(HOME / 'active', (self.run.name + '\n').encode())
        durable_directory(HOME)
        return receipt

    def preflight(self, _):
        """Claims the host for this run, then reads the live pins; changes nothing else."""
        claim(self.run.name)
        try:
            need(not main_release_running(), 'a Main release job is running')
            need(shutil.disk_usage('/').free >= 8 << 30, 'less than 8 GiB free on /')
            run(['docker', 'image', 'inspect', '--format', '{{.Id}}', self.plan['current']['localId']])
            cred = credential(Path(self.plan['canary']['credential']))
            if self.plan.get('cutover'):
                self.cutover_maintenance(True)
                self.cutover_census()
                need(inspect(MAIN)['Config'].get('Labels', {}).get('org.merv.native-git-protocol') == '1',
                     'cutover requires native-compatible Main')
            else:
                whoami(cred)
            return {**self.pins(), 'canaryActor': cred['actorId'],
                    **({'cutoverMainImage': inspect(MAIN)['Image']} if self.plan.get('cutover') else {})}
        except BaseException:
            if owner() == self.run.name:
                (HOME / 'active').unlink()
            raise

    def pins(self, _=None):
        """The live pins, reading only: each app serving Main's or the env file's machines, natively,
        the releases both name, and the catalog's release ids."""
        catalog = json.loads(env_of(CONTROL)[CATALOG])
        need(catalog == json.loads(env_of(MAIN)[CATALOG]), 'catalog_services_differ')
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
        with gate_environment(build['lane'] == 'boundary') as profile:
            for name in LANE_GATES[build['lane']]:
                flags, targets, command, expected, lines = GATES[name]
                environment = ['--name', profile] if profile else []
                if profile and 'SYS_ADMIN' in flags:
                    environment += ['--security-opt', 'apparmor=' + profile]
                if name in ('linux-workflow-gate.py', 'linux-review-gate.py'):
                    environment += ['--security-opt', 'seccomp=' + gate_seccomp(self.run / 'gate-seccomp.json')]
                gate = self.run / 'source/scripts/hosted-runner' / name
                mounts = [part for target in targets for part in ('-v', f'{gate}:{target}:ro')]
                if name == 'linux-review-gate.py':
                    mounts += ['-v', f'{self.run}/bundle/review-launch-fixture.mjs:/opt/merv/runtime/review-launch-fixture.mjs:ro']
                out = run(['docker', 'run', '--rm', '--network', 'none', *environment, *flags, *mounts,
                           build['candidate'], command], timeout=300, log=self.run / f'gate-{name}.log').decode()
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

    def sandboxes_file(self, network_none=False, before_recreate=lambda: None):
        if not network_none:
            return self._sandboxes_file(network_none, before_recreate)
        with reader_recovery(self.run, capture=True):
            path, apply = self._sandboxes_file(network_none, before_recreate)
        def recoverable(raw):
            with reader_recovery(self.run):
                target=self.run/'reader-target.json'
                expected={'sha256':sha(raw)}
                need(not target.exists() or read(target)==expected, 'reader recovery target changed')
                if not target.exists(): atomic(target,json.dumps(expected).encode())
                return apply(raw)
        return path,recoverable

    def _sandboxes_file(self, network_none=False, before_recreate=lambda: None):
        """The shared raw env and a coordinated recreate of its two readers on their current images."""
        need(not main_release_running(), 'a Main release job is running')
        commands = []
        for name, key in ((CONTROL, 'SANDBOXES_TS_IMAGE'), (MAIN, 'MERV_TS_IMAGE')):
            state = reader_info(name)
            labels = state['Config']['Labels']
            command = ['docker', 'compose', '-p', labels['com.docker.compose.project']]
            for file in labels['com.docker.compose.project.config_files'].split(','):
                command += ['-f', file]
            if name == CONTROL:
                command += ['--env-file', '/etc/sandboxes/release.env']
            commands.append((name, command, dict(os.environ, **{key: state['Image']}),
                             labels['com.docker.compose.project.working_dir']))

        def apply(raw):
            atomic(SHARED, raw)
            for name, command, env, cwd in commands:
                if name == MAIN and network_none:
                    effective = env_of(MAIN)
                    effective.update(file_env(raw))
                    need(all('\n' not in v and '\r' not in v for v in effective.values()), 'multiline env cannot be rendered with docker env-file')
                    render_env = self.run / 'render.effective.env'
                    atomic(render_env, ('\n'.join(k + '=' + v for k, v in effective.items()) + '\n').encode())
                    run(['docker', 'run', '--rm', '--network', 'none', '--env-file', str(render_env),
                         '--entrypoint', 'node', env['MERV_TS_IMAGE'], '/app/deploy/render-config.mjs', '/tmp/hosted-release-render.json'])
                elif name == MAIN:
                    run(command + ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'node', 'control',
                                   '/app/deploy/render-config.mjs', '/tmp/hosted-release-render.json'],
                        env=env, cwd=cwd)
                else:
                    run(command + ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'sbx', 'control',
                                   'migrate', '--status'], env=env, cwd=cwd)
            for name, command, env, cwd in commands:
                before_recreate()
                if network_none: recover_reader_name(name, raw, self.run)
                run(command + ['up', '-d', '--no-deps', 'control'],
                    env=env, cwd=cwd, timeout=240)
                healthy(name, 90, 2)
                need(json.loads(env_of(name)[CATALOG]) == json.loads(env_value(raw, CATALOG)),
                     'catalog not live in ' + name)
        return SHARED, apply

    def add_releases(self, arg, backup, broken=lambda: None):
        """Adds arg's entries (each one release id arg['releases'] names) to both services' catalogs,
        keeping earlier releases, and recreates them once nothing is in flight; restores on failure."""
        path, apply = self.sandboxes_file()
        entries, releases = arg['entries'], arg['releases']
        need(release_ids(entries) == [releases[e['provider']] for e in entries],
             'Sandboxes derives a different release id')
        raw = path.read_bytes()
        doc, changed = raw, False
        for entry in entries:
            doc, added = with_release(doc, entry, protect=arg.get('protect', ()))
            changed = changed or added
        result = {'releases': releases, 'digest': entries[0]['image_digest'],
                  'size': len(json.loads(env_value(doc, CATALOG)))}
        if not changed and all(json.loads(env_of(c)[CATALOG]) == json.loads(env_value(doc, CATALOG)) for c in (CONTROL, MAIN)):
            return {**result, 'changed': False}
        quiet(self.plan['drainSeconds'])
        if not backup.exists():
            atomic(backup, raw)
        if self.plan.get('stagingCatalog'):
            atomic(self.run / 'catalog.target', doc)
        try:
            apply(doc)
        except BaseException:
            if self.plan.get('cutover'):
                broken()
                raise
            try:
                apply(raw)
            except BaseException as error:
                broken()
                raise RuntimeError(f'catalog restore failed too: {error}') from None
            raise
        return {**result, 'changed': True, 'sha256Before': sha(raw), 'sha256After': sha(path.read_bytes())}

    def catalog(self, arg):
        """Adds the release, an entry per live app, to both shared-env readers, keeping earlier releases,
        and recreates them. {"restore": true} puts back the file this run replaced, for a restore that failed."""
        backup = self.run / 'catalog.before'
        if self.plan.get('cutover'):
            self.cutover_maintenance(True)
            self.cutover_census()
        if arg.get('restore'):
            need(not self.plan.get('cutover'), 'cutover cannot restore the old catalog')
            if backup.exists():
                self.sandboxes_file()[1](backup.read_bytes())
            self.note({'catalogBroken': False})
            return {'restored': backup.exists()}
        need(arg['releases'][PROVIDER] == arg['releaseId'], 'Sandboxes derives a different release id')
        result = self.add_releases(arg, backup, lambda: self.note({'catalogBroken': True}))
        return {'releaseId': arg['releaseId'], **result}

    def propagation_ready(self, _):
        need((read(self.run / 'progress.json') or {}).get('stagingPropagation'), 'no staging propagation checkpoint')
        image = read(self.run / 'push.json')['image']
        releases = self.releases()[image]
        current = {'image': image, 'releaseId': releases[PROVIDER], 'releases': releases}
        verify_production_pair(current)
        return current

    def staging_apps(self, _):
        return {'providers': [p['name'] for p in json.loads(env_of(CONTROL)['SANDBOXES_PROVIDERS'])
                              if p['name'] in STAGING_PROVIDERS]}

    def stage(self, arg):
        """Once the release has passed: its copy for each staging app (arg's entries) that Sandboxes serves,
        added as `catalog` adds the live apps'. Nothing here can roll the release back; staging Main is
        switched by the driver on the staging host."""
        need(not self.plan.get('cutover'), 'staging is deferred until its Main protocol is accepted')
        served = {p['name'] for p in json.loads(env_of(CONTROL)['SANDBOXES_PROVIDERS'])}
        entries = [e for e in arg['entries'] if e['provider'] in served]
        need(entries, 'Sandboxes serves no staging app')
        releases = {e['provider']: arg['releases'][e['provider']] for e in entries}
        return self.add_releases({'entries': entries, 'releases': releases}, self.run / 'stage.before')

    def drain(self, arg):
        """Waits until nothing is in flight and no Pi or work machine is up, releasing each idle Pi
        machine at every poll (one whose turn ends, or that a page warms, while the drain waits goes
        too) and holding work machines, so Fleet stops each once its step settles. A rollback's drain
        ({"work": true}) waits on work machines alone: it must not wait on turns the release it undoes
        is serving."""
        if self.plan.get('stagingCutover'):
            self.cutover_maintenance(True)
            return self.staging_census()
        if self.plan.get('cutover'):
            self.cutover_maintenance(True)
            return self.cutover_census()
        if arg.get('work'):
            return work_drain(self.plan['drainSeconds'])
        return quiet(self.plan['drainSeconds'], release=True)

    def native(self, arg):
        return native(arg.get('provider', PROVIDER))

    def switch(self, arg):
        """Points each of Main's machines at its app's release ({provider: releaseId}; a releaseId alone
        is Standard's; a machine left out keeps the release Main runs) and recreates Main on its own
        image; restores the env on failure. It never waits for a drain: by now Cloudflare runs the
        release and Main must name it."""
        named = arg['releases'] if 'releases' in arg else {PROVIDER: arg['releaseId']}
        if self.plan.get('cutover'):
            self.cutover_maintenance(True)
            need(named == (read(self.run / 'catalog.json') or {}).get('releases'),
                 'cutover may only switch to its prepared candidate pins')
        releases = {**machines(env_of(MAIN)), **named}
        need(all(re.fullmatch(r'rt1_[0-9a-f]{64}', r or '') for r in releases.values()), 'invalid release id')
        raw = ENV.read_bytes()
        want = with_releases(raw, releases)
        if want == raw and pins(env_of(MAIN)) == pins(file_env(raw)):
            return {'changed': False}
        # The drain's hold outlasts the switch: a failed canary rolls back, redeploying every app, and
        # a step admitted meanwhile would hold that rollback up until it ended. The canary lifts it.
        return recreate(raw, want, self.run / 'env.before', restore=not self.plan.get('cutover'))

    def cutover_maintenance(self, active):
        need(self.plan.get('cutover'), 'not a cutover run')
        live, saved = env_of(MAIN).get('MERV_BOOT_MAINTENANCE', '0'), file_env(ENV.read_bytes()).get('MERV_BOOT_MAINTENANCE', '0')
        need(live == saved and live == ('1' if active else '0'),
             'Main and saved environment must both have maintenance ' + ('enabled' if active else 'removed'))
        with urllib.request.urlopen('http://127.0.0.1:3081/health', timeout=30) as response:
            health = json.load(response)
        need(health.get('status') == 'ok' and (health.get('maintenance') is True) == active,
             'Main health does not confirm the requested maintenance state')

    def cutover_census(self):
        # Unlike drain, this never releases idle hosts, sets a hold, or expects fenced workers to act.
        pending = busy(False)
        allocations = main_read("SELECT coalesce(json_agg(id), '[]'::json)::text AS ids FROM {s}.fleet_allocations WHERE phase <> 'released'")
        need(not pending and not json.loads(allocations['ids']),
             'cutover ownership is not empty; complete the authorized drain before preparation')
        return {'drained': True, 'readOnly': True}

    def cutover_pair(self):
        before, pushed, catalog = (read(self.run / p) for p in ('preflight.json', 'push.json', 'catalog.json'))
        need(before and pushed and catalog, 'cutover artifacts are incomplete')
        need(inspect(MAIN)['Image'] == before['cutoverMainImage'], 'prepared Main image changed')
        live = self.pins()
        need(live['releases'] == live['fileReleases'] == catalog['releases'], 'prepared release pins changed')
        need(live['mainReleaseId'] == live['fileReleaseId'] == catalog['releaseId'], 'prepared Standard pin changed')
        held = {(entry['provider'], entry['id'], entry['digest']) for entry in live['catalog']}
        need(all((provider, release, pushed['image'].split('@')[1]) in held
                 for provider, release in catalog['releases'].items()), 'prepared catalog entry changed')
        need(all(n['image'] == pushed['image'] and not n.get('rollout') for n in live['apps'].values()),
             'prepared hosted image changed or rollout is incomplete')
        return {'mainImage': before['cutoverMainImage'], 'image': pushed['image'], 'releases': catalog['releases']}

    def prepare_cutover(self, _):
        self.cutover_maintenance(True)
        self.cutover_census()
        pair = self.cutover_pair()
        self.note({'cutoverPrepared': pair})
        return pair

    def accept_cutover(self, _):
        checkpoint = (read(self.run / 'progress.json') or {}).get('cutoverPrepared')
        need(checkpoint, 'cutover has no preparation checkpoint')
        self.cutover_maintenance(False)
        need(self.cutover_pair() == checkpoint, 'prepared image pair changed')
        return {'accepted': True}

    def canary(self, arg):
        """One real Pi turn as the canary reader on Standard; proves the release served it and its
        machine was released, and that every other live app runs the same image, healthy."""
        if self.plan.get('stagingCutover'):
            self.staging_accept({})
        elif self.plan.get('cutover'):
            self.accept_cutover({})
        cred, target = credential(Path(self.plan['canary']['credential'])), arg['releaseId']
        whoami(cred)
        nonce = secrets.token_hex(4)
        if self.plan.get('isolatedStaging'):
            intent = read(self.run / 'isolated-canary.intent.json')
            if intent:
                need(intent['releaseId'] == target and intent['isolation'] == isolation_identity(), 'canary intent changed')
                previous_result=read(self.run / 'isolated-canary.result.json') or {}
                if (previous_result.get('nonce') == intent['nonce'] and previous_result.get('released')
                        and previous_result.get('status') not in (*ACTIVE, None) and previous_result.get('accepted') is False):
                    # Only a terminal, stopped and fully censused attempt can be replaced.
                    self.staging_census()
                    isolated_census()
                    atomic(self.run / ('isolated-canary.attempt-' + intent['nonce'] + '.json'),
                           json.dumps({'intent':intent,'result':previous_result}).encode())
                    intent={**intent,'nonce':nonce,'generation':intent.get('generation',1)+1}
                    atomic(self.run / 'isolated-canary.intent.json',json.dumps(intent).encode())
                nonce = intent['nonce']
            else:
                self.staging_census()
                atomic(self.run / 'isolated-canary.intent.json', json.dumps({'nonce': nonce, 'releaseId': target,
                       'isolation': isolation_identity()}).encode())
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
            cleanup = (('pi.stop', {'id': conversation}), ('pi.machine.stop', {}))
            if self.plan.get('isolatedStaging'):
                # Lost reads/process death leave the same command resumable. Never cancel a
                # live attempt or the person's shared machine; wait for natural idle release.
                cleanup = ()
            for name, body in cleanup:
                with contextlib.suppress(RuntimeError):
                    tool(cred, name, body, tries=3)
        if self.plan.get('isolatedStaging'):
            need(command.get('status') and command['status'] not in ACTIVE, 'canary attempt still active; resume the same durable command')
        allocation = command.get('runtimeId')  # the machine that served the turn
        profiles = json.loads(run(['docker', 'exec', '-w', '/app', MAIN, 'node', '--import', 'tsx',
                                   '--input-type=module', '-e', FLEET_PROFILES]))
        served = main_read("SELECT count(*)::int AS n FROM {s}.fleet_allocations WHERE id = $1 AND "
                           "data_json::jsonb->>'profileId' = ANY($2::text[])", allocation,
                           [profile for profile, release in profiles.items() if release == target])['n']
        # Native deletion and Fleet retries can each back off for a minute. Wait for
        # observed stop, not just Fleet's lease-expiry fallback freeing its slot.
        released, release_deadline = False, time.monotonic() + (900 if self.plan.get('isolatedStaging') else 600)
        while time.monotonic() < release_deadline:
            released = main_read("SELECT count(*)::int AS n FROM {s}.fleet_allocations WHERE id = $1 AND "
                                 "phase = 'released' AND data_json::jsonb->'runtime'->>'state' = 'stopped'",
                                 allocation)['n'] == 1
            if released:
                break
            time.sleep(min(3, max(0, release_deadline - time.monotonic())))
        image = self.plan['current']['image'] if self.plan.get('stagingCutover') else native()['image']
        # The coordinator verifies staging apps through production's Sandboxes before and after
        # this local ordinary-HTTP canary. Staging has no Sandboxes control container.
        apps = {} if self.plan.get('stagingCutover') else {p: native(p) for p in self.apps() if p != PROVIDER}
        result = {'conversation': conversation, 'status': command.get('status'), 'error': command.get('error'),
                  'reply': any(word in m.get('text', '') for m in command.get('messages', [])
                               if m.get('role') == 'assistant'),
                  'servedByRelease': served > 0, 'released': released,
                  'apps': {p: n['image'] == image and not n.get('rollout') and (n.get('health') or {}).get(
                      'errors') == [] and not n['health'].get('instances', {}).get('failed') for p, n in apps.items()},
                  'seconds': round(time.monotonic() - started)}
        result['accepted'] = bool(result['status'] == 'completed' and result['reply'] and result['servedByRelease'] and result['released'] and all(result['apps'].values()))
        if self.plan.get('isolatedStaging'):
            isolated_census()
            result['nonce']=nonce
            atomic(self.run / 'isolated-canary.result.json', json.dumps(result).encode())
        need(result['status'] == 'completed' and result['reply'] and result['servedByRelease'] and result['released']
             and all(result['apps'].values()), 'canary_failed ' + json.dumps(result))
        if not self.plan.get('cutover'):
            unhold()  # normal release removes only its own drain hold
        atomic(self.run / 'canary.json', json.dumps({**result,'releaseId':target,'image':image}).encode())
        return result

    def note(self, arg):
        """Records progress; step() arms the guard timer before a first deployAttempted is recorded."""
        path = self.run / 'progress.json'
        before = read(path) or {}
        atomic(path, json.dumps({**before, **arg}).encode())
        return {**before, **arg}

    def finish(self, arg):
        """Closes the run: the new pins (on success), the drain's hold, the guard, the backups, the marker."""
        if self.plan.get('deferStaging') and arg.get('result') == 'pass':
            current=(arg.get('state') or {}).get('current') or {}
            canary=read(self.run / 'canary.json') or {}
            need(not self.plan.get('cutover') and not self.plan.get('stagingCutover')
                 and not (read(self.run / 'progress.json') or {}).get('stagingPropagation'),
                 'deferral cannot erase staging propagation ownership')
            need(current.get('image') and current.get('releaseId') and canary.get('accepted') is True
                 and canary.get('image') == current['image'] and canary.get('releaseId') == current['releaseId'],
                 'staging deferral requires the actual accepted production canary')
            deferred={'status':'deferred','reason':self.plan['deferStaging'],'sourceRun':self.run.name,
                      'image':current['image'],'releaseId':current['releaseId']}
            need(arg['state'].get('staging') == deferred, 'staging deferral receipt mismatch')
            atomic(self.run / 'staging-deferred.json',json.dumps(deferred).encode())
        if not self.plan.get('cutover') and owner() in ('', self.run.name):
            with authorized(self.run.name):
                unhold()
        if arg.get('state'):
            previous=read(HOME / 'state.json') or {}
            if 'staging' not in arg['state'] and (previous.get('staging') or {}).get('status') == 'deferred':
                arg['state']={**arg['state'],'staging':previous['staging']}
            current=arg['state'].get('current') or {}
            canary=read(self.run / 'canary.json') or {}
            if (arg.get('result') in ('pass','rechecked','abandoned') and current.get('verified') is not False
                    and canary.get('accepted') is True and canary.get('image') == current.get('image')
                    and canary.get('releaseId') == current.get('releaseId')):
                atomic(self.run / 'acceptance.json',json.dumps({'current':current,'canary':canary}).encode())
            atomic(HOME / 'state.json', json.dumps(arg['state']).encode())
        for name in ('catalog.before', 'stage.before', 'env.before'):  # they hold secrets
            if (self.run / name).exists():
                subprocess.run(['shred', '-u', self.run / name], capture_output=True)
        if owner() == self.run.name:  # the guard timer is the open run's
            subprocess.run(['systemctl', 'disable', '--now', GUARD.name + '.timer'], capture_output=True)
            (HOME / 'active').unlink()
        for tidy in (['docker', 'image', 'rm', 'merv-hosted-sandbox:' + self.run.name],
                     ['docker', 'builder', 'prune', '-af', '--keep-storage', '10GB']):  # best effort
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
        if self.plan.get('cutover') or (read(self.run / 'progress.json') or {}).get('stagingPropagation'):
            return {'guard': 'cutover/propagation: preserve pins; explicit forward resume required'}
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
        rollout, Main and the env file name its releases, and both shared-env readers' catalog holds them."""
        need(not self.plan.get('cutover'), 'cutover cannot be abandoned; resume forward')
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
            catalog != json.loads(env_of(MAIN)[CATALOG]) and 'the shared-env readers hold different catalogs',
        ) if p]
        need(not problems, 'production disagrees, so the run stays open: ' + '; '.join(problems))
        return {'releaseId': target[PROVIDER], 'releases': target, 'image': image}

    def mint_canary(self, _):
        """Once: a non-expiring reader key for the service pilot, minted inside Main and stored root-only."""
        path = Path(self.plan['canary']['credential'])
        need(path.is_absolute() and not str(path).startswith('/var/lib/merv-ts'), 'keep the credential outside Main')
        if path.exists() or path.is_symlink():
            cred = credential(path)
            need(cred['projectId'] == self.plan['canary']['projectId'], 'saved canary belongs to another project')
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
    if name in ('replace_predeploy', 'preflight', 'staging_preflight', 'mint_canary', 'pins'):  # the plan arrives with the first step of a run
        if name == 'replace_predeploy':
            existing = read(directory / 'plan.json')
            need(existing is None or existing == arg, 'replacement plan is immutable')
        atomic(directory / 'plan.json', json.dumps(arg).encode())
        arg = {}
    work = Step(directory, json.loads((directory / 'plan.json').read_bytes()))
    HOME.mkdir(mode=0o700, parents=True, exist_ok=True)
    if name in ('status', 'pins'):  # reads only, and holds nothing
        result = getattr(work, name)(arg)
        if name == 'pins' and directory.name.endswith('-check'):  # a --check run keeps no copy
            shutil.rmtree(directory)
        return result
    # Take the shared lock first everywhere: capture must not overlap a Main recreate.
    MAINTENANCE.parent.mkdir(parents=True, exist_ok=True)
    with MAINTENANCE.open('a') as maintenance, (HOME / 'lock').open('a') as lock:
        if not locked(maintenance, 0 if name == 'guard' else 1200):
            need(name == 'guard', 'deployment or recovery snapshot held the maintenance lock for 20 minutes')
            return {'guard': 'busy'}
        need(not RECOVERY_PENDING.exists(), 'recovery snapshot restart is pending; recover it first')
        if not locked(lock, 0 if name == 'guard' else 1200):
            need(name == 'guard', 'another hosted-release step held the host lock for 20 minutes')
            return {'guard': 'busy'}
        if name == 'guard':
            return work.guard(arg)
        if name not in ('replace_predeploy', 'preflight', 'staging_preflight', 'mint_canary', 'finish'):
            need(owner() == directory.name, f'hosted run {directory.name} does not hold {HOME / "active"}')
        with leased(directory, driver) if name != 'mint_canary' else contextlib.nullcontext():
            if name not in ('finish', 'replace_predeploy') and not work.plan.get('stagingCutover'):
                arm(directory, arg)
            with authorized(directory.name):
                replacement = read(directory / 'replacement.json')
                if replacement and name in ('push', 'catalog', 'drain', 'switch', 'prepare_cutover'):
                    before = read(directory / 'preflight.json')
                    work.replacement_safety(before, replacement['migration'])
                    if name == 'push' or (name == 'catalog' and not (directory / 'catalog.before').exists() and not (directory / 'catalog.json').exists()):
                        live = work.pins()
                        need(all(live.get(k) == before.get(k) for k in ('apps', 'mainReleaseId', 'fileReleaseId', 'releases', 'fileReleases', 'catalog')),
                             'production changed before replacement mutation')
                    if name == 'drain' and not (read(directory / 'progress.json') or {}).get('deployAttempted'):
                        need(work.pins()['apps'] == before['apps'], 'provider state changed before replacement deployment')
                if name in ('push', 'catalog', 'drain', 'switch', 'stage') or (name == 'note' and arg.get('deployAttempted')):
                    if not (directory / 'mutation-started.json').exists():
                        atomic(directory / 'mutation-started.json', json.dumps({'step': name}).encode())
                    # Retry may see a journal whose earlier directory fsync failed: barrier again.
                    durable_directory(directory)
                result = getattr(work, name)(arg)
            if name == 'staging_preflight':
                atomic(directory / 'preflight.json', json.dumps(result).encode())
            if name in RECORDED and not arg.get('restore'):
                atomic(directory / f'{name}.json', json.dumps(result).encode())
    return result


def staging_source(owned=None):
    need((not owner() or owner() == owned) and not main_release_running(), 'production release is in progress')
    state = read(HOME / 'state.json') or {}
    current = state.get('current') or {}
    need(current and current.get('verified') is not False and
         re.fullmatch(r'registry\.cloudflare\.com/[a-z0-9/_-]+@sha256:[0-9a-f]{64}', current.get('image', '')),
         'production has no verified immutable release')
    accepted, native_baseline = [], False
    records=[]
    for finish in RUNS.glob('*/finish.json'):
        record, plan = read(finish), read(finish.parent / 'plan.json') or {}
        progress = read(finish.parent / 'progress.json') or {}
        if record.get('result') == 'pass' and plan.get('cutover') and not plan.get('stagingCutover') and progress.get('cutoverPrepared'):
            native_baseline = True
        records.append((finish.parent,record,plan,progress))
    def provenance(wanted, seen=frozenset()):
        identity=(wanted.get('sourceCommit'),wanted.get('sandboxesCommit'),wanted.get('image'))
        if identity in seen or wanted.get('verified') is False:
            return []
        found=[]
        for path,record,plan,progress in records:
            receipt=read(path / 'acceptance.json') or {}
            attested=receipt.get('current') or {}
            canary=read(path / 'canary.json') or {}
            if (not plan.get('stagingCutover') and record.get('result') in ('pass','rechecked','abandoned')
                    and canary.get('accepted') is True and receipt.get('canary') == canary
                    and canary.get('image') == wanted.get('image') and canary.get('releaseId') == wanted.get('releaseId')
                    and attested.get('verified') is not False
                    and all(attested.get(k)==wanted.get(k) for k in ('sourceCommit','sandboxesCommit','image','releaseId','releases'))):
                found.append(path.name)
            if plan.get('stagingCutover') or plan.get('sourceCommit') != identity[0] or plan.get('sandboxesCommit') != identity[1]:
                continue
            if (record.get('result') == 'pass' and (read(path / 'push.json') or {}).get('image') == identity[2]
                    and (not plan.get('cutover') or progress.get('cutoverPrepared'))):
                found.append(path.name)
            elif record.get('result') == 'current':
                old=plan.get('current') or {}
                build=read(path / 'build.json') or {}
                # The actual builder proved identical filesystem AND configuration. A bare
                # finish flag cannot extend acceptance to another executable or failed run.
                identical=(build.get('lane')=='none' and build.get('changedCount')==0 and build.get('configChanged') is False)
                same=all(old.get(k)==wanted.get(k) for k in ('image','releaseId','releases'))
                if identical and same and provenance(old,seen|{identity}):
                    found.append(path.name)
        return found
    accepted=provenance(current)
    need(accepted and native_baseline, 'production has no completed acceptance receipt for its native baseline and current release')
    need(inspect(MAIN)['Config'].get('Labels', {}).get('org.merv.native-git-protocol') == '1',
         'production Main is not native compatible')
    live = Step(Path('/unused'), {}).pins()
    need(live['releases'] == live['fileReleases'] == current['releases'] and
         live['mainReleaseId'] == live['fileReleaseId'] == current['releaseId'], 'production pins drifted')
    need(all(n['image'] == current['image'] and not n.get('rollout') for n in live['apps'].values()),
         'production accepted image drifted')
    catalog = json.loads(env_of(CONTROL)[CATALOG])
    source = [e for e, rid in zip(catalog, release_ids(catalog)) if rid == current['releaseId']]
    need(len(source) == 1 and source[0]['image_digest'] == current['image'].split('@')[1], 'accepted catalog entry missing')
    entries = [{**source[0], 'provider': p} for p in STAGING_PROVIDERS]
    return {'current': current, 'acceptedRun': sorted(accepted)[-1], 'entries': entries,
            'releases': dict(zip(STAGING_PROVIDERS, release_ids(entries)))}


def staging_provider_census(database_reader=None, status_reader=None, inventory_reader=None):
    database_reader = database_reader or main_read
    status_reader = status_reader or native
    inventory_reader = inventory_reader or (lambda provider: sbx(MERV_PROVIDER=provider, MERV_INVENTORY='1'))
    # Every staging provider object counts, including owners unknown to Main and pending bootstrap.
    row = database_reader("SELECT count(*)::int AS n FROM public.sandboxes WHERE provider = ANY($1::text[]) "
                    "AND state NOT IN ('stopped','deleted','failed')", list(STAGING_PROVIDERS), url='SANDBOXES_DATABASE_URL')
    launches = database_reader("SELECT count(*)::int AS n FROM public.runtime_bootstraps b JOIN public.sandboxes s "
                        "ON s.id=b.sandbox_id AND s.namespace=b.namespace WHERE s.provider = ANY($1::text[]) "
                        "AND b.state='pending' AND b.expires_at > now()",
                        list(STAGING_PROVIDERS), url='SANDBOXES_DATABASE_URL')
    need(row['n'] == launches['n'] == 0, 'staging provider ownership is not empty')
    for provider in STAGING_PROVIDERS:
        status = status_reader(provider)
        health = status.get('health') or {}
        counts = health.get('instances')
        fields = {'active', 'assigned', 'healthy', 'stopped', 'failed', 'scheduling', 'starting'}
        need(isinstance(counts, dict) and set(counts) == fields and
             all(type(n) is int and n >= 0 for n in counts.values()),
             'staging provider instance counters are malformed or unknown')
        # Cloudflare defines active + assigned as live DO-bound placements. The observed healthy
        # summary can be positive with a completely empty native inventory; it cannot certify
        # ownership either way. Require the concrete full inventory below, not a guessed meaning.
        need(status.get('rollout') is None and health.get('errors') == [] and
             all(counts[key] == 0 for key in fields - {'healthy'}),
             'staging provider instances are not confirmed empty')
        inventory = inventory_reader(provider)
        need(isinstance(inventory, dict) and inventory.get('liveEmpty') is True and
             type(inventory.get('instances')) is int and inventory['instances'] == 0 and
             type(inventory.get('assignedObjects')) is int and inventory['assignedObjects'] == 0 and
             type(inventory.get('durableObjects')) is int and inventory['durableObjects'] >= 0 and
             type(inventory.get('dormantObjects')) is int and inventory['dormantObjects'] == inventory['durableObjects'] and
             type(inventory.get('pages')) is int and 1 <= inventory['pages'] <= 100,
             'staging provider native inventory is not confirmed empty')
    return {'drained': True, 'readOnly': True}


def ordinary_staging(arg):
    """Reserve the whole ordinary propagation, including remote provider deployment. A crash
    keeps the marker; only the same production run may resume after its driver lease expires."""
    action, run_id = arg['action'], arg['run']
    need(action in ('begin', 'touch', 'drain', 'switch', 'finish'), 'invalid staging propagation action')
    need(re.fullmatch(r'[0-9TZ-]+-[0-9a-f]{8}', run_id), 'invalid production run')
    name = 'ordinary-' + run_id
    HOME.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory = HOME / name
    with MAINTENANCE.open('a') as maintenance, (HOME / 'lock').open('a') as lock:
        need(locked(maintenance, 1200) and locked(lock, 1200), 'staging maintenance is busy')
        need(not RECOVERY_PENDING.exists(), 'staging recovery is pending')
        need(not main_release_running(), 'staging Main release is running')
        if action == 'begin':
            need(not owner() or owner() == name, 'staging is owned by ' + owner())
            directory.mkdir(mode=0o700, exist_ok=True)
            expected = {'image': arg['image'], 'releases': arg['releases']}
            before = read(directory / 'target.json')
            need(not before or before == expected, 'ordinary staging target changed')
            atomic(directory / 'target.json', json.dumps(expected).encode())
            claim(name)
            (directory / 'finish.json').unlink(missing_ok=True)
        need(owner() == name, 'ordinary staging propagation does not own staging')
        with leased(directory, arg['driver']), authorized(name):
            if action == 'drain':
                return work_drain(arg['seconds'])
            if action == 'switch':
                target = read(directory / 'target.json')['releases']
                need(arg['releases'] and all(target.get(p) == rid for p, rid in arg['releases'].items()),
                     'ordinary staging pins differ from reserved target')
                return staging(arg['releases'], maintenance_held=True)
            if action == 'finish':
                unhold()
                atomic(directory / 'finish.json', b'{"result":"pass"}')
                (HOME / 'active').unlink()
                return {'finished': True}
            return {'reserved': True}


def unowned_staging(action):
    """Compatibility commands cannot enter a reserved flow, including during PREPARED."""
    HOME.mkdir(mode=0o700, parents=True, exist_ok=True)
    with MAINTENANCE.open('a') as maintenance, (HOME / 'lock').open('a') as lock:
        need(locked(maintenance, 1200) and locked(lock, 1200), 'staging maintenance is busy')
        need(not RECOVERY_PENDING.exists(), 'staging recovery is pending')
        require_owner()
        return action()


def verify_catalog_recovery(journal):
    current = journal['source']['current']
    need(not main_release_running(), 'a Main release is running during catalog recovery')
    need((read(HOME / 'state.json') or {}).get('current') == current, 'accepted production state changed')
    need(all(inspect(c)['Image'] == image for c, image in journal['images'].items()),
         'production reader image changed during catalog recovery')
    verify_production_pair(current)


def verify_production_pair(current):
    expected = [current['releaseId'], current['releases']]
    need(pins(env_of(MAIN)) == pins(file_env(ENV.read_bytes())) == expected,
         'production pins changed during staging catalog/propagation recovery')
    apps = [native(p) for p in current['releases']]
    need(all(n['image'] == current['image'] and not n.get('rollout') for n in apps),
         'production hosted image changed during staging catalog/propagation recovery')


ISOLATION = Path('/var/lib/merv-fleet-pilot/staging-isolation/accepted.json')
STAGING_APPS = {'cloudflare-fleet-staging': 'a03c1f13-92c1-46c7-a246-17c9304c0f21',
                'cloudflare-fleet-staging-large': 'a03d8ea0-6914-4a7c-9f45-08e25da4a6ab'}


def reader_read(query, *params, **flags):
    """Read-only one-shot on the reader's actual image/networks, including stopped readers."""
    need(not flags.get('write'), 'ephemeral reader is read-only')
    effective=env_of(MAIN)
    effective.pop('MERV_W',None)
    effective.update(MERV_URL=flags.get('url','MERV_DB_URL'),MERV_Q=query,MERV_P=json.dumps(params))
    info=reader_info(MAIN)
    networks=list(info.get('NetworkSettings',{}).get('Networks',{})) or ['sandboxes_default']
    return json.loads(run(['docker','run','--rm',*[part for n in networks for part in ('--network',n)],
                           '-w','/app',*[part for k in effective for part in ('-e',k)],
                           '--entrypoint','node',info['Image'],'--input-type=module','-e',MAIN_READ],
                          env=dict(os.environ,**effective)))


def isolated_read(query, *params, **flags):
    need(flags.get('url') == 'SANDBOXES_DATABASE_URL' and not flags.get('write'), 'isolated reader is Sandboxes read-only')
    return reader_read(query,*params,**flags)


def isolated_probe(provider, inventory=False):
    need(provider in STAGING_APPS, 'not a staging app')
    effective = env_of(CONTROL)
    effective.update(MERV_PROVIDER=provider, MERV_INVENTORY='1' if inventory else '')
    source = globals().get('_STAGING_PROBE') or Path(__file__).with_name('hosted-sandboxes-probe.mjs').read_bytes()
    return json.loads(run(['docker', 'run', '--rm', '-i', '--network', 'sandboxes_default',
                           '-w', '/opt/sandboxes/typescript', *[part for key in effective for part in ('-e', key)],
                           '--entrypoint', 'node', reader_info(CONTROL)['Image'], '--import', 'tsx', '--input-type=module', '-'],
                          payload=source, env=dict(os.environ, **effective), timeout=60))


def isolated_census():
    return staging_provider_census(isolated_read, isolated_probe, lambda p: isolated_probe(p, True))


def isolation_identity(binding_override=None):
    need(ISOLATION.is_file() and not ISOLATION.is_symlink() and
         ISOLATION.stat().st_uid == 0 and ISOLATION.stat().st_mode & 0o077 == 0,
         'root-private isolated staging acceptance is missing')
    binding = binding_override or read(ISOLATION)
    need(binding.get('phase') == 'destination-enabled' and binding.get('apps') == STAGING_APPS,
         'staging controller handoff is incomplete')
    need(binding.get('sourceRelinquished') is True and binding.get('restoreRehearsal') and
         binding.get('historySha256') and binding.get('relay'), 'missing isolation preservation proof')
    live = env_of(MAIN)
    need(live.get('MERV_TS_DB_SCHEMA') == 'merv_ts_staging', 'not staging Main')
    for service in (MAIN, CONTROL):
        effective = env_of(service)
        need(effective.get('SANDBOXES_DATABASE_URL') == live.get('SANDBOXES_DATABASE_URL') and
             effective.get('SANDBOXES_VAULT_KEY') == live.get('SANDBOXES_VAULT_KEY'),
             'staging readers disagree on database or vault')
        providers = json.loads(effective['SANDBOXES_PROVIDERS'])
        need({p['name'] for p in providers} == set(STAGING_APPS) and all(p['settings']['application_id'] == STAGING_APPS[p['name']] for p in providers), 'staging provider/app set changed')
        need(reader_info(service)['Image'] == binding['images'][service], 'isolated reader image changed')
    db = isolated_read("SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid, "
                   "current_user AS role,inet_server_addr()::text AS address,inet_server_port() AS port",
                   url='SANDBOXES_DATABASE_URL')
    need(db == binding['database'] and db['database'] == 'sandboxes_staging', 'isolated database identity changed')
    need(live.get('MERV_SANDBOXES_PUBLIC_ORIGIN') == binding['publicOrigin'] and
         binding['publicOrigin'] != 'https://sandboxes.rapidreview.io', 'staging public origin changed')
    return binding


def isolated_staging_gateway(arg):
    """Everything except accepted-image discovery stays on the staging host. Never fallback."""
    need(arg['action'] in ('identity', 'catalog', 'recover-catalog', 'native', 'census'), 'invalid local gateway action')
    HOME.mkdir(mode=0o700, parents=True, exist_ok=True)
    with MAINTENANCE.open('a') as maintenance, (HOME / 'lock').open('a') as lock:
        need(locked(maintenance, 1200) and locked(lock, 1200), 'staging owner is busy')
        need(not RECOVERY_PENDING.exists() and not main_release_running(), 'staging recovery/release is active')
        recovery_name=arg.get('run','')
        need(not recovery_name or re.fullmatch(r'[0-9TZ-]+-[0-9a-f]{8}-staging',recovery_name), 'invalid recovery run')
        with reader_recovery(RUNS / recovery_name / 'local-catalog'):
            binding = isolation_identity()
            if arg['action'] == 'identity':
                return binding
            name = arg.get('run', '')
            need(re.fullmatch(r'[0-9TZ-]+-[0-9a-f]{8}-staging', name), 'invalid local staging run')
            need(owner() == name, 'local hosted run does not own staging')
            plan = read(RUNS / name / 'plan.json') or {}
            need(plan.get('isolatedStaging') and plan.get('isolation') == binding and
                 plan.get('stagingSource') == arg.get('source'), 'local source or isolation binding changed')
            source = arg['source']
            directory = RUNS / name / 'local-catalog'
            journal = read(directory / 'intent.json')
            recovering = arg['action'] == 'recover-catalog'
            if recovering:
                # No intent or external-effect marker means there is nothing to repair.
                # Never create a fresh catalog from this pre-drain entry point.
                if not journal or not (directory / 'reader-target.json').exists():
                    return {'recovered': False}
                need((directory / 'reader-originals.json').is_file(), 'catalog reader recovery metadata missing')
                need(env_of(MAIN).get('MERV_BOOT_MAINTENANCE') == '1' and
                     file_env(ENV.read_bytes()).get('MERV_BOOT_MAINTENANCE') == '1',
                     'catalog recovery requires preserved boot maintenance')
                # The ordinary drain/HTTP health checks run AFTER repair. In the missing-name
                # gap use the exact saved image for read-only Main and native ownership census.
                Step(RUNS / name, plan).staging_census(database_reader=reader_read)
            if arg['action'] == 'native':
                need(arg.get('provider') in STAGING_PROVIDERS, 'not a staging app')
                return isolated_probe(arg['provider'])
            isolated_census()
            if arg['action'] == 'census':
                return {'drained': True, 'readOnly': True, 'isolation': binding}
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            journal = read(directory / 'intent.json')
            if journal:
                need(journal['source'] == source and journal['isolation'] == binding, 'local catalog intent changed')
            else:
                before = SHARED.read_bytes()
                atomic(directory / 'original.env', before)
                target = before
                for entry in source['entries']:
                    need(entry['provider'] in STAGING_PROVIDERS, 'non-staging catalog entry')
                    target, _ = with_release(target, entry)
                atomic(directory / 'target.env', target)
                atomic(directory / 'intent.json', json.dumps({'source': source, 'isolation': binding,
                       'before': sha(before), 'target': sha(target)}).encode())
                journal = read(directory / 'intent.json')
            target = (directory / 'target.env').read_bytes()
            need(sha(target) == journal['target'] and sha(SHARED.read_bytes()) in (journal['before'], journal['target']),
                 'local catalog files drifted')
            # An interrupted reader recreation always rolls forward to the same durable target.
            Step(directory, {}).sandboxes_file(network_none=True)[1](target)
            need(isolation_identity() == binding, 'isolation changed during catalog apply')
            atomic(directory / 'complete.json', json.dumps({'target': journal['target']}).encode())
            return {'entries': source['entries'], 'releases': source['releases'], 'isolation': binding, **({'recovered': True} if recovering else {})}

def staging_gateway(arg):
    need(os.geteuid() == 0, 'run as root')
    if arg.get('isolated'):
        return isolated_staging_gateway(arg)
    action = arg['action']
    need(action == 'source' or not Path('/var/lib/merv-fleet-pilot/staging-isolation/relinquished.json').exists(), 'staging apps were handed off; use isolated staging mode')
    need(action in ('source', 'catalog', 'native', 'census'), 'invalid staging gateway action')
    HOME.mkdir(mode=0o700, parents=True, exist_ok=True)
    with MAINTENANCE.open('a') as maintenance, (HOME / 'lock').open('a') as lock:
        need(locked(maintenance, 1200) and locked(lock, 1200), 'production maintenance lock is busy')
        need(not RECOVERY_PENDING.exists(), 'production recovery is pending')
        name = arg.get('run')
        if name:
            need(re.fullmatch(r'[0-9TZ-]+-[0-9a-f]{8}-staging', name), 'invalid staging run')
        directory = HOME / 'staging-catalog' / name if name else None
        if owner():
            need(name and owner() == name and directory.is_dir(),
                 'production release or another catalog repair is in progress')
            journal = read(directory / 'recovery.json')
            need(journal and journal['source'] == arg.get('source'), 'catalog recovery owner/source mismatch')
            verify_catalog_recovery(journal)
            target = directory / 'catalog.target'
            if target.exists():
                # An owned write may have stopped after either reader. Finish that exact target;
                # never require the readers to agree before completing the recorded transaction.
                staging_provider_census()
                quiet(900)
                Step(directory, {}).sandboxes_file()[1](target.read_bytes())
            need(staging_source(name) == journal['source'], 'production source changed during catalog recovery')
            (HOME / 'active').unlink()
        source = staging_source()
        if action == 'source':
            return source
        need(source == arg.get('source'), 'accepted production source changed; preserve staging fence')
        if action == 'native':
            for raw in (env_of(CONTROL)[CATALOG], env_of(MAIN)[CATALOG], env_value(SHARED.read_bytes(), CATALOG)):
                held = json.loads(raw)
                need(all(entry in held for entry in source['entries']), 'prepared staging catalog changed')
            need(arg.get('provider') in STAGING_PROVIDERS, 'not a staging provider')
            return native(arg['provider'])
        staging_provider_census()
        if action == 'census':
            return {'drained': True, 'readOnly': True}
        served = {p['name'] for p in json.loads(env_of(CONTROL)['SANDBOXES_PROVIDERS'])}
        need(set(STAGING_PROVIDERS) <= served, 'both staging providers must be configured')
        # Keep the accepted source and durable secret backup under a separate staging catalog run.
        need(name, 'catalog requires a staging run')
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        existing = read(directory / 'source.json')
        need(not existing or existing == source, 'staging catalog source changed')
        atomic(directory / 'source.json', json.dumps(source).encode())
        journal = {'source': source, 'images': {c: inspect(c)['Image'] for c in (CONTROL, MAIN)}}
        atomic(directory / 'recovery.json', json.dumps(journal).encode())
        claim(name)
        verify_catalog_recovery(journal)
        result = Step(directory, {'cutover': True, 'stagingCatalog': True, 'drainSeconds': 900}).add_releases(
            {'entries': source['entries'], 'releases': source['releases'],
             'protect': [source['current']['image'].split('@')[1]]}, directory / 'catalog.before')
        need(staging_source(name) == source, 'production source changed during catalog update')
        (HOME / 'active').unlink()
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
    # On the staging host: `staging '<releases>'` switches staging Main; `staging-drain '<seconds>'`
    # holds its work machines and waits, bounded, until none is up, before its apps are replaced;
    # `staging-unhold` lifts that hold when they were not.
    STAGING = {'staging-gateway': lambda a: staging_gateway(json.loads(a)),
               'staging-flow': lambda a: ordinary_staging(json.loads(a)),
               'staging': lambda a: unowned_staging(lambda: staging(json.loads(a), maintenance_held=True)),
               'staging-drain': lambda a: unowned_staging(lambda: work_drain(int(a))),
               'staging-unhold': lambda _: unowned_staging(lambda: unhold() or {'lifted': True})}
    if sys.argv[1:2] and sys.argv[1] in STAGING:
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        os.umask(0o077)
        try:
            print(json.dumps(STAGING[sys.argv[1]](sys.argv[2] if len(sys.argv) > 2 else None)), flush=True)
        except Exception as error:
            print(json.dumps({'error': str(error)[-1500:]}), flush=True)
            sys.exit(1)
    else:
        main()
