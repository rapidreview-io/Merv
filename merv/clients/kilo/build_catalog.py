#!/usr/bin/env python3
"""Build Kilo's versioned remote Agent Skills catalog from canonical skills."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path


MERV_ROOT = Path(__file__).resolve().parents[2]
SKILLS_ROOT = MERV_ROOT / "skills"


def _skill_files(skill_dir: Path) -> list[Path]:
    files: list[Path] = []
    for path in sorted(skill_dir.rglob("*")):
        if path.is_symlink():
            raise SystemExit(f"Kilo catalog refuses symlink: {path}")
        if not path.is_file() or any(part.startswith(".") for part in path.relative_to(skill_dir).parts):
            continue
        files.append(path)
    if skill_dir / "SKILL.md" not in files:
        raise SystemExit(f"Kilo skill is missing SKILL.md: {skill_dir.name}")
    return files


def _version(skill_dir: Path, files: list[Path]) -> str:
    digest = hashlib.sha256()
    for path in files:
        rel = path.relative_to(skill_dir).as_posix()
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def build_catalog(out: Path, *, skills_root: Path = SKILLS_ROOT) -> dict[str, object]:
    """Write a complete catalog, replacing ``out`` only after it is ready."""
    skills: list[dict[str, object]] = []
    out = out.resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{out.name}-", dir=out.parent))
    try:
        for skill_dir in sorted(path for path in skills_root.iterdir() if path.is_dir()):
            if skill_dir.is_symlink() or skill_dir.name.startswith("."):
                continue
            files = _skill_files(skill_dir)
            rels = [path.relative_to(skill_dir).as_posix() for path in files]
            for source, rel in zip(files, rels):
                destination = staging / skill_dir.name / rel
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
            skills.append(
                {
                    "name": skill_dir.name,
                    "version": _version(skill_dir, files),
                    "files": rels,
                }
            )

        catalog: dict[str, object] = {"skills": skills}
        (staging / "index.json").write_text(
            json.dumps(catalog, indent=2) + "\n", encoding="utf-8"
        )
        if out.exists():
            shutil.rmtree(out)
        os.replace(staging, out)
        return catalog
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, help="catalog output directory")
    args = parser.parse_args(argv)
    catalog = build_catalog(Path(args.out))
    print(f"built Kilo catalog: {len(catalog['skills'])} skills -> {Path(args.out).resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
