from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from merv.shared.client_config import (
    CLIENT_CONFIG_ENV_VAR,
    CONTROL_URL_ENV_VAR,
    read_client_config,
    resolve_client_control_url,
)
from merv.client.cli import HOSTED_CONTROL_URL, configure_client, main


class ClientConfigTest(unittest.TestCase):
    def test_configure_writes_only_the_machine_control_url(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "client.json"
            config = configure_client(
                config_path=config_path,
                control_url="https://control.example.test/",
            )

            self.assertEqual(config, {"control_url": "https://control.example.test"})
            self.assertEqual(
                read_client_config({CLIENT_CONFIG_ENV_VAR: str(config_path)}),
                config,
            )
            self.assertEqual(config_path.stat().st_mode & 0o777, 0o600)

    def test_explicit_env_overrides_machine_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "client.json"
            configure_client(
                config_path=config_path,
                control_url="https://configured.example.test",
            )
            env = {
                CLIENT_CONFIG_ENV_VAR: str(config_path),
                CONTROL_URL_ENV_VAR: "https://override.example.test",
            }
            self.assertEqual(resolve_client_control_url(env=env), "https://override.example.test")

    def test_configure_defaults_to_hosted_url(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "client.json"
            with redirect_stdout(io.StringIO()):
                code = main(["--config", str(config_path), "configure"])
            self.assertEqual(code, 0)
            self.assertEqual(
                json.loads(config_path.read_text()),
                {"control_url": HOSTED_CONTROL_URL},
            )

    def test_env_prints_http_mcp_snippet_with_key_indirection(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "client.json"
            configure_client(
                config_path=config_path,
                control_url="https://control.example.test/",
            )
            with (
                patch.dict(
                    "os.environ",
                    {CONTROL_URL_ENV_VAR: "", "RESEARCH_PLUGIN_CONTROL_URL": ""},
                    clear=False,
                ),
                redirect_stdout(io.StringIO()) as stdout,
            ):
                code = main(["--config", str(config_path), "env"])

            self.assertEqual(code, 0)
            snippet = json.loads(stdout.getvalue())
            self.assertEqual(
                snippet,
                {
                    "mcpServers": {
                        "merv": {
                            "type": "http",
                            "url": "https://control.example.test/mcp",
                            "headers": {
                                "Authorization": "Bearer ${MERV_MCP_KEY}",
                            },
                        },
                    },
                },
            )

    def test_retired_commands_are_not_in_help(self) -> None:
        with self.assertRaises(SystemExit):
            with redirect_stdout(io.StringIO()) as stdout:
                main(["--help"])
        help_text = stdout.getvalue()
        for command in ("login", "link", "route", "links", "unlink", "connect"):
            self.assertNotIn(command, help_text)
        self.assertIn("configure", help_text)
        self.assertIn("env", help_text)


if __name__ == "__main__":
    unittest.main()
