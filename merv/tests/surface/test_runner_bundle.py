"""The standalone auto-run archive is a complete, backend-free client."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from tests.paths import PLUGIN_ROOT


_spec = importlib.util.spec_from_file_location(
    "build_runner_bundle", PLUGIN_ROOT / "scripts" / "build_runner_bundle.py"
)
build_runner_bundle = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build_runner_bundle)


class RunnerBundleTest(unittest.TestCase):
    def test_manifest_is_the_small_machine_local_closure(self) -> None:
        manifest = build_runner_bundle.manifest()
        self.assertIn("merv/client/agent_runner.py", manifest)
        self.assertIn("merv/client/runner_entry.py", manifest)
        self.assertIn("merv/shared/client_config.py", manifest)
        self.assertFalse(any("brain" in Path(path).parts for path in manifest))
        self.assertFalse(any("tests" in Path(path).parts for path in manifest))

    def test_archive_runs_runner_and_client_without_the_checkout(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = build_runner_bundle.build(root / "dist")
            with zipfile.ZipFile(archive) as bundle:
                names = set(bundle.namelist())
            self.assertIn("merv/client/agent_runner.py", names)
            self.assertFalse(any("/brain/" in name for name in names))

            environment = {**os.environ, "HOME": str(root / "home")}
            client = subprocess.run(
                [sys.executable, str(archive), "client", "env"],
                env=environment,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(client.returncode, 0, client.stderr)
            self.assertEqual(
                json.loads(client.stdout)["mcpServers"]["merv"]["type"],
                "http",
            )
            token = subprocess.run(
                [
                    sys.executable,
                    str(archive),
                    "runner",
                    "--config",
                    str(root / "client.json"),
                    "--show-pairing-token",
                ],
                env=environment,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(token.returncode, 0, token.stderr)
            self.assertGreaterEqual(len(token.stdout.strip()), 32)

    def test_installer_is_idempotent_and_launchers_use_the_archive(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            distribution = root / "distribution"
            build_runner_bundle.build(distribution)
            home = root / "home"
            runner_home = home / ".merv" / "runner"
            bin_dir = home / ".merv" / "bin"
            environment = {
                **os.environ,
                "HOME": str(home),
                "MERV_RUNNER_BASE_URL": distribution.as_uri(),
                "MERV_RUNNER_HOME": str(runner_home),
                "MERV_RUNNER_BIN_DIR": str(bin_dir),
                "MERV_RUNNER_PYTHON": sys.executable,
            }
            installer = PLUGIN_ROOT / "runner" / "install.sh"
            for _ in range(2):
                installed = subprocess.run(
                    ["sh", str(installer), "--install-only"],
                    env=environment,
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                self.assertEqual(installed.returncode, 0, installed.stderr)

            self.assertTrue((runner_home / "merv-runner.pyz").is_file())
            for name in ("merv-runner", "merv-agent-runner", "merv-client"):
                self.assertTrue(os.access(bin_dir / name, os.X_OK))
            client = subprocess.run(
                [str(bin_dir / "merv-client"), "env"],
                env=environment,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(client.returncode, 0, client.stderr)
            self.assertEqual(
                json.loads(client.stdout)["mcpServers"]["merv"]["url"],
                "https://experiments.rapidreview.io/mcp",
            )


if __name__ == "__main__":
    unittest.main()
