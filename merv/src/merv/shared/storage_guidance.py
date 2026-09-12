"""Agent-facing guidance for durable heavy-file storage."""

from __future__ import annotations

GIB = 1024 * 1024 * 1024
DEFAULT_STORAGE_MAX_UPLOAD_BYTES = 50 * GIB

STORAGE_RULE_OF_THUMB = (
    "Use storage for files that are too large or noisy for the repo or "
    "artifact submission, or expensive to regenerate: checkpoints/models, "
    "precious datasets, dataset shards, parquet/archive outputs, generated "
    "caches that must survive, and logs/traces over about 10 MB."
)
