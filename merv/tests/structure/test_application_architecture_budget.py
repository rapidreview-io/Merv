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

    def test_no_application_file_reaches_an_external_tracking_adapter(self) -> None:
        # The external run-tracking integration was deleted whole: no adapter,
        # no optional collaborator, no per-file re-entry point for one.
        root = (APPLICATION / "application.py").read_text()
        self.assertIn("self.workflow_deliveries = WorkflowDeliveries(", root)
        for path in APPLICATION.rglob("*.py"):
            source = path.read_text()
            for reintroduced in ("adapter.create_run(", "adapter.finalize_run(",
                                 "adapter.project_results_snapshot("):
                self.assertNotIn(reintroduced, source, path)

    def test_surface_owns_ui_projection_but_not_cross_module_workflow(self) -> None:
        figure = (SURFACE / "experiment_figure.py").read_text()
        routes = (SURFACE / "transport/api/experiments.py").read_text()
        self.assertIn("def build_experiment_figure(", figure)
        self.assertIn("application.figure_facts(", routes)
        self.assertNotIn(
            "EventDispatcher",
            "\n".join(path.read_text() for path in APPLICATION.rglob("*.py")),
        )


if __name__ == "__main__":
    unittest.main()
