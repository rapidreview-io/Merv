from __future__ import annotations

from merv.brain.workflows import Workflows

import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from dataclasses import FrozenInstanceError
from pathlib import Path

from merv.brain.artifacts import Artifacts
from merv.brain.kernel.state.store import StateStore
from merv.brain.research_core.experiments import (
    TRACKING_EVENT_TYPES,
    ExperimentService,
)
from merv.brain.research_core import Research, ResearchArtifacts
from tests.fakes import FakeBlobStore


class CommittedEventTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.store = StateStore(db_path=Path(self.tmp.name) / "state.sqlite")
        self.artifacts = ResearchArtifacts(
            store=self.store,
            artifacts=Artifacts(store=self.store, blobs=FakeBlobStore()),
        )
        with closing(self.store.connect()) as conn:
            row = conn.execute("SELECT id FROM projects").fetchone()
            assert row is not None
            self.project_id = str(row["id"])

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_record_event_returns_exact_row_and_deep_frozen_payload(self) -> None:
        payload = {"z": [{"nested": "original"}], "a": 1}
        with self.store.transaction() as conn:
            event = self.store.record_event(
                conn=conn,
                project_id=self.project_id,
                event_type="test.recorded",
                target_type="test",
                target_id="target_1",
                payload=payload,
            )
            payload["z"][0]["nested"] = "caller-mutated"

        with closing(self.store.connect()) as conn:
            row = conn.execute(
                "SELECT * FROM events WHERE id = ?", (event.id,)
            ).fetchone()
        assert row is not None
        self.assertEqual(
            str(row["payload_json"]), '{"a": 1, "z": [{"nested": "original"}]}'
        )
        self.assertEqual(event.project_id, str(row["project_id"]))
        self.assertEqual(event.type, str(row["type"]))
        self.assertEqual(event.target_type, str(row["target_type"]))
        self.assertEqual(event.target_id, str(row["target_id"]))
        self.assertEqual(event.created_at, str(row["created_at"]))
        self.assertEqual(event.payload["z"][0]["nested"], "original")
        self.assertIsInstance(event.payload["z"], tuple)
        with self.assertRaises(TypeError):
            event.payload["new"] = "nope"
        with self.assertRaises(TypeError):
            event.payload["z"][0]["nested"] = "nope"
        with self.assertRaises(FrozenInstanceError):
            event.type = "changed"

        wire = self.store.recent_events(
            project_id=self.project_id, after_id=event.id - 1
        )["events"]
        self.assertEqual(
            wire,
            [
                {
                    "id": event.id,
                    "project_id": self.project_id,
                    "type": "test.recorded",
                    "target_type": "test",
                    "target_id": "target_1",
                    "created_at": event.created_at,
                    "payload": {"a": 1, "z": [{"nested": "original"}]},
                }
            ],
        )
        wire[0]["payload"]["z"][0]["nested"] = "wire-remains-mutable"
        self.assertEqual(event.payload["z"][0]["nested"], "original")

    def test_research_transition_returns_its_exact_committed_event(self) -> None:
        research = Research(store=self.store, artifacts=self.artifacts, workflows=Workflows(store=self.store))
        created = research.create_experiment(
            project_id=self.project_id, name="committed-event", intent="test"
        )
        committed = research.transition_experiment(
            project_id=self.project_id,
            experiment_id=created["id"],
            transition="mark_failed",
            evidence={"reason": "expected failure", "codes": [1, 2]},
        )
        state, event = committed.state, committed.event
        with self.assertRaises(FrozenInstanceError):
            committed.event = event
        self.assertEqual(state["status"], "failed")
        self.assertEqual(event.type, "experiment.transitioned")
        self.assertEqual(event.target_id, created["id"])
        self.assertEqual(
            dict(event.payload),
            {
                "evidence": {"codes": (1, 2), "reason": "expected failure"},
                "from": "planned",
                "to": "failed",
                "transition": "mark_failed",
                "workflow": "experiment", "version": 1, "revision": 1,
            },
        )

        with closing(self.store.connect()) as conn:
            row = conn.execute(
                "SELECT payload_json FROM events WHERE id = ?",
                (event.id,),
            ).fetchone()
        assert row is not None
        self.assertEqual(
            json.loads(str(row["payload_json"])),
            {
                "evidence": {"codes": [1, 2], "reason": "expected failure"},
                "from": "planned",
                "to": "failed",
                "transition": "mark_failed",
                "workflow": "experiment", "version": 1, "revision": 1,
            },
        )

    def test_tracking_refresh_returns_the_exact_committed_ledger_event(self) -> None:
        experiments = Research(store=self.store, artifacts=self.artifacts, workflows=Workflows(store=self.store))._experiments
        research = Research(store=self.store, artifacts=self.artifacts, workflows=Workflows(store=self.store))
        created = experiments.create(
            project_id=self.project_id, name="tracking-event", intent="test"
        )
        run = {
            "run_id": "run_1",
            "run_name": "owned",
            "status": "FINISHED",
            "artifact_uri": "s3://tracking/run_1",
            "created_at": "2026-07-19T18:00:00Z",
        }

        committed = research.refresh_tracking_run(
            project_id=self.project_id,
            experiment_id=created["id"],
            run=run,
        )

        with closing(self.store.connect()) as conn:
            row = conn.execute(
                "SELECT * FROM events WHERE id = ?", (committed.event.id,)
            ).fetchone()
        assert row is not None
        self.assertEqual(committed.event.type, "experiment.mlflow_run_refreshed")
        self.assertEqual(committed.event.target_id, created["id"])
        self.assertEqual(committed.event.created_at, str(row["created_at"]))
        self.assertEqual(
            dict(committed.event.payload), json.loads(str(row["payload_json"]))
        )
        self.assertEqual(committed.state["mlflow_run"]["run_id"], "run_1")
        self.assertEqual(committed.state["mlflow_run"]["status"], "FINISHED")

    def test_event_insert_failure_rolls_back_state_and_event_together(self) -> None:
        experiments = Research(store=self.store, artifacts=self.artifacts, workflows=Workflows(store=self.store))._experiments
        created = experiments.create(
            project_id=self.project_id, name="rollback-event", intent="test"
        )
        with self.store.transaction() as conn:
            conn.execute(
                """
                CREATE TRIGGER reject_transition_event
                BEFORE INSERT ON events
                WHEN NEW.type = 'experiment.transitioned'
                BEGIN
                  SELECT RAISE(ABORT, 'forced event failure');
                END
                """
            )

        with self.assertRaisesRegex(sqlite3.IntegrityError, "forced event failure"):
            experiments.transition_with_event(
                project_id=self.project_id,
                experiment_id=created["id"],
                transition="mark_failed",
            )

        state = experiments.get_state(
            project_id=self.project_id, experiment_id=created["id"]
        )
        self.assertEqual(state["status"], "planned")
        with closing(self.store.connect()) as conn:
            row = conn.execute(
                """
                SELECT COUNT(*) AS count FROM events
                WHERE type = 'experiment.transitioned' AND target_id = ?
                """,
                (created["id"],),
            ).fetchone()
        assert row is not None
        self.assertEqual(int(row["count"]), 0)


