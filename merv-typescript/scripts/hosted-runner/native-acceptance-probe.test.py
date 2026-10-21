"""Portable probe checks. These do not claim a real Linux/provider mount passed."""
import errno
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    'probe', Path(__file__).with_name('native-acceptance-probe.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='merv-native-proof-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / 'checkout'
        self.root.mkdir()
        probe.git(self.root, 'init', '-q')
        probe.git(self.root, 'config', 'user.name', 'Acceptance fixture')
        probe.git(self.root, 'config', 'user.email', 'fixture@example.invalid')
        (self.root / 'canary-one.txt').write_text('first\n')
        probe.git(self.root, 'add', 'canary-one.txt')
        probe.git(self.root, 'commit', '-qm', 'fixture')

    def test_inspection_reports_dirt_without_staging_or_committing(self):
        before = probe.inspect(self.root, 'canary')
        (self.root / 'canary-one.txt').write_text('second\n')
        after = probe.inspect(self.root, 'canary')
        self.assertFalse(before['dirty'])
        self.assertTrue(after['dirty'])
        self.assertEqual(after['head'], before['head'])
        self.assertEqual(after['indexTree'], before['indexTree'])
        self.assertEqual(after['markers']['canary-one.txt']['sha256'], probe.sha(b'second\n'))
        self.assertNotIn('second', json.dumps(after))

    def test_canary_prefix_and_missing_files_refused(self):
        for prefix in ('../canary', 'canary/one', '-invalid', 'a' * 49, 'missing'):
            with self.subTest(prefix=prefix), self.assertRaises(probe.Refused):
                probe.inspect(self.root, prefix)

    def test_review_inspection_matches_staged_tree_without_changing_git_files(self):
        (self.root / 'canary-one.txt').write_text('submitted\n')
        probe.git(self.root, 'add', 'canary-one.txt')
        expected = probe.inspect(self.root, 'canary')
        self.assertNotEqual(expected['headTree'], expected['indexTree'])

        def git_files():
            return {str(path.relative_to(self.root)): path.read_bytes()
                    for path in (self.root / '.git').rglob('*') if path.is_file()}

        before = git_files()
        self.assertEqual(probe.inspect(self.root, 'canary', expected['indexTree']), expected)
        self.assertEqual(git_files(), before)
        for value in ('--help', expected['head']):
            with self.subTest(value=value), self.assertRaisesRegex(probe.Refused, 'git_object_invalid'):
                probe.inspect(self.root, 'canary', value)
        with self.assertRaisesRegex(probe.Refused, 'submission_mismatch'):
            probe.inspect(self.root, 'canary', expected['headTree'])

    def test_review_tree_comparison_detects_modes_flags_and_intent_to_add(self):
        tree = probe.git(self.root, 'write-tree')
        probe.git(self.root, 'config', 'core.filemode', 'false')
        probe.git(self.root, 'update-index', '--chmod=+x', 'canary-one.txt')
        for flag in ('--assume-unchanged', '--skip-worktree'):
            probe.git(self.root, 'update-index', flag, 'canary-one.txt')
            with self.subTest(flag=flag), self.assertRaisesRegex(probe.Refused, 'submission_mismatch'):
                probe.inspect(self.root, 'canary', tree)
        probe.git(self.root, 'update-index', '--no-assume-unchanged', '--no-skip-worktree',
                  '--chmod=-x', 'canary-one.txt')
        (self.root / 'pending.txt').write_text('not submitted\n')
        probe.git(self.root, 'add', '-N', 'pending.txt')
        with self.assertRaisesRegex(probe.Refused, 'submission_mismatch'):
            probe.inspect(self.root, 'canary', tree)

    def test_review_tree_comparison_ignores_local_object_replacements(self):
        original = probe.git(self.root, 'write-tree')
        (self.root / 'canary-one.txt').write_text('replacement\n')
        probe.git(self.root, 'add', 'canary-one.txt')
        replacement = probe.git(self.root, 'write-tree')
        probe.git(self.root, 'replace', original, replacement)
        with self.assertRaisesRegex(probe.Refused, 'submission_mismatch'):
            probe.inspect(self.root, 'canary', original)

    def test_symlink_canary_is_not_followed(self):
        (self.root / 'canary-link').symlink_to(self.root / 'canary-one.txt')
        with self.assertRaises(OSError):
            probe.inspect(self.root, 'canary')

    def test_exact_tree_and_unstaged_differences_rejected_before_write_tests(self):
        facts = probe.inspect(self.root, 'canary')
        with self.assertRaisesRegex(probe.Refused, 'submission_mismatch'):
            probe.review(self.root, facts, '0' * 40, facts['indexTree'], 'canary')
        (self.root / 'canary-one.txt').write_text('unstaged\n')
        facts = probe.inspect(self.root, 'canary')
        with self.assertRaisesRegex(probe.Refused, 'review_worktree_differs_from_index'):
            probe.review(self.root, facts, facts['head'], facts['indexTree'], 'canary')

    def test_review_refuses_index_flags_that_can_hide_modified_files(self):
        tree = probe.git(self.root, 'write-tree')
        (self.root / 'canary-one.txt').write_text('hidden dirty content\n')
        for flag in ('--assume-unchanged', '--skip-worktree'):
            probe.git(self.root, 'update-index', flag, 'canary-one.txt')
            facts = probe.inspect(self.root, 'canary', tree)
            with self.subTest(flag=flag), self.assertRaisesRegex(probe.Refused, 'review_index_flags_invalid'):
                probe.review(self.root, facts, facts['head'], tree, 'canary')
            probe.git(self.root, 'update-index', '--no-assume-unchanged', '--no-skip-worktree',
                      'canary-one.txt')

    def test_review_refuses_ignored_untracked_files(self):
        (self.root / '.git/info/exclude').write_text('hidden.txt\n')
        (self.root / 'hidden.txt').write_text('not in submitted tree\n')
        facts = probe.inspect(self.root, 'canary')
        self.assertFalse(facts['dirty'])
        with self.assertRaisesRegex(probe.Refused, 'review_worktree_differs_from_index'):
            probe.review(self.root, facts, facts['head'], facts['indexTree'], 'canary')

    def test_linked_worktree_checks_actual_common_and_private_git_metadata(self):
        linked = self.root.parent / 'linked'
        probe.git(self.root, 'worktree', 'add', '-q', '--detach', str(linked), 'HEAD')
        (linked / 'canary-one.txt').write_text('submitted\n')
        probe.git(linked, 'add', 'canary-one.txt')
        facts = probe.inspect(linked, 'canary')
        self.assertNotEqual(facts['headTree'], facts['indexTree'])
        checked = []
        actual_git = probe.git

        def fake_git(root, *args, required=True):
            if args[0] in ('config', 'write-tree', 'update-ref'):
                return SimpleNamespace(returncode=128, stderr=b'Read-only file system')
            return actual_git(root, *args, required=required)

        def mount(path):
            checked.append(path)
            return {'path': str(path.parent), 'readonly': True, 'id': 1}

        with patch.object(probe, 'git', side_effect=fake_git), \
                patch.object(probe, 'readonly_mount', side_effect=mount), \
                patch.object(probe, 'write_denied', return_value=errno.EROFS), \
                patch.object(probe, 'remount_denied', return_value=errno.EPERM):
            proof = probe.review(linked, facts, facts['head'], facts['indexTree'], 'canary')
        self.assertEqual(set(proof['gitDenials']), {'config', 'index', 'ref'})
        self.assertIn(self.root / '.git' / 'config', checked)
        self.assertIn(self.root / '.git' / 'worktrees' / 'linked' / 'HEAD', checked)
        self.assertIn(self.root / '.git' / 'worktrees' / 'linked' / 'index', checked)
        self.assertEqual(probe.inspect(linked, 'canary'), facts)

    def test_write_open_requires_erofs_not_ownership_denial(self):
        info = SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=12001)
        for error in (errno.EACCES, errno.EPERM, errno.EROFS):
            with patch.object(Path, 'lstat', return_value=info), \
                    patch.object(os, 'open', side_effect=OSError(error, 'hidden')) as opened:
                if error == errno.EROFS:
                    self.assertEqual(probe.write_denied(Path('/probe')), error)
                else:
                    with self.assertRaisesRegex(probe.Refused, 'review_write_not_erofs'):
                        probe.write_denied(Path('/probe'))
                self.assertEqual(opened.call_args.args[1] & os.O_TRUNC, 0)

    def test_successful_write_open_fails_without_writing(self):
        info = SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=12001)
        with patch.object(Path, 'lstat', return_value=info), \
                patch.object(os, 'open', return_value=999), patch.object(os, 'close') as closed:
            with self.assertRaisesRegex(probe.Refused, 'review_write_permitted'):
                probe.write_denied(Path('/probe'))
            closed.assert_called_once_with(999)

    def test_mount_facts_require_readonly_filesystem_and_effective_mount(self):
        mountinfo = '1 0 0:1 / / rw - rootfs rootfs rw\n2 1 0:2 / /workspace ro - ext4 /dev/x rw\n'
        with patch.object(os, 'statvfs', return_value=SimpleNamespace(f_flag=os.ST_RDONLY)), \
                patch.object(Path, 'read_text', return_value=mountinfo):
            self.assertEqual(probe.readonly_mount(Path('/workspace/canary')),
                             {'id': 2, 'path': '/workspace', 'readonly': True})
            with self.assertRaisesRegex(probe.Refused, 'review_mount_not_readonly'):
                probe.readonly_mount(Path('/elsewhere'))
        with patch.object(os, 'statvfs', return_value=SimpleNamespace(f_flag=0)):
            with self.assertRaisesRegex(probe.Refused, 'review_mount_writable'):
                probe.readonly_mount(Path('/workspace'))

    def test_launcher_receipt_requires_root_ownership_live_processes_and_exact_denials(self):
        root = Path('/workspace/assignments') / ('a' * 64)
        roots = {name: {'pid': 100, 'ppid': 99, 'starttime': 1234}
                 for name in ('supervisor', 'guardian', 'group')}
        expected = {f'{name}_{operation}' for name in roots
                    for operation in ('environ', 'fd', 'signal', 'ptrace')}
        expected.update(('guardian_socket_fd', 'ledger_directory', 'runtime_directory',
                         'state_directory', 'ledger_catalog', 'release_catalog', 'guardian_connect'))
        report = {'ok': True, 'workspace': root.name, 'launch_id': 'launch_1', 'roots': roots,
                  'identity': {'uids': [12001] * 3, 'gids': [12001] * 3, 'groups': [],
                               'caps': {name: '0000000000000000' for name in
                                        ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb')},
                               'no_new_privs': 1},
                  'outcomes': {**{name: errno.EPERM for name in expected}, 'sudo_returncode': 1},
                  'listeners': []}
        fields = ['S', '99'] + ['0'] * 17 + ['1234']
        raw = json.dumps(report).encode()
        directory = SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0)
        file = SimpleNamespace(st_mode=stat.S_IFREG | 0o444, st_uid=0, st_nlink=1,
                               st_size=len(raw))
        with patch.object(Path, 'lstat', return_value=directory), \
                patch.object(os, 'open', return_value=999), \
                patch.object(os, 'fstat', return_value=file), \
                patch.object(os, 'read', side_effect=lambda *_: json.dumps(report).encode()), \
                patch.object(os, 'close'), \
                patch.object(Path, 'read_text', side_effect=lambda: '100 (node) ' + ' '.join(fields)):
            self.assertEqual(probe.launcher_report(root)['launchId'], 'launch_1')
            fields[19] = '5678'
            with self.assertRaisesRegex(probe.Refused, 'launcher_root_not_live'):
                probe.launcher_report(root)
            fields[19] = '1234'
            file.st_uid = 12001
            with self.assertRaisesRegex(probe.Refused, 'launcher_report_file_invalid'):
                probe.launcher_report(root)
            file.st_uid = 0
            report['outcomes']['guardian_connect'] = 0
            with self.assertRaisesRegex(probe.Refused, 'launcher_denials_invalid'):
                probe.launcher_report(root)

    def test_cli_failure_is_structured_and_does_not_disclose_exception_or_environment(self):
        result = subprocess.run(
            [os.sys.executable, str(Path(__file__).with_name('native-acceptance-probe.py')),
             '--stage', 'reviewer', '--prefix', 'canary'],
            cwd=self.root, env={**os.environ, 'MERV_TEST_SECRET': 'never-print-this-value'},
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertFalse(json.loads(result.stdout)['passed'])
        self.assertNotIn('never-print-this-value', result.stdout + result.stderr)
        self.assertEqual(result.stderr, '')


if __name__ == '__main__':
    unittest.main()
