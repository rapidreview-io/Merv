"""Shipped interactive adapters all use the same OAuth-discovered HTTP MCP."""

from __future__ import annotations

import json
import re
import tomllib
import unittest

from merv.brain import __version__ as BACKEND_VERSION
from tests.paths import PLUGIN_ROOT


HOSTED_MCP_URL = "https://experiments.rapidreview.io/mcp"


class HttpMcpManifestTest(unittest.TestCase):
    def test_generic_codex_and_cursor_manifests_are_oauth_first(self) -> None:
        for name in (".mcp.json", ".mcp.codex.json", "mcp.json"):
            with self.subTest(manifest=name):
                config = json.loads((PLUGIN_ROOT / name).read_text())
                server = config["mcpServers"]["merv"]
                self.assertEqual(server["type"], "http")
                self.assertEqual(server["url"], HOSTED_MCP_URL)
                self.assertNotIn("headers", server)
                serialized = json.dumps(server)
                self.assertNotIn("MERV_MCP_KEY", serialized)
                self.assertNotIn("mk_", serialized)
                self.assertNotIn("merv-mcp", serialized)

    def test_gemini_uses_the_same_oauth_first_http_endpoint(self) -> None:
        manifest = json.loads((PLUGIN_ROOT / "gemini-extension.json").read_text())
        self.assertEqual(manifest["name"], "merv")
        self.assertEqual(manifest["version"], BACKEND_VERSION)
        server = manifest["mcpServers"]["merv"]
        self.assertEqual(server["httpUrl"], HOSTED_MCP_URL)
        self.assertNotIn("headers", server)

    def test_kilo_plugin_is_oauth_first(self) -> None:
        adapter = PLUGIN_ROOT / "clients" / "kilo"
        package = json.loads((adapter / "package.json").read_text())
        plugin = (adapter / "plugin.js").read_text()
        self.assertEqual(package["name"], "merv-kilo-plugin")
        self.assertEqual(package["version"], "0.1.4")
        self.assertIn(HOSTED_MCP_URL, plugin)
        self.assertIn("https://rapidreview.io/merv/.well-known/skills/", plugin)
        self.assertIn("type: 'remote'", plugin)
        self.assertNotIn("headers", plugin)
        self.assertNotIn("MERV_MCP_KEY", plugin)
        self.assertNotIn("mk_", plugin)

    def test_opencode_example_uses_environment_key_indirection(self) -> None:
        config = json.loads(
            (PLUGIN_ROOT / "clients" / "opencode" / "opencode.json.example").read_text()
        )
        server = config["mcp"]["merv"]
        self.assertEqual(server["type"], "remote")
        self.assertEqual(server["url"], HOSTED_MCP_URL)
        self.assertEqual(
            server["headers"]["Authorization"],
            "Bearer {env:MERV_MCP_KEY}",
        )

    def test_plugin_manifests_keep_package_identity(self) -> None:
        claude = json.loads(
            (PLUGIN_ROOT / ".claude-plugin" / "plugin.json").read_text()
        )
        cursor = json.loads(
            (PLUGIN_ROOT / ".cursor-plugin" / "plugin.json").read_text()
        )
        codex = json.loads(
            (PLUGIN_ROOT / ".codex-plugin" / "plugin.json").read_text()
        )
        for manifest in (claude, cursor, codex):
            self.assertEqual(manifest["name"], "merv")

        plugin_version = claude["version"]
        self.assertRegex(plugin_version, r"^\d+\.\d+\.\d+$")
        self.assertEqual(cursor["version"], plugin_version)
        kilo = json.loads(
            (PLUGIN_ROOT / "clients" / "kilo" / "package.json").read_text()
        )
        self.assertEqual(kilo["version"], plugin_version)
        self.assertEqual(codex["version"].split("+", 1)[0], plugin_version)
        self.assertEqual(codex["name"], "merv")
        codex_server = codex["mcpServers"]["merv"]
        self.assertEqual(codex_server["type"], "http")
        self.assertEqual(codex_server["url"], HOSTED_MCP_URL)
        self.assertEqual(codex_server["default_tools_approval_mode"], "approve")
        self.assertNotIn("headers", codex_server)

    def test_repository_marketplaces_publish_the_same_plugin(self) -> None:
        repo_root = PLUGIN_ROOT.parent
        claude = json.loads(
            (repo_root / ".claude-plugin" / "marketplace.json").read_text()
        )
        cursor = json.loads(
            (repo_root / ".cursor-plugin" / "marketplace.json").read_text()
        )
        codex = json.loads(
            (repo_root / ".agents" / "plugins" / "marketplace.json").read_text()
        )

        for marketplace in (claude, cursor, codex):
            self.assertEqual(marketplace["name"], "rapidreview")
            self.assertEqual(marketplace["plugins"][0]["name"], "merv")

        self.assertEqual(claude["plugins"][0]["source"], "./merv")
        self.assertEqual(cursor["plugins"][0]["source"], "merv")
        self.assertEqual(
            codex["plugins"][0]["source"],
            {"source": "local", "path": "./merv"},
        )
        self.assertEqual(
            codex["plugins"][0]["policy"],
            {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
        )

        release_version = claude["plugins"][0]["version"]
        self.assertEqual(cursor["plugins"][0]["version"], release_version)
        packaged_version = json.loads(
            (PLUGIN_ROOT / ".claude-plugin" / "plugin.json").read_text()
        )["version"]
        self.assertEqual(release_version, packaged_version)

    def test_release_version_lockstep(self) -> None:
        # One release number everywhere: a UI or package left behind produces
        # a permanent false "reload this UI" compat banner against /api/meta.
        pyproject = tomllib.loads((PLUGIN_ROOT / "pyproject.toml").read_text())
        self.assertEqual(pyproject["project"]["version"], BACKEND_VERSION)
        api_js = (PLUGIN_ROOT.parent / "research_state_ui" / "src" / "api.js").read_text()
        match = re.search(r"CLIENT_VERSION = '([^']+)'", api_js)
        self.assertIsNotNone(match)
        self.assertEqual(match.group(1), BACKEND_VERSION)


if __name__ == "__main__":
    unittest.main()
