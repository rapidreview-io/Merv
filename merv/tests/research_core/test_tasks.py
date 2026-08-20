from __future__ import annotations

import json

from merv.brain.kernel.utils import NotFoundError, ValidationError, WorkflowError
from merv.brain.research_core.dependencies import record_dependencies
from merv.brain.research_core.evidence import (
    brief_checks,
    delivery_entry_parts,
    delivery_results,
    delivery_section,
    render_task_brief,
)
from merv.brain.research_core.task_workflow import TASK_WORKFLOW

from .scenarios import VALID_CHANGE_SPEC, VALID_PLAN, ResearchCase


DELIVERABLES = [
    "train/val/test parquet files exist under out/ with row counts matching the data card",
    'check_overlap.py prints "0 overlapping ids" when run from the task folder',
    "out/DATA_CARD.md records source, license, and preprocessing",
]

VALID_DELIVERY = """\
# Delivery: prep-data

## Confirmations
1. out/{train,val,test}.parquet with 41 200 / 5 150 / 5 150 rows — how to check: ls out/ and open the data card's row-count table
2. check_overlap.py printed "0 overlapping ids" (receipt in the sandbox run log) — how to check: rerun it from the task folder
3. out/DATA_CARD.md written — how to check: open it; source, license, preprocessing sections are filled

## Notes
Splits drawn with a seeded permutation; the card lists the seed. The val/test
split predates the dedup fix; see the data card before trusting it downstream.
"""

# The pre-schema section names still parse (older tasks on real brains).
LEGACY_DELIVERY = """\
## Checks
1. [x] out/train.parquet exists — how to check: ls out/
2. [ ] overlap receipt missing — how to check: rerun check_overlap.py
3. not delivered — the data card is blocked on the license question

## Report
Legacy report prose.

## Caveats
Legacy caveat prose.
"""

SHORT_DELIVERY = """\
## Confirmations
1. splits exist — how to check: ls out/

## Notes
none
"""

