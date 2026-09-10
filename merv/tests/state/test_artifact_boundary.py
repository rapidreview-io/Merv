"""Content independence and workflow-owned evidence across the artifact boundary."""

from __future__ import annotations

from contextlib import closing
from dataclasses import fields
from pathlib import Path
import tempfile
import unittest

from merv.brain.artifacts import Artifact, Artifacts
from tests.support.schema import booted_store
from merv.brain.kernel.utils import NotFoundError, ValidationError, new_id, now_iso
from merv.brain.research_core.artifact_models import ArtifactTarget
from merv.brain.research_core.artifacts import ResearchArtifacts
from tests.fakes import FakeBlobStore


class ArtifactFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = booted_store(Path(self.tmp.name) / "state.sqlite")
        self.core = Artifacts(store=self.store, blobs=FakeBlobStore())
        with closing(self.store.connect()) as tx:
            self.project_id = str(tx.execute("SELECT id FROM projects").fetchone()["id"])

    def create(self, data: bytes = b"evidence", *, path: str = "evidence.md") -> Artifact:
        return self.core.create(project_id=self.project_id, path=path, data=data)

    def other_project(self) -> str:
        project_id = new_id(prefix="proj")
        with self.store.transaction() as tx:
            tx.execute(
                "INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)",
                (project_id, "Other project", now_iso()),
            )
        return project_id


class GenericArtifactBoundaryTest(ArtifactFixture):
    def test_custom_content_needs_no_research_target_or_role(self) -> None:
        pending = self.core.submit(
            project_id=self.project_id, path="arbitrary.customformat", max_bytes=32
        )
        payload = b"\x00\xffarbitrary content"
        completed = self.core.complete_upload(
            token=pending.token, kind="artifact", data=payload
        )
        artifact = self.core.get(
            artifact_ids=(completed.artifact_id,),
            project_id=self.project_id,
            include="content",
        )[0]
        self.assertEqual(artifact.data, payload)
        self.assertEqual(artifact.size_bytes, len(payload))
        self.assertEqual(artifact.path, "arbitrary.customformat")
        self.assertFalse(
            {field.name for field in fields(Artifact)}
            & {"target_type", "target_id", "role", "attempt_index", "lens_id", "submission_id"}
        )
        with closing(self.store.connect()) as tx:
            self.assertEqual(tx.execute("SELECT COUNT(*) AS n FROM experiments").fetchone()["n"], 0)
            self.assertEqual(tx.execute("SELECT COUNT(*) AS n FROM research_artifact_links").fetchone()["n"], 0)

    def test_new_version_does_not_overwrite_the_previous_content(self) -> None:
        first = self.create(b"first")
        second = self.create(b"second")
        self.assertNotEqual(first.id, second.id)
        self.assertEqual(
            [artifact.data for artifact in self.core.get(
                artifact_ids=(first.id, second.id), include="content"
            )],
            [b"first", b"second"],
        )

    def test_generic_upload_cap_and_single_use_are_independent_of_roles(self) -> None:
        pending = self.core.submit(project_id=self.project_id, path="blob.xyz", max_bytes=3)
        self.assertEqual(self.core.upload_cap(token=pending.token, kind="artifact"), 3)
        with self.assertRaises(ValidationError):
            self.core.complete_upload(token=pending.token, kind="artifact", data=b"1234")
        self.core.complete_upload(token=pending.token, kind="artifact", data=b"123")
        with self.assertRaises(NotFoundError):
            self.core.complete_upload(token=pending.token, kind="artifact", data=b"456")
        self.assertEqual(self.core.get(artifact_ids=(pending.artifact_id,), include="content")[0].data, b"123")

    def test_declared_document_child_cannot_disappear_into_a_complete_manifest(self) -> None:
        pending = self.core.submit(
            project_id=self.project_id, path="document.md", discover_figures=True
        )
        completed = self.core.complete_upload(
            token=pending.token, kind="artifact", data=b"![plot](figures/plot.png)"
        )
        self.assertEqual([figure.link_path for figure in completed.figures], ["figures/plot.png"])
        with self.store.transaction() as tx:
            with self.assertRaises(ValidationError):
                self.core.assert_complete(
                    artifact_ids=(pending.artifact_id,), project_id=self.project_id, tx=tx
                )
            tx.execute(
                "UPDATE artifact_figures SET expires_at = '2000-01-01T00:00:00Z' WHERE artifact_id = ?",
                (pending.artifact_id,),
            )
        with self.assertRaises(NotFoundError):
            self.core.upload_cap(token=completed.figures[0].token, kind="figure")
        with self.store.transaction() as tx:
            with self.assertRaises(ValidationError):
                self.core.assert_complete(
                    artifact_ids=(pending.artifact_id,), project_id=self.project_id, tx=tx
                )

    def test_project_scoped_reads_and_completeness_do_not_leak_content(self) -> None:
        artifact = self.create()
        other = self.other_project()
        self.assertEqual(
            self.core.get(artifact_ids=(artifact.id,), project_id=other, include="content"), ()
        )
        with self.store.transaction() as tx:
            with self.assertRaises(NotFoundError):
                self.core.assert_complete(artifact_ids=(artifact.id,), project_id=other, tx=tx)


