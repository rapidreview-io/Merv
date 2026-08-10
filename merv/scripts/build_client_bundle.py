#!/usr/bin/env python3
"""Assemble the slim client plugin bundle from the repository.

The plugin root (``merv/``) doubles as the monorepo: it carries the full backend
(``src/merv/brain``, ~237 files) and the test suite (``tests/``, ~133 files) that
a thin HTTP-MCP client never runs. Claude Code copies a plugin's whole ``source``
tree on install (there is no ``.claudeignore``), so shipping ``merv/`` directly
hands every client the entire backend. This build step copies only the files a
client needs into an output directory that the marketplace/publish pipeline
serves, while the repository stays full for self-hosters.

The real ``skills/``/``agents/``/``src`` are the single source of truth; nothing
is duplicated in the source branch. The release workflow runs this builder and
force-publishes its output to the generated ``merv-client`` branch, which is the
small, auto-updating source used by Gemini CLI.

    python3 scripts/build_client_bundle.py            # -> dist/plugin/
    python3 scripts/build_client_bundle.py --out /tmp/merv-slim
    python3 scripts/build_client_bundle.py --manifest # print the file list only
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

MERV_ROOT = Path(__file__).resolve().parent.parent

# What a thin client needs to install, discover skills/agents/reviewers, connect
# over HTTP MCP, and run the onboarding CLI. Paths are relative to merv/.
INCLUDE = (
    # Platform manifests + MCP configs
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".cursor-plugin/plugin.json",
    ".mcp.json",
    ".mcp.codex.json",
    "mcp.json",
    "gemini-extension.json",
    # Always-on agent context referenced by the manifests
    "GEMINI.md",
    "AGENTS.md",
    "README.md",
    # Codex manifest declares composerIcon: ./assets/icon.svg
    "assets",
    # Hermes uses the canonical skill tree plus a thin setup guide/installer.
    "clients/hermes",
    # Skills + reviewer agents (auto-discovered by every platform)
    "skills",
    "agents",
    # Onboarding and machine-local agent runner (no merv.brain import)
    "bin/merv-client",
    "bin/merv-agent-runner",
    # The portable run watcher every platform backgrounds to get woken
    "bin/merv-runs-wait",
    "src/merv/__init__.py",
    "src/merv/client",
    "src/merv/shared",
    # The one client-useful script: connection conformance probe
    "scripts/mcp_conformance.py",
)

# Belt-and-suspenders: these must never appear in the bundle even if a future
# INCLUDE entry would pull them transitively.
FORBIDDEN_SUBSTRINGS = ("/brain/", "/tests/", "/deploy/", "merv-http")


def forbidden_hit(root_relative: str) -> str | None:
    """Return the forbidden marker a merv/-relative path matches, else None.

    Operates on the path *relative to the plugin root* so the build is unaffected
    by where the checkout physically lives (a clone under /tests/… or a directory
    named merv-http must not poison every file's absolute path)."""
    probe = "/" + root_relative.lstrip("/")
    return next((s for s in FORBIDDEN_SUBSTRINGS if s in probe), None)


def iter_files(rel: str):
    src = MERV_ROOT / rel
    # Symlinks are skipped entirely: a symlink inside an included directory could
    # otherwise resolve to the backend/tests and slip past the path check below.
    if src.is_symlink():
        raise SystemExit(f"build_client_bundle: refusing symlinked source {rel!r}")
    if src.is_file():
        yield src
    elif src.is_dir():
        for path in sorted(src.rglob("*")):
            if path.is_symlink() or "__pycache__" in path.parts:
                continue
            if path.is_file():
                yield path
    else:
        raise SystemExit(f"build_client_bundle: missing source {rel!r}")


def manifest() -> list[str]:
    rels: list[str] = []
    for entry in INCLUDE:
        for path in iter_files(entry):
            rels.append(path.relative_to(MERV_ROOT).as_posix())
    return rels


def build(out: Path) -> int:
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    root = MERV_ROOT.resolve()
    count = 0
    for rel in manifest():
        # Resolve symlinks, confirm the target stays inside the plugin root, then
        # apply the forbidden check to the root-relative path (never the absolute
        # one — the checkout's own location must not affect the result).
        real = (MERV_ROOT / rel).resolve()
        try:
            real_rel = real.relative_to(root).as_posix()
        except ValueError:
            raise SystemExit(f"build_client_bundle: {rel!r} resolves outside the plugin root")
        for probe_rel in (rel, real_rel):
            bad = forbidden_hit(probe_rel)
            if bad:
                raise SystemExit(f"build_client_bundle: {rel!r} matches forbidden {bad!r}")
        dst = out / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(MERV_ROOT / rel, dst)
        count += 1
    print(f"built slim bundle: {count} files -> {out}")
    return count


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=str(MERV_ROOT / "dist" / "plugin"))
    parser.add_argument("--manifest", action="store_true", help="print file list, do not build")
    args = parser.parse_args(argv)
    if args.manifest:
        print("\n".join(manifest()))
        return 0
    build(Path(args.out).resolve())
    return 0


if __name__ == "__main__":
    sys.exit(main())
