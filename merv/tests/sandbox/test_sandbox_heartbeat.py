from __future__ import annotations

import os
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from tests.support.brain import TestBrain
from tests.support.sandbox_backend import FakeSandboxBackend
from merv.brain.sandbox.scheduler import SandboxScheduler
from merv.brain.sandbox.core import LIVE_COMMAND_MAX_CHARS
from merv.brain.sandbox.heartbeat import (
    HEARTBEAT_SERIES_MAX,
    SandboxIdlePolicy,
    append_usage_point,
    usage_point,
)
from merv.brain.kernel.utils import format_iso


def _sample(
    *,
    cpu: float = 0.0,
    gpu: int = 0,
    mem: int = 1_000_000,
    net: int = 1_000,
    ssh: int = 0,
) -> dict:
    return {
        "cpu": {"used_cores": cpu, "limit_cores": 2.0},
        "memory": {"used_bytes": mem, "limit_bytes": None},
        "network": {"bytes_total": net, "ssh_established": ssh},
        "gpus": [{"index": 0, "util_pct": gpu}],
    }


class SandboxIdlePolicyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.policy = SandboxIdlePolicy()
        self.previous = _sample()

    def test_all_quiet_is_idle(self) -> None:
        self.assertTrue(
            self.policy.is_idle(
                current=_sample(),
                previous=self.previous,
                elapsed_seconds=30,
            )
        )

    def test_work_in_flight_outranks_every_quiet_gauge(self) -> None:
        self.assertFalse(
            self.policy.is_idle(
                current=_sample(),
                previous=self.previous,
                elapsed_seconds=30,
                work_running=True,
            )
        )

    def test_unmeasurable_ssh_does_not_block_idle(self) -> None:
        # ss/proc absent (e.g. Modal has no sshd) → ssh_established is None;
        # that must not make an otherwise-quiet box un-reapable.
        self.assertTrue(
            self.policy.is_idle(
                current=_sample(ssh=None),
                previous=self.previous,
                elapsed_seconds=30,
            )
        )

    def test_any_activity_signal_is_not_idle(self) -> None:
        cases = {
            "network": _sample(net=100_000),
            "cpu": _sample(cpu=0.25),
            "gpu": _sample(gpu=20),
            "ram": _sample(mem=100_000_000),
            "ssh": _sample(ssh=1),
        }
        for name, current in cases.items():
            with self.subTest(signal=name):
                self.assertFalse(
                    self.policy.is_idle(
                        current=current,
                        previous=self.previous,
                        elapsed_seconds=30,
                    )
                )

    def test_idle_window_accumulates_to_reap_threshold(self) -> None:
        now = datetime(2026, 1, 1, tzinfo=UTC)
        started = self.policy.next_idle_since(idle_since=None, now=now, is_idle=True)
        self.assertEqual(started, now)
        self.assertFalse(
            self.policy.should_reap(
                idle_since=now - timedelta(seconds=3599),
                now=now,
                threshold_seconds=3600,
            )
        )
        self.assertTrue(
            self.policy.should_reap(
                idle_since=now - timedelta(seconds=3600),
                now=now,
                threshold_seconds=3600,
            )
        )

    def test_activity_resets_idle_window(self) -> None:
        now = datetime(2026, 1, 1, tzinfo=UTC)
        self.assertIsNone(
            self.policy.next_idle_since(
                idle_since=now - timedelta(hours=2),
                now=now,
                is_idle=False,
            )
        )


