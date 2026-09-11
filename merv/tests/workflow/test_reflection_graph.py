"""Reflection fan-out is a real composition with immutable submitted work."""

from merv.brain.kernel.utils import NotFoundError, ValidationError, WorkflowError
from tests.research_core.scenarios import LENSES, ResearchCase


class ReflectionGraphTest(ResearchCase):
    @property
    def runtime(self):
        return self.app.research.workflows.runtime

    def state(self, instance_id):
        return self.runtime.get(project_id=self.project_id, instance_id=instance_id)

    def content(self, *, lens_id, body=None, project_id=None):
        return self.app.artifacts.contents.create(
            project_id=project_id or self.project_id, path=f"reflections/{lens_id}.md",
            data=(body or f"# {lens_id}\n\n## Summary\nThe independent lens identified evidence worth testing.").encode(),
            created_by="independent-lens",
        ).id

    def submit_child(self, child, artifact_id):
        snapshot = self.state(child.id)
        return self.call("workflow.transition", project_id=self.project_id, instance_id=child.id,
                         action="submit", expected_revision=snapshot.revision, request_id=f"submit:{child.id}",
                         payload={"artifact_id": artifact_id})

    def test_independent_lens_submissions_join_and_pin_exact_content(self):
        started = self.call("workflow.start", project_id=self.project_id, workflow="reflection", request_id="wave",
                            data={"title": "Independent views", "lenses": [dict(lens) for lens in LENSES]})
        wave = self.state(started["id"])
        self.assertEqual({child.key for child in wave.children}, {lens["id"] for lens in LENSES})
        self.assertEqual(len(wave.children), 5)
        with self.assertRaises(WorkflowError):
            self.call("workflow.transition", project_id=self.project_id, instance_id=wave.id,
                      action="submit_reflections", expected_revision=wave.revision, request_id="premature")
        submitted = {}
        for child in wave.children:
            assignment = self.call("workflow.assignment", project_id=self.project_id, instance_id=child.id)
            self.assertEqual(assignment["role"], "reflection_lens")
            self.assertIn("payload={artifact_id", assignment["brief"])
            artifact_id = self.content(lens_id=child.key)
            submitted[child.key] = artifact_id
            self.assertEqual(self.submit_child(child, artifact_id)["outcome"], "submitted")
        after = self.state(wave.id)
        self.assertEqual(after.state, "synthesizing")
        self.assertEqual(dict(after.data["lens_artifacts"]), submitted)
        native = self.call("reflection.get", project_id=self.project_id, reflection_id=wave.id)
        self.assertEqual(native["status"], "synthesizing")
        self.assertTrue(native["reflection_coverage"]["complete"])
        packet = self.call("workflow.assignment", project_id=self.project_id, instance_id=wave.id)
        self.assertEqual(packet["role"], "reflection_owner")
        self.assertIn("do not repeat", packet["brief"])
        self.assertEqual([entry["action"] for entry in self.runtime.history(project_id=self.project_id, instance_id=wave.id)],
                         ["start", "submit_reflections"])

    def test_completed_lens_contribution_survives_a_later_native_replacement(self):
        wave = self.state(self.create_reflection())
        first = wave.children[0]
        original = self.content(lens_id=first.key)
        self.submit_child(first, original)
        replacement = self.submit(target_type="reflection", target_id=wave.id, role="reflection_lens_doc",
                                  lens_id=first.key, path=f"reflections/{first.key}.md",
                                  body="## Summary\nA later document must not rewrite a completed task.")
        for child in wave.children[1:]:
            self.submit_child(child, self.content(lens_id=child.key))
        self.assertEqual(self.state(wave.id).data["lens_artifacts"][first.key], original)
        native = self.call("reflection.get", project_id=self.project_id, reflection_id=wave.id)
        current_ids = {artifact["id"] for artifact in native["current_attempt_artifacts"]}
        self.assertNotIn(replacement, current_ids)
        first_history = self.runtime.history(project_id=self.project_id, instance_id=first.id)
        self.assertEqual(first_history[-1]["after"]["data"]["artifact_id"], original)

    def test_lens_payload_is_checked_and_cannot_select_another_projects_bytes(self):
        wave = self.state(self.create_reflection())
        child = wave.children[0]
        other = self.call("project", action="create", name="Other project", summary="Different evidence scope.")
        foreign = self.content(lens_id=child.key, project_id=other["id"])
        with self.assertRaises((NotFoundError, ValidationError, WorkflowError)):
            self.submit_child(child, foreign)
        malformed = self.content(lens_id=child.key, body="An unstructured note without the required summary.")
        with self.assertRaisesRegex(WorkflowError, "Summary"):
            self.submit_child(child, malformed)
        self.assertEqual(self.state(child.id).revision, 0)
        self.assertEqual(self.state(child.id).outcome, "")
        self.assertEqual(self.state(wave.id).state, "reflecting")

    def test_only_parent_composition_can_create_a_lens(self):
        wave = self.state(self.create_reflection())
        with self.assertRaisesRegex(WorkflowError, "parent's fixed composition"):
            self.call("workflow.start", project_id=self.project_id, workflow="reflection_lens", request_id="rogue-lens",
                      data={"reflection_id": wave.id, "attempt_index": 1, "lens_id": wave.children[0].key})
        self.assertEqual(len(self.state(wave.id).children), 5)

    def test_migration_adopts_existing_submitted_lenses_without_dispatching_them(self):
        wave = self.state(self.create_reflection())
        first_key = wave.children[0].key
        artifact_id = self.submit(target_type="reflection", target_id=wave.id, role="reflection_lens_doc",
                                  lens_id=first_key, path=f"reflections/{first_key}.md", body="## Summary\nA retained independent finding.")
        with self.app.store.transaction() as conn:
            for child in wave.children:
                conn.execute("DELETE FROM workflow_history WHERE instance_id = ?", (child.id,))
                conn.execute("DELETE FROM workflow_instances WHERE id = ?", (child.id,))
            self.app.reflection_waves.migrate_workflow_instances(conn)
        adopted = self.state(wave.id)
        retained = next(child for child in adopted.children if child.key == first_key)
        self.assertEqual(retained.outcome, "submitted")
        self.assertEqual(retained.data["artifact_id"], artifact_id)
        self.assertEqual(sum(not child.outcome for child in adopted.children), 4)
        with self.assertRaises(WorkflowError):
            self.call("workflow.assignment", project_id=self.project_id, instance_id=retained.id)
        with self.app.store.transaction() as conn:
            self.app.reflection_waves.migrate_workflow_instances(conn)
        self.assertEqual(self.state(wave.id), adopted)

    def test_review_return_has_fresh_children_only_when_lenses_must_be_repeated(self):
        wave_id = self.drive_reflection_to_review()
        with self.app.store.connect() as conn:
            first_ids = {row["id"] for row in conn.execute("SELECT id FROM workflow_instances WHERE parent_id = ?", (wave_id,)).fetchall()}
        self.review(target_type="reflection", target_id=wave_id, role="reflection_reviewer", verdict="needs_changes", return_to="synthesizing")
        self.assertEqual(self.state(wave_id).state, "synthesizing")
        self.assertEqual(len(self.state(wave_id).data["lens_artifacts"]), 5)
        current = self.state(wave_id)
        self.call("workflow.transition", project_id=self.project_id, instance_id=wave_id, action="submit_reflection_artifacts",
                  expected_revision=current.revision, request_id="resubmit")
        self.review(target_type="reflection", target_id=wave_id, role="reflection_reviewer", verdict="needs_changes", return_to="reflecting")
        rerun = self.state(wave_id)
        self.assertEqual(rerun.state, "reflecting")
        self.assertEqual(rerun.data["attempt_index"], 2)
        self.assertEqual(len(rerun.children), 5)
        self.assertFalse(first_ids & {child.id for child in rerun.children})
        self.assertTrue(all(not child.outcome for child in rerun.children))
        self.assertEqual(dict(rerun.data["lens_artifacts"]), {})

    def test_published_wave_composes_its_existing_instances_and_routes_their_outcomes(self):
        reflection_id = self.drive_reflection_to_review()
        self.pass_review(target_type="reflection", target_id=reflection_id, role="reflection_reviewer")
        published = self.consolidate_and_publish(reflection_id)
        experiment_id = published.materialized_experiments[0]["experiment_id"]
        before = self.state(experiment_id)
        started = self.call("workflow.start", project_id=self.project_id, workflow="research_wave", request_id=f"reflection-wave:{reflection_id}",
                            data={"reflection_id": reflection_id})
        self.assertEqual([child["id"] for child in started["children"]], [experiment_id])
        self.assertEqual(self.state(experiment_id), before)
        # A manual start racing the publication delivery resolves the same
        # durable wave instead of attempting to reparent or rerun its members.
        self.app.application.workflow_deliveries.run_once(project_id=self.project_id)
        with self.app.store.connect() as conn:
            action = conn.execute("SELECT status, last_error FROM workflow_actions WHERE instance_id = ? AND kind = 'workflow.start'", (reflection_id,)).fetchone()
            self.assertEqual(action["status"], "delivered", action["last_error"])
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM workflow_instances WHERE project_id = ? AND workflow = 'research_wave'", (self.project_id,)).fetchone()["n"], 1)
        with self.assertRaisesRegex(WorkflowError, "declared child outcomes"):
            self.call("workflow.transition", project_id=self.project_id, instance_id=started["id"], action="complete",
                      expected_revision=0, request_id="too-early")
        self.call("workflow.transition", project_id=self.project_id, instance_id=experiment_id,
                  action="mark_failed", expected_revision=before.revision, request_id="unavailable-data",
                  payload={"reason": "The planned source data could not be obtained."})
        settled = self.state(started["id"])
        self.assertEqual(settled.outcome, "needs_replanning")
        self.assertEqual(settled.data["next_workflow"], "reflection")
        self.assertEqual(set(settled.data["outcomes"].values()), {"failed"})
        with self.app.store.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM reflections WHERE project_id = ?", (self.project_id,)).fetchone()["n"], 1)
