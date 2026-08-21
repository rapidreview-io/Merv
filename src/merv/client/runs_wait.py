"""runs-wait: the one watcher an agent arms to be woken when a run ends.

Every agent platform can background a process and notice when it exits, and
almost none of them can be woken any other way. So that is what this ships: a
process that blocks while a detached ``merv_run`` runs, and whose EXIT — plus
the single line it leaves on stdout — is the wake signal.

Two ways in, one grammar out. With a signed ``wait_url`` from a sandbox.runs
row it is one streaming GET and no credential at all; without one it is
authenticated polling of sandbox.runs over the same wire ``merv-client env``
prints. Either way the last line of stdout is
``MERV_RUNS_WAIT <state> <label> [status=... exit_code=...]`` and the exit code
is the state, so a platform can watch whichever of the two it can see.

Exit 0 means the run reached a TERMINAL state — the observation completed, not
that the work succeeded; the caller branches on ``status=``/``exit_code=``.
Exit 2 (timed out) and 3 (the wait itself failed) both mean re-arm. Exit 4 is
the only conclusive absence.

Stdlib only, like the rest of ``merv.client``: this runs from a bare python3
on a machine that installed nothing.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import signal
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Sequence
from typing import Any

from merv.shared.client_config import (
    AGENT_SESSION_KEY_ENV_VAR,
    dual_env_value,
    resolve_client_control_url,
)


MCP_KEY_ENV_VAR = "MERV_MCP_KEY"

FINAL_PREFIX = "MERV_RUNS_WAIT "
DONE = "done"
STILL_RUNNING = "still_running"
POLL_ERROR = "poll_error"
NO_SUCH_RUN = "no_such_run"
# The wake contract. 0 says the observation finished, never that the workload
# succeeded; 2 and 3 both mean "re-arm"; 4 is the one conclusive absence.
EXIT_CODES = {DONE: 0, STILL_RUNNING: 2, POLL_ERROR: 3, NO_SUCH_RUN: 4}

# Never two authenticated polls closer together than this, whatever the server
# did with wait_seconds.
POLL_FLOOR_SECONDS = 5.0
# sandbox.runs' own long poll, at the documented ceiling: a finished run wakes
# this process seconds later instead of at the next tick.
LONG_POLL_SECONDS = 45
# merv_run writes its receipt on the box before the brain has mirrored it, so a
# label the mirror has never heard of is registration lag until this has passed.
REGISTRATION_GRACE_SECONDS = 90.0
# The server's hold cap, so both modes hand the caller back at the same rhythm.
DEFAULT_DEADLINE_SECONDS = 3600.0
# Per READ, not per stream: a hold lasts up to the cap and heartbeats every
# ~20s, so this only fires on a connection that actually died.
STREAM_READ_TIMEOUT_SECONDS = 120.0
# Headroom over the long poll the server is holding for us.
KEYED_CALL_MARGIN_SECONDS = 30.0
# ...and over the caller's own deadline: one socket operation may outlive it by
# this much, nothing may outlive it by more.
KEYED_OVERRUN_SECONDS = 5.0
# A body arrives in pieces, and one piece at a time is what lets a read be
# abandoned on a clock instead of on the socket's own timeout.
READ_CHUNK_BYTES = 65536
# The wall clock is joined a hair past the budget it enforces: handing back
# early would read as a failed call rather than as the deadline it is.
JOIN_MARGIN_SECONDS = 0.05

# `finished`, `lost` and `unknown` are all ends of the observation; only
# `running` is a reason to keep waiting.
TERMINAL_RUN_STATUSES = frozenset({"finished", "lost", "unknown"})

_MAX_ECHO_CHARS = 128
# The server forces its echoed label into merv_run's charset before it goes on
# the wire; this side must too, or a crafted label could forge a second
# protocol line and wake a platform with an answer nobody sent.
_UNSAFE_LABEL_RE = re.compile(r"[^A-Za-z0-9._-]")
# What `done` has to actually say. A state token alone is not an outcome: the
# two facts are the whole reason exit 0 licenses the caller to move on. The
# shim spells this same grammar in shell as DONE_LINE_RE (bin/merv-runs-wait),
# because it validates the line this process wrote without being able to import
# anything; the two must be changed together, and the end-to-end test that
# drives a `done` through the shim is the seam that says so.
_FACTS_RE = re.compile(
    rf"^status=({'|'.join(sorted(TERMINAL_RUN_STATUSES))}) exit_code=(-?\d+|none)$"
)


class UsageError(Exception):
    """A bad invocation. Never argparse's SystemExit(2): 2 is still_running."""


