"""Shared shaping, scrubbing, and sizing helpers for in-memory telemetry."""

from __future__ import annotations

from contextlib import suppress
from dataclasses import dataclass, field
import hashlib
import json
import re
import time
from typing import Any

# Cap the per-event result payload written to the log. Tool results such as
# experiment.get_state and the project home view can be many KB; logging them
# verbatim on every call — including frequent UI polls — is what drives
# multi-hundred-MB/day growth. The log is a visibility feed, not an archive.
RESULT_LOG_MAX_BYTES = 16 * 1024

# The durable ledger keeps a failure *sample*, never the failure text: one
# line, capped, so errors group without the column becoming a payload store.
LEDGER_ERROR_MAX_CHARS = 200

# Every durable LABEL column (tool, source, project_id, target_id, error_code,
# request/principal id) is indexed and fed by caller-controlled text: an MCP
# method name, a query-string project_id. Uncapped, one hostile caller both
# amplifies the table and its three indexes and parks a credential in a column
# a human will later read. Bound them here, at the one writer.
LEDGER_LABEL_MAX_CHARS = 120

# What an argument name means to telemetry. Kernel knows only the generic
# fields every component carries; an owner registers its own at composition
# (``register_activity_vocabulary``), so the shared log shapes work the same
# for a record Kernel has never heard of.
SENSITIVE_KEYS = {"capability", "session_secret", "MLFLOW_TRACKING_PASSWORD"}
ID_KEYS = {"project_id", "artifact_id", "job_id", "target_type", "target_id",
           "role", "transition", "verdict"}
TARGET_KEYS: list[tuple[str, str]] = [("artifact", "artifact_id")]

# What the ledger will accept in its status column; anything else is an error.
TOOL_CALL_STATUSES = frozenset({"ok", "error", "rejected"})


def register_activity_vocabulary(
    *,
    sensitive_keys: tuple[str, ...] = (),
    id_keys: tuple[str, ...] = (),
    targets: tuple[tuple[str, str], ...] = (),
) -> None:
    """Let an owner name its own argument fields for the shared log.

    ``sensitive_keys`` are blanked wherever they appear, ``id_keys`` survive
    the redacted argument summary, and ``targets`` pair a record kind with the
    argument that carries its id, in the order they should be tried.
    """
    SENSITIVE_KEYS.update(sensitive_keys)
    ID_KEYS.update(id_keys)
    TARGET_KEYS.extend(target for target in targets if target not in TARGET_KEYS)


# Value-level secret scrubbing (INV-12). storage.submit/fetch AND feed.post
# results carry a one-time upload-token URL inside their `run` command string
# (storage also carries a presigned S3 URL — a ~1-hour replayable credential
# that bypasses brain auth entirely). Neither may reach a persisted log even
# when embedded in a string value, so we drop every SigV4 query param (name and
# value) and the upload-token path segments.
_S3_SIGV4_PARAM_RE = re.compile(
    r"(?i)X-Amz-(?:Signature|Credential|Security-Token|Algorithm|Date|Expires|SignedHeaders)=[^&'\"\s]+"
)
# The two path patterns are public because the HTTP access-log scrubber
# (transport/api/shared.redact_upload_tokens) masks the very same credential in
# a request path and imports these rather than restating them: two copies that
# drift is how a bearer token reaches a persisted log.
UPLOAD_TOKEN_PATH_RE = re.compile(
    r"(/api/(?:artifacts/[uf]|feed/u|storage/u)/)[^/?'\"\s]+"
)
# Run-wait URLs are auth-exempt capabilities too, and they are handed to agents
# to paste into commands — so they reach logs inside string values, not just as
# request paths. Keep the sandbox and label, mask the tag.
WAIT_SIGNATURE_PATH_RE = re.compile(
    r"(/wait/[^/?'\"\s]+/[^/?'\"\s]+/)[^/?'\"\s]+"
)


def scrub_secret_text(text: str) -> str:
    """Redact presigned-URL SigV4 params and upload-token path segments embedded
    in a string value before it is persisted to a visibility log."""
    if "X-Amz-" in text:
        text = _S3_SIGV4_PARAM_RE.sub("<redacted>", text)
    if "/api/" in text:
        text = UPLOAD_TOKEN_PATH_RE.sub(r"\1<redacted>", text)
    if "/wait/" in text:
        text = WAIT_SIGNATURE_PATH_RE.sub(r"\1<redacted>", text)
    return text


