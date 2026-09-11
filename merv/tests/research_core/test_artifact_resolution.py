"""One door resolves an artifact id whether or not research associated it."""

from __future__ import annotations

from contextlib import closing
from pathlib import Path
import tempfile
import unittest

from merv.brain.artifacts import Artifacts
from merv.brain.research_core import (
    ArtifactTarget,
    CompletedArtifact,
    ResearchArtifacts,
)
from merv.brain.kernel.state import StateStore
from merv.brain.kernel.utils import NotFoundError, new_id, now_iso
from tests.support.blobs import LocalDirBlobStore

PLAN = "## Summary\nBody.\n\n## Objective\nGoal.\n\n## Evaluation\nMetric.\n"


class ArtifactResolutionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.store = StateStore(db_path=root / "state.sqlite")
        self.contents = Artifacts(
            store=self.store, blobs=LocalDirBlobStore(root=root / "blobs")
        )
        self.artifacts = ResearchArtifacts(store=self.store, artifacts=self.contents)
        with closing(self.store.connect()) as tx:
            self.project_id = str(tx.execute("SELECT id FROM projects").fetchone()["id"])
        self.experiment_id = new_id(prefix="exp")
        with self.store.transaction() as tx:
            tx.execute(
                """
                INSERT INTO experiments (
                  id, project_id, name, intent, status, attempt_index,
                  revision_context, created_at, updated_at
                )
                VALUES (?, ?, ?, 'test', 'planned', 1, '', ?, ?)
                """,
                (self.experiment_id, self.project_id, self.experiment_id,
                 now_iso(), now_iso()),
            )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _associated(self, *, path: str = "plan.md") -> str:
        """An id research knows: submitted against the experiment as its plan."""
        pending = self.artifacts.submit(
            target=ArtifactTarget("experiment", self.experiment_id, self.project_id),
            role="plan",
            path=path,
        )
        completed = self.artifacts.complete_upload(
            token=pending.token, kind="artifact", data=PLAN.encode()
        )
        assert isinstance(completed, CompletedArtifact)
        return completed.artifact_id

    def _loose(self, *, path: str = "notes.txt", data: bytes = b"loose") -> str:
        """An id only Artifacts knows: uploaded, never attached to anything."""
        pending = self.contents.submit(project_id=self.project_id, path=path)
        self.contents.complete_upload(
            token=pending.token, kind="artifact", data=data
        )
        return pending.artifact_id

    def test_mixed_ids_come_back_in_the_order_they_were_asked_for(self) -> None:
        associated = self._associated()
        loose = self._loose()
        second = self._associated(path="report.md")

        for order in ((loose, associated, second), (second, loose, associated)):
            with self.subTest(order=order):
                resolved = self.artifacts.resolve(
                    artifact_ids=order, project_id=self.project_id
                )
                self.assertEqual(tuple(item.id for item in resolved), order)

    def test_every_item_carries_the_same_fields_whatever_it_resolved_from(self) -> None:
        associated, loose = self._associated(), self._loose()
        by_id = {
            item.id: item
            for item in self.artifacts.resolve(
                artifact_ids=(associated, loose),
                project_id=self.project_id,
                include="content",
            )
        }

        research = by_id[associated]
        self.assertEqual(research.artifact_id, associated)
        self.assertEqual(research.target_type, "experiment")
        self.assertEqual(research.target_id, self.experiment_id)
        self.assertEqual(research.role, "plan")
        self.assertEqual(research.data, PLAN.encode())

        content = by_id[loose]
        # No association exists, so the association fields are empty rather
        # than absent: one type answers both kinds of id.
        self.assertEqual(content.id, loose)
        self.assertEqual(content.artifact_id, loose)
        self.assertEqual(content.project_id, self.project_id)
        self.assertEqual(
            (content.target_type, content.target_id, content.role,
             content.lens_id, content.submission_id, content.attempt_index),
            ("", "", "", "", "", 0),
        )
        self.assertEqual(content.path, "notes.txt")
        self.assertEqual(content.data, b"loose")
        self.assertEqual(content.size_bytes, len(b"loose"))
        self.assertEqual(content.status, "complete")
        self.assertEqual(content.figures, ())
        self.assertTrue(content.sha256 and content.created_at and content.updated_at)

    def test_an_attached_association_resolves_under_its_own_handle(self) -> None:
        loose = self._loose(path="metrics.json", data=b'{"auc": 0.9}')
        association = self.artifacts.attach(
            artifact_id=loose,
            target=ArtifactTarget("experiment", self.experiment_id, self.project_id),
            role="result",
        )
        self.assertNotEqual(association.id, loose)

        resolved = self.artifacts.resolve(
            artifact_ids=(association.id, loose), project_id=self.project_id
        )
        self.assertEqual(resolved[0].role, "result")
        self.assertEqual(resolved[0].artifact_id, loose)
        self.assertEqual(resolved[1].role, "")
        self.assertEqual(resolved[1].artifact_id, loose)

    def test_an_unknown_id_names_the_project_and_the_ids_it_could_not_find(self) -> None:
        known = self._associated()
        with self.assertRaises(NotFoundError) as missing:
            self.artifacts.resolve(
                artifact_ids=(known, "art_nope", "art_also_nope"),
                project_id=self.project_id,
            )
        self.assertIn(self.project_id, str(missing.exception))
        self.assertIn("art_nope", str(missing.exception))
        self.assertEqual(
            missing.exception.details["missing_artifact_ids"],
            ["art_nope", "art_also_nope"],
        )
        self.assertEqual(self.artifacts.resolve(
            artifact_ids=(), project_id=self.project_id
        ), ())

    def test_another_projects_artifact_is_not_found_here(self) -> None:
        loose = self._loose()
        with self.store.transaction() as tx:
            other = new_id(prefix="proj")
            tx.execute(
                "INSERT INTO projects (id, name, created_at) VALUES (?, 'Other', ?)",
                (other, now_iso()),
            )
        with self.assertRaises(NotFoundError):
            self.artifacts.resolve(artifact_ids=(loose,), project_id=other)


if __name__ == "__main__":
    unittest.main()
