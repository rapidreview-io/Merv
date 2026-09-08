from __future__ import annotations

import copy
import tempfile
import unittest
from pathlib import Path

from merv.brain.infrastructure.budget import daily_budget
from merv.brain.infrastructure.providers import RemoteProviders
from merv.brain.kernel.state import StateStore
from merv.brain.kernel.utils import ValidationError


class ProviderClient:
    def __init__(self):
        self.calls = []
        self.own = {}
        self.host = {"name": "lambda", "plugin": "lambda", "source": "host",
                     "health": {"status": "ok"}}

    def request(self, method, path, *, namespace, json=None, **kwargs):
        self.calls.append((method, path, namespace, copy.deepcopy(json)))
        own = self.own.setdefault(namespace, {})
        if method == "GET" and path == "/providers":
            return {"providers": [copy.deepcopy(self.host), *copy.deepcopy(list(own.values()))],
                    "plugins": [{"name": "lambda", "credential_fields": [
                        {"name": "api_key", "required": True, "secret": True}]}]}
        name = path.removeprefix("/providers/")
        if name == "lambda":
            raise AssertionError("native host provider names cannot be shadowed or disconnected")
        if method == "PUT":
            own[name] = {"name": name, "plugin": json["plugin"], "source": "namespace",
                         "health": {"status": "ok"}, "verified_at": "2026-09-08T00:00:00Z"}
            return copy.deepcopy(own[name])
        if method == "DELETE":
            own.pop(name)
            return {}
        raise AssertionError((method, path))


class RemoteProvidersTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = StateStore(db_path=Path(self.tmp.name) / "test.db")
        with self.store.transaction() as conn:
            for pid in ("p1", "p2"):
                conn.execute("INSERT INTO projects (id,name,created_at) VALUES (?,?,?)",
                             (pid, pid, "2026-09-08T00:00:00Z"))
        self.client = ProviderClient()
        self.providers = RemoteProviders(client=self.client, store=self.store)

    def entries(self, project_id="p1"):
        return {row["provider"]: row for row in self.providers.overview(project_id=project_id)["providers"]}

    def test_personal_lambda_connect_and_disconnect_preserve_host_and_project_scope(self):
        entries = self.entries()
        self.assertFalse(entries["lambda"]["can_edit_connection"])
        self.assertFalse(entries["lambda"]["can_disconnect"])
        self.assertEqual(entries["lambda"]["credential_mode"], "platform")
        self.assertFalse(entries["lambda-own"]["setup_complete"])
        self.assertEqual(entries["lambda-own"]["credential_mode"], "own")
        self.assertFalse(entries["lambda-own"]["platform_available"])
        self.assertEqual(entries["lambda-own"]["fields"][0]["key"], "api_key")

        with self.assertRaises(ValidationError):
            self.providers.set_credentials(project_id="p1", provider="lambda", mode="own",
                                           values={"api_key": "personal-secret"})
        with self.assertRaises(ValidationError):
            self.providers.disconnect(project_id="p1", provider="lambda")
        connected = self.providers.set_credentials(project_id="p1", provider="lambda-own", mode="own",
                                                    values={"api_key": "personal-secret"})
        self.assertTrue(connected["setup_complete"])
        self.assertTrue(connected["can_edit_connection"])
        self.assertTrue(connected["can_disconnect"])
        self.assertEqual([call for call in self.client.calls if call[0] == "PUT"], [
            ("PUT", "/providers/lambda-own", "merv-project-p1",
             {"plugin": "lambda", "fields": {"api_key": "personal-secret"}})])
        self.assertTrue(self.entries()["lambda"]["setup_complete"])
        self.assertFalse(self.entries("p2")["lambda-own"]["setup_complete"])
        self.assertNotIn("personal-secret", str(self.entries()))

        self.providers.disconnect(project_id="p1", provider="lambda-own")
        self.assertFalse(self.entries()["lambda-own"]["setup_complete"])
        self.assertTrue(self.entries()["lambda"]["setup_complete"])

    def test_shared_and_personal_connections_use_the_same_saved_lambda_policy(self):
        self.providers.set_credentials(project_id="p1", provider="lambda-own", mode="own",
                                       values={"api_key": "personal-secret"})
        self.providers.set_daily_limit(project_id="p1", provider="lambda-own", daily_usd_limit=17)
        self.assertEqual({row["daily_usd_limit"] for row in self.entries().values()}, {17})
        for mode in ("own", "platform"):
            budget = daily_budget(store=self.store, project_id="p1", provider="lambda",
                                  payer_id="user1", billing_mode=mode)
            self.assertEqual(float(budget["project_daily_usd_limit"]), 17)
            if mode == "own":
                self.assertIsNone(budget["provider_daily_usd_limit"])
        self.providers.set_enabled(project_id="p1", provider="lambda", enabled=False)
        self.assertFalse(any(row["enabled"] for row in self.entries().values()))
        self.providers.set_enabled(project_id="p1", provider="lambda-own", enabled=True)
        self.assertTrue(all(row["enabled"] for row in self.entries().values()))
        with self.store.connect() as conn:
            rows = conn.execute("SELECT provider,credentials FROM sandbox_provider_settings").fetchall()
            self.assertEqual([(row["provider"], row["credentials"]) for row in rows], [("lambda_labs", "{}")])

    def test_existing_personal_alias_does_not_create_an_extra_setup_slot(self):
        self.client.own["merv-project-p1"] = {
            "team-lambda": {"name": "team-lambda", "plugin": "lambda", "source": "namespace",
                            "health": {"status": "ok"}}}
        self.assertEqual(set(self.entries()), {"lambda", "team-lambda"})
        self.assertTrue(self.entries()["team-lambda"]["can_edit_connection"])


if __name__ == "__main__":
    unittest.main()
