from __future__ import annotations

import ast
import importlib
import unittest

from tests.paths import TESTS_ROOT

SHARED_FAKE_NAMES = {"FakeProcess"}
CONCERN_PACKAGES = {
    "infrastructure",
    "workflow",
    "surface",
    "state",
    "structure",
}


def _test_sources() -> list[Path]:
    return sorted(TESTS_ROOT.rglob("test_*.py"))


class TestLayoutTest(unittest.TestCase):
    def test_canonical_loader_collects_every_top_level_test(self) -> None:
        for path in _test_sources():
            tree = ast.parse(path.read_text())
            free = {node.name for node in tree.body
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_")}
            if not free:
                continue
            with self.subTest(path=str(path)):
                self.assertTrue(any(isinstance(node, ast.FunctionDef) and node.name == "load_tests"
                                    for node in tree.body), f"Uncollected free tests: {sorted(free)}")
                module = importlib.import_module("tests." + ".".join(path.relative_to(TESTS_ROOT).with_suffix("").parts))
                pending = list(unittest.defaultTestLoader.loadTestsFromModule(module))
                collected = set()
                while pending:
                    case = pending.pop()
                    if isinstance(case, unittest.TestSuite):
                        pending.extend(case)
                    elif isinstance(case, unittest.FunctionTestCase):
                        collected.add(case._testFunc.__name__)
                self.assertLessEqual(free, collected)

    def test_tests_are_grouped_by_concern_packages(self) -> None:
        self.assertEqual(sorted(path.name for path in TESTS_ROOT.glob("test_*.py")), [])
        for package in CONCERN_PACKAGES:
            with self.subTest(package=package):
                path = TESTS_ROOT / package
                self.assertTrue(path.is_dir())
                self.assertTrue((path / "__init__.py").is_file())
                self.assertTrue(list(path.glob("test_*.py")))

    def test_test_modules_do_not_import_other_test_modules(self) -> None:
        for path in _test_sources():
            tree = ast.parse(path.read_text(encoding="utf-8"))
            with self.subTest(path=path.name):
                for node in ast.walk(tree):
                    if isinstance(node, ast.Import):
                        imported = [alias.name for alias in node.names]
                    elif isinstance(node, ast.ImportFrom) and node.module:
                        imported = [node.module]
                    else:
                        continue
                    offenders = [
                        name
                        for name in imported
                        if name.startswith("tests.test_") or name.startswith("test_")
                    ]
                    self.assertEqual(offenders, [])

    def test_shared_fakes_are_declared_only_in_tests_fakes(self) -> None:
        for path in _test_sources():
            tree = ast.parse(path.read_text(encoding="utf-8"))
            with self.subTest(path=path.name):
                declarations = {
                    node.name
                    for node in tree.body
                    if isinstance(node, ast.ClassDef | ast.FunctionDef)
                }
                self.assertEqual(declarations & SHARED_FAKE_NAMES, set())


if __name__ == "__main__":
    unittest.main()
