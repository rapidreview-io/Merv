"""Support may carry research work, but it may not speak research.

``docs/MODULE_BOUNDARIES.md`` states the law; this is the executable half.
Every source file in the support packages — Artifacts, Feed, Agent Sessions,
Kernel, the support half of Surface, the client, and shared — is tokenized,
and no identifier, string literal, or SQL table it names may be a research
word.  Storing and echoing an opaque id a packet supplied is fine; naming
what that id means is not.

Comments and docstrings are deliberately outside the law: prose explaining
*why* support carries something research-shaped is how the boundary stays
understandable.  Everything else is code the boundary has to hold.
"""

from __future__ import annotations

import ast
import re
import unittest
from pathlib import Path

from tests.paths import BACKEND_ROOT, CLIENT_ROOT, IMPORT_ROOT, SHARED_ROOT
from tests.structure.test_module_boundaries import (
    FOREIGN_SQL_TABLE_REF,
    RESEARCH_ROUTERS,
    RESEARCH_TABLES,
)

RESEARCH_WORD = re.compile(
    r"experiment|reflection|consolidat|reviewer|\bclaim\b|\blens\b|\bcandidate\b"
)

SUPPORT_ROOTS = (
    BACKEND_ROOT / "artifacts",
    BACKEND_ROOT / "feed",
    BACKEND_ROOT / "agent_sessions",
    BACKEND_ROOT / "kernel",
    BACKEND_ROOT / "surface",
    CLIENT_ROOT,
    SHARED_ROOT,
)

# Research files that live inside Surface's delivery tree: the science
# reaching HTTP, classified as Research in test_module_boundaries.
RESEARCH_FILES = frozenset(
    {
        "brain/surface/experiment_figure.py",
        "brain/surface/workflow_knowledge.py",
        *(f"brain/surface/transport/api/{name}.py" for name in RESEARCH_ROUTERS),
    }
)

# Files the law cannot reach, each for a reason it cannot state generically.
UNSCANNED = {
    "brain/surface/surface.py": (
        "the composition root: naming every owner and wiring them to each "
        "other is the whole job of the file"
    ),
    "brain/surface/transport/api/app.py": (
        "the router assembly: it mounts every router by name, the research "
        "ones included"
    ),
    "brain/surface/tools/mlflow_contracts.py": (
        "frozen MLflow integration text, moved verbatim from the suspended "
        "adapter; MLflow is the named exception to the component law"
    ),
}

# (file, word) pairs a support file may still carry, and why each survives.
ALLOWED_WORDS = {
    ("brain/artifacts/tools.py", "lens"): (
        "`lens_id` is a public wire field of artifact.upload and a column "
        "behind it; the value is opaque to Artifacts, but the field name is a "
        "contract every agent and runner already sends"
    ),
    ("brain/surface/artifacts.py", "lens"): (
        "the wire shapes that relay `lens_id` between that field and the "
        "association API, without reading it"
    ),
    ("shared/client_config.py", "experiments"): (
        "experiments.rapidreview.io is the hosted brain's DNS name — a "
        "deployment fact, not vocabulary"
    ),
}

_CHUNK = re.compile(r"[A-Za-z0-9]+")
_WORD = re.compile(r"[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+")


def _words(text: str) -> set[str]:
    """Every word in an identifier or a string, however it is spelled.

    Splits on punctuation and on camelCase so ``WebPreviewError`` is three
    words and ``experiment_workspaces`` is two: a law that matched raw
    substrings would both miss ``Claim`` and flag ``PreviewError``.
    """
    return {
        word.lower()
        for chunk in _CHUNK.findall(text)
        for word in _WORD.findall(chunk)
    }


def _support_files() -> list[tuple[str, Path]]:
    files = []
    for root in SUPPORT_ROOTS:
        for path in sorted(root.rglob("*.py")):
            if "__pycache__" in path.parts:
                continue
            rel = path.relative_to(IMPORT_ROOT / "merv").as_posix()
            if rel in RESEARCH_FILES or rel in UNSCANNED:
                continue
            files.append((rel, path))
    return files


