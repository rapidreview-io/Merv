"""Dependency-free error types shared across Merv layers."""

from __future__ import annotations


class ResearchPluginError(Exception):
    """Base class for domain and tool errors."""

    error_code = "research_plugin_error"

    def __init__(self, message: str, *, details: dict | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or {}


class NotFoundError(ResearchPluginError):
    error_code = "not_found"


class PermissionDeniedError(ResearchPluginError):
    error_code = "permission_denied"


class ValidationError(ResearchPluginError):
    error_code = "validation_error"


class WorkflowError(ResearchPluginError):
    error_code = "workflow_error"


class ContentUnavailableError(ResearchPluginError):
    """A file's bytes are not available from the current deployment."""

    error_code = "content_unavailable"


class GoneError(ResearchPluginError):
    """A short-lived resource existed but can no longer be used (HTTP 410)."""

    error_code = "gone"


class ThrottledError(ResearchPluginError):
    """The caller exceeded a rate limit and must back off (HTTP 429)."""

    error_code = "throttled"


class TrackingPersistenceError(ResearchPluginError):
    """A committed state change whose tracking outcome never reached the DB.

    It belongs to this family so transports render its message verbatim: the
    caller must learn the change is already committed, must not be retried,
    and which run id may now be orphaned — not a generic internal error.
    """

    error_code = "tracking_persistence_failed"
