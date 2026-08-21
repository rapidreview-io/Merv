"""Portable OAuth device-login and STDIO-to-HTTP MCP bridge.

The bridge lets an MCP client running on a remote machine use Merv without a
loopback browser callback and without a user-managed API key.  A human runs
``merv-mcp login`` once, approves the short code in any browser, and configures
the client to launch ``merv-mcp serve`` as a local STDIO server.
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any, BinaryIO, TextIO


DEFAULT_SERVER_URL = "https://experiments.rapidreview.io/mcp"
DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
CLIENT_NAME = "Merv portable MCP bridge"
USER_AGENT = "merv-mcp/1"
MCP_ACCEPT = "application/json, text/event-stream"
REFRESH_EARLY_SECONDS = 60


class BridgeError(Exception):
    """Safe, user-facing bridge failure."""


def credential_path() -> Path:
    override = os.environ.get("MERV_OAUTH_STORE")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".merv" / "oauth.json"


def normalize_resource(value: str) -> str:
    """Validate and canonicalize one remote MCP resource URL."""
    try:
        parsed = urllib.parse.urlsplit(value.strip())
        port = parsed.port
    except ValueError as exc:
        raise BridgeError("server URL is malformed") from exc
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise BridgeError(
            "server URL cannot contain credentials, a query, or a fragment"
        )
    hostname = (parsed.hostname or "").lower()
    loopback = hostname in {"127.0.0.1", "::1", "localhost"}
    if parsed.scheme != "https" and not (parsed.scheme == "http" and loopback):
        raise BridgeError(
            "server URL must use HTTPS (HTTP is allowed only on loopback)"
        )
    if not hostname:
        raise BridgeError("server URL must include a host")
    host = f"[{hostname}]" if ":" in hostname else hostname
    authority = f"{host}:{port}" if port is not None else host
    path = parsed.path.rstrip("/") or "/mcp"
    return urllib.parse.urlunsplit((parsed.scheme, authority, path, "", ""))


def resource_origin(resource: str) -> str:
    parsed = urllib.parse.urlsplit(resource)
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))


def checked_endpoint(value: object, *, origin: str, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise BridgeError(f"OAuth metadata is missing {field}")
    parsed = urllib.parse.urlsplit(value)
    endpoint_origin = urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, "", "", "")
    )
    if (
        endpoint_origin != origin
        or parsed.username
        or parsed.password
        or parsed.fragment
    ):
        raise BridgeError(f"OAuth {field} must be on the Merv server origin")
    return value


class CredentialStore:
    """Atomic, owner-only storage keyed by the canonical MCP resource URL."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or credential_path()

    def get(self, resource: str) -> dict[str, Any] | None:
        value = self._read().get(resource)
        return dict(value) if isinstance(value, dict) else None

    def put(self, resource: str, credential: Mapping[str, Any]) -> None:
        data = self._read()
        data[resource] = dict(credential)
        self._write(data)

    def remove(self, resource: str) -> bool:
        data = self._read()
        existed = resource in data
        if existed:
            data.pop(resource)
            self._write(data)
        return existed

    def _read(self) -> dict[str, Any]:
        try:
            info = self.path.lstat()
        except FileNotFoundError:
            return {}
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            raise BridgeError(f"credential store is not a regular file: {self.path}")
        if os.name != "nt" and stat.S_IMODE(info.st_mode) & 0o077:
            raise BridgeError(
                f"credential store is readable by other users; run chmod 600 {self.path}"
            )
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise BridgeError(f"could not read credential store: {self.path}") from exc
        if not isinstance(value, dict):
            raise BridgeError(
                f"credential store must contain a JSON object: {self.path}"
            )
        return value

    def _write(self, value: Mapping[str, Any]) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if os.name != "nt":
            os.chmod(parent, 0o700)
        fd, temporary = tempfile.mkstemp(dir=parent, prefix=".oauth-")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(value, handle, indent=2, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            if os.name != "nt":
                os.chmod(temporary, 0o600)
            os.replace(temporary, self.path)
        except BaseException:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            raise


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _request(
    url: str,
    *,
    form: Mapping[str, str] | None = None,
    json_body: Mapping[str, Any] | None = None,
    headers: Mapping[str, str] | None = None,
    timeout: int = 60,
) -> tuple[int, Mapping[str, str], bytes]:
    request_headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        **dict(headers or {}),
    }
    data = None
    if form is not None:
        data = urllib.parse.urlencode(form).encode("ascii")
        request_headers["Content-Type"] = "application/x-www-form-urlencoded"
    elif json_body is not None:
        data = json.dumps(json_body, separators=(",", ":")).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=request_headers)
    opener = urllib.request.build_opener(_NoRedirect())
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers, exc.read()
    except (OSError, urllib.error.URLError) as exc:
        raise BridgeError(f"could not reach {url}") from exc


