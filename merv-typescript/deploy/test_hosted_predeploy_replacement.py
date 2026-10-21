"""Failure injection for the pre-push cutover ownership transfer. No Docker or host calls."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('vm', Path(__file__).with_name('hosted-release-vm.py'))
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)


class Replacement(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'home'; self.home.mkdir()
        self.old = self.root / 'old'; self.old.mkdir()
        self.new = self.root / 'new'; self.new.mkdir()
        self.patches = []
        self.mock('HOME', self.home); self.mock('RUNS', self.root)
        self.mock('main_release_running', lambda: False)
        (self.home / 'active').write_text('old')
        self.plan = dict(run='new', replaces='old', cutover=True, sourceCommit='new-commit',
                         current={'image': 'old-provider'}, sandboxesCommit='sandbox-commit',
                         canary={'credential': '/private'}, nodeImage='node-pinned', drainSeconds=900, lane='boundary')
        self.before = dict(cutoverMainImage='main-id', apps={'standard': {'image': 'old-provider', 'version': 7, 'rollout': None}},
                           mainReleaseId='old', fileReleaseId='old', releases={'standard': 'old'},
                           fileReleases={'standard': 'old'}, catalog=[{'id': 'old'}])
        self.live = copy.deepcopy(self.before)
        self.image = {'Image': 'main-id', 'Config': {'Labels': {'org.merv.native-git-protocol': '1'}}}
        self.mock('inspect', lambda _: self.image)
        self.proof = {'report': {'ready': True, 'alreadyNative': True, 'protocolMigrated': True}, 'ledgerSha256': 'ledger'}
        self.calls = []
        for method, replacement in [
            ('pins', lambda _: self.live),
            ('cutover_maintenance', lambda _, enabled: self.calls.append(('maintenance', enabled))),
            ('cutover_census', lambda _: self.calls.append(('census',))),
            ('migration_proof', lambda _: self.proof),
        ]:
            p = patch.object(vm.Step, method, replacement); p.start(); self.addCleanup(p.stop)
        for folder in (self.old, self.new):
            (folder / 'source/deploy').mkdir(parents=True)
            for name in ('hosted-release.mjs', 'hosted-release-vm.py'):
                (folder / 'source/deploy' / name).write_text('same audited current pipeline')
            for archive in ('source.tar.gz', 'sandboxes.tar.gz'):
                (folder / archive).write_bytes(b'same archive')
        for archive, key in [('source.tar.gz', 'sourceArchiveSha256'), ('sandboxes.tar.gz', 'sandboxesArchiveSha256')]:
            self.plan[key] = vm.sha((self.new / archive).read_bytes())
        self.write(self.old, 'plan', {**self.plan, 'run': 'old', 'sourceCommit': 'old-commit'})
        self.write(self.old, 'preflight', self.before)
        self.write(self.old, 'build', {'candidate': 'immutable-old-candidate'})
        self.write(self.old, 'lease', {'seen': time.time() - vm.LEASE - 10})
        self.write(self.old, 'progress', {'cutoverFailure': 'gates: command_failed: test'})
        self.step = vm.Step(self.new, self.plan)
        self.original = self.snapshot()

    def mock(self, name, value):
        p = patch.object(vm, name, value); p.start(); self.addCleanup(p.stop)

    def write(self, folder, name, value):
        (folder / (name + '.json')).write_text(json.dumps(value))

    def snapshot(self):
        return {str(p.relative_to(self.old)): p.read_bytes() for p in self.old.rglob('*') if p.is_file()}

    def refuses(self):
        with self.assertRaises((RuntimeError, ValueError)):
            self.step.replace_predeploy({})
        self.assertEqual(vm.owner(), 'old')

    def test_transfer_preserves_original_and_has_complete_resume_evidence(self):
        result = self.step.replace_predeploy({})
        self.assertEqual(vm.owner(), 'new')
        self.assertEqual(self.snapshot(), self.original)
        self.assertEqual(vm.read(self.new / 'preflight.json'), self.before)
        self.assertEqual(result['migration'], self.proof)
        self.assertEqual(result['oldCandidate'], 'immutable-old-candidate')
        self.assertFalse((self.old / 'finish.json').exists())
        self.assertEqual(self.calls, [('maintenance', True), ('census',)])
        self.assertFalse((self.new / 'build.json').exists())
        self.assertFalse((self.new / 'gates.json').exists())

    def test_later_or_interrupted_mutation_is_always_refused(self):
        for filename in ('gates.json', 'push.json', 'catalog.json', 'finish.json', 'mutation-started.json',
                         'catalog.before', 'catalog.target', 'env.before', 'stage.before'):
            with self.subTest(filename=filename):
                path = self.old / filename; path.write_text('{}')
                self.refuses(); path.unlink()

    def test_lease_and_ownership(self):
        self.write(self.old, 'lease', {'seen': time.time()}); self.refuses()
        self.write(self.old, 'lease', {}); self.refuses()
        self.write(self.old, 'lease', {'seen': time.time()-vm.LEASE-10})
        (self.home / 'active').write_text('other')
        with self.assertRaisesRegex(RuntimeError, 'active run'): self.step.replace_predeploy({})
        self.assertEqual(vm.owner(), 'other')

    def test_state_and_main_drift(self):
        for key in ('apps', 'catalog', 'mainReleaseId', 'fileReleaseId', 'releases', 'fileReleases'):
            with self.subTest(key=key):
                prior = self.live[key]; self.live[key] = 'changed'; self.refuses(); self.live[key] = prior
        self.image['Image'] = 'other-main'; self.refuses()
        self.image['Image'] = 'main-id'; self.image['Config']['Labels'] = {}; self.refuses()

    def test_plan_archive_pipeline_and_progress(self):
        for key in ('current', 'sandboxesCommit', 'canary', 'nodeImage', 'drainSeconds', 'lane', 'sourceArchiveSha256'):
            with self.subTest(key=key):
                prior = self.plan[key]; self.plan[key] = 'changed'; self.refuses(); self.plan[key] = prior
        path = self.old / 'source/deploy/hosted-release.mjs'; path.write_text('unknown pipeline'); self.refuses()
        path.write_text('same audited current pipeline')
        for progress in ({}, {'cutoverFailure': 'push: failure'}, {'cutoverFailure': 'gates: failed', 'deployAttempted': False}):
            self.write(self.old, 'progress', progress); self.refuses()

    def test_maintenance_census_and_migration_failure_preserve_owner(self):
        for method in ('cutover_maintenance', 'cutover_census', 'migration_proof'):
            with self.subTest(method=method), patch.object(vm.Step, method, side_effect=RuntimeError('unproven')):
                self.refuses()

    def test_interrupt_before_owner_commit_keeps_predecessor(self):
        original_atomic = vm.atomic
        def fail(path, data, *args):
            if path == self.home / 'active': raise OSError('interrupted before rename')
            original_atomic(path, data, *args)
        with patch.object(vm, 'atomic', fail), self.assertRaises(OSError): self.step.replace_predeploy({})
        self.assertEqual(vm.owner(), 'old')
        self.assertEqual(self.snapshot(), self.original)
        self.assertTrue((self.new / 'preflight.json').exists())
        self.assertTrue((self.new / 'replacement.json').exists())
        # Repeating the exact step completes the atomic transfer, without deleting any evidence.
        self.step.replace_predeploy({})
        self.assertEqual(vm.owner(), 'new')

    def test_interrupt_after_owner_commit_is_resumable_not_replaceable(self):
        original_atomic = vm.atomic
        def fail(path, data, *args):
            original_atomic(path, data, *args)
            if path == self.home / 'active': raise OSError('lost response after rename')
        with patch.object(vm, 'atomic', fail), self.assertRaises(OSError): self.step.replace_predeploy({})
        self.assertEqual(vm.owner(), 'new')
        self.assertTrue((self.new / 'preflight.json').exists())
        self.assertTrue((self.new / 'replacement.json').exists())
        with self.assertRaisesRegex(RuntimeError, 'active run'): self.step.replace_predeploy({})
        self.assertEqual(self.snapshot(), self.original)

    def root_step(self, name, payload):
        # Exercise the real step dispatcher and both flock scopes without needing root.
        import os
        original_stat = Path.stat
        def root_stat(path, *args, **kwargs):
            result = original_stat(path, *args, **kwargs)
            if path == self.new:
                values = list(result); values[4] = 0
                return os.stat_result(values)
            return result
        self.new.chmod(0o700)
        with patch.object(vm.os, 'geteuid', return_value=0), patch.object(Path, 'stat', root_stat), \
             patch.object(vm, 'MAINTENANCE', self.root / 'maintenance.lock'), \
             patch.object(vm, 'RECOVERY_PENDING', self.root / 'recovery-pending'):
            return vm.step(name, self.new, payload)

    def test_dispatcher_holds_both_locks_at_owner_commit(self):
        import fcntl
        original_atomic = vm.atomic
        observed = []
        def check(path, data, *args):
            if path == self.home / 'active':
                for lock in (self.root / 'maintenance.lock', self.home / 'lock'):
                    with lock.open('a') as fd:
                        with self.assertRaises(BlockingIOError):
                            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    observed.append(lock.name)
            original_atomic(path, data, *args)
        with patch.object(vm, 'atomic', check):
            self.root_step('replace_predeploy', {'driver': 'test', 'arg': self.plan})
        self.assertEqual(observed, ['maintenance.lock', 'lock'])
        self.assertEqual(vm.owner(), 'new')
        self.assertEqual(self.snapshot(), self.original)

    def test_mutation_intent_survives_interrupted_push(self):
        self.root_step('replace_predeploy', {'driver': 'test', 'arg': self.plan})
        with patch.object(vm.Step, 'push', side_effect=RuntimeError('interrupted push')):
            with self.assertRaisesRegex(RuntimeError, 'interrupted push'):
                self.root_step('push', {'driver': 'test', 'arg': {}})
        self.assertEqual(vm.read(self.new / 'mutation-started.json'), {'step': 'push'})
        self.assertFalse((self.new / 'push.json').exists())
        self.assertEqual(vm.owner(), 'new')

    def test_recheck_before_push_refuses_drift_without_mutation_intent(self):
        self.root_step('replace_predeploy', {'driver': 'test', 'arg': self.plan})
        self.live['apps']['standard']['version'] += 1
        with patch.object(vm.Step, 'push', side_effect=AssertionError('must not push')):
            with self.assertRaisesRegex(RuntimeError, 'production changed'):
                self.root_step('push', {'driver': 'test', 'arg': {}})
        self.assertFalse((self.new / 'mutation-started.json').exists())
        self.assertEqual(vm.owner(), 'new')

    def test_handoff_durability_precedes_owner_commit(self):
        events = []
        original_atomic = vm.atomic
        def atomic(path, data, *args):
            events.append('owner' if path == self.home / 'active' else path.name)
            original_atomic(path, data, *args)
        with patch.object(vm, 'atomic', atomic), \
             patch.object(vm, 'durable_tree', lambda p: events.append('tree')), \
             patch.object(vm, 'durable_directory', lambda p: events.append('home' if p == self.home else 'runs')):
            self.step.replace_predeploy({})
        self.assertEqual(events[-6:], ['replacement.json', 'preflight.json', 'tree', 'runs', 'owner', 'home'])

    def test_replacement_can_follow_another_failed_gate_with_same_migration(self):
        self.write(self.old, 'replacement', {'successor': 'old', 'predecessor': 'older', 'migration': self.proof})
        self.step.replace_predeploy({})
        self.assertEqual(vm.owner(), 'new')

    def test_invalid_or_changed_lineage_proof_is_refused(self):
        for receipt in ({}, {'successor': 'wrong', 'migration': self.proof},
                        {'successor': 'old', 'migration': {**self.proof, 'ledgerSha256': 'changed'}}):
            self.write(self.old, 'replacement', receipt); self.refuses()

    def test_partial_provider_rollout_can_resume_forward(self):
        self.root_step('replace_predeploy', {'driver': 'test', 'arg': self.plan})
        self.live['apps']['standard']['image'] = 'candidate'
        self.write(self.new, 'progress', {'deployAttempted': True})
        # Existing arm/rollout implementation is covered separately; this exercises the new guard.
        with patch.object(vm, 'arm'), patch.object(vm.Step, 'drain', return_value={'drained': True}):
            result = self.root_step('drain', {'driver': 'test', 'arg': {}})
        self.assertEqual(result, {'drained': True})
        self.assertEqual(vm.owner(), 'new')

    def test_recheck_rejects_migration_change(self):
        with self.assertRaisesRegex(RuntimeError, 'migration changed'):
            self.step.replacement_safety(self.before, {**self.proof, 'ledgerSha256': 'different'})


if __name__ == '__main__': unittest.main()
