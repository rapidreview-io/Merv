"""The generated native Hermes plugin stays complete, minimal, and installable."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from tests.paths import PLUGIN_ROOT


_spec = importlib.util.spec_from_file_location(
    "build_hermes_bundle", PLUGIN_ROOT / "clients" / "hermes" / "build_bundle.py"
)
build_hermes_bundle = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build_hermes_bundle)


class _FakeContext:
    def __init__(self) -> None:
        self.skills: list[tuple[str, Path]] = []
        self.sections: list[tuple[str, str, str, int]] = []

    def register_skill(self, name: str, path: Path) -> None:
        self.skills.append((name, path))

    def register_system_prompt_section(
        self, name: str, content: str, *, position: str, max_chars: int
    ) -> None:
        self.sections.append((name, content, position, max_chars))


class HermesAdapterTest(unittest.TestCase):
    def test_generated_plugin_copies_every_canonical_skill_exactly(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "merv-hermes-client"
            build_hermes_bundle.build(out, source_revision="abc123")

            canonical = {
                path.relative_to(PLUGIN_ROOT / "skills"): path.read_bytes()
                for path in (PLUGIN_ROOT / "skills").rglob("*")
                if path.is_file()
            }
            generated = {
                path.relative_to(out / "skills"): path.read_bytes()
                for path in (out / "skills").rglob("*")
                if path.is_file()
            }
            self.assertEqual(generated, canonical)
            self.assertFalse((out / "src").exists())
            self.assertFalse((out / "tests").exists())
            self.assertFalse((out / "deploy").exists())
            self.assertTrue((out / ".github" / "workflows" / "sync.yml").is_file())
            self.assertEqual(
                json.loads((out / "SOURCE.json").read_text())["source_revision"],
                "abc123",
            )

    def test_generated_plugin_registers_all_skills_and_context(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "merv-hermes-client"
            build_hermes_bundle.build(out)
            spec = importlib.util.spec_from_file_location("generated_merv", out / "__init__.py")
            plugin = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(plugin)

            context = _FakeContext()
            plugin.register(context)
            expected = {
                path.parent.name for path in (PLUGIN_ROOT / "skills").glob("*/SKILL.md")
            }
            self.assertEqual({name for name, _ in context.skills}, expected)
            for _, path in context.skills:
                self.assertTrue(path.is_file())
                self.assertTrue(path.resolve().is_relative_to((out / "skills").resolve()))
            self.assertEqual(len(context.sections), 1)
            name, content, position, max_chars = context.sections[0]
            self.assertEqual(name, "merv.integration")
            self.assertEqual(position, "after_memory")
            self.assertLessEqual(len(content), max_chars)
            self.assertIn("merv:research-workflow", content)
            self.assertIn("mcp_merv_workflow_status_and_next", content)

    def test_manifest_and_public_setup_copy(self) -> None:
        manifest = (
            PLUGIN_ROOT / "clients" / "hermes" / "plugin" / "plugin.yaml"
        ).read_text()
        self.assertIn("name: merv", manifest)
        self.assertIn("version: 0.1.4", manifest)
        sync = (
            PLUGIN_ROOT
            / "clients"
            / "hermes"
            / "plugin"
            / ".github"
            / "workflows"
            / "sync.yml"
        ).read_text()
        self.assertIn('cron: "*/5 * * * *"', sync)
        self.assertIn("https://github.com/rapidreview-io/Merv.git", sync)
        self.assertIn("git commit --allow-empty", sync)
        self.assertIn("--exclude .github/workflows/sync.yml", sync)

        root = PLUGIN_ROOT.parent
        command = "hermes plugins install rapidreview-io/merv-hermes-client --enable"
        connect = (
            "hermes mcp add merv --url "
            "https://experiments.rapidreview.io/mcp --auth oauth"
        )
        update = "hermes plugins update merv"
        for path in (
            root / "README.md",
            root / "research_state_ui" / "src" / "components" / "connectClients.jsx",
            PLUGIN_ROOT / "clients" / "hermes" / "README.md",
        ):
            copy = path.read_text()
            self.assertIn(command, copy, str(path))
            self.assertIn(connect, copy, str(path))
            self.assertIn(update, copy, str(path))


if __name__ == "__main__":
    unittest.main()