class SandboxHeartbeatMonitorTest(unittest.TestCase):
    _ENV = {"RESEARCH_PLUGIN_SANDBOX_REAPER_INTERVAL": "3600"}

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self._saved = {key: os.environ.get(key) for key in self._ENV}
        os.environ.update(self._ENV)
        self.backend = FakeSandboxBackend()
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
            execution_backend=self.backend,
        )
        self.project_id = self.app.call_tool(
            "project", {"action": "create", "name": "Heartbeat Project"}
        )["id"]

    def tearDown(self) -> None:
        self.app.shutdown()
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmp.cleanup()

    def _experiment(self, name: str) -> str:
        exp_id = self.app.call_tool(
            "experiment.create",
            {"project_id": self.project_id, "name": name, "intent": "x"},
        )["id"]
        with self.app.store.transaction() as conn:
            conn.execute(
                "UPDATE experiments SET status = 'ready_to_run' WHERE id = ?", (exp_id,)
            )
        return exp_id

    def _request(self, exp_id: str) -> dict:
        return self.app.call_tool(
            "sandbox.request",
            {"project_id": self.project_id, "experiment_id": exp_id},
        )

    def _seed_heartbeat(
        self,
        *,
        exp_id: str,
        sandbox_uid: str,
        sampled_at: datetime,
        idle_since: datetime,
        metrics: dict,
    ) -> None:
        self.app.sandbox_storage.record_heartbeat(
            sandbox_uid=sandbox_uid,
            expected_project_id=self.project_id,
            idle_since=format_iso(idle_since),
            snapshot={"sampled_at": format_iso(sampled_at), "metrics": metrics},
        )

    def test_idle_sandbox_is_reaped_while_busy_sandbox_is_spared(self) -> None:
        now = datetime(2026, 1, 1, 2, 0, tzinfo=UTC)
        previous_at = now - timedelta(seconds=30)
        idle_since = now - timedelta(hours=1)
        idle_exp = self._experiment("idle")
        busy_exp = self._experiment("busy")
        idle = self._request(idle_exp)
        busy = self._request(busy_exp)
        for exp_id, sandbox_uid in (
            (idle_exp, idle["sandbox_uid"]),
            (busy_exp, busy["sandbox_uid"]),
        ):
            self._seed_heartbeat(
                exp_id=exp_id,
                sandbox_uid=str(sandbox_uid),
                sampled_at=previous_at,
                idle_since=idle_since,
                metrics=_sample(),
            )
        self.backend.metrics[idle["sandbox_id"]] = _sample()
        self.backend.metrics[busy["sandbox_id"]] = _sample(cpu=0.5)

        reaped = self.app.sandboxes.reap_idle(now=now, threshold_seconds=3600)

        self.assertEqual(reaped, 1)
        self.assertIn(idle["sandbox_id"], self.backend.terminated)
        self.assertNotIn(busy["sandbox_id"], self.backend.terminated)
        self.assertEqual(
            self.app.sandboxes.get(
                project_id=self.project_id,
                sandbox_uid=str(idle["sandbox_uid"]),
            )["status"],
            "terminated",
        )
        self.assertEqual(
            self.app.sandboxes.get(project_id=self.project_id, experiment_id=busy_exp)[
                "status"
            ],
            "running",
        )
        events = self.app.store.recent_events(project_id=self.project_id)["events"]
        idle_events = [
            event
            for event in events
            if event["type"] == "sandbox.idle_reaped" and event["target_id"] == idle_exp
        ]
        self.assertEqual(len(idle_events), 1)
        self.assertEqual(idle_events[0]["payload"]["idle_seconds"], 3600)

    def _idle_candidate(self, name: str, *, now: datetime) -> dict:
        """A running sandbox that every sampled gauge calls idle."""
        exp_id = self._experiment(name)
        created = self._request(exp_id)
        self._seed_heartbeat(
            exp_id=exp_id,
            sandbox_uid=str(created["sandbox_uid"]),
            sampled_at=now - timedelta(seconds=30),
            idle_since=now - timedelta(hours=1),
            metrics=_sample(),
        )
        self.backend.metrics[created["sandbox_id"]] = _sample()
        return {**created, "experiment_id": exp_id}

    def _status(self, sandbox_uid: str) -> str:
        return str(
            self.app.sandbox_storage.get_by_uid(sandbox_uid=sandbox_uid)["status"]
        )

    def test_a_running_merv_run_receipt_vetoes_the_idle_reap(self) -> None:
        # The gauges say idle, but a detached run never reported finishing:
        # a blocked download or low-CPU orchestration step looks exactly like
        # this, and reaping it destroys the work (audit SAN-07).
        now = datetime(2026, 1, 1, 2, 0, tzinfo=UTC)
        idle = self._idle_candidate("receipt-veto", now=now)
        with self.app.store.transaction() as conn:
            conn.execute(
                """
                INSERT INTO sandbox_runs (
                  sandbox_uid, label, command, exit_code, started_at,
                  first_seen_at, updated_at
                ) VALUES (?, 'train', 'python train.py', NULL, ?, ?, ?)
                """,
                (
                    str(idle["sandbox_uid"]),
                    format_iso(now - timedelta(minutes=30)),
                    format_iso(now - timedelta(minutes=30)),
                    format_iso(now - timedelta(seconds=30)),
                ),
            )

        self.assertEqual(
            self.app.sandboxes.reap_idle(now=now, threshold_seconds=3600), 0
        )
        self.assertNotIn(idle["sandbox_id"], self.backend.terminated)
        self.assertEqual(self._status(str(idle["sandbox_uid"])), "running")
        # Work in flight also resets the idle clock rather than banking it.
        self.assertIsNone(
            self.app.sandbox_storage.get_by_uid(
                sandbox_uid=str(idle["sandbox_uid"])
            )["idle_since"]
        )

    def test_a_finished_receipt_does_not_veto_the_idle_reap(self) -> None:
        now = datetime(2026, 1, 1, 2, 0, tzinfo=UTC)
        idle = self._idle_candidate("receipt-finished", now=now)
        with self.app.store.transaction() as conn:
            conn.execute(
                """
                INSERT INTO sandbox_runs (
                  sandbox_uid, label, command, exit_code, started_at,
                  first_seen_at, updated_at
                ) VALUES (?, 'train', 'python train.py', 0, ?, ?, ?)
                """,
                (
                    str(idle["sandbox_uid"]),
                    format_iso(now - timedelta(hours=3)),
                    format_iso(now - timedelta(hours=3)),
                    format_iso(now - timedelta(seconds=30)),
                ),
            )

        self.assertEqual(
            self.app.sandboxes.reap_idle(now=now, threshold_seconds=3600), 1
        )
        self.assertIn(idle["sandbox_id"], self.backend.terminated)

    def test_a_stale_receipt_no_longer_vetoes(self) -> None:
        # The ledger has not re-confirmed this run in longer than the whole
        # idle window: the run directory is gone, so it is not evidence of work.
        now = datetime(2026, 1, 1, 2, 0, tzinfo=UTC)
        idle = self._idle_candidate("receipt-stale", now=now)
        with self.app.store.transaction() as conn:
            conn.execute(
                """
                INSERT INTO sandbox_runs (
                  sandbox_uid, label, command, exit_code, started_at,
                  first_seen_at, updated_at
                ) VALUES (?, 'train', 'python train.py', NULL, ?, ?, ?)
                """,
                (
                    str(idle["sandbox_uid"]),
                    format_iso(now - timedelta(days=2)),
                    format_iso(now - timedelta(days=2)),
                    format_iso(now - timedelta(days=2)),
                ),
            )

        self.assertEqual(
            self.app.sandboxes.reap_idle(now=now, threshold_seconds=3600), 1
        )

    def test_a_receipt_that_exists_only_on_the_box_vetoes_the_idle_reap(self) -> None:
        # The blocker: a quiet merv_run launched right after the last mirror
        # sweep exists ONLY on the sandbox. Deciding against the mirror alone
        # reaps a machine that is working — so the candidate's receipts are
        # read from the box before the decision, not a tick later.
        now = datetime(2026, 1, 1, 2, 0, tzinfo=UTC)
        idle = self._idle_candidate("on-box-only", now=now)
        # Raw listing exactly as the on-box command emits it: a run with no
        # ===EXIT sentinel is still in flight. Nothing is in sandbox_runs yet.
        self.backend.run_listings[idle["sandbox_id"]] = (
            "===MERV_RUN dHJhaW4=\n"
            "===META eyJsYWJlbCI6InRyYWluIiwiY29tbWFuZCI6InB5dGhvbiB0cmFpbi5weSJ9\n"
        )
        with self.app.store.transaction() as conn:
            self.assertIsNone(
                conn.execute(
                    "SELECT 1 FROM sandbox_runs WHERE sandbox_uid = ?",
                    (str(idle["sandbox_uid"]),),
                ).fetchone()
            )

        self.assertEqual(
            self.app.sandboxes.reap_idle(now=now, threshold_seconds=3600), 0
        )
        self.assertNotIn(idle["sandbox_id"], self.backend.terminated)
        self.assertEqual(self._status(str(idle["sandbox_uid"])), "running")

    def test_an_unreadable_receipt_source_vetoes_the_idle_reap(self) -> None:
        # A known running receipt whose ledger has not been refreshable for
        # longer than the whole idle window: its updated_at ages out of the
        # freshness query, so the mirror alone now says "nothing running".
        # That silence is ignorance, not proof — read_runs returning None must
        # veto rather than license the reap.
        now = datetime(2026, 1, 1, 2, 0, tzinfo=UTC)
        idle = self._idle_candidate("unreadable", now=now)
        with self.app.store.transaction() as conn:
            conn.execute(
                """
                INSERT INTO sandbox_runs (
                  sandbox_uid, label, command, exit_code, started_at,
                  first_seen_at, updated_at
                ) VALUES (?, 'train', 'python train.py', NULL, ?, ?, ?)
                """,
                (
                    str(idle["sandbox_uid"]),
                    format_iso(now - timedelta(days=2)),
                    format_iso(now - timedelta(days=2)),
                    format_iso(now - timedelta(days=2)),
                ),
            )

        def unreadable(*, sandbox_id, workdir="", ssh_host="", ssh_port=0,
                       ssh_user="", key_path=""):
            return None  # management channel down: "no news", not "no runs"

        self.backend.read_runs = unreadable  # type: ignore[assignment]

        self.assertEqual(
            self.app.sandboxes.reap_idle(now=now, threshold_seconds=3600), 0
        )
        self.assertNotIn(idle["sandbox_id"], self.backend.terminated)
        self.assertEqual(self._status(str(idle["sandbox_uid"])), "running")

    def test_a_failed_receipt_mirror_write_does_not_license_a_reap(self) -> None:
        # The box answered, but the mirror write blew up. A receipt we saw and
        # could not record is still work in flight.
        now = datetime(2026, 1, 1, 2, 0, tzinfo=UTC)
        idle = self._idle_candidate("unmirrored", now=now)
        self.backend.run_listings[idle["sandbox_id"]] = (
            "===MERV_RUN dHJhaW4=\n"
            "===META eyJsYWJlbCI6InRyYWluIiwiY29tbWFuZCI6InB5dGhvbiB0cmFpbi5weSJ9\n"
        )
        ledger = self.app.sandbox_runs

        def exploding_record(*, row, listing):
            raise RuntimeError("state store unreachable")

        with patch.object(ledger, "_record", side_effect=exploding_record):
            self.assertEqual(
                self.app.sandboxes.reap_idle(now=now, threshold_seconds=3600), 0
            )
        self.assertNotIn(idle["sandbox_id"], self.backend.terminated)

    def test_a_running_command_vetoes_the_idle_reap(self) -> None:
        now = datetime(2026, 1, 1, 2, 0, tzinfo=UTC)
        idle = self._idle_candidate("command-veto", now=now)
        self.app.sandbox_storage.record_command_snapshot(
            sandbox_uid=str(idle["sandbox_uid"]),
            snapshot={"command_id": "cmd_1", "command": "bash setup.sh", "status": "running"},
            expected_project_id=self.project_id,
        )

        self.assertEqual(
            self.app.sandboxes.reap_idle(now=now, threshold_seconds=3600), 0
        )
        self.assertNotIn(idle["sandbox_id"], self.backend.terminated)

    def test_an_unconfirmed_deletion_parks_the_reap_and_reports_no_reap(self) -> None:
        now = datetime(2026, 1, 1, 2, 0, tzinfo=UTC)
        idle = self._idle_candidate("unconfirmed", now=now)
        self.backend.terminate = lambda *, sandbox_id: False  # type: ignore[assignment]
        self.backend.liveness_unavailable = True

        self.assertEqual(
            self.app.sandboxes.reap_idle(now=now, threshold_seconds=3600), 0
        )
        self.assertEqual(
            self._status(str(idle["sandbox_uid"])), "cleanup_pending"
        )

    def test_a_row_that_left_running_mid_sweep_is_not_reaped(self) -> None:
        # The re-read guard: the snapshot ages while earlier rows make provider
        # calls, and the row may already be gone by the time this one's turn
        # comes up.
        now = datetime(2026, 1, 1, 2, 0, tzinfo=UTC)
        idle = self._idle_candidate("raced", now=now)
        repository = self.app.sandbox_storage
        original_get = repository.get_by_uid

        def get_by_uid(*, sandbox_uid):
            row = original_get(sandbox_uid=sandbox_uid)
            return {**row, "status": "terminated"}

        with patch.object(repository, "get_by_uid", side_effect=get_by_uid):
            self.assertEqual(
                self.app.sandboxes.reap_idle(now=now, threshold_seconds=3600), 0
            )
        self.assertNotIn(idle["sandbox_id"], self.backend.terminated)

    def test_zero_threshold_reaps_nothing_however_idle_the_box_is(self) -> None:
        created, now = self._long_idle_box("disabled")

        self.assertEqual(
            self.app.sandboxes.reap_idle(now=now, threshold_seconds=0),
            0,
        )
        self.assertNotIn(created["sandbox_id"], self.backend.terminated)

    def test_zero_threshold_still_records_a_sample(self) -> None:
        # Sampling is decoupled from reaping: "watch, don't act" must not
        # degrade to "don't look", or the fleet view goes blind wherever idle
        # reaping is switched off.
        created, now = self._long_idle_box("watch-only")

        self.app.sandboxes.reap_idle(now=now, threshold_seconds=0)

        row = self.app.sandbox_storage.get_by_uid(
            sandbox_uid=str(created["sandbox_uid"])
        )
        snapshot = self.app.sandbox_storage.heartbeat_snapshot(row=row)
        self.assertEqual(snapshot["sampled_at"], format_iso(now))
        self.assertEqual(len(snapshot["series"]), 1)

    def _long_idle_box(self, name: str) -> tuple[dict, datetime]:
        """A running box that every gauge calls idle, well past any threshold."""
        now = datetime(2026, 1, 1, 2, 0, tzinfo=UTC)
        exp_id = self._experiment(name)
        created = self._request(exp_id)
        self._seed_heartbeat(
            exp_id=exp_id,
            sandbox_uid=str(created["sandbox_uid"]),
            sampled_at=now - timedelta(seconds=30),
            idle_since=now - timedelta(hours=2),
            metrics=_sample(),
        )
        self.backend.metrics[created["sandbox_id"]] = _sample()
        return created, now


