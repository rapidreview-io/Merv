"""Feed tests that do not require the full application composition."""

from __future__ import annotations

from contextlib import contextmanager
from email.message import Message
from pathlib import Path
import urllib.error
import unittest.mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from merv.brain.feed import FeedService
from merv.brain.feed import persistence as feed_persistence
from merv.brain.kernel.ports.web_preview import WebPreviewError
from merv.brain.kernel.state.store import StateStore
from merv.brain.kernel.utils import NotFoundError, ValidationError
from merv.brain.object_storage.blobs import LocalDirBlobStore
from merv.brain.research_core import Research
from merv.brain.surface import web_preview
from merv.brain.surface.transport.feed_http import register_feed_routes


_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360000002000100ffff030000060005"
    "57bff8a40000000049454e44ae426082"
)


class _UnavailablePreview:
    def unfurl(self, url: str) -> dict:
        raise WebPreviewError("preview unavailable")

    def fetch_preview_image(self, image_url: str) -> tuple[bytes, str]:
        raise WebPreviewError("preview unavailable")


class _CountingConnection:
    def __init__(self, connection, statements: list[str]) -> None:
        self._connection = connection
        self._statements = statements

    def execute(self, sql, parameters=()):
        self._statements.append(str(sql))
        return self._connection.execute(sql, parameters)

    def __getattr__(self, name):
        return getattr(self._connection, name)


class _CountingStore(StateStore):
    def __init__(self, *, db_path: Path) -> None:
        self.statements: list[str] = []
        super().__init__(db_path=db_path)

    def connect(self):
        return _CountingConnection(super().connect(), self.statements)


class _AlterFailingStore:
    def __init__(self) -> None:
        self.alter_attempts = 0

    @contextmanager
    def transaction(self):
        store = self

        class Connection:
            def execute(self, sql):
                if str(sql).lstrip().startswith("ALTER TABLE"):
                    store.alter_attempts += 1
                    raise RuntimeError("ALTER lost a race")

        yield Connection()


@pytest.fixture()
def feed(tmp_path: Path) -> tuple[FeedService, str, _CountingStore]:
    store = _CountingStore(db_path=tmp_path / "state.sqlite3")
    project = Research(
        store=store, artifacts=unittest.mock.Mock()
    ).create_project(name="Feed tests")
    service = FeedService(
        store=store,
        blobs=LocalDirBlobStore(root=tmp_path / "blobs"),
        web_preview=_UnavailablePreview(),
    )
    project_id = str(project["id"])
    service.register(project_id=project_id, handle="Nova-7")
    store.statements.clear()
    return service, project_id, store


def test_core_owns_posts_replies_reactions_and_batched_history(feed) -> None:
    service, project_id, store = feed
    parent = service.post(
        project_id=project_id,
        handle="Nova-7",
        text="A useful result",
        kind="finding",
    )["post"]
    assert parent["kind"] == "finding"
    assert not any(parent["reactions"].values())

    reacted = service.set_reaction(
        project_id=project_id,
        post_id=parent["id"],
        kind="eyes",
        on=True,
    )
    assert reacted["post"]["reactions"]["eyes"] is True
    assert service.set_reaction(
        project_id=project_id,
        post_id=parent["id"],
        kind="eyes",
        on=True,
    )["post"]["reactions"]["eyes"] is True
    reply = service.researcher_reply(
        project_id=project_id,
        post_id=parent["id"],
        text="What changed?",
    )["post"]

    store.statements.clear()
    result = service.list_posts(project_id=project_id)

    assert [post["id"] for post in result["posts"]] == [reply["id"], parent["id"]]
    assert result["posts"][0]["in_reply_to"] == parent["id"]
    assert result["posts"][0]["author_handle"] == "Researcher"
    assert result["posts"][0]["author_role"] == "researcher"
    assert result["posts"][1]["reactions"]["eyes"] is True
    reaction_reads = [
        sql for sql in store.statements if "FROM post_reactions" in sql
    ]
    assert len(reaction_reads) == 1

    assert service.set_reaction(
        project_id=project_id,
        post_id=parent["id"],
        kind="eyes",
        on=False,
    )["post"]["reactions"]["eyes"] is False
    assert service.set_reaction(
        project_id=project_id,
        post_id=parent["id"],
        kind="eyes",
        on=False,
    )["post"]["reactions"]["eyes"] is False


