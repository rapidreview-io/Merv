#!/usr/bin/python3
import contextlib
import datetime
import json
import os
from pathlib import Path
import re
import select
import signal
import socket
import stat
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit

sys.path.insert(0, '/opt/merv/python')
from merv_sandboxes.runtimes.launcher import (
    _prctl, _root_linux, _trusted_path, _verified_bootstrap, prepare_assignment_identity,
)

NODE = Path('/usr/local/bin/node')
PYTHON = Path('/usr/bin/python3.11')
WORKER = Path('/opt/merv/pi/worker-main.mjs')
DEPENDENCIES = Path('/opt/merv/pi/node_modules')
COMPILE_CACHE = Path('/opt/merv/pi/compile-cache')
PRESTART = Path('/run/merv-prestart/worker.sock')
WORKER_HOME = Path('/home/assignment')
DIAGNOSTIC = re.compile(rb'(?:Pi worker|Protected runtime) [A-Za-z0-9 ():]{1,160}\n')


def trusted_runtime():
    def failed_walk(error):
        raise error

    for filename in (NODE, PYTHON, WORKER, Path(__file__), Path('/opt/merv/pi/package.json')):
        info = _trusted_path(filename)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('invalid runtime file')
    for tree in (DEPENDENCIES, COMPILE_CACHE):
        if not stat.S_ISDIR(_trusted_path(tree).st_mode):
            raise ValueError('missing worker dependencies')
        # The walk enters only directories it already checked, so one lstat per entry suffices.
        for directory, folders, files in os.walk(tree, onerror=failed_walk, followlinks=False):
            for name in (*folders, *files):
                info = os.lstat(os.path.join(directory, name))
                if (info.st_uid != 0 or info.st_mode & 0o022 or
                        not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode))):
                    raise ValueError('invalid worker dependency')


def worker():
    _root_linux()
    _prctl(4, 0)
    trusted_runtime()
    _trusted_path(WORKER_HOME.parent)
    info = WORKER_HOME.lstat()
    if (not stat.S_ISDIR(info.st_mode) or (info.st_uid, info.st_gid) != (12001, 12001)
            or stat.S_IMODE(info.st_mode) != 0o700):
        raise ValueError('invalid worker home')
    if not stat.S_ISFIFO(os.fstat(0).st_mode):
        raise ValueError('private worker input required')
    os.chdir(WORKER_HOME)
    prepare_assignment_identity(uid=12001, gid=12001, administrative_uid=1000, preserve_stdio=True)
    os.execve(str(NODE), [str(NODE), str(WORKER)], {
        'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(WORKER_HOME),
        'CODEX_HOME': str(WORKER_HOME / '.codex'), 'TMPDIR': str(WORKER_HOME),
        'LANG': 'C.UTF-8', 'USER': 'assignment', 'LOGNAME': 'assignment',
        'NODE_COMPILE_CACHE': str(COMPILE_CACHE),
    })


def validate_pi(data, size):
    # Version 2 only: one worker per host slot, running up to `slots` turns at once.
    if (size > 4096 or type(data) is not dict or
            set(data) != {'kind', 'version', 'baseUrl', 'hostId', 'runtimeId', 'epoch',
                          'machine', 'slots', 'workerToken', 'expiresAt'} or
            data['kind'] != 'pi' or type(data['version']) is not int or data['version'] != 2 or
            type(data['epoch']) is not int or not 0 <= data['epoch'] <= 9007199254740991 or
            type(data['slots']) is not int or not 1 <= data['slots'] <= 8 or
            not isinstance(data['machine'], str) or
            not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', data['machine']) or
            any(not isinstance(data[key], str) or
                not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', data[key])
                for key in ('hostId', 'runtimeId')) or
            not isinstance(data['workerToken'], str) or
            not re.fullmatch(r'piw_flt_[A-Za-z0-9]+\.[A-Za-z0-9_-]{43}', data['workerToken']) or
            not isinstance(data['baseUrl'], str) or
            not re.fullmatch(r'https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?/?', data['baseUrl']) or
            not isinstance(data['expiresAt'], str)):
        raise ValueError('invalid Pi bootstrap')
    endpoint = urlsplit(data['baseUrl'])
    if not endpoint.hostname or (':' in endpoint.netloc and not endpoint.port):
        raise ValueError('invalid worker origin')
    expires = datetime.datetime.fromisoformat(data['expiresAt'].replace('Z', '+00:00'))
    if expires.tzinfo is None:
        raise ValueError('invalid worker expiry')
    lifetime = (expires - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
    if not 0 < lifetime <= 86400:
        raise ValueError('invalid worker lifetime')
    return lifetime


def read_bootstrap():
    value = os.environ.get('MERV_BOOTSTRAP_FILE', '')
    filename = Path(value)
    if (filename.parent != Path('/run/merv-runtime') or
            not re.fullmatch(r'bootstrap-[A-Za-z0-9_-]+', filename.name)):
        raise ValueError('invalid bootstrap path')
    _verified_bootstrap(filename)
    try:
        descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
        try:
            info = os.fstat(descriptor)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or
                    info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600):
                raise ValueError('invalid bootstrap permissions')
            raw = bytearray(os.read(descriptor, 16385))
            if len(raw) > 16384:
                raw[:] = b'\x00' * len(raw)
                raise ValueError('bootstrap too large')
            return filename, raw
        finally:
            os.close(descriptor)
    except Exception:
        filename.unlink(missing_ok=True)
        raise


