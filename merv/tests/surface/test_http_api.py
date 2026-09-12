from __future__ import annotations

import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from tests.support.brain import TestBrain, upload_token
from tests.research_core.scenarios import (
    REVIEW_SYNOPSIS, VALID_GRAPH, VALID_PLAN, VALID_REPORT, complete_no_code_consolidation,
)
from merv.brain.workflows.definitions.experiment import RETURN_TO_PLANNED
from merv.brain.surface.transport.api import create_fastapi_app
from tests.support.infrastructure import FakeInfrastructureClient, seed_sandbox
from merv.brain.kernel.utils import now_iso


class ResearchPluginHttpApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.backend = FakeInfrastructureClient()
        # Not an identity test: agent_id is merely recorded here (see test_agent_identity.py).
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
            infrastructure_client=self.backend,
            env={"MERV_AGENT_IDENTITY": "optional"},
        )
        self.client = TestClient(create_fastapi_app(self.app))

    def tearDown(self) -> None:
        self.client.close()
        self.app.shutdown()
        self.tmp.cleanup()

    def request(self, method: str, path: str, body: dict | None = None):
        response = self.client.request(method, path, json=body)
        self.assertLess(response.status_code, 400, response.text)
        return response.json()

    def submit(
        self,
        *,
        pid: str,
        target_type: str,
        target_id: str,
        role: str,
        path: str,
        body: str,
        lens_id: str = "",
    ) -> dict:
        return self.app.submit_artifact(
            project_id=pid,
            target_type=target_type,
            target_id=target_id,
            role=role,
            path=path,
            body=body,
            lens_id=lens_id,
        )

    def review_experiment(self, project_id, experiment_id, role, verdict="pass", return_to=None):
        request = self.request("POST", f"/api/projects/{project_id}/reviews/request", {
            "target_type": "experiment", "target_id": experiment_id, "role": role,
        })
        reviewer = self.request("POST", f"/api/projects/{project_id}/reviews/start", {
            "review_request_id": request["review_request_id"],
            "reviewer_capability": request["reviewer_capability"], "caller_session_id": "http-reviewer",
        })
        return self.request("POST", f"/api/projects/{project_id}/reviews/submit", {
            "review_session_id": reviewer["review_session_id"], "verdict": verdict,
            "synopsis": REVIEW_SYNOPSIS, **({"return_to": return_to} if return_to else {}),
        })

    def approve_execution(self, project_id, experiment_id):
        self.submit(pid=project_id, target_type="experiment", target_id=experiment_id,
                    role="plan", path="plan.md", body=VALID_PLAN)
        self.request("POST", f"/api/projects/{project_id}/experiments/{experiment_id}/transition", {"transition": "submit_design"})
        self.review_experiment(project_id, experiment_id, "design_reviewer")

    def begin_execution(self, project_id, experiment_id):
        current = self.app.workflows.runtime.get(project_id=project_id, instance_id=experiment_id)
        self.app.call_tool("workflow.begin", {
            "project_id": project_id, "instance_id": experiment_id, "expected_revision": current.revision,
        })
        self.app.application.workflow_deliveries.run_once(project_id=project_id)
        return self.app.call_tool("experiment.get_state", {"project_id": project_id, "experiment_id": experiment_id})

    def test_project_context_http_cas_and_pending_document(self) -> None:
        project = self.request("POST", "/api/projects", {"name": "Intent", "summary": "Original"})
        pid = project["id"]
        path = f"/api/projects/{pid}"
        home = self.request("GET", f"{path}/home")
        self.assertFalse(home["project"]["maintenance"]["pending"])
        updated = self.request("PATCH", f"{path}/context", {
            "summary": "Clarified scope", "expected_summary": "Original",
        })
        self.assertEqual(updated["summary"], "Clarified scope")
        stale = self.client.patch(f"{path}/context", json={
            "summary": "Overwrite", "expected_summary": "Original",
        })
        self.assertEqual(stale.status_code, 400, stale.text)
        self.assertEqual(stale.json()["reason"], "stale_project_context")
        missing = self.client.patch(f"{path}/context", json={"summary": "No CAS"})
        self.assertEqual(missing.status_code, 400, missing.text)
        home = self.request("GET", f"{path}/home")
        self.assertEqual(home["project"]["summary"], "Clarified scope")
        self.assertTrue(home["project"]["maintenance"]["pending"])
        self.assertEqual(home["project"]["methods"], "")
        self.assertIn("project.context.updated", [e["type"] for e in home["recent_events"]])
        renamed = self.request("PATCH", path, {"name": "Renamed", "agent_dispatch": False})
        self.assertEqual(renamed["summary"], "Clarified scope")
        self.assertEqual(renamed["name"], "Renamed")
        # Optional intent can be cleared without adding a completeness gate.
        cleared = self.request("PATCH", f"{path}/context", {
            "summary": "", "expected_summary": "Clarified scope",
        })
        self.assertEqual(cleared["summary"], "")

    def test_home_claim_experiment_artifact_review_endpoints(self) -> None:
        project = self.request(
            "POST",
            "/api/projects",
            {"name": "UI Project", "summary": "Frontend target"},
        )
        project_id = project["id"]
        claim = self.request(
            "POST",
            f"/api/projects/{project_id}/claims",
            {"statement": "Threshold classifier improves toy accuracy."},
        )
        exp = self.request(
            "POST",
            f"/api/projects/{project_id}/experiments",
            {
                "name": "threshold-vs-baseline",
                "intent": "Compare threshold with baseline.",
                "claim_ids": [claim["id"]],
            },
        )
        exp_id = exp["id"]
        first = self.submit(
            pid=project_id,
            target_type="experiment",
            target_id=exp_id,
            role="plan",
            path="plan.md",
            body=(
                "## Summary\nCompare a threshold classifier with the baseline.\n\n"
                "## Objective & hypothesis\nThreshold rule beats majority class.\n\n"
                "## Evaluation\nMetric: accuracy vs majority baseline; success if higher.\n"
            ),
        )

        home = self.request("GET", f"/api/projects/{project_id}/home")
        self.assertEqual(home["project"]["name"], "UI Project")
        self.assertEqual(home["stats"]["claims"], 1)
        self.assertEqual(home["workflow"]["next_action"], "submit_design")

        content = self.request(
            "GET",
            f"/api/projects/{project_id}/artifacts/{first['artifact_id']}/content",
        )
        self.assertIn("accuracy", content["content"])
        # Resubmitting the same slot supersedes: a new artifact id, old row gone.
        second = self.submit(
            pid=project_id,
            target_type="experiment",
            target_id=exp_id,
            role="plan",
            path="plan.md",
            body=(
                "## Summary\nCompare a threshold classifier with the baseline (v2).\n\n"
                "## Objective & hypothesis\nThreshold rule beats majority class.\n\n"
                "## Evaluation\nMetric: accuracy vs majority baseline; success if higher.\n"
            ),
        )
        artifact_id = second["artifact_id"]
        self.assertNotEqual(artifact_id, first["artifact_id"])
        listing = self.request("GET", f"/api/projects/{project_id}/artifacts")
        self.assertEqual([row["id"] for row in listing["artifacts"]], [artifact_id])

        self.request(
            "POST",
            f"/api/projects/{project_id}/experiments/{exp_id}/transition",
            {"transition": "submit_design"},
        )
        review_request = self.request(
            "POST",
            f"/api/projects/{project_id}/reviews/request",
            {
                "target_type": "experiment",
                "target_id": exp_id,
                "role": "design_reviewer",
            },
        )
        self.assertEqual(review_request["role"], "design_reviewer")
        self.assertNotIn("target_snapshot", review_request)  # the queue view below carries it
        reviews = self.request(
            "GET",
            f"/api/projects/{project_id}/reviews?target_type=experiment&target_id={exp_id}",
        )
        self.assertEqual(len(reviews["requests"]), 1)
        self.assertEqual(
            reviews["requests"][0]["target_snapshot"]["artifacts"][0]["artifact_id"],
            artifact_id,
        )
        queue = self.request("GET", f"/api/projects/{project_id}/reviews")
        self.assertEqual(
            queue["requests"][0]["target_snapshot"]["artifacts"][0]["artifact_id"],
            artifact_id,
        )

        # The synopsis is the researcher's TLDR: it persists and surfaces on
        # both the target-scoped review.status view and the project-wide queue.
        session = self.request(
            "POST",
            f"/api/projects/{project_id}/reviews/start",
            {
                "review_request_id": review_request["review_request_id"],
                "reviewer_capability": review_request["reviewer_capability"],
                "caller_session_id": "home-endpoint-reviewer",
            },
        )
        synopsis = "The threshold rule clears the majority-class baseline, so the design is sound."
        self.request(
            "POST",
            f"/api/projects/{project_id}/reviews/submit",
            {
                "review_session_id": session["review_session_id"],
                "verdict": "pass",
                "synopsis": synopsis,
            },
        )
        conn = self.app._store.connect()
        try:
            cursor = int(
                conn.execute("SELECT MAX(id) AS id FROM events").fetchone()["id"]
            )
        finally:
            conn.close()
        tool_status = self.app.call_tool(
            "review.status",
            {
                "project_id": project_id,
                "target_type": "experiment",
                "target_id": exp_id,
            },
        )
        status = self.request(
            "GET",
            f"/api/projects/{project_id}/reviews?target_type=experiment&target_id={exp_id}",
        )
        self.assertEqual(status, tool_status)
        self.assertIn("feed_note", status)
        conn = self.app._store.connect()
        try:
            self.assertEqual(
                int(conn.execute("SELECT MAX(id) AS id FROM events").fetchone()["id"]),
                cursor,
            )
        finally:
            conn.close()
        self.assertEqual(status["reviews"][0]["synopsis"], synopsis)
        queue = self.request("GET", f"/api/projects/{project_id}/reviews")
        self.assertEqual(queue["reviews"][0]["synopsis"], synopsis)

    def test_review_start_and_submit_are_scoped_to_route_project(self) -> None:
        project = self.request("POST", "/api/projects", {"name": "Scoped A"})
        pid = project["id"]
        exp = self.request(
            "POST",
            f"/api/projects/{pid}/experiments",
            {"name": "exp-1", "intent": "Scoped review"},
        )
        exp_id = exp["id"]
        self.submit(
            pid=pid,
            target_type="experiment",
            target_id=exp_id,
            role="plan",
            path="plan.md",
            body=(
                "## Summary\nScoped review.\n\n"
                "## Objective & hypothesis\nTest scoping.\n\n"
                "## Evaluation\nMetric: pass/fail of the scoping check.\n"
            ),
        )
        self.request(
            "POST",
            f"/api/projects/{pid}/experiments/{exp_id}/transition",
            {"transition": "submit_design"},
        )
        req = self.request(
            "POST",
            f"/api/projects/{pid}/reviews/request",
            {
                "target_type": "experiment",
                "target_id": exp_id,
                "role": "design_reviewer",
            },
        )

        other = self.request("POST", "/api/projects", {"name": "Scoped B"})
        other_id = other["id"]

        # Starting the review under the wrong project's URL is rejected.
        wrong_start = self.client.request(
            "POST",
            f"/api/projects/{other_id}/reviews/start",
            json={
                "review_request_id": req["review_request_id"],
                "reviewer_capability": req["reviewer_capability"],
                "caller_session_id": "rev",
            },
        )
        self.assertEqual(wrong_start.status_code, 404, wrong_start.text)

        # The correct project still works.
        session = self.request(
            "POST",
            f"/api/projects/{pid}/reviews/start",
            {
                "review_request_id": req["review_request_id"],
                "reviewer_capability": req["reviewer_capability"],
                "caller_session_id": "rev",
            },
        )
        recorded = [
            event
            for event in self.app.activity.recent(limit=1000)["events"]
            if event.get("tool") == "review.start"
        ]
        self.assertEqual(len(recorded), 1)
        self.assertEqual(recorded[0]["args"]["project_id"], pid)

        wrong_submit = self.client.request(
            "POST",
            f"/api/projects/{other_id}/reviews/submit",
            json={
                "review_session_id": session["review_session_id"],
                "verdict": "pass",
                "synopsis": "The plan and results check out, so the attempt stands as reported.",
            },
        )
        self.assertEqual(wrong_submit.status_code, 404, wrong_submit.text)

        # Submitting under the owning project still works.
        self.request(
            "POST",
            f"/api/projects/{pid}/reviews/submit",
            {
                "review_session_id": session["review_session_id"],
                "verdict": "pass",
                "synopsis": "The plan and results check out, so the attempt stands as reported.",
            },
        )

    def test_claim_update_http_endpoint(self) -> None:
        project = self.request("POST", "/api/projects", {"name": "Claim Update"})
        pid = project["id"]
        claim = self.request(
            "POST", f"/api/projects/{pid}/claims", {"statement": "X improves Y."}
        )
        updated = self.request(
            "PATCH",
            f"/api/projects/{pid}/claims/{claim['id']}",
            {"status": "supported", "confidence": "high"},
        )
        self.assertEqual(updated["status"], "supported")
        self.assertEqual(updated["confidence"], "high")

    def test_sandbox_http_endpoints(self) -> None:
        project = self.request("POST", "/api/projects", {"name": "Sandbox UI Project"})
        project_id = project["id"]
        exp = self.request(
            "POST",
            f"/api/projects/{project_id}/experiments",
            {"name": "exp-2", "intent": "Run an experiment"},
        )
        exp_id = exp["id"]
        # Keep the rest of the endpoint fixture in the usual runnable state.
        with self.app.store.transaction() as conn:
            conn.execute(
                "UPDATE experiments SET status = 'ready_to_run' WHERE id = ?", (exp_id,)
            )
        # Procuring is an agent action (MCP tool); the UI observes the result.
        requested = self.app.call_tool(
            "sandbox.request",
            {"project_id": project_id, "experiment_id": exp_id, "gpu": "A100"},
        )
        self.assertEqual(requested["status"], "running")
        sandbox_uid = requested["sandbox_uid"]
        self.assertIn("host", requested["ssh"])
        self.assertNotIn("command", requested["ssh"])
        self.assertNotIn("raw_command", requested["ssh"])

        sandbox = self.request(
            "GET", f"/api/projects/{project_id}/experiments/{exp_id}/sandbox"
        )
        self.assertEqual(sandbox["status"], "running")
        self.assertEqual(sandbox["sandbox_uid"], sandbox_uid)
        self.assertNotIn("dashboards", sandbox)
        sandbox_by_uid = self.request(
            "GET", f"/api/projects/{project_id}/sandboxes/{sandbox_uid}"
        )
        self.assertEqual(sandbox_by_uid["sandbox_uid"], sandbox_uid)
        self.assertEqual(sandbox_by_uid["status"], "running")

        listed = self.request("GET", f"/api/projects/{project_id}/sandboxes")[
            "sandboxes"
        ]
        self.assertEqual(len(listed), 1)

        for route in (f"experiments/{exp_id}/sandbox", f"sandboxes/{sandbox_uid}"):
            terminal = self.request("GET", f"/api/projects/{project_id}/{route}/terminal")
            self.assertFalse(terminal["available"])
            self.assertIn("sandbox.run", terminal["transcript"])

        released = self.request(
            "POST", f"/api/projects/{project_id}/sandboxes/{sandbox_uid}/release", {"confirm_retained": True}
        )
        self.assertEqual(released["status"], "terminated")

        self.assertTrue(self.request("GET", "/api/sandboxes/health")["ok"])

    def test_application_components_share_the_composed_service_instances(self) -> None:
        self.assertIs(self.app.research.experiments, self.app.experiments)
        self.assertIs(self.app.research.artifacts, self.app.artifacts)
        self.assertFalse(hasattr(self.app._app, "_record_core"))
        self.assertIs(self.app.artifact_tools.artifacts, self.app.artifacts)
        self.assertTrue(callable(self.app.feed.advisory))
        self.assertIs(self.app.application.research, self.app.research_core)
        self.assertIs(self.app.application.artifacts, self.app.artifacts)
        self.assertIs(self.app.application.feed, self.app.feed)
        self.assertIs(self.app.application.sandboxes, self.app.sandboxes)

    def test_home_exposes_active_experiments_and_processes(self) -> None:
        project = self.request("POST", "/api/projects", {"name": "Active Work Project"})
        project_id = project["id"]
        planned = self.request(
            "POST",
            f"/api/projects/{project_id}/experiments",
            {"name": "exp-4", "intent": "Planned active work"},
        )
        running = self.request(
            "POST",
            f"/api/projects/{project_id}/experiments",
            {"name": "exp-5", "intent": "Running active work"},
        )
        complete = self.request(
            "POST",
            f"/api/projects/{project_id}/experiments",
            {"name": "exp-6", "intent": "Finished work"},
        )
        now = now_iso()
        with self.app.store.transaction() as conn:
            conn.execute(
                "UPDATE experiments SET status = 'running', updated_at = ? WHERE id = ?",
                (now, running["id"]),
            )
            conn.execute(
                "UPDATE experiments SET status = 'complete', updated_at = ? WHERE id = ?",
                (now, complete["id"]),
            )
            conn.execute(
                "UPDATE workflow_instances SET state = 'running', revision = 2 WHERE id = ?",
                (running["id"],),
            )
            conn.execute(
                "UPDATE workflow_instances SET state = 'complete', revision = 4, outcome = 'passed' WHERE id = ?",
                (complete["id"],),
            )

        seed_sandbox(self.app.sandboxes, project_id=project_id,
                     experiment_id=running["id"], sandbox_uid="uid_active", status="running")
        home = self.request("GET", f"/api/projects/{project_id}/home")

        self.assertEqual(
            [item["id"] for item in home["active_experiments"]],
            [running["id"], planned["id"]],
        )
        self.assertEqual(home["active_experiment"]["id"], running["id"])
        self.assertEqual(
            home["workflow"]["next_action"], "run_experiment_and_retain_results"
        )
        self.assertEqual(home["stats"]["active_experiments"], 2)
        self.assertEqual(home["stats"]["active_processes"], 1)
        self.assertEqual(home["active_processes"][0]["experiment_id"], running["id"])
        self.assertEqual(home["active_processes"][0]["process_type"], "sandbox")
        self.assertEqual(home["active_processes"][0]["experiment"]["id"], running["id"])
        self.assertNotIn(
            complete["id"], [item["id"] for item in home["active_experiments"]]
        )

    def test_activity_endpoint_reports_recent_tool_calls(self) -> None:
        self.request("GET", "/api/projects")
        activity = self.request("GET", "/api/activity?limit=5")
        self.assertNotIn("activity_log", activity)
        self.assertTrue(
            any(
                event.get("event") == "tool.call"
                and event.get("source") == "http"
                and event.get("tool") == "project.list"
                and "projects" in event.get("result", {})
                for event in activity["events"]
            )
        )

    def test_experiment_logic_graph_endpoint_resolves_refs(self) -> None:
        project = self.request("POST", "/api/projects", {"name": "Graph Project"})
        pid = project["id"]
        claim = self.request(
            "POST", f"/api/projects/{pid}/claims", {"statement": "Warmup matters."}
        )
        exp = self.request(
            "POST",
            f"/api/projects/{pid}/experiments",
            {
                "name": "warmup-sensitivity",
                "intent": "Test warmup sensitivity.",
                "claim_ids": [claim["id"]],
            },
        )
        exp_id = exp["id"]

        # No graph associated yet — the endpoint reports that plainly.
        empty = self.request("GET", f"/api/projects/{pid}/experiments/{exp_id}/graph")
        self.assertFalse(empty["available"])
        self.assertEqual(empty["max_nodes"], 16)

        # A passing design review supplies a real rev_ id to reference.
        plan = self.submit(
            pid=pid,
            target_type="experiment",
            target_id=exp_id,
            role="plan",
            path="plan.md",
            body=(
                "## Summary\nWarmup sweep.\n\n"
                "## Objective & hypothesis\nWarmup changes accuracy.\n\n"
                "## Evaluation\nMetric: accuracy delta; success if > 1pt.\n"
            ),
        )
        self.request(
            "POST",
            f"/api/projects/{pid}/experiments/{exp_id}/transition",
            {"transition": "submit_design"},
        )
        req = self.request(
            "POST",
            f"/api/projects/{pid}/reviews/request",
            {
                "target_type": "experiment",
                "target_id": exp_id,
                "role": "design_reviewer",
            },
        )
        session = self.request(
            "POST",
            f"/api/projects/{pid}/reviews/start",
            {
                "review_request_id": req["review_request_id"],
                "reviewer_capability": req["reviewer_capability"],
                "caller_session_id": "rev",
            },
        )
        review = self.request(
            "POST",
            f"/api/projects/{pid}/reviews/submit",
            {
                "review_session_id": session["review_session_id"],
                "verdict": "pass",
                "synopsis": "The plan and results check out, so the attempt stands as reported.",
            },
        )

        result = self.submit(
            pid=pid,
            target_type="experiment",
            target_id=exp_id,
            role="result",
            path="results.json",
            body='{"accuracy": 0.93}\n',
        )
        graph_body = {
            "version": 1,
            # Agent-authored fields are opaque data, even when a key matches a
            # local control-plane redaction name.
            "repo_root": "keep-in-authored-graph",
            "nodes": [
                {
                    "id": "obj",
                    "kind": "objective",
                    "label": "Warmup sweep",
                    "refs": [claim["id"], exp_id],
                },
                {
                    "id": "rev",
                    "kind": "pivot",
                    "label": "Design review passed",
                    "refs": [review["id"]],
                },
                {
                    "id": "out",
                    "kind": "outcome",
                    "label": "Accuracy 93%",
                    "refs": [
                        result["artifact_id"],
                        plan["artifact_id"],
                        "art_missing",
                        "notes.md",
                    ],
                },
            ],
            "edges": [{"from": "obj", "to": "rev"}, {"from": "rev", "to": "out"}],
        }
        import json as _json

        self.submit(
            pid=pid,
            target_type="experiment",
            target_id=exp_id,
            role="graph",
            path="graph.json",
            body=_json.dumps(graph_body),
        )

        payload = self.request("GET", f"/api/projects/{pid}/experiments/{exp_id}/graph")
        self.assertTrue(payload["available"])
        self.assertEqual(payload["problems"], [])
        self.assertEqual(len(payload["graph"]["nodes"]), 3)
        self.assertEqual(payload["graph"]["repo_root"], "keep-in-authored-graph")
        refs = payload["ref_index"]
        # art_ ids → submitted-artifact links.
        self.assertEqual(refs[result["artifact_id"]]["type"], "artifact")
        self.assertTrue(refs[result["artifact_id"]]["resolved"])
        self.assertEqual(refs[result["artifact_id"]]["path"], "results.json")
        self.assertEqual(refs[plan["artifact_id"]]["type"], "artifact")
        self.assertEqual(refs[plan["artifact_id"]]["path"], "plan.md")
        # rev_ / claim_ / exp_ ids → their records.
        self.assertEqual(refs[review["id"]]["type"], "review")
        self.assertEqual(refs[review["id"]]["verdict"], "pass")
        self.assertEqual(refs[claim["id"]]["type"], "claim")
        self.assertEqual(refs[claim["id"]]["statement"], "Warmup matters.")
        self.assertEqual(refs[exp_id]["type"], "experiment")
        # Unknown art_ ids and raw paths are unresolved with submit guidance —
        # refs resolve against records only, never a disk probe.
        for unresolved in ("art_missing", "notes.md"):
            self.assertFalse(refs[unresolved]["resolved"])
            self.assertIn("not a submitted artifact id", refs[unresolved]["hint"])

    def test_experiment_logic_graph_picks_latest_association_and_reports_broken_json(
        self,
    ) -> None:
        import json as _json

        project = self.request("POST", "/api/projects", {"name": "Graph Pick Project"})
        pid = project["id"]
        exp = self.request(
            "POST",
            f"/api/projects/{pid}/experiments",
            {"name": "graph-pick", "intent": "Pick the right graph file."},
        )
        exp_id = exp["id"]

        def graph_with(label):
            return _json.dumps({"version": 1, "nodes": [{"id": "n", "label": label}]})

        # Submit two graph-role files in the same attempt. The alphabetically
        # later path goes FIRST, so a last-by-path picker would choose it; the
        # endpoint must instead pick the most recently submitted file — the
        # same row the submit_results validator lints.
        for path, label in (("b_old.json", "old story"), ("a_new.json", "new story")):
            self.submit(
                pid=pid,
                target_type="experiment",
                target_id=exp_id,
                role="graph",
                path=path,
                body=graph_with(label),
            )

        payload = self.request("GET", f"/api/projects/{pid}/experiments/{exp_id}/graph")
        self.assertTrue(payload["available"])
        self.assertEqual(payload["path"], "a_new.json")
        self.assertEqual(payload["graph"]["nodes"][0]["label"], "new story")

        # Resubmitting corrupted content replaces the pinned bytes: still
        # available (a graph exists), problems stated — the UI renders them
        # instead of hiding.
        self.submit(
            pid=pid,
            target_type="experiment",
            target_id=exp_id,
            role="graph",
            path="a_new.json",
            body="{not json",
        )
        payload = self.request("GET", f"/api/projects/{pid}/experiments/{exp_id}/graph")
        self.assertTrue(payload["available"])
        self.assertIsNone(payload["graph"])
        self.assertTrue(any("not valid JSON" in p for p in payload["problems"]))

    def test_reflection_endpoints_and_project_graph(self) -> None:
        project = self.request("POST", "/api/projects", {"name": "Reflect"})
        pid = project["id"]

        # Drive a wave to published via the tool surface (the same path the
        # MCP proxy exercises); read everything back over HTTP.
        lenses = [
            {"id": "amplify"},
            {"id": "avoid"},
            {"id": "entropy"},
            {
                "id": "rigor",
                "charter": "Method soundness.",
                "why_distinct": "How we measured, not what we found.",
            },
            {
                "id": "cost",
                "charter": "Compute vs information gained.",
                "why_distinct": "Prices the exploration.",
            },
        ]
        syn = self.app.call_tool(
            "reflection.create",
            {"project_id": pid, "title": "Wave 1", "lenses": lenses},
        )
        syn_id = syn["id"]

        listing = self.request("GET", f"/api/projects/{pid}/reflections")
        self.assertEqual(len(listing["reflections"]), 1)
        self.assertEqual(listing["open_reflection"]["id"], syn_id)
        self.assertIn("signal", listing)
        checklist_item = listing["reflections"][0]["gate_checklist"]["items"][0]
        self.assertEqual(checklist_item["action"], "fan_out_reflection_subagents")
        children = self.app.workflows.runtime.get(project_id=pid, instance_id=syn_id).children
        self.assertEqual({child.key for child in children}, {lens["id"] for lens in lenses})
        self.assertEqual(
            self.request("GET", f"/api/projects/{pid}/reflections/{syn_id}")[
                "gate_checklist"
            ]["items"][0]["action"],
            "fan_out_reflection_subagents",
        )

        # No graph yet: the project-graph endpoint degrades, not errors.
        empty = self.request("GET", f"/api/projects/{pid}/reflections/current/graph")
        self.assertFalse(empty["available"])

        avoid_lens_artifact_id = ""
        for lens in ("amplify", "avoid", "entropy", "rigor", "cost"):
            submitted = self.submit(
                pid=pid,
                target_type="reflection",
                target_id=syn_id,
                role="reflection_lens_doc",
                path=f"reflections/{syn_id}/reflections/{lens}.md",
                body=f"## Summary\n{lens} findings\n",
                lens_id=lens,
            )
            if lens == "avoid":
                avoid_lens_artifact_id = submitted["artifact_id"]
        self.app.call_tool(
            "reflection.transition",
            {
                "project_id": pid,
                "reflection_id": syn_id,
                "transition": "submit_reflections",
            },
        )

        # The project graph refs the wave itself (syn_) and a lens artifact.
        graph_text = (
            '{"version": 1, "title": "Project logic", "nodes": ['
            '{"id": "a", "kind": "lesson", "label": "Lesson", "refs": ["'
            + syn_id
            + '"]},'
            '{"id": "b", "kind": "open", "label": "Open question", '
            '"refs": ["' + avoid_lens_artifact_id + '"]}],'
            ' "edges": [{"from": "a", "to": "b"}]}'
        )
        reflection_text = (
            "# Reflection\n\n"
            "## Summary\nHTTP reflection test wave.\n\n"
            "![project graph](figures/project_graph.png)\n\n"
            "## Critical reading\nThe test wave adds one claim and two planned experiments.\n\n"
            "## Decision / future directions\nCreate both HTTP experiments in parallel.\n"
        )
        change_spec_text = json.dumps(
            {
                "version": 1,
                "claim_changes": [
                    {
                        "op": "create",
                        "key": "claim_http_wave",
                        "statement": "HTTP reflection wave claim.",
                        "confidence": "medium",
                        "rationale": "The HTTP reflection test needs a materializable claim.",
                    }
                ],
                "decision": {
                    "type": "create_experiments",
                    "experiments": [
                        {
                            "key": "http_a",
                            "name": "http-wave-a",
                            "intent": "HTTP-created experiment A.",
                            "tested_claim_refs": ["claim_http_wave"],
                            "parallelism": "Independent HTTP test axis A.",
                        },
                        {
                            "key": "http_b",
                            "name": "http-wave-b",
                            "intent": "HTTP-created experiment B.",
                            "tested_claim_refs": ["claim_http_wave"],
                            "parallelism": "Independent HTTP test axis B.",
                        },
                    ],
                },
            }
        )
        self.submit(
            pid=pid,
            target_type="reflection",
            target_id=syn_id,
            role="project_graph",
            path="project/logic_graph.json",
            body=graph_text,
        )
        reflection_doc = self.submit(
            pid=pid,
            target_type="reflection",
            target_id=syn_id,
            role="reflection_doc",
            path="project/reflection.md",
            body=reflection_text,
        )
        # The upload response mints one figure token per markdown image link;
        # pushing the bytes completes the figure the same way the agent's
        # follow-up curl would.
        self.assertEqual(
            [fig["link_path"] for fig in reflection_doc["figures"]],
            ["figures/project_graph.png"],
        )
        self.app.upload_artifact_bytes(
            token=upload_token(reflection_doc["figures"][0]["run"]),
            data=b"\x89PNG\r\n\x1a\nfake",
            kind="f",
        )
        self.submit(
            pid=pid,
            target_type="reflection",
            target_id=syn_id,
            role="change_spec",
            path="project/change_spec.json",
            body=change_spec_text,
        )
        figure = self.client.get(
            f"/api/projects/{pid}/artifacts/{reflection_doc['artifact_id']}/figure",
            params={"rel": "figures/project_graph.png"},
        )
        self.assertEqual(figure.status_code, 200)
        self.assertTrue(figure.content.startswith(b"\x89PNG"))
        self.app.call_tool(
            "reflection.transition",
            {
                "project_id": pid,
                "reflection_id": syn_id,
                "transition": "submit_reflection_artifacts",
            },
        )

        # The open wave's graph renders while still under review.
        payload = self.request("GET", f"/api/projects/{pid}/reflections/current/graph")
        self.assertTrue(payload["available"])
        self.assertEqual(payload["reflection"]["id"], syn_id)
        self.assertEqual(payload["reflection"]["status"], "reflection_review")
        self.assertEqual(payload["problems"], [])
        refs = payload["ref_index"]
        self.assertEqual(refs[syn_id]["type"], "reflection")
        self.assertTrue(refs[syn_id]["resolved"])
        self.assertEqual(refs[syn_id]["title"], "Wave 1")
        reflection_ref = refs[avoid_lens_artifact_id]
        self.assertEqual(reflection_ref["type"], "artifact")

        # Review over the HTTP review endpoints (target-polymorphic).
        req = self.request(
            "POST",
            f"/api/projects/{pid}/reviews/request",
            {
                "target_type": "reflection",
                "target_id": syn_id,
                "role": "reflection_reviewer",
            },
        )
        session = self.request(
            "POST",
            f"/api/projects/{pid}/reviews/start",
            {
                "review_request_id": req["review_request_id"],
                "reviewer_capability": req["reviewer_capability"],
                "caller_session_id": "http-reviewer",
            },
        )
        self.request(
            "POST",
            f"/api/projects/{pid}/reviews/submit",
            {
                "review_session_id": session["review_session_id"],
                "verdict": "pass",
                "synopsis": "The reflection wave honestly represents the project's logic state.",
            },
        )
        complete_no_code_consolidation(
            app=self.app,
            project_id=pid,
            reflection_id=syn_id,
        )

        detail = self.request("GET", f"/api/projects/{pid}/reflections/{syn_id}")
        self.assertEqual(detail["status"], "published")
        self.assertTrue(detail["published_graph_version_id"])
        self.assertEqual(len(detail["roster"]), 5)

        # Published wave still serves the living graph as "current".
        payload = self.request("GET", f"/api/projects/{pid}/reflections/current/graph")
        self.assertTrue(payload["available"])
        self.assertEqual(payload["reflection"]["status"], "published")
        listing = self.request("GET", f"/api/projects/{pid}/reflections")
        self.assertIsNone(listing["open_reflection"])
        self.assertEqual(listing["latest_published"]["id"], syn_id)
        self.assertEqual(listing["current"]["id"], syn_id)

    def test_per_wave_graph_and_pinned_artifact_content(self) -> None:
        # The reflection-wave UI renders a SPECIFIC wave's graph + content from
        # the artifacts that wave pinned, so it stays faithful after later
        # waves submit new versions of the living files.
        roster = [
            {"id": "amplify"},
            {"id": "avoid"},
            {"id": "entropy"},
            {
                "id": "rigor",
                "charter": "Method soundness.",
                "why_distinct": "How, not what.",
            },
            {
                "id": "cost",
                "charter": "Compute spent.",
                "why_distinct": "Prices exploration.",
            },
        ]
        project = self.request("POST", "/api/projects", {"name": "Pin"})
        pid = project["id"]
        wave1_id = self.app.call_tool(
            "reflection.create",
            {"project_id": pid, "title": "Wave 1", "lenses": roster},
        )["id"]

        # Before any graph is submitted, the per-wave endpoint degrades cleanly.
        empty = self.request("GET", f"/api/projects/{pid}/reflections/{wave1_id}/graph")
        self.assertFalse(empty["available"])

        graph_text = (
            '{"version": 1, "title": "Wave 1 logic", "nodes": ['
            '{"id": "a", "kind": "lesson", "label": "A lesson"}], "edges": []}'
        )
        wave1_graph = self.submit(
            pid=pid,
            target_type="reflection",
            target_id=wave1_id,
            role="project_graph",
            path="project/logic_graph.json",
            body=graph_text,
        )

        # The per-wave graph renders the wave's pinned bytes.
        payload = self.request(
            "GET", f"/api/projects/{pid}/reflections/{wave1_id}/graph"
        )
        self.assertTrue(payload["available"])
        self.assertEqual(payload["reflection"]["id"], wave1_id)
        self.assertEqual(payload["graph"]["nodes"][0]["id"], "a")
        self.assertEqual(payload["problems"], [])

        # The wave detail exposes the pinned artifact id.
        detail = self.request("GET", f"/api/projects/{pid}/reflections/{wave1_id}")
        graph_row = next(r for r in detail["current_attempt_artifacts"] if r["role"] == "project_graph")
        self.assertEqual(graph_row["id"], wave1_graph["artifact_id"])

        # The artifact content endpoint serves the exact submitted bytes.
        pinned = self.request(
            "GET", f"/api/projects/{pid}/artifacts/{wave1_graph['artifact_id']}/content"
        )
        self.assertEqual(pinned["content"], graph_text)
        self.assertTrue(pinned["available"])
        self.assertFalse(pinned["is_binary"])
        self.assertEqual(pinned["content_type"], "application/json")

        # An unknown artifact id is rejected, not served.
        bad = self.client.get(f"/api/projects/{pid}/artifacts/art_bogus/content")
        self.assertEqual(bad.status_code, 404)

        # The literal current/graph route still resolves (not captured by the
        # {reflection_id}/graph param route).
        current = self.request("GET", f"/api/projects/{pid}/reflections/current/graph")
        self.assertTrue(current["available"])
        self.assertEqual(current["reflection"]["id"], wave1_id)

        # A second wave submits its own version of the living file; wave 1's
        # artifact keeps serving its original pinned bytes.
        with self.app.store.transaction() as conn:
            conn.execute(
                "UPDATE reflections SET status = 'published' WHERE id = ?", (wave1_id,)
            )
        wave2_id = self.app.call_tool(
            "reflection.create",
            {"project_id": pid, "title": "Wave 2", "lenses": roster},
        )["id"]
        new_text = graph_text.replace("Wave 1 logic", "Wave 2 logic")
        wave2_graph = self.submit(
            pid=pid,
            target_type="reflection",
            target_id=wave2_id,
            role="project_graph",
            path="project/logic_graph.json",
            body=new_text,
        )
        self.assertNotEqual(wave2_graph["artifact_id"], wave1_graph["artifact_id"])
        self.assertEqual(
            self.request(
                "GET",
                f"/api/projects/{pid}/artifacts/{wave2_graph['artifact_id']}/content",
            )["content"],
            new_text,
        )
        self.assertEqual(
            self.request(
                "GET",
                f"/api/projects/{pid}/artifacts/{wave1_graph['artifact_id']}/content",
            )["content"],
            graph_text,
        )


