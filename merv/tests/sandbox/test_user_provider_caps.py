"""Per-user per-provider daily spend caps (migration 44).

Commitment-based admission (accrued + committed + requested lease vs the
cap), payer-of-record attribution from reservation to ledger, pre-launch
quote revalidation, and the warn → over_budget → grace → terminate sweep.
Time-sensitive math pins ``quotas`` clock to noon UTC so UTC-midnight
clamping is deterministic regardless of when the suite runs.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest import mock

from tests.support.brain import DEFAULT_PUBLIC_KEY, TestBrain
from tests.support.sandbox_backend import FakeSandboxBackend
from merv.brain.kernel.utils import PermissionDeniedError
from merv.brain.sandbox.budget import BudgetEnforcer
from merv.brain.sandbox.models import ProvisionedSandbox, SandboxRequest
from merv.brain.sandbox.quotas import AdmissionRequest, QuotaService

NOON = datetime(2026, 8, 3, 12, 0, 0, tzinfo=UTC)
MIDNIGHT_NEXT = datetime(2026, 8, 4, 0, 0, 0, tzinfo=UTC)


class _FixedDatetime(datetime):
    @classmethod
    def now(cls, tz=None):  # noqa: D102 — stdlib signature
        return NOON if tz is not None else NOON.replace(tzinfo=None)


def _iso(moment: datetime) -> str:
    return moment.isoformat().replace("+00:00", "Z")


class _CapTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.backend = FakeSandboxBackend(requires_hardware_selection=True)
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
            execution_backend=self.backend,
        )
        self.store = self.app.store
        self.quotas = QuotaService(store=self.store)
        self.project_id = self.app.call_tool(
            "project", {"action": "create", "name": "Cap Proj"}
        )["id"]

    def tearDown(self) -> None:
        self.app.shutdown()
        self.tmp.cleanup()

    def _set_cap(
        self, *, provider: str = "fake", user_id: str = "", limit: float | None
    ) -> None:
        with self.store.transaction() as conn:
            conn.execute(
                "INSERT INTO provider_user_caps "
                "(provider, user_id, daily_usd_limit, updated_at) "
                "VALUES (?, ?, ?, '2026-08-03T00:00:00Z') "
                "ON CONFLICT(provider, user_id) DO UPDATE "
                "SET daily_usd_limit = excluded.daily_usd_limit",
                (provider, user_id, limit),
            )

    def _seed_generation(
        self,
        *,
        user_id: str,
        price: float,
        started: datetime,
        ended: datetime | None,
        provider: str = "fake",
        billing_mode: str = "platform",
        price_known: int = 1,
        sandbox_uid: str = "",
    ) -> None:
        with self.store.transaction() as conn:
            conn.execute(
                "INSERT INTO sandbox_generations "
                "(id, experiment_id, project_id, tenant_id, sandbox_id, "
                " provider, price_usd_per_hour, price_known, user_id, "
                " billing_mode, sandbox_uid, started_at, ended_at) "
                "VALUES (?, 'exp_seed', ?, 'local', 'sb-seed', ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    f"sbg_{started.timestamp()}_{user_id}_{price}",
                    self.project_id,
                    provider,
                    price,
                    price_known,
                    user_id,
                    billing_mode,
                    sandbox_uid,
                    _iso(started),
                    None if ended is None else _iso(ended),
                ),
            )

    def _seed_sandbox(
        self,
        *,
        uid: str,
        status: str,
        user_id: str,
        quoted_price: float | None,
        expires_at: datetime | None = None,
        provider: str = "fake",
        billing_mode: str = "platform",
        price: float = 0.0,
        sandbox_id: str = "",
        budget_state: str = "",
        over_budget_at: datetime | None = None,
    ) -> None:
        with self.store.transaction() as conn:
            conn.execute(
                "INSERT INTO sandboxes "
                "(sandbox_uid, project_id, status, provider, user_id, "
                " billing_mode, quoted_price_usd_per_hour, price_usd_per_hour, "
                " sandbox_id, budget_state, over_budget_at, expires_at, "
                " created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
                "        '2026-08-03T00:00:00Z', '2026-08-03T00:00:00Z')",
                (
                    uid,
                    self.project_id,
                    status,
                    provider,
                    user_id,
                    billing_mode,
                    quoted_price,
                    price,
                    sandbox_id,
                    budget_state,
                    None if over_budget_at is None else _iso(over_budget_at),
                    None if expires_at is None else _iso(expires_at),
                ),
            )

    def _admission(
        self,
        *,
        user_id: str = "user-a",
        price: float | None = 1.0,
        time_limit: int = 3600,
        billing_mode: str = "platform",
        reason: str = "",
    ) -> AdmissionRequest:
        return AdmissionRequest(
            tenant_id="local",
            time_limit_seconds=time_limit,
            price_usd_per_hour=price,
            price_unknown_reason=reason,
            project_id=self.project_id,
            provider="fake",
            user_id=user_id,
            billing_mode=billing_mode,
        )

    def _events(self, *, event_type: str) -> list[dict]:
        with self.store.transaction() as conn:
            rows = conn.execute(
                "SELECT payload_json FROM events WHERE type = ?",
                (event_type,),
            ).fetchall()
        return [json.loads(row["payload_json"]) for row in rows]


@mock.patch("merv.brain.sandbox.quotas.datetime", _FixedDatetime)
class UserCapMathTest(_CapTestBase):
    """QuotaService unit math at a pinned noon-UTC clock."""

    def test_day_spend_clamps_to_utc_midnight(self) -> None:
        self._seed_generation(
            user_id="user-a",
            price=2.0,
            started=NOON - timedelta(hours=14),  # yesterday 22:00
            ended=NOON - timedelta(hours=10),  # today 02:00
        )
        spend = self.quotas.user_provider_day_spend(
            user_id="user-a", provider="fake", now=NOON
        )
        self.assertAlmostEqual(spend, 4.0)  # 2h inside today × $2

    def test_day_spend_ignores_foreign_rows(self) -> None:
        base = dict(price=3.0, started=NOON - timedelta(hours=2), ended=None)
        self._seed_generation(user_id="user-b", **base)
        self._seed_generation(user_id="", **base)  # legacy: never counted
        self._seed_generation(
            user_id="user-a", billing_mode="own", **base
        )
        self.assertEqual(
            self.quotas.user_provider_day_spend(
                user_id="user-a", provider="fake", now=NOON
            ),
            0.0,
        )

    def test_open_generation_bills_through_now(self) -> None:
        self._seed_generation(
            user_id="user-a",
            price=1.5,
            started=NOON - timedelta(hours=2),
            ended=None,
        )
        self.assertAlmostEqual(
            self.quotas.user_provider_day_spend(
                user_id="user-a", provider="fake", now=NOON
            ),
            3.0,
        )

    def test_committed_burn_horizons(self) -> None:
        # Running with future expiry: finite horizon.
        self._seed_sandbox(
            uid="u-run",
            status="running",
            user_id="user-a",
            quoted_price=1.0,
            expires_at=NOON + timedelta(hours=2),
        )
        # Provisioning: boot is unbounded → midnight (12h × $2).
        self._seed_sandbox(
            uid="u-prov",
            status="provisioning",
            user_id="user-a",
            quoted_price=2.0,
        )
        # Unconfirmed deletion: blocks through midnight (12h × $0.5).
        self._seed_sandbox(
            uid="u-clean",
            status="cleanup_pending",
            user_id="user-a",
            quoted_price=0.5,
            expires_at=NOON - timedelta(hours=1),
        )
        with self.store.transaction() as conn:
            burn = self.quotas.user_provider_committed_burn(
                user_id="user-a", provider="fake", conn=conn, now=NOON
            )
        self.assertAlmostEqual(burn, 2.0 + 24.0 + 6.0)

    def test_running_past_expiry_commits_to_midnight(self) -> None:
        self._seed_sandbox(
            uid="u-late",
            status="running",
            user_id="user-a",
            quoted_price=1.0,
            expires_at=NOON - timedelta(minutes=5),  # reaper hasn't landed
        )
        with self.store.transaction() as conn:
            burn = self.quotas.user_provider_committed_burn(
                user_id="user-a", provider="fake", conn=conn, now=NOON
            )
        self.assertAlmostEqual(burn, 12.0)

    def test_unknown_priced_row_commits_everything(self) -> None:
        self._seed_sandbox(
            uid="u-mystery",
            status="running",
            user_id="user-a",
            quoted_price=None,  # and no price_known generation
            expires_at=NOON + timedelta(hours=1),
        )
        with self.store.transaction() as conn:
            burn = self.quotas.user_provider_committed_burn(
                user_id="user-a", provider="fake", conn=conn, now=NOON
            )
        self.assertEqual(burn, float("inf"))

    def test_completed_row_price_needs_price_known(self) -> None:
        # quoted NULL but the open generation vouches for the legacy column.
        self._seed_sandbox(
            uid="u-vouched",
            status="running",
            user_id="user-a",
            quoted_price=None,
            price=1.0,
            expires_at=NOON + timedelta(hours=3),
        )
        self._seed_generation(
            user_id="user-a",
            price=1.0,
            started=NOON - timedelta(hours=1),
            ended=None,
            sandbox_uid="u-vouched",
            price_known=1,
        )
        with self.store.transaction() as conn:
            burn = self.quotas.user_provider_committed_burn(
                user_id="user-a", provider="fake", conn=conn, now=NOON
            )
        self.assertAlmostEqual(burn, 3.0)

    def test_exclude_sandbox_uid_replaces_own_commitment(self) -> None:
        self._seed_sandbox(
            uid="u-self",
            status="provisioning",
            user_id="user-a",
            quoted_price=2.0,
        )
        with self.store.transaction() as conn:
            burn = self.quotas.user_provider_committed_burn(
                user_id="user-a",
                provider="fake",
                conn=conn,
                now=NOON,
                exclude_sandbox_uid="u-self",
            )
        self.assertEqual(burn, 0.0)

    def test_admission_denied_at_cap(self) -> None:
        self._set_cap(limit=5.0)
        self._seed_generation(
            user_id="user-a",
            price=5.0,
            started=NOON - timedelta(hours=1),
            ended=NOON,
        )
        with self.assertRaises(PermissionDeniedError) as ctx:
            self.quotas.check_admission(request=self._admission())
        self.assertEqual(
            ctx.exception.details["quota"], "provider_user_daily_usd_limit"
        )
        self.assertIn("resets_at", ctx.exception.details)

    def test_admission_counts_committed_burn(self) -> None:
        self._set_cap(limit=5.0)
        self._seed_sandbox(
            uid="u-busy",
            status="running",
            user_id="user-a",
            quoted_price=1.0,
            expires_at=NOON + timedelta(hours=4),  # $4 committed
        )
        with self.assertRaises(PermissionDeniedError):
            # $4 committed + $1.5×1h requested ≥ $5.
            self.quotas.check_admission(
                request=self._admission(price=1.5, time_limit=3600)
            )
        # A cheaper lease still fits under the cap.
        self.quotas.check_admission(
            request=self._admission(price=0.5, time_limit=3600)
        )

    def test_admission_requires_price_under_cap(self) -> None:
        self._set_cap(limit=5.0)
        with self.assertRaises(PermissionDeniedError) as ctx:
            self.quotas.check_admission(
                request=self._admission(price=None, reason="no catalog price")
            )
        self.assertEqual(
            ctx.exception.details["quota"], "price_required_by_cost_policy"
        )

    def test_cap_resolution_and_exemptions(self) -> None:
        self._set_cap(limit=0.01)
        # Per-user override beats the strict default.
        self._set_cap(user_id="user-a", limit=100.0)
        self.quotas.check_admission(request=self._admission())
        # NULL override = explicit uncapped.
        self._set_cap(user_id="user-b", limit=None)
        self.quotas.check_admission(request=self._admission(user_id="user-b"))
        # Empty user / non-platform billing skip the check entirely.
        self.quotas.check_admission(request=self._admission(user_id=""))
        self.quotas.check_admission(
            request=self._admission(billing_mode="own")
        )

    def test_extension_charges_payer_of_record(self) -> None:
        self._set_cap(limit=5.0)
        self._seed_sandbox(
            uid="u-ext",
            status="running",
            user_id="user-a",
            quoted_price=1.0,
            expires_at=NOON + timedelta(hours=4),  # $4 committed already
        )
        with self.store.transaction() as conn:
            row = conn.execute(
                "SELECT * FROM sandboxes WHERE sandbox_uid = 'u-ext'"
            ).fetchone()
            row = {key: row[key] for key in row.keys()}
        with self.assertRaises(PermissionDeniedError):
            # 2 added hours × $1 on top of $4 committed ≥ $5.
            self.quotas.check_lifetime_extension(
                tenant_id="local",
                total_time_limit_seconds=6 * 3600,
                price_usd_per_hour=1.0,
                row=row,
                added_seconds=7200,
            )
        # A modest extension still fits.
        self.quotas.check_lifetime_extension(
            tenant_id="local",
            total_time_limit_seconds=4 * 3600 + 600,
            price_usd_per_hour=1.0,
            row=row,
            added_seconds=600,
        )

    def test_final_quote_replaces_own_commitment(self) -> None:
        self._set_cap(limit=5.0)
        self._seed_sandbox(
            uid="u-quote",
            status="provisioning",
            user_id="user-a",
            quoted_price=0.3,  # admitted: 12h to midnight × 0.3 = 3.6 < 5
        )
        with self.store.transaction() as conn:
            # Unchanged quote reproduces the admission result: its own row is
            # excluded and the lease burn stands in (1h × 0.3, not 12h).
            self.quotas.check_final_quote(
                conn=conn,
                sandbox_uid="u-quote",
                tenant_id="local",
                user_id="user-a",
                billing_mode="platform",
                provider="fake",
                time_limit_seconds=3600,
                price=0.3,
            )
            with self.assertRaises(PermissionDeniedError):
                self.quotas.check_final_quote(
                    conn=conn,
                    sandbox_uid="u-quote",
                    tenant_id="local",
                    user_id="user-a",
                    billing_mode="platform",
                    provider="fake",
                    time_limit_seconds=3600,
                    price=6.0,  # re-quote busts the cap
                )
            with self.assertRaises(PermissionDeniedError):
                self.quotas.check_final_quote(
                    conn=conn,
                    sandbox_uid="u-quote",
                    tenant_id="local",
                    user_id="user-a",
                    billing_mode="platform",
                    provider="fake",
                    time_limit_seconds=3600,
                    price=None,  # unknown under a dollar policy
                )

    def test_sequential_admissions_see_prior_reservation(self) -> None:
        self._set_cap(limit=5.0)
        self._seed_sandbox(
            uid="u-first",
            status="provisioning",
            user_id="user-a",
            quoted_price=0.4,  # commits 12h × 0.4 = 4.8 of the $5 cap
        )
        with self.assertRaises(PermissionDeniedError):
            self.quotas.check_admission(
                request=self._admission(price=1.0, time_limit=3600)
            )


@mock.patch("merv.brain.sandbox.quotas.datetime", _FixedDatetime)
class UserCapRequestFlowTest(_CapTestBase):
    """The cap through the real request/extend/on_quote paths."""

    def _request(self, *, user: str = "user-a", **kwargs) -> dict:
        exp = self.app.call_tool(
            "experiment.create",
            {
                "project_id": self.project_id,
                "name": f"exp-{user}-{len(self.backend.acquired)}",
                "intent": "cap coverage",
            },
        )
        return self.app.sandboxes.request(
            project_id=self.project_id,
            experiment_id=exp["id"],
            public_key=DEFAULT_PUBLIC_KEY,
            instance_type="gpu_1x_a10",
            region="us-west-1",
            provisioning_user_id=user,
            **kwargs,
        )

    def test_request_stamps_payer_everywhere(self) -> None:
        self._set_cap(limit=1000.0)
        result = self._request()
        self.assertEqual(result["status"], "running")
        with self.store.transaction() as conn:
            row = conn.execute(
                "SELECT user_id, billing_mode, quoted_price_usd_per_hour "
                "FROM sandboxes WHERE sandbox_uid = ?",
                (result["sandbox_uid"],),
            ).fetchone()
            gen = conn.execute(
                "SELECT user_id, billing_mode, sandbox_uid, price_known, "
                "price_usd_per_hour FROM sandbox_generations "
                "WHERE sandbox_uid = ?",
                (result["sandbox_uid"],),
            ).fetchone()
        self.assertEqual(row["user_id"], "user-a")
        self.assertEqual(row["billing_mode"], "platform")
        self.assertAlmostEqual(row["quoted_price_usd_per_hour"], 0.75)
        self.assertEqual(gen["user_id"], "user-a")
        self.assertEqual(gen["billing_mode"], "platform")
        self.assertEqual(gen["sandbox_uid"], result["sandbox_uid"])
        self.assertEqual(int(gen["price_known"]), 1)
        self.assertAlmostEqual(gen["price_usd_per_hour"], 0.75)

    def test_second_request_denied_by_first_commitment(self) -> None:
        self._set_cap(limit=1.0)
        first = self._request()  # $0.75/hr lease burn < $1 admits
        self.assertEqual(first["status"], "running")
        with self.assertRaises(PermissionDeniedError) as ctx:
            self._request(user="user-a")
        self.assertEqual(
            ctx.exception.details["quota"], "provider_user_daily_usd_limit"
        )
        # A different user is unaffected by user-a's commitment.
        self._set_cap(user_id="user-b", limit=1000.0)
        other = self._request(user="user-b")
        self.assertEqual(other["status"], "running")

    def test_extend_denied_when_cap_exhausted(self) -> None:
        self._set_cap(limit=1000.0)
        result = self._request()
        self.app.sandbox_storage.record_command_snapshot(
            sandbox_uid=result["sandbox_uid"],
            snapshot={"command_id": "cmd", "status": "running"},
            expected_project_id=self.project_id,
        )
        self._set_cap(limit=0.01)  # cap collapses under the running burn
        with self.assertRaises(PermissionDeniedError):
            self.app.sandboxes.extend(
                project_id=self.project_id,
                sandbox_uid=result["sandbox_uid"],
                seconds=1800,
            )
        # Restoring headroom lets the same extension through — the denial was
        # the cap, not the transactional plumbing.
        self._set_cap(limit=1000.0)
        extended = self.app.sandboxes.extend(
            project_id=self.project_id,
            sandbox_uid=result["sandbox_uid"],
            seconds=1800,
        )
        self.assertTrue(extended["extended"])

    def test_unknown_final_quote_fails_closed_pre_launch(self) -> None:
        self._set_cap(limit=50.0)
        self.backend.quote_override = None
        result = self._request()
        self.assertEqual(result["status"], "failed")
        self.assertIn("spend policy", result.get("error", ""))
        # Fail-closed BEFORE launch: no instance was ever created, and no
        # generation is left open.
        self.assertEqual(self.backend.counter, 0)
        with self.store.transaction() as conn:
            open_gens = conn.execute(
                "SELECT COUNT(*) AS n FROM sandbox_generations "
                "WHERE ended_at IS NULL"
            ).fetchone()
        self.assertEqual(int(open_gens["n"]), 0)

    def test_busting_final_quote_aborts_pre_launch(self) -> None:
        self._set_cap(limit=50.0)
        self.backend.quote_override = 200.0  # re-quote explodes past the cap
        result = self._request()
        self.assertEqual(result["status"], "failed")
        self.assertEqual(self.backend.counter, 0)

    def test_lost_reservation_aborts_before_launch(self) -> None:
        # A release/reaper that wins the row between reservation and on_quote
        # makes the quote stamp fail — the worker must abort rather than
        # launch an instance no ledger row can account for.
        self._set_cap(limit=50.0)
        self.app.sandbox_provisioner.revalidate_quote = lambda **kw: False
        result = self._request()
        self.assertNotIn(result["status"], ("running", "provisioning"))
        self.assertEqual(self.backend.counter, 0)
        with self.store.transaction() as conn:
            gens = conn.execute(
                "SELECT COUNT(*) AS n FROM sandbox_generations"
            ).fetchone()
        self.assertEqual(int(gens["n"]), 0)


class BudgetSweepTest(_CapTestBase):
    """The warn → over_budget → grace → terminate ladder."""

    def setUp(self) -> None:
        super().setUp()
        self.enforcer = BudgetEnforcer(
            store=self.store,
            storage=self.app.sandbox_storage,
            quotas=self.quotas,
            lifecycle=self.app.sandbox_lifecycle,
        )

    def _budget_state(self, uid: str) -> tuple[str, str | None]:
        with self.store.transaction() as conn:
            row = conn.execute(
                "SELECT budget_state, over_budget_at FROM sandboxes "
                "WHERE sandbox_uid = ?",
                (uid,),
            ).fetchone()
        return str(row["budget_state"] or ""), row["over_budget_at"]

    def test_warn_at_80_percent_once(self) -> None:
        self._set_cap(limit=10.0)
        self._seed_sandbox(
            uid="u-warm",
            status="running",
            user_id="user-a",
            quoted_price=1.0,
            expires_at=NOON + timedelta(hours=1),
            sandbox_id="sb-warm",
        )
        self._seed_generation(
            user_id="user-a",
            price=1.0,
            started=NOON - timedelta(hours=9),  # $9 of $10 ≥ 80%
            ended=None,
            sandbox_uid="u-warm",
        )
        self.enforcer.enforce(now=NOON)
        self.assertEqual(self._budget_state("u-warm")[0], "warned")
        self.enforcer.enforce(now=NOON)  # idempotent: no event spam
        events = self._events(event_type="sandbox.budget_warning")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["user_id"], "user-a")
        self.assertAlmostEqual(events[0]["limit"], 10.0)

    def test_over_budget_then_grace_then_terminate(self) -> None:
        self._set_cap(limit=5.0)
        self.backend.alive["sb-hot"] = True
        self._seed_sandbox(
            uid="u-hot",
            status="running",
            user_id="user-a",
            quoted_price=1.0,
            expires_at=NOON + timedelta(hours=6),
            sandbox_id="sb-hot",
        )
        self._seed_generation(
            user_id="user-a",
            price=1.0,
            started=NOON - timedelta(hours=6),  # $6 ≥ $5 cap
            ended=None,
            sandbox_uid="u-hot",
        )
        self.enforcer.enforce(now=NOON)
        state, stamped = self._budget_state("u-hot")
        self.assertEqual(state, "over_budget")
        self.assertIsNotNone(stamped)
        self.assertEqual(len(self._events(event_type="sandbox.over_budget")), 1)
        # Inside the 1-hour grace: still running.
        with self.store.transaction() as conn:
            conn.execute(
                "UPDATE sandboxes SET over_budget_at = ? "
                "WHERE sandbox_uid = 'u-hot'",
                (_iso(NOON - timedelta(minutes=30)),),
            )
        self.enforcer.enforce(now=NOON)
        with self.store.transaction() as conn:
            status = conn.execute(
                "SELECT status FROM sandboxes WHERE sandbox_uid = 'u-hot'"
            ).fetchone()["status"]
        self.assertEqual(status, "running")
        # Grace elapsed: terminated through the lifecycle, loudly.
        with self.store.transaction() as conn:
            conn.execute(
                "UPDATE sandboxes SET over_budget_at = ? "
                "WHERE sandbox_uid = 'u-hot'",
                (_iso(NOON - timedelta(hours=2)),),
            )
        self.enforcer.enforce(now=NOON)
        with self.store.transaction() as conn:
            row = conn.execute(
                "SELECT status FROM sandboxes WHERE sandbox_uid = 'u-hot'"
            ).fetchone()
            open_gens = conn.execute(
                "SELECT COUNT(*) AS n FROM sandbox_generations "
                "WHERE sandbox_uid = 'u-hot' AND ended_at IS NULL"
            ).fetchone()
        self.assertEqual(row["status"], "terminated")
        self.assertEqual(int(open_gens["n"]), 0)
        terminated = self._events(event_type="sandbox.budget_terminated")
        self.assertEqual(len(terminated), 1)
        self.assertEqual(terminated[0]["reason"], "budget_exhausted")
        self.assertIn("sb-hot", self.backend.terminated)

    def test_grace_terminates_billable_boot(self) -> None:
        # A provisioning row with a persisted provider ID is billing while a
        # long boot polls (exempt from stale reaping) — grace must reach it.
        self._set_cap(limit=5.0)
        self.backend.alive["sb-boot"] = True
        self._seed_sandbox(
            uid="u-boot",
            status="provisioning",
            user_id="user-a",
            quoted_price=1.0,
            sandbox_id="sb-boot",
            budget_state="over_budget",
            over_budget_at=NOON - timedelta(hours=2),
        )
        self._seed_generation(
            user_id="user-a",
            price=1.0,
            started=NOON - timedelta(hours=6),  # $6 ≥ $5 cap
            ended=None,
            sandbox_uid="u-boot",
        )
        self.enforcer.enforce(now=NOON)
        with self.store.transaction() as conn:
            row = conn.execute(
                "SELECT status FROM sandboxes WHERE sandbox_uid = 'u-boot'"
            ).fetchone()
            open_gens = conn.execute(
                "SELECT COUNT(*) AS n FROM sandbox_generations "
                "WHERE sandbox_uid = 'u-boot' AND ended_at IS NULL"
            ).fetchone()
        self.assertNotIn(row["status"], ("provisioning", "running"))
        self.assertEqual(int(open_gens["n"]), 0)
        self.assertEqual(
            len(self._events(event_type="sandbox.budget_terminated")), 1
        )
        self.assertIn("sb-boot", self.backend.terminated)

    def test_midnight_rollover_self_heals(self) -> None:
        self._set_cap(limit=5.0)
        self._seed_sandbox(
            uid="u-heal",
            status="running",
            user_id="user-a",
            quoted_price=1.0,
            expires_at=NOON + timedelta(days=1),
            sandbox_id="sb-heal",
            budget_state="over_budget",
            over_budget_at=NOON - timedelta(minutes=10),
        )
        self._seed_generation(
            user_id="user-a",
            price=1.0,
            started=NOON - timedelta(hours=6),
            ended=NOON,  # closed: nothing accrues tomorrow
            sandbox_uid="u-heal",
        )
        next_day = NOON + timedelta(hours=13)  # 01:00 next UTC day
        self.enforcer.enforce(now=next_day)
        self.assertEqual(self._budget_state("u-heal")[0], "")

    def test_unpriced_active_row_is_exhausted(self) -> None:
        self._set_cap(limit=5.0)
        self._seed_sandbox(
            uid="u-dark",
            status="running",
            user_id="user-a",
            quoted_price=None,  # no validated quote, no vouched generation
            expires_at=NOON + timedelta(hours=1),
            sandbox_id="sb-dark",
        )
        self.enforcer.enforce(now=NOON)
        self.assertEqual(self._budget_state("u-dark")[0], "over_budget")

    def test_unpriced_row_escalates_alone_under_the_cap(self) -> None:
        # One unpriced row must not put priced, far-under-cap siblings on the
        # termination ladder: admission is already halted fleet-wide by the
        # inf commitment, and reaping them would destroy real work.
        self._set_cap(limit=50.0)
        self.backend.alive["sb-priced"] = True
        self.backend.alive["sb-dark"] = True
        self._seed_sandbox(
            uid="u-priced",
            status="running",
            user_id="user-a",
            quoted_price=1.0,
            expires_at=NOON + timedelta(hours=1),
            sandbox_id="sb-priced",
        )
        self._seed_generation(
            user_id="user-a",
            price=1.0,
            started=NOON - timedelta(minutes=18),  # $0.30 of $50
            ended=None,
            sandbox_uid="u-priced",
        )
        self._seed_sandbox(
            uid="u-dark",
            status="running",
            user_id="user-a",
            quoted_price=None,
            expires_at=NOON + timedelta(hours=1),
            sandbox_id="sb-dark",
        )
        self.enforcer.enforce(now=NOON)
        self.assertEqual(self._budget_state("u-dark")[0], "over_budget")
        self.assertEqual(self._budget_state("u-priced")[0], "")
        # Past grace, only the unpriced row is terminated.
        with self.store.transaction() as conn:
            conn.execute(
                "UPDATE sandboxes SET over_budget_at = ? "
                "WHERE sandbox_uid = 'u-dark'",
                (_iso(NOON - timedelta(hours=2)),),
            )
        self.enforcer.enforce(now=NOON)
        with self.store.transaction() as conn:
            statuses = {
                row["sandbox_uid"]: row["status"]
                for row in conn.execute(
                    "SELECT sandbox_uid, status FROM sandboxes "
                    "WHERE sandbox_uid IN ('u-dark', 'u-priced')"
                ).fetchall()
            }
        self.assertEqual(statuses["u-dark"], "terminated")
        self.assertEqual(statuses["u-priced"], "running")
        self.assertNotIn("sb-priced", self.backend.terminated)

    def test_exhausted_cap_still_escalates_the_whole_group(self) -> None:
        # Genuine cap exhaustion keeps the fleet-wide ladder, priced or not.
        self._set_cap(limit=5.0)
        self._seed_sandbox(
            uid="u-one",
            status="running",
            user_id="user-a",
            quoted_price=1.0,
            expires_at=NOON + timedelta(hours=1),
            sandbox_id="sb-one",
        )
        self._seed_sandbox(
            uid="u-two",
            status="running",
            user_id="user-a",
            quoted_price=1.0,
            expires_at=NOON + timedelta(hours=1),
            sandbox_id="sb-two",
        )
        self._seed_generation(
            user_id="user-a",
            price=1.0,
            started=NOON - timedelta(hours=6),  # $6 ≥ $5 cap
            ended=None,
            sandbox_uid="u-one",
        )
        self.enforcer.enforce(now=NOON)
        self.assertEqual(self._budget_state("u-one")[0], "over_budget")
        self.assertEqual(self._budget_state("u-two")[0], "over_budget")

    def test_completion_without_a_price_keeps_the_admission_stamp(self) -> None:
        # An adapter that loses its quote at provision time must not degrade
        # the admission-validated stamp to NULL (unpriced would halt the
        # payer's fleet) — nor to a "known" $0.
        self._seed_sandbox(
            uid="u-stamp",
            status="provisioning",
            user_id="user-a",
            quoted_price=2.5,
        )
        generation_id = self.app.sandbox_storage.complete_provision(
            experiment_id="exp_seed",
            sandbox_uid="u-stamp",
            project_id=self.project_id,
            provisioned=ProvisionedSandbox(
                sandbox_id="sb-stamp",
                ssh_host="h.example",
                ssh_port=22,
                ssh_user="root",
                workdir="/w",
                volume_name="",
                price_usd_per_hour=None,
            ),
            request=SandboxRequest(
                experiment_id="exp_seed",
                project_id=self.project_id,
                public_key=DEFAULT_PUBLIC_KEY,
            ),
            provider="fake",
        )
        self.assertIsNotNone(generation_id)
        with self.store.transaction() as conn:
            row = conn.execute(
                "SELECT quoted_price_usd_per_hour, price_usd_per_hour "
                "FROM sandboxes WHERE sandbox_uid = 'u-stamp'"
            ).fetchone()
            gen = conn.execute(
                "SELECT price_usd_per_hour, price_known FROM sandbox_generations "
                "WHERE sandbox_uid = 'u-stamp'"
            ).fetchone()
        self.assertAlmostEqual(float(row["quoted_price_usd_per_hour"]), 2.5)
        self.assertAlmostEqual(float(row["price_usd_per_hour"]), 2.5)
        self.assertAlmostEqual(float(gen["price_usd_per_hour"]), 2.5)
        self.assertEqual(int(gen["price_known"]), 1)

    def test_completion_with_no_price_anywhere_stays_unknown(self) -> None:
        # No adapter quote and no admission stamp: the floor 0 is recorded
        # with price_known=0 so the exhausted sentinel still fires.
        self._seed_sandbox(
            uid="u-dark-boot",
            status="provisioning",
            user_id="user-a",
            quoted_price=None,
        )
        self.app.sandbox_storage.complete_provision(
            experiment_id="exp_seed",
            sandbox_uid="u-dark-boot",
            project_id=self.project_id,
            provisioned=ProvisionedSandbox(
                sandbox_id="sb-dark-boot",
                ssh_host="h.example",
                ssh_port=22,
                ssh_user="root",
                workdir="/w",
                volume_name="",
                price_usd_per_hour=None,
            ),
            request=SandboxRequest(
                experiment_id="exp_seed",
                project_id=self.project_id,
                public_key=DEFAULT_PUBLIC_KEY,
            ),
            provider="fake",
        )
        with self.store.transaction() as conn:
            row = conn.execute(
                "SELECT quoted_price_usd_per_hour FROM sandboxes "
                "WHERE sandbox_uid = 'u-dark-boot'"
            ).fetchone()
            gen = conn.execute(
                "SELECT price_known FROM sandbox_generations "
                "WHERE sandbox_uid = 'u-dark-boot'"
            ).fetchone()
        self.assertIsNone(row["quoted_price_usd_per_hour"])
        self.assertEqual(int(gen["price_known"]), 0)

    def test_no_cap_no_states(self) -> None:
        self._seed_sandbox(
            uid="u-free",
            status="running",
            user_id="user-a",
            quoted_price=1.0,
            expires_at=NOON + timedelta(hours=1),
            sandbox_id="sb-free",
            budget_state="warned",
        )
        self.enforcer.enforce(now=NOON)  # cap removed → halt lifts
        self.assertEqual(self._budget_state("u-free")[0], "")


class BudgetViewTest(_CapTestBase):
    def test_options_carries_budget_for_capped_payer(self) -> None:
        self._set_cap(limit=50.0)
        view = self.app.sandboxes.options(requesting_user_id="user-a")
        self.assertIn("budget", view)
        self.assertEqual(view["budget"]["provider"], "fake")
        self.assertAlmostEqual(view["budget"]["daily_cap_usd"], 50.0)
        self.assertAlmostEqual(view["budget"]["remaining_today_usd"], 50.0)

    def test_options_stays_clean_without_cap_or_user(self) -> None:
        self.assertNotIn("budget", self.app.sandboxes.options())
        self.assertNotIn(
            "budget", self.app.sandboxes.options(requesting_user_id="user-a")
        )


if __name__ == "__main__":
    unittest.main()
