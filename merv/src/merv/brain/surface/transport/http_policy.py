"""HTTP surface policy independent of FastAPI route wiring."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class HttpSurfacePolicy:
    restrict_cors: bool
    hosted_control: bool


# Session credentials fail closed. Every leased session may reach these support
# tools; the node it works declares everything else in its execution policy,
# and the gateway binds each scoped call to the leased instance.
SESSION_READ_BASELINE = frozenset(
    {
        "agent.hello",
        "project",
        "project.get",
        "project.list",
        "workflow.status_and_next",
        "workflow.catalog",
        "workflow.assignment",
        "workflow.history",
        "artifact.read",
        "feed.list",
        "storage.find",
        "storage.fetch",
    }
)
SESSION_WRITE_BASELINE = frozenset(
    {
        "artifact.upload",
        "artifact.attach",
        "feed.post",
        "feed.register",
        "storage.submit",
        "workflow.transition",
    }
)


@dataclass(frozen=True)
class ScopeRule:
    """One argument a session may only fill with the value research resolved."""

    field: str
    source: str
    tools: frozenset[str] = frozenset()

    def covers(self, tool: str, *, mutating: frozenset[str]) -> bool:
        return tool in self.tools if self.tools else tool in mutating


@dataclass(frozen=True)
class SessionExecution:
    """The node-declared policy a leased session carries, parsed once and fail-closed.

    A packet without a policy (or with an unreadable one) is read-only with no
    node-specific tools: the credential can look but never write.
    """

    read_only: bool = True
    tools: frozenset[str] = frozenset()
    mutating: frozenset[str] = frozenset()
    scope: tuple[ScopeRule, ...] = ()
    sandbox: bool = False
    workspace_mode: str = ""

    @classmethod
    def from_packet(cls, value: object) -> "SessionExecution":
        if not isinstance(value, dict) or "read_only" not in value:
            return cls()
        rules = []
        for item in value.get("scope") or ():
            if not isinstance(item, dict) or not str(item.get("field") or "") or not str(item.get("source") or ""):
                continue
            rules.append(ScopeRule(
                field=str(item["field"]), source=str(item["source"]),
                tools=frozenset(str(tool) for tool in item.get("tools") or () if str(tool)),
            ))
        workspace = value.get("workspace")
        return cls(
            read_only=bool(value.get("read_only")),
            tools=frozenset(str(tool) for tool in value.get("tools") or () if str(tool)),
            mutating=frozenset(str(tool) for tool in value.get("mutating") or () if str(tool)),
            scope=tuple(rules),
            sandbox=bool(value.get("sandbox")),
            workspace_mode=str(workspace.get("mode") or "") if isinstance(workspace, dict) else "",
        )

    @property
    def allowed_tools(self) -> frozenset[str]:
        """Effective allowlist: the baseline for the policy's read/write mode plus node tools."""
        baseline = SESSION_READ_BASELINE if self.read_only else SESSION_READ_BASELINE | SESSION_WRITE_BASELINE
        return baseline | self.tools