class TrackingDeliveryLedgerSqlTest(unittest.TestCase):
    """The delivery barrier over the real SQL, not an in-memory stand-in.

    The application tests prove the handler's decisions; only these prove the
    query behind them, so a filter or ordering regression cannot duplicate a
    durable event while every lost-ack test stays green.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.store = StateStore(db_path=Path(self.tmp.name) / "state.sqlite")
        artifacts = ResearchArtifacts(
            store=self.store,
            artifacts=Artifacts(store=self.store, blobs=FakeBlobStore()),
        )
        self.experiments = Research(store=self.store, artifacts=artifacts, workflows=Workflows(store=self.store))._experiments
        with closing(self.store.connect()) as conn:
            row = conn.execute("SELECT id FROM projects").fetchone()
            assert row is not None
            self.project_id = str(row["id"])
        self.experiment_id = self.experiments.create(
            project_id=self.project_id, name="delivery-ledger", intent="test"
        )["id"]

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _record(self, *, run_id: str, delivery_id: int | None) -> dict:
        return self.experiments.record_mlflow_run(
            project_id=self.project_id,
            experiment_id=self.experiment_id,
            run={"run_id": run_id, "status": "RUNNING"},
            delivery_id=delivery_id,
        )

    def _tracking_events(self) -> list[dict]:
        with closing(self.store.connect()) as conn:
            rows = conn.execute(
                "SELECT type, payload_json FROM events WHERE target_id = ?"
                "  AND type IN (?, ?, ?) ORDER BY id",
                (self.experiment_id, *TRACKING_EVENT_TYPES),
            ).fetchall()
        return [
            {"type": str(row["type"]), **json.loads(str(row["payload_json"]))}
            for row in rows
        ]

    def _delivery_rows(self) -> list[tuple[int, str]]:
        """The normalized delivery keys, oldest append first."""
        with closing(self.store.connect()) as conn:
            rows = conn.execute(
                "SELECT delivery_id, target_type FROM tracking_deliveries"
                "  WHERE target_id = ? ORDER BY event_id",
                (self.experiment_id,),
            ).fetchall()
        return [(int(row["delivery_id"]), str(row["target_type"])) for row in rows]

    def test_sql_lookup_finds_the_delivery_and_the_writer_no_ops_on_a_duplicate(
        self,
    ) -> None:
        self._record(run_id="run_a", delivery_id=41)

        found = self.experiments.tracking_delivery_state(
            project_id=self.project_id,
            experiment_id=self.experiment_id,
            delivery_id=41,
        )
        assert found is not None
        self.assertEqual(found["mlflow_run"]["run_id"], "run_a")
        # A delivery that never wrote is absent: the query correlates on the
        # payload key, not on "this experiment has some tracking event".
        self.assertIsNone(
            self.experiments.tracking_delivery_state(
                project_id=self.project_id,
                experiment_id=self.experiment_id,
                delivery_id=42,
            )
        )

        # The duplicate carries a different run so a no-op is distinguishable
        # from a re-write that happens to land the same values.
        replayed = self._record(run_id="run_replayed", delivery_id=41)

        self.assertEqual(replayed["mlflow_run"]["run_id"], "run_a")
        # The event-returning shape stays total across the no-op: it answers
        # with the event that landed rather than inventing one.
        refreshed = self.experiments.record_mlflow_run(
            project_id=self.project_id,
            experiment_id=self.experiment_id,
            run={"run_id": "run_replayed", "status": "RUNNING"},
            delivery_id=41,
            return_event=True,
        )
        self.assertEqual(refreshed.event.payload["run_id"], "run_a")
        self.assertEqual(refreshed.event.payload["delivery_id"], 41)
        self.assertEqual(
            self._tracking_events(),
            [
                {
                    "type": "experiment.mlflow_run_created",
                    "run_id": "run_a",
                    "run_name": "",
                    "status": "RUNNING",
                    "error": "",
                    "previous_run_id": "",
                    "delivery_id": 41,
                }
            ],
        )
        # One delivery row, written with the append it names — the replays
        # found it there and added none.
        self.assertEqual(self._delivery_rows(), [(41, "experiment")])

    def test_a_rival_write_after_a_negative_read_cannot_duplicate_the_append(
        self,
    ) -> None:
        # The race the barrier exists for: A's ledger read (its own
        # transaction) finds nothing, A's write commits late anyway, a newer
        # delivery B commits on top, and only then does A retry.
        self.assertIsNone(
            self.experiments.tracking_delivery_state(
                project_id=self.project_id,
                experiment_id=self.experiment_id,
                delivery_id=41,
            )
        )
        self._record(run_id="run_a", delivery_id=41)  # A's delayed commit
        self._record(run_id="run_rival", delivery_id=99)  # B, the newer outcome

        retried = self._record(run_id="run_a", delivery_id=41)

        # One append per delivery, and A's older outcome does not come back.
        self.assertEqual(
            [
                (event["delivery_id"], event["run_id"])
                for event in self._tracking_events()
            ],
            [(41, "run_a"), (99, "run_rival")],
        )
        self.assertEqual(retried["mlflow_run"]["run_id"], "run_rival")

    def test_an_unkeyed_write_is_never_deduplicated(self) -> None:
        # refresh_tracking_run carries no delivery id; the barrier must not
        # collapse those writes into the first one.
        self._record(run_id="run_a", delivery_id=None)
        self._record(run_id="run_b", delivery_id=None)

        self.assertEqual(
            [event["run_id"] for event in self._tracking_events()],
            ["run_a", "run_b"],
        )
        # An unkeyed write has no delivery to name, so it claims no key.
        self.assertEqual(self._delivery_rows(), [])

    def test_unkeyed_refreshes_are_never_mistaken_for_a_delivery(self) -> None:
        # mlflow.finalize_run appends an unkeyed refresh every time an agent
        # calls it, without limit. Those carry no delivery id and are excluded
        # from the lookup by type, so no volume of them can make a committed
        # delivery look absent and create a second MLflow run.
        self._record(run_id="run_a", delivery_id=41)
        for index in range(205):
            self.experiments.record_mlflow_run(
                project_id=self.project_id,
                experiment_id=self.experiment_id,
                run={"run_id": "run_a", "status": f"RUNNING-{index}"},
                event_type="experiment.mlflow_run_refreshed",
            )

        found = self.experiments.tracking_delivery_state(
            project_id=self.project_id,
            experiment_id=self.experiment_id,
            delivery_id=41,
        )
        assert found is not None
        replayed = self._record(run_id="run_redelivered", delivery_id=41)

        self.assertEqual(replayed["mlflow_run"]["run_id"], "run_a")
        keyed = [event for event in self._tracking_events() if "delivery_id" in event]
        self.assertEqual(
            [(event["type"], event["run_id"]) for event in keyed],
            [("experiment.mlflow_run_created", "run_a")],
        )

    def test_the_oldest_delivery_survives_an_unbounded_run_of_keyed_events(
        self,
    ) -> None:
        # Nothing caps an experiment's keyed tracking events: a `retry_running`
        # loop during an MLflow outage appends one `mlflow_run_unavailable` per
        # attempt while the experiment never leaves `running`. The keyed row
        # the lookup reads is exact and permanent, so the FIRST delivery stays
        # findable behind any number of later ones — an aged-out delivery would
        # let its replay write a second MLflow run.
        self._record(run_id="run_a", delivery_id=41)
        for index in range(205):
            self._record(run_id=f"run_{index}", delivery_id=100 + index)

        self.assertIsNotNone(
            self.experiments.tracking_delivery_state(
                project_id=self.project_id,
                experiment_id=self.experiment_id,
                delivery_id=41,
            )
        )
        # Every keyed write left exactly one delivery row, and the oldest is
        # reached by that row rather than by walking the newer ones.
        self.assertEqual(self._delivery_rows()[0], (41, "experiment"))
        self.assertEqual(len(self._delivery_rows()), 206)
        before = self._tracking_events()
        replayed = self._record(run_id="run_redelivered", delivery_id=41)

        # The replay is a no-op that answers with the currently durable run,
        # not with its own stale intent, and appends nothing.
        self.assertEqual(replayed["mlflow_run"]["run_id"], "run_204")
        self.assertEqual(self._tracking_events(), before)
        self.assertEqual(
            [event for event in before if event.get("delivery_id") == 41],
            [
                {
                    "type": "experiment.mlflow_run_created",
                    "run_id": "run_a",
                    "run_name": "",
                    "status": "RUNNING",
                    "error": "",
                    "previous_run_id": "",
                    "delivery_id": 41,
                }
            ],
        )

    def test_a_keyed_write_rejects_an_event_type_override(self) -> None:
        # A keyed write cannot name its own type: an override would commit an
        # event whose type denies the delivery its own row describes, so the
        # durable ledger would contradict itself.
        with self.assertRaises(ValueError) as raised:
            self.experiments.record_mlflow_run(
                project_id=self.project_id,
                experiment_id=self.experiment_id,
                run={"run_id": "run_a", "status": "RUNNING"},
                event_type="experiment.mlflow_run_refreshed",
                delivery_id=41,
            )

        self.assertIn("delivery_id=41", str(raised.exception))
        # Rejected before the transaction: no event, no experiments-row write.
        self.assertEqual(self._tracking_events(), [])
        self.assertIsNone(
            self.experiments.tracking_delivery_state(
                project_id=self.project_id,
                experiment_id=self.experiment_id,
                delivery_id=41,
            )
        )


class _RecordingCursor:
    """Reports how many rows a statement actually handed back."""

    def __init__(self, cursor, sql: str, reads: list[tuple[str, int]]) -> None:
        self._cursor = cursor
        self._sql = " ".join(sql.split())
        self._reads = reads

    def fetchone(self):
        row = self._cursor.fetchone()
        self._reads.append((self._sql, 0 if row is None else 1))
        return row

    def fetchall(self):
        rows = self._cursor.fetchall()
        self._reads.append((self._sql, len(rows)))
        return rows

    def __getattr__(self, name: str):
        return getattr(self._cursor, name)


class _RecordingConnection:
    def __init__(self, conn, reads: list[tuple[str, int]]) -> None:
        self._conn = conn
        self._reads = reads

    def execute(self, sql: str, parameters=()):
        return _RecordingCursor(self._conn.execute(sql, parameters), sql, self._reads)

    def __getattr__(self, name: str):
        return getattr(self._conn, name)


class _RecordingStateStore(StateStore):
    """A store whose reads are observable, so a lookup's COST is assertable."""

    def __init__(self, *, db_path: Path) -> None:
        self.reads: list[tuple[str, int]] = []
        super().__init__(db_path=db_path)

    def connect(self):
        return _RecordingConnection(super().connect(), self.reads)