class _Terminated(Exception):
    """SIGTERM or SIGHUP, in a shape this process can answer.

    Its default action is a silent 143 with an empty stdout — the one way a
    platform's own teardown can leave the watcher looking like a crash.
    """


class PollError(Exception):
    """A poll that could not answer: transport, auth, or a refused call."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def echo(label: str) -> str:
    """The label as it may go on the wire, in merv_run's own charset."""
    return _UNSAFE_LABEL_RE.sub("_", label)[:_MAX_ECHO_CHARS] or "_"


def final_line(state: str, label: str, extra: str = "") -> str:
    tail = f" {extra}" if extra else ""
    return f"{FINAL_PREFIX}{state} {label}{tail}"


def exit_code_for(line: str) -> int:
    return EXIT_CODES.get(_state_of(line), EXIT_CODES[POLL_ERROR])


def _state_of(line: str) -> str:
    if not line.startswith(FINAL_PREFIX):
        return ""
    return line[len(FINAL_PREFIX):].split(" ", 1)[0]


def _note(line: str) -> None:
    """Progress goes to stderr; stdout is reserved for the answer."""
    if line:
        _diagnostic(line)


def _diagnostic(text: str) -> None:
    """Everything that is not the answer, and never at the answer's expense.

    These are notes for a human. A stderr that was closed, replaced or hung up
    must not turn one into an exception the caller reads as a crash — and it
    must never fall back to stdout, which carries the wake signal alone.
    """
    stream = sys.stderr
    if stream is None:
        return
    with contextlib.suppress(Exception):
        stream.write(text if text.endswith("\n") else f"{text}\n")
        stream.flush()


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """Refuses every hop. Both URLs this client opens are canonical — a signed
    wait URL and the configured control URL — so a 3xx is a misconfiguration,
    and following one would hand MERV_MCP_KEY to whatever answered."""

    def redirect_request(self, *args, **kwargs) -> None:  # noqa: D102 — hook
        return None


# Unhandled by the redirect handler, a 3xx falls through to urllib's default
# error handler and arrives as an HTTPError, like any other refusal.
_OPENER = urllib.request.build_opener(_NoRedirects())


def _is_redirect(exc: urllib.error.HTTPError) -> bool:
    return 300 <= int(exc.code) < 400


# ---------- url mode: one streaming GET, no credential ----------


def watch_url(
    url: str,
    *,
    read_timeout: float = STREAM_READ_TIMEOUT_SECONDS,
    note: Callable[[str], None] = _note,
) -> str:
    """Hold the signed wait URL open until the server states an outcome.

    The server's own grammar line is the answer and is relayed verbatim; a
    stream that ends without one told us nothing, which is poll_error even
    when the socket closed cleanly.
    """
    label = _label_from_wait_url(url)
    if urllib.parse.urlsplit(url).scheme not in ("http", "https"):
        return final_line(POLL_ERROR, label, "bad_url")
    try:
        response: Any = _OPENER.open(url, timeout=read_timeout)
        status = int(getattr(response, "status", 0) or 0)
    except urllib.error.HTTPError as exc:
        if _is_redirect(exc):
            return final_line(POLL_ERROR, label, "redirect")
        # A refusal is a response: 410 and 429 carry their own protocol line.
        response, status = exc, int(exc.code)
    except (urllib.error.URLError, OSError):
        return final_line(POLL_ERROR, label, "transport")
    with contextlib.closing(response):
        try:
            for raw in response:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith(FINAL_PREFIX):
                    note(line)  # heartbeats are progress, not answers
                    continue
                return _relayed(line, label=label)
        except (urllib.error.URLError, OSError):
            return final_line(POLL_ERROR, label, "transport")
    if status == 410:
        return final_line(NO_SUCH_RUN, label)
    if status == 429:
        return final_line(POLL_ERROR, label, "rate_limited")
    return final_line(POLL_ERROR, label, "no_final_line")


