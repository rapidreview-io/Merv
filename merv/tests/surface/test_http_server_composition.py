"""The programmatic uvicorn wrapper is a composition root, and answers for it.

``make_http_server``/``UvicornHttpServer`` compose a FastAPI app themselves, so
they must reach the same hosted-auth decision every other composition does.
Omitting ``surface_policy`` selects the unauthenticated LOCAL default, which is
only honest on a loopback bind — hence the non-loopback refusal below. Naming a
LOCAL policy outright composes that SAME surface, so the refusal keys on the
effective policy rather than on the argument being absent.

The wrapper is not the launcher, though: ``merv-http`` runs ``main`` ->
``_serve_local`` -> ``_run_server``, which never touches it. So the refusal is
pinned on THOSE entrypoints too, over the host spellings an operator actually
types — wildcards, IPv6, IPv4-mapped forms, and the empty string.
"""

from __future__ import annotations

import errno
import ipaddress
import socket
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from merv.brain.kernel.secret_tokens import WAIT_SECRET_ENV_VAR
from tests.support.infrastructure import FakeInfrastructureClient
from merv.brain.surface.config import Mode
from merv.brain.surface.transport import http_server
from merv.brain.surface.transport.http_policy import HttpSurfacePolicy
from merv.brain.surface.transport.http_server import (
    is_loopback_host,
    make_http_server,
)
from merv.shared.errors import ValidationError
from tests.support.brain import TestBrain

HOSTED = HttpSurfacePolicy.for_surface(restrict_cors=True, hosted_control=True)
# The same unauthenticated surface the omitted argument composes, spelled out.
LOCAL = HttpSurfacePolicy.for_surface(restrict_cors=False, hosted_control=False)
# A hosted composition must name a run-wait key or fail to build, so the tests
# below carry one: what they pin is the AUTH decision, not that refusal.
WAIT_ENV = {WAIT_SECRET_ENV_VAR: "w" * 40}

# Every spelling that must NOT reach a bind under the local policy: the two
# wildcards, an IPv6 wildcard in brackets, a routable LAN address, IPv4-mapped
# loopback (an AF_INET6 socket accepts v4 traffic on it), and hostnames the
# address parser cannot vouch for.
OFF_MACHINE_HOSTS = (
    "0.0.0.0",
    "0.0.0.0.",
    "::",
    "[::]",
    "0000:0000:0000:0000:0000:0000:0000:0000",
    "::ffff:127.0.0.1",
    "192.168.1.10",
    "example.com",
)
# Reachable only from this machine, so the unauthenticated surface is honest —
# mapped to the address each spelling must actually hand ``socket.bind``. A
# spelling blessed by NAME is pinned to numeric loopback (``socket.bind`` would
# otherwise resolve it a second time, and a resolver is free to answer with a
# LAN address); numeric spellings bind as themselves.
LOOPBACK_BINDS = {
    "": "127.0.0.1",
    "127.0.0.1": "127.0.0.1",
    "127.5.5.5": "127.5.5.5",
    "localhost": "127.0.0.1",
    "::1": "::1",
    "[::1]": "::1",
}
LOOPBACK_HOSTS = tuple(LOOPBACK_BINDS)


class HttpServerCompositionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.app = TestBrain(
            repo_root=root,
            db_path=root / "state.sqlite",
            infrastructure_client=FakeInfrastructureClient(),
        )

    def tearDown(self) -> None:
        self.app.shutdown()
        self.tmp.cleanup()

    def _serve(self, **kwargs):
        server = make_http_server(self.app, port=0, **kwargs)
        self.addCleanup(server.server_close)
        return server

    def test_the_local_default_refuses_a_non_loopback_bind(self) -> None:
        """The reported bypass: build_control_app + host='0.0.0.0' served a full
        unauthenticated surface off-machine without naming any override."""
        for host in ("0.0.0.0", "::", "192.168.1.10"):
            with self.subTest(host=host), self.assertRaises(ValidationError) as ctx:
                make_http_server(self.app, host=host, port=0)
            self.assertIn(host, str(ctx.exception))

    def test_an_explicitly_named_local_policy_is_refused_off_machine(self) -> None:
        """The round-5 bypass: the guard fired only when ``surface_policy`` was
        omitted, so naming the identical LOCAL policy skipped it and bound the
        unauthenticated surface on a wildcard. WHICH surface this is does not
        depend on how the caller spelled it."""
        for host in OFF_MACHINE_HOSTS:
            with self.subTest(host=host):
                with mock.patch.object(http_server, "_bind_socket") as bind:
                    with self.assertRaises(ValidationError) as ctx:
                        make_http_server(
                            self.app, host=host, port=0, surface_policy=LOCAL
                        )
                bind.assert_not_called()
                self.assertIn(host, str(ctx.exception))

    def test_the_loopback_local_policy_still_composes(self) -> None:
        """Naming LOCAL is refused off-machine, not everywhere."""
        server = self._serve(host="127.0.0.1", surface_policy=LOCAL)
        self.assertEqual(server.server_address[0], "127.0.0.1")

    def test_the_loopback_local_default_still_composes(self) -> None:
        for host in ("127.0.0.1", "localhost", "::1"):
            with self.subTest(host=host):
                server = self._serve(host=host)
                # Reported as bound, not as typed: a name was pinned.
                self.assertEqual(server.server_address[0], LOOPBACK_BINDS[host])

    def _bound_address(self, **kwargs) -> tuple[Any, Any]:
        """The address handed to ``socket.bind``, with the socket itself faked.

        Binding for real proves nothing here: THIS machine's resolver maps
        ``localhost`` to 127.0.0.1, so a name reaching the socket unpinned
        would look identical. The string passed is the thing under test.
        """
        with mock.patch.object(http_server, "socket") as sock:
            sock.socket.return_value.getsockname.return_value = ("127.0.0.1", 8787)
            server = make_http_server(self.app, port=0, **kwargs)
        return sock.socket.return_value.bind.call_args.args[0], server

    def test_a_blessed_name_binds_the_numeric_loopback_it_was_blessed_as(self) -> None:
        """``localhost`` classifies as loopback by NAME, but ``socket.bind``
        resolves the name a second time — a resolver answering with a LAN
        address would bind off-machine under a guard that just said loopback.
        Names never reach the socket: they are pinned to numeric loopback."""
        for host in ("localhost", "LOCALHOST", " localhost ", ""):
            with self.subTest(host=host):
                address, server = self._bound_address(host=host, surface_policy=LOCAL)
                self.assertEqual(address[0], "127.0.0.1")
                self.assertTrue(ipaddress.ip_address(address[0]).is_loopback)
                self.assertEqual(server.server_address[0], "127.0.0.1")

    def test_numeric_loopback_spellings_bind_themselves(self) -> None:
        """The pin normalizes names, it does not collapse addresses: an
        operator who asked for ::1 or 127.5.5.5 gets that interface."""
        for host, expected in LOOPBACK_BINDS.items():
            with self.subTest(host=host):
                address, _server = self._bound_address(host=host)
                self.assertEqual(address[0], expected)

    def test_a_non_loopback_hosted_surface_makes_the_auth_decision(self) -> None:
        """Naming the hosted surface routes the wrapper through the same gate:
        no verifier and no override is a refusal, not an open plane."""
        with self.assertRaises(ValidationError) as ctx:
            make_http_server(
                self.app, host="0.0.0.0", port=0, surface_policy=HOSTED,
                env=WAIT_ENV,
            )
        self.assertIn(
            "refuses to serve an unauthenticated surface", str(ctx.exception)
        )

    def test_the_hosted_override_is_threaded_through_to_the_gate(self) -> None:
        """And the deliberate, loudly logged escape still works — proving the
        wrapper threads env into the decision rather than bypassing it."""
        with self.assertLogs("merv.brain.surface.auth", level="WARNING") as logs:
            server = self._serve(
                host="0.0.0.0",
                surface_policy=HOSTED,
                env={**WAIT_ENV, "MERV_ALLOW_OPEN_CONTROL": "1"},
            )
        self.assertEqual(server.server_address[0], "0.0.0.0")
        self.assertIn("OPEN CONTROL PLANE", "\n".join(logs.output))

    def test_loopback_classification(self) -> None:
        self.assertTrue(all(map(is_loopback_host, LOOPBACK_HOSTS)))
        self.assertFalse(any(map(is_loopback_host, OFF_MACHINE_HOSTS)))

    def test_every_blessed_loopback_spelling_binds_a_real_socket(self) -> None:
        """Classification that a socket then rejects is worse than useless: it
        blesses a spelling the operator cannot actually serve on. ``[::1]`` is
        URL syntax and raised ``gaierror`` unnormalized, so bind for real."""
        bound_hosts = []
        for host in LOOPBACK_HOSTS:
            with self.subTest(host=host):
                try:
                    server_socket = http_server._bind_socket(host=host, port=0)
                except OSError as exc:
                    # No interface for this address (macOS aliases only
                    # 127.0.0.1; some hosts have no IPv6) is a machine fact, so
                    # skip that spelling alone. An unresolvable spelling is the
                    # normalization bug, so gaierror is never excused.
                    if not isinstance(exc, socket.gaierror) and (
                        exc.errno == errno.EADDRNOTAVAIL
                    ):
                        continue
                    raise
                self.addCleanup(server_socket.close)
                bound = server_socket.getsockname()[0]
                self.assertTrue(ipaddress.ip_address(bound).is_loopback)
                bound_hosts.append(host)
        # A machine with no loopback at all would make the whole loop vacuous.
        self.assertIn("127.0.0.1", bound_hosts)


