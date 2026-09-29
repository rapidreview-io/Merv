#!/usr/bin/env python3
"""Offline deployment recovery. No application imports or provider/job reconciliation."""
import argparse
import base64
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

IDENT = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,62}$')
SNAP = re.compile(r'^\d{8}T\d{6}Z-[0-9a-f]{32}$')
PAYLOADS = ('database.dump', 'code.tar')


class Failure(Exception):
    pass


def require(ok, message):
    if not ok:
        raise Failure(message)


def durable_json(path, value):
    path = Path(path)
    with open(str(path) + '.next', 'w', opener=lambda p, f: os.open(p, f, 0o600)) as out:
        json.dump(value, out, sort_keys=True)
        out.flush()
        os.fsync(out.fileno())
    os.replace(str(path) + '.next', path)
    sync_dir(path.parent)


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return {'bytes': Path(path).stat().st_size, 'sha256': h.hexdigest()}


@contextlib.contextmanager
def locked(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Failure('maintenance or snapshot operation already running') from None
        yield


class Recovery:
    def __init__(self, config):
        self.c = config
        require(IDENT.fullmatch(config['schema']), 'invalid schema')
        require(re.fullmatch(r'[A-Za-z0-9_-]{1,64}', config['deployment']), 'invalid deployment')
        self.root = Path(config['code_root']).resolve()
        self.state = Path(config['state_dir']).resolve()
        self.staging = Path(config['staging_dir']).resolve()
        for path in (self.state, self.staging):
            require(path != self.root and self.root not in path.parents, 'staging/state must be outside Code')
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
            require(path.stat().st_mode & 0o077 == 0, 'state/staging directory must be private')
        self.resume = self.state / 'resume.json'
        self.verification_record = self.state / 'verification.json'
        self.maintenance = config.get('maintenance_lock', '/run/lock/merv-maintenance.lock')
        self.timeout = config.get('timeout_seconds', 1800)
        self.keep = config.get('keep', 3)
        require(isinstance(self.keep, int) and self.keep >= 2, 'keep must be at least two')
        self.store = config['store']
        if 'directory' in self.store:
            self.bucket = Path(self.store['directory']).resolve() / 'recovery-v2' / config['deployment']
            self.bucket.mkdir(parents=True, exist_ok=True, mode=0o700)
        else:
            url = self.store['url'].rstrip('/')
            require(re.fullmatch(r's3://[a-z0-9][a-z0-9.-]+/recovery-v2/' + re.escape(config['deployment']), url),
                    'store URL must end in recovery-v2/<deployment>')
            self.bucket = url
            endpoint = self.store.get('endpoint', '')
            require(not endpoint or re.fullmatch(r'https://[A-Za-z0-9.-]+(?::\d+)?', endpoint), 'invalid storage endpoint')

    def run(self, args, data=None, output=None, env=None, source=None):
        # Never return child stderr: PostgreSQL/AWS errors can contain private connection data.
        clean = {k: v for k, v in os.environ.items() if not (args[0] == 'git' and k.startswith('GIT_'))}
        clean.update(env or {})
        try:
            p = subprocess.run(args, input=data, stdin=source, stdout=output or subprocess.PIPE,
                               stderr=subprocess.PIPE, timeout=self.timeout, env=clean, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise Failure('operational command unavailable or timed out') from None
        require(p.returncode == 0, 'operational command failed (details suppressed)')
        return p.stdout if output is None else b''

    def pg(self, tool, args):
        db = self.c['database']
        return db.get('command_prefix', []) + [tool] + db.get('args', []) + ['-U', db['user']] + args

    def sql(self, sql, database=None):
        db = database or self.c['database']['name']
        args = self.pg('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db])
        return self.run(args, data=('BEGIN READ ONLY;\nSET LOCAL statement_timeout=\'30s\';\n' + sql + '\nCOMMIT;').encode()).decode().strip()

    def exists(self, table, database=None):
        return self.sql("SELECT to_regclass('\"%s\".\"%s\"') IS NOT NULL;" % (self.c['schema'], table), database) == 't'

    def idle(self):
        schema = self.c['schema']
        for table, condition in (
            ('worker_sessions', "status IN ('offered','active')"),
            ('session_workspaces', f"result_json IS NULL AND EXISTS (SELECT 1 FROM \"{schema}\".worker_sessions s WHERE s.id=session_workspaces.session_id AND NOT (COALESCE(s.session_json::jsonb #>> '{{execution,policy,readOnly}}','false')='true' AND COALESCE(s.session_json::jsonb #>> '{{execution,policy,workspace,mode}}','none')='ephemeral' AND COALESCE(s.session_json::jsonb #>> '{{execution,policy,workspace,retain}}','false')='false'))"),
            ('fleet_allocations', "phase <> 'released'"),
            ('code_bases', "state='running' OR check_state IN ('queued','running') OR check_job_json IS NOT NULL"),
            ('code_units', "writer_state IN ('reserved','active','closing')"),
            ('pi_commands', "status IN ('waiting','starting','working','saving')"),
            ('managed_compute_runs', "state NOT IN ('completed','failed','cancelled')"),
            ('code_publications', 'lock_id IS NOT NULL'),
        ):
            if table in self.c.get('idle_tables', ['worker_sessions', 'session_workspaces', 'fleet_allocations', 'code_bases', 'code_units', 'pi_commands', 'managed_compute_runs', 'code_publications']):
                require(self.exists(table), 'configured idle census table missing')
                require(self.sql(f'SELECT count(*) FROM "{schema}"."{table}" WHERE {condition};') == '0',
                        'active work: snapshot skipped; previous recovery points unchanged')

    def inventory(self, root, database=None):
        schema = self.c['schema']
        require(self.exists('code_projects', database), 'Code schema is not initialized')
        rows = json.loads(self.sql(f"SELECT COALESCE(json_agg(json_build_object('project',project_id,'repository',repository_id,'hosted',store_json IS NOT NULL) ORDER BY project_id),'[]'::json) FROM \"{schema}\".code_projects;", database))
        repos = []
        checked = set()
        by_key = {hashlib.sha256(r['project'].encode()).hexdigest()[:32]: r for r in rows}
        for row in rows:
            directory = root / hashlib.sha256(row['project'].encode()).hexdigest()[:32]
            require(not row['hosted'] or (directory / 'repository.git').is_dir(), 'hosted repository missing')
        for directory in sorted(root.iterdir()):
            if not directory.is_dir() or not re.fullmatch('[0-9a-f]{32}', directory.name):
                continue
            repo = directory / 'repository.git'
            if not repo.exists():
                continue
            marker = json.loads((directory / 'merv-project.json').read_text())
            row = by_key.get(directory.name)
            require(hashlib.sha256(str(marker.get('projectId', '')).encode()).hexdigest()[:32] == directory.name, 'repository identity mismatch')
            require(row is None or marker.get('projectId') == row['project'], 'repository identity mismatch')
            valid_v1 = marker.get('format') == 1 and list(marker) == ['format', 'projectId', 'repositoryId'] and isinstance(marker.get('repositoryId'), str)
            valid_v2 = marker.get('format') == 2 and set(marker) == {'format', 'projectId', 'repositoryIds'} and isinstance(marker.get('repositoryIds'), list) and all(isinstance(v, str) for v in marker['repositoryIds'])
            require(isinstance(marker.get('projectId'), str) and (valid_v1 or valid_v2), 'unsupported repository identity')
            identities = marker.get('repositoryIds', [marker.get('repositoryId')])
            require(row is None or row['repository'] in identities, 'repository binding mismatch')
            env = {'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_DIR': str(repo)}
            # Disable lazy object fetch and replace refs; verification cannot use a remote.
            env.update({'GIT_NO_LAZY_FETCH': '1', 'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_ALLOW_PROTOCOL': ''})
            require(not (repo / 'objects/info/alternates').exists(), 'repository borrows external objects')
            refs = self.run(['git', 'for-each-ref', '--format=%(refname) %(objectname)'], env=env).decode().splitlines()
            require(not (repo / 'hooks').exists() or not list((repo / 'hooks').iterdir()), 'repository contains hooks')
            # Match CodeRepositories.validate; do not certify a store Code will refuse to open.
            controlled = {'core.bare': 'true', 'core.fsync': 'all', 'core.fsyncmethod': 'fsync', 'core.logallrefupdates': 'false', 'gc.auto': '0', 'transfer.fsckobjects': 'true'}
            incidental = {'core.repositoryformatversion', 'core.filemode', 'core.ignorecase', 'core.precomposeunicode', 'core.symlinks', 'extensions.objectformat'}
            entries = [entry.partition('\n')[::2] for entry in self.run(['git', 'config', '--no-includes', '--file', str(repo / 'config'), '--list', '-z'], env=env).decode().split('\0') if entry]
            require(all(key in incidental or controlled.get(key) == value for key, value in entries) and set(controlled) <= {key for key, _ in entries}, 'repository configuration is not Code-owned')
            self.run(['git', 'fsck', '--full', '--strict', '--no-dangling'], env=env)
            if row is not None:
                self.promises(root, row['project'], dict(x.split(' ', 1) for x in refs), env, database)
                checked.add(row['project'])
            repos.append({'directory': directory.name, 'marker': marker, 'refs': refs})
        for row in rows:
            if row['project'] not in checked:
                # Bound external-only projects may have no local store, but pending imports
                # and other durable promises must still be checked when the directory is lost.
                self.promises(root, row['project'], {}, {'GIT_DIR': str(root / hashlib.sha256(row['project'].encode()).hexdigest()[:32] / 'repository.git')}, database)
        return {'projects': rows, 'repositories': repos}

    def promises(self, root, project, refs, env, database):
        schema = self.c['schema']
        # project IDs come from our DB but still quote literals rather than interpolate SQL.
        quoted = project.replace("'", "''")
        def rows(table):
            require(self.exists(table, database), 'Code recovery table missing')
            return json.loads(self.sql(f"SELECT COALESCE(json_agg(t),'[]'::json) FROM \"{schema}\".{table} t WHERE project_id='{quoted}';", database))
        def body(value):
            return json.loads(value) if isinstance(value, str) else value or {}
        def commit(oid):
            require(isinstance(oid, str) and re.fullmatch('[0-9a-f]{40}|[0-9a-f]{64}', oid), 'invalid stored commit')
            require(self.run(['git', 'cat-file', '-t', oid], env=env).strip() == b'commit', 'stored commit missing')
        def work(unit):
            encode = '..' in unit or unit.endswith(('.', '.lock')) or unit.startswith('encoded-') or not re.fullmatch('[A-Za-z0-9_][A-Za-z0-9_.-]*', unit)
            return 'refs/merv/work/' + ('encoded-' + base64.urlsafe_b64encode(unit.encode()).decode().rstrip('=') if encode else unit)
        projects = rows('code_projects')
        store = body(projects[0].get('store_json'))
        main = body(projects[0].get('main_json'))
        if store:
            commit(store['rootOid'])
        if main.get('stored'):
            commit(main['oid'])
        expected = {}
        stored_bindings = {}
        for op in rows('code_operations'):
            payload, progress, result = (body(op.get(k)) for k in ('payload_json', 'progress_json', 'result_json'))
            if op['kind'] == 'local_bind' and op['status'] == 'completed' and result.get('main', {}).get('stored'):
                stored_bindings[op['id']] = result['main']['oid']
            if op['kind'] not in ('import', 'upload', 'accept-ref'):
                continue
            if op['status'] == 'completed':
                if result.get('head'):
                    commit(result['head'])
                if result.get('receiptRef'):
                    require(refs.get(result['receiptRef']) == result['head'], 'completed receipt missing')
            elif op['status'] == 'prepared':
                phase = op.get('phase')
                require(phase in ('receiving', 'admitting', 'objects_durable', 'refs_applied'), 'unsupported recovery phase')
                if phase == 'receiving':
                    continue
                target, receipt = progress.get('target'), progress.get('receiptRef')
                unit = payload.get('unitId')
                branch = work(unit) if payload.get('source') == 'upload' else None
                if phase == 'admitting':
                    bundle = root / hashlib.sha256(project.encode()).hexdigest()[:32] / 'quarantine' / op['id'] / 'bundle'
                    require((bundle.parents[2] / 'repository.git').is_dir() and bundle.is_file(), 'admitting operation lost retained bundle or repository')
                    if payload.get('bundle'):
                        require(digest(bundle) == payload['bundle'], 'retained bundle checksum mismatch')
                    require(refs.get(receipt) is None, 'admitting operation has premature receipt')
                    if branch:
                        require(refs.get(branch) == progress.get('expectedOld'), 'admitting work ref mismatch')
                        expected[unit] = progress.get('expectedOld')
                else:
                    commit(target)
                    applied = refs.get(receipt) == target
                    require(applied or (phase == 'objects_durable' and refs.get(receipt) is None), 'journal receipt mismatch')
                    if branch:
                        expected[unit] = target if applied else progress.get('expectedOld')
                        require(refs.get(branch) == expected[unit], 'journal work ref mismatch')
        for unit in rows('code_units'):
            head = unit.get('head_oid')
            if head:
                commit(head)
                actual = refs.get(work(unit['unit_id']))
                if unit['unit_id'] in expected:
                    require(actual == expected[unit['unit_id']], 'pending unit ref mismatch')
                else:
                    require(actual == head or (actual is None and head == body(unit.get('base_json')).get('reference')), 'unit ref differs from stored head')
            accepted = body(unit.get('acceptance_json'))
            # A locally admitted head/acceptance promises its immutable base too. A
            # historical external-only pin alone does not promise hosted objects.
            base = body(unit.get('base_json'))
            pinned_main = base.get('main') or {}
            local_main = stored_bindings.get(pinned_main.get('operationId'))
            if local_main:
                require(pinned_main.get('oid') == local_main, 'pinned Main binding mismatch')
                commit(local_main)
            if base and (head or accepted.get('storage') == 'code' or (local_main and base.get('kind') == 'main')):
                commit(base['reference'])
            if accepted.get('storage') == 'code':
                commit(accepted['code']['commit'])
        if self.exists('code_review_acceptances', database):
            for row in rows('code_review_acceptances'):
                accepted = body(row.get('acceptance_json'))
                if accepted.get('storage') == 'code':
                    commit(accepted['code']['commit'])
        if self.exists('code_bases', database):
            for row in rows('code_bases'):
                if row.get('state') == 'resolved':
                    result = body(row.get('result_json'))
                    commit(result['commit'])
                    require(refs.get('refs/merv/bases/' + row['base_key']) == result['commit'], 'resolved base ref missing')

    def container(self):
        raw = self.run(['docker', 'inspect', '--format', '{{json .}}', self.c['container']])
        return json.loads(raw)

    def recover(self):
        if not self.resume.exists():
            self.cleanup_verifier()
            return
        record = json.loads(self.resume.read_text())
        require(record['deployment'] == self.c['deployment'] and record['container'] == self.c['container'], 'resume identity mismatch')
        current = self.container()
        require(current['Id'] == record['id'] and current['Image'] == record['image'], 'container replaced while capture was stopped')
        if record['running']:
            if not current['State']['Running']:
                self.run(['docker', 'start', self.c['container']])
            deadline = time.monotonic() + self.c.get('health_timeout_seconds', 180)
            while True:
                state = self.container()['State']
                if state.get('Health', {}).get('Status') == 'healthy':
                    break
                require(time.monotonic() < deadline, 'restart health failed; resume record retained')
                time.sleep(1)
        self.resume.unlink()
        sync_dir(self.state)
        self.cleanup_verifier()

    def cleanup_verifier(self):
        if not self.verification_record.exists():
            return
        record = json.loads(self.verification_record.read_text())
        name = record['container']
        require(record['deployment'] == self.c['deployment'] and re.fullmatch('merv-verify-[0-9a-f]{32}', name), 'verification cleanup identity mismatch')
        listed = self.run(['docker', 'ps', '--all', '--filter', 'name=^/' + name + '$', '--format', '{{.Names}}']).decode().strip()
        if listed:
            require(listed == name, 'verification cleanup container mismatch')
            self.run(['docker', 'rm', '--force', name])
        self.verification_record.unlink()
        sync_dir(self.state)

    def stopped_capture(self, work):
        with locked(self.maintenance):
            self.recover()
            hosted = Path(self.c.get('hosted_marker', '/var/lib/merv-fleet-pilot/hosted-release/active'))
            require(not hosted.exists() or not hosted.read_text().strip(), 'hosted release owns Main; retry after it closes')
            self.idle()
            before = self.container()
            record = {'deployment': self.c['deployment'], 'container': self.c['container'],
                      'id': before['Id'], 'image': before['Image'], 'running': before['State']['Running']}
            durable_json(self.resume, record)
            try:
                if record['running']:
                    self.run(['docker', 'stop', '--time', str(self.c.get('stop_seconds', 60)), self.c['container']])
                after = self.container()
                require(not after['State']['Running'], 'control writer still running')
                require(not record['running'] or after['State']['ExitCode'] == 0, 'control did not stop cleanly')
                # Catch work that started after the first census; never certify that race.
                self.idle()
                return work(record)
            finally:
                self.recover()

    def transfer(self, direction, snapshot, name, local=None):
        require(SNAP.fullmatch(snapshot) and name in (*PAYLOADS, 'COMPLETE.json'), 'invalid object key')
        if isinstance(self.bucket, Path):
            path = self.bucket / snapshot / name
            if direction == 'put':
                path.parent.mkdir(exist_ok=True, mode=0o700)
                require(not path.exists(), 'immutable object already exists')
                with open(local, 'rb') as source, open(path, 'xb') as target:
                    shutil.copyfileobj(source, target)
                    target.flush()
                    os.fsync(target.fileno())
                sync_dir(path.parent)
            elif direction == 'get':
                shutil.copyfile(path, local)
            else:
                path.unlink(missing_ok=True)
            return
        args = ['aws']
        if self.store.get('endpoint'):
            args += ['--endpoint-url', self.store['endpoint']]
        remote = f'{self.bucket}/{snapshot}/{name}'
        if direction == 'delete':
            self.run(args + ['s3', 'rm', remote, '--only-show-errors'])
        else:
            pair = [str(local), remote] if direction == 'put' else [remote, str(local)]
            self.run(args + ['s3', 'cp', *pair, '--only-show-errors'])

    def ids(self):
        if isinstance(self.bucket, Path):
            return sorted(p.name for p in self.bucket.iterdir() if p.is_dir() and SNAP.fullmatch(p.name))
        args = ['aws'] + (['--endpoint-url', self.store['endpoint']] if self.store.get('endpoint') else [])
        bucket, prefix = str(self.bucket)[5:].split('/', 1)
        result = json.loads(self.run(args + ['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', prefix + '/', '--output', 'json']))
        return sorted({item['Key'][len(prefix) + 1:].split('/')[0] for item in result.get('Contents', [])
                       if SNAP.fullmatch(item['Key'][len(prefix) + 1:].split('/')[0])})

    def manifest(self, snapshot, directory):
        file = directory / 'COMPLETE.json'
        self.transfer('get', snapshot, 'COMPLETE.json', file)
        m = json.loads(file.read_text())
        require(m.get('format') == 2 and m.get('snapshot') == snapshot and m.get('deployment') == self.c['deployment']
                and m.get('schema') == self.c['schema'], 'snapshot identity mismatch')
        require(set(m.get('payloads', {})) == set(PAYLOADS), 'incomplete snapshot manifest')
        for item in m['payloads'].values():
            require(isinstance(item.get('bytes'), int) and item['bytes'] > 0 and
                    re.fullmatch('[0-9a-f]{64}', item.get('sha256', '')), 'invalid payload receipt')
        return m

    def download(self, snapshot, directory):
        m = self.manifest(snapshot, directory)
        for name in PAYLOADS:
            self.transfer('get', snapshot, name, directory / name)
            require(digest(directory / name) == m['payloads'][name], 'snapshot payload checksum mismatch')
        return m

    def archive(self, file):
        require(self.root.is_dir(), 'Code root missing')
        with tarfile.open(file, 'w', dereference=True) as archive:
            for base, dirs, files in os.walk(self.root, followlinks=False):
                for name in sorted(dirs + files):
                    path = Path(base) / name
                    relative = path.relative_to(self.root)
                    if str(relative) == 'writer.sock':
                        continue
                    require(not path.is_symlink(), 'Code archive contains a symbolic link')
                    require(path.is_file() or path.is_dir(), 'Code archive contains a special file')
                    archive.add(path, arcname=str(relative), recursive=False)
        with open(file, 'rb') as stream:
            os.fsync(stream.fileno())

    def extract(self, file, root):
        root.mkdir(mode=0o700)
        with tarfile.open(file, 'r:') as archive:
            for member in archive:
                path = Path(member.name)
                require(not path.is_absolute() and '..' not in path.parts and member.name not in ('', '.')
                        and (member.isfile() or member.isdir()), 'unsafe archive member')
                destination = root / path
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    with archive.extractfile(member) as source, open(destination, 'xb') as target:
                        shutil.copyfileobj(source, target)
                    os.chmod(destination, member.mode & 0o777)
                    os.utime(destination, (member.mtime, member.mtime))

    @contextlib.contextmanager
    def restored_database(self, file, name=None):
        scratch = name or 'merv_recovery_' + uuid.uuid4().hex
        require(IDENT.fullmatch(scratch) and scratch != self.c['database']['name'], 'invalid restore database')
        self.run(self.pg('createdb', ['--template=template0', scratch]))
        try:
            with open(file, 'rb') as stream:
                # Prefix can be docker exec: stream input, never pass a host filename inside it.
                self.run(self.pg('pg_restore', ['--exit-on-error', '--no-owner', '--no-privileges', '-d', scratch]), source=stream)
            yield scratch
        finally:
            if name is None:
                self.run(self.pg('dropdb', [scratch]))

    @contextlib.contextmanager
    def verification_database(self):
        verification = self.c['verification']
        original = self.c['database']
        container = None
        try:
            if 'database' in verification:
                self.c['database'] = verification['database']
            else:
                image = verification['image']
                require(re.fullmatch(r'[^\s]+@sha256:[0-9a-f]{64}', image), 'verification image must be pinned by digest')
                container = 'merv-verify-' + uuid.uuid4().hex
                durable_json(self.verification_record, {'deployment': self.c['deployment'], 'container': container})
                self.run(['docker', 'run', '--detach', '--rm', '--network', 'none', '--name', container,
                          '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image])
                deadline = time.monotonic() + 90
                while True:
                    try:
                        self.run(['docker', 'exec', container, 'pg_isready', '-U', 'postgres'])
                        break
                    except Failure:
                        require(time.monotonic() < deadline, 'isolated verification database did not start')
                        time.sleep(1)
                self.c['database'] = {'name': 'postgres', 'user': 'postgres', 'command_prefix': ['docker', 'exec', '-i', container]}
            yield
        finally:
            self.c['database'] = original
            if container:
                self.cleanup_verifier()

    def verify_local(self, directory, m):
        root = directory / 'checked-code'
        self.extract(directory / 'code.tar', root)
        try:
            with self.verification_database():
                with self.restored_database(directory / 'database.dump') as db:
                    require(self.inventory(root, db) == m['inventory'], 'restored database/repository inventory mismatch')
        finally:
            shutil.rmtree(root)

    def create(self):
        snapshot = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex
        with tempfile.TemporaryDirectory(prefix='capture-', dir=self.staging) as name:
            directory = Path(name)
            def capture(record):
                started = datetime.datetime.now(datetime.timezone.utc).isoformat()
                used = sum(p.stat().st_size for p in self.root.rglob('*') if p.is_file())
                db_bytes = int(self.sql('SELECT pg_database_size(current_database());'))
                require(shutil.disk_usage(self.staging).free > 2 * used + db_bytes + self.c.get('reserve_bytes', 1024 ** 3), 'insufficient recovery staging space')
                inventory = self.inventory(self.root)
                with open(directory / 'database.dump', 'wb') as out:
                    self.run(self.pg('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--schema', self.c['schema'], '-d', self.c['database']['name']]), output=out)
                    out.flush()
                    os.fsync(out.fileno())
                self.archive(directory / 'code.tar')
                return {'format': 2, 'snapshot': snapshot, 'deployment': self.c['deployment'], 'schema': self.c['schema'],
                        'capture_started_at': started, 'captured_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'image': record['image'],
                        'database_name': self.c['database']['name'], 'database_version': self.sql('SHOW server_version;'),
                        'git_version': self.run(['git', '--version']).decode().strip(),
                        'inventory': inventory, 'payloads': {n: digest(directory / n) for n in PAYLOADS}}
            m = self.stopped_capture(capture)
            self.verify_local(directory, m)
            for item in PAYLOADS:
                require(m['payloads'][item]['bytes'] <= self.c.get('max_object_bytes', 5 * 1024 ** 4), 'snapshot exceeds configured provider object limit')
                self.transfer('put', snapshot, item, directory / item)
                with tempfile.TemporaryDirectory(dir=self.staging) as check:
                    downloaded = Path(check) / item
                    self.transfer('get', snapshot, item, downloaded)
                    require(digest(downloaded) == m['payloads'][item], 'uploaded payload checksum mismatch')
            durable_json(directory / 'COMPLETE.json', m)
            self.transfer('put', snapshot, 'COMPLETE.json', directory / 'COMPLETE.json')
            with tempfile.TemporaryDirectory(dir=self.staging) as check:
                require(self.manifest(snapshot, Path(check)) == m, 'completion marker verification failed')
            durable_json(self.state / 'last-complete.json', {'snapshot': snapshot, 'completed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()})
            self.prune()
        return {'snapshot': snapshot, 'state': 'complete'}

    def verify(self, snapshot):
        with tempfile.TemporaryDirectory(dir=self.staging) as name:
            directory = Path(name)
            m = self.download(snapshot, directory)
            self.verify_local(directory, m)
        return {'snapshot': snapshot, 'state': 'verified'}

    def restore(self, snapshot, database, root):
        target = Path(root).resolve()
        require(not target.exists() and target != self.root and self.root not in target.parents, 'restore needs a new isolated Code path')
        require('restore_database' in self.c, 'restore requires explicitly configured isolated database target')
        original = self.c['database']
        require(database != original['name'], 'cannot restore the source database name')
        # Creates a NEW database; leaves failed restores for diagnosis, never destroys existing data.
        with tempfile.TemporaryDirectory(dir=self.staging) as name:
            directory = Path(name)
            m = self.download(snapshot, directory)
            self.verify_local(directory, m)
            self.extract(directory / 'code.tar', target)
            try:
                self.c['database'] = self.c['restore_database']
                with self.restored_database(directory / 'database.dump', database) as db:
                    require(self.inventory(target, db) == m['inventory'], 'restored inventory mismatch')
            finally:
                self.c['database'] = original
        return {'snapshot': snapshot, 'state': 'restored-isolated', 'database': database, 'code_root': str(target), 'activation': 'manual reconciliation required'}

    def status(self):
        file = self.state / 'last-complete.json'
        require(file.exists(), 'no complete recovery snapshot has been recorded')
        receipt = json.loads(file.read_text())
        at = datetime.datetime.fromisoformat(receipt['completed_at'])
        age = (datetime.datetime.now(datetime.timezone.utc) - at).total_seconds()
        require(-300 <= age <= self.c.get('max_age_seconds', 30 * 3600), 'recovery snapshot is stale or clock is inconsistent')
        return {**receipt, 'state': 'fresh', 'age_seconds': max(0, int(age))}

    def prune(self):
        complete = []
        with tempfile.TemporaryDirectory(dir=self.staging) as name:
            for snapshot in self.ids():
                try:
                    manifest = self.manifest(snapshot, Path(name))
                except (Failure, OSError, ValueError):
                    continue
                complete.append((manifest['captured_at'], snapshot))
        complete = [snapshot for _, snapshot in sorted(complete)]
        # Verify the recovery points we retain BEFORE deleting any older complete point.
        if len(complete) <= self.keep:
            return {'deleted': []}
        for snapshot in complete[-self.keep:]:
            self.verify(snapshot)
        deleted = []
        for snapshot in complete[:-self.keep]:
            self.transfer('delete', snapshot, 'COMPLETE.json')
            for name in PAYLOADS:
                self.transfer('delete', snapshot, name)
            if isinstance(self.bucket, Path):
                (self.bucket / snapshot).rmdir()
            deleted.append(snapshot)
        return {'deleted': deleted}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('command', choices=['create', 'verify', 'restore', 'prune', 'recover', 'status'])
    parser.add_argument('--snapshot')
    parser.add_argument('--database')
    parser.add_argument('--code-root')
    args = parser.parse_args()
    os.umask(0o077)
    config = Path(args.config)
    require(config.stat().st_mode & 0o077 == 0, 'configuration must be private')
    r = Recovery(json.loads(config.read_text()))
    if args.command == 'status':
        print(json.dumps(r.status()))
        return
    with locked(r.state / 'run.lock'):
        if args.command == 'recover':
            with locked(r.maintenance):
                r.recover()
            result = {'state': 'recovered'}
        elif args.command == 'create':
            result = r.create()
        elif args.command == 'prune':
            result = r.prune()
        else:
            require(args.snapshot and SNAP.fullmatch(args.snapshot), 'explicit snapshot ID required')
            if args.command == 'verify':
                result = r.verify(args.snapshot)
            else:
                require(args.database and args.code_root, 'restore requires new database and Code path')
                result = r.restore(args.snapshot, args.database, args.code_root)
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Exception text from tools, JSON, filesystem and providers is deliberately not printed.
        print(json.dumps({'state': 'failed', 'reason': str(error) if isinstance(error, Failure) else 'invalid or unavailable recovery input'}), file=sys.stderr)
        sys.exit(1)
