#!/usr/bin/env python3
"""Build the generated, Git-updatable Hermes plugin from canonical Merv skills."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
from pathlib import Path


MERV_ROOT = Path(__file__).resolve().parents[2]
ADAPTER_ROOT = Path(__file__).resolve().parent
PLUGIN_ROOT = ADAPTER_ROOT / "plugin"
SKILLS_ROOT = MERV_ROOT / "skills"
PLUGIN_FILES = (
    "plugin.yaml",
    "__init__.py",
    "after-install.md",
    "README.md",
    ".github/workflows/sync.yml",
)


def _regular_files(root: Path) -> list[Path]:
    """Return files below *root*, rejecting links and hidden build residue."""
    files: list[Path] = []
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root)
        if path.is_symlink():
            raise SystemExit(f"Hermes bundle refuses symlink: {path}")
        if any(part.startswith(".") or part == "__pycache__" for part in rel.parts):
            continue
        if path.is_file():
            files.append(path)
    return files


def build(
    out: Path,
    *,
    source_revision: str = "unknown",
    skills_root: Path = SKILLS_ROOT,
) -> int:
    """Build a complete plugin, replacing *out* only after validation."""
    out = out.resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{out.name}-", dir=out.parent))
    count = 0
    try:
        for name in PLUGIN_FILES:
            source = PLUGIN_ROOT / name
            if not source.is_file() or source.is_symlink():
                raise SystemExit(f"Hermes plugin source is missing or linked: {source}")
            destination = staging / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            count += 1

        skill_dirs = sorted(path for path in skills_root.iterdir() if path.is_dir())
        if not skill_dirs:
            raise SystemExit("Hermes bundle found no canonical skills")
        for skill_dir in skill_dirs:
            if skill_dir.is_symlink() or skill_dir.name.startswith("."):
                raise SystemExit(f"Hermes bundle refuses skill directory: {skill_dir}")
            files = _regular_files(skill_dir)
            if skill_dir / "SKILL.md" not in files:
                raise SystemExit(f"Hermes skill is missing SKILL.md: {skill_dir.name}")
            for source in files:
                rel = source.relative_to(skill_dir)
                destination = staging / "skills" / skill_dir.name / rel
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
                count += 1

        source_record = {
            "generated": True,
            "source_repository": "https://github.com/rapidreview-io/Merv",
            "source_revision": source_revision,
            "source_path": "merv/clients/hermes",
        }
        (staging / "SOURCE.json").write_text(
            json.dumps(source_record, indent=2) + "\n", encoding="utf-8"
        )
        count += 1

        if out.exists():
            shutil.rmtree(out)
        os.replace(staging, out)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return count


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, help="generated repository root")
    parser.add_argument("--source-revision", default="unknown")
    args = parser.parse_args(argv)
    count = build(Path(args.out), source_revision=args.source_revision)
    print(f"built Hermes plugin: {count} files -> {Path(args.out).resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
