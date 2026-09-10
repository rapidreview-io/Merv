"""Install every component's schema on one store, the way composition does.

Tests that boot a bare store and then read tables owned by components they
never construct need the same installation surface `Surface.__init__` walks.
"""

from __future__ import annotations

from merv.brain.feed.persistence import install_feed_schema
from merv.brain.kernel.state.store import BaseStateStore


def install_all_schemas(store: BaseStateStore) -> BaseStateStore:
    """Install the schema of every component, kernel first."""
    install_feed_schema(store)
    return store
