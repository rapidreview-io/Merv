"""The record engine, exercised through each kind's own declaration.

Every case below is derived from the ``RecordKind`` and its graph, not written
out per kind: a new kind joins this suite by adding one ``Case`` row.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from merv.brain.kernel.utils import NotFoundError, ValidationError, WorkflowError
from merv.brain.workflows import ArtifactNeed, KINDS, RecordKind, Reference, ReviewGate

from .scenarios import VALID_PLAN, ResearchCase

DELIVERABLES = ["out/clean.parquet exists with the row count the data card states"]
GOAL = ("Prepare dataset D with clean, deduplicated splits so the distill "
        "experiments train on identical data.")
DELIVERY = """\
# Delivery: engine-task

## Confirmations
1. out/clean.parquet written with 41 200 rows — how to check: open the data card's row-count table

## Notes
Splits drawn with a seeded permutation; the card lists the seed.
"""


@dataclass(frozen=True)
class Case:
    """One kind under test: how to make one, and how to satisfy its first need."""

    kind: RecordKind
    create: Callable[[ResearchCase, str], str]
    label: str
    # The first document the initial state wants, and an action it does not gate.
    document: tuple[str, str, str] | None
    ungated_action: str
    # Everything the first forward action needs, then that action.
    prepare: Callable[[ResearchCase, str], None]
    advance: str
    advances_to: str

    @property
    def name(self) -> str:
        return self.kind.name


def _create_experiment(case: ResearchCase, name: str) -> str:
    return str(case.call("experiment.create", project_id=case.project_id, name=name,
                         intent="Test the registered claim.")["id"])


def _create_task(case: ResearchCase, name: str) -> str:
    return str(case.call("task.create", project_id=case.project_id, name=name, goal=GOAL,
                         deliverables=DELIVERABLES)["id"])


def _create_reflection(case: ResearchCase, name: str) -> str:
    return case.create_reflection(name)


def _submit(role: str, path: str, body: str):
    def prepare(case: ResearchCase, record_id: str) -> None:
        case.submit(target_type=case.kind_under_test, target_id=record_id, role=role, path=path, body=body)
    return prepare


CASES = (
    Case(KINDS["experiment"], _create_experiment, "name", ("plan", "plan.md", VALID_PLAN), "abandon",
         _submit("plan", "plan.md", VALID_PLAN), "submit_design", "design_review"),
    Case(KINDS["task"], _create_task, "name", None, "mark_failed",
         _submit("delivery", "tasks/delivery.md", DELIVERY), "submit_delivery", "in_review"),
    Case(KINDS["reflection"], _create_reflection, "title", None, "abandon",
         lambda case, record_id: case.submit_lenses(record_id), "submit_reflections", "synthesizing"),
)


class RecordEngineTest(ResearchCase):
    """One create/read/gate/commit path, checked against three declarations."""

    kind_under_test = ""

    def records(self):
        return self.app.research.records

    def create(self, case: Case, name: str) -> str:
        self.kind_under_test = case.name
        return case.create(self, name)

    def state(self, case: Case, record_id: str) -> dict[str, Any]:
        return self.records().get_state(case.kind, record_id=record_id, project_id=self.project_id)

    def test_create_writes_the_declared_spine_and_its_declared_event(self) -> None:
        for case in CASES:
            with self.subTest(kind=case.name):
                record_id = self.create(case, f"engine-{case.name}")
                self.assertTrue(record_id.startswith(f"{case.kind.id_prefix}_"))
                with self.app.store.connect() as conn:
                    row = dict(conn.execute(
                        f"SELECT * FROM {case.kind.table} WHERE id = ?", (record_id,)).fetchone())
                    events = [dict(item) for item in conn.execute(
                        "SELECT type, target_type FROM events WHERE target_id = ?", (record_id,)).fetchall()]
                self.assertEqual(row["status"], case.kind.workflow.initial)
                self.assertEqual(row["attempt_index"], 1)
                self.assertEqual(row["revision_context"], "")
                for column in case.kind.columns:
                    self.assertIn(column, row)
                self.assertIn((case.kind.created_event, case.name),
                              [(event["type"], event["target_type"]) for event in events])

    def test_state_carries_the_shared_read_model_for_every_kind(self) -> None:
        for case in CASES:
            with self.subTest(kind=case.name):
                state = self.state(case, self.create(case, f"read-{case.name}"))
                for key in ("artifacts", "current_attempt_artifacts", "submissions", "reviews",
                            "allowed_transitions", "gate_checklist"):
                    self.assertIn(key, state, key)
                for column, (field, _empty) in case.kind.json_columns.items():
                    self.assertNotIn(column, state)
                    self.assertIn(field, state)
                self.assertEqual(case.kind.dependencies, "dependencies" in state)
                self.assertEqual(case.kind.dependencies, "dependents" in state)

    def test_the_checklist_is_exactly_the_nodes_declared_requirements(self) -> None:
        for case in CASES:
            with self.subTest(kind=case.name):
                state = self.state(case, self.create(case, f"gate-{case.name}"))
                needs = case.kind.requirements(state["status"])
                expected = [f"{'artifact' if isinstance(need, ArtifactNeed) else 'review' if isinstance(need, ReviewGate) else 'record'}:{need.key}"
                            for need in needs]
                self.assertEqual([item["id"] for item in state["gate_checklist"]["items"]], expected)
                self.assertEqual(state["gate_checklist"]["status"], state["status"])

    def test_a_requirement_blocks_only_the_actions_it_declares(self) -> None:
        for case in CASES:
            with self.subTest(kind=case.name):
                record_id = self.create(case, f"block-{case.name}")
                state = self.state(case, record_id)
                gated = {action for need in case.kind.requirements(state["status"]) for action in need.actions}
                evaluation = self.app.workflows.runtime.evaluate(
                    project_id=self.project_id, instance_id=record_id).public()
                blocked = {item["action"] for item in evaluation["blocked_actions"]}
                available = {item["action"] for item in evaluation["available_actions"]}
                self.assertTrue(gated <= blocked, (case.name, gated, blocked))
                self.assertIn(case.ungated_action, available)

    def test_a_satisfied_document_requirement_opens_its_action(self) -> None:
        for case in (item for item in CASES if item.document):
            role, path, body = case.document
            with self.subTest(kind=case.name):
                record_id = self.create(case, f"open-{case.name}")
                need = next(item for item in case.kind.requirements(case.kind.workflow.initial)
                            if isinstance(item, ArtifactNeed) and item.role == role)
                before = self.state(case, record_id)["gate_checklist"]["items"]
                self.assertFalse(next(item for item in before if item["role"] == role)["satisfied"])
                self.submit(target_type=case.name, target_id=record_id, role=role, path=path, body=body)
                after = self.state(case, record_id)
                item = next(entry for entry in after["gate_checklist"]["items"] if entry["role"] == role)
                self.assertTrue(item["satisfied"], item)
                self.assertEqual(item["status"], "valid" if need.validator else "present")
                self.assertIn("artifact_id", item)
                self.assertTrue(set(need.actions) <=
                                {entry["transition"] for entry in after["allowed_transitions"]})

    def test_knowledge_reads_the_record_its_project_and_its_bytes(self) -> None:
        for case in CASES:
            with self.subTest(kind=case.name):
                record_id = self.create(case, f"know-{case.name}")
                with self.app.store.connect() as conn:
                    snapshot = self.app.workflows.runtime.get(
                        project_id=self.project_id, instance_id=record_id, conn=conn)
                    knowledge = self.records().knowledge(case.kind, snapshot, conn)
                    self.assertEqual(knowledge.read(Reference(case.name, record_id))["id"], record_id)
                    self.assertEqual(knowledge.read(Reference("project", self.project_id))["id"], self.project_id)
                    with self.assertRaises(NotFoundError):
                        knowledge.read(Reference("nonsense", record_id))

    def test_knowledge_refuses_a_row_that_diverged_from_its_instance(self) -> None:
        for case in CASES:
            with self.subTest(kind=case.name):
                record_id = self.create(case, f"drift-{case.name}")
                with self.app.store.transaction() as conn:
                    conn.execute(f"UPDATE {case.kind.table} SET status = 'wandered' WHERE id = ?", (record_id,))
                    snapshot = self.app.workflows.runtime.get(
                        project_id=self.project_id, instance_id=record_id, conn=conn)
                    with self.assertRaisesRegex(WorkflowError, "explicit migration"):
                        self.records().knowledge(case.kind, snapshot, conn)

    def test_a_declared_status_projection_is_applied_before_the_guard(self) -> None:
        # A reflection under code review has no row status of its own; every
        # reader still sees the wave as `consolidating`.
        kind = KINDS["reflection"]
        self.assertEqual(kind.status_of("consolidation_review"), "consolidating")
        self.assertEqual(kind.status_of("synthesizing"), "synthesizing")
        self.assertNotIn("consolidation_review", kind.terminal_statuses)

    def test_unique_names_are_refused_exactly_where_declared(self) -> None:
        for case in CASES:
            with self.subTest(kind=case.name):
                name = f"twice-{case.name}"
                case.create(self, name)
                if not case.kind.unique_name:
                    continue
                with self.assertRaisesRegex(ValidationError, "already exists in this project"):
                    case.create(self, name)

    def test_create_in_transaction_shares_the_callers_connection(self) -> None:
        # The reflection wave materializes every node on one transaction; a
        # failure after a create must leave no row behind.
        kind = KINDS["experiment"]
        with self.assertRaises(RuntimeError):
            with self.app.store.transaction() as conn:
                self.app.experiments._create(conn=conn, project_id=self.project_id, name="rolled-back",
                                             intent="Never committed.")
                raise RuntimeError("caller failed after the create")
        with self.app.store.connect() as conn:
            self.assertIsNone(conn.execute(
                f"SELECT id FROM {kind.table} WHERE project_id = ? AND name = ?",
                (self.project_id, "rolled-back")).fetchone())

    def test_a_forward_action_writes_the_declared_columns_and_seals_its_round(self) -> None:
        for case in CASES:
            with self.subTest(kind=case.name):
                record_id = self.create(case, f"commit-{case.name}")
                case.prepare(self, record_id)
                self.call(f"{case.name}.transition", project_id=self.project_id,
                          **{f"{case.name}_id": record_id, "transition": case.advance})
                state = self.state(case, record_id)
                self.assertEqual(state["status"], case.kind.status_of(case.advances_to))
                with self.app.store.connect() as conn:
                    sealed = conn.execute(
                        "SELECT COUNT(*) AS n FROM research_artifact_links "
                        "WHERE target_id = ? AND submission_id <> ''", (record_id,)).fetchone()["n"]
                    transitions = [row["type"] for row in conn.execute(
                        "SELECT type FROM events WHERE target_id = ? AND type = ? ORDER BY id",
                        (record_id, case.kind.workflow.event_type)).fetchall()]
                self.assertGreater(sealed, 0, case.name)
                self.assertEqual(len(transitions), 1, case.name)

    def test_a_terminal_record_offers_no_transition_and_refuses_a_repeat(self) -> None:
        for case in CASES:
            with self.subTest(kind=case.name):
                record_id = self.create(case, f"terminal-{case.name}")
                arguments = {f"{case.name}_id": record_id, "transition": case.ungated_action}
                if case.name == "task":
                    arguments["evidence"] = {"reason": "Withdrawn before any work."}
                self.call(f"{case.name}.transition", project_id=self.project_id, **arguments)
                state = self.state(case, record_id)
                self.assertEqual(state["allowed_transitions"], [])
                self.assertIn(state["status"], case.kind.terminal_statuses)
                with self.assertRaises(WorkflowError):
                    self.call(f"{case.name}.transition", project_id=self.project_id, **arguments)
