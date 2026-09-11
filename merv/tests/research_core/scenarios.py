from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from tests.support.brain import TestBrain


VALID_PLAN = """\
## Summary
Compare a candidate with the baseline.

## Objective & hypothesis
The candidate should improve accuracy.

## Evaluation
Compare accuracy; pass if it exceeds 0.60.
"""

VALID_REPORT = """\
## Summary
The candidate was evaluated against the baseline.

## Results

The system record of this attempt is [metrics_exhibit.json](metrics_exhibit.json);
the table below reads it.

| Metric | Target | Achieved |
|--------|--------|----------|
| accuracy | 0.60 | 0.72 |

## Deviations from plan
None.

## Conclusion
The registered threshold was met.
"""

VALID_GRAPH = json.dumps(
    {
        "version": 1,
        "nodes": [
            {"id": "objective", "kind": "objective", "label": "Beat baseline"},
            {"id": "result", "kind": "outcome", "label": "Accuracy reached 0.72"},
        ],
        "edges": [{"from": "objective", "to": "result", "label": "confirmed by"}],
    }
)

VALID_PROJECT_GRAPH = json.dumps(
    {
        "version": 1,
        "title": "Project logic",
        "nodes": [
            {"id": "lesson", "kind": "lesson", "label": "Schedule matters"},
            {
                "id": "question",
                "kind": "open_question",
                "label": "Does it transfer?",
            },
        ],
        "edges": [{"from": "lesson", "to": "question", "label": "raises"}],
    }
)

VALID_REFLECTION = """\
# Reflection

## Summary
The wave reconciles the five readings into the current project state.

## Critical reading
The schedule result is promising, but transfer remains untested.

## Decision / future directions
Run one focused transfer experiment.
"""

VALID_CHANGE_SPEC = json.dumps(
    {
        "version": 1,
        "claim_changes": [
            {
                "op": "create",
                "key": "transfer",
                "statement": "The schedule effect transfers.",
                "scope": "This project.",
                "confidence": "medium",
                "rationale": "The reflection identified transfer as the next question.",
            }
        ],
        "decision": {
            "type": "create_experiments",
            "experiments": [
                {
                    "key": "transfer_test",
                    "name": "transfer-test",
                    "intent": "Test transfer on a held-out setting.",
                    "tested_claim_refs": ["transfer"],
                }
            ],
        },
    }
)

LENSES = (
    {"id": "amplify"},
    {"id": "avoid"},
    {"id": "entropy"},
    {
        "id": "rigor",
        "charter": "Check methodological soundness.",
        "why_distinct": "It judges measurement quality.",
    },
    {
        "id": "cost",
        "charter": "Compare compute cost with information gained.",
        "why_distinct": "It prices the exploration.",
    },
)

REVIEW_SYNOPSIS = (
    "The submitted evidence supports the stated decision, and the attempt "
    "can advance without hiding a material qualification."
)


def complete_no_code_consolidation(
    *, app: TestBrain, project_id: str, reflection_id: str
) -> dict[str, Any]:
    """Publish a reviewed reflection through the real no-code consolidation gate."""

    def call(tool: str, **arguments: Any) -> dict[str, Any]:
        return app.call_tool(tool, arguments)

    packet = app.application.consolidation(
        project_id=project_id,
        reflection_id=reflection_id,
    )
    app.application.submit_consolidation(
        project_id=project_id,
        reflection_id=reflection_id,
        base_sha="1" * 40,
        proposal_sha="2" * 40,
        summary="The reviewed research changes no tracked source files.",
        validation={"tests": "not_applicable"},
        decisions=[
            {
                "experiment_id": experiment["id"],
                "disposition": "reviewed_not_used",
                "rationale": "This experiment produced no promotable source change.",
                "integration_kind": "none",
            }
            for experiment in packet["experiments"]
        ],
        producer_session_id="consolidator",
    )
    request = call(
        "review.request",
        project_id=project_id,
        target_type="reflection",
        target_id=reflection_id,
        role="consolidation_reviewer",
        producer_session_id="consolidator",
    )
    session = call(
        "review.start",
        review_request_id=request["review_request_id"],
        reviewer_capability=request["reviewer_capability"],
        caller_session_id="independent-consolidation-reviewer",
    )
    call(
        "review.submit",
        review_session_id=session["review_session_id"],
        verdict="pass",
        synopsis=REVIEW_SYNOPSIS,
    )
    advance = app.research.reflections.prepare_advance(
        project_id=project_id,
        reflection_id=reflection_id,
        runner_id="runner",
    )
    return app.research.reflections.settle_advance(
        project_id=project_id,
        advance_id=advance["id"],
        runner_id="runner",
        observed_sha="2" * 40,
        proposal_parents=["1" * 40],
        diffstat={
            "commit_count": 0,
            "files_changed": 0,
            "insertions": 0,
            "deletions": 0,
        },
        ancestry={},
    )


