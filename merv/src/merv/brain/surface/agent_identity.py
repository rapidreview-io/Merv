"""Agent context-window identity: ``agent.hello`` and per-call attribution.

An *agent* here is one model context window — one conversation of one
coding agent, including each subagent it spawns, which has a context of its
own. Merv wants to know, per context window, every tool call it made and
everything Merv sent back, so the credential (shared by a whole client, or a
whole runner) is not enough of a name.

The mechanism is deliberately cheap on the model side: ``agent.hello`` mints
a six-character random ``agent_id`` once, and every later call carries it as
one small argument. The gateway strips it before contract validation, checks
it belongs to the calling credential's user/tenant, and binds it into the
request context so the ledger row and the payload record are attributed.

Rules, in order:

- A coding-agent session credential (``mas_``) is already one process. Its
  hello mints an identity bound to that session; a call without ``agent_id``
  falls back to the session's default identity instead of being refused, so
  runner tooling (``merv call``) keeps working; a supplied id must belong to
  that same session.
- Every other MCP caller must supply an ``agent_id`` this service issued for
  the same user (or tenant, where no user exists) — or is told, in the
  refusal itself, to resend with the id it already has or to call hello.
- HTTP/UI calls never carry one.

``MERV_AGENT_IDENTITY=optional`` relaxes the second rule to "record it when
supplied" for narrow deployments and test compositions.
"""

from __future__ import annotations

import secrets
import threading
import time
from collections.abc import Mapping
from contextlib import closing
from dataclasses import dataclass
from typing import Any

from ..kernel.env import env_value
from ..kernel.request_context import bind_agent
from ..kernel.state import BaseStateStore, row_to_dict, rows_to_dicts
from ..kernel.state.activity import ledger_label
from ..kernel.state.tool_call_payloads import ToolCallPayloadStore
from ..kernel.utils import NotFoundError, ValidationError, now_iso

AGENT_IDENTITY_MODE_ENV_VAR = "MERV_AGENT_IDENTITY"
AGENT_IDENTITY_MODES = ("required", "optional")
HELLO_TOOL = "agent.hello"
# Lowercase base-31 without the look-alikes (0/o, 1/l/i): six characters is
# ~887M ids — a handful of tokens for the model to carry, unique with a retry.
AGENT_ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"
AGENT_ID_LENGTH = 6
_MINT_ATTEMPTS = 16
# A validated id is remembered this long before the row is re-read, so the
# per-call check is a dict lookup, not a query.
_CACHE_SECONDS = 300.0
_CACHE_MAX_ENTRIES = 20_000
_MAX_FIELD_CHARS = 200

_IDENTITY_COLUMNS = """
agent_id, tenant_id, user_id, principal_id, oauth_family_id, agent_session_id,
mcp_session_id, client_name, client_version, role, parent_agent_id, note,
created_at
"""


class AgentIdentityRequiredError(ValidationError):
    """An MCP call arrived without the context window's agent_id."""

    error_code = "agent_id_required"


class AgentIdentityUnknownError(ValidationError):
    """The supplied agent_id was never issued, or not to this caller."""

    error_code = "agent_id_unknown"


def resolve_agent_identity_mode(env: Mapping[str, str] | None = None) -> str:
    raw = (env_value(AGENT_IDENTITY_MODE_ENV_VAR, env=env) or "required").lower()
    if raw not in AGENT_IDENTITY_MODES:
        raise ValidationError(
            f"invalid {AGENT_IDENTITY_MODE_ENV_VAR}: {raw!r} "
            f"(expected one of {', '.join(AGENT_IDENTITY_MODES)})",
            details={"value": raw},
        )
    return raw


@dataclass(frozen=True)
class CallerFacts:
    """The non-secret facts about a caller that an identity is bound to.

    Built by the delivery layer from the authenticated principal (it owns the
    principal vocabulary); this module only ever compares and stores them.
    """

    tenant_id: str = ""
    user_id: str = ""
    principal_id: str = ""
    oauth_family_id: str = ""
    agent_session_id: str = ""
    mcp_session_id: str = ""

    def as_dict(self) -> dict[str, str]:
        return {
            "tenant_id": self.tenant_id,
            "user_id": self.user_id,
            "principal_id": self.principal_id,
            "oauth_family_id": self.oauth_family_id,
            "agent_session_id": self.agent_session_id,
            "mcp_session_id": self.mcp_session_id,
        }


