# If you update this file, you must consult feed.md to see whether feed.md needs to be updated. feed.md must not exceed 100 lines.
"""Feed authors, posts, replies, reactions, history, and advisories.

Posts are editorial, append-only observations rather than events or artifacts.
Schema compatibility, outbound previews, and blob storage remain behind their
focused persistence or infrastructure boundaries.
"""

from __future__ import annotations

from contextlib import closing, suppress
from dataclasses import dataclass, replace
import json
import secrets
import urllib.parse
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from merv.shared.feed_embeds import (
    MAX_FEED_EMBED_BYTES,
    sniff_html_type,
    wrap_embed_html,
)
from merv.shared.feed_images import (
    MAX_FEED_IMAGE_BYTES,
    SERVEABLE_IMAGE_TYPES,
    sniff_image_type,
)

from ..kernel.ports.blob_store import EvidenceBlobStore
from ..kernel.ports.web_preview import WebPreview, WebPreviewError
from ..kernel.state.store import (
    BaseStateStore,
    next_created_seq,
    row_to_dict,
    rows_to_dicts,
)
from ..kernel.utils import (
    NotFoundError,
    ValidationError,
    iso_after,
    new_id,
    now_iso,
    parse_iso,
)
from .attachments import normalize_attachments
from .persistence import install_feed_schema
from .refs import parse_refs

# The product contract is a short post, measured after stripping. Longer
# thoughts are threads (chained posts), never longer posts.
POST_TEXT_MAX = 280
THREAD_MAX = 8
BIO_MAX = 80

AUTHOR_ROLES = frozenset({"main", "reviewer", "lens", "researcher"})
# Roles that share one persistent voice per project: every reviewer session
# posts as the project's reviewer, so the reader can follow one voice.
ADOPTABLE_ROLES = frozenset({"reviewer", "lens"})

# Kinds are self-declared, never inferred. `status` is a live checkpoint;
# `finding` is a landed result.
POST_KINDS = frozenset(
    {
        "finding", "hunch", "bottleneck", "kill", "direction", "status",
        "idea", "paper", "question",
    }
)

# Reactions are binary because a project has one researcher.
REACTION_KINDS = frozenset({"fire", "eyes", "question"})

RESEARCHER_HANDLE = "Researcher"

_KNOWN_REF_PREFIXES = ("exp_", "claim_", "res_", "rver_", "syn_", "rev_", "lit_", "paper_")

# Backup cadence policy. The agent skill remains the primary editorial policy;
# these values only decide whether page one carries a soft reminder.
NUDGE_AFTER_EVENTS = 8
NUDGE_AFTER_HOURS = 6.0

# Matches artifact.submit: enough time to run curl, short-lived if leaked.
FEED_UPLOAD_TOKEN_TTL_SECONDS = 15 * 60
# Direct in-process calls lack the caller-reachable base injected by HTTP.
_LOCAL_API_BASE = "http://127.0.0.1:8787"


# -- Public application boundary and post values ---------------------------

@runtime_checkable
class FigureLookup(Protocol):
    """Whether a figure submitted with an artifact exists in a project.

    Injected by the surface so the feed can reference artifact figures without
    reading artifact tables itself."""

    def __call__(self, project_id: str, artifact_id: str, link_path: str) -> bool: ...


@runtime_checkable
class FeedAdvisory(Protocol):
    """The narrow post-commit, best-effort capability Application consumes."""

    def transition_advisory(
        self, *, project_id: str, experiment_id: str, event: str
    ) -> str | None: ...


@dataclass(frozen=True, slots=True)
class PostIntent:
    """One post request; resolving it fills the project and author role.

    ``attachments`` holds the validated native attachments (stat/chart/table/
    log). ``thread`` holds continuation posts (each ``{"text", "attachments",
    "url", "ref"}``) chained under this one. ``chain_root`` is set when a
    self-reply continues the author's own earlier post."""

    handle: str
    text: str
    project_id: str | None
    author_role: str = ""
    url: str = ""
    ref: str = ""
    kind: str = ""
    in_reply_to: str = ""
    quote_of: str = ""
    attachments: tuple[dict[str, Any], ...] = ()
    thread: tuple[dict[str, Any], ...] = ()
    chain_root: str = ""


@dataclass(frozen=True, slots=True)
class MediaInput:
    kind: str
    path: str
    data: bytes


# -- Feed operations --------------------------------------------------------

def _shell_quote(value: str) -> str:
    """POSIX single-quote — the agent runs the returned command verbatim."""
    return "'" + value.replace("'", "'\\''") + "'"


def feed_upload_command(*, base_url: str, path: str, token: str) -> str:
    base = (base_url or _LOCAL_API_BASE).rstrip("/")
    return f"curl -sf -T {_shell_quote(path)} '{base}/api/feed/u/{token}'"


def _validate_handle(handle: str) -> str:
    handle = (handle or "").strip()
    if not handle:
        raise ValidationError("handle is required")
    if len(handle) < 2 or len(handle) > 40:
        raise ValidationError("handle must be 2-40 characters")
    allowed = set(" -_.")
    if not all(ch.isalnum() or ch in allowed for ch in handle):
        raise ValidationError("handle may use letters, digits, spaces, and - _ . only")
    return handle


