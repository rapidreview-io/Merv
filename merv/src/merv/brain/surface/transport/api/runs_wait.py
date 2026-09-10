"""Auth-exempt run-wait streams: one GET that blocks until a run ends.

``GET /wait/{sandbox_uid}/{label}/{sig}`` is how an agent on ANY platform waits
for detached ``merv_run`` work without holding a credential: the URL is the
capability, its tag is an HMAC over exactly the (sandbox_uid, label) it names,
and what it reveals is exactly what a waiter needs — that the run ended, and
how. Outputs, logs and receipts stay behind the authenticated tools.

Nothing is stored for a wait. Validity is re-derived from rows that already
exist, and only from BRAIN clocks (when this process last mirrored the run,
when it last read the box), never from a timestamp the sandbox wrote.

Every terminal answer — 410, 429, resolution, hold cap, a failure mid-stream —
ends with one ``MERV_RUNS_WAIT <state> <label>`` line, so a caller that only
greps for that prefix always learns what happened. Invalid signature, unknown
sandbox and lapsed validity are one answer on purpose: the endpoint is an
unauthenticated lookup, and three answers would be an oracle.
"""

from __future__ import annotations

import asyncio
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter
from fastapi.responses import Response, StreamingResponse

from ....infrastructure import RemoteSandboxes as SandboxEngine
from ....infrastructure import infrastructure_actor
from ....kernel.env import env_int
from ....kernel.secret_tokens import (
    MIN_WAIT_SECRET_BYTES,
    WAIT_ROUTE_PREFIX,
    wait_signature_matches,
)
from ....kernel.utils import parse_iso

MAX_STREAMS_ENV_VAR = "MERV_WAIT_MAX_STREAMS"
# How many waits this process will hold at once. Each is an idle async task
# plus one bounded DB read every poll, so the ceiling is about the reads and
# the sockets, not memory.
DEFAULT_MAX_STREAMS = 64
# One URL is one waiter re-arming, plus at most one overlap while it does.
PER_SIGNATURE_STREAMS = 2
# Reject-path budget: refused requests still cost an HMAC and a socket.
BUCKET_CAPACITY = 128.0
BUCKET_REFILL_PER_SECOND = 32.0

WAIT_POLL_SECONDS = 5.0
WAIT_HEARTBEAT_SECONDS = 20.0
# An hour, then the caller re-arms with the same URL. Bounded so a forgotten
# waiter cannot hold a slot for the life of the process.
WAIT_HOLD_CAP_SECONDS = 3600.0
# A terminal run answers for six hours after this process last saw it, so a
# waiter that reconnects late still gets its answer instead of a mystery.
WAIT_TERMINAL_GRACE_SECONDS = 6 * 3600.0
# Nothing stays valid past the paid-for lease plus a day. This is the ceiling
# for rows nothing ever reconciled; it moves with sandbox.extend by itself.
WAIT_LEASE_CEILING_SECONDS = 24 * 3600.0
WAIT_POOL_WORKERS = 6
# The ledger read opens a synchronous connection (Postgres when hosted), so it
# is bounded like every other blocking thing here: a database that does not
# answer costs this wait its cycle, never the loop every heartbeat runs on.
WAIT_FACTS_TIMEOUT_SECONDS = 5.0
# ...but a run of unanswered cycles is a failure, and the caller is better off
# re-arming its URL than heartbeating at a database that stopped talking.
WAIT_FACTS_MAX_TIMEOUTS = 3

_MAX_ECHO_CHARS = 128
# The wire format is line-oriented and the label arrives as caller-controlled
# path text, so anything outside merv_run's own charset — a percent-encoded
# newline above all — could otherwise forge a second protocol line.
_UNSAFE_LABEL_RE = re.compile(r"[^A-Za-z0-9._-]")


class _TokenBucket:
    """Process-wide entry budget, so the reject path has a cost ceiling too."""

    def __init__(self, *, capacity: float, per_second: float) -> None:
        self.capacity = capacity
        self.per_second = per_second
        self._tokens = capacity
        self._stamp = time.monotonic()
        self._guard = threading.Lock()

    def take(self) -> bool:
        with self._guard:
            now = time.monotonic()
            self._tokens = min(
                self.capacity, self._tokens + (now - self._stamp) * self.per_second
            )
            self._stamp = now
            if self._tokens < 1.0:
                return False
            self._tokens -= 1.0
            return True


