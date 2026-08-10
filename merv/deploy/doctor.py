#!/usr/bin/env python3
"""One-shot post-startup readiness sweep for the reference deploy stack.

This is intentionally a doctor, not a liveness probe. It performs active checks
that may call provider APIs and write tiny smoke artifacts, so run it once after
startup/restart rather than as a periodic Docker HEALTHCHECK.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
import time
from dataclasses import dataclass
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request


DEFAULT_CONTROL_URL = "http://127.0.0.1:8787"
DEFAULT_PROJECT_NAME = "Deploy Doctor"
SMOKE_BYTES = b"merv deploy doctor storage smoke\n"


class DoctorError(RuntimeError):
    """Readiness check failure with an operator-facing message."""


@dataclass
class Check:
    name: str
    ok: bool
    detail: str


class Doctor:
    def __init__(
        self,
        *,
        control_url: str,
        project_id: str,
        project_name: str,
        timeout: float,
        url_rewrite: list[tuple[str, str]],
        skip_storage: bool,
        bearer_token: str,
    ) -> None:
        self.control_url = control_url.rstrip("/")
        self.project_id = project_id
        self.project_name = project_name
        self.timeout = timeout
        self.url_rewrite = url_rewrite
        self.skip_storage = skip_storage
        self.bearer_token = bearer_token
        self.checks: list[Check] = []

    def run(self) -> int:
        project_id = ""
        try:
            meta = self._control("GET", "/api/meta")
            self._ok("control", f"version={meta.get('server_version') or meta.get('version')}")

            project_id = self._ensure_project()
            self._ok("project", project_id)

            self._check_sandbox(project_id=project_id)
            if not self.skip_storage:
                self._check_storage(project_id=project_id)
            else:
                self._ok("storage", "skipped")
        except DoctorError as exc:
            self._fail("doctor", str(exc))
        except Exception as exc:  # noqa: BLE001
            self._fail("doctor", f"unexpected failure: {type(exc).__name__}: {exc}")

        for check in self.checks:
            marker = "ok" if check.ok else "FAIL"
            print(f"[{marker}] {check.name}: {check.detail}")
        return 0 if all(check.ok for check in self.checks) else 1

    def _ensure_project(self) -> str:
        if self.project_id:
            return self.project_id
        listed = self._control("GET", "/api/projects")
        for project in listed.get("projects") or []:
            if str(project.get("name") or "") == self.project_name:
                return str(project["id"])
        created = self._control(
            "POST",
            "/api/projects",
            {
                "name": self.project_name,
                "summary": "Operational smoke project for post-startup deploy checks.",
            },
        )
        return str(created["id"])

    def _check_sandbox(self, *, project_id: str) -> None:
        health = self._control("GET", "/api/sandboxes/health")
        if not health.get("ok"):
            raise DoctorError(f"sandbox backend is unhealthy: {health.get('error') or health}")
        options = self._mcp("sandbox.options", {"project_id": project_id})
        provider = str(options.get("provider") or health.get("backend") or "unknown")
        if options.get("selection_required") and not (options.get("options") or []):
            raise DoctorError(f"{provider} requires hardware selection but returned no options")
        option_count = len(options.get("options") or [])
        self._ok("sandbox", f"backend={provider}, options={option_count}")

    def _check_storage(self, *, project_id: str) -> None:
        payload = SMOKE_BYTES + str(time.time_ns()).encode("ascii")
        sha = hashlib.sha256(payload).hexdigest()
        checksum = base64.b64encode(hashlib.sha256(payload).digest()).decode("ascii")
        name = f"deploy-doctor-smoke-{int(time.time())}"
        registered = self._mcp(
            "storage.put_object",
            {
                "project_id": project_id,
                "name": name,
                "kind": "other",
                "sha256": sha,
                "size_bytes": len(payload),
                "content_type": "text/plain",
                "notes": "post-startup deploy doctor smoke object",
            },
        )
        obj = registered.get("object") or {}
        upload = registered.get("upload") or {}
        if upload:
            upload_url = self._rewrite_url(str(upload["url"]))
            self._raw_request(
                "PUT",
                upload_url,
                data=payload,
                headers={
                    "Content-Type": "text/plain",
                    "x-amz-checksum-sha256": checksum,
                },
            )
            completed = self._mcp(
                "storage.complete_upload",
                {"project_id": project_id, "upload_id": str(upload["upload_id"])},
            )
            obj = completed
        object_id = str(obj.get("id") or "")
        if not object_id:
            raise DoctorError("storage smoke did not return an object id")
        resolved = self._mcp(
            "storage.find",
            {"project_id": project_id, "object_id": object_id, "include_download": True},
        )
        download = resolved.get("download") or {}
        download_url = self._rewrite_url(str(download.get("url") or ""))
        if not download_url:
            raise DoctorError("storage smoke did not return a download URL")
        data = self._raw_request("GET", download_url)
        if data != payload:
            raise DoctorError("storage smoke downloaded bytes did not match upload")
        self._mcp(
            "storage.object",
            {"project_id": project_id, "object_id": object_id, "action": "delete"},
        )
        self._ok("storage", f"object_id={object_id}")

    def _mcp(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        response = self._control("POST", "/mcp/call", {"name": name, "arguments": arguments})
        result = response.get("result")
        if not isinstance(result, dict):
            raise DoctorError(f"{name} returned a non-object result")
        return result

    def _control(
        self, method: str, path: str, body: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return self._json_request(method, self.control_url + path, body)

    def _json_request(
        self, method: str, url: str, body: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Accept": "application/json"}
        if self.bearer_token:
            headers["Authorization"] = f"Bearer {self.bearer_token}"
        if data is not None:
            headers["Content-Type"] = "application/json"
        raw = self._raw_request(method, self._rewrite_url(url), data=data, headers=headers)
        if not raw:
            return {}
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DoctorError(f"{url} returned non-JSON response") from exc
        if not isinstance(parsed, dict):
            raise DoctorError(f"{url} returned non-object JSON")
        return parsed

    def _raw_request(
        self,
        method: str,
        url: str,
        *,
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> bytes:
        req = urllib_request.Request(
            self._rewrite_url(url), data=data, method=method, headers=headers or {}
        )
        try:
            with urllib_request.urlopen(req, timeout=self.timeout) as response:
                return response.read()
        except urllib_error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise DoctorError(f"{method} {url} failed HTTP {exc.code}: {detail}") from exc
        except urllib_error.URLError as exc:
            raise DoctorError(f"{method} {url} failed: {exc.reason}") from exc

    def _rewrite_url(self, url: str) -> str:
        rewritten = url
        for old, new in self.url_rewrite:
            rewritten = rewritten.replace(old, new)
        return rewritten

    def _ok(self, name: str, detail: str) -> None:
        self.checks.append(Check(name=name, ok=True, detail=detail))

    def _fail(self, name: str, detail: str) -> None:
        self.checks.append(Check(name=name, ok=False, detail=detail))


def _parse_rewrites(raw_values: list[str]) -> list[tuple[str, str]]:
    rewrites: list[tuple[str, str]] = []
    for raw in raw_values:
        if not raw:
            continue
        for item in raw.split(","):
            item = item.strip()
            if not item:
                continue
            if "=" not in item:
                raise SystemExit(f"invalid URL rewrite {item!r}; expected OLD=NEW")
            old, new = item.split("=", 1)
            rewrites.append((old, new))
    return rewrites


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--control-url",
        default=os.environ.get("RP_DOCTOR_CONTROL_URL", DEFAULT_CONTROL_URL),
        help=f"Control-plane base URL (default: {DEFAULT_CONTROL_URL})",
    )
    parser.add_argument(
        "--project-id",
        default=os.environ.get("RP_DOCTOR_PROJECT_ID", ""),
        help="Existing project id to use for smoke artifacts.",
    )
    parser.add_argument(
        "--project-name",
        default=os.environ.get("RP_DOCTOR_PROJECT_NAME", DEFAULT_PROJECT_NAME),
        help=f"Project name to create/reuse when --project-id is omitted.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=float(os.environ.get("RP_DOCTOR_TIMEOUT", "20")),
        help="HTTP timeout in seconds per request.",
    )
    parser.add_argument(
        "--url-rewrite",
        action="append",
        default=[],
        help="Rewrite URLs before fetching them, OLD=NEW. Also read from RP_DOCTOR_URL_REWRITE.",
    )
    parser.add_argument(
        "--skip-storage",
        action="store_true",
        default=os.environ.get("RP_DOCTOR_SKIP_STORAGE", "").lower() in {"1", "true", "yes"},
        help="Skip object-storage upload/download smoke.",
    )
    parser.add_argument(
        "--bearer-token",
        default=os.environ.get(
            "RP_DOCTOR_BEARER_TOKEN", os.environ.get("MERV_MCP_KEY", "")
        ),
        help=(
            "Bearer credential for authenticated control routes. Defaults to "
            "RP_DOCTOR_BEARER_TOKEN, then MERV_MCP_KEY."
        ),
    )
    args = parser.parse_args(argv)
    rewrites = _parse_rewrites(
        [os.environ.get("RP_DOCTOR_URL_REWRITE", ""), *args.url_rewrite]
    )
    return Doctor(
        control_url=args.control_url,
        project_id=args.project_id,
        project_name=args.project_name,
        timeout=args.timeout,
        url_rewrite=rewrites,
        skip_storage=args.skip_storage,
        bearer_token=args.bearer_token,
    ).run()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
