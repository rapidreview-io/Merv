"""Real Linux regression for native-acceptance-probe inspect/review; no model or network.

Run as root in a disposable image with Git, Python, administrator UID/GID 1000 and
assignment UID/GID 12001. Mount this directory at /opt/merv/runtime and the vendored
runtime Python tree at /opt/merv/python, both read-only. Grant the container SYS_ADMIN
for the parent's private bind mounts; children drop every capability using the actual
launcher helper before invoking the probe. The production wrapper mounts standalone
checkouts. A separate synthetic linked-worktree case mounts both metadata and worktree
roots; this does not claim the launcher admits linked worktrees.

Example (from merv-typescript, using an already available local fixture image):
  docker run --rm --network none --cap-add SYS_ADMIN --security-opt apparmor=unconfined \
    -v "$PWD/scripts/hosted-runner:/opt/merv/runtime:ro" \
    -v "$PWD/vendor/merv-sandboxes/typescript/packages/runtimes/assets/python:/opt/merv/python:ro" \
    --entrypoint python3 merv-review-local:test -B /opt/merv/runtime/linux-native-acceptance-probe.py

--legacy --probe /old-probe.py confirms the original inspect fails under these same
real read-only conditions. Supply that prior source as a separate read-only mount.
"""
import argparse
import ctypes
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile

sys.path[:0] = ['/opt/merv/python', '/opt/merv/runtime']
from merv_sandboxes.runtimes.launcher import prepare_assignment_identity


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def snapshot(root):
    facts = {}
    for path in sorted(root.rglob('*')):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            value = ['symlink', os.readlink(path)]
        elif stat.S_ISREG(info.st_mode):
            value = ['file', hashlib.sha256(path.read_bytes()).hexdigest()]
        else:
            value = ['directory']
        facts[str(path.relative_to(root))] = [stat.S_IMODE(info.st_mode), info.st_uid,
                                             info.st_gid, *value]
    return facts


def linked_readonly(common, root):
    """Synthetic linked checkout: each actual Git metadata path has a real RO mount."""
    libc = ctypes.CDLL(None, use_errno=True)
    libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p,
                          ctypes.c_ulong, ctypes.c_void_p]
    libc.mount.restype = ctypes.c_int
    assert libc.unshare(0x00020000) == 0, ctypes.get_errno()
    assert libc.mount(None, b'/', None, (1 << 14) | (1 << 18), None) == 0, ctypes.get_errno()
    for path in (common, root):
        encoded = os.fsencode(path)
        assert libc.mount(encoded, encoded, None, 4096, None) == 0, ctypes.get_errno()
        assert libc.mount(None, encoded, None, 4096 | 32 | 1 | 2 | 4, None) == 0, ctypes.get_errno()


def child(args, probe):
    spec = json.loads(args.child)
    root = Path(spec['root'])
    if spec['linked']:
        linked_readonly(Path(spec['common']), root)
    else:
        boundary = load('boundary', '/opt/merv/runtime/assignment-probed.py')
        boundary.readonly_code(root)
    prepare_assignment_identity(uid=12001, gid=12001, administrative_uid=1000, preserve_stdio=True)
    identity = probe.identity()
    # This witnesses the old failure using real Git, even when running the fixed probe.
    write_tree = probe.git(root, 'write-tree', required=False)
    assert write_tree.returncode != 0
    assert b'index.lock' in write_tree.stderr and b'Read-only file system' in write_tree.stderr
    before = snapshot(Path(spec['directory']))
    if args.legacy:
        try:
            probe.inspect(root, 'canary')
        except probe.Refused as error:
            assert str(error) == 'git_inspection_failed'
        else:
            raise AssertionError('old inspect unexpectedly accepted the read-only checkout')
        outcome = 'legacy-readonly-failure-confirmed'
        evidence = {}
    else:
        expected_tree = spec['headTree'] if spec['case'] == 'wrong-tree' else spec['tree']
        try:
            facts = probe.inspect(root, 'canary', expected_tree)
            assert facts['head'] == spec['parent']
            assert facts['indexTree'] == spec['tree'] != facts['headTree']
            parent = '0' * len(spec['parent']) if spec['case'] == 'wrong-parent' else spec['parent']
            evidence = probe.review(root, facts, parent, expected_tree, 'canary')
        except probe.Refused as error:
            expected = {'wrong-parent': 'submission_mismatch', 'wrong-tree': 'submission_mismatch',
                        'dirty-tracked': 'review_worktree_differs_from_index',
                        'dirty-untracked': 'review_worktree_differs_from_index',
                        'dirty-ignored': 'review_worktree_differs_from_index',
                        'assume-unchanged': 'review_index_flags_invalid',
                        'skip-worktree': 'review_index_flags_invalid',
                        'intent-to-add': 'submission_mismatch'}
            assert spec['case'] in expected and str(error) == expected[spec['case']], str(error)
            outcome = 'rejected'
            evidence = {'code': str(error)}
        else:
            assert spec['case'] == 'exact', 'mismatched or dirty checkout was accepted'
            assert all(item['readonly'] for item in evidence['mounts'].values())
            assert set(evidence['gitDenials']) == {'config', 'index', 'ref'}
            outcome = 'accepted'
        # All cases, including early refusals, retain actual filesystem write protection.
        for name in ('config', 'HEAD', 'index'):
            path = Path(probe.git(root, 'rev-parse', '--path-format=absolute', '--git-path', name)).resolve()
            assert probe.readonly_mount(path)['readonly']
            assert probe.write_denied(path) == errno.EROFS
        assert probe.write_denied(root / 'canary-one.txt') == errno.EROFS
    assert snapshot(Path(spec['directory'])) == before, 'probe changed Git or worktree content'
    print(json.dumps({'case': spec['case'], 'linked': spec['linked'], 'outcome': outcome,
                      'parent': spec['parent'], 'tree': spec['tree'], 'identity': identity,
                      'writeTreeIndexLockEROFS': True, 'unchanged': True, 'evidence': evidence}))


