"""Fixed, fail-closed pre-exec isolation attestation for hosted workflows."""

from __future__ import annotations

import ctypes
import errno
import hashlib
import json
import os
import re
import select
import signal
import socket
import stat
import subprocess
import sys
import time
from pathlib import Path

from merv_sandboxes.runtimes.launcher import (
    IsolationUnavailable, _prctl, _root_linux, prepare_assignment_identity,
)


NODE = "/usr/local/bin/node"
SUPERVISOR = "/opt/merv/runner/supervisor.mjs"
SMOKE = "/opt/merv/runner/smoke-supervisor.mjs"
ASSIGNMENT = "/opt/merv/runtime/assignment-probed.py"
LEDGER = Path("/var/lib/merv-runner/ledger.sqlite")
CATALOG = Path("/opt/merv/runtime/releases.json")
REPORT_DIR = Path("/run/merv-isolation")
DENIED = (errno.EPERM, errno.EACCES)
MAX_REPORT = 8192
TIMEOUT = 5.0


def _process(pid: int) -> dict[str, int]:
    raw = Path(f"/proc/{pid}/stat").read_bytes()
    fields = raw.rsplit(b") ", 1)[1].split()
    if fields[0] in (b"Z", b"X"):
        raise IsolationUnavailable("isolation target is not running")
    info = Path(f"/proc/{pid}").stat()
    if info.st_uid != 0 or os.readlink(f"/proc/{pid}/exe") != NODE:
        raise IsolationUnavailable("isolation target is not the root Node runtime")
    return {"pid": pid, "ppid": int(fields[1]), "starttime": int(fields[19])}


def _command(pid: int) -> list[str]:
    raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    if not raw.endswith(b"\0") or len(raw) > 4096:
        raise IsolationUnavailable("isolation target command is invalid")
    return [item.decode("utf-8") for item in raw[:-1].split(b"\0")]


