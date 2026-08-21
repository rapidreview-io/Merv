"""JSON-safe value contracts at service-shaped component boundaries."""

from __future__ import annotations

import dataclasses
import importlib
import json
import math
import re
import sqlite3
import unittest
from collections import Counter
from collections.abc import Mapping
from pathlib import Path
from typing import Any, get_args, get_origin, get_type_hints, is_typeddict

from merv.brain.application.experiments.create import ExperimentCreateArgs
from merv.brain.application.experiments.presentation import SlimExperimentState
from merv.brain.application.tasks import SlimTaskState, TaskTransitionReceipt
from merv.brain.application.experiments.transition import (
    TransitionReceipt,
    TransitionResponse,
)
from merv.brain.object_storage import ProducedObject
from merv.brain.application.mlflow import (
    CreateRunResult,
    FinalizeRunResult,
    MetricsSnapshot,
    TrackingCapabilities,
    TrackingContextPayload,
    TrackingExperimentSnapshot,
    TrackingMetric,
    TrackingRun,
    TrackingSnapshotRun,
)
from merv.brain.kernel.events import StoredEvent, freeze_json_object
from merv.brain.research_core.models import (
    LiteratureSignal,
    ResearchSnapshot,
    CommittedExperimentUpdate,
    CommittedTaskUpdate,
    ExhibitVerdict,
    ExperimentState,
    ExperimentSummary,
    PersistedRunState,
    DependencyNode,
    TaskResult,
    TaskState,
    TaskSummary,
)
from tests.paths import BACKEND_ROOT


APPLICATION_DATACLASS_EXCLUSIONS = frozenset(
    {
        "merv.brain.application.experiments.transition.TransitionExperiment",
        "merv.brain.application.tasks.TaskContextQuery",
        "merv.brain.application.tasks.TransitionTask",
        "merv.brain.application.workflow.StatusAndNextQuery",
    }
)


def _qualified(value: type) -> str:
    return f"{value.__module__}.{value.__qualname__}"


def _boundary_types() -> dict[str, type]:
    """Discover public DTOs in stable entrypoints and their value modules."""
    result: dict[str, type] = {}
    value_modules = {
        "application/events.py",
        "application/experiments/presentation.py",
        "kernel/events.py",
        "object_storage/storage.py",
        "research_core/models.py",
    }
    for path in sorted(BACKEND_ROOT.rglob("*.py")):
        relative = path.relative_to(BACKEND_ROOT).as_posix()
        source = path.read_text(encoding="utf-8")
        is_application_export = (
            relative.startswith("application/") and "__all__" in source
        )
        is_boundary_module = (
            relative.endswith("/facade.py")
            or "/ports/" in relative
            or relative in value_modules
        )
        if not (is_boundary_module or is_application_export):
            continue
        module_name = "merv.brain." + relative.removesuffix(".py").replace("/", ".")
        module = importlib.import_module(module_name)
        for name, value in vars(module).items():
            if (
                name.startswith("_")
                or not isinstance(value, type)
                or value.__module__ != module.__name__
            ):
                continue
            if is_application_export and name not in getattr(module, "__all__", ()):
                continue
            qualified = _qualified(value)
            if (
                is_typeddict(value)
                or dataclasses.is_dataclass(value)
                and (
                    is_boundary_module
                    or qualified not in APPLICATION_DATACLASS_EXCLUSIONS
                )
            ):
                result[qualified] = value
    return result


EVENT = StoredEvent(
    id=7,
    project_id="proj_1",
    type="experiment.transitioned",
    target_type="experiment",
    target_id="exp_1",
    payload=freeze_json_object({"transition": "start_running", "steps": [1, 2]}),
    created_at="2026-07-21T12:00:00Z",
)
RUN: TrackingRun = {
    "run_id": "run_1",
    "run_name": "attempt-1",
    "status": "RUNNING",
    "artifact_uri": "s3://runs/1",
    "created_at": "2026-07-21T12:00:00Z",
    "created_by_plugin": True,
    "error": "",
}

