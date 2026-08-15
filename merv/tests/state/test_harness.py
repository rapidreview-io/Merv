"""Every auto-run child gets Merv's skills and a working native tool route."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from merv.client import harness
from merv.client.agent_runner import Platform


class SkillsInstallTest(unittest.TestCase):
    def test_bundled_skills_install_once_and_replace_on_change(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp)
            install = harness.install_skills(state)
            self.assertEqual(install.root, state / "skills")
            self.assertIn("research-workflow", install.names)
            self.assertIn("experiment-attempt-review", install.names)
            self.assertTrue((install.root / "research-workflow" / "SKILL.md").is_file())
            # Supporting files travel with their skill.
            self.assertTrue(
                (install.root / "research-workflow" / "plan-template.md").is_file()
            )
            manifest = json.loads(
                (install.root / harness.MANIFEST_NAME).read_text(encoding="utf-8")
            )
            self.assertEqual(manifest["digest"], install.digest)

            marker = install.root / "research-workflow" / "local-edit.txt"
            marker.write_text("stale", encoding="utf-8")
            again = harness.install_skills(state)
            self.assertEqual(again.digest, install.digest)
            self.assertTrue(marker.exists(), "an unchanged bundle is left in place")

            (install.root / harness.MANIFEST_NAME).write_text(
                json.dumps({"digest": "different"}), encoding="utf-8"
            )
            refreshed = harness.install_skills(state)
            self.assertEqual(refreshed.digest, install.digest)
            self.assertFalse(marker.exists(), "a changed bundle is replaced whole")
            self.assertEqual(
                sorted(item.name for item in state.iterdir()),
                ["skills"],
                "no scratch or old copies are left behind",
            )


class SkillsMountTest(unittest.TestCase):
    def test_codex_and_claude_get_native_mounts_excluded_from_git(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            install = harness.install_skills(root / "state")
            workspace = root / "work"
            workspace.mkdir()
            exclude = root / "central.git" / "info" / "exclude"
            exclude.parent.mkdir(parents=True)
            exclude.write_text("*.log\n", encoding="utf-8")

            mounted = harness.mount_skills(
                adapter="codex",
                workspace=workspace,
                install=install,
                exclude_file=exclude,
            )
            self.assertIn(".agents/skills/research-workflow", mounted)
            link = workspace / ".agents" / "skills" / "research-workflow"
            self.assertTrue(link.is_symlink())
            self.assertEqual(
                Path(os.readlink(link)), install.root / "research-workflow"
            )
            self.assertTrue((link / "SKILL.md").is_file())

            text = exclude.read_text(encoding="utf-8")
            self.assertTrue(text.startswith("*.log\n"), "existing rules survive")
            self.assertIn("/.agents/skills/research-workflow\n", text)
            self.assertIn("/.claude/skills/research-workflow\n", text)
            self.assertEqual(text.count(harness.EXCLUDE_BEGIN), 1)

            harness.mount_skills(
                adapter="claude",
                workspace=workspace,
                install=install,
                exclude_file=exclude,
            )
            self.assertTrue(
                (workspace / ".claude" / "skills" / "sandbox-operation").is_symlink()
            )
            self.assertEqual(
                exclude.read_text(encoding="utf-8").count(harness.EXCLUDE_BEGIN),
                1,
                "the managed block is rewritten, never duplicated",
            )

            # The workspace's own skill of the same name is never replaced.
            own = workspace / ".agents" / "skills" / "feed-posting"
            own.unlink()
            own.mkdir()
            (own / "SKILL.md").write_text("mine", encoding="utf-8")
            mounted = harness.mount_skills(
                adapter="codex", workspace=workspace, install=install
            )
            self.assertNotIn(".agents/skills/feed-posting", mounted)
            self.assertEqual((own / "SKILL.md").read_text(encoding="utf-8"), "mine")

            self.assertEqual(
                harness.mount_skills(
                    adapter="hermes", workspace=workspace, install=install
                ),
                (),
            )

    def test_git_capture_ignores_the_mounted_skills(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            install = harness.install_skills(root / "state")
            source = root / "source"
            source.mkdir()
            git = ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main"]
            subprocess.run([*git, "init", "-q"], cwd=source, check=True)
            (source / "README.md").write_text("hi\n", encoding="utf-8")
            subprocess.run([*git, "add", "-A"], cwd=source, check=True)
            subprocess.run([*git, "commit", "-q", "-m", "init"], cwd=source, check=True)
            bare = root / "central.git"
            subprocess.run(
                ["git", "clone", "-q", "--bare", str(source), str(bare)], check=True
            )
            work = root / "work"
            subprocess.run(
                ["git", "-C", str(bare), "worktree", "add", "-q", str(work), "main"],
                check=True,
            )
            harness.mount_skills(
                adapter="codex",
                workspace=work,
                install=install,
                exclude_file=bare / "info" / "exclude",
            )
            (work / "result.txt").write_text("real work\n", encoding="utf-8")
            status = subprocess.run(
                ["git", "status", "--porcelain"],
                cwd=work,
                capture_output=True,
                text=True,
                check=True,
            ).stdout
            self.assertIn("result.txt", status)
            self.assertNotIn(".agents", status)


class ReadinessTest(unittest.TestCase):
    def test_note_and_readiness_describe_what_each_harness_receives(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            install = harness.install_skills(root)
            note = harness.skills_note(install, adapter="hermes")
            self.assertIn(str(install.root), note)
            self.assertIn("research-workflow", note)
            self.assertIn("do not search", note)
            self.assertIn("mounted", harness.skills_note(install, adapter="codex"))

            fake_bin = root / "bin"
            fake_bin.mkdir()
            codex = fake_bin / "codex"
            codex.write_text("#!/bin/sh\necho codex-cli 9.9.9\n", encoding="utf-8")
            codex.chmod(0o755)
            platforms = (
                Platform("codex", "codex", ("codex",)),
                Platform("hermes", "hermes", ("hermes-missing",)),
            )
            report = harness.readiness(
                platforms=platforms,
                install=install,
                environment={"PATH": str(fake_bin)},
            )
            self.assertEqual(report["skills"]["count"], len(install.names))
            ready = report["platforms"]["codex"]
            self.assertTrue(ready["ok"])
            self.assertEqual(ready["executable"], str(codex))
            self.assertEqual(ready["version"], "codex-cli 9.9.9")
            self.assertEqual(ready["merv_mcp"], "native")
            self.assertEqual(ready["skills"], "mounted")
            missing = report["platforms"]["hermes"]
            self.assertFalse(missing["ok"])
            self.assertEqual(missing["merv_mcp"], "merv-client")
            self.assertEqual(missing["skills"], "instruction")
            self.assertIn("'hermes-missing' is not on PATH", missing["problems"])


class SignInEvidenceTest(unittest.TestCase):
    """Sign-in is the harness's business; the runner notices signals and reads refusals."""

    def test_auth_signal_is_present_unknown_or_not_applicable_and_never_reads_values(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            self.assertEqual(harness.auth_signal("codex", {}, home=home), {"status": "unknown", "via": ""})
            self.assertEqual(
                harness.auth_signal("codex", {"OPENAI_API_KEY": "sk-secret"}, home=home),
                {"status": "present", "via": "env OPENAI_API_KEY"},
            )
            (home / ".codex").mkdir()
            (home / ".codex" / "auth.json").write_text('{"token": "secret"}')
            signal = harness.auth_signal("codex", {}, home=home)
            self.assertEqual(signal, {"status": "present", "via": "~/.codex/auth.json"})
            self.assertNotIn("secret", json.dumps(signal))
            self.assertEqual(harness.auth_signal("command", {}, home=home)["status"], "n/a")

    def test_classify_failure_reads_the_harness_own_words_and_names_the_fix(self) -> None:
        auth = harness.classify_failure("codex", "warming up\nError: not logged in. Please run codex login\n")
        self.assertEqual(auth["kind"], "auth")
        self.assertEqual(auth["line"], "Error: not logged in. Please run codex login")
        self.assertIn("codex login", auth["hint"])
        claude = harness.classify_failure("claude", 'API Error: 401 {"type":"authentication_error"}')
        self.assertEqual(claude["kind"], "auth")
        self.assertIn("sign in", claude["hint"])
        quota = harness.classify_failure("gemini", "429 RESOURCE_EXHAUSTED: quota exceeded")
        self.assertEqual(quota["kind"], "quota")
        self.assertIsNone(harness.classify_failure("codex", "all good\nwrote results.json\n"))

    def test_readiness_carries_the_auth_signal_per_platform(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            report = harness.readiness(
                platforms=[Platform(name="codex", adapter="codex", command=("codex",), enabled=True)],
                install=None,
                environment={"PATH": tmp, "OPENAI_API_KEY": "x"},
            )
        self.assertEqual(report["platforms"]["codex"]["auth"], {"status": "present", "via": "env OPENAI_API_KEY"})
