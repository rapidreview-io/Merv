import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

SANDBOX = Path(__file__).resolve().parents[3] / 'output/fleet-sandboxes/control/src'
sys.path.insert(0, str(SANDBOX))
MODULE = Path(__file__).with_name('start-runtime.py')
spec = importlib.util.spec_from_file_location('start_runtime', MODULE)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


def bootstrap():
    return {
        'kind': 'pi', 'baseUrl': 'https://api.example.test/', 'projectId': 'project_1',
        'conversationId': 'conversation_1', 'runtimeId': 'runtime_1', 'epoch': 1,
        'workerToken': 'piw_flt_test.' + 'a' * 43,
        'expiresAt': (datetime.datetime.now(datetime.timezone.utc) +
                      datetime.timedelta(hours=1)).isoformat(),
    }


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.dumpability = patch.object(runtime, '_prctl')
        self.prctl = self.dumpability.start()
        self.addCleanup(self.dumpability.stop)

    def test_pi_bootstrap_rejects_untrusted_fields(self):
        valid = bootstrap()
        self.assertGreater(runtime.validate_pi(valid, len(json.dumps(valid))), 0)
        changes = [
            {'kind': 'shell'}, {'epoch': True}, {'epoch': 9007199254740992},
            {'projectId': '../secrets'}, {'workerToken': 'fake'},
            {'baseUrl': 'http://api.example.test/'},
            {'baseUrl': 'https://api.example.test@evil.test/'},
            {'baseUrl': 'https://api.example.test/secrets'},
            {'baseUrl': 'https://api.example.test:99999/'},
            {'expiresAt': '1970-01-01T00:00:00Z'},
            {'expiresAt': '2099-01-01T00:00:00Z'},
            {'expiresAt': '2026-09-23T00:00:00'},
            {'modelApiKey': 'untrusted'},
        ]
        for change in changes:
            with self.subTest(change=change), self.assertRaises((ValueError, TypeError)):
                runtime.validate_pi({**valid, **change}, 200)
        with self.assertRaises(ValueError):
            runtime.validate_pi(valid, 4097)

    def test_bootstrap_file_rejects_malicious_path_and_type(self):
        with patch.object(runtime, '_verified_bootstrap') as verify:
            with patch.dict(os.environ, {'MERV_BOOTSTRAP_FILE': '/tmp/bootstrap-evil'}):
                with self.assertRaises(ValueError):
                    runtime.read_bootstrap()
            verify.assert_not_called()
        with patch.dict(os.environ, {'MERV_BOOTSTRAP_FILE': '/run/merv-runtime/bootstrap-good'}):
            with patch.object(runtime, '_verified_bootstrap', side_effect=ValueError('unsafe')):
                with self.assertRaises(ValueError):
                    runtime.read_bootstrap()
            with patch.object(runtime, '_verified_bootstrap'):
                with patch.object(runtime.os, 'open', side_effect=OSError('symlink')):
                    with self.assertRaises(OSError):
                        runtime.read_bootstrap()

    def test_workflow_passes_original_file_to_codex_supervisor(self):
        class ExecCalled(BaseException):
            pass

        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / 'bootstrap-workflow'
            filename.write_text(json.dumps({
                'baseUrl': 'https://api.example.test/', 'projectId': 'test',
                'enrollmentToken': 'private', 'modelApiKey': 'private',
            }))
            raw = bytearray(filename.read_bytes())
            with patch.object(runtime, '_root_linux'), patch.object(runtime, 'read_bootstrap', return_value=(filename, raw)):
                with patch.object(runtime, '_trusted_path'):
                    with patch.object(runtime.os, 'execve', side_effect=ExecCalled) as execve:
                        with self.assertRaises(ExecCalled):
                            runtime.supervisor()
            self.assertTrue(filename.exists())
            self.assertEqual(raw, bytearray(len(raw)))
            self.assertEqual(execve.call_args.args[1], [str(runtime.NODE), '/opt/merv/runner/smoke-supervisor.mjs'])
            self.assertEqual(execve.call_args.args[2]['MERV_BOOTSTRAP_FILE'], str(filename))

    def test_pi_uses_private_stdin_not_environment_and_wipes_file(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / 'bootstrap-pi'
            raw = bytearray(json.dumps(bootstrap()).encode())
            filename.write_bytes(raw)
            original = bytes(raw)
            instances = []

            class Child:
                def __init__(self, argv, **options):
                    self.options = options
                    self.argv = argv
                    self.stdin = io.BytesIO()
                    self.stdin.close = lambda: None
                    self.pid = 42
                    instances.append(self)

                def poll(self):
                    return 0

                def wait(self, **_kwargs):
                    return 0

            with patch.object(runtime, '_root_linux'), patch.object(runtime, 'read_bootstrap', return_value=(filename, raw)):
                with patch.object(runtime.subprocess, 'Popen', Child):
                    with patch.dict(os.environ, {'MERV_BOOTSTRAP_FILE': str(filename)}):
                        self.assertEqual(runtime.supervisor(), 0)
                        self.assertNotIn('MERV_BOOTSTRAP_FILE', os.environ)
            child = instances[0]
            self.assertFalse(filename.exists())
            self.assertEqual(raw, bytearray(len(raw)))
            self.assertEqual(json.loads(child.stdin.getvalue()), json.loads(original))
            self.assertEqual(child.argv[-1], '--worker')
            self.assertNotIn('piw_flt_', str(child.options['env']))
            self.assertEqual(child.options['stdin'], runtime.subprocess.PIPE)
            self.assertTrue(child.options['close_fds'] and child.options['start_new_session'])

    def test_unknown_kind_fails_closed_and_removes_file(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / 'bootstrap-other'
            raw = bytearray(b'{"kind":"other"}')
            filename.write_bytes(raw)
            with patch.object(runtime, '_root_linux'), patch.object(runtime, 'read_bootstrap', return_value=(filename, raw)):
                with self.assertRaises(ValueError):
                    runtime.supervisor()
            self.assertFalse(filename.exists())
            self.assertEqual(raw, bytearray(len(raw)))

    def test_malicious_worker_dependency_cannot_be_trusted(self):
        with tempfile.TemporaryDirectory() as directory:
            dependencies = Path(directory) / 'node_modules'
            dependencies.mkdir()
            (dependencies / 'safe').write_text('safe')

            def trust(filename):
                if filename != dependencies and dependencies not in filename.parents:
                    return os.stat_result((stat.S_IFREG | 0o755,) + (0,) * 9)
                info = filename.lstat()
                if stat.S_ISLNK(info.st_mode) or info.st_mode & 0o022:
                    raise ValueError('untrusted file')
                return info

            with patch.object(runtime, 'DEPENDENCIES', dependencies), patch.object(runtime, '_trusted_path', side_effect=trust):
                runtime.trusted_runtime()
                (dependencies / 'unsafe').symlink_to(dependencies / 'safe')
                with self.assertRaises(ValueError):
                    runtime.trusted_runtime()
                (dependencies / 'unsafe').unlink()
                (dependencies / 'unsafe').write_text('writable')
                (dependencies / 'unsafe').chmod(0o666)
                with self.assertRaises(ValueError):
                    runtime.trusted_runtime()

    def test_worker_drops_identity_and_uses_only_private_pipe_and_home(self):
        class ExecCalled(BaseException):
            pass

        worker_info = os.stat_result((stat.S_IFDIR | 0o700, 0, 0, 0, 12001, 12001) + (0,) * 4)
        pipe_info = os.stat_result((stat.S_IFIFO | 0o600,) + (0,) * 9)
        with patch.object(runtime, '_root_linux'), patch.object(runtime, 'trusted_runtime'):
            with patch.object(runtime, '_trusted_path'), patch.object(runtime.Path, 'lstat', return_value=worker_info):
                with patch.object(runtime.os, 'fstat', return_value=pipe_info), patch.object(runtime.os, 'chdir'):
                    with patch.object(runtime, 'prepare_assignment_identity') as drop:
                        with patch.object(runtime.os, 'execve', side_effect=ExecCalled) as execve:
                            with self.assertRaises(ExecCalled):
                                runtime.worker()
        drop.assert_called_once_with(uid=12001, gid=12001, administrative_uid=1000,
                                     preserve_stdio=True)
        self.prctl.assert_called_with(4, 0)
        self.assertEqual(execve.call_args.args[1], [str(runtime.NODE), str(runtime.WORKER)])
        environment = execve.call_args.args[2]
        self.assertEqual(environment['CODEX_HOME'], '/home/assignment/.codex')
        self.assertEqual(environment['TMPDIR'], '/home/assignment')
        self.assertNotIn('MERV_BOOTSTRAP_FILE', environment)
        self.assertNotIn('OPENAI_API_KEY', environment)
        with patch.object(runtime, '_root_linux'), patch.object(runtime, 'trusted_runtime'):
            with patch.object(runtime, '_trusted_path'), patch.object(runtime.Path, 'lstat', return_value=worker_info):
                with patch.object(runtime.os, 'fstat', return_value=worker_info):
                    with self.assertRaises(ValueError):
                        runtime.worker()


if __name__ == '__main__':
    unittest.main()
