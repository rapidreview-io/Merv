"""The programs this brain installs. Adding one is an entry in ``INSTALLED``."""

from ..workflows import Program
from .research import PROGRAM

INSTALLED: tuple[Program, ...] = (PROGRAM,)

__all__ = ["INSTALLED", "PROGRAM", "Program"]
