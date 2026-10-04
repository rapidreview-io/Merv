"""Agent-facing guidance for durable heavy-file storage."""

from __future__ import annotations

GIB = 1024 * 1024 * 1024
DEFAULT_STORAGE_MAX_UPLOAD_BYTES = 50 * GIB

STORAGE_RULE_OF_THUMB = (
    "Storage is for files too large, noisy or costly to regenerate for the repo or "
    "artifacts: checkpoints/models, datasets and shards, parquet/archive outputs, "
    "caches that must survive, logs/traces over about 10 MB."
)
