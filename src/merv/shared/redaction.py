"""One redactor, and one set of bounds, for provider trace excerpts.

The runner writes provider traces, the harness classifies provider stderr, and
the brain stores the excerpt an agent session reports. All three carry text a
provider may have echoed a credential into ("Incorrect API key provided:
sk-..."), so all three mask the same shapes here instead of each keeping its
own drifting copy of the pattern.

The runner caps what it sends and the brain redacts what it stores — a brain
cannot trust a client to have masked anything — so the caps below are the one
statement of how much of a trace may travel and be kept.

Stdlib only: this module rides the standalone runner archive, which no brain
code may enter.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

# Bounds on what one excerpt may carry: depth, breadth, and per-value length.
MAX_EXCERPT_DEPTH = 12
MAX_EXCERPT_ITEMS = 64
MAX_EXCERPT_KEY_CHARS = 120
MAX_EXCERPT_VALUE_CHARS = 240

# Bounds on one session's trace peek: the last few provider events and the
# stderr tail. TAIL_BYTES is how far back the runner reads its own file;
# EVENTS_BYTES is what the whole encoded batch may weigh once stored.
MAX_TRACE_EVENTS = 60
MAX_TRACE_EVENT_BYTES = 4 * 1024
MAX_TRACE_EVENTS_BYTES = 96 * 1024
MAX_TRACE_STDERR_BYTES = 8 * 1024
MAX_TRACE_TAIL_BYTES = 256 * 1024

_SECRET_KEY = re.compile(
    r"(?i)(api[-_]?key|token|secret|password|credential|authorization)"
)
_SECRET_VALUE = re.compile(
    r"\b(?:mk_|mas_|rr_sk_|sk-|ghp_|xox[a-z]-|AIza)[A-Za-z0-9_\-]{8,}"
    r"|Bearer\s+[A-Za-z0-9._\-]{8,}"
)


def redact_secrets(text: str) -> str:
    """Blank secret-shaped tokens in one line of output."""
    return _SECRET_VALUE.sub("<redacted>", str(text or ""))


def redact_excerpt(value: Any, *, depth: int = 0) -> Any:
    """Drop secret-looking keys and mask secret-looking strings, recursively."""
    if depth > MAX_EXCERPT_DEPTH:
        return "<nested>"
    if isinstance(value, Mapping):
        return {
            str(key)[:MAX_EXCERPT_KEY_CHARS]: (
                "<redacted>"
                if _SECRET_KEY.search(str(key))
                else redact_excerpt(item, depth=depth + 1)
            )
            for key, item in list(value.items())[:MAX_EXCERPT_ITEMS]
        }
    if isinstance(value, list):
        return [
            redact_excerpt(item, depth=depth + 1)
            for item in value[:MAX_EXCERPT_ITEMS]
        ]
    if isinstance(value, str):
        return redact_secrets(value)
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return str(value)[:MAX_EXCERPT_VALUE_CHARS]
