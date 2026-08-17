"""HTTP surface policy independent of FastAPI route wiring."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class HostedToolPolicy:
    telemetry_from_review_request: bool = False
    telemetry_from_review_session: bool = False


@dataclass(frozen=True)
class HttpSurfacePolicy:
    restrict_cors: bool
    hosted_control: bool
    use_hosted_tool_policies: bool

    @classmethod
    def for_surface(
        cls,
        *,
        restrict_cors: bool,
        hosted_control: bool,
    ) -> "HttpSurfacePolicy":
        return cls(
            restrict_cors=restrict_cors,
            hosted_control=hosted_control,
            use_hosted_tool_policies=hosted_control,
        )


HOSTED_CONTROL_TOOL_POLICIES = {
    # The merged `project` tool (action=create reaches the brain) and the
    # UI-facing project.list are non-project-scoped control calls that must run
    # in hosted mode without a resolved project scope.
    "project": HostedToolPolicy(),
    "project.list": HostedToolPolicy(),
    "review.start": HostedToolPolicy(telemetry_from_review_request=True),
    # INV-9: a review session resolves its own project, so an mk_ key cannot
    # ride a foreign session id to mutate another project's review.
    "review.submit": HostedToolPolicy(telemetry_from_review_session=True),
}

# Session credentials fail closed: these are the only public tools a worker
# assigned to one experiment may reach. Per-target checks in the gateway bind
# every mutation and sandbox operation to that exact experiment.
AGENT_EXPERIMENT_SESSION_TOOLS = frozenset(
    {
        "agent.hello",
        "artifact.find",
        "artifact.submit",
        "claim.list",
        "experiment.exhibit",
        "experiment.get_state",
        "experiment.list",
        "experiment.transition",
        "feed.list",
        "feed.post",
        "feed.register",
        "litreview.cite",
        "litreview.view",
        "mlflow.context",
        "mlflow.finalize_run",
        "project",
        "project.get",
        "project.list",
        "review.request",
        "review.status",
        "sandbox.attach",
        "sandbox.extend",
        "sandbox.get",
        "sandbox.health",
        "sandbox.options",
        "sandbox.pull_outputs",
        "sandbox.release",
        "sandbox.request",
        "sandbox.runs",
        "sandbox.terminal",
        "storage.fetch",
        "storage.find",
        "storage.submit",
        "workflow.status_and_next",
    }
)

AGENT_REVIEW_SESSION_TOOLS = frozenset(
    {
        "agent.hello",
        "artifact.find",
        "claim.list",
        "consolidation.get",
        "experiment.get_state",
        "experiment.list",
        "litreview.view",
        "project",
        "project.get",
        "project.list",
        "review.start",
        "review.status",
        "review.submit",
        "workflow.status_and_next",
    }
)

AGENT_CONSOLIDATION_SESSION_TOOLS = frozenset(
    {
        "agent.hello",
        "consolidation.get",
        "consolidation.submit",
        "experiment.get_state",
        "experiment.list",
        "project",
        "project.get",
        "project.list",
        "reflection.get",
        "review.request",
        "review.status",
    }
)
