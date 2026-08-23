from __future__ import annotations

from merv.brain.kernel.utils import ValidationError, WorkflowError

from .scenarios import (
    PROBLEM_DETAILS as VALID_DETAILS,
    PROBLEM_STATEMENT as STATEMENT,
    VALID_GRAPH,
    VALID_PLAN,
    VALID_REPORT,
    ResearchCase,
)


def child(statement: str) -> dict[str, str]:
    return {"statement": statement}


CHILD_A = "Does logit distillation alone reach the 2-point band on GSM8K?"
CHILD_B = "Does hidden-state matching close the gap logit distillation leaves?"
CHILD_C = "Is the public data mix sufficient to train the 3B student at all?"


class ProblemTreeCase(ResearchCase):
    def setUp(self) -> None:
        super().setUp()
        self.call(
            "project.update",
            project_id=self.project_id,
            workflow_mode="problem_tree",
        )
        self.root = self.call(
            "problem.define",
            project_id=self.project_id,
            statement=STATEMENT,
            details=VALID_DETAILS,
        )["id"]

    def decompose_root(self, *statements: str) -> list[str]:
        result = self.call(
            "problem.decompose",
            project_id=self.project_id,
            problem_id=self.root,
            children=[child(statement) for statement in statements],
        )
        return [entry["id"] for entry in result["children"]]

    def attempt(self, problem_ids, name: str = "probe") -> str:
        return str(
            self.call(
                "problem.attempt",
                project_id=self.project_id,
                problem_ids=problem_ids,
                kind="experiment",
                name=name,
                intent="Test the attached frontier problems with one concrete run.",
            )["attempt"]["id"]
        )

    def complete_experiment(self, experiment_id: str) -> None:
        """Drive an already-created experiment through both reviews to complete."""
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
        self.transition_experiment(experiment_id, "mark_ready_to_run")
        self.transition_experiment(experiment_id, "start_running")
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
        self.pass_review(
            target_type="experiment",
            target_id=experiment_id,
            role="experiment_reviewer",
        )
        self.transition_experiment(experiment_id, "complete")

    def tree_status(self) -> dict:
        return self.call("workflow.status_and_next", project_id=self.project_id)


class TreeModeGatesTest(ProblemTreeCase):
    def test_direct_creates_and_reflections_are_tree_only(self) -> None:
        with self.assertRaises(WorkflowError):
            self.create_experiment()
        with self.assertRaises(WorkflowError):
            self.call(
                "task.create",
                project_id=self.project_id,
                name="adhoc",
                goal="Ad-hoc work outside the tree should be refused here.",
                deliverables=["a file exists"],
            )
        with self.assertRaises(WorkflowError):
            self.call(
                "reflection.create",
                project_id=self.project_id,
                title="Retired",
                lenses=[],
            )

    def test_project_status_serves_the_frontier(self) -> None:
        status = self.tree_status()
        self.assertEqual(status["workflow"]["current_gate"], "problem_tree")
        self.assertEqual(status["workflow"]["next_action"], "triage_problem")
        tree = status["problem_tree"]
        self.assertEqual(tree["root"]["id"], self.root)
        self.assertEqual([entry["id"] for entry in tree["frontier"]], [self.root])

    def test_tree_mode_projects_can_be_created_directly(self) -> None:
        project = self.call(
            "project",
            action="create",
            name="tree-born",
            workflow_mode="problem_tree",
        )
        status = self.call("workflow.status_and_next", project_id=project["id"])
        self.assertEqual(status["workflow"]["current_gate"], "problem_definition")


