"""Labelled immutable evidence without a storage-specific role vocabulary."""

from collections.abc import Mapping

from ...kernel.utils import WorkflowError
from ..graph import Change, Reference


def retain_artifacts(snapshot, payload, knowledge):
    """Validate selected content inside the transition transaction, then pin IDs."""
    selected = payload.get("artifacts", {})
    if not isinstance(selected, Mapping):
        raise WorkflowError("artifacts must map semantic labels to immutable content IDs")
    for label, artifact_id in selected.items():
        if not isinstance(label, str) or not label.strip() or not isinstance(artifact_id, str) or not artifact_id:
            raise WorkflowError("each artifact needs a nonempty label and content ID")
        knowledge.read(Reference("artifact", artifact_id, label))
    return Change(data={"artifacts": {**snapshot.data.get("artifacts", {}), **selected}})


def artifact_references(snapshot):
    return tuple(Reference("artifact", artifact_id, label)
                 for label, artifact_id in snapshot.data.get("artifacts", {}).items())
