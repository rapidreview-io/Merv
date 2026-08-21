#!/usr/bin/env python3
"""Pair a Kilo/OpenCode install with Merv's MCP, no browser-to-machine hop.

The stock ``kilo mcp auth merv`` flow ends with the browser redirecting to a
loopback URL on the machine running the client — which fails when that machine
is a VM reached over SSH. This script uses Merv's RFC 8628 device grant
instead: it polls the brain with a secret only this machine holds, you approve
a short code in any signed-in browser, and the minted tokens are written into
the client's own MCP token store (``mcp-auth.json``). From then on the client
uses and refreshes them natively; no tunnel, no key copying, ever.

Stdlib only — runs anywhere Python 3.9+ exists:

    python3 pair_mcp.py                     # autodetect kilo/opencode store
    python3 pair_mcp.py --client kilo
    python3 pair_mcp.py --server-url https://dev-experiments.rapidreview.io/mcp
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import NoReturn

DEFAULT_SERVER_URL = "https://experiments.rapidreview.io/mcp"
CLIENT_NAME = "Merv MCP pairing"
DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
USER_AGENT = "merv-pair-mcp/1"


def data_dir(flavor: str) -> str:
    base = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    return os.path.join(base, flavor)


def detect_store(client: str | None, store: str | None) -> tuple[str, str]:
    """Return (label, mcp-auth.json path) for the chosen or detected client."""
    if store:
        return ("custom", store)
    if client:
        return (client, os.path.join(data_dir(client), "mcp-auth.json"))
    present = [name for name in ("kilo", "opencode") if os.path.isdir(data_dir(name))]
    if len(present) == 1:
        return (present[0], os.path.join(data_dir(present[0]), "mcp-auth.json"))
    if not present:
        sys.exit(
            "error: found neither a kilo nor an opencode data directory; "
            "pass --client kilo|opencode or --store PATH"
        )
    sys.exit(
        "error: both kilo and opencode are installed; pass --client to pick one"
    )


def http_json(
    url: str,
    *,
    form: dict[str, str] | None = None,
    body_json: dict | None = None,
) -> tuple[int, dict]:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    data = None
    if form is not None:
        data = urllib.parse.urlencode(form).encode("ascii")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    elif body_json is not None:
        data = json.dumps(body_json).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return (response.status, json.loads(response.read() or b"{}"))
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read() or b"{}")
        except ValueError:
            payload = {}
        return (error.code, payload)


def fail(message: str) -> NoReturn:
    sys.exit(f"error: {message}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--server-url", default=DEFAULT_SERVER_URL)
    parser.add_argument("--client", choices=("kilo", "opencode"))
    parser.add_argument("--store", help="explicit path to an mcp-auth.json")
    parser.add_argument(
        "--name", default="merv", help="MCP entry name in the store (default: merv)"
    )
    args = parser.parse_args()

    server_url = args.server_url.rstrip("/")
    origin = "{0.scheme}://{0.netloc}".format(urllib.parse.urlsplit(server_url))
    label, store_path = detect_store(args.client, args.store)
    print(f"Pairing {label} with {server_url}")

    status, metadata = http_json(f"{origin}/.well-known/oauth-authorization-server")
    if status != 200:
        fail(f"could not read OAuth metadata from {origin} (HTTP {status})")
    device_endpoint = metadata.get("device_authorization_endpoint")
    token_endpoint = metadata.get("token_endpoint")
    registration_endpoint = metadata.get("registration_endpoint")
    if not device_endpoint:
        fail(
            "this Merv server does not offer the device grant yet; "
            "upgrade the brain or use the SSH port-forward flow in AUTH.md"
        )

    # Identical metadata resolves to the identical client server-side, so
    # every run of this script shares one registration.
    status, registration = http_json(
        registration_endpoint,
        body_json={
            "client_name": CLIENT_NAME,
            "token_endpoint_auth_method": "none",
            "grant_types": [DEVICE_GRANT, "refresh_token"],
        },
    )
    if status != 201:
        fail(f"client registration failed (HTTP {status}): {registration}")
    client_id = registration["client_id"]

    status, start = http_json(
        device_endpoint, form={"client_id": client_id, "resource": server_url}
    )
    if status == 429:
        fail("too many pairing attempts from this address; wait a minute and retry")
    if status != 200:
        fail(f"device authorization failed (HTTP {status}): {start}")

    print()
    print(f"  Open:  {start['verification_uri_complete']}")
    print(f"  Code:  {start['user_code']}")
    print()
    print("Sign in and approve in any browser — it never needs to reach this machine.")
    print("Waiting for approval...", flush=True)

    interval = max(1, int(start.get("interval") or 5))
    deadline = time.time() + int(start.get("expires_in") or 600)
    tokens = None
    while time.time() < deadline:
        time.sleep(interval)
        status, poll = http_json(
            token_endpoint,
            form={
                "grant_type": DEVICE_GRANT,
                "client_id": client_id,
                "device_code": start["device_code"],
                "resource": server_url,
            },
        )
        if status == 200:
            tokens = poll
            break
        error = str(poll.get("error") or "")
        if error == "authorization_pending":
            continue
        if error == "slow_down":
            interval += 5
            continue
        if error == "access_denied":
            fail("the request was denied in the browser")
        if error == "expired_token":
            fail("the code expired before it was approved; run the script again")
        fail(f"token exchange failed (HTTP {status}): {poll}")
    if tokens is None:
        fail("the code expired before it was approved; run the script again")

    entry = {
        "tokens": {
            "accessToken": tokens["access_token"],
            "refreshToken": tokens.get("refresh_token"),
            # The client compares seconds-since-epoch, mirroring its own
            # ``Date.now() / 1000 + expires_in`` stamp.
            "expiresAt": time.time() + int(tokens.get("expires_in") or 3600),
        },
        "clientInfo": {
            "clientId": client_id,
            "clientIdIssuedAt": int(registration.get("client_id_issued_at") or 0),
        },
        "serverUrl": server_url,
    }
    store: dict = {}
    if os.path.exists(store_path):
        try:
            with open(store_path, encoding="utf-8") as handle:
                store = json.load(handle)
        except ValueError:
            fail(f"{store_path} exists but is not valid JSON; move it aside and retry")
        if not isinstance(store, dict):
            fail(f"{store_path} does not hold a JSON object; move it aside and retry")
    store[args.name] = entry
    os.makedirs(os.path.dirname(store_path), exist_ok=True)
    fd, temp_path = tempfile.mkstemp(
        dir=os.path.dirname(store_path), prefix=".mcp-auth-"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(store, handle, indent=1)
        os.chmod(temp_path, 0o600)
        os.replace(temp_path, store_path)
    except BaseException:
        os.unlink(temp_path)
        raise

    print()
    print(f"Paired. Tokens written to {store_path} under '{args.name}'.")
    print(f"Restart {label}; it refreshes the token on its own from here on.")


if __name__ == "__main__":
    main()
