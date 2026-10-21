"""Inspect an actual HTTP-fetched submission through the production Linux review boundary.

The caller mounts the checkout read-only at /input; copying inside the container gives
the assignment an otherwise writable tree, so the private mount is what denies writes.
This gate runs no model and proves neither a full hosted image nor provider isolation.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.path[:0] = ['/opt/merv/python', '/opt/merv/runtime']
from merv_sandboxes.runtimes.launcher import prepare_assignment_identity

spec = importlib.util.spec_from_file_location('boundary', '/opt/merv/runtime/assignment-probed.py')
boundary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundary)


def git(path, *args):
    return subprocess.run(['/usr/bin/git', '-C', str(path), *args], check=True,
                          capture_output=True, text=True).stdout.strip()


if len(sys.argv) == 3:
    path, facts = Path(sys.argv[1]), json.loads(sys.argv[2])
    boundary.readonly_code(path)
    prepare_assignment_identity(uid=12001, gid=12001, administrative_uid=1000, preserve_stdio=True)
    assert git(path, 'rev-parse', 'HEAD') == facts['parent']
    for name, expected in facts['files'].items():
        assert (path / name).read_text() == expected
    for name in [*facts['files'], 'injected.txt', '.git/config', '.git/HEAD']:
        try:
            (path / name).write_text('tampered')
        except OSError:
            continue
        raise AssertionError('review wrote ' + name)
    for args in [['add', '-A'], ['reset', '--hard', 'HEAD'], ['checkout', '-b', 'injected'],
                 ['config', 'review.changed', 'true'], ['update-ref', 'refs/heads/injected', 'HEAD']]:
        assert subprocess.run(['/usr/bin/git', '-C', str(path), *args],
                              capture_output=True).returncode != 0
    assert subprocess.run(['/usr/bin/mount', '-o', 'remount,rw,bind', str(path)],
                          capture_output=True).returncode != 0
    try:
        (path.parent / 'private' / 'credential').read_text()
        raise AssertionError('review read supervisor credential')
    except PermissionError:
        pass
    with tempfile.TemporaryDirectory(prefix='review-test-') as scratch:
        result = subprocess.run([sys.executable, '-B', str(path / 'plan.py')], cwd=scratch,
                                capture_output=True, text=True, check=True)
        assert result.stdout.strip() == '5'
        (Path(scratch) / 'verification.txt').write_text(result.stdout)
    status = Path('/proc/self/status').read_text()
    for field in ['CapEff', 'CapPrm', 'CapBnd', 'CapAmb']:
        assert int(status.split(field + ':')[1].split()[0], 16) == 0
    assert 'NoNewPrivs:\t1' in status
    print(json.dumps({'gate': 'linux-submission-review', 'parent': facts['parent'],
                      'tree': facts['tree'], 'passed': True,
                      'actualHostedSupervisor': False, 'cloudflareEvidence': False}))
else:
    facts = json.loads(Path('/facts.json').read_text())
    with tempfile.TemporaryDirectory(prefix='submission-review-', dir='/var/tmp') as temp:
        root = Path(temp)
        root.chmod(0o755)
        path = root / 'checkout'
        shutil.copytree('/input', path, symlinks=True)
        assert git(path, 'rev-parse', 'HEAD') == facts['parent']
        assert git(path, 'write-tree') == facts['tree']
        private = root / 'private'
        private.mkdir(mode=0o700)
        (private / 'credential').write_text('synthetic-supervisor-secret')
        for directory, dirs, files in os.walk(path):
            os.chown(directory, 12001, 12001)
            for name in dirs + files:
                os.chown(Path(directory) / name, 12001, 12001, follow_symlinks=False)
        subprocess.run([sys.executable, __file__, str(path), json.dumps(facts)], check=True)
