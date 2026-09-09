"""Composing an app must not leave a worker running against disposed state."""

from fastapi.testclient import TestClient

from tests.research_core.scenarios import ResearchCase


class WorkflowLifecycleTest(ResearchCase):
    def test_only_serving_starts_the_worker_and_lifespan_shutdown_joins_it(self):
        deliveries = self.app.application.workflow_deliveries
        self.assertIsNone(deliveries._thread)
        with TestClient(self.app.fastapi_app):
            first = deliveries._thread
            self.assertTrue(first.is_alive())
            deliveries.start()
            self.assertIs(deliveries._thread, first)
        self.assertFalse(first.is_alive())
        with TestClient(self.app.fastapi_app):
            resumed = deliveries._thread
            self.assertTrue(resumed.is_alive())
            self.assertIsNot(resumed, first)
        self.assertFalse(resumed.is_alive())