# One non-empty sample per discovered value type. TypedDicts are ordinary dicts
# at runtime; including every declared field makes their nested shapes visible.
SAMPLES: dict[type, object] = {
    TrackingCapabilities: TrackingCapabilities(True, True, True),
    TrackingContextPayload: {
        "configured": True,
        "mode": "control",
        "tracking_uri": "https://tracking.example",
        "dashboard_url": "https://tracking.example/ui",
        "experiment_name": "proj_1.exp_1",
        "env": {"MLFLOW_TRACKING_URI": "https://tracking.example"},
        "note": "configured",
        "project_id": "proj_1",
        "experiment_namespace_prefix": "proj_1",
        "experiments": [{"id": "exp_1", "name": "Example"}],
    },
    TrackingRun: RUN,
    CreateRunResult: {"created": True, **RUN},
    FinalizeRunResult: {"run": RUN},
    TrackingMetric: {"last": 0.9, "step": 3, "min": 0.4, "max": 0.9},
    TrackingSnapshotRun: {
        "run_id": "run_1",
        "run_name": "attempt-1",
        "status": "RUNNING",
        "start_time": 1,
        "end_time": 2,
        "params": {"seed": 7},
        "tags": {"attempt": "1"},
        "metrics": {"accuracy": {"last": 0.9}},
        "metrics_capped_at": 50,
    },
    TrackingExperimentSnapshot: {"name": "proj_1.exp_1", "runs": [RUN]},
    MetricsSnapshot: {
        "available": True,
        "suspended": False,
        "experiments": [{"name": "proj_1.exp_1", "runs": []}],
    },
    ProducedObject: {
        "id": "so_1",
        "name": "models/checkpoint.bin",
        "version": 1,
        "kind": "model",
        "content_sha256": "c" * 64,
        "size_bytes": 12,
        "content_type": "application/octet-stream",
        "status": "available",
        "expires_at": None,
        "producing_run": "run_1",
        "source_uri": "",
        "notes": "retained",
        "created_at": "2026-07-21T12:00:00Z",
        "updated_at": "2026-07-21T12:00:00Z",
        "last_accessed_at": None,
    },
    TransitionResponse: {
        "id": "exp_1",
        "project_id": "proj_1",
        "name": "Example",
        "intent": "Test one claim",
        "details": "Hold the optimizer fixed; budget one GPU-day.",
        "status": "running",
        "attempt_index": 1,
        "mlflow_run": RUN,
        "mlflow": {"configured": True},
        "mlflow_guidance": "Log every run.",
        "mlflow_warning": {"tracking": "unavailable", "error": "down", "repair": "…"},
        "metrics_exhibit": {"pinned": True},
        "feed_note": "Experiment started.",
    },
    TransitionReceipt: {
        "experiment_id": "exp_1",
        "transition": "start_running",
        "from_status": "ready_to_run",
        "to_status": "running",
        "status": "running",
        "attempt_index": 1,
        "event_id": 7,
        "accepted_at": "2026-07-21T12:00:00Z",
        "metrics_exhibit": {"pinned": True},
        "feed_note": "Experiment started.",
        "mlflow": {"configured": True},
        "mlflow_run": RUN,
        "mlflow_guidance": "Log every run.",
        "mlflow_warning": {"tracking": "unavailable", "error": "down", "repair": "…"},
    },
    StoredEvent: EVENT,
    PersistedRunState: {**RUN, "delivery_id": 7},
    ExperimentCreateArgs: {
        "name": "example",
        "intent": "Test one claim",
        "details": "Hold the optimizer fixed; budget one GPU-day.",
        "tested_claim_ids": ["claim_1"],
        "claim_id": None,
        "claim_ids": None,
        "title": "",
        "hypothesis": "",
        "design": "",
        "success_criteria": "",
        "risks": "",
        "status": "planned",
        "depends_on": ["task_1"],
        "project_id": "proj_1",
    },
    ExperimentState: {
        "id": "exp_1",
        "project_id": "proj_1",
        "name": "Example",
        "intent": "Test one claim",
        "details": "Hold the optimizer fixed; budget one GPU-day.",
        "status": "running",
        "attempt_index": 1,
        "mlflow_run": RUN,
    },
    ExperimentSummary: {
        "id": "exp_1",
        "project_id": "proj_1",
        "name": "Example",
        "intent": "Test one claim",
        "status": "running",
        "attempt_index": 1,
        "created_at": "2026-07-21T12:00:00Z",
        "updated_at": "2026-07-21T12:00:00Z",
    },
    SlimExperimentState: {
        "id": "exp_1",
        "project_id": "proj_1",
        "name": "Example",
        "intent": "Test one claim",
        "details": "Hold the optimizer fixed; budget one GPU-day.",
        "status": "running",
        "attempt_index": 1,
        "mlflow_run": RUN,
    },
    ExhibitVerdict: {
        "runs_found": 1,
        "result_files": 1,
        "attempt_index": 1,
        "mlflow": {"configured": True},
        "pinned": True,
    },
    CommittedExperimentUpdate: CommittedExperimentUpdate(
        state={"id": "exp_1", "status": "running"}, event=EVENT
    ),
    TaskResult: {
        "number": 1,
        "state": "met",
        "evidence": "out/train.parquet with 41 200 rows",
        "how": "ls out/",
        "text": "[x] out/train.parquet with 41 200 rows — how to check: ls out/",
    },
    DependencyNode: {
        "id": "exp_1",
        "node_type": "experiment",
        "name": "distill",
        "status": "ready_to_run",
        "settled": False,
        "failed": False,
    },
    TaskState: {
        "id": "task_1",
        "project_id": "proj_1",
        "name": "prep-data",
        "goal": "Prepare the dataset",
        "status": "in_progress",
        "attempt_index": 1,
        "outcome": "",
        "failed_by": "",
        "deliverables": ["clean, deduplicated splits exist under out/"],
        "checks": ["clean, deduplicated splits exist under out/"],
        "results": [
            {
                "number": 1,
                "state": "met",
                "evidence": "out/train.parquet with 41 200 rows",
                "how": "ls out/",
                "text": "[x] out/train.parquet with 41 200 rows — how to check: ls out/",
            }
        ],
        "report": "Generated the splits with a seeded permutation.",
        "caveats": None,
        "dependencies": [],
        "dependents": [
            {
                "id": "exp_1",
                "node_type": "experiment",
                "name": "distill",
                "status": "ready_to_run",
                "settled": False,
                "failed": False,
            }
        ],
    },
    SlimTaskState: {
        "id": "task_1",
        "project_id": "proj_1",
        "name": "prep-data",
        "goal": "Prepare the dataset",
        "status": "in_progress",
        "attempt_index": 1,
        "outcome": "",
        "failed_by": "",
        "deliverables": [],
        "checks": [],
        "results": [],
        "report": None,
        "caveats": None,
        "dependencies": [],
        "dependents": [],
    },
    TaskTransitionReceipt: {
        "task_id": "task_1",
        "transition": "submit_delivery",
        "from_status": "in_progress",
        "to_status": "in_review",
        "status": "in_review",
        "attempt_index": 1,
        "event_id": 7,
        "accepted_at": "2026-07-21T12:00:00Z",
        "feed_note": "Task accepted.",
    },
    TaskSummary: {
        "id": "task_1",
        "project_id": "proj_1",
        "name": "prep-data",
        "goal": "Prepare the dataset",
        "status": "in_progress",
        "attempt_index": 1,
        "outcome": "",
        "failed_by": "",
        "created_at": "2026-07-21T12:00:00Z",
        "updated_at": "2026-07-21T12:00:00Z",
    },
    CommittedTaskUpdate: CommittedTaskUpdate(
        state={"id": "task_1", "status": "in_progress"}, event=EVENT
    ),
    ResearchSnapshot: ResearchSnapshot(
        project_id="proj_1",
        requested_experiment_id="exp_1",
        project={"id": "proj_1"},
        claims=[{"id": "clm_1"}],
        experiments=[{"id": "exp_1", "status": "running"}],
        open_reflection=None,
        latest_published_reflection=None,
        reflection_signal={"needed": False},
        gate_evaluations={"exp_1": {"ready": True}},
        tasks=[{"id": "task_1", "status": "in_progress"}],
        requested_task_id="task_1",
        recent_claims=[{"id": "clm_1"}],
        claim_events_since_reflection=[],
        literature_signal=LiteratureSignal(papers_total=1, papers_unreviewed=0),
    ),
    LiteratureSignal: LiteratureSignal(papers_total=1, papers_unreviewed=0),
}


