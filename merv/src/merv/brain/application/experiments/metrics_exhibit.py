# If you update this file, you must consult application.md to see whether application.md needs to be updated. application.md must not exceed 100 lines.
"""Pure construction of a system-authored metrics exhibit.

The exhibit is the observation-not-attestation record of a quantitative
attempt: the eligible pinned result-file sources of the current attempt, each
with provenance.  Callers supply plain data, so preview and final pinning use
identical construction.
"""

from __future__ import annotations

import json
from typing import Any

METRICS_EXHIBIT_KIND = "metrics_exhibit"
METRICS_EXHIBIT_FILENAME = "metrics_exhibit.json"


def build_metrics_exhibit(
    *,
    project_id: str,
    experiment_id: str,
    attempt_index: int,
    window_started_at: str | None,
    file_sources: list[dict[str, Any]],
) -> dict[str, Any]:
    """Build a deterministic exhibit document from supplied observations."""
    files = [
        {
            "path": source.get("path") or "",
            "data": source.get("data"),
            "source": {
                "type": "result_file",
                "path": source.get("path") or "",
                "artifact_id": source.get("artifact_id") or "",
                "sha256": source.get("sha256") or "",
                "submitted_at": source.get("submitted_at") or "",
            },
        }
        for source in file_sources
    ]
    return {
        "kind": METRICS_EXHIBIT_KIND,
        "project_id": project_id,
        "experiment_id": experiment_id,
        "attempt_index": int(attempt_index),
        # The generation instant lives out-of-band so identical inputs remain
        # byte-identical between preview and final pinning.
        "window": {"started_at": window_started_at or ""},
        "result_files": files,
        "verdict": {"result_files": len(files)},
    }


def exhibit_bytes(exhibit: dict[str, Any]) -> bytes:
    """Canonical, reproducible bytes used for pinning."""
    return (json.dumps(exhibit, indent=2, sort_keys=True) + "\n").encode("utf-8")


__all__ = [
    "METRICS_EXHIBIT_FILENAME",
    "METRICS_EXHIBIT_KIND",
    "build_metrics_exhibit",
    "exhibit_bytes",
]
