#!/usr/bin/env python3
"""Carry the retired ``storage_objects`` ledger into Research's ``research_objects``.

Object storage now lives in merv-sandboxes (the catalog: names, versions,
state, retention, bytes). Merv keeps only the research association of an
object to the experiment that produced it, plus the submitter's kind, run,
source and notes, and a metadata snapshot captured from the service.

For every active ledger row (``status = 'available'``) this script:

1. looks the object up in merv-sandboxes by SHA-256 — legacy uploads were
   registered in the project's namespace under ``name = <sha256>`` — taking
   the available object whose ``sha256`` matches;
2. writes the association (``target_type='experiment'`` when the ledger row
   named a producing experiment that still exists in the project, otherwise
   untargeted) with the SERVICE object's metadata as the snapshot; and
3. reports ledger rows with no matching available service object, and rows
   whose producing experiment no longer exists (adopted untargeted).

What cannot be carried over — merv-sandboxes has no rename:

* Merv display names and per-name versions. The service object keeps the
  name ``<sha256>`` and the version the service assigned. ``storage.find``
  by the old Merv name will not resolve historical objects; find them by
  object id (reported here) or through the producing experiment's
  ``storage_objects``.
* Merv-side expiry, pin state and ``last_accessed_at``. Retention is the
  service's own (legacy imports were adopted pinned).
* Rows that were ``uploading``/``completing``/``expired``/``deleted`` at cutover.

Idempotent: an existing association is left untouched and counted as skipped.
``--dry-run`` reports the mapping without writing.

Usage (inside the control image, with the production environment):

    MERV_DB_URL=postgresql://... \\
    MERV_SANDBOXES_URL=https://... MERV_SANDBOXES_CONNECTIONS_FILE=/etc/merv/connections.json \\
    python deploy/migrate_storage_ledger.py [--dry-run] [--project proj_x] [--sqlite path/to/state.sqlite]

Take a database backup first. Do not run this script until the release that
retires the ledger (migration 62) is deployed.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from contextlib import closing
from pathlib import Path
from typing import Any

from merv.brain.infrastructure.client import build_infrastructure_client
from merv.brain.infrastructure.objects import present
from merv.brain.infrastructure.ports import project_namespace
from merv.brain.research_core import ResearchObjects
from merv.brain.surface.config import build_state_store
from merv.shared.errors import ResearchPluginError

_PAGE = 1000


def ledger_rows(store: Any, *, project_id: str | None) -> list[dict[str, Any]]:
    where = "status = 'available'" + (" AND project_id = ?" if project_id else "")
    params: tuple[Any, ...] = (project_id,) if project_id else ()
    with closing(store.connect()) as conn:
        rows = conn.execute(
            f"""
            SELECT id, project_id, name, version, kind, content_sha256, size_bytes,
                   content_type, producing_experiment_id, producing_run, source_uri,
                   notes, created_at
            FROM storage_objects WHERE {where}
            ORDER BY project_id, created_seq, id
            """,
            params,
        ).fetchall()
        return [dict(row) for row in rows]


def experiment_exists(store: Any, *, project_id: str, experiment_id: str) -> bool:
    with closing(store.connect()) as conn:
        row = conn.execute(
            "SELECT 1 FROM experiments WHERE id = ? AND project_id = ?",
            (experiment_id, project_id),
        ).fetchone()
    return row is not None


def service_object(client: Any, *, project_id: str, sha256: str) -> dict[str, Any] | None:
    """The available service object registered under the legacy sha256 name."""
    namespace = project_namespace(project_id)
    offset = 0
    while True:
        page = client.request(
            "GET", "/storage/objects", namespace=namespace,
            params={"name": sha256, "limit": _PAGE, "offset": offset},
        )["objects"]
        matches = [row for row in page if row["sha256"] == sha256 and row["state"] == "available"]
        if matches:
            # Several ledger rows could share one content object; the oldest
            # service version is the one the cutover import created.
            return min(matches, key=lambda row: int(row["version"]))
        if len(page) < _PAGE:
            return None
        offset += len(page)


def migrate(*, store: Any, client: Any, project_id: str | None, dry_run: bool) -> dict[str, Any]:
    research = ResearchObjects(store=store)
    report: dict[str, Any] = {
        "dry_run": dry_run, "adopted": 0, "skipped_existing": 0,
        "unmatched": [], "untargeted_missing_experiment": [], "mapping": [],
    }
    for row in ledger_rows(store, project_id=project_id):
        try:
            found = service_object(client, project_id=row["project_id"], sha256=row["content_sha256"])
        except ResearchPluginError as exc:
            report["unmatched"].append({
                "id": row["id"], "project_id": row["project_id"], "sha256": row["content_sha256"],
                "reason": f"{exc.error_code}: {exc.message}",
            })
            continue
        if found is None:
            report["unmatched"].append({
                "id": row["id"], "project_id": row["project_id"], "sha256": row["content_sha256"],
                "reason": "no available service object with this sha256",
            })
            continue
        target_id = str(row["producing_experiment_id"] or "")
        if target_id and not experiment_exists(store, project_id=row["project_id"], experiment_id=target_id):
            report["untargeted_missing_experiment"].append({"id": row["id"], "experiment_id": target_id})
            target_id = ""
        entry = present(found, project_id=row["project_id"])
        report["mapping"].append({
            "ledger_id": row["id"], "object_id": entry["id"], "project_id": row["project_id"],
            "merv_name": row["name"], "merv_version": row["version"],
            "service_name": entry["name"], "service_version": entry["version"],
            "experiment_id": target_id,
        })
        if dry_run:
            continue
        adopted = research.adopt(
            project_id=row["project_id"], object_id=entry["id"], kind=str(row["kind"]),
            target_type="experiment" if target_id else "", target_id=target_id,
            producing_run=str(row["producing_run"] or ""), source_uri=str(row["source_uri"] or ""),
            notes=str(row["notes"] or ""), snapshot=entry, created_at=str(entry["created_at"] or row["created_at"]),
        )
        report["adopted" if adopted else "skipped_existing"] += 1
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="report the mapping without writing associations")
    parser.add_argument("--project", default=None, help="migrate one project only")
    parser.add_argument("--sqlite", default=None, help="SQLite state file for local brains (default: MERV_DB_URL)")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    env = dict(os.environ)
    if args.sqlite:
        env.pop("MERV_DB_URL", None)
    elif not env.get("MERV_DB_URL"):
        print("MERV_DB_URL (or --sqlite) is required", file=sys.stderr)
        return 2
    client = build_infrastructure_client(env)
    if client is None:
        print("MERV_SANDBOXES_URL and MERV_SANDBOXES_CONNECTIONS_FILE are required", file=sys.stderr)
        return 2
    store = build_state_store(db_path=Path(args.sqlite or "unused.sqlite"), env=env)
    try:
        report = migrate(store=store, client=client, project_id=args.project, dry_run=args.dry_run)
    finally:
        client.close()
    print(json.dumps(report, indent=2, sort_keys=True))
    return 1 if report["unmatched"] else 0


if __name__ == "__main__":
    sys.exit(main())
