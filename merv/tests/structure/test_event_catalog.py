from __future__ import annotations

import ast
import re
import unittest
from pathlib import Path


APPLICATION = Path(__file__).resolve().parents[2] / "src/merv/brain/application"
EVENT_TYPE = re.compile(r"^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$")
FROZEN_DURABLE_EVENT_TYPES = frozenset(
    {
        "artifact.pinned",
        "artifact.submitted",
        "candidate.promoted",
        "candidate.staged",
        "candidate.submitted",
        "claim.created",
        "claim.updated",
        "experiment.created",
        "experiment.exhibit_generated",
        "experiment.mlflow_run_created",
        "experiment.mlflow_run_refreshed",
        "experiment.mlflow_run_unavailable",
        "experiment.returned_to_planned",
        "experiment.returned_to_running",
        "experiment.transitioned",
        "feed.author_registered",
        "feed.post_created",
        "litreview.paper_cited",
        "litreview.section_added",
        "litreview.section_deleted",
        "litreview.section_edited",
        "litreview.sections_reordered",
        "project.created",
        "project.updated",
        "reflection.created",
        "reflection.central_advance_intended",
        "reflection.central_advance_stale",
        "reflection.consolidation_proposed",
        "reflection.consolidation_returned",
        "reflection.returned_to_reflecting",
        "reflection.returned_to_synthesizing",
        "reflection.transitioned",
        "review.requested",
        "review.started",
        "review.submitted",
        "run.finished",
        "sandbox.attached",
        "sandbox.budget_terminated",
        "sandbox.budget_warning",
        "sandbox.cleanup_confirmed",
        "sandbox.cleanup_pending",
        "sandbox.cleanup_retried",
        "sandbox.created",
        "sandbox.endpoint_refreshed",
        "sandbox.expired",
        "sandbox.failed",
        "sandbox.idle_reaped",
        "sandbox.lifetime_extended",
        "sandbox.over_budget",
        "sandbox.released",
        "sandbox.reused",
        "storage.completed",
        "storage.deleted",
        "storage.expired",
        "storage.registered",
        "task.created",
        "task.failed_by_review",
        "task.returned_to_in_progress",
        "task.transitioned",
        "telemetry.dropped",
        "tool.call",
    }
)


class EventCatalogStructureTest(unittest.TestCase):
    def test_complete_durable_event_name_inventory_is_frozen(self) -> None:
        """Catch coordinated producer/consumer renames outside the reaction catalog."""
        found: set[str] = set()
        for path in APPLICATION.parent.rglob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for call in (node for node in ast.walk(tree) if isinstance(node, ast.Call)):
                expressions = [
                    keyword.value
                    for keyword in call.keywords
                    if keyword.arg in {"event", "event_type"}
                ]
                if (
                    isinstance(call.func, ast.Name)
                    and call.func.id == "LifecycleEvent"
                    and call.args
                ):
                    expressions.append(call.args[0])
                for expression in expressions:
                    found.update(
                        str(node.value)
                        for node in ast.walk(expression)
                        if isinstance(node, ast.Constant)
                        and isinstance(node.value, str)
                        and EVENT_TYPE.fullmatch(node.value)
                    )
        self.assertEqual(found, FROZEN_DURABLE_EVENT_TYPES)


if __name__ == "__main__":
    unittest.main()
