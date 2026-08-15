"""Generic HTTP telemetry, CORS, and exception adapters.

Split out of gateway.py so the request-aware boundaries (RequestAuthenticator,
ProjectAuthorizer, ToolInvocationGateway) stay within their line budget. The
error handler maps the scope/visibility/human-session refusals to 403, the
not-found family to 404, and a lost tracking write to 500 (a valid request the
server failed to record is not a client error); everything else in the domain
error hierarchy is 400.
"""

from __future__ import annotations

import uuid

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from merv.shared.errors import TrackingPersistenceError

from ....kernel.request_context import begin_request, reset_request
from ....kernel.state import monotonic_ms
from ....kernel.utils import (
    ContentUnavailableError,
    GoneError,
    NotFoundError,
    ResearchPluginError,
    ThrottledError,
)
from ...identity import (
    HumanSessionRequiredError,
    ProjectKeyScopeError,
    ToolVisibilityError,
)
from ...telemetry import StructuredLogger
from ..http_policy import HttpSurfacePolicy
from .shared import UI_CORS_EXPOSE_HEADERS, UI_CORS_HEADERS, redact_upload_tokens


def install_activity_middleware(
    http: FastAPI, *, structured_logger: StructuredLogger
) -> None:
    @http.middleware("http")
    async def log_http_activity(request: Request, call_next):
        started = monotonic_ms()
        status = 500
        request_id = uuid.uuid4().hex[:16]
        # Outermost of the custom middlewares, so every inner layer — the
        # principal gate, the routes, and the tool dispatcher running in the
        # threadpool — inherits this id without it entering any signature.
        scope = begin_request(request_id=request_id)
        try:
            response = await call_next(request)
            status = response.status_code
            response.headers["X-RP-Request-Id"] = request_id
            return response
        finally:
            reset_request(scope)
            principal = getattr(request.state, "principal", None)
            structured_logger.log(
                kind="http",
                request_id=request_id,
                tenant_id=getattr(principal, "tenant_id", "") or "",
                path=redact_upload_tokens(str(request.url.path)),
                status=status,
                duration_ms=monotonic_ms() - started,
                method=request.method,
            )


def install_cors(
    http: FastAPI, *, allowed_origins: list[str] | None, surface: HttpSurfacePolicy
) -> None:
    http.add_middleware(
        CORSMiddleware,
        allow_origins=(allowed_origins or []) if surface.restrict_cors else ["*"],
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=UI_CORS_HEADERS,
        expose_headers=UI_CORS_EXPOSE_HEADERS,
    )


def install_error_handlers(http: FastAPI) -> None:
    @http.exception_handler(ResearchPluginError)
    async def research_error_handler(
        _request: Request, exc: ResearchPluginError
    ) -> JSONResponse:
        status = (
            403
            if isinstance(
                exc,
                (HumanSessionRequiredError, ProjectKeyScopeError, ToolVisibilityError),
            )
            else 404
            if isinstance(exc, (NotFoundError, ContentUnavailableError))
            else 410
            if isinstance(exc, GoneError)
            else 429
            if isinstance(exc, ThrottledError)
            # The request was valid and its transition committed; only the
            # server's own durable record failed. The message and error_code
            # still carry the do-not-retry instruction verbatim.
            else 500
            if isinstance(exc, TrackingPersistenceError)
            else 400
        )
        return JSONResponse(
            {"detail": exc.message, "error_code": exc.error_code, **exc.details},
            status_code=status,
        )

    @http.exception_handler(RequestValidationError)
    async def validation_error_handler(
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse(
            {"detail": "invalid HTTP request", "errors": exc.errors()}, status_code=400
        )


__all__ = ["install_activity_middleware", "install_cors", "install_error_handlers"]
