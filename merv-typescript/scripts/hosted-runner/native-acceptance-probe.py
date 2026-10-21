#!/usr/bin/env python3
"""Worker-run facts for hosted native Git acceptance; no network or scientific work.

Run from the actual assignment checkout, including when this source is supplied on
stdin. Producers report existing canaries. Reviewers require the exact frozen
parent/tree and exercise only writes that the read-only mount must refuse.
The orchestrator must bind launcher.launchId to the session and separately prove
public transport, image identity, shutdown acknowledgement and provider deletion.
"""
import argparse
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys


class Refused(Exception):
    pass


def need(value, code):
    if not value:
        raise Refused(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(root, *args, required=True):
    # No inherited Git credential/config overrides, hooks, pager or external diff.
    result = subprocess.run(
        ['/usr/bin/git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
         '-c', 'core.pager=cat', '-C', str(root), *args],
        env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C',
             'HOME': '/nonexistent', 'GIT_CONFIG_NOSYSTEM': '1',
             'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_OPTIONAL_LOCKS': '0',
             'GIT_TERMINAL_PROMPT': '0'},
        stdin=subprocess.DEVNULL, capture_output=True, timeout=15, check=False,
    )
    need(len(result.stdout) + len(result.stderr) <= 2 * 1024 * 1024, 'git_output_limit')
    if required:
        need(result.returncode == 0, 'git_inspection_failed')
        return result.stdout.decode().strip()
    return result


def identity():
    fields = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines()
                  if ':' in line)
    caps = {name: fields.get(name, '').strip()
            for name in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb')}
    need(os.getresuid() == (12001,) * 3 and os.getresgid() == (12001,) * 3
         and not os.getgroups() and all(value == '0000000000000000' for value in caps.values())
         and fields.get('NoNewPrivs', '').strip() == '1', 'assignment_identity_invalid')
    return {'uid': 12001, 'gid': 12001, 'groups': [], 'caps': caps, 'noNewPrivs': 1}


def launcher_report(root):
    need(root.parent == Path('/workspace/assignments')
         and re.fullmatch(r'[0-9a-f]{64}', root.name), 'assignment_path_invalid')
    directory = Path('/run/merv-isolation')
    for path, mode in ((Path('/run'), 0o755), (directory, 0o755)):
        info = path.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
             and stat.S_IMODE(info.st_mode) == mode, 'launcher_report_directory_invalid')
    descriptor = os.open(directory / (root.name + '.json'), os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
             and stat.S_IMODE(info.st_mode) == 0o444 and info.st_size <= 8192,
             'launcher_report_file_invalid')
        raw = os.read(descriptor, 8193)
    finally:
        os.close(descriptor)
    report = json.loads(raw)
    need(report.get('ok') is True and report.get('workspace') == root.name
         and re.fullmatch(r'[A-Za-z0-9_-]{1,200}', report.get('launch_id', '')),
         'launcher_report_invalid')
    expected_identity = {
        'uids': [12001] * 3, 'gids': [12001] * 3, 'groups': [],
        'caps': {name: '0000000000000000'
                 for name in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb')},
        'no_new_privs': 1,
    }
    need(report.get('identity') == expected_identity, 'launcher_identity_invalid')
    roots = report.get('roots', {})
    need(set(roots) in ({'supervisor', 'guardian', 'group'},
                        {'supervisor', 'guardian', 'subreaper', 'group'}), 'launcher_roots_invalid')
    for target in roots.values():
        need(isinstance(target, dict) and set(target) == {'pid', 'ppid', 'starttime'}
             and all(type(value) is int and value > 0 for value in target.values()),
             'launcher_root_invalid')
        fields = Path('/proc/' + str(target['pid']) + '/stat').read_text().rsplit(') ', 1)[1].split()
        need(fields[0] not in ('Z', 'X') and int(fields[1]) == target['ppid']
             and int(fields[19]) == target['starttime'], 'launcher_root_not_live')
    expected = {f'{name}_{operation}' for name in roots
                for operation in ('environ', 'fd', 'signal', 'ptrace')}
    expected.update(('guardian_socket_fd', 'ledger_directory', 'runtime_directory',
                     'state_directory', 'ledger_catalog', 'release_catalog', 'guardian_connect'))
    outcomes = report.get('outcomes', {})
    need(set(outcomes) == expected | {'sudo_returncode'}
         and all(type(outcomes[key]) is int and outcomes[key] in (errno.EPERM, errno.EACCES)
                 for key in expected) and outcomes['sudo_returncode'] == 1
         and report.get('listeners') in ([], ['0100007F:0016 0']), 'launcher_denials_invalid')
    return {'launchId': report['launch_id'], 'sha256': sha(raw), 'roots': roots,
            'denialCount': len(expected), 'identity': report['identity']}


def inspect(root, prefix):
    need(re.fullmatch(r'[a-z][a-z0-9-]{0,47}', prefix), 'canary_prefix_invalid')
    need(Path(git(root, 'rev-parse', '--show-toplevel')).resolve() == root,
         'checkout_root_required')
    head = git(root, 'rev-parse', '--verify', 'HEAD')
    tree = git(root, 'write-tree')
    head_tree = git(root, 'rev-parse', 'HEAD^{tree}')
    need(all(re.fullmatch(r'(?:[0-9a-f]{40}|[0-9a-f]{64})', value)
             for value in (head, tree, head_tree)), 'git_object_invalid')
    status_bytes = git(root, 'status', '--porcelain=v1', '-z', required=False)
    need(status_bytes.returncode == 0, 'git_status_failed')
    markers = {}
    for path in sorted(root.iterdir()):
        if not (path.name == prefix or path.name.startswith(prefix + '-')):
            continue
        need(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', path.name), 'canary_name_invalid')
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(descriptor)
            need(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                 and info.st_size <= 1024 * 1024, 'canary_file_invalid')
            raw = os.read(descriptor, 1024 * 1024 + 1)
            need(len(raw) == info.st_size, 'canary_changed_during_read')
        finally:
            os.close(descriptor)
        markers[path.name] = {'sha256': sha(raw), 'bytes': len(raw)}
    need(0 < len(markers) <= 32, 'canaries_required')
    info = root.stat()
    return {'cwd': str(root), 'device': info.st_dev, 'inode': info.st_ino,
            'head': head, 'indexTree': tree, 'headTree': head_tree,
            'dirty': bool(status_bytes.stdout), 'statusSha256': sha(status_bytes.stdout),
            'markers': markers}


def readonly_mount(path):
    need(os.statvfs(path).f_flag & os.ST_RDONLY, 'review_mount_writable')
    matches = []
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        fields = line.split()
        mount = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), fields[4])
        if path == Path(mount) or Path(mount) in path.parents:
            matches.append((len(mount), fields[0], mount, fields[5].split(',')))
    need(matches, 'review_mount_missing')
    _, mount_id, mount, options = max(matches)
    need('ro' in options, 'review_mount_not_readonly')
    return {'id': int(mount_id), 'path': mount, 'readonly': True}