def forward_diagnostics(stream):
    # Only fixed-vocabulary lines leave the lower-privileged worker, at most 64; the rest is drained.
    forwarded = 0
    for line in iter(lambda: stream.readline(200), b''):
        if forwarded < 64 and DIAGNOSTIC.fullmatch(line):
            forwarded += 1
            with contextlib.suppress(OSError):
                os.write(2, line)


def spawn_worker():
    return subprocess.Popen(
        [str(PYTHON), str(Path(__file__).resolve()), '--worker'],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8'},
        close_fds=True, start_new_session=True,
    )


class Prestarted:
    """A worker loaded at boot, handed over with its pipes; only its holder signals and reaps it."""

    def __init__(self, connection):
        message, descriptors, _flags, _address = socket.recv_fds(connection, 1, 2)
        if message != b'W' or len(descriptors) != 2:
            raise ValueError('invalid prestarted worker')
        self.connection, self.returncode = connection, None
        self.stdin, self.stderr = os.fdopen(descriptors[0], 'wb'), os.fdopen(descriptors[1], 'rb')

    def poll(self):
        with contextlib.suppress(subprocess.TimeoutExpired):
            return self.wait(0)

    def wait(self, timeout=None):
        if self.returncode is None:
            if not select.select([self.connection], [], [], timeout)[0]:
                raise subprocess.TimeoutExpired('worker', timeout)
            try:
                status = self.connection.recv(1)
            except ConnectionError:
                status = b''
            self.returncode = status[0] if status else 1
        return self.returncode


def prestarted():
    connection = socket.socket(socket.AF_UNIX)
    try:
        connection.settimeout(5)
        connection.connect(str(PRESTART))
        return Prestarted(connection)
    except (OSError, ValueError):
        connection.close()
        return None


def stop_group(process, method):
    if process.poll() is None:
        try:
            if isinstance(process, Prestarted):
                process.connection.send(bytes([method]))
            else:
                os.killpg(process.pid, method)
        except OSError:  # Already gone (macOS reports a zombie group as EPERM) or holder closed.
            pass


def prestart():
    # Pi loads while the sandbox boots, then waits on its private stdin for the first Pi supervisor.
    _root_linux()
    _prctl(4, 0)
    PRESTART.parent.mkdir(mode=0o700)
    _trusted_path(PRESTART.parent)
    process = spawn_worker()
    try:
        with socket.socket(socket.AF_UNIX) as server:
            server.bind(str(PRESTART))
            server.listen(1)
            while not select.select([server], [], [], 1)[0]:
                if process.poll() is not None:
                    return
            connection = server.accept()[0]
        PRESTART.unlink()
        with connection:
            socket.send_fds(connection, [b'W'], [process.stdin.fileno(), process.stderr.fileno()])
            process.stdin.close()
            process.stderr.close()
            # The supervisor asks and this parent signals and reaps: no stop reaches a reused PID.
            while process.poll() is None:
                if select.select([connection], [], [], 1)[0]:
                    request = connection.recv(1)
                    if not request:
                        return
                    stop_group(process, signal.SIGTERM if request[0] == signal.SIGTERM
                               else signal.SIGKILL)
            connection.sendall(bytes([process.returncode & 255]))
    finally:
        PRESTART.unlink(missing_ok=True)
        if process.poll() is None:
            stop_group(process, signal.SIGKILL)
            process.wait()


def supervisor():
    _root_linux()
    _prctl(4, 0)
    filename, raw = read_bootstrap()
    try:
        data = json.loads(raw)
        if type(data) is not dict:
            raise ValueError('invalid bootstrap')
        if 'kind' not in data:
            _trusted_path(NODE)
            # A Pi worker loaded at boot never meets a workflow: its holder kills it once claimed.
            prestarted()
            os.execve(str(NODE), [str(NODE), '/opt/merv/runner/smoke-supervisor.mjs'], {
                'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8',
                'MERV_BOOTSTRAP_FILE': str(filename),
            })
        lifetime = validate_pi(data, len(raw))
    except Exception:
        filename.unlink(missing_ok=True)
        raise
    finally:
        raw[:] = b'\x00' * len(raw)
    payload = bytearray(json.dumps(data, separators=(',', ':')).encode())
    data.clear()
    filename.unlink()
    os.environ.pop('MERV_BOOTSTRAP_FILE', None)
    process = None
    try:
        process = prestarted() or spawn_worker()
        reader = threading.Thread(target=forward_diagnostics, args=(process.stderr,), daemon=True)
        reader.start()
        stopping_at = None

        def stop(_signal, _frame):
            nonlocal stopping_at
            stopping_at = stopping_at or time.monotonic()
            stop_group(process, signal.SIGTERM)

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        process.stdin.write(payload)
        process.stdin.close()
        payload[:] = b'\x00' * len(payload)
        deadline = time.monotonic() + lifetime
        while process.poll() is None:
            if time.monotonic() >= deadline:
                stop(None, None)
            if stopping_at is not None and time.monotonic() - stopping_at >= 5:
                stop_group(process, signal.SIGKILL)
                break
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
        process.wait()
        reader.join(1)
        return process.returncode
    finally:
        payload[:] = b'\x00' * len(payload)
        if process is not None and process.poll() is None:
            stop_group(process, signal.SIGKILL)
            process.wait()


def main():
    try:
        if sys.argv[1:] == ['--worker']:
            worker()
        elif sys.argv[1:] == ['--prestart']:
            prestart()
        elif not sys.argv[1:]:
            sys.exit(supervisor())
        else:
            sys.exit(64)
    except Exception:
        sys.stderr.write('Protected runtime failed\n')
        sys.exit(1)


if __name__ == '__main__':
    main()