class DecomposeAndAttemptTest(ProblemTreeCase):
    def test_decompose_moves_the_frontier_down(self) -> None:
        children = self.decompose_root(CHILD_A, CHILD_B)
        status = self.tree_status()
        self.assertEqual(status["workflow"]["next_action"], "triage_problem")
        self.assertEqual(
            {entry["id"] for entry in status["problem_tree"]["frontier"]},
            set(children),
        )
        tree = self.call("problem.tree", project_id=self.project_id)
        self.assertEqual(len(tree["root"]["children"]), 2)
        self.assertEqual(tree["counts"], {"decomposed": 1, "open": 2})

    def test_decompose_rejects_duplicates_and_non_open_parents(self) -> None:
        (child_a,) = self.decompose_root(CHILD_A)
        with self.assertRaises(WorkflowError):
            self.decompose_root(CHILD_B)
        with self.assertRaises(ValidationError):
            self.call(
                "problem.decompose",
                project_id=self.project_id,
                problem_id=child_a,
                children=[child(CHILD_B), child(CHILD_B)],
            )
        with self.assertRaises(ValidationError):
            self.call(
                "problem.decompose",
                project_id=self.project_id,
                problem_id=child_a,
                children=[child(CHILD_A)],
            )

    def test_attempt_attaches_and_flips_to_attempting(self) -> None:
        children = self.decompose_root(CHILD_A, CHILD_B)
        attempt_id = self.attempt(children)
        self.assertTrue(attempt_id.startswith("exp_"))
        status = self.tree_status()
        self.assertEqual(status["problem_tree"]["frontier"], [])
        running = status["problem_tree"]["running_attempts"]
        self.assertEqual(running[0]["attempt_id"], attempt_id)
        self.assertEqual(set(running[0]["problem_ids"]), set(children))
        with self.assertRaises(WorkflowError):
            self.attempt(children, name="second")

    def test_attempt_cap_and_unknown_problems(self) -> None:
        with self.assertRaises(ValidationError):
            self.attempt(["p1", "p2", "p3", "p4", "p5"])
        from merv.brain.kernel.utils import NotFoundError

        with self.assertRaises(NotFoundError):
            self.attempt(["prob_missing"])


class ResolveAttemptTest(ProblemTreeCase):
    def test_infra_death_reopens_every_problem(self) -> None:
        children = self.decompose_root(CHILD_A, CHILD_B)
        attempt_id = self.attempt(children)
        with self.assertRaises(WorkflowError):
            self.call(
                "problem.resolve_attempt",
                project_id=self.project_id,
                attempt_id=attempt_id,
            )
        self.transition_experiment(attempt_id, "abandon")
        result = self.call(
            "problem.resolve_attempt",
            project_id=self.project_id,
            attempt_id=attempt_id,
        )
        self.assertEqual(
            {entry["verdict"] for entry in result["problems"]}, {"reopen"}
        )
        status = self.tree_status()
        self.assertEqual(
            {entry["id"] for entry in status["problem_tree"]["frontier"]},
            set(children),
        )

    def test_completed_attempt_takes_per_problem_verdicts(self) -> None:
        children = self.decompose_root(CHILD_A, CHILD_B)
        attempt_id = self.attempt(children)
        self.complete_experiment(attempt_id)
        status = self.tree_status()
        self.assertEqual(status["workflow"]["next_action"], "resolve_attempt")
        with self.assertRaises(ValidationError):
            self.call(
                "problem.resolve_attempt",
                project_id=self.project_id,
                attempt_id=attempt_id,
                verdicts=[
                    {"problem_id": children[0], "verdict": "solved", "summary": "x" * 30}
                ],
            )
        self.call(
            "problem.resolve_attempt",
            project_id=self.project_id,
            attempt_id=attempt_id,
            verdicts=[
                {
                    "problem_id": children[0],
                    "verdict": "solved",
                    "summary": "Logit distillation reached the band; evidence "
                    "in the probe run's metrics.",
                },
                {
                    "problem_id": children[1],
                    "verdict": "failed",
                    "summary": "Hidden-state matching added nothing on top; "
                    "the gap stayed open at the compute cap.",
                },
            ],
        )
        status = self.tree_status()
        self.assertEqual(status["workflow"]["next_action"], "revisit_problem")
        self.assertEqual(
            status["problem_tree"]["full_revisits"][0]["id"], self.root
        )


