from __future__ import annotations

import tempfile
import unittest
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from merv.brain.infrastructure.budget import daily_budget
from merv.brain.infrastructure.providers import RemoteProviders
from merv.brain.kernel.state import StateStore
from merv.brain.kernel.utils import ValidationError


class PolicyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = StateStore(db_path=Path(self.tmp.name) / "state.db")
        self.now = datetime(2026, 9, 8, 12, tzinfo=UTC)
        with self.store.transaction() as conn:
            for pid in ("p1", "p2"):
                conn.execute("INSERT INTO projects (id,name,tenant_id,created_at) VALUES (?,?,?,?)",
                             (pid, pid, "team1", "2026-09-08T00:00:00Z"))

    def tearDown(self):
        self.tmp.cleanup()

    def budget(self, **kwargs):
        return daily_budget(store=self.store, project_id="p1", provider="lambda", payer_id="user1",
                            billing_mode="platform", now=self.now, **kwargs)

    def test_default_platform_user_cap_uses_legacy_provider_alias(self):
        self.assertEqual(Decimal(self.budget()["provider_daily_usd_limit"]), Decimal(50))
        self.assertEqual(self.budget()["provider"], "lambda")
        self.assertEqual(self.budget()["source_day"], "2026-09-08")

    def test_platform_identity_is_required_and_own_key_avoids_platform_allowance(self):
        with self.assertRaises(ValidationError, msg="platform cannot silently lose its payer"):
            daily_budget(store=self.store, project_id="p1", provider="lambda", payer_id="",
                         billing_mode="platform", now=self.now)
        own = daily_budget(store=self.store, project_id="p1", provider="lambda", payer_id="user1",
                           billing_mode="own", now=self.now)
        self.assertIsNone(own["provider_daily_usd_limit"])
        self.assertEqual(own["billing_mode"], "own")

    def test_user_override_and_explicit_uncapped_override_are_preserved(self):
        with self.store.transaction() as conn:
            conn.execute("INSERT INTO provider_user_caps (provider,user_id,daily_usd_limit,updated_at) VALUES (?,?,?,?)",
                         ("lambda_labs", "user1", 12.5, self.now.isoformat()))
        self.assertEqual(Decimal(self.budget()["provider_daily_usd_limit"]), Decimal("12.5"))
        with self.store.transaction() as conn:
            conn.execute("UPDATE provider_user_caps SET daily_usd_limit = NULL WHERE provider = ? AND user_id = ?",
                         ("lambda_labs", "user1"))
        self.assertIsNone(self.budget()["provider_daily_usd_limit"])

    def test_project_cap_applies_to_own_and_platform_credentials(self):
        self.store.set_sandbox_provider_daily_limit(project_id="p1", provider="lambda_labs", daily_usd_limit=140)
        self.assertEqual(Decimal(self.budget()["project_daily_usd_limit"]), Decimal(140))
        own = daily_budget(store=self.store, project_id="p1", provider="lambda", payer_id="user1",
                           billing_mode="own", now=self.now)
        self.assertEqual(Decimal(own["project_daily_usd_limit"]), Decimal(140))

    def test_disabled_provider_and_operator_halt_fail_closed(self):
        self.store.upsert_sandbox_provider_settings(project_id="p1", provider="lambda_labs", enabled=False)
        with self.assertRaises(ValidationError, msg="disabled provider must stay disabled"):
            self.budget()
        self.store.upsert_sandbox_provider_settings(project_id="p1", provider="lambda_labs", enabled=True)
        for scope in ("global", "team1"):
            with self.store.transaction() as conn:
                conn.execute("DELETE FROM spend_kill_switches")
                conn.execute("INSERT INTO spend_kill_switches (scope,tripped) VALUES (?,1)", (scope,))
            with self.assertRaises(ValidationError, msg="operator halt must remain effective"):
                self.budget()

    def test_legacy_spend_clips_midnight_and_separates_project_and_shared_user_costs(self):
        rows = [
            ("cross_midnight", "p1", "user1", "platform", "2026-09-07T23:00:00Z", "2026-09-08T01:00:00Z", 2),
            ("other_project", "p2", "user1", "platform", "2026-09-08T01:00:00Z", "2026-09-08T02:00:00Z", 3),
            ("own", "p1", "user1", "own", "2026-09-08T03:00:00Z", "2026-09-08T04:00:00Z", 5),
            ("other_user", "p1", "user2", "platform", "2026-09-08T05:00:00Z", "2026-09-08T06:00:00Z", 7),
            ("yesterday", "p1", "user1", "platform", "2026-09-07T10:00:00Z", "2026-09-07T11:00:00Z", 99),
        ]
        with self.store.transaction() as conn:
            for gid, pid, uid, mode, start, end, price in rows:
                conn.execute("INSERT INTO sandbox_generations (id,project_id,experiment_id,provider,user_id,billing_mode,started_at,ended_at,price_usd_per_hour) VALUES (?,?,?,?,?,?,?,?,?)",
                             (gid, pid, "e1", "lambda_labs", uid, mode, start, end, price))
        claim = self.budget()
        self.assertEqual(Decimal(claim["legacy_user_spend_usd_today"]), Decimal(5))
        self.assertEqual(Decimal(claim["legacy_project_spend_usd_today"]), Decimal(14))

    def test_provider_overview_and_writes_share_the_native_plugin_policy(self):
        class Transport:
            def request(self, method, path, **kwargs):
                return {"providers": [{"name": "lambda-shared", "plugin": "lambda", "source": "host", "health": {"status": "ok"}}],
                        "plugins": [{"name": "lambda", "credential_fields": []}]}

        providers = RemoteProviders(client=Transport(), store=self.store)
        saved = providers.set_daily_limit(project_id="p1", provider="lambda-shared", daily_usd_limit=35)
        self.assertEqual(saved["daily_usd_limit"], 35)
        self.assertEqual(saved["credential_source"], "platform")
        self.assertEqual(Decimal(self.budget()["project_daily_usd_limit"]), Decimal(35))
        with self.assertRaises(ValidationError):
            providers.set_daily_limit(project_id="p1", provider="lambda-shared", daily_usd_limit=float("nan"))
        providers.set_enabled(project_id="p1", provider="lambda-shared", enabled=False)
        with self.assertRaises(ValidationError):
            self.budget()


if __name__ == "__main__":
    unittest.main()
