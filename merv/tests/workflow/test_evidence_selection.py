"""Which artifacts count as evidence, and for whom.

Two failures motivated these: reviewer hydration keyed on (role, path), so a
wave that wrote its five lens documents to one path showed the reviewer one
document; and the shared "preferred artifact" helper fell back to historical
latest, so a rejected prior attempt's project graph answered "what is the
current project graph?". The selectors are now named and the reviewer reads
the ids its snapshot pinned.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from merv.brain.workflows.definitions.documents import (
    current_slot_artifacts,
    latest_per_slot,
    sealed_submission_artifacts,
)
from tests.research_core.scenarios import complete_no_code_consolidation
from tests.support.brain import TestBrain

# All five lens documents share ONE path: the slot is (role, lens_id, path),
# so this is legal, current, and gate-passing — and it is exactly the shape a
# (role, path) reviewer key collapses.
SHARED_LENS_PATH = "project/lens_reflection.md"

LENS_IDS = ("amplify", "avoid", "entropy", "rigor", "cost")

VALID_PROJECT_GRAPH = (
    '{"version": 1, "title": "Project logic", "nodes": ['
    '{"id": "lesson", "kind": "lesson", "label": "LR schedule dominates"},'
    '{"id": "open", "kind": "open_question", "label": "Does it hold at scale?"}],'
    ' "edges": [{"from": "lesson", "to": "open", "label": "raises"}]}\n'
)

REJECTED_PROJECT_GRAPH = (
    '{"version": 1, "title": "Project logic", "nodes": ['
    '{"id": "lesson", "kind": "lesson", "label": "Optimizer choice dominates"},'
    '{"id": "open", "kind": "open_question", "label": "Is the effect real?"}],'
    ' "edges": [{"from": "lesson", "to": "open", "label": "raises"}]}\n'
)

VALID_REFLECTION_DOC = (
    "# Reflection\n\n"
    "## Summary\n"
    "The wave reconciles the lens reflections into the current project state.\n\n"
    "## Critical reading\n"
    "The LR-schedule direction remains live, while optimizer swaps compress as dead ends.\n\n"
    "## Decision / future directions\n"
    "Create a small parallel wave to test transfer and mechanism questions.\n"
)


def full_roster() -> list[dict[str, str]]:
    return [
        {"id": "amplify"},
        {"id": "avoid"},
        {"id": "entropy"},
        {
            "id": "rigor",
            "charter": "Methodological soundness of the experiments.",
            "why_distinct": "Judges how we measured, not what we found or skipped.",
        },
        {
            "id": "cost",
            "charter": "Compute spent vs information gained per experiment.",
            "why_distinct": "Prices the exploration; no core lens does.",
        },
    ]


def change_spec(*, suffix: str) -> str:
    return json.dumps(
        {
            "version": 1,
            "claim_changes": [
                {
                    "op": "create",
                    "key": f"claim_transfer_{suffix}",
                    "statement": f"The LR-schedule effect transfers at larger scale ({suffix}).",
                    "scope": "Toy evidence-selection project.",
                    "confidence": "medium",
                    "rationale": "The wave surfaced this as the next belief to test.",
                }
            ],
            "decision": {
                "type": "create_experiments",
                "experiments": [
                    {
                        "key": f"scale_check_{suffix}",
                        "name": f"scale-check-{suffix}",
                        "intent": "Test whether the LR-schedule effect transfers at larger scale.",
                        "tested_claim_refs": [f"claim_transfer_{suffix}"],
                        "parallelism": "Independent scale axis; no dependency on the other.",
                    },
                    {
                        "key": f"mechanism_probe_{suffix}",
                        "name": f"mechanism-probe-{suffix}",
                        "intent": "Probe whether clipping interaction explains the effect.",
                        "tested_claim_refs": [f"claim_transfer_{suffix}"],
                        "parallelism": "Independent mechanism axis; no dependency on the other.",
                    },
                ],
            },
        }
    )


class EvidenceSelectorTest(unittest.TestCase):
    """The three selectors mean three different things, and say so."""

    ROWS = [
        {"id": "a1", "role": "plan", "lens_id": "", "path": "p.md",
         "attempt_index": 1, "submission_id": "sub_1", "submitted_order": 1},
        {"id": "a2", "role": "report", "lens_id": "", "path": "r.md",
         "attempt_index": 1, "submission_id": "sub_2", "submitted_order": 2},
        {"id": "a3", "role": "report", "lens_id": "", "path": "r.md",
         "attempt_index": 2, "submission_id": "", "submitted_order": 3},
    ]

    def test_current_slot_is_this_attempt_only(self) -> None:
        kept = current_slot_artifacts(self.ROWS, attempt=2)
        self.assertEqual([row["id"] for row in kept], ["a3"])
        self.assertEqual(
            [row["id"] for row in current_slot_artifacts(self.ROWS, attempt=1)],
            ["a1", "a2"],
        )

    def test_sealed_submission_is_exactly_the_sealed_set(self) -> None:
        self.assertEqual(
            [row["id"] for row in sealed_submission_artifacts(self.ROWS, submission_id="sub_2")],
            ["a2"],
        )
        # An unsealed round has no id and must not widen to everything.
        self.assertEqual(sealed_submission_artifacts(self.ROWS, submission_id=""), [])

    def test_historical_latest_crosses_attempts_by_design(self) -> None:
        kept = latest_per_slot(self.ROWS)
        self.assertEqual([row["id"] for row in kept], ["a1", "a3"])


class ReflectionEvidenceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
        )
        self.project_id = self.call("project", action="create", name="Evidence")["id"]

    def tearDown(self) -> None:
        self.tmp.cleanup()
        self.app.shutdown()

    def call(self, tool_name: str, **kwargs):
        return self.app.call_tool(tool_name, kwargs)

    # ---- helpers ----

    def _submit(self, *, syn_id: str, role: str, path: str, body: str, lens_id: str = "") -> str:
        return str(
            self.app.submit_artifact(
                project_id=self.project_id,
                target_type="reflection",
                target_id=syn_id,
                role=role,
                path=path,
                body=body,
                lens_id=lens_id,
            )["artifact_id"]
        )

    def _transition(self, *, syn_id: str, transition: str) -> dict:
        return self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=syn_id,
            transition=transition,
        )

    def _submit_lens_docs(self, *, syn_id: str, round_label: str) -> dict[str, str]:
        return {
            lens_id: self._submit(
                syn_id=syn_id,
                role="reflection_lens_doc",
                path=SHARED_LENS_PATH,
                body=(
                    f"# {lens_id}\n\n## Summary\n"
                    f"Findings through the {lens_id} lens ({round_label}).\n"
                ),
                lens_id=lens_id,
            )
            for lens_id in LENS_IDS
        }

    def _drive_to_review(
        self, *, syn_id: str, graph: str, suffix: str, round_label: str = "r1"
    ) -> dict[str, str]:
        lens_ids = self._submit_lens_docs(syn_id=syn_id, round_label=round_label)
        self._transition(syn_id=syn_id, transition="submit_reflections")
        self._submit(
            syn_id=syn_id, role="project_graph", path="project/logic_graph.json", body=graph
        )
        self._submit(
            syn_id=syn_id,
            role="reflection_doc",
            path="project/reflection.md",
            body=VALID_REFLECTION_DOC,
        )
        self._submit(
            syn_id=syn_id,
            role="change_spec",
            path="project/change_spec.json",
            body=change_spec(suffix=suffix),
        )
        self._transition(syn_id=syn_id, transition="submit_reflection_artifacts")
        return lens_ids

    def _review(self, *, syn_id: str, verdict: str, return_to: str = "") -> None:
        session = self._review_session(syn_id=syn_id)
        payload = {
            "review_session_id": session["review_session_id"],
            "verdict": verdict,
            "synopsis": "The wave's evidence was read end to end before this verdict.",
        }
        if return_to:
            payload["return_to"] = return_to
        self.call("review.submit", **payload)

    def _review_session(self, *, syn_id: str) -> dict:
        request = self.call(
            "review.request",
            project_id=self.project_id,
            target_type="reflection",
            target_id=syn_id,
            role="reflection_reviewer",
        )
        return self.call(
            "review.start",
            review_request_id=request["review_request_id"],
            reviewer_capability=request["reviewer_capability"],
            caller_session_id="reflection-reviewer",
        )

    def _create_wave(self, *, title: str) -> str:
        return self.call(
            "reflection.create",
            project_id=self.project_id,
            title=title,
            lenses=full_roster(),
        )["id"]

    def _current_project_graph(self) -> dict:
        return self.app._client.get(
            f"/api/projects/{self.project_id}/reflections/current/graph"
        ).json()

    # ---- ART-01 ----

    def test_five_lens_documents_reach_the_reviewer_as_five_documents(self) -> None:
        syn_id = self._create_wave(title="Lens hydration")
        lens_ids = self._drive_to_review(
            syn_id=syn_id, graph=VALID_PROJECT_GRAPH, suffix="a"
        )
        session = self._review_session(syn_id=syn_id)

        self.assertEqual(
            session["project_context"]["project"]["id"], self.project_id
        )
        self.assertEqual(session["reflection_context"]["id"], syn_id)
        # The reviewer grades against the roster and corpus; the documents
        # themselves ride once, in submitted_artifacts.
        self.assertEqual(set(session["reflection_context"]),
                         {"id", "title", "status", "attempt_index", "revision_context", "roster",
                          "reflection_coverage", "corpus", "consolidation"})
        self.assertNotIn("workflow_context", session)

        lens_docs = [
            item
            for item in session["submitted_artifacts"]
            if item["role"] == "reflection_lens_doc"
        ]
        self.assertEqual(
            sorted(item["lens_id"] for item in lens_docs),
            sorted(LENS_IDS),
            "every lens the wave submitted must be its own reviewer document",
        )
        self.assertEqual(
            {item["artifact_id"] for item in lens_docs},
            set(lens_ids.values()),
        )
        for item in lens_docs:
            self.assertIn(item["lens_id"], item["content"])
            self.assertEqual(item["path"], SHARED_LENS_PATH)

        # The rest of the pinned round is still there, including the documents
        # sealed by an earlier round of the same attempt.
        by_role = {item["role"] for item in session["submitted_artifacts"]}
        self.assertEqual(
            by_role,
            {"reflection_lens_doc", "project_graph", "reflection_doc", "change_spec"},
        )

    def test_reviewer_evidence_carries_the_round_that_sealed_it(self) -> None:
        syn_id = self._create_wave(title="Round provenance")
        self._drive_to_review(syn_id=syn_id, graph=VALID_PROJECT_GRAPH, suffix="b")
        session = self._review_session(syn_id=syn_id)
        rounds = {
            item["role"]: item["submission_id"]
            for item in session["submitted_artifacts"]
        }
        self.assertTrue(all(rounds.values()), rounds)
        self.assertNotEqual(
            rounds["reflection_lens_doc"],
            rounds["project_graph"],
            "the fan-out and the reconciliation are two rounds of one attempt",
        )

    # ---- ART-06 ----

    def test_rejected_prior_attempt_graph_is_not_the_current_project_graph(self) -> None:
        published = self._create_wave(title="Published wave")
        self._drive_to_review(syn_id=published, graph=VALID_PROJECT_GRAPH, suffix="c")
        self._review(syn_id=published, verdict="pass")
        complete_no_code_consolidation(
            app=self.app,
            project_id=self.project_id,
            reflection_id=published,
        )

        # A new wave's graph is rejected back to the fan-out, which bumps the
        # attempt: nothing in the open attempt is a project graph any more.
        reopened = self._create_wave(title="Reopened wave")
        self._drive_to_review(
            syn_id=reopened, graph=REJECTED_PROJECT_GRAPH, suffix="d", round_label="r1"
        )
        rejected_graph_id = self.call(
            "reflection.get", project_id=self.project_id, reflection_id=reopened
        )["current_attempt_artifacts"]
        rejected_graph_id = next(
            item["id"] for item in rejected_graph_id if item["role"] == "project_graph"
        )
        self._review(syn_id=reopened, verdict="needs_changes", return_to="reflecting")

        state = self.call(
            "reflection.get", project_id=self.project_id, reflection_id=reopened
        )
        self.assertEqual(state["status"], "reflecting")
        self.assertEqual(state["attempt_index"], 2)

        current = self._current_project_graph()
        self.assertTrue(current["available"])
        self.assertNotEqual(
            current["artifact_id"],
            rejected_graph_id,
            "a graph a reviewer rejected must not answer 'what is current'",
        )
        self.assertEqual(current["reflection"]["id"], published)
        self.assertEqual(current["graph"]["nodes"][0]["label"], "LR schedule dominates")

    def test_a_wave_with_no_graph_in_the_open_attempt_shows_none_of_its_own(self) -> None:
        syn_id = self._create_wave(title="No published predecessor")
        self._drive_to_review(syn_id=syn_id, graph=REJECTED_PROJECT_GRAPH, suffix="e")
        self._review(syn_id=syn_id, verdict="needs_changes", return_to="reflecting")

        wave_graph = self.app._client.get(
            f"/api/projects/{self.project_id}/reflections/{syn_id}/graph"
        ).json()
        self.assertFalse(wave_graph["available"])
        self.assertFalse(self._current_project_graph()["available"])


if __name__ == "__main__":
    unittest.main()