# Presigned URLs are not the only credential that reaches a persisted column.
# An auth failure quotes the header it rejected, and a caller can put anything
# in a label; both land in the durable ledger. These shapes cover it: a
# bearer/basic header value, a named credential field, this system's minted
# prefixes, and generic token shapes.
_BEARER_RE = re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}")
_CREDENTIAL_FIELD_RE = re.compile(
    r"(?i)\b(authorization|x-admin-token|api[_-]?key|access[_-]?token"
    r"|refresh[_-]?token|password|secret)\s*[:=]\s*[^\s,;&'\"]+"
)
# The known prefixes scrub whatever follows them, however short. The verifiers
# accept a minted key by PREFIX alone — `mk_x` is a live credential — so a
# scrubber with a length floor would be laxer than the thing it protects,
# and a short key would land verbatim in an indexed column a human later reads.
# The cost is that an ordinary `rp_run`-shaped label redacts too; a lost
# telemetry label is far cheaper than a persisted key.
_MINTED_PREFIX_RE = re.compile(
    r"\b(?:rr_sk_|mk_|mas_|mac_|mrt_|rp_|hf_|ghp_|sk-)[A-Za-z0-9_-]*"
)
# Generic shapes carry no prefix to key on, so structure and length are the
# only signal separating a token from a word: a JWT's three base64url segments.
_TOKEN_SHAPE_RE = re.compile(
    r"\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*"
)
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]+")


def scrub_credentials(text: str) -> str:
    """Redact bearer/authorization values and key-shaped strings.

    Applied on the durable path only (ledger labels and ``error_head``): the
    in-memory rings keep the raw text the debug UI drills into, and paying for
    four regex passes over every logged result would buy nothing there.
    """
    text = _BEARER_RE.sub(r"\1 <redacted>", text)
    text = _CREDENTIAL_FIELD_RE.sub(lambda match: f"{match.group(1)}=<redacted>", text)
    text = _MINTED_PREFIX_RE.sub("<redacted>", text)
    return _TOKEN_SHAPE_RE.sub("<redacted>", text)


def _scrubbed(text: str, *, cap: int) -> str:
    """Both scrubbers, then the cap, for one durable column.

    Pre-trimmed before scrubbing so a multi-megabyte value costs a slice
    rather than a regex sweep, while a token straddling the final cap is still
    seen whole by the scrubber.
    """
    return scrub_credentials(scrub_secret_text(text[: cap * 4]))[:cap]


def ledger_label(value: Any) -> str:
    """Bound and de-fang a value on its way into an indexed label column."""
    return _scrubbed(
        _CONTROL_CHARS_RE.sub(" ", str(value or "")), cap=LEDGER_LABEL_MAX_CHARS
    )


@dataclass(slots=True)
class ToolCallRecord:
    """One tool call, shaped ONCE for every sink that logs it.

    The sinks disagree about what to KEEP — the ring keeps the raw text a human
    drills into, the durable row keeps sizes and digests — but they may not
    disagree about what the call WAS. Target, scope, and the two I/O sizes are
    derived here, so an event and a row can never report different sizes for
    the same call and no sink pays to work them out again.
    """

    tool: str = ""
    source: str = ""
    status: str = "ok"
    duration_ms: int = 0
    arguments: dict[str, Any] = field(default_factory=dict)
    result: dict[str, Any] | None = None
    error: str = ""
    error_code: str = ""
    project_id: str = ""
    target_type: str = field(init=False, default="")
    target_id: str = field(init=False, default="")
    sent_chars: int = field(init=False, default=0)
    received_chars: int = field(init=False, default=0)

    def __post_init__(self) -> None:
        self.arguments = self.arguments if isinstance(self.arguments, dict) else {}
        self.status = self.status if self.status in TOOL_CALL_STATUSES else "error"
        self.duration_ms = int(self.duration_ms or 0)
        target_type, target_id = target_of(self.arguments)
        self.target_type = target_type or ""
        self.target_id = target_id or ""
        self.project_id = self.project_id or str(self.arguments.get("project_id") or "")
        # Full I/O sizes in characters — what the agent actually sent and
        # received — independent of any capped or summarized copy a sink keeps.
        # `received_chars` matches HTTP MCP serialization (json.dumps(result,
        # sort_keys=True)), so it is the exact size of the payload that lands in
        # the agent's context; it is what the debug view sorts on to find
        # context-bloating tools. A failed call received the error text the
        # caller got back, not a result it never saw.
        self.sent_chars = payload_chars(value=self.arguments)
        self.received_chars = (
            len(self.error or "")
            if self.status != "ok"
            else payload_chars(value=self.result)
        )