class SandboxSweepOrderTest(unittest.TestCase):
    """The reaper's tick order is load-bearing, not incidental."""

    def test_receipts_are_reconciled_before_the_idle_decision(self) -> None:
        trace: list[str] = []
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        app = TestBrain(
            repo_root=root,
            db_path=root / ".research_plugin" / "state.sqlite",
            execution_backend=FakeSandboxBackend(),
        )
        self.addCleanup(app.shutdown)
        engine = app.sandboxes
        with (
            patch.object(
                engine._lifecycle,
                "reap_expired",
                side_effect=lambda **_kwargs: trace.append("expiry"),
            ),
            patch.object(
                engine._observer,
                "observe_live",
                side_effect=lambda: trace.append("receipts"),
            ),
            patch.object(
                engine._heartbeat,
                "reap_idle",
                side_effect=lambda **_kwargs: trace.append("idle"),
            ),
            patch.object(
                engine._provisioner,
                "reap_stale_provisions",
                side_effect=lambda **_kwargs: trace.append("stale"),
            ),
            patch.object(
                engine._lifecycle,
                "retry_cleanup_pending",
                side_effect=lambda **_kwargs: trace.append("cleanup_retry"),
            ),
        ):
            engine._maintenance_sweep(
                stale_deadline_seconds=900.0,
                expiry_enabled=True,
                idle_threshold_seconds=3600.0,
            )

        self.assertEqual(
            trace, ["expiry", "receipts", "idle", "stale", "cleanup_retry"]
        )
        self.assertLess(trace.index("receipts"), trace.index("idle"))


