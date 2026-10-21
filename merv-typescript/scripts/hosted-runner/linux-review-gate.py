"""Real Linux read-only mount + identity boundary. Run as root in the candidate image."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

sys.path.insert(0, '/opt/merv/python')
sys.path.insert(0, '/opt/merv/runtime')
from merv_sandboxes.runtimes.launcher import prepare_assignment_identity

wrapper_path = Path(os.environ.get('MERV_REVIEW_WRAPPER', '/opt/merv/runtime/assignment-probed.py'))
sys.path.insert(0, str(wrapper_path.parent))
spec = importlib.util.spec_from_file_location('review_boundary', wrapper_path)
wrapper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wrapper)


def git(path, *args):
    return subprocess.run(['/usr/bin/git', '-C', str(path), *args], check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.decode().strip()


if len(sys.argv) > 1:
    path = Path(sys.argv[1])
    wrapper.readonly_code(path)
    prepare_assignment_identity(uid=12001, gid=12001, administrative_uid=1000, preserve_stdio=True)
    assert os.getuid() == 12001
    assert git(path, 'show', 'HEAD:source.txt') == 'original'
    assert (path / 'source.txt').read_text() == 'submitted without commit\n'
    for target in [path / 'source.txt', path / 'new.txt', path / '.git/config', path / '.git/HEAD']:
        try:
            target.write_text('tampered')
            raise AssertionError('review file was writable: ' + str(target))
        except OSError:
            pass
    for command in [['add', '-A'], ['reset', '--hard', 'HEAD'], ['checkout', '-b', 'review-write'],
                    ['config', 'review.changed', 'true'], ['update-ref', 'refs/heads/review', 'HEAD']]:
        assert subprocess.run(['/usr/bin/git', '-C', str(path), *command],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0
    assert subprocess.run(['/usr/bin/mount', '-o', 'remount,rw,bind', str(path)],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0
    try:
        (path.parent / 'runner-private' / 'credential').read_text()
        raise AssertionError('reviewer read runner credential')
    except PermissionError:
        pass
    with tempfile.TemporaryDirectory(prefix='review-scratch-') as scratch:
        output = Path(scratch) / 'test-output'
        output.write_text('tests may write scratch')
        assert output.read_text() == 'tests may write scratch'
    status = Path('/proc/self/status').read_text()
    for field in ['CapEff', 'CapPrm', 'CapBnd', 'CapAmb']:
        assert int(status.split(field + ':')[1].split()[0], 16) == 0
    assert 'NoNewPrivs:\t1' in status
    print(json.dumps({'gate': 'linux-review-readonly', 'passed': True,
                      'actualProtectedWorkflow': False, 'cloudflareEvidence': False}))
else:
    assert sys.platform == 'linux' and os.geteuid() == 0
    with tempfile.TemporaryDirectory(prefix='review-gate-', dir='/var/tmp') as temporary:
        root = Path(temporary)
        root.chmod(0o755)
        private = root / 'runner-private'
        private.mkdir(mode=0o700)
        (private / 'credential').write_text('synthetic-runner-secret')
        path = root / 'checkout'
        path.mkdir()
        git(path, 'init', '-q')
        git(path, 'config', 'user.name', 'Fixture')
        git(path, 'config', 'user.email', 'fixture@example.invalid')
        (path / 'source.txt').write_text('original\n')
        git(path, 'add', '.')
        git(path, 'commit', '-qm', 'parent')
        (path / 'source.txt').write_text('submitted without commit\n')
        # This matches the real handoff: assignment-owned, otherwise writable checkout.
        for directory, dirs, files in os.walk(path):
            os.chown(directory, 12001, 12001)
            for name in dirs + files:
                os.chown(Path(directory) / name, 12001, 12001)
        subprocess.run([sys.executable, __file__, str(path)], check=True)
        # Child's private mount did not freeze the supervisor's retained working copy.
        (path / 'source.txt').write_text('supervisor can prepare the next session\n')