class ResearchCase(unittest.TestCase):
    app: TestBrain
    project_id: str

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
        )
        self.project_id = self.call(
            "project", action="create", name=self.__class__.__name__
        )["id"]

    def tearDown(self) -> None:
        self.app.shutdown()
        self.tmp.cleanup()

    def call(self, tool: str, **arguments: Any) -> dict[str, Any]:
        return self.app.call_tool(tool, arguments)

    def submit(
        self,
        *,
        target_type: str,
        target_id: str,
        role: str,
        body: str,
        path: str | None = None,
        lens_id: str = "",
    ) -> str:
        result = self.app.submit_artifact(
            project_id=self.project_id,
            target_type=target_type,
            target_id=target_id,
            role=role,
            path=path or f"{role}.md",
            body=body,
            lens_id=lens_id,
        )
        return str(result["artifact_id"])

    def create_experiment(self, name: str = "experiment") -> str:
        return str(
            self.call(
                "experiment.create",
                project_id=self.project_id,
                name=name,
                intent="Test the registered claim.",
            )["id"]
        )

    def transition_experiment(
        self, experiment_id: str, transition: str
    ) -> dict[str, Any]:
        return self.call(
            "experiment.transition",
            project_id=self.project_id,
            experiment_id=experiment_id,
            transition=transition,
        )

    def pass_review(
        self, *, target_type: str, target_id: str, role: str
    ) -> dict[str, Any]:
        return self.review(
            target_type=target_type,
            target_id=target_id,
            role=role,
            verdict="pass",
        )

    def review(
        self,
        *,
        target_type: str,
        target_id: str,
        role: str,
        verdict: str,
        return_to: str = "",
        producer_session_id: str = "producer",
    ) -> dict[str, Any]:
        request = self.call(
            "review.request",
            project_id=self.project_id,
            target_type=target_type,
            target_id=target_id,
            role=role,
            producer_session_id=producer_session_id,
        )
        session = self.call(
            "review.start",
            review_request_id=request["review_request_id"],
            reviewer_capability=request["reviewer_capability"],
            caller_session_id="independent-reviewer",
        )
        arguments: dict[str, Any] = {
            "review_session_id": session["review_session_id"],
            "verdict": verdict,
            "synopsis": REVIEW_SYNOPSIS,
        }
        if return_to:
            arguments["return_to"] = return_to
        return self.call("review.submit", **arguments)

    def drive_experiment_to_running(self, name: str = "experiment") -> str:
        experiment_id = self.create_experiment(name)
        self.submit(
            target_type="experiment",
            target_id=experiment_id,
            role="plan",
            path="plan.md",
            body=VALID_PLAN,
        )
        self.transition_experiment(experiment_id, "submit_design")
        self.pass_review(
            target_type="experiment",
            target_id=experiment_id,
            role="design_reviewer",
        )
        self.assertEqual(self.app.research.experiments.get_state(project_id=self.project_id, experiment_id=experiment_id).status, "running")
        return experiment_id

    def drive_experiment_to_review(self, name: str = "experiment") -> str:
        experiment_id = self.drive_experiment_to_running(name)
        for role, path, body in (
            ("result", "results.json", '{"accuracy": 0.72}'),
            ("report", "report.md", VALID_REPORT),
            ("graph", "graph.json", VALID_GRAPH),
        ):
            self.submit(
                target_type="experiment",
                target_id=experiment_id,
                role=role,
                path=path,
                body=body,
            )
        self.transition_experiment(experiment_id, "submit_results")
        return experiment_id

    def create_reflection(self, title: str = "Reflection") -> str:
        return str(
            self.call(
                "reflection.create",
                project_id=self.project_id,
                title=title,
                lenses=[dict(lens) for lens in LENSES],
            )["id"]
        )

    def submit_lenses(self, reflection_id: str) -> None:
        for lens in LENSES:
            lens_id = str(lens["id"])
            self.submit(
                target_type="reflection",
                target_id=reflection_id,
                role="reflection_lens_doc",
                path=f"reflections/{lens_id}.md",
                lens_id=lens_id,
                body=(
                    f"# {lens_id}\n\n## Summary\n"
                    f"The {lens_id} reading identifies a concrete project signal."
                ),
            )

    def submit_reflection_bundle(
        self,
        reflection_id: str,
        *,
        graph: str = VALID_PROJECT_GRAPH,
        reflection: str = VALID_REFLECTION,
        change_spec: str = VALID_CHANGE_SPEC,
    ) -> None:
        for role, path, body in (
            ("project_graph", "project/logic_graph.json", graph),
            ("reflection_doc", "project/reflection.md", reflection),
            ("change_spec", "project/change_spec.json", change_spec),
        ):
            self.submit(
                target_type="reflection",
                target_id=reflection_id,
                role=role,
                path=path,
                body=body,
            )

    def drive_reflection_to_review(self, title: str = "Reflection") -> str:
        reflection_id = self.create_reflection(title)
        self.submit_lenses(reflection_id)
        self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=reflection_id,
            transition="submit_reflections",
        )
        self.submit_reflection_bundle(reflection_id)
        self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=reflection_id,
            transition="submit_reflection_artifacts",
        )
        return reflection_id

    def consolidate_and_publish(self, reflection_id: str) -> dict[str, Any]:
        """Complete the post-reflection code gate with a no-code proposal."""
        return complete_no_code_consolidation(
            app=self.app,
            project_id=self.project_id,
            reflection_id=reflection_id,
        )
