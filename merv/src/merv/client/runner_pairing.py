"""Pair this machine's runner to one Merv project with a device code.

The runner generates its own ``mk_`` key and never sends the plaintext. It
keeps that key **only** in an owner-only pairing file until the brain confirms
approval, so an interrupted or expired exchange never leaves a valid-looking
but unregistered credential behind. Promotion is three idempotent single-file
steps — key file, ``client.json`` project id, unlink pairing file — and the
brain keeps the approved answer readable for ten minutes, so a crash between
any two steps simply resumes on the next start.
"""

from __future__ import annotations

import hashlib
import json
import secrets
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, TextIO

from .private_files import (
    PrivateFileError,
    read_json_document,
    replace_json_document,
    write_private_json,
    write_private_text,
)

PAIRING_CREATE_PATH = "/api/agent-runners/pairing"
PAIRING_TOKEN_PATH = "/api/agent-runners/pairing/token"
KEY_PREFIX = "mk_"
DEFAULT_POLL_SECONDS = 5.0
MAX_POLL_SECONDS = 30.0
REQUEST_TIMEOUT_SECONDS = 15.0


class PairingError(Exception):
    """The exchange cannot continue; the message tells the user what to do."""


@dataclass(frozen=True)
class PairingState:
    """Everything a resumed process needs to finish an exchange."""

    key: str
    key_digest: str
    device_code: str
    user_code: str
    control_url: str
    expires_at: float
    interval: float = DEFAULT_POLL_SECONDS
    project_id: str = ""


def pairing_path(config_path: Path) -> Path:
    return config_path.parent / "agent-runner.pairing.json"


def credential_path(config_path: Path) -> Path:
    return config_path.parent / "agent-runner.key"


def generate_key() -> str:
    """Same shape the brain mints: ``mk_`` + 43 URL-safe characters."""
    return KEY_PREFIX + secrets.token_urlsafe(32)


