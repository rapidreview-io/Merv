import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import warnings

SANDBOX = Path(__file__).resolve().parents[3] / 'output/fleet-sandboxes/control/src'
sys.path.insert(0, str(SANDBOX))
MODULE = Path(__file__).with_name('start-runtime.py')
spec = importlib.util.spec_from_file_location('start_runtime', MODULE)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


def bootstrap():
    return {
        'kind': 'pi', 'version': 2, 'baseUrl': 'https://api.example.test/', 'hostId': 'pih_1',
        'runtimeId': 'runtime_1', 'epoch': 1, 'machine': 'standard', 'slots': 3,
        'workerToken': 'piw_flt_test.' + 'a' * 43,
        'expiresAt': (datetime.datetime.now(datetime.timezone.utc) +
                      datetime.timedelta(hours=1)).isoformat(),
    }


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.dumpability = patch.object(runtime, '_prctl')
        self.prctl = self.dumpability.start()
        self.addCleanup(self.dumpability.stop)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        prestart = patch.object(runtime, 'PRESTART', self.directory / 'prestart/worker.sock')
        prestart.start()
        self.addCleanup(prestart.stop)

    def test_pi_bootstrap_rejects_untrusted_fields(self):
        valid = bootstrap()
        self.assertGreater(runtime.validate_pi(valid, len(json.dumps(valid))), 0)
        changes = [
            {'kind': 'shell'}, {'epoch': True}, {'epoch': 9007199254740992},
            {'version': 1}, {'version': True}, {'version': 2.0},
            {'slots': 0}, {'slots': 9}, {'slots': True}, {'machine': 'Large'},
            {'machine': 'large\n'}, {'hostId': '../secrets'}, {'workerToken': 'fake'},
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
        # A per-conversation (v1) bootstrap is refused, not run as a host slot.
        v1 = {key: value for key, value in valid.items()
              if key not in ('version', 'hostId', 'machine', 'slots')}
        with self.assertRaises(ValueError):
            runtime.validate_pi({**v1, 'projectId': 'project_1', 'conversationId': 'c_1'}, 200)

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
                    self.stderr = io.BytesIO(b'Pi worker turn failed: Turn expired\n')
                    self.returncode = 0
                    self.pid = 42
                    instances.append(self)

                def poll(self):
                    return 0

                def wait(self, **_kwargs):
                    return 0

            with patch.object(runtime, '_root_linux'), patch.object(runtime, 'read_bootstrap', return_value=(filename, raw)):
                with patch.object(runtime.subprocess, 'Popen', Child), patch.object(runtime.os, 'write') as write:
                    with patch.dict(os.environ, {'MERV_BOOTSTRAP_FILE': str(filename)}):
                        self.assertEqual(runtime.supervisor(), 0)
                        self.assertNotIn('MERV_BOOTSTRAP_FILE', os.environ)
            write.assert_called_once_with(2, b'Pi worker turn failed: Turn expired\n')
            child = instances[0]
            self.assertFalse(filename.exists())
            self.assertEqual(raw, bytearray(len(raw)))
            self.assertEqual(json.loads(child.stdin.getvalue()), json.loads(original))
            self.assertEqual(child.argv[-1], '--worker')
            self.assertNotIn('piw_flt_', str(child.options['env']))
            self.assertEqual(child.options['stdin'], runtime.subprocess.PIPE)
            self.assertEqual(child.options['stderr'], runtime.subprocess.PIPE)
            self.assertTrue(child.options['close_fds'] and child.options['start_new_session'])

    def test_worker_diagnostics_forward_only_bounded_known_lines(self):
        stream = io.BytesIO(b''.join([
            b'Pi worker unavailable: Worker request failed with HTTP 401\n',
            b'Pi worker unavailable: piw_flt_test.' + b'a' * 43 + b'\n',
            b'Pi worker turn failed: ' + b'x' * 300 + b'\n',
            b'Model token pir_' + b'b' * 43 + b'\n',
            b'Protected runtime failed\n',
            b'Pi worker turn failed: Turn expired\n' * 80,
        ]))
        with patch.object(runtime.os, 'write') as write:
            runtime.forward_diagnostics(stream)
        lines = [call.args[1] for call in write.call_args_list]
        self.assertEqual(lines[:2], [b'Pi worker unavailable: Worker request failed with HTTP 401\n',
                                     b'Protected runtime failed\n'])
        self.assertEqual(len(lines), 64)
        self.assertEqual(set(lines[2:]), {b'Pi worker turn failed: Turn expired\n'})

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

    def test_malicious_worker_dependency_or_compile_cache_cannot_be_trusted(self):
        with tempfile.TemporaryDirectory() as directory:
            dependencies, cache = Path(directory) / 'node_modules', Path(directory) / 'compile-cache'
            dependencies.mkdir()
            (dependencies / 'safe').write_text('safe')
            (cache / 'v22-x64-tag-12001').mkdir(parents=True)
            owners, real = {}, os.lstat

            def trust(filename):
                if filename in (dependencies, cache):
                    return filename.stat()
                return os.stat_result((stat.S_IFREG | 0o755,) + (0,) * 9)

            def lstat(filename):
                info = real(filename)
                return os.stat_result((info.st_mode, info.st_ino, info.st_dev, info.st_nlink,
                                       owners.get(str(filename), 0), 0, *info[6:10]))

            with patch.object(runtime, 'DEPENDENCIES', dependencies), patch.object(runtime, 'COMPILE_CACHE', cache):
                with patch.object(runtime, '_trusted_path', side_effect=trust), patch.object(runtime.os, 'lstat', side_effect=lstat):
                    runtime.trusted_runtime()
                    (dependencies / 'unsafe').symlink_to(dependencies / 'safe')
                    with self.assertRaises(ValueError):
                        runtime.trusted_runtime()
                    (dependencies / 'unsafe').unlink()
                    (dependencies / 'unsafe').write_text('writable')
                    (dependencies / 'unsafe').chmod(0o666)
                    with self.assertRaises(ValueError):
                        runtime.trusted_runtime()
                    (dependencies / 'unsafe').unlink()
                    runtime.trusted_runtime()
                    entry = cache / 'v22-x64-tag-12001' / 'entry'
                    entry.write_bytes(b'bytecode')
                    owners[str(entry)] = 12001
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
        self.assertEqual(environment['NODE_COMPILE_CACHE'], '/opt/merv/pi/compile-cache')
        self.assertNotIn('MERV_BOOTSTRAP_FILE', environment)
        self.assertNotIn('OPENAI_API_KEY', environment)
        with patch.object(runtime, '_root_linux'), patch.object(runtime, 'trusted_runtime'):
            with patch.object(runtime, '_trusted_path'), patch.object(runtime.Path, 'lstat', return_value=worker_info):
                with patch.object(runtime.os, 'fstat', return_value=worker_info):
                    with self.assertRaises(ValueError):
                        runtime.worker()


class PrestartTests(unittest.TestCase):
    """The real holder and supervisor, with a stand-in worker that echoes its private stdin."""

    def setUp(self):
        DispatchTests.setUp(self)
        # Production closes these pipes by exiting or exec; here the collector does.
        warnings.simplefilter('ignore', ResourceWarning)

    def hold(self, script):
        if runtime.PRESTART.parent.exists():
            runtime.PRESTART.parent.rmdir()
        workers = []

        def spawn():
            workers.append(subprocess.Popen(
                [sys.executable, '-c', script, str(self.directory / 'received')],
                stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                close_fds=True, start_new_session=True,
            ))
            return workers[0]

        with patch.object(runtime, '_root_linux'), patch.object(runtime, 'spawn_worker', spawn):
            with patch.object(runtime, '_trusted_path', side_effect=lambda path: path.stat()):
                holder = threading.Thread(target=runtime.prestart, daemon=True)
                holder.start()
                deadline = time.monotonic() + 5
                while not runtime.PRESTART.exists() and holder.is_alive() and time.monotonic() < deadline:
                    time.sleep(0.01)
        self.addCleanup(lambda: workers and workers[0].poll() is None and workers[0].kill())
        return holder, workers

    def test_pi_supervisor_hands_its_bootstrap_to_the_worker_loaded_at_boot(self):
        holder, workers = self.hold(
            'import sys; sys.stderr.write("Pi worker ready 5 ms\\n"); sys.stderr.flush(); '
            'open(sys.argv[1], "wb").write(sys.stdin.buffer.read()); sys.exit(3)')
        self.assertTrue(runtime.PRESTART.exists())
        filename = self.directory / 'bootstrap-pi'
        raw = bytearray(json.dumps(bootstrap()).encode())
        filename.write_bytes(raw)
        original = json.loads(raw)
        with patch.object(runtime, '_root_linux'), patch.object(runtime, 'read_bootstrap', return_value=(filename, raw)):
            with patch.object(runtime, 'spawn_worker', side_effect=AssertionError), patch.object(runtime.os, 'write') as write:
                self.assertEqual(runtime.supervisor(), 3)
        holder.join(5)
        self.assertFalse(holder.is_alive())
        self.assertEqual(workers[0].returncode, 3)
        self.assertEqual(json.loads((self.directory / 'received').read_bytes()), original)
        write.assert_called_once_with(2, b'Pi worker ready 5 ms\n')
        self.assertFalse(runtime.PRESTART.exists())
        self.assertFalse(filename.exists())
        self.assertEqual(raw, bytearray(len(raw)))

    def test_workflow_stops_the_worker_loaded_at_boot_and_a_lost_supervisor_does_too(self):
        class ExecCalled(BaseException):
            pass

        for workflow in (True, False):
            with self.subTest(workflow=workflow):
                holder, workers = self.hold('import time; time.sleep(60)')
                if workflow:
                    filename = self.directory / 'bootstrap-workflow'
                    raw = bytearray(b'{"baseUrl":"https://api.example.test/","projectId":"test"}')
                    with patch.object(runtime, '_root_linux'), patch.object(runtime, '_trusted_path'):
                        with patch.object(runtime, 'read_bootstrap', return_value=(filename, raw)):
                            with patch.object(runtime.os, 'execve', side_effect=ExecCalled):
                                with self.assertRaises(ExecCalled):
                                    runtime.supervisor()
                else:
                    runtime.prestarted().connection.close()
                holder.join(5)
                self.assertFalse(holder.is_alive())
                self.assertIsNotNone(workers[0].poll())
                self.assertIsNone(runtime.prestarted())

    def test_holder_leaves_when_its_worker_fails_before_any_claim(self):
        holder, workers = self.hold('raise SystemExit(1)')
        holder.join(5)
        self.assertFalse(holder.is_alive())
        self.assertEqual(workers[0].returncode, 1)
        self.assertFalse(runtime.PRESTART.exists())
        self.assertIsNone(runtime.prestarted())


if __name__ == '__main__':
    unittest.main()
