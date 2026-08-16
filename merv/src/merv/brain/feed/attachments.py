# If you update this file, you must consult feed.md to see whether feed.md needs to be updated. feed.md must not exceed 100 lines.
"""Typed post attachments: validation and normalization.

A post carries at most ``MAX_ATTACHMENTS`` typed attachments. Native ones
(``stat``, ``chart``, ``table``, ``log``) are small JSON documents the UI draws
in the design system; ``image``/``embed`` name a local file the agent uploads
with the returned command; ``link`` names a URL to unfurl. Pure validation —
no I/O, no storage.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from ..kernel.utils import ValidationError

MAX_ATTACHMENTS = 4
MAX_NATIVE_BYTES = 4096
# A Vega-Lite spec carries its data inline, so it gets a bigger budget.
MAX_VEGA_BYTES = 20_000
NATIVE_TYPES = frozenset({"stat", "chart", "table", "log", "heatmap", "diagram", "vega"})
UPLOAD_TYPES = frozenset({"image", "embed"})
# `figure` references a figure already submitted with an artifact; the feed
# service checks it exists in the project before accepting the post.
ATTACHMENT_TYPES = NATIVE_TYPES | UPLOAD_TYPES | {"link", "figure"}
CHART_KINDS = frozenset({"line", "bars", "scatter"})

_MAX_SERIES = 6
_MAX_POINTS = 64
_MAX_SCATTER_POINTS = 200
_MAX_BARS = 12
_MAX_HEATMAP_SIDE = 20
_MAX_DIAGRAM_CHARS = 4000
_MAX_DIAGRAM_LINES = 80
_MAX_TABLE_COLUMNS = 8
_MAX_TABLE_ROWS = 20
_MAX_LOG_LINES = 40
_MAX_LOG_CHARS = 4000


@dataclass(frozen=True, slots=True)
class NormalizedAttachments:
    native: tuple[dict[str, Any], ...]
    media_kind: str  # "image" | "embed" | ""
    media_path: str
    link_url: str


def _text(value: Any, *, field: str, limit: int, required: bool = False) -> str:
    if value is None:
        if required:
            raise ValidationError(f"attachment field '{field}' is required")
        return ""
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise ValidationError(f"attachment field '{field}' must be text or a number")
    text = str(value).strip()
    if required and not text:
        raise ValidationError(f"attachment field '{field}' is required")
    if len(text) > limit:
        raise ValidationError(f"attachment field '{field}' is over {limit} characters")
    return text


def _number(value: Any, *, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValidationError(f"attachment field '{field}' must be a number")
    return float(value)


def _stat(raw: dict[str, Any]) -> dict[str, Any]:
    out = {
        "type": "stat",
        "value": _text(raw.get("value"), field="stat.value", limit=24, required=True),
    }
    for key, limit in (("unit", 12), ("delta", 40), ("baseline", 60), ("note", 120)):
        text = _text(raw.get(key), field=f"stat.{key}", limit=limit)
        if text:
            out[key] = text
    return out


def _chart(raw: dict[str, Any]) -> dict[str, Any]:
    kind = _text(raw.get("kind"), field="chart.kind", limit=8, required=True).lower()
    if kind not in CHART_KINDS:
        raise ValidationError(
            f"chart.kind must be one of {', '.join(sorted(CHART_KINDS))}"
        )
    series_raw = raw.get("series")
    if not isinstance(series_raw, list) or not series_raw:
        raise ValidationError("chart.series must be a non-empty list")
    if len(series_raw) > _MAX_SERIES:
        raise ValidationError(f"chart.series may hold at most {_MAX_SERIES} series")
    series: list[dict[str, Any]] = []
    for index, item in enumerate(series_raw):
        if not isinstance(item, dict):
            raise ValidationError(f"chart.series[{index}] must be an object")
        name = _text(item.get("name"), field=f"chart.series[{index}].name", limit=40)
        if kind in ("line", "scatter"):
            points_raw = item.get("points")
            if not isinstance(points_raw, list) or not points_raw:
                raise ValidationError(f"chart.series[{index}].points must be a non-empty list of [x, y]")
            cap = _MAX_SCATTER_POINTS if kind == "scatter" else _MAX_POINTS
            if len(points_raw) > cap:
                raise ValidationError(f"a {kind} series holds at most {cap} points")
            points = []
            for point in points_raw:
                if not isinstance(point, (list, tuple)) or len(point) != 2:
                    raise ValidationError("each line point must be [x, y]")
                points.append([
                    _number(point[0], field=f"chart.series[{index}].points.x"),
                    _number(point[1], field=f"chart.series[{index}].points.y"),
                ])
            series.append({"name": name, "points": points})
        else:
            values_raw = item.get("values")
            if not isinstance(values_raw, list) or not values_raw:
                raise ValidationError(f"chart.series[{index}].values must be a non-empty list of numbers")
            if len(values_raw) > _MAX_BARS:
                raise ValidationError(f"a bars series holds at most {_MAX_BARS} values")
            series.append({
                "name": name,
                "values": [_number(v, field=f"chart.series[{index}].values") for v in values_raw],
            })
    out: dict[str, Any] = {
        "type": "chart",
        "kind": kind,
        "title": _text(raw.get("title"), field="chart.title", limit=80),
        "series": series,
    }
    if kind == "bars":
        labels_raw = raw.get("labels")
        if not isinstance(labels_raw, list) or not labels_raw:
            raise ValidationError("bars charts need labels: one per bar")
        labels = [_text(v, field="chart.labels", limit=24, required=True) for v in labels_raw]
        if any(len(s["values"]) != len(labels) for s in series):
            raise ValidationError("every bars series must have one value per label")
        out["labels"] = labels
    for key, limit in (("unit", 12), ("x_label", 24), ("y_label", 24)):
        text = _text(raw.get(key), field=f"chart.{key}", limit=limit)
        if text:
            out[key] = text
    ref_line = raw.get("ref_line")
    if ref_line is not None:
        if not isinstance(ref_line, dict):
            raise ValidationError("chart.ref_line must be an object {value, label?}")
        out["ref_line"] = {"value": _number(ref_line.get("value"), field="chart.ref_line.value")}
        label = _text(ref_line.get("label"), field="chart.ref_line.label", limit=40)
        if label:
            out["ref_line"]["label"] = label
    hero = raw.get("hero")
    if hero is not None:
        if not isinstance(hero, dict):
            raise ValidationError("chart.hero must be an object {series, index}")
        s_idx = int(_number(hero.get("series", 0), field="chart.hero.series"))
        p_idx = int(_number(hero.get("index"), field="chart.hero.index"))
        if not 0 <= s_idx < len(series):
            raise ValidationError("chart.hero.series is out of range")
        length = len(series[s_idx]["points" if kind in ("line", "scatter") else "values"])
        if not 0 <= p_idx < length:
            raise ValidationError("chart.hero.index is out of range")
        out["hero"] = {"series": s_idx, "index": p_idx}
    return out


def _table(raw: dict[str, Any]) -> dict[str, Any]:
    columns_raw = raw.get("columns")
    if not isinstance(columns_raw, list) or not columns_raw:
        raise ValidationError("table.columns must be a non-empty list")
    if len(columns_raw) > _MAX_TABLE_COLUMNS:
        raise ValidationError(f"a table holds at most {_MAX_TABLE_COLUMNS} columns")
    columns = [_text(c, field="table.columns", limit=24, required=True) for c in columns_raw]
    rows_raw = raw.get("rows")
    if not isinstance(rows_raw, list) or not rows_raw:
        raise ValidationError("table.rows must be a non-empty list of rows")
    if len(rows_raw) > _MAX_TABLE_ROWS:
        raise ValidationError(f"a table holds at most {_MAX_TABLE_ROWS} rows")
    rows = []
    for row in rows_raw:
        if not isinstance(row, list) or len(row) != len(columns):
            raise ValidationError("every table row must have one cell per column")
        rows.append([_text(cell, field="table.rows", limit=40) for cell in row])
    out: dict[str, Any] = {"type": "table", "columns": columns, "rows": rows}
    hero_row = raw.get("hero_row")
    if hero_row is not None:
        idx = int(_number(hero_row, field="table.hero_row"))
        if not 0 <= idx < len(rows):
            raise ValidationError("table.hero_row is out of range")
        out["hero_row"] = idx
    caption = _text(raw.get("caption"), field="table.caption", limit=80)
    if caption:
        out["caption"] = caption
    return out


def _log(raw: dict[str, Any]) -> dict[str, Any]:
    text = raw.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ValidationError("log.text is required")
    text = text.rstrip("\n")
    if len(text) > _MAX_LOG_CHARS:
        raise ValidationError(f"log.text is over {_MAX_LOG_CHARS} characters")
    lines = text.split("\n")
    if len(lines) > _MAX_LOG_LINES:
        raise ValidationError(f"log.text holds at most {_MAX_LOG_LINES} lines")
    out: dict[str, Any] = {"type": "log", "text": text}
    highlight = raw.get("highlight")
    if highlight is not None:
        if not isinstance(highlight, list):
            raise ValidationError("log.highlight must be a list of line indexes")
        indexes = sorted({int(_number(v, field="log.highlight")) for v in highlight})
        if any(not 0 <= i < len(lines) for i in indexes):
            raise ValidationError("log.highlight index is out of range")
        out["highlight"] = indexes
    return out


def _heatmap(raw: dict[str, Any]) -> dict[str, Any]:
    rows_raw, cols_raw, values_raw = raw.get("rows"), raw.get("cols"), raw.get("values")
    if not isinstance(rows_raw, list) or not rows_raw or not isinstance(cols_raw, list) or not cols_raw:
        raise ValidationError("heatmap.rows and heatmap.cols must be non-empty lists of labels")
    if len(rows_raw) > _MAX_HEATMAP_SIDE or len(cols_raw) > _MAX_HEATMAP_SIDE:
        raise ValidationError(f"a heatmap holds at most {_MAX_HEATMAP_SIDE}×{_MAX_HEATMAP_SIDE} cells")
    rows = [_text(v, field="heatmap.rows", limit=24, required=True) for v in rows_raw]
    cols = [_text(v, field="heatmap.cols", limit=24, required=True) for v in cols_raw]
    if not isinstance(values_raw, list) or len(values_raw) != len(rows):
        raise ValidationError("heatmap.values must hold one list of numbers per row")
    values = []
    for row in values_raw:
        if not isinstance(row, list) or len(row) != len(cols):
            raise ValidationError("every heatmap.values row must have one number per column")
        values.append([_number(v, field="heatmap.values") for v in row])
    out: dict[str, Any] = {"type": "heatmap", "rows": rows, "cols": cols, "values": values}
    for key, limit in (("title", 80), ("unit", 12)):
        text = _text(raw.get(key), field=f"heatmap.{key}", limit=limit)
        if text:
            out[key] = text
    for key in ("vmin", "vmax"):
        if raw.get(key) is not None:
            out[key] = _number(raw.get(key), field=f"heatmap.{key}")
    if raw.get("annotate") is not None:
        out["annotate"] = bool(raw.get("annotate"))
    return out


def _diagram(raw: dict[str, Any]) -> dict[str, Any]:
    text = raw.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ValidationError("diagram.text (Mermaid source) is required")
    text = text.strip()
    if len(text) > _MAX_DIAGRAM_CHARS:
        raise ValidationError(f"diagram.text is over {_MAX_DIAGRAM_CHARS} characters")
    if text.count("\n") + 1 > _MAX_DIAGRAM_LINES:
        raise ValidationError(f"diagram.text holds at most {_MAX_DIAGRAM_LINES} lines")
    return {"type": "diagram", "text": text}


_VEGA_FORBIDDEN_KEYS = frozenset({"url", "href", "usermeta", "loader"})


def _vega_scan(node: Any, path: str = "spec") -> None:
    """Refuse anything that would reach outside the spec: remote data or
    images (``url``), click-outs (``href``), and loader hooks."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key in _VEGA_FORBIDDEN_KEYS:
                raise ValidationError(
                    f"vega spec may not use '{key}' ({path}.{key}); inline the data with data.values"
                )
            _vega_scan(value, f"{path}.{key}")
    elif isinstance(node, list):
        for index, value in enumerate(node):
            _vega_scan(value, f"{path}[{index}]")


