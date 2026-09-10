"""Brain-only architecture laws.

Every tool is served by the control brain, control modules stay free of
checkout-local I/O, and the state store does not know where a repository lives.
"""

from __future__ import annotations

import ast
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Protocol, get_type_hints

from merv.brain.surface.tools.contracts import TOOL_CONTRACTS
from tests.paths import (
    ARTIFACTS_ROOT,
    BACKEND_ROOT,
    DOMAIN_ROOT,
    FEED_ROOT,
    IMPORT_ROOT,
    PORTS_ROOT,
    RESEARCH_CORE_ROOT,
    SERVICES_ROOT,
    SURFACE_ROOT,
)


# Service-shaped glue that must remain cloud-safe and process-free.
GLUE_SERVICE_FILES = (
    *(SERVICES_ROOT / name for name in ("auth.py", "identity.py")),
    BACKEND_ROOT / "application" / "maintenance.py",
)

# Record halves that must be servable from a cloud control plane: no local
# processes, no conn machinery, no dataplane worker.
ARTIFACTS_MODULES = tuple(sorted(ARTIFACTS_ROOT.glob("*.py")))
DOMAIN_MODULES = tuple(sorted(DOMAIN_ROOT.glob("*.py")))
PORT_MODULES = tuple(sorted(PORTS_ROOT.glob("*.py")))

CONTROL_MODULES = (
    *ARTIFACTS_MODULES,
    *DOMAIN_MODULES,
    *PORT_MODULES,
    SURFACE_ROOT / "tools" / "dispatcher.py",
    *sorted(RESEARCH_CORE_ROOT.glob("*.py")),
    *sorted((BACKEND_ROOT / "literature").glob("*.py")),
    BACKEND_ROOT / "application" / "status_guidance.py",
    BACKEND_ROOT / "application" / "experiments" / "presentation.py",
    BACKEND_ROOT / "application" / "workflow.py",
    FEED_ROOT / "feed.py",
    SURFACE_ROOT / "surface.py",
    SURFACE_ROOT / "telemetry.py",
    BACKEND_ROOT / "kernel" / "state" / "store.py",
    BACKEND_ROOT / "kernel" / "state" / "dialects.py",
)

# Module names (any dotted segment) control modules may never import.
CONTROL_FORBIDDEN_SEGMENTS = {
    "dataplane",
    "proxy",
    "sandbox_worker",
    "sandbox_conn",
    "subprocess",
    "workspace",
}