class RevisitTest(ProblemTreeCase):
    def stuck(self, problem_id: str) -> None:
        self.call(
            "problem.mark_stuck",
            project_id=self.project_id,
            problem_id=problem_id,
            why="No runnable experiment exists and no independent split "
            "presents itself; parking this branch for the parent.",
        )

    def test_full_revisit_next_spawns_and_budget_caps(self) -> None:
        children = self.decompose_root(CHILD_A)
        self.stuck(children[0])
        result = self.call(
            "problem.revisit_submit",
            project_id=self.project_id,
            problem_id=self.root,
            verdict="next",
            why="The first probe parked; a data-sufficiency check must come "
            "before any distillation recipe can be judged.",
            children=[child(CHILD_C)],
        )
        self.assertEqual(result["kind"], "full")
        self.assertEqual(len(result["spawned"]), 1)
        for round_index in range(3):
            self.stuck(result["spawned"][0]["id"])
            result = self.call(
                "problem.revisit_submit",
                project_id=self.project_id,
                problem_id=self.root,
                verdict="next",
                why="Still probing for a workable angle on the same parent "
                "problem; spawning the next narrow check.",
                children=[child(f"{CHILD_C[:-1]} at scale {round_index}?")],
            )
        self.stuck(result["spawned"][0]["id"])
        with self.assertRaises(WorkflowError):
            self.call(
                "problem.revisit_submit",
                project_id=self.project_id,
                problem_id=self.root,
                verdict="next",
                why="One spawn too many: the revisit budget must stop this "
                "loop and force an honest resolution.",
                children=[child("One decomposition too many for the budget?")],
            )

    def test_full_revisit_resolves_the_root(self) -> None:
        children = self.decompose_root(CHILD_A)
        self.stuck(children[0])
        self.call(
            "problem.revisit_submit",
            project_id=self.project_id,
            problem_id=self.root,
            verdict="failed",
            why="Every angle parked; the charter question is closed as "
            "unanswerable within the stated constraints.",
            summary="No distillation recipe was runnable within constraints; "
            "the project closes with a negative result.",
        )
        status = self.tree_status()
        self.assertEqual(
            status["workflow"]["current_gate"], "problem_tree_resolved"
        )

    def test_interim_moot_cascades_and_ends_orphaned_work(self) -> None:
        children = self.decompose_root(CHILD_A, CHILD_B)
        attempt_id = self.attempt([children[1]], name="doomed")
        self.stuck(children[0])
        status = self.tree_status()
        self.assertEqual(status["workflow"]["next_action"], "interim_revisit")
        with self.assertRaises(ValidationError):
            self.call(
                "problem.revisit_submit",
                project_id=self.project_id,
                problem_id=self.root,
                verdict="next",
                why="NEXT while a child still runs must be refused — that is "
                "the whole point of the interim restriction.",
                children=[child(CHILD_C)],
            )
        result = self.call(
            "problem.revisit_submit",
            project_id=self.project_id,
            problem_id=self.root,
            verdict="moot",
            why="The stuck sibling settles it: this branch's answer no "
            "longer depends on the running child, so stop paying for it.",
            moot_ids=[children[1]],
        )
        self.assertEqual(result["mooted"], [children[1]])
        ended = result["ended_work"]
        self.assertEqual(ended[0]["id"], attempt_id)
        self.assertTrue(ended[0]["ended"])
        tree = self.call("problem.tree", project_id=self.project_id)
        mooted_node = next(
            node
            for node in tree["root"]["children"]
            if node["id"] == children[1]
        )
        self.assertEqual(mooted_node["status"], "moot")
        self.assertEqual(mooted_node["attempts"][0]["status"], "abandoned")
        status = self.tree_status()
        self.assertEqual(status["workflow"]["next_action"], "revisit_problem")

    def test_interim_resolve_moots_all_live_children(self) -> None:
        children = self.decompose_root(CHILD_A, CHILD_B)
        self.stuck(children[0])
        self.call(
            "problem.revisit_submit",
            project_id=self.project_id,
            problem_id=self.root,
            verdict="solved",
            why="The stuck child's parking note contained the answer: the "
            "question resolves without waiting on the second branch.",
            summary="The charter question resolved from the first branch's "
            "evidence; the second line of attack became unnecessary.",
        )
        tree = self.call("problem.tree", project_id=self.project_id)
        self.assertEqual(tree["root"]["status"], "solved")
        statuses = {node["id"]: node["status"] for node in tree["root"]["children"]}
        self.assertEqual(statuses[children[0]], "stuck")
        self.assertEqual(statuses[children[1]], "moot")
