"""The derived experiment figure is a timeline: every round sits strictly after
the round before it *and* the verdict that caused it, and every satellite names
the beat it belongs to. Pinned on a synthetic three-attempt, four-round story
so the projection stays honest without a database."""

from __future__ import annotations

import unittest

from merv.brain.surface.experiment_figure import (
    ARTIFACT_FANOUT_CAP,
    build_experiment_figure,
)


def _seal(seal_id: str, attempt: int, transition: str, seq: int) -> dict:
    return {
        "id": seal_id,
        "attempt_index": attempt,
        "transition": transition,
        "created_at": f"2026-08-01T00:00:{seq:02d}Z",
        "created_seq": seq,
    }


def _artifact(art_id: str, attempt: int, role: str, seal: str, path: str | None = None) -> dict:
    return {
        "id": art_id,
        "attempt_index": attempt,
        "role": role,
        "submission_id": seal,
        "path": path or f"{art_id}.md",
        "title": "",
    }


def _review(review_id: str, role: str, verdict: str, seq: int, *, seal: str = "", return_to: str = "") -> dict:
    return {
        "id": review_id,
        "role": role,
        "verdict": verdict,
        "return_to": return_to,
        "submission_id": seal,
        "created_at": f"2026-08-01T00:01:{seq:02d}Z",
        "created_seq": seq,
        "synopsis": "",
        "notes": "",
    }


def _story() -> dict:
    """Attempt 1 and 2 rejected at design review; attempt 3 approved, then
    four result rounds, three sent back to running and the last accepted."""
    seals = [
        _seal("seal_d1", 1, "submit_design", 1),
        _seal("seal_d2", 2, "submit_design", 2),
        _seal("seal_d3", 3, "submit_design", 3),
        _seal("seal_ready", 3, "mark_ready_to_run", 4),
        _seal("seal_start", 3, "start_running", 5),
        _seal("seal_31", 3, "submit_results", 6),
        _seal("seal_32", 3, "submit_results", 7),
        _seal("seal_33", 3, "submit_results", 8),
        _seal("seal_34", 3, "submit_results", 9),
        _seal("seal_done", 3, "complete", 10),
    ]
    artifacts = [
        _artifact("plan1", 1, "plan", "seal_d1", "plan.md"),
        _artifact("plan2", 2, "plan", "seal_d2", "plan.md"),
        _artifact("plan3", 3, "plan", "seal_d3", "plan.md"),
        _artifact("cfg3", 3, "config", "seal_start", "run.yaml"),
        _artifact("rep31", 3, "report", "seal_31", "report.md"),
        _artifact("rcpt31", 3, "result", "seal_31", "execution_receipt.json"),
        _artifact("rep32", 3, "report", "seal_32", "report.md"),
        _artifact("rep33", 3, "report", "seal_33", "report.md"),
        _artifact("rep34", 3, "report", "seal_34", "report.md"),
        _artifact("res34", 3, "result", "seal_34", "evidence.json"),
        _artifact("late", 3, "note", "", "scratch.txt"),
    ]
    # Enough graph/result files on round 3.1 to overflow the fan-out cap.
    for i in range(ARTIFACT_FANOUT_CAP + 3):
        artifacts.append(_artifact(f"g31_{i}", 3, "graph", "seal_31", f"figs/{i}.png"))
    reviews = [
        _review("rv_d1", "design_reviewer", "needs_changes", 1, seal="seal_d1", return_to="planned"),
        _review("rv_d2", "design_reviewer", "needs_changes", 2, seal="seal_d2", return_to="planned"),
        _review("rv_d3", "design_reviewer", "pass", 3, seal="seal_d3"),
        _review("rv_31", "experiment_reviewer", "needs_changes", 4, seal="seal_31", return_to="running"),
        _review("rv_32", "experiment_reviewer", "needs_changes", 5, seal="seal_32", return_to="running"),
        _review("rv_33", "experiment_reviewer", "needs_changes", 6, seal="seal_33", return_to="running"),
        _review("rv_34", "experiment_reviewer", "pass", 7, seal="seal_34"),
    ]
    return {
        "id": "exp_1",
        "intent": "story",
        "status": "complete",
        "attempt_index": 3,
        "conclusion": "It worked.",
        "submissions": list(reversed(seals)),  # newest-first, like the store
        "artifacts": artifacts,
        "current_attempt_artifacts": [
            a for a in artifacts if a["id"] in {"plan3", "cfg3", "rep34", "res34", "late"}
        ],
        "reviews": list(reversed(reviews)),
        "tested_claims": [{"id": "claim_1", "statement": "X holds.", "status": "supported"}],
    }


