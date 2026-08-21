"""Deterministic TLDRs for submitted content shared by evidence projections."""

from __future__ import annotations

import json
import re
from typing import Any


MAX_CONTENT_TLDR_CHARS = 600

_HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$", re.MULTILINE)
_HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_FENCED_CODE_RE = re.compile(r"```.*?```|~~~.*?~~~", re.DOTALL)
_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\([^)]+\)")
_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_SUMMARY_HEADINGS = ("summary", "tldr", "tl dr", "executive summary", "abstract")


def content_tldr(
    content: Any,
    *,
    role: str = "",
    path: str = "",
    max_chars: int = MAX_CONTENT_TLDR_CHARS,
) -> str:
    """Return a compact, non-empty summary for submitted text.

    Prefer an author-written summary (a JSON summary-like field or markdown
    Summary/TLDR section). Structured graph and change-spec artifacts get a
    compact semantic outline. Legacy documents without a summary fall back to
    their opening prose; unavailable content gets an explicit metadata-based
    marker rather than a blank TLDR.
    """

    text = str(content or "").strip()
    if not text:
        label = _artifact_label(role=role, path=path)
        return _truncate(f"No submitted text is available for {label}.", max_chars)

    structured = _json_tldr(text)
    if structured:
        return _truncate(_plain_text(structured), max_chars)

    summary_section = _markdown_summary_section(text)
    candidate = summary_section or _opening_prose(text)
    plain = _plain_text(candidate)
    if not plain:
        plain = _artifact_label(role=role, path=path).capitalize() + " was submitted."
    return _truncate(plain, max_chars)


def _json_tldr(text: str) -> str:
    if not text.startswith(("{", "[")):
        return ""
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return ""
    if isinstance(data, list):
        return _join_values(data[:4])
    if not isinstance(data, dict):
        return str(data)

    for key in ("tldr", "summary", "abstract", "conclusion", "description"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value

    nodes = data.get("nodes")
    if isinstance(nodes, list):
        labels = [
            str(node.get("label") or "").strip()
            for node in nodes
            if isinstance(node, dict) and str(node.get("label") or "").strip()
        ]
        title = str(data.get("title") or "").strip()
        parts = ([title] if title else []) + labels[:5]
        if parts:
            return "; ".join(parts)

    experiments = data.get("experiments")
    if not isinstance(experiments, list):
        decision = data.get("decision")
        experiments = (
            decision.get("experiments")
            if isinstance(decision, dict)
            else None
        )
    if isinstance(experiments, list):
        intents = [
            str(item.get("intent") or item.get("name") or "").strip()
            for item in experiments
            if isinstance(item, dict)
            and str(item.get("intent") or item.get("name") or "").strip()
        ]
        claim_changes = data.get("claim_changes")
        changed = len(claim_changes) if isinstance(claim_changes, list) else 0
        prefix = (
            f"Proposes {len(intents)} experiment"
            f"{'' if len(intents) == 1 else 's'}"
        )
        if changed:
            prefix += (
                f" and {changed} claim change"
                f"{'' if changed == 1 else 's'}"
            )
        return prefix + (": " + "; ".join(intents[:4]) if intents else ".")

    title = str(data.get("title") or "").strip()
    if title:
        return title
    return _join_values(list(data.values())[:4])


def _markdown_summary_section(text: str) -> str:
    clean = _HTML_COMMENT_RE.sub("", text)
    headings = list(_HEADING_RE.finditer(clean))
    for index, heading in enumerate(headings):
        name = _normalize_heading(heading.group(2))
        if not any(
            name == candidate or name.startswith(candidate + " ")
            for candidate in _SUMMARY_HEADINGS
        ):
            continue
        level = len(heading.group(1))
        end = len(clean)
        for following in headings[index + 1 :]:
            if len(following.group(1)) <= level:
                end = following.start()
                break
        body = clean[heading.end() : end].strip()
        if body:
            return body
    return ""


def _opening_prose(text: str) -> str:
    clean = _HTML_COMMENT_RE.sub("", text)
    clean = _FENCED_CODE_RE.sub(" ", clean)
    lines: list[str] = []
    for raw in clean.splitlines():
        line = raw.strip()
        if not line or _HEADING_RE.fullmatch(line):
            if lines:
                break
            continue
        if re.fullmatch(r"\|?[\s:|-]+\|?", line):
            continue
        lines.append(line)
        if sum(len(item) for item in lines) >= MAX_CONTENT_TLDR_CHARS:
            break
    return " ".join(lines)


def _plain_text(text: str) -> str:
    value = _HTML_COMMENT_RE.sub(" ", str(text or ""))
    value = _FENCED_CODE_RE.sub(" ", value)
    value = _IMAGE_RE.sub(lambda match: match.group(1), value)
    value = _LINK_RE.sub(lambda match: match.group(1), value)
    value = re.sub(r"(?m)^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)]|>)\s*", "", value)
    value = value.replace("`", "").replace("|", " ")
    return re.sub(r"\s+", " ", value).strip()


def _join_values(values: list[Any]) -> str:
    parts: list[str] = []
    for value in values:
        if isinstance(value, str) and value.strip():
            parts.append(value.strip())
        elif isinstance(value, (int, float, bool)):
            parts.append(str(value))
    return "; ".join(parts)


def _artifact_label(*, role: str, path: str) -> str:
    role_label = str(role or "").replace("_", " ").strip()
    path_label = str(path or "").strip()
    if role_label and path_label:
        return f"the {role_label} artifact at {path_label}"
    if role_label:
        return f"the {role_label} artifact"
    if path_label:
        return f"the artifact at {path_label}"
    return "this artifact"


def _normalize_heading(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def _truncate(text: str, max_chars: int) -> str:
    if max_chars < 2:
        return text[:max_chars]
    compact = re.sub(r"\s+", " ", text).strip()
    if len(compact) <= max_chars:
        return compact
    clipped = compact[: max_chars - 1].rstrip()
    if " " in clipped:
        clipped = clipped.rsplit(" ", 1)[0].rstrip()
    return clipped + "…"


__all__ = ["MAX_CONTENT_TLDR_CHARS", "content_tldr"]
