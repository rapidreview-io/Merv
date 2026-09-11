"""Generic artifact tools and compatible research artifact wire shapes.

Artifacts owns immutable content; Research owns its associations. Surface owns dictionaries, shell
commands, and content classification exposed to MCP and HTTP callers.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import quote

from merv.shared.shell_commands import api_base, curl_upload_command

from ..artifacts import CompletedFigure, PendingUpload
from ..research_core import (
    Artifact,
    ArtifactTarget,
    CompletedArtifact,
    ResearchArtifacts as Artifacts,
)


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
    return curl_upload_command(
        base_url=base_url, path=path, route=f"/api/artifacts/{route_code}/{token}"
    )


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
    """Serialize metadata without ever exposing the bearer upload token.

    Content nothing associated keeps its own, slimmer shape: no association
    fields, and the digest under the name the content routes use.
    """
    if not artifact.target_type:
        return {
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
    return {
        "id": artifact.id,
        "artifact_id": artifact.artifact_id,
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

    def upload(
        self,
        *,
        project_id: str,
        path: str,
        title: str = "",
        discover_figures: bool = False,
        attach_to: dict[str, str] | None = None,
        base_url: str = "",
    ) -> dict[str, Any]:
        if attach_to is None:
            pending = self.artifacts.contents.submit(
                project_id=project_id,
                path=path,
                title=title,
                discover_figures=discover_figures,
            )
        else:
            pending = self.artifacts.submit(
                target=ArtifactTarget(
                    attach_to["target_type"], attach_to["target_id"], project_id
                ),
                role=attach_to["role"],
                lens_id=attach_to.get("lens_id", ""),
                path=path,
                title=title,
            )
        return pending_upload_v1(pending, base_url=base_url)

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

    def read(
        self,
        *,
        project_id: str,
        base_url: str = "",
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
            include = "document" if include_content else "metadata"
            rows = []
            for artifact in self.artifacts.resolve(
                artifact_ids=ids, project_id=project_id, include=include
            ):
                row = artifact_meta_v1(artifact)
                row["download_url"] = (
                    f"{api_base(base_url)}"
                    f"/api/projects/{quote(project_id, safe='')}/artifacts/{quote(artifact.id, safe='')}/file"
                )
                if include_content:
                    row["figures"] = list(artifact.figures)
                    row["content"] = content_envelope_v1(artifact)
                rows.append(row)
            if artifact_id:
                row = rows[0]
                result = {"artifact": row, "download_url": row.pop("download_url")}
                if include_content:
                    result["content"] = row.pop("content")
                return result
            return {"artifacts": rows, "count": len(rows)}
        return artifact_list_v1(
            self.artifacts.scan(
                project_id=project_id,
                target_type=target_type,
                target_ids=(target_id,) if target_id else (),
                roles=(role,) if role else (),
            )
        )
