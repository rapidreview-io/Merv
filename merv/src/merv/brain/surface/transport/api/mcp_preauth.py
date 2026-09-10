"""Synchronous pre-flight denials for streamable /mcp tool calls (FIX 6).

Mirrors every gateway dispatch check that can deny a call WITHOUT running the
tool — project scope (key equality + membership), the key project-create
block, and review-request/session-derived scope (INV-9) — so denials always
commit as transport errors (403 for scope/visibility, 404 for membership
misses) before the SSE stream can open with a 200. The gateway dispatch path
keeps the same checks and stays authoritative.
"""

from __future__ import annotations

from typing import Any, Callable, Protocol

from fastapi import Request

from ....research_core import Research
from ...identity import LOCAL_PRINCIPAL, ProjectKeyScopeError, is_external_key
from ...tools.contracts import TOOL_MANIFEST

Preauthorizer = Callable[[Request, str, dict[str, Any]], None]


class ProjectScopeAuthorizer(Protocol):
    def require_member(self, *, project_id: str | None, principal: Any) -> None: ...

    def key_project_id(self, principal: Any) -> str: ...


class AgentSessionAuthorizer(Protocol):
    def __call__(
        self, *, name: str, arguments: dict[str, Any], principal: Any
    ) -> None: ...


def build_mcp_preauthorizer(
    *,
    authorizer: ProjectScopeAuthorizer,
    research: Research,
    hosted: bool,
    authorize_agent_session: AgentSessionAuthorizer | None = None,
) -> Preauthorizer:
    """Bind the project authorizer + review resolver into a ScopeAuthorizer."""

    def preauthorize(request: Request, name: str, arguments: dict[str, Any]) -> None:
        principal = getattr(request.state, "principal", LOCAL_PRINCIPAL)
        if authorize_agent_session is not None:
            authorize_agent_session(
                name=name, arguments=arguments, principal=principal
            )
        key_project_id = authorizer.key_project_id(principal)
        authorizer.require_member(
            project_id=key_project_id or None,
            principal=principal,
        )
        authorizer.require_member(
            project_id=str(arguments.get("project_id") or "") or None,
            principal=principal,
        )
        if is_external_key(principal) and name == "project" and arguments.get("action") == "create":
            # Mirrors the gateway: keyed on credential shape so an
            # account-scoped key (no key_project_id) cannot slip through.
            raise ProjectKeyScopeError("project API keys cannot create projects",
                                       details={"key_project_id": key_project_id})
        scope_field = getattr(TOOL_MANIFEST.get(name), "telemetry_scope_field", "") if hosted else ""
        if scope_field:
            # INV-9: the reviewed request or the session's own project decides
            # scope, so an mk_ key cannot ride a foreign id into another project.
            authorizer.require_member(
                project_id=research.review_project_id(
                    **{scope_field: arguments.get(scope_field)}),
                principal=principal)

    return preauthorize