class _StreamAdmission:
    """Concurrent-hold accounting: one ceiling process-wide, one per URL."""

    def __init__(self) -> None:
        self.limit = env_int(MAX_STREAMS_ENV_VAR, DEFAULT_MAX_STREAMS, strict=False)
        self.per_signature = PER_SIGNATURE_STREAMS
        self._held = 0
        self._by_signature: dict[str, int] = {}
        self._guard = threading.Lock()

    def acquire(self, *, signature: str) -> bool:
        with self._guard:
            if self._held >= self.limit:
                return False
            if self._by_signature.get(signature, 0) >= self.per_signature:
                return False
            self._held += 1
            self._by_signature[signature] = self._by_signature.get(signature, 0) + 1
            return True

    def release(self, *, signature: str) -> None:
        with self._guard:
            self._held = max(self._held - 1, 0)
            remaining = self._by_signature.get(signature, 0) - 1
            if remaining > 0:
                self._by_signature[signature] = remaining
            else:
                self._by_signature.pop(signature, None)

    def held(self) -> int:
        with self._guard:
            return self._held


class _Slot:
    """One admission, given back by whichever path reaches it first.

    Two paths must: the generator's finally, and the response's ASGI call for
    the client that vanishes before the body is ever iterated. A resolved
    stream runs both, so releasing twice must hand back nothing.
    """

    def __init__(self, *, signature: str) -> None:
        self.signature = signature
        self._guard = threading.Lock()
        self._held = True

    def release(self) -> None:
        with self._guard:
            if not self._held:
                return
            self._held = False
        _ADMISSION.release(signature=self.signature)


_BUCKET = _TokenBucket(
    capacity=BUCKET_CAPACITY, per_second=BUCKET_REFILL_PER_SECOND
)
_ADMISSION = _StreamAdmission()
# Its own pool: every blocking thing a wait does runs here — the receipt read
# blocks its thread for up to the acquire budget, and the ledger read is a
# synchronous connection — and starving the request threadpool of workers
# would stall unrelated routes.
_WAIT_POOL = ThreadPoolExecutor(
    max_workers=WAIT_POOL_WORKERS, thread_name_prefix="merv-wait"
)


@dataclass(frozen=True, slots=True)
class _Verdict:
    """hold, done (with the two facts a waiter gets), or gone."""

    state: str
    status: str = ""
    exit_code: str = "none"


_HOLD = _Verdict("hold")
_GONE = _Verdict("gone")


def _echo(label: str) -> str:
    """The label as it goes back on the wire, forced into merv_run's charset."""
    return _UNSAFE_LABEL_RE.sub("_", label)[:_MAX_ECHO_CHARS] or "_"


def _line(state: str, label: str, extra: str = "") -> str:
    tail = f" {extra}" if extra else ""
    return f"MERV_RUNS_WAIT {state} {label}{tail}\n"