def _relayed(line: str, *, label: str) -> str:
    """The server's line verbatim — but only once it is a whole answer.

    The state token alone is not one: a truncated line, a line naming another
    run, or a `done` without its two facts would each wake the caller with an
    outcome nobody stated, and `done` is the one that ends the waiting.
    """
    body = line[len(FINAL_PREFIX):] if line.startswith(FINAL_PREFIX) else ""
    state, _, rest = body.partition(" ")
    echoed, _, facts = rest.partition(" ")
    if state not in EXIT_CODES or echoed != label:
        return final_line(POLL_ERROR, label, "malformed")
    if state == DONE and not _FACTS_RE.match(facts):
        return final_line(POLL_ERROR, label, "malformed")
    return line


def _label_from_wait_url(url: str) -> str:
    """The label out of /wait/{sandbox_uid}/{label}/{sig}, echo-safe."""
    parts = urllib.parse.urlsplit(url).path.strip("/").split("/")
    if len(parts) < 3:
        return "_"
    return echo(urllib.parse.unquote(parts[-2]))


# ---------- keyed mode: authenticated polling of sandbox.runs ----------


def watch_keyed(
    *,
    sandbox_uid: str,
    label: str,
    deadline: float,
    call: Callable[..., dict[str, Any]],
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> str:
    """Poll sandbox.runs for one (sandbox_uid, label) until it settles.

    Two clocks bound the loop and neither may bend the other: no two calls are
    ever closer together than the floor, and the deadline is never crossed by
    issuing one more call — whichever comes first simply ends the wait.

    The deadline bounds the call in flight too, not just the cadence: each call
    is handed what is left of it, and a call that spends the rest of it answers
    still_running, because a wait that ran out of time learned nothing.
    """
    echoed = echo(label)
    started = monotonic()
    next_poll = started
    seen = False
    while True:
        delay = min(next_poll, started + deadline) - monotonic()
        if delay > 0:
            sleep(delay)
        elapsed = monotonic() - started
        if elapsed >= deadline:
            return final_line(STILL_RUNNING, echoed)
        if not seen and elapsed >= REGISTRATION_GRACE_SECONDS:
            return final_line(NO_SUCH_RUN, echoed)
        # An unregistered label answers immediately however long the poll asks
        # for, so the grace window is short calls in a loop; only a run the
        # mirror already knows earns sandbox.runs' own long poll.
        budget = int(min(LONG_POLL_SECONDS, deadline - elapsed)) if seen else 0
        next_poll = monotonic() + POLL_FLOOR_SECONDS
        try:
            view = call(
                sandbox_uid=sandbox_uid,
                wait_seconds=budget,
                remaining=deadline - elapsed,
            )
        except PollError as exc:
            if monotonic() - started >= deadline:
                # A call that spent the whole deadline says nothing about the
                # run; the deadline is the true answer, and it re-arms cleanly.
                return final_line(STILL_RUNNING, echoed)
            return final_line(POLL_ERROR, echoed, exc.reason)
        run = _row_for(view, sandbox_uid=sandbox_uid, label=label)
        if run is not None:
            seen = True
            status = str(run.get("status") or "")
            if status in TERMINAL_RUN_STATUSES:
                return final_line(DONE, echoed, _facts(run, status=status))
        if monotonic() - started >= deadline:
            # An answered call may still have outlived the deadline: hand back
            # here rather than sleep toward a call this loop must not make.
            return final_line(STILL_RUNNING, echoed)


def _row_for(
    view: dict[str, Any], *, sandbox_uid: str, label: str
) -> dict[str, Any] | None:
    """The one run this watcher named. Labels are unique per sandbox only, so
    an experiment-scoped listing can carry a namesake from another box."""
    for run in view.get("runs") or []:
        if not isinstance(run, dict) or str(run.get("label") or "") != label:
            continue
        uid = str(run.get("sandbox_uid") or "")
        if uid and uid != sandbox_uid:
            continue
        return run
    return None


def _facts(run: dict[str, Any], *, status: str) -> str:
    """The two facts a waiter gets, spelled exactly as the server spells them."""
    code = run.get("exit_code")
    rendered = "none"
    if code is not None:
        with contextlib.suppress(TypeError, ValueError):
            rendered = str(int(code))
    return f"status={status} exit_code={rendered}"


def call_sandbox_runs(
    *,
    control_url: str,
    key: str,
    project_id: str,
    sandbox_uid: str,
    wait_seconds: int,
    remaining: float | None = None,
) -> dict[str, Any]:
    """One sandbox.runs call on the same HTTP MCP wire merv-client prints.

    ``remaining`` is the caller's hard budget, and the WHOLE call answers to
    it — connect, headers and body together — because urllib's timeout is per
    socket OPERATION and a call is many of them: a server that stalls between
    two ops, or dribbles keepalives inside one, outlasts any setting of it.
    The per-op timeout stays as the inner belt; the budget is the wall.
    """
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "sandbox.runs",
            "arguments": {
                "project_id": project_id,
                "sandbox_uid": sandbox_uid,
                "wait_seconds": wait_seconds,
            },
        },
    }
    request = urllib.request.Request(
        f"{control_url}/mcp",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            # Streamable HTTP may answer either way, and a long poll usually
            # streams — its keepalive comments are what cross a proxy.
            "Accept": "application/json, text/event-stream",
        },
    )
    held = wait_seconds + KEYED_CALL_MARGIN_SECONDS
    budget = held if remaining is None else max(remaining, 0.0)
    timeout = max(1.0, min(held, budget + KEYED_OVERRUN_SECONDS))
    try:
        body = _fetch_within(request, timeout=timeout, budget=budget)
    except urllib.error.HTTPError as exc:
        # A credential rode on this request, so a hop is a disclosure, not a
        # transport hiccup: name it, and never let the opener follow it.
        reason = "redirect" if _is_redirect(exc) else f"http_{int(exc.code)}"
        raise PollError(reason) from exc
    except (urllib.error.URLError, OSError) as exc:
        raise PollError("transport") from exc
    return tool_view(body)