class TrackingDeliveryLookupCostTest(unittest.TestCase):
    """The barrier runs inside EVERY keyed write, so its cost is a contract.

    The tests above fix what the lookup answers; these fix how much it reads.
    The lookup it replaced correlated on a payload key, so it had to read and
    JSON-decode every keyed event the experiment had accrued — a per-write cost
    linear in an unbounded cardinality, hence quadratic cumulatively, and paid
    inside the write transaction. A row count is the honest assertion: an index
    the planner could stop using would not change the answers, only the work.
    """

    HISTORY = 205

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.store = _RecordingStateStore(db_path=Path(self.tmp.name) / "state.sqlite")
        artifacts = ResearchArtifacts(
            store=self.store,
            artifacts=Artifacts(store=self.store, blobs=FakeBlobStore()),
        )
        self.experiments = Research(store=self.store, artifacts=artifacts, workflows=Workflows(store=self.store))._experiments
        with closing(self.store.connect()) as conn:
            row = conn.execute("SELECT id FROM projects").fetchone()
            assert row is not None
            self.project_id = str(row["id"])
        self.experiment_id = self.experiments.create(
            project_id=self.project_id, name="delivery-cost", intent="test"
        )["id"]
        # The oldest delivery, then a long run of newer ones on top of it: the
        # worst case for anything that walks the history to find one delivery.
        self._record(run_id="run_a", delivery_id=41)
        for index in range(self.HISTORY):
            self._record(run_id=f"run_{index}", delivery_id=100 + index)
        self.store.reads.clear()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _record(self, *, run_id: str, delivery_id: int | None) -> dict:
        return self.experiments.record_mlflow_run(
            project_id=self.project_id,
            experiment_id=self.experiment_id,
            run={"run_id": run_id, "status": "RUNNING"},
            delivery_id=delivery_id,
        )

    def _assert_indexed_reads(self) -> None:
        delivery_reads = [
            count
            for sql, count in self.store.reads
            if "FROM tracking_deliveries" in sql
        ]
        event_reads = [
            (sql, count) for sql, count in self.store.reads if "FROM events" in sql
        ]
        # One row proves the requested key landed; one row identifies which
        # delivery owns the current mutable run. The event is a primary-key
        # point read. None of these costs grow with history.
        self.assertEqual(delivery_reads, [1, 1])
        self.assertEqual([count for _, count in event_reads], [1])
        self.assertIn("FROM events WHERE id = ?", event_reads[0][0])

    def test_the_read_path_lookup_never_walks_the_keyed_history(self) -> None:
        found = self.experiments.tracking_delivery_state(
            project_id=self.project_id,
            experiment_id=self.experiment_id,
            delivery_id=41,
        )

        assert found is not None
        self.assertEqual(found["mlflow_run"]["run_id"], f"run_{self.HISTORY - 1}")
        self._assert_indexed_reads()

    def test_the_write_barrier_never_walks_the_keyed_history(self) -> None:
        # The path that made the cost quadratic: the barrier inside the write
        # transaction, replaying the OLDEST delivery behind every later one.
        replayed = self._record(run_id="run_redelivered", delivery_id=41)

        self.assertEqual(replayed["mlflow_run"]["run_id"], f"run_{self.HISTORY - 1}")
        self._assert_indexed_reads()


if __name__ == "__main__":
    unittest.main()
