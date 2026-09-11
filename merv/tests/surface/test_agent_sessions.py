from __future__ import annotations

import secrets
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from tests.support.brain import TestBrain
from tests.support.infrastructure import FakeInfrastructureClient, project_namespace, seed_sandbox
from merv.brain.infrastructure.ports import _subject
from merv.brain.surface.auth import SupabaseVerifier
from merv.brain.surface.project_keys import ProjectKeys
from merv.brain.surface.transport.api import create_fastapi_app
from merv.brain.surface.transport.http_policy import HttpSurfacePolicy
from tests.research_core.scenarios import (
    LENSES,
    REVIEW_SYNOPSIS,
    VALID_CHANGE_SPEC,
    VALID_PROJECT_GRAPH,
    VALID_REFLECTION,
)


VALID_PLAN = (
    "## Summary\nA focused agent-session experiment.\n\n"
    "## Objective & hypothesis\nThe isolated worker can complete the task.\n\n"
    "## Evaluation\nThe workflow and independent review both succeed.\n"
)


class AgentSessionSurfaceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.brain = TestBrain(
            repo_root=root,
            db_path=root / "state.sqlite",
            infrastructure_client=FakeInfrastructureClient(),
        )
        self.client = TestClient(self.brain.fastapi_app, raise_server_exceptions=False)
        self.project_id = self.brain.call_tool(
            "project", {"action": "create", "name": "Agent sessions"}
        )["id"]
        # Dispatch is opt-in per project; these tests exercise the enabled path.
        self.brain.call_tool(
            "project.update",
            {"project_id": self.project_id, "agent_dispatch": True},
        )
        self.experiment_id = self.brain.call_tool(
            "experiment.create",
            {
                "project_id": self.project_id,
                "name": "parallel-agent",
                "intent": "Exercise the hosted coding-agent workflow.",
            },
        )["id"]

    def tearDown(self) -> None:
        self.brain.shutdown()
        self.temp.cleanup()

    @staticmethod
    def secret() -> str:
        return "mas_" + secrets.token_urlsafe(32)

    def claim(self, *, secret: str, runner_id: str) -> dict:
        response = self.client.post(
            "/api/agent-sessions/lease",
            json={
                "project_id": self.project_id,
                "platform": "codex",
                "runner_id": runner_id,
                "idempotency_key": f"retry-{runner_id}",
                "session_secret": secret,
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["session"]

    def mcp(self, *, secret: str, name: str, arguments: dict):
        return self.client.post(
            "/mcp/call",
            headers={"Authorization": f"Bearer {secret}"},
            json={"name": name, "arguments": arguments},
        )

    def pass_review(self, *, target_type: str, target_id: str, role: str) -> dict:
        request = self.brain.application.request_review(
            project_id=self.project_id,
            target_type=target_type,
            target_id=target_id,
            role=role,
            producer_session_id="test-producer",
        )
        started = self.brain.call_tool(
            "review.start",
            {
                "review_request_id": request["review_request_id"],
                "reviewer_capability": request["reviewer_capability"],
                "caller_session_id": "test-reviewer",
            },
        )
        return self.brain.call_tool(
            "review.submit",
            {
                "review_session_id": started["review_session_id"],
                "verdict": "pass",
                "synopsis": REVIEW_SYNOPSIS,
            },
        )

    def assert_intent_is_read_only(self, secret: str, summary: str = "") -> None:
        headers = {"Authorization": f"Bearer {secret}", "Accept": "application/json, text/event-stream"}
        legacy = self.client.get("/mcp/tools", headers=headers).json()["tools"]
        streamed = self.client.post("/mcp", headers=headers, json={
            "jsonrpc": "2.0", "id": 1, "method": "tools/list"}).json()["result"]["tools"]
        self.assertEqual({item["name"] for item in legacy}, {item["name"] for item in streamed})
        for catalog in (legacy, streamed):
            names = {item["name"] for item in catalog}
            self.assertIn("project", names)
            self.assertNotIn("project.context.update", names)
            self.assertNotIn("project.update", names)
        args = {"project_id": self.project_id, "summary": "Invented intent", "expected_summary": ""}
        denied = self.mcp(secret=secret, name="project.context.update", arguments=args)
        self.assertEqual(denied.json()["error_code"], "agent_session_scope_forbidden", denied.text)
        denied = self.client.post("/mcp", headers=headers, json={
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {"name": "project.context.update", "arguments": args}})
        self.assertIn("agent_session_scope_forbidden", denied.text)
        denied = self.mcp(secret=secret, name="project.update", arguments=args)
        self.assertNotEqual(denied.status_code, 200)
        for method in ("patch", "put"):
            denied = getattr(self.client, method)(f"/api/projects/{self.project_id}", headers=headers,
                                                  json={"summary": "Invented intent"})
            self.assertEqual(denied.status_code, 403, denied.text)
        read = self.mcp(secret=secret, name="project",
                        arguments={"action": "overview", "project_id": self.project_id})
        self.assertEqual(read.status_code, 200, read.text)
        self.assertEqual(read.json()["result"]["project"]["summary"], summary)
        # A session lookup must not contaminate the following interactive catalog.
        interactive = self.client.get("/mcp/tools").json()["tools"]
        self.assertIn("project.context.update", {item["name"] for item in interactive})

    def test_deployed_producer_cannot_discover_or_edit_user_intent(self) -> None:
        summary = "User background and goal. " * 90 + "\nScope: preserve the final constraint."
        self.brain.call_tool("project.context.update",
            {"project_id": self.project_id, "summary": summary, "expected_summary": ""})
        secret = self.secret()
        session = self.claim(secret=secret, runner_id="intent-reader")
        self.assertIn(summary, session["assignment"]["brief"])
        self.assertIn(summary, session["instruction"])
        self.assert_intent_is_read_only(secret, summary)

    def test_deployed_project_author_can_publish_only_its_narrative(self) -> None:
        self.claim(secret=self.secret(), runner_id="experiment-owner")
        secret = self.secret()
        author = self.claim(secret=secret, runner_id="project-author")
        self.assertEqual(author["assignment"]["role"], "project_author")
        self.assert_intent_is_read_only(secret)
        arguments = {"project_id": self.project_id, "instance_id": author["workflow_instance_id"]}
        read = self.mcp(secret=secret, name="project.synthesis.read", arguments=arguments)
        self.assertEqual(read.status_code, 200, read.text)
        source = read.json()["result"]["source"]
        headers = {"Authorization": f"Bearer {secret}"}
        names = {tool["name"] for tool in self.client.get("/mcp/tools", headers=headers).json()["tools"]}
        self.assertIn("project.synthesis.read", names)
        self.assertNotIn("litreview.edit", names)
        # The shared writable baseline must not let a document author attach
        # replacement evidence to somebody else's research record.
        denied = self.mcp(secret=secret, name="artifact.attach", arguments={
            "project_id": self.project_id, "artifact_id": "unrelated-evidence",
            "target_type": "experiment", "target_id": self.experiment_id, "role": "report"})
        self.assertEqual(denied.status_code, 400, denied.text)
        self.assertEqual(denied.json()["error_code"], "agent_session_scope_forbidden")
        publication = {"methods": "The registered test is underway; inspect its live status.",
                       "results": "No established results yet.", "references": source["references"][:1],
                       "editorial_note": "Kept one causal account without adding a report inventory."}
        for extra in ({"summary": "Rewritten intent"}, {"covered_event": 999999}):
            rejected = self.mcp(secret=secret, name="workflow.transition", arguments={**arguments,
                "expected_revision": author["workflow_revision"], "action": "publish",
                "request_id": "bad-publication", "payload": {**publication, **extra}})
            self.assertNotEqual(rejected.status_code, 200, rejected.text)
        foreign = self.brain.call_tool("project", {"action": "create", "name": "Foreign narrative"})["id"]
        denied = self.mcp(secret=secret, name="project.synthesis.read",
                          arguments={**arguments, "project_id": foreign})
        self.assertNotEqual(denied.status_code, 200)
        published = self.mcp(secret=secret, name="workflow.transition", arguments={**arguments,
            "expected_revision": author["workflow_revision"], "action": "publish",
            "request_id": "published", "payload": publication})
        self.assertEqual(published.status_code, 200, published.text)
        self.assertIsNone(self.brain.agent_sessions.authenticate(session_secret=secret))
        document = self.brain.call_tool("project", {"action": "overview", "project_id": self.project_id})["project"]
        self.assertEqual(document["methods"], publication["methods"])
        self.assertEqual(document["maintenance"]["covered_event"], source["through_event"])

    def reflection_ready_for_review(self) -> str:
        self.brain.call_tool(
            "experiment.transition",
            {
                "project_id": self.project_id,
                "experiment_id": self.experiment_id,
                "transition": "abandon",
            },
        )
        reflection = self.brain.call_tool(
            "reflection.create",
            {
                "project_id": self.project_id,
                "lenses": [dict(lens) for lens in LENSES],
            },
        )
        reflection_id = str(reflection["id"])
        for lens in LENSES:
            lens_id = str(lens["id"])
            self.brain.submit_artifact(
                project_id=self.project_id,
                target_type="reflection",
                target_id=reflection_id,
                role="reflection_lens_doc",
                path=f"reflections/{lens_id}.md",
                lens_id=lens_id,
                body=(
                    f"# {lens_id}\n\n## Summary\n"
                    "This lens identified one concrete project signal."
                ),
            )
        self.brain.call_tool(
            "reflection.transition",
            {
                "project_id": self.project_id,
                "reflection_id": reflection_id,
                "transition": "submit_reflections",
            },
        )
        for role, path, body in (
            ("project_graph", "project/logic_graph.json", VALID_PROJECT_GRAPH),
            ("reflection_doc", "project/reflection.md", VALID_REFLECTION),
            ("change_spec", "project/change_spec.json", VALID_CHANGE_SPEC),
        ):
            self.brain.submit_artifact(
                project_id=self.project_id,
                target_type="reflection",
                target_id=reflection_id,
                role=role,
                path=path,
                body=body,
            )
        self.brain.call_tool(
            "reflection.transition",
            {
                "project_id": self.project_id,
                "reflection_id": reflection_id,
                "transition": "submit_reflection_artifacts",
            },
        )
        return reflection_id

    def reflection_ready_for_consolidation(self) -> str:
        reflection_id = self.reflection_ready_for_review()
        self.pass_review(
            target_type="reflection",
            target_id=reflection_id,
            role="reflection_reviewer",
        )
        state = self.brain.call_tool(
            "reflection.get", {"project_id": self.project_id, "reflection_id": reflection_id}
        )
        self.assertEqual(state["status"], "consolidating")
        return reflection_id

    def test_session_reads_its_native_job_and_cannot_cancel_another_experiments_job(self) -> None:
        secret = self.secret()
        self.claim(secret=secret, runner_id="native-jobs")
        other = self.brain.call_tool("experiment.create", {
            "project_id": self.project_id, "name": "foreign-native-job", "intent": "other work",
        })["id"]
        fake = self.brain.infrastructure_client
        for uid, eid, jid in (("sbx_own", self.experiment_id, "job_own"), ("sbx_foreign", other, "job_foreign")):
            seed_sandbox(self.brain.sandboxes, project_id=self.project_id,
                         experiment_id=eid, sandbox_uid=uid, status="running")
            fake.seed_jobs(project_namespace(self.project_id), uid, {"label": jid, "exit_code": 0})
        own = self.mcp(secret=secret, name="sandbox.job", arguments={"project_id": self.project_id, "job_id": "job_own"})
        self.assertEqual(own.status_code, 200, own.text)
        self.assertEqual(own.json()["result"]["id"], "job_own")
        output = self.mcp(secret=secret, name="sandbox.job", arguments={
            "project_id": self.project_id, "job_id": "job_own", "stream": "stdout", "limit": 32,
        })
        self.assertEqual(output.status_code, 200, output.text)
        self.assertEqual(output.json()["result"]["output"]["stream"], "stdout")
        oversized = self.mcp(secret=secret, name="sandbox.job", arguments={
            "project_id": self.project_id, "job_id": "job_own", "stream": "stdout", "limit": 1048577,
        })
        self.assertEqual(oversized.status_code, 400, oversized.text)
        cancelled = self.mcp(secret=secret, name="sandbox.job", arguments={
            "project_id": self.project_id, "job_id": "job_own", "cancel": True,
        })
        self.assertEqual(cancelled.status_code, 200, cancelled.text)
        self.assertEqual(cancelled.json()["result"]["state"], "cancelled")
        fake.calls.clear()
        foreign = self.mcp(secret=secret, name="sandbox.job", arguments={
            "project_id": self.project_id, "job_id": "job_foreign", "cancel": True, "stream": "stdout",
        })
        self.assertEqual(foreign.status_code, 404, foreign.text)
        self.assertFalse(any(path.endswith("/cancel") or path.endswith("/output") for _, path, *_ in fake.calls))

    def test_generic_artifact_attachment_is_confined_to_the_assigned_work(self) -> None:
        session_secret = self.secret()
        self.claim(secret=session_secret, runner_id="artifact-worker")
        other_id = self.brain.call_tool("experiment.create", {
            "project_id": self.project_id, "name": "other-artifact-target",
            "intent": "Must remain outside the assigned worker's authority.",
        })["id"]
        stored = self.mcp(secret=session_secret, name="artifact.upload", arguments={
            "project_id": self.project_id, "path": "plan.md",
        })
        self.assertEqual(stored.status_code, 200, stored.text)
        pending = stored.json()["result"]
        token = pending["run"].rsplit("/", 1)[-1].rstrip("'")
        uploaded = self.client.put(f"/api/artifacts/u/{token}", content=VALID_PLAN.encode())
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        arguments = {
            "project_id": self.project_id, "artifact_id": pending["artifact_id"],
            "target_type": "experiment", "target_id": self.experiment_id, "role": "plan",
        }
        foreign = self.mcp(secret=session_secret, name="artifact.attach", arguments={
            **arguments, "target_id": other_id,
        })
        self.assertEqual(foreign.status_code, 400, foreign.text)
        self.assertEqual(foreign.json()["error_code"], "agent_session_scope_forbidden")
        self.assertEqual(self.brain.artifacts.scan(target_ids=(other_id,)), ())
        own = self.mcp(secret=session_secret, name="artifact.attach", arguments=arguments)
        self.assertEqual(own.status_code, 200, own.text)
        self.assertEqual(own.json()["result"]["association"]["target_id"], self.experiment_id)

    def test_nested_upload_target_is_confined_before_creating_an_intent(self) -> None:
        secret = self.secret()
        session = self.claim(secret=secret, runner_id="nested-upload")
        self.assertEqual(session["workflow_instance_id"], self.experiment_id)
        other = self.brain.call_tool("experiment.create", {
            "project_id": self.project_id, "name": "foreign-upload-target",
            "intent": "Must not receive the assigned worker's evidence.",
        })["id"]
        target = {"target_type": "experiment", "target_id": self.experiment_id, "role": "plan"}
        with patch.object(self.brain.artifacts.contents, "submit") as submit:
            for foreign in ({**target, "target_id": other}, {**target, "target_type": "reflection"}):
                with self.subTest(target=foreign):
                    denied = self.mcp(secret=secret, name="artifact.upload", arguments={
                        "project_id": self.project_id, "path": "plan.md", "attach_to": foreign,
                    })
                    self.assertEqual(denied.status_code, 400, denied.text)
                    self.assertEqual(denied.json()["error_code"], "agent_session_scope_forbidden")
            submit.assert_not_called()
        own = self.mcp(secret=secret, name="artifact.upload", arguments={
            "project_id": self.project_id, "path": "plan.md", "attach_to": target,
        })
        self.assertEqual(own.status_code, 200, own.text)
        pending = own.json()["result"]
        token = pending["run"].rsplit("/", 1)[-1].rstrip("'")
        uploaded = self.client.put(f"/api/artifacts/u/{token}", content=VALID_PLAN.encode())
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        self.assertEqual(
            [artifact.id for artifact in self.brain.artifacts.scan(target_ids=(self.experiment_id,))],
            [pending["artifact_id"]],
        )
        self.assertEqual(self.brain.artifacts.scan(target_ids=(other,)), ())

    def test_session_is_mcp_only_and_default_denies_other_experiments(self) -> None:
        session_secret = self.secret()
        session = self.claim(secret=session_secret, runner_id="owner")
        other_id = self.brain.call_tool(
            "experiment.create",
            {
                "project_id": self.project_id,
                "name": "other-agent",
                "intent": "Must remain outside this session.",
            },
        )["id"]

        direct = self.client.get(
            f"/api/projects/{self.project_id}",
            headers={"Authorization": f"Bearer {session_secret}"},
        )
        foreign = self.mcp(
            secret=session_secret,
            name="experiment.transition",
            arguments={
                "project_id": self.project_id,
                "experiment_id": other_id,
                "transition": "submit_design",
            },
        )
        forbidden_tool = self.mcp(
            secret=session_secret,
            name="reflection.create",
            arguments={"project_id": self.project_id},
        )

        self.assertEqual(session["kind"], "workflow")
        self.assertEqual(session["workflow_instance_id"], self.experiment_id)
        self.assertEqual(session["workflow_node"], "planned")
        self.assertEqual(session["workflow_revision"], 0)
        self.assertEqual(session["assignment"]["title"], "Design experiment")
        self.assertEqual(session["assignment"]["role"], "experiment_owner")
        self.assertIn("parallel-agent", session["assignment"]["brief"])
        self.assertIn("Complete only this node", session["instruction"])
        self.assertIn("hand off and exit", session["instruction"])
        self.assertEqual(direct.status_code, 403, direct.text)
        self.assertEqual(foreign.status_code, 400, foreign.text)
        self.assertEqual(foreign.json()["error_code"], "agent_session_scope_forbidden")
        self.assertEqual(forbidden_tool.status_code, 400, forbidden_tool.text)
        self.assertEqual(
            forbidden_tool.json()["error_code"],
            "agent_session_scope_forbidden",
        )

    def test_runner_mirrors_a_trace_excerpt_the_browser_can_read(self) -> None:
        secret = self.secret()
        session = self.claim(secret=secret, runner_id="owner")
        recorded = self.client.post(
            f"/api/agent-sessions/{session['id']}/trace",
            json={
                "runner_id": "owner",
                "events": [{"type": "message", "text": "working", "token": "abc"}],
                "stderr_tail": "note\n",
                "complete": False,
            },
        )
        self.assertEqual(recorded.status_code, 200, recorded.text)
        listed = self.client.get(
            f"/api/projects/{self.project_id}/agent-sessions/{session['id']}/trace"
        )
        self.assertEqual(listed.status_code, 200, listed.text)
        trace = listed.json()["trace"]
        self.assertEqual(trace["events"][0]["text"], "working")
        self.assertEqual(trace["events"][0]["token"], "<redacted>")
        self.assertEqual(trace["stderr_tail"], "note\n")
        # The listing itself never carries the excerpt.
        sessions = self.client.get(f"/api/projects/{self.project_id}/agent-sessions").json()
        self.assertNotIn("trace", sessions["sessions"][0])
        self.assertNotIn("events", sessions["sessions"][0])
        missing = self.client.get(
            f"/api/projects/{self.project_id}/agent-sessions/ags_missing/trace"
        )
        self.assertEqual(missing.status_code, 200, missing.text)
        self.assertIsNone(missing.json()["trace"])

    def test_the_listing_names_each_job_worktree_when_the_runner_reported_one(self) -> None:
        secret = self.secret()
        session = self.claim(secret=secret, runner_id="owner")
        branch = f"merv/experiments/{self.project_id}/{self.experiment_id}"
        attached = self.client.post(
            f"/api/agent-sessions/{session['id']}/attach",
            json={
                "runner_id": "owner",
                "host_session_ref": "pid:1:abc",
                "workspace_ref": branch,
                "base_sha": "1" * 40,
                "head_sha": "2" * 40,
                "workspace_stats": {"commit_count": 3, "files_changed": 5, "insertions": 40, "deletions": 7},
                "agent_setup": {
                    "platform": "codex",
                    "machine": "lucia.local",
                    "workspace_path": "/Users/me/w/experiments/p/e",
                },
            },
        )
        self.assertEqual(attached.status_code, 200, attached.text)
        listing = self.client.get(f"/api/projects/{self.project_id}/agent-sessions").json()
        row = next(item for item in listing["sessions"] if item["id"] == session["id"])
        # The branch is the worktree's identity; the path is a courtesy the
        # runner may or may not include — the page treats both as optional.
        self.assertEqual(row["workspace_ref"], branch)
        self.assertEqual(row["agent_setup"]["workspace_path"], "/Users/me/w/experiments/p/e")
        workspace = listing["workspaces"][self.experiment_id]
        self.assertEqual(workspace["branch"], branch)
        self.assertEqual(workspace["head_sha"], "2" * 40)
        self.assertEqual((workspace["commit_count"], workspace["files_changed"]), (3, 5))
        self.assertNotIn("project_id", workspace)

    def test_idle_runner_presence_is_visible_without_exposing_runner_identity(self) -> None:
        reported = self.client.post(
            f"/api/projects/{self.project_id}/agent-runners/heartbeat",
            json={
                "runner_id": "machine-secret-id",
                "machine": {
                    "hostname": "research-mac",
                    "system": "Darwin",
                    "architecture": "arm64",
                },
                "platforms": [
                    {
                        "name": "Codex",
                        "harness": "codex",
                        "model": "gpt-5.6-sol",
                        "parallelism": 2,
                    }
                ],
                "capacity": 2,
            },
        )
        listed = self.client.get(
            f"/api/projects/{self.project_id}/agent-sessions"
        )

        self.assertEqual(reported.status_code, 200, reported.text)
        self.assertEqual(listed.status_code, 200, listed.text)
        runner = listed.json()["runner"]
        self.assertTrue(runner["live"])
        self.assertEqual(runner["machine"]["hostname"], "research-mac")
        self.assertNotIn("runner_id", runner)
        self.assertEqual(listed.json()["runners"], [runner])
        self.assertEqual(len(runner["runner_ref"]), 24)
        # The heartbeat answers with the caller's own row and its desired tuning.
        body = reported.json()
        self.assertEqual(body["presence"]["runner_ref"], runner["runner_ref"])
        self.assertEqual(body["desired_version"], 0)
        self.assertEqual(body["desired_settings"], {})

    def test_merv_dispatches_a_separate_reviewer_session(self) -> None:
        owner_secret = self.secret()
        owner = self.claim(secret=owner_secret, runner_id="owner")
        self.brain.submit_artifact(
            project_id=self.project_id,
            target_type="experiment",
            target_id=self.experiment_id,
            role="plan",
            path="plan.md",
            body=VALID_PLAN,
        )
        self.brain.call_tool(
            "experiment.transition",
            {
                "project_id": self.project_id,
                "experiment_id": self.experiment_id,
                "transition": "submit_design",
            },
        )
        request = self.brain.application.request_review(
            project_id=self.project_id,
            target_type="experiment",
            target_id=self.experiment_id,
            role="design_reviewer",
            producer_session_id=owner["id"],
        )

        reviewer_secret = self.secret()
        reviewer = self.claim(secret=reviewer_secret, runner_id="reviewer")
        self.assert_intent_is_read_only(reviewer_secret)
        content = self.brain.artifacts.contents.create(
            project_id=self.project_id, path="review-input.bin", data=b"\x00review input"
        )
        read = self.mcp(secret=reviewer_secret, name="artifact.read", arguments={
            "project_id": self.project_id, "artifact_id": content.id, "include_content": True,
        })
        self.assertEqual(read.status_code, 200, read.text)
        self.assertTrue(read.json()["result"]["content"]["is_binary"])
        with patch.object(self.brain._blobs, "get") as get:
            raw = self.client.get(read.json()["result"]["download_url"], headers={
                "Authorization": f"Bearer {reviewer_secret}",
            })
            self.assertEqual(raw.status_code, 403, raw.text)
            get.assert_not_called()
        target = {"target_type": "experiment", "target_id": self.experiment_id, "role": "plan"}
        for name, arguments in (
            ("artifact.upload", {"path": "new.bin"}),
            ("artifact.upload", {"path": "plan.md", "attach_to": target}),
            ("artifact.attach", {"artifact_id": content.id, **target}),
        ):
            with self.subTest(tool=name, arguments=arguments):
                denied = self.mcp(secret=reviewer_secret, name=name, arguments={
                    "project_id": self.project_id, **arguments,
                })
                self.assertEqual(denied.status_code, 400, denied.text)
                self.assertEqual(denied.json()["error_code"], "agent_session_scope_forbidden")
        started = self.mcp(
            secret=reviewer_secret,
            name="review.start",
            arguments={
                "review_request_id": request["review_request_id"],
                "reviewer_capability": "assigned",
                "caller_session_id": "assigned",
                "declared_agent": "claude",
            },
        )
        self.assertEqual(started.status_code, 200, started.text)
        review_session_id = started.json()["result"]["review_session_id"]
        submitted = self.mcp(
            secret=reviewer_secret,
            name="review.submit",
            arguments={
                "review_session_id": review_session_id,
                "verdict": "pass",
                "synopsis": (
                    "The plan is focused, falsifiable, and has a clear "
                    "evaluation criterion."
                ),
                "notes": "Independent review passed.",
                "findings": [],
                "evidence": {},
                "return_to": "",
            },
        )

        self.assertEqual(reviewer["kind"], "review")
        self.assertEqual(reviewer["review_request_id"], request["review_request_id"])
        self.assertEqual(submitted.status_code, 200, submitted.text)
        self.assertEqual(submitted.json()["result"]["verdict"], "pass")
        closed = {
            item["id"]: item
            for item in self.brain.agent_sessions.list(project_id=self.project_id)[
                "sessions"
            ]
        }
        self.assertEqual(closed[reviewer["id"]]["status"], "expired")
        self.assertEqual(closed[reviewer["id"]]["close_reason"], "workflow_assignment_changed")
        self.assertEqual(closed[owner["id"]]["status"], "expired")

    def test_merv_dispatches_the_reflection_reviewer_before_consolidation(
        self,
    ) -> None:
        reflection_id = self.reflection_ready_for_review()
        request = self.brain.application.request_review(
            project_id=self.project_id,
            target_type="reflection",
            target_id=reflection_id,
            role="reflection_reviewer",
            producer_session_id="reflection-author",
        )

        reviewer_secret = self.secret()
        reviewer = self.claim(
            secret=reviewer_secret,
            runner_id="reflection-reviewer",
        )
        authenticated = self.mcp(
            secret=reviewer_secret,
            name="review.start",
            arguments={
                "review_request_id": request["review_request_id"],
                "reviewer_capability": "assigned",
                "caller_session_id": "assigned",
            },
        )

        self.assertEqual(reviewer["kind"], "review")
        self.assertEqual(reviewer["target_type"], "reflection")
        self.assertEqual(reviewer["target_id"], reflection_id)
        self.assertEqual(reviewer["review_request_id"], request["review_request_id"])
        self.assertEqual([item["kind"] for item in reviewer["references"] if item["kind"] == "code"], [])
        self.assertTrue(reviewer["execution"]["read_only"])
        self.assertEqual(reviewer["execution"]["workspace"]["mode"], "ephemeral")
        self.assertIn("project-reflection-review", reviewer["instruction"])
        self.assertEqual(authenticated.status_code, 200, authenticated.text)

    def test_expired_review_request_is_renewed_for_an_independent_reviewer(self) -> None:
        owner = self.claim(secret=self.secret(), runner_id="owner")
        self.brain.submit_artifact(
            project_id=self.project_id,
            target_type="experiment",
            target_id=self.experiment_id,
            role="plan",
            path="plan.md",
            body=VALID_PLAN,
        )
        self.brain.call_tool(
            "experiment.transition",
            {
                "project_id": self.project_id,
                "experiment_id": self.experiment_id,
                "transition": "submit_design",
            },
        )
        request = self.brain.application.request_review(
            project_id=self.project_id,
            target_type="experiment",
            target_id=self.experiment_id,
            role="design_reviewer",
            producer_session_id=owner["id"],
        )
        released = self.client.post(
            f"/api/agent-sessions/{owner['id']}/release",
            json={"runner_id": "owner", "reason": "test_restart"},
        )
        self.assertEqual(released.status_code, 200, released.text)
        with self.brain.store.transaction() as tx:
            tx.execute(
                """
                UPDATE review_requests
                SET expires_at = '2000-01-01T00:00:00Z'
                WHERE id = ?
                """,
                (request["review_request_id"],),
            )

        self.brain.application.workflow_deliveries.run_once(project_id=self.project_id, renew_interval_seconds=0)
        replacement = self.claim(secret=self.secret(), runner_id="replacement")

        self.assertEqual(replacement["kind"], "review")
        self.assertEqual(replacement["experiment_id"], self.experiment_id)
        self.assertNotEqual(replacement["review_request_id"], request["review_request_id"])
        self.assertEqual(replacement["workflow_node"], "design_review")
        self.assertEqual(replacement["workflow_revision"], 1)

    def test_revoking_the_parent_project_key_revokes_the_session(self) -> None:
        user_id = "runner-owner"
        self.brain.research.add_project_member(
            project_id=self.project_id, user_id=user_id
        )
        keys = ProjectKeys(store=self.brain.store)
        minted = keys.create(
            project_id=self.project_id,
            owner_user_id=user_id,
        )
        verifier = SupabaseVerifier(
            supabase_url="https://example.supabase.co",
            jwt_secret="unused-in-this-test",
            project_keys=keys,
        )
        hosted = TestClient(
            create_fastapi_app(
                self.brain.server.app,
                surface_policy=HttpSurfacePolicy(
                    restrict_cors=True, hosted_control=True
                ),
                auth=verifier,
            ),
            raise_server_exceptions=False,
        )
        key = str(minted["secret"])
        session_secret = self.secret()
        claimed = hosted.post(
            "/api/agent-sessions/lease",
            headers={"Authorization": f"Bearer {key}"},
            json={
                "project_id": self.project_id,
                "platform": "codex",
                "runner_id": "hosted-runner",
                "idempotency_key": "hosted-retry",
                "session_secret": session_secret,
            },
        )
        self.assertEqual(claimed.status_code, 200, claimed.text)
        first = hosted.post(
            "/mcp/call",
            headers={"Authorization": f"Bearer {session_secret}"},
            json={
                "name": "workflow.status_and_next",
                "arguments": {
                    "project_id": self.project_id,
                    "experiment_id": self.experiment_id,
                },
            },
        )
        self.assertEqual(first.status_code, 200, first.text)

        # Later infrastructure requests recover the payer from persisted session
        # authority, after the claim's HTTP context has ended. A fresh gateway
        # and key lookup must produce the same subject without any quota copy.
        hosted.close()
        hosted = TestClient(
            create_fastapi_app(
                self.brain.server.app,
                surface_policy=HttpSurfacePolicy(
                    restrict_cors=True, hosted_control=True
                ),
                auth=SupabaseVerifier(
                    supabase_url="https://example.supabase.co",
                    jwt_secret="unused-in-this-test",
                    project_keys=ProjectKeys(store=self.brain.store),
                ),
            ),
            raise_server_exceptions=False,
        )
        fake = self.brain.infrastructure_client
        seed_sandbox(
            self.brain.sandboxes, project_id=self.project_id,
            experiment_id=self.experiment_id, sandbox_uid="sbx_delayed", status="running",
        )
        fake.seed_jobs(project_namespace(self.project_id), "sbx_delayed", {"label": "job_delayed"})
        original_request = fake.request
        subjects = []

        def observed_request(*args, **kwargs):
            subjects.append(_subject.get())
            return original_request(*args, **kwargs)

        job_call = {
            "name": "sandbox.job",
            "arguments": {"project_id": self.project_id, "job_id": "job_delayed"},
        }
        with patch.object(fake, "request", side_effect=observed_request):
            delayed = hosted.post(
                "/mcp/call", headers={"Authorization": f"Bearer {session_secret}"},
                json=job_call,
            )
        self.assertEqual(delayed.status_code, 200, delayed.text)
        self.assertTrue(subjects)
        self.assertEqual(set(subjects), {user_id})
        self.assertIsNone(_subject.get())

        keys.revoke(
            project_id=self.project_id,
            key_id=str(minted["key"]["id"]),
            owner_user_id=user_id,
        )
        with patch.object(fake, "request") as native_request:
            denied = hosted.post(
                "/mcp/call", headers={"Authorization": f"Bearer {session_secret}"},
                json=job_call,
            )
            self.assertEqual(denied.status_code, 401, denied.text)
            native_request.assert_not_called()
        revoked = hosted.post(
            "/mcp/call",
            headers={"Authorization": f"Bearer {session_secret}"},
            json={
                "name": "workflow.status_and_next",
                "arguments": {
                    "project_id": self.project_id,
                    "experiment_id": self.experiment_id,
                },
            },
        )
        hosted.close()

        self.assertEqual(revoked.status_code, 401, revoked.text)
        session = self.brain.agent_sessions.list(project_id=self.project_id)[
            "sessions"
        ][0]
        self.assertEqual(session["close_reason"], "source_authority_revoked")

    def test_runner_control_rechecks_parent_project_membership(self) -> None:
        user_id = "runner-owner"
        self.brain.research.add_project_member(
            project_id=self.project_id, user_id=user_id
        )
        self.brain.research.add_project_member(
            project_id=self.project_id, user_id="remaining-owner"
        )
        keys = ProjectKeys(store=self.brain.store)
        minted = keys.create(
            project_id=self.project_id,
            owner_user_id=user_id,
        )
        hosted = TestClient(
            create_fastapi_app(
                self.brain.server.app,
                surface_policy=HttpSurfacePolicy(
                    restrict_cors=True, hosted_control=True
                ),
                auth=SupabaseVerifier(
                    supabase_url="https://example.supabase.co",
                    jwt_secret="unused-in-this-test",
                    project_keys=keys,
                ),
            ),
            raise_server_exceptions=False,
        )
        key = str(minted["secret"])
        claimed = hosted.post(
            "/api/agent-sessions/lease",
            headers={"Authorization": f"Bearer {key}"},
            json={
                "project_id": self.project_id,
                "platform": "codex",
                "runner_id": "hosted-runner",
                "idempotency_key": "membership-retry",
                "session_secret": self.secret(),
            },
        )
        self.assertEqual(claimed.status_code, 200, claimed.text)
        session_id = claimed.json()["session"]["id"]
        self.brain.research.remove_project_member(
            project_id=self.project_id, user_id=user_id
        )

        denied = hosted.post(
            f"/api/agent-sessions/{session_id}/attach",
            headers={"Authorization": f"Bearer {key}"},
            json={
                "runner_id": "hosted-runner",
                "host_session_ref": "pid:101:revoked",
            },
        )
        hosted.close()

        self.assertEqual(denied.status_code, 404, denied.text)
        session = self.brain.agent_sessions.list(project_id=self.project_id)[
            "sessions"
        ][0]
        self.assertEqual(session["status"], "expired")
        self.assertEqual(session["close_reason"], "source_authority_revoked")

    def test_consolidator_reviewer_and_runner_publish_one_reviewed_proposal(
        self,
    ) -> None:
        reflection_id = self.reflection_ready_for_consolidation()
        self.claim(secret=self.secret(), runner_id="project-author")
        consolidator_secret = self.secret()
        consolidator = self.claim(
            secret=consolidator_secret,
            runner_id="consolidator",
        )
        attached = self.client.post(
            f"/api/agent-sessions/{consolidator['id']}/attach",
            json={
                "runner_id": "consolidator",
                "host_session_ref": "pid:101:consolidator",
                "workspace_ref": (
                    f"merv/consolidations/{self.project_id}/{reflection_id}"
                ),
                "base_sha": "1" * 40,
                "head_sha": "1" * 40,
            },
        )
        self.assertEqual(attached.status_code, 200, attached.text)
        packet = self.mcp(
            secret=consolidator_secret,
            name="consolidation.get",
            arguments={
                "project_id": self.project_id,
                "reflection_id": reflection_id,
            },
        )
        self.assertEqual(packet.status_code, 200, packet.text)
        self.assertEqual(packet.json()["result"]["base_sha"], "1" * 40)
        reflection_summary = packet.json()["result"]["reflection"]
        self.assertTrue(reflection_summary["created_at"])
        self.assertEqual(
            [review["role"] for review in reflection_summary["reviews"]],
            ["reflection_reviewer"],
        )

        submitted = self.mcp(
            secret=consolidator_secret,
            name="consolidation.submit",
            arguments={
                "project_id": self.project_id,
                "reflection_id": reflection_id,
                "base_sha": "1" * 40,
                "proposal_sha": "2" * 40,
                "summary": "The experiment was reviewed; no code was promotable.",
                "validation": {"tests": "not_applicable"},
                "decisions": [
                    {
                        "experiment_id": self.experiment_id,
                        "disposition": "reviewed_not_used",
                        "rationale": (
                            "The abandoned experiment produced no source change."
                        ),
                        "integration_kind": "none",
                    }
                ],
            },
        )
        self.assertEqual(submitted.status_code, 200, submitted.text)
        requested = self.mcp(
            secret=consolidator_secret,
            name="review.request",
            arguments={
                "project_id": self.project_id,
                "target_type": "reflection",
                "target_id": reflection_id,
                "role": "consolidation_reviewer",
                "reason": "Review the immutable code proposal.",
            },
        )
        self.assertEqual(requested.status_code, 401, requested.text)
        # Submitting the proposal ends this node and fences its credential.
        # The support action opens the next node's independent review.
        opened = self.brain.application.request_review(
            project_id=self.project_id, target_type="reflection", target_id=reflection_id,
            role="consolidation_reviewer", producer_session_id=consolidator["id"],
        )
        request_id = opened["review_request_id"]
        self.client.post(
            f"/api/agent-sessions/{consolidator['id']}/release",
            json={"runner_id": "consolidator", "reason": "proposal_submitted"},
        )

        reviewer_secret = self.secret()
        reviewer = self.claim(secret=reviewer_secret, runner_id="reviewer")
        self.assertEqual(reviewer["kind"], "review")
        self.assertEqual(reviewer["target_type"], "reflection")
        started = self.mcp(
            secret=reviewer_secret,
            name="review.start",
            arguments={
                "review_request_id": request_id,
                "reviewer_capability": "assigned",
                "caller_session_id": "assigned",
            },
        )
        self.assertEqual(started.status_code, 200, started.text)
        verdict = self.mcp(
            secret=reviewer_secret,
            name="review.submit",
            arguments={
                "review_session_id": started.json()["result"]["review_session_id"],
                "verdict": "pass",
                "synopsis": REVIEW_SYNOPSIS,
            },
        )
        self.assertEqual(verdict.status_code, 200, verdict.text)

        pending = self.client.get(
            f"/api/projects/{self.project_id}/workspace-advances/pending"
        )
        self.assertEqual(pending.status_code, 200, pending.text)
        waiting = pending.json()["advance"]
        self.assertEqual(waiting["instance_id"], reflection_id)
        self.assertEqual((waiting["advance_id"], waiting["expected_sha"], waiting["target_sha"]), ("", "1" * 40, "2" * 40))
        self.assertEqual(waiting["sources"], [])
        prepared = self.client.post(
            f"/api/projects/{self.project_id}/workspace-advances/prepare",
            json={
                "instance_id": reflection_id,
                "runner_id": "central-runner",
            },
        )
        self.assertEqual(prepared.status_code, 200, prepared.text)
        advance = prepared.json()["advance"]
        advance_id = advance["advance_id"]
        self.assertTrue(advance_id)
        self.assertEqual({**advance, "advance_id": ""}, waiting)
        self.assertEqual(
            self.client.get(f"/api/projects/{self.project_id}/workspace-advances/pending").json()["advance"], advance,
        )
        settled = self.client.post(
            f"/api/projects/{self.project_id}/workspace-advances/settle",
            json={
                "advance_id": advance_id,
                "runner_id": "central-runner",
                "observed_sha": "2" * 40,
                "proposal_parents": ["1" * 40],
                "diffstat": {"commit_count": 0, "files_changed": 0},
                "ancestry": {},
            },
        )
        self.assertEqual(settled.status_code, 200, settled.text)
        self.assertEqual(settled.json()["advance"]["status"], "bound")
        self.assertEqual(settled.json()["advance"]["outcome"], "published")
        self.assertIsNone(
            self.client.get(f"/api/projects/{self.project_id}/workspace-advances/pending").json()["advance"],
        )
        ledger = self.client.get(
            f"/api/projects/{self.project_id}/reflections/"
            f"{reflection_id}/consolidation"
        )
        self.assertEqual(ledger.status_code, 200, ledger.text)
        ledger_result = ledger.json()
        self.assertTrue(ledger_result["reflection"]["published_at"])
        self.assertEqual(
            {
                review["role"]: review["verdict"]
                for review in ledger_result["reflection"]["reviews"]
            },
            {
                "reflection_reviewer": "pass",
                "consolidation_reviewer": "pass",
            },
        )
        self.assertEqual(
            ledger_result["consolidation"]["review"]["verdict"],
            "pass",
        )
        history = self.brain.application.experiment(
            project_id=self.project_id,
            experiment_id=self.experiment_id,
        )["consolidation_history"]
        self.assertEqual(history[-1]["disposition"], "reviewed_not_used")
        self.assertEqual(history[-1]["integration_outcome"], "not_applied")

    def test_a_paired_credential_consolidates_as_its_hello_identity(self) -> None:
        # A caller with no mas_ session (an externally paired credential) must
        # still be able to submit the proposal: its agent.hello id is the
        # producer the proposal records.
        reflection_id = self.reflection_ready_for_consolidation()
        hello = self.client.post(
            "/mcp/call", json={"name": "agent.hello", "arguments": {}}
        )
        self.assertEqual(hello.status_code, 200, hello.text)
        agent_id = hello.json()["result"]["agent_id"]
        submitted = self.client.post(
            "/mcp/call",
            json={
                "name": "consolidation.submit",
                "arguments": {
                    "agent_id": agent_id,
                    "project_id": self.project_id,
                    "reflection_id": reflection_id,
                    "base_sha": "1" * 40,
                    "proposal_sha": "2" * 40,
                    "summary": (
                        "The experiment was reviewed; no code was promotable."
                    ),
                    "validation": {"tests": "not_applicable"},
                    "decisions": [
                        {
                            "experiment_id": self.experiment_id,
                            "disposition": "reviewed_not_used",
                            "rationale": (
                                "The abandoned experiment produced no source "
                                "change."
                            ),
                            "integration_kind": "none",
                        }
                    ],
                },
            },
        )
        self.assertEqual(submitted.status_code, 200, submitted.text)
        conn = self.brain.store.connect()
        try:
            row = conn.execute(
                "SELECT created_by_session_id FROM consolidation_proposals "
                "WHERE reflection_id = ?",
                (reflection_id,),
            ).fetchone()
        finally:
            conn.close()
        self.assertEqual(row["created_by_session_id"], agent_id)


class AgentDispatchSwitchTest(unittest.TestCase):
    """The per-project switch gates claims; halting is a separate stop."""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.brain = TestBrain(
            repo_root=root,
            db_path=root / "state.sqlite",
            infrastructure_client=FakeInfrastructureClient(),
        )
        self.client = TestClient(self.brain.fastapi_app, raise_server_exceptions=False)
        self.project_id = self.brain.call_tool(
            "project", {"action": "create", "name": "Dispatch switch"}
        )["id"]
        self.brain.call_tool(
            "experiment.create",
            {
                "project_id": self.project_id,
                "name": "dispatchable",
                "intent": "Exercise the per-project dispatch switch.",
            },
        )

    def tearDown(self) -> None:
        self.brain.shutdown()
        self.temp.cleanup()

    def set_dispatch(self, enabled: bool) -> dict:
        return self.brain.call_tool(
            "project.update",
            {"project_id": self.project_id, "agent_dispatch": enabled},
        )

    def claim(self, *, runner_id: str = "runner-a") -> dict:
        response = self.client.post(
            "/api/agent-sessions/lease",
            json={
                "project_id": self.project_id,
                "platform": "codex",
                "runner_id": runner_id,
                "idempotency_key": f"key-{runner_id}",
                "session_secret": "mas_" + secrets.token_urlsafe(32),
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def live_sessions(self) -> list[dict]:
        response = self.client.get(f"/api/projects/{self.project_id}/agent-sessions")
        self.assertEqual(response.status_code, 200, response.text)
        return [
            session
            for session in response.json()["sessions"]
            if session["status"] in {"offered", "active"}
        ]

    def test_dispatch_is_off_until_the_project_turns_it_on(self) -> None:
        result = self.claim()
        self.assertIsNone(result["session"])
        self.assertEqual(result["reason"], "agent_dispatch_disabled")

        self.assertIs(self.set_dispatch(True)["settings"]["agent_dispatch"], True)
        self.assertIsNotNone(self.claim()["session"])

    def test_turning_dispatch_off_stops_new_claims_only(self) -> None:
        self.set_dispatch(True)
        self.assertIsNotNone(self.claim(runner_id="runner-a")["session"])

        self.set_dispatch(False)
        # The running session is untouched; only the next claim is refused.
        self.assertEqual(len(self.live_sessions()), 1)
        self.assertEqual(
            self.claim(runner_id="runner-b")["reason"],
            "agent_dispatch_disabled",
        )

    def test_halt_closes_live_sessions(self) -> None:
        self.set_dispatch(True)
        session = self.claim()["session"]
        self.assertIsNotNone(session)

        response = self.client.post(
            f"/api/projects/{self.project_id}/agent-sessions/halt"
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["halted"], 1)
        self.assertEqual(self.live_sessions(), [])
        closed = next(
            item
            for item in response.json()["sessions"]
            if item["id"] == session["id"]
        )
        self.assertEqual(closed["close_reason"], "dispatch_halted")

    def test_halting_an_idle_project_is_a_no_op(self) -> None:
        response = self.client.post(
            f"/api/projects/{self.project_id}/agent-sessions/halt"
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["halted"], 0)

    def test_the_list_reports_what_would_be_dispatched_next(self) -> None:
        # The queue is what a claim would take, in claim order, whether or not
        # dispatch is on — the page needs it precisely when nothing can run.
        listing = self.client.get(f"/api/projects/{self.project_id}/agent-sessions").json()
        self.assertEqual(
            [(item["kind"], item["title"], item["status"]) for item in listing["queue"]],
            [("workflow", "Design experiment", "planned"),
             ("workflow", "Revise the living project document", "writing")],
        )
        self.assertEqual(listing["queue"][0]["target_type"], "experiment")
        self.assertEqual(listing["queue_total"], 2)

        # A live session on the target takes it out of the queue; closing it
        # (here: halt) puts it back.
        self.set_dispatch(True)
        session = self.claim()["session"]
        self.assertIsNotNone(session)
        listing = self.client.get(f"/api/projects/{self.project_id}/agent-sessions").json()
        self.assertEqual([item["role"] for item in listing["queue"]], ["project_author"])
        self.client.post(f"/api/projects/{self.project_id}/agent-sessions/halt")
        listing = self.client.get(f"/api/projects/{self.project_id}/agent-sessions").json()
        self.assertIn(session["target_id"], [item["target_id"] for item in listing["queue"]])