def _fetch_within(request: Any, *, timeout: float, budget: float) -> str:
    """The whole call under ONE wall clock, whatever the socket is doing.

    No arrangement of urllib's per-operation timeout bounds a call: a connect
    that hangs, headers that never come and a body that dribbles are three
    separate operations, each free to spend the timeout again. So the blocking
    work runs where it can be WALKED AWAY FROM — a daemon thread, which can
    never hold this process open — and the budget is spent joining it. The
    socket is torn down on the way out so the abandoned read gives up too.
    """
    stop = time.monotonic() + budget
    live: list[Any] = []  # the response, from the moment there is one
    done: list[Any] = []  # the body, or whatever was raised getting it

    def _fetch() -> None:
        try:
            response = _OPENER.open(request, timeout=timeout)
            live.append(response)
            with contextlib.closing(response):
                done.append(_read_until(response, stop=stop))
        except BaseException as exc:  # noqa: BLE001 — relayed, not handled
            done.append(exc)

    worker = threading.Thread(target=_fetch, name="merv-runs-wait", daemon=True)
    worker.start()
    worker.join(max(budget, 0.0) + JOIN_MARGIN_SECONDS)
    if worker.is_alive():
        for response in live:
            _abandon(response)
        raise PollError("timeout")
    outcome = done[0] if done else PollError("transport")
    if isinstance(outcome, BaseException):
        raise outcome
    return str(outcome)


def _abandon(response: Any) -> None:
    """Tear the socket down under the worker still reading it.

    Closing need not wake a read already blocked in recv; a shutdown does, and
    a connection nobody is waiting for should not idle to its own timeout.
    """
    raw = getattr(getattr(response, "fp", None), "raw", None)
    with contextlib.suppress(Exception):
        raw._sock.shutdown(socket.SHUT_RDWR)  # noqa: SLF001 — the only handle
    with contextlib.suppress(Exception):
        response.close()


