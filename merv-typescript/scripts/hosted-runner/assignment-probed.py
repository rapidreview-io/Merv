#!/usr/bin/python3
import ctypes
import base64
import os
import stat
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, '/opt/merv/python')
from merv_sandboxes.runtimes import assignment
from isolation_probe import attest_workflow


def readonly_code(path):
    """A private mount namespace, established before the irreversible identity drop.

    The independent review checkout includes its own Git directory. No writeable
    alias, external Git directory or nested mount may bypass the read-only bind.
    Scratch remains outside this mount in /tmp. A kernel without this boundary
    refuses the launch instead of relying on the agent's tool permissions.
    """
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise assignment.IsolationUnavailable('read-only review mounts require Linux root')
    path = path.resolve(strict=True)
    dot = path / '.git'
    if dot.exists() or dot.is_symlink():
        info = dot.lstat()
        if (not stat.S_ISDIR(info.st_mode) or dot.is_symlink()
                or (dot / 'commondir').exists()
                or (dot / 'objects/info/alternates').exists()):
            raise assignment.IsolationUnavailable('review requires independent Git metadata')
    # A newly materialized review must not share mutable inodes with the producer.
    for directory, directories, files in os.walk(path, followlinks=False):
        for name in files:
            info = (Path(directory) / name).lstat()
            if stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
                raise assignment.IsolationUnavailable('review checkout contains shared files')
    libc = ctypes.CDLL(None, use_errno=True)
    libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p,
                          ctypes.c_ulong, ctypes.c_void_p]
    libc.mount.restype = ctypes.c_int

    def checked(result):
        if result != 0:
            raise assignment.IsolationUnavailable('read-only review mount unavailable')

    checked(libc.unshare(0x00020000))  # CLONE_NEWNS; never modify the supervisor's mounts.
    checked(libc.mount(None, b'/', None, (1 << 14) | (1 << 18), None))  # REC | PRIVATE
    # Refuse nested mounts rather than accidentally leaving one writable.
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        mount = line.split()[4]
        for escaped, decoded in ((r'\040', ' '), (r'\011', '\t'),
                                 (r'\012', '\n'), (r'\134', '\\')):
            mount = mount.replace(escaped, decoded)
        if mount.startswith(str(path) + '/'):
            raise assignment.IsolationUnavailable('review checkout contains a nested mount')
    encoded = os.fsencode(path)
    checked(libc.mount(encoded, encoded, None, 4096, None))  # BIND
    checked(libc.mount(None, encoded, None, 4096 | 32 | 1 | 2 | 4, None))  # BIND REMOUNT RDONLY NOSUID NODEV
    if not os.statvfs(path).f_flag & os.ST_RDONLY:
        raise assignment.IsolationUnavailable('review checkout is not read-only')


def main():
    original = assignment.prepare_assignment_identity
    original_environment = assignment._scoped_environment

    def scoped_environment(source, *, login=False):
        result = original_environment(source, login=login)
        token, remote = source.get('MERV_GIT_TOKEN'), source.get('MERV_GIT_URL')
        if not login and (token is not None or remote is not None):
            url, endpoint = urlsplit(remote or ''), urlsplit(source.get('MERV_MCP_URL', ''))
            if (not re.fullmatch(r'mg_[A-Za-z0-9_-]{43}', token or '')
                    or url.scheme != endpoint.scheme or url.netloc != endpoint.netloc
                    or url.username or url.password or url.query or url.fragment
                    or not re.fullmatch(r'/git/[A-Za-z0-9_-]+\.git', url.path)):
                raise assignment.IsolationUnavailable('assignment Git credential is invalid')
            encoded = base64.b64encode(('merv:' + token).encode()).decode()
            result.update({
                'GIT_CONFIG_COUNT': '2', 'GIT_CONFIG_KEY_0': 'http.' + remote + '.extraHeader',
                'GIT_CONFIG_VALUE_0': 'Authorization: Basic ' + encoded,
                'GIT_CONFIG_KEY_1': 'http.followRedirects', 'GIT_CONFIG_VALUE_1': 'false',
            })
        return result

    def checked_identity(**options):
        if sys.argv[1:4] == ['--', str(assignment.CODEX_EXECUTABLE), 'exec']:
            attest_workflow(Path.cwd())
            if os.environ.get('MERV_REVIEW_CODE') == '1':
                readonly_code(Path.cwd())
        original(**options)

    assignment.prepare_assignment_identity = checked_identity
    assignment._scoped_environment = scoped_environment
    return assignment.main()


if __name__ == '__main__':
    raise SystemExit(main())
