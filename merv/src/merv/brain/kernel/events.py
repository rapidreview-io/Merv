"""Immutable values for events already committed to the public ledger."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import TypeAlias


JsonScalar: TypeAlias = str | int | float | bool | None
FrozenJsonValue: TypeAlias = (
    JsonScalar | tuple["FrozenJsonValue", ...] | Mapping[str, "FrozenJsonValue"]
)
FrozenJsonObject: TypeAlias = Mapping[str, FrozenJsonValue]


def freeze_json_object(value: Mapping[str, object]) -> FrozenJsonObject:
    """Defensively freeze a JSON object, including every nested container."""

    def freeze(item: object) -> FrozenJsonValue:
        if isinstance(item, Mapping):
            return MappingProxyType({str(key): freeze(child) for key, child in item.items()})
        if isinstance(item, (list, tuple)):
            return tuple(freeze(child) for child in item)
        if item is None or isinstance(item, (str, int, float, bool)):
            return item
        raise TypeError(f"value is not JSON-compatible: {type(item).__name__}")

    return MappingProxyType({str(key): freeze(child) for key, child in value.items()})


@dataclass(frozen=True, slots=True)
class StoredEvent:
    """The exact identity and value of one event inserted in the ledger."""

    id: int
    project_id: str
    type: str
    target_type: str
    target_id: str
    payload: FrozenJsonObject
    created_at: str


__all__ = ["StoredEvent", "freeze_json_object"]
