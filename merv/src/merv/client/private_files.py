"""Owner-only files under the machine state directory.

Every runner-private artifact (secrets, ledgers, settings) is written the same
way: created ``0600``, replaced atomically, never left half-written. Nothing
here knows what the bytes mean.
"""

from __future__ import annotations

import json
import os
import secrets
import uuid
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any


class PrivateFileError(Exception):
    """A private machine file cannot be read or written safely."""


def private_token(path: Path) -> tuple[str, bool]:
    """Read or create one owner-only machine secret; ``(token, created)``."""
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
        raise PrivateFileError(f"cannot read local private token: {path}") from exc
    if len(token) < 32:
        raise PrivateFileError(f"local private token is empty or invalid: {path}")
    path.chmod(0o600)
    return token, False


def write_private_text(path: Path, text: str) -> None:
    """Atomically replace ``path`` with ``text``, mode 0600."""
    path.parent.mkdir(parents=True, exist_ok=True)
    scratch = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        descriptor = os.open(scratch, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(text)
        scratch.replace(path)
    finally:
        scratch.unlink(missing_ok=True)


def write_private_json(path: Path, value: Mapping[str, Any]) -> None:
    write_private_text(path, json.dumps(dict(value), indent=2, sort_keys=True) + "\n")


def read_json_document(path: Path) -> dict[str, Any]:
    """The JSON object at ``path``, or ``{}`` when it does not exist yet."""
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        raise PrivateFileError(f"cannot read machine settings: {path}") from exc
    if not isinstance(value, dict):
        raise PrivateFileError(f"machine settings must contain an object: {path}")
    return value


def replace_json_document(
    path: Path,
    document: Mapping[str, Any],
    *,
    validate: Callable[[Path], None] | None = None,
) -> None:
    """Write ``document`` to ``path`` atomically after validating the candidate.

    The candidate is validated at its scratch path so a rejected document
    never replaces the live one.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    scratch = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        descriptor = os.open(scratch, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(json.dumps(dict(document), indent=2, sort_keys=True) + "\n")
        if validate is not None:
            validate(scratch)
        scratch.replace(path)
    finally:
        scratch.unlink(missing_ok=True)


__all__ = [
    "PrivateFileError",
    "private_token",
    "read_json_document",
    "replace_json_document",
    "write_private_json",
    "write_private_text",
]
