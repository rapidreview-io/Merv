"""Request principal vocabulary.

The current private hosted-control deployment authenticates via Supabase JWTs,
RapidReview ``rr_sk_`` keys, and project-scoped ``mk_`` keys. HTTP requests run
as ``LOCAL_PRINCIPAL`` — the trusted-local sentinel — until a verifier resolves
a credential. A project (``mk_``) key carries its immutable project scope on the
principal; everything else (JWT, rr_sk_) carries none.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..kernel.identity import LOCAL_CLIENT_ID, LOCAL_TENANT_ID
from ..kernel.utils import PermissionDeniedError


class ProjectKeyScopeError(PermissionDeniedError):
    """A project key was presented outside its immutable project scope."""

    error_code = "project_scope_forbidden"


class ToolVisibilityError(PermissionDeniedError):
    """A non-local MCP caller attempted an internal-only tool."""

    error_code = "tool_visibility_forbidden"


class HumanSessionRequiredError(PermissionDeniedError):
    """A machine credential attempted a human-owned control operation."""

    error_code = "human_session_required"

class AgentSessionScopeError(PermissionDeniedError):
    """A coding-agent session attempted work outside its experiment."""

    error_code = "agent_session_scope_forbidden"


@dataclass(frozen=True)
class Principal:
    """The authenticated identity behind a request.

    ``tenant_id`` scopes every project-level record; ``client_id`` identifies
    the calling machine/daemon within the tenant (lease holder identity, audit
    attribution). ``user_id`` is the Supabase ``auth.users`` UUID when the
    request carried a verified credential — empty on the local surface, where
    project-membership filtering stays inactive. Local mode uses
    ``LOCAL_PRINCIPAL``.

    A project (``mk_``) key additionally binds an immutable ``key_project_id``
    and (for later OAuth + quota phases) ``audience``/``oauth_family_id`` plus
    stored ceilings; only such a principal carries a non-None ``key_id``.
    """

    tenant_id: str
    client_id: str
    user_id: str = ""
    key_id: str | None = None
    key_project_id: str | None = None
    audience: str | None = None
    oauth_family_id: str | None = None
    key_sandbox_seconds_ceiling: int | None = None
    key_blob_bytes_ceiling: int | None = None
    agent_session_id: str | None = None
    agent_experiment_id: str | None = None
    agent_target_type: str | None = None
    agent_target_id: str | None = None
    agent_session_kind: str | None = None
    agent_review_request_id: str | None = None
    agent_workflow_instance_id: str | None = None
    agent_workflow_revision: int | None = None
    agent_workflow_node: str | None = None
    agent_read_only: bool = False
    source_key_id: str | None = None


LOCAL_PRINCIPAL = Principal(tenant_id=LOCAL_TENANT_ID, client_id=LOCAL_CLIENT_ID)


def is_external_key(principal: object | None) -> bool:
    """Whether this principal is an external machine credential."""
    return (
        getattr(principal, "key_id", None) is not None
        or getattr(principal, "agent_session_id", None) is not None
    )


def is_human_session(principal: object | None) -> bool:
    """Whether a real person is driving this request (a Supabase browser JWT).

    Every other verified credential — ``mk_``, ``rr_sk_`` — is a machine one,
    however wide its reach, so operations that only a human may authorize
    (project-key management, personal tokens, membership) test this.
    """
    return str(getattr(principal, "client_id", "") or "").startswith("jwt:")


def is_local_principal(principal: object | None) -> bool:
    """Whether this is the trusted-local sentinel (internal composition).

    Only ``LOCAL_PRINCIPAL`` is trusted-local; every verifier-minted principal
    (JWT, rr_sk_, mk_) is external. The value-level check keeps the answer
    stable if the sentinel is ever reconstructed rather than shared by identity.
    """
    if principal is LOCAL_PRINCIPAL:
        return True
    return (
        getattr(principal, "key_id", None) is None
        and getattr(principal, "agent_session_id", None) is None
        and str(getattr(principal, "client_id", "")) == LOCAL_CLIENT_ID
        and not getattr(principal, "user_id", "")
    )


def principal_label(principal: object | None) -> str:
    """Non-secret caller identity for telemetry attribution.

    A project key is named by its ``project_api_keys`` row id — never the
    presented secret, and never a digest of one; a verified session by its
    Supabase user id; the trusted-local sentinel by ``local``; and an
    unauthenticated request on an open deployment by ``open``.
    """
    key_id = str(getattr(principal, "key_id", "") or "")
    if key_id:
        return f"key:{key_id}"
    agent_session_id = str(getattr(principal, "agent_session_id", "") or "")
    if agent_session_id:
        return f"agent-session:{agent_session_id}"
    user_id = str(getattr(principal, "user_id", "") or "")
    if user_id:
        return f"user:{user_id}"
    return "local" if is_local_principal(principal) else "open"


__all__ = [
    "HumanSessionRequiredError",
    "AgentSessionScopeError",
    "LOCAL_PRINCIPAL",
    "Principal",
    "ProjectKeyScopeError",
    "ToolVisibilityError",
    "is_external_key",
    "is_human_session",
    "is_local_principal",
    "principal_label",
]
