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
