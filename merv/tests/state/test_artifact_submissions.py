from __future__ import annotations

from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock

from merv.brain.artifacts.artifacts import (
    MAX_SUBMITTED_TEXT_BYTES,
    UPLOAD_TOKEN_TTL_SECONDS,
    ArtifactTarget,
    Artifacts,
    CompletedArtifact,
    CompletedFigure,
)
from merv.brain.kernel.state import StateStore
from merv.brain.kernel.utils import (
    NotFoundError,
    ValidationError,
    new_id,
    now_iso,
)
from tests.support.blobs import LocalDirBlobStore
from merv.brain.research_core.association_targets import AssociationTargets
from merv.shared.markdown_images import MARKDOWN_FIGURE_MAX_BYTES


PLAN = "## Summary\nBody.\n\n## Objective\nGoal.\n\n## Evaluation\nMetric.\n"
REPORT = (
    "## Summary\nRan it.\n\n## Results\n![curve](figures/curve.png)\n\n"
    "## Deviations from plan\nNone.\n\n## Conclusion\nDone.\n"
)


class ArtifactsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.store = StateStore(db_path=root / "state.sqlite")
        self.blobs = LocalDirBlobStore(root=root / "blobs")
        self.artifacts = Artifacts(
            store=self.store,
            blobs=self.blobs,
            targets=AssociationTargets(),
        )
        with closing(self.store.connect()) as tx:
            self.project_id = str(
                tx.execute("SELECT id FROM projects").fetchone()["id"]
            )
        self.experiment_id = self._insert_experiment()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _insert_experiment(self, *, attempt_index: int = 1) -> str:
        experiment_id = new_id(prefix="exp")
        with self.store.transaction() as tx:
            tx.execute(
                """
                INSERT INTO experiments (
                  id, project_id, name, intent, status, attempt_index,
                  revision_context, created_at, updated_at
                )
                VALUES (?, ?, ?, 'test', 'planned', ?, '', ?, ?)
                """,
                (
                    experiment_id,
                    self.project_id,
                    experiment_id,
                    attempt_index,
                    now_iso(),
                    now_iso(),
                ),
            )
        return experiment_id

    def _insert_reflection(self, *, status: str = "reflecting") -> str:
        reflection_id = new_id(prefix="ref")
        with self.store.transaction() as tx:
            tx.execute(
                """
                INSERT INTO reflections (
                  id, project_id, title, status, created_at, updated_at
                )
                VALUES (?, ?, 'Wave', ?, ?, ?)
                """,
                (
                    reflection_id,
                    self.project_id,
                    status,
                    now_iso(),
                    now_iso(),
                ),
            )
        return reflection_id

    def _submit(
        self,
        *,
        role: str = "plan",
        path: str = "plan.md",
        **kwargs,
    ):
        return self.artifacts.submit(
            target=self._target(),
            role=role,
            path=path,
            **kwargs,
        )

    def _target(
        self,
        target_id: str | None = None,
        *,
        target_type: str = "experiment",
        project_id: str | None = None,
    ) -> ArtifactTarget:
        return ArtifactTarget(
            target_type=target_type,
            target_id=target_id or self.experiment_id,
            project_id=project_id or self.project_id,
        )

    def _complete(self, pending, data: bytes = PLAN.encode()) -> CompletedArtifact:
        completed = self.artifacts.complete_upload(
            token=pending.token,
            kind="artifact",
            data=data,
        )
        assert isinstance(completed, CompletedArtifact)
        return completed

    def _history(self, target_id: str | None = None):
        target_id = target_id or self.experiment_id
        with closing(self.store.connect()) as tx:
            return self.artifacts.history(
                tx=tx,
                target_type="experiment",
                target_ids=(target_id,),
                summarize=True,
            )[target_id]

    def test_submit_upload_get_scan_and_history(self) -> None:
        pending = self._submit(path=r"\plans\plan.md")
        self.assertTrue(pending.artifact_id.startswith("art_"))
        self.assertEqual(pending.path, "plans/plan.md")

        completed = self._complete(pending)
        self.assertEqual(completed.artifact_id, pending.artifact_id)
        self.assertEqual(completed.figures, ())

        payload = self.artifacts.get(
            artifact_ids=(pending.artifact_id,),
            project_id=self.project_id,
            include="content",
        )[0]
        self.assertEqual(payload.data, PLAN.encode())
        self.assertEqual(payload.role, "plan")
        self.assertEqual(payload.attempt_index, 1)

        scanned = self.artifacts.scan(
            project_id=self.project_id,
            target_type="experiment",
            target_ids=(self.experiment_id,),
        )
        self.assertEqual([artifact.id for artifact in scanned], [pending.artifact_id])
        history = self._history()
        self.assertEqual([artifact.id for artifact in history.artifacts], [pending.artifact_id])
        self.assertTrue(history.artifacts[0].tldr)

    def test_history_reads_blobs_only_for_best_effort_summaries(self) -> None:
        pending = self._submit()
        self._complete(pending)
        unavailable_blobs = Mock(wraps=self.blobs)
        unavailable_blobs.get.side_effect = RuntimeError("storage unavailable")
        artifacts = Artifacts(
            store=self.store,
            blobs=unavailable_blobs,
            targets=AssociationTargets(),
        )

        with closing(self.store.connect()) as tx:
            plain = artifacts.history(
                tx=tx,
                target_type="experiment",
                target_ids=(self.experiment_id,),
            )[self.experiment_id]
        unavailable_blobs.get.assert_not_called()
        self.assertEqual([item.id for item in plain.artifacts], [pending.artifact_id])
        self.assertEqual(plain.artifacts[0].tldr, "")

        with closing(self.store.connect()) as tx:
            summarized = artifacts.history(
                tx=tx,
                target_type="experiment",
                target_ids=(self.experiment_id,),
                summarize=True,
            )[self.experiment_id]
        unavailable_blobs.get.assert_called_once()
        self.assertEqual(
            [item.id for item in summarized.artifacts],
            [pending.artifact_id],
        )
        self.assertIn("No submitted text is available", summarized.artifacts[0].tldr)

    def test_submit_validates_role_lens_and_project(self) -> None:
        with self.assertRaises(ValidationError):
            self._submit(role="code", path="train.py")
        with self.assertRaises(ValidationError):
            self._submit(role="reflection_lens_doc", path="rigor.md")
        with self.assertRaises(ValidationError):
            self._submit(role="plan", lens_id="rigor")
        with self.assertRaises(NotFoundError):
            self.artifacts.submit(
                target=self._target(project_id="proj_missing"),
                role="plan",
                path="plan.md",
            )

    def test_upload_token_is_capped_expiring_and_single_use(self) -> None:
        with self.assertRaises(NotFoundError):
            self.artifacts.upload_cap(token="unknown", kind="artifact")
        pending = self._submit()
        self.assertEqual(
            self.artifacts.upload_cap(token=pending.token, kind="artifact"),
            MAX_SUBMITTED_TEXT_BYTES,
        )
        self._complete(pending)
        with self.assertRaises(NotFoundError):
            self._complete(pending)

        expired = self._submit(path="expired.md")
        with self.store.transaction() as tx:
            tx.execute(
                """
                UPDATE artifacts SET expires_at = '2000-01-01T00:00:00Z'
                WHERE id = ?
                """,
                (expired.artifact_id,),
            )
        with self.assertRaises(NotFoundError):
            self._complete(expired)
        self.assertGreater(UPLOAD_TOKEN_TTL_SECONDS, 0)

    def test_oversize_upload_rolls_back_and_allows_a_smaller_retry(self) -> None:
        pending = self._submit()
        with self.assertRaises(ValidationError) as caught:
            self._complete(pending, b"x" * (MAX_SUBMITTED_TEXT_BYTES + 1))
        self.assertEqual(
            caught.exception.details["max_bytes"],
            MAX_SUBMITTED_TEXT_BYTES,
        )
        self.assertEqual(self._complete(pending).artifact_id, pending.artifact_id)

    def test_resubmit_replaces_live_rows_but_not_sealed_history(self) -> None:
        first = self._submit()
        self._complete(first)
        second = self._submit()
        self._complete(second, (PLAN + "v2\n").encode())
        self.assertEqual(
            [item.id for item in self.artifacts.scan(target_ids=(self.experiment_id,))],
            [second.artifact_id],
        )

        with self.store.transaction() as tx:
            self.artifacts.seal(
                tx=tx,
                target=self._target(),
                transition="submit_design",
            )
        third = self._submit()
        self._complete(third, (PLAN + "v3\n").encode())

        history = self._history()
        submission = history.submissions[0]
        by_id = {item.id: item for item in history.artifacts}
        self.assertEqual(set(by_id), {second.artifact_id, third.artifact_id})
        self.assertEqual(by_id[second.artifact_id].submission_id, submission.id)
        self.assertEqual(by_id[third.artifact_id].submission_id, "")
        self.assertEqual([item.id for item in history.submissions], [submission.id])

    def test_seal_uses_the_callers_transaction(self) -> None:
        pending = self._submit()
        self._complete(pending)
        with self.assertRaisesRegex(RuntimeError, "force rollback"):
            with self.store.transaction() as tx:
                self.artifacts.seal(
                    tx=tx,
                    target=self._target(),
                    transition="submit_design",
                )
                raise RuntimeError("force rollback")
        history = self._history()
        self.assertEqual(history.submissions, ())
        self.assertEqual(history.artifacts[0].submission_id, "")

    def test_stale_attempt_token_is_deleted_before_refusal(self) -> None:
        pending = self._submit()
        with self.store.transaction() as tx:
            tx.execute(
                "UPDATE experiments SET attempt_index = 2 WHERE id = ?",
                (self.experiment_id,),
            )
        with self.assertRaisesRegex(ValidationError, "attempt superseded"):
            self._complete(pending)
        with self.assertRaises(NotFoundError):
            self._complete(pending)

    def test_terminal_target_token_is_deleted_before_refusal(self) -> None:
        reflection_id = self._insert_reflection()
        pending = self.artifacts.submit(
            target=self._target(reflection_id, target_type="reflection"),
            role="reflection_doc",
            path="reflection.md",
        )
        with self.store.transaction() as tx:
            tx.execute(
                "UPDATE reflections SET status = 'published' WHERE id = ?",
                (reflection_id,),
            )
        with self.assertRaisesRegex(ValidationError, "published"):
            self.artifacts.complete_upload(
                token=pending.token,
                kind="artifact",
                data=b"## Summary\nDone.\n",
            )
        with self.assertRaises(NotFoundError):
            self.artifacts.upload_cap(token=pending.token, kind="artifact")

    def test_figure_uploads_are_typed_capped_and_readable(self) -> None:
        report = self._submit(role="report", path="reports/report.md")
        completed = self._complete(report, REPORT.encode())
        self.assertEqual(
            [figure.link_path for figure in completed.figures],
            ["figures/curve.png"],
        )
        figure = completed.figures[0]
        self.assertEqual(
            self.artifacts.upload_cap(token=figure.token, kind="figure"),
            MARKDOWN_FIGURE_MAX_BYTES,
        )
        png = b"\x89PNG fake"
        uploaded = self.artifacts.complete_upload(
            token=figure.token,
            kind="figure",
            data=png,
        )
        self.assertIsInstance(uploaded, CompletedFigure)
        assert isinstance(uploaded, CompletedFigure)
        self.assertEqual(uploaded.artifact_id, report.artifact_id)
        self.assertEqual(
            self.artifacts.figure(
                artifact_id=report.artifact_id,
                link_path="figures/curve.png",
                project_id=self.project_id,
            ),
            png,
        )
        payload = self.artifacts.get(
            artifact_ids=(report.artifact_id,),
            include="document",
        )[0]
        self.assertEqual(payload.figures, ("figures/curve.png",))
        with self.assertRaises(NotFoundError):
            self.artifacts.complete_upload(
                token=figure.token,
                kind="figure",
                data=png,
            )

    def test_unsafe_figure_link_rolls_back_for_a_fixed_retry(self) -> None:
        for index, link in enumerate(
            ("../secret.png", "figs;rm.png", "figs/`id`.png", "$HOME.png")
        ):
            pending = self._submit(role="report", path=f"report-{index}.md")
            with self.assertRaises(ValidationError):
                self._complete(
                    pending,
                    f"## Summary\nS.\n\n![x]({link})\n".encode(),
                )
            self.assertEqual(
                self._complete(pending, b"## Summary\nFixed.\n").artifact_id,
                pending.artifact_id,
            )

    def test_stale_figure_token_cannot_mutate_a_closed_round(self) -> None:
        report = self._submit(role="report", path="report.md")
        figure_token = self._complete(report, REPORT.encode()).figures[0].token
        with self.store.transaction() as tx:
            tx.execute(
                "UPDATE experiments SET attempt_index = 2 WHERE id = ?",
                (self.experiment_id,),
            )
        with self.assertRaisesRegex(ValidationError, "attempt superseded"):
            self.artifacts.complete_upload(
                token=figure_token,
                kind="figure",
                data=b"\x89PNG",
            )
        self.assertIsNone(
            self.artifacts.figure(
                artifact_id=report.artifact_id,
                link_path="figures/curve.png",
            )
        )

    def test_get_is_ordered_omits_missing_ids_and_supports_read_modes(self) -> None:
        second = self._submit(role="result", path="second.txt")
        self._complete(second, b"second")
        self.artifacts.pin(
            target=self._target(),
            role="exhibit",
            path="large.json",
            data=b"a" * (MAX_SUBMITTED_TEXT_BYTES + 10),
        )
        first_id = self.artifacts.scan(
            target_ids=(self.experiment_id,),
            roles=("exhibit",),
        )[0].id

        payloads = self.artifacts.get(
            artifact_ids=(
                second.artifact_id,
                "art_missing",
                first_id,
                second.artifact_id,
            ),
            include="content",
        )
        self.assertEqual(
            [payload.id for payload in payloads],
            [second.artifact_id, first_id],
        )
        self.assertEqual(
            len(payloads[1].data or b""),
            MAX_SUBMITTED_TEXT_BYTES + 10,
        )
        metadata = self.artifacts.get(artifact_ids=(first_id,))
        self.assertIsNone(metadata[0].data)

    def test_content_reads_isolate_blob_errors_but_document_reads_are_strict(
        self,
    ) -> None:
        unavailable = self._submit(path="unavailable.md")
        unavailable_result = self._complete(unavailable)
        available = self._submit(role="result", path="available.txt")
        self._complete(available, b"available")

        original_get = self.blobs.get

        def flaky_get(*, namespace: str, sha256: str) -> bytes:
            if sha256 == unavailable_result.sha256:
                raise RuntimeError("transient storage failure")
            return original_get(namespace=namespace, sha256=sha256)

        flaky_blobs = Mock(wraps=self.blobs)
        flaky_blobs.get.side_effect = flaky_get
        artifacts = Artifacts(
            store=self.store,
            blobs=flaky_blobs,
            targets=AssociationTargets(),
        )

        content = artifacts.get(
            artifact_ids=(unavailable.artifact_id, available.artifact_id),
            include="content",
        )
        self.assertEqual(
            [artifact.id for artifact in content],
            [unavailable.artifact_id, available.artifact_id],
        )
        self.assertIsNone(content[0].data)
        self.assertEqual(content[1].data, b"available")

        with self.assertRaisesRegex(RuntimeError, "transient storage failure"):
            artifacts.get(
                artifact_ids=(unavailable.artifact_id,),
                include="document",
            )

    def test_scan_filters_complete_rows_roles_and_targets(self) -> None:
        pending = self._submit(path="pending.md")
        plan = self._submit(path="plan.md")
        result = self._submit(role="result", path="result.json")
        self._complete(plan)
        self._complete(result, b'{"accuracy": 0.9}')
        other_id = self._insert_experiment(attempt_index=2)
        other = self.artifacts.submit(
            target=self._target(other_id),
            role="plan",
            path="other.md",
        )
        self._complete(other, b"other")

        scanned = self.artifacts.scan(
            project_id=self.project_id,
            target_type="experiment",
            target_ids=(self.experiment_id, other_id),
            roles=("plan",),
        )
        self.assertEqual(
            {item.id for item in scanned},
            {plan.artifact_id, other.artifact_id},
        )
        self.assertNotIn(pending.artifact_id, {item.id for item in scanned})

    def test_artifact_event_and_replacement_share_one_transaction(self) -> None:
        original = self._submit()
        self._complete(original)
        replacement = self._submit()
        with self.store.transaction() as tx:
            tx.execute(
                """
                CREATE TRIGGER reject_artifact_submitted
                BEFORE INSERT ON events
                WHEN NEW.type = 'artifact.submitted'
                BEGIN
                  SELECT RAISE(ABORT, 'forced artifact event failure');
                END
                """
            )
        with self.assertRaisesRegex(
            sqlite3.IntegrityError,
            "forced artifact event failure",
        ):
            self._complete(replacement, (PLAN + "v2\n").encode())

        with closing(self.store.connect()) as tx:
            rows = tx.execute(
                """
                SELECT id, status, content_sha256 FROM artifacts
                WHERE target_id = ? AND role = 'plan'
                ORDER BY created_seq
                """,
                (self.experiment_id,),
            ).fetchall()
            event = tx.execute(
                """
                SELECT payload_json FROM events
                WHERE type = 'artifact.submitted' AND target_id = ?
                """,
                (self.experiment_id,),
            ).fetchone()
        self.assertEqual(
            [(str(row["id"]), str(row["status"])) for row in rows],
            [
                (original.artifact_id, "complete"),
                (replacement.artifact_id, "pending"),
            ],
        )
        self.assertEqual(str(rows[1]["content_sha256"]), "")
        self.assertEqual(
            json.loads(str(event["payload_json"])),
            {
                "artifact_id": original.artifact_id,
                "attempt_index": 1,
                "path": "plan.md",
                "role": "plan",
            },
        )

    def test_pin_is_complete_and_event_atomic(self) -> None:
        self.artifacts.pin(
            target=self._target(),
            role="exhibit",
            path="metrics/exhibit.json",
            data=b'{"version": 1}',
        )
        original = self.artifacts.scan(
            target_ids=(self.experiment_id,),
            roles=("exhibit",),
        )[0]

        with self.store.transaction() as tx:
            tx.execute(
                """
                CREATE TRIGGER reject_artifact_pinned
                BEFORE INSERT ON events
                WHEN NEW.type = 'artifact.pinned'
                BEGIN
                  SELECT RAISE(ABORT, 'forced pinned event failure');
                END
                """
            )
        with self.assertRaisesRegex(sqlite3.IntegrityError, "forced pinned event"):
            self.artifacts.pin(
                target=self._target(),
                role="exhibit",
                path="metrics/exhibit.json",
                data=b'{"version": 2}',
            )
        after = self.artifacts.scan(
            target_ids=(self.experiment_id,),
            roles=("exhibit",),
        )
        self.assertEqual([item.id for item in after], [original.id])
        payload = self.artifacts.get(
            artifact_ids=(original.id,),
            include="content",
        )[0]
        self.assertEqual(payload.data, b'{"version": 1}')


if __name__ == "__main__":
    unittest.main()