def run(args, probe):
    assert sys.platform == 'linux' and os.geteuid() == 0
    cases = [('exact', False)] if args.legacy else [
        ('exact', False), ('wrong-parent', False), ('wrong-tree', False),
        ('dirty-tracked', False), ('dirty-untracked', False), ('dirty-ignored', False),
        ('assume-unchanged', False), ('skip-worktree', False), ('intent-to-add', False), ('exact', True),
    ]
    reports = []
    for case, linked in cases:
        with tempfile.TemporaryDirectory(prefix='native-probe-linux-', dir='/var/tmp') as temporary:
            directory = Path(temporary)
            directory.chmod(0o755)
            common = directory / 'common'
            common.mkdir()
            probe.git(common, 'init', '-q')
            probe.git(common, 'config', 'user.name', 'Readonly fixture')
            probe.git(common, 'config', 'user.email', 'fixture@example.invalid')
            (common / 'canary-one.txt').write_text('original\n')
            probe.git(common, 'add', '.')
            probe.git(common, 'commit', '-qm', 'parent')
            root = common
            if linked:
                root = directory / 'linked'
                probe.git(common, 'worktree', 'add', '-q', '--detach', str(root), 'HEAD')
            (root / 'canary-one.txt').write_text('submitted without a commit\n')
            probe.git(root, 'add', 'canary-one.txt')
            spec = {'directory': str(directory), 'common': str(common), 'root': str(root),
                    'case': case, 'linked': linked, 'parent': probe.git(root, 'rev-parse', 'HEAD'),
                    'headTree': probe.git(root, 'rev-parse', 'HEAD^{tree}'),
                    'tree': probe.git(root, 'write-tree')}
            assert spec['tree'] != spec['headTree']
            if case == 'dirty-tracked':
                (root / 'canary-one.txt').write_text('post-submission unstaged content must be rejected\n')
            elif case == 'dirty-untracked':
                (root / 'untracked.txt').write_text('untracked content must be rejected\n')
            elif case == 'dirty-ignored':
                (root / '.git/info/exclude').write_text('ignored.txt\n')
                (root / 'ignored.txt').write_text('ignored content must be rejected\n')
            elif case in ('assume-unchanged', 'skip-worktree'):
                probe.git(root, 'update-index', '--' + case, 'canary-one.txt')
                (root / 'canary-one.txt').write_text('index flags must not hide altered content\n')
            elif case == 'intent-to-add':
                (root / 'intent.txt').write_text('intent-to-add entry must be rejected\n')
                probe.git(root, 'add', '-N', 'intent.txt')
            for path in directory.rglob('*'):
                os.chown(path, 12001, 12001, follow_symlinks=False)
            before = snapshot(directory)
            command = [sys.executable, '-B', __file__, '--probe', args.probe, '--child', json.dumps(spec)]
            if args.legacy:
                command.append('--legacy')
            result = subprocess.run(command, capture_output=True, text=True, timeout=60)
            assert result.returncode == 0, result.stderr
            reports.append(json.loads(result.stdout))
            assert snapshot(directory) == before, 'review mutated the supervisor retained checkout'
            # The mount namespace belonged to the child, not its supervisor.
            (root / 'canary-one.txt').write_text('supervisor can prepare the next session\n')
    print(json.dumps({'gate': 'linux-native-acceptance-probe', 'passed': True,
                      'legacy': args.legacy, 'cases': reports,
                      'probeSha256': hashlib.sha256(Path(args.probe).read_bytes()).hexdigest(),
                      'gitVersion': subprocess.check_output(['/usr/bin/git', '--version'], text=True).strip(),
                      'actualProtectedWorkflow': False, 'cloudflareEvidence': False}, sort_keys=True))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--probe', default='/opt/merv/runtime/native-acceptance-probe.py')
    parser.add_argument('--legacy', action='store_true')
    parser.add_argument('--child')
    args = parser.parse_args()
    probe = load('probe', args.probe)
    if args.child:
        child(args, probe)
    else:
        run(args, probe)
