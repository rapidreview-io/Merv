"""Install every component's schema on one store, the way composition does.

Tests that boot a bare store and then read tables owned by components they
never construct need the same installation surface `Surface.__init__` walks:
kernel arrives with the store, every other module through `install`.
"""

from __future__ import annotations

from pathlib import Path

from merv.brain.agent_sessions.persistence import AGENT_SESSION_SCHEMA
from merv.brain.artifacts.persistence import ARTIFACT_SCHEMA
from merv.brain.feed.persistence import FEED_SCHEMA
from merv.brain.infrastructure.persistence import INFRASTRUCTURE_SCHEMA
from merv.brain.kernel.state.persistence import KERNEL_SCHEMA
from merv.brain.kernel.state.schema import MIGRATION_ORDER
from merv.brain.kernel.state.store import BaseStateStore, StateStore
from merv.brain.research_core.persistence import RESEARCH_SCHEMA
from merv.brain.surface.agent_identity import AGENT_IDENTITY_SCHEMA
from merv.brain.surface.oauth_store import OAUTH_SCHEMA
from merv.brain.surface.project_keys import PROJECT_KEY_SCHEMA
from merv.brain.surface.user_settings import USER_SETTINGS_SCHEMA
from merv.brain.workflows.persistence import WORKFLOW_SCHEMA

# Install order is the foreign-key order Postgres validates at CREATE:
# credentials before the rows that reference them, content before the links.
ALL_SCHEMAS = (
    PROJECT_KEY_SCHEMA,
    OAUTH_SCHEMA,
    USER_SETTINGS_SCHEMA,
    AGENT_IDENTITY_SCHEMA,
    ARTIFACT_SCHEMA,
    RESEARCH_SCHEMA,
    WORKFLOW_SCHEMA,
    FEED_SCHEMA,
    AGENT_SESSION_SCHEMA,
    INFRASTRUCTURE_SCHEMA,
)

# The whole ladder, in the order a store applies it, as (version, name).
LADDER = tuple(
    sorted(
        (
            (migration.version, migration.name)
            for schema in (KERNEL_SCHEMA, *ALL_SCHEMAS)
            for migration in schema.migrations
        )
    )
)

# Every component's DDL concatenated in install order — what the one kernel
# SCHEMA constant used to be, for tests that build a legacy schema from it.
ALL_DDL = "\n".join(
    schema.ddl for schema in (KERNEL_SCHEMA, *ALL_SCHEMAS)
)


def ladder_through(version: int) -> tuple[int, ...]:
    """MIGRATION_ORDER truncated after ``version``, for replay tests."""
    return tuple(item for item in MIGRATION_ORDER if item <= version)


def install_all_schemas(store: BaseStateStore) -> BaseStateStore:
    """Install the schema of every component, kernel first."""
    for schema in ALL_SCHEMAS:
        store.install(schema)
    return store


def booted_store(db_path: Path) -> StateStore:
    """A SQLite store with every component installed — composition's schema."""
    store = StateStore(db_path=db_path)
    install_all_schemas(store)
    return store
