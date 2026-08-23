from __future__ import annotations

from merv.brain.kernel.utils import ValidationError, WorkflowError

from .scenarios import PROBLEM_DETAILS, PROBLEM_STATEMENT, ResearchCase

VALID_DETAILS = PROBLEM_DETAILS
STATEMENT = PROBLEM_STATEMENT


class ProblemDefinitionTest(ResearchCase):
    def define(self, **overrides):
        arguments = {
            "project_id": self.project_id,
            "statement": STATEMENT,
            "details": VALID_DETAILS,
        }
        arguments.update(overrides)
        return self.call("problem.define", **arguments)

    def test_define_creates_the_root_problem(self) -> None:
        problem = self.define()
        self.assertTrue(str(problem["id"]).startswith("prob_"))
        self.assertEqual(problem["statement"], STATEMENT)
        self.assertEqual(problem["details_version"], 1)
        self.assertEqual(problem["status"], "open")
        fetched = self.call("problem.get", project_id=self.project_id)
        self.assertTrue(fetched["exists"])
        self.assertEqual(fetched["problem"]["id"], problem["id"])

    def test_statement_must_be_one_bounded_line(self) -> None:
        with self.assertRaises(ValidationError):
            self.define(statement="")
        with self.assertRaises(ValidationError):
            self.define(statement="Line one\nline two of the statement here")
        with self.assertRaises(ValidationError):
            self.define(statement="x" * 300)
        with self.assertRaises(ValidationError):
            self.define(statement="LLM stuff")

    def test_details_requires_every_interview_section(self) -> None:
        with self.assertRaises(ValidationError):
            self.define(details="")
        missing_failed = VALID_DETAILS.replace("## Failed means", "## Fails")
        with self.assertRaises(ValidationError) as caught:
            self.define(details=missing_failed)
        self.assertIn("Failed means", str(caught.exception))
        empty_section = VALID_DETAILS.replace(
            "## Non-goals\nNo new pretraining corpora; no teacher retraining; "
            "no models above 7B.",
            "## Non-goals",
        )
        with self.assertRaises(ValidationError):
            self.define(details=empty_section)

    def test_one_root_per_project_and_immutable_statement(self) -> None:
        self.define()
        with self.assertRaises(ValidationError) as caught:
            self.define()
        self.assertIn("problem.refine", str(caught.exception))

    def test_refine_bumps_version_and_guards_concurrency(self) -> None:
        self.define()
        refined = self.call(
            "problem.refine",
            project_id=self.project_id,
            details=VALID_DETAILS + "\n## Background\nWhat wave one taught us.\n",
            expected_version=1,
        )
        self.assertEqual(refined["details_version"], 2)
        self.assertEqual(refined["statement"], STATEMENT)
        with self.assertRaises(ValidationError):
            self.call(
                "problem.refine",
                project_id=self.project_id,
                details=VALID_DETAILS,
                expected_version=1,
            )

    def test_tree_carries_charter_details_and_version_history(self) -> None:
        self.define()
        self.call(
            "problem.refine",
            project_id=self.project_id,
            details=VALID_DETAILS + "\n## Background\nWave one taught us plenty.\n",
            expected_version=1,
        )
        tree = self.call("problem.tree", project_id=self.project_id)
        self.assertIn("## Solved means", tree["root"]["details"])
        self.assertIn("## Background", tree["root"]["details"])
        self.assertEqual(tree["root"]["details_version"], 2)
        history = tree["details_history"]
        self.assertEqual([entry["version"] for entry in history], [1])
        self.assertIn("## Solved means", history[0]["details"])
        self.assertNotIn("## Background", history[0]["details"])

    def test_refine_without_a_root_is_a_clear_miss(self) -> None:
        from merv.brain.kernel.utils import NotFoundError

        with self.assertRaises(NotFoundError):
            self.call(
                "problem.refine",
                project_id=self.project_id,
                details=VALID_DETAILS,
            )

    def test_fresh_project_status_gates_on_the_interview(self) -> None:
        status = self.call("workflow.status_and_next", project_id=self.project_id)
        workflow = status["workflow"]
        self.assertEqual(workflow["current_gate"], "problem_definition")
        self.assertEqual(workflow["allowed_actions"], ["problem.define"])
        self.assertIn("interview_guidance", workflow)
        blocked = {entry["action"] for entry in workflow["blocked_actions"]}
        self.assertEqual(blocked, {"experiment.create", "task.create", "claim.create"})
        self.define()
        after = self.call("workflow.status_and_next", project_id=self.project_id)
        self.assertEqual(after["workflow"]["current_gate"], "project_setup")
        self.assertEqual(after["context"]["problem"]["statement"], STATEMENT)
        self.assertIn("## Solved means", after["context"]["problem"]["details"])

    def test_projects_with_prior_work_keep_todays_behavior(self) -> None:
        self.call(
            "claim.create",
            project_id=self.project_id,
            statement="Distillation transfers reasoning at small scale.",
        )
        status = self.call("workflow.status_and_next", project_id=self.project_id)
        self.assertEqual(status["workflow"]["current_gate"], "project_setup")

    def test_require_root_problem_knob_blocks_research_creates(self) -> None:
        self.app.projects.update(
            project_id=self.project_id, require_root_problem=True
        )
        with self.assertRaises(WorkflowError):
            self.create_experiment()
        with self.assertRaises(WorkflowError):
            self.call(
                "task.create",
                project_id=self.project_id,
                name="prep-data",
                goal="Prepare the distillation data so experiments can start.",
                deliverables=["out/train.parquet exists with the documented row count"],
            )
        with self.assertRaises(WorkflowError):
            self.call(
                "claim.create",
                project_id=self.project_id,
                statement="Blocked until the interview happens.",
            )
        self.define()
        self.assertTrue(self.create_experiment())