class SandboxHeartbeatEnvTest(unittest.TestCase):
    def _scheduler(self) -> SandboxScheduler:
        return SandboxScheduler(
            sweep=lambda **_kwargs: None,
            enforce_expiry=True,
        )

    def test_idle_threshold_zero_or_empty_disables_idle_reaping(self) -> None:
        scheduler = self._scheduler()
        for value in ("0", ""):
            with self.subTest(value=value):
                with patch.dict(
                    os.environ,
                    {"RESEARCH_PLUGIN_SANDBOX_IDLE_SECONDS": value},
                    clear=False,
                ):
                    self.assertEqual(scheduler._idle_reap_threshold(), 0)

    def test_the_sweep_still_runs_when_nothing_would_be_reaped(self) -> None:
        # Sampling is the fleet's observability substrate, so switching off
        # both reapers must not stop the daemon that feeds it.
        scheduler = SandboxScheduler(sweep=lambda **_kwargs: None, enforce_expiry=False)
        with patch.dict(
            os.environ,
            {
                "RESEARCH_PLUGIN_SANDBOX_REAPER": "false",
                "MERV_SANDBOX_IDLE_SECONDS": "",
                "RESEARCH_PLUGIN_SANDBOX_IDLE_SECONDS": "",
            },
            clear=False,
        ):
            self.assertEqual(scheduler._idle_reap_threshold(), 0)
            self.assertTrue(scheduler._daemon_enabled())

    def test_sampling_can_be_switched_off_outright(self) -> None:
        # The escape hatch for anyone who disabled idle reaping specifically to
        # stop the control plane touching their boxes.
        scheduler = SandboxScheduler(sweep=lambda **_kwargs: None, enforce_expiry=False)
        with patch.dict(
            os.environ,
            {
                "RESEARCH_PLUGIN_SANDBOX_REAPER": "false",
                "MERV_SANDBOX_IDLE_SECONDS": "",
                "RESEARCH_PLUGIN_SANDBOX_IDLE_SECONDS": "",
                "MERV_SANDBOX_ACTIVITY_SAMPLING": "false",
            },
            clear=False,
        ):
            self.assertFalse(scheduler._daemon_enabled())


