"""METRICS_SCRIPT under a real shell, pinned on the SSH self-session rule.

The management probe reaches VM providers over SSH, so its own ESTABLISHED
:22 socket is always in the sample. Counting it kept ``ssh_established`` >= 1
forever, which made ``is_idle`` permanently False — idle reaping never fired
and idle GPU boxes billed to hard expiry. A fake ``ss`` on PATH owns the
socket table; the script's other gauges degrade per platform as designed.
"""

from __future__ import annotations

import os
import shlex
import subprocess
import tempfile
import unittest
from pathlib import Path

from merv.brain.sandbox.remote.usage_metrics import METRICS_SCRIPT, parse_metrics


class MetricsScriptSshSessionsTest(unittest.TestCase):
    def _ssh_established(self, *, established: int, over_ssh: bool) -> int | None:
        with tempfile.TemporaryDirectory() as tmp:
            fake_ss = Path(tmp) / "ss"
            if established:
                rows = "\n".join(
                    f"ESTAB 0 0 10.0.0.5:22 203.0.113.7:5{i:04d}"
                    for i in range(established)
                )
                fake_ss.write_text(f"#!/bin/sh\nprintf '%s\\n' {shlex.quote(rows)}\n")
            else:
                fake_ss.write_text("#!/bin/sh\nexit 0\n")
            fake_ss.chmod(0o755)
            env = {k: v for k, v in os.environ.items() if k != "SSH_CONNECTION"}
            env["PATH"] = f"{tmp}:{env.get('PATH', '')}"
            if over_ssh:
                env["SSH_CONNECTION"] = "203.0.113.7 50000 10.0.0.5 22"
            proc = subprocess.run(
                ["bash", "-c", METRICS_SCRIPT],
                capture_output=True,
                text=True,
                env=env,
                timeout=30,
            )
        metrics = parse_metrics(proc.stdout)
        self.assertIsNotNone(metrics, f"stdout={proc.stdout!r} stderr={proc.stderr!r}")
        assert metrics is not None
        return metrics["network"]["ssh_established"]

    def test_probe_session_is_not_counted(self) -> None:
        self.assertEqual(self._ssh_established(established=1, over_ssh=True), 0)

    def test_real_sessions_still_count(self) -> None:
        self.assertEqual(self._ssh_established(established=3, over_ssh=True), 2)

    def test_exec_probe_is_untouched(self) -> None:
        # Modal-style exec probes do not ride SSH: no subtraction.
        self.assertEqual(self._ssh_established(established=2, over_ssh=False), 2)

    def test_zero_never_goes_negative(self) -> None:
        self.assertEqual(self._ssh_established(established=0, over_ssh=True), 0)


if __name__ == "__main__":
    unittest.main()
