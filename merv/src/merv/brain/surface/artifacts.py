"""Generic artifact tools and compatible research artifact wire shapes.

Artifacts owns immutable content; Research owns its associations. Surface owns dictionaries, shell
commands, and content classification exposed to MCP and HTTP callers.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import quote

from ..artifacts import CompletedFigure, PendingUpload
from ..research_core import (
    Artifact,
    ArtifactTarget,
    CompletedArtifact,
    ResearchArtifacts as Artifacts,
)
from ..kernel.utils import NotFoundError


_LOCAL_API_BASE = "http://127.0.0.1:8787"
_ARTIFACT_LIST_FIELDS = (
    "id",
    "target_type",
    "target_id",
    "role",
    "attempt_index",
    "lens_id",
    "path",
    "title",
    "size_bytes",
    "content_type",
    "status",
    "created_by",
    "created_at",
    "updated_at",
)


def _shell_quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"


def upload_command(
    *,
    base_url: str,
    path: str,
    token: str,
    route_code: Literal["u", "f"] = "u",
) -> str:
    """Return the V1 ready-to-run POSIX upload command."""
    if route_code not in ("u", "f"):
        raise ValueError(f"unknown artifact upload route: {route_code}")
    base = (base_url or _LOCAL_API_BASE).rstrip("/")
    url = f"{base}/api/artifacts/{route_code}/{token}"
    return f"curl -sf -T {_shell_quote(path)} {_shell_quote(url)}"


def pending_upload_v1(pending: PendingUpload, *, base_url: str = "") -> dict[str, Any]:
    return {
        "artifact_id": pending.artifact_id,
        "run": upload_command(
            base_url=base_url,
            path=pending.path,
            token=pending.token,
        ),
    }


def artifact_meta_v1(artifact: Artifact) -> dict[str, Any]:
    """Serialize metadata without ever exposing the bearer upload token."""
    return {
        "id": artifact.id,
        "project_id": artifact.project_id,
        "target_type": artifact.target_type,
        "target_id": artifact.target_id,
        "role": artifact.role,
        "attempt_index": artifact.attempt_index,
        "lens_id": artifact.lens_id,
        "path": artifact.path,
        "title": artifact.title,
        "content_sha256": artifact.sha256,
        "size_bytes": artifact.size_bytes,
        "content_type": artifact.content_type,
        "status": artifact.status,
        "expires_at": artifact.expires_at,
        "created_by": artifact.created_by,
        "created_at": artifact.created_at,
        "updated_at": artifact.updated_at,
        "created_seq": artifact.order,
        "submission_id": artifact.submission_id,
    }


def _artifact_list_item_v1(artifact: Artifact) -> dict[str, Any]:
    """The exact slim list shape, projected from the detail serializer."""
    detail = artifact_meta_v1(artifact)
    return {field: detail[field] for field in _ARTIFACT_LIST_FIELDS}


def artifact_list_v1(
    artifacts: tuple[Artifact, ...],
) -> dict[str, Any]:
    rows = [_artifact_list_item_v1(artifact) for artifact in artifacts]
    return {"artifacts": rows, "count": len(rows)}


def _is_textual_type(content_type: str) -> bool:
    base = content_type.split(";", 1)[0].strip().lower()
    return (
        not base
        or base.startswith("text/")
        or base in ("application/json", "application/xml")
        or base.endswith(("+json", "+xml"))
    )


def content_envelope_v1(artifact: Artifact) -> dict[str, Any]:
    content_type = artifact.content_type
    data = artifact.data
    text: str | None = None
    is_binary = False
    if data is not None:
        if not _is_textual_type(content_type) or b"\x00" in data:
            is_binary = True
        else:
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                is_binary = True
    return {
        "content": text,
        "is_binary": is_binary,
        "size_bytes": artifact.size_bytes,
        "content_type": content_type,
        "available": data is not None,
    }


def completed_artifact_v1(
    completed: CompletedArtifact, *, base_url: str
) -> dict[str, Any]:
    document_dir = completed.path.rsplit("/", 1)[0] if "/" in completed.path else ""
    return {
        "artifact_id": completed.artifact_id,
        "role": completed.role,
        "path": completed.path,
        "sha256": completed.sha256,
        "size_bytes": completed.size_bytes,
        "figures": [
            {
                "link_path": figure.link_path,
                "run": upload_command(
                    base_url=base_url,
                    path=(
                        f"{document_dir}/{figure.link_path}"
                        if document_dir
                        else figure.link_path
                    ),
                    token=figure.token,
                    route_code="f",
                ),
            }
            for figure in completed.figures
        ],
    }


def completed_figure_v1(completed: CompletedFigure) -> dict[str, Any]:
    return {
        "artifact_id": completed.artifact_id,
        "link_path": completed.link_path,
        "sha256": completed.sha256,
        "size_bytes": completed.size_bytes,
    }


@dataclass(frozen=True, slots=True)
class ArtifactTools:
    """Generic content storage and research association commands."""

    artifacts: Artifacts

    def store(
        self,
        *,
        project_id: str,
        path: str,
        title: str = "",
        discover_figures: bool = False,
        base_url: str = "",
    ) -> dict[str, Any]:
        """Upload generic immutable content without assigning research meaning."""
        pending = self.artifacts.contents.submit(
            project_id=project_id,
            path=path,
            title=title,
            discover_figures=discover_figures,
        )
        return pending_upload_v1(pending, base_url=base_url)

    def read(
        self, *, project_id: str, artifact_id: str, include_content: bool = False,
        base_url: str = "",
    ) -> dict[str, Any]:
        """Return metadata and a download URL using normal project/account auth."""
        found = self.artifacts.contents.get(
            artifact_ids=(artifact_id,),
            project_id=project_id,
            include="document" if include_content else "metadata",
        )
        _require_all((artifact_id,), found, project_id=project_id)
        artifact = found[0]
        result = {
            "download_url": (
                f"{(base_url or _LOCAL_API_BASE).rstrip('/')}"
                f"/api/projects/{quote(project_id, safe='')}/artifacts/{quote(artifact.id, safe='')}/file"
            ),
            "artifact": {
                field: getattr(artifact, field)
                for field in (
                    "id",
                    "project_id",
                    "path",
                    "title",
                    "sha256",
                    "size_bytes",
                    "content_type",
                    "status",
                    "created_by",
                    "created_at",
                    "updated_at",
                )
            }
        }
        if include_content:
            result["content"] = content_envelope_v1(artifact)
            result["artifact"]["figures"] = list(artifact.figures)
        return result

    def attach(
        self,
        *,
        project_id: str,
        artifact_id: str,
        target_type: str,
        target_id: str,
        role: str,
        lens_id: str = "",
    ) -> dict[str, Any]:
        association = self.artifacts.attach(
            artifact_id=artifact_id,
            target=ArtifactTarget(target_type, target_id, project_id),
            role=role,
            lens_id=lens_id,
        )
        return {
            "artifact_id": artifact_id,
            "association": artifact_meta_v1(association),
        }

    def submit(
        self,
        *,
        target_type: str,
        target_id: str,
        role: str,
        path: str,
        lens_id: str = "",
        title: str = "",
        project_id: str | None = None,
        base_url: str = "",
    ) -> dict[str, Any]:
        pending = self.artifacts.submit(
            target=ArtifactTarget(target_type, target_id, project_id),
            role=role,
            path=path,
            lens_id=lens_id,
            title=title,
        )
        return pending_upload_v1(pending, base_url=base_url)

    def find(
        self,
        *,
        project_id: str | None = None,
        artifact_id: str = "",
        artifact_ids: list[str] | None = None,
        include_content: bool = False,
        target_type: str = "",
        target_id: str = "",
        role: str = "",
    ) -> dict[str, Any]:
        requested_ids = tuple(dict.fromkeys(artifact_ids or ()))
        ids = (artifact_id,) if artifact_id else requested_ids
        if ids:
            artifacts = self.artifacts.get(
                artifact_ids=ids,
                project_id=project_id,
                include="document" if include_content else "metadata",
            )
            _require_all(ids, artifacts, project_id=project_id)
            if artifact_id:
                artifact = artifacts[0]
                result: dict[str, Any] = {"artifact": artifact_meta_v1(artifact)}
                if include_content:
                    result["content"] = content_envelope_v1(artifact)
                return result
            rows: list[dict[str, Any]] = []
            for artifact in artifacts:
                row = _artifact_list_item_v1(artifact)
                if include_content:
                    row["content"] = content_envelope_v1(artifact)
                rows.append(row)
            return {"artifacts": rows, "count": len(rows)}
        return artifact_list_v1(
            self.artifacts.scan(
                project_id=project_id,
                target_type=target_type,
                target_ids=(target_id,) if target_id else (),
                roles=(role,) if role else (),
            )
        )


def _require_all(
    requested: tuple[str, ...],
    found: tuple[Artifact, ...],
    *,
    project_id: str | None,
) -> None:
    found_ids = {artifact.id for artifact in found}
    missing = [artifact_id for artifact_id in requested if artifact_id not in found_ids]
    if not missing:
        return
    scope = f" in project {project_id}" if project_id is not None else ""
    if len(requested) == 1:
        raise NotFoundError(f"artifact not found{scope}: {missing[0]}")
    raise NotFoundError(
        f"artifacts not found{scope}: {', '.join(missing)}",
        details={
            "field": "artifact_ids",
            "artifact_ids": list(requested),
            "missing_artifact_ids": missing,
        },
    )