def _read_until(response: Any, *, stop: float) -> str:
    """The body, stopped on the budget between reads rather than on the socket.

    Keepalive bytes reset a socket timeout forever; they cannot reset a budget.
    This is the cheap half of the bound — a stream that keeps DRIBBLING ends
    here, with a short body, which is a malformed answer rather than a hang —
    and one that goes silent mid-read is caught outside, by the clock that can
    abandon a read this loop has already entered.
    """
    chunks: list[bytes] = []
    while time.monotonic() < stop:
        chunk = response.read1(READ_CHUNK_BYTES)
        if not chunk:
            break
        chunks.append(chunk)
    return b"".join(chunks).decode("utf-8", "replace")


def tool_view(body: str) -> dict[str, Any]:
    """The tool's structured result out of a JSON or SSE-framed response."""
    message = _last_json_message(body)
    if message.get("error") is not None:
        raise PollError("tool_error")
    result = message.get("result")
    if not isinstance(result, dict):
        raise PollError("malformed")
    structured = result.get("structuredContent")
    if isinstance(structured, dict):
        return structured
    for block in result.get("content") or []:
        text = block.get("text") if isinstance(block, dict) else None
        if not text:
            continue
        with contextlib.suppress(ValueError, TypeError):
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                return parsed
    raise PollError("malformed")


def _last_json_message(body: str) -> dict[str, Any]:
    raw = body.strip()
    if raw and not raw.startswith("{"):
        # SSE framing: the answer is the last `data:` line, after however many
        # keepalive comments and progress notifications preceded it.
        raw = next(
            (
                line[len("data:"):].strip()
                for line in reversed(raw.splitlines())
                if line.startswith("data:")
            ),
            "",
        )
    try:
        message = json.loads(raw)
    except ValueError as exc:
        raise PollError("malformed") from exc
    if not isinstance(message, dict):
        raise PollError("malformed")
    return message


# ---------- entry point ----------


def main(argv: Sequence[str] | None = None) -> int:
    """Every way out of this process is one grammar line and its exit code.

    Every way in, too: the standard fds are claimed and the teardown signals
    are armed here rather than under ``__main__``, so a caller that imports
    this function is as total as the module invoked as a script.
    """
    _ANSWERED.clear()  # one answer per invocation, and this one is importable
    _claim_std_fds()
    restore = _arm_teardown()
    try:
        return _answer(_observed(argv))
    except BaseException as exc:  # noqa: BLE001 — the seam, and only the seam
        # A teardown signal fires exactly once and lands wherever the main
        # thread stands — including in the few instructions between observing
        # and answering, which neither of them is watching. Nothing has been
        # written there yet, because the answer deafens before it speaks, so
        # this belt can still state one rather than leave through a traceback.
        #
        # It can also land AFTER the line — a host whose flush raises, a
        # SystemExit from inside the write — and then there is nothing left to
        # state: `_answer` finds the latch set and leaves through the code the
        # line already named, because a caller woken by it is reading already.
        _deafen()
        _diagnostic(f"merv-runs-wait: {exc!r}")
        return _answer(final_line(POLL_ERROR, "_", "crashed"))
    finally:
        restore()


def _observed(argv: Sequence[str] | None) -> str:
    """The one grammar line this invocation earned, however it got there."""
    watched = "_"
    try:
        args = _parser().parse_args(None if argv is None else list(argv))
        watched = _label_of(args)
        line = _watch(args)
    except UsageError as exc:
        _diagnostic(f"merv-runs-wait: {exc}")
        line = final_line(POLL_ERROR, watched, "usage")
    except (KeyboardInterrupt, _Terminated) as exc:
        # A teardown, not a crash: the run being watched is known, and the
        # caller is still reading for the grammar rather than for 130 or 143.
        reason = "terminated" if isinstance(exc, _Terminated) else "interrupted"
        _diagnostic(f"merv-runs-wait: {reason}")
        line = final_line(POLL_ERROR, watched, reason)
    except BaseException as exc:  # noqa: BLE001 — a watcher that dies wakes nobody
        # Whatever went wrong — including an exit some library took upon
        # itself — the caller is a background process watching for this
        # grammar, and leaving through a traceback would strand it.
        _diagnostic(f"merv-runs-wait: {exc!r}")
        line = final_line(POLL_ERROR, watched, "crashed")
    return line


