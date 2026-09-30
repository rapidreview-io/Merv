"""External-provider regression for the separately maintained Sandboxes repo.

Load that repository's real fixtures with -p tests.conftest. This is deliberately
outside Merv's passing local-plugin suite: see README.md for the observed source
revision, command, and the provider contract.
"""

import asyncio
import pytest
from merv_sandboxes.lifecycle.queue import WorkKind
from merv_sandboxes.lifecycle.worker import LifecycleWorker
from merv_sandboxes.models import CreatePhase, SandboxState, Presence
from tests.helpers import settle
from tests.test_registry import _create

@pytest.mark.asyncio
async def test_terminal_report_cannot_precede_a_late_live_machine(container):
    row = await _create(container, idempotency_key='lean-late-create-probe')
    bound = await container.providers.resolve('team-a', 'fake')
    driver = bound.driver
    create = driver.create
    entered, release = asyncio.Event(), asyncio.Event()
    async def delayed(request):
        entered.set()
        await release.wait()
        return await create(request)
    driver.create = delayed
    a = LifecycleWorker(container)
    b = LifecycleWorker(container)
    items = await container.queue.claim(worker_id='lean-probe-a')
    provision = next(x for x in items if x.kind is WorkKind.PROVISION)
    running = asyncio.create_task(a.handle(provision))
    try:
        await asyncio.wait_for(entered.wait(), timeout=10)
        await container.registry.request_delete(namespace='team-a', sandbox_id=row.id)
        items = await container.queue.claim(worker_id='lean-probe-b')
        deletion = next(x for x in items if x.kind is WorkKind.DELETE)
        await b.handle(deletion)
        before = await container.registry.get_by_id(row.id)
        assert before.state is SandboxState.DELETING
        assert before.create_phase is CreatePhase.PENDING
        release.set()
        await asyncio.wait_for(running, timeout=10)
        after = await container.registry.get_by_id(row.id)
        presence = (await driver.presence(after.native_id)) if after.native_id else Presence.ABSENT
        assert not (before.state is SandboxState.STOPPED and presence is Presence.PRESENT), (
            "Sandboxes reported STOPPED before a paused create finished; "
            "that create then left a PRESENT machine behind the terminal report"
        )
        assert after.create_phase is CreatePhase.SETTLED
        await settle(container)
        final = await container.registry.get_by_id(row.id)
        assert final.state is SandboxState.STOPPED
        assert await driver.presence(final.native_id) is Presence.ABSENT
    finally:
        release.set()
        await running
        driver.create = create
