"""The auth-exempt run-wait URL: what it proves, what it tells, what it costs.

Four things are load-bearing here and each has its own class: the tag is a
domain-separated MAC over exactly one (sandbox, label) pair; the endpoint
answers only from brain clocks and never distinguishes a forged tag from an
expired one; a wait costs a bounded, releasable slot; and the tag never
reaches either log scrubber.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch
from urllib.parse import quote

from fastapi.testclient import TestClient

from merv.brain.kernel.secret_tokens import (
    MIN_WAIT_SECRET_BYTES,
    WAIT_SECRET_ENV_VAR,
    WAIT_SECRET_FILENAME,
    load_wait_secret,
    wait_signature,
    wait_signature_matches,
)
from merv.brain.kernel.state.activity import redact_sensitive, scrub_secret_text
from merv.brain.kernel.utils import ValidationError, now_iso
from tests.support.sandbox_backend import FakeSandboxBackend
from merv.brain.surface.telemetry import ControlToolCallSink
from merv.brain.surface.config import (
    MGMT_KEY_PATH_ENV_VAR,
    MGMT_PUBLIC_KEY_ENV_VAR,
)
from merv.brain.surface.transport.api import runs_wait
from merv.brain.surface.transport.api.shared import redact_upload_tokens
from merv.brain.surface.transport.api import create_fastapi_app
from merv.brain.surface.transport.http_policy import HttpSurfacePolicy
from merv.brain.surface.transport.http_server import make_http_server
from tests.support.brain import TestBrain


SECRET = b"wait-secret-for-tests-0123456789abcdef"


def _b64(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def _listing(*runs: dict) -> str:
    """Raw on-box listing text, exactly as runs_listing_command emits it."""
    blocks = []
    for run in runs:
        meta = json.dumps(
            {
                "label": run["label"],
                "command": "python train.py",
                "pid": 4242,
                "started_at": "2026-07-27T10:00:00Z",
            }
        )
        exit_code = run.get("exit_code")
        blocks.append(
            f"===MERV_RUN {_b64(run['label'])}\n"
            f"===META {_b64(meta)}\n"
            f"===EXIT {_b64('' if exit_code is None else str(exit_code))}\n"
            f"===FIN {_b64(run.get('finished_at', ''))}\n"
        )
    return "".join(blocks)


class WaitSignatureTest(unittest.TestCase):
    def test_golden_vector_pins_the_wire_encoding(self) -> None:
        # Any drift in the domain string, the length prefixes, or the
        # truncation silently invalidates every URL already in an agent's
        # hands, so the derivation is pinned by value and not by round-trip.
        self.assertEqual(
            wait_signature(
                key=bytes(range(32)), sandbox_uid="sbx-1", label="seed0"
            ),
            "0f91397d686573aa774bc815b2ce3d66",
        )

    def test_length_prefixes_stop_one_pair_signing_as_another(self) -> None:
        first = wait_signature(key=SECRET, sandbox_uid="sbx-1", label="seed0")
        recut = wait_signature(key=SECRET, sandbox_uid="sbx-1s", label="eed0")
        self.assertNotEqual(first, recut)

    def test_the_tag_is_a_128_bit_hex_tag(self) -> None:
        tag = wait_signature(key=SECRET, sandbox_uid="sbx-1", label="seed0")
        self.assertEqual(len(tag), 32)
        self.assertEqual(tag, tag.lower())
        int(tag, 16)

    def test_verification_accepts_only_the_exact_tag(self) -> None:
        tag = wait_signature(key=SECRET, sandbox_uid="sbx-1", label="seed0")
        self.assertTrue(
            wait_signature_matches(
                key=SECRET, sandbox_uid="sbx-1", label="seed0", presented=tag
            )
        )
        for wrong in (tag[:-1] + "0", tag[:16], "", "zz", tag.upper(), "sigé"):
            with self.subTest(presented=wrong):
                self.assertFalse(
                    wait_signature_matches(
                        key=SECRET,
                        sandbox_uid="sbx-1",
                        label="seed0",
                        presented=wrong,
                    )
                )
        self.assertFalse(
            wait_signature_matches(
                key=b"another-key-that-is-long-enough-0", sandbox_uid="sbx-1",
                label="seed0", presented=tag,
            )
        )


class WaitSecretLoaderTest(unittest.TestCase):
    def test_a_set_but_weak_env_secret_fails_the_boot(self) -> None:
        with self.assertRaises(ValidationError) as caught:
            load_wait_secret(env={WAIT_SECRET_ENV_VAR: "too-short"})
        self.assertIn(WAIT_SECRET_ENV_VAR, caught.exception.message)
        self.assertEqual(caught.exception.details["bytes"], len("too-short"))

    def test_a_deployment_with_no_writable_state_root_requires_the_env(self) -> None:
        with self.assertRaises(ValidationError) as caught:
            load_wait_secret(env={}, require_env=True)
        self.assertIn(WAIT_SECRET_ENV_VAR, caught.exception.message)
        with tempfile.TemporaryDirectory() as tmp:
            # Naming a state root does not buy a hosted composition a key.
            with self.assertRaises(ValidationError):
                load_wait_secret(
                    env={}, state_root=Path(tmp), require_env=True
                )

    def test_the_env_secret_wins_and_is_used_verbatim(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            loaded = load_wait_secret(
                env={WAIT_SECRET_ENV_VAR: "e" * 40}, state_root=root
            )
            self.assertEqual(loaded, b"e" * 40)
            self.assertFalse((root / WAIT_SECRET_FILENAME).exists())

    def test_a_local_state_root_generates_one_owner_only_key_and_keeps_it(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "brain"
            first = load_wait_secret(env={}, state_root=root)
            self.assertGreaterEqual(len(first), MIN_WAIT_SECRET_BYTES)
            path = root / WAIT_SECRET_FILENAME
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            # Stable across re-invocation: a URL minted before a restart must
            # still verify after one.
            self.assertEqual(load_wait_secret(env={}, state_root=root), first)
            self.assertEqual(sorted(p.name for p in root.iterdir()), ["wait_secret"])


class WaitEndpointTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.fake = FakeSandboxBackend()
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
            execution_backend=self.fake,
        )
        self.client = TestClient(
            create_fastapi_app(self.app, wait_secret=SECRET)
        )
        self.project_id = self.app.call_tool(
            "project", {"action": "create", "name": "Waits"}
        )["id"]
        self.experiment_id = self._experiment("long-training")
        view = self.app.call_tool(
            "sandbox.request",
            {"project_id": self.project_id, "experiment_id": self.experiment_id},
        )
        self.sandbox_uid = view["sandbox_uid"]
        row = self.app.sandbox_storage.get_by_uid(sandbox_uid=self.sandbox_uid)
        self.sandbox_id = str(row["sandbox_id"])
        # Module singletons are process-wide by design; each test starts clean.
        runs_wait._ADMISSION = runs_wait._StreamAdmission()
        runs_wait._BUCKET = runs_wait._TokenBucket(
            capacity=runs_wait.BUCKET_CAPACITY,
            per_second=runs_wait.BUCKET_REFILL_PER_SECOND,
        )

    def tearDown(self) -> None:
        self.app.shutdown()
        self.tmp.cleanup()

    def _experiment(self, name: str) -> str:
        exp_id = self.app.call_tool(
            "experiment.create",
            {"project_id": self.project_id, "name": name, "intent": "x"},
        )["id"]
        with self.app.store.transaction() as conn:
            conn.execute(
                "UPDATE experiments SET status = 'ready_to_run' WHERE id = ?",
                (exp_id,),
            )
        return exp_id

    def _url(self, *, label: str, uid: str | None = None, sig: str | None = None) -> str:
        sandbox_uid = self.sandbox_uid if uid is None else uid
        tag = sig or wait_signature(
            key=SECRET, sandbox_uid=sandbox_uid, label=label
        )
        return f"/wait/{sandbox_uid}/{label}/{tag}"

    def _mirror(self, *runs: dict) -> None:
        self.fake.run_listings[self.sandbox_id] = _listing(*runs)
        self.app.sandbox_observer.observe_live(max_age_seconds=0.0)

    def _set_run_clock(self, *, label: str, updated_at: str) -> None:
        with self.app.store.transaction() as conn:
            conn.execute(
                "UPDATE sandbox_runs SET updated_at = ? "
                "WHERE sandbox_uid = ? AND label = ?",
                (updated_at, self.sandbox_uid, label),
            )

    def _set_sandbox(self, **columns: str) -> None:
        assignments = ", ".join(f"{name} = ?" for name in columns)
        with self.app.store.transaction() as conn:
            conn.execute(
                f"UPDATE sandboxes SET {assignments} WHERE sandbox_uid = ?",
                (*columns.values(), self.sandbox_uid),
            )

    @staticmethod
    def _protocol_lines(text: str) -> list[str]:
        return [line for line in text.splitlines() if line.startswith("MERV_RUNS_WAIT ")]

    # ---------- resolution ----------

    def test_a_finished_run_resolves_immediately_with_status_and_exit_code(self) -> None:
        self._mirror({"label": "seed0", "exit_code": 0, "finished_at": "2026-07-27T10:05:00Z"})
        response = self.client.get(self._url(label="seed0"))
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("text/plain"))
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(response.headers["x-accel-buffering"], "no")
        self.assertEqual(
            response.text, "MERV_RUNS_WAIT done seed0 status=finished exit_code=0\n"
        )

    def test_a_nonzero_exit_is_still_a_finished_run(self) -> None:
        self._mirror({"label": "seed0", "exit_code": 137, "finished_at": "2026-07-27T10:05:00Z"})
        response = self.client.get(self._url(label="seed0"))
        self.assertEqual(
            response.text, "MERV_RUNS_WAIT done seed0 status=finished exit_code=137\n"
        )

    def test_a_run_the_dead_box_never_reported_resolves_without_an_exit_code(self) -> None:
        self._mirror({"label": "seed0"})
        self._set_sandbox(status="terminated", runs_final_observed_at=now_iso())
        response = self.client.get(self._url(label="seed0"))
        self.assertEqual(
            response.text, "MERV_RUNS_WAIT done seed0 status=lost exit_code=none\n"
        )

    def test_a_run_answers_nothing_else_about_itself(self) -> None:
        self._mirror({"label": "seed0", "exit_code": 0, "finished_at": "2026-07-27T10:05:00Z"})
        body = self.client.get(self._url(label="seed0")).text
        for leaked in ("python train.py", "4242", "log.txt", ".runs", "2026-07-27T10:05"):
            self.assertNotIn(leaked, body)

    # ---------- one answer for every way of not answering ----------

    def test_a_forged_tag_and_an_unknown_sandbox_are_one_answer(self) -> None:
        self._mirror({"label": "seed0", "exit_code": 0})
        forged = self.client.get(
            self._url(label="seed0", sig="0" * 32)
        )
        unknown = self.client.get(self._url(label="seed0", uid="no-such-sandbox"))
        self.assertEqual(forged.status_code, 410)
        self.assertEqual(forged.text, "MERV_RUNS_WAIT no_such_run seed0\n")
        self.assertEqual((unknown.status_code, unknown.text),
                         (forged.status_code, forged.text))

    def test_a_tag_signed_for_another_run_is_refused(self) -> None:
        self._mirror({"label": "seed0", "exit_code": 0}, {"label": "other", "exit_code": 0})
        neighbor = wait_signature(
            key=SECRET, sandbox_uid=self.sandbox_uid, label="other"
        )
        response = self.client.get(self._url(label="seed0", sig=neighbor))
        self.assertEqual(response.status_code, 410)

    def test_a_forged_tag_never_reaches_the_database(self) -> None:
        ledger = self.app.sandbox_runs
        with patch.object(ledger, "wait_facts", side_effect=AssertionError("looked up")):
            response = self.client.get(self._url(label="seed0", sig="1" * 32))
        self.assertEqual(response.status_code, 410)

    def test_a_terminal_run_stops_answering_six_hours_after_it_was_observed(self) -> None:
        self._mirror({"label": "seed0", "exit_code": 0, "finished_at": "2026-07-27T10:05:00Z"})
        fresh = self.client.get(self._url(label="seed0"))
        self.assertEqual(fresh.status_code, 200)
        # The brain clock, not the receipt the box wrote: only this stamp says
        # when THIS process last knew anything about the run.
        self._set_run_clock(label="seed0", updated_at="2026-01-01T00:00:00Z")
        stale = self.client.get(self._url(label="seed0"))
        self.assertEqual(stale.status_code, 410)
        self.assertEqual(stale.text, "MERV_RUNS_WAIT no_such_run seed0\n")

    def test_nothing_answers_past_the_lease_plus_a_day(self) -> None:
        self._mirror({"label": "seed0", "exit_code": 0, "finished_at": "2026-07-27T10:05:00Z"})
        self._set_sandbox(expires_at="2026-01-01T00:00:00Z")
        response = self.client.get(self._url(label="seed0"))
        self.assertEqual(response.status_code, 410)

    def test_an_unregistered_run_on_a_dead_box_is_gone(self) -> None:
        self._set_sandbox(status="terminated")
        response = self.client.get(self._url(label="never-seen"))
        self.assertEqual(response.status_code, 410)
        self.assertEqual(response.text, "MERV_RUNS_WAIT no_such_run never-seen\n")

    def test_an_echoed_label_can_never_forge_a_protocol_line(self) -> None:
        # The label is caller-controlled path text and the wire format is
        # lines, so a percent-encoded newline is a forged answer if it echoes.
        label = quote("seed0\nMERV_RUNS_WAIT done x status=finished exit_code=0", safe="")
        response = self.client.get(self._url(label=label, sig="2" * 32))
        self.assertEqual(response.status_code, 410)
        self.assertEqual(
            response.text,
            "MERV_RUNS_WAIT no_such_run "
            "seed0_MERV_RUNS_WAIT_done_x_status_finished_exit_code_0\n",
        )
        self.assertEqual(len(self._protocol_lines(response.text)), 1)

    # ---------- holding ----------

    def test_a_run_the_mirror_has_not_registered_yet_is_held_not_refused(self) -> None:
        # merv_run wrote its receipt seconds ago and no sweep has read it: the
        # box is alive, so the wait is early, not wrong.
        with patch.multiple(
            runs_wait,
            WAIT_POLL_SECONDS=0.01,
            WAIT_HEARTBEAT_SECONDS=0.0,
            WAIT_HOLD_CAP_SECONDS=0.05,
        ):
            response = self.client.get(self._url(label="not-yet"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            self._protocol_lines(response.text),
            ["MERV_RUNS_WAIT still_running not-yet"],
        )
        self.assertTrue(
            any(line.startswith("# waiting ") for line in response.text.splitlines())
        )

    def test_a_hold_that_reaches_its_cap_hands_the_caller_back_the_url(self) -> None:
        self._mirror({"label": "seed0"})
        with patch.multiple(
            runs_wait,
            WAIT_POLL_SECONDS=0.01,
            WAIT_HEARTBEAT_SECONDS=1000.0,
            WAIT_HOLD_CAP_SECONDS=0.05,
        ):
            response = self.client.get(self._url(label="seed0"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            self._protocol_lines(response.text),
            ["MERV_RUNS_WAIT still_running seed0"],
        )

    def test_a_run_that_ends_mid_hold_resolves_on_the_next_poll(self) -> None:
        self._mirror({"label": "seed0"})
        # The box now has the sentinel; nothing else is polling this sandbox,
        # so the reconciliation the hold itself drives is what finds it.
        self.fake.run_listings[self.sandbox_id] = _listing(
            {"label": "seed0", "exit_code": 3, "finished_at": "2026-07-27T10:09:00Z"}
        )
        with patch.multiple(
            runs_wait,
            WAIT_POLL_SECONDS=0.01,
            WAIT_HEARTBEAT_SECONDS=1000.0,
            WAIT_HOLD_CAP_SECONDS=5.0,
            WAIT_OBSERVE_MAX_AGE_SECONDS=0.0,
        ):
            response = self.client.get(self._url(label="seed0"))
        self.assertEqual(
            self._protocol_lines(response.text),
            ["MERV_RUNS_WAIT done seed0 status=finished exit_code=3"],
        )

    def test_a_hold_reconciles_through_the_observer_not_the_ledger(self) -> None:
        self._mirror({"label": "seed0"})
        with patch.multiple(
            runs_wait,
            WAIT_POLL_SECONDS=0.01,
            WAIT_HEARTBEAT_SECONDS=1000.0,
            WAIT_HOLD_CAP_SECONDS=0.05,
        ):
            with patch.object(
                self.app.sandbox_observer, "observe", return_value=True
            ) as observe:
                self.client.get(self._url(label="seed0"))
        self.assertTrue(observe.call_args_list)
        for call in observe.call_args_list:
            self.assertEqual(
                call.kwargs["max_age_seconds"], runs_wait.WAIT_OBSERVE_MAX_AGE_SECONDS
            )
            self.assertEqual(
                call.kwargs["acquire_timeout"], runs_wait.WAIT_OBSERVE_ACQUIRE_SECONDS
            )

    # ---------- admission ----------

    def test_the_process_wide_cap_refuses_with_the_protocol_grammar(self) -> None:
        self._mirror({"label": "seed0", "exit_code": 0})
        with patch.object(runs_wait._ADMISSION, "limit", 0):
            response = self.client.get(self._url(label="seed0"))
        self.assertEqual(response.status_code, 429)
        self.assertEqual(
            response.text, "MERV_RUNS_WAIT poll_error seed0 rate_limited\n"
        )

    def test_an_exhausted_entry_budget_refuses_the_same_way(self) -> None:
        with patch.object(runs_wait._BUCKET, "_tokens", 0.0), patch.object(
            runs_wait._BUCKET, "per_second", 0.0
        ):
            response = self.client.get(self._url(label="seed0"))
        self.assertEqual(response.status_code, 429)
        self.assertEqual(
            response.text, "MERV_RUNS_WAIT poll_error seed0 rate_limited\n"
        )

    def test_one_url_may_not_hold_more_than_two_streams(self) -> None:
        # TestClient buffers a whole response, so the two holds run in their
        # own threads (each request gets its own portal) while the third asks.
        url = self._url(label="seed0")
        with patch.multiple(
            runs_wait,
            WAIT_POLL_SECONDS=0.05,
            WAIT_HEARTBEAT_SECONDS=0.0,
            WAIT_HOLD_CAP_SECONDS=3.0,
        ):
            holders = [
                threading.Thread(target=lambda: self.client.get(url), daemon=True)
                for _ in range(2)
            ]
            for holder in holders:
                holder.start()
            self._await_held(2)
            refused = self.client.get(url)
            self.assertEqual(refused.status_code, 429)
            self.assertEqual(
                refused.text, "MERV_RUNS_WAIT poll_error seed0 rate_limited\n"
            )
            for holder in holders:
                holder.join(timeout=10.0)
        self._assert_slots_free()

    def test_a_client_that_walks_away_gives_its_slot_back(self) -> None:
        # Driven at the ASGI seam because TestClient buffers: the first body
        # chunk fails to send, exactly as a vanished client's socket does.
        async def send(message: dict) -> None:
            if message["type"] == "http.response.body" and message.get("body"):
                raise OSError("client went away")

        self.assertEqual(self._drive_wait(label="seed0", send=send), 0)

    def test_a_client_that_vanishes_before_the_stream_starts_gives_it_back(self) -> None:
        """The leak: Starlette iterates the generator only once the response
        has BEGUN, so a client already gone while the headers are still going
        out never reaches the generator's finally, and two of those per valid
        signature ate that URL's whole budget for the life of the process.

        Driven against the response itself — the ASGI call is the one context
        that runs whether or not the body ever starts."""
        async def send(message: dict) -> None:
            await asyncio.Event().wait()  # the headers never land

        async def gone() -> dict:
            return {"type": "http.disconnect"}

        async def drive() -> int:
            response = await self._endpoint(label="seed0")
            self.assertEqual(runs_wait._ADMISSION.held(), 1)
            await response({"type": "http"}, gone, send)
            return runs_wait._ADMISSION.held()

        with patch.multiple(
            runs_wait,
            WAIT_POLL_SECONDS=0.02,
            WAIT_HEARTBEAT_SECONDS=0.0,
            WAIT_HOLD_CAP_SECONDS=30.0,
        ):
            self.assertEqual(asyncio.run(drive()), 0)

    def test_a_stream_that_resolves_hands_back_exactly_one_slot(self) -> None:
        """Resolution runs BOTH finallys — the generator's and the response's
        ASGI call — so the release is once-only. A slot handed back twice is
        another waiter's slot, and the ceiling stops meaning anything."""
        self._mirror({"label": "seed0", "exit_code": 0, "finished_at": "2026-07-27T10:05:00Z"})
        self.assertTrue(runs_wait._ADMISSION.acquire(signature="another-wait"))
        self.assertEqual(self.client.get(self._url(label="seed0")).status_code, 200)
        self.assertEqual(runs_wait._ADMISSION.held(), 1)
        slot = runs_wait._Slot(signature="another-wait")
        slot.release()
        slot.release()
        self.assertEqual(runs_wait._ADMISSION.held(), 0)

    def test_a_refused_request_never_took_a_slot(self) -> None:
        self.client.get(self._url(label="seed0", sig="3" * 32))
        self._assert_slots_free()

    # ---------- the loop the stream runs on ----------

    def test_a_slow_ledger_read_costs_its_own_cycle_and_nothing_else(self) -> None:
        """wait_facts opens a synchronous connection (Postgres when hosted), so
        reading it inline would freeze every heartbeat in the process — and
        every unrelated request — for as long as one database is slow."""
        ledger = self.app.sandbox_runs
        answer = ledger.wait_facts
        readers: list[str] = []

        def slow(**kwargs) -> dict | None:
            readers.append(threading.current_thread().name)
            time.sleep(0.2)
            return answer(**kwargs)

        chunks: list[bytes] = []
        ticks = 0

        async def tick() -> None:
            nonlocal ticks
            while True:
                await asyncio.sleep(0.01)
                ticks += 1

        async def send(message: dict) -> None:
            if message["type"] == "http.response.body":
                chunks.append(message.get("body", b""))

        with patch.object(ledger, "wait_facts", side_effect=slow):
            held = self._drive_wait(
                label="not-yet", send=send, before=tick, hold_cap=0.6
            )
        self.assertEqual(held, 0)
        # Whatever else the wait did, the loop kept running through the reads.
        self.assertGreater(ticks, 10)
        self.assertIn(b"# waiting ", b"".join(chunks))
        # The pool this module owns, never the thread the event loop is on.
        self.assertTrue(readers)
        for reader in readers:
            self.assertTrue(reader.startswith("merv-wait"), reader)

    # ---------- no key, no route ----------

    def test_a_composition_that_named_no_key_mounts_no_wait_route(self) -> None:
        """An unsigned URL is not a capability and a process-lifetime key is a
        URL that dies at the next restart, so absence is not a fallback."""
        client = TestClient(create_fastapi_app(self.app))
        with patch.object(
            runs_wait._ADMISSION, "acquire", side_effect=AssertionError("admitted")
        ):
            response = client.get(self._url(label="seed0"))
        self.assertEqual(response.status_code, 404)

    def test_a_short_key_refuses_to_mount_rather_than_sign(self) -> None:
        """The route is auth-exempt: bytes no loader vetted must meet the same
        floor the loader enforces, or the mount itself is the forgery."""
        with self.assertRaises(ValueError):
            runs_wait.build_router(sandboxes=self.app.sandboxes, secret=b"x")
        with self.assertRaises(ValueError):
            create_fastapi_app(self.app, wait_secret=b"x")

    def test_a_cancelled_opening_read_gives_its_slot_back(self) -> None:
        """Cancellation is a BaseException with no response object yet, so no
        downstream finally exists — the route itself must hand the slot back."""
        entered = threading.Event()
        finish = threading.Event()

        def stuck(*_a, **_k):
            entered.set()
            finish.wait(5.0)
            return None

        ledger = self.app.sandbox_runs

        async def scenario() -> int:
            task = asyncio.create_task(self._endpoint(label="seed0"))
            deadline = asyncio.get_running_loop().time() + 5.0
            while not entered.is_set():
                if asyncio.get_running_loop().time() > deadline:
                    self.fail("the opening read never started")
                await asyncio.sleep(0.01)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            return runs_wait._ADMISSION.held()

        try:
            with patch.object(ledger, "wait_facts", side_effect=stuck):
                held = asyncio.run(scenario())
        finally:
            finish.set()
        self.assertEqual(held, 0)

    async def _endpoint(self, *, label: str):
        """The route's own response object, before any middleware wraps it."""
        route = runs_wait.build_router(
            sandboxes=self.app.sandboxes, secret=SECRET
        ).routes[0]
        return await route.endpoint(
            sandbox_uid=self.sandbox_uid,
            label=label,
            sig=wait_signature(
                key=SECRET, sandbox_uid=self.sandbox_uid, label=label
            ),
        )

    def _drive_wait(
        self,
        *,
        label: str,
        send,
        receive=None,
        before=None,
        hold_cap: float = 30.0,
    ) -> int:
        """One wait driven at the ASGI seam, since TestClient buffers.

        Returns the slots still held THE MOMENT the request is over, read on
        the loop: ``asyncio.run`` closes stray async generators on its way out
        and would otherwise hand back a slot nothing in the process ever did.
        ``before`` is a coroutine started on that same loop, which is how a
        stream that froze it is told apart from one that only froze itself.
        """
        url = self._url(label=label)
        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
            "method": "GET", "scheme": "http", "path": url,
            "raw_path": url.encode(), "query_string": b"", "root_path": "",
            "headers": [(b"host", b"testserver")],
            "client": ("127.0.0.1", 4444), "server": ("testserver", 80),
        }

        async def request() -> dict:
            return {"type": "http.request", "body": b"", "more_body": False}

        app = create_fastapi_app(self.app, wait_secret=SECRET)
        held = -1

        async def drive() -> None:
            nonlocal held
            companion = None if before is None else asyncio.create_task(before())
            try:
                with contextlib.suppress(BaseException):  # a gone client raises
                    await app(scope, receive or request, send)
                held = runs_wait._ADMISSION.held()
            finally:
                if companion is not None:
                    companion.cancel()

        with patch.multiple(
            runs_wait,
            WAIT_POLL_SECONDS=0.02,
            WAIT_HEARTBEAT_SECONDS=0.0,
            WAIT_HOLD_CAP_SECONDS=hold_cap,
        ):
            asyncio.run(drive())
        return held

    def _await_held(self, count: int) -> None:
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline and runs_wait._ADMISSION.held() < count:
            time.sleep(0.02)
        self.assertEqual(runs_wait._ADMISSION.held(), count)

    def _assert_slots_free(self) -> None:
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline and runs_wait._ADMISSION.held():
            time.sleep(0.02)
        self.assertEqual(runs_wait._ADMISSION.held(), 0)


