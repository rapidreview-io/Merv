"""Concurrent/recovered delivery leases keep one current authority."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

from merv.brain.kernel.state.store import StateStore
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


def test_concurrent_delivery_claim_and_expired_recovery_have_one_winner(tmp_path):
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


def test_stale_selection_cannot_replace_a_fresh_delivery_lease(tmp_path):
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


def test_external_effect_fences_expired_workers_and_stops_automatic_replay(tmp_path):
    store, deliveries, project_id = pending_action(tmp_path)
    old = deliveries.claim(project_id=project_id)
    with store.transaction() as conn:
        conn.execute("UPDATE workflow_actions SET lease_until = '' WHERE id = ?", (old.id,))
    current = deliveries.claim(project_id=project_id)
    assert not deliveries.protect_external_effect(old, reason="stale worker")
    assert deliveries.protect_external_effect(current, reason="Inspect the external run before repair")
    with store.transaction() as conn:
        conn.execute("UPDATE workflow_actions SET lease_until = '', next_attempt_at = '' WHERE id = ?", (current.id,))
    # Even a process death after the reservation cannot authorize a second create.
    with ThreadPoolExecutor(max_workers=4) as pool:
        assert list(pool.map(lambda _: deliveries.claim(project_id=project_id), range(4))) == [None] * 4
    assert deliveries.settle(current, error="remote run exists; database acknowledgement lost")
    row = deliveries.history(project_id=project_id, instance_id=current.instance_id)[0]
    assert row["status"] == "manual_repair"
    assert "acknowledgement lost" in row["last_error"]
    assert deliveries.claim(project_id=project_id) is None
    deliveries.resolve_manual_repair(project_id=project_id, instance_id=current.instance_id, kind="save")
    assert deliveries.history(project_id=project_id, instance_id=current.instance_id)[0]["status"] == "delivered"


def test_failure_before_external_reservation_keeps_ordinary_retry(tmp_path):
    store, deliveries, project_id = pending_action(tmp_path)
    first = deliveries.claim(project_id=project_id)
    assert deliveries.settle(first, error="temporary input read failed")
    with store.transaction() as conn:
        conn.execute("UPDATE workflow_actions SET next_attempt_at = '' WHERE id = ?", (first.id,))
    retry = deliveries.claim(project_id=project_id)
    assert retry.id == first.id
    assert retry.attempts == 2
    assert deliveries.protect_external_effect(retry, reason="external write")
    assert deliveries.settle(retry)
    assert deliveries.history(project_id=project_id, instance_id=retry.instance_id)[0]["status"] == "delivered"
