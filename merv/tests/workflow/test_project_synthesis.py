"""End-to-end publication, pinned evidence, and lifecycle recovery."""

from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from merv.brain.kernel.utils import NotFoundError, WorkflowError
from merv.brain.workflows import research_contracts
from tests.research_core.scenarios import ResearchCase, VALID_REPORT, VALID_GRAPH
from tests.support.brain import TestBrain


class ProjectSynthesisTest(ResearchCase):
    def document(self):
        return self.call("project", action="overview", project_id=self.project_id)["project"]

    def prepare(self):
        document = self.document()
        self.call("workflow.transition", project_id=self.project_id,
            instance_id=document["maintenance"]["instance_id"], expected_revision=document["maintenance"]["revision"],
            action="prepare", request_id=f"prepare:{document['maintenance']['revision']}")
        packet = self.call("project.synthesis.read", project_id=self.project_id,
                           instance_id=document["maintenance"]["instance_id"])
        return packet

    def publish(self, packet, **overrides):
        publication = dict(methods="Compare the registered approach with its control; await validation.",
            results="No established finding yet; this is ongoing work.",
            references=packet["source"]["references"][:1],
            editorial_note="Replaced the chronological run inventory with one causal account.")
        publication.update(overrides)
        return self.call("workflow.transition", project_id=self.project_id, instance_id=packet["instance_id"],
            expected_revision=packet["revision"], request_id=f"publish:{packet['revision']}",
            action="publish", payload=publication)

    def test_empty_and_initialization_do_not_invent_content_or_require_dispatch(self):
        document = self.document()
        self.assertEqual(document["methods"], "")
        self.assertEqual(document["results"], "")
        self.assertFalse(document["maintenance"]["pending"])
        self.assertEqual(self.app.workflows.candidates(project_id=self.project_id), [])
        with self.assertRaises(WorkflowError):
            self.call("workflow.start", project_id=self.project_id, workflow="project_synthesis",
                      request_id="second-author", data={"methods": "forged", "covered_event": 999})
        self.create_experiment()
        packet = self.prepare()
        begin = self.call("workflow.begin", project_id=self.project_id, instance_id=packet["instance_id"],
                          expected_revision=packet["revision"])
        self.assertIn("SHORT, accurate", begin["brief"])
        self.publish(packet)
        self.assertFalse(self.document()["maintenance"]["pending"])

    def test_markdown_table_and_figure_preserve_evidence_references(self):
        experiment = self.create_experiment()
        figure = self.submit(target_type="experiment", target_id=experiment,
                             role="report", path="comparison.svg", body='<svg xmlns="http://www.w3.org/2000/svg"/>')
        packet = self.prepare()
        results = f"| Approach | Accuracy |\n| --- | --- |\n| Baseline | 0.65 |\n\n![Baseline comparison]({figure})"
        with self.assertRaisesRegex(WorkflowError, "every figure artifact"):
            self.publish(packet, results=results, references=[])
        reference = next(ref for ref in packet["source"]["references"] if ref["id"] == figure)
        self.publish(packet, results=results, references=[reference])
        self.assertEqual(self.document()["results"], results)
        self.assertIn(results, research_contracts.render_project_document(self.document()))

    def test_existing_project_is_initialized_and_concurrent_preparation_coalesces(self):
        experiment = self.create_experiment()
        instance = self.document()["maintenance"]["instance_id"]
        # Simulate a database created before this feature's workflow existed.
        with self.app.store.transaction() as conn:
            conn.execute("DELETE FROM workflow_history WHERE instance_id = ?", (instance,))
            conn.execute("DELETE FROM workflow_instances WHERE id = ?", (instance,))
        self.app.shutdown()
        self.app = TestBrain(repo_root=self.repo, db_path=self.app.db_path)
        self.assertTrue(self.document()["maintenance"]["pending"])
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda _: self.app.research.synthesis.prepare(project_id=self.project_id), range(2)))
        packet = self.call("project.synthesis.read", project_id=self.project_id, instance_id=instance)
        self.assertEqual(packet["revision"], 1)
        self.assertIn(experiment, {record["id"] for record in packet["source"]["records"]})
        history = self.app.workflows.runtime.history(project_id=self.project_id, instance_id=instance)
        self.assertEqual(sum(item["action"] == "prepare" for item in history), 1)

    def test_rejected_attempt_evidence_survives_retry_in_the_author_input(self):
        experiment = self.drive_experiment_to_review()
        self.review(target_type="experiment", target_id=experiment, role="experiment_reviewer",
                    verdict="needs_changes", return_to="planned")
        packet = self.prepare()
        record = next(r for r in packet["source"]["records"] if r["id"] == experiment)
        self.assertEqual(record["attempt_index"], 2)
        self.assertTrue(any(a["label"] == "report" and a["attempt_index"] == 1 for a in record["artifacts"]))
        self.assertTrue(any(review["verdict"] == "needs_changes" for review in record["reviews"]))

    def test_literature_citations_and_specific_context_survive_shared_document_delivery(self):
        self.call("litreview.edit", project_id=self.project_id, op="edit", section="summary",
                  expected_revision=0, body="A cited baseline frames the open question.", tldr="Baseline")
        section = self.document()["literature"]["id"]
        self.call("litreview.cite", project_id=self.project_id, url="https://example.test/baseline",
                  title="Baseline evidence", targets=[{"type": "litreview_section", "id": section}])
        experiment = self.create_experiment()
        packet = self.prepare()
        self.publish(packet)
        document = self.document()
        self.assertEqual(document["literature"]["cited_papers"][0]["title"], "Baseline evidence")
        rendered = research_contracts.render_project_document(document)
        self.assertIn("[Baseline evidence](https://example.test/baseline)", rendered)
        assignment = self.call("workflow.assignment", project_id=self.project_id, instance_id=experiment)
        self.assertIn(rendered, assignment["brief"])
        self.assertIn("Test the registered claim.", assignment["brief"])
        self.assertEqual(assignment["brief"].count("## Methods"), 1)
        task = self.call("task.create", project_id=self.project_id, name="check-dataset",
                        goal="Retain the prepared dataset", deliverables=["A retained dataset"])
        status = self.call("workflow.status_and_next", project_id=self.project_id)
        self.assertEqual({key: status["context"]["project"][key] for key in document}, document)
        status = self.call("workflow.status_and_next", project_id=self.project_id, task_id=task["id"])
        self.assertEqual(set(status), {"scope", "workflow", "context"})

    def test_only_publication_advances_pinned_coverage_and_concurrent_arrivals_survive(self):
        first = self.create_experiment("first-approach")
        packet = self.prepare()
        source = deepcopy(packet["source"])
        second = self.create_experiment("next-approach")
        reread = self.call("project.synthesis.read", project_id=self.project_id, instance_id=packet["instance_id"])
        self.assertEqual(reread["source"], source)
        self.assertEqual(self.document()["methods"], "")
        with self.assertRaises(WorkflowError):
            self.publish(packet, covered_event=10**12)
        with self.assertRaises(WorkflowError):
            self.publish(packet, references=[{"kind": "experiment", "id": second, "label": "Not in this input"}])
        after = self.publish(packet)
        self.assertEqual(self.document()["maintenance"]["covered_event"], source["through_event"])
        self.assertTrue(self.document()["maintenance"]["pending"])
        self.assertEqual(self.publish(packet), after)  # delivery replay does not republish
        latest = self.prepare()
        self.assertIn(second, {r["id"] for r in latest["source"]["records"]})
        self.assertNotIn(first, {r["id"] for r in latest["source"]["records"]})
        with self.assertRaises(WorkflowError):
            self.publish(packet, methods="An obsolete worker's edit.")
        self.publish(latest)
        self.assertFalse(self.document()["maintenance"]["pending"])

    def test_failed_publication_and_worker_restart_preserve_last_valid_document(self):
        self.create_experiment()
        original = self.prepare()
        self.publish(original, methods="Established account retained.")
        self.create_experiment("follow-up")
        packet = self.prepare()
        old = self.document()
        record_event = self.app.store.record_event
        def fail_publication(**kwargs):
            if kwargs.get("target_type") == "project_synthesis":
                raise RuntimeError("simulated commit failure")
            return record_event(**kwargs)
        with patch.object(self.app.store, "record_event", side_effect=fail_publication):
            with self.assertRaisesRegex(RuntimeError, "commit failure"):
                self.publish(packet, methods="New account.")
        self.assertEqual(self.document(), old)
        self.app.shutdown()
        self.app = TestBrain(repo_root=self.repo, db_path=self.app.db_path)
        self.assertEqual(self.document(), old)
        self.assertEqual(self.call("project.synthesis.read", project_id=self.project_id,
                                  instance_id=packet["instance_id"])["source"], packet["source"])
        self.publish(packet, methods="Recovered account.")
        self.assertEqual(self.document()["methods"], "Recovered account.")
        # A wrong id and a wrong state are told apart, and the state is named.
        with self.assertRaisesRegex(NotFoundError, "psyn_nope.*this project's is " + packet["instance_id"]):
            self.call("project.synthesis.read", project_id=self.project_id, instance_id="psyn_nope")
        with self.assertRaisesRegex(WorkflowError, "is 'waiting', not writing"):
            self.call("project.synthesis.read", project_id=self.project_id, instance_id=packet["instance_id"])

    def test_canonical_sources_are_composed_and_context_changes_require_refresh(self):
        self.create_experiment()
        packet = self.prepare()
        self.call("project.context.update", project_id=self.project_id, summary="User goal and scope.", expected_summary="")
        with self.assertRaisesRegex(WorkflowError, "intent or literature changed"):
            self.publish(packet)
        self.call("workflow.transition", project_id=self.project_id, instance_id=packet["instance_id"],
                  expected_revision=packet["revision"], request_id="refresh", action="refresh")
        self.assertEqual(self.document()["maintenance"]["covered_event"], 0)
        self.call("litreview.edit", project_id=self.project_id, op="edit", section="summary",
                  expected_revision=0, body="The existing literature narrows the unresolved question.", tldr="Known literature.")
        document = self.document()
        self.assertEqual(document["summary"], "User goal and scope.")
        self.assertEqual(document["literature"]["body"], "The existing literature narrows the unresolved question.")
        packet = self.prepare()
        for key in ("summary", "literature", "settings"):
            with self.assertRaises(WorkflowError):
                self.publish(packet, **{key: "not owned by this author"})
        self.publish(packet)
        self.assertEqual(self.document()["summary"], document["summary"])
        self.assertEqual(self.document()["literature"], document["literature"])

    def test_completion_and_reflection_publication_really_dispatch_fresh_work(self):
        experiment = self.drive_experiment_to_review()
        self.publish(self.prepare())
        self.assertFalse(self.document()["maintenance"]["pending"])
        self.pass_review(target_type="experiment", target_id=experiment, role="experiment_reviewer")
        self.assertTrue(self.document()["maintenance"]["pending"])
        queue = self.app.application.dispatch_queue(project_id=self.project_id)
        self.assertTrue(any(item["role"] == "project_author" for item in queue))
        packet = self.call("project.synthesis.read", project_id=self.project_id,
                           instance_id=self.document()["maintenance"]["instance_id"])
        self.assertTrue(any(e["target_id"] == experiment and e["to"] == "complete" for e in packet["source"]["events"]))
        self.publish(packet)
        reflection = self.drive_reflection_to_review()
        self.pass_review(target_type="reflection", target_id=reflection, role="reflection_reviewer")
        self.publish(self.prepare())
        self.assertFalse(self.document()["maintenance"]["pending"])
        self.consolidate_and_publish(reflection)
        self.assertTrue(self.document()["maintenance"]["pending"])
        with patch.object(self.app.blobs, "get", side_effect=AssertionError("source preparation must not read blobs")) as blobs:
            packet = self.prepare()
            blobs.assert_not_called()
        self.assertTrue(any(e["target_id"] == reflection and e["to"] == "published" for e in packet["source"]["events"]))
        self.assertTrue(any(ref["kind"] == "artifact" for ref in packet["source"]["references"]))
        self.publish(packet)
        self.assertFalse(self.document()["maintenance"]["pending"])

    def test_selected_status_is_live_but_evidence_is_pinned_and_foreign_evidence_is_rejected(self):
        experiment = self.drive_experiment_to_running()
        packet = self.prepare()
        self.assertTrue(any(e["target_id"] == experiment and e["to"] == "running" for e in packet["source"]["events"]))
        methods = f"To test generalization, we run a paired comparison:\n\n{experiment}"
        artifact = next(ref for ref in packet["source"]["references"] if ref["kind"] == "artifact")
        refs = [{"kind": "experiment", "id": experiment, "label": "Current approach"}, artifact]
        other = self.call("project", action="create", name="Other scope")
        foreign = self.app.artifacts.contents.create(project_id=other["id"], path="foreign.md", data=b"Unrelated finding")
        with self.assertRaises(WorkflowError):
            self.publish(packet, references=[{"kind": "artifact", "id": foreign.id, "label": "Foreign"}])
        self.publish(packet, methods=methods, references=refs)
        self.transition_experiment(experiment, "abandon")
        document = self.document()
        self.assertEqual(document["methods"], methods)
        self.assertTrue(document["maintenance"]["pending"])
        self.assertEqual(document["references"][0]["status"], "abandoned")
        self.assertEqual(document["references"][1]["id"], artifact["id"])
        read = self.call("artifact.read", project_id=self.project_id, artifact_id=artifact["id"], include_content=True)
        self.assertIn("content", read)

    def test_more_records_do_not_expand_the_shared_document(self):
        experiment = self.create_experiment()
        self.publish(self.prepare())
        before = self.document()
        # A legacy project can contain a large history; automatic orientation
        # must not hydrate or append its records merely because they exist.
        with self.app.store.transaction() as conn:
            for index in range(50):
                conn.execute("INSERT INTO experiments (id, project_id, name, intent, status, attempt_index, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, 'complete', 1, 'now', 'now')",
                    (f"exp_history_{index}", self.project_id, f"history-{index}", "Detailed retained investigation."))
        after = self.document()
        self.assertEqual(research_contracts.render_project_document(before),
                         research_contracts.render_project_document(after))
        records = self.call("project", action="records", project_id=self.project_id)
        self.assertEqual(len(records["experiments"]), 51)
        self.assertIn(experiment, {r["id"] for r in records["experiments"]})

    def test_opposing_results_and_reflection_replace_the_account_with_selected_evidence(self):
        # This is a hand-authored editorial fixture, not a model-quality eval.
        first = self.drive_experiment_to_review("initial-setting")
        self.pass_review(target_type="experiment", target_id=first, role="experiment_reviewer")
        self.publish(self.prepare(), methods="Test the candidate in the initial setting.",
                     results="Accuracy was 0.72 against the 0.60 threshold; transfer is untested.")

        second = self.drive_experiment_to_running("held-out-setting")
        negative_report = VALID_REPORT.replace("0.72", "0.55").replace(
            "The registered threshold was met.",
            "The held-out setting missed the registered threshold; the initial gain did not transfer.")
        negative_id = ""
        for role, path, body in (
            ("result", "results.json", '{"accuracy": 0.55}'),
            ("report", "report.md", negative_report),
            ("graph", "graph.json", VALID_GRAPH.replace("0.72", "0.55")),
        ):
            artifact_id = self.submit(target_type="experiment", target_id=second,
                                      role=role, path=path, body=body)
            if role == "report":
                negative_id = artifact_id
        self.transition_experiment(second, "submit_results")
        self.pass_review(target_type="experiment", target_id=second, role="experiment_reviewer")

        wave = self.create_reflection("Reconcile opposing settings")
        self.submit_lenses(wave)
        self.call("reflection.transition", project_id=self.project_id, reflection_id=wave,
                  transition="submit_reflections")
        self.submit_reflection_bundle(wave, reflection=(
            "# Reflection\n\n## Summary\nInitial accuracy 0.72 did not transfer: held-out accuracy was 0.55.\n"
            "## Critical reading\nThe effect depends on setting; two observations cannot identify the mechanism.\n"
            "## Decision / future directions\nRun a controlled transfer test before claiming generality."))
        self.call("reflection.transition", project_id=self.project_id, reflection_id=wave,
                  transition="submit_reflection_artifacts")
        self.pass_review(target_type="reflection", target_id=wave, role="reflection_reviewer")
        self.consolidate_and_publish(wave)

        packet = self.prepare()
        records = {record["id"]: record for record in packet["source"]["records"]}
        self.assertEqual(records[second]["status"], "complete")
        self.assertEqual(records[wave]["status"], "published")
        negative = self.call("artifact.read", project_id=self.project_id,
                             artifact_id=negative_id, include_content=True)
        self.assertIn("did not transfer", negative["content"]["content"])
        wave_evidence = next(a for a in records[wave]["artifacts"] if a["label"] == "reflection_doc")
        selected_ids = {first, second, negative_id, wave, wave_evidence["id"]}
        refs = [ref for ref in packet["source"]["references"] if ref["id"] in selected_ids]
        methods = (f"Comparing the initial and held-out settings ({first}, {second}) exposed a transfer gap. "
                   f"The reviewed reflection ({wave}) motivates a controlled transfer test to isolate setting effects; "
                   "that follow-up is provisional, with no validated outcome yet.")
        results = (f"The candidate reached 0.72 against the 0.60 threshold initially, but only 0.55 held out "
                   f"({negative_id}). This supports a setting-specific gain, not a general improvement. "
                   f"The reflection ({wave_evidence['id']}) preserves this contrary result and leaves the mechanism unresolved.")
        self.publish(packet, methods=methods, results=results, references=refs,
                     editorial_note="Replaced the initial-only account with one cross-setting conclusion; "
                                    "retained the failed transfer and omitted per-run procedure available in the reports.")
        document = self.document()
        self.assertEqual(document["methods"], methods)
        self.assertEqual(document["results"], results)
        self.assertNotIn("transfer is untested", document["results"])
        self.assertEqual({ref["id"] for ref in document["references"]}, selected_ids)
        self.assertFalse(document["maintenance"]["pending"])
