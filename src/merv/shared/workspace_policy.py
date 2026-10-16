"""How a session's code is laid out, as one value both sides read.

The brain declares this on a workflow node and freezes it into the assignment
packet; the runner reads the packet back and builds exactly what it says. Two
independent definitions of the same six fields could drift into a node the
runner refuses, so there is one, and it ships in the standalone runner archive
with no brain import.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, fields
from typing import Any

WORKSPACE_MODES = frozenset({"none", "ephemeral", "persistent"})
REFERENCE_BASE_PREFIX = "reference:"
_SEGMENT = re.compile(r"[A-Za-z0-9_.-]{1,80}")


@dataclass(frozen=True, slots=True)
class WorkspacePolicy:
    """``namespace`` is the branch and directory segment a session keeps;
    ``base`` is ``"central"`` or ``"reference:<kind>"``."""

    mode: str = "persistent"
    namespace: str = "workflows"
    base: str = "central"
    per_base: bool = False        # persistent branch keyed by instance AND base
    retain: bool = True           # keep the branch/worktree when the session ends
    advances_central: bool = False  # accepted work may advance the central ref

    @classmethod
    def from_execution(cls, execution: Mapping[str, Any]) -> WorkspacePolicy:
        """The policy a packet declares; fields it omits keep their default."""
        raw = execution.get("workspace")
        if raw is not None and not isinstance(raw, Mapping):
            raise ValueError("assignment execution.workspace must be an object")
        raw = raw or {}
        return cls(
            **{
                spec.name: type(spec.default)(value)
                for spec in fields(cls)
                if (value := raw.get(spec.name)) not in (None, "")
            }
        )

    @property
    def base_reference_kind(self) -> str:
        """The reference kind ``base`` names, or "" for the central ref."""
        prefix = REFERENCE_BASE_PREFIX
        return self.base[len(prefix):] if self.base.startswith(prefix) else ""

    def problems(self) -> list[str]:
        """Everything wrong with this layout, in the words both sides report."""
        issues = []
        if self.mode not in WORKSPACE_MODES:
            issues.append(f"unknown workspace mode {self.mode!r}")
        if self.base != "central" and not self.base_reference_kind:
            issues.append(f"unknown workspace base {self.base!r}")
        if not _SEGMENT.fullmatch(self.namespace):
            issues.append(
                f"workspace namespace is not a path segment: {self.namespace!r}"
            )
        return issues
