"""Translate Merv's saved spend policy into trusted service admission claims.

Merv reads historical policy and costs. merv-sandboxes atomically reserves
new rental/renewal commitments across projects and owns their enforcement.
"""

from __future__ import annotations

from contextlib import closing
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from ..kernel.utils import ValidationError, parse_iso
from ..kernel.state import BaseStateStore


def daily_budget(
    *, store: BaseStateStore, project_id: str, provider: str, payer_id: str,
    billing_mode: str, now: datetime | None = None,
) -> dict[str, Any]:
    current = now or datetime.now(UTC)
    day = current.replace(hour=0, minute=0, second=0, microsecond=0)
    legacy_provider = "lambda_labs" if provider == "lambda" else provider
    with closing(store.connect()) as conn:
        pid = store.require_project_id(conn=conn, project_id=project_id)
        project = conn.execute("SELECT tenant_id FROM projects WHERE id = ?", (pid,)).fetchone()
        halted = conn.execute(
            "SELECT reason FROM spend_kill_switches WHERE tripped = 1 AND scope IN (?, ?)",
            ("global", project["tenant_id"]),
        ).fetchone()
        if halted:
            raise ValidationError("sandbox spending is halted by the research operator")
        policy = conn.execute(
            "SELECT daily_usd_limit, enabled FROM sandbox_provider_settings WHERE project_id = ? AND provider = ?",
            (pid, legacy_provider),
        ).fetchone()
        if policy and not policy["enabled"]:
            raise ValidationError("provider is disabled for this project")
        user_limit = None
        if billing_mode == "platform":
            if not payer_id:
                default = conn.execute(
                    "SELECT daily_usd_limit FROM provider_user_caps WHERE provider = ? AND user_id = ''",
                    (legacy_provider,),
                ).fetchone()
                if default and default["daily_usd_limit"] is not None:
                    raise ValidationError("a signed-in payer is required for platform compute")
            else:
                user_limit = store.resolve_provider_user_cap(provider=legacy_provider, user_id=payer_id, conn=conn)
        historical = conn.execute(
            "SELECT project_id, user_id, billing_mode, started_at, ended_at, price_usd_per_hour "
            "FROM sandbox_generations WHERE provider = ? AND (ended_at IS NULL OR ended_at >= ?)",
            (legacy_provider, day.isoformat()),
        ).fetchall()
    user_spent = Decimal(0)
    project_spent = Decimal(0)
    for row in historical:
        start = parse_iso(row["started_at"])
        end = parse_iso(row["ended_at"]) if row["ended_at"] else current
        if start is None or end is None:
            raise ValidationError("historical spend timestamps are invalid; cannot authorize compute")
        seconds = max(0.0, (min(current, end) - max(day, start)).total_seconds())
        amount = Decimal(str(seconds)) * Decimal(str(row["price_usd_per_hour"])) / Decimal(3600)
        if row["project_id"] == project_id:
            project_spent += amount
        if row["user_id"] == payer_id and row["billing_mode"] == "platform":
            user_spent += amount
    return {
        "payer_id": payer_id or "project-" + project_id,
        "provider": provider, "billing_mode": billing_mode,
        "source_day": current.date().isoformat(),
        "provider_daily_usd_limit": None if user_limit is None else str(user_limit),
        "project_daily_usd_limit": None if not policy or policy["daily_usd_limit"] is None else str(policy["daily_usd_limit"]),
        "legacy_user_spend_usd_today": str(user_spent),
        "legacy_project_spend_usd_today": str(project_spent),
    }
