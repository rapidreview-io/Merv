"""Feed tests that do not require the full application composition."""

from __future__ import annotations

from merv.brain.programs import INSTALLED, PROGRAM
from merv.brain.workflows import Workflows
from merv.brain.agent_sessions import WorkspaceAdvances

from email.message import Message
from pathlib import Path
import urllib.error
import unittest.mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
import unittest
from tempfile import TemporaryDirectory

from merv.brain.feed import FeedService
from merv.brain.kernel.ports.web_preview import WebPreviewError
from merv.brain.kernel.state.store import StateStore
from merv.brain.kernel.utils import NotFoundError, ValidationError
from tests.support.blobs import LocalDirBlobStore
from merv.brain.research_core import Research
from merv.brain.surface import web_preview
from merv.brain.surface.transport.feed_http import register_feed_routes


# The feed learns which ids exist from its composition; these tests declare a
# vocabulary of their own so nothing below depends on research's prefixes.
_VOCABULARY = (("exp_", "experiment"), ("gizmo_", "gizmo"))
_ROLES = frozenset({"main", "auditor"})
_ADOPTABLE = frozenset({"auditor"})

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


class FeedIsolatedTests(unittest.TestCase):
    def setUp(self):
        self.tmp_path = Path(self.enterContext(TemporaryDirectory()))
        store = _CountingStore(db_path=self.tmp_path / "state.sqlite3")
        project = Research(
            store=store, advances=WorkspaceAdvances(store=store),
            artifacts=unittest.mock.Mock(), workflows=Workflows(store=store, programs=INSTALLED), program=PROGRAM,
        ).create_project(name="Feed tests")
        service = FeedService(
            store=store,
            blobs=LocalDirBlobStore(root=self.tmp_path / "blobs"),
            web_preview=_UnavailablePreview(),
            ref_vocabulary=_VOCABULARY,
            author_roles=_ROLES,
            adoptable_roles=_ADOPTABLE,
        )
        project_id = str(project["id"])
        service.register(project_id=project_id, handle="Nova-7", role="main")
        store.statements.clear()
        self.feed = service, project_id, store

    def test_core_owns_posts_replies_reactions_and_batched_history(self):
        service, project_id, store = self.feed
        parent = service.post(
            project_id=project_id,
            handle="Nova-7",
            text="A useful result",
            kind="finding",
        )
        parent = service.list_posts(project_id=project_id)["posts"][0]
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

    def test_refs_follow_the_injected_vocabulary(self):
        service, project_id, _store = self.feed

        parsed = service.post(
            project_id=project_id,
            handle="Nova-7",
            text="gizmo_0badf00d beat exp_c0ffee12 by a hair",
        )
        parsed = service.list_posts(project_id=project_id)["posts"][0]
        assert parsed["ref"] == "gizmo_0badf00d"

        explicit = service.post(
            project_id=project_id,
            handle="Nova-7",
            text="on the record",
            ref="gizmo_000000",
        )
        explicit = service.list_posts(project_id=project_id)["posts"][0]
        assert explicit["ref"] == "gizmo_000000"

        with self.assertRaisesRegex(ValidationError, "gizmo gizmo_"):
            service.post(
                project_id=project_id,
                handle="Nova-7",
                text="not a project entity",
                ref="claim_54962efed0a3",
            )

    def test_ref_vocabulary_must_be_declared(self):
        tmp_path = self.tmp_path
        from merv.brain.feed.refs import RefParser

        with self.assertRaisesRegex(ValueError, "at least one"):
            RefParser(())
        with self.assertRaisesRegex(ValueError, "prefix and a kind"):
            RefParser((("", "nameless"),))

    def test_roles_follow_the_injected_sets(self):
        service, project_id, _store = self.feed

        with self.assertRaisesRegex(ValidationError, "unknown author role: reviewer"):
            service.register(project_id=project_id, handle="Cold Equations", role="reviewer")
        with self.assertRaisesRegex(ValidationError, "unknown author role: researcher"):
            service.register(project_id=project_id, handle="Impostor", role="researcher")

        first = service.register(
            project_id=project_id, handle="Cold Equations", role="auditor", session_id="s1"
        )
        assert first["created"] and not first["adopted"]
        second = service.register(
            project_id=project_id, handle="Second Opinion", role="auditor", session_id="s2"
        )
        assert second["adopted"] and second["author"]["handle"] == "Cold Equations"
        assert "auditor voice is 'Cold Equations'" in second["note"]
        # A non-adoptable role never shares a live handle across sessions.
        service.register(project_id=project_id, handle="Kestrel-9", role="main", session_id="m1")
        with self.assertRaisesRegex(ValidationError, "already in use"):
            service.register(project_id=project_id, handle="Kestrel-9", role="main", session_id="m2")

    def test_role_sets_are_validated_at_construction(self):
        tmp_path = self.tmp_path
        def build(**roles):
            return FeedService(
                store=StateStore(db_path=tmp_path / "roles.sqlite3"),
                blobs=LocalDirBlobStore(root=tmp_path / "blobs"),
                web_preview=_UnavailablePreview(),
                ref_vocabulary=_VOCABULARY,
                **roles,
            )

        with self.assertRaisesRegex(ValueError, "subset of the author roles"):
            build(author_roles={"main"}, adoptable_roles={"auditor"})
        with self.assertRaisesRegex(ValueError, "feed's own voice"):
            build(author_roles={"main", "researcher"}, adoptable_roles=())

    def test_advisory_disappears_after_referenced_post(self):
        service, project_id, _store = self.feed

        note = service.advisory(
            project_id=project_id, ref="exp_123", message="exp_123 just completed"
        )
        assert note and "exp_123 just completed" in note

        service.post(
            project_id=project_id,
            handle="Nova-7",
            text="The run landed.",
            ref="exp_123",
        )
        assert service.advisory(
            project_id=project_id, ref="exp_123", message="exp_123 just completed"
        ) is None

    def test_media_completion_consumes_token_with_post_insert(self):
        service, project_id, _store = self.feed
        pending = service.post(
            project_id=project_id,
            handle="Nova-7",
            text="The curve",
            image_path="figures/curve.png",
        )
        token = pending["run"].rsplit("/", 1)[-1].rstrip("'")
        assert service.list_posts(project_id=project_id)["posts"] == []

        result = service.complete_upload(token=token, data=_PNG)

        assert result == {"post_id": pending["post_id"]}
        posted = service.list_posts(project_id=project_id)["posts"][0]
        assert posted["has_image"] is True
        assert "image_sha256" not in posted
        assert service.get_image(
            project_id=project_id, post_id=pending["post_id"]
        ) == (_PNG, "image/png")
        with self.assertRaises(NotFoundError):
            service.complete_upload(token=token, data=_PNG)

    def test_invalid_media_leaves_upload_token_retryable(self):
        service, project_id, _store = self.feed
        pending = service.post(
            project_id=project_id,
            handle="Nova-7",
            text="Retry the curve",
            image_path="curve.txt",
        )
        token = pending["run"].rsplit("/", 1)[-1].rstrip("'")

        with self.assertRaisesRegex(ValidationError, "does not look like an image"):
            service.complete_upload(token=token, data=b"not an image")

        assert service.list_posts(project_id=project_id)["posts"] == []
        completed = service.complete_upload(token=token, data=_PNG)
        assert completed["post_id"] == pending["post_id"]

    def test_token_post_and_event_commit_in_one_transaction(self):
        service, project_id, _store = self.feed
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
            self.assertRaisesRegex(RuntimeError, "event write failed"),
        ):
            service.complete_upload(token=token, data=_PNG)

        assert service.list_posts(project_id=project_id)["posts"] == []
        completed = service.complete_upload(token=token, data=_PNG)
        assert completed["post_id"] == pending["post_id"]

    def test_non_web_link_is_never_stored_as_clickable(self):
        service, project_id, _store = self.feed

        post = service.post(
            project_id=project_id,
            handle="Nova-7",
            text="Do not click",
            url="javascript:alert(1)",
        )
        post = service.list_posts(project_id=project_id)["posts"][0]

        assert "link_url" not in post
        assert post["link_preview"]["url"] == ""
        assert post["link_preview"]["error"]

    def test_safe_fetch_revalidates_redirect_host(self):
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
            self.assertRaisesRegex(WebPreviewError, "non-public"),
        ):
            web_preview.safe_fetch("https://papers.example/start")

        assert opener.open.call_count == 1

    def test_preview_image_requires_image_mime(self):
        with (
            unittest.mock.patch.object(
                web_preview,
                "safe_fetch",
                return_value=("https://example.test/file", "text/html", b"<html>"),
            ),
            self.assertRaisesRegex(WebPreviewError, "not an image"),
        ):
            web_preview.fetch_preview_image("https://example.test/file")

    def test_http_contract_and_media_headers_are_preserved(self):
        service, project_id, _store = self.feed
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
        post_id = completed.json()["post_id"]
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