def _json_payload(body: bytes, *, what: str) -> dict[str, Any]:
    try:
        value = json.loads(body or b"{}")
    except (UnicodeDecodeError, ValueError) as exc:
        raise BridgeError(f"{what} returned malformed JSON") from exc
    if not isinstance(value, dict):
        raise BridgeError(f"{what} returned a non-object JSON response")
    return value


class OAuthDeviceClient:
    def __init__(
        self,
        *,
        resource: str,
        store: CredentialStore,
        request: Callable[..., tuple[int, Mapping[str, str], bytes]] = _request,
    ) -> None:
        self.resource = normalize_resource(resource)
        self.origin = resource_origin(self.resource)
        self.store = store
        self.request = request

    def discovery(self) -> dict[str, str]:
        status, _headers, body = self.request(
            f"{self.origin}/.well-known/oauth-authorization-server"
        )
        if status != 200:
            raise BridgeError(f"OAuth discovery failed with HTTP {status}")
        metadata = _json_payload(body, what="OAuth discovery")
        if metadata.get("issuer") != self.origin:
            raise BridgeError("OAuth issuer does not match the Merv server origin")
        return {
            name: checked_endpoint(metadata.get(name), origin=self.origin, field=name)
            for name in (
                "registration_endpoint",
                "device_authorization_endpoint",
                "token_endpoint",
            )
        }

    def login(
        self,
        *,
        output: TextIO = sys.stdout,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], float] = time.time,
    ) -> dict[str, Any]:
        endpoints = self.discovery()
        status, _headers, body = self.request(
            endpoints["registration_endpoint"],
            json_body={
                "client_name": CLIENT_NAME,
                "token_endpoint_auth_method": "none",
                "grant_types": [DEVICE_GRANT, "refresh_token"],
            },
        )
        registration = _json_payload(body, what="client registration")
        if status != 201 or not isinstance(registration.get("client_id"), str):
            raise BridgeError(
                f"client registration failed with HTTP {status}: "
                f"{registration.get('error_description') or registration.get('error') or 'unknown error'}"
            )
        client_id = registration["client_id"]
        status, _headers, body = self.request(
            endpoints["device_authorization_endpoint"],
            form={"client_id": client_id, "resource": self.resource},
        )
        started = _json_payload(body, what="device authorization")
        if status != 200:
            raise BridgeError(
                f"device authorization failed with HTTP {status}: "
                f"{started.get('error_description') or started.get('error') or 'unknown error'}"
            )
        for field in ("device_code", "user_code", "verification_uri"):
            if not isinstance(started.get(field), str) or not started[field]:
                raise BridgeError(f"device authorization response is missing {field}")

        verification = (
            started.get("verification_uri_complete") or started["verification_uri"]
        )
        print(f"Open: {verification}", file=output)
        print(f"Code: {started['user_code']}", file=output)
        print("Approve in any signed-in browser. Waiting for approval...", file=output)
        output.flush()

        interval = max(1, int(started.get("interval") or 5))
        deadline = now() + max(1, int(started.get("expires_in") or 600))
        while now() < deadline:
            sleep(interval)
            status, _headers, body = self.request(
                endpoints["token_endpoint"],
                form={
                    "grant_type": DEVICE_GRANT,
                    "client_id": client_id,
                    "device_code": started["device_code"],
                    "resource": self.resource,
                },
            )
            token = _json_payload(body, what="token endpoint")
            if status == 200:
                credential = self._credential(
                    token=token,
                    client_id=client_id,
                    token_endpoint=endpoints["token_endpoint"],
                    now=now(),
                )
                self.store.put(self.resource, credential)
                return credential
            error = str(token.get("error") or "")
            if error == "authorization_pending":
                continue
            if error == "slow_down":
                interval += 5
                continue
            if error == "access_denied":
                raise BridgeError("device authorization was denied")
            if error == "expired_token":
                break
            raise BridgeError(
                f"token exchange failed with HTTP {status}: "
                f"{token.get('error_description') or error or 'unknown error'}"
            )
        raise BridgeError("device code expired before it was approved; run login again")

    def access_token(self, *, force_refresh: bool = False) -> str:
        credential = self.store.get(self.resource)
        if credential is None:
            raise BridgeError("not signed in; run `merv-mcp login` on this machine")
        expires_at = float(credential.get("expires_at") or 0)
        if force_refresh or expires_at <= time.time() + REFRESH_EARLY_SECONDS:
            credential = self.refresh(credential)
        token = credential.get("access_token")
        if not isinstance(token, str) or not token:
            raise BridgeError(
                "stored OAuth credential has no access token; sign in again"
            )
        return token

    def refresh(self, credential: Mapping[str, Any]) -> dict[str, Any]:
        refresh_token = credential.get("refresh_token")
        client_id = credential.get("client_id")
        if not isinstance(refresh_token, str) or not isinstance(client_id, str):
            raise BridgeError("stored OAuth credential cannot refresh; sign in again")
        endpoints = self.discovery()
        status, _headers, body = self.request(
            endpoints["token_endpoint"],
            form={
                "grant_type": "refresh_token",
                "client_id": client_id,
                "refresh_token": refresh_token,
                "resource": self.resource,
            },
        )
        token = _json_payload(body, what="token refresh")
        if status != 200:
            raise BridgeError(
                "OAuth refresh failed; run `merv-mcp login` again "
                f"(HTTP {status}: {token.get('error_description') or token.get('error') or 'unknown error'})"
            )
        refreshed = self._credential(
            token=token,
            client_id=client_id,
            token_endpoint=endpoints["token_endpoint"],
            now=time.time(),
            previous_refresh=refresh_token,
        )
        self.store.put(self.resource, refreshed)
        return refreshed

    def _credential(
        self,
        *,
        token: Mapping[str, Any],
        client_id: str,
        token_endpoint: str,
        now: float,
        previous_refresh: str | None = None,
    ) -> dict[str, Any]:
        access_token = token.get("access_token")
        refresh_token = token.get("refresh_token") or previous_refresh
        if not isinstance(access_token, str) or not access_token:
            raise BridgeError("token response is missing access_token")
        if not isinstance(refresh_token, str) or not refresh_token:
            raise BridgeError("token response is missing refresh_token")
        return {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "expires_at": now + max(1, int(token.get("expires_in") or 3600)),
            "client_id": client_id,
            "token_endpoint": token_endpoint,
            "resource": self.resource,
        }