class TaskWorkflowTest(ResearchCase):
    def create_task(self, name: str = "prep-data", **extra) -> str:
        return str(
            self.call(
                "task.create",
                project_id=self.project_id,
                name=name,
                goal="Prepare dataset D with clean, deduplicated splits so "
                "the distill experiments train on identical data.",
                deliverables=extra.pop("deliverables", None) or DELIVERABLES,
                **extra,
            )["id"]
        )

    def transition_task(self, task_id: str, transition: str, **evidence):
        arguments = {
            "project_id": self.project_id,
            "task_id": task_id,
            "transition": transition,
        }
        if evidence:
            arguments["evidence"] = evidence
        return self.call("task.transition", **arguments)

    def submit_task_docs(self, task_id: str, *, delivery: str = VALID_DELIVERY) -> None:
        # The brief is rendered and pinned at create; only the delivery is authored.
        self.submit(
            target_type="task",
            target_id=task_id,
            role="delivery",
            path="tasks/prep-data/delivery.md",
            body=delivery,
        )

    def task_status(self, task_id: str) -> dict:
        return self.call(
            "workflow.status_and_next", project_id=self.project_id, task_id=task_id
        )

    # ---- lifecycle ----

    def test_full_lifecycle_is_gated_and_records_transitions(self) -> None:
        task_id = self.create_task()
        state = self.call("task.get_state", project_id=self.project_id, task_id=task_id)
        self.assertEqual(state["status"], TASK_WORKFLOW.initial)
        self.assertNotIn("tested_claims", state)

        status = self.task_status(task_id)
        self.assertEqual(status["scope"], "task")
        # The brief is rendered and pinned at create — the first gate is the
        # delivery, and the goal is immutable: brief submissions are refused.
        self.assertEqual(status["workflow"]["current_gate"], "delivery_required")
        self.assertEqual(
            status["workflow"]["artifact_guidance"]["checks"],
            self.call("task.get_state", project_id=self.project_id, task_id=task_id)[
                "checks"
            ],
        )
        self.assertEqual(len(status["task"]["checks"]), 3)
        self.assertEqual(status["task"]["deliverables"], DELIVERABLES)
        rendered = status["context"]["brief"]["content"]
        self.assertIn("## Goal", rendered)
        self.assertIn("## Deliverables", rendered)
        self.assertIn(DELIVERABLES[0], rendered)
        with self.assertRaisesRegex(ValidationError, "immutable goal"):
            self.submit(
                target_type="task",
                target_id=task_id,
                role="brief",
                path="tasks/prep-data/brief.md",
                body="# Brief\n\n## Goal\nrewritten\n\n## Deliverables\n1. x\n",
            )

        # A delivery that skips deliverables 2 and 3 is shape-invalid.
        self.submit(
            target_type="task",
            target_id=task_id,
            role="delivery",
            path="tasks/prep-data/delivery.md",
            body=SHORT_DELIVERY,
        )
        with self.assertRaisesRegex(WorkflowError, "missing entries for deliverable"):
            self.transition_task(task_id, "submit_delivery")
        status = self.task_status(task_id)
        self.assertEqual(status["workflow"]["next_action"], "fix_delivery_artifact")

        self.submit(
            target_type="task",
            target_id=task_id,
            role="delivery",
            path="tasks/prep-data/delivery.md",
            body=VALID_DELIVERY,
        )
        status = self.task_status(task_id)
        self.assertEqual(status["workflow"]["current_gate"], "task_review_required")
        self.assertIn("submit_delivery_for_review", status["workflow"]["next_action"])

        receipt = self.transition_task(task_id, "submit_delivery")
        self.assertEqual(receipt["status"], "in_review")
        self.assertEqual(receipt["from_status"], "in_progress")
        status = self.task_status(task_id)
        self.assertEqual(status["workflow"]["next_action"], "launch_task_reviewer")
        self.assertEqual(status["workflow"]["review_gate"]["skill"], "task-review")
        self.assertEqual(status["workflow"]["review_gate"]["role"], "task_reviewer")

        with self.assertRaises(WorkflowError):
            self.transition_task(task_id, "accept")

        self.pass_review(target_type="task", target_id=task_id, role="task_reviewer")
        status = self.task_status(task_id)
        self.assertEqual(status["workflow"]["next_action"], "accept_task")

        accepted = self.transition_task(
            task_id, "accept", outcome="Splits ready; see the data card."
        )
        self.assertEqual(accepted["status"], "done")
        state = self.call("task.get_state", project_id=self.project_id, task_id=task_id)
        self.assertEqual(state["outcome"], "Splits ready; see the data card.")
        self.assertEqual(state["failed_by"], "")
        self.assertEqual(state["allowed_transitions"], [])
        self.assertEqual(self.task_status(task_id)["workflow"]["current_gate"], "terminal")

        with self.app.store.connect() as conn:
            events = conn.execute(
                "SELECT payload_json FROM events WHERE target_id = ? AND type = ? ORDER BY id",
                (task_id, TASK_WORKFLOW.event_type),
            ).fetchall()
            sealed = conn.execute(
                "SELECT COUNT(*) AS n FROM artifacts WHERE target_id = ? AND submission_id <> ''",
                (task_id,),
            ).fetchone()["n"]
        self.assertEqual(
            [json.loads(row["payload_json"])["transition"] for row in events],
            ["submit_delivery", "accept"],
        )
        self.assertGreater(sealed, 0)
        # Closed tasks refuse late artifacts.
        with self.assertRaises(ValidationError):
            self.submit(
                target_type="task",
                target_id=task_id,
                role="delivery",
                path="tasks/prep-data/delivery.md",
                body=VALID_DELIVERY,
            )

    def test_needs_changes_returns_to_in_progress_on_the_same_attempt(self) -> None:
        task_id = self.create_task()
        self.submit_task_docs(task_id)
        self.transition_task(task_id, "submit_delivery")
        review = self.review(
            target_type="task",
            target_id=task_id,
            role="task_reviewer",
            verdict="needs_changes",
        )
        self.assertEqual(review["return_to"], "in_progress")
        state = self.call("task.get_state", project_id=self.project_id, task_id=task_id)
        self.assertEqual(state["status"], "in_progress")
        self.assertEqual(state["attempt_index"], 1)
        self.assertIn("task_reviewer returned needs_changes", state["revision_context"])
        self.assertIn("Done-when checks", state["revision_context"])
        status = self.task_status(task_id)
        self.assertEqual(status["workflow"]["current_gate"], "task_review_required")
        self.assertTrue(status["workflow"]["revision_context"])

        # A fresh delivery, a fresh review, and the task completes.
        self.submit(
            target_type="task",
            target_id=task_id,
            role="delivery",
            path="tasks/prep-data/delivery.md",
            body=VALID_DELIVERY + "\nRevised after review.\n",
        )
        self.transition_task(task_id, "submit_delivery")
        self.pass_review(target_type="task", target_id=task_id, role="task_reviewer")
        self.assertEqual(self.transition_task(task_id, "accept")["status"], "done")

    def test_fail_verdict_ends_the_task(self) -> None:
        task_id = self.create_task()
        self.submit_task_docs(task_id)
        self.transition_task(task_id, "submit_delivery")
        with self.assertRaisesRegex(ValidationError, "ends the task"):
            self.review(
                target_type="task",
                target_id=task_id,
                role="task_reviewer",
                verdict="fail",
                return_to="in_progress",
            )
        review = self.review(
            target_type="task", target_id=task_id, role="task_reviewer", verdict="fail"
        )
        self.assertEqual(review["return_to"], "failed")
        state = self.call("task.get_state", project_id=self.project_id, task_id=task_id)
        self.assertEqual(state["status"], "failed")
        self.assertEqual(state["failed_by"], "reviewer")
        self.assertIn("task_reviewer returned fail", state["outcome"])
        with self.assertRaisesRegex(WorkflowError, "terminal"):
            self.transition_task(task_id, "submit_delivery")

    def test_owner_can_withdraw_with_a_reason(self) -> None:
        task_id = self.create_task()
        receipt = self.transition_task(
            task_id, "mark_failed", reason="The dataset license forbids this use."
        )
        self.assertEqual(receipt["status"], "failed")
        state = self.call("task.get_state", project_id=self.project_id, task_id=task_id)
        self.assertEqual(state["failed_by"], "owner")
        self.assertEqual(state["outcome"], "The dataset license forbids this use.")

    # ---- creation rules ----

    def test_names_are_folder_safe_and_unique_and_claims_are_not_a_field(self) -> None:
        self.create_task("prep-data")
        with self.assertRaisesRegex(ValidationError, "already exists"):
            self.create_task("PREP-DATA")
        with self.assertRaisesRegex(ValidationError, "folder name"):
            self.create_task("bad name!")
        with self.assertRaisesRegex(ValidationError, "goal is required"):
            self.call("task.create", project_id=self.project_id, name="no-goal", goal="")
        with self.assertRaises(ValidationError):
            self.call(
                "task.create",
                project_id=self.project_id,
                name="claimed",
                goal="A goal.",
                tested_claim_ids=["claim_x"],
            )

    def test_project_status_lists_live_tasks(self) -> None:
        task_id = self.create_task()
        status = self.call("workflow.status_and_next", project_id=self.project_id)
        self.assertEqual(status["scope"], "project")
        self.assertEqual(status["workflow"]["current_gate"], "live_experiments")
        self.assertEqual(
            [row["id"] for row in status["workflow"]["live_tasks"]], [task_id]
        )
        self.assertIn("task.create", status["workflow"]["allowed_actions"])
        self.assertEqual(
            [row["id"] for row in status["context"]["tasks"]], [task_id]
        )

    # ---- dependencies ----

    def test_task_waits_on_its_dependencies(self) -> None:
        upstream = self.create_task("download-raw")
        downstream = self.create_task("prep-data", depends_on=[upstream])
        self.submit_task_docs(downstream)
        status = self.task_status(downstream)
        self.assertEqual(status["workflow"]["current_gate"], "dependencies_pending")
        self.assertIn("wait_for_dependencies", status["workflow"]["next_action"])
        self.assertEqual(status["workflow"]["dependencies"][0]["id"], upstream)
        with self.assertRaisesRegex(WorkflowError, "waiting on unfinished dependencies"):
            self.transition_task(downstream, "submit_delivery")

        # Finish the upstream task; the downstream gate opens.
        self.submit(
            target_type="task", target_id=upstream, role="delivery",
            path="tasks/download-raw/delivery.md", body=VALID_DELIVERY,
        )
        self.transition_task(upstream, "submit_delivery")
        self.pass_review(target_type="task", target_id=upstream, role="task_reviewer")
        self.transition_task(upstream, "accept")
        self.assertEqual(
            self.transition_task(downstream, "submit_delivery")["status"], "in_review"
        )

    def test_failed_dependency_is_reported_and_cycles_are_refused(self) -> None:
        upstream = self.create_task("download-raw")
        downstream = self.create_task("prep-data", depends_on=[upstream])
        self.transition_task(upstream, "mark_failed", reason="source gone")
        self.submit_task_docs(downstream)
        status = self.task_status(downstream)
        self.assertEqual(status["workflow"]["current_gate"], "dependency_failed")
        self.assertIn("mark_task_failed", status["workflow"]["next_action"])
        with self.assertRaisesRegex(WorkflowError, "ended without succeeding"):
            self.transition_task(downstream, "submit_delivery")
        with self.assertRaisesRegex(ValidationError, "cannot depend on itself"):
            with self.app.store.transaction() as conn:
                record_dependencies(
                    conn=conn,
                    project_id=self.project_id,
                    node_id=upstream,
                    depends_on_ids=[upstream],
                )
        with self.assertRaisesRegex(ValidationError, "dependency cycle"):
            with self.app.store.transaction() as conn:
                record_dependencies(
                    conn=conn,
                    project_id=self.project_id,
                    node_id=upstream,
                    depends_on_ids=[downstream],
                )
        with self.assertRaisesRegex(NotFoundError, "dependency not found"):
            self.create_task("dangling", depends_on=["task_000000000000"])

    def test_experiment_waits_on_a_task(self) -> None:
        task_id = self.create_task("prep-data")
        experiment_id = str(
            self.call(
                "experiment.create",
                project_id=self.project_id,
                name="uses-prepped-data",
                intent="Train on the prepared splits.",
                depends_on=[task_id],
            )["id"]
        )
        self.submit(
            target_type="experiment", target_id=experiment_id, role="plan",
            path="plan.md", body=VALID_PLAN,
        )
        self.transition_experiment(experiment_id, "submit_design")
        self.pass_review(
            target_type="experiment", target_id=experiment_id, role="design_reviewer"
        )
        self.transition_experiment(experiment_id, "mark_ready_to_run")
        status = self.call(
            "workflow.status_and_next",
            project_id=self.project_id,
            experiment_id=experiment_id,
        )
        self.assertEqual(status["workflow"]["current_gate"], "dependencies_pending")
        with self.assertRaisesRegex(WorkflowError, "waiting on unfinished dependencies"):
            self.transition_experiment(experiment_id, "start_running")

        self.submit_task_docs(task_id)
        self.transition_task(task_id, "submit_delivery")
        self.pass_review(target_type="task", target_id=task_id, role="task_reviewer")
        self.transition_task(task_id, "accept")
        self.assertEqual(
            self.transition_experiment(experiment_id, "start_running")["status"],
            "running",
        )

    # ---- document structure ----

    def test_document_parsers_and_rendered_brief(self) -> None:
        # The rendered brief: Goal prose + numbered Deliverables.
        brief = render_task_brief(
            {"name": "prep-data", "goal": "Prose goal.", "deliverables": ["a", "b"]}
        )
        self.assertIn("## Goal", brief)
        self.assertIn("## Deliverables", brief)
        self.assertEqual(brief_checks(brief), ["a", "b"])
        # Legacy proposals may still carry done_when; legacy briefs still read.
        legacy = render_task_brief(
            {"name": "old", "goal": "Prose.", "done_when": ["x"]}
        )
        self.assertEqual(brief_checks(legacy), ["x"])
        self.assertEqual(
            brief_checks("## Goal\ng\n\n## Done when\n1. legacy check\n"),
            ["legacy check"],
        )

        met = delivery_entry_parts(1, "[x] 9,409 rows — how to check: python check.py")
        self.assertEqual((met["state"], met["evidence"], met["how"]), ("met", "9,409 rows", "python check.py"))
        miss = delivery_entry_parts(2, "not delivered — the license question is open")
        self.assertEqual(miss["state"], "unmet")
        self.assertIn("license question", miss["evidence"])
        implicit = delivery_entry_parts(3, "out/DATA_CARD.md written")
        self.assertEqual(implicit["state"], "met")

        # Confirmations is the section; Checks still parses (legacy).
        results = delivery_results(VALID_DELIVERY, count=3)
        self.assertEqual([r["state"] for r in results], ["met", "met", "met"])
        legacy_results = delivery_results(LEGACY_DELIVERY, count=3)
        self.assertEqual([r["state"] for r in legacy_results], ["met", "unmet", "unmet"])
        self.assertTrue(delivery_section(VALID_DELIVERY, "notes").startswith("Splits drawn"))
        self.assertTrue(delivery_section(LEGACY_DELIVERY, "report").startswith("Legacy report"))
        self.assertTrue(delivery_section(LEGACY_DELIVERY, "caveats").startswith("Legacy caveat"))

    def test_state_carries_deliverables_results_and_dependents(self) -> None:
        task_id = self.create_task("prep-data")
        downstream = self.create_task("train-on-splits", depends_on=[task_id])
        rich = self.app.application.task(
            task_id=task_id, project_id=self.project_id, rich=True
        )
        # The goal's contract is structure from creation.
        self.assertEqual(rich["deliverables"], DELIVERABLES)
        self.assertEqual(rich["checks"], DELIVERABLES)
        self.assertNotIn("deliverables_json", rich)
        self.assertEqual(rich["results"], [])
        self.assertEqual([d["id"] for d in rich["dependents"]], [downstream])
        self.assertEqual(rich["dependents"][0]["node_type"], "task")

        self.submit(
            target_type="task", target_id=task_id, role="delivery",
            path="tasks/prep-data/delivery.md", body=VALID_DELIVERY,
        )
        rich = self.app.application.task(
            task_id=task_id, project_id=self.project_id, rich=True
        )
        self.assertEqual([r["state"] for r in rich["results"]], ["met", "met", "met"])
        self.assertEqual(rich["results"][0]["how"], "ls out/ and open the data card's row-count table")
        self.assertTrue(rich["report"].startswith("Splits drawn"))
        # The UI's task-scoped status read carries the same detail; the agent's
        # slim status does not pay for it.
        status = self.app.application.status(project_id=self.project_id, task_id=task_id)
        self.assertEqual([r["state"] for r in status["task"]["results"]], ["met", "met", "met"])
        self.assertNotIn("results", self.task_status(task_id)["task"])
        slim = self.call("task.get_state", project_id=self.project_id, task_id=task_id)
        self.assertEqual(slim["deliverables"], DELIVERABLES)
        self.assertEqual([d["id"] for d in slim["dependents"]], [downstream])
        # Lists carry the contract but not the delivery read.
        listed = next(
            t for t in self.app.application.tasks(project_id=self.project_id, rich=True)
            if t["id"] == task_id
        )
        self.assertEqual(listed["deliverables"], DELIVERABLES)
        self.assertNotIn("results", listed)
        self.assertEqual([d["id"] for d in listed["dependents"]], [downstream])

        # Experiments carry the same reverse edges.
        exp_id = str(
            self.call(
                "experiment.create",
                project_id=self.project_id,
                name="uses-prep",
                intent="Consume the prepared splits.",
                depends_on=[task_id],
            )["id"]
        )
        exp_rich = self.app.application.experiment(
            experiment_id=exp_id, project_id=self.project_id, rich=True
        )
        self.assertEqual([d["id"] for d in exp_rich["dependencies"]], [task_id])
        self.assertEqual(exp_rich.get("dependents", []), [])

    def test_deliverables_are_required_and_bounded(self) -> None:
        with self.assertRaisesRegex(ValidationError, "deliverables is required"):
            self.call(
                "task.create", project_id=self.project_id,
                name="no-contract", goal="A goal with no contract.",
            )
        with self.assertRaisesRegex(ValidationError, "at least one item"):
            self.call(
                "task.create", project_id=self.project_id,
                name="empty-contract", goal="G.", deliverables=["", "  "],
            )
        with self.assertRaisesRegex(ValidationError, "too many"):
            self.call(
                "task.create", project_id=self.project_id,
                name="bloated", goal="G.", deliverables=[f"d{i}" for i in range(13)],
            )

    # ---- reflection ----

    def test_publish_materializes_tasks_with_pinned_briefs_and_edges(self) -> None:
        change_spec = json.loads(VALID_CHANGE_SPEC)
        change_spec["decision"]["tasks"] = [
            {
                "key": "prep",
                "name": "prep-data",
                "goal": "Prepare dataset D for the wave.",
                "done_when": [
                    "splits exist under out/ — verify: row counts",
                    "no id in more than one split — verify: run check_overlap.py",
                ],
                "scope": "No new data sources.",
            },
            {
                "key": "lit",
                "name": "lit-sweep",
                "goal": "Know what has been tried on data like D.",
                "done_when": ["at least 15 papers from 2023+ are summarized"],
                "depends_on": ["prep"],
            },
        ]
        change_spec["decision"]["experiments"][0]["depends_on"] = ["prep", "lit"]
        change_spec["decision"]["experiments"][0].pop("parallelism", None)

        reflection_id = self.create_reflection("Wave with tasks")
        self.submit_lenses(reflection_id)
        self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=reflection_id,
            transition="submit_reflections",
        )
        self.submit_reflection_bundle(reflection_id, change_spec=json.dumps(change_spec))
        self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=reflection_id,
            transition="submit_reflection_artifacts",
        )
        # The wave reserved the task names too.
        with self.assertRaisesRegex(ValidationError, "reserved by reflection wave"):
            self.create_task("prep-data")
        self.pass_review(
            target_type="reflection", target_id=reflection_id, role="reflection_reviewer"
        )
        published = self.consolidate_and_publish(reflection_id)
        self.assertEqual(published["status"], "published")
        materialized = {row["name"]: row for row in published["materialized_tasks"]}
        self.assertEqual(set(materialized), {"prep-data", "lit-sweep"})
        prep = self.call(
            "task.get_state",
            project_id=self.project_id,
            task_id=materialized["prep-data"]["task_id"],
        )
        self.assertEqual(prep["status"], "in_progress")
        self.assertEqual(len(prep["checks"]), 2)
        brief = next(a for a in prep["current_attempt_artifacts"] if a["role"] == "brief")
        self.assertEqual(brief["path"], "tasks/prep-data/brief.md")
        lit = self.call(
            "task.get_state",
            project_id=self.project_id,
            task_id=materialized["lit-sweep"]["task_id"],
        )
        self.assertEqual([d["id"] for d in lit["dependencies"]], [prep["id"]])
        experiment_id = published["materialized_experiments"][0]["experiment_id"]
        experiment = self.call(
            "experiment.get_state", project_id=self.project_id, experiment_id=experiment_id
        )
        self.assertEqual(
            sorted(d["id"] for d in experiment["dependencies"]),
            sorted([prep["id"], lit["id"]]),
        )
        # The task-scoped status shows the pinned brief and the delivery gate.
        status = self.task_status(prep["id"])
        self.assertEqual(status["workflow"]["current_gate"], "delivery_required")
        self.assertIn("## Deliverables", status["context"]["brief"]["content"])

    def test_change_spec_may_be_tasks_only_and_rejects_bad_task_specs(self) -> None:
        change_spec = json.loads(VALID_CHANGE_SPEC)
        change_spec["claim_changes"] = []
        change_spec["decision"]["experiments"] = []
        change_spec["decision"]["tasks"] = [
            {"key": "a", "name": "task-a", "goal": "g", "done_when": ["x"], "depends_on": ["b"]},
            {"key": "b", "name": "task-b", "goal": "g", "done_when": ["y"], "depends_on": ["a"]},
        ]
        reflection_id = self.create_reflection("Cyclic wave")
        self.submit_lenses(reflection_id)
        self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=reflection_id,
            transition="submit_reflections",
        )
        self.submit_reflection_bundle(reflection_id, change_spec=json.dumps(change_spec))
        with self.assertRaisesRegex(WorkflowError, "cycle"):
            self.call(
                "reflection.transition",
                project_id=self.project_id,
                reflection_id=reflection_id,
                transition="submit_reflection_artifacts",
            )
        change_spec["decision"]["tasks"][1]["depends_on"] = []
        self.submit_reflection_bundle(reflection_id, change_spec=json.dumps(change_spec))
        self.call(
            "reflection.transition",
            project_id=self.project_id,
            reflection_id=reflection_id,
            transition="submit_reflection_artifacts",
        )
        self.pass_review(
            target_type="reflection", target_id=reflection_id, role="reflection_reviewer"
        )
        published = self.consolidate_and_publish(reflection_id)
        self.assertEqual(len(published["materialized_tasks"]), 2)
        self.assertEqual(published["materialized_experiments"], [])
