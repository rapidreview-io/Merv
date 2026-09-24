import ctypes
import datetime
import errno
import importlib.util
import json
import os
from pathlib import Path
import signal
import shutil
import socket
import subprocess
import time


spec = importlib.util.spec_from_file_location('runtime', '/opt/merv/runtime/start-runtime.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
runtime.trusted_runtime()
filename = Path('/run/merv-runtime/bootstrap-pi-gate')
token = 'piw_flt_gate.' + 'a' * 43
filename.write_text(json.dumps({
    'kind': 'pi', 'baseUrl': 'https://127.0.0.1:9', 'projectId': 'project_gate',
    'conversationId': 'pic_gate', 'runtimeId': 'flt_gate', 'epoch': 1,
    'workerToken': token,
    'expiresAt': (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=30)).isoformat(),
}))
filename.chmod(0o600)
parent = subprocess.Popen(
    ['/opt/merv/runtime/start-runner'],
    env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'MERV_BOOTSTRAP_FILE': str(filename)},
    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    start_new_session=True,
)
try:
    worker = None
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline and parent.poll() is None:
        for entry in Path('/proc').iterdir():
            if not entry.name.isdecimal():
                continue
            try:
                command = (entry / 'cmdline').read_bytes().split(b'\x00')
                if command[:2] == [b'/usr/local/bin/node', b'/opt/merv/pi/worker-main.mjs']:
                    worker = entry
                    break
            except (FileNotFoundError, PermissionError):
                continue
        if worker:
            break
        time.sleep(0.05)
    if worker is None:
        raise RuntimeError('Pi worker did not survive protected launch')
    status = dict(line.split(':', 1) for line in (worker / 'status').read_text().splitlines() if ':' in line)
    assert status['Uid'].split() == ['12001'] * 4
    assert status['Gid'].split() == ['12001'] * 4
    assert not status['Groups'].strip()
    assert status['NoNewPrivs'].strip() == '1'
    for name in ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']:
        assert int(status[name].strip(), 16) == 0, name
    environment = (worker / 'environ').read_bytes()
    assert token.encode() not in environment
    assert b'OPENAI_API_KEY=' not in environment
    assert b'MERV_BOOTSTRAP_FILE=' not in environment
    assert not filename.exists()
    assert token.encode() not in (worker / 'cmdline').read_bytes()
    assert token.encode() not in Path(f'/proc/{parent.pid}/cmdline').read_bytes()
    root_marker = Path('/run/merv-runtime/root-marker')
    root_marker.write_text('root-only')
    root_marker.chmod(0o600)
    control_path = Path('/run/merv-runtime/gate-control.sock')
    control = socket.socket(socket.AF_UNIX)
    control.bind(str(control_path))
    control_path.chmod(0o600)
    control.listen(1)
    sudo = shutil.which('sudo')
    child = os.fork()
    if child == 0:
        runtime.prepare_assignment_identity(uid=12001, gid=12001, administrative_uid=1000, preserve_stdio=True)
        for target in [root_marker, Path(f'/proc/{parent.pid}/environ')]:
            try:
                target.read_bytes()
            except PermissionError:
                continue
            os._exit(1)
        try:
            list(Path(f'/proc/{parent.pid}/fd').iterdir())
        except PermissionError:
            pass
        else:
            os._exit(2)
        try:
            os.kill(parent.pid, 0)
        except PermissionError:
            pass
        else:
            os._exit(3)
        library = ctypes.CDLL(None, use_errno=True)
        library.ptrace.restype = ctypes.c_long
        library.ptrace.argtypes = [ctypes.c_ulong, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_void_p]
        if library.ptrace(16, parent.pid, None, None) != -1 or ctypes.get_errno() not in (errno.EPERM, errno.EACCES):
            os._exit(4)
        if sudo and subprocess.run([sudo, '-n', '/usr/bin/true'], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   timeout=5).returncode == 0:
            os._exit(5)
        try:
            with socket.socket(socket.AF_UNIX) as probe:
                probe.connect(str(control_path))
        except PermissionError:
            pass
        else:
            os._exit(6)
        os._exit(0)
    _, result = os.waitpid(child, 0)
    control.close()
    control_path.unlink()
    assert result == 0, f'assignment isolation probe failed ({result})'
    print(json.dumps({'gate': 'linux-pi-protected-launch', 'uid': 12001, 'capabilities': 0,
                      'noNewPrivileges': True, 'bootstrapRemoved': True,
                      'privateParentDenied': True, 'parentDescriptorsDenied': True,
                      'parentSignalDenied': True, 'parentPtraceDenied': True,
                      'sudo': 'denied' if sudo else 'not-installed',
                      'syntheticControlSocketDenied': True, 'workerAlive': parent.poll() is None}))
finally:
    if parent.poll() is None:
        os.killpg(parent.pid, signal.SIGTERM)
    try:
        output, error = parent.communicate(timeout=8)
    except subprocess.TimeoutExpired:
        os.killpg(parent.pid, signal.SIGKILL)
        parent.communicate()
        raise RuntimeError('protected supervisor failed to stop')
    assert token.encode() not in output + error
    filename.unlink(missing_ok=True)