def _spoken_words(tree: ast.AST) -> list[tuple[int, str, str]]:
    """Every identifier and non-docstring string a module says, with its line."""
    docstrings = {
        id(owner.body[0].value)
        for owner in ast.walk(tree)
        if isinstance(
            owner, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)
        )
        and owner.body
        and isinstance(owner.body[0], ast.Expr)
        and isinstance(owner.body[0].value, ast.Constant)
        and isinstance(owner.body[0].value.value, str)
    }
    spoken: list[tuple[int, str, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            text = node.id
        elif isinstance(node, ast.Attribute):
            text = node.attr
        elif isinstance(node, ast.arg):
            text = node.arg
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            text = node.name
        elif isinstance(node, ast.keyword) and node.arg:
            text = node.arg
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            if id(node) in docstrings:
                continue
            text = node.value
        else:
            continue
        for word in _words(text):
            if RESEARCH_WORD.search(word):
                spoken.append((getattr(node, "lineno", 0), word, text[:80]))
    return spoken


class SupportVocabularyTest(unittest.TestCase):
    def test_support_never_speaks_a_research_word(self) -> None:
        offenders: list[str] = []
        for rel, path in _support_files():
            for lineno, word, text in _spoken_words(
                ast.parse(path.read_text(encoding="utf-8"))
            ):
                if (rel, word) in ALLOWED_WORDS:
                    continue
                offenders.append(f"{rel}:{lineno} says {word!r} in {text!r}")
        self.assertFalse(
            offenders,
            "support names a research record; research declares and support "
            "enforces, so the name belongs to its owner and the value reaches "
            "support opaquely: " + ", ".join(sorted(set(offenders))),
        )

    def test_support_sql_never_names_a_research_table(self) -> None:
        """Support stores and echoes what research hands it; it never joins to
        research's own records, not even in a migration."""
        offenders: list[str] = []
        for rel, path in _support_files():
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                if not (isinstance(node, ast.Constant) and isinstance(node.value, str)):
                    continue
                for match in FOREIGN_SQL_TABLE_REF.finditer(node.value):
                    if match.group(1).lower() in RESEARCH_TABLES:
                        offenders.append(f"{rel}:{node.lineno} names {match.group(1)}")
        self.assertFalse(
            offenders,
            "support SQL names a research table; the owning component must "
            "supply the query at composition: " + ", ".join(sorted(set(offenders))),
        )

    def test_every_exemption_is_still_earning_its_place(self) -> None:
        """An allowlist that outlives its hit is a claim nobody checks."""
        scanned = {rel for rel, _ in _support_files()}
        for rel in sorted(UNSCANNED):
            with self.subTest(unscanned=rel):
                self.assertTrue((IMPORT_ROOT / "merv" / rel).is_file())
        spoken = {
            (rel, word)
            for rel, path in _support_files()
            for _, word, _ in _spoken_words(ast.parse(path.read_text(encoding="utf-8")))
        }
        stale = sorted(set(ALLOWED_WORDS) - spoken)
        self.assertFalse(
            stale,
            "the word is gone; DELETE the allowlist entry: "
            + ", ".join(f"{rel} {word}" for rel, word in stale),
        )
        self.assertFalse(
            sorted(rel for rel, _ in ALLOWED_WORDS if rel not in scanned),
            "an allowlist entry names a file the scan does not read",
        )

    def test_the_scanner_reads_code_and_not_prose(self) -> None:
        source = (
            '"""A docstring may explain the experiment it carries."""\n'
            "# so may a comment about reflections\n"
            "class WebPreviewError(Exception):\n"
            "    pass\n"
            "lens_id = ''\n"
            "Claim = 1\n"
            "table = 'SELECT id FROM agent_workspaces'\n"
        )
        self.assertEqual(
            sorted(word for _, word, _ in _spoken_words(ast.parse(source))),
            ["claim", "lens"],
        )


if __name__ == "__main__":
    unittest.main()
