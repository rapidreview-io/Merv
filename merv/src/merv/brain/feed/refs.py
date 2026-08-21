# If you update this file, you must consult feed.md to see whether feed.md needs to be updated. feed.md must not exceed 100 lines.
"""References parsed out of a post's text.

Agents write naturally; the feed pulls the structure out. An entity id in the
prose becomes the post's ``ref`` (and an inline chip in the UI); the first
arXiv id, DOI, or http(s) URL becomes the post's link when no explicit ``url``
was given. Pure functions, no I/O.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Known project entity prefixes (kept in sync with feed._KNOWN_REF_PREFIXES).
ENTITY_ID_RE = re.compile(
    r"(?<![A-Za-z0-9_])((?:exp|task|claim|res|rver|syn|rev|lit|paper)_[0-9a-f]{6,32})(?![A-Za-z0-9_])"
)
_ARXIV_RE = re.compile(r"\barXiv:\s?(\d{4}\.\d{4,5}(?:v\d+)?)\b", re.IGNORECASE)
_DOI_RE = re.compile(r"\bdoi:\s?(10\.\d{4,9}/[^\s,;)\]]+)", re.IGNORECASE)
_URL_RE = re.compile(r"https?://[^\s<>()\[\]\"']+", re.IGNORECASE)
_TRAILING_PUNCT = ".,;:!?"


@dataclass(frozen=True, slots=True)
class ParsedRefs:
    entities: tuple[str, ...]
    links: tuple[str, ...]


def _dedupe(values: list[str]) -> tuple[str, ...]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            out.append(value)
    return tuple(out)


def parse_refs(text: str) -> ParsedRefs:
    """Entity ids and links mentioned in ``text``, in order of appearance."""
    text = text or ""
    entities = _dedupe(ENTITY_ID_RE.findall(text))
    links: list[tuple[int, str]] = []
    for match in _URL_RE.finditer(text):
        links.append((match.start(), match.group(0).rstrip(_TRAILING_PUNCT)))
    for match in _ARXIV_RE.finditer(text):
        links.append((match.start(), f"https://arxiv.org/abs/{match.group(1)}"))
    for match in _DOI_RE.finditer(text):
        doi = match.group(1).rstrip(_TRAILING_PUNCT)
        links.append((match.start(), f"https://doi.org/{doi}"))
    links.sort(key=lambda item: item[0])
    return ParsedRefs(entities=entities, links=_dedupe([url for _, url in links]))
