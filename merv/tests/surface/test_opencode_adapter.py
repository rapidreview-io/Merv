"""OpenCode's native Git plugin stays OAuth-first and updateable."""

from __future__ import annotations

import json
import subprocess
import unittest

from tests.paths import PLUGIN_ROOT


class OpenCodeAdapterTest(unittest.TestCase):
    def test_plugin_injects_oauth_mcp_catalog_and_reviewers(self) -> None:
        plugin = PLUGIN_ROOT / "clients" / "opencode" / "plugin.js"
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
        self.assertNotIn("headers", config["mcp"]["merv"])
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

    def test_generated_package_exposes_the_opencode_entrypoint(self) -> None:
        package = json.loads(
            (PLUGIN_ROOT / "clients" / "kilo" / "package.json").read_text()
        )
        self.assertEqual(
            package["exports"]["./server"]["import"],
            "./clients/opencode/plugin.js",
        )

    def test_public_setup_copy_is_in_readme_and_ui(self) -> None:
        command = "opencode plugin 'github:rapidreview-io/Merv#merv-client' --global"
        root = PLUGIN_ROOT.parent
        self.assertIn(command, (root / "README.md").read_text())
        self.assertIn(
            command,
            (
                root
                / "research_state_ui"
                / "src"
                / "components"
                / "connectClients.jsx"
            ).read_text(),
        )


if __name__ == "__main__":
    unittest.main()
