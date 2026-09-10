# If you update this file, you must consult feed.md to see whether feed.md needs to be updated. feed.md must not exceed 100 lines.
"""References parsed out of a post's text.

Agents write naturally; the feed pulls the structure out. An entity id in the
prose becomes the post's ``ref`` (and an inline chip in the UI); the first
arXiv id, DOI, or http(s) URL becomes the post's link when no explicit ``url``
was given. Which id prefixes count as entities is not the feed's to know: the
composition hands in a ``RefVocabulary`` and the feed matches prefixes
opaquely. Pure functions and values, no I/O.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# ``(prefix, kind)`` pairs declared by whoever mints the ids, e.g.
# ``(("wid_", "widget"), ...)``. The prefix is what the feed matches on;
# the kind is a label for messages and never drives behavior.
RefVocabulary = tuple[tuple[str, str], ...]

_ARXIV_RE = re.compile(r"\barXiv:\s?(\d{4}\.\d{4,5}(?:v\d+)?)\b", re.IGNORECASE)
_DOI_RE = re.compile(r"\bdoi:\s?(10\.\d{4,9}/[^\s,;)\]]+)", re.IGNORECASE)
_URL_RE = re.compile(r"https?://[^\s<>()\[\]\"']+", re.IGNORECASE)
_TRAILING_PUNCT = ".,;:!?"


@dataclass(frozen=True, slots=True)
class ParsedRefs:
    entities: tuple[str, ...]
    links: tuple[str, ...]


class RefParser:
    """Entity-id and link extraction over one declared vocabulary."""

    __slots__ = ("vocabulary", "prefixes", "_entity_re")

    def __init__(self, vocabulary: RefVocabulary) -> None:
        entries = tuple((str(prefix), str(kind)) for prefix, kind in vocabulary)
        if not entries:
            raise ValueError("a ref vocabulary needs at least one (prefix, kind) entry")
        for prefix, kind in entries:
            if not prefix or not kind:
                raise ValueError(f"ref vocabulary entries need a prefix and a kind: {(prefix, kind)!r}")
        self.vocabulary: RefVocabulary = entries
        self.prefixes: tuple[str, ...] = tuple(prefix for prefix, _ in entries)
        alternatives = "|".join(re.escape(prefix) for prefix in self.prefixes)
        self._entity_re = re.compile(
            rf"(?<![A-Za-z0-9_])((?:{alternatives})[0-9a-f]{{6,32}})(?![A-Za-z0-9_])"
        )

    def accepts(self, ref: str) -> bool:
        """Whether ``ref`` carries one of the declared prefixes."""
        return bool(ref) and ref.startswith(self.prefixes)

    def describe(self) -> str:
        """The vocabulary as prose for validation messages."""
        return ", ".join(f"{kind} {prefix}…" for prefix, kind in self.vocabulary)

    def parse(self, text: str) -> ParsedRefs:
        """Entity ids and links mentioned in ``text``, in order of appearance."""
        text = text or ""
        entities = _dedupe(self._entity_re.findall(text))
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


def _dedupe(values: list[str]) -> tuple[str, ...]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            out.append(value)
    return tuple(out)