# The line this invocation has already put on the wake channel, if any. Written
# is the point of no return: a platform watching output is reading by then, and
# nothing that escapes afterwards — a flush that raised, a host's own
# SystemExit, a signal in the last instruction — may say a second thing over
# it. Module state because the escape can happen anywhere below `main`, and
# cleared per invocation because `main` is importable and may be called again.
_ANSWERED: list[str] = []


def _answer(line: str) -> int:
    """Say it once on stdout, and never let saying it change what was said.

    Stdout carries the final line and nothing else, so a platform watching
    output wakes exactly once and on the answer — and a parent that already
    closed the pipe still gets the exit code its observation earned, not a
    BrokenPipeError's. The code is settled BEFORE anything is written, because
    it is the half of the wake signal no broken stream can eat; and a stream
    that refused the line is muted right here, since the interpreter would
    otherwise discover the same failure in its own final flush, where it
    becomes exit 120 and the code is lost after all.

    Nothing may interrupt the saying of it either: past this point the caller
    is owed a line and a code, and a SIGTERM landing between the write and the
    return would hand it a valid line followed by a traceback and exit 1.

    And it is said ONCE. The code is mapped here, before the line is offered
    to any stream, and the latch is claimed down in ``_say`` before the first
    byte of it goes anywhere — so whatever reaches this function second, the
    crash belt in ``main`` after an escape from inside the writing itself,
    arrives too late to change an answer somebody may already have woken on
    and leaves through that answer's own code instead of stating another.
    """
    _deafen()
    if _ANSWERED:
        return exit_code_for(_ANSWERED[0])
    code = exit_code_for(line)
    if not _say(line) or not _drained(sys.stderr):
        _mute_std_streams()
    return code


def _drained(stream: Any) -> bool:
    """True once the stream holds nothing that could fail on the way out.

    Flushing what is already flushed costs a call and cannot fail, so this is
    silent on every healthy run; it is the notes side of the same trap, where
    a heartbeat left buffered in a stderr nobody is reading becomes exit 120
    at shutdown just as surely as the answer would.
    """
    if stream is None:
        return True
    with contextlib.suppress(Exception):
        stream.flush()
        return True
    return False


def _say(line: str) -> bool:
    """The answer onto fd 1, through whatever is left of the stream.

    The raw fd is for ONE thing: a process that has no ``sys.stdout`` to offer
    the line to at all, spawned with the descriptor already closed. Not a
    fallback for a stream that took the line badly — once a byte has been
    offered to a stream, that attempt is the whole answer, whatever became of
    it. How much landed is exactly what cannot be known there: a host that
    wrote every character and THEN raised reports no count at all, because the
    raise is what returned in place of one, and writing the line again down
    the raw fd puts a second whole answer under a first one somebody may
    already have woken on. Two identical lines are not one line said twice to
    a consumer keying on the first it reads, and a partial line is the
    `poll_error` it re-arms on — so an offering that did not plainly complete
    ends here, with the exit code the observation earned still standing.

    The latch is claimed BEFORE the first byte is offered, not after the write
    returns. Writing is where the escapes live — a host's ``SystemExit`` from
    inside ``write``, a signal in that same instruction — and one of those
    walking out with the latch still unset is how a line already on the wake
    channel got a second one written under it. Claiming it early can at worst
    cost a line that never landed; claiming it late costs a caller who is
    already awake a contradiction. The exit code was settled before either.
    """
    text = f"{line}\n"
    _ANSWERED.append(line)
    stream = sys.stdout
    write = getattr(stream, "write", None)
    if not callable(write):
        return _say_raw(text)  # no stream at all, so the fd is still owed it
    if _delivered(write, text) < len(text):
        return False
    with contextlib.suppress(Exception):
        stream.flush()
        return True
    return False  # written, but into something that will not drain


def _say_raw(text: str) -> bool:
    payload = text.encode("utf-8", "replace")
    return _delivered(lambda chunk: os.write(1, chunk), payload) == len(payload)


