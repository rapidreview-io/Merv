"""Content-identity digests for schema columns the database keys on.

A row whose identity IS its content needs one definition of that content —
otherwise a UNIQUE index and the adapter that writes new rows enforce two
subtly different notions of "the same thing". This module is that single
definition, and it lives beside the schema rather than beside its caller.

Not secret material: these digests are computed over public metadata, so they
deliberately do not go through ``kernel/secret_tokens.py``, whose helpers are
reserved for high-entropy bearer secrets.
"""

from __future__ import annotations

import hashlib
import json


def oauth_client_fingerprint(
    *, client_name: str, redirect_uris_json: str, grant_types_json: str
) -> str:
    """The identity of one OAuth DCR registration's metadata.

    Both arrays are sorted: their order carries no meaning to either side, so a
    client that merely shuffles its own list is the same client and must not
    fork a second row on every launch. Unparseable stored JSON fingerprints as
    its own literal text rather than raising — a legacy row is still entitled to
    a stable, distinct identity.
    """
    payload = json.dumps(
        {
            "client_name": client_name,
            "grant_types": _canonical_json_list(grant_types_json),
            "redirect_uris": _canonical_json_list(redirect_uris_json),
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _canonical_json_list(raw: str) -> list[str]:
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return [raw]
    if not isinstance(parsed, list):
        return [raw]
    return sorted(str(item) for item in parsed)


__all__ = ["oauth_client_fingerprint"]
