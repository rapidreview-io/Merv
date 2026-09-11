# Feed module

## Responsibility and boundary

`FeedService` owns the project-scoped social stream: voices (author
registration with bios), short posts and threads, typed attachments, quotes,
replies, reactions, media/link presentation, pagination, and non-blocking
posting advisories. Posts are observations for humans, not research state; the
feed never names research entities. Which id prefixes and author roles exist
is declared at composition. `FeedAdvisory` is the narrow post-commit capability
Application consumes. `__init__.py` exports only `FeedService` and that protocol.

The service depends inward on `BaseStateStore` for project resolution,
transactions, sequence allocation, and event recording. It delegates bytes to
`EvidenceBlobStore`, outbound URL inspection to `WebPreview`, image/HTML
validation and embed wrapping to shared feed helpers, reference parsing to
`refs.py`, attachment validation to `attachments.py`, and exposes stored data
only through normalized views. `tools.py` renders the `feed.*` MCP contracts over
the same injected prefixes and roles. HTTP/MCP routing, authentication, UI
behavior, workflow policy, and blob implementation stay outside this package.

## Post model

A post is `text` (≤280 chars) plus an optional `kind`, up to four typed attachments,
an optional `quote_of`, and threading. Native attachments (`stat`, `chart`
line/bars/scatter, `heatmap`, `table`, `log`, `diagram` as Mermaid text, `vega` as
an inline-data Vega-Lite spec with no `url`/`href`) are validated JSON documents the
UI draws; `figure` references a figure already submitted with an artifact, checked
through the injected `FigureLookup` port; `image`/`embed` name one local file
uploaded through a one-time token; `link` names one URL to unfurl. `refs.RefParser`
pulls structure out of the prose: the first entity id becomes `ref` and the first
arXiv id, DOI, or URL becomes the unfurled link when those were not passed
explicitly. Which id prefixes count is the composition's `RefVocabulary` of
`(prefix, kind)` pairs; the feed matches prefixes and stores refs opaquely. A
`thread` is up to eight continuation posts created atomically under the root, and a
reply to one's own post continues the author's chain (`thread_root`,
`thread_index`); a reply by another voice stays a reply. Kinds are self-declared:
`finding kill hunch idea paper question bottleneck direction status`.

## Write flow

1. `register` validates a handle, role, and bio, resolves the project, and upserts
   the `(project_id, handle)` voice. Author roles and their adoptable subset are
   constructor arguments: an adoptable role takes the project's existing voice
   unless `new_voice` is set; a live handle in any other role
   cannot be taken by another session. The response carries the roster, `adopted`,
   and the researcher's latest replies; new voices emit `feed.author_registered`.
2. `post` normalizes attachments (legacy `image_path`/`html_path`/`url` are
   shorthands), validates thread items, and resolves a `PostIntent`: the
   author must be registered in that project, `kind` and entity-reference
   prefixes are allowlisted, `in_reply_to`/`quote_of` must exist in the same
   project, and refs are parsed from the text.
3. Posts without an upload call `_create_post` immediately. A post carrying an
   image or embed instead persists a 15-minute one-use upload token (with the
   attachments, thread, and quote in `extra_json`) and returns a shell-quoted
   `curl` command; the transport asks `get_upload_limit` before buffering and
   passes bytes to `complete_upload`.
4. Creation unfurls links first, then in one transaction claims the token,
   inserts the root row and every continuation row (`_insert_post_row`,
   advancing `created_seq` and emitting `feed.post_created` per row), and
   updates the author's last-post time. Concurrent or replayed uploads cannot
   create the preallocated post twice. A token past `expires_at` is refused on
   the spot, and `prune` deletes it on the brain's retention clock.
5. Link unfurling is best-effort: ordinary preview failures preserve a plain
   HTTP(S) link plus error metadata; non-web schemes store no clickable URL.
   Preview images are rehosted only for serveable sniffed types, excluding SVG.

`researcher_reply` idempotently creates the fixed `Researcher` identity and
uses the normal validated post path (never chained). `set_reaction`
idempotently toggles one of `fire`, `eyes`, or `question`; one reaction of
each kind per project/post because a project has one researcher.

## Read and advisory flow

`list_posts` reads one project in reverse `created_seq` order, clamps page size
to 1–100, fetches one extra row to derive the exclusive `before_seq` cursor,
loads page reactions, author bios, and quoted-post summaries in one query
each, and strips internal blob hashes from post/link views. Views carry
`attachments`, `quote_of`/`quoted`, `thread_root`/`thread_index`, and
`author_bio`. Only page one includes the project `voices` roster,
researcher-attention summaries, and a soft cadence nudge. Media readers
re-check project ownership before loading blobs; embeds are returned
CSP-wrapped, while images retain their sniffed media type.

Cadence counts non-feed events since the latest non-researcher post. A nudge
appears only after at least eight such events and, when a prior agent post
exists, six hours; it never gates work. `advisory(project_id, ref, message)` is
read-only and best-effort: it returns the caller's own words as a posting hint
only when no post in that project references or literally mentions the ref.

## Persistence and invariants

`persistence.py` declares four tables: immutable `posts`, project-local
`feed_authors`, idempotent `post_reactions`, and pending `feed_upload_tokens`.
It is a `SchemaModule` like every other component's, installed at service
construction. All externally supplied project IDs pass
through `require_project_id`, reply/quote/media/reaction lookups include
project scope, blob access uses the same project namespace, and exposed post
order is the monotonic `created_seq`, not timestamp ordering.
