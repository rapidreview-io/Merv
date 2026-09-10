"""Shared helpers for high-entropy opaque bearer secrets.

Two shapes live here. A minted secret is stored by digest and compared against
what a caller presents. A DERIVED secret — the run-wait tag — is stored
nowhere at all: one process key plus the (sandbox_uid, label) it names
reproduces the tag on every request. Subject-bound v2 tags also authenticate the
original infrastructure subject, so a later worker can restore its identity
without retaining the original HTTP context. An auth-exempt wait URL needs no row
or migration; resource access still depends on the service's current grant.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from collections.abc import Mapping
from pathlib import Path
from urllib.parse import urlencode

from merv.shared.errors import ValidationError

from .env import env_value

WAIT_SECRET_ENV_VAR = "MERV_WAIT_SECRET"
WAIT_SECRET_FILENAME = "wait_secret"
# The route shape lives HERE and not in the transport: the transport mounts it
# and sandbox.runs renders it, and those two live in components that cannot
# import each other. One string, so a drift cannot mint URLs nobody serves.
WAIT_ROUTE_PREFIX = "/wait/"
# The tag is 128 bits, so a key below it would be the cheaper thing to guess.
MIN_WAIT_SECRET_BYTES = 32
WAIT_SIGNATURE_CHARS = 32
# Versioned and NUL-terminated, so a later derivation can never collide here.
_WAIT_DOMAIN = b"merv-wait-v1\0"


def mint_secret(*, prefix: str, nbytes: int) -> str:
    """Mint a URL-safe high-entropy secret with the caller's public prefix."""
    return f"{prefix}{secrets.token_urlsafe(nbytes)}"


def hash_secret(secret: str) -> str:
    """Stored form for high-entropy opaque secrets: sha256 hex digest."""
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def secret_digest_matches(*, stored_digest: object | None, presented_digest: str) -> bool:
    """Constant-time comparison for a stored digest and a presented digest.

    ``None`` burns the same compare primitive and returns false, which keeps
    unknown-token paths from growing a separate early-return compare shape.
    """
    if stored_digest is None:
        hmac.compare_digest(presented_digest, presented_digest)
        return False
    return hmac.compare_digest(str(stored_digest), presented_digest)


def load_wait_secret(
    *,
    env: Mapping[str, str] | None = None,
    state_root: Path | None = None,
    require_env: bool = False,
) -> bytes:
    """The one key every run-wait URL is signed and verified with.

    The environment wins wherever it is set, and a set-but-weak value fails the
    boot rather than minting guessable URLs quietly. ``require_env`` is the
    hosted composition, whose state root is a sentinel path that must never
    hold a secret; a composition that names a writable ``state_root`` generates
    the key once and reuses it, so a URL minted before a restart still verifies
    after one.
    """
    raw = env_value(WAIT_SECRET_ENV_VAR, env=env)
    if raw:
        # The value's own UTF-8 bytes ARE the key: nothing is base64/hex
        # unwrapped, so what an operator sets is what gets measured here.
        material = raw.encode("utf-8")
        if len(material) < MIN_WAIT_SECRET_BYTES:
            raise ValidationError(
                f"{WAIT_SECRET_ENV_VAR} must be at least "
                f"{MIN_WAIT_SECRET_BYTES} bytes; refusing to sign run-wait URLs "
                "with a guessable key (try `openssl rand -hex 32`)",
                details={"variable": WAIT_SECRET_ENV_VAR, "bytes": len(material)},
            )
        return material
    if require_env or state_root is None:
        raise ValidationError(
            f"{WAIT_SECRET_ENV_VAR} is required in this deployment: run-wait "
            "URLs are auth-exempt, and this composition keeps no writable state "
            "root to generate a key in (try `openssl rand -hex 32`)",
            details={"variable": WAIT_SECRET_ENV_VAR},
        )
    return _stored_wait_secret(state_root=Path(state_root))


def _stored_wait_secret(*, state_root: Path) -> bytes:
    """Read the state root's wait key, generating it the first time."""
    path = state_root / WAIT_SECRET_FILENAME
    try:
        existing = path.read_bytes()
    except OSError:
        existing = b""
    if len(existing) >= MIN_WAIT_SECRET_BYTES:
        return existing
    state_root.mkdir(parents=True, exist_ok=True)
    minted = secrets.token_bytes(MIN_WAIT_SECRET_BYTES)
    scratch = path.with_name(f"{WAIT_SECRET_FILENAME}.{os.getpid()}.tmp")
    scratch.unlink(missing_ok=True)  # a crash mid-write must not wedge the boot
    # Owner-only from the first byte, and renamed into place, so no reader ever
    # sees a half-written key and no other account ever sees the key at all.
    handle = os.open(scratch, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(handle, minted)
    finally:
        os.close(handle)
    os.replace(scratch, path)
    return minted


def wait_signature(*, key: bytes, sandbox_uid: str, label: str, subject: str | None = None) -> str:
    """The tag that makes a run-wait URL a capability.

    Length-prefixed under a versioned domain: without it, one (uid, label) pair
    could be re-cut into another that signs identically.
    """
    domain = _WAIT_DOMAIN if subject is None else b"merv-wait-v2\0"
    message = domain + _length_prefixed(sandbox_uid) + _length_prefixed(label)
    if subject is not None:
        message += _length_prefixed(subject)
    digest = hmac.new(key, message, hashlib.sha256).hexdigest()
    return digest[:WAIT_SIGNATURE_CHARS]


def wait_url(*, base_url: str, key: bytes, sandbox_uid: str, label: str,
             subject: str | None = None) -> str:
    """The absolute capability URL for one run, ready to hand to an agent.

    The prefix carries its own slashes, and labels are already restricted to
    merv_run's charset at registration, so nothing here is escaped or joined
    twice — a URL this returns resolves to the mounted route verbatim.
    """
    signature = wait_signature(key=key, sandbox_uid=sandbox_uid, label=label, subject=subject)
    query = "?" + urlencode({"subject": subject}) if subject is not None else ""
    return (
        f"{base_url.rstrip('/')}{WAIT_ROUTE_PREFIX}"
        f"{sandbox_uid}/{label}/{signature}{query}"
    )


def wait_signature_matches(
    *, key: bytes, sandbox_uid: str, label: str, presented: str, subject: str | None = None
) -> bool:
    """Constant-time check of a presented run-wait tag."""
    expected = wait_signature(key=key, sandbox_uid=sandbox_uid, label=label, subject=subject)
    return hmac.compare_digest(
        expected.encode("ascii"), presented.encode("utf-8", errors="replace")
    )


def _length_prefixed(value: str) -> bytes:
    raw = value.encode("utf-8")
    return len(raw).to_bytes(4, "big") + raw
