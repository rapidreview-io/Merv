from __future__ import annotations


class FakeProcess:
    def __init__(self, stdout: str = "", code: int = 0, *, running: bool = True) -> None:
        self._stdout = stdout
        self._code = code
        self._running = running
        self.terminated = False
        self.killed = False

    @property
    def stdout(self):
        text = self._stdout

        class _Stream:
            def read(self_inner):
                return text

        return _Stream()

    @property
    def stderr(self):
        return None

    def poll(self) -> int | None:
        if self.terminated or self.killed:
            return -15
        return None if self._running else self._code

    def terminate(self) -> None:
        self.terminated = True

    def kill(self) -> None:
        self.killed = True

    def wait(self, timeout: float | None = None) -> int:  # noqa: ARG002
        return self._code if not (self.terminated or self.killed) else -15
class FakeBlobStore:
    """In-memory BlobStore double sharing LocalDirBlobStore's semantics."""

    def __init__(self) -> None:
        self.blobs: dict[tuple[str, str], bytes] = {}
        self.meta: dict[tuple[str, str], dict] = {}

    def put(
        self,
        *,
        namespace: str,
        data: bytes,
        content_type: str = "application/octet-stream",
        expires_at: str | None = None,
    ) -> str:
        import hashlib

        from merv.brain.kernel.utils import now_iso

        sha = hashlib.sha256(data).hexdigest()
        key = (namespace, sha)
        if key in self.blobs:
            current = self.meta[key].get("expires_at")
            if current is not None and (expires_at is None or expires_at > current):
                self.meta[key]["expires_at"] = expires_at
            return sha
        self.blobs[key] = data
        self.meta[key] = {
            "sha256": sha,
            "namespace": namespace,
            "size_bytes": len(data),
            "content_type": content_type,
            "created_at": now_iso(),
            "expires_at": expires_at,
        }
        return sha

    def get(self, *, namespace: str, sha256: str) -> bytes:
        from merv.brain.kernel.utils import NotFoundError

        key = (namespace, sha256)
        if key not in self.blobs:
            raise NotFoundError(f"blob not found: {namespace}/{sha256}")
        return self.blobs[key]

    def sweep_expired(self, *, now: str | None = None) -> int:
        from merv.brain.kernel.utils import now_iso

        cutoff = now or now_iso()
        expired = [
            key
            for key, meta in self.meta.items()
            if meta.get("expires_at") and str(meta["expires_at"]) <= cutoff
        ]
        for key in expired:
            self.blobs.pop(key, None)
            self.meta.pop(key, None)
        return len(expired)


class FakeObjectStore:
    """Test double for the heavy ObjectStore port.

    Production storage now goes exclusively through S3CompatibleObjectStore.
    This fake exists only to keep ledger/service tests isolated from Docker.
    """

    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], bytes] = {}
        self.meta: dict[tuple[str, str], dict] = {}
        self.uploads: dict[str, dict] = {}
        self._staging_dir: str | None = None

    def presign_upload(
        self,
        *,
        namespace: str,
        sha256: str,
        size_bytes: int,
        content_type: str = "application/octet-stream",
        expires_in: int,
    ) -> dict:
        import tempfile
        from pathlib import Path as _Path

        from merv.brain.kernel.ports.blob_store import validate_blob_keys
        from merv.brain.kernel.utils import new_id

        _ = expires_in
        validate_blob_keys(namespace=namespace, sha256=sha256)
        if self._staging_dir is None:
            self._staging_dir = tempfile.mkdtemp(prefix="fake-object-uploads-")
        upload_id = new_id(prefix="upload")
        staging = _Path(self._staging_dir) / upload_id
        self.uploads[upload_id] = {
            "namespace": namespace,
            "sha256": sha256,
            "size_bytes": int(size_bytes),
            "content_type": content_type,
            "path": staging,
        }
        return {
            "upload_id": upload_id,
            "url": staging.resolve().as_uri(),
            "size_bytes": int(size_bytes),
            "content_type": content_type,
        }

    def complete_upload(self, *, upload_id: str, parts: list[dict] | None = None):
        import hashlib

        from merv.brain.object_storage.provider import ObjectStat
        from merv.brain.kernel.utils import NotFoundError, ValidationError

        _ = parts
        meta = self.uploads.pop(upload_id, None)
        if meta is None:
            raise NotFoundError(f"unknown or already-consumed upload: {upload_id}")
        staging = meta["path"]
        try:
            if not staging.exists():
                raise NotFoundError(f"upload received no bytes: {upload_id}")
            data = staging.read_bytes()
            if len(data) > int(meta["size_bytes"]):
                raise ValidationError(
                    f"upload {upload_id} exceeds its size cap: "
                    f"{len(data)} > {meta['size_bytes']} bytes"
                )
            sha = hashlib.sha256(data).hexdigest()
            if sha != str(meta["sha256"]):
                raise ValidationError(
                    f"upload {upload_id} checksum mismatch: "
                    f"expected {meta['sha256']}, got {sha}"
                )
            key = (str(meta["namespace"]), sha)
            self.objects.setdefault(key, data)
            self.meta.setdefault(
                key,
                {
                    "sha256": sha,
                    "namespace": str(meta["namespace"]),
                    "size_bytes": len(data),
                    "content_type": str(meta["content_type"]),
                },
            )
            return ObjectStat(**self.meta[key])
        finally:
            try:
                staging.unlink()
            except FileNotFoundError:
                pass

    def resume_upload(self, *, upload_id: str, expires_in: int) -> dict:
        from merv.brain.kernel.utils import NotFoundError

        _ = expires_in
        meta = self.uploads.get(upload_id)
        if meta is None:
            raise NotFoundError(f"unknown or already-consumed upload: {upload_id}")
        return {
            "upload_id": upload_id,
            "url": meta["path"].resolve().as_uri(),
            "size_bytes": int(meta["size_bytes"]),
            "content_type": str(meta["content_type"]),
        }

    def presign_download(self, *, namespace: str, sha256: str, expires_in: int) -> dict:
        import tempfile
        from pathlib import Path as _Path

        from merv.brain.kernel.utils import NotFoundError

        _ = expires_in
        key = (namespace, sha256)
        if key not in self.objects:
            raise NotFoundError(f"object not found: {namespace}/{sha256}")
        if self._staging_dir is None:
            self._staging_dir = tempfile.mkdtemp(prefix="fake-object-uploads-")
        path = _Path(self._staging_dir) / f"{namespace}-{sha256}"
        path.write_bytes(self.objects[key])
        return {"url": path.resolve().as_uri()}

    def stat(self, *, namespace: str, sha256: str):
        from merv.brain.object_storage.provider import ObjectStat

        meta = self.meta.get((namespace, sha256))
        return ObjectStat(**meta) if meta is not None else None

    def delete(self, *, namespace: str, sha256: str) -> bool:
        key = (namespace, sha256)
        existed = key in self.objects
        self.objects.pop(key, None)
        self.meta.pop(key, None)
        return existed