JSON_ROUNDTRIP_DEBT: Counter[tuple[str, str]] = Counter()

ANNOTATION_DEBT = frozenset(
    {
        ("merv.brain.application.mlflow.TrackingMetric.step", "object"),
        ("merv.brain.application.mlflow.TrackingSnapshotRun.params", "object"),
        (
            "merv.brain.application.experiments.transition.TransitionResponse.metrics_exhibit",
            "object",
        ),
        (
            "merv.brain.application.experiments.transition.TransitionReceipt.metrics_exhibit",
            "object",
        ),
        ("merv.brain.research_core.models.ResearchSnapshot.project", "Any"),
        ("merv.brain.research_core.models.ResearchSnapshot.claims", "Any"),
        ("merv.brain.research_core.models.ResearchSnapshot.open_reflection", "Any"),
        (
            "merv.brain.research_core.models.ResearchSnapshot.latest_published_reflection",
            "Any",
        ),
        ("merv.brain.research_core.models.ResearchSnapshot.reflection_signal", "Any"),
        ("merv.brain.research_core.models.ResearchSnapshot.gate_evaluations", "Any"),
        ("merv.brain.research_core.models.ResearchSnapshot.recent_claims", "Any"),
        (
            "merv.brain.research_core.models.ResearchSnapshot.claim_events_since_reflection",
            "Any",
        ),
        ("merv.brain.research_core.models.ExhibitVerdict.mlflow", "object"),
    }
)

