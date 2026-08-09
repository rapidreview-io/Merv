"""Cloud cleanup sweeps (cloud plan Phase 9), driven by injected clocks.

The idempotent sweeps grouped behind CleanupService.run_all — orphan-VM,
blob TTL GC, storage TTL GC, and stale-provision reap — each take a
``now`` so the test owns the clock. The service is mode-blind (the in-process
app exercises the exact code the control plane schedules), so these run without
docker or a real control plane.
"""

from __future__ import annotations

import os
import tempfile
import threading
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from tests.support.brain import DEFAULT_PUBLIC_KEY, TestBrain
from merv.brain.kernel.utils import parse_iso
from tests.support.sandbox_backend import FakeSandboxBackend, seed_sandbox
from merv.brain.sandbox import models as sandbox_models
from merv.brain.sandbox.models import BackendCapabilities
from merv.brain.sandbox.scheduler import SandboxScheduler
from merv.brain.sandbox.models import (
    CLEANUP_INFLIGHT_DEADLINE_SECONDS,
    cleanup_inflight_token,
)
from merv.brain.application.maintenance import CleanupService


class CleanupSweepTest(unittest.TestCase):
    # Park the background reaper so the test, not a timer, drives every sweep.
    _ENV = {
        "RESEARCH_PLUGIN_SANDBOX_REAPER_INTERVAL": "3600",
        "RESEARCH_PLUGIN_SANDBOX_REAPER": "0",
    }

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self._saved = {k: os.environ.get(k) for k in self._ENV}
        os.environ.update(self._ENV)
        self.backend = FakeSandboxBackend()
        # enforce_expiry off keeps the reaper inert; the sweeps drive themselves.
        self.backend.capabilities = BackendCapabilities(name="fake")
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
            execution_backend=self.backend,
        )
        self.store = self.app.store
        self.cleanup = CleanupService(
            sandboxes=self.app.sandboxes, blobs=self.app.blobs
        )
        self.project_id = self.app.call_tool("project", {"action": "create", "name": "Proj C"})["id"]

    def tearDown(self) -> None:
        self.app.shutdown()
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def _experiment(self) -> str:
        return self.app.call_tool(
            "experiment.create",
            {"project_id": self.project_id, "name": "exp", "intent": "x"},
        )["id"]

    # ---- orphan-VM sweep ----

    def test_orphan_vm_sweep_reaps_a_running_row_whose_vm_is_gone(self) -> None:
        exp_id = self._experiment()
        sandbox_uid = "uid_gone"
        seed_sandbox(
            self.app.sandbox_storage,
            experiment_id=exp_id,
            sandbox_uid=sandbox_uid,
            project_id=self.project_id,
            sandbox_id="sb-gone",
            status="running",
            ssh_host="h",
            ssh_port=22,
            ssh_user="root",
            expires_at="2999-01-01T00:00:00Z",
        )
        # The provider says the VM is gone (never marked alive in the fake).
        self.assertFalse(self.backend.is_alive(sandbox_id="sb-gone"))
        reaped = self.cleanup.sweep_orphan_vms(now=datetime.now(tz=UTC))
        self.assertEqual(reaped, 1)
        row = self.app.sandbox_storage.get_by_uid(sandbox_uid=sandbox_uid)
        self.assertEqual(row["status"], "terminated")

    def test_orphan_vm_sweep_leaves_a_live_row_running(self) -> None:
        exp_id = self._experiment()
        seed_sandbox(
            self.app.sandbox_storage,
            experiment_id=exp_id,
            sandbox_uid="uid_live",
            project_id=self.project_id,
            sandbox_id="sb-live",
            status="running",
            ssh_host="h",
            ssh_port=22,
            ssh_user="root",
            expires_at="2999-01-01T00:00:00Z",
        )
        self.backend.alive["sb-live"] = True
        reaped = self.cleanup.sweep_orphan_vms(now=datetime.now(tz=UTC))
        self.assertEqual(reaped, 0)
        row = self.app.sandbox_storage.load_row(experiment_id=exp_id)
        self.assertEqual(row["status"], "running")

    # ---- stale provisioning reap ----

    def test_stale_provision_reaped_past_deadline(self) -> None:
        exp_id = self._experiment()
        sandbox_uid = "uid_wedged"
        started = "2026-01-01T00:00:00Z"
        seed_sandbox(
            self.app.sandbox_storage,
            experiment_id=exp_id,
            sandbox_uid=sandbox_uid,
            project_id=self.project_id,
            sandbox_id="sb-wedged",
            status="provisioning",
            phase="connecting",
            provision_started_at=started,
        )
        self.backend.alive["sb-wedged"] = True
        self.backend.by_experiment[exp_id] = "sb-wedged"
        # 20 minutes later, well past the stale-provision deadline.
        now = datetime(2026, 1, 1, 0, 20, 0, tzinfo=UTC)
        reaped = self.cleanup.sweep_stale_provisions(now=now)
        self.assertEqual(reaped, 1)
        row = self.app.sandbox_storage.get_by_uid(sandbox_uid=sandbox_uid)
        self.assertEqual(row["status"], "failed")
        # The billing VM was terminated by cleanup_orphan.
        self.assertIn("sb-wedged", self.backend.terminated)

    def test_stale_provision_reaped_in_earlier_phase(self) -> None:
        # A daemon crash during `connecting` (Lambda waiting for boot + SSH)
        # leaves a billing VM in a provisioning phase. The sweep must still
        # reap it — the VM exists from `creating` onward.
        exp_id = self._experiment()
        seed_sandbox(
            self.app.sandbox_storage,
            experiment_id=exp_id,
            sandbox_uid="uid_connecting",
            project_id=self.project_id,
            sandbox_id="sb-connecting",
            status="provisioning",
            phase="connecting",
            provision_started_at="2026-01-01T00:00:00Z",
        )
        self.backend.alive["sb-connecting"] = True
        self.backend.by_experiment[exp_id] = "sb-connecting"
        now = datetime(2026, 1, 1, 0, 20, 0, tzinfo=UTC)
        reaped = self.cleanup.sweep_stale_provisions(now=now)
        self.assertEqual(reaped, 1)
        row = self.app.sandbox_storage.get_by_uid(sandbox_uid="uid_connecting")
        self.assertEqual(row["status"], "failed")
        self.assertIn("sb-connecting", self.backend.terminated)

    def test_stale_provision_reaped_before_id_recorded(self) -> None:
        # Crash in the narrow window after the provider created the VM but
        # before on_created persisted its id: the row has an empty sandbox_id,
        # so the reap can only find the VM by its deterministic name
        # (cleanup_orphan -> backend.find_sandbox_id). It must still be killed.
        exp_id = self._experiment()
        sandbox_uid = "uid_unrecorded"
        seed_sandbox(
            self.app.sandbox_storage,
            experiment_id=exp_id,
            sandbox_uid=sandbox_uid,
            project_id=self.project_id,
            sandbox_id="",
            status="provisioning",
            phase="creating",
            provision_started_at="2026-01-01T00:00:00Z",
        )
        # Only the deterministic-name lookup knows about this VM.
        self.backend.alive["sb-unrecorded"] = True
        self.backend.by_experiment[exp_id] = "sb-unrecorded"
        now = datetime(2026, 1, 1, 0, 20, 0, tzinfo=UTC)
        reaped = self.cleanup.sweep_stale_provisions(now=now)
        self.assertEqual(reaped, 1)
        row = self.app.sandbox_storage.get_by_uid(sandbox_uid=sandbox_uid)
        self.assertEqual(row["status"], "failed")
        self.assertIn("sb-unrecorded", self.backend.terminated)

    def test_stale_provision_left_alone_within_deadline(self) -> None:
        exp_id = self._experiment()
        seed_sandbox(
            self.app.sandbox_storage,
            experiment_id=exp_id,
            sandbox_uid="uid_fresh",
            project_id=self.project_id,
            sandbox_id="sb-fresh",
            status="provisioning",
            phase="connecting",
            provision_started_at="2026-01-01T00:00:00Z",
        )
        # Only 2 minutes in — under the deadline, so it keeps provisioning.
        now = datetime(2026, 1, 1, 0, 2, 0, tzinfo=UTC)
        reaped = self.cleanup.sweep_stale_provisions(now=now)
        self.assertEqual(reaped, 0)
        row = self.app.sandbox_storage.load_row(experiment_id=exp_id)
        self.assertEqual(row["status"], "provisioning")

    # ---- run_all ----

    def test_run_all_returns_per_sweep_counts_and_is_idempotent(self) -> None:
        # One expired blob + one dead-VM row.
        self.app.blobs.put(
            namespace=self.project_id, data=b"x", expires_at="2000-01-01T00:00:00Z"
        )
        exp_id = self._experiment()
        seed_sandbox(
            self.app.sandbox_storage,
            experiment_id=exp_id,
            sandbox_uid="uid_dead_run_all",
            project_id=self.project_id,
            sandbox_id="sb-dead",
            status="running",
            expires_at="2999-01-01T00:00:00Z",
        )
        future = datetime.now(tz=UTC) + timedelta(hours=1)
        report = self.cleanup.run_all(now=future)
        self.assertEqual(report.orphan_vms_reaped, 1)
        self.assertEqual(report.blobs_swept, {"deleted": 1, "ok": True})
        # A second pass over the cleaned state changes nothing.
        report2 = self.cleanup.run_all(now=future)
        skipped = {"deleted": 0, "ok": True, "skipped": True}
        self.assertEqual(report2.as_dict(), {
            "ok": True,
            "orphan_vms_reaped": 0,
            # Nothing parked, so the money-safety sweep reports a clean pass.
            "cleanup_pending": {
                "ok": True, "pending": 0, "confirmed": 0, "retried": 0
            },
            "blobs_swept": {"deleted": 0, "ok": True},
            # No storage, ledger, or OAuth store wired into this CleanupService,
            # and the report says skipped rather than reporting a sweep that
            # never ran as a clean zero.
            "storage_objects_swept": skipped,
            "stale_provisions_reaped": 0,
            "tool_calls_pruned": skipped,
            "oauth_clients_pruned": skipped,
            "agent_sessions_expired": 0,
            "sweep_errors": {},
        })

    # ---- tool-call ledger retention ----

    def test_a_failing_count_sweep_degrades_without_cancelling_the_pass(self) -> None:
        # A provider or DB failure in a count-returning sweep must not cancel
        # the pass: the money-safety re-ask (SAN-05) and the later prunes all
        # still get their turn, and the failure lands in the report.
        with patch.object(
            self.cleanup, "retry_cleanup_pending", wraps=self.cleanup.retry_cleanup_pending
        ) as reask:
            with patch.object(
                self.app.sandboxes,
                "reap_stale_provisions",
                side_effect=RuntimeError("provider 500"),
            ):
                report = self.cleanup.run_all(now=datetime.now(tz=UTC))
        self.assertTrue(reask.called)
        self.assertFalse(report.ok)
        self.assertEqual(report.stale_provisions_reaped, 0)
        self.assertEqual(
            report.as_dict()["sweep_errors"], {"stale_provisions": "provider 500"}
        )

    def test_prune_deletes_expired_ledger_rows_through_the_pass(self) -> None:
        cleanup = CleanupService(
            sandboxes=self.app.sandboxes,
            blobs=self.app.blobs,
            tool_call_ledger=self.app.tool_ledger,
        )
        self.app.call_tool("claim.list", {"project_id": self.project_id})
        with self.store.transaction() as conn:
            conn.execute(
                "INSERT INTO tool_calls (ts, tool, source, status) VALUES (?, ?, ?, ?)",
                ("2020-01-01T00:00:00Z", "ancient", "mcp", "ok"),
            )
        outcome = cleanup.run_all(now=datetime.now(tz=UTC)).as_dict()["tool_calls_pruned"]
        self.assertTrue(outcome["ok"])
        self.assertEqual(outcome["deleted"], 1)
        with self.store.transaction() as conn:
            remaining = [
                str(row["tool"])
                for row in conn.execute("SELECT tool FROM tool_calls").fetchall()
            ]
        self.assertNotIn("ancient", remaining)

    def test_a_failing_blob_sweep_is_reported_as_not_ok_not_as_zero(self) -> None:
        class ExplodingBlobs:
            def sweep_expired(self, *, now):
                raise RuntimeError("blob store unreachable")

        class ExplodingStorage:
            def sweep_expired(self, *, now):
                raise RuntimeError("bucket unreachable")

        cleanup = CleanupService(
            sandboxes=self.app.sandboxes,
            blobs=ExplodingBlobs(),
            storage=ExplodingStorage(),
        )
        report = cleanup.run_all(now=datetime.now(tz=UTC))
        self.assertEqual(
            report.blobs_swept,
            {"deleted": 0, "ok": False, "error": "blob store unreachable"},
        )
        self.assertEqual(
            report.storage_objects_swept,
            {"deleted": 0, "ok": False, "error": "bucket unreachable"},
        )
        # The pass still completes, and the response says it did not go clean.
        self.assertFalse(report.ok)
        self.assertIs(report.as_dict()["ok"], False)
        self.assertEqual(report.orphan_vms_reaped, 0)

    # ---- unconfirmed deletions stay visible (audit SAN-05/SAN-06) ----

    def _running_row(self, *, sandbox_uid: str, sandbox_id: str) -> str:
        exp_id = self._experiment()
        seed_sandbox(
            self.app.sandbox_storage,
            experiment_id=exp_id,
            sandbox_uid=sandbox_uid,
            project_id=self.project_id,
            sandbox_id=sandbox_id,
            status="running",
            expires_at="2000-01-01T00:00:00Z",
        )
        self.backend.alive[sandbox_id] = True
        return exp_id

    def _row(self, sandbox_uid: str) -> dict:
        return self.app.sandbox_storage.get_by_uid(sandbox_uid=sandbox_uid)

    def _due_at(self, sandbox_uid: str) -> datetime:
        """An instant at which the parked row's backoff window has elapsed."""
        parked_at = parse_iso(self._row(sandbox_uid)["updated_at"])
        assert parked_at is not None
        return parked_at + timedelta(minutes=5)

    def _sandbox_events(self, event_type: str) -> list[dict]:
        return [
            event
            for event in self.store.recent_events(project_id=self.project_id)["events"]
            if event["type"] == event_type
        ]

    def test_a_delete_that_raises_parks_the_row_instead_of_terminating_it(self) -> None:
        uid = "uid_delete_raises"
        self._running_row(sandbox_uid=uid, sandbox_id="sb-delete-raises")

        def exploding_terminate(*, sandbox_id):
            raise RuntimeError("provider API 503")

        self.backend.terminate = exploding_terminate  # type: ignore[assignment]
        self.backend.liveness_unavailable = True
        self.assertEqual(
            self.app.sandboxes.reap_expired(now=datetime(2999, 1, 1, tzinfo=UTC)), 0
        )

        row = self._row(uid)
        self.assertEqual(row["status"], "cleanup_pending")
        self.assertEqual(row["phase"], "cleanup_attempt_1")
        self.assertIn("may still exist and bill", row["detail"])
        # Durable ledger entry, and visible in the project's sandbox list.
        events = self._sandbox_events("sandbox.cleanup_pending")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["payload"]["trigger"], "expired")
        listed = self.app.sandboxes.list_sandboxes(project_id=self.project_id)
        self.assertIn(
            "cleanup_pending",
            [entry["status"] for entry in listed["sandboxes"]],
        )

    def test_the_retry_terminalizes_once_the_provider_confirms_gone(self) -> None:
        uid = "uid_retry_confirms"
        self._running_row(sandbox_uid=uid, sandbox_id="sb-retry-confirms")
        original_terminate = self.backend.terminate
        self.backend.terminate = lambda *, sandbox_id: False  # type: ignore[assignment]
        self.backend.liveness_unavailable = True
        self.app.sandboxes.reap_expired(now=datetime(2999, 1, 1, tzinfo=UTC))
        self.assertEqual(self._row(uid)["status"], "cleanup_pending")

        # Still unreachable: the retry bumps the attempt and keeps the row.
        first = self.cleanup.retry_cleanup_pending(now=datetime(2999, 1, 1, tzinfo=UTC))
        self.assertEqual(first, {"ok": False, "pending": 1, "confirmed": 0, "retried": 1})
        self.assertEqual(self._row(uid)["phase"], "cleanup_attempt_2")
        self.assertEqual(len(self._sandbox_events("sandbox.cleanup_retried")), 1)

        # Provider comes back and confirms the delete.
        self.backend.terminate = original_terminate  # type: ignore[assignment]
        self.backend.liveness_unavailable = False
        second = self.cleanup.retry_cleanup_pending(
            now=datetime(2999, 1, 2, tzinfo=UTC)
        )
        self.assertEqual(
            second, {"ok": True, "pending": 0, "confirmed": 1, "retried": 0}
        )
        self.assertEqual(self._row(uid)["status"], "terminated")
        self.assertEqual(len(self._sandbox_events("sandbox.cleanup_confirmed")), 1)

    def test_the_retry_backs_off_before_asking_again(self) -> None:
        uid = "uid_backoff"
        self._running_row(sandbox_uid=uid, sandbox_id="sb-backoff")
        self.backend.terminate = lambda *, sandbox_id: False  # type: ignore[assignment]
        self.backend.liveness_unavailable = True
        self.app.sandboxes.reap_expired(now=datetime(2999, 1, 1, tzinfo=UTC))
        parked_at = parse_iso(self._row(uid)["updated_at"])
        assert parked_at is not None

        early = self.cleanup.retry_cleanup_pending(
            now=parked_at + timedelta(seconds=10)
        )
        self.assertEqual(early["retried"], 0)  # inside the first backoff window
        self.assertEqual(self._row(uid)["phase"], "cleanup_attempt_1")
        late = self.cleanup.retry_cleanup_pending(now=parked_at + timedelta(minutes=5))
        self.assertEqual(late["retried"], 1)
        self.assertEqual(self._row(uid)["phase"], "cleanup_attempt_2")

    def test_a_failed_provision_keeps_its_verdict_through_the_detour(self) -> None:
        # A wedged provision whose cleanup could not be confirmed parks, then
        # settles as `failed` (not a clean `terminated`) once the VM is gone.
        exp_id = self._experiment()
        uid = "uid_wedged_unconfirmed"
        seed_sandbox(
            self.app.sandbox_storage,
            experiment_id=exp_id,
            sandbox_uid=uid,
            project_id=self.project_id,
            sandbox_id="sb-wedged-unconfirmed",
            status="provisioning",
            phase="connecting",
            provision_started_at="2026-01-01T00:00:00Z",
        )
        self.backend.alive["sb-wedged-unconfirmed"] = True
        original_terminate = self.backend.terminate
        self.backend.terminate = lambda *, sandbox_id: False  # type: ignore[assignment]
        self.backend.liveness_unavailable = True
        self.assertEqual(
            self.cleanup.sweep_stale_provisions(
                now=datetime(2026, 1, 1, 0, 20, tzinfo=UTC)
            ),
            0,
        )
        row = self._row(uid)
        self.assertEqual(row["status"], "cleanup_pending")
        self.assertIn("wedged past deadline", row["error"])

        self.backend.terminate = original_terminate  # type: ignore[assignment]
        self.backend.liveness_unavailable = False
        # The park stamp is wall-clock, so drive the retry from past it.
        self.cleanup.retry_cleanup_pending(now=datetime(2999, 1, 1, tzinfo=UTC))
        settled = self._row(uid)
        self.assertEqual(settled["status"], "failed")
        self.assertIn("wedged past deadline", settled["error"])

    def test_an_unreachable_lookup_never_terminalizes_an_unrecorded_row(self) -> None:
        # No sandbox_id: the deterministic-name probe is the only evidence, and
        # a provider that cannot be asked is not evidence the VM is gone.
        exp_id = self._experiment()
        uid = "uid_lookup_outage"
        seed_sandbox(
            self.app.sandbox_storage,
            experiment_id=exp_id,
            sandbox_uid=uid,
            project_id=self.project_id,
            sandbox_id="",
            status="provisioning",
            phase="creating",
            provision_started_at="2026-01-01T00:00:00Z",
        )

        def exploding_find(*, experiment_id, sandbox_uid=""):
            raise RuntimeError("provider API timeout")

        self.backend.find_sandbox_id = exploding_find  # type: ignore[assignment]
        self.assertEqual(
            self.cleanup.sweep_stale_provisions(
                now=datetime(2026, 1, 1, 0, 20, tzinfo=UTC)
            ),
            0,
        )
        self.assertEqual(self._row(uid)["status"], "cleanup_pending")

    def test_an_authoritative_not_found_still_terminalizes(self) -> None:
        # Same row, but the provider answers and names nothing: that IS proof.
        exp_id = self._experiment()
        uid = "uid_lookup_empty"
        seed_sandbox(
            self.app.sandbox_storage,
            experiment_id=exp_id,
            sandbox_uid=uid,
            project_id=self.project_id,
            sandbox_id="",
            status="provisioning",
            phase="creating",
            provision_started_at="2026-01-01T00:00:00Z",
        )
        self.assertEqual(
            self.cleanup.sweep_stale_provisions(
                now=datetime(2026, 1, 1, 0, 20, tzinfo=UTC)
            ),
            1,
        )
        self.assertEqual(self._row(uid)["status"], "failed")

    def test_request_never_forgets_an_unrecorded_orphan_on_lookup_failure(self) -> None:
        exp_id = self._experiment()
        uid = "uid_reacquire_lookup_outage"
        seed_sandbox(
            self.app.sandbox_storage,
            experiment_id=exp_id,
            sandbox_uid=uid,
            project_id=self.project_id,
            sandbox_id="",
            provider="fake",
            status="provisioning",
            phase="creating",
            provision_started_at="2026-01-01T00:00:00Z",
        )

        def unavailable_lookup(**_kwargs):
            raise RuntimeError("provider lookup unavailable")

        self.backend.find_sandbox_id = unavailable_lookup  # type: ignore[method-assign]
        fresh = self.app.sandboxes.request(
            project_id=self.project_id,
            experiment_id=exp_id,
            public_key=DEFAULT_PUBLIC_KEY,
        )

        parked = self._row(uid)
        self.assertEqual(parked["status"], "cleanup_pending")
        self.assertNotEqual(fresh["sandbox_uid"], uid)

    def test_a_pending_cleanup_makes_the_whole_pass_not_ok(self) -> None:
        uid = "uid_not_ok"
        self._running_row(sandbox_uid=uid, sandbox_id="sb-not-ok")
        self.backend.terminate = lambda *, sandbox_id: False  # type: ignore[assignment]
        self.backend.liveness_unavailable = True
        self.app.sandboxes.reap_expired(now=datetime(2999, 1, 1, tzinfo=UTC))
        report = self.cleanup.run_all(now=datetime(2999, 1, 1, tzinfo=UTC))
        self.assertEqual(report.cleanup_pending["pending"], 1)
        self.assertFalse(report.ok)

    def test_a_request_never_provisions_over_a_pending_cleanup(self) -> None:
        uid = "uid_no_clobber"
        exp_id = self._running_row(sandbox_uid=uid, sandbox_id="sb-no-clobber")
        self.backend.terminate = lambda *, sandbox_id: False  # type: ignore[assignment]
        self.backend.liveness_unavailable = True
        self.app.sandboxes.reap_expired(now=datetime(2999, 1, 1, tzinfo=UTC))
        self.backend.liveness_unavailable = False
        lookups: list[dict] = []
        self.backend.find_sandbox_id = (  # type: ignore[method-assign]
            lambda **kwargs: lookups.append(kwargs) or None
        )

        fresh = self.app.sandboxes.request(
            project_id=self.project_id,
            experiment_id=exp_id,
            public_key=DEFAULT_PUBLIC_KEY,
        )
        self.assertNotEqual(fresh["sandbox_uid"], uid)
        parked = self._row(uid)
        self.assertEqual(parked["status"], "cleanup_pending")
        self.assertEqual(parked["sandbox_id"], "sb-no-clobber")
        self.assertEqual(lookups, [])

    # ---- a row is never rewritten over an unconfirmed cleanup (SAN-05) ----

    def _interrupted_provision(self, *, uid: str, sandbox_id: str, **fields) -> str:
        """A `provisioning` row whose job died with the brain (restart)."""
        exp_id = self._experiment()
        seed_sandbox(
            self.app.sandbox_storage,
            experiment_id=exp_id,
            sandbox_uid=uid,
            project_id=self.project_id,
            sandbox_id=sandbox_id,
            status="provisioning",
            phase="connecting",
            provision_started_at="2026-01-01T00:00:00Z",
            **fields,
        )
        self.backend.alive[sandbox_id] = True
        return exp_id

    def _request(self, exp_id: str) -> dict:
        return self.app.sandboxes.request(
            project_id=self.project_id,
            experiment_id=exp_id,
            public_key=DEFAULT_PUBLIC_KEY,
        )

    def test_a_restarted_provision_parks_rather_than_losing_its_provider_id(self) -> None:
        # The brain restarted after on_created persisted the id but before the
        # provision finished, and the agent re-calls sandbox.request. The row's
        # sandbox_id is the ONLY record of a VM that may still be billing, so
        # an unconfirmed cleanup must park that row — not blank its id and
        # re-provision on top of it.
        uid = "uid_restart_unconfirmed"
        exp_id = self._interrupted_provision(uid=uid, sandbox_id="sb-restart")
        self.backend.terminate = lambda *, sandbox_id: False  # type: ignore[assignment]
        self.backend.liveness_unavailable = True

        fresh = self._request(exp_id)

        parked = self._row(uid)
        self.assertEqual(parked["status"], "cleanup_pending")
        self.assertEqual(parked["sandbox_id"], "sb-restart")  # id survives
        self.assertNotEqual(fresh["sandbox_uid"], uid)  # fresh row, not a rewrite
        self.assertEqual(len(self._sandbox_events("sandbox.cleanup_pending")), 1)
        self.assertEqual(
            self._sandbox_events("sandbox.cleanup_pending")[0]["payload"]["trigger"],
            "reacquire",
        )

    def test_a_restarted_provision_reuses_its_row_once_cleanup_is_confirmed(self) -> None:
        # The control: the provider answers, the delete is confirmed, and the
        # row is reused exactly as before — no new row, no parking.
        uid = "uid_restart_confirmed"
        exp_id = self._interrupted_provision(uid=uid, sandbox_id="sb-restart-ok")

        fresh = self._request(exp_id)

        self.assertEqual(fresh["sandbox_uid"], uid)
        self.assertEqual(self._row(uid)["status"], "running")
        self.assertIn("sb-restart-ok", self.backend.terminated)

    def test_a_parked_row_settles_as_failed_not_as_a_clean_terminated(self) -> None:
        # Manual release of a parked row must finish the journey the row was
        # already on. Laundering a failed provision into `terminated` hides the
        # failure from the only status the agent ever reads.
        uid = "uid_release_verdict"
        exp_id = self._experiment()
        seed_sandbox(
            self.app.sandbox_storage,
            experiment_id=exp_id,
            sandbox_uid=uid,
            project_id=self.project_id,
            sandbox_id="sb-verdict",
            status="provisioning",
            phase="connecting",
            provision_started_at="2026-01-01T00:00:00Z",
        )
        self.backend.alive["sb-verdict"] = True
        self.backend.terminate = lambda *, sandbox_id: False  # type: ignore[assignment]
        self.backend.liveness_unavailable = True
        self.cleanup.sweep_stale_provisions(now=datetime(2026, 1, 1, 0, 20, tzinfo=UTC))
        self.assertEqual(self._row(uid)["status"], "cleanup_pending")

        self.backend.terminate = FakeSandboxBackend.terminate.__get__(self.backend)  # type: ignore[assignment]
        self.backend.liveness_unavailable = False
        released = self.app.sandboxes.release(
            project_id=self.project_id, sandbox_uid=uid, confirm_retained=True
        )

        self.assertEqual(released["status"], "failed")
        settled = self._row(uid)
        self.assertEqual(settled["status"], "failed")
        self.assertIn("wedged past deadline", settled["error"])
        self.assertEqual(
            self._sandbox_events("sandbox.released")[-1]["payload"]["status"], "failed"
        )

    def test_an_aggregate_release_never_reports_terminated_while_one_row_parks(
        self,
    ) -> None:
        # Two live sandboxes, one teardown unconfirmed. A "terminated" headline
        # tells the operator the bill stopped, and they stop looking.
        exp_id = self._experiment()
        for uid, sandbox_id in (("uid_agg_ok", "sb-agg-ok"), ("uid_agg_bad", "sb-agg-bad")):
            seed_sandbox(
                self.app.sandbox_storage,
                experiment_id=exp_id,
                sandbox_uid=uid,
                project_id=self.project_id,
                sandbox_id=sandbox_id,
                status="running",
                expires_at="2999-01-01T00:00:00Z",
            )
            self.backend.alive[sandbox_id] = True
        original_terminate = self.backend.terminate

        def terminate(*, sandbox_id):
            if sandbox_id == "sb-agg-bad":
                raise RuntimeError("provider API 503")
            return original_terminate(sandbox_id=sandbox_id)

        self.backend.terminate = terminate  # type: ignore[assignment]

        result = self.app.sandboxes.release(
            project_id=self.project_id, experiment_id=exp_id, confirm_retained=True
        )

        self.assertEqual(result["status"], "cleanup_pending")
        self.assertEqual(result["released_count"], 1)
        self.assertEqual(result["pending_count"], 1)
        self.assertIs(result["released"], False)
        self.assertIn("may still be running", result["hint"])
        self.assertEqual(self._row("uid_agg_ok")["status"], "terminated")
        self.assertEqual(self._row("uid_agg_bad")["status"], "cleanup_pending")

    def test_an_experiment_release_never_omits_an_already_parked_sibling(self) -> None:
        # The state fix 1 produces: a row parks BEFORE the release, and the
        # request that followed it provisioned a second, healthy row. Filtering
        # the experiment's rows to the live ones drops the parked one from the
        # release entirely — and then the aggregate happily reports
        # "terminated" over a VM that may still be up and billing.
        uid_parked = "uid_release_preparked"
        exp_id = self._running_row(sandbox_uid=uid_parked, sandbox_id="sb-preparked")
        original_terminate = self.backend.terminate
        self.backend.terminate = lambda *, sandbox_id: False  # type: ignore[assignment]
        self.backend.liveness_unavailable = True
        self.app.sandboxes.reap_expired(now=datetime(2999, 1, 1, tzinfo=UTC))
        self.assertEqual(self._row(uid_parked)["status"], "cleanup_pending")

        # The provider recovers enough to serve a fresh provision.
        self.backend.terminate = original_terminate  # type: ignore[assignment]
        self.backend.liveness_unavailable = False
        fresh = self._request(exp_id)
        self.assertEqual(fresh["status"], "running")
        self.assertNotEqual(fresh["sandbox_uid"], uid_parked)

        # ...but still cannot delete the parked box.
        def terminate(*, sandbox_id):
            if sandbox_id == "sb-preparked":
                raise RuntimeError("provider API 503")
            return original_terminate(sandbox_id=sandbox_id)

        self.backend.terminate = terminate  # type: ignore[assignment]

        result = self.app.sandboxes.release(
            project_id=self.project_id, experiment_id=exp_id, confirm_retained=True
        )

        self.assertEqual(result["status"], "cleanup_pending")
        self.assertEqual(result["pending_count"], 1)
        self.assertEqual(result["released_count"], 1)
        self.assertIs(result["released"], False)
        self.assertIn("may still be running", result["hint"])
        self.assertIn(
            uid_parked, [view.get("sandbox_uid") for view in result["sandboxes"]]
        )
        self.assertEqual(self._row(uid_parked)["status"], "cleanup_pending")
        self.assertEqual(self._row(uid_parked)["sandbox_id"], "sb-preparked")
        self.assertEqual(self._row(fresh["sandbox_uid"])["status"], "terminated")

    def test_an_experiment_release_retries_a_parked_sibling_it_can_now_delete(
        self,
    ) -> None:
        # The other half: once the provider answers, the parked sibling is
        # settled by the same release rather than left for the sweep.
        uid_parked = "uid_release_retried"
        exp_id = self._running_row(sandbox_uid=uid_parked, sandbox_id="sb-retried")
        original_terminate = self.backend.terminate
        self.backend.terminate = lambda *, sandbox_id: False  # type: ignore[assignment]
        self.backend.liveness_unavailable = True
        self.app.sandboxes.reap_expired(now=datetime(2999, 1, 1, tzinfo=UTC))
        self.backend.terminate = original_terminate  # type: ignore[assignment]
        self.backend.liveness_unavailable = False
        fresh = self._request(exp_id)

        result = self.app.sandboxes.release(
            project_id=self.project_id, experiment_id=exp_id, confirm_retained=True
        )

        self.assertEqual(result["status"], "terminated")
        self.assertEqual(result["released_count"], 2)
        self.assertEqual(self._row(uid_parked)["status"], "terminated")
        self.assertEqual(self._row(fresh["sandbox_uid"])["status"], "terminated")
        self.assertIn("sb-retried", self.backend.terminated)

    # ---- provider ownership routes every cleanup (SAN-06) ----

    def test_a_row_whose_provider_is_unconfigured_is_never_terminalized(self) -> None:
        # The row records the provider that served it. If that provider is no
        # longer in MERV_EXECUTION_BACKENDS, every remaining provider answering
        # "not mine" is not evidence — its VM may be up and billing, and nobody
        # asked its owner.
        exp_id = self._experiment()
        uid = "uid_foreign_provider"
        seed_sandbox(
            self.app.sandbox_storage,
            experiment_id=exp_id,
            sandbox_uid=uid,
            project_id=self.project_id,
            sandbox_id="",
            provider="lambda_labs",  # the configured backend is "fake"
            status="provisioning",
            phase="creating",
            provision_started_at="2026-01-01T00:00:00Z",
        )
        self.backend.alive["sb-foreign"] = True
        self.backend.by_experiment[exp_id] = "sb-foreign"

        self.assertEqual(
            self.cleanup.sweep_stale_provisions(
                now=datetime(2026, 1, 1, 0, 20, tzinfo=UTC)
            ),
            0,
        )
        self.assertEqual(self._row(uid)["status"], "cleanup_pending")
        # And nobody else's VM was destroyed on that row's behalf.
        self.assertNotIn("sb-foreign", self.backend.terminated)

    def test_a_row_whose_provider_is_configured_still_terminalizes(self) -> None:
        # Same row, correct owner recorded: the sweep works exactly as before.
        exp_id = self._experiment()
        uid = "uid_own_provider"
        seed_sandbox(
            self.app.sandbox_storage,
            experiment_id=exp_id,
            sandbox_uid=uid,
            project_id=self.project_id,
            sandbox_id="",
            provider="fake",
            status="provisioning",
            phase="creating",
            provision_started_at="2026-01-01T00:00:00Z",
        )
        self.backend.alive["sb-own"] = True
        self.backend.by_experiment[exp_id] = "sb-own"

        self.assertEqual(
            self.cleanup.sweep_stale_provisions(
                now=datetime(2026, 1, 1, 0, 20, tzinfo=UTC)
            ),
            1,
        )
        self.assertEqual(self._row(uid)["status"], "failed")
        self.assertIn("sb-own", self.backend.terminated)

    # ---- concurrent cleanup workers (CAS) ----

    def test_a_late_unavailable_result_cannot_resurrect_a_terminal_row(self) -> None:
        # Two workers hold the same pending row. A confirms the delete and
        # terminalizes it; B's slower "unavailable" answer arrives afterwards.
        # B must not drag a row whose attachments and spend generation are
        # already closed back to cleanup_pending.
        uid = "uid_cas_race"
        self._running_row(sandbox_uid=uid, sandbox_id="sb-cas")
        self.app.sandbox_lifecycle.mark_terminated(
            row=self._row(uid),
        )
        self.assertEqual(self._row(uid)["status"], "terminated")

        self.app.sandbox_storage.mark_cleanup_pending(
            sandbox_uid=uid,
            detail="late worker",
            expected_project_id=self.project_id,
            error="late worker",
            attempts=2,
        )

        settled = self._row(uid)
        self.assertEqual(settled["status"], "terminated")
        self.assertNotEqual(settled["phase"], "cleanup_attempt_2")

    def test_a_still_pending_row_is_parked_again_by_the_same_write(self) -> None:
        # The control for the CAS clause: a non-terminal row still moves.
        uid = "uid_cas_pending"
        self._running_row(sandbox_uid=uid, sandbox_id="sb-cas-pending")
        self.backend.terminate = lambda *, sandbox_id: False  # type: ignore[assignment]
        self.backend.liveness_unavailable = True
        self.app.sandboxes.reap_expired(now=datetime(2999, 1, 1, tzinfo=UTC))

        self.app.sandbox_storage.mark_cleanup_pending(
            sandbox_uid=uid,
            detail="second attempt",
            expected_project_id=self.project_id,
            attempts=2,
        )
        self.assertEqual(self._row(uid)["phase"], "cleanup_attempt_2")

    def test_two_cleanup_workers_racing_one_parked_row_confirm_it_once(self) -> None:
        # The daemon loop and the cloud CleanupService sweep the same pending
        # rows. Both read the row while it is pending; A confirms the delete and
        # terminalizes it. B must notice on its own re-read — no second provider
        # round-trip, no second confirmation event, no resurrected row.
        uid = "uid_two_racers"
        self._running_row(sandbox_uid=uid, sandbox_id="sb-racers")
        self.backend.terminate = lambda *, sandbox_id: False  # type: ignore[assignment]
        self.backend.liveness_unavailable = True
        self.app.sandboxes.reap_expired(now=datetime(2999, 1, 1, tzinfo=UTC))
        snapshot = self._row(uid)  # the copy BOTH workers are holding
        self.assertEqual(snapshot["status"], "cleanup_pending")
        due_at = self._due_at(uid)

        self.backend.terminate = FakeSandboxBackend.terminate.__get__(self.backend)  # type: ignore[assignment]
        self.backend.liveness_unavailable = False
        lifecycle = self.app.sandbox_lifecycle

        self.assertTrue(
            lifecycle._retry_one_cleanup(  # noqa: SLF001
                row=dict(snapshot), attempts=1, now=due_at
            )
        )
        self.assertEqual(self._row(uid)["status"], "terminated")
        terminate_calls = len(self.backend.terminated)

        # Worker B wakes up with the same stale snapshot.
        self.assertTrue(
            lifecycle._retry_one_cleanup(  # noqa: SLF001
                row=dict(snapshot), attempts=1, now=due_at
            )
        )

        settled = self._row(uid)
        self.assertEqual(settled["status"], "terminated")
        self.assertEqual(len(self.backend.terminated), terminate_calls)
        self.assertEqual(len(self._sandbox_events("sandbox.cleanup_confirmed")), 1)
        self.assertEqual(len(self._sandbox_events("sandbox.cleanup_retried")), 0)

    def test_two_simultaneous_workers_terminate_one_parked_vm_once(self) -> None:
        # The race the sequential test above cannot reach: BOTH workers re-read
        # the row and see it pending before either has settled anything. The
        # re-read is a check, not a claim — without one, each fires its own
        # terminate at the same VM and each writes its own confirmation, so the
        # ledger says one deletion happened twice.
        uid = "uid_simultaneous"
        self._running_row(sandbox_uid=uid, sandbox_id="sb-simultaneous")
        self.backend.terminate = lambda *, sandbox_id: False  # type: ignore[assignment]
        self.backend.liveness_unavailable = True
        self.app.sandboxes.reap_expired(now=datetime(2999, 1, 1, tzinfo=UTC))
        snapshot = self._row(uid)  # the copy BOTH workers are holding
        self.assertEqual(snapshot["status"], "cleanup_pending")
        due_at = self._due_at(uid)

        # The provider can delete again: both workers would otherwise succeed.
        self.backend.terminate = FakeSandboxBackend.terminate.__get__(self.backend)  # type: ignore[assignment]
        self.backend.liveness_unavailable = False
        lifecycle = self.app.sandbox_lifecycle
        repository = lifecycle.storage
        inner_get = repository.get_by_uid
        # Hold each worker at the instant after its re-read, so neither can
        # settle the row before the other has seen it pending.
        gate = threading.Barrier(2, timeout=30)

        def gated_get_by_uid(*, sandbox_uid: str):
            row = inner_get(sandbox_uid=sandbox_uid)
            if sandbox_uid == uid and row.get("status") == "cleanup_pending":
                gate.wait()
            return row

        repository.get_by_uid = gated_get_by_uid  # type: ignore[method-assign]
        confirmed: list[bool] = []
        failures: list[BaseException] = []

        def worker() -> None:
            try:
                confirmed.append(
                    lifecycle._retry_one_cleanup(  # noqa: SLF001
                        row=dict(snapshot), attempts=1, now=due_at
                    )
                )
            except BaseException as exc:  # noqa: BLE001 — reported, not swallowed
                failures.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(2)]
        try:
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=30)
                self.assertFalse(thread.is_alive(), "a cleanup worker never finished")
        finally:
            repository.get_by_uid = inner_get  # type: ignore[method-assign]

        self.assertEqual(failures, [])
        # Exactly one worker owned the attempt; the other found it taken.
        self.assertEqual(sorted(confirmed), [False, True])
        self.assertEqual(self.backend.terminated.count("sb-simultaneous"), 1)
        self.assertEqual(len(self._sandbox_events("sandbox.cleanup_confirmed")), 1)
        self.assertEqual(self._row(uid)["status"], "terminated")

    def test_two_releases_of_a_running_row_take_one_destructive_claim(self) -> None:
        uid = "uid_two_live_releases"
        self._running_row(sandbox_uid=uid, sandbox_id="sb-two-live-releases")
        snapshot = self._row(uid)
        real_terminate = FakeSandboxBackend.terminate.__get__(self.backend)
        entered = threading.Event()
        finish = threading.Event()

        def gated_terminate(*, sandbox_id: str):
            entered.set()
            finish.wait(timeout=5)
            return real_terminate(sandbox_id=sandbox_id)

        self.backend.terminate = gated_terminate  # type: ignore[assignment]
        first: list[dict] = []
        worker = threading.Thread(
            target=lambda: first.append(
                self.app.sandboxes._release_row(row=dict(snapshot))
            )
        )
        worker.start()
        self.assertTrue(entered.wait(timeout=5))
        second = self.app.sandboxes._release_row(row=dict(snapshot))
        finish.set()
        worker.join(timeout=5)

        self.assertFalse(worker.is_alive())
        self.assertEqual(self.backend.terminated.count("sb-two-live-releases"), 1)
        self.assertEqual(len(self._sandbox_events("sandbox.released")), 1)
        self.assertEqual(first[0]["status"], "terminated")
        self.assertEqual(second["status"], "cleanup_pending")
        self.assertIn("Nothing was sent", second["hint"])

    def test_a_staggered_worker_never_enters_a_claimed_provider_call(self) -> None:
        # The race the barrier test cannot reach: the workers are STAGGERED, not
        # simultaneous. A claims the attempt and blocks inside the provider
        # call; B — already past its own eligibility check — re-reads the row
        # only then, so it sees A's fresh attempt marker and would CAS cleanly
        # against it. Being still-due is what refuses B: A's claim stamped the
        # row, so its backoff window has not elapsed. One VM, one terminate,
        # one settlement.
        uid = "uid_staggered"
        self._running_row(sandbox_uid=uid, sandbox_id="sb-staggered")
        self.backend.terminate = lambda *, sandbox_id: False  # type: ignore[assignment]
        self.backend.liveness_unavailable = True
        self.app.sandboxes.reap_expired(now=datetime(2999, 1, 1, tzinfo=UTC))
        snapshot = self._row(uid)
        self.assertEqual(snapshot["status"], "cleanup_pending")
        due_at = self._due_at(uid)  # both workers pass eligibility at this clock

        real_terminate = FakeSandboxBackend.terminate.__get__(self.backend)
        self.backend.liveness_unavailable = False
        lifecycle = self.app.sandbox_lifecycle
        inside = threading.Event()
        finish = threading.Event()
        worker_a: threading.Thread

        def gated_terminate(*, sandbox_id: str):
            # Only A parks in the provider call; B, if it ever gets here, is
            # allowed straight through so the duplicate shows up as a count.
            if threading.current_thread() is worker_a:
                inside.set()
                finish.wait(timeout=30)
            return real_terminate(sandbox_id=sandbox_id)

        self.backend.terminate = gated_terminate  # type: ignore[assignment]
        outcome: list[bool] = []
        failures: list[BaseException] = []

        def run_a() -> None:
            try:
                outcome.append(
                    lifecycle._retry_one_cleanup(  # noqa: SLF001
                        row=dict(snapshot), attempts=1, now=due_at
                    )
                )
            except BaseException as exc:  # noqa: BLE001 — reported, not swallowed
                failures.append(exc)

        worker_a = threading.Thread(target=run_a)
        worker_a.start()
        try:
            self.assertTrue(inside.wait(timeout=30), "worker A never reached the provider")
            # B arrives while A's terminate is still outstanding.
            self.assertFalse(
                lifecycle._retry_one_cleanup(  # noqa: SLF001
                    row=dict(snapshot), attempts=1, now=due_at
                )
            )
            self.assertEqual(
                self.backend.terminated.count("sb-staggered"),
                0,
                "the losing worker reached the provider",
            )
        finally:
            finish.set()
            worker_a.join(timeout=30)
            self.assertFalse(worker_a.is_alive(), "worker A never finished")

        self.assertEqual(failures, [])
        self.assertEqual(outcome, [True])  # only A owned the attempt
        self.assertEqual(self.backend.terminated.count("sb-staggered"), 1)
        self.assertEqual(len(self._sandbox_events("sandbox.cleanup_confirmed")), 1)
        self.assertEqual(len(self._sandbox_events("sandbox.cleanup_retried")), 0)
        self.assertEqual(self._row(uid)["status"], "terminated")

    def test_a_release_refuses_a_row_claimed_since_it_read_it(self) -> None:
        # Release may jump the retry backoff — asking by hand is the point —
        # but not an attempt already taken. The hard case is a release whose
        # snapshot is taken AFTER the sweep's claim: the phase and the stamp it
        # holds are both the winner's own, so no CAS on either can tell this
        # apart from a free row. Only an explicit in-flight marker can, and the
        # sweep's provider call has not reported yet.
        uid = "uid_release_inflight"
        self._running_row(sandbox_uid=uid, sandbox_id="sb-release-inflight")
        self.backend.terminate = lambda *, sandbox_id: False  # type: ignore[assignment]
        self.backend.liveness_unavailable = True
        self.app.sandboxes.reap_expired(now=datetime(2999, 1, 1, tzinfo=UTC))
        self.backend.terminate = FakeSandboxBackend.terminate.__get__(self.backend)  # type: ignore[assignment]
        self.backend.liveness_unavailable = False

        lifecycle = self.app.sandbox_lifecycle
        claim = lifecycle.claim_cleanup_due(row=self._row(uid), now=self._due_at(uid))
        self.assertTrue(claim)

        # The release reads the row fresh, from scratch, after that claim.
        snapshot = self._row(uid)
        self.assertEqual(snapshot["status"], "cleanup_pending")
        self.assertEqual(snapshot["phase"], claim.phase)
        self.assertTrue(cleanup_inflight_token(phase=snapshot["phase"]))

        view = self.app.sandboxes._release_row(row=dict(snapshot))  # noqa: SLF001

        self.assertEqual(self.backend.terminated.count("sb-release-inflight"), 0)
        self.assertEqual(view["status"], "cleanup_pending")
        self.assertIn("Nothing was sent to the provider", view["hint"])
        self.assertEqual(len(self._sandbox_events("sandbox.released")), 0)
        # The holder still owns the row: nothing was bumped out from under it.
        self.assertEqual(self._row(uid)["phase"], claim.phase)

    def test_an_in_flight_claim_is_reclaimable_only_past_the_deadline(self) -> None:
        # A worker can die inside the provider call. Its marker must not park a
        # possibly-billing VM forever — but nor may a second worker step over a
        # claim that is merely slow. The hard deadline is the whole difference.
        uid = "uid_inflight_deadline"
        self._running_row(sandbox_uid=uid, sandbox_id="sb-inflight-deadline")
        self.backend.terminate = lambda *, sandbox_id: False  # type: ignore[assignment]
        self.backend.liveness_unavailable = True
        self.app.sandboxes.reap_expired(now=datetime(2999, 1, 1, tzinfo=UTC))
        lifecycle = self.app.sandbox_lifecycle
        claimed_at = self._due_at(uid)
        worker_a = lifecycle.claim_cleanup_due(row=self._row(uid), now=claimed_at)
        self.assertTrue(worker_a)

        # Still inside the deadline: the row belongs to A, by hand or by sweep.
        early = claimed_at + timedelta(seconds=CLEANUP_INFLIGHT_DEADLINE_SECONDS - 30)
        self.assertFalse(lifecycle.claim_cleanup_due(row=self._row(uid), now=early))
        self.assertFalse(lifecycle.claim_cleanup(row=self._row(uid)))
        self.assertEqual(
            self.cleanup.retry_cleanup_pending(now=early),
            {"ok": False, "pending": 1, "confirmed": 0, "retried": 0},
        )
        self.assertEqual(self._row(uid)["phase"], worker_a.phase)

        # Past it the sweep reclaims the row under a NEW token — otherwise one
        # lost worker parks a possibly-billing VM behind its marker forever.
        # The provider is still unreachable, so the reclaim re-parks at the
        # attempt IT took, not at A's.
        late = claimed_at + timedelta(seconds=CLEANUP_INFLIGHT_DEADLINE_SECONDS + 30)
        self.assertEqual(
            self.cleanup.retry_cleanup_pending(now=late),
            {"ok": False, "pending": 1, "confirmed": 0, "retried": 1},
        )
        reclaimed = self._row(uid)
        self.assertEqual(reclaimed["status"], "cleanup_pending")
        self.assertEqual(reclaimed["phase"], "cleanup_attempt_3")

        # A finally reports. Its settlement lands nowhere.
        self.assertFalse(
            lifecycle.mark_terminated(
                row=self._row(uid),
                expected_phase=worker_a.phase,
            )
        )
        fenced = self._row(uid)
        self.assertEqual(fenced["status"], "cleanup_pending")
        self.assertEqual(fenced["phase"], "cleanup_attempt_3")

        # ...and the ending belongs to whoever holds the row now.
        self.backend.terminate = FakeSandboxBackend.terminate.__get__(self.backend)  # type: ignore[assignment]
        self.backend.liveness_unavailable = False
        self.assertEqual(
            self.cleanup.retry_cleanup_pending(now=late + timedelta(hours=2)),
            {"ok": True, "pending": 0, "confirmed": 1, "retried": 0},
        )
        self.assertEqual(self._row(uid)["status"], "terminated")

    def test_a_reclaimed_release_settles_nothing_and_reports_it(self) -> None:
        # The same fence through the whole release path: this release overran
        # the deadline, another attempt reclaimed the row while it was inside
        # the provider call, and its terminate really did go through. It must
        # still write nothing — no terminal status, no `sandbox.released` — and
        # the operator must be told the row was not settled here.
        uid = "uid_release_fenced"
        self._running_row(sandbox_uid=uid, sandbox_id="sb-release-fenced")
        self.backend.terminate = lambda *, sandbox_id: False  # type: ignore[assignment]
        self.backend.liveness_unavailable = True
        self.app.sandboxes.reap_expired(now=datetime(2999, 1, 1, tzinfo=UTC))
        snapshot = self._row(uid)
        self.backend.liveness_unavailable = False
        lifecycle = self.app.sandbox_lifecycle
        real_terminate = FakeSandboxBackend.terminate.__get__(self.backend)
        reclaimed: list[str] = []

        def gated_terminate(*, sandbox_id: str):
            # A second attempt reclaims the row mid-call: from its side this
            # release has been gone longer than any bounded provider call.
            if not reclaimed:
                with patch.object(
                    sandbox_models, "CLEANUP_INFLIGHT_DEADLINE_SECONDS", 0.0
                ):
                    claim = lifecycle.claim_cleanup(row=self._row(uid))
                reclaimed.append(claim.phase if claim else "")
            return real_terminate(sandbox_id=sandbox_id)

        self.backend.terminate = gated_terminate  # type: ignore[assignment]

        view = self.app.sandboxes._release_row(row=dict(snapshot))  # noqa: SLF001

        self.assertTrue(reclaimed and reclaimed[0], "the reclaim never happened")
        self.assertEqual(self.backend.terminated.count("sb-release-fenced"), 1)
        self.assertEqual(view["status"], "cleanup_pending")
        self.assertIn("reclaimed", view["hint"])
        self.assertEqual(len(self._sandbox_events("sandbox.released")), 0)
        settled = self._row(uid)
        self.assertEqual(settled["status"], "cleanup_pending")
        self.assertEqual(settled["phase"], reclaimed[0])

    def test_a_release_retries_once_against_a_row_that_has_freed_up(self) -> None:
        # A snapshot goes stale without the row being held: the attempt it
        # collided with finished and re-parked. Refusing the operator forever on
        # that evidence is starvation, not safety — one fresh read settles it.
        uid = "uid_release_starved"
        self._running_row(sandbox_uid=uid, sandbox_id="sb-release-starved")
        self.backend.terminate = lambda *, sandbox_id: False  # type: ignore[assignment]
        self.backend.liveness_unavailable = True
        self.app.sandboxes.reap_expired(now=datetime(2999, 1, 1, tzinfo=UTC))
        snapshot = self._row(uid)  # the operator's read: attempt 1, parked

        # The sweep takes attempt 2 and cannot confirm either, so the row parks
        # again — with a phase and a stamp the operator's copy never saw.
        self.cleanup.retry_cleanup_pending(now=self._due_at(uid))
        self.assertEqual(self._row(uid)["phase"], "cleanup_attempt_2")

        self.backend.terminate = FakeSandboxBackend.terminate.__get__(self.backend)  # type: ignore[assignment]
        self.backend.liveness_unavailable = False

        view = self.app.sandboxes._release_row(row=dict(snapshot))  # noqa: SLF001

        self.assertEqual(view["status"], "terminated")
        self.assertEqual(self.backend.terminated.count("sb-release-starved"), 1)
        self.assertEqual(len(self._sandbox_events("sandbox.released")), 1)

    def test_a_release_holding_the_same_parked_row_never_settles_it_twice(
        self,
    ) -> None:
        # Manual release and the cleanup sweep contend for exactly the same
        # rows. A release working from a snapshot another worker has already
        # acted on must not send a second terminate, nor write a second
        # settlement over the first.
        uid = "uid_release_race"
        self._running_row(sandbox_uid=uid, sandbox_id="sb-release-race")
        self.backend.terminate = lambda *, sandbox_id: False  # type: ignore[assignment]
        self.backend.liveness_unavailable = True
        self.app.sandboxes.reap_expired(now=datetime(2999, 1, 1, tzinfo=UTC))
        snapshot = self._row(uid)
        self.assertEqual(snapshot["status"], "cleanup_pending")
        self.backend.terminate = FakeSandboxBackend.terminate.__get__(self.backend)  # type: ignore[assignment]
        self.backend.liveness_unavailable = False

        first = self.app.sandboxes._release_row(row=dict(snapshot))  # noqa: SLF001
        self.assertEqual(first["status"], "terminated")
        self.assertEqual(self.backend.terminated.count("sb-release-race"), 1)

        second = self.app.sandboxes._release_row(row=dict(snapshot))  # noqa: SLF001

        self.assertEqual(self.backend.terminated.count("sb-release-race"), 1)
        self.assertEqual(len(self._sandbox_events("sandbox.released")), 1)
        self.assertEqual(second["status"], "terminated")
        self.assertIn("Nothing was sent to the provider", second["hint"])

    def test_a_fenced_out_workers_observation_stamp_never_lands(self) -> None:
        # The stamp flips unfinished runs from `unknown` to `lost`, so a worker
        # that lost its claim past the deadline must not land a read it took
        # before the stall — only the holder of the row's current marker may.
        uid = "uid_fenced_stamp"
        self._running_row(sandbox_uid=uid, sandbox_id="sb-fenced-stamp")
        self.backend.terminate = lambda *, sandbox_id: False  # type: ignore[assignment]
        self.backend.liveness_unavailable = True
        self.app.sandboxes.reap_expired(now=datetime(2999, 1, 1, tzinfo=UTC))
        lifecycle = self.app.sandbox_lifecycle
        claimed_at = self._due_at(uid)
        worker_a = lifecycle.claim_cleanup_due(row=self._row(uid), now=claimed_at)
        self.assertTrue(worker_a)
        stale = dict(self._row(uid))

        # Past the deadline the sweep reclaims and re-parks under a new marker.
        late = claimed_at + timedelta(seconds=CLEANUP_INFLIGHT_DEADLINE_SECONDS + 30)
        self.cleanup.retry_cleanup_pending(now=late)
        self.assertNotEqual(self._row(uid)["phase"], worker_a.phase)

        # A's late stamp names the marker it held; the row has moved on.
        lifecycle.commit_runs_observation(
            row=stale, observed=True, expected_phase=worker_a.phase
        )
        self.assertFalse(self._row(uid)["runs_final_observed_at"])

        # The current holder's stamp lands.
        worker_b = lifecycle.claim_cleanup(row=self._row(uid))
        self.assertTrue(worker_b)
        lifecycle.commit_runs_observation(
            row=self._row(uid), observed=True, expected_phase=worker_b.phase
        )
        self.assertTrue(self._row(uid)["runs_final_observed_at"])

    def test_row_views_never_carry_the_cleanup_ownership_token(self) -> None:
        # The in-flight marker fences internal writers; agents and the UI get
        # the attempt count, never the token that authorizes completion writes.
        uid = "uid_view_token"
        self._running_row(sandbox_uid=uid, sandbox_id="sb-view-token")
        self.backend.terminate = lambda *, sandbox_id: False  # type: ignore[assignment]
        self.backend.liveness_unavailable = True
        self.app.sandboxes.reap_expired(now=datetime(2999, 1, 1, tzinfo=UTC))
        lifecycle = self.app.sandbox_lifecycle
        claim = lifecycle.claim_cleanup_due(row=self._row(uid), now=self._due_at(uid))
        self.assertTrue(claim)
        token = cleanup_inflight_token(phase=self._row(uid)["phase"])
        self.assertTrue(token)

        view = self.app.sandboxes.snapshot(
            project_id=self.project_id,
            sandbox_uid=uid,
        )
        self.assertNotIn(token, str(view))
        self.assertEqual(view["phase"], "cleanup_attempt_2")

        refusal = self.app.sandboxes._release_row(row=dict(self._row(uid)))  # noqa: SLF001
        self.assertNotIn(token, str(refusal))

    def test_a_failing_prune_is_reported_as_not_ok_not_as_zero(self) -> None:
        class ExplodingLedger:
            def prune(self, *, now=None):
                raise RuntimeError("ledger unreachable")

        cleanup = CleanupService(
            sandboxes=self.app.sandboxes,
            blobs=self.app.blobs,
            tool_call_ledger=ExplodingLedger(),
        )
        report = cleanup.run_all(now=datetime.now(tz=UTC))
        self.assertEqual(
            report.tool_calls_pruned,
            {"deleted": 0, "ok": False, "error": "ledger unreachable"},
        )
        # The rest of the pass still ran.
        self.assertEqual(report.orphan_vms_reaped, 0)


if __name__ == "__main__":
    unittest.main()
