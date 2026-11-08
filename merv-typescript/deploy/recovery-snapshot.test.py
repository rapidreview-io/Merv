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
from unittest.mock import patch
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

    def current_storage(self):
        self.write(f"""CREATE TABLE audit.code_workspaces AS SELECT project_id,unit_id,head_oid,base_json FROM audit.code_units;
        ALTER TABLE audit.code_workspaces ADD COLUMN writer_state text DEFAULT 'idle';
        CREATE TABLE audit.code_retained_commits(project_id text,retention_key text,unit_id text,commit_oid text,storage text);
        INSERT INTO audit.code_retained_commits VALUES ('{self.project}','accepted:unit','unit','{self.oid}','code');
        """)



    def test_current_retained_commit_promises_survive_restore_and_reject_missing_objects(self):
        self.current_storage()
        self.write('DROP TABLE audit.code_units;')  # Fresh core storage has no legacy adapter.
        good = self.r.create()['snapshot']
        missing = 'f' * 40
        # Acceptance also promises the pinned base, even before any workspace head.
        self.write(f"UPDATE audit.code_workspaces SET head_oid=NULL,base_json='{{\"reference\":\"{missing}\"}}';")
        with self.assertRaises(m.Failure):
            self.r.create()
        self.write(f"UPDATE audit.code_workspaces SET head_oid='{self.oid}',base_json='{{\"reference\":\"{self.oid}\"}}';")
        self.write(f"INSERT INTO audit.code_retained_commits VALUES ('{self.project}','other-acceptance','unlisted-unit','{missing}','code');")
        with self.assertRaisesRegex(m.Failure, 'stored commit missing'):
            self.r.create()
        self.assertEqual(self.r.verify(good)['state'], 'verified')
        self.assertEqual([p.parent.name for p in self.r.bucket.glob('*/COMPLETE.json')], [good])
        self.write("UPDATE audit.code_retained_commits SET storage='external' WHERE retention_key='other-acceptance';")
        self.assertEqual(self.r.verify(self.r.create()['snapshot'])['state'], 'verified')




    def test_incomplete_upload_does_not_publish_or_prune(self):
        first = self.r.create()['snapshot']
        self.r.fail_upload = True
        with self.assertRaises(m.Failure):
            self.r.create()
        self.assertTrue(self.r.control['State']['Running'])
        manifests = list(self.r.bucket.glob('*/COMPLETE.json'))
        self.assertEqual([p.parent.name for p in manifests], [first])
        self.assertEqual(self.r.verify(first)['state'], 'verified')






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




    def test_space_refusal_happens_before_stop_and_before_download(self):
        usage = shutil.disk_usage(self.base)
        with patch.object(m.shutil, 'disk_usage', return_value=usage._replace(free=1)):
            with self.assertRaisesRegex(m.Failure, 'insufficient recovery space') as failed:
                self.r.create()
        self.assertEqual(failed.exception.details['stage'], 'capture_space')
        self.assertEqual(self.r.starts, 0)
        self.assertTrue(self.r.control['State']['Running'])
        point = self.r.create()['snapshot']
        transfers, original = [], self.r.transfer
        def transfer(*args):
            transfers.append(args[:3])
            return original(*args)
        self.r.transfer = transfer
        with patch.object(m.shutil, 'disk_usage', return_value=usage._replace(free=1)):
            with self.assertRaisesRegex(m.Failure, 'insufficient recovery space') as failed:
                self.r.verify(point)
        self.assertEqual(failed.exception.details['stage'], 'download_space')
        self.assertEqual(transfers, [('get', point, 'COMPLETE.json')])
        self.assertEqual(list(self.r.staging.iterdir()), [])



    def test_failure_diagnostics_never_include_arguments_or_child_stderr(self):
        private = 'private://user:password@host/path'
        with self.assertRaises(m.Failure) as failed:
            with self.r.phase('verify_restore'):
                self.r.run(['psql', '--not-a-real-option', private])
        self.assertEqual(failed.exception.details['stage'], 'verify_restore')
        self.assertEqual(failed.exception.details['tool'], 'psql')
        self.assertNotEqual(failed.exception.details['exit_code'], 0)
        self.assertNotIn(private, str(failed.exception) + json.dumps(failed.exception.details))


if __name__ == '__main__':
    unittest.main()
