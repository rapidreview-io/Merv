# If you update this file, you must consult feed.md to see whether feed.md needs to be updated. feed.md must not exceed 100 lines.
"""Feed-owned tables and their column upgrades.

This module is deliberately narrow: it declares the rows used by FeedService
and contains no Feed workflow or delivery behavior.
"""

from __future__ import annotations

from ..kernel.state.schema import SchemaModule
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

-- The feed reads newest-first per project, counts a voice's posts, and takes
-- the next created_seq on every insert; none of those may scan the table.
CREATE INDEX IF NOT EXISTS idx_posts_project_seq ON posts(project_id, created_seq);
CREATE INDEX IF NOT EXISTS idx_posts_project_author ON posts(project_id, author_handle);
CREATE INDEX IF NOT EXISTS idx_posts_seq ON posts(created_seq);

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

FEED_SCHEMA = SchemaModule(name="feed", ddl=FEED_DDL)


def install_feed_schema(store: BaseStateStore) -> None:
    """Install Feed's tables."""
    store.install(FEED_SCHEMA)
