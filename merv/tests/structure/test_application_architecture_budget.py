"""Ratchets for the consolidated Application boundary."""

from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
APPLICATION = ROOT / "src/merv/brain/application"
SURFACE = ROOT / "src/merv/brain/surface"


class ApplicationArchitectureBudgetTest(unittest.TestCase):
    def test_one_public_root_replaces_the_service_bag(self) -> None:
        composition = (SURFACE / "surface.py").read_text()
        handlers = (SURFACE / "tools/dispatcher.py").read_text()
        self.assertEqual(composition.count("Application("), 1)
        self.assertIn('"application": self.application', composition)
        self.assertNotIn("from ...application", handlers)
        for removed in (
            "facade.py",
            "events.py",
            "tool_commands.py",
            "experiments/reactions.py",
            "experiments/tracking.py",
            "experiments/tracking_presentation.py",
            "ports",
        ):
            self.assertFalse((APPLICATION / removed).exists(), removed)

    def test_mlflow_is_one_explicit_optional_integration(self) -> None:
        integration = (APPLICATION / "mlflow.py").read_text()
        root = (APPLICATION / "application.py").read_text()
        transition = (APPLICATION / "experiments/transition.py").read_text()
        deliveries = (APPLICATION / "workflow_actions.py").read_text()
        self.assertIn("class MlflowIntegration:", integration)
        self.assertIn("self._mlflow = MlflowIntegration(", root)
        self.assertNotIn("self.mlflow.after_transition(", transition)
        self.assertIn("tracking.deliver_workflow_action", deliveries)
        self.assertIn("self.workflow_deliveries = WorkflowDeliveries(", root)
        for path in APPLICATION.rglob("*.py"):
            if path.name == "mlflow.py":
                continue
            source = path.read_text()
            self.assertNotIn("adapter.create_run(", source, path)
            self.assertNotIn("adapter.finalize_run(", source, path)
            self.assertNotIn("adapter.project_results_snapshot(", source, path)

    def test_application_owns_workflow_without_dispatching_events(self) -> None:
        self.assertNotIn(
            "EventDispatcher",
            "\n".join(path.read_text() for path in APPLICATION.rglob("*.py")),
        )


if __name__ == "__main__":
    unittest.main()
