"""Real PostgreSQL/Git recovery tests; Docker and object storage remain local fixtures."""
import copy
import datetime
import importlib.util
import json
import multiprocessing
import signal
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
import uuid
from urllib.parse import urlparse, unquote

spec = importlib.util.spec_from_file_location('recovery', Path(__file__).with_name('recovery-snapshot.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def shell(args, cwd=None, data=None):
    return subprocess.check_output(args, cwd=cwd, input=data, stderr=subprocess.PIPE).decode().strip()


class Fixture(m.Recovery):
    """Only the control-container boundary is fake. Data operations are real."""
    def __init__(self, config):
        super().__init__(config)
        self.control = {'Id': 'container-one', 'Image': 'sha256:test', 'State': {'Running': True, 'ExitCode': 0, 'Health': {'Status': 'healthy'}}}
        self.starts = 0
        self.fail_upload = False
        self.stop_race = False

    def container(self):
        return copy.deepcopy(self.control)

    def run(self, args, **kwargs):
        if args[:2] == ['docker', 'stop']:
            self.control['State']['Running'] = False
            if self.stop_race:
                self.run(self.pg('psql', ['-d', self.c['database']['name'], '-c', "INSERT INTO audit.worker_sessions VALUES ('active');"]))
            return b''
        if args[:2] == ['docker', 'start']:
            self.control['State']['Running'] = True
            self.starts += 1
            return b''
        return super().run(args, **kwargs)

    def transfer(self, direction, snapshot, name, local=None):
        if self.fail_upload and direction == 'put' and name == 'code.tar':
            raise m.Failure('injected upload failure')
        return super().transfer(direction, snapshot, name, local)


@unittest.skipUnless(os.environ.get('MERV_TEST_POSTGRES_URL'), 'MERV_TEST_POSTGRES_URL required')
class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='recovery-test-')
        self.base = Path(self.temp.name)
        url = urlparse(os.environ['MERV_TEST_POSTGRES_URL'])
        self.assertIn(url.hostname, ('localhost', '127.0.0.1', '::1'), 'tests require an explicit loopback PostgreSQL cluster')
        previous_password = os.environ.get('PGPASSWORD')
        def restore_password():
            if previous_password is None:
                os.environ.pop('PGPASSWORD', None)
            else:
                os.environ['PGPASSWORD'] = previous_password
        self.addCleanup(restore_password)
        if url.password is not None:
            os.environ['PGPASSWORD'] = unquote(url.password)
        self.db = {'name': 'snapshot_' + uuid.uuid4().hex, 'user': unquote(url.username or 'merv'),
                   'args': ['-h', url.hostname, '-p', str(url.port or 5432)]}
        self.original = unquote(url.path.strip('/')) or 'postgres'
        shell(['createdb', *self.db['args'], '-U', self.db['user'], '--template=template0', self.db['name']])
        self.restored = []
        self.config = {'schema': 'audit', 'deployment': 'test', 'code_root': str(self.base / 'code'),
                       'state_dir': str(self.base / 'state'), 'staging_dir': str(self.base / 'stage'),
                       'container': 'control', 'maintenance_lock': str(self.base / 'maintenance.lock'),
                       'hosted_marker': str(self.base / 'hosted'), 'reserve_bytes': 0, 'keep': 2,
                       'database': self.db, 'verification': {'database': {**self.db, 'name': self.original}},
                       'restore_database': {**self.db, 'name': self.original},
                       'idle_tables': ['worker_sessions'], 'store': {'directory': str(self.base / 'bucket')}}
        self.r = Fixture(self.config)
        self.project = 'project-one'
        self.key = m.hashlib.sha256(self.project.encode()).hexdigest()[:32]
        self.directory = self.r.root / self.key
        self.repo = self.directory / 'repository.git'
        self.repo.parent.mkdir(parents=True)
        shell(['git', 'init', '--bare', '--template=', str(self.repo)])
        for key, value in {'core.fsync': 'all', 'core.fsyncmethod': 'fsync', 'core.logallrefupdates': 'false', 'gc.auto': '0', 'transfer.fsckobjects': 'true'}.items():
            shell(['git', 'config', '--file', str(self.repo / 'config'), key, value])
        source = self.base / 'source'
        shell(['git', 'init', '--template=', str(source)])
        shell(['git', 'config', 'user.name', 'Fixture'], cwd=source)
        shell(['git', 'config', 'user.email', 'fixture@example.test'], cwd=source)
        (source / 'file').write_text('durable work')
        shell(['git', 'add', '.'], cwd=source)
        shell(['git', 'commit', '-m', 'initial'], cwd=source)
        self.oid = shell(['git', 'rev-parse', 'HEAD'], cwd=source)
        shell(['git', 'push', str(self.repo), 'HEAD:refs/merv/work/unit'], cwd=source)
        (self.directory / 'merv-project.json').write_text(json.dumps({'format': 1, 'projectId': self.project, 'repositoryId': 'repository'}))
        (self.directory / 'held').mkdir()
        (self.directory / 'held' / 'rejected.bundle').write_bytes(b'intentionally invalid, preserve me')
        (self.directory / 'quarantine' / 'receiving').mkdir(parents=True)
        (self.directory / 'quarantine' / 'receiving' / 'bundle.part').write_bytes(b'partial upload')
        sql = f"""CREATE SCHEMA audit;
        CREATE TABLE audit.worker_sessions(status text);
        CREATE TABLE audit.code_projects(project_id text, repository_id text, store_json text, main_json text);
        CREATE TABLE audit.code_units(project_id text,unit_id text,head_oid text,base_json text,acceptance_json text);
        CREATE TABLE audit.code_operations(id text,project_id text,kind text,status text,phase text,payload_json text,progress_json text,result_json text);
        INSERT INTO audit.code_projects VALUES ('{self.project}','repository','{{"rootOid":"{self.oid}"}}','{{}}');
        INSERT INTO audit.code_units VALUES ('{self.project}','unit','{self.oid}','{{"reference":"{self.oid}"}}',NULL);
        INSERT INTO audit.code_operations VALUES ('receiving','{self.project}','import','prepared','receiving','{{}}','{{}}',NULL);
        """
        self.write(sql)

    def write(self, sql):
        shell(['psql', *self.db['args'], '-U', self.db['user'], '-d', self.db['name'], '-v', 'ON_ERROR_STOP=1', '-c', sql])

    def tearDown(self):
        for db in self.restored + [self.db['name']]:
            shell(['dropdb', *self.db['args'], '-U', self.db['user'], '--if-exists', db])
        self.temp.cleanup()

    def test_missing_base_pin_cannot_replace_good_snapshot(self):
        good = self.r.create()['snapshot']
        self.write("UPDATE audit.code_units SET base_json='{" + '\"reference\":\"' + 'f' * 40 + '\"}' + "';")
        for _ in range(2):
            with self.assertRaises((m.Failure, subprocess.CalledProcessError)):
                self.r.create()
        self.assertTrue((self.r.bucket / good / 'COMPLETE.json').is_file())
        self.assertEqual(self.r.verify(good)['state'], 'verified')

    def test_no_head_pin_retains_proven_stored_main(self):
        missing = 'f' * 40
        base = json.dumps({'kind': 'main', 'reference': missing, 'main': {'oid': missing, 'operationId': 'hosted-bind'}})
        result = json.dumps({'main': {'oid': missing, 'stored': True}})
        self.write(f"UPDATE audit.code_units SET head_oid=NULL,base_json='{base}'; INSERT INTO audit.code_operations VALUES ('hosted-bind','project-one','local_bind','completed',NULL,'{{}}','{{}}','{result}');")
        with self.assertRaises(m.Failure):
            self.r.inventory(self.r.root)
        self.write("UPDATE audit.code_operations SET result_json='{}' WHERE id='hosted-bind';")
        self.r.inventory(self.r.root)

    def test_external_only_pin_and_missing_first_import(self):
        self.write("UPDATE audit.code_projects SET store_json=NULL; UPDATE audit.code_units SET head_oid=NULL,base_json='{\"reference\":\"" + 'f' * 40 + "\"}'; DELETE FROM audit.code_operations;")
        shutil.rmtree(self.directory)
        self.r.inventory(self.r.root)
        self.write("INSERT INTO audit.code_operations VALUES ('first','project-one','import','prepared','admitting','{}','{}',NULL);")
        with self.assertRaisesRegex(m.Failure, 'retained bundle'):
            self.r.inventory(self.r.root)
        with self.assertRaises(m.Failure):
            self.r.create()
        self.assertFalse(any(self.r.bucket.glob('*/COMPLETE.json')))

    def test_marker_and_config_match_code_open_requirements(self):
        marker = self.directory / 'merv-project.json'
        original = marker.read_text()
        marker.write_text(json.dumps({'format': 999, 'projectId': self.project, 'repositoryId': 'repository'}))
        with self.assertRaisesRegex(m.Failure, 'identity'):
            self.r.inventory(self.r.root)
        marker.write_text(json.dumps({'format': 2, 'projectId': self.project, 'repositoryIds': ['old', 'repository']}))
        self.r.inventory(self.r.root)
        marker.write_text(original)
        for value in ('false', None):
            args = ['git', 'config', '--file', str(self.repo / 'config')]
            shell(args + (['--unset', 'core.fsync'] if value is None else ['core.fsync', value]))
            with self.assertRaisesRegex(m.Failure, 'configuration'):
                self.r.inventory(self.r.root)
            shell(args + ['core.fsync', 'all'])

    def test_real_roundtrip_preserves_held_and_receiving(self):
        first = self.r.create()['snapshot']
        self.assertTrue(self.r.control['State']['Running'])
        self.assertFalse(self.r.resume.exists())
        self.assertEqual(self.r.verify(first)['state'], 'verified')
        db = 'restored_' + uuid.uuid4().hex
        self.restored.append(db)
        destination = self.base / 'restored-code'
        result = self.r.restore(first, db, destination)
        self.assertEqual(result['state'], 'restored-isolated')
        self.assertEqual((destination / self.key / 'held/rejected.bundle').read_bytes(), b'intentionally invalid, preserve me')
        self.assertEqual((destination / self.key / 'quarantine/receiving/bundle.part').read_bytes(), b'partial upload')
        self.assertEqual(shell(['git', '--git-dir', str(destination / self.key / 'repository.git'), 'show', self.oid + ':file']), 'durable work')
        with self.assertRaises(m.Failure):
            self.r.restore(first, db, destination)

    def test_missing_terminal_capture_is_history_but_live_writers_block(self):
        self.write("""ALTER TABLE audit.worker_sessions ADD COLUMN id text, ADD COLUMN session_json text;
        INSERT INTO audit.worker_sessions VALUES ('expired','old','{"execution":{"policy":{"readOnly":false,"workspace":{"mode":"persistent","retain":true}}}}');
        CREATE TABLE audit.session_workspaces(session_id text, result_json text);
        INSERT INTO audit.session_workspaces VALUES ('old',NULL);
        ALTER TABLE audit.code_units ADD COLUMN writer_state text DEFAULT 'available';""")
        # The obsolete entry in an older host config must not make historical debt live.
        self.r.c['idle_tables'] = ['worker_sessions', 'session_workspaces', 'code_units']
        first = self.r.create()['snapshot']
        self.assertEqual(self.r.verify(first)['state'], 'verified')
        self.write("UPDATE audit.code_units SET writer_state='closing';")
        with self.assertRaisesRegex(m.Failure, 'active work'):
            self.r.create()
        self.write("UPDATE audit.code_units SET writer_state='available'; UPDATE audit.worker_sessions SET status='active';")
        with self.assertRaisesRegex(m.Failure, 'active work'):
            self.r.create()
        self.assertEqual([p.parent.name for p in self.r.bucket.glob('*/COMPLETE.json')], [first])
        self.assertTrue(self.r.control['State']['Running'])

    def test_cleanup_queue_blocks_capture_even_with_older_host_configuration(self):
        self.r.idle()  # Pre-v3 schema remains supported.
        self.write('CREATE TABLE audit.code_base_cleanup(sandbox_id text, next_at text);')
        self.r.idle()
        # Unknown ownership and slow retries both remain outstanding, even with no
        # active base handle and with the old explicit idle_tables configuration.
        for values in ("NULL,NULL", "'sbx_pending','2099-01-01T00:00:00Z'"):
            self.write(f'INSERT INTO audit.code_base_cleanup VALUES ({values});')
            with self.assertRaisesRegex(m.Failure, 'pending Code cleanup'):
                self.r.create()
            self.assertTrue(self.r.control['State']['Running'])
            self.assertFalse(self.r.resume.exists())
            self.assertFalse(any(self.r.bucket.glob('*/COMPLETE.json')))
            self.write('DELETE FROM audit.code_base_cleanup;')
        self.r.idle()

    def test_incomplete_upload_does_not_publish_or_prune(self):
        first = self.r.create()['snapshot']
        self.r.fail_upload = True
        with self.assertRaises(m.Failure):
            self.r.create()
        self.assertTrue(self.r.control['State']['Running'])
        manifests = list(self.r.bucket.glob('*/COMPLETE.json'))
        self.assertEqual([p.parent.name for p in manifests], [first])
        self.assertEqual(self.r.verify(first)['state'], 'verified')

    def test_real_missing_commit_fails_even_with_valid_git(self):
        self.write("UPDATE audit.code_units SET head_oid='" + 'a' * 40 + "';")
        with self.assertRaises(m.Failure):
            self.r.create()
        self.assertTrue(self.r.control['State']['Running'])
        self.assertEqual(list(self.r.bucket.glob('*/COMPLETE.json')), [])

    def test_admitting_preserves_bundle_and_phase_pair_validation(self):
        bundle = self.directory / 'quarantine' / 'pending' / 'bundle'
        bundle.parent.mkdir(parents=True)
        shell(['git', '--git-dir', str(self.repo), 'bundle', 'create', str(bundle), '--all'])
        payload = json.dumps({'source': 'upload', 'unitId': 'unit', 'bundle': m.digest(bundle)})
        progress = json.dumps({'target': self.oid, 'expectedOld': self.oid, 'receiptRef': 'refs/merv/receipts/pending'})
        self.write(f"INSERT INTO audit.code_operations VALUES ('pending','{self.project}','upload','prepared','admitting','{payload}','{progress}',NULL);")
        first = self.r.create()['snapshot']
        self.r.verify(first)
        # The ref transaction can be committed while DB still says objects_durable.
        shell(['git', '--git-dir', str(self.repo), 'update-ref', 'refs/merv/receipts/pending', self.oid])
        self.write("UPDATE audit.code_operations SET phase='objects_durable' WHERE id='pending';")
        self.r.verify(self.r.create()['snapshot'])
        self.write("UPDATE audit.code_operations SET phase='refs_applied' WHERE id='pending';")
        self.r.verify(self.r.create()['snapshot'])
        shell(['git', '--git-dir', str(self.repo), 'update-ref', '-d', 'refs/merv/receipts/pending'])
        with self.assertRaises(m.Failure):
            self.r.create()

    def test_retention_complete_points_only_and_legacy_untouched(self):
        legacy = self.base / 'bucket' / 'legacy'
        legacy.mkdir()
        (legacy / 'keep').write_text('old format')
        ids = [self.r.create()['snapshot'] for _ in range(3)]
        self.assertFalse((self.r.bucket / ids[0]).exists())
        self.assertEqual(len(list(self.r.bucket.glob('*/COMPLETE.json'))), 2)
        self.assertEqual((legacy / 'keep').read_text(), 'old format')
        for snapshot in ids[1:]:
            self.r.verify(snapshot)

    def test_corrupt_retained_point_prevents_prune(self):
        self.r.keep = 3
        ids = [self.r.create()['snapshot'] for _ in range(3)]
        (self.r.bucket / ids[-1] / 'code.tar').write_bytes(b'corrupt')
        self.r.keep = 2
        with self.assertRaises(m.Failure):
            self.r.prune()
        self.assertTrue((self.r.bucket / ids[0] / 'COMPLETE.json').exists())

    def test_idle_race_and_hosted_run_fail_without_leaving_service_stopped(self):
        self.r.stop_race = True
        with self.assertRaises(m.Failure):
            self.r.create()
        self.assertTrue(self.r.control['State']['Running'])
        self.assertEqual(self.r.starts, 1)
        self.write('DELETE FROM audit.worker_sessions;')
        self.r.stop_race = False
        Path(self.config['hosted_marker']).write_text('active-release')
        with self.assertRaises(m.Failure):
            self.r.create()
        self.assertEqual(self.r.starts, 1)

    def test_resume_after_crash_and_container_identity_guard(self):
        m.durable_json(self.r.resume, {'deployment': 'test', 'container': 'control', 'id': 'container-one', 'image': 'sha256:test', 'running': True})
        self.r.control['State']['Running'] = False
        self.r.recover()
        self.assertTrue(self.r.control['State']['Running'])
        self.assertFalse(self.r.resume.exists())
        m.durable_json(self.r.resume, {'deployment': 'test', 'container': 'control', 'id': 'different', 'image': 'sha256:test', 'running': True})
        with self.assertRaises(m.Failure):
            self.r.recover()
        self.assertTrue(self.r.resume.exists())

    def test_failure_in_capture_and_stopped_service_state(self):
        original = self.r.archive
        self.r.archive = lambda _: (_ for _ in ()).throw(OSError('simulated ENOSPC'))
        with self.assertRaises(OSError):
            self.r.create()
        self.assertTrue(self.r.control['State']['Running'])
        self.r.archive = original
        self.r.control['State']['Running'] = False
        self.r.create()
        self.assertFalse(self.r.control['State']['Running'])

    def test_sigkill_after_stop_is_recovered_by_new_supervisor_invocation(self):
        state = self.base / 'control-state.json'
        m.durable_json(state, self.r.control)
        original = self.r.run
        self.r.container = lambda: json.loads(state.read_text())
        def persisted_run(args, **kwargs):
            if args[:2] in (['docker', 'stop'], ['docker', 'start']):
                value = json.loads(state.read_text())
                value['State']['Running'] = args[1] == 'start'
                m.durable_json(state, value)
                return b''
            return original(args, **kwargs)
        self.r.run = persisted_run
        def killed_capture():
            self.r.stopped_capture(lambda _: os.kill(os.getpid(), signal.SIGKILL))
        child = multiprocessing.get_context('fork').Process(target=killed_capture)
        child.start()
        child.join(10)
        self.assertEqual(child.exitcode, -signal.SIGKILL)
        self.assertFalse(self.r.container()['State']['Running'])
        self.assertTrue(self.r.resume.exists())
        with m.locked(self.config['maintenance_lock']):
            self.r.recover()
        self.assertTrue(self.r.container()['State']['Running'])
        self.assertFalse(self.r.resume.exists())

    def test_independent_status_observer_detects_never_and_stale(self):
        with self.assertRaises(m.Failure):
            self.r.status()
        m.durable_json(self.r.state / 'last-complete.json', {'snapshot': 'fixture', 'completed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()})
        self.assertEqual(self.r.status()['state'], 'fresh')
        m.durable_json(self.r.state / 'last-complete.json', {'snapshot': 'fixture', 'completed_at': '2000-01-01T00:00:00+00:00'})
        with self.assertRaises(m.Failure):
            self.r.status()

    def test_unsafe_archive_rejected(self):
        archive = self.base / 'unsafe.tar'
        with tarfile.open(archive, 'w') as out:
            item = tarfile.TarInfo('../escape')
            item.type = tarfile.DIRTYPE
            out.addfile(item)
        with self.assertRaises(m.Failure):
            self.r.extract(archive, self.base / 'unsafe-output')
        self.assertFalse((self.base.parent / 'escape').exists())

    def test_shared_lock_excludes_capture(self):
        with m.locked(self.config['maintenance_lock']):
            with self.assertRaises(m.Failure):
                self.r.create()
        self.assertTrue(self.r.control['State']['Running'])


if __name__ == '__main__':
    unittest.main()