def _roots() -> tuple[dict[str, dict[str, int]], str]:
    group = _process(os.getppid())
    guardian = _process(group["ppid"])
    supervisor = _process(guardian["ppid"])
    if (_command(group["pid"]) != [NODE, SUPERVISOR, "group"]
            or _command(supervisor["pid"]) != [NODE, SMOKE]):
        raise IsolationUnavailable("isolation target ancestry is invalid")
    arguments = _command(guardian["pid"])
    if (len(arguments) != 5 or arguments[:3] != [NODE, SUPERVISOR, "guardian"]
            or arguments[3] != str(LEDGER)
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", arguments[4])):
        raise IsolationUnavailable("isolation guardian command is invalid")
    if (group["ppid"] != guardian["pid"] or guardian["ppid"] != supervisor["pid"]):
        raise IsolationUnavailable("isolation target ancestry changed")
    return {"supervisor": supervisor, "guardian": guardian, "group": group}, arguments[4]


def _private(path: Path, mode: int, directory: bool) -> None:
    info = path.lstat()
    if (info.st_uid != 0 or stat.S_IMODE(info.st_mode) != mode
            or not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            or (not directory and info.st_nlink != 1)):
        raise IsolationUnavailable("isolation protected path is invalid")


def _socket(guardian: int, launch_id: str) -> dict[str, object]:
    directory = Path(f"/tmp/merv-runner-0-{hashlib.sha256(str(LEDGER.parent).encode()).hexdigest()[:16]}")
    path = directory / f"{hashlib.sha256(launch_id.encode()).hexdigest()[:24]}.sock"
    _private(directory, 0o700, True)
    info = path.lstat()
    if (info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600
            or not stat.S_ISSOCK(info.st_mode)):
        raise IsolationUnavailable("isolation socket is invalid")
    matches = []
    for line in Path("/proc/net/unix").read_text().splitlines()[1:]:
        parts = line.split(maxsplit=7)
        if (len(parts) == 8 and parts[7] == str(path)):
            if parts[3] != "00010000" or parts[4] != "0001":
                raise IsolationUnavailable("isolation socket is not listening")
            matches.append(int(parts[6]))
    if len(matches) != 1:
        raise IsolationUnavailable("isolation guardian socket is not bound")
    fd_matches = [int(name) for name in os.listdir(f"/proc/{guardian}/fd")
                  if name.isdecimal() and os.readlink(f"/proc/{guardian}/fd/{name}")
                  == f"socket:[{matches[0]}]"]
    if len(fd_matches) != 1:
        raise IsolationUnavailable("isolation guardian does not own socket")
    return {"path": str(path), "path_inode": info.st_ino,
            "bound_inode": matches[0], "guardian_fd": fd_matches[0]}


def _safe_context() -> dict[str, object]:
    namespaces = {}
    for name in ("pid", "mnt", "net"):
        value = os.readlink(f"/proc/self/ns/{name}")
        if not re.fullmatch(rf"{name}:\[[0-9]+\]", value):
            raise IsolationUnavailable("isolation namespace is invalid")
        namespaces[name] = value
    mounts = [int(line.split()[0]) for line in Path("/proc/self/mountinfo").read_text().splitlines()
              if line.split()[4] == "/proc"]
    if len(mounts) != 1:
        raise IsolationUnavailable("isolation proc mount is invalid")
    return {"namespaces": namespaces, "proc_mount_id": mounts[0],
            "proc_device": os.stat("/proc").st_dev,
            "ledger_device": LEDGER.parent.stat().st_dev}


def _denial(action) -> int:
    try:
        descriptor = action()
    except OSError as error:
        if error.errno in DENIED:
            return error.errno
        raise IsolationUnavailable("isolation access did not fail with permission denial") from None
    else:
        if isinstance(descriptor, int):
            os.close(descriptor)
        raise IsolationUnavailable("isolation access was permitted")


def _ptrace(pid: int) -> int:
    libc = ctypes.CDLL(None, use_errno=True)
    ctypes.set_errno(0)
    result = libc.ptrace(16, pid, None, None)
    if result == 0:
        libc.ptrace(17, pid, None, None)
        raise IsolationUnavailable("isolation ptrace was permitted")
    error = ctypes.get_errno()
    if error not in DENIED:
        raise IsolationUnavailable("isolation ptrace was not denied")
    return error


def _identity() -> dict[str, object]:
    fields = {}
    for line in Path("/proc/self/status").read_text().splitlines():
        key, _, value = line.partition(":")
        if key in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs"):
            fields[key] = value.strip()
    if (os.getresuid() != (12001, 12001, 12001)
            or os.getresgid() != (12001, 12001, 12001) or os.getgroups()
            or any(fields.get(key) != "0000000000000000"
                   for key in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"))
            or fields.get("NoNewPrivs") != "1"):
        raise IsolationUnavailable("isolation assignment identity is invalid")
    return {"uids": list(os.getresuid()), "gids": list(os.getresgid()),
            "groups": [], "caps": {key: fields[key] for key in
                                   ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")},
            "no_new_privs": 1}


def _probe(roots: dict[str, dict[str, int]], endpoint: dict[str, object]) -> dict[str, object]:
    identity = _identity()
    outcomes = {}
    for name, target in roots.items():
        pid = target["pid"]
        for leaf in ("environ", "fd"):
            flags = os.O_RDONLY | os.O_CLOEXEC
            if leaf == "fd":
                flags |= os.O_DIRECTORY
            outcomes[f"{name}_{leaf}"] = _denial(
                lambda pid=pid, leaf=leaf, flags=flags: os.open(f"/proc/{pid}/{leaf}", flags))
        outcomes[f"{name}_signal"] = _denial(lambda pid=pid: os.kill(pid, 0))
        outcomes[f"{name}_ptrace"] = _ptrace(pid)
    guardian = roots["guardian"]["pid"]
    fd = endpoint["guardian_fd"]
    outcomes["guardian_socket_fd"] = _denial(
        lambda: os.open(f"/proc/{guardian}/fd/{fd}", os.O_RDONLY | os.O_CLOEXEC))
    for name, path, flags in (
        ("ledger_directory", LEDGER.parent, os.O_RDONLY | os.O_DIRECTORY),
        ("runtime_directory", Path("/run/merv-runtime"), os.O_RDONLY | os.O_DIRECTORY),
        ("state_directory", Path("/var/lib/merv-runtime"), os.O_RDONLY | os.O_DIRECTORY),
        ("ledger_catalog", LEDGER, os.O_RDONLY),
        ("release_catalog", CATALOG, os.O_RDONLY),
    ):
        outcomes[name] = _denial(lambda path=path, flags=flags: os.open(path, flags | os.O_CLOEXEC))
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(0.5)
        outcomes["guardian_connect"] = _denial(lambda: client.connect(endpoint["path"]))
    result = subprocess.run(
        ["/usr/bin/sudo", "-n", "-u", "root", "--", "/usr/bin/true"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env={"PATH": "/usr/bin:/bin", "LANG": "C"}, close_fds=True, timeout=2,
        check=False,
    )
    if result.returncode != 1:
        raise IsolationUnavailable("isolation sudo was not denied")
    outcomes["sudo_returncode"] = result.returncode
    return {"identity": identity, "outcomes": outcomes}


def _child(write_fd: int, read_fd: int, roots: dict[str, dict[str, int]],
           endpoint: dict[str, object]) -> None:
    ready = False
    try:
        os.close(read_fd)
        null_fd = os.open("/dev/null", os.O_RDWR | os.O_CLOEXEC)
        for descriptor in (0, 2):
            os.dup2(null_fd, descriptor)
        os.dup2(write_fd, 1)
        ready = True
        if null_fd > 2:
            os.close(null_fd)
        if write_fd > 2:
            os.close(write_fd)
        prepare_assignment_identity(uid=12001, gid=12001, administrative_uid=1000,
                                    preserve_stdio=True)
        _prctl(4, 0)
        os.environ.clear()
        result = {"ok": True, **_probe(roots, endpoint)}
        payload = json.dumps(result, separators=(",", ":")).encode()
        if len(payload) > MAX_REPORT - 1:
            raise IsolationUnavailable("isolation result too large")
        os.write(1, payload + b"\n")
        os._exit(0)
    except BaseException:
        try:
            os.environ.clear()
            if ready:
                os.write(1, b'{"ok":false}\n')
        except OSError:
            pass
        os._exit(1)


def _valid_result(result: object) -> bool:
    if type(result) is not dict or set(result) != {"ok", "identity", "outcomes"}:
        return False
    identity = result["identity"]
    outcomes = result["outcomes"]
    expected = {f"{name}_{operation}" for name in ("supervisor", "guardian", "group")
                for operation in ("environ", "fd", "signal", "ptrace")}
    expected.update(("guardian_socket_fd", "ledger_directory", "runtime_directory",
                     "state_directory", "ledger_catalog", "release_catalog", "guardian_connect"))
    if (result["ok"] is not True or type(identity) is not dict
            or type(outcomes) is not dict or set(outcomes) != expected | {"sudo_returncode"}):
        return False
    return (identity == {"uids": [12001] * 3, "gids": [12001] * 3, "groups": [],
                         "caps": {key: "0000000000000000" for key in
                                  ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")},
                         "no_new_privs": 1}
            and all(type(outcomes[key]) is int and outcomes[key] in DENIED for key in expected)
            and type(outcomes["sudo_returncode"]) is int and outcomes["sudo_returncode"] == 1)


def _collect(roots: dict[str, dict[str, int]], endpoint: dict[str, object]) -> dict[str, object]:
    read_fd, write_fd = os.pipe2(os.O_CLOEXEC)
    try:
        pid = os.fork()
    except BaseException:
        os.close(read_fd)
        os.close(write_fd)
        raise
    if pid == 0:
        _child(write_fd, read_fd, roots, endpoint)
        os._exit(1)
    os.close(write_fd)
    payload = bytearray()
    deadline = time.monotonic() + TIMEOUT
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([read_fd], [], [], remaining)[0]:
                raise IsolationUnavailable("isolation probe timed out")
            chunk = os.read(read_fd, MAX_REPORT - len(payload) + 1)
            if not chunk:
                break
            payload.extend(chunk)
            if len(payload) > MAX_REPORT:
                raise IsolationUnavailable("isolation result too large")
        ended, status = os.waitpid(pid, os.WNOHANG)
        if ended == 0:
            remaining = deadline - time.monotonic()
            while remaining > 0:
                ended, status = os.waitpid(pid, os.WNOHANG)
                if ended == pid:
                    break
                time.sleep(min(0.01, remaining))
                remaining = deadline - time.monotonic()
            else:
                raise IsolationUnavailable("isolation probe timed out")
        pid = 0
        if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
            raise IsolationUnavailable("isolation probe failed")
        result = json.loads(payload)
        if not _valid_result(result):
            raise IsolationUnavailable("isolation probe failed")
        return result
    finally:
        os.close(read_fd)
        if pid:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)


def _report(workspace: Path, result: dict[str, object]) -> Path:
    try:
        os.mkdir(REPORT_DIR, 0o755)
        os.chmod(REPORT_DIR, 0o755)
    except FileExistsError:
        pass
    _private(REPORT_DIR, 0o755, True)
    path = REPORT_DIR / f"{workspace.name}.json"
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                         0o444)
    try:
        os.fchmod(descriptor, 0o444)
        payload = json.dumps(result, sort_keys=True, separators=(",", ":")).encode() + b"\n"
        if len(payload) > MAX_REPORT:
            raise IsolationUnavailable("isolation report too large")
        with os.fdopen(descriptor, "wb", closefd=False) as output:
            output.write(payload)
            output.flush()
        os.fsync(descriptor)
    except BaseException:
        os.unlink(path)
        raise
    finally:
        os.close(descriptor)
    return path


def attest_workflow(workspace: Path) -> Path:
    """Attest only the fixed live hosted workflow immediately before its identity drop."""
    _root_linux()
    if (not isinstance(workspace, Path) or workspace.parent != Path("/workspace/assignments")
            or not re.fullmatch(r"[0-9a-f]{64}", workspace.name)
            or Path.cwd() != workspace
            or sys.argv[0] != ASSIGNMENT
            or sys.argv[1:4] != ["--", "/opt/merv/bin/codex", "exec"]
            or [sys.argv[index + 1] for index, value in enumerate(sys.argv[:-1])
                if value == "-C"] != [str(workspace)]):
        raise IsolationUnavailable("isolation probe requires fixed workflow exec")
    try:
        _private(Path("/run"), 0o755, True)
        _private(Path("/tmp"), 0o1777, True)
        for path, mode, directory in (
            (LEDGER.parent, 0o700, True), (LEDGER, 0o600, False),
            (Path("/run/merv-runtime"), 0o700, True),
            (Path("/var/lib/merv-runtime"), 0o700, True),
            (CATALOG, 0o600, False),
        ):
            _private(path, mode, directory)
        for executable in ("/usr/bin/sudo", "/usr/bin/true"):
            info = Path(executable).stat()
            if info.st_uid != 0 or not stat.S_ISREG(info.st_mode) or not info.st_mode & 0o111:
                raise IsolationUnavailable("isolation probe command is unavailable")
            if executable == "/usr/bin/sudo" and not info.st_mode & stat.S_ISUID:
                raise IsolationUnavailable("isolation sudo is not setuid")
        roots, launch_id = _roots()
        endpoint = _socket(roots["guardian"]["pid"], launch_id)
        context = _safe_context()
        child = _collect(roots, endpoint)
        verified_roots, verified_id = _roots()
        if (verified_roots != roots or verified_id != launch_id
                or _socket(roots["guardian"]["pid"], launch_id) != endpoint):
            raise IsolationUnavailable("isolation targets changed during probe")
        return _report(workspace, {"workspace": workspace.name, "roots": roots,
                                   "socket": endpoint, "context": context, **child})
    except (OSError, ValueError, KeyError, IndexError) as error:
        raise IsolationUnavailable("isolation probe failed") from None
