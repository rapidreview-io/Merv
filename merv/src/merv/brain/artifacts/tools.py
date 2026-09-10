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
        path: str = Field(
            min_length=1,
            max_length=1000,
            description="Local file to send with the returned upload command; also its provenance label.",
        )
        title: str = Field(default="", max_length=1000)
        discover_figures: bool = Field(
            default=False,
            description="Discover relative Markdown images for unattached content. Attached documents follow their role's figure policy.",
        )
        attach_to: ArtifactAssociationInput | None = Field(
            default=None,
            description="Optional research association, activated when the upload completes. Omit to store generic content.",
        )

    class ArtifactAttachInput(ProjectScopedInput, ArtifactAssociationInput):
        artifact_id: str = Field(min_length=1)

    class ArtifactReadInput(ProjectScopedInput):
        artifact_id: str = Field(
            default="",
            description=(
                "Resolve one artifact by id. Use artifact_ids for an ordered batch, "
                "or omit both to list with the filters below."
            ),
        )
        artifact_ids: list[str] = Field(
            default_factory=list,
            max_length=50,
            description=(
                "Resolve 1-50 artifacts in one call. Duplicate ids are de-duplicated "
                "in first-seen order. Any missing or cross-project id fails the "
                "whole request."
            ),
        )
        include_content: bool = Field(
            default=False,
            description=(
                "Opt in to bounded submitted text for id-based reads. Metadata is "
                "the slim default. Singular reads add a sibling content envelope; "
                "plural reads add that envelope to each artifact row. It contains "
                "content, available, is_binary, size_bytes, and content_type; "
                "binary or unavailable bytes are never injected as text. Invalid "
                "when listing by filters."
            ),
        )
        target_type: str = Field(
            default="", description="List filter: the target kind of the association."
        )
        target_id: str = Field(default="", description="List filter: target id.")
        role: str = Field(default="", description="List filter: artifact role.")

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
                "Write a local file, call upload, then execute the returned run command "
                "to store immutable content in Merv. Optional attach_to bundles research "
                "association: specify target_type, target_id, role and lens_id when required. "
                "Associated evidence is validated and size-capped at 16 KB; uploading a new "
                "version replaces the current slot while preserving frozen history. "
                "Run any figure upload commands returned by the upload response too."
            ),
        ),
        "artifact.read": ToolContract(
            handler_identity="artifact_submissions.read",
            needs_base_url=True,
            input_model=ArtifactReadInput,
            description=(
                "Read one artifact_id, an ordered batch of 1-50 artifact_ids, or list "
                "complete research evidence using target_type/target_id/role filters. "
                "IDs may identify generic content or research associations; associations "
                "include their target, role and history. Missing/cross-project IDs fail the "
                "whole batch. Opt into text and figure paths with include_content. ID reads "
                "include download URLs requiring project/account auth (not worker credentials)."
            ),
        ),
        "artifact.attach": ToolContract(
            handler_identity="artifact_submissions.attach",
            input_model=ArtifactAttachInput,
            description="Associate existing complete content with a research target and role. Returns an association handle for artifact.read and workflow history; content remains immutable and reusable.",
        ),
    }
