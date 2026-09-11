"""Exercise typed projections through HTTP and tools, without whole-project captures."""
import json

from fastapi.testclient import TestClient
from merv.brain.surface.transport.api import create_fastapi_app
from tests.research_core.scenarios import ResearchCase, VALID_PLAN, VALID_REPORT, VALID_GRAPH


class NativeContractTest(ResearchCase):
    def setUp(self):
        super().setUp()
        self.client = TestClient(create_fastapi_app(self.app))
        self.addCleanup(self.client.close)

    def get(self, suffix):
        response = self.client.get(f"/api/projects/{self.project_id}/{suffix}")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_native_detail_list_home_overview_and_status_routes(self):
        experiment = self.create_experiment()
        task = self.call("task.create", project_id=self.project_id, name="task-example",
                         goal="Write a note", deliverables=["Note exists"])["id"]
        for kind, record_id, initial in (("experiment", experiment, "planned"), ("task", task, "in_progress")):
            with self.subTest(kind=kind):
                identity = {kind + "_id": record_id}
                rich = self.get(f"{kind}s/{record_id}")
                slim = self.call(kind + ".get_state", project_id=self.project_id, **identity)
                self.assertEqual((rich["id"], rich["status"]), (record_id, initial))
                self.assertEqual(slim["gate_checklist"], rich["gate_checklist"])
                self.assertTrue({"project_id", "artifacts", "submissions"} <= rich.keys())
                self.assertFalse({"project_id", "artifacts", "submissions"} & slim.keys())
                if kind == "task":
                    self.assertIsNone(rich["report"])
                    self.assertNotIn("report", slim)
                for listing in (self.get(kind + "s"), self.call(kind + ".list", project_id=self.project_id),
                                self.get("home"), self.call("project", action="records", project_id=self.project_id)):
                    row = next(row for row in listing[kind + "s"] if row["id"] == record_id)
                    self.assertEqual(row["status"], initial)
                status = self.get(f"{kind}s/{record_id}/status")
                self.assertEqual(status[kind]["id"], record_id)
                agent = self.call("workflow.status_and_next", project_id=self.project_id, **identity)
                self.assertTrue(agent["workflow"])
                self.assertTrue(agent["context"])
        project_status = self.call("workflow.status_and_next", project_id=self.project_id)
        self.assertEqual(project_status["scope"], "project")
        self.assertTrue(project_status["workflow"])

    def test_review_recovery_and_completed_evidence_survive_all_experiment_views(self):
        claim = self.call("claim.create", project_id=self.project_id, statement="Accuracy improves.")["id"]
        experiment = self.call("experiment.create", project_id=self.project_id, name="completed-example",
                               intent="Test accuracy", tested_claim_ids=[claim])["id"]
        self.submit(target_type="experiment", target_id=experiment, role="plan", body=VALID_PLAN)
        self.transition_experiment(experiment, "submit_design")
        self.pass_review(target_type="experiment", target_id=experiment, role="design_reviewer")
        for role, body in (("result", '{"accuracy": 0.72}'), ("report", VALID_REPORT), ("graph", VALID_GRAPH)):
            self.submit(target_type="experiment", target_id=experiment, role=role, body=body,
                        path=role + (".json" if role in {"result", "graph"} else ".md"))
        self.transition_experiment(experiment, "submit_results")
        request = self.call("review.request", project_id=self.project_id, target_type="experiment",
                            target_id=experiment, role="experiment_reviewer")
        for status in (self.get("reviews"), self.call("review.status", project_id=self.project_id,
                                                   target_type="experiment", target_id=experiment)):
            row = next(row for row in status["requests"] if row["id"] == request["review_request_id"])
            self.assertEqual(row["status"], "requested")
            self.assertNotIn("reviewer_capability", json.dumps(status))
        self.pass_review(target_type="experiment", target_id=experiment, role="experiment_reviewer")
        rows = [self.get(f"experiments/{experiment}"),
                self.call("experiment.get_state", project_id=self.project_id, experiment_id=experiment),
                next(row for row in self.get("home")["experiments"] if row["id"] == experiment)]
        for row in rows:
            self.assertEqual(row["status"], "complete")
            self.assertEqual(row["tested_claims"][0]["id"], claim)
            self.assertTrue(row["conclusion"])
            self.assertTrue(row["reviews"])
            self.assertNotIn("claim_update_suggestions", json.dumps(row))

    def test_published_reflection_guidance_survives_serialization_and_nested_overviews(self):
        reflection = self.drive_reflection_to_review()
        self.pass_review(target_type="reflection", target_id=reflection, role="reflection_reviewer")
        self.consolidate_and_publish(reflection)
        views = [self.get(f"reflections/{reflection}"), self.get("reflections"),
                 self.call("reflection.get", project_id=self.project_id, reflection_id=reflection),
                 self.call("reflection.list", project_id=self.project_id)]
        def check(node):
            found = 0
            if isinstance(node, dict):
                if "post_publish_guidance" in node:
                    keys = list(node)
                    self.assertEqual(keys[keys.index("materialized_experiments") + 1], "post_publish_guidance")
                    self.assertTrue(node["post_publish_guidance"])
                    self.assertNotIn("workflow_state", node)
                    found += 1
                found += sum(check(value) for value in node.values())
            elif isinstance(node, list):
                found += sum(check(value) for value in node)
            return found
        for view in views:
            self.assertGreater(check(json.loads(json.dumps(view))), 0)
        packet = self.call("consolidation.get", project_id=self.project_id, reflection_id=reflection)
        self.assertEqual(packet["reflection"]["id"], reflection)
        self.assertEqual(set(packet), {"reflection", "base_sha", "experiments", "consolidation", "revision_context"})