_PERSISTENCE_OR_SERVICE = re.compile(
    r"(?:Connection|Cursor|Row|BaseStateStore|StateStore|Repository|Service|Facade)$"
)


def _to_json_value(value: object, *, boundary_types: set[type]) -> object:
    value_type = type(value)
    if _PERSISTENCE_OR_SERVICE.search(value_type.__name__):
        raise TypeError(f"boundary contains runtime service: {_qualified(value_type)}")
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        if value_type not in boundary_types:
            raise TypeError(
                f"unregistered boundary dataclass: {_qualified(value_type)}"
            )
        return {
            field.name: _to_json_value(
                getattr(value, field.name), boundary_types=boundary_types
            )
            for field in dataclasses.fields(value)
        }
    if isinstance(value, Mapping):
        converted: dict[str, object] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError(f"JSON mapping key is {type(key).__name__}, not str")
            converted[key] = _to_json_value(item, boundary_types=boundary_types)
        return converted
    if isinstance(value, (list, tuple)):
        return [_to_json_value(item, boundary_types=boundary_types) for item in value]
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float) and math.isfinite(value):
        return value
    raise TypeError(f"boundary contains non-JSON value: {_qualified(value_type)}")


def _annotation_nodes(annotation: object):
    yield annotation
    for argument in get_args(annotation):
        yield from _annotation_nodes(argument)


class BoundaryValueContractTest(unittest.TestCase):
    def test_public_boundary_values_have_complete_representative_samples(self) -> None:
        discovered = _boundary_types()
        sampled = {_qualified(value_type) for value_type in SAMPLES}
        self.assertEqual(sampled, set(discovered))
        self.assertFalse(APPLICATION_DATACLASS_EXCLUSIONS & set(discovered))
        for qualified in APPLICATION_DATACLASS_EXCLUSIONS:
            module_name, class_name = qualified.rsplit(".", 1)
            module = importlib.import_module(module_name)
            value = getattr(module, class_name, None)
            self.assertTrue(dataclasses.is_dataclass(value), qualified)
            self.assertIn(class_name, module.__all__, qualified)
        for value_type, sample in SAMPLES.items():
            if is_typeddict(value_type):
                with self.subTest(value_type=_qualified(value_type)):
                    self.assertEqual(set(sample), set(get_type_hints(value_type)))

    def test_boundary_samples_are_json_roundtrippable_except_exact_debt(self) -> None:
        boundary_types = set(_boundary_types().values())
        failures: Counter[tuple[str, str]] = Counter()
        for value_type, sample in SAMPLES.items():
            with self.subTest(value_type=_qualified(value_type)):
                try:
                    normalized = _to_json_value(sample, boundary_types=boundary_types)
                    encoded = json.dumps(normalized, allow_nan=False, sort_keys=True)
                    self.assertEqual(json.loads(encoded), normalized)
                except TypeError as exc:
                    failures[(_qualified(value_type), str(exc))] += 1
        self.assertEqual(failures, JSON_ROUNDTRIP_DEBT)

    def test_boundary_annotation_debt_is_exact_and_has_no_persistence_types(
        self,
    ) -> None:
        debt: set[tuple[str, str]] = set()
        forbidden: list[str] = []
        for value_type in _boundary_types().values():
            for field, annotation in get_type_hints(value_type).items():
                label = f"{_qualified(value_type)}.{field}"
                nodes = tuple(_annotation_nodes(annotation))
                if Any in nodes:
                    debt.add((label, "Any"))
                if object in nodes:
                    debt.add((label, "object"))
                origin = get_origin(annotation)
                args = get_args(annotation)
                if origin is dict and args and args[0] is not str:
                    debt.add((label, "non-string-key"))
                for node in nodes:
                    if isinstance(node, type) and _PERSISTENCE_OR_SERVICE.search(
                        node.__name__
                    ):
                        forbidden.append(f"{label}: {_qualified(node)}")
        self.assertFalse(
            forbidden, "persistence/service types escaped: " + ", ".join(forbidden)
        )
        self.assertEqual(debt, ANNOTATION_DEBT)

    def test_runtime_connection_or_service_objects_are_rejected(self) -> None:
        connection = sqlite3.connect(":memory:")
        self.addCleanup(connection.close)
        with self.assertRaisesRegex(TypeError, "runtime service"):
            _to_json_value(connection, boundary_types=set(_boundary_types().values()))
        connection.row_factory = sqlite3.Row
        row = connection.execute("SELECT 1 AS value").fetchone()
        with self.assertRaisesRegex(TypeError, "runtime service"):
            _to_json_value(row, boundary_types=set(_boundary_types().values()))


if __name__ == "__main__":
    unittest.main()
