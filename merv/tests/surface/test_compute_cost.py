"""HTTP surface for the project compute-spend panel.

GET /api/projects/{id}/compute-cost presents service-reported amounts
with experiment names hydrated from local research associations.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from tests.support.brain import TestBrain
from tests.support.infrastructure import FakeInfrastructureClient
from merv.brain.surface.transport.api import create_fastapi_app


class ComputeCostEndpointTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
            infrastructure_client=FakeInfrastructureClient(),
        )
        self.client = TestClient(create_fastapi_app(self.app))
        self.project_id = self.app.call_tool("project", {"action": "create", "name": "Cost P"})["id"]

    def tearDown(self) -> None:
        self.app.shutdown()
        self.tmp.cleanup()

    def _get(self, path: str) -> dict:
        response = self.client.get(path)
        self.assertLess(response.status_code, 400, response.text)
        return response.json()

    def test_empty_project_returns_zeroed_shape(self) -> None:
        body = self._get(f"/api/projects/{self.project_id}/compute-cost")
        self.assertAlmostEqual(body["total_usd"], 0.0)
        self.assertEqual(body["generations"], 0)
        self.assertEqual(body["by_experiment"], [])
        self.assertEqual(body["daily"], [])

    def test_spend_served_with_experiment_names(self) -> None:
        exp_id = self.app.call_tool(
            "experiment.create",
            {"project_id": self.project_id, "name": "ablation-sweep", "intent": "x"},
        )["id"]
        with self.app.store.transaction() as conn:
            conn.execute(
                """
                INSERT INTO remote_sandbox_links (project_id, sandbox_uid, experiment_id, created_at)
                VALUES (?, 'sbx_reported', ?, '2026-01-01T00:00:00Z')
                """,
                (self.project_id, exp_id),
            )
        amount = {"currency": "USD", "amount": "2.58"}
        self.app.server.app.infrastructure_client.spend_reports[self.project_id] = {
            "namespace": self.project_id, "member_id": None, "as_of": "2026-01-01T02:00:00Z",
            "accrued": [amount], "reserved": [], "hourly_rate": [], "hours": "2", "unpriced_hours": "0",
            "resource_count": 1, "active_resource_count": 0,
            "resources": [{"id": "sbx_reported", "hours": "2", "accrued": amount}],
            "daily": [{"date": "2026-01-01", "hours": "2", "totals": [amount]}],
            "by_hardware": [{"instance_type": "gpu_1x_a100", "gpu": "A100", "hourly_price": {"currency": "USD", "amount": "1.29"}, "hours": "2", "resource_count": 1, "accrued": [amount]}],
        }
        body = self._get(f"/api/projects/{self.project_id}/compute-cost")
        self.assertAlmostEqual(body["total_usd"], 2.58)
        self.assertAlmostEqual(body["total_hours"], 2.0)
        self.assertEqual(body["open_generations"], 0)
        self.assertEqual(len(body["by_experiment"]), 1)
        self.assertEqual(body["by_experiment"][0]["experiment_id"], exp_id)
        self.assertEqual(body["by_experiment"][0]["experiment_name"], "ablation-sweep")
        self.assertEqual(body["by_hardware"][0]["instance_type"], "gpu_1x_a100")
        self.assertEqual([d["date"] for d in body["daily"]], ["2026-01-01"])

    def test_imported_service_amounts_keep_their_experiment_associations(self) -> None:
        exp_id = self.app.call_tool("experiment.create", {
            "project_id": self.project_id, "name": "historical-run", "intent": "x",
        })["id"]
        amount = {"currency": "USD", "amount": "7.125"}
        self.app.server.app.infrastructure_client.spend_reports[self.project_id] = {
            "namespace": self.project_id, "member_id": "member", "as_of": "2026-01-01T02:00:00Z",
            "accrued": [amount], "reserved": [], "hourly_rate": [], "hours": "0.5", "unpriced_hours": "0",
            "hours_coverage": "complete",
            "resource_count": 0, "active_resource_count": 0, "resources": [], "daily": [],
            "adjustments": [{"id": "imported-charge", "accrued": amount, "compute_hours": "0.5", "reference": {
                "application": "merv", "project_id": self.project_id, "experiment_id": exp_id,
            }}],
        }
        body = self._get(f"/api/projects/{self.project_id}/compute-cost")
        self.assertEqual(body["total_usd"], 7.125)
        self.assertEqual(body["by_experiment"][0]["usd"], 7.125)
        self.assertEqual(body["by_experiment"][0]["experiment_name"], "historical-run")
        self.assertEqual(body["by_experiment"][0]["historical_adjustment_count"], 1)
        self.assertEqual(body["hours_coverage"], "complete")
        self.assertEqual(body["total_hours"], 0.5)
        self.assertEqual(body["by_experiment"][0]["hours"], 0.5)


if __name__ == "__main__":
    unittest.main()