class ResearchArtifactBoundaryTest(ArtifactFixture):
    def setUp(self) -> None:
        super().setUp()
        self.research = ResearchArtifacts(store=self.store, artifacts=self.core)
        self.experiment_id = new_id(prefix="exp")
        self.task_id = new_id(prefix="task")
        with self.store.transaction() as tx:
            tx.execute(
                """INSERT INTO experiments
                   (id, project_id, name, intent, status, attempt_index, created_at, updated_at)
                   VALUES (?, ?, 'Boundary experiment', 'Check evidence ownership', 'planned', 1, ?, ?)""",
                (self.experiment_id, self.project_id, now_iso(), now_iso()),
            )
            tx.execute(
                """INSERT INTO tasks (id, project_id, name, goal, status, created_at, updated_at)
                   VALUES (?, ?, 'Boundary task', 'Check reusable evidence', 'in_progress', ?, ?)""",
                (self.task_id, self.project_id, now_iso(), now_iso()),
            )

    def target(self, *, task: bool = False, project_id: str | None = None) -> ArtifactTarget:
        return ArtifactTarget(
            target_type="task" if task else "experiment",
            target_id=self.task_id if task else self.experiment_id,
            project_id=self.project_id if project_id is None else project_id,
        )

    def test_one_content_version_can_serve_two_workflows_with_distinct_handles(self) -> None:
        content = self.create()
        plan = self.research.attach(artifact_id=content.id, target=self.target(), role="plan")
        delivery = self.research.attach(artifact_id=content.id, target=self.target(task=True), role="delivery")
        self.assertNotEqual(plan.id, delivery.id)
        self.assertEqual((plan.artifact_id, delivery.artifact_id), (content.id, content.id))
        found = self.research.get(artifact_ids=(plan.id, delivery.id), include="content")
        self.assertEqual([(item.target_type, item.role) for item in found], [("experiment", "plan"), ("task", "delivery")])
        self.assertEqual([item.data for item in found], [b"evidence", b"evidence"])

    def test_superseding_workflow_evidence_keeps_prior_content_readable(self) -> None:
        first, second = self.create(b"first"), self.create(b"second")
        self.research.attach(artifact_id=first.id, target=self.target(), role="plan")
        latest = self.research.attach(artifact_id=second.id, target=self.target(), role="plan")
        visible = self.research.scan(target_ids=(self.experiment_id,), roles=("plan",))
        self.assertEqual([item.id for item in visible], [latest.id])
        self.assertEqual(self.core.get(artifact_ids=(first.id,), include="content")[0].data, b"first")

    def test_unavailable_historical_bytes_cannot_be_accepted_as_new_evidence(self) -> None:
        content = self.create()
        self.core._blobs.blobs.pop((self.project_id, content.sha256))
        with self.assertRaisesRegex(ValidationError, "content is unavailable"):
            self.research.attach(artifact_id=content.id, target=self.target(), role="plan")
        self.assertEqual(self.research.scan(target_ids=(self.experiment_id,)), ())
        self.assertEqual(self.core.get(artifact_ids=(content.id,))[0].sha256, content.sha256)

    def test_cross_project_attachment_is_refused_without_changing_source_content(self) -> None:
        other = self.other_project()
        foreign = self.core.create(project_id=other, path="evidence.md", data=b"private")
        with self.assertRaises(NotFoundError):
            self.research.attach(artifact_id=foreign.id, target=self.target(), role="plan")
        self.assertEqual(self.research.scan(target_ids=(self.experiment_id,)), ())
        self.assertEqual(self.core.get(artifact_ids=(foreign.id,), project_id=other, include="content")[0].data, b"private")

    def test_each_snapshot_records_its_complete_composition_and_never_changes(self) -> None:
        plan = self.research.attach(
            artifact_id=self.create(b"approved plan", path="plan.md").id,
            target=self.target(), role="plan",
        )
        with self.store.transaction() as tx:
            self.research.seal(tx=tx, target=self.target(), transition="submit_design")
        report = self.research.attach(
            artifact_id=self.create(b"results", path="report.md").id,
            target=self.target(), role="report",
        )
        with self.store.transaction() as tx:
            self.research.seal(tx=tx, target=self.target(), transition="submit_results")
        before = self.snapshot_members()
        self.assertEqual(before, [{plan.id}, {plan.id, report.id}])

        replacement = self.research.attach(
            artifact_id=self.create(b"revised plan", path="plan.md").id,
            target=self.target(), role="plan",
        )
        self.assertEqual(self.snapshot_members(), before)
        with self.assertRaisesRegex(RuntimeError, "abort transition"):
            with self.store.transaction() as tx:
                self.research.seal(tx=tx, target=self.target(), transition="submit_results")
                raise RuntimeError("abort transition")
        self.assertEqual(self.snapshot_members(), before)

        with self.store.transaction() as tx:
            self.research.seal(tx=tx, target=self.target(), transition="submit_results")
        self.assertEqual(
            self.snapshot_members(), [*before, {replacement.id, report.id}]
        )
        self.assertEqual(
            self.core.get(artifact_ids=(plan.artifact_id,), include="content")[0].data,
            b"approved plan",
        )

    def snapshot_members(self) -> list[set[str]]:
        with closing(self.store.connect()) as tx:
            history = self.research.history(
                tx=tx, target_type="experiment", target_ids=(self.experiment_id,)
            )[self.experiment_id]
        result = []
        for submission in history.submissions:
            members = {
                artifact.id for artifact in self.research.snapshot(
                    submission_id=submission.id, project_id=self.project_id
                )
            }
            self.assertEqual(members, set(submission.artifact_ids))
            result.append(members)
        return result

    def test_stale_compatibility_upload_cannot_attach_to_a_new_attempt(self) -> None:
        pending = self.research.submit(target=self.target(), role="plan", path="plan.md")
        with self.store.transaction() as tx:
            tx.execute("UPDATE experiments SET attempt_index = 2 WHERE id = ?", (self.experiment_id,))
        with self.assertRaises(ValidationError):
            self.research.complete_upload(token=pending.token, kind="artifact", data=b"old attempt")
        self.assertEqual(self.research.scan(target_ids=(self.experiment_id,)), ())

    def test_seal_refuses_an_incomplete_document_manifest(self) -> None:
        pending = self.research.submit(target=self.target(), role="plan", path="plan.md")
        self.research.complete_upload(token=pending.token, kind="artifact", data=b"![plot](plot.png)")
        with self.assertRaises(ValidationError):
            with self.store.transaction() as tx:
                self.research.seal(tx=tx, target=self.target(), transition="submit_design")
        with closing(self.store.connect()) as tx:
            history = self.research.history(tx=tx, target_type="experiment", target_ids=(self.experiment_id,))[self.experiment_id]
        self.assertEqual(history.submissions, ())


if __name__ == "__main__":
    unittest.main()
