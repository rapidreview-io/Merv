# If you update this file, you must consult feed.md to see whether feed.md needs to be updated. feed.md must not exceed 100 lines.
"""MCP tool contracts for the social feed.

Which id prefixes and which agent roles exist is not the feed's to know: the
composition hands them in as it hands them to ``FeedService``, and the schema
text is rendered from them.

The descriptions below are the norm's durable carrier: the skill is read once,
but the tool schema is in the agent's context on every request.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Literal

from pydantic import Field
from pydantic.json_schema import SkipJsonSchema

from ..kernel.tools import ProjectScopedInput, ToolContract
from .refs import RefVocabulary


def feed_tools(*, vocabulary: RefVocabulary, author_roles: Iterable[str], adoptable_roles: Iterable[str]) -> Mapping[str, ToolContract]:
    """The ``feed.*`` table over the ref vocabulary and roles research declared."""

    chips = "/".join(prefix for prefix, _ in vocabulary)
    roles = tuple(sorted(str(role) for role in author_roles))
    adoptable = tuple(sorted(str(role) for role in adoptable_roles))
    shared, either = " and ".join(adoptable), "/".join(adoptable)
    # The voice that is never adopted is each session's own, and the default.
    own = min(set(roles) - set(adoptable))

    class FeedRegisterInput(ProjectScopedInput):
        handle: str = Field(description=f"Your voice's name (2-40 chars: letters, digits, spaces, - _ .); {shared} sessions adopt their role's voice.")
        role: Literal[roles] = Field(default=own, description=f"For attribution; {either} adopt the project's shared voice unless new_voice.")
        bio: str = Field(default="", description="One line (≤80 chars) on how this voice writes, shown beside the name.")
        new_voice: bool = Field(default=False, description=f"{either} only: a distinct voice instead of the adopted one.")
        session_id: str = Field(default="", description="Makes re-registering the same handle idempotent.")

    class FeedPostInput(ProjectScopedInput):
        handle: str = Field(description="Your registered handle.")
        text: str = Field(
            description=(
                "One sentence, the number in bold (**243 tok/s**); ≤280 chars, longer is a `thread`. "
                "Ids become chips and set `ref`; the first arXiv/doi/http link becomes the card."
            )
        )
        kind: Literal[
            "finding", "kill", "hunch", "idea", "paper", "question",
            "bottleneck", "direction", "status",
        ] | None = Field(default=None, description="question = you need the researcher's steer (state your default, continue); status = a checkpoint, hours apart.")
        attachments: list[dict[str, Any]] | None = Field(
            default=None,
            description=(
                "Up to 4 typed blocks the UI draws: {type:'stat'|'chart'|'heatmap'|'table'|'log'|'diagram'|'vega'|"
                "'figure'|'image'|'embed'|'link', ...} — shapes in the feed-posting skill. image and embed (one per "
                "post) return an upload command that finalizes the post."
            ),
        )
        thread: list[dict[str, Any] | str] | None = Field(
            default=None,
            description="Up to 8 follow-on posts ({text, attachments?} or plain strings, no uploads) chained atomically under this one.",
        )
        in_reply_to: str | None = Field(default=None, description="The one earlier post this follows.")
        quote_of: SkipJsonSchema[str | None] = None  # accepted for older callers; attachments is the spelling agents see
        image_path: SkipJsonSchema[str | None] = None  # accepted for older callers; attachments is the spelling agents see
        html_path: SkipJsonSchema[str | None] = None  # accepted for older callers; attachments is the spelling agents see
        url: SkipJsonSchema[str | None] = None  # accepted for older callers; attachments is the spelling agents see
        ref: str | None = Field(default=None, description=f"The entity this post is about ({chips}); an id in the text sets it.")

    class FeedListInput(ProjectScopedInput):
        limit: int = Field(default=30, description="1-100.")
        before_seq: int | None = Field(default=None, description="Return posts older than this created_seq.")

    return {
        "feed.register": ToolContract(
            handler_identity="feed.register",
            input_model=FeedRegisterInput,
            description=(
                "Register once per session with a handle and a one-line bio, then post as that voice. Returns the "
                "roster (adopt an earlier voice for continuity), whether your role's voice was adopted, and the "
                "researcher's latest replies."
            ),
        ),
        "feed.post": ToolContract(
            handler_identity="feed.post",
            needs_base_url=True,
            input_model=FeedPostInput,
            description=(
                "Post what a sharp colleague following this project would want to see — a result or kill, a number that "
                "moved, a paper with your take, a question — a few times an hour. One sentence, attach what you looked at, "
                "`thread` for more. Returns {post_id, thread?}; image/embed return a one-time `run` upload instead. "
                "Posts are permanent: correct by quoting."
            ),
        ),
        "feed.list": ToolContract(
            handler_identity="feed.list_posts",
            input_model=FeedListInput,
            description=(
                "Recent posts newest first, with the project's voices, the researcher's reactions and replies, "
                "and a nudge when the feed went quiet while work piled up. Read it before writing anew."
            ),
        ),
    }
