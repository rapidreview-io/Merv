"""Loopback-only settings control for the machine-local agent runner."""

from __future__ import annotations

import hmac
import json
import os
import re
import secrets
import threading
import uuid
from collections.abc import Callable, Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit


DEFAULT_PORT = 8791
MAX_SETTINGS_BYTES = 64 * 1024
DEFAULT_UI_ORIGINS = {
    "https://experiments.rapidreview.io",
    "https://rapidreview.io",
    "https://research-suite-chi.vercel.app",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://localhost:5173",
}

_BRIDGE_PAGE = r"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Merv runner connection</title>
  <style nonce="__NONCE__">
    :root { color-scheme: light dark; font: 15px system-ui, sans-serif; }
    body { margin: 0; padding: 28px; line-height: 1.45; }
    h1 { font-size: 19px; margin: 0 0 10px; }
    p { margin: 0; opacity: .72; }
  </style>
</head>
<body>
  <h1>Connected to the Merv runner</h1>
  <p>Keep this small window open while you finish setup in RapidReview.</p>
  <script nonce="__NONCE__">
    const uiOrigin = __UI_ORIGIN__;
    const bridgeSource = "merv-runner-bridge-v1";
    const allowed = new Set(["/health", "/settings", "/status", "/credential", "/start"]);

    window.addEventListener("message", async (event) => {
      if (event.source !== window.opener || event.origin !== uiOrigin) return;
      const message = event.data;
      if (!message || message.source !== "merv-runner-ui-v1"
          || message.type !== "request" || typeof message.id !== "string"
          || !allowed.has(message.path)
          || !["GET", "PUT", "POST"].includes(message.method)) return;
      try {
        const headers = {};
        if (message.token) headers.Authorization = `Bearer ${message.token}`;
        if (message.body !== undefined) headers["Content-Type"] = "application/json";
        const response = await fetch(message.path, {
          method: message.method,
          credentials: "omit",
          headers,
          ...(message.body !== undefined ? { body: JSON.stringify(message.body) } : {}),
        });
        const payload = await response.json().catch(() => null);
        window.opener.postMessage({
          source: bridgeSource,
          type: "response",
          id: message.id,
          ok: response.ok,
          status: response.status,
          payload,
        }, uiOrigin);
      } catch (error) {
        window.opener.postMessage({
          source: bridgeSource,
          type: "response",
          id: message.id,
          ok: false,
          status: 0,
          payload: { error: error?.message || "runner request failed" },
        }, uiOrigin);
      }
    });

    if (window.opener) {
      window.opener.postMessage({ source: bridgeSource, type: "ready" }, uiOrigin);
      window.opener.focus();
    }
  </script>