def test_transition_advisory_disappears_after_referenced_post(feed) -> None:
    service, project_id, _store = feed

    note = service.transition_advisory(
        project_id=project_id,
        experiment_id="exp_123",
        event="experiment_complete",
    )
    assert note and "exp_123 just completed" in note

    service.post(
        project_id=project_id,
        handle="Nova-7",
        text="The experiment landed.",
        ref="exp_123",
    )
    assert service.transition_advisory(
        project_id=project_id,
        experiment_id="exp_123",
        event="experiment_complete",
    ) is None


def test_media_completion_consumes_token_with_post_insert(feed) -> None:
    service, project_id, _store = feed
    pending = service.post(
        project_id=project_id,
        handle="Nova-7",
        text="The curve",
        image_path="figures/curve.png",
    )
    token = pending["run"].rsplit("/", 1)[-1].rstrip("'")
    assert service.list_posts(project_id=project_id)["posts"] == []

    result = service.complete_upload(token=token, data=_PNG)

    assert result["post"]["id"] == pending["post_id"]
    assert result["post"]["has_image"] is True
    assert "image_sha256" not in result["post"]
    assert service.get_image(
        project_id=project_id, post_id=pending["post_id"]
    ) == (_PNG, "image/png")
    with pytest.raises(NotFoundError):
        service.complete_upload(token=token, data=_PNG)


def test_invalid_media_leaves_upload_token_retryable(feed) -> None:
    service, project_id, _store = feed
    pending = service.post(
        project_id=project_id,
        handle="Nova-7",
        text="Retry the curve",
        image_path="curve.txt",
    )
    token = pending["run"].rsplit("/", 1)[-1].rstrip("'")

    with pytest.raises(ValidationError, match="does not look like an image"):
        service.complete_upload(token=token, data=b"not an image")

    assert service.list_posts(project_id=project_id)["posts"] == []
    completed = service.complete_upload(token=token, data=_PNG)
    assert completed["post"]["id"] == pending["post_id"]


def test_token_post_and_event_commit_in_one_transaction(feed) -> None:
    service, project_id, _store = feed
    pending = service.post(
        project_id=project_id,
        handle="Nova-7",
        text="Atomic curve",
        image_path="curve.png",
    )
    token = pending["run"].rsplit("/", 1)[-1].rstrip("'")

    with (
        unittest.mock.patch.object(
            service.store,
            "record_event",
            side_effect=RuntimeError("event write failed"),
        ),
        pytest.raises(RuntimeError, match="event write failed"),
    ):
        service.complete_upload(token=token, data=_PNG)

    assert service.list_posts(project_id=project_id)["posts"] == []
    completed = service.complete_upload(token=token, data=_PNG)
    assert completed["post"]["id"] == pending["post_id"]


def test_non_web_link_is_never_stored_as_clickable(feed) -> None:
    service, project_id, _store = feed

    post = service.post(
        project_id=project_id,
        handle="Nova-7",
        text="Do not click",
        url="javascript:alert(1)",
    )["post"]

    assert post["link_url"] is None
    assert post["link_preview"]["url"] == ""
    assert post["link_preview"]["error"]


def test_safe_fetch_revalidates_redirect_host() -> None:
    headers = Message()
    headers["Location"] = "http://127.0.0.1/private"
    redirect = urllib.error.HTTPError(
        "https://papers.example/start", 302, "Found", headers, None
    )
    opener = unittest.mock.Mock()
    opener.open.side_effect = redirect

    def addresses(host: str, _port):
        address = "93.184.216.34" if host == "papers.example" else "127.0.0.1"
        return [(2, 1, 6, "", (address, 0))]

    with (
        unittest.mock.patch.object(web_preview, "_OPENER", opener),
        unittest.mock.patch.object(
            web_preview.socket, "getaddrinfo", side_effect=addresses
        ),
        pytest.raises(WebPreviewError, match="non-public"),
    ):
        web_preview.safe_fetch("https://papers.example/start")

    assert opener.open.call_count == 1


def test_preview_image_requires_image_mime() -> None:
    with (
        unittest.mock.patch.object(
            web_preview,
            "safe_fetch",
            return_value=("https://example.test/file", "text/html", b"<html>"),
        ),
        pytest.raises(WebPreviewError, match="not an image"),
    ):
        web_preview.fetch_preview_image("https://example.test/file")


