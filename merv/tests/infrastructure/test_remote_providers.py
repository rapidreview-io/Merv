from __future__ import annotations

import copy
import tempfile
import unittest
from pathlib import Path

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

    def test_overview_reads_native_instances_without_editable_policy(self):
        result = self.providers.overview(project_id="p1")
        self.assertEqual([row["provider"] for row in result["providers"]], ["lambda"])
        self.assertEqual(self.client.calls, [("GET", "/providers", "p1", None)])
        self.assertNotIn("daily_usd_limit", result["providers"][0])
        self.assertNotIn("fields", result["providers"][0])

    def test_project_connections_stay_isolated(self):
        self.client.own["p1"] = {"own": {"name": "own", "plugin": "lambda", "source": "user", "health": {"status": "ok"}}}
        self.assertEqual(set(self.entries("p1")), {"lambda", "own"})
        self.assertEqual(set(self.entries("p2")), {"lambda"})

    def test_disconnected_client_does_not_invent_provider_settings(self):
        result = RemoteProviders(client=None, store=self.store).overview(project_id="p1")
        self.assertFalse(result["configured"])
        self.assertEqual(result["providers"], [])


if __name__ == "__main__":
    unittest.main()