def sse_messages(stream: BinaryIO) -> Iterator[dict[str, Any]]:
    data_lines: list[str] = []
    for raw_line in stream:
        line = raw_line.decode("utf-8").rstrip("\r\n")
        if not line:
            if data_lines:
                payload = json.loads("\n".join(data_lines))
                if isinstance(payload, dict):
                    yield payload
                data_lines = []
            continue
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
    if data_lines:
        payload = json.loads("\n".join(data_lines))
        if isinstance(payload, dict):
            yield payload


class McpBridge:
    def __init__(self, *, oauth: OAuthDeviceClient, timeout: int = 3600) -> None:
        self.oauth = oauth
        self.resource = oauth.resource
        self.timeout = timeout
        self.session_id = ""
        self.protocol_version = ""
        self.opener = urllib.request.build_opener(_NoRedirect())

    def send(
        self, payload: dict[str, Any], emit: Callable[[dict[str, Any]], None]
    ) -> None:
        params = payload.get("params")
        if payload.get("method") == "initialize" and isinstance(params, dict):
            version = params.get("protocolVersion")
            if isinstance(version, str):
                self.protocol_version = version
        token = self.oauth.access_token()
        status = self._post(payload=payload, token=token, emit=emit)
        if status == 401:
            token = self.oauth.access_token(force_refresh=True)
            status = self._post(payload=payload, token=token, emit=emit)
        if status not in (200, 202):
            raise BridgeError(f"Merv MCP returned HTTP {status}")

    def _post(
        self,
        *,
        payload: Mapping[str, Any],
        token: str,
        emit: Callable[[dict[str, Any]], None],
    ) -> int:
        headers = {
            "User-Agent": USER_AGENT,
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": MCP_ACCEPT,
        }
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        if self.protocol_version:
            headers["MCP-Protocol-Version"] = self.protocol_version
        request = urllib.request.Request(
            self.resource,
            data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
            headers=headers,
        )
        try:
            response = self.opener.open(request, timeout=self.timeout)
        except urllib.error.HTTPError as exc:
            exc.read()
            return exc.code
        except (OSError, urllib.error.URLError) as exc:
            raise BridgeError("could not reach the Merv MCP server") from exc
        with response:
            session_id = response.headers.get("Mcp-Session-Id")
            if session_id:
                self.session_id = session_id
            if response.status == 202:
                response.read()
                return 202
            content_type = response.headers.get("Content-Type", "").partition(";")[0]
            try:
                if content_type == "text/event-stream":
                    for message in sse_messages(response):
                        emit(message)
                else:
                    message = json.loads(response.read())
                    if isinstance(message, dict):
                        emit(message)
                    else:
                        raise ValueError("not an object")
            except (UnicodeDecodeError, ValueError) as exc:
                raise BridgeError("Merv MCP returned a malformed response") from exc
            return response.status


