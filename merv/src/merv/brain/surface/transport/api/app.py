"""Lean FastAPI composition root for the Merv HTTP surface."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from fastapi import FastAPI, Request, Response

from .... import __version__
from ....kernel.secret_tokens import MIN_WAIT_SECRET_BYTES
from ...auth import require_hosted_auth_decision
from ...runner_pairing import RunnerPairings
from ..feed_http import register_feed_routes
from ..http_policy import HttpSurfacePolicy
from ..mcp_http import register_mcp_routes
from . import (
    agent_sessions,
    artifacts,
    claims,
    events,
    experiments,
    mcp_preauth,
    meta,
    oauth,
    projects,
    reflections,
    reviews,
    runs_wait,
    sandbox_providers,
    sandboxes,
    storage,
    user_settings,
)
from .gateway import (
    ProjectAuthorizer,
    RequestAuthenticator,
    ToolInvocationGateway,
    install_auth_routes,
    install_request_middleware,
)
from .middleware import (
    install_activity_middleware,
    install_cors,
    install_error_handlers,
)
from .shared import conditional_json


def create_fastapi_app(
    app: Any | None = None,
    *,
    allowed_origins: list[str] | None = None,
    cleanup: Any | None = None,
    tenant_counters: Any | None = None,
    surface_policy: HttpSurfacePolicy | None = None,
    auth: Any | None = None,
    user_directory: Any | None = None,
    oauth_service: Any | None = None,
    ui_base_url: str = "",
    oauth_resource_uri: str = "",
    wait_secret: bytes | None = None,
    env: Mapping[str, str] | None = None,
    runner_pairings: RunnerPairings | None = None,
) -> FastAPI:
    """Compose transport adapters around an already-built backend."""
    if app is None:
        raise ValueError("provide app")
    if oauth_service is not None and not oauth_resource_uri:
        raise ValueError("oauth_resource_uri is required when OAuth is enabled")
    surface = surface_policy or HttpSurfacePolicy.for_surface(
        restrict_cors=False, hosted_control=False
    )
    require_hosted_auth_decision(auth=auth, hosted=surface.hosted_control, env=env)
    api = app
    # Validated before any wiring: a bad key must refuse this composition
    # without touching state a sibling app over the same backend relies on.
    if wait_secret and len(wait_secret) < MIN_WAIT_SECRET_BYTES:
        raise ValueError(f"wait secret must be at least {MIN_WAIT_SECRET_BYTES} bytes")
    authorizer = ProjectAuthorizer(research=api.research)
    # One key, both directions: the gateway signs sandbox.runs wait URLs with
    # exactly what the route below verifies, per composition — never shared.
    gateway = ToolInvocationGateway(
        tools=api.tools,
        research=api.research,
        sandboxes=api.sandboxes,
        surface=surface,
        projects=authorizer,
        ledger=api.tool_ledger,
        agent_sessions=api.agent_sessions,
        wait_secret=wait_secret,
        auth_meta=auth.meta() if auth is not None else None,
    )
    authenticator = RequestAuthenticator(
        surface=surface,
        verifier=auth,
        agent_sessions=api.agent_sessions,
        oauth_enabled=oauth_service is not None,
        canonical_mcp_resource=oauth_resource_uri,
    )
    http = FastAPI(title="Merv API", version=__version__)

    install_request_middleware(
        http, authenticator=authenticator, authorizer=authorizer, ledger=api.tool_ledger
    )
    install_activity_middleware(http, structured_logger=api.structured_log)
    # Registered last so CORS decorates middleware short-circuits as well.
    install_cors(http, allowed_origins=allowed_origins, surface=surface)
    install_error_handlers(http)
    # Owner-minted keys carry no audience: the audience column exists to
    # confine OAuth-issued keys to /mcp, and stamping the resource URI here
    # 403'd directly minted mk_ keys off every REST route in hosted deploys.
    install_auth_routes(
        http,
        verifier=auth,
        tracking_enabled=api.application.tracking_enabled,
        runner_pairings=runner_pairings,
        gateway=gateway,
    )
    oauth.install_routes(
        http,
        service=oauth_service,
        allowed_origins=allowed_origins or [],
        ui_base_url=ui_base_url,
        canonical_mcp_resource=oauth_resource_uri,
    )

    sandbox_routers = (
        (
            sandboxes.build_router(
                gateway,
                application=api.application,
                sandboxes=api.sandboxes,
            ),
            runs_wait.build_router(sandboxes=api.sandboxes, secret=wait_secret),
            sandbox_providers.build_router(
                providers=api.sandbox_providers,
                budget_view=api.sandboxes.user_budget_view,
            ),
        )
        if api.sandbox_enabled
        else ()
    )
    routers = (
        agent_sessions.build_router(gateway, application=api.application),
        meta.build_router(
            gateway,
            activity_log=api.activity,
            tool_calls=api.tool_calls,
            research=api.research,
            project_member_directory=user_directory is not None,
            storage_max_upload_bytes=(
                api.storage.max_upload_bytes if api.storage is not None else None
            ),
        ),
        projects.build_router(
            gateway,
            application=api.application,
            research=api.research,
            sandboxes=api.sandboxes,
            user_directory=user_directory,
        ),
        claims.build_router(gateway),
        experiments.build_router(gateway, application=api.application),
        reflections.build_router(application=api.application),
        artifacts.build_router(artifacts=api.artifacts),
        storage.build_router(storage=api.storage),
        reviews.build_router(
            gateway,
            application=api.application,
            research=api.research,
        ),
        *sandbox_routers,
        events.build_router(application=api.application),
        user_settings.build_router(user_settings=api.user_settings),
    )
    for router in routers:
        http.include_router(router)
    register_feed_routes(
        http,
        feed_api=api.feed,
        authorize_project=gateway.authorize_project,
        activity=api.activity,
    )
    register_mcp_routes(
        http,
        list_tools=api.tools.list_tools,
        call_tool=gateway.call_mcp,
        allow_tool=lambda _tool: True,
        authorize_scope=mcp_preauth.build_mcp_preauthorizer(
            authorizer=authorizer,
            research=api.research,
            hosted=surface.use_hosted_tool_policies,
            authorize_agent_session=gateway.authorize_agent_session,
        ),
        ledger=api.tool_ledger,
    )
    @http.get("/api/projects/{project_id}/litreview")
    def litreview(project_id: str, request: Request) -> Response:
        return conditional_json(
            request, api.literature.ui_snapshot(project_id=project_id)
        )

    if cleanup is not None:
        counters = tenant_counters or api.application.tenant_counters

        @http.post("/api/admin/cleanup")
        def admin_cleanup() -> dict[str, Any]:
            return {"cleaned": cleanup.run_all().as_dict()}

        @http.get("/api/admin/tenants/{tenant_id}/counters")
        def admin_tenant_counters(tenant_id: str) -> dict[str, Any]:
            return counters(tenant_id=tenant_id)

    return http
