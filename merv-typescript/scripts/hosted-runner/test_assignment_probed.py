import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[2] / 'output/fleet-sandboxes/control/src'))
spec = importlib.util.spec_from_file_location('assignment_probed', HERE / 'assignment-probed.py')
wrapper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wrapper)


class AssignmentProbeTests(unittest.TestCase):
    def test_only_validated_exec_checks_before_identity_drop(self):
        for arguments, expected in [
            (['--', '/opt/merv/bin/codex', 'exec'], ['attest', 'drop']),
            (['--', '/opt/merv/bin/codex', 'login', '--with-api-key'], ['drop']),
            (['--git', 'status'], ['drop']),
        ]:
            with self.subTest(arguments=arguments):
                calls = []
                with patch.object(wrapper.assignment, 'prepare_assignment_identity',
                                  side_effect=lambda **options: calls.append('drop')):
                    with patch.object(wrapper, 'attest_workflow', side_effect=lambda workspace: calls.append('attest')):
                        with patch.object(wrapper.assignment, 'main', side_effect=lambda: wrapper.assignment.prepare_assignment_identity(uid=12001)):
                            with patch.object(sys, 'argv', ['assignment-probed.py', *arguments]):
                                wrapper.main()
                self.assertEqual(calls, expected)

    def test_failed_attestation_prevents_exec_identity_handoff(self):
        with patch.object(wrapper.assignment, 'prepare_assignment_identity') as drop:
            with patch.object(wrapper, 'attest_workflow', side_effect=RuntimeError('refused')):
                with patch.object(wrapper.assignment, 'main', side_effect=lambda: wrapper.assignment.prepare_assignment_identity(uid=12001)):
                    with patch.object(sys, 'argv', ['assignment-probed.py', '--', '/opt/merv/bin/codex', 'exec']):
                        with self.assertRaises(RuntimeError):
                            wrapper.main()
            drop.assert_not_called()


if __name__ == '__main__':
    unittest.main()