class FeedService:
    def __init__(
        self,
        *,
        store: BaseStateStore,
        blobs: EvidenceBlobStore,
        web_preview: WebPreview,
        figure_lookup: FigureLookup | None = None,
    ) -> None:
        self.store = store
        self.blobs = blobs
        self.web_preview = web_preview
        self.figure_lookup = figure_lookup
        install_feed_schema(store)

    # -- identity -----------------------------------------------------------

    def register(
        self,
        *,
        handle: str,
        role: str = "main",
        session_id: str = "",
        project_id: str | None = None,
        bio: str = "",
        new_voice: bool = False,
    ) -> dict[str, Any]:
        """Claim a voice for this project (idempotent per session).

        A handle is unique per project so parallel agents post under distinct
        voices. Re-registering the same handle from the same session is a no-op;
        a different session claiming a live handle is rejected so two agents do
        not collide on one name. Reviewer and lens sessions adopt the project's
        existing voice for that role (``adopted``) unless ``new_voice`` is set,
        so the reader follows one reviewer instead of a new name per review.
        The response carries the project's roster so an agent can pick up an
        earlier voice deliberately.
        """
        handle = _validate_handle(handle)
        if role not in AUTHOR_ROLES:
            raise ValidationError(
                f"unknown author role: {role}. Allowed: {', '.join(sorted(AUTHOR_ROLES))}"
            )
        bio = (bio or "").strip()
        if len(bio) > BIO_MAX:
            raise ValidationError(f"bio must be {BIO_MAX} characters or fewer")
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            adopted = False
            if role in ADOPTABLE_ROLES and not new_voice:
                voice = conn.execute(
                    "SELECT handle FROM feed_authors WHERE project_id = ? AND role = ? "
                    "ORDER BY COALESCE(last_posted_at, registered_at) DESC LIMIT 1",
                    (project_id, role),
                ).fetchone()
                if voice is not None and str(voice["handle"]) != handle:
                    handle = str(voice["handle"])
                    adopted = True
            existing = conn.execute(
                "SELECT * FROM feed_authors WHERE project_id = ? AND handle = ?",
                (project_id, handle),
            ).fetchone()
            if existing is not None:
                if (
                    not adopted
                    and existing["session_id"]
                    and session_id
                    and existing["session_id"] != session_id
                ):
                    raise ValidationError(
                        f"handle '{handle}' is already in use in this project; "
                        "choose another sci-fi name"
                    )
                conn.execute(
                    "UPDATE feed_authors SET role = ?, session_id = ?, bio = ? "
                    "WHERE project_id = ? AND handle = ?",
                    (
                        role,
                        session_id or existing["session_id"],
                        bio or (existing["bio"] or ""),
                        project_id,
                        handle,
                    ),
                )
                created = False
            else:
                conn.execute(
                    """
                    INSERT INTO feed_authors (project_id, handle, role, session_id, bio, registered_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (project_id, handle, role, session_id, bio, now_iso()),
                )
                self.store.record_event(
                    conn=conn,
                    project_id=project_id,
                    event_type="feed.author_registered",
                    target_type="feed_author",
                    target_id=handle,
                    payload={"handle": handle, "role": role},
                )
                created = True
            row = conn.execute(
                "SELECT * FROM feed_authors WHERE project_id = ? AND handle = ?",
                (project_id, handle),
            ).fetchone()
            author = row_to_dict(row=row) or {}
            author.pop("session_id", None)
            result: dict[str, Any] = {
                "author": author,
                "created": created,
                "adopted": adopted,
                "roster": self._roster(conn=conn, project_id=project_id),
            }
            replies = self._recent_researcher_replies(conn=conn, project_id=project_id)
            if replies:
                result["researcher_replies"] = replies
            if adopted:
                result["note"] = (
                    f"This project's {role} voice is '{handle}'; post as that handle "
                    "so the reader follows one voice. Pass new_voice=true to create "
                    "a distinct one on purpose."
                )
            return result

    def _roster(self, *, conn: Any, project_id: str) -> list[dict[str, Any]]:
        """Every voice in the project with its bio and post count."""
        rows = conn.execute(
            """
            SELECT a.handle, a.role, a.bio, a.last_posted_at,
                   (SELECT COUNT(*) FROM posts p
                    WHERE p.project_id = a.project_id AND p.author_handle = a.handle) AS posts
            FROM feed_authors a
            WHERE a.project_id = ?
            ORDER BY COALESCE(a.last_posted_at, a.registered_at) DESC
            LIMIT 20
            """,
            (project_id,),
        ).fetchall()
        return [
            {
                "handle": str(row["handle"]),
                "role": str(row["role"] or "main"),
                "bio": str(row["bio"] or ""),
                "posts": int(row["posts"] or 0),
                "last_posted_at": row["last_posted_at"],
            }
            for row in rows
        ]

    def _recent_researcher_replies(
        self, *, conn: Any, project_id: str, limit: int = 5
    ) -> list[dict[str, Any]]:
        """The researcher's latest replies — steering an agent should not miss."""
        rows = conn.execute(
            "SELECT id, in_reply_to, text, created_at FROM posts "
            "WHERE project_id = ? AND author_role = 'researcher' "
            "ORDER BY created_seq DESC LIMIT ?",
            (project_id, limit),
        ).fetchall()
        return [
            {
                "post_id": str(row["id"]),
                "in_reply_to": str(row["in_reply_to"] or ""),
                "text": str(row["text"] or ""),
                "created_at": row["created_at"],
            }
            for row in rows
        ]

    # -- writing ------------------------------------------------------------

    def post(
        self,
        *,
        handle: str,
        text: str,
        image_path: str | None = None,
        html_path: str | None = None,
        url: str | None = None,
        ref: str | None = None,
        kind: str | None = None,
        in_reply_to: str | None = None,
        quote_of: str | None = None,
        attachments: list[dict[str, Any]] | None = None,
        thread: list[dict[str, Any]] | None = None,
        project_id: str | None = None,
        base_url: str = "",
    ) -> dict[str, Any]:
        """Write a post. ``handle`` must already be registered in this project.

        Entity ids and links in ``text`` are parsed: the first entity id becomes
        ``ref`` and the first link becomes the unfurled link when those fields
        are not given explicitly. ``attachments`` are validated typed blocks;
        ``thread`` chains continuation posts under this one, atomically.

        A post without an upload lands immediately (shape ``{"post": …}``,
        plus ``"thread"`` when continuations were created). A post carrying an
        image or embed instead mints a one-time upload token and returns
        ``{"post_id", "run"}``: the agent runs the ``run`` curl to PUT the local
        file's bytes to ``/api/feed/u/<token>``, which finalizes the post (and
        its thread) — the bytes travel over the agent's own curl, never through
        MCP (the artifact.submit discipline)."""
        if image_path and html_path:
            raise ValidationError("a post may carry an image or an embed, not both")
        normalized = normalize_attachments(
            attachments,
            image_path=str(image_path or ""),
            html_path=str(html_path or ""),
            url=str(url or ""),
        )
        intent = self._resolve_intent(
            PostIntent(
                handle=handle,
                text=text,
                project_id=project_id,
                url=normalized.link_url,
                ref=str(ref or ""),
                kind=str(kind or ""),
                in_reply_to=str(in_reply_to or ""),
                quote_of=str(quote_of or ""),
                attachments=normalized.native,
                thread=self._validate_thread(thread),
            )
        )
        if normalized.media_kind:
            return self._begin_upload(
                intent=intent,
                media_kind=normalized.media_kind,
                media_path=normalized.media_path,
                base_url=base_url,
            )
        return self._create_post(intent=intent)

    def _validate_thread(self, thread: Any) -> tuple[dict[str, Any], ...]:
        """Continuation posts: text plus native attachments and at most one link.
        Uploads are not allowed inside a thread; post them as the root, or reply
        to your own post afterwards."""
        if thread is None:
            return ()
        if not isinstance(thread, list):
            raise ValidationError("thread must be a list of {text, attachments?} objects")
        if len(thread) > THREAD_MAX:
            raise ValidationError(f"a thread continues for at most {THREAD_MAX} more posts")
        items: list[dict[str, Any]] = []
        for index, item in enumerate(thread):
            if isinstance(item, str):
                item = {"text": item}
            if not isinstance(item, dict):
                raise ValidationError(f"thread[{index}] must be an object with text")
            text = self._validate_text(str(item.get("text") or ""))
            normalized = normalize_attachments(item.get("attachments"), url=str(item.get("url") or ""))
            if normalized.media_kind:
                raise ValidationError(
                    "thread posts cannot carry an image or embed upload; put the visual "
                    "on the root post, or reply to your own post afterwards"
                )
            refs = parse_refs(text)
            items.append(
                {
                    "text": text,
                    "attachments": list(normalized.native),
                    "url": normalized.link_url or (refs.links[0] if refs.links else ""),
                    "ref": refs.entities[0] if refs.entities else "",
                }
            )
        return tuple(items)

    def _resolve_intent(self, intent: PostIntent) -> PostIntent:
        handle, text, ref, kind = self._validate_post_fields(
            handle=intent.handle,
            text=intent.text,
            ref=intent.ref,
            kind=intent.kind,
        )
        refs = parse_refs(text)
        if not ref and refs.entities:
            ref = refs.entities[0]
        url = intent.url or (refs.links[0] if refs.links else "")
        with self.store.transaction() as conn:
            resolved_project = self.store.require_project_id(
                conn=conn, project_id=intent.project_id
            )
            author = conn.execute(
                "SELECT role FROM feed_authors WHERE project_id = ? AND handle = ?",
                (resolved_project, handle),
            ).fetchone()
            if author is None:
                raise ValidationError(
                    f"handle '{handle}' is not registered; call feed.register first"
                )
            author_role = str(author["role"] or "main")
            reply_to, chain_root = self._validate_in_reply_to(
                conn=conn,
                project_id=resolved_project,
                in_reply_to=intent.in_reply_to,
                handle=handle,
                author_role=author_role,
            )
            quote_of = self._validate_quote_of(
                conn=conn, project_id=resolved_project, quote_of=intent.quote_of
            )
        self._validate_figures(project_id=resolved_project, intent=intent)
        return replace(
            intent,
            handle=handle,
            author_role=author_role,
            text=text,
            url=url,
            ref=ref,
            kind=kind,
            in_reply_to=reply_to,
            quote_of=quote_of,
            chain_root=chain_root,
            project_id=resolved_project,
        )

    def _begin_upload(
        self,
        *,
        intent: PostIntent,
        media_kind: str,
        media_path: str,
        base_url: str,
    ) -> dict[str, Any]:
        self._sweep_expired_tokens()
        post_id = new_id(prefix="post")
        token = secrets.token_urlsafe(24)
        extra = {
            "attachments": list(intent.attachments),
            "thread": list(intent.thread),
            "quote_of": intent.quote_of,
        }
        with self.store.transaction() as conn:
            conn.execute(
                """
                INSERT INTO feed_upload_tokens (
                    token, project_id, post_id, handle, text, media_kind,
                    media_path, url, ref, kind, in_reply_to, extra_json,
                    expires_at, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    token,
                    intent.project_id,
                    post_id,
                    intent.handle,
                    intent.text,
                    media_kind,
                    media_path,
                    intent.url,
                    intent.ref,
                    intent.kind,
                    intent.in_reply_to,
                    json.dumps(extra, sort_keys=True),
                    iso_after(seconds=FEED_UPLOAD_TOKEN_TTL_SECONDS),
                    now_iso(),
                ),
            )
        return {
            "post_id": post_id,
            "run": feed_upload_command(base_url=base_url, path=media_path, token=token),
        }

    def get_upload_limit(self, *, token: str) -> int:
        """Return the pending upload's cap before the transport buffers bytes."""
        row = self._pending_upload(token=token, columns="media_kind")
        return (
            MAX_FEED_IMAGE_BYTES
            if str(row["media_kind"]) == "image"
            else MAX_FEED_EMBED_BYTES
        )

    def complete_upload(self, *, token: str, data: bytes) -> dict[str, Any]:
        """Validate uploaded bytes, then atomically consume the token and post."""
        row = self._pending_upload(token=token)
        media_kind = str(row["media_kind"] or "")
        try:
            extra = json.loads(row["extra_json"] or "{}")
        except (TypeError, ValueError):
            extra = {}
        if not isinstance(extra, dict):
            extra = {}
        intent = self._resolve_intent(
            PostIntent(
                project_id=str(row["project_id"]),
                handle=str(row["handle"]),
                text=str(row["text"]),
                url=str(row["url"] or ""),
                ref=str(row["ref"] or ""),
                kind=str(row["kind"] or ""),
                in_reply_to=str(row["in_reply_to"] or ""),
                quote_of=str(extra.get("quote_of") or ""),
                attachments=tuple(extra.get("attachments") or ()),
                thread=tuple(extra.get("thread") or ()),
            )
        )
        media = MediaInput(
            kind=media_kind,
            path=str(row["media_path"] or ""),
            data=data,
        )
        return self._create_post(
            intent=intent,
            media=media,
            post_id=str(row["post_id"]),
            consume_token=token,
        )

    def _pending_upload(self, *, token: str, columns: str = "*") -> Any:
        self._sweep_expired_tokens()
        with closing(self.store.connect()) as conn:
            row = conn.execute(
                f"SELECT {columns} FROM feed_upload_tokens "
                "WHERE token = ? AND expires_at >= ?",
                (token, now_iso()),
            ).fetchone()
        if row is None:
            raise NotFoundError(
                "unknown, used, or expired feed upload token — call feed.post again"
            )
        return row

    def _sweep_expired_tokens(self) -> None:
        """Own transaction so the sweep survives a failing access path."""
        with self.store.transaction() as conn:
            conn.execute(
                "DELETE FROM feed_upload_tokens WHERE expires_at < ?", (now_iso(),)
            )

    def _create_post(
        self,
        *,
        intent: PostIntent,
        media: MediaInput | None = None,
        post_id: str | None = None,
        consume_token: str | None = None,
    ) -> dict[str, Any]:
        image_sha256, image_content_type = "", ""
        embed_sha256, embed_content_type = "", ""
        if media is not None:
            if media.kind == "image":
                image_sha256, image_content_type = self._capture_image_bytes(
                    project_id=intent.project_id,
                    image_path=media.path or "feed-image",
                    data=media.data,
                )
            elif media.kind == "embed":
                embed_sha256, embed_content_type = self._capture_embed_bytes(
                    project_id=intent.project_id,
                    html_path=media.path or "feed-embed",
                    data=media.data,
                )
            else:
                raise ValidationError(f"unknown feed media kind: {media.kind}")
        link_url = ""
        link_preview: dict[str, Any] = {}
        if intent.url:
            link_url, link_preview = self._build_link_preview(
                project_id=intent.project_id, url=intent.url
            )
        # Unfurl continuation links before the transaction, like the root's.
        thread_links: list[tuple[str, dict[str, Any]]] = []
        for item in intent.thread:
            if item.get("url"):
                thread_links.append(
                    self._build_link_preview(project_id=intent.project_id, url=str(item["url"]))
                )
            else:
                thread_links.append(("", {}))
        with self.store.transaction() as conn:
            # Claim the token in the post/event transaction so concurrent or
            # replayed PUTs cannot insert the pre-minted post twice.
            if consume_token is not None:
                claimed = conn.execute(
                    "SELECT 1 FROM feed_upload_tokens "
                    "WHERE token = ? AND expires_at >= ?",
                    (consume_token, now_iso()),
                ).fetchone()
                if claimed is None:
                    raise NotFoundError(
                        "unknown, used, or expired feed upload token — "
                        "call feed.post again"
                    )
                conn.execute(
                    "DELETE FROM feed_upload_tokens WHERE token = ?", (consume_token,)
                )
            post_id = post_id or new_id(prefix="post")
            created_at = now_iso()
            # A self-reply continues the author's own chain; a fresh thread
            # root has no chain of its own until a continuation lands.
            thread_root, thread_index = "", 0
            if intent.chain_root:
                thread_root = intent.chain_root
                thread_index = self._next_thread_index(
                    conn=conn, project_id=intent.project_id, root=thread_root
                )
            self._insert_post_row(
                conn=conn,
                post_id=post_id,
                intent=intent,
                text=intent.text,
                ref=intent.ref,
                kind=intent.kind,
                in_reply_to=intent.in_reply_to,
                quote_of=intent.quote_of,
                attachments=list(intent.attachments),
                image=(image_sha256, image_content_type),
                embed=(embed_sha256, embed_content_type),
                link=(link_url, link_preview),
                thread_root=thread_root,
                thread_index=thread_index,
                created_at=created_at,
            )
            thread_ids: list[str] = []
            for index, item in enumerate(intent.thread):
                child_id = new_id(prefix="post")
                self._insert_post_row(
                    conn=conn,
                    post_id=child_id,
                    intent=intent,
                    text=str(item["text"]),
                    ref=str(item.get("ref") or ""),
                    kind="",
                    in_reply_to=post_id,
                    quote_of="",
                    attachments=list(item.get("attachments") or []),
                    image=("", ""),
                    embed=("", ""),
                    link=thread_links[index],
                    thread_root=thread_root or post_id,
                    thread_index=(thread_index if thread_root else 0) + index + 1,
                    created_at=created_at,
                )
                thread_ids.append(child_id)
            conn.execute(
                "UPDATE feed_authors SET last_posted_at = ? WHERE project_id = ? AND handle = ?",
                (created_at, intent.project_id, intent.handle),
            )
            root = row_to_dict(
                row=conn.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()
            ) or {}
            result: dict[str, Any] = {
                "post": self._post_view(root, reaction_kinds=set())
            }
            if thread_ids:
                placeholders = ", ".join("?" for _ in thread_ids)
                rows = conn.execute(
                    f"SELECT * FROM posts WHERE id IN ({placeholders}) ORDER BY thread_index",
                    thread_ids,
                ).fetchall()
                result["thread"] = [
                    self._post_view(item, reaction_kinds=set())
                    for item in rows_to_dicts(rows=rows)
                ]
            return result

    def _insert_post_row(
        self,
        *,
        conn: Any,
        post_id: str,
        intent: PostIntent,
        text: str,
        ref: str,
        kind: str,
        in_reply_to: str,
        quote_of: str,
        attachments: list[dict[str, Any]],
        image: tuple[str, str],
        embed: tuple[str, str],
        link: tuple[str, dict[str, Any]],
        thread_root: str,
        thread_index: int,
        created_at: str,
    ) -> None:
        seq = next_created_seq(conn=conn, table="posts")
        conn.execute(
            """
            INSERT INTO posts (
                id, project_id, author_handle, author_role, text,
                image_sha256, image_content_type, link_url, link_preview_json,
                ref, kind, in_reply_to, embed_sha256, embed_content_type,
                attachments_json, quote_of, thread_root, thread_index,
                created_at, created_seq
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                post_id,
                intent.project_id,
                intent.handle,
                intent.author_role,
                text,
                image[0],
                image[1],
                link[0],
                json.dumps(link[1], sort_keys=True),
                ref,
                kind,
                in_reply_to,
                embed[0],
                embed[1],
                json.dumps(attachments, sort_keys=True),
                quote_of,
                thread_root,
                int(thread_index),
                created_at,
                seq,
            ),
        )
        self.store.record_event(
            conn=conn,
            project_id=intent.project_id,
            event_type="feed.post_created",
            target_type="post",
            target_id=post_id,
            payload={
                "handle": intent.handle,
                "has_image": bool(image[0]),
                "has_embed": bool(embed[0]),
                "has_link": bool(link[0]),
                "attachments": [str(a.get("type")) for a in attachments],
                "ref": ref,
                "thread_root": thread_root,
            },
        )

    def _next_thread_index(self, *, conn: Any, project_id: str, root: str) -> int:
        row = conn.execute(
            "SELECT COALESCE(MAX(thread_index), 0) AS n FROM posts "
            "WHERE project_id = ? AND (thread_root = ? OR id = ?)",
            (project_id, root, root),
        ).fetchone()
        return int(row["n"] or 0) + 1

    def researcher_reply(
        self, *, post_id: str, text: str, project_id: str | None = None
    ) -> dict[str, Any]:
        """Post a researcher reply threaded under ``post_id``.

        Auto-registers the fixed "Researcher" handle idempotently — the human
        does not go through feed.register.
        """
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            existing = conn.execute(
                "SELECT 1 FROM feed_authors WHERE project_id = ? AND handle = ?",
                (project_id, RESEARCHER_HANDLE),
            ).fetchone()
            if existing is None:
                conn.execute(
                    """
                    INSERT INTO feed_authors (project_id, handle, role, session_id, registered_at)
                    VALUES (?, ?, 'researcher', '', ?)
                    """,
                    (project_id, RESEARCHER_HANDLE, now_iso()),
                )
        intent = self._resolve_intent(
            PostIntent(
                handle=RESEARCHER_HANDLE,
                text=text,
                project_id=project_id,
                in_reply_to=post_id,
            )
        )
        return self._create_post(intent=intent)

    def _validate_in_reply_to(
        self,
        *,
        conn: Any,
        project_id: str,
        in_reply_to: str | None,
        handle: str = "",
        author_role: str = "",
    ) -> tuple[str, str]:
        """Return ``(in_reply_to, chain_root)``. A reply to your own post is a
        thread continuation: ``chain_root`` names the thread's root so the UI
        stacks it under one connector instead of nesting it as a reply."""
        in_reply_to = (in_reply_to or "").strip()
        if not in_reply_to:
            return "", ""
        target = conn.execute(
            "SELECT id, author_handle, thread_root FROM posts WHERE id = ? AND project_id = ?",
            (in_reply_to, project_id),
        ).fetchone()
        if target is None:
            raise ValidationError(f"in_reply_to post not found: {in_reply_to}")
        chain_root = ""
        if (
            handle
            and author_role != "researcher"
            and str(target["author_handle"]) == handle
        ):
            chain_root = str(target["thread_root"] or target["id"])
        return in_reply_to, chain_root

    def _validate_figures(self, *, project_id: str, intent: PostIntent) -> None:
        """A ``figure`` attachment must name a figure already submitted with an
        artifact in this project; the lookup is the surface's, not the feed's."""
        groups = [intent.attachments, *(tuple(item.get("attachments") or ()) for item in intent.thread)]
        for group in groups:
            for attachment in group:
                if not isinstance(attachment, dict) or attachment.get("type") != "figure":
                    continue
                if self.figure_lookup is None:
                    raise ValidationError("figure attachments are not available on this brain")
                artifact_id = str(attachment.get("artifact_id") or "")
                path = str(attachment.get("path") or "")
                if not self.figure_lookup(project_id, artifact_id, path):
                    raise ValidationError(
                        f"figure not found in this project: {artifact_id} {path} — "
                        "use artifact.find to list submitted figures"
                    )

    def _validate_quote_of(
        self, *, conn: Any, project_id: str, quote_of: str | None
    ) -> str:
        quote_of = (quote_of or "").strip()
        if not quote_of:
            return ""
        target = conn.execute(
            "SELECT 1 FROM posts WHERE id = ? AND project_id = ?",
            (quote_of, project_id),
        ).fetchone()
        if target is None:
            raise ValidationError(f"quote_of post not found: {quote_of}")
        return quote_of

    def _validate_text(self, text: str) -> str:
        text = (text or "").strip()
        if not text:
            raise ValidationError("post text is required")
        if len(text) > POST_TEXT_MAX:
            raise ValidationError(
                f"post text is {len(text)} chars; keep each post under {POST_TEXT_MAX} "
                "— continue in a thread instead of writing a longer post"
            )
        return text

    def _validate_post_fields(
        self, *, handle: str, text: str, ref: str | None, kind: str | None = None
    ) -> tuple[str, str, str, str]:
        handle = _validate_handle(handle)
        text = self._validate_text(text)
        ref = (ref or "").strip()
        if ref and not ref.startswith(_KNOWN_REF_PREFIXES):
            raise ValidationError(
                "ref must point at a project entity "
                f"({', '.join(p.rstrip('_') for p in _KNOWN_REF_PREFIXES)})"
            )
        kind = (kind or "").strip().lower()
        if kind and kind not in POST_KINDS:
            raise ValidationError(
                f"unknown post kind: {kind}. Allowed: {', '.join(sorted(POST_KINDS))} (or omit it)"
            )
        return handle, text, ref, kind

    def _capture_image_bytes(
        self, *, project_id: str, image_path: str, data: bytes
    ) -> tuple[str, str]:
        if len(data) > MAX_FEED_IMAGE_BYTES:
            raise ValidationError(
                f"image is {len(data)} bytes; keep feed images under "
                f"{MAX_FEED_IMAGE_BYTES}"
            )
        candidate = Path(image_path or "feed-image")
        content_type = sniff_image_type(candidate, data)
        if content_type is None:
            raise ValidationError(
                f"{image_path} does not look like an image (png/jpeg/gif/webp/svg)"
            )
        sha = self.blobs.put(namespace=project_id, data=data)
        return sha, content_type

    def _capture_embed_bytes(
        self, *, project_id: str, html_path: str, data: bytes
    ) -> tuple[str, str]:
        if len(data) > MAX_FEED_EMBED_BYTES:
            raise ValidationError(
                f"embed is {len(data)} bytes; keep feed embeds under "
                f"{MAX_FEED_EMBED_BYTES}"
            )
        content_type = sniff_html_type(data)
        if content_type is None:
            raise ValidationError(f"{html_path} does not look like an HTML document")
        sha = self.blobs.put(namespace=project_id, data=data)
        return sha, content_type

    def _build_link_preview(
        self, *, project_id: str, url: str
    ) -> tuple[str, dict[str, Any]]:
        """Unfurl ``url`` into a static preview; degrade to a plain link on failure.

        Per the PRD edge case, a bad or disallowed link never fails the post — it
        becomes a plain, non-embedded chip (``preview.error`` set). Exception:
        a non-web scheme (javascript:/data:/file:…) is attacker-shaped, not
        degradable — the post survives, but nothing clickable is stored.
        """
        url = url.strip()
        if urllib.parse.urlparse(url).scheme.lower() not in ("http", "https"):
            return "", {"url": "", "error": "only http and https links can be embedded"}
        try:
            card = self.web_preview.unfurl(url)
        except WebPreviewError as exc:
            return url, {"url": url, "error": str(exc)}
        preview: dict[str, Any] = {
            "url": card["url"],
            "title": card.get("title", ""),
            "description": card.get("description", ""),
            "trusted": bool(card.get("trusted")),
            "kind": card.get("kind") or "page",
            "authors": card.get("authors") or [],
            "year": card.get("year") or "",
        }
        image_url = card.get("image_url") or ""
        if image_url:
            with suppress(WebPreviewError):
                img_bytes, ctype = self.web_preview.fetch_preview_image(image_url)
                normalized = (ctype or "").split(";", 1)[0].strip().lower()
                # Re-hosting external SVG same-origin would permit stored XSS.
                if normalized in SERVEABLE_IMAGE_TYPES:
                    preview["image_sha256"] = self.blobs.put(
                        namespace=project_id, data=img_bytes
                    )
                    preview["image_content_type"] = normalized
        return url, preview

    # -- reading ------------------------------------------------------------

    def list_posts(
        self,
        *,
        project_id: str | None = None,
        limit: int = 30,
        before_seq: int | None = None,
    ) -> dict[str, Any]:
        """Reverse-chronological posts, cursor-paginated by ``created_seq``."""
        limit = max(1, min(int(limit), 100))
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            params: list[Any] = [project_id]
            where = "project_id = ?"
            if before_seq is not None:
                where += " AND created_seq < ?"
                params.append(int(before_seq))
            params.append(limit + 1)
            rows = conn.execute(
                f"SELECT * FROM posts WHERE {where} ORDER BY created_seq DESC LIMIT ?",
                params,
            ).fetchall()
            items = rows_to_dicts(rows=rows)
            has_more = len(items) > limit
            items = items[:limit]
            next_cursor = items[-1]["created_seq"] if (has_more and items) else None
            reactions = self._reaction_kinds_for_posts(
                conn=conn,
                project_id=project_id,
                post_ids=[str(item["id"]) for item in items],
            )
            bios = self._author_bios(conn=conn, project_id=project_id)
            quoted = self._quoted_views(
                conn=conn,
                project_id=project_id,
                post_ids=[str(item["quote_of"]) for item in items if item.get("quote_of")],
            )
            views = [
                self._post_view(
                    item,
                    reaction_kinds=reactions.get(str(item["id"]), set()),
                    bios=bios,
                    quoted=quoted,
                )
                for item in items
            ]
            result: dict[str, Any] = {
                "posts": views,
                "next_cursor": next_cursor,
            }
            # Keep cadence signaling on Feed's first page so Research does not
            # acquire a Feed dependency.
            if before_seq is None:
                result["voices"] = self._roster(conn=conn, project_id=project_id)
                nudge = self._posting_nudge(project_id=project_id, conn=conn)
                if nudge is not None:
                    result["nudge"] = nudge
                attention = [
                    {
                        "post_id": view["id"],
                        "reactions": [
                            kind for kind, on in view["reactions"].items() if on
                        ],
                        "text_snippet": (view["text"] or "")[:80],
                    }
                    for view in views
                    if any(view["reactions"].values())
                ][:5]
                if attention:
                    result["researcher_attention"] = attention
            return result

    def get_embed(self, *, project_id: str, post_id: str) -> str:
        """Return the CSP-wrapped HTML document for a post's embed."""
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            row = conn.execute(
                "SELECT embed_sha256 FROM posts WHERE id = ? AND project_id = ?",
                (post_id, project_id),
            ).fetchone()
        if row is None or not row["embed_sha256"]:
            raise NotFoundError(f"no embed for post: {post_id}")
        data = self.blobs.get(namespace=project_id, sha256=str(row["embed_sha256"]))
        return wrap_embed_html(data)

    def get_image(self, *, project_id: str, post_id: str) -> tuple[bytes, str]:
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            row = conn.execute(
                "SELECT image_sha256, image_content_type FROM posts WHERE id = ? AND project_id = ?",
                (post_id, project_id),
            ).fetchone()
        if row is None or not row["image_sha256"]:
            raise NotFoundError(f"no image for post: {post_id}")
        data = self.blobs.get(namespace=project_id, sha256=str(row["image_sha256"]))
        return data, str(row["image_content_type"] or "application/octet-stream")

    def get_link_image(self, *, project_id: str, post_id: str) -> tuple[bytes, str]:
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            row = conn.execute(
                "SELECT link_preview_json FROM posts WHERE id = ? AND project_id = ?",
                (post_id, project_id),
            ).fetchone()
        sha = ""
        ctype = ""
        if row is not None:
            try:
                preview = json.loads(row["link_preview_json"] or "{}")
                sha = str(preview.get("image_sha256") or "")
                ctype = str(preview.get("image_content_type") or "")
            except (TypeError, ValueError):
                sha = ""
        if not sha:
            raise NotFoundError(f"no link image for post: {post_id}")
        # Serve the real sniffed content type captured at unfurl time. Older rows
        # predate the stored type; fall back to a safe non-renderable default
        # rather than the invalid `image/*` media range.
        return (
            self.blobs.get(namespace=project_id, sha256=sha),
            ctype or "application/octet-stream",
        )

    def set_reaction(
        self, *, post_id: str, kind: str, on: bool, project_id: str | None = None
    ) -> dict[str, Any]:
        """Idempotently set/clear a researcher reaction, returning the post view."""
        kind = (kind or "").strip().lower()
        if kind not in REACTION_KINDS:
            raise ValidationError(
                f"unknown reaction kind: {kind}. Allowed: {', '.join(sorted(REACTION_KINDS))}"
            )
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            row = conn.execute(
                "SELECT * FROM posts WHERE id = ? AND project_id = ?",
                (post_id, project_id),
            ).fetchone()
            if row is None:
                raise NotFoundError(f"post not found: {post_id}")
            if on:
                conn.execute(
                    """
                    INSERT INTO post_reactions (project_id, post_id, kind, created_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(project_id, post_id, kind) DO NOTHING
                    """,
                    (project_id, post_id, kind, now_iso()),
                )
            else:
                conn.execute(
                    "DELETE FROM post_reactions WHERE project_id = ? AND post_id = ? AND kind = ?",
                    (project_id, post_id, kind),
                )
            row = conn.execute(
                "SELECT * FROM posts WHERE id = ? AND project_id = ?",
                (post_id, project_id),
            ).fetchone()
            reaction_kinds = self._reaction_kinds_for_posts(
                conn=conn, project_id=project_id, post_ids=[post_id]
            ).get(post_id, set())
            return {
                "post": self._post_view(
                    row_to_dict(row=row) or {}, reaction_kinds=reaction_kinds
                )
            }

    def _author_bios(self, *, conn: Any, project_id: str) -> dict[str, str]:
        rows = conn.execute(
            "SELECT handle, bio FROM feed_authors WHERE project_id = ?", (project_id,)
        ).fetchall()
        return {str(row["handle"]): str(row["bio"] or "") for row in rows}

    def _quoted_views(
        self, *, conn: Any, project_id: str, post_ids: list[str]
    ) -> dict[str, dict[str, Any]]:
        """Compact views of quoted posts, one query for the page."""
        ids = sorted({pid for pid in post_ids if pid})
        if not ids:
            return {}
        placeholders = ", ".join("?" for _ in ids)
        rows = conn.execute(
            f"SELECT * FROM posts WHERE project_id = ? AND id IN ({placeholders})",
            [project_id, *ids],
        ).fetchall()
        out: dict[str, dict[str, Any]] = {}
        for item in rows_to_dicts(rows=rows):
            attachments = _load_attachments(item)
            stat = next((a for a in attachments if a.get("type") == "stat"), None)
            out[str(item["id"])] = {
                "id": item.get("id"),
                "author_handle": item.get("author_handle"),
                "author_role": item.get("author_role"),
                "text": item.get("text"),
                "kind": item.get("kind") or None,
                "has_image": bool(item.get("image_sha256")),
                "stat": stat,
                "created_at": item.get("created_at"),
            }
        return out

    def _post_view(
        self,
        item: dict[str, Any],
        *,
        reaction_kinds: set[str],
        bios: dict[str, str] | None = None,
        quoted: dict[str, dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        preview_raw = item.get("link_preview_json") or "{}"
        try:
            link_preview = json.loads(preview_raw)
        except (TypeError, ValueError):
            link_preview = {}
        clean_preview: dict[str, Any] | None = None
        if link_preview:
            # Blob hashes stay internal; newer fields default for legacy rows.
            clean_preview = {
                "url": link_preview.get("url"),
                "title": link_preview.get("title") or "",
                "description": link_preview.get("description") or "",
                "trusted": bool(link_preview.get("trusted")),
                "has_image": bool(link_preview.get("image_sha256")),
                "error": link_preview.get("error"),
                "kind": link_preview.get("kind") or "page",
                "authors": link_preview.get("authors") or [],
                "year": link_preview.get("year") or "",
            }
        handle = str(item.get("author_handle") or "")
        quote_of = str(item.get("quote_of") or "")
        return {
            "id": item.get("id"),
            "author_handle": item.get("author_handle"),
            "author_role": item.get("author_role"),
            "author_bio": (bios or {}).get(handle, ""),
            "text": item.get("text"),
            "ref": item.get("ref") or None,
            "kind": item.get("kind") or None,
            "in_reply_to": item.get("in_reply_to") or None,
            "quote_of": quote_of or None,
            "quoted": (quoted or {}).get(quote_of) if quote_of else None,
            "thread_root": item.get("thread_root") or None,
            "thread_index": int(item.get("thread_index") or 0),
            "attachments": _load_attachments(item),
            "has_image": bool(item.get("image_sha256")),
            "has_embed": bool(item.get("embed_sha256")),
            "link_url": item.get("link_url") or None,
            "link_preview": clean_preview,
            "reactions": {
                kind: kind in reaction_kinds for kind in sorted(REACTION_KINDS)
            },
            "created_at": item.get("created_at"),
            "created_seq": item.get("created_seq"),
        }

    def _reaction_kinds_for_posts(
        self, *, conn: Any, project_id: str, post_ids: list[str]
    ) -> dict[str, set[str]]:
        """Load all reactions for one page in a single query."""
        if not post_ids:
            return {}
        placeholders = ", ".join("?" for _ in post_ids)
        rows = conn.execute(
            "SELECT post_id, kind FROM post_reactions "
            f"WHERE project_id = ? AND post_id IN ({placeholders})",
            [project_id, *post_ids],
        ).fetchall()
        result: dict[str, set[str]] = {post_id: set() for post_id in post_ids}
        for row in rows:
            result.setdefault(str(row["post_id"]), set()).add(str(row["kind"]))
        return result

    # -- posting nudge (backup cadence signal) ------------------------------

    def _cadence_signal(self, *, project_id: str, conn: Any) -> dict[str, Any]:
        """Raw cadence numbers: events and hours since the last AGENT post.

        A researcher reply is not agent activity — it must not reset the
        cold-feed clock, or a human commenting on an old post would silence
        the nudge without the agent having posted anything new.
        """
        last = conn.execute(
            "SELECT created_at FROM posts WHERE project_id = ? AND author_role <> 'researcher' "
            "ORDER BY created_seq DESC LIMIT 1",
            (project_id,),
        ).fetchone()
        last_post_at = last["created_at"] if last is not None else None
        # Feed events must not create their own posting nudges.
        if last_post_at:
            events_since = conn.execute(
                "SELECT COUNT(*) AS n FROM events "
                "WHERE project_id = ? AND created_at > ? AND substr(type, 1, 5) <> 'feed.'",
                (project_id, last_post_at),
            ).fetchone()["n"]
        else:
            events_since = conn.execute(
                "SELECT COUNT(*) AS n FROM events "
                "WHERE project_id = ? AND substr(type, 1, 5) <> 'feed.'",
                (project_id,),
            ).fetchone()["n"]
        hours_since = _hours_since(last_post_at)
        return {
            "last_post_at": last_post_at,
            "events_since_last_post": int(events_since),
            "hours_since_last_post": hours_since,
            "ever_posted": last_post_at is not None,
        }

    def _posting_nudge(self, *, project_id: str, conn: Any) -> dict[str, Any] | None:
        """A soft 'consider posting' hint, or None when nothing needs saying.

        Backup only: fires when the agent feed has been silent for an extended
        stretch (both event-count AND elapsed-time thresholds crossed). The
        listing call has no caller identity, so clients decide whether the hint
        applies to their role. Never blocks — the feed is ungated by design.
        """
        signal = self._cadence_signal(project_id=project_id, conn=conn)
        events = signal["events_since_last_post"]
        hours = signal["hours_since_last_post"]
        if events < NUDGE_AFTER_EVENTS:
            return None
        if hours is not None and hours < NUDGE_AFTER_HOURS:
            return None
        if signal["ever_posted"]:
            reason = (
                f"{events} things have happened and roughly "
                f"{int(hours)}h have passed since your last feed post"
                if hours is not None
                else f"{events} things have happened since your last feed post"
            )
        else:
            reason = f"{events} things have happened and there are no feed posts yet"
        return {
            "should_post": True,
            "hint": (
                f"Consider posting to the feed — {reason}. Share one high-signal "
                "aha-moment if there is something worth surfacing (brief; a visual "
                "helps). Skip it if nothing rises to that bar."
            ),
            **signal,
        }

    # -- event-carried advisory ---------------------------------------------

    def transition_advisory(
        self, *, project_id: str, experiment_id: str, event: str
    ) -> str | None:
        """Return an optional Feed nudge for a committed experiment transition.

        Application attaches this only after committing its transition and
        treats failures as advisory. A matching ``ref`` or text mention is the
        deduplication state; no separate "already nudged" record is written.
        Missing identifiers return None.
        """
        project_id = (project_id or "").strip()
        experiment_id = (experiment_id or "").strip()
        if not project_id or not experiment_id:
            return None
        with closing(self.store.connect()) as conn:
            mentioned = conn.execute(
                "SELECT 1 FROM posts WHERE project_id = ? "
                "AND (ref = ? OR text LIKE ? ESCAPE '\\') LIMIT 1",
                (
                    project_id,
                    experiment_id,
                    f"%{_escape_like(experiment_id)}%",
                ),
            ).fetchone()
        if mentioned is not None:
            return None
        phrase = _FEED_NOTE_PHRASES.get(
            event, "{entity} just had a workflow update"
        ).format(entity=experiment_id)
        return (
            f"{phrase} and the feed has never mentioned it — if there's a "
            "takeaway worth sharing, consider a post (see the feed-posting skill)."
        )


_FEED_NOTE_PHRASES: dict[str, str] = {
    "experiment_complete": "{entity} just completed",
    "experiment_failed": "{entity} just failed",
    "experiment_abandoned": "{entity} was just abandoned",
    "experiment_review_verdict": "a review verdict just landed on {entity}",
    "mlflow_run_finalized": "an MLflow run for {entity} just finished",
}


def _load_attachments(item: dict[str, Any]) -> list[dict[str, Any]]:
    """Native attachments stored on a row; malformed JSON reads as none."""
    try:
        loaded = json.loads(item.get("attachments_json") or "[]")
    except (TypeError, ValueError):
        return []
    return [a for a in loaded if isinstance(a, dict)] if isinstance(loaded, list) else []


def _escape_like(value: str) -> str:
    """Escape SQL LIKE metacharacters so ``value`` is matched literally.

    Entity ids commonly contain ``_`` (``exp_``, `claim_``, ...), itself a
    LIKE single-char wildcard — left unescaped it would make the substring
    search too permissive. ``LIKE ... ESCAPE '\\'`` is portable across both
    the SQLite and Postgres dialects (unlike SQLite-only ``instr``).
    """
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _hours_since(iso_ts: str | None) -> float | None:
    parsed = parse_iso(iso_ts)
    if parsed is None:
        return None
    from datetime import UTC, datetime

    delta = datetime.now(UTC) - parsed
    return max(0.0, delta.total_seconds() / 3600.0)
