from __future__ import annotations

import contextlib
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from fastapi.testclient import TestClient

from merv.brain.surface.surface import build_local_server
from tests.support.infrastructure import FakeInfrastructureClient
from merv.brain.kernel.state import StateStore
from tests.support.blobs import LocalDirBlobStore
from merv.brain.kernel.utils import NotFoundError, ValidationError


DEFAULT_PUBLIC_KEY = "ssh-ed25519 " + ("A" * 48) + " test-brain@local"


def upload_token(run_command: str) -> str:
    """Extract the one-time token from an artifact.upload `run` line."""
    return run_command.rsplit("/", 1)[-1].rstrip("'")


class TestBrain:
    """Unified localhost brain with test conveniences around control dispatch.

    Tests keep the old repo_root/db_path construction convenience, while the
    record/lifecycle brain is the production Surface path built by
    build_local_server.
    """

    __test__ = False
    _PRIVATE_ALIASES = {
        "store": "_store",
        "blobs": "_blobs",
        "mlflow_tracking": "_tracking",
    }

    def __init__(
        self,
        *,
        repo_root: Path,
        db_path: Path,
        infrastructure_client: Any | None = None,
        store: Any | None = None,
        blobs: Any | None = None,
        mlflow_tracking: Any | None = None,
        storage_enabled: bool = False,
        env: dict[str, str] | None = None,
    ) -> None:
        self.repo_root = Path(repo_root).expanduser().resolve()
        self.db_path = Path(db_path).expanduser().resolve()
        # Materialize the pinned state dir up front so the project-state-dir
        # resolver behaves identically whether or not an injected store ever
        # touches the filesystem (StateStore mkdirs it; PostgresStateStore
        # does not).
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.workspace = SimpleNamespace(repo_root=self.repo_root)
        self._store = store if store is not None else StateStore(db_path=self.db_path)
        self._blobs = (
            blobs
            if blobs is not None
            else LocalDirBlobStore(root=self.db_path.parent / "blobs")
        )
        self.server = build_local_server(
            state_dir=self._brain_root(),
            env={} if env is None else env,
            infrastructure_client=(
                infrastructure_client
                if infrastructure_client is not None
                else FakeInfrastructureClient()
            ),
            store=self._store,
            blobs=self._blobs,
            mlflow_tracking=mlflow_tracking,
            # Storage tools stay out of the default manifest; storage tests opt in.
            storage_enabled=storage_enabled,
        )
        self._app = self.server.app
        research = self._app.research

        def list_projects(
            *,
            tenant_id: str | None = None,
            include_hidden: bool = False,
            user_id: str = "",
            project_id: str = "",
        ) -> dict[str, Any]:
            return research.reachable_projects(
                tenant_id=tenant_id,
                include_hidden=include_hidden,
                user_id=user_id,
                key_project_id=project_id,
            )

        self._test_parts = {
            "research_core": research,
            "projects": SimpleNamespace(
                create=research.create_project,
                get=research.get_project,
                update=research.update_project,
                list_projects=list_projects,
                current=research.current_project,
                members=research.project_members,
                is_member=research.is_project_member,
                add_member=research.add_project_member,
                remove_member=research.remove_project_member,
            ),
            "claims": SimpleNamespace(
                create=research.create_claim,
                update=research.update_claim,
                list_claims=research.list_claims,
            ),
            "experiments": research._experiments,
            "graph_refs": SimpleNamespace(resolve_index=research.resolve_graph_refs),
            "reflection_waves": research._reflections,
            "reviews": research._reviews,
            "artifacts": self._app.artifacts,
            "feed": self._app.feed,
            "literature": self._app.literature,
        }
        self.fastapi_app = self.server.fastapi_app
        self._client = TestClient(self.fastapi_app)

    def _brain_root(self) -> Path:
        if self.db_path.parent.name in {".merv", ".research_plugin"}:
            return self.db_path.parent.parent
        return self.db_path.parent

    def __getattr__(self, name: str) -> Any:
        if name == "infrastructure_client":
            return self._app.infrastructure_client
        if name in self._test_parts:
            return self._test_parts[name]
        return getattr(self._app, self._PRIVATE_ALIASES.get(name, name))

    def current_project(self, *, tenant_id: str | None = None) -> dict[str, Any]:
        return self._app.application.current_project(tenant_id=tenant_id)

    def list_tools(self) -> list[dict[str, Any]]:
        return self._app.tools.list_tools()

    def call_tool(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
        *,
        activity_source: str = "app",
        internal_kwargs: dict[str, Any] | None = None,
        telemetry_project_id: str | None = None,
    ) -> dict[str, Any]:
        args = dict(arguments or {})
        effective_internal_kwargs = dict(internal_kwargs or {})
        if name == "sandbox.request":
            args.setdefault("public_key", DEFAULT_PUBLIC_KEY)
            args.setdefault("provider", "fake")
            args.setdefault("instance_type", "tiny:east")
        try:
            return self._app.tools.call_tool(
                name=name,
                arguments=args,
                activity_source=activity_source,
                internal_kwargs=effective_internal_kwargs or None,
                telemetry_project_id=telemetry_project_id,
            )
        finally:
            # The ledger writes on its own thread. Tests read the table and
            # delete the database directory the moment a call returns, so the
            # row has to be in before this does.
            self._app.tool_ledger.flush()

    def submit_artifact(
        self,
        *,
        project_id: str,
        target_type: str,
        target_id: str,
        role: str,
        path: str,
        body: bytes | str,
        lens_id: str = "",
        title: str = "",
    ) -> dict[str, Any]:
        """The production submit flow: artifact.upload -> token-bearer PUT."""
        pending = self.call_tool(
            "artifact.upload",
            {
                "project_id": project_id,
                "path": path,
                "title": title,
                "attach_to": {
                    "target_type": target_type, "target_id": target_id,
                    "role": role, "lens_id": lens_id,
                },
            },
        )
        result = self.upload_artifact_bytes(
            token=upload_token(pending["run"]),
            data=body if isinstance(body, bytes) else str(body).encode(),
        )
        return {**result, "artifact_id": pending["artifact_id"]}

    def upload_artifact_bytes(
        self, *, token: str, data: bytes, kind: str = "u"
    ) -> dict[str, Any]:
        response = self._client.put(f"/api/artifacts/{kind}/{token}", content=data)
        return self._response_json(response)

    def post_feed_media(
        self,
        *,
        project_id: str,
        handle: str,
        text: str,
        data: bytes,
        image_path: str | None = None,
        html_path: str | None = None,
        **extra: Any,
    ) -> dict[str, Any]:
        """The production media-post flow: feed.post mints a token -> curl PUT."""
        args: dict[str, Any] = {
            "project_id": project_id,
            "handle": handle,
            "text": text,
            **extra,
        }
        if image_path is not None:
            args["image_path"] = image_path
        if html_path is not None:
            args["html_path"] = html_path
        pending = self.call_tool("feed.post", args)
        result = self.upload_feed_bytes(token=upload_token(pending["run"]), data=data)
        return {**result, "post_id": pending["post_id"]}

    def upload_feed_bytes(self, *, token: str, data: bytes) -> dict[str, Any]:
        response = self._client.put(f"/api/feed/u/{token}", content=data)
        return self._response_json(response)

    @staticmethod
    def _response_json(response: Any) -> dict[str, Any]:
        if response.status_code < 400:
            body = response.json()
            return body if isinstance(body, dict) else {}
        try:
            body = response.json()
        except ValueError:
            body = {"detail": response.text}
        detail = str(body.get("detail") or body.get("message") or response.text)
        details = {
            key: value
            for key, value in body.items()
            if key not in {"detail", "message", "error_code"}
        }
        if response.status_code == 404:
            raise NotFoundError(detail, details=details)
        raise ValidationError(detail, details=details)

    def shutdown(self) -> None:
        with contextlib.suppress(Exception):
            self._client.close()
        with contextlib.suppress(Exception):
            self.server.shutdown()


__all__ = ["DEFAULT_PUBLIC_KEY", "TestBrain", "upload_token"]