class LocalLauncherBindTest(unittest.TestCase):
    """The refusal on the path ``merv-http`` actually takes.

    ``main`` -> ``_serve_local`` -> ``_run_server`` never constructs
    ``UvicornHttpServer``, so the wrapper's guard proves nothing about the
    shipped console script. These pin the launcher itself, and they patch the
    bind so a regression fails the assertion instead of opening a real socket.
    """

    def _run(self, *, host: str, local_surface: bool) -> tuple[Any, Any]:
        """Drive ``_run_server`` with the socket and uvicorn stubbed out."""
        with (
            mock.patch.object(http_server, "_bind_socket") as bind,
            mock.patch.object(http_server, "uvicorn") as uv,
        ):
            bind.return_value.getsockname.return_value = (host, 8787)
            result = http_server._run_server(
                server=mock.Mock(),
                host=host,
                port=0,
                label="brain",
                local_surface=local_surface,
            )
        self.assertEqual(result, 0)
        return bind, uv

    def test_run_server_refuses_every_off_machine_spelling_before_binding(self) -> None:
        for host in OFF_MACHINE_HOSTS:
            with self.subTest(host=host):
                with mock.patch.object(http_server, "_bind_socket") as bind:
                    with self.assertRaises(ValidationError) as ctx:
                        http_server._run_server(
                            server=mock.Mock(),
                            host=host,
                            port=0,
                            label="brain",
                            local_surface=True,
                        )
                bind.assert_not_called()
                self.assertIn(host, str(ctx.exception))

    def test_run_server_serves_loopback_including_the_empty_host_default(self) -> None:
        """Empty is the argparse fallback ``_bind_socket`` reads as 127.0.0.1."""
        for host in LOOPBACK_HOSTS:
            with self.subTest(host=host):
                bind, uv = self._run(host=host, local_surface=True)
                bind.assert_called_once_with(host=LOOPBACK_BINDS[host], port=0)
                uv.Server.return_value.run.assert_called_once()

    def test_run_server_pins_a_loopback_name_to_a_numeric_bind(self) -> None:
        """The console-script path, down to the socket: ``--host localhost`` is
        blessed by name, so the name must never be what ``socket.bind``
        resolves — a resolver mapping it to a LAN address would serve the
        unauthenticated surface off-machine under a loopback verdict."""
        with (
            mock.patch.object(http_server, "socket") as sock,
            mock.patch.object(http_server, "uvicorn") as uv,
        ):
            sock.socket.return_value.getsockname.return_value = ("127.0.0.1", 8787)
            http_server._run_server(
                server=mock.Mock(),
                host="localhost",
                port=0,
                label="brain",
                local_surface=True,
            )
        address = sock.socket.return_value.bind.call_args.args[0]
        self.assertEqual(address[0], "127.0.0.1")
        self.assertEqual(uv.Config.call_args.kwargs["host"], "127.0.0.1")

    def test_the_hosted_plane_still_binds_off_machine(self) -> None:
        """CONTROL composes an authenticated surface and made its own decision,
        so the local refusal must not reach it — deploys bind 0.0.0.0."""
        bind, _uv = self._run(host="0.0.0.0", local_surface=False)
        bind.assert_called_once_with(host="0.0.0.0", port=0)

    def test_serve_local_refuses_before_it_builds_a_brain(self) -> None:
        """Refusal precedes composition: no state dir, no store, no socket."""
        for host in OFF_MACHINE_HOSTS:
            with self.subTest(host=host):
                with (
                    mock.patch(
                        "merv.brain.surface.surface.build_local_server"
                    ) as build,
                    mock.patch.object(http_server, "_bind_socket") as bind,
                ):
                    with self.assertRaises(ValidationError) as ctx:
                        http_server._serve_local(host=host, port=0, state_dir=None)
                build.assert_not_called()
                bind.assert_not_called()
                self.assertIn(host, str(ctx.exception))

    def test_serve_local_tells_run_server_the_surface_is_unauthenticated(self) -> None:
        """The two guards are one decision, not two opinions that can drift."""
        with (
            mock.patch("merv.brain.surface.surface.build_local_server"),
            mock.patch.object(http_server, "_run_server", return_value=0) as run,
        ):
            http_server._serve_local(host="127.0.0.1", port=0, state_dir=None)
        self.assertTrue(run.call_args.kwargs["local_surface"])

    def test_the_merv_http_entrypoint_refuses_the_reported_wildcard(self) -> None:
        """The literal report: ``merv-http --host 0.0.0.0`` in default mode."""
        with (
            mock.patch("sys.argv", ["merv-http", "--host", "0.0.0.0", "--port", "0"]),
            mock.patch.object(http_server, "resolve_mode", return_value=Mode.LOCAL),
            mock.patch("merv.brain.surface.surface.build_local_server") as build,
            mock.patch.object(http_server, "_bind_socket") as bind,
        ):
            with self.assertRaises(ValidationError):
                http_server.main()
        build.assert_not_called()
        bind.assert_not_called()


if __name__ == "__main__":
    unittest.main()
