"""Durable tool-call payload records: what one agent sent and what it got back.

The ``tool_calls`` table stays sizes-and-digests by design (audit §15.2); the
request/response record itself is written HERE, as one JSON blob per call in
the same content-addressed blob store that holds Artifacts and Feed bytes —
on disk (or the bucket), never in RAM — with an ``expires_at`` the store's own
sweep honours and a key the ledger deletes explicitly when the row ages out.

A record is written only for calls attributed to an agent context window
(``agent_id`` bound): those are the calls whose contents an operator later
needs in order to reconstruct what a given model conversation was told.

Every write is fail-safe: a payload failure is reported to the ledger, never
raised into the call it was observing.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from .activity import jsonable, redact_sensitive, scrub_credentials
from ..utils import NotFoundError, format_iso

PAYLOAD_NAMESPACE = "tool-calls"
PAYLOAD_RECORD_VERSION = 1
PAYLOAD_CONTENT_TYPE = "application/json"
# Per-side caps. A result past the cap is kept as a bounded preview plus the
# full text's length and digest: the trace still says WHAT the agent got and
# how big it was, without a single sandbox transcript owning the disk.
PAYLOAD_MAX_ARGUMENT_CHARS = 1_000_000
PAYLOAD_MAX_RESULT_CHARS = 4_000_000
PAYLOAD_PREVIEW_CHARS = 64 * 1024


class PayloadBlobStore(Protocol):
    """The blob-store slice the payload ledger needs (put/get/delete)."""

    def put(
        self,
        *,
        namespace: str,
        data: bytes,
        content_type: str = "application/octet-stream",
        expires_at: str | None = None,
    ) -> str: ...

    def get(self, *, namespace: str, sha256: str) -> bytes: ...

    def delete(self, *, namespace: str, sha256: str) -> bool: ...


def _durable_redact(value: Any) -> Any:
    """Redaction for the durable path: field-level plus token-shape scrubbing.

    ``redact_sensitive`` blanks the named credential fields and presigned
    URLs; the durable record additionally runs every string through the
    credential-shape scrubber, because a tool result can quote a minted
    secret inside prose (a reviewer capability, an upload one-liner) and a
    payload on disk for 180 days must never be where one survives.
    """
    safe = redact_sensitive(value=jsonable(value=value))
    return _scrub_strings(safe)


def _scrub_strings(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _scrub_strings(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_scrub_strings(item) for item in value]
    if isinstance(value, tuple):
        return [_scrub_strings(item) for item in value]
    if isinstance(value, str):
        return scrub_credentials(value)
    return value


def _bounded(value: Any, *, max_chars: int) -> Any:
    """The value itself, or a bounded stand-in when its JSON text is too big."""
    try:
        text = json.dumps(value, sort_keys=True)
    except (TypeError, ValueError):
        return {"_unserializable": True, "repr": repr(value)[:PAYLOAD_PREVIEW_CHARS]}
    if len(text) <= max_chars:
        return value
    return {
        "_truncated": True,
        "_chars": len(text),
        "_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "preview": text[:PAYLOAD_PREVIEW_CHARS],
    }


class ToolCallPayloadStore:
    """Write, read, and delete one call's redacted request/response record."""

    def __init__(
        self,
        *,
        blobs: PayloadBlobStore,
        retention_days: int,
        namespace: str = PAYLOAD_NAMESPACE,
    ) -> None:
        self._blobs = blobs
        self.retention_days = max(1, int(retention_days))
        self.namespace = namespace

    def write(
        self,
        *,
        ts: str,
        agent_id: str,
        request_id: str,
        principal_id: str,
        mcp_session_id: str,
        tool: str,
        source: str,
        project_id: str,
        status: str,
        duration_ms: int,
        arguments: Any,
        result: Any,
        error: str,
        error_code: str,
        now: datetime | None = None,
    ) -> str:
        """Persist the record and return its blob key (the ledger's payload_ref).

        The record carries a nonce so two byte-identical calls (same second,
        same args, same result) never share one content-addressed blob — a
        shared blob would vanish for the second row when the first is pruned.
        """
        record = {
            "v": PAYLOAD_RECORD_VERSION,
            "nonce": uuid.uuid4().hex,
            "ts": ts,
            "agent_id": agent_id,
            "request_id": request_id,
            "principal_id": principal_id,
            "mcp_session_id": mcp_session_id,
            "tool": tool,
            "source": source,
            "project_id": project_id,
            "status": status,
            "error_code": error_code,
            "error": scrub_credentials(str(error or ""))[:PAYLOAD_PREVIEW_CHARS],
            "duration_ms": int(duration_ms or 0),
            "arguments": _bounded(
                _durable_redact(arguments), max_chars=PAYLOAD_MAX_ARGUMENT_CHARS
            ),
            # An error's "result" is the error text the caller got back.
            "result": (
                None
                if status != "ok"
                else _bounded(_durable_redact(result), max_chars=PAYLOAD_MAX_RESULT_CHARS)
            ),
        }
        data = json.dumps(record, sort_keys=True, separators=(",", ":")).encode("utf-8")
        expires_at = format_iso(
            (now or datetime.now(tz=UTC)) + timedelta(days=self.retention_days)
        )
        return self._blobs.put(
            namespace=self.namespace,
            data=data,
            content_type=PAYLOAD_CONTENT_TYPE,
            expires_at=expires_at,
        )

    def read(self, *, ref: str) -> dict[str, Any] | None:
        """The stored record, or None when it has been pruned/swept."""
        if not ref:
            return None
        try:
            data = self._blobs.get(namespace=self.namespace, sha256=ref)
        except NotFoundError:
            return None
        try:
            payload = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return None
        return payload if isinstance(payload, dict) else None

    def delete(self, *, ref: str) -> bool:
        if not ref:
            return False
        try:
            return bool(self._blobs.delete(namespace=self.namespace, sha256=ref))
        except NotFoundError:
            return False


__all__ = [
    "PAYLOAD_MAX_ARGUMENT_CHARS",
    "PAYLOAD_MAX_RESULT_CHARS",
    "PAYLOAD_NAMESPACE",
    "PAYLOAD_PREVIEW_CHARS",
    "PayloadBlobStore",
    "ToolCallPayloadStore",
]
