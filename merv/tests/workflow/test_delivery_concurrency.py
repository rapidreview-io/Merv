"""Concurrent/recovered delivery leases keep one current authority."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from types import SimpleNamespace
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from merv.brain.kernel.state.store import StateStore
from merv.brain.workflows.persistence import WORKFLOW_SCHEMA
from merv.brain.workflows import (
    Action,
    Change,
    Deliveries,
    Edge,
    Node,
    Registry,
    Runtime,
    Workflow,
)


def pending_action(tmp_path):
    store = StateStore(db_path=tmp_path / "state.sqlite")
    store.install(WORKFLOW_SCHEMA)
    with store.transaction() as conn:
        project_id = conn.execute("SELECT id FROM projects LIMIT 1").fetchone()["id"]
    definition = Workflow(
        "effects", 1, "work", (Node("work"),),
        (Edge("work", "finish", "done", change=lambda snapshot, payload, knowledge: Change(actions=(Action("save"),))),),
        {"done": "complete"},
    )
    runtime = Runtime(store=store, registry=Registry((definition,)))
    instance = runtime.start(project_id=project_id, workflow="effects", request_id="start")
    runtime.apply(project_id=project_id, instance_id=instance.id, action="finish", expected_revision=0, request_id="finish")
    return store, Deliveries(store=store), project_id


class DeliveryConcurrencyTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp_path = Path(tmp.name)

    def test_concurrent_delivery_claim_and_expired_recovery_have_one_winner(self):
        tmp_path = self.tmp_path
        store, deliveries, project_id = pending_action(tmp_path)

        def contend():
            with ThreadPoolExecutor(max_workers=4) as pool:
                return [value for value in pool.map(lambda _: deliveries.claim(project_id=project_id), range(4)) if value is not None]

        first = contend()
        assert len(first) == 1
        with store.transaction() as conn:
            conn.execute("UPDATE workflow_actions SET lease_until = '' WHERE id = ?", (first[0].id,))
        recovered = contend()
        assert len(recovered) == 1
        assert recovered[0].id == first[0].id
        assert recovered[0].lease_token != first[0].lease_token
        assert recovered[0].attempts == 2
        assert not deliveries.settle(first[0], error="late original worker")
        assert deliveries.settle(recovered[0])
        assert deliveries.claim(project_id=project_id) is None



    def test_stale_selection_cannot_replace_a_fresh_delivery_lease(self):
        tmp_path = self.tmp_path
        store, deliveries, project_id = pending_action(tmp_path)
        with store.transaction() as conn:
            selected_before_competitor = conn.execute("SELECT * FROM workflow_actions").fetchone()
        winner = deliveries.claim(project_id=project_id)
        original_transaction = store.transaction

        @contextmanager
        def stale_selection_transaction():
            with original_transaction() as conn:
                def execute(sql, parameters=()):
                    if sql.startswith("SELECT * FROM workflow_actions WHERE"):
                        return SimpleNamespace(fetchone=lambda: selected_before_competitor)
                    return conn.execute(sql, parameters)
                yield SimpleNamespace(execute=execute)

        # Model a read committed selection that another worker claimed before our
        # lease write. This assertion doesn't depend on the store's broad writer lock.
        with patch.object(store, "transaction", stale_selection_transaction):
            assert deliveries.claim(project_id=project_id) is None
        assert deliveries.settle(winner)



    def test_failed_delivery_returns_to_the_queue_and_retries(self):
        tmp_path = self.tmp_path
        store, deliveries, project_id = pending_action(tmp_path)
        first = deliveries.claim(project_id=project_id)
        assert deliveries.settle(first, error="temporary input read failed")
        with store.transaction() as conn:
            conn.execute("UPDATE workflow_actions SET next_attempt_at = '' WHERE id = ?", (first.id,))
        retry = deliveries.claim(project_id=project_id)
        assert retry.id == first.id
        assert retry.attempts == 2
        assert deliveries.settle(retry)
        assert deliveries.history(project_id=project_id, instance_id=retry.instance_id)[0]["status"] == "delivered"