class ArtifactFigureRouteTest(unittest.TestCase):
    """GET /artifacts/{id}/figure?rel=... serves submitted figure bytes only."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
            infrastructure_client=FakeInfrastructureClient(),
        )
        self.client = TestClient(create_fastapi_app(self.app))
        project = self.client.post("/api/projects", json={"name": "Rel"}).json()
        self.project_id = project["id"]
        exp = self.client.post(
            f"/api/projects/{self.project_id}/experiments",
            json={"name": "plan-figure", "intent": "Verify submitted plan image."},
        ).json()
        self.plan = self.app.submit_artifact(
            project_id=self.project_id,
            target_type="experiment",
            target_id=exp["id"],
            role="plan",
            path="plans/plan.md",
            body=(
                "## Summary\nPlan with a diagram.\n\n"
                "![diagram](figures/diagram.png)\n\n"
                "## Objective & hypothesis\nTest plan image serving.\n\n"
                "## Evaluation\nSuccess means the backend serves submitted bytes.\n"
            ),
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_unsubmitted_figure_is_not_found(self) -> None:
        # The token was minted but the figure bytes were never pushed.
        response = self.client.get(
            f"/api/projects/{self.project_id}/artifacts/{self.plan['artifact_id']}/figure",
            params={"rel": "figures/diagram.png"},
        )
        self.assertEqual(response.status_code, 404, response.text)

    def test_serves_submitted_plan_figure_without_live_file(self) -> None:
        self.assertEqual(
            [fig["link_path"] for fig in self.plan["figures"]],
            ["figures/diagram.png"],
        )
        self.app.upload_artifact_bytes(
            token=upload_token(self.plan["figures"][0]["run"]),
            data=b"\x89PNG\r\n\x1a\nplan",
            kind="f",
        )
        response = self.client.get(
            f"/api/projects/{self.project_id}/artifacts/{self.plan['artifact_id']}/figure",
            params={"rel": "figures/diagram.png"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"\x89PNG\r\n\x1a\nplan")

    def test_unknown_rel_is_not_found(self) -> None:
        response = self.client.get(
            f"/api/projects/{self.project_id}/artifacts/{self.plan['artifact_id']}/figure",
            params={"rel": "figures/nope.png"},
        )
        self.assertEqual(response.status_code, 404)

    def test_figure_upload_command_resolves_relative_to_the_document(self) -> None:
        # The doc lives at plans/plan.md and links figures/diagram.png, so the
        # generated curl must read plans/figures/diagram.png (quoted), while
        # the stored link_path stays document-relative.
        figure = self.plan["figures"][0]
        self.assertEqual(figure["link_path"], "figures/diagram.png")
        self.assertIn("-T 'plans/figures/diagram.png'", figure["run"])

    def test_upload_routes_gate_on_the_token_before_reading_the_body(self) -> None:
        # Unknown tokens 404 even when an over-cap body is attached — the
        # handler never buffers a byte for an unauthenticated caller.
        for kind in ("u", "f"):
            response = self.client.put(
                f"/api/artifacts/{kind}/tok_unknown", content=b"x" * 20_000
            )
            self.assertEqual(response.status_code, 404, response.text)

    def test_over_cap_upload_is_413_and_keeps_the_token_alive(self) -> None:
        exp = self.client.post(
            f"/api/projects/{self.project_id}/experiments",
            json={"name": "cap-check", "intent": "Reject oversize uploads."},
        ).json()
        pending = self.app.call_tool(
            "artifact.upload",
            {
                "project_id": self.project_id,
                "path": "report.md",
                "attach_to": {
                    "target_type": "experiment", "target_id": exp["id"], "role": "report",
                },
            },
        )
        token = upload_token(pending["run"])
        response = self.client.put(f"/api/artifacts/u/{token}", content=b"x" * 17_000)
        self.assertEqual(response.status_code, 413, response.text)
        self.assertEqual(response.json()["error_code"], "payload_too_large")
        # The cap refusal never consumed the token: a slimmed retry works.
        retry = self.app.upload_artifact_bytes(token=token, data=b"## Summary\nS.\n")
        self.assertEqual(retry["artifact_id"], pending["artifact_id"])


class UploadTokenRedactionTest(unittest.TestCase):
    def test_activity_paths_redact_upload_tokens(self) -> None:
        from merv.brain.surface.transport.api.shared import redact_upload_tokens

        self.assertEqual(
            redact_upload_tokens("/api/artifacts/u/tok_SECRET"),
            "/api/artifacts/u/<redacted>",
        )
        self.assertEqual(
            redact_upload_tokens("/api/artifacts/f/tok_SECRET"),
            "/api/artifacts/f/<redacted>",
        )
        # The shared choke-point also covers feed-media upload tokens (INV-12).
        self.assertEqual(
            redact_upload_tokens("/api/feed/u/tok_SECRET"),
            "/api/feed/u/<redacted>",
        )
        # The storage completion token is scrubbed too (INV-12), keeping the
        # /complete suffix so the route stays legible in the access log.
        self.assertEqual(
            redact_upload_tokens("/api/storage/u/tok_SECRET/complete"),
            "/api/storage/u/<redacted>/complete",
        )
        # Non-token routes pass through untouched.
        self.assertEqual(
            redact_upload_tokens("/api/projects/p_1/artifacts/art_1/content"),
            "/api/projects/p_1/artifacts/art_1/content",
        )
        self.assertEqual(
            redact_upload_tokens("/api/projects/p_1/storage/sto_1"),
            "/api/projects/p_1/storage/sto_1",
        )


class DegradedStatesTest(unittest.TestCase):
    """Artifact content reads return documented degraded shapes, not 500s."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
            infrastructure_client=FakeInfrastructureClient(),
        )
        self.client = TestClient(
            create_fastapi_app(self.app), raise_server_exceptions=False
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_pending_artifact_content_is_unavailable_not_500(self) -> None:
        project = self.client.post(
            "/api/projects", json={"name": "Proj P", "summary": "s"}
        ).json()
        pid = project["id"]
        exp = self.client.post(
            f"/api/projects/{pid}/experiments",
            json={"name": "deg-exp", "intent": "Degraded read."},
        ).json()
        # Submitted but never uploaded: the row is pending, no bytes exist.
        pending = self.app.call_tool(
            "artifact.upload",
            {
                "project_id": pid,
                "path": "results.json",
                "attach_to": {
                    "target_type": "experiment", "target_id": exp["id"], "role": "result",
                },
            },
        )
        body = self.client.get(
            f"/api/projects/{pid}/artifacts/{pending['artifact_id']}/content"
        ).json()
        self.assertFalse(body["available"])
        self.assertIsNone(body["content"])
        self.assertFalse(body["is_binary"])
        # The raw-file route reports not-found instead of erroring.
        raw = self.client.get(
            f"/api/projects/{pid}/artifacts/{pending['artifact_id']}/file"
        )
        self.assertEqual(raw.status_code, 404)