def test_http_contract_and_media_headers_are_preserved(feed) -> None:
    service, project_id, _store = feed
    pending = service.post(
        project_id=project_id,
        handle="Nova-7",
        text="The HTTP curve",
        image_path="curve.png",
    )
    token = pending["run"].rsplit("/", 1)[-1].rstrip("'")
    activity = unittest.mock.Mock()
    app = FastAPI()
    register_feed_routes(
        app,
        feed_api=service,
        authorize_project=lambda _request, _project_id: None,
        activity=activity,
    )
    client = TestClient(app)

    completed = client.put(f"/api/feed/u/{token}", content=_PNG)
    assert completed.status_code == 200
    post_id = completed.json()["post"]["id"]
    listing = client.get(f"/api/projects/{project_id}/feed")
    assert listing.status_code == 200
    assert listing.json()["posts"][0]["image_url"].endswith(f"/{post_id}/image")
    image = client.get(f"/api/projects/{project_id}/feed/{post_id}/image")
    assert image.content == _PNG
    assert image.headers["content-type"] == "image/png"
    assert image.headers["x-content-type-options"] == "nosniff"

    paths = set(app.openapi()["paths"])
    assert {
        "/api/feed/u/{token}",
        "/api/projects/{project_id}/feed",
        "/api/projects/{project_id}/feed/{post_id}/reactions",
        "/api/projects/{project_id}/feed/{post_id}/reply",
        "/api/projects/{project_id}/feed/{post_id}/image",
        "/api/projects/{project_id}/feed/{post_id}/link-image",
        "/api/projects/{project_id}/feed/{post_id}/embed",
        "/api/projects/{project_id}/feed/track",
    } <= paths


def test_schema_installer_converges_legacy_posts_idempotently(tmp_path: Path) -> None:
    store = StateStore(db_path=tmp_path / "legacy.sqlite3")
    project_id = Research(
        store=store, artifacts=unittest.mock.Mock()
    ).create_project(name="Legacy Feed")["id"]
    with store.transaction() as connection:
        connection.execute(
            """
            CREATE TABLE posts (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL,
              author_handle TEXT NOT NULL DEFAULT '',
              author_role TEXT NOT NULL DEFAULT 'main',
              text TEXT NOT NULL DEFAULT '',
              image_sha256 TEXT NOT NULL DEFAULT '',
              image_content_type TEXT NOT NULL DEFAULT '',
              link_url TEXT NOT NULL DEFAULT '',
              link_preview_json TEXT NOT NULL DEFAULT '{}',
              ref TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL,
              created_seq INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        connection.execute(
            """
            INSERT INTO posts (
              id, project_id, author_handle, text, created_at, created_seq
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            ("post_legacy", project_id, "Nova-7", "Still readable", "2020-01-01", 1),
        )

    feed_persistence.install_feed_schema(store)
    feed_persistence.install_feed_schema(store)

    with store.transaction() as connection:
        row = connection.execute(
            "SELECT kind, in_reply_to, embed_sha256, embed_content_type, "
            "attachments_json, quote_of, thread_root, thread_index "
            "FROM posts WHERE id = ?",
            ("post_legacy",),
        ).fetchone()
    assert row is not None
    assert tuple(row) == ("", "", "", "", "[]", "", "", 0)


def test_schema_installer_suppresses_only_a_converged_alter_race() -> None:
    won_elsewhere = _AlterFailingStore()
    # First probe misses, the ALTER "loses the race", the re-probe finds the
    # column; every later legacy column probes as present.
    later = len(feed_persistence._LEGACY_COLUMNS) - 1
    with unittest.mock.patch.object(
        feed_persistence,
        "_column_exists",
        side_effect=[False, True, *([True] * later)],
    ):
        feed_persistence.install_feed_schema(won_elsewhere)
    assert won_elsewhere.alter_attempts == 1

    still_missing = _AlterFailingStore()
    with (
        unittest.mock.patch.object(
            feed_persistence,
            "_column_exists",
            side_effect=[False, False],
        ),
        pytest.raises(RuntimeError, match="lost a race"),
    ):
        feed_persistence.install_feed_schema(still_missing)
