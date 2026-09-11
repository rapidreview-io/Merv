"""Durable maintenance contract for the Research Core module guide."""

from __future__ import annotations

import re
import unittest

from tests.paths import BACKEND_ROOT, PLUGIN_ROOT, RESEARCH_CORE_ROOT
from merv.brain.programs import INSTALLED
from merv.brain.surface.tools.contracts import TOOL_MANIFEST


GUIDE = RESEARCH_CORE_ROOT / "research_core.md"
# research.md walks one experiment across all of them, so it is held to the same
# density and reference rules as the component notes it points into.
GUIDES = (BACKEND_ROOT / "research.md", *(BACKEND_ROOT / name / f"{name}.md"
          for name in ("research_core", "workflows", "application", "surface")))


def _catalog():
    workflows = [workflow for program in INSTALLED for workflow in program.workflows]
    return {
        "action": {f"{workflow.name}.{edge.name}" for workflow in workflows for edge in workflow.edges},
        "role": {f"{workflow.name}.{role}" for workflow in workflows for node in workflow.nodes
                 for role in (node.role, *(getattr(need, "role", "") for need in node.requires)) if role},
        "tool": set(TOOL_MANIFEST),
        "skill": {path.parent.name for path in (PLUGIN_ROOT / "skills").glob("*/SKILL.md")},
    }


def _reference_problems(text, catalog):
    bare = {name.rsplit(".", 1)[-1] for kind in ("action", "role") for name in catalog[kind]}
    bare |= catalog["tool"] | catalog["skill"]
    problems = []
    for reference in re.findall(r"`([^`\n]+)`", text):
        kind, _, name = reference.partition(":")
        if kind in catalog and name not in catalog[kind]:
            problems.append(f"unknown {reference}")
        elif reference in bare:
            problems.append(f"unqualified {reference}")
    return problems


MAINTENANCE_HEADER = (
    "# If you update this file, you must consult research_core.md to see whether "
    "research_core.md needs to be updated. research_core.md must not exceed 100 lines."
)


class ResearchCoreDocumentationTests(unittest.TestCase):
    def test_guide_stays_dense(self) -> None:
        for guide in GUIDES:
            with self.subTest(guide=str(guide)):
                self.assertTrue(guide.is_file())
                self.assertLess(len(guide.read_text().splitlines()), 100)

    def test_qualified_references_resolve_and_reject_deleted_or_misspelled_names(self):
        catalog = _catalog()
        for guide in GUIDES:
            with self.subTest(guide=str(guide)):
                self.assertEqual(_reference_problems(guide.read_text(), catalog), [])
        for kind, names in catalog.items():
            name = sorted(names)[0]
            self.assertTrue(_reference_problems(f"`{kind}:{name}_misspelled`", catalog))
            self.assertTrue(_reference_problems(f"`{kind}:{name}`", {**catalog, kind: names - {name}}))
            unqualified = name.rsplit(".", 1)[-1] if kind in {"action", "role"} else name
            self.assertTrue(_reference_problems(f"`{unqualified}`", catalog))

    def test_every_module_source_points_to_the_guide(self) -> None:
        sources = sorted(RESEARCH_CORE_ROOT.glob("*.py"))
        self.assertTrue(sources, "Research Core must contain Python sources")
        for path in sources:
            with self.subTest(path=path.name):
                first_line = path.read_text(encoding="utf-8").splitlines()[0]
                self.assertEqual(first_line, MAINTENANCE_HEADER)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
