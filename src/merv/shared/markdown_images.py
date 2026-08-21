"""Markdown image-link helpers shared by artifact lints and submitted-byte reads."""

from __future__ import annotations

import re


MARKDOWN_FIGURE_MAX_BYTES = 5_000_000

# Gated markdown roles whose relative image links are captured as submitted
# figures at artifact.submit time. Single source of truth shared by the
# hosted reader (serves the figure bytes) and submission path (pins them into
# the blob store + report_figures index).
MARKDOWN_FIGURE_ROLES = frozenset({"plan", "report", "reflection_doc"})

_HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_IMAGE_LINK_RE = re.compile(r"!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+[\"'][^\"']*[\"'])?\s*\)")
# Figure links become file paths inside generated shell commands, so they get
# a strict allowlist: alnum start, then alnum / '/' '.' '-' '_' ' ', no '..'.
_SAFE_FIGURE_LINK_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9/._\- ]*")


def figure_link_problem(link: str) -> str | None:
    """Why a relative figure link is unsafe to upload, or None if it is fine."""
    if not _SAFE_FIGURE_LINK_RE.fullmatch(link):
        return (
            f"figure link {link!r} contains unsupported characters — use only "
            "letters, digits, '/', '.', '-', '_' and spaces, starting with a "
            "letter or digit"
        )
    if ".." in link:
        return f"figure link {link!r} must not contain '..'"
    return None


def markdown_image_links(markdown_text: str) -> list[str]:
    """Relative markdown image links, in order."""
    links: list[str] = []
    for target in markdown_image_targets(markdown_text):
        if target.startswith(("http://", "https://", "data:", "/")):
            continue
        links.append(target)
    return links


def markdown_image_targets(markdown_text: str) -> list[str]:
    """All markdown image targets, including external and absolute links."""
    stripped = _HTML_COMMENT_RE.sub("", markdown_text)
    return [match.group(1) for match in _IMAGE_LINK_RE.finditer(stripped)]
