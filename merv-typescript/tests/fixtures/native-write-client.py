"""Run a native client against an explicitly authorized isolated fixture.

Model authentication stays private. This helper sets no tool permissions or MCP
configuration. It never supplies a Merv token or a per-run tool allowlist.
"""
import json
import os
import subprocess
import sys

if os.environ.get("MERV_ALLOW_MODEL_TESTS") != "1":
    raise SystemExit("Set MERV_ALLOW_MODEL_TESTS=1 to reuse local model authentication privately.")
root, client = sys.argv[1:3]
if client not in ("codex", "claude"):
    raise SystemExit("Choose codex or claude")
with open(os.path.join(root, "fixture.json")) as source:
    fixture = json.load(source)
if os.path.realpath(root) != os.path.realpath(fixture["root"]):
    raise SystemExit("Not the fixture root")
env = dict(os.environ, BROWSER="true", DISABLE_AUTOUPDATER="1")
if client == "codex":
    env["CODEX_HOME"] = os.path.join(root, "codex")
else:
    env["CLAUDE_CONFIG_DIR"] = os.path.join(root, "claude")
    stored = json.loads(subprocess.check_output(
        ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
        stderr=subprocess.DEVNULL,
    ))
    env["CLAUDE_CODE_OAUTH_TOKEN"] = stored["claudeAiOauth"]["accessToken"]
os.chdir(root)
binary = os.environ.get("MERV_CLAUDE_BIN", client) if client == "claude" else client
os.execvpe(binary, [binary] + sys.argv[3:], env)
