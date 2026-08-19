"""Kilo's Git plugin and hosted remote-skill catalog stay installable."""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from tests.paths import PLUGIN_ROOT


_spec = importlib.util.spec_from_file_location(
    "build_kilo_catalog", PLUGIN_ROOT / "clients" / "kilo" / "build_catalog.py"
)
build_kilo_catalog = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build_kilo_catalog)


class KiloAdapterTest(unittest.TestCase):
    def test_catalog_contains_every_skill_and_content_versions(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            skills = root / "skills"
            shutil.copytree(PLUGIN_ROOT / "skills", skills)
            out = root / "catalog"

            first = build_kilo_catalog.build_catalog(out, skills_root=skills)
            index = json.loads((out / "index.json").read_text())
            self.assertEqual(index, first)

            expected = {path.name for path in skills.iterdir() if path.is_dir()}
            entries = {entry["name"]: entry for entry in index["skills"]}
            self.assertEqual(set(entries), expected)
            for name, entry in entries.items():
                self.assertIn("SKILL.md", entry["files"])
                self.assertRegex(entry["version"], r"^[0-9a-f]{64}$")
                for rel in entry["files"]:
                    self.assertTrue((out / name / rel).is_file())

            before = entries["research-workflow"]["version"]
            target = skills / "research-workflow" / "SKILL.md"
            target.write_text(target.read_text() + "\nUpdate test.\n")
            second = build_kilo_catalog.build_catalog(out, skills_root=skills)
            after = {
                entry["name"]: entry["version"] for entry in second["skills"]
            }
            self.assertNotEqual(after["research-workflow"], before)
            unchanged = set(expected) - {"research-workflow"}
            for name in unchanged:
                self.assertEqual(after[name], entries[name]["version"])

    def test_plugin_injects_mcp_catalog_and_reviewer_agents_idempotently(self) -> None:
        plugin = PLUGIN_ROOT / "clients" / "kilo" / "plugin.js"
        script = """
          const mod = await import(process.argv[1]);
          const hooks = await mod.mervPlugin();
          const config = { skills: { urls: ['https://example.test/skills/'] } };
          await hooks.config(config);
          await hooks.config(config);
          console.log(JSON.stringify(config));
        """
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script, plugin.as_uri()],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        config = json.loads(result.stdout)
        self.assertEqual(
            config["mcp"]["merv"],
            {
                "type": "remote",
                "url": "https://experiments.rapidreview.io/mcp",
                "enabled": True,
            },
        )
        catalog = "https://rapidreview.io/merv/.well-known/skills/"
        self.assertEqual(config["skills"]["urls"].count(catalog), 1)
        self.assertEqual(
            set(config["agent"]),
            {
                "consolidation-review",
                "experiment-attempt-review",
                "experiment-design-review",
                "project-reflection-review",
                "task-review",
            },
        )
        for agent in config["agent"].values():
            self.assertEqual(agent["mode"], "subagent")
            self.assertEqual(agent["permission"]["edit"], "deny")

    def test_public_setup_copy_is_in_the_readme_and_hosted_ui(self) -> None:
        command = "kilo plugin 'github:rapidreview-io/Merv#merv-client' --global"
        root = PLUGIN_ROOT.parent
        self.assertIn(command, (root / "README.md").read_text())
        self.assertIn(
            command,
            (root / "research_state_ui" / "src" / "components" / "connectClients.jsx").read_text(),
        )


if __name__ == "__main__":
    unittest.main()
