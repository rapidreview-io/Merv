# If you update this file, you must consult feed.md to see whether feed.md needs to be updated. feed.md must not exceed 100 lines.
"""Feed-owned tables and their column upgrades.

This module is deliberately narrow: it declares the rows used by FeedService
and contains no Feed workflow or delivery behavior.
"""

from __future__ import annotations

from ..kernel.state.schema import Connection, Migration, SchemaModule, ensure_columns
from ..kernel.state.store import BaseStateStore


FEED_DDL = """\
CREATE TABLE IF NOT EXISTS posts (
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
  kind TEXT NOT NULL DEFAULT '',
  in_reply_to TEXT NOT NULL DEFAULT '',
  embed_sha256 TEXT NOT NULL DEFAULT '',
  embed_content_type TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_seq INTEGER NOT NULL DEFAULT 0,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  quote_of TEXT NOT NULL DEFAULT '',
  thread_root TEXT NOT NULL DEFAULT '',
  thread_index INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS feed_authors (
  project_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'main',
  session_id TEXT NOT NULL DEFAULT '',
  registered_at TEXT NOT NULL,
  last_posted_at TEXT,
  bio TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project_id, handle),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS post_reactions (
  project_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, post_id, kind),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS feed_upload_tokens (
  token TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  media_kind TEXT NOT NULL,
  media_path TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  ref TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  in_reply_to TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  extra_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
"""

# Columns added after a table first shipped. Keep them last in the CREATE
# statements too: SQLite splices an added column in before the table
# constraints, and a fresh store must hash like a converged one.
_LATER_COLUMNS: tuple[tuple[str, dict[str, str]], ...] = (
    (
        "posts",
        {
            "kind": "TEXT NOT NULL DEFAULT ''",
            "in_reply_to": "TEXT NOT NULL DEFAULT ''",
            "embed_sha256": "TEXT NOT NULL DEFAULT ''",
            "embed_content_type": "TEXT NOT NULL DEFAULT ''",
            "attachments_json": "TEXT NOT NULL DEFAULT '[]'",
            "quote_of": "TEXT NOT NULL DEFAULT ''",
            "thread_root": "TEXT NOT NULL DEFAULT ''",
            "thread_index": "INTEGER NOT NULL DEFAULT 0",
        },
    ),
    ("feed_authors", {"bio": "TEXT NOT NULL DEFAULT ''"}),
    ("feed_upload_tokens", {"extra_json": "TEXT NOT NULL DEFAULT '{}'"}),
)


def _add_feed_upload_tokens(conn: Connection) -> None:
    """Migration 32: historical marker. Feed's own DDL creates the table on
    every boot, which is what carried it to every database before the ledger
    learned that components own their schema."""


def _converge_feed_columns(conn: Connection) -> None:
    """Migration 64: the columns Feed grew after its tables first shipped."""
    for table, columns in _LATER_COLUMNS:
        ensure_columns(conn, table, columns)


FEED_SCHEMA = SchemaModule(
    name="feed",
    ddl=FEED_DDL,
    migrations=(
        Migration(32, "add_feed_upload_tokens", _add_feed_upload_tokens),
        Migration(64, "converge_feed_columns", _converge_feed_columns),
    ),
)


def install_feed_schema(store: BaseStateStore) -> None:
    """Install Feed tables and converge stores created before later columns."""
    store.install(FEED_SCHEMA)
