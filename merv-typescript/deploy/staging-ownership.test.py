"""Regression reproductions: partial catalog completion and full ordinary staging ownership."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


class Ownership(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('vm', Path(__file__).with_name('hosted-release-vm.py'))
        self.v = v = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(v)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        t = Path(self.temp.name)
        v.HOME = t / 'home'; v.HOME.mkdir()
        v.RUNS = t / 'runs'; v.MAINTENANCE = t / 'lock'
        v.RECOVERY_PENDING = t / 'no-recovery'; v.SHARED = t / 'shared'; v.ENV = t / 'env'
        self.image = 'registry.cloudflare.com/acct/worker@sha256:' + 'a' * 64
        self.entry = {'provider': v.PROVIDER, 'image_digest': 'sha256:' + 'a' * 64, 'executable_sha256': 'b' * 64}
        v.release_ids = lambda es: ['rt1_prod' if e['provider'] == v.PROVIDER else 'rt1_' + e['provider'] for e in es]
        self.current = {'image': self.image, 'releaseId': 'rt1_prod', 'releases': {v.PROVIDER: 'rt1_prod'},
                        'sourceCommit': 'source', 'sandboxesCommit': 'sbx'}
        v.atomic(v.HOME / 'state.json', json.dumps({'current': self.current}).encode())
        proof = v.RUNS / 'accepted'; proof.mkdir(parents=True)
        for f, value in {'plan': {'cutover': True, 'sourceCommit': 'source', 'sandboxesCommit': 'sbx'},
                         'push': {'image': self.image}, 'progress': {'cutoverPrepared': {'image': self.image}},
                         'finish': {'result': 'pass'}}.items():
            v.atomic(proof / (f + '.json'), json.dumps(value).encode())
        v.ENV.write_text(v.KEY + '=rt1_prod\n')
        v.SHARED.write_text(v.CATALOG + '=' + json.dumps([self.entry]) + '\n')
        self.envs = {c: {v.CATALOG: json.dumps([self.entry]), v.KEY: 'rt1_prod',
                       'SANDBOXES_PROVIDERS': json.dumps([{'name': p} for p in v.STAGING_PROVIDERS])}
                     for c in [v.CONTROL, v.MAIN]}
        v.env_of = lambda c: self.envs[c]
        v.main_release_running = lambda: False
        self.images = {v.MAIN: 'main-image', v.CONTROL: 'control-image'}
        v.inspect = lambda c: {'Image': self.images[c], 'Config': {'Labels': {'org.merv.native-git-protocol': '1'}}}
        v.native = lambda p=v.PROVIDER: {'image': self.image, 'rollout': None}
        v.os.geteuid = lambda: 0
        v.staging_provider_census = lambda: None
        v.quiet = lambda *_: None
        self.source = v.staging_source()
        self.arg = {'action': 'catalog', 'source': self.source, 'run': '20261021T000000Z-1234abcd-staging'}
        self.calls = []
        self.fail_after = v.CONTROL
        def sandboxes_file(step):
            def apply(doc):
                self.calls.append('apply')
                v.SHARED.write_bytes(doc)
                for c in [v.CONTROL, v.MAIN]:
                    self.envs[c][v.CATALOG] = v.env_value(doc, v.CATALOG)
                    if self.fail_after == c:
                        raise RuntimeError('simulated recreate failure after ' + c)
            return v.SHARED, apply
        v.Step.sandboxes_file = sandboxes_file

    def test_partial_apply_resumes_before_catalog_equality(self):
        for reader in [self.v.CONTROL, self.v.MAIN]:
            with self.subTest(reader=reader):
                # Each iteration starts from the same original shared catalog.
                self.setUp()
                v = self.v; self.fail_after = reader
                with self.assertRaisesRegex(RuntimeError, 'simulated recreate'):
                    v.staging_gateway(self.arg)
                self.assertEqual(v.owner(), self.arg['run'])
                self.fail_after = None
                result = v.staging_gateway({**self.arg, 'action': 'source'})
                self.assertEqual(result, self.source)
                self.assertEqual(self.calls, ['apply', 'apply'])
                self.assertEqual(v.owner(), '')
                self.assertEqual(self.envs[v.CONTROL][v.CATALOG], self.envs[v.MAIN][v.CATALOG])
                self.assertEqual(v.read(v.HOME / 'state.json')['current'], self.current)

    def test_partial_apply_refuses_foreign_owner_or_changed_images_and_pins(self):
        v = self.v
        with self.assertRaises(RuntimeError): v.staging_gateway(self.arg)
        self.fail_after = None
        for change in ['owner', 'image', 'pins']:
            with self.subTest(change=change):
                (v.HOME / 'active').write_text('other' if change == 'owner' else self.arg['run'])
                self.images[v.MAIN] = 'changed' if change == 'image' else 'main-image'
                self.envs[v.MAIN][v.KEY] = 'changed' if change == 'pins' else 'rt1_prod'
                with self.assertRaises(RuntimeError): v.staging_gateway({**self.arg, 'action': 'source'})
                self.assertEqual(len(self.calls), 1)

    def ordinary(self, action, driver='one', **extra):
        return self.v.ordinary_staging({'action': action, 'run': '20261021T000000Z-1234abcd',
                                       'driver': driver, **extra})

    def test_prepared_cutover_blocks_helpers_and_full_flow_before_mutation(self):
        v = self.v; (v.HOME / 'active').write_text('prepared-staging-cutover')
        v.main_read = lambda *a, **kw: self.fail('DB mutation under foreign owner')
        v.recreate = lambda *a, **kw: self.fail('recreate under foreign owner')
        target = {p: 'rt1_' + 'a' * 64 for p in v.STAGING_PROVIDERS}
        for call in [lambda: v.staging(target), lambda: v.work_drain(0), v.unhold,
                     lambda: self.ordinary('begin', image=self.image, releases=target)]:
            with self.assertRaisesRegex(RuntimeError, 'owned by'): call()
        self.assertEqual(v.owner(), 'prepared-staging-cutover')

    def test_whole_flow_reservation_survives_driver_crash_and_requires_same_run_lease(self):
        v = self.v; target = {p: 'rt1_' + 'a' * 64 for p in v.STAGING_PROVIDERS}
        self.ordinary('begin', image=self.image, releases=target)
        marker = v.owner()
        with self.assertRaises(RuntimeError): v.claim('new-cutover')
        with self.assertRaisesRegex(RuntimeError, 'driven by another'):
            self.ordinary('touch', driver='two')
        lease = v.HOME / marker / 'lease.json'
        old = v.read(lease); old['seen'] -= v.LEASE + 1
        v.atomic(lease, json.dumps(old).encode())
        self.ordinary('begin', driver='two', image=self.image, releases=target)
        # Expiry never releases ownership to a different run or to a cutover.
        with self.assertRaises(RuntimeError): v.claim('new-cutover')
        v.main_read = lambda *a, **kw: {'work': '[]'}
        self.ordinary('drain', driver='two', seconds=0)
        self.ordinary('finish', driver='two')
        self.assertEqual(v.owner(), '')


if __name__ == '__main__':
    unittest.main()
