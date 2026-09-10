"""ResearchObjects: research facts about service objects, read without the service."""

from __future__ import annotations

import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from merv.brain.kernel.state.store import StateStore
from merv.brain.kernel.utils import NotFoundError, ValidationError
from merv.brain.research_core import ProducedObject, ResearchObjects


class CountingStateStore(StateStore):
    def __init__(self, *, db_path: Path) -> None:
        self.statements: list[str] = []
        super().__init__(db_path=db_path)

    def connect(self):
        conn = super().connect()
        conn.set_trace_callback(self.statements.append)
        return conn


def _record(object_id: str, *, name: str, version: int = 1, size: int = 3) -> dict:
    return {
        "id": object_id,
        "name": name,
        "version": version,
        "kind": "file",
        "content_sha256": object_id.ljust(64, "a")[:64],
        "size_bytes": size,
        "content_type": "application/octet-stream",
        "created_at": "2026-09-01T00:00:00Z",
    }


class ResearchObjectsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.store = CountingStateStore(db_path=Path(self.tmp.name) / "state.sqlite")
        with closing(self.store.connect()) as conn:
            self.project_id = str(conn.execute("SELECT id FROM projects ORDER BY created_at LIMIT 1").fetchone()["id"])
        self.objects = ResearchObjects(store=self.store)
        self.experiment_id = self._experiment("exp_one", project_id=self.project_id)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _experiment(self, experiment_id: str, *, project_id: str) -> str:
        with self.store.transaction() as conn:
            conn.execute(
                """
                INSERT INTO experiments (id, project_id, name, intent, status, attempt_index, created_at, updated_at)
                VALUES (?, ?, ?, 'test', 'planned', 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')
                """,
                (experiment_id, project_id, experiment_id),
            )
        return experiment_id

    def _submit(self, object_id: str, *, name: str, version: int = 1, **attributes) -> None:
        self.objects.submitted(
            project_id=self.project_id,
            record=_record(object_id, name=name, version=version),
            attributes={"kind": "model", **attributes},
        )

    def test_association_activates_at_completion_with_the_verified_snapshot(self) -> None:
        self._submit("obj_1", name="models/w.bin", producing_experiment_id=self.experiment_id,
                     producing_run="run-1", source_uri="s3://x", notes="kept")
        # Pending objects are not yet produced.
        self.assertEqual(
            self.objects.by_target(project_id=self.project_id, target_ids=(self.experiment_id,)),
            {self.experiment_id: []},
        )
        self.objects.completed(
            project_id=self.project_id,
            record={**_record("obj_1", name="models/w.bin"), "size_bytes": 99, "content_type": "text/plain"},
        )
        produced = self.objects.by_experiment(project_id=self.project_id, experiment_ids=(self.experiment_id,))
        self.assertEqual(len(produced[self.experiment_id]), 1)
        item: ProducedObject = produced[self.experiment_id][0]
        self.assertEqual(list(item), list(ProducedObject.__annotations__))
        self.assertEqual(item["id"], "obj_1")
        self.assertEqual(item["kind"], "model")
        self.assertEqual((item["size_bytes"], item["content_type"]), (99, "text/plain"))
        self.assertEqual((item["producing_run"], item["source_uri"], item["notes"]), ("run-1", "s3://x", "kept"))
        self.assertEqual(item["created_at"], "2026-09-01T00:00:00Z")
        link = self.objects.association(project_id=self.project_id, object_id="obj_1")
        self.assertEqual((link["target_type"], link["target_id"], link["status"]), ("experiment", self.experiment_id, "active"))

    def test_deleted_objects_leave_the_experiment_view(self) -> None:
        self._submit("obj_1", name="a", producing_experiment_id=self.experiment_id)
        self.objects.completed(project_id=self.project_id, record=_record("obj_1", name="a"))
        self.objects.deleted(project_id=self.project_id, object_id="obj_1")
        self.assertEqual(
            self.objects.by_target(project_id=self.project_id, target_ids=(self.experiment_id,)),
            {self.experiment_id: []},
        )
        self.assertEqual(self.objects.association(project_id=self.project_id, object_id="obj_1")["status"], "deleted")
        # A late completion never resurrects a deleted association.
        self.objects.completed(project_id=self.project_id, record=_record("obj_1", name="a"))
        self.assertEqual(self.objects.association(project_id=self.project_id, object_id="obj_1")["status"], "deleted")

    def test_untargeted_objects_keep_their_kind_but_belong_to_no_experiment(self) -> None:
        self._submit("obj_free", name="loose.bin")
        self.objects.completed(project_id=self.project_id, record=_record("obj_free", name="loose.bin"))
        link = self.objects.association(project_id=self.project_id, object_id="obj_free")
        self.assertEqual((link["target_type"], link["target_id"], link["kind"]), ("", "", "model"))
        self.assertEqual(self.objects.by_target(project_id=self.project_id, target_ids=(self.experiment_id,)),
                         {self.experiment_id: []})
        self.assertIsNone(self.objects.association(project_id=self.project_id, object_id="obj_unknown"))

    def test_submission_validates_kind_and_experiment_ownership(self) -> None:
        with self.assertRaisesRegex(ValidationError, "invalid storage kind"):
            self.objects.submitted(project_id=self.project_id, record=_record("obj_x", name="x"),
                                   attributes={"kind": "blob"})
        with self.assertRaises(NotFoundError):
            self._submit("obj_y", name="y", producing_experiment_id="exp_missing")
        other_project = "proj_other"
        with self.store.transaction() as conn:
            conn.execute("INSERT INTO projects (id, name, summary, created_at) VALUES (?, 'Other', '', '2026-09-01T00:00:00Z')",
                         (other_project,))
        foreign = self._experiment("exp_foreign", project_id=other_project)
        with self.assertRaises(NotFoundError):
            self._submit("obj_z", name="z", producing_experiment_id=foreign)
        self.assertIsNone(self.objects.association(project_id=self.project_id, object_id="obj_z"))

    def test_by_target_orders_batches_and_isolates_projects(self) -> None:
        other_project = "proj_other"
        with self.store.transaction() as conn:
            conn.execute("INSERT INTO projects (id, name, summary, created_at) VALUES (?, 'Other', '', '2026-09-01T00:00:00Z')",
                         (other_project,))
        shared = self._experiment("exp_shared", project_id=other_project)
        second = self._experiment("exp_two", project_id=self.project_id)
        self._submit("obj_old", name="models/ckpt.bin", version=1, producing_experiment_id=self.experiment_id)
        self._submit("obj_new", name="models/ckpt.bin", version=2, producing_experiment_id=self.experiment_id)
        self.objects.submitted(project_id=self.project_id, record=_record("obj_data", name="datasets/t.tar"),
                               attributes={"kind": "dataset", "producing_experiment_id": second})
        self.objects.submitted(project_id=other_project, record=_record("obj_other", name="other.bin"),
                               attributes={"kind": "other", "producing_experiment_id": shared})
        for object_id, project_id, name, version in (
            ("obj_old", self.project_id, "models/ckpt.bin", 1),
            ("obj_new", self.project_id, "models/ckpt.bin", 2),
            ("obj_data", self.project_id, "datasets/t.tar", 1),
            ("obj_other", other_project, "other.bin", 1),
        ):
            self.objects.completed(project_id=project_id, record=_record(object_id, name=name, version=version))
        self.store.statements.clear()

        result = self.objects.by_target(
            project_id=self.project_id, target_ids=(self.experiment_id, second, "exp_missing", self.experiment_id)
        )
        self.assertEqual(list(result), [self.experiment_id, second, "exp_missing"])
        self.assertEqual([item["id"] for item in result[self.experiment_id]], ["obj_new", "obj_old"])
        self.assertEqual([item["id"] for item in result[second]], ["obj_data"])
        self.assertEqual(result["exp_missing"], [])
        self.assertEqual(sum("FROM research_objects" in s for s in self.store.statements), 1)
        self.assertEqual(self.objects.by_target(project_id=other_project, target_ids=(shared,))[shared][0]["id"], "obj_other")
        self.assertEqual(self.objects.by_target(project_id=self.project_id, target_ids=(shared,)), {shared: []})
        self.assertEqual(self.objects.by_target(project_id=self.project_id, target_ids=()), {})

    def test_large_batches_are_chunked_below_sql_parameter_limits(self) -> None:
        target_ids = tuple(f"exp_{index}" for index in range(801))
        self.store.statements.clear()
        result = self.objects.by_target(project_id=self.project_id, target_ids=target_ids)
        self.assertEqual(list(result), list(target_ids))
        self.assertEqual(sum("FROM research_objects" in s for s in self.store.statements), 3)

    def test_adopt_records_historical_objects_once(self) -> None:
        snapshot = _record("obj_hist", name="datasets/h.tar")
        adopted = self.objects.adopt(
            project_id=self.project_id, object_id="obj_hist", kind="dataset",
            target_type="experiment", target_id=self.experiment_id, producing_run="r", source_uri="",
            notes="migrated", snapshot=snapshot, created_at="2026-01-01T00:00:00Z",
        )
        self.assertTrue(adopted)
        self.assertFalse(self.objects.adopt(
            project_id=self.project_id, object_id="obj_hist", kind="dataset",
            target_type="experiment", target_id=self.experiment_id, producing_run="r", source_uri="",
            notes="migrated", snapshot=snapshot, created_at="2026-01-01T00:00:00Z",
        ))
        produced = self.objects.by_target(project_id=self.project_id, target_ids=(self.experiment_id,))
        self.assertEqual([item["created_at"] for item in produced[self.experiment_id]], ["2026-01-01T00:00:00Z"])
        with self.assertRaises(ValidationError):
            self.objects.adopt(
                project_id=self.project_id, object_id="obj_bad", kind="dataset", target_type="experiment",
                target_id="", producing_run="", source_uri="", notes="", snapshot=snapshot, created_at="x",
            )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
