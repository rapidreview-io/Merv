from __future__ import annotations

import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from pathlib import Path

from fastapi.testclient import TestClient

from tests.support.brain import TestBrain
from merv.brain.surface.tools.contracts import TOOL_MANIFEST
from merv.brain.kernel.utils import ValidationError


class ProjectToolTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        # Not an identity test: agent_id is merely recorded here (see test_agent_identity.py).
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
            env={"MERV_AGENT_IDENTITY": "optional"},
        )

    def tearDown(self) -> None:
        self.app.shutdown()
        self.tmp.cleanup()

    def test_context_writer_is_narrow_persistent_and_rejects_stale_text(self) -> None:
        project = self.call("project", action="create", name="Intent", summary="A user's problem.")
        args = dict(project_id=project["id"], expected_summary=project["summary"])
        for extra in ({"name": "Renamed"}, {"agent_dispatch": True}, {"hidden": True}):
            with self.assertRaises(ValidationError):
                self.call("project.context.update", summary="Changed", **args, **extra)
        with self.assertRaises(ValidationError):
            self.call("project.context.update", project_id=project["id"], summary="Changed")
        with self.assertRaisesRegex(ValidationError, "intent changed"):
            self.call("project.context.update", project_id=project["id"], summary="Changed",
                      expected_summary=" " + project["summary"])
        revised = "A user's problem.\nGoal: answer it within the original scope."
        changed = self.call("project.context.update", summary=revised, **args)
        self.assertEqual(changed["settings"], project["settings"])
        self.assertEqual(changed["name"], project["name"])
        with self.assertRaisesRegex(ValidationError, "intent changed"):
            self.call("project.context.update", summary="Stale replacement", **args)
        self.app.shutdown()
        self.app = TestBrain(repo_root=self.repo, db_path=self.app.db_path,
                             env={"MERV_AGENT_IDENTITY": "optional"})
        self.assertEqual(self.call("project", action="overview", project_id=project["id"])["project"]["summary"], revised)
        with self.app.store.connect() as conn:
            events = conn.execute("SELECT payload_json FROM events WHERE project_id = ? AND type = ?",
                                  (project["id"], "project.context.updated")).fetchall()
        self.assertEqual(len(events), 1)
        self.assertIn("original scope", events[0]["payload_json"])

    def test_two_writers_cannot_overwrite_the_same_observed_intent(self) -> None:
        project = self.call("project", action="create", name="Concurrent intent")
        barrier = Barrier(2)
        def write(summary):
            barrier.wait(timeout=5)
            try:
                return self.app.research.update_project_context(
                    project_id=project["id"], summary=summary, expected_summary="")
            except ValidationError as error:
                return error
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(write, ("User clarification A", "User clarification B")))
        winners = [result for result in results if isinstance(result, dict)]
        self.assertEqual(len(winners), 1)
        self.assertEqual(sum(isinstance(result, ValidationError) for result in results), 1)
        self.assertEqual(self.call("project.get", project_id=project["id"])["summary"], winners[0]["summary"])

    def call(self, tool: str, **kwargs):
        return self.app.call_tool(tool, kwargs)

    def test_project_view_omits_legacy_hard_stop_fields(self) -> None:
        # The hard-stop mechanism is gone; views must not resurface its
        # legacy columns even on databases that still carry them.
        project = self.call("project", action="create", name="Alpha")
        self.assertNotIn("hard_stop_reflection_id", project)
        self.assertNotIn("hard_stop_rationale", project)
        self.assertNotIn("stopped_at", project)

        fetched = self.call("project.get", project_id=project["id"])
        self.assertNotIn("hard_stop_reflection_id", fetched)
        self.assertNotIn("hard_stop_rationale", fetched)
        self.assertNotIn("stopped_at", fetched)

    def test_project_name_must_be_at_least_three_chars_on_create_and_update(self) -> None:
        with self.assertRaises(ValidationError) as ctx:
            self.call("project", action="create", name="ab")
        self.assertIn("at least 3", str(ctx.exception))

        project = self.call("project", action="create", name="Alpha")
        with self.assertRaises(ValidationError) as empty_ctx:
            self.call("project.update", project_id=project["id"], name=" ")
        self.assertIn("name is required", str(empty_ctx.exception))

        with self.assertRaises(ValidationError) as short_ctx:
            self.call("project.update", project_id=project["id"], name="xy")
        self.assertIn("at least 3", str(short_ctx.exception))

        updated = self.call("project.update", project_id=project["id"], name="Beta")
        self.assertEqual(updated["name"], "Beta")

    def test_hidden_project_is_stashed_from_list_but_retained(self) -> None:
        keep = self.call("project", action="create", name="Keep")
        stash = self.call("project", action="create", name="Stash")

        self.call("project.update", project_id=stash["id"], hidden=True)

        # project.list (the UI project picker) omits the hidden project...
        listed = {p["id"] for p in self.call("project.list")["projects"]}
        self.assertIn(keep["id"], listed)
        self.assertNotIn(stash["id"], listed)

        # ...but the row and direct-by-id access are fully retained.
        fetched = self.call("project.get", project_id=stash["id"])
        self.assertEqual(fetched["name"], "Stash")
        self.assertTrue(fetched["settings"]["hidden"])

        # Restoring returns it to the list (reversible).
        self.call("project.update", project_id=stash["id"], hidden=False)
        restored = {p["id"] for p in self.call("project.list")["projects"]}
        self.assertIn(stash["id"], restored)

    def test_action_create_requires_name(self) -> None:
        with self.assertRaises(ValidationError) as ctx:
            self.call("project", action="create")
        self.assertIn("name", str(ctx.exception))

    def test_action_create_rejects_short_name(self) -> None:
        with self.assertRaises(ValidationError) as ctx:
            self.call("project", action="create", name="ab")
        self.assertIn("3", str(ctx.exception))

    def test_action_current_rejects_extra_fields(self) -> None:
        with self.assertRaises(ValidationError) as ctx:
            self.call("project", action="current", name="Alpha")
        self.assertIn("current", str(ctx.exception))

    def test_action_overview_rejects_extra_fields(self) -> None:
        with self.assertRaises(ValidationError) as ctx:
            self.call("project", action="overview", name="Alpha")
        self.assertIn("overview", str(ctx.exception))

    def test_action_records_reads_all_claims_and_experiments(self) -> None:
        # overview returns every claim including a non-active one (the
        # whole-project read). A direct caller may pass an explicit project id.
        pid = self.app.current_project()["project"]["id"]
        claim = self.call("claim.create", project_id=pid, statement="Overview claim.")
        self.call("claim.update", project_id=pid, claim_id=claim["id"], status="abandoned")
        overview = self.call("project", action="records", project_id=pid)
        self.assertEqual(overview["project"]["id"], pid)
        self.assertEqual(
            {c["id"]: c["status"] for c in overview["claims"]}[claim["id"]],
            "abandoned",
        )
        self.assertIn("experiments", overview)

    def test_brain_current_without_a_bound_key_reports_exists_false(self) -> None:
        # D7: current now resolves against the key's bound project. A caller
        # with no key is simply unbound — not an error.
        result = self.call("project", action="current")
        self.assertFalse(result["exists"])
        self.assertIn("hint", result)

    def test_current_over_direct_http_mcp_call(self) -> None:
        # current is served (unbound → 200 exists:false).
        client = TestClient(self.app.fastapi_app)
        current = client.post(
            "/mcp/call", json={"name": "project", "arguments": {"action": "current"}}
        )
        self.assertEqual(current.status_code, 200, current.text)
        self.assertFalse(current.json()["result"]["exists"])

    def test_action_create_forwards_over_direct_http_mcp_call(self) -> None:
        client = TestClient(self.app.fastapi_app)
        response = client.post(
            "/mcp/call",
            json={
                "name": "project",
                "arguments": {"action": "create", "name": "Http Made"},
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["result"]["name"], "Http Made")

    def test_project_list_is_hidden_from_agents(self) -> None:
        self.assertEqual(TOOL_MANIFEST["project.list"].visibility, "internal")

    def test_update_without_hidden_leaves_hidden_unchanged(self) -> None:
        project = self.call("project", action="create", name="Alpha")
        self.call("project.update", project_id=project["id"], hidden=True)
        self.call("project.update", project_id=project["id"], summary="edited")
        fetched = self.call("project.get", project_id=project["id"])
        self.assertTrue(fetched["settings"]["hidden"])
        self.assertEqual(fetched["summary"], "edited")


if __name__ == "__main__":
    unittest.main()
