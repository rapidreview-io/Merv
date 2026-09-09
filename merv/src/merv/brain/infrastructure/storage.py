"""Large dataset and model transfers through native merv-sandboxes storage.

Research names, versions, associations and retention policy remain in Merv.
Artifact and figure bytes use the independent Merv-owned R2 adapter.
"""

from __future__ import annotations

import base64
import json
import re
from typing import Any

from ..kernel.ports.blob_store import validate_blob_keys
from ..kernel.utils import NotFoundError, ValidationError
from ..object_storage import ObjectStat
from .client import InfrastructureClient, InfrastructureUnavailableError, project_namespace


def _encode_upload(namespace: str, object_id: str, *, row_id: str | None = None) -> str:
    identity = [namespace, object_id]
    if row_id is not None:
        identity.append(row_id)
    payload = json.dumps(identity, separators=(",", ":")).encode()
    return "msbx_" + base64.urlsafe_b64encode(payload).decode().rstrip("=")


def _decode_upload(upload_id: str) -> tuple[str, str]:
    try:
        if not upload_id.startswith("msbx_") or len(upload_id) > 512:
            raise ValueError
        raw = upload_id[5:]
        identity = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
        if not isinstance(identity, list) or len(identity) not in {2, 3}:
            raise ValueError
        namespace, object_id = identity[:2]
        if len(identity) == 3 and (
            not isinstance(identity[2], str)
            or not re.fullmatch(r"sto_[A-Za-z0-9_]{1,128}", identity[2])
        ):
            raise ValueError
        validate_blob_keys(namespace=namespace)
        if not isinstance(object_id, str) or not object_id.startswith("obj_"):
            raise ValueError
        validate_blob_keys(namespace=object_id)
        return namespace, object_id
    except (ValueError, TypeError, UnicodeError) as exc:
        raise ValidationError("invalid merv-sandboxes upload identity") from exc


class RemoteObjectProvider:
    def __init__(self, *, client: InfrastructureClient) -> None:
        self.client = client

    def _namespace(self, namespace: str) -> str:
        return project_namespace(namespace)

    def _name(self, namespace: str, sha256: str) -> str:
        validate_blob_keys(namespace=namespace, sha256=sha256)
        return sha256

    def _find(self, *, namespace: str, sha256: str) -> list[dict[str, Any]]:
        name = self._name(namespace, sha256)
        records: list[dict[str, Any]] = []
        offset = 0
        while True:
            page = self.client.request("GET", "/storage/objects", namespace=self._namespace(namespace),
                                       params={"name": name, "limit": 1000, "offset": offset})["objects"]
            records.extend(row for row in page if row["sha256"] == sha256)
            if len(page) < 1000:
                return records
            offset += len(page)

    def _available(self, *, namespace: str, sha256: str) -> dict[str, Any] | None:
        return next((row for row in self._find(namespace=namespace, sha256=sha256)
                     if row["state"] == "available"), None)

    def presign_upload(
        self, *, namespace: str, sha256: str, size_bytes: int,
        content_type: str = "application/octet-stream", expires_in: int,
    ) -> dict[str, Any]:
        name = self._name(namespace, sha256)
        status = self.client.request("POST", "/storage/objects", namespace=self._namespace(namespace),
                                     json={"name": name, "sha256": sha256, "size_bytes": size_bytes,
                                           "content_type": content_type})
        return self._target(namespace=namespace, status=status)

    def _target(self, *, namespace: str, status: dict[str, Any]) -> dict[str, Any]:
        obj = status["object"]
        parts = list(status["parts"])
        completed = list(status.get("completed_parts", []))
        next_part = status.get("next_part")
        seen: set[int] = set()
        while next_part is not None:
            if next_part in seen:
                raise InfrastructureUnavailableError("invalid upload pagination from merv-sandboxes")
            seen.add(next_part)
            page = self.client.request("GET", f"/storage/objects/{obj['id']}/upload",
                                       namespace=self._namespace(namespace),
                                       params={"start_part": next_part, "limit": 100})
            parts.extend(page["parts"])
            completed.extend(page.get("completed_parts", []))
            next_part = page.get("next_part")
        target = {"upload_id": _encode_upload(namespace, obj["id"]), "parts": parts,
                "completed_parts": sorted(set(completed)), "part_count": status["part_count"],
                "part_size": status["part_size"], "size_bytes": obj["size_bytes"],
                "content_type": obj["content_type"],
                "checksum_sha256": base64.b64encode(bytes.fromhex(obj["sha256"])).decode()}
        if status["part_count"] == 1 and len(parts) == 1 and not completed:
            target.update(url=parts[0]["url"], headers=parts[0].get("headers", {}))
        return target

    def resume_upload(self, *, upload_id: str, expires_in: int) -> dict[str, Any]:
        namespace, object_id = _decode_upload(upload_id)
        status = self.client.request("GET", f"/storage/objects/{object_id}/upload",
                                     namespace=self._namespace(namespace))
        target = self._target(namespace=namespace, status=status)
        # Several historical ledger rows can share one native content object.
        # Their row-specific completion handles must survive URL refreshes.
        target["upload_id"] = upload_id
        return target

    def complete_upload(self, *, upload_id: str, parts: Any = None) -> ObjectStat:
        namespace, object_id = _decode_upload(upload_id)
        obj = self.client.request("POST", f"/storage/objects/{object_id}/complete",
                                  namespace=self._namespace(namespace))
        return self._stat(namespace, obj)

    @staticmethod
    def _stat(namespace: str, obj: dict[str, Any]) -> ObjectStat:
        if obj["state"] != "available":
            raise ValidationError("merv-sandboxes has not completed the upload")
        return ObjectStat(namespace=namespace, sha256=obj["sha256"], size_bytes=obj["size_bytes"],
                          content_type=obj["content_type"])

    def stat(self, *, namespace: str, sha256: str) -> ObjectStat | None:
        obj = self._available(namespace=namespace, sha256=sha256)
        return self._stat(namespace, obj) if obj else None

    def presign_download(self, *, namespace: str, sha256: str, expires_in: int) -> dict[str, str]:
        obj = self._available(namespace=namespace, sha256=sha256)
        if obj is None:
            raise NotFoundError(f"stored content not found: {namespace}/{sha256}")
        target = self.client.request("GET", f"/storage/objects/{obj['id']}/download",
                                     namespace=self._namespace(namespace))
        return {"url": target["url"]}

    def delete(self, *, namespace: str, sha256: str) -> bool:
        found = False
        for obj in self._find(namespace=namespace, sha256=sha256):
            if obj["state"] not in {"deleted", "delete_pending"}:
                self.client.request("DELETE", f"/storage/objects/{obj['id']}",
                                    namespace=self._namespace(namespace))
                found = True
        return found
