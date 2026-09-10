"""Version + client-compatibility floors.

The server publishes its own version and the retained minimum legacy-proxy
version at ``GET /api/meta``. Versioned clients stamp requests with
``X-RP-Client-Version``; hosted mode rejects explicitly below-floor clients
with an actionable upgrade error.

Floors are plain constants bumped by hand when a wire change makes an older
client unsafe to serve. The floor moves rarely; it exists so a breaking change has
a refusal mechanism instead of a confusing partial failure. The compatibility
floor remains during the retirement telemetry window for already-shipped
proxies.
"""

from __future__ import annotations

from .. import __version__

# The header clients stamp their version on. Missing header is TOLERATED
# (documented choice):
# a client may predate the handshake, and refusing it would strand in-flight
# upgrades; only an explicitly-too-old version is rejected. Once every
# shipped client sends the header, the floor moving is the enforcement lever.
CLIENT_VERSION_HEADER = "X-RP-Client-Version"

# The current server version (single source: merv.brain.__version__).
SERVER_VERSION = __version__

# Minimum MCP proxy version the control plane will serve.
# 0.0014 fences clients that predate reflection consolidation. Older clients
# would try to publish directly from reflection_review and strand the wave.
MIN_PROXY_VERSION = "0.0014"

# Bump only when the agent-facing MCP catalog changes incompatibly. Unlike the
# retired proxy catalogs, this is a deployment-drift signal, not a file digest.
MCP_CATALOG_VERSION = "2026-09-10"


def _version_tuple(version: str) -> tuple[int, ...]:
    """Parse a dotted numeric version to a comparable tuple.

    Lenient: non-numeric segments contribute 0 so a malformed version sorts low
    (and is therefore rejected against any real floor) rather than raising.
    """
    parts: list[int] = []
    for segment in str(version).strip().split("."):
        try:
            parts.append(int(segment))
        except ValueError:
            parts.append(0)
    return tuple(parts) or (0,)


def is_below_floor(*, client_version: str, floor: str) -> bool:
    """True when ``client_version`` is strictly older than ``floor``."""
    return _version_tuple(client_version) < _version_tuple(floor)


def meta() -> dict[str, str]:
    """The /api/meta payload: server version + the client floors."""
    return {
        "server_version": SERVER_VERSION,
        "min_proxy_version": MIN_PROXY_VERSION,
        "catalog_version": MCP_CATALOG_VERSION,
    }
