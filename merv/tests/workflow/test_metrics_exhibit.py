"""System-authored metrics exhibit: generation, gating, and pinning.

The exhibit shifts quantitative evidence from attestation to observation — the
system generates the record from the attempt's pinned result files; the agent
writes interpretation around it. These tests cover the pure builder
(provenance, determinism) and the tool-level flow (finalize+pin at
submit_results, report-reference gate, preview parity, agent immutability, and
the qualitative bypass).
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tests.support.brain import TestBrain
from merv.brain.application.experiments.metrics_exhibit import (
    build_metrics_exhibit,
    exhibit_bytes,
)
from merv.brain.kernel.utils import ValidationError, WorkflowError

WINDOW_START = "2026-07-05T10:00:00Z"


def _source(path: str = "metrics.json", *, data: object | None = None) -> dict:
    return {
        "path": path,
        "artifact_id": "art_1",
        "sha256": "ab" * 32,
        "submitted_at": WINDOW_START,
        "data": data,
    }


def _build(**overrides) -> dict:
    kwargs = dict(
        project_id="proj",
        experiment_id="exp",
        attempt_index=1,
        window_started_at=WINDOW_START,
        file_sources=[],
    )
    kwargs.update(overrides)
    return build_metrics_exhibit(**kwargs)


class ExhibitBuilderTest(unittest.TestCase):
    def test_result_file_sources_carry_provenance_and_data(self) -> None:
        exhibit = _build(file_sources=[_source(data={"accuracy": 0.72})])
        entry = exhibit["result_files"][0]
        self.assertEqual(entry["data"], {"accuracy": 0.72})
        self.assertEqual(entry["source"]["type"], "result_file")
        self.assertEqual(entry["source"]["artifact_id"], "art_1")
        self.assertEqual(entry["source"]["sha256"], "ab" * 32)
        self.assertEqual(exhibit["verdict"]["result_files"], 1)

    def test_the_attempt_window_is_recorded_with_the_record(self) -> None:
        exhibit = _build(attempt_index=3)
        self.assertEqual(exhibit["window"]["started_at"], WINDOW_START)
        self.assertEqual(exhibit["attempt_index"], 3)

    def test_generation_is_deterministic_for_identical_state(self) -> None:
        sources = [_source(data={"a": 1})]
        self.assertEqual(
            exhibit_bytes(_build(file_sources=sources)),
            exhibit_bytes(_build(file_sources=sources)),
        )


VALID_PLAN = (
    "## Summary\nToy experiment for exhibit tests.\n\n"
    "## Objective & hypothesis\nThreshold beats baseline.\n\n"
    "## Evaluation\nAccuracy vs baseline; success if > 0.6.\n"
)

VALID_GRAPH = (
    '{"version": 1, "nodes": ['
    '{"id": "obj", "kind": "objective", "label": "Beat baseline"},'
    '{"id": "out", "kind": "outcome", "label": "Met"}],'
    ' "edges": [{"from": "obj", "to": "out", "label": "confirmed"}]}\n'
)

REPORT_WITH_REFERENCE = (
    "## Summary\nRan per plan.\n\n"
    "## Results\nAll runs: [metrics exhibit](metrics_exhibit.json); the good "
    "seed cleared 0.6 and the four flat seeds are discussed below.\n\n"
    "## Deviations from plan\nNone.\n\n"
    "## Conclusion\nDecision rule met.\n"
)

REPORT_WITHOUT_REFERENCE = (
    "## Summary\nRan per plan.\n\n"
    "## Results\nAccuracy was 0.72, comfortably above the 0.6 threshold.\n\n"
    "## Deviations from plan\nNone.\n\n"
    "## Conclusion\nDecision rule met.\n"
)


class ExhibitFlowTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
        )
        self.project_id = self.call("project", action="create", name="Exhibit Test")[
            "id"
        ]

    def tearDown(self) -> None:
        self.app.shutdown()
        self.tmp.cleanup()

    def call(self, tool_name: str, **kwargs):
        return self.app.call_tool(tool_name, kwargs)

    # ---- helpers ----

    def _submit(self, *, exp_id: str, path: str, role: str, body: str) -> None:
        self.app.submit_artifact(
            project_id=self.project_id,
            target_type="experiment",
            target_id=exp_id,
            role=role,
            path=path,
            body=body,
        )

    def _pass_review(self, *, exp_id: str, role: str) -> None:
        req = self.call(
            "review.request",
            project_id=self.project_id,
            target_type="experiment",
            target_id=exp_id,
            role=role,
        )
        session = self.call(
            "review.start",
            review_request_id=req["review_request_id"],
            reviewer_capability=req["reviewer_capability"],
            caller_session_id=f"{role}-reviewer",
        )
        self.call(
            "review.submit",
            review_session_id=session["review_session_id"],
            verdict="pass",
            synopsis="The attempt checks out against the exhibit, so it stands.",
        )

    def _drive_to_running(self, *, name: str = "exp-1") -> str:
        exp_id = self.call(
            "experiment.create",
            name=name,
            project_id=self.project_id,
            intent="Exhibit flow.",
        )["id"]
        self._submit(exp_id=exp_id, path="plan.md", role="plan", body=VALID_PLAN)
        self.call(
            "experiment.transition",
            project_id=self.project_id,
            experiment_id=exp_id,
            transition="submit_design",
        )
        self._pass_review(exp_id=exp_id, role="design_reviewer")
        current = self.app.workflows.runtime.get(project_id=self.project_id, instance_id=exp_id)
        self.assertEqual(current.state, "running")
        self.assertIsNone(self.app.research.experiments.attempt_started_running_at(experiment_id=exp_id))
        started = self.call(
            "workflow.begin",
            project_id=self.project_id,
            instance_id=exp_id,
            expected_revision=current.revision,
        )
        # The node handoff explains the system record; actual activation owns
        # the attempt window.
        self.assertIn("metrics_exhibit.json", started["brief"])
        self.assertIn("experiment.exhibit", started["brief"])
        self.assertIsNotNone(self.app.research.experiments.attempt_started_running_at(experiment_id=exp_id))
        self.app.application.workflow_deliveries.run_once(project_id=self.project_id)
        return exp_id

    def _submit_ready(
        self,
        exp_id: str,
        *,
        report: str = REPORT_WITH_REFERENCE,
        result: str = '{"accuracy": 0.72}\n',
        result_path: str = "results.json",
    ) -> None:
        self._submit(exp_id=exp_id, path=result_path, role="result", body=result)
        self._submit(exp_id=exp_id, path="report.md", role="report", body=report)
        self._submit(exp_id=exp_id, path="graph.json", role="graph", body=VALID_GRAPH)

    def _exhibit_association(self, exp_id: str) -> dict | None:
        conn = self.app._store.connect()
        try:
            row = conn.execute(
                """
                SELECT id, path, created_by, content_sha256
                FROM research_artifacts
                WHERE target_type = 'experiment' AND target_id = ?
                  AND role = 'exhibit' AND status = 'complete'
                ORDER BY created_seq DESC LIMIT 1
                """,
                (exp_id,),
            ).fetchone()
        finally:
            conn.close()
        if row is None:
            return None
        return {key: row[key] for key in row.keys()}

    def _pinned_exhibit(self, exp_id: str) -> dict:
        association = self._exhibit_association(exp_id)
        self.assertIsNotNone(association, "no pinned exhibit association")
        data = self.app._blobs.get(
            namespace=self.project_id, sha256=str(association["content_sha256"])
        )
        return json.loads(data.decode("utf-8"))

    # ---- finalize + pin at submit_results ----

    def test_submit_results_pins_a_system_authored_exhibit(self) -> None:
        exp_id = self._drive_to_running()
        self._submit_ready(exp_id)
        out = self.call(
            "experiment.transition",
            project_id=self.project_id,
            experiment_id=exp_id,
            transition="submit_results",
        )
        self.assertEqual(out["status"], "experiment_review")
        self.assertTrue(out["metrics_exhibit"]["pinned"])
        self.assertEqual(out["metrics_exhibit"]["verdict"]["result_files"], 1)

        exhibit = self._pinned_exhibit(exp_id)
        # Result-file source ingested with parsed payload and provenance.
        self.assertEqual(exhibit["result_files"][0]["data"], {"accuracy": 0.72})
        self.assertEqual(exhibit["result_files"][0]["source"]["type"], "result_file")

        association = self._exhibit_association(exp_id)
        self.assertEqual(association["created_by"], "system")
        self.assertTrue(str(association["path"]).endswith("metrics_exhibit.json"))

    def test_files_submitted_after_the_transition_are_outside_the_record(self) -> None:
        exp_id = self._drive_to_running()
        self._submit_ready(exp_id)
        self.call(
            "experiment.transition",
            project_id=self.project_id,
            experiment_id=exp_id,
            transition="submit_results",
        )
        exhibit = self._pinned_exhibit(exp_id)
        self.assertEqual(
            [entry["path"] for entry in exhibit["result_files"]], ["results.json"]
        )

    def test_report_must_reference_the_exhibit_when_results_are_machine_readable(
        self,
    ) -> None:
        exp_id = self._drive_to_running()
        self._submit_ready(exp_id, report=REPORT_WITHOUT_REFERENCE)
        with self.assertRaises(WorkflowError) as ctx:
            self.call(
                "experiment.transition",
                project_id=self.project_id,
                experiment_id=exp_id,
                transition="submit_results",
            )
        self.assertIn("metrics_exhibit.json", str(ctx.exception))
        # Referencing the exhibit (after previewing it) unblocks the gate.
        self._submit(
            exp_id=exp_id, path="report.md", role="report", body=REPORT_WITH_REFERENCE
        )
        out = self.call(
            "experiment.transition",
            project_id=self.project_id,
            experiment_id=exp_id,
            transition="submit_results",
        )
        self.assertEqual(out["status"], "experiment_review")

    def test_a_qualitative_attempt_needs_no_exhibit_and_no_gate_machinery(self) -> None:
        # A result artifact the system cannot parse is the agent's own prose:
        # nothing to be the record of, so no exhibit and no reference demanded.
        exp_id = self._drive_to_running()
        self._submit_ready(
            exp_id,
            report=REPORT_WITHOUT_REFERENCE,
            result="observed a qualitative shift, no numbers\n",
            result_path="results.txt",
        )
        out = self.call(
            "experiment.transition",
            project_id=self.project_id,
            experiment_id=exp_id,
            transition="submit_results",
        )
        self.assertEqual(out["status"], "experiment_review")
        self.assertIsNone(self._exhibit_association(exp_id))
        self.assertNotIn("metrics_exhibit", out)

    def test_generation_verdict_is_recorded_for_instrumentation(self) -> None:
        exp_id = self._drive_to_running()
        self._submit_ready(exp_id)
        self.call(
            "experiment.transition",
            project_id=self.project_id,
            experiment_id=exp_id,
            transition="submit_results",
        )
        conn = self.app._store.connect()
        try:
            row = conn.execute(
                "SELECT payload_json FROM events WHERE type = 'experiment.exhibit_generated' AND target_id = ?",
                (exp_id,),
            ).fetchone()
        finally:
            conn.close()
        payload = json.loads(str(row["payload_json"]))
        self.assertEqual(payload["result_files"], 1)
        self.assertTrue(payload["pinned"])

    def test_reviewer_hydration_includes_the_exhibit_content(self) -> None:
        # Review start lists the immutable exhibit id; artifact.read is the
        # reviewer's focused path to the ground-truth numbers.
        exp_id = self._drive_to_running()
        self._submit_ready(exp_id)
        self.call(
            "experiment.transition",
            project_id=self.project_id,
            experiment_id=exp_id,
            transition="submit_results",
        )
        req = self.call(
            "review.request",
            project_id=self.project_id,
            target_type="experiment",
            target_id=exp_id,
            role="experiment_reviewer",
        )
        session = self.call(
            "review.start",
            review_request_id=req["review_request_id"],
            reviewer_capability=req["reviewer_capability"],
            caller_session_id="experiment_reviewer-reviewer",
        )
        exhibit_ref = next(
            artifact
            for artifact in session["context"]["artifacts"]
            if artifact["descriptor"] == "exhibit"
        )
        found = self.call(
            "artifact.read",
            project_id=self.project_id,
            artifact_id=exhibit_ref["id"],
            include_content=True,
        )
        exhibit = json.loads(found["content"]["content"])
        self.assertEqual(exhibit["result_files"][0]["data"], {"accuracy": 0.72})

    # ---- preview during running ----

    def test_preview_matches_final_for_identical_state(self) -> None:
        exp_id = self._drive_to_running()
        self._submit_ready(exp_id)
        preview = self.call(
            "experiment.exhibit", project_id=self.project_id, experiment_id=exp_id
        )
        self.assertIn("metrics_exhibit.json", preview["exhibit_path"])
        self.call(
            "experiment.transition",
            project_id=self.project_id,
            experiment_id=exp_id,
            transition="submit_results",
        )
        final = self._pinned_exhibit(exp_id)
        # Same generation code, same state: byte-identical record — no
        # generation timestamp lives in the payload.
        self.assertEqual(exhibit_bytes(preview["exhibit"]), exhibit_bytes(final))

    def test_preview_requires_a_running_experiment(self) -> None:
        exp_id = self.call(
            "experiment.create",
            name="exp-idle",
            project_id=self.project_id,
            intent="Preview gate.",
        )["id"]
        with self.assertRaises(WorkflowError):
            self.call(
                "experiment.exhibit", project_id=self.project_id, experiment_id=exp_id
            )

    # ---- agent immutability ----

    def test_agents_cannot_author_replace_or_delete_the_exhibit(self) -> None:
        exp_id = self._drive_to_running()
        self._submit_ready(exp_id)
        self.call(
            "experiment.transition",
            project_id=self.project_id,
            experiment_id=exp_id,
            transition="submit_results",
        )
        association = self._exhibit_association(exp_id)
        exhibit_path = str(association["path"])

        # The exhibit role is not submittable through the agent surface —
        # not even against the exhibit's own path label.
        for path in ("forged.json", exhibit_path):
            with self.assertRaises(ValidationError):
                self.call(
                    "artifact.upload",
                    project_id=self.project_id,
                    path=path,
                    attach_to={"target_type": "experiment", "target_id": exp_id, "role": "exhibit"},
                )


if __name__ == "__main__":
    unittest.main()
