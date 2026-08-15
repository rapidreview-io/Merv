#!/usr/bin/env python3
"""Build the standalone, stdlib-only Merv auto-run archive.

The runner is a separate distribution boundary even though its sources stay in
the monorepo.  This builder copies the exact machine-local closure and turns it
into one executable zipapp; no brain, UI, plugin, or test code can enter it.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import shutil
import tempfile
import zipapp
from pathlib import Path


MERV_ROOT = Path(__file__).resolve().parent.parent
SOURCE_ROOT = MERV_ROOT / "src"
# The plugin's skills ride along as data: the brain's instructions name them
# and auto-run children never see the user's plugin. They land beside the
# harness module that installs them (see merv.client.harness).
SKILLS_ROOT = MERV_ROOT / "skills"
SKILLS_TARGET = "merv/client/skills"

INCLUDE = (
    "merv/__init__.py",
    "merv/client/__init__.py",
    "merv/client/agent_runner.py",
    "merv/client/cli.py",
    "merv/client/harness.py",
    "merv/client/private_files.py",
    "merv/client/runner_entry.py",
    "merv/client/runner_pairing.py",
    "merv/client/storage_upload.py",
    "merv/shared/__init__.py",
    "merv/shared/client_config.py",
    "merv/shared/machine_dirs.py",
    "merv/shared/runner_settings.py",
)


def manifest() -> tuple[str, ...]:
    for relative in INCLUDE:
        path = SOURCE_ROOT / relative
        if not path.is_file() or path.is_symlink():
            raise SystemExit(f"build_runner_bundle: missing regular file {relative!r}")
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=relative)
        if any(
            (
                isinstance(node, ast.Import)
                and any(name.name.startswith("merv.brain") for name in node.names)
            )
            or (
                isinstance(node, ast.ImportFrom)
                and str(node.module or "").startswith("merv.brain")
            )
            for node in ast.walk(tree)
        ):
            raise SystemExit(f"build_runner_bundle: backend import in {relative!r}")
    return INCLUDE


def skill_files() -> tuple[str, ...]:
    """Every skill data file, relative to the plugin ``skills`` directory."""
    if not SKILLS_ROOT.is_dir():
        raise SystemExit("build_runner_bundle: missing plugin skills directory")
    files = tuple(
        sorted(
            str(path.relative_to(SKILLS_ROOT))
            for path in SKILLS_ROOT.rglob("*")
            if path.is_file()
            and not path.is_symlink()
            and "__pycache__" not in path.parts
            and not path.name.startswith(".")
        )
    )
    if not any(Path(item).name == "SKILL.md" for item in files):
        raise SystemExit("build_runner_bundle: plugin skills contain no SKILL.md")
    return files


def build(out: Path) -> Path:
    out = out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    target = out / "merv-runner.pyz"
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        for relative in manifest():
            destination = root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SOURCE_ROOT / relative, destination)
        for relative in skill_files():
            destination = root / SKILLS_TARGET / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SKILLS_ROOT / relative, destination)
        zipapp.create_archive(
            root,
            target=target,
            interpreter="/usr/bin/env python3",
            main="merv.client.runner_entry:main",
            compressed=True,
        )
    target.chmod(0o755)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    (out / "SHA256SUMS").write_text(f"{digest}  {target.name}\n", encoding="utf-8")
    shutil.copy2(MERV_ROOT / "runner" / "install.sh", out / "install.sh")
    print(f"built standalone runner: {target}")
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out")
    parser.add_argument("--manifest", action="store_true")
    args = parser.parse_args()
    if args.manifest:
        print("\n".join(manifest()))
        return 0
    if not args.out:
        parser.error("--out is required unless --manifest is used")
    build(Path(args.out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
