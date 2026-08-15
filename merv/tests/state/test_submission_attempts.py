"""Submission attempts: the round inside an experiment attempt.

A review return to running deliberately does not bump attempt_index, so before this
existed every report round was indistinguishable and each resubmission hard-
deleted the previous round's report. These tests pin the two halves of the fix:
a forward transition seals the live composition, and a sealed row is immune
from supersede.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from merv.brain.artifacts import ArtifactTarget
from merv.brain.research_core.evidence import latest_per_slot
from tests.support.brain import TestBrain

VALID_PLAN = (
    "## Summary\nA toy experiment used by the submission-attempt tests.\n\n"
    "## Objective & hypothesis\nThreshold beats the majority baseline.\n\n"
    "## Evaluation\nAccuracy vs baseline; success if accuracy > 0.6.\n"
)

VALID_REPORT = (
    "## Summary\nRan the toy experiment per the approved plan.\n\n"
    "## Results\nAccuracy 0.72 vs target 0.60.\n\n"
    "## Deviations from plan\nNone.\n\n"
    "## Conclusion\nDecision rule met.\n"
)

VALID_GRAPH = (
    '{"version": 1, "nodes": ['
    '{"id": "obj", "kind": "objective", "label": "Beat baseline"},'
    '{"id": "out", "kind": "outcome", "label": "Met at 0.72"}],'
    ' "edges": [{"from": "obj", "to": "out", "label": "confirmed by"}]}\n'
)


class LatestPerSlotTest(unittest.TestCase):
    def test_latest_per_slot_keeps_only_the_newest_row_in_order(self) -> None:
        artifacts = [
            {"id": "a1", "role": "report", "lens_id": "", "path": "r.md", "submitted_order": 1},
            {"id": "a2", "role": "result", "lens_id": "", "path": "x.json", "submitted_order": 2},
            {"id": "a3", "role": "report", "lens_id": "", "path": "r.md", "submitted_order": 3},
        ]
        self.assertEqual(latest_per_slot(artifacts[:2]), artifacts[:2])
        self.assertEqual(
            [artifact["id"] for artifact in latest_per_slot(artifacts)],
            ["a2", "a3"],
        )


class SubmissionAttemptFlowTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
        )
        self.project_id = self.call("project", action="create", name="Submissions")["id"]

    def tearDown(self) -> None:
        self.tmp.cleanup()
        self.app.shutdown()

    def call(self, tool_name: str, **kwargs):
        return self.app.call_tool(tool_name, kwargs)

    def _target(self, experiment_id: str) -> ArtifactTarget:
        return ArtifactTarget("experiment", experiment_id, self.project_id)

    def _submit(self, *, target_id: str, role: str, path: str, body: str) -> str:
        pending = self.call(
            "artifact.submit",
            project_id=self.project_id,
            target_type="experiment",
            target_id=target_id,
            role=role,
            path=path,
        )
        token = pending["run"].rsplit("/", 1)[-1].rstrip("'")
        response = self.app._client.put(
            f"/api/artifacts/u/{token}", content=body.encode()
        )
        self.assertEqual(response.status_code, 200, response.text)
        return str(pending["artifact_id"])

    def _review(self, *, exp_id: str, role: str, verdict: str, return_to: str = "") -> None:
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
        payload = {
            "review_session_id": session["review_session_id"],
            "verdict": verdict,
            "synopsis": "A synopsis long enough to satisfy the reviewer contract.",
        }
        if return_to:
            payload["return_to"] = return_to
        self.call("review.submit", **payload)

    def _rows(self, sql: str, params: tuple = ()) -> list[dict]:
        with self.app.store.transaction() as conn:
            return [dict(row) for row in conn.execute(sql, params).fetchall()]

    def _reach_experiment_review(self, exp_id: str) -> None:
        self._submit(target_id=exp_id, role="plan", path="plan.md", body=VALID_PLAN)
        self.call(
            "experiment.transition",
            project_id=self.project_id,
            experiment_id=exp_id,
            transition="submit_design",
        )
        self._review(exp_id=exp_id, role="design_reviewer", verdict="pass")
        self.call(
            "experiment.transition",
            project_id=self.project_id,
            experiment_id=exp_id,
            transition="mark_ready_to_run",
        )
        self.call(
            "experiment.transition",
            project_id=self.project_id,
            experiment_id=exp_id,
            transition="start_running",
        )
        self._submit(target_id=exp_id, role="result", path="metrics.json", body='{"accuracy": 0.72}')
        self._submit(target_id=exp_id, role="graph", path="graph.json", body=VALID_GRAPH)
        self._submit(target_id=exp_id, role="report", path="report.md", body=VALID_REPORT)
        self.call(
            "experiment.transition",
            project_id=self.project_id,
            experiment_id=exp_id,
            transition="submit_results",
        )

    def test_rejected_round_keeps_its_report_and_the_next_round_is_its_own(self) -> None:
        exp_id = self.call(
            "experiment.create",
            project_id=self.project_id,
            name="two-rounds",
            intent="Prove a rejected round keeps its report.",
        )["id"]
        self._reach_experiment_review(exp_id)
        first_report = self._rows(
            "SELECT id, submission_id FROM artifacts "
            "WHERE target_id = ? AND role = 'report' AND status = 'complete'",
            (exp_id,),
        )
        self.assertEqual(len(first_report), 1)
        self.assertNotEqual(first_report[0]["submission_id"], "")

        # Round 1 rejected back to running: same attempt, new round.
        self._review(
            exp_id=exp_id,
            role="experiment_reviewer",
            verdict="needs_changes",
            return_to="running",
        )
        state = self.call(
            "experiment.get_state", project_id=self.project_id, experiment_id=exp_id
        )
        self.assertEqual(state["attempt_index"], 1, "a report rejection must not bump the attempt")

        second_id = self._submit(
            target_id=exp_id,
            role="report",
            path="report.md",
            body=VALID_REPORT.replace("0.72", "0.81"),
        )

        reports = self._rows(
            "SELECT id, submission_id FROM artifacts "
            "WHERE target_id = ? AND role = 'report' AND status = 'complete' "
            "ORDER BY created_seq",
            (exp_id,),
        )
        self.assertEqual(
            [r["id"] for r in reports],
            [first_report[0]["id"], second_id],
            "the rejected round's report must survive its replacement",
        )
        self.assertEqual(reports[1]["submission_id"], "", "the new round is not sealed yet")

        # Only the newest counts as current, so gates and the review snapshot
        # see exactly one report.
        state = self.call(
            "experiment.get_state", project_id=self.project_id, experiment_id=exp_id
        )
        current = [
            a for a in state["current_attempt_artifacts"] if a["role"] == "report"
        ]
        self.assertEqual([a["id"] for a in current], [second_id])
        self.call(
            "experiment.transition",
            project_id=self.project_id,
            experiment_id=exp_id,
            transition="submit_results",
        )
        rounds = self._rows(
            "SELECT attempt_index, transition FROM submissions "
            "WHERE target_id = ? AND transition = 'submit_results' "
            "ORDER BY created_seq",
            (exp_id,),
        )
        self.assertEqual(
            [r["attempt_index"] for r in rounds],
            [1, 1],
            "two report rounds inside one experiment attempt",
        )

    def test_resubmitting_inside_one_round_still_replaces(self) -> None:
        exp_id = self.call(
            "experiment.create",
            project_id=self.project_id,
            name="one-round",
            intent="Prove supersede still works before the seal.",
        )["id"]
        first = self._submit(
            target_id=exp_id, role="plan", path="plan.md", body=VALID_PLAN
        )
        second = self._submit(
            target_id=exp_id, role="plan", path="plan.md", body=VALID_PLAN + "\nRevised.\n"
        )
        plans = self._rows(
            "SELECT id FROM artifacts WHERE target_id = ? AND role = 'plan' "
            "AND status = 'complete'",
            (exp_id,),
        )
        self.assertEqual(
            [p["id"] for p in plans],
            [second],
            "unsealed work in the round being assembled is still replaced",
        )
        self.assertNotEqual(first, second)

    def test_sealed_system_artifact_survives_the_next_rounds_pin(self) -> None:
        """A new round may replace only its own unsealed exhibit."""
        exp_id = self.call(
            "experiment.create",
            project_id=self.project_id,
            name="exhibit-history",
            intent="Prove a sealed system artifact is not re-pinned away.",
        )["id"]
        artifacts = self.app.artifacts

        artifacts.pin(
            target=self._target(exp_id),
            role="exhibit",
            path="exhibit.json",
            data=b'{"round": 1}',
        )
        first_id = artifacts.scan(
            target_ids=(exp_id,), roles=("exhibit",)
        )[0].id
        # Freeze round 1 exactly as a forward transition would.
        with self.app.store.transaction() as conn:
            artifacts.seal(
                tx=conn,
                target=self._target(exp_id),
                transition="submit_results",
            )
        artifacts.pin(
            target=self._target(exp_id),
            role="exhibit",
            path="exhibit.json",
            data=b'{"round": 2}',
        )
        second_id = next(
            artifact.id
            for artifact in artifacts.scan(
                target_ids=(exp_id,), roles=("exhibit",)
            )
            if artifact.submission_id == ""
        )

        rows = self._rows(
            "SELECT id, submission_id FROM artifacts WHERE target_id = ? "
            "AND role = 'exhibit' AND status = 'complete' ORDER BY created_seq",
            (exp_id,),
        )
        self.assertEqual(
            [r["id"] for r in rows],
            [first_id, second_id],
            "the sealed round-1 exhibit must survive round 2's pin",
        )
        self.assertNotEqual(rows[0]["submission_id"], "")
        self.assertEqual(rows[1]["submission_id"], "")

        # A third pin inside the same unsealed round still replaces, so
        # exhibits do not pile up within one round.
        artifacts.pin(
            target=self._target(exp_id),
            role="exhibit",
            path="exhibit.json",
            data=b'{"round": 2, "revised": true}',
        )
        third_id = next(
            artifact.id
            for artifact in artifacts.scan(
                target_ids=(exp_id,), roles=("exhibit",)
            )
            if artifact.submission_id == ""
        )
        rows = self._rows(
            "SELECT id FROM artifacts WHERE target_id = ? AND role = 'exhibit' "
            "AND status = 'complete' ORDER BY created_seq",
            (exp_id,),
        )
        self.assertEqual([r["id"] for r in rows], [first_id, third_id])

    def test_figure_chains_submissions_instead_of_stacking_them(self) -> None:
        exp_id = self.call(
            "experiment.create",
            project_id=self.project_id,
            name="figure-rounds",
            intent="Prove the canvas draws rounds as a spine.",
        )["id"]
        self._reach_experiment_review(exp_id)
        self._review(
            exp_id=exp_id,
            role="experiment_reviewer",
            verdict="needs_changes",
            return_to="running",
        )
        self._submit(
            target_id=exp_id,
            role="report",
            path="report.md",
            body=VALID_REPORT.replace("0.72", "0.81"),
        )
        self.call(
            "experiment.transition",
            project_id=self.project_id,
            experiment_id=exp_id,
            transition="submit_results",
        )
        figure = self.app._client.get(
            f"/api/projects/{self.project_id}/experiments/{exp_id}/figure"
        ).json()
        nodes = {n["id"]: n for n in figure["nodes"]}
        edges = {(e["from"], e["to"]): e["type"] for e in figure["edges"]}
        self.assertIn("submission:1.1", nodes)
        self.assertIn("submission:1.2", nodes)
        # The spine is temporal: design approval → round 1 → its verdict →
        # round 2. Round 2 hangs off the rejecting review, not the attempt and
        # not round 1 directly.
        design = [
            n for n in figure["nodes"]
            if n["type"] == "review" and n["qualifier"] == "attempt 1"
        ]
        self.assertEqual(len(design), 1)
        self.assertEqual(edges[("attempt:1", design[0]["id"])], "reviewed_by")
        self.assertEqual(edges[(design[0]["id"], "submission:1.1")], "then")
        verdicts = [
            n for n in figure["nodes"]
            if n["type"] == "review" and n["qualifier"] == "round 1.1"
        ]
        self.assertEqual(len(verdicts), 1, "expected one verdict on round 1.1")
        self.assertEqual(edges[("submission:1.1", verdicts[0]["id"])], "reviewed_by")
        self.assertEqual(
            edges[(verdicts[0]["id"], "submission:1.2")],
            "revised_to",
            "round 2 must follow round 1's verdict, not hang off the attempt",
        )
        # …and the straight backbone links the markers directly as well.
        self.assertEqual(edges[("submission:1.1", "submission:1.2")], "then")
        self.assertEqual(edges[("attempt:1", "submission:1.1")], "then")
        # Each round's report is evidence anchored on that round.
        reports = [
            n for n in figure["nodes"]
            if n["type"] == "artifact" and n["meta"]["role"] == "report"
        ]
        self.assertEqual(
            sorted((r["anchor"], r["lane"], r["qualifier"]) for r in reports),
            [
                ("submission:1.1", "evidence", "round 1.1"),
                ("submission:1.2", "evidence", "round 1.2"),
            ],
        )


if __name__ == "__main__":
    unittest.main()
