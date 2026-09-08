from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tests.support.infrastructure import FakeInfrastructureClient
from merv.shared.errors import ResearchPluginError
from tests.support.brain import TestBrain


class TrackingAbsentProductSurfaceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.app = TestBrain(
            repo_root=root,
            db_path=root / ".merv" / "state.sqlite",
            infrastructure_client=FakeInfrastructureClient(),
            env={
                # Stale deployment configuration must not silently re-enable
                # the removed integration.
                "MERV_MLFLOW_TRACKING_URI": "https://legacy.invalid",
                "MERV_MLFLOW_SERVER_URI": "https://legacy.invalid",
            },
        )
        self.project = self.app.call_tool(
            "project",
            {"action": "create", "name": "Surface Test", "summary": "No tracking"},
        )

    def tearDown(self) -> None:
        self.app.shutdown()
        self.tmp.cleanup()

    def test_tools_routes_and_home_have_no_tracking_surface(self) -> None:
        self.assertIsNone(self.app._app._tracking)
        names = {tool["name"] for tool in self.app.list_tools()}
        self.assertNotIn("mlflow.context", names)
        self.assertNotIn("mlflow.finalize_run", names)

        project_id = self.project["id"]
        home = self.app._client.get(f"/api/projects/{project_id}/home")
        self.assertEqual(home.status_code, 200)
        self.assertNotIn("mlflow", home.json())
        self.assertEqual(
            self.app._client.get(f"/api/projects/{project_id}/mlflow").status_code,
            404,
        )

        with self.assertRaises(ResearchPluginError):
            self.app.call_tool("mlflow.context", {"project_id": project_id})

    def test_legacy_run_columns_are_scrubbed_from_project_and_status_reads(self) -> None:
        project_id = self.project["id"]
        experiment = self.app.call_tool(
            "experiment.create",
            {
                "project_id": project_id,
                "name": "legacy-row",
                "intent": "Verify public projection",
            },
        )
        experiment_id = experiment["id"]
        with self.app.store.transaction() as conn:
            conn.execute(
                """
                UPDATE experiments
                SET status = 'running',
                    mlflow_run_id = 'legacy-run',
                    mlflow_run_name = 'legacy-name',
                    mlflow_run_status = 'RUNNING'
                WHERE id = ?
                """,
                (experiment_id,),
            )

        responses = (
            self.app.call_tool(
                "project", {"action": "overview", "project_id": project_id}
            ),
            self.app.call_tool(
                "experiment.get_state",
                {"project_id": project_id, "experiment_id": experiment_id},
            ),
            self.app.call_tool(
                "workflow.status_and_next",
                {"project_id": project_id, "experiment_id": experiment_id},
            ),
            self.app._client.get(f"/api/projects/{project_id}/home").json(),
        )
        for response in responses:
            self.assertNotIn("mlflow", str(response).lower())


if __name__ == "__main__":
    unittest.main()