def _delivered(write: Callable[[Any], Any], payload: Any) -> int:
    """Offer the whole payload to one writer, however many goes it takes.

    A write that reports fewer units than it was handed has taken only that
    much, and a caller reading for a whole line has not been answered yet — so
    the remainder is offered again rather than assumed gone. ``os.write`` says
    so in bytes and a text stream in characters; both are counts, and both are
    short on a pipe under pressure or a host stand-in that dribbles.

    A writer that reports nothing at all is taken at its word that it took
    everything: it did not raise, and there is no count to disagree with.
    Anything that raises, or that reports no progress, is a stream that will
    not take the rest — the loop ends there rather than spinning on it, and
    what it managed is what the caller gets.

    So the count is a floor and never a receipt: a writer that raises may have
    taken every byte it was handed and reported none of them. Which is why an
    incomplete return is `unknowable`, not `nothing`, to the one caller of this.
    """
    sent, total = 0, len(payload)
    while sent < total:
        try:
            wrote = write(payload[sent:])
        except Exception:  # noqa: BLE001 — a stream that would not take it
            break
        if not isinstance(wrote, int):
            return total  # no count to go on, and it did not refuse
        if wrote <= 0:
            break
        sent = min(sent + wrote, total)
    return sent


def _label_of(args: argparse.Namespace) -> str:
    """The run this invocation is watching, as it may go on the wire."""
    if args.url:
        return _label_from_wait_url(args.url)
    return echo(args.label) if args.label else "_"


def _claim_std_fds() -> None:
    """Hold fds 1 and 2 open, pointed at the void if they arrived closed.

    A process spawned with stdout closed has no wake channel — but it does
    have an exit code, and the fd it was denied would otherwise be handed to
    the next socket this client opens, which is where the answer would then be
    written. Live fds are left exactly as they are, so nothing that captures
    this process's output is disturbed.
    """
    for fd in (1, 2):
        try:
            os.fstat(fd)
            continue
        except OSError:
            pass
        with contextlib.suppress(OSError):
            null = os.open(os.devnull, os.O_WRONLY)
            if null != fd:  # the void may land ON the fd it is standing in for
                os.dup2(null, fd)
                os.close(null)


def _mute_std_streams() -> None:
    """Point the real stdout/stderr at the void, once one of them has failed.

    The interpreter flushes both as it exits, and on a pipe the parent already
    closed that raises — which would print a traceback on the wake channel and
    replace this process's mapped exit code with 120. The dance is by the
    numbers rather than through ``fileno()``: there may be no stream objects
    left to ask, and /dev/null may itself land on fd 1, where closing the
    descriptor we just opened would undo the whole point.
    """
    with contextlib.suppress(Exception):
        null = os.open(os.devnull, os.O_WRONLY)
        os.dup2(null, 1)
        os.dup2(null, 2)
        if null > 2:
            os.close(null)


def _teardown(signum: int, frame: Any) -> None:  # noqa: ARG001 — signal hook
    """A teardown signal, once, in a shape this process can answer.

    Deafening ALL teardown signals as the first one fires is the point: the raise
    lands wherever the main thread happens to stand, and a second one landing
    inside the clause already answering for the first would escape it — a
    traceback and exit 1 where the caller is blocked reading for a line.
    """
    _deafen()
    if signum == signal.SIGINT:
        raise KeyboardInterrupt
    raise _Terminated


def _deafen() -> None:
    """Stop listening for the signals this process answers for. Idempotent.

    Best effort, like arming them was. Once an answer is settled every
    remaining instruction IS the wake signal — the line, the flush, the code —
    and a signal landing in that window would replace a stated answer with a
    traceback.
    """
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        with contextlib.suppress(Exception):
            signal.signal(signum, signal.SIG_IGN)


def _arm_teardown() -> Callable[[], None]:
    """Ask for the teardown signals as exceptions, and hand back the undo.

    Best effort by design: off the main thread, or under an embedded
    interpreter, this simply keeps the defaults and the outer belts answer.
    SIGINT is taken over as well as SIGTERM — its default already raises, but
    only this handler disarms, and the two arrive by the same teardowns.
    Restoring matters because ``main`` is importable: a host process's own
    signal handling is not this function's to keep once the wait is over, and
    the exit path deafened all of them.
    """
    previous: dict[int, Any] = {}
    # SIGHUP rides along: the exec'd shim has nothing in front of this process
    # anymore, so a platform hanging up mid-hold must land here, not default.
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        with contextlib.suppress(Exception):
            previous[signum] = signal.signal(signum, _teardown)
    return lambda: _restore_signals(previous)