def write_denied(path):
    info = path.lstat()
    need(stat.S_ISREG(info.st_mode) and info.st_uid == 12001, 'review_probe_file_invalid')
    # Opening without O_TRUNC never changes data, even if the protection is broken.
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as error:
        need(error.errno == errno.EROFS, 'review_write_not_erofs')
        return error.errno
    else:
        os.close(descriptor)
        raise Refused('review_write_permitted')


def remount_denied(path):
    libc = ctypes.CDLL(None, use_errno=True)
    libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p,
                          ctypes.c_ulong, ctypes.c_void_p]
    libc.mount.restype = ctypes.c_int
    result = libc.mount(None, os.fsencode(path), None, 4096 | 32, None)  # BIND | REMOUNT, rw
    need(result == -1 and ctypes.get_errno() in (errno.EPERM, errno.EACCES),
         'review_remount_not_denied')
    return ctypes.get_errno()


def review(root, facts, parent, tree, prefix):
    need(facts['head'] == parent and facts['indexTree'] == tree, 'submission_mismatch')
    need(git(root, 'diff-files', '--quiet', '--no-ext-diff', required=False).returncode == 0
         and not git(root, 'ls-files', '--others', '--exclude-standard'),
         'review_worktree_differs_from_index')
    # Resolve actual metadata: .git may be a pointer, and linked worktrees keep
    # HEAD/index separately from common config. Every containing mount must be ro.
    paths = {name: Path(git(root, 'rev-parse', '--path-format=absolute', '--git-path', name)).resolve()
             for name in ('config', 'HEAD', 'index')}
    paths['canary'] = root / next(iter(facts['markers']))
    mounts = {name: readonly_mount(path) for name, path in paths.items()}
    writes = {name: write_denied(path) for name, path in paths.items()}
    commands = {
        'config': ['config', '--local', 'mervAcceptance.probe', prefix],
        'index': ['update-index', '--index-version=2'],
        'ref': ['update-ref', 'refs/heads/native-acceptance-' + prefix, 'HEAD'],
    }
    denials = {}
    for name, args in commands.items():
        result = git(root, *args, required=False)
        need(result.returncode != 0 and b'Read-only file system' in result.stderr,
             'review_git_write_not_erofs')
        denials[name] = {'exitCode': result.returncode, 'erofs': True}
    remounts = {mount['path']: remount_denied(Path(mount['path'])) for mount in mounts.values()}
    need(inspect(root, prefix) == facts, 'review_probe_changed_checkout')
    return {'parent': parent, 'tree': tree, 'mounts': mounts,
            'writeErrnos': writes, 'gitDenials': denials, 'remountErrnos': remounts}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', choices=['planner', 'executor', 'reviewer'], required=True)
    parser.add_argument('--prefix', required=True)
    parser.add_argument('--parent')
    parser.add_argument('--tree')
    args = parser.parse_args()
    try:
        need(sys.platform == 'linux', 'linux_required')
        need(args.stage != 'reviewer' or (args.parent and args.tree), 'submission_ids_required')
        root = Path.cwd().resolve()
        proof = {'formatVersion': 1, 'stage': args.stage, 'prefix': args.prefix,
                 'identity': identity(), 'launcher': launcher_report(root)}
        proof['checkout'] = inspect(root, args.prefix)
        if args.stage == 'reviewer':
            proof['review'] = review(root, proof['checkout'], args.parent, args.tree, args.prefix)
        print(json.dumps({'passed': True, **proof}, sort_keys=True))
        return 0
    except Exception as error:
        # Never include exception messages, Git diagnostics, config or environment.
        code = str(error) if isinstance(error, Refused) else 'probe_unavailable'
        print(json.dumps({'passed': False, 'stage': args.stage, 'code': code}, sort_keys=True))
        return 1


if __name__ == '__main__':
    sys.exit(main())