class RunsWaitUrlTest(unittest.TestCase):
    """sandbox.runs hands back the wait URL itself.

    An agent that just launched work — or just listed what is running — can arm
    a watcher from the row it already has, with no second call and no key of
    its own. Two things make that URL: the caller-reachable base the request
    arrived on, and this app's wait key. Missing either, the field is absent
    and the consumer falls back to authenticated polling.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.fake = FakeSandboxBackend()
        # Not an identity test: agent_id is merely recorded here (see test_agent_identity.py).
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
            execution_backend=self.fake,
            env={"MERV_AGENT_IDENTITY": "optional"},
        )
        self.client = TestClient(
            create_fastapi_app(self.app, wait_secret=SECRET)
        )
        self.project_id = self.app.call_tool(
            "project", {"action": "create", "name": "Waits"}
        )["id"]
        self.experiment_id = self._experiment("long-training")
        self.sandbox_uid = self._sandbox(self.experiment_id)
        self._mirror(
            self.sandbox_uid,
            {"label": "seed0", "exit_code": 0, "finished_at": "2026-07-27T10:05:00Z"},
            {"label": "seed1"},
        )

    def tearDown(self) -> None:
        self.app.shutdown()
        self.tmp.cleanup()

    def _experiment(self, name: str) -> str:
        exp_id = self.app.call_tool(
            "experiment.create",
            {"project_id": self.project_id, "name": name, "intent": "x"},
        )["id"]
        with self.app.store.transaction() as conn:
            conn.execute(
                "UPDATE experiments SET status = 'ready_to_run' WHERE id = ?",
                (exp_id,),
            )
        return exp_id

    def _sandbox(self, experiment_id: str) -> str:
        return self.app.call_tool(
            "sandbox.request",
            {"project_id": self.project_id, "experiment_id": experiment_id},
        )["sandbox_uid"]

    def _mirror(self, sandbox_uid: str, *runs: dict) -> None:
        row = self.app.sandbox_storage.get_by_uid(sandbox_uid=sandbox_uid)
        self.fake.run_listings[str(row["sandbox_id"])] = _listing(*runs)
        self.app.sandbox_observer.observe_live(max_age_seconds=0.0)

    def _legacy(self, **arguments: str) -> dict:
        response = self.client.post(
            "/mcp/call",
            json={"name": "sandbox.runs", "arguments": {
                "project_id": self.project_id, **arguments}},
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["result"]

    def _streamable(self, **arguments: str) -> dict:
        response = self.client.post(
            "/mcp",
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "sandbox.runs", "arguments": {
                    "project_id": self.project_id, **arguments}},
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["result"]["structuredContent"]

    def _by_label(self, view: dict) -> dict[str, dict]:
        return {str(run["label"]): run for run in view["runs"]}

    def test_every_row_carries_a_url_signed_for_its_own_run(self) -> None:
        runs = self._by_label(self._legacy(sandbox_uid=self.sandbox_uid))
        self.assertEqual(sorted(runs), ["seed0", "seed1"])
        for label, run in runs.items():
            with self.subTest(label=label):
                # Golden against the derivation itself, not a round-trip: the
                # URL an agent is handed has to be the one the route verifies.
                self.assertEqual(
                    run["wait_url"],
                    f"http://testserver/wait/{self.sandbox_uid}/{label}/"
                    + wait_signature(
                        key=SECRET, sandbox_uid=self.sandbox_uid, label=label
                    ),
                )

    def test_the_streamable_transport_renders_the_same_url(self) -> None:
        # Both transports reach the tool through ToolInvocationGateway.call_mcp,
        # which is where the caller-reachable base is read; this pins that they
        # stay one seam rather than two that can drift.
        legacy = self._by_label(self._legacy(sandbox_uid=self.sandbox_uid))
        streamed = self._by_label(self._streamable(sandbox_uid=self.sandbox_uid))
        self.assertEqual(
            {label: run["wait_url"] for label, run in streamed.items()},
            {label: run["wait_url"] for label, run in legacy.items()},
        )

    def test_the_rendered_url_resolves_to_the_mounted_route(self) -> None:
        """The prefix carries its own slashes, so a joining slip is a 404."""
        runs = self._by_label(self._legacy(sandbox_uid=self.sandbox_uid))
        response = self.client.get(runs["seed0"]["wait_url"])
        self.assertNotEqual(response.status_code, 404)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.text, "MERV_RUNS_WAIT done seed0 status=finished exit_code=0\n"
        )

    def test_an_experiment_listing_never_cross_signs_its_sandboxes(self) -> None:
        other_uid = self._sandbox(self._experiment("second-box"))
        self.app.call_tool(
            "sandbox.attach",
            {"project_id": self.project_id, "experiment_id": self.experiment_id,
             "sandbox_uid": other_uid},
        )
        self._mirror(other_uid, {"label": "sweep", "exit_code": 0})
        runs = self._by_label(self._legacy(experiment_id=self.experiment_id))
        self.assertEqual(sorted(runs), ["seed0", "seed1", "sweep"])
        self.assertIn(other_uid, runs["sweep"]["wait_url"])
        self.assertNotIn(self.sandbox_uid, runs["sweep"]["wait_url"])
        # Each tag opens exactly one run: the neighbour's URL is refused for it.
        self.assertEqual(
            self.client.get(
                f"http://testserver/wait/{other_uid}/sweep/"
                + wait_signature(
                    key=SECRET, sandbox_uid=self.sandbox_uid, label="sweep"
                )
            ).status_code,
            410,
        )
        self.assertEqual(
            self.client.get(runs["sweep"]["wait_url"]).status_code, 200
        )

    def _runs_via(self, client: TestClient) -> dict[str, dict]:
        response = client.post(
            "/mcp/call",
            json={"name": "sandbox.runs", "arguments": {
                "project_id": self.project_id, "sandbox_uid": self.sandbox_uid}},
        )
        self.assertEqual(response.status_code, 200, response.text)
        return self._by_label(response.json()["result"])

    def test_a_composition_with_no_key_renders_no_field_at_all(self) -> None:
        """Absent, not null: a consumer tests for the key, never for a value."""
        keyless = TestClient(create_fastapi_app(self.app))
        for run in self._runs_via(keyless).values():
            self.assertNotIn("wait_url", run)
        # The key rides the composition, not the shared backend: a keyless
        # sibling must not have unhooked the app that was already serving.
        survivor = self._runs_via(self.client)["seed0"]
        self.assertEqual(self.client.get(survivor["wait_url"]).status_code, 200)

    def test_two_keyed_compositions_over_one_backend_stay_isolated(self) -> None:
        """Each app signs with its own key and honors only its own signatures."""
        second_key = b"second-wait-secret-9876543210zyxwvu"
        other = TestClient(create_fastapi_app(self.app, wait_secret=second_key))
        mine = self._runs_via(self.client)["seed0"]["wait_url"]
        theirs = self._runs_via(other)["seed0"]["wait_url"]
        self.assertNotEqual(mine, theirs)
        self.assertEqual(self.client.get(mine).status_code, 200)
        self.assertEqual(other.get(theirs).status_code, 200)
        self.assertEqual(self.client.get(theirs).status_code, 410)
        self.assertEqual(other.get(mine).status_code, 410)

    def test_a_failed_composition_leaves_a_serving_app_untouched(self) -> None:
        """A short key refuses its own composition before touching anything a
        sibling app relies on."""
        with self.assertRaises(ValueError):
            create_fastapi_app(self.app, wait_secret=b"x")
        survivor = self._runs_via(self.client)["seed0"]
        self.assertEqual(self.client.get(survivor["wait_url"]).status_code, 200)

    def test_a_library_call_with_no_reachable_base_renders_no_field(self) -> None:
        """No request, no base: the facade still answers, just without URLs."""
        view = self.app.call_tool(
            "sandbox.runs",
            {"project_id": self.project_id, "sandbox_uid": self.sandbox_uid},
        )
        self.assertEqual(len(view["runs"]), 2)
        for run in view["runs"]:
            self.assertNotIn("wait_url", run)
        self.assertNotIn(
            "wait_url",
            self.app.sandboxes.runs(
                project_id=self.project_id, sandbox_uid=self.sandbox_uid
            )["runs"][0],
        )

    def test_a_rendered_url_never_reaches_a_persisted_log_intact(self) -> None:
        """The row is a tool RESULT, and results reach the telemetry sinks: the
        durable ledger stores only sizes, and every sink that keeps a body runs
        it through the same scrubber the access log uses."""
        runs = self._by_label(self._legacy(sandbox_uid=self.sandbox_uid))
        url = runs["seed0"]["wait_url"]
        tag = wait_signature(key=SECRET, sandbox_uid=self.sandbox_uid, label="seed0")
        self.assertNotIn(
            tag,
            json.dumps(redact_sensitive(value={"runs": list(runs.values())})),
        )
        self.assertTrue(scrub_secret_text(url).endswith("/seed0/<redacted>"))
        # And through a real sink, not just the helper: the stored row itself
        # must come back masked, or a sink that skips the scrubber hides here.
        sink = ControlToolCallSink()
        sink.record(
            tool="sandbox.runs", source="http", status="ok", duration_ms=1,
            arguments={"project_id": self.project_id},
            result={"runs": list(runs.values())},
        )
        stored = json.dumps(sink.get(call_id=1))
        self.assertIn("seed0", stored)
        self.assertNotIn(tag, stored)


class WaitRedactionTest(unittest.TestCase):
    """The tag is a bearer credential in a URL, so neither scrubber keeps it."""

    def test_the_access_log_scrubber_keeps_the_run_and_masks_the_tag(self) -> None:
        self.assertEqual(
            redact_upload_tokens("/wait/sbx-1/seed0/0f91397d686573aa774bc815b2ce3d66"),
            "/wait/sbx-1/seed0/<redacted>",
        )
        # The upload-token shapes still redact; one function, two families.
        self.assertEqual(
            redact_upload_tokens("/api/artifacts/u/tok_SECRET"),
            "/api/artifacts/u/<redacted>",
        )
        self.assertEqual(
            redact_upload_tokens("/api/projects/p_1/sandboxes/sbx-1"),
            "/api/projects/p_1/sandboxes/sbx-1",
        )

    def test_the_value_scrubber_catches_a_tag_embedded_in_a_command(self) -> None:
        text = (
            "curl -sN https://experiments.rapidreview.io/wait/sbx-1/seed0/"
            "0f91397d686573aa774bc815b2ce3d66"
        )
        scrubbed = scrub_secret_text(text)
        self.assertNotIn("0f91397d686573aa774bc815b2ce3d66", scrubbed)
        self.assertIn("/wait/sbx-1/seed0/<redacted>", scrubbed)


class WaitCompositionTest(unittest.TestCase):
    def test_hosted_composition_without_the_env_secret_fails_the_boot(self) -> None:
        from merv.brain.surface.surface import build_control_server

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            key_path = root / "managed_key"
            key_path.write_text("PRIVATE KEY\n", encoding="utf-8")
            key_path.chmod(0o600)
            env = {
                MGMT_KEY_PATH_ENV_VAR: str(key_path),
                MGMT_PUBLIC_KEY_ENV_VAR: "ssh-ed25519 AAAAmanaged",
                "MERV_ALLOW_OPEN_CONTROL": "1",
            }
            with self.assertRaises(ValidationError) as caught:
                build_control_server(repo_root=root, env=env)
            self.assertIn(WAIT_SECRET_ENV_VAR, caught.exception.message)

    def test_local_composition_generates_its_key_into_the_state_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            app = TestBrain(
                repo_root=repo,
                db_path=repo / ".research_plugin" / "state.sqlite",
                execution_backend=FakeSandboxBackend(),
            )
            self.addCleanup(app.shutdown)
            path = repo / ".research_plugin" / WAIT_SECRET_FILENAME
            self.assertTrue(path.is_file())
            self.assertGreaterEqual(len(path.read_bytes()), MIN_WAIT_SECRET_BYTES)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)


class WaitServerCompositionTest(unittest.TestCase):
    """The programmatic uvicorn wrapper is a composition root too.

    It keeps no state root, so its key is whatever the environment names —
    and it must load it through the same contract rather than mint one that
    dies with the process.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        repo = Path(self.tmp.name)
        self.fake = FakeSandboxBackend()
        self.brain = TestBrain(
            repo_root=repo,
            db_path=repo / ".research_plugin" / "state.sqlite",
            execution_backend=self.fake,
        )
        project_id = self.brain.call_tool(
            "project", {"action": "create", "name": "Waits"}
        )["id"]
        experiment_id = self.brain.call_tool(
            "experiment.create",
            {"project_id": project_id, "name": "wrapped", "intent": "x"},
        )["id"]
        with self.brain.store.transaction() as conn:
            conn.execute(
                "UPDATE experiments SET status = 'ready_to_run' WHERE id = ?",
                (experiment_id,),
            )
        view = self.brain.call_tool(
            "sandbox.request",
            {"project_id": project_id, "experiment_id": experiment_id},
        )
        self.sandbox_uid = view["sandbox_uid"]
        row = self.brain.sandbox_storage.get_by_uid(sandbox_uid=self.sandbox_uid)
        self.fake.run_listings[str(row["sandbox_id"])] = _listing(
            {"label": "seed0", "exit_code": 0, "finished_at": "2026-07-27T10:05:00Z"}
        )
        self.brain.sandbox_observer.observe_live(max_age_seconds=0.0)
        # Module singletons are process-wide by design; each test starts clean.
        runs_wait._ADMISSION = runs_wait._StreamAdmission()
        runs_wait._BUCKET = runs_wait._TokenBucket(
            capacity=runs_wait.BUCKET_CAPACITY,
            per_second=runs_wait.BUCKET_REFILL_PER_SECOND,
        )

    def tearDown(self) -> None:
        self.brain.shutdown()
        self.tmp.cleanup()

    def _serve(self, **kwargs) -> Any:
        server = make_http_server(self.brain, port=0, **kwargs)
        self.addCleanup(server.server_close)
        return server

    def _wait(self, server: Any, *, key: bytes):
        tag = wait_signature(key=key, sandbox_uid=self.sandbox_uid, label="seed0")
        return TestClient(server.fastapi_app).get(
            f"/wait/{self.sandbox_uid}/seed0/{tag}"
        )

    def test_the_env_key_is_what_the_wrapper_signs_with_and_it_survives_a_rebuild(
        self,
    ) -> None:
        # The bug: the wrapper named no key at all, so MERV_WAIT_SECRET sitting
        # right there in its env was ignored and every URL died with the
        # process. Two constructions is the restart an agent's URL must cross.
        key = b"e" * 40
        env = {WAIT_SECRET_ENV_VAR: key.decode("ascii")}
        for _ in range(2):
            response = self._wait(self._serve(env=env), key=key)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(
                response.text,
                "MERV_RUNS_WAIT done seed0 status=finished exit_code=0\n",
            )
        # And it is that key, not any key: another one is the 410 non-answer.
        self.assertEqual(
            self._wait(self._serve(env=env), key=b"f" * 40).status_code, 410
        )

    def test_a_hosted_wrapper_without_the_key_fails_at_construction(self) -> None:
        with self.assertRaises(ValidationError) as caught:
            make_http_server(
                self.brain,
                host="0.0.0.0",
                port=0,
                surface_policy=HttpSurfacePolicy.for_surface(
                    restrict_cors=True, hosted_control=True
                ),
                env={"MERV_ALLOW_OPEN_CONTROL": "1"},
            )
        self.assertIn(WAIT_SECRET_ENV_VAR, caught.exception.message)

    def test_a_local_wrapper_with_no_key_serves_no_wait_route(self) -> None:
        response = self._wait(self._serve(env={}), key=b"e" * 40)
        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