def _clip(value: Any) -> str:
    return ledger_label(value)[:_MAX_FIELD_CHARS]


def _hello_message(agent_id: str) -> str:
    return (
        f"Pass agent_id={agent_id!r} in every Merv call for the rest of this "
        "context window. Do not call agent.hello again here."
    )


class AgentIdentities:
    """Own agent context-window identities and their per-call resolution."""

    def __init__(
        self,
        *,
        store: BaseStateStore,
        mode: str = "required",
        payloads: ToolCallPayloadStore | None = None,
    ) -> None:
        if mode not in AGENT_IDENTITY_MODES:
            raise ValidationError(f"invalid agent identity mode: {mode!r}")
        self.store = store
        self.mode = mode
        self.payloads = payloads
        self._lock = threading.Lock()
        # agent_id -> (row, validated_at). Rows are immutable once minted, so
        # a cached row is never stale; the TTL only bounds memory.
        self._cache: dict[str, tuple[dict[str, Any], float]] = {}

    @property
    def required(self) -> bool:
        return self.mode == "required"

    # ------------------------------------------------------------------ hello

    def hello(
        self,
        *,
        agent_id: str | None = None,
        role: str = "",
        parent_agent_id: str = "",
        note: str = "",
        caller: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """The ``agent.hello`` tool: mint this context window's id, or confirm it.

        ``caller`` is injected by the gateway from the authenticated
        principal — never from the model. Passing an ``agent_id`` this
        caller may use confirms it instead of minting a second one, so a
        model re-orienting after context compaction does not split its own
        trace in two.
        """
        facts = CallerFacts(**(caller or {}))
        supplied = str(agent_id or "").strip()
        if supplied and self._usable(agent_id=supplied, caller=facts) is not None:
            bind_agent(agent_id=supplied)
            return {
                "agent_id": supplied,
                "created": False,
                "message": _hello_message(supplied),
            }
        row = self._mint(
            caller=facts,
            role=role,
            parent_agent_id=parent_agent_id,
            note=note,
        )
        # The hello call is the first row of the new trace: attribute it too.
        bind_agent(agent_id=row["agent_id"])
        return {
            "agent_id": row["agent_id"],
            "created": True,
            "message": _hello_message(row["agent_id"]),
        }

    def peek(self, *, agent_id: str, caller: CallerFacts) -> str:
        """``agent_id`` if this caller may use it, else "". Never raises."""
        try:
            usable = self._usable(agent_id=str(agent_id or ""), caller=caller)
        except Exception:  # noqa: BLE001 -- attribution is best-effort here
            return ""
        return str(agent_id) if usable is not None else ""

    # ---------------------------------------------------------------- resolve

    def resolve(
        self, *, agent_id: str | None, caller: CallerFacts, tool: str = ""
    ) -> str:
        """The agent_id one MCP call is attributed to, or "" when none applies.

        Raises ``AgentIdentityRequiredError`` / ``AgentIdentityUnknownError``
        with model-facing text: the refusal is the "system asks whether you
        have an id" step, so it says exactly what to do next.
        """
        supplied = str(agent_id or "").strip()
        if caller.agent_session_id:
            if supplied:
                row = self._usable(agent_id=supplied, caller=caller)
                if row is None:
                    raise AgentIdentityUnknownError(
                        f"agent_id {supplied!r} was not issued to this agent "
                        "session. Use the agent_id agent.hello gave THIS "
                        "context window, or call agent.hello once to get one.",
                        details={"agent_id": supplied, "tool": tool},
                    )
                return supplied
            return self._session_default(caller=caller)["agent_id"]
        if supplied:
            row = self._usable(agent_id=supplied, caller=caller)
            if row is None:
                raise AgentIdentityUnknownError(
                    f"agent_id {supplied!r} is not one Merv issued to you. If "
                    "agent.hello gave this context window an id earlier, resend "
                    "with exactly that id; otherwise call agent.hello once and "
                    "carry the id it returns in every call.",
                    details={"agent_id": supplied, "tool": tool},
                )
            return supplied
        if not self.required:
            return ""
        raise AgentIdentityRequiredError(
            "agent_id is required on every Merv call. If this context window "
            "already has one from agent.hello, resend this call with it; if "
            "not, call agent.hello once and carry the returned agent_id in "
            "every call from now on. (If agent.hello is not in your tool list, "
            "reconnect the Merv MCP server.)",
            details={"tool": tool, "hint": "call agent.hello"},
        )

    # ------------------------------------------------------------- transport

    def record_mcp_session(
        self,
        *,
        session_id: str,
        principal_id: str,
        client_name: str,
        client_version: str,
        protocol_version: str,
    ) -> None:
        """Remember one initialize: who the client said it was. Never raises."""
        if not session_id:
            return
        try:
            with self.store.transaction() as tx:
                tx.execute(
                    """
                    INSERT INTO mcp_sessions
                      (session_id, principal_id, client_name, client_version,
                       protocol_version, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        _clip(session_id),
                        _clip(principal_id),
                        _clip(client_name),
                        _clip(client_version),
                        _clip(protocol_version),
                        now_iso(),
                    ),
                )
        except Exception:  # noqa: BLE001 -- telemetry never breaks the handshake
            return

    # ------------------------------------------------------------------ reads

    def get(self, *, agent_id: str) -> dict[str, Any] | None:
        with closing(self.store.connect()) as conn:
            row = conn.execute(
                f"SELECT {_IDENTITY_COLUMNS} FROM agent_identities WHERE agent_id = ?",
                (str(agent_id or ""),),
            ).fetchone()
        return row_to_dict(row=row)

    def list(
        self, *, user_id: str | None = None, limit: int = 100
    ) -> dict[str, Any]:
        """Identities newest first, each with its call count and activity span."""
        bounded = max(1, min(int(limit), 1000))
        clauses = []
        params: list[Any] = []
        if user_id:
            clauses.append("a.user_id = ?")
            params.append(str(user_id))
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with closing(self.store.connect()) as conn:
            rows = conn.execute(
                f"""
                SELECT a.agent_id, a.tenant_id, a.user_id, a.principal_id,
                       a.oauth_family_id, a.agent_session_id, a.mcp_session_id,
                       a.client_name, a.client_version, a.role,
                       a.parent_agent_id, a.note, a.created_at,
                       COALESCE(c.calls, 0) AS calls,
                       COALESCE(c.first_call_at, '') AS first_call_at,
                       COALESCE(c.last_call_at, '') AS last_call_at
                FROM agent_identities a
                LEFT JOIN (
                  SELECT agent_id, COUNT(*) AS calls,
                         MIN(ts) AS first_call_at, MAX(ts) AS last_call_at
                  FROM tool_calls WHERE agent_id <> '' GROUP BY agent_id
                ) c ON c.agent_id = a.agent_id
                {where}
                ORDER BY a.created_at DESC, a.agent_id
                LIMIT ?
                """,
                (*params, bounded),
            ).fetchall()
        return {"agents": rows_to_dicts(rows=rows), "limit": bounded}

    def trace(
        self,
        *,
        agent_id: str,
        limit: int = 200,
        after_id: int | None = None,
        payloads: bool = False,
    ) -> dict[str, Any]:
        """One agent's calls in the order it made them, optionally with payloads.

        The payload is the redacted record of what the agent sent and what
        Merv returned; ``payload: null`` on a call means the record was not
        kept (no payload store, a write failure, or already pruned).
        """
        identity = self.get(agent_id=agent_id)
        if identity is None:
            raise NotFoundError(f"agent not found: {agent_id}")
        bounded = max(1, min(int(limit), 2000))
        with closing(self.store.connect()) as conn:
            rows = conn.execute(
                """
                SELECT id, ts, request_id, principal_id, tool, source, project_id,
                       target_type, target_id, status, error_code, error_head,
                       duration_ms, sent_chars, received_chars, args_digest,
                       mcp_session_id, payload_ref
                FROM tool_calls
                WHERE agent_id = ? AND id > ?
                ORDER BY id
                LIMIT ?
                """,
                (str(agent_id), int(after_id or 0), bounded + 1),
            ).fetchall()
        calls = rows_to_dicts(rows=rows)
        more = len(calls) > bounded
        calls = calls[:bounded]
        if payloads and self.payloads is not None:
            for call in calls:
                call["payload"] = self.payloads.read(ref=str(call.get("payload_ref") or ""))
        return {
            "agent": identity,
            "calls": calls,
            "more": more,
            "next_after_id": int(calls[-1]["id"]) if calls and more else None,
        }

    # -------------------------------------------------------------- internals

    def _usable(
        self, *, agent_id: str, caller: CallerFacts
    ) -> dict[str, Any] | None:
        """The identity row if this caller may use it, else None.

        Binding is by user when the credential names one (so an OAuth token
        rotating hourly keeps the same identity), by tenant otherwise; a
        session credential may only use identities minted under that session.
        """
        row = self._cached(agent_id=agent_id)
        if row is None:
            return None
        if caller.agent_session_id:
            if str(row.get("agent_session_id") or "") != caller.agent_session_id:
                return None
            return row
        row_user = str(row.get("user_id") or "")
        if row_user or caller.user_id:
            return row if row_user == caller.user_id else None
        return row if str(row.get("tenant_id") or "") == caller.tenant_id else None

    def _cached(self, *, agent_id: str) -> dict[str, Any] | None:
        if not agent_id or len(agent_id) > _MAX_FIELD_CHARS:
            return None
        now = time.monotonic()
        with self._lock:
            hit = self._cache.get(agent_id)
            if hit is not None and now - hit[1] < _CACHE_SECONDS:
                return hit[0]
        row = self.get(agent_id=agent_id)
        if row is not None:
            with self._lock:
                if len(self._cache) >= _CACHE_MAX_ENTRIES:
                    self._cache.clear()
                self._cache[agent_id] = (row, now)
        return row

    def _session_default(self, *, caller: CallerFacts) -> dict[str, Any]:
        """The one identity a session credential's unattributed calls fall to."""
        with closing(self.store.connect()) as conn:
            row = conn.execute(
                f"""
                SELECT {_IDENTITY_COLUMNS} FROM agent_identities
                WHERE agent_session_id = ? AND role = 'session'
                ORDER BY created_at, agent_id LIMIT 1
                """,
                (caller.agent_session_id,),
            ).fetchone()
        found = row_to_dict(row=row)
        if found is not None:
            return found
        return self._mint(caller=caller, role="session", parent_agent_id="", note="")

    def _mint(
        self, *, caller: CallerFacts, role: str, parent_agent_id: str, note: str
    ) -> dict[str, Any]:
        """Insert a fresh random identity; the store's single writer makes the
        existence check and the insert one atomic step, so a collision is
        simply retried."""
        client_name, client_version = self._client_of(
            mcp_session_id=caller.mcp_session_id
        )
        with self.store.transaction() as tx:
            for _ in range(_MINT_ATTEMPTS):
                candidate = "".join(
                    secrets.choice(AGENT_ID_ALPHABET) for _ in range(AGENT_ID_LENGTH)
                )
                taken = tx.execute(
                    "SELECT 1 FROM agent_identities WHERE agent_id = ?", (candidate,)
                ).fetchone()
                if taken is not None:
                    continue
                row = {
                    "agent_id": candidate,
                    "tenant_id": _clip(caller.tenant_id),
                    "user_id": _clip(caller.user_id),
                    "principal_id": _clip(caller.principal_id),
                    "oauth_family_id": _clip(caller.oauth_family_id),
                    "agent_session_id": _clip(caller.agent_session_id),
                    "mcp_session_id": _clip(caller.mcp_session_id),
                    "client_name": client_name,
                    "client_version": client_version,
                    "role": _clip(role),
                    "parent_agent_id": _clip(parent_agent_id),
                    "note": _clip(note),
                    "created_at": now_iso(),
                }
                tx.execute(
                    f"INSERT INTO agent_identities ({_IDENTITY_COLUMNS}) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    tuple(row.values()),
                )
                with self._lock:
                    self._cache[candidate] = (row, time.monotonic())
                return row
        raise RuntimeError("could not mint a unique agent_id")

    def _client_of(self, *, mcp_session_id: str) -> tuple[str, str]:
        """Client name/version the transport session announced at initialize."""
        if not mcp_session_id:
            return "", ""
        try:
            with closing(self.store.connect()) as conn:
                row = conn.execute(
                    "SELECT client_name, client_version FROM mcp_sessions "
                    "WHERE session_id = ?",
                    (_clip(mcp_session_id),),
                ).fetchone()
        except Exception:  # noqa: BLE001 -- provenance is best-effort
            return "", ""
        if row is None:
            return "", ""
        return str(row["client_name"] or ""), str(row["client_version"] or "")


__all__ = [
    "AGENT_ID_ALPHABET",
    "AGENT_ID_LENGTH",
    "AGENT_IDENTITY_MODE_ENV_VAR",
    "HELLO_TOOL",
    "AgentIdentities",
    "AgentIdentityRequiredError",
    "AgentIdentityUnknownError",
    "CallerFacts",
    "resolve_agent_identity_mode",
]