</body>
</html>
"""


class LocalControlError(Exception):
    pass


def private_token(path: Path) -> tuple[str, bool]:
    """Read or create one owner-only machine secret."""
    try:
        token = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        path.parent.mkdir(parents=True, exist_ok=True)
        token = secrets.token_urlsafe(32)
        try:
            handle = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            return private_token(path)
        try:
            os.write(handle, (token + "\n").encode("utf-8"))
        finally:
            os.close(handle)
        return token, True
    except OSError as exc:
        raise LocalControlError(f"cannot read local private token: {path}") from exc
    if len(token) < 32:
        raise LocalControlError(f"local private token is empty or invalid: {path}")
    path.chmod(0o600)
    return token, False


def pairing_token(path: Path) -> tuple[str, bool]:
    """Token a browser must present to the loopback settings service."""
    return private_token(path)


def local_control(
    *,
    config_path: Path,
    token: str,
    validate: Callable[[Path], None],
    status: Callable[[], Mapping[str, Any]],
    start: Callable[[str], None] | None = None,
    credential_path: Path | None = None,
    port: int = DEFAULT_PORT,
    origins: set[str] | None = None,
) -> ThreadingHTTPServer:
    """Build an IPv4-loopback server; the returned server is not started."""
    allowed_origins = _allowed_origins() if origins is None else origins

    class Handler(BaseHTTPRequestHandler):
        server_version = "MervLocalControl/1"

        def do_OPTIONS(self) -> None:
            if not self._safe_host() or not self._origin_allowed():
                self._json(403, {"error": "forbidden"})
                return
            self.send_response(204)
            self._cors()
            self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
            self.send_header(
                "Access-Control-Allow-Headers", "Authorization, Content-Type"
            )
            if (
                self.headers.get("Access-Control-Request-Private-Network")
                == "true"
            ):
                self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()

        def do_GET(self) -> None:
            if not self._safe_host():
                self._json(403, {"error": "forbidden"})
                return
            target = urlsplit(self.path)
            if target.path == "/bridge":
                requested = parse_qs(target.query).get("origin", [""])[0]
                if requested not in allowed_origins:
                    self._json(403, {"error": "origin_not_allowed"})
                    return
                self._bridge(requested)
                return
            if self.path == "/health":
                self._json(200, {"ok": True, "service": "merv-agent-runner"})
                return
            if not self._authorized():
                return
            if self.path == "/settings":
                document = _read_document(config_path)
                self._json(200, _public_settings(document))
            elif self.path == "/status":
                self._json(200, dict(status()))
            else:
                self._json(404, {"error": "not_found"})

        def do_PUT(self) -> None:
            if not self._safe_host():
                self._json(403, {"error": "forbidden"})
                return
            if not self._authorized():
                return
            if self.path not in {"/settings", "/credential"}:
                self._json(404, {"error": "not_found"})
                return
            try:
                payload = self._body()
                if self.path == "/credential":
                    if credential_path is None:
                        self._json(404, {"error": "not_found"})
                        return
                    _write_credential(
                        credential_path,
                        key=payload.get("key"),
                    )
                    self._json(200, {"ok": True, "configured": True})
                    return
                updated = _merge_settings(
                    config_path=config_path,
                    payload=payload,
                    validate=validate,
                )
            except (LocalControlError, ValueError) as exc:
                self._json(400, {"error": str(exc)})
                return
            self._json(
                200,
                {**_public_settings(updated), "restart_required": True},
            )

        def do_POST(self) -> None:
            if not self._safe_host():
                self._json(403, {"error": "forbidden"})
                return
            if not self._authorized():
                return
            if self.path != "/start":
                self._json(404, {"error": "not_found"})
                return
            try:
                payload = self._body()
                project_id = _start_project_id(payload.get("project_id"))
                current = dict(status())
                if start is None:
                    if (
                        current.get("runner_active") is True
                        and str(current.get("project_id") or "") == project_id
                    ):
                        self._json(
                            200,
                            {"ok": True, "state": "running", "project_id": project_id},
                        )
                    else:
                        self._json(409, {"error": "runner_cannot_start"})
                    return
                try:
                    validate(config_path)
                except Exception as exc:
                    raise LocalControlError(
                        str(exc) or "runner settings are invalid"
                    ) from exc
            except (LocalControlError, ValueError) as exc:
                self._json(400, {"error": str(exc)})
                return
            with start_lock:
                if start_state["requested"]:
                    self._json(409, {"error": "runner_starting"})
                    return
                start_state["requested"] = True
            self._json(
                202,
                {"ok": True, "state": "starting", "project_id": project_id},
            )
            # Let the response reach the browser before the settings service
            # closes its socket and hands this process to the actual runner.
            threading.Thread(
                target=start,
                args=(project_id,),
                name="merv-runner-handoff",
                daemon=True,
            ).start()

        def _body(self) -> dict[str, Any]:
            try:
                length = int(self.headers.get("Content-Length") or "0")
            except ValueError as exc:
                raise LocalControlError("invalid content length") from exc
            if not 0 < length <= MAX_SETTINGS_BYTES:
                raise LocalControlError("settings body is empty or too large")
            try:
                value = json.loads(self.rfile.read(length))
            except (ValueError, UnicodeDecodeError) as exc:
                raise LocalControlError("settings body is not valid JSON") from exc
            if not isinstance(value, dict):
                raise LocalControlError("settings body must be an object")
            return value

        def _authorized(self) -> bool:
            if not self._origin_allowed():
                self._json(403, {"error": "origin_not_allowed"})
                return False
            presented = self.headers.get("Authorization") or ""
            expected = f"Bearer {token}"
            if not hmac.compare_digest(presented.encode(), expected.encode()):
                self._json(
                    401,
                    {"error": "pairing_token_required"},
                    extra_headers={"WWW-Authenticate": "Bearer"},
                )
                return False
            return True

        def _safe_host(self) -> bool:
            host = (self.headers.get("Host") or "").split(":", 1)[0].strip("[]")
            return host in {"127.0.0.1", "localhost"}

        def _origin_allowed(self) -> bool:
            origin = self.headers.get("Origin")
            local_origins = {
                f"http://127.0.0.1:{self.server.server_port}",
                f"http://localhost:{self.server.server_port}",
            }
            return not origin or origin in allowed_origins or origin in local_origins

        def _bridge(self, ui_origin: str) -> None:
            nonce = secrets.token_urlsafe(18)
            body = (
                _BRIDGE_PAGE.replace("__NONCE__", nonce)
                .replace("__UI_ORIGIN__", json.dumps(ui_origin))
                .encode("utf-8")
            )
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'none'; connect-src 'self'; "
                f"script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; "
                "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            )
            self.end_headers()
            self.wfile.write(body)

        def _cors(self) -> None:
            origin = self.headers.get("Origin")
            if origin and origin in allowed_origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")

        def _json(
            self,
            code: int,
            payload: Mapping[str, Any],
            *,
            extra_headers: Mapping[str, str] | None = None,
        ) -> None:
            body = json.dumps(dict(payload), sort_keys=True).encode("utf-8")
            self.send_response(code)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for name, value in (extra_headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            return

    start_lock = threading.Lock()
    start_state = {"requested": False}
    try:
        server = ThreadingHTTPServer(("127.0.0.1", int(port)), Handler)
    except OSError as exc:
        raise LocalControlError(
            f"cannot bind local settings server on 127.0.0.1:{port}"
        ) from exc
    server.daemon_threads = True
    return server


def _start_project_id(value: object) -> str:
    project_id = value if isinstance(value, str) else ""
    if not re.fullmatch(r"proj_[A-Za-z0-9][A-Za-z0-9_-]{0,127}", project_id):
        raise LocalControlError("project_id must be a valid Merv project id")
    return project_id


def _write_credential(path: Path, *, key: object) -> None:
    """Atomically store one project key without ever returning or logging it."""
    secret = key if isinstance(key, str) else ""
    if not re.fullmatch(r"mk_[A-Za-z0-9_-]{43}", secret):
        raise LocalControlError("credential must be a Merv project key")
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(path.parent, 0o700)
        handle = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(handle, (secret + "\n").encode("utf-8"))
        finally:
            os.close(handle)
        os.replace(temporary, path)
        path.chmod(0o600)
    except OSError as exc:
        raise LocalControlError(f"cannot write runner credential: {path}") from exc
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def start_in_background(server: ThreadingHTTPServer) -> threading.Thread:
    thread = threading.Thread(
        target=server.serve_forever,
        name="merv-local-control",
        daemon=True,
    )
    thread.start()
    return thread


def _merge_settings(
    *,
    config_path: Path,
    payload: Mapping[str, Any],
    validate: Callable[[Path], None],
) -> dict[str, Any]:
    allowed = {"agent_platforms", "agent_workspace", "features"}
    unknown = set(payload) - allowed
    if unknown:
        raise LocalControlError(
            f"unsupported settings: {', '.join(sorted(unknown))}"
        )
    if not payload:
        raise LocalControlError("no settings supplied")
    if "features" in payload:
        features = payload["features"]
        if not isinstance(features, dict):
            raise LocalControlError("features must be an object")
        if set(features) - {"sandbox"}:
            raise LocalControlError("unsupported feature setting")
        if "sandbox" in features and not isinstance(features["sandbox"], bool):
            raise LocalControlError("features.sandbox must be true or false")
    document = _read_document(config_path)
    candidate = {**document, **{key: payload[key] for key in allowed if key in payload}}
    config_path.parent.mkdir(parents=True, exist_ok=True)
    scratch = config_path.with_name(f"{config_path.name}.{uuid.uuid4().hex}.tmp")
    try:
        _write_private(scratch, candidate)
        try:
            validate(scratch)
        except Exception as exc:
            raise LocalControlError(str(exc)) from exc
        scratch.replace(config_path)
    finally:
        scratch.unlink(missing_ok=True)
    return candidate


def _read_document(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        raise LocalControlError(f"cannot read machine settings: {path}") from exc
    if not isinstance(value, dict):
        raise LocalControlError("machine settings must contain an object")
    return value


def _write_private(path: Path, value: Mapping[str, Any]) -> None:
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
        0o600,
    )
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        output.write(json.dumps(dict(value), indent=2, sort_keys=True) + "\n")


def _public_settings(document: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "agent_workspace": document.get("agent_workspace") or {},
        "agent_platforms": document.get("agent_platforms") or {},
        "features": document.get("features") or {},
    }


def _allowed_origins() -> set[str]:
    extra = {
        value.strip().rstrip("/")
        for value in os.environ.get("MERV_AGENT_UI_ORIGINS", "").split(",")
        if value.strip()
    }
    return DEFAULT_UI_ORIGINS | extra