def _rpc_error(payload: object, message: str) -> dict[str, Any] | None:
    request_id = payload.get("id") if isinstance(payload, dict) else None
    if request_id is None:
        return None
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": -32000, "message": message},
    }


def serve_stdio(
    bridge: McpBridge,
    *,
    input: TextIO = sys.stdin,
    output: TextIO = sys.stdout,
    errors: TextIO = sys.stderr,
) -> int:
    def emit(message: dict[str, Any]) -> None:
        output.write(json.dumps(message, separators=(",", ":")) + "\n")
        output.flush()

    for line in input:
        if not line.strip():
            continue
        payload: object = None
        try:
            payload = json.loads(line)
            if not isinstance(payload, dict):
                raise BridgeError("STDIO MCP messages must be JSON objects")
            bridge.send(payload, emit)
        except (ValueError, BridgeError) as exc:
            error = _rpc_error(payload, str(exc))
            if error is not None:
                emit(error)
            else:
                print(f"merv-mcp: {exc}", file=errors, flush=True)
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="merv-mcp",
        description="Use Merv OAuth from remote machines and any STDIO MCP client.",
    )
    parser.add_argument(
        "command",
        nargs="?",
        choices=("serve", "login", "status", "logout"),
        default="serve",
    )
    parser.add_argument("--server-url", default=DEFAULT_SERVER_URL)
    parser.add_argument("--store", type=Path, help="OAuth credential store path")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        resource = normalize_resource(args.server_url)
        store = CredentialStore(args.store)
        oauth = OAuthDeviceClient(resource=resource, store=store)
        if args.command == "login":
            oauth.login()
            print(f"Signed in to {resource}. Credentials stored in {store.path}.")
            return 0
        if args.command == "status":
            credential = store.get(resource)
            if credential is None:
                print(f"Not signed in to {resource}.")
                return 1
            expires = time.strftime(
                "%Y-%m-%d %H:%M:%S %Z",
                time.localtime(float(credential.get("expires_at") or 0)),
            )
            print(f"Signed in to {resource}; current access token expires {expires}.")
            return 0
        if args.command == "logout":
            removed = store.remove(resource)
            print(
                ("Removed" if removed else "No") + f" local credential for {resource}."
            )
            return 0
        return serve_stdio(McpBridge(oauth=oauth))
    except BridgeError as exc:
        print(f"merv-mcp: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