class UsagePointTest(unittest.TestCase):
    """The compact percentage unit the fleet row reads."""

    now = datetime(2026, 8, 1, 12, 0, tzinfo=UTC)

    def test_percentages_come_from_the_in_container_limits(self) -> None:
        point = usage_point(
            metrics={
                "cpu": {"used_cores": 13.0, "limit_cores": 26.0},
                "memory": {"used_bytes": 80 * 1024**3, "limit_bytes": 200 * 1024**3},
                "gpus": [
                    {"util_pct": 94, "mem_used_mib": 40_500, "mem_total_mib": 81_000}
                ],
            },
            now=self.now,
            row={},
        )
        self.assertEqual(point["cpu"], 50.0)
        self.assertEqual(point["mem"], 40.0)
        self.assertEqual(point["gpu"], 94.0)
        self.assertEqual(point["vram"], 50.0)

    def test_reserved_row_values_stand_in_for_unreadable_cgroup_limits(self) -> None:
        point = usage_point(
            metrics={
                "cpu": {"used_cores": 1.0},
                "memory": {"used_bytes": 1024**3},
                "gpus": [],
            },
            now=self.now,
            row={"cpu": 4.0, "memory": 8192},
        )
        self.assertEqual(point["cpu"], 25.0)
        self.assertEqual(point["mem"], 12.5)

    def test_an_unknown_ratio_is_none_not_zero(self) -> None:
        # A blank bar is honest; a zero would render as an idle box and could
        # talk someone into releasing live work.
        point = usage_point(metrics={}, now=self.now, row={})
        for key in ("cpu", "mem", "gpu", "vram"):
            with self.subTest(metric=key):
                self.assertIsNone(point[key])

    def test_multi_gpu_reports_the_busiest_card(self) -> None:
        point = usage_point(
            metrics={"gpus": [{"util_pct": 12}, {"util_pct": 88}]},
            now=self.now,
            row={},
        )
        self.assertEqual(point["gpu"], 88.0)

    def test_the_ring_keeps_the_newest_points_and_drops_the_oldest(self) -> None:
        series: list = []
        for index in range(HEARTBEAT_SERIES_MAX + 5):
            series = append_usage_point(series=series, point={"i": index})
        self.assertEqual(len(series), HEARTBEAT_SERIES_MAX)
        self.assertEqual(series[0]["i"], 5)
        self.assertEqual(series[-1]["i"], HEARTBEAT_SERIES_MAX + 4)

    def test_a_malformed_prior_blob_never_breaks_the_sweep(self) -> None:
        point = {"i": 1}
        self.assertEqual(append_usage_point(series="not-a-list", point=point), [point])
        self.assertEqual(
            append_usage_point(series=[1, None, {"a": 1}], point=point),
            [{"a": 1}, point],
        )


