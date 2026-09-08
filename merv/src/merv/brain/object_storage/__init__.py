# If you update this file, you must consult object_storage.md to see whether object_storage.md needs to be updated. object_storage.md must not exceed 100 lines.
"""Research object metadata; physical storage belongs to merv-sandboxes."""

from .provider import ObjectStat
from .storage import ObjectStorage, ProducedObject

__all__ = ["ObjectStat", "ObjectStorage", "ProducedObject"]
