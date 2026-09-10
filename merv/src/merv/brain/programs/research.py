"""Merv's own research program: the graphs, records, effects and tools it runs on."""

from __future__ import annotations

from ..research_core import TOOLS as RESEARCH_TOOLS
from ..workflows import (
    TOOLS as WORKFLOW_TOOLS, ArtifactNeed, DependenciesDone, Program, RecordNeed, ReviewGate,
)
from ..workflows.definitions.experiment import EXPERIMENT, KIND as EXPERIMENT_KIND
from ..workflows.definitions.reflection import LENS, REFLECTION, KIND as REFLECTION_KIND
from ..workflows.definitions.research_wave import RESEARCH_WAVE
from ..workflows.definitions.task import TASK, KIND as TASK_KIND

# The lens and the published wave keep their whole record in instance data, so
# they carry no ``RecordKind``; the other three bind to a native row.
PROGRAM = Program(
    name="research",
    version=1,
    workflows=(EXPERIMENT, TASK, REFLECTION, LENS, RESEARCH_WAVE),
    kinds=(EXPERIMENT_KIND, TASK_KIND, REFLECTION_KIND),
    effects=("workflow.start", "review.request"),
    requirements=(ArtifactNeed, RecordNeed, DependenciesDone, ReviewGate),
    tools={**WORKFLOW_TOOLS, **RESEARCH_TOOLS},
)
