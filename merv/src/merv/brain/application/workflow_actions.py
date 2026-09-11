"""Live delivery of workflow requests through existing support capabilities."""

from __future__ import annotations

from collections.abc import Mapping
import logging
from threading import Event, Thread
from typing import Protocol

from ..research_core import Research
from ..agent_sessions import AgentSessions
from ..workflows import Delivery, Workflows

LOGGER = logging.getLogger(__name__)


class Handler(Protocol):
    """Serve one queued effect kind through the root that owns it."""
    def __call__(self, delivery: Delivery) -> None: ...


def research_effects(*, research: Research, sessions: AgentSessions) -> dict[str, Handler]:
    """The two effect kinds a research graph queues, bound to the roots that serve
    them. A program names the effects it emits; the root decides what serves each."""

    def start(delivery: Delivery) -> None:
        data = dict(delivery.data)
        research.workflows.start(project_id=delivery.project_id,
                                 request_id=str(data.pop("request_id", delivery.id)), **data)

    def review(delivery: Delivery) -> None:
        research.reviews.request(project_id=delivery.project_id, expected_revision=delivery.revision,
                                 producer_session_id=sessions.workflow_producer(
                                     project_id=delivery.project_id, instance_id=delivery.instance_id,
                                     revision=delivery.revision - 1) or "main",
                                 if_current=True, **dict(delivery.data))

    return {"workflow.start": start, "review.request": review}


class WorkflowDeliveries:
    def __init__(self, *, workflows: Workflows, handlers: Mapping[str, Handler]) -> None:
        self.workflows = workflows
        self.handlers = dict(handlers)
        self._stop = Event()
        self._thread: Thread | None = None

    def run_once(self, *, project_id: str | None = None, renew_interval_seconds: int = 30):
        # Review capabilities expire independently of workflow revisions. Keep
        # reconciling that desired request until the waiting node changes.
        self.workflows.deliveries.renew("review.request", interval_seconds=renew_interval_seconds)
        return self.workflows.deliveries.drain(self.handlers, project_id=project_id)

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = Thread(target=self._run, name="workflow-actions", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.wait(5):
            try:
                self.run_once()
            except Exception:
                LOGGER.exception("workflow action delivery will retry")

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=30)
