# If you update this file, you must consult artifacts.md to see whether artifacts.md needs to be updated. artifacts.md must not exceed 100 lines.
"""MCP tool contracts for stored content.

Which targets and roles an association may name is research vocabulary: the
composition injects it and Artifacts renders it into the schema.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping

from pydantic import Field, model_validator

from ..kernel.tools import ContractModel, ProjectScopedInput, ToolContract


def artifact_tools(*, target_types: Iterable[str], roles: Iterable[str], lens_role: str) -> Mapping[str, ToolContract]:
    """The ``artifact.*`` table over the association vocabulary research declared."""

    class ArtifactAssociationInput(ContractModel):
        target_type: str = Field(
            min_length=1, json_schema_extra={"enum": sorted(target_types)}
        )
        target_id: str = Field(min_length=1)
        role: str = Field(min_length=1, json_schema_extra={"enum": sorted(roles)})
        lens_id: str = Field(
            default="",
            description=f"Required only for {lens_role}; identifies the roster lens.",
        )

        @model_validator(mode="after")
        def _check_lens(self) -> "ArtifactAssociationInput":
            if self.role == lens_role and not self.lens_id:
                raise ValueError(f"lens_id is required when role is {lens_role}")
            if self.lens_id and self.role != lens_role:
                raise ValueError(f"lens_id only applies to {lens_role} artifacts")
            return self

    class ArtifactUploadInput(ProjectScopedInput):
        path: str = Field(min_length=1, max_length=1000, description="Local file to send with the returned upload command; also its provenance label.")
        title: str = Field(default="", max_length=1000)
        discover_figures: bool = Field(default=False, description="Also upload the Markdown's relative images (unattached content; attached roles follow their figure policy).")
        attach_to: ArtifactAssociationInput | None = Field(default=None, description="Research association activated when the upload completes; omit for generic content.")

    class ArtifactAttachInput(ProjectScopedInput, ArtifactAssociationInput):
        artifact_id: str = Field(min_length=1)

    class ArtifactReadInput(ProjectScopedInput):
        artifact_id: str = Field(default="", description="One artifact; or artifact_ids for a batch; or neither to list by the filters.")
        artifact_ids: list[str] = Field(default_factory=list, max_length=50, description="1-50 ids in order; any missing or cross-project id fails the whole call.")
        include_content: bool = Field(default=False, description="Id reads only: add the text envelope (content, available, is_binary, size_bytes, content_type, truncated, next_offset).")
        max_bytes: int = Field(default=16000, ge=1, description="Text bytes per artifact; page with offset=next_offset.")
        offset: int = Field(default=0, ge=0, description="Byte offset the text window starts at.")
        target_type: str = Field(default="", description="List filter.")
        target_id: str = Field(default="", description="List filter.")
        role: str = Field(default="", description="List filter.")

        @model_validator(mode="after")
        def _check_selector(self) -> "ArtifactReadInput":
            if any(not item for item in self.artifact_ids):
                raise ValueError("artifact_ids cannot contain blank ids")
            self.artifact_ids = list(dict.fromkeys(self.artifact_ids))
            if self.artifact_id and self.artifact_ids:
                raise ValueError("provide at most one of artifact_id or artifact_ids")
            filters = [
                field
                for field in ("target_type", "target_id", "role")
                if getattr(self, field)
            ]
            if (self.artifact_id or self.artifact_ids) and filters:
                raise ValueError(
                    "id-based artifact reads cannot be combined with list filters"
                )
            if self.include_content and not (self.artifact_id or self.artifact_ids):
                raise ValueError("include_content requires artifact_id or artifact_ids")
            return self

    return {
        "artifact.upload": ToolContract(
            handler_identity="artifact_submissions.upload",
            needs_base_url=True,
            input_model=ArtifactUploadInput,
            description=(
                "Write the file locally, call this, then run the returned command (and any figure upload commands) to "
                "store it immutably. attach_to binds a research role at once; attached evidence is validated, capped at "
                "16 KB, and a new version replaces the current slot."
            ),
        ),
        "artifact.read": ToolContract(
            handler_identity="artifact_submissions.read",
            needs_base_url=True,
            input_model=ArtifactReadInput,
            description=(
                "Read one artifact_id, a batch of artifact_ids, or list evidence by target_type/target_id/role; "
                "include_content adds bounded text. Download URLs need project or account auth."
            ),
        ),
        "artifact.attach": ToolContract(
            handler_identity="artifact_submissions.attach",
            input_model=ArtifactAttachInput,
            description="Associate stored content with a research target and role; returns the association handle. Content stays immutable and reusable.",
        ),
    }
