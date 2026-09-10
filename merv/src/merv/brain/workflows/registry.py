"""Install a plugin by registering its versioned graph here."""

from .definitions.task import TASK, KIND as TASK_KIND
from .definitions.experiment import EXPERIMENT, KIND as EXPERIMENT_KIND
from .definitions.reflection import REFLECTION, LENS, KIND as REFLECTION_KIND
from .definitions.research_wave import RESEARCH_WAVE

WORKFLOWS = {"experiment": EXPERIMENT, "task": TASK, "reflection": REFLECTION,
             "reflection_lens": LENS, "research_wave": RESEARCH_WAVE}

# Native records bound to a graph. A plugin workflow has no row of its own and
# never appears here; the runtime treats its instance data as the whole record.
KINDS = {kind.name: kind for kind in (EXPERIMENT_KIND, TASK_KIND, REFLECTION_KIND)}