def _restore_signals(previous: dict[int, Any]) -> None:
    for signum, handler in previous.items():
        with contextlib.suppress(Exception):
            signal.signal(signum, handler)


def _watch(args: argparse.Namespace) -> str:
    keyed = (args.project_id, args.sandbox_uid, args.label)
    if args.url:
        if any(keyed):
            raise UsageError("--url takes no --project-id/--sandbox-uid/--label")
        return watch_url(args.url)
    if not all(keyed):
        raise UsageError(
            "keyed mode needs --project-id, --sandbox-uid and --label "
            "(or pass the --url from a sandbox.runs row)"
        )
    if args.deadline <= 0:
        raise UsageError("--deadline must be positive")
    key = dual_env_value(AGENT_SESSION_KEY_ENV_VAR) or dual_env_value(
        MCP_KEY_ENV_VAR
    )
    if not key:
        raise UsageError(
            f"{AGENT_SESSION_KEY_ENV_VAR} or {MCP_KEY_ENV_VAR} is required "
            "to poll sandbox.runs"
        )
    control_url = resolve_client_control_url()
    return watch_keyed(
        sandbox_uid=args.sandbox_uid,
        label=args.label,
        deadline=float(args.deadline),
        call=lambda **kwargs: call_sandbox_runs(
            control_url=control_url, key=key, project_id=args.project_id, **kwargs
        ),
    )


class _Parser(argparse.ArgumentParser):
    """Every invocation, `-h` included, honors the wake contract: exit 0 is
    reserved for an observed terminal run, so help and usage errors alike leave
    through the protocol rather than through argparse's own exits (its 2 is
    still_running, its 0 is done). The help TEXT still prints — on stderr,
    where a human reads it and a platform's wake channel never does.

    Both writers render the text themselves rather than hand argparse a
    stream: argparse falls back to STDOUT for a file it was given as None,
    which is what a dead stderr would arrive as, and help on the wake channel
    is exactly what this class exists to prevent.
    """

    def error(self, message: str):  # noqa: D102 — argparse hook
        raise UsageError(message)

    def exit(self, status: int = 0, message: str | None = None):  # noqa: D102
        raise UsageError(message or "help requested")

    def print_help(self, file=None) -> None:  # noqa: D102 — argparse hook
        _diagnostic(self.format_help())

    def print_usage(self, file=None) -> None:  # noqa: D102 — argparse hook
        _diagnostic(self.format_usage())


def _parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog="merv-runs-wait",
        description=(
            "Block until a detached merv_run ends, then exit: 0 terminal "
            "(read status=/exit_code= on the final line), 2 still running "
            "(re-arm), 3 poll error, 4 no such run."
        ),
    )
    parser.add_argument(
        "--url",
        help="Signed wait_url from a sandbox.runs row. Needs no key.",
    )
    parser.add_argument(
        "--project-id", help="Keyed mode: project the sandbox belongs to."
    )
    parser.add_argument(
        "--sandbox-uid", help="Keyed mode: sandbox the run was launched on."
    )
    parser.add_argument(
        "--label",
        help="Keyed mode: merv_run label — unique within its sandbox only.",
    )
    parser.add_argument(
        "--deadline",
        type=float,
        default=DEFAULT_DEADLINE_SECONDS,
        help=(
            "Keyed mode: report still_running after this many seconds "
            f"(default {int(DEFAULT_DEADLINE_SECONDS)})."
        ),
    )
    return parser


if __name__ == "__main__":
    # `python -m merv.client.runs_wait`, and nothing here that an importer of
    # main() does not also get: the exit code is half the wake signal, and the
    # muting that protects it from the interpreter's own shutdown now lives
    # where the answer is written, not in this block.
    raise SystemExit(main())
