"""Generic HTTP telemetry, CORS, and exception adapters.

Split out of gateway.py so the request-aware boundaries (RequestAuthenticator,
ProjectAuthorizer, ToolInvocationGateway) stay within their line budget. Every
domain error carries its own ``http_status``; the handler renders it.
"""

from __future__ import annotations

import uuid

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from ....kernel.request_context import begin_request, reset_request
from ....kernel.state import monotonic_ms
from ....kernel.utils import ResearchPluginError
from ...telemetry import StructuredLogger
from ..http_policy import HttpSurfacePolicy
from .shared import UI_CORS_EXPOSE_HEADERS, UI_CORS_HEADERS, redact_upload_tokens, refusal


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
            principal = getattr(request.state, "principal", None)  # unset on OPTIONS
            structured_logger.log(
                kind="http",
                request_id=request_id,
                tenant_id=principal.tenant_id if principal else "",
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
        return refusal(exc)

    @http.exception_handler(RequestValidationError)
    async def validation_error_handler(
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        errors = [{k: e[k] for k in ("loc", "msg", "type") if k in e} for e in exc.errors()]
        return JSONResponse({"detail": "invalid HTTP request", "errors": errors}, status_code=400)


__all__ = ["install_activity_middleware", "install_cors", "install_error_handlers"]
