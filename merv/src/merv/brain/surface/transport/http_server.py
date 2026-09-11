"""HTTP process for the Merv brain server.

Owns the running uvicorn server: binds the socket and serves the FastAPI app
from the unified brain composition. Local deployment is just this server on
localhost with small-store defaults.
"""

from __future__ import annotations

import argparse
import ipaddress
import os
import socket
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import uvicorn

from ..config import Mode, resolve_mode
from ...kernel.env import env_bool, env_value
from ...kernel.utils import ValidationError
from .api import create_fastapi_app
from .http_policy import HttpSurfacePolicy


def _normalize_host(host: str) -> str:
    """The bare address ``socket.bind`` wants, from what an operator typed.

    Brackets are URL syntax for IPv6 (``[::1]``) and ``socket.bind`` raises
    ``gaierror`` on them, so classification and the bind normalize identically:
    a spelling the loopback check blesses is the spelling that gets bound.
    """
    return (host or "127.0.0.1").strip().strip("[]")


def _loopback_bind_host(host: str) -> str:
    """The numeric address a blessed loopback spelling must actually bind.

    ``is_loopback_host`` blesses ``localhost`` by NAME, but ``socket.bind``
    resolves that name a second time — a resolver mapping it to a LAN address
    would bind off-machine under a guard that just said loopback. So a
    non-numeric spelling is pinned to numeric loopback and numeric spellings
    bind as themselves: what was classified is what gets bound.
    """
    spelling = _normalize_host(host)
    try:
        ipaddress.ip_address(spelling)
    except ValueError:
        return "127.0.0.1"
    return spelling


def _bind_socket(*, host: str, port: int) -> socket.socket:
    bind_host = _normalize_host(host)
    family = socket.AF_INET6 if ":" in bind_host else socket.AF_INET
    server_socket = socket.socket(family, socket.SOCK_STREAM)
    server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server_socket.bind((bind_host, port))
    server_socket.listen(socket.SOMAXCONN)
    server_socket.set_inheritable(True)
    return server_socket


def _uvicorn(app: Any, *, host: str, port: int) -> uvicorn.Server:
    return uvicorn.Server(uvicorn.Config(
        app,
        host=host,
        port=port,
        log_level="warning",
        access_log=False,
        lifespan="on",
        # Honor X-Forwarded-Proto/-For from the fronting proxy only: the
        # artifact upload curls are minted from request.base_url and must say
        # https, and the pairing route's per-IP budget is keyed on the client
        # address, which any peer could otherwise forge. uvicorn reads the
        # trusted addresses from FORWARDED_ALLOW_IPS (default 127.0.0.1); the
        # deployment sets it to the proxy's network.
        proxy_headers=True,
        forwarded_allow_ips=None,
    ))


def is_loopback_host(host: str) -> bool:
    """Whether binding ``host`` can only be reached from this machine."""
    spelling = _normalize_host(host).lower()
    if spelling == "localhost":
        return True
    try:
        address = ipaddress.ip_address(spelling)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return False
    return address.is_loopback


def refuse_non_loopback_local_surface(host: str) -> str:
    """Refuse to bind the unauthenticated LOCAL surface off-machine.

    Every launcher that can serve the local default asks this BEFORE it binds —
    the wrapper below, the ``merv-http`` console script, the dev daemons — so
    one host spelling cannot open the full surface to the network. Anything
    that is not provably loopback (an unparseable spelling, an IPv4-mapped
    form, a wildcard) is refused, because guessing wrong here serves the whole
    tool surface to anyone who can route to the box.

    Returns the address to bind, so the verdict and the bind are one step: a
    name this blessed (``localhost``) is pinned to numeric loopback rather than
    handed to a resolver that could still land it on a LAN interface.
    """
    if is_loopback_host(host):
        return _loopback_bind_host(host)
    raise ValidationError(
        f"refusing to serve the unauthenticated local surface on {host!r}: "
        "bind a loopback address, or compose the hosted surface (a "
        "hosted_control surface_policy, and auth) so the hosted "
        "authentication decision is made explicitly.",
        details={"host": host},
    )


class UvicornHttpServer:
    """uvicorn server wrapper used by compatibility tests.

    The production launcher builds the unified brain directly. This wrapper is
    a small socket/uvicorn harness for tests and programmatic callers.

    It is also a composition root, so it answers the same question every other
    one does: WHICH surface is this? Passing ``surface_policy`` threads the
    answer (with ``auth``/``env``) into ``create_fastapi_app``, where the
    hosted gate decides.

    The refusal keys on the EFFECTIVE policy, not on whether one was named: a
    local policy is the unauthenticated surface whether it arrives by omission
    or by ``HttpSurfacePolicy(hosted_control=False)``, and it is only honest on a
    loopback bind. Only ``hosted_control`` — which has already made the auth
    decision at the gate — may bind off-machine.

    """

    def __init__(
        self,
        *,
        app: Any,
        host: str,
        port: int,
        surface_policy: HttpSurfacePolicy | None = None,
        auth: Any | None = None,
        env: Mapping[str, str] | None = None,
    ) -> None:
        bind_host = host
        hosted = surface_policy is not None and surface_policy.hosted_control
        if not hosted:
            bind_host = refuse_non_loopback_local_surface(host)
        fastapi_app = create_fastapi_app(
            app=app,
            surface_policy=surface_policy,
            auth=auth,
            env=env,
        )
        self.fastapi_app = fastapi_app
        self._socket = _bind_socket(host=bind_host, port=port)
        selected_port = int(self._socket.getsockname()[1])
        self.server_address = (bind_host, selected_port)
        self._server = _uvicorn(fastapi_app, host=bind_host, port=selected_port)

    def serve_forever(self) -> None:
        self._server.run(sockets=[self._socket])

    def shutdown(self) -> None:
        self._server.should_exit = True

    def server_close(self) -> None:
        self._socket.close()


