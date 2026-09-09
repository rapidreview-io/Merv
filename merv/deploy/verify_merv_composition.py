#!/usr/bin/env python3
"""Check the release image with hosted auth and disposable synthetic records.

The real production DB URL is removed from this process before any Merv import.
Only configured native service health/auth is read. No socket is exposed.
A synthetic project and key exist only in the temporary SQLite database.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
import tempfile

def verify_composition() -> None:
    # Explicitly clear both names before importing application composition.
    # No Merv helper in this process can accidentally resolve production DB.
    os.environ["MERV_DB_URL"] = ""
    os.environ["RESEARCH_PLUGIN_DB_URL"] = ""
    from verify_sandboxes_cutover import emit, require
    from fastapi.testclient import TestClient
    from merv.brain.kernel.state.store import MIGRATIONS, StateStore
    from merv.brain.kernel.version import SERVER_VERSION
    from merv.brain.surface.project_keys import ProjectKeys
    from merv.brain.surface.surface import build_control_server

    with tempfile.TemporaryDirectory(prefix="merv-composition-") as temporary:
        server = build_control_server(repo_root=Path(temporary), env=dict(os.environ))
        try:
            require(isinstance(server.app._store, StateStore), "synthetic composition did not select SQLite")
            require(server.app._store.db_path.is_relative_to(Path(temporary)), "synthetic SQLite escaped temporary state")
            with server.app._store.connect() as connection:
                require(connection.execute("SELECT max(version) FROM schema_migrations").fetchone()[0] == MIGRATIONS[-1][0], "synthetic schema initialization failed")
            project = server.app.research.create_project(name="Temporary composition smoke", user_id="smoke-user")
            key = ProjectKeys(store=server.app._store).create(project_id=project["id"], owner_user_id="smoke-user")["secret"]
            with TestClient(server.fastapi_app, raise_server_exceptions=False) as browser:
                health = browser.get("/health")
                require(health.status_code == 200 and health.json()["ok"], "synthetic hosted health failed")
                meta = browser.get("/api/meta")
                require(meta.status_code == 200, "synthetic metadata route failed")
                value = meta.json()
                require(value["server_version"] == SERVER_VERSION == "0.0015", "unexpected release version")
                require(value["mode"] == "control" and value["capabilities"]["hosted_control"], "hosted composition policy missing")
                require(value["capabilities"]["storage"], "native storage capability missing")
                require(browser.get("/api/projects").status_code in {401, 403}, "hosted research route accepted an unauthenticated request")
                require(browser.get("/api/projects", headers={"Authorization": "Bearer invalid-smoke-token"}).status_code in {401, 403}, "hosted research route accepted an invalid credential")
                listed = browser.get("/api/projects", headers={"Authorization": "Bearer " + key})
                require(listed.status_code == 200 and [row["id"] for row in listed.json()["projects"]] == [project["id"]], "synthetic project key failed owner-scoped authentication")
                initialized = browser.post("/mcp", headers={"Authorization": "Bearer " + key,
                    "Accept": "application/json, text/event-stream"}, json={"jsonrpc": "2.0", "id": 1,
                    "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                    "clientInfo": {"name": "cutover-smoke", "version": "1"}}})
                require(initialized.status_code == 200, "synthetic MCP credential failed initialization")
                require(initialized.json()["result"]["serverInfo"]["version"] == SERVER_VERSION, "MCP returned the wrong release version")
            client = server.app.infrastructure_client
            require(client is not None and client.health()["ok"], "native service health failed")
            identity = client.request("GET", "/auth/me", namespace="merv-control")
            require(identity["namespace"] == "merv-control" and identity["token_id"].startswith("svc_"), "native delegated JWT failed")
            emit("synthetic_hosted_composition", ok=True, version=SERVER_VERSION, database="temporary_sqlite",
                 auth_enforced=True, synthetic_mcp_credential_verified=True, native_health=True, delegated_auth=True)
        finally:
            server.shutdown()


def main() -> int:
    os.environ["MERV_DB_URL"] = ""
    os.environ["RESEARCH_PLUGIN_DB_URL"] = ""
    from verify_sandboxes_cutover import emit, safe_failure
    logging.disable(logging.CRITICAL)
    try:
        verify_composition()
        return 0
    except Exception as exc:
        emit("failed", ok=False, **safe_failure(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
