import errno
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch


SANDBOX = Path(__file__).resolve().parents[3] / "output/fleet-sandboxes/control/src"
sys.path.insert(0, str(SANDBOX))
SPEC = importlib.util.spec_from_file_location("isolation_probe", Path(__file__).with_name("isolation_probe.py"))
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


ROOTS = {
    "supervisor": {"pid": 101, "ppid": 1, "starttime": 12},
    "guardian": {"pid": 102, "ppid": 101, "starttime": 13},
    "group": {"pid": 103, "ppid": 102, "starttime": 14},
}
ENDPOINT = {"path": "/tmp/guardian.sock", "path_inode": 10,
            "bound_inode": 20, "guardian_fd": 7}
WORKSPACE = Path("/workspace/assignments/" + "a" * 64)


class IsolationProbeTests(unittest.TestCase):
    def test_process_pins_starttime_and_root_node_executable(self):
        fields = [b"S", b"101"] + [b"0"] * 17 + [b"987654"]
        contents = b"103 (node) " + b" ".join(fields)
        info = SimpleNamespace(st_uid=0)
        with patch.object(probe.Path, "read_bytes", return_value=contents):
            with patch.object(probe.Path, "stat", return_value=info):
                with patch.object(probe.os, "readlink", return_value=probe.NODE):
                    self.assertEqual(probe._process(103),
                                     {"pid": 103, "ppid": 101, "starttime": 987654})
                with patch.object(probe.os, "readlink", return_value="/usr/bin/node"):
                    with self.assertRaises(probe.IsolationUnavailable):
                        probe._process(103)

    def test_protected_catalog_requires_root_private_regular_file(self):
        with patch.object(probe.Path, "lstat", return_value=SimpleNamespace(
                st_uid=0, st_mode=stat.S_IFREG | 0o600, st_nlink=1)):
            probe._private(probe.CATALOG, 0o600, False)
        for info in (SimpleNamespace(st_uid=12001, st_mode=stat.S_IFREG | 0o600, st_nlink=1),
                     SimpleNamespace(st_uid=0, st_mode=stat.S_IFLNK | 0o600, st_nlink=1),
                     SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o644, st_nlink=1)):
            with patch.object(probe.Path, "lstat", return_value=info):
                with self.assertRaises(probe.IsolationUnavailable):
                    probe._private(probe.CATALOG, 0o600, False)
        with patch.object(probe.Path, "lstat", side_effect=FileNotFoundError(errno.ENOENT, "absent")):
            with self.assertRaises(FileNotFoundError):
                probe._private(probe.CATALOG, 0o600, False)

    def test_denial_requires_permission_error_not_missing_or_success(self):
        for error in (errno.EPERM, errno.EACCES):
            with self.subTest(error=error):
                def denied():
                    raise OSError(error, "denied")

                self.assertEqual(probe._denial(denied), error)
        for error in (errno.ENOENT, errno.ESRCH, errno.ENXIO):
            with self.subTest(error=error), self.assertRaises(probe.IsolationUnavailable):
                def absent():
                    raise OSError(error, "absent")

                probe._denial(absent)
        with tempfile.TemporaryFile() as output:
            descriptor = os.dup(output.fileno())
            with self.assertRaises(probe.IsolationUnavailable):
                probe._denial(lambda: descriptor)
            with self.assertRaises(OSError) as failure:
                os.fstat(descriptor)
            self.assertEqual(failure.exception.errno, errno.EBADF)

    def test_ptrace_attach_denial_and_cleanup(self):
        library = SimpleNamespace(ptrace=lambda *_: -1)
        with patch.object(probe.ctypes, "CDLL", return_value=library):
            with patch.object(probe.ctypes, "get_errno", return_value=errno.EPERM):
                self.assertEqual(probe._ptrace(101), errno.EPERM)
            with patch.object(probe.ctypes, "get_errno", return_value=errno.ESRCH):
                with self.assertRaises(probe.IsolationUnavailable):
                    probe._ptrace(101)
        calls = []
        library.ptrace = lambda *arguments: calls.append(arguments) or 0
        with patch.object(probe.ctypes, "CDLL", return_value=library):
            with self.assertRaises(probe.IsolationUnavailable):
                probe._ptrace(101)
        self.assertEqual([call[0] for call in calls], [16, 17])

    def test_ancestry_binds_exact_scripts_and_ledger_arguments(self):
        commands = {
            101: [probe.NODE, probe.SMOKE],
            102: [probe.NODE, probe.SUPERVISOR, "guardian", str(probe.LEDGER), "launch_1"],
            103: [probe.NODE, probe.SUPERVISOR, "group"],
        }
        def process(pid):
            return next(info.copy() for info in ROOTS.values() if info["pid"] == pid)

        with patch.object(probe.os, "getppid", return_value=103):
            with patch.object(probe, "_process", side_effect=process):
                with patch.object(probe, "_command", side_effect=lambda pid: commands[pid]):
                    self.assertEqual(probe._roots(), (ROOTS, "launch_1"))
                    commands[102][3] = "/tmp/other.sqlite"
                    with self.assertRaises(probe.IsolationUnavailable):
                        probe._roots()
                    commands[102][3] = str(probe.LEDGER)
                    commands[102].append("unexpected")
                    with self.assertRaises(probe.IsolationUnavailable):
                        probe._roots()
                    commands[102].pop()
                    commands[103][-1] = "guardian"
                    with self.assertRaises(probe.IsolationUnavailable):
                        probe._roots()

    def test_socket_requires_bound_inode_in_guardian_fd(self):
        def link(name):
            return "socket:[20]" if name.endswith("/7") else "socket:[99]"

        valid = "Num RefCount Protocol Flags Type St Inode Path\n000: 1 0 00010000 0001 01 20 "
        directory = f"/tmp/merv-runner-0-{probe.hashlib.sha256(str(probe.LEDGER.parent).encode()).hexdigest()[:16]}"
        socket_path = f"{directory}/{probe.hashlib.sha256(b'launch_1').hexdigest()[:24]}.sock"
        socket_info = SimpleNamespace(st_uid=0, st_mode=stat.S_IFSOCK | 0o600, st_ino=99)
        with patch.object(probe, "_private"), patch.object(probe.Path, "lstat", return_value=socket_info):
            with patch.object(probe.Path, "read_text", return_value=valid + socket_path + "\n"):
                with patch.object(probe.os, "listdir", return_value=["7", "8"]):
                    with patch.object(probe.os, "readlink", side_effect=link):
                        observed = probe._socket(102, "launch_1")
                        self.assertEqual(observed["bound_inode"], 20)
                        self.assertEqual(observed["path_inode"], 99)
                        self.assertEqual(observed["guardian_fd"], 7)
                    with patch.object(probe.os, "readlink", return_value="socket:[99]"):
                        with self.assertRaises(probe.IsolationUnavailable):
                            probe._socket(102, "launch_1")
            with patch.object(probe.Path, "read_text", return_value=valid + "/other.sock\n"):
                with self.assertRaises(probe.IsolationUnavailable):
                    probe._socket(102, "launch_1")

    def test_child_probes_all_roots_without_reading_protected_content(self):
        identity = {"uids": [12001] * 3}
        with patch.object(probe, "_identity", return_value=identity):
            with patch.object(probe, "_denial", return_value=errno.EACCES) as denial:
                with patch.object(probe, "_ptrace", return_value=errno.EPERM) as ptrace:
                    with patch.object(probe.socket, "socket"), patch.object(probe, "_listeners", return_value=[]):
                        with patch.object(probe.subprocess, "run", return_value=SimpleNamespace(returncode=1)) as run:
                            result = probe._probe(ROOTS, ENDPOINT)
        self.assertEqual(ptrace.call_count, 3)
        self.assertEqual(denial.call_count, 3 * 3 + 1 + 5 + 1)
        self.assertEqual(len(result["outcomes"]), 3 * 4 + 1 + 5 + 1 + 1)
        self.assertEqual(result["listeners"], [])
        self.assertTrue(all(outcome in (errno.EPERM, errno.EACCES, 1)
                            for outcome in result["outcomes"].values()))
        self.assertEqual(run.call_args.args[0],
                         ["/usr/bin/sudo", "-n", "-u", "root", "--", "/usr/bin/true"])
        self.assertEqual(run.call_args.kwargs["env"], {"PATH": "/usr/bin:/bin", "LANG": "C"})

    def test_identity_requires_all_ids_caps_and_no_new_privileges(self):
        status = "\n".join([f"{key}:\t0000000000000000" for key in
                            ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")]) + "\nNoNewPrivs:\t1\n"
        with patch.object(probe.Path, "read_text", return_value=status):
            with patch.object(probe.os, "getresuid", return_value=(12001,) * 3, create=True):
                with patch.object(probe.os, "getresgid", return_value=(12001,) * 3, create=True):
                    with patch.object(probe.os, "getgroups", return_value=[]):
                        self.assertEqual(probe._identity()["no_new_privs"], 1)
                        with patch.object(probe.os, "getgroups", return_value=[1000]):
                            with self.assertRaises(probe.IsolationUnavailable):
                                probe._identity()
                        with patch.object(probe.Path, "read_text", return_value=status.replace(
                                "CapBnd:\t0000000000000000", "CapBnd:\t0000000000000001")):
                            with self.assertRaises(probe.IsolationUnavailable):
                                probe._identity()

    def test_parent_rejects_incomplete_or_forged_success(self):
        identity = {"uids": [12001] * 3, "gids": [12001] * 3, "groups": [],
                    "caps": {key: "0000000000000000" for key in
                             ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")},
                    "no_new_privs": 1}
        outcomes = {f"{name}_{operation}": errno.EACCES
                    for name in ("supervisor", "guardian", "group")
                    for operation in ("environ", "fd", "signal", "ptrace")}
        outcomes.update({key: errno.EPERM for key in
                         ("guardian_socket_fd", "ledger_directory", "runtime_directory",
                          "state_directory", "ledger_catalog", "release_catalog", "guardian_connect")})
        outcomes["sudo_returncode"] = 1
        valid = {"ok": True, "identity": identity, "outcomes": outcomes, "listeners": []}
        self.assertTrue(probe._valid_result(valid))
        self.assertTrue(probe._valid_result({**valid, "listeners": [probe.SSHD]}))
        # With the network on, any other listener could be reached from the assignment's shell.
        for listeners in (["0100007F:1F90 0"], [probe.SSHD, "00000000:0016 0"],
                          ["0100007F:0016 12001"], None):
            self.assertFalse(probe._valid_result({**valid, "listeners": listeners}))
        self.assertFalse(probe._valid_result({key: valid[key] for key in ("ok", "identity", "outcomes")}))
        self.assertFalse(probe._valid_result({**valid, "outcomes": {**outcomes, "group_signal": errno.ESRCH}}))
        self.assertFalse(probe._valid_result({**valid, "identity": {**identity, "groups": [1000]}}))
        self.assertFalse(probe._valid_result({**valid, "outcomes": {**outcomes, "sudo_returncode": 0}}))
        self.assertFalse(probe._valid_result([valid]))

    def test_entry_rejects_login_and_arbitrary_command_without_forking(self):
        argv = [probe.ASSIGNMENT, "--", "/opt/merv/bin/codex", "login", "--with-api-key"]
        with patch.object(probe, "_root_linux"), patch.object(probe.Path, "cwd", return_value=WORKSPACE):
            with patch.object(probe.sys, "argv", argv), patch.object(probe, "_collect") as collect:
                with self.assertRaises(probe.IsolationUnavailable):
                    probe.attest_workflow(WORKSPACE)
                collect.assert_not_called()
            argv = [probe.ASSIGNMENT, "--", "/opt/merv/bin/codex", "exec", "-C", str(WORKSPACE)]
            with patch.object(probe.sys, "argv", argv):
                with self.assertRaises(probe.IsolationUnavailable):
                    probe.attest_workflow(WORKSPACE.parent / "other")

    def test_fixed_exec_rechecks_targets_then_creates_one_report(self):
        argv = [probe.ASSIGNMENT, "--", "/opt/merv/bin/codex", "exec", "-C", str(WORKSPACE)]
        output = Path("/run/merv-isolation") / f"{WORKSPACE.name}.json"
        with patch.object(probe, "_root_linux"), patch.object(probe.Path, "cwd", return_value=WORKSPACE), \
                patch.object(probe, "_sshd") as sshd:
            with patch.object(probe.sys, "argv", argv), patch.object(probe, "_private"):
                with patch.object(probe.Path, "stat", return_value=SimpleNamespace(
                        st_uid=0, st_mode=stat.S_IFREG | stat.S_ISUID | 0o755)):
                    with patch.object(probe, "_roots", return_value=(ROOTS, "launch_1")) as roots:
                        with patch.object(probe, "_socket", return_value=ENDPOINT) as endpoint:
                            with patch.object(probe, "_safe_context", return_value={}):
                                with patch.object(probe, "_collect", return_value={"ok": True}):
                                    with patch.object(probe, "_report", return_value=output) as report:
                                        self.assertEqual(probe.attest_workflow(WORKSPACE), output)
                                        self.assertEqual(roots.call_count, 2)
                                        self.assertEqual(endpoint.call_count, 2)
                                        self.assertEqual(report.call_count, 1)
                                        sshd.assert_called_once_with()

    def test_post_probe_pid_reuse_or_socket_change_refuses_report(self):
        argv = [probe.ASSIGNMENT, "--", "/opt/merv/bin/codex", "exec", "-C", str(WORKSPACE)]
        changed = {**ROOTS, "guardian": {**ROOTS["guardian"], "starttime": 15}}
        with patch.object(probe, "_root_linux"), patch.object(probe.Path, "cwd", return_value=WORKSPACE), \
                patch.object(probe, "_sshd"):
            with patch.object(probe.sys, "argv", argv), patch.object(probe, "_private"):
                with patch.object(probe.Path, "stat", return_value=SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | stat.S_ISUID | 0o755)):
                    with patch.object(probe, "_roots", side_effect=[(ROOTS, "launch_1"), (changed, "launch_1")]):
                        with patch.object(probe, "_socket", return_value=ENDPOINT):
                            with patch.object(probe, "_safe_context", return_value={}):
                                with patch.object(probe, "_collect", return_value={"ok": True}):
                                    with patch.object(probe, "_report") as report:
                                        with self.assertRaises(probe.IsolationUnavailable):
                                            probe.attest_workflow(WORKSPACE)
                                        report.assert_not_called()
                    with patch.object(probe, "_roots", return_value=(ROOTS, "launch_1")):
                        with patch.object(probe, "_socket", side_effect=[ENDPOINT, {**ENDPOINT, "bound_inode": 21}]):
                            with patch.object(probe, "_safe_context", return_value={}):
                                with patch.object(probe, "_collect", return_value={"ok": True}):
                                    with patch.object(probe, "_report") as report:
                                        with self.assertRaises(probe.IsolationUnavailable):
                                            probe.attest_workflow(WORKSPACE)
                                        report.assert_not_called()

    def test_listeners_are_every_tcp_listen_socket_with_its_owner(self):
        tables = {
            "/proc/net/tcp": "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
                             "   0: 0100007F:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 11\n"
                             "   1: 0100007F:9C40 0100007F:0016 01 00000000:00000000 00:00000000 00000000 12001        0 12\n",
            "/proc/net/tcp6": "  sl  local_address remote_address st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
                              "   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A "
                              "00000000:00000000 00:00000000 00000000  1000        0 13\n",
        }
        with patch.object(probe.Path, "exists", return_value=True):
            with patch.object(probe.Path, "read_text", autospec=True, side_effect=lambda path: tables[str(path)]):
                self.assertEqual(probe._listeners(), [
                    "00000000000000000000000001000000:1F90 1000", probe.SSHD])
        with patch.object(probe.Path, "exists", side_effect=[True, False]):
            with patch.object(probe.Path, "read_text", return_value=tables["/proc/net/tcp"]):
                self.assertEqual(probe._listeners(), [probe.SSHD])

    def test_sshd_must_refuse_passwords_and_keyboard_interactive(self):
        settings = "port 22\npasswordauthentication no\nkbdinteractiveauthentication no\n"
        for stdout, code, allowed in ((settings, 0, True), (settings, 255, False),
                                      (settings.replace("password", "x", 1), 0, False),
                                      (settings.replace("passwordauthentication no", "passwordauthentication yes"), 0, False),
                                      (settings.replace("kbdinteractiveauthentication no", "kbdinteractiveauthentication yes"), 0, False)):
            with self.subTest(stdout=stdout, code=code):
                answer = SimpleNamespace(returncode=code, stdout=stdout.encode())
                with patch.object(probe.subprocess, "run", return_value=answer) as run:
                    if allowed:
                        probe._sshd()
                    else:
                        with self.assertRaises(probe.IsolationUnavailable):
                            probe._sshd()
                self.assertEqual(run.call_args.args[0], ["/usr/sbin/sshd", "-T"])

    def test_report_is_exclusive_read_only_and_closes_fd_on_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(probe, "REPORT_DIR", Path(directory) / "reports"):
                with patch.object(probe, "_private"):
                    descriptors = []
                    original_open = os.open
                    def tracked_open(*arguments, **options):
                        descriptor = original_open(*arguments, **options)
                        descriptors.append(descriptor)
                        return descriptor

                    with patch.object(probe.os, "open", side_effect=tracked_open):
                        path = probe._report(WORKSPACE, {"ok": True})
                    self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o444)
                    self.assertEqual(json.loads(path.read_text()), {"ok": True})
                    with self.assertRaises(OSError) as failure:
                        os.fstat(descriptors[0])
                    self.assertEqual(failure.exception.errno, errno.EBADF)
                    with self.assertRaises(FileExistsError):
                        probe._report(WORKSPACE, {"ok": False})
                    self.assertEqual(json.loads(path.read_text()), {"ok": True})
                    with patch.object(probe.os, "fsync", side_effect=OSError(errno.EIO, "error")):
                        second = Path(directory) / "another"
                        with self.assertRaises(OSError):
                            probe._report(second, {"ok": True})
                        self.assertFalse((probe.REPORT_DIR / "another.json").exists())

    def test_child_scrubs_environment_and_closes_inherited_descriptors(self):
        with patch.dict(os.environ, {"PROBE_PRIVATE_EXAMPLE": "do-not-send"}):
            inherited = os.open(os.devnull, os.O_RDONLY)
            def drop(**arguments):
                if arguments != {"uid": 12001, "gid": 12001, "administrative_uid": 1000,
                                 "preserve_stdio": True}:
                    raise AssertionError("wrong identity drop")
                for descriptor in range(3, 512):
                    try:
                        os.close(descriptor)
                    except OSError:
                        pass

            def check(*_arguments):
                if os.environ or os.path.exists(f"/dev/fd/{inherited}"):
                    raise AssertionError("inherited authority remained")
                identity = {"uids": [12001] * 3, "gids": [12001] * 3, "groups": [],
                            "caps": {key: "0000000000000000" for key in
                                     ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")},
                            "no_new_privs": 1}
                outcomes = {f"{name}_{operation}": errno.EACCES
                            for name in ("supervisor", "guardian", "group")
                            for operation in ("environ", "fd", "signal", "ptrace")}
                outcomes.update({key: errno.EACCES for key in
                                 ("guardian_socket_fd", "ledger_directory", "runtime_directory",
                                  "state_directory", "ledger_catalog", "release_catalog", "guardian_connect")})
                outcomes["sudo_returncode"] = 1
                return {"identity": identity, "outcomes": outcomes, "listeners": []}

            try:
                with patch.object(probe, "prepare_assignment_identity", side_effect=drop):
                    with patch.object(probe, "_prctl", side_effect=lambda option, value: None if
                                      (option, value) == (4, 0) else 1):
                        with patch.object(probe, "_probe", side_effect=check):
                            with patch.object(probe.os, "pipe2", side_effect=lambda _: os.pipe(), create=True):
                                self.assertTrue(probe._collect(ROOTS, ENDPOINT)["ok"])
            finally:
                try:
                    os.close(inherited)
                except OSError:
                    pass

    def test_collector_timeout_reaps_child_and_closes_pipe(self):
        descriptors = []
        original = os.pipe
        def pipe(flags):
            pair = original()
            descriptors.extend(pair)
            return pair

        def stuck(*_arguments):
            time.sleep(2)

        with patch.object(probe, "TIMEOUT", 0.1):
            with patch.object(probe.os, "pipe2", side_effect=pipe, create=True):
                with patch.object(probe, "_child", side_effect=stuck):
                    with self.assertRaises(probe.IsolationUnavailable):
                        probe._collect(ROOTS, ENDPOINT)
        for descriptor in descriptors:
            with self.assertRaises(OSError) as failure:
                os.fstat(descriptor)
            self.assertEqual(failure.exception.errno, errno.EBADF)


if __name__ == "__main__":
    unittest.main()