class ExperimentFigureTimelineTest(unittest.TestCase):
    def setUp(self) -> None:
        self.figure = build_experiment_figure(
            experiment=_story(),
            review_attempts={"rv_d1": 1, "rv_d2": 2, "rv_d3": 3, "rv_31": 3, "rv_32": 3, "rv_33": 3, "rv_34": 3},
            open_review_requests=[],
            sandbox={"status": "released", "gpu": "A100"},
            sandbox_active=False,
        )
        self.nodes = {n["id"]: n for n in self.figure["nodes"]}
        self.edges = {(e["from"], e["to"]): e["type"] for e in self.figure["edges"]}

    def test_verdicts_are_spine_beats_between_rounds(self) -> None:
        # attempt → its review → next round; no redundant marker→marker link.
        self.assertEqual(self.edges[("attempt:1", "review:rv_d1")], "reviewed_by")
        self.assertEqual(self.edges[("review:rv_d1", "attempt:2")], "revised_to")
        self.assertNotIn(("attempt:1", "attempt:2"), self.edges)
        self.assertEqual(self.edges[("review:rv_d2", "attempt:3")], "revised_to")
        # Approval leads on to the first result round.
        self.assertEqual(self.edges[("attempt:3", "review:rv_d3")], "reviewed_by")
        self.assertEqual(self.edges[("review:rv_d3", "submission:3.1")], "then")
        self.assertNotIn(("attempt:3", "submission:3.1"), self.edges)
        # Each rejected round is what leads to the next; the last passes on to
        # the conclusion.
        for j in (1, 2, 3):
            self.assertEqual(self.edges[(f"submission:3.{j}", f"review:rv_3{j}")], "reviewed_by")
            self.assertEqual(self.edges[(f"review:rv_3{j}", f"submission:3.{j + 1}")], "revised_to")
            self.assertNotIn((f"submission:3.{j}", f"submission:3.{j + 1}"), self.edges)
        self.assertEqual(self.edges[("submission:3.4", "review:rv_34")], "reviewed_by")
        self.assertEqual(self.edges[("review:rv_34", "conclusion")], "concludes")
        self.assertEqual(self.edges[("conclusion", "claim:claim_1")], "tests")

    def test_satellites_name_their_beat(self) -> None:
        plan1 = self.nodes["artifact:plan1:a1"]
        self.assertEqual((plan1["anchor"], plan1["lane"], plan1["qualifier"]), ("attempt:1", "evidence", "attempt 1"))
        self.assertEqual(self.edges[("attempt:1", "artifact:plan1:a1")], "proposed")
        self.assertEqual(plan1["sublabel"], "plan · superseded")

        rep31 = self.nodes["artifact:rep31:a3"]
        self.assertEqual((rep31["anchor"], rep31["lane"], rep31["qualifier"]), ("submission:3.1", "evidence", "round 3.1"))
        self.assertEqual(self.edges[("submission:3.1", "artifact:rep31:a3")], "submitted")
        rep34 = self.nodes["artifact:rep34:a3"]
        self.assertEqual(rep34["anchor"], "submission:3.4")
        self.assertEqual(rep34["sublabel"], "report")

        # A file sealed by start_running is execution output trailing the design
        # approval; a file sealed by nothing trails the final verdict.
        cfg = self.nodes["artifact:cfg3:a3"]
        self.assertEqual((cfg["anchor"], cfg["lane"]), ("review:rv_d3", "execution"))
        self.assertEqual(self.edges[("attempt:3", "artifact:cfg3:a3")], "produced")
        late = self.nodes["artifact:late:a3"]
        self.assertEqual((late["anchor"], late["lane"], late["qualifier"]), ("review:rv_34", "execution", "round 3.4"))

        # Reviews carry the round they graded.
        self.assertEqual(self.nodes["review:rv_d2"]["qualifier"], "attempt 2")
        self.assertEqual(self.nodes["review:rv_33"]["qualifier"], "round 3.3")

        # The sandbox hangs off the design approval that started execution.
        sandbox = self.nodes["sandbox"]
        self.assertEqual((sandbox["anchor"], sandbox["lane"], sandbox["qualifier"]), ("review:rv_d3", "execution", "attempt 3"))
        self.assertEqual(self.edges[("attempt:3", "sandbox")], "ran_on")

    def test_fanout_cap_is_per_round(self) -> None:
        # Round 3.1 has report + receipt + 9 graph files: cap keeps the
        # load-bearing ones and rolls the rest into a group on the same beat.
        shown = [
            n for n in self.figure["nodes"]
            if n["type"] == "artifact" and n.get("anchor") == "submission:3.1"
        ]
        self.assertEqual(len(shown), ARTIFACT_FANOUT_CAP)
        self.assertEqual([n["meta"]["role"] for n in shown[:2]], ["report", "result"])
        group = self.nodes["artifact_group:submission:3.1:evidence"]
        self.assertEqual(group["meta"]["count"], 9 + 2 - ARTIFACT_FANOUT_CAP)
        self.assertEqual((group["anchor"], group["qualifier"]), ("submission:3.1", "round 3.1"))
        self.assertEqual(self.edges[("submission:3.1", group["id"])], "submitted")
        # Other rounds are untouched by 3.1's overflow.
        self.assertNotIn("artifact_group:submission:3.4:evidence", self.nodes)

    def test_open_gate_lands_after_the_latest_verdict(self) -> None:
        story = _story()
        story["status"] = "experiment_review"
        story["conclusion"] = ""
        story["reviews"] = [r for r in story["reviews"] if r["id"] != "rv_34"]
        figure = build_experiment_figure(
            experiment=story,
            review_attempts={"rv_d1": 1, "rv_d2": 2, "rv_d3": 3, "rv_31": 3, "rv_32": 3, "rv_33": 3},
            open_review_requests=[{"id": "req_1", "role": "experiment_reviewer"}],
            sandbox=None,
        )
        edges = {(e["from"], e["to"]): e["type"] for e in figure["edges"]}
        nodes = {n["id"]: n for n in figure["nodes"]}
        self.assertEqual(edges[("submission:3.4", "review_request:req_1")], "reviewed_by")
        self.assertEqual(nodes["review_request:req_1"]["qualifier"], "round 3.4")
        # Claims trail whatever the final beat is when there is no conclusion.
        self.assertEqual(edges[("review_request:req_1", "claim:claim_1")], "tests")

    def test_markers_link_directly_when_no_verdict_exists(self) -> None:
        story = _story()
        story["reviews"] = []
        figure = build_experiment_figure(
            experiment=story, review_attempts={}, open_review_requests=[], sandbox=None
        )
        edges = {(e["from"], e["to"]): e["type"] for e in figure["edges"]}
        self.assertEqual(edges[("attempt:1", "attempt:2")], "then")
        self.assertEqual(edges[("attempt:3", "submission:3.1")], "then")
        self.assertEqual(edges[("submission:3.1", "submission:3.2")], "then")


if __name__ == "__main__":
    unittest.main()
