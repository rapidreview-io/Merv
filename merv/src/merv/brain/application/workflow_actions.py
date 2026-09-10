"""Live delivery of workflow requests through existing support capabilities."""

from __future__ import annotations

import logging
from threading import Event, Thread

from ..research_core import Research
from ..agent_sessions import AgentSessions
from ..workflows import Delivery, Workflows

LOGGER = logging.getLogger(__name__)


class WorkflowDeliveries:
    def __init__(self, *, workflows: Workflows, research: Research, sessions: AgentSessions) -> None:
        self.workflows, self.research = workflows, research
        self.sessions = sessions
        self.handlers = {"workflow.start": self._start, "review.request": self._review}
        self._stop = Event()
        self._thread: Thread | None = None

    def _start(self, delivery: Delivery) -> None:
        data = dict(delivery.data)
        self.workflows.start(project_id=delivery.project_id, request_id=str(data.pop("request_id", delivery.id)), **data)

    def _review(self, delivery: Delivery) -> None:
        self.research.reviews.request(project_id=delivery.project_id, expected_revision=delivery.revision,
                                     producer_session_id=self.sessions.workflow_producer(
                                         project_id=delivery.project_id, instance_id=delivery.instance_id,
                                         revision=delivery.revision - 1) or "main",
                                     if_current=True, **dict(delivery.data))

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