def make_http_server(
    app: Any,
    host: str = "127.0.0.1",
    port: int = 8787,
    *,
    surface_policy: HttpSurfacePolicy | None = None,
    auth: Any | None = None,
    env: Mapping[str, str] | None = None,
) -> UvicornHttpServer:
    return UvicornHttpServer(
        app=app,
        host=host,
        port=port,
        surface_policy=surface_policy,
        auth=auth,
        env=env,
    )


def _run_server(
    *, server: Any, host: str, port: int, label: str, local_surface: bool = False
) -> int:
    """Bind and serve an already-composed brain.

    ``local_surface`` says the composition above chose the unauthenticated
    local policy, so the same non-loopback refusal the programmatic wrapper
    makes applies here — at the bind itself, which is the one place every
    launcher passes through, and it also decides the address bound.
    """
    bind_host = host
    if local_surface:
        bind_host = refuse_non_loopback_local_surface(host)
    server_socket = _bind_socket(host=bind_host, port=port)
    selected_port = int(server_socket.getsockname()[1])
    uv = _uvicorn(server.fastapi_app, host=bind_host, port=selected_port)
    print(f"merv {label} listening on http://{bind_host}:{selected_port}", flush=True)
    try:
        uv.run(sockets=[server_socket])
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server_socket.close()
    return 0


def _serve_control(*, host: str, port: int) -> int:
    """Run the hosted brain preset.

    Hosted/no-repo-root control requires durable DB, durable blob store, and a
    configured merv-sandboxes connection. End-user auth is Supabase-backed and REQUIRED:
    booting without a verifier fails startup unless the operator sets
    MERV_ALLOW_OPEN_CONTROL=1, which serves an OPEN surface and says so in the
    boot log.
    """
    from ..surface import build_control_server

    server = build_control_server()
    return _run_server(server=server, host=host, port=port, label="CONTROL plane")


def _serve_local(*, host: str, port: int, state_dir: Path | None) -> int:
    """Run the localhost brain preset.

    This preset composes the unauthenticated local policy, so it refuses a
    non-loopback ``--host``/``MERV_HTTP_HOST`` before it builds anything —
    long before a socket exists. Serving off-machine is the hosted brain's
    job (``MERV_MODE=control``), which makes the auth decision explicitly.
    """
    refuse_non_loopback_local_surface(host)
    from ..surface import build_local_server

    server = build_local_server(state_dir=state_dir)
    return _run_server(
        server=server, host=host, port=port, label="brain", local_surface=True
    )


def control_main() -> int:
    """Launch the hosted brain.

    The console-script entry for the ``control`` extra and the deploy Dockerfile:
    forces control mode (MERV_MODE=control) so the image entrypoint
    never accidentally binds the local preset. The retention clock sweeps every
    owner's rows in-process; ``POST /api/admin/cleanup`` runs the same sweeps on
    demand. End-user auth is Supabase verification and startup
    fails without it (MERV_ALLOW_OPEN_CONTROL=1 is the deliberate, loudly
    logged escape); deploy behind TLS and a trusted network boundary either way.
    """
    os.environ["MERV_MODE"] = "control"
    return main()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=env_value("MERV_HTTP_HOST") or "127.0.0.1")
    parser.add_argument("--port", type=int, default=int(env_value("MERV_HTTP_PORT") or "8787"))
    parser.add_argument(
        "--registry-store",
        default=env_value("MERV_REGISTRY_STORE"),
        help=(
            "Compatibility path whose parent selects the local brain state "
            "root (research records live under the sibling brain/ directory). "
            "Unset lets the composition resolve ~/.merv/brain, or the legacy "
            "~/.research_plugin/brain when that state already exists."
        ),
    )
    parser.add_argument(
        "--activity-stderr",
        action="store_true",
        default=env_bool("MERV_ACTIVITY_STDERR", default=False),
        help=(
            "Legacy compatibility flag. The unified brain exposes bounded "
            "diagnostics over HTTP and does not mirror them to stderr."
        ),
    )
    args = parser.parse_args()

    mode = resolve_mode()
    if mode is Mode.CONTROL:
        return _serve_control(host=args.host, port=args.port)

    if args.activity_stderr:
        os.environ["MERV_ACTIVITY_STDERR"] = "1"
    return _serve_local(
        host=args.host,
        port=args.port,
        state_dir=(
            Path(args.registry_store).expanduser().resolve().parent / "brain"
            if args.registry_store
            else None
        ),
    )


if __name__ == "__main__":
    raise SystemExit(main())