def _imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name.split(".", 1)[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            if node.module == "__future__":
                continue
            modules.add(node.module.split(".", 1)[0])
    return modules


def _import_segments(path: Path) -> set[str]:
    """Every dotted segment of every imported module path.

    Catches relative submodule imports that a top-level-only collector would
    report by parent package only.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"))
    segments: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                segments.update(alias.name.split("."))
        elif isinstance(node, ast.ImportFrom):
            if node.module == "__future__":
                continue
            if node.module:
                segments.update(node.module.split("."))
            for alias in node.names:
                segments.update(alias.name.split("."))
    return segments


def _class_method_names(path: Path, class_name: str) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == class_name:
            return {
                item.name for item in node.body if isinstance(item, ast.FunctionDef)
            }
    raise AssertionError(f"{class_name} not found in {path}")


def _call_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        owner = _call_name(node.value)
        return f"{owner}.{node.attr}" if owner else node.attr
    return ""


def _import_aliases(tree: ast.AST) -> dict[str, str]:
    aliases: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                aliases[alias.asname or alias.name.split(".", 1)[0]] = alias.name
        elif isinstance(node, ast.ImportFrom) and node.module:
            for alias in node.names:
                aliases[alias.asname or alias.name] = f"{node.module}.{alias.name}"
    return aliases


def _resolve_call_name(name: str, aliases: dict[str, str]) -> str:
    if not name:
        return ""
    parts = name.split(".", 1)
    head = aliases.get(parts[0], parts[0])
    return f"{head}.{parts[1]}" if len(parts) == 2 else head


def _literal_args(node: ast.Call) -> list[str]:
    values: list[str] = []
    for arg in node.args:
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            values.append(arg.value)
    return values


def _process_spawn_references(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    aliases = _import_aliases(tree)
    references: set[str] = set()
    spawn_calls = {
        "asyncio.create_subprocess_exec",
        "asyncio.create_subprocess_shell",
        "os.execl",
        "os.execle",
        "os.execlp",
        "os.execlpe",
        "os.execv",
        "os.execve",
        "os.execvp",
        "os.execvpe",
        "os.popen",
        "os.posix_spawn",
        "os.posix_spawnp",
        "os.spawnl",
        "os.spawnle",
        "os.spawnlp",
        "os.spawnlpe",
        "os.spawnv",
        "os.spawnve",
        "os.spawnvp",
        "os.spawnvpe",
        "os.system",
        "subprocess.call",
        "subprocess.check_call",
        "subprocess.check_output",
        "subprocess.Popen",
        "subprocess.run",
    }
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "subprocess":
                    references.add("import subprocess")
        elif isinstance(node, ast.ImportFrom):
            if node.module == "subprocess":
                references.add("from subprocess import ...")
        elif isinstance(node, ast.Call):
            name = _resolve_call_name(_call_name(node.func), aliases)
            if name in spawn_calls:
                references.add(name)
            if name == "__import__" and "subprocess" in _literal_args(node):
                references.add("__import__('subprocess')")
            if name == "importlib.import_module" and "subprocess" in _literal_args(
                node
            ):
                references.add("importlib.import_module('subprocess')")
    return references


def _imports_management_key_adapter(path: Path) -> bool:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.endswith("sandbox.keys"):
                    return True
        elif isinstance(node, ast.ImportFrom) and node.module:
            module = node.module
            if module.endswith("sandbox.keys"):
                return True
            if module.endswith("sandbox") and any(
                alias.name == "keys" for alias in node.names
            ):
                return True
    return False


class BrainToolManifestTest(unittest.TestCase):
    def test_one_valued_plane_abstraction_stays_deleted(self) -> None:
        source = (SURFACE_ROOT / "tools" / "contracts.py").read_text(encoding="utf-8")
        self.assertTrue(TOOL_CONTRACTS)
        for removed in (
            "ToolPlane",
            "def plane(",
            "TOOL_PLANE_REGISTRY",
            "CONTROL_PLANE_TOOL_NAMES",
            "DATA_PLANE_TOOL_NAMES",
            "def tool_plane(",
        ):
            self.assertNotIn(removed, source)


class PlaneImportLintTest(unittest.TestCase):
    def test_infrastructure_is_remote_and_compute_providers_are_absent(self) -> None:
        self.assertFalse((BACKEND_ROOT / "sandbox").exists())
        # Heavy objects live in merv-sandboxes; Merv keeps no ledger component.
        self.assertFalse((BACKEND_ROOT / "object_storage").exists())
        forbidden = {"boto3", "botocore", "modal", "paramiko", "subprocess"}
        for path in (BACKEND_ROOT / "infrastructure").glob("*.py"):
            with self.subTest(module=path.name):
                self.assertFalse(_import_segments(path) & forbidden)

    def test_process_spawn_lint_catches_alias_forms(self) -> None:
        source = """
import os as ops
from os import system as run_cmd
from asyncio import create_subprocess_exec
from importlib import import_module as load

ops.popen("cmd")
run_cmd("cmd")
create_subprocess_exec("cmd")
load("subprocess")
"""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "service.py"
            path.write_text(source, encoding="utf-8")
            self.assertEqual(
                _process_spawn_references(path),
                {
                    "os.popen",
                    "os.system",
                    "asyncio.create_subprocess_exec",
                    "importlib.import_module('subprocess')",
                },
            )

    def test_management_key_adapter_lint_catches_import_forms(self) -> None:
        cases = (
            "import merv.brain.sandbox.keys\n",
            "from merv.brain.sandbox import keys\n",
            "from ..sandbox.keys import LocalMgmtKeyStore\n",
        )
        with tempfile.TemporaryDirectory() as tmp:
            for index, source in enumerate(cases):
                path = Path(tmp) / f"service_{index}.py"
                path.write_text(source, encoding="utf-8")
                with self.subTest(source=source.strip()):
                    self.assertTrue(_imports_management_key_adapter(path))

    def test_only_sandbox_io_modules_spawn_processes(self) -> None:
        # Everything service-shaped is spawn-free; inside the sandbox module
        # only execution/ (provider IO) and keys.py (keygen) may spawn.
        sandbox_record_modules = [
            path
            for path in (BACKEND_ROOT / "sandbox").glob("*.py")
            if path.name != "keys.py"
        ]
        for path in sorted(
            (
                *GLUE_SERVICE_FILES,
                *RESEARCH_CORE_ROOT.rglob("*.py"),
                *FEED_ROOT.rglob("*.py"),
                *sandbox_record_modules,
            )
        ):
            with self.subTest(module=path.name):
                self.assertFalse(
                    _process_spawn_references(path),
                    f"{path.name} references process-spawn APIs",
                )

    def test_control_modules_import_no_local_io(self) -> None:
        # Hard from Phase 3: the record halves must be provably IO-free so the
        # same code can serve from a cloud VM with no checkout, no ssh, and no
        # worker in-process.
        for path in CONTROL_MODULES:
            with self.subTest(module=path.name):
                forbidden = _import_segments(path) & CONTROL_FORBIDDEN_SEGMENTS
                self.assertFalse(
                    forbidden,
                    f"{path.name} imports local-IO modules: {sorted(forbidden)}",
                )

    def test_state_store_knows_no_repo_root(self) -> None:
        # The record store is a records-only component (plan §3.1): local
        # checkout paths do not belong in the brain.
        source = (BACKEND_ROOT / "kernel" / "state" / "store.py").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("repo_root", source)




    def test_checkout_local_diagnostic_adapters_stay_deleted(self) -> None:
        activity = (BACKEND_ROOT / "kernel" / "state" / "activity.py").read_text(
            encoding="utf-8"
        )
        self.assertFalse((BACKEND_ROOT / "kernel" / "state" / "tool_calls.py").exists())
        self.assertFalse((IMPORT_ROOT / "merv" / "shared" / "project_dirs.py").exists())
        self.assertNotIn("class ActivityLogger", activity)
        self.assertNotIn("project_dirs", activity)

    def test_services_package_init_is_import_light(self) -> None:
        self.assertFalse(_imports(SERVICES_ROOT / "__init__.py"))


    def test_brain_checkout_modules_are_absent(self) -> None:
        self.assertFalse((BACKEND_ROOT / "dataplane").exists())
        self.assertFalse((BACKEND_ROOT / "workspace.py").exists())

    def test_artifacts_is_generic_with_research_owned_associations(
        self,
    ) -> None:
        self.assertEqual(
            {
                path.relative_to(ARTIFACTS_ROOT).as_posix()
                for path in ARTIFACTS_ROOT.rglob("*.py")
            },
            {"__init__.py", "artifacts.py", "models.py", "persistence.py", "r2.py", "tools.py"},
        )
        source = (ARTIFACTS_ROOT / "artifacts.py").read_text(encoding="utf-8")
        models = (ARTIFACTS_ROOT / "models.py").read_text(encoding="utf-8")
        imports = _import_segments(ARTIFACTS_ROOT / "artifacts.py")
        composition = (SURFACE_ROOT / "surface.py").read_text(encoding="utf-8")

        self.assertFalse({"research_core", "artifact_roles"} & imports)
        self.assertNotIn("ArtifactTargets", source + models)
        self.assertNotIn("targets=", composition)
        self.assertIn("ResearchArtifacts(", composition)
        for workflow_field in (
            "target_type", "target_id", "role", "attempt_index", "lens_id", "submission_id",
        ):
            self.assertNotIn(f"    {workflow_field}:", models)
        for behavior in (".execute(", ".transaction(", "record_event(", "_blobs"):
            self.assertNotIn(behavior, models)

    def test_surface_is_the_single_composition_root(self) -> None:
        source = (SURFACE_ROOT / "surface.py").read_text(encoding="utf-8")
        self.assertIn("class Surface:", source)
        self.assertIn("app = Surface(", source)
        self.assertNotIn("build_record_core", source)
        self.assertIn("tool_owners = {", source)
        self.assertIn("tool_names = available_tool_names(", source)
        self.assertIn(
            "tracking_enabled=mlflow_tracking is not None",
            source,
        )
        self.assertIn("tool_names=tool_names", source)

    def test_surface_builds_both_deployment_presets(self) -> None:
        path = SURFACE_ROOT / "surface.py"
        source = path.read_text(encoding="utf-8")
        imports = _import_segments(path)
        self.assertIn("class Surface:", source)
        self.assertIn("app = Surface(", source)
        self.assertNotIn("TestBrain", source)
        self.assertNotIn("build_local_runtime", source)
        self.assertIn("RemoteSandboxes", source)
        self.assertIn("build_infrastructure_client", source)
        self.assertNotIn("MgmtKeyStore", source)
        self.assertIn("build_local_server", source)
        self.assertIn("CONTROL_COMPAT_REPO_ROOT", source)
        self.assertNotIn("tempfile", _import_segments(path))




if __name__ == "__main__":
    unittest.main()