def key_digest(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def format_user_code(code: str) -> str:
    return f"{code[:4]}-{code[4:]}" if len(code) == 8 else code


def load_pairing(path: Path) -> PairingState | None:
    try:
        raw = read_json_document(path)
    except PrivateFileError as exc:
        raise PairingError(str(exc)) from exc
    if not raw:
        return None
    try:
        return PairingState(
            key=str(raw["key"]),
            key_digest=str(raw["key_digest"]),
            device_code=str(raw["device_code"]),
            user_code=str(raw["user_code"]),
            control_url=str(raw["control_url"]),
            expires_at=float(raw["expires_at"]),
            interval=float(raw.get("interval") or DEFAULT_POLL_SECONDS),
            project_id=str(raw.get("project_id") or ""),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise PairingError(
            f"pairing file is unreadable; delete it and pair again: {path}"
        ) from exc


def save_pairing(path: Path, state: PairingState) -> None:
    write_private_json(path, asdict(state))


class PairingClient:
    """The two unauthenticated brain routes a pairing runner talks to."""

    def __init__(self, *, control_url: str, timeout: float = REQUEST_TIMEOUT_SECONDS):
        self.control_url = control_url.rstrip("/")
        self.timeout = timeout

    def create(
        self, *, key_digest: str, runner_id: str, machine: Mapping[str, Any]
    ) -> dict[str, Any]:
        status, body = self._post(
            PAIRING_CREATE_PATH,
            {"key_digest": key_digest, "runner_id": runner_id, "machine": dict(machine)},
        )
        if status == 429:
            raise PairingError(
                "Merv is rate-limiting pairing requests from this address; "
                "wait a minute and try again"
            )
        if status not in (200, 201) or not isinstance(body, dict):
            raise PairingError(f"Merv refused to start pairing (HTTP {status})")
        return body

    def token(self, *, device_code: str) -> tuple[str, dict[str, Any]]:
        """``("pending", {})``, ``("approved", payload)``, or ``("gone", detail)``."""
        status, body = self._post(PAIRING_TOKEN_PATH, {"device_code": device_code})
        payload = body if isinstance(body, dict) else {}
        if status == 200 and payload.get("status") == "approved":
            return "approved", payload
        if status in (200, 202) and payload.get("status") == "pending":
            return "pending", payload
        if status == 410:
            return "gone", payload
        raise PairingError(f"Merv answered the pairing poll with HTTP {status}")

    def _post(self, path: str, payload: Mapping[str, Any]) -> tuple[int, Any]:
        request = urllib.request.Request(
            f"{self.control_url}{path}",
            data=json.dumps(dict(payload)).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return response.status, _json_or_none(response.read())
        except urllib.error.HTTPError as exc:
            return exc.code, _json_or_none(exc.read())
        except (urllib.error.URLError, OSError) as exc:
            raise PairingError(f"could not reach Merv at {self.control_url}") from exc


def pair(
    *,
    config_path: Path,
    control_url: str,
    runner_id: str,
    machine: Mapping[str, Any],
    client: PairingClient | None = None,
    out: TextIO | None = None,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.time,
    project_writer: Callable[[Path, str], None] | None = None,
) -> str:
    """Run or resume the exchange until this machine is paired; return project id.

    Raises ``PairingError`` when the exchange is genuinely lost.
    """
    output = out if out is not None else sys.stdout
    client = client or PairingClient(control_url=control_url)
    state_path = pairing_path(config_path)
    key_path = credential_path(config_path)
    write_project = project_writer or _write_project_id
    state = load_pairing(state_path)
    if state is not None and (
        not state.device_code  # crashed between key generation and create
        or state.control_url != control_url
        or state.expires_at <= now()
    ):
        if state.project_id and _already_promoted(key_path, config_path, state):
            state_path.unlink(missing_ok=True)
            return state.project_id
        state_path.unlink(missing_ok=True)
        state = None
    if state is None:
        key = generate_key()
        digest = key_digest(key)
        # The key exists on disk only inside the pairing file until approval.
        save_pairing(
            state_path,
            PairingState(
                key=key,
                key_digest=digest,
                device_code="",
                user_code="",
                control_url=control_url,
                expires_at=now() + 600,
            ),
        )
        started = client.create(key_digest=digest, runner_id=runner_id, machine=machine)
        state = PairingState(
            key=key,
            key_digest=digest,
            device_code=str(started.get("device_code") or ""),
            user_code=str(started.get("user_code") or ""),
            control_url=control_url,
            expires_at=now() + float(started.get("expires_in") or 600),
            interval=min(
                max(float(started.get("interval") or DEFAULT_POLL_SECONDS), 1.0),
                MAX_POLL_SECONDS,
            ),
        )
        if not state.device_code or not state.user_code:
            state_path.unlink(missing_ok=True)
            raise PairingError("Merv returned an incomplete pairing response")
        save_pairing(state_path, state)
    minutes = max(int((state.expires_at - now()) // 60), 0)
    print(
        f"Pair this machine: enter  {format_user_code(state.user_code)}  in "
        f"Settings → Auto running (expires in {minutes} min).",
        file=output,
    )
    while True:
        outcome, payload = client.token(device_code=state.device_code)
        if outcome == "approved":
            project_id = str(payload.get("project_id") or "")
            if not project_id:
                raise PairingError("Merv approved the pairing without a project")
            _promote(
                key_path=key_path,
                config_path=config_path,
                state_path=state_path,
                state=state,
                project_id=project_id,
                write_project=write_project,
            )
            print(
                f"Paired with {payload.get('project_name') or project_id}.",
                file=output,
            )
            return project_id
        if outcome == "gone":
            if state.project_id and _already_promoted(key_path, config_path, state):
                state_path.unlink(missing_ok=True)
                return state.project_id
            state_path.unlink(missing_ok=True)
            reason = str(payload.get("reason") or "expired")
            raise PairingError(
                "the pairing code expired or was already used "
                f"({reason}); run `merv-agent-runner pair` to get a new code"
            )
        if now() >= state.expires_at:
            state_path.unlink(missing_ok=True)
            raise PairingError(
                "the pairing code expired before it was approved; run "
                "`merv-agent-runner pair` to get a new code"
            )
        sleep(state.interval)


def _promote(
    *,
    key_path: Path,
    config_path: Path,
    state_path: Path,
    state: PairingState,
    project_id: str,
    write_project: Callable[[Path, str], None],
) -> None:
    """Three idempotent single-file steps; any prefix can be safely re-run."""
    # Remember the project in the pairing file first so a crash after the key
    # write but before the unlink can still resolve a later 410 locally.
    save_pairing(state_path, PairingState(**{**asdict(state), "project_id": project_id}))
    write_private_text(key_path, state.key + "\n")
    write_project(config_path, project_id)
    state_path.unlink(missing_ok=True)


def _already_promoted(key_path: Path, config_path: Path, state: PairingState) -> bool:
    try:
        stored = key_path.read_text(encoding="utf-8").strip()
    except OSError:
        return False
    if key_digest(stored) != state.key_digest:
        return False
    try:
        return str(read_json_document(config_path).get("project_id") or "") == state.project_id
    except PrivateFileError:
        return False


def _write_project_id(config_path: Path, project_id: str) -> None:
    try:
        document = read_json_document(config_path)
    except PrivateFileError as exc:
        raise PairingError(str(exc)) from exc
    replace_json_document(config_path, {**document, "project_id": project_id})


def _json_or_none(raw: bytes) -> Any:
    try:
        return json.loads(raw.decode("utf-8")) if raw.strip() else None
    except ValueError:
        return None


__all__ = [
    "PairingClient",
    "PairingError",
    "PairingState",
    "credential_path",
    "format_user_code",
    "generate_key",
    "key_digest",
    "load_pairing",
    "pair",
    "pairing_path",
    "save_pairing",
]