class FleetLivenessProjectionTest(SandboxHeartbeatMonitorTest):
    """`for_project` carries per-row liveness so the fleet view needs no SSH."""

    def test_a_sweep_appends_to_the_series_and_the_list_projects_it(self) -> None:
        now = datetime(2026, 1, 1, 2, 0, tzinfo=UTC)
        exp_id = self._experiment("busy")
        created = self._request(exp_id)
        sandbox_uid = str(created["sandbox_uid"])
        self._seed_heartbeat(
            exp_id=exp_id,
            sandbox_uid=sandbox_uid,
            sampled_at=now - timedelta(seconds=30),
            idle_since=now - timedelta(hours=1),
            metrics=_sample(),
        )
        self.backend.metrics[created["sandbox_id"]] = _sample(cpu=0.5, gpu=94)

        for tick in range(3):
            self.app.sandboxes.reap_idle(
                now=now + timedelta(seconds=30 * tick), threshold_seconds=3600
            )

        row = self._fleet_row(sandbox_uid)
        heartbeat = row["heartbeat"]
        self.assertEqual(len(heartbeat["series"]), 3)
        self.assertEqual(heartbeat["latest"]["gpu"], 94.0)
        self.assertEqual([point["gpu"] for point in heartbeat["series"]], [94.0] * 3)
        # A busy box is never idle, so the row carries no idle clock.
        self.assertIsNone(heartbeat["idle_since"])

    def test_bars_render_before_the_ring_has_filled(self) -> None:
        # Rows written before the series existed must still show utilization —
        # `latest` reads the stored sample, not the ring's tail.
        now = datetime(2026, 1, 1, 2, 0, tzinfo=UTC)
        exp_id = self._experiment("legacy")
        created = self._request(exp_id)
        sandbox_uid = str(created["sandbox_uid"])
        self._seed_heartbeat(
            exp_id=exp_id,
            sandbox_uid=sandbox_uid,
            sampled_at=now,
            idle_since=now,
            metrics=_sample(cpu=1.0, gpu=42),
        )

        heartbeat = self._fleet_row(sandbox_uid)["heartbeat"]
        self.assertEqual(heartbeat["series"], [])
        self.assertEqual(heartbeat["latest"]["gpu"], 42.0)
        self.assertEqual(heartbeat["latest"]["cpu"], 50.0)

    def test_the_row_learns_its_card_inventory_from_the_sample(self) -> None:
        # The row stores only the short label chosen at provision ("A100");
        # how many cards and how much memory each has comes from nvidia-smi.
        now = datetime(2026, 1, 1, 2, 0, tzinfo=UTC)
        exp_id = self._experiment("inventory")
        created = self._request(exp_id)
        sandbox_uid = str(created["sandbox_uid"])
        metrics = _sample(cpu=1.0, gpu=42)
        metrics["gpus"] = [
            {"index": 0, "name": "NVIDIA A100-SXM4-80GB", "util_pct": 42, "mem_used_mib": 1000, "mem_total_mib": 81920},
            {"index": 1, "name": "NVIDIA A100-SXM4-80GB", "util_pct": 7, "mem_used_mib": 500, "mem_total_mib": 81920},
        ]
        self._seed_heartbeat(
            exp_id=exp_id, sandbox_uid=sandbox_uid, sampled_at=now, idle_since=now, metrics=metrics
        )
        heartbeat = self._fleet_row(sandbox_uid)["heartbeat"]
        self.assertEqual(
            heartbeat["gpus"],
            {"count": 2, "vram_mib": 81920, "name": "NVIDIA A100-SXM4-80GB"},
        )

        # A sample whose card memory the sampler could not read keeps the count
        # and says nothing about VRAM rather than claiming zero.
        blind = self._experiment("blind")
        created = self._request(blind)
        sandbox_uid = str(created["sandbox_uid"])
        self._seed_heartbeat(
            exp_id=blind, sandbox_uid=sandbox_uid, sampled_at=now, idle_since=now, metrics=_sample()
        )
        self.assertEqual(
            self._fleet_row(sandbox_uid)["heartbeat"]["gpus"],
            {"count": 1, "vram_mib": None, "name": ""},
        )

    def test_a_terminated_row_drops_stale_usage_but_keeps_its_last_command(
        self,
    ) -> None:
        now = datetime(2026, 1, 1, 2, 0, tzinfo=UTC)
        exp_id = self._experiment("done")
        created = self._request(exp_id)
        sandbox_uid = str(created["sandbox_uid"])
        self._seed_heartbeat(
            exp_id=exp_id,
            sandbox_uid=sandbox_uid,
            sampled_at=now,
            idle_since=now,
            metrics=_sample(),
        )
        self.app.sandbox_storage.record_command_snapshot(
            sandbox_uid=sandbox_uid,
            expected_project_id=self.project_id,
            snapshot={
                "command_id": "c1",
                "command": "python train.py",
                "status": "finished",
                "exit_code": 1,
                "started_at": format_iso(now - timedelta(minutes=5)),
                "finished_at": format_iso(now),
                "output_tail": "boom",
            },
        )
        self.app.sandboxes.release(
            project_id=self.project_id,
            sandbox_uid=sandbox_uid,
            confirm_retained=True,
        )

        row = self._fleet_row(sandbox_uid)
        self.assertEqual(row["status"], "terminated")
        self.assertNotIn("heartbeat", row)
        self.assertEqual(row["last_command"]["command"], "python train.py")
        self.assertEqual(row["last_command"]["exit_code"], 1)
        # The tail belongs to the terminal endpoint, not a 3s fleet poll.
        self.assertNotIn("output_tail", row["last_command"])

    def test_a_pathological_command_is_bounded_before_it_rides_the_poll(self) -> None:
        now = datetime(2026, 1, 1, 2, 0, tzinfo=UTC)
        exp_id = self._experiment("chatty")
        created = self._request(exp_id)
        sandbox_uid = str(created["sandbox_uid"])
        self.app.sandbox_storage.record_command_snapshot(
            sandbox_uid=sandbox_uid,
            expected_project_id=self.project_id,
            snapshot={
                "command_id": "c1",
                "command": "x" * 5000,
                "status": "running",
                "started_at": format_iso(now),
            },
        )
        row = self._fleet_row(sandbox_uid)
        self.assertEqual(len(row["last_command"]["command"]), LIVE_COMMAND_MAX_CHARS)

    def _fleet_row(self, sandbox_uid: str) -> dict:
        rows = self.app.sandboxes.for_project(project_id=self.project_id)
        return next(row for row in rows if row["sandbox_uid"] == sandbox_uid)


if __name__ == "__main__":
    unittest.main()