class ToolActivityEmitter:
    """Shared tool-call event shaping for activity sinks."""

    def tool_call(self, call: ToolCallRecord) -> None:
        payload: dict[str, Any] = {
            "source": call.source,
            "tool": call.tool,
            "status": call.status,
            "duration_ms": call.duration_ms,
            "args": summarize_arguments(arguments=call.arguments),
            "sent_chars": call.sent_chars,
            "received_chars": call.received_chars,
        }
        if call.status == "ok":
            payload["result"] = cap_result(value=call.result)
        else:
            payload["error"] = call.error
            payload["error_code"] = call.error_code
        self.emit(event_type="tool.call", payload=payload)


def effective_source(*, event: dict[str, Any]) -> str:
    """Treat http.request events as having an implicit source = http."""
    if event.get("event") == "http.request":
        return "http"
    return event.get("source") or "mcp"


def is_event_ok(*, event: dict[str, Any]) -> bool:
    if event.get("event") == "http.request":
        status = event.get("status")
        return not (isinstance(status, int) and status >= 400)
    status = event.get("status")
    return status in (None, "ok")


def summarize_arguments(*, arguments: dict[str, Any]) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    for key, value in arguments.items():
        if key in SENSITIVE_KEYS:
            summary[key] = "[redacted]"
        elif key in ID_KEYS:
            summary[key] = value
    return summary


def target_of(arguments: Any) -> tuple[str | None, str | None]:
    """The entity a call names, so a feed or ledger row can chip it."""
    if not isinstance(arguments, dict):
        return None, None
    for target_type, key in TARGET_KEYS:
        if arguments.get(key):
            return target_type, str(arguments[key])
    return None, None


def args_digest(*, arguments: Any) -> str:
    """Stable fingerprint of REDACTED arguments — a retry loop repeats one
    digest, and no argument value is recoverable from it."""
    try:
        canonical = json.dumps(
            redact_sensitive(value=jsonable(value=arguments)), sort_keys=True
        )
    except (TypeError, ValueError):
        return ""
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def error_head(*, error: str) -> str:
    """First line of an error, secret-scrubbed and capped for the ledger."""
    lines = str(error or "").strip().splitlines()
    return _scrubbed(lines[0], cap=LEDGER_ERROR_MAX_CHARS) if lines else ""


def payload_chars(*, value: Any) -> int:
    """Length (in chars) of a value serialized the way the agent sees it.

    Matches HTTP MCP's `json.dumps(result, sort_keys=True)` so the count is
    the true size of the JSON text that enters the agent's context. Results past
    PRETTY_RESULT_THRESHOLD_BYTES go out indented, so this measures their payload
    and not the added whitespace. Returns 0 on any serialization failure rather
    than raising — this is telemetry.
    """
    try:
        return len(json.dumps(jsonable(value=value), sort_keys=True))
    except (TypeError, ValueError):
        return 0


def cap_result(*, value: Any) -> Any:
    """Return a JSON-safe result capped to RESULT_LOG_MAX_BYTES.

    Oversized results are replaced with a compact truncation marker so the
    activity log stays bounded. The caller still received the full result; the
    log is a visibility feed, not an archive.
    """
    safe = redact_sensitive(value=jsonable(value=value))
    try:
        encoded = json.dumps(safe, separators=(",", ":"))
    except (TypeError, ValueError):
        return safe
    if len(encoded) <= RESULT_LOG_MAX_BYTES:
        return safe
    return {
        "_truncated": True,
        "_bytes": len(encoded),
        "preview": encoded[:2048],
    }


def jsonable(*, value: Any) -> Any:
    with suppress(TypeError, ValueError):
        json.dumps(value)
        return value
    if isinstance(value, dict):
        return {str(key): jsonable(value=item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(value=item) for item in value]
    return str(value)


def redact_sensitive(*, value: Any, credentials: bool = False) -> Any:
    """Blank the named credential fields and scrub secrets out of string values.

    ``credentials`` adds the credential-SHAPE scrubber to every string. It is
    the durable path's setting only: a tool result can quote a minted secret
    inside prose (a capability, an upload one-liner), and a payload record
    kept on disk for 180 days must never be where one survives. The in-memory
    rings leave it off — they keep the raw text the debug UI drills into, and
    four more regex passes over every logged result would buy nothing there.
    """
    if isinstance(value, dict):
        return {
            key: "[redacted]"
            if key in SENSITIVE_KEYS
            else redact_sensitive(value=item, credentials=credentials)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_sensitive(value=item, credentials=credentials) for item in value]
    if isinstance(value, tuple):
        return tuple(
            redact_sensitive(value=item, credentials=credentials) for item in value
        )
    if isinstance(value, str):
        text = scrub_secret_text(value)
        return scrub_credentials(text) if credentials else text
    return value


def monotonic_ms() -> int:
    return int(time.perf_counter() * 1000)
