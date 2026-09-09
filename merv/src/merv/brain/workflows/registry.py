"""Install a plugin by registering its versioned graph here."""

from .definitions.task import TASK
from .definitions.experiment import EXPERIMENT
from .definitions.reflection import REFLECTION, LENS
from .definitions.research_wave import RESEARCH_WAVE

WORKFLOWS = {"experiment": EXPERIMENT, "task": TASK, "reflection": REFLECTION,
             "reflection_lens": LENS, "research_wave": RESEARCH_WAVE}