def _plain(body: str, *, status_code: int) -> Response:
    return Response(
        content=body,
        status_code=status_code,
        media_type="text/plain",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


class _WaitStream(StreamingResponse):
    """A hold that gives its slot back even when the body never starts.

    Starlette only begins iterating the generator once the response has begun,
    so a client that disappears while the headers go out never reaches the
    generator's finally. The ASGI call is the one context that always runs.
    """

    def __init__(self, generator, *, slot: _Slot, **kwargs) -> None:
        super().__init__(generator, **kwargs)
        self.slot = slot

    async def __call__(self, scope, receive, send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            self.slot.release()


def _verdict(*, facts: dict | None, now: datetime) -> _Verdict:
    """Whether this URL still answers, and with what, from brain clocks only."""
    if facts is None:
        return _GONE
    lease = parse_iso(facts.get("expires_at"))
    if lease is not None and now > lease + timedelta(
        seconds=WAIT_LEASE_CEILING_SECONDS
    ):
        return _GONE
    if not facts.get("present"):
        # Registration lag: merv_run wrote its receipt and the mirror has not
        # read it yet. Only a live box can still be about to register one.
        return _HOLD if facts.get("sandbox_active") else _GONE
    status = str(facts.get("status") or "")
    if status == "running":
        return _HOLD
    observed = parse_iso(facts.get("observed_at"))
    if observed is not None and now > observed + timedelta(
        seconds=WAIT_TERMINAL_GRACE_SECONDS
    ):
        return _GONE
    exit_code = facts.get("exit_code")
    return _Verdict(
        "done",
        status=status,
        exit_code="none" if exit_code is None else str(int(exit_code)),
    )


async def _facts(
    *, sandboxes: SandboxEngine, sandbox_uid: str, label: str, subject: str | None = None
) -> dict | None:
    """The namespace-scoped service read every wait makes, off the loop and time-bounded.

    Raises ``TimeoutError`` when the service did not answer in the budget;
    the caller decides whether that is one lost cycle or the end of the hold.
    """
    loop = asyncio.get_running_loop()
    def observe():
        # Executor threads do not inherit request ContextVars. Restore only the
        # subject authenticated by the wait capability, then reset on all exits.
        with infrastructure_actor(subject):
            return sandboxes.run_wait_facts(sandbox_uid=sandbox_uid, label=label)

    return await asyncio.wait_for(
        loop.run_in_executor(
            _WAIT_POOL,
            observe,
        ),
        timeout=WAIT_FACTS_TIMEOUT_SECONDS,
    )


def build_router(
    *, sandboxes: SandboxEngine, secret: bytes | None = None
) -> APIRouter:
    """Mount the wait route, but only for a composition that named a key.

    A process-lifetime key would sign URLs that stop verifying at the next
    restart, so no key is no route: every composition that means to serve
    waits loads one explicitly, and a hosted one that named none fails its
    boot rather than handing agents URLs that quietly die.
    """
    api_router = APIRouter()
    if not secret:
        return api_router
    if len(secret) < MIN_WAIT_SECRET_BYTES:
        # The route is auth-exempt, so a short key here is a forgeable
        # capability no loader ever vetted — refuse to mount at all.
        raise ValueError(
            f"wait secret must be at least {MIN_WAIT_SECRET_BYTES} bytes"
        )

    @api_router.get(WAIT_ROUTE_PREFIX + "{sandbox_uid}/{label}/{sig}")
    async def wait_for_run(sandbox_uid: str, label: str, sig: str,
                           subject: str | None = None) -> Response:
        echo = _echo(label)
        if not _BUCKET.take():
            return _plain(_line("poll_error", echo, "rate_limited"), status_code=429)
        # The MAC decides before anything is looked up: a forged tag costs one
        # HMAC and touches no row, so this endpoint is not a sandbox probe.
        if not wait_signature_matches(
            key=secret, sandbox_uid=sandbox_uid, label=label, presented=sig, subject=subject
        ):
            return _plain(_line("no_such_run", echo), status_code=410)
        if not _ADMISSION.acquire(signature=sig):
            return _plain(_line("poll_error", echo, "rate_limited"), status_code=429)
        slot = _Slot(signature=sig)
        try:
            facts = await _facts(
                sandboxes=sandboxes, sandbox_uid=sandbox_uid, label=label, subject=subject
            )
            opening = _verdict(facts=facts, now=datetime.now(tz=UTC))
        except Exception:  # noqa: BLE001 — the slot must not leak on a bad read
            slot.release()
            return _plain(_line("poll_error", echo), status_code=500)
        except BaseException:
            # Cancellation lands here: no response object exists yet, so no
            # downstream finally can give this slot back.
            slot.release()
            raise
        if opening.state == "gone":
            slot.release()
            return _plain(_line("no_such_run", echo), status_code=410)

        async def hold(first: dict | None):
            loop = asyncio.get_running_loop()
            started = loop.time()
            beat = started - WAIT_HEARTBEAT_SECONDS
            facts = first
            timeouts = 0
            try:
                while True:
                    verdict = _verdict(facts=facts, now=datetime.now(tz=UTC))
                    if verdict.state == "done":
                        yield _line(
                            "done",
                            echo,
                            f"status={verdict.status} exit_code={verdict.exit_code}",
                        )
                        return
                    if verdict.state == "gone":
                        # Validity lapsed mid-hold; the headers are long gone,
                        # so the 410's grammar is all that is left to send.
                        yield _line("no_such_run", echo)
                        return
                    now = loop.time()
                    if now - started >= WAIT_HOLD_CAP_SECONDS:
                        yield _line("still_running", echo)
                        return
                    if now - beat >= WAIT_HEARTBEAT_SECONDS:
                        beat = now
                        # Never matches the MERV_RUNS_WAIT prefix, and the
                        # first one flushes the response past any proxy.
                        yield f"# waiting {int(now - started)}s\n"
                    await asyncio.sleep(WAIT_POLL_SECONDS)
                    try:
                        facts = await _facts(
                            sandboxes=sandboxes, sandbox_uid=sandbox_uid, label=label, subject=subject
                        )
                        timeouts = 0
                    except asyncio.TimeoutError:
                        timeouts += 1
                        if timeouts >= WAIT_FACTS_MAX_TIMEOUTS:
                            raise
                        # One unanswered read is a lost cycle, not an answer:
                        # keep the facts from last time and ask again.
            except Exception:  # noqa: BLE001 — say so rather than die silent
                yield _line("poll_error", echo)
            finally:
                # Also the disconnect path: a closed generator lands here, and
                # a slot a vanished client still holds is a slot lost forever.
                slot.release()

        return _WaitStream(
            hold(facts),
            slot=slot,
            media_type="text/plain",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    return api_router


__all__ = ["build_router"]