def _vega(raw: dict[str, Any]) -> dict[str, Any]:
    spec = raw.get("spec")
    if not isinstance(spec, dict) or not spec:
        raise ValidationError("vega.spec must be a Vega-Lite spec object with inline data.values")
    schema = str(spec.get("$schema") or "")
    if schema and "vega-lite" not in schema:
        raise ValidationError("vega.spec must be a Vega-Lite spec (schema vega-lite/v5 or v6)")
    if len(json.dumps(spec, separators=(",", ":"))) > MAX_VEGA_BYTES:
        raise ValidationError(f"vega.spec is over {MAX_VEGA_BYTES} bytes; thin the data")
    _vega_scan(spec)
    out: dict[str, Any] = {"type": "vega", "spec": spec}
    title = _text(raw.get("title"), field="vega.title", limit=80)
    if title:
        out["title"] = title
    return out


def _figure(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "figure",
        "artifact_id": _text(raw.get("artifact_id"), field="figure.artifact_id", limit=64, required=True),
        "path": _text(raw.get("path"), field="figure.path", limit=512, required=True),
        "caption": _text(raw.get("caption"), field="figure.caption", limit=120),
    }


def normalize_attachments(
    raw: Any,
    *,
    image_path: str = "",
    html_path: str = "",
    url: str = "",
) -> NormalizedAttachments:
    """Validate ``raw`` (a list of attachment objects) and fold in the legacy
    ``image_path`` / ``html_path`` / ``url`` shorthands. At most one upload
    (image or embed) and one link per post."""
    if raw is None:
        raw = []
    if not isinstance(raw, list):
        raise ValidationError("attachments must be a list of objects")
    if len(raw) > MAX_ATTACHMENTS:
        raise ValidationError(f"a post carries at most {MAX_ATTACHMENTS} attachments")
    native: list[dict[str, Any]] = []
    media_kind = "image" if image_path else ("embed" if html_path else "")
    media_path = str(image_path or html_path or "")
    link_url = str(url or "").strip()
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValidationError(f"attachments[{index}] must be an object with a type")
        kind = str(item.get("type") or "").strip().lower()
        if kind not in ATTACHMENT_TYPES:
            raise ValidationError(
                f"attachments[{index}].type must be one of {', '.join(sorted(ATTACHMENT_TYPES))}"
            )
        if kind in UPLOAD_TYPES:
            path = _text(item.get("path"), field=f"{kind}.path", limit=1024, required=True)
            if media_kind:
                raise ValidationError("a post may carry one image or embed upload; put more in a thread")
            media_kind, media_path = kind, path
        elif kind == "link":
            link = _text(item.get("url"), field="link.url", limit=2048, required=True)
            if link_url:
                raise ValidationError("a post may carry one link; put more in a thread")
            link_url = link
        else:
            builder = {
                "stat": _stat, "chart": _chart, "table": _table, "log": _log,
                "heatmap": _heatmap, "diagram": _diagram, "vega": _vega, "figure": _figure,
            }[kind]
            built = builder(item)
            cap = MAX_VEGA_BYTES if kind == "vega" else MAX_NATIVE_BYTES
            if len(json.dumps(built, separators=(",", ":"))) > cap:
                raise ValidationError(f"attachments[{index}] is over {cap} bytes")
            native.append(built)
    return NormalizedAttachments(
        native=tuple(native),
        media_kind=media_kind,
        media_path=media_path,
        link_url=link_url,
    )
