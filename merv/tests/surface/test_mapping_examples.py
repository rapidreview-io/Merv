"""Compact examples for the four public shapes that remain ordinary mappings."""
import json
from pathlib import Path

from fastapi.testclient import TestClient
from merv.brain.surface.transport.api import create_fastapi_app
from tests.research_core.scenarios import ResearchCase


class MappingExampleTest(ResearchCase):
    def test_project_claim_candidate_and_current_examples(self):
        examples = json.loads((Path(__file__).parents[1] / "fixtures" / "public_examples.json").read_text())
        self.app.research.update_project(project_id=self.project_id, name="Wire Shapes")
        for project in self.app.research.list_projects()["projects"]:
            if project["id"] != self.project_id:
                self.app.research.update_project(project_id=project["id"], hidden=True)
        # Distinct timestamps are unnecessary: compare claims by their semantic identity.
        for claim in examples["http:claims"]["claims"]:
            self.call("claim.create", project_id=self.project_id,
                      **{key: claim[key] for key in ("statement", "scope", "confidence")})
        experiment = self.create_experiment()
        self.call("candidate.submit", project_id=self.project_id, name="champion-1",
                  source_kind="experiment_workspace", source_ref=experiment, metrics={"accuracy": 0.72},
                  primary_metric="accuracy", validation_summary="The first promotable candidate.",
                  idempotency_key="compact-example")
        with TestClient(create_fastapi_app(self.app)) as client:
            actual = {}
            for name, path in (("http:project", ""), ("http:claims", "/claims")):
                response = client.get(f"/api/projects/{self.project_id}{path}")
                self.assertEqual(response.status_code, 200, response.text)
                actual[name] = response.json()
        actual["tool:candidate.list"] = self.call("candidate.list", project_id=self.project_id)
        actual["tool:project.current"] = self.call("project", action="current")
        actual["tool:project.list"] = self.call("project", action="list")
        claims = actual["http:claims"]["claims"]
        self.assertEqual(claims, sorted(claims, key=lambda claim: (claim["created_at"], claim["id"])))
        for value in (actual, examples):
            value["http:claims"]["claims"].sort(key=lambda claim: claim["statement"])

        def compare(expected, observed):
            if isinstance(expected, dict):
                self.assertEqual(set(observed), set(expected))
                for key in expected:
                    compare(expected[key], observed[key])
            elif isinstance(expected, list):
                self.assertEqual(len(observed), len(expected))
                for left, right in zip(expected, observed):
                    compare(left, right)
            elif expected == "<time>":
                self.assertRegex(observed, r"^\d{4}-\d{2}-\d{2}T")
            elif expected in ("<proj>", "<claim>", "<exp>", "<cand>"):
                self.assertRegex(observed, "^" + expected[1:-1] + r"_[0-9a-f]{12}$")
            else:
                self.assertEqual(observed, expected)
        compare(examples, actual)
