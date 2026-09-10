from __future__ import annotations

import ast
import re
import unittest
from collections import Counter
from pathlib import Path
from typing import Protocol

from tests.paths import (
    ARTIFACTS_ROOT,
    BACKEND_ROOT,
    FEED_ROOT,
    PLUGIN_ROOT,
    PORTS_ROOT,
    RESEARCH_CORE_ROOT,
    SERVICES_ROOT,
    SURFACE_ROOT,
)

ROOT = PLUGIN_ROOT
SERVICES = SERVICES_ROOT

GLUE_SERVICE_FILES = (
    *(SERVICES_ROOT / name for name in ("auth.py", "identity.py")),
    BACKEND_ROOT / "application" / "maintenance.py",
)
RESEARCH_CORE = RESEARCH_CORE_ROOT
UI_SRC = PLUGIN_ROOT.parent / "research_state_ui" / "src"
HTTP_TRANSPORT_MODULES = (
    SURFACE_ROOT / "transport" / "feed_http.py",
    SURFACE_ROOT / "transport" / "mcp_http.py",
    *sorted((SURFACE_ROOT / "transport" / "api").glob("*.py")),
)
HTTP_API_APP = SURFACE_ROOT / "transport" / "api" / "app.py"
HTTP_API_GATEWAY = SURFACE_ROOT / "transport" / "api" / "gateway.py"
HTTP_API_VIEWS = SURFACE_ROOT / "transport" / "api" / "views.py"
HTTP_API_PACKAGE = SURFACE_ROOT / "transport" / "api"

_CONTROL_APP_SCAN_EXCLUSIONS = {
    "config.py",
    "surface.py",
    "transport/http_server.py",
}
CONTROL_APP_SCAN_MODULES = tuple(
    path
    for path in sorted(SURFACE_ROOT.rglob("*.py"))
    if not path.relative_to(SURFACE_ROOT).as_posix().startswith("composition/")
    and path.relative_to(SURFACE_ROOT).as_posix() not in _CONTROL_APP_SCAN_EXCLUSIONS
)

# Exact, line-independent debt ledgers for the remaining whole-Surface HTTP
# seams. Counter keys deliberately identify a file and top-level collaborator,
# not a line number, so harmless formatting does not churn the baseline. Both
# ledgers are shrinking: a new entry is a regression, while a removed entry
# fails with an instruction to delete the now-stale baseline debt.
RAW_CONTROL_APP_ACCESS_BASELINE: Counter[tuple[str, str]] = Counter()
WHOLE_CONTROL_APP_CARRIER_BASELINE: Counter[tuple[str, str]] = Counter()

_RAW_CONTROL_APP_COLLABORATORS = {
    "artifacts",
    "experiments",
    "feed",
    "projects",
    "resources",
    "reviews",
    "sandboxes",
    "storage",
    "store",
    "tool_calls",
}


def _source(name: str) -> str:
    return (SERVICES / name).read_text(encoding="utf-8")


def _sandbox_source(name: str) -> str:
    return (BACKEND_ROOT / "sandbox" / name).read_text(encoding="utf-8")


def _rc_source(name: str) -> str:
    return (RESEARCH_CORE / name).read_text(encoding="utf-8")


def _api_app_source() -> str:
    return HTTP_API_APP.read_text(encoding="utf-8")


def _http_gateway_source() -> str:
    return HTTP_API_GATEWAY.read_text(encoding="utf-8")


def _api_views_source() -> str:
    return HTTP_API_VIEWS.read_text(encoding="utf-8")


def _api_package_source() -> str:
    return "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted(HTTP_API_PACKAGE.glob("*.py"))
    )


def _artifacts_source(name: str) -> str:
    return (ARTIFACTS_ROOT / name).read_text(encoding="utf-8")


def _import_modules(name: str) -> set[str]:
    return {module.split(".", 1)[0] for module in _import_module_names(SERVICES / name)}


def _import_module_names(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            if node.module == "__future__":
                continue
            modules.add(node.module)
    return modules


def _import_segments(path: Path) -> set[str]:
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


def _assigned_names(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names: set[str] = set()

    def collect(target: ast.expr) -> None:
        if isinstance(target, ast.Name):
            names.add(target.id)
        elif isinstance(target, (ast.Tuple, ast.List)):
            for item in target.elts:
                collect(item)

    for node in ast.walk(tree):
        targets: list[ast.expr] = []
        if isinstance(node, ast.Assign):
            targets = list(node.targets)
        elif isinstance(node, ast.AnnAssign):
            targets = [node.target]
        elif isinstance(node, ast.AugAssign):
            targets = [node.target]
        for target in targets:
            collect(target)
    return names


def _attribute_chain(node: ast.AST) -> tuple[str, ...] | None:
    if isinstance(node, ast.Name):
        return (node.id,)
    if isinstance(node, ast.Attribute):
        owner = _attribute_chain(node.value)
        return (*owner, node.attr) if owner is not None else None
    return None


def _call_name(node: ast.Call) -> str | None:
    if isinstance(node.func, ast.Name):
        return node.func.id
    if isinstance(node.func, ast.Attribute):
        return node.func.attr
    return None


def _surface_relative(path: Path) -> str:
    return path.relative_to(SURFACE_ROOT).as_posix()


def _whole_app_locals(tree: ast.AST) -> set[str]:
    """Names assigned a whole app, including one-hop local aliases."""
    names: set[str] = set()
    changed = True
    while changed:
        changed = False
        for node in ast.walk(tree):
            if not isinstance(node, (ast.Assign, ast.AnnAssign)):
                continue
            if not _is_whole_app_receiver(node.value, local_names=names):
                continue
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Name) and target.id not in names:
                    names.add(target.id)
                    changed = True
    return names


def _is_whole_app_receiver(node: ast.AST, *, local_names: set[str]) -> bool:
    chain = _attribute_chain(node)
    if chain in {
        ("api", "app"),
        ("ctx", "api", "app"),
        ("self", "app"),
        ("self", "backend"),
    }:
        return True
    if isinstance(node, ast.Name) and node.id in local_names:
        return True
    return isinstance(node, ast.Call) and _call_name(node) in {
        "app_for",
        "app_for_project",
    }


def _raw_control_app_accesses() -> Counter[tuple[str, str]]:
    accesses: Counter[tuple[str, str]] = Counter()
    for path in CONTROL_APP_SCAN_MODULES:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        local_names = _whole_app_locals(tree)
        relative = _surface_relative(path)
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Attribute)
                and node.attr in _RAW_CONTROL_APP_COLLABORATORS
                and _is_whole_app_receiver(node.value, local_names=local_names)
            ):
                accesses[(relative, node.attr)] += 1
    return accesses


def _whole_control_app_carriers() -> Counter[tuple[str, str]]:
    carriers: Counter[tuple[str, str]] = Counter()
    for path in CONTROL_APP_SCAN_MODULES:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        relative = _surface_relative(path)
        local_names = _whole_app_locals(tree)
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                call_name = _call_name(node) or "<call>"
                if call_name in {"app_for", "app_for_project"}:
                    carriers[(relative, f"{call_name}(...)")] += 1
                for keyword in node.keywords:
                    if not (
                        _is_whole_app_receiver(
                            keyword.value, local_names=local_names
                        )
                        or isinstance(keyword.value, ast.Name)
                        and keyword.value.id == "app"
                    ):
                        continue
                    value = ast.unparse(keyword.value)
                    expression = f"{call_name}({keyword.arg or '**'}={value})"
                    if call_name == "ToolInvocationGateway":
                        expression = f"backend={value}"
                    carriers[(relative, expression)] += 1
                for argument in node.args:
                    if _is_whole_app_receiver(argument, local_names=local_names):
                        carriers[(relative, f"{call_name}({ast.unparse(argument)})")] += 1
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = (
                    node.targets if isinstance(node, ast.Assign) else [node.target]
                )
                if any(
                    _attribute_chain(target) == ("self", "app")
                    for target in targets
                ):
                    carriers[(relative, f"self.app={ast.unparse(node.value)}")] += 1
                elif _attribute_chain(node.value) in {
                    ("api", "app"),
                    ("ctx", "api", "app"),
                    ("self", "app"),
                    ("self", "backend"),
                }:
                    for target in targets:
                        carriers[
                            (relative, f"{ast.unparse(target)}={ast.unparse(node.value)}")
                        ] += 1
            elif isinstance(node, ast.Return):
                chain = _attribute_chain(node.value) if node.value is not None else None
                if chain in {
                    ("api", "app"),
                    ("ctx", "api", "app"),
                    ("self", "app"),
                    ("self", "backend"),
                }:
                    carriers[(relative, f"return {'.'.join(chain)}")] += 1
    return carriers


def _format_counter(counter: Counter[tuple[str, str]]) -> str:
    return ", ".join(
        f"{path}: {name} x{count}"
        for (path, name), count in sorted(counter.items())
    )


VOCABULARY_NAMES = {
    "CLAIM_CONFIDENCES",
    "CLAIM_STATUSES",
    "EXPERIMENT_ACTIVE_PROCESS_STATUSES",
    "EXPERIMENT_TERMINAL_STATUSES",
    "GATED_ROLES",
    "GATED_ROLE_BYTE_CAPS",
    "LEGACY_PROJECT_GRAPH_ROLE",
    "LEGACY_PROPOSALS_ROLE",
    "LEGACY_REFLECTION_DOC_ROLE",
    "LEGACY_REFLECTION_LENS_DOC_ROLE",
    "LEGACY_RESOURCE_ROLES",
    "PROJECT_GRAPH_ROLE",
    "PROJECT_GRAPH_ROLES",
    "REFLECTION_LENS_DOC_ROLE",
    "REFLECTION_LENS_DOC_ROLES",
    "RESOURCE_ROLES",
    "RESOURCE_TARGET_TYPES",
    "REVIEW_ROLE_VALUES",
    "REVIEW_ROLES",
    "REVIEW_VERDICT_VALUES",
    "REVIEW_VERDICTS",
}

class ServiceLayoutTest(unittest.TestCase):
    def test_http_policy_is_fastapi_free(self) -> None:
        imports = _import_module_names(SURFACE_ROOT / "transport" / "http_policy.py")

        self.assertEqual(imports, {"dataclasses"})

    def test_ports_are_neutral_and_outside_services(self) -> None:
        expected_imports = {
        }
        for name, allowed_imports in expected_imports.items():
            with self.subTest(module=name):
                self.assertFalse((SERVICES / name).exists())
                self.assertTrue((PORTS_ROOT / name).exists())
                self.assertEqual(
                    _import_module_names(PORTS_ROOT / name),
                    allowed_imports,
                )
                source = (PORTS_ROOT / name).read_text(encoding="utf-8")
                for forbidden in ("httpx", "sqlite3", "json", "tempfile", "os."):
                    self.assertNotIn(forbidden, source)
        self.assertFalse((PORTS_ROOT / "project_readers.py").exists())
        self.assertFalse((PORTS_ROOT / "reflection_waves.py").exists())
        self.assertFalse((PORTS_ROOT / "review_targets.py").exists())
        self.assertFalse((PORTS_ROOT / "workflow_readers.py").exists())
        # The resource-observation port died with the resource system.
        self.assertFalse((PORTS_ROOT / "resource_records.py").exists())
        self.assertFalse((PORTS_ROOT / "sandbox_worker.py").exists())
        self.assertFalse((PORTS_ROOT / "task_channel.py").exists())
        self.assertFalse((PORTS_ROOT / "reflection_writers.py").exists())

    def test_auto_sync_poller_is_removed(self) -> None:
        local_source = (BACKEND_ROOT / "infrastructure" / "sandboxes.py").read_text()
        http_source = _api_package_source()
        api_source = (UI_SRC / "api.js").read_text(encoding="utf-8")
        components = UI_SRC / "components"

        self.assertFalse((BACKEND_ROOT / "sandbox" / "sandbox_autosync.py").exists())
        self.assertFalse((components / "ExperimentSyncIndicator.jsx").exists())
        self.assertFalse((components / "ExperimentSyncDetailsModal.jsx").exists())
        self.assertNotIn("run_auto_sync_target", local_source)
        self.assertNotIn("_auto_sync_loop", local_source)
        self.assertNotIn("auto_sync_thread", local_source)
        self.assertNotIn("RESEARCH_PLUGIN_SANDBOX_AUTO_RSYNC", local_source)
        self.assertNotIn("RESEARCH_PLUGIN_SANDBOX_RSYNC_INTERVAL", local_source)
        for source in (http_source, api_source):
            self.assertNotIn("/sandbox/sync", source)
            self.assertNotIn("syncSandbox", source)
        for path in components.glob("*.jsx"):
            source = path.read_text(encoding="utf-8")
            self.assertNotIn("sandbox.rsynced", source)
            self.assertNotIn("sandbox.synced", source)
            self.assertNotIn("sandbox.rsync_error", source)
            self.assertNotIn("initial_rsynchronized", source)

    def test_artifacts_never_read_checkout_paths(self) -> None:
        # The brain never reads a checkout: every consumed byte arrives via the
        # token-bearer upload PUT.
        source = _artifacts_source("artifacts.py")
        imports = _import_segments(ARTIFACTS_ROOT / "artifacts.py")

        for local_read in ("open(", ".read_bytes(", ".read_text("):
            self.assertNotIn(local_read, source)
        for local_context in ("repo_root", "self.workspace", "observe_file"):
            self.assertNotIn(local_context, source)
        self.assertFalse({"pathlib", "tempfile"} & imports)

    def test_feed_service_does_not_read_workspace_media(self) -> None:
        source = (FEED_ROOT / "feed.py").read_text(encoding="utf-8")

        self.assertNotIn("resolve_repo_relative_file", source)
        self.assertNotIn(".read_bytes(", source)
        self.assertNotIn("workspace", source)

    def test_feed_schema_stays_out_of_business_logic(self) -> None:
        core_source = (FEED_ROOT / "feed.py").read_text(encoding="utf-8")
        persistence_source = (FEED_ROOT / "persistence.py").read_text(encoding="utf-8")
        self.assertNotIn("CREATE TABLE", core_source)
        self.assertIn("CREATE TABLE IF NOT EXISTS posts", persistence_source)
        self.assertIn(
            "CREATE TABLE IF NOT EXISTS feed_upload_tokens", persistence_source
        )

    def test_feed_documentation_is_bounded_and_required_by_sources(self) -> None:
        documentation = FEED_ROOT / "feed.md"
        self.assertLessEqual(
            len(documentation.read_text(encoding="utf-8").splitlines()),
            100,
            "feed.md must remain at most 100 lines",
        )
        maintenance_header = (
            "# If you update this file, you must consult feed.md to see whether "
            "feed.md needs to be updated. feed.md must not exceed 100 lines."
        )
        for path in sorted(FEED_ROOT.glob("*.py")):
            with self.subTest(path=path.name):
                self.assertEqual(
                    path.read_text(encoding="utf-8").splitlines()[0],
                    maintenance_header,
                )

    def test_utils_stays_free_of_local_path_guards(self) -> None:
        path = BACKEND_ROOT / "kernel" / "utils.py"
        self.assertEqual(
            _import_module_names(path),
            {"datetime", "uuid", "merv.shared.errors"},
        )
        source = path.read_text(encoding="utf-8")
        self.assertNotIn("resolve_repo_relative_file", source)
        self.assertNotIn("pathlib", source)
        self.assertNotIn("os.path", source)

    def test_kernel_error_reexports_preserve_shared_identity(self) -> None:
        from merv.brain.kernel import utils as kernel_utils
        from merv.shared import errors as shared_errors

        for name in (
            "ResearchPluginError",
            "NotFoundError",
            "PermissionDeniedError",
            "ValidationError",
            "WorkflowError",
            "ContentUnavailableError",
        ):
            with self.subTest(error=name):
                self.assertIs(getattr(kernel_utils, name), getattr(shared_errors, name))

    def test_iso_parsing_is_single_sourced(self) -> None:
        for path in sorted(BACKEND_ROOT.rglob("*.py")):
            if path.name == "utils.py":
                continue
            with self.subTest(module=path.relative_to(BACKEND_ROOT).as_posix()):
                self.assertNotIn(
                    "fromisoformat",
                    path.read_text(encoding="utf-8"),
                )

    def test_iso_formatting_is_single_sourced(self) -> None:
        for path in sorted(BACKEND_ROOT.rglob("*.py")):
            if path.name == "utils.py":
                continue
            source = path.read_text(encoding="utf-8")
            with self.subTest(module=path.relative_to(BACKEND_ROOT).as_posix()):
                self.assertNotIn('replace("+00:00", "Z")', source)
                self.assertNotIn("replace('+00:00', 'Z')", source)
                self.assertIsNone(
                    re.search(r"datetime\.now\([^)]*UTC[^)]*\)\.isoformat\(", source)
                )

    def test_env_coercion_is_single_sourced(self) -> None:
        # logging is allowed for the one-per-process legacy-env deprecation
        # warning, and the shared error vocabulary so a strictly parsed flag
        # (env_bool_strict) can refuse a misspelling by name instead of
        # coercing it to the risky answer. The kernel resolver must otherwise
        # stay dependency-free — merv.shared.errors imports nothing itself.
        self.assertEqual(
            _import_module_names(BACKEND_ROOT / "kernel" / "env.py"),
            {"collections.abc", "logging", "merv.shared.errors", "os"},
        )
        for path in sorted(BACKEND_ROOT.rglob("*.py")):
            if path.name == "env.py":
                continue
            source = path.read_text(encoding="utf-8")
            with self.subTest(module=path.relative_to(BACKEND_ROOT).as_posix()):
                self.assertNotIn("def env_flag", source)
                self.assertNotIn("def env_float", source)
                self.assertNotIn(
                    'RESEARCH_PLUGIN_ACTIVITY_STDERR", "").lower()', source
                )
                self.assertNotIn(
                    'RESEARCH_PLUGIN_SANDBOX_REAPER", "1").lower()', source
                )
                self.assertNotIn(
                    'RESEARCH_PLUGIN_SANDBOX_AUTO_RSYNC", "1").lower()',
                    source,
                )


    def test_services_type_against_base_state_store(self) -> None:
        concrete_store_names = {"StateStore"}
        sandbox_record_modules = [
            path
            for path in (BACKEND_ROOT / "sandbox").glob("*.py")
            if path.name != "__init__.py"
        ]
        for path in sorted(
            (
                *GLUE_SERVICE_FILES,
                *RESEARCH_CORE.rglob("*.py"),
                *FEED_ROOT.rglob("*.py"),
                *sandbox_record_modules,
            )
        ):
            if path.name == "__init__.py":
                continue
            with self.subTest(module=path.name):
                tree = ast.parse(path.read_text(encoding="utf-8"))
                for node in ast.walk(tree):
                    if isinstance(node, ast.Import):
                        for alias in node.names:
                            module = alias.name.split(".")
                            self.assertFalse(
                                module[-2:] == ["state", "store"]
                                or module[-1:] == ["state"],
                                "services should not import concrete state modules",
                            )
                        continue
                    if isinstance(node, ast.ImportFrom):
                        imported = {alias.name for alias in node.names}
                        module = node.module.split(".") if node.module else []
                        if "state" in imported and (
                            not module or module[-1] in {"merv", "brain", "kernel"}
                        ):
                            self.fail(
                                "services should not import the state package directly"
                            )
                        if not node.module:
                            continue
                        module = node.module.split(".")
                        if not (
                            module[-2:] == ["state", "store"]
                            or module[-1:] == ["state"]
                        ):
                            continue
                        self.assertNotIn(
                            "*",
                            imported,
                            "services should not star-import state modules",
                        )
                        self.assertNotIn(
                            "store",
                            imported,
                            "services should not import the concrete store module",
                        )
                        concrete = concrete_store_names & imported
                        self.assertFalse(
                            concrete,
                            "services should type store dependencies against BaseStateStore",
                        )

    def test_store_contract_uses_neutral_connection_types(self) -> None:
        source = (BACKEND_ROOT / "kernel" / "state" / "store.py").read_text(
            encoding="utf-8"
        )
        # The row/cursor/connection protocols every component's persistence
        # module types against live beside them, in the schema registration
        # API, not in the SQLite dialect's own file.
        contract = (BACKEND_ROOT / "kernel" / "state" / "schema.py").read_text(
            encoding="utf-8"
        )
        base_source = source[
            source.index("class BaseStateStore:") : source.index("class StateStore(")
        ]
        self.assertIn("class Row(Protocol)", contract)
        self.assertIn("class ResultCursor(Protocol)", contract)
        self.assertIn("class Connection(Protocol)", contract)
        self.assertIn("def connect(self) -> Connection:", base_source)
        self.assertIn("def transaction(self) -> Iterator[Connection]:", base_source)
        self.assertIn("parameters: Sequence[Any] = ()", contract)
        self.assertIn("def __enter__(self) -> Connection:", contract)
        self.assertIn("tb: TracebackType | None", contract)
        self.assertNotIn("sqlite3.", base_source)
        self.assertIn("def next_created_seq(*, conn: Connection", source)
        self.assertIn("row: Row | Mapping[str, Any] | None", source)

        from merv.brain.kernel.state.store import Connection, ResultCursor, Row

        for protocol in (Row, ResultCursor, Connection):
            self.assertIn(Protocol, protocol.__mro__)

    def test_control_services_do_not_leak_sqlite_connection_types(self) -> None:
        for path in (
            ARTIFACTS_ROOT / "artifacts.py",
        ):
            with self.subTest(module=path.name):
                source = path.read_text(encoding="utf-8")
                self.assertNotIn("sqlite3.Connection", source)
                self.assertNotIn("sqlite3.Row", source)
                self.assertNotIn("import sqlite3", source)

    def test_sandbox_lifecycle_uses_the_standard_dispatcher(self) -> None:
        source = _http_gateway_source()
        self.assertNotIn("hosted_control_sandbox_lookup", source)
        self.assertIn("return self.tools.call_tool(", source)
        self.assertNotIn("run=lambda: self.sandboxes.get(", source)

    def test_http_surface_policy_keeps_mode_decisions_named(self) -> None:
        source = _api_app_source()
        policy_source = (SURFACE_ROOT / "transport" / "http_policy.py").read_text(
            encoding="utf-8"
        )

        self.assertNotIn("class _HttpSurfacePolicy", source)
        self.assertIn("surface_policy: HttpSurfacePolicy | None = None", source)
        self.assertIn(
            "surface = surface_policy or HttpSurfacePolicy.for_surface(", source
        )
        control_source = (SURFACE_ROOT / "surface.py").read_text(encoding="utf-8")
        self.assertIn("surface_policy=surface", control_source)
        for decision in (
            "CONTROL_RESTRICT_CORS_ENV_VAR",
            "hosted_control=True",
        ):
            with self.subTest(decision=decision):
                self.assertIn(decision, control_source)
        for removed_decision in (
            "CONTROL_REQUIRE_AUTH_ENV_VAR",
            "expose_local_data_plane",
            "accept_repo_root_context",
            "allow_data_plane_tool_calls",
            "require_bearer_auth",
            "require_privileged_bearer_auth",
            "enforce_project_scope",
        ):
            with self.subTest(removed_decision=removed_decision):
                self.assertNotIn(removed_decision, control_source)
        control_builder = control_source[
            control_source.index("def _control_http_surface(") :
        ]
        self.assertNotIn("auth is not None", control_builder)
        self.assertNotIn("auth is None", control_builder)
        self.assertIn("class HttpSurfacePolicy", policy_source)
        self.assertIn("def for_surface(", policy_source)
        self.assertNotIn("for_auth_present", source)
        self.assertNotIn("for_auth_present", policy_source)
        self.assertNotIn("auth_required", source)
        for field_name in ("restrict_cors", "hosted_control"):
            with self.subTest(field_name=field_name):
                self.assertIn(field_name, policy_source)
        self.assertNotIn("require_bearer_auth", policy_source)
        self.assertNotIn("require_privileged_bearer_auth", policy_source)
        self.assertNotIn("enforce_project_scope", policy_source)

    def test_http_transport_does_not_carry_interim_project_scope_gate(self) -> None:
        source = _api_package_source()

        self.assertNotIn(".store.require_project_id(", source)
        self.assertNotIn(".store.transaction(", source)
        self.assertNotIn("def require_project_scope(", source)
        self.assertNotIn("target.app.projects.require_project_scope(", source)
        self.assertNotIn("project_ids_for_tenant", source)

    def test_hosted_tool_metadata_and_producer_binding_are_contract_declared(
        self,
    ) -> None:
        # Per-tool hosted policy, provenance, transport injection and caller
        # binding moved onto the ToolContract each owner declares: http_policy
        # keeps generic policy and the session baselines, and the gateway names
        # no tool to resolve any of them.
        source = _http_gateway_source()
        policy_source = (SURFACE_ROOT / "transport" / "http_policy.py").read_text(
            encoding="utf-8"
        )
        from merv.brain.surface.tools.contracts import TOOL_MANIFEST

        self.assertEqual(
            {
                name: tool.telemetry_scope_field
                for name, tool in TOOL_MANIFEST.items()
                if tool.telemetry_scope_field
            },
            {
                "review.start": "review_request_id",
                "review.submit": "review_session_id",
            },
        )
        self.assertEqual(
            {
                name: tool.binds_producer_session
                for name, tool in TOOL_MANIFEST.items()
                if tool.binds_producer_session
            },
            {"consolidation.submit": "agent", "review.request": "session"},
        )
        self.assertEqual(
            {name for name, tool in TOOL_MANIFEST.items() if tool.binds_capability},
            {"review.start"},
        )
        self.assertEqual(
            {name for name, tool in TOOL_MANIFEST.items() if tool.needs_base_url},
            {
                "artifact.upload", "artifact.read", "feed.post",
                "storage.submit", "sandbox.runs",
            },
        )
        self.assertEqual(
            {name for name, tool in TOOL_MANIFEST.items() if tool.needs_wait_secret},
            {"sandbox.runs"},
        )
        self.assertEqual(
            {
                name: tool.binds_caller_project
                for name, tool in TOOL_MANIFEST.items()
                if tool.binds_caller_project
            },
            {"project": "key_project_id", "project.list": "project_id"},
        )
        self.assertEqual(
            {
                name: tool.external_key_denied_action
                for name, tool in TOOL_MANIFEST.items()
                if tool.external_key_denied_action
            },
            {"project": "create"},
        )
        # workflow.transition, the sandbox. prefix and the agent.hello constant
        # are the only tool names the gateway is allowed to know.
        named = set(re.findall(r'"([a-z_]+\.[a-z_]+)"', source)) - {
            "context.repo_root"
        }
        self.assertEqual(named, {"workflow.transition"})
        self.assertNotIn("tenant_id_fallback", policy_source)
        self.assertNotIn("HostedToolPolicy", policy_source + source)
        self.assertNotIn("consolidation", source)
        for tool_name in ("review.start", "review.submit"):
            self.assertNotIn(f'"{tool_name}": ', policy_source)
            self.assertNotIn(
                f'if surface.hosted_control and name == "{tool_name}"', source
            )
        self.assertEqual(source.count("self.research.review_project_id("), 1)
        self.assertNotIn("SELECT project_id FROM review_requests", source)

    def test_http_data_plane_capabilities_stay_retired(self) -> None:
        # The resource-registration browser capabilities died with the
        # resource system; the policy table must not grow back.
        route_source = _api_package_source()
        policy_source = (SURFACE_ROOT / "transport" / "http_policy.py").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("HTTP_DATA_PLANE_FEATURE_TO_TOOL", policy_source)
        self.assertNotIn("data_plane_http_capabilities", route_source)
        self.assertNotIn("require_data_plane_for_http", route_source)

    def test_mcp_http_routes_are_shared_by_local_and_control(self) -> None:
        source = _api_app_source()
        mcp_source = (SURFACE_ROOT / "transport" / "mcp_http.py").read_text(
            encoding="utf-8"
        )

        self.assertEqual(
            _import_module_names(SURFACE_ROOT / "transport" / "mcp_http.py"),
            {
                "collections.abc",
                "json",
                "typing",
                "fastapi",
                "fastapi.concurrency",
                "kernel.utils",
                "mcp_streamable_http",
            },
        )
        self.assertIn("register_mcp_routes(", source)
        self.assertNotIn('@http.get("/mcp/tools")', source)
        self.assertNotIn('@http.post("/mcp/call")', source)
        self.assertNotIn("tool name is required", source)
        self.assertNotIn("arguments must be an object", source)
        self.assertNotIn("context must be an object", source)
        self.assertIn('"/mcp/tools"', mcp_source)
        self.assertIn('"/mcp/call"', mcp_source)
        self.assertIn("tool name is required", mcp_source)
        self.assertIn("arguments must be an object", mcp_source)
        self.assertIn("context must be an object", mcp_source)

    def test_control_data_plane_http_routes_are_deleted(self) -> None:
        source = _api_app_source()
        self.assertFalse(
            (SURFACE_ROOT / "transport" / "data_plane_http.py").exists()
        )
        self.assertNotIn("register_data_plane_routes", source)
        for route in (
            '"/api/data-plane/feed/validate-post"',
            '"/api/data-plane/feed/post"',
        ):
            with self.subTest(route=route):
                self.assertNotIn(route, source)

    def test_transport_delegates_artifact_content_to_artifacts(self) -> None:
        self.assertFalse((HTTP_API_PACKAGE / "resources.py").exists())
        routes = (HTTP_API_PACKAGE / "artifacts.py").read_text(encoding="utf-8")
        views = _api_views_source()
        self.assertIn("artifacts.get(", routes)
        self.assertIn("artifacts.figure(", routes)
        self.assertNotIn("FROM artifacts", routes + views)
        self.assertNotIn(".blobs.get", routes + views)


    def test_surface_raw_control_app_access_baseline_only_shrinks(self) -> None:
        current = _raw_control_app_accesses()
        self.assertEqual(current, RAW_CONTROL_APP_ACCESS_BASELINE)

    def test_whole_control_app_carrier_baseline_only_shrinks(self) -> None:
        current = _whole_control_app_carriers()
        self.assertEqual(current, WHOLE_CONTROL_APP_CARRIER_BASELINE)

    def test_http_transport_does_not_own_raw_persistence(self) -> None:
        def enclosing_function(
            node: ast.AST, parents: dict[ast.AST, ast.AST]
        ) -> str | None:
            parent = parents.get(node)
            while parent is not None:
                if isinstance(parent, ast.FunctionDef):
                    return parent.name
                parent = parents.get(parent)
            return None

        def stringish(node: ast.AST) -> str | None:
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                return node.value
            if isinstance(node, ast.JoinedStr):
                parts: list[str] = []
                for value in node.values:
                    if isinstance(value, ast.Constant) and isinstance(value.value, str):
                        parts.append(value.value)
                    else:
                        parts.append("{}")
                return "".join(parts)
            return None

        sql_re = re.compile(
            r"(?is)^\s*(WITH\b|PRAGMA\b|CREATE\s+TABLE\b|ALTER\s+TABLE\b|DROP\s+TABLE\b|SELECT\b|INSERT\b.+\bINTO\b|UPDATE\b.+\bSET\b|DELETE\b.+\bFROM\b)"
        )

        for path in HTTP_TRANSPORT_MODULES:
            with self.subTest(module=path.name):
                source = path.read_text(encoding="utf-8")
                # A router that owns a table declares its SchemaModule here;
                # the ladder step that creates it is schema, not request-path
                # persistence, so its DDL execute is not a leak.
                schema_steps = "SchemaModule(" in source
                tree = ast.parse(source)
                parents: dict[ast.AST, ast.AST] = {}
                for parent in ast.walk(tree):
                    for child in ast.iter_child_nodes(parent):
                        parents[child] = parent

                raw_sql: list[tuple[int, str]] = []
                execute_calls: list[int] = []
                connect_calls: list[tuple[str, str, int]] = []
                for node in ast.walk(tree):
                    text = stringish(node)
                    if text is not None and sql_re.search(text):
                        raw_sql.append((node.lineno, text.strip().splitlines()[0]))
                    if isinstance(node, ast.Call) and isinstance(
                        node.func, ast.Attribute
                    ):
                        if node.func.attr == "execute" and not (
                            schema_steps
                            and (enclosing_function(node, parents) or "").startswith(
                                "_add_"
                            )
                        ):
                            execute_calls.append(node.lineno)
                        if node.func.attr == "connect":
                            connect_calls.append(
                                (
                                    enclosing_function(node, parents) or "<module>",
                                    ast.unparse(node.func.value),
                                    node.lineno,
                                )
                            )

                self.assertEqual(raw_sql, [])
                self.assertEqual(execute_calls, [])
                self.assertEqual(connect_calls, [])

    def test_transport_has_no_visible_project_lookup_gate(self) -> None:
        source = _api_package_source()
        self.assertNotIn("project_ids_for_tenant", source)
        self.assertNotIn("SELECT id FROM projects WHERE tenant_id", source)

    def test_identity_constants_are_foundation_vocabulary(self) -> None:
        from merv.brain.kernel.identity import LOCAL_CLIENT_ID, LOCAL_TENANT_ID
        from merv.brain.surface.identity import LOCAL_PRINCIPAL

        self.assertEqual(LOCAL_TENANT_ID, "local")
        self.assertEqual(LOCAL_CLIENT_ID, "local")
        self.assertEqual(LOCAL_PRINCIPAL.tenant_id, LOCAL_TENANT_ID)
        self.assertEqual(LOCAL_PRINCIPAL.client_id, LOCAL_CLIENT_ID)
        self.assertIn("kernel.identity", _import_module_names(SERVICES / "identity.py"))
        self.assertIn("kernel.identity", _import_module_names(RESEARCH_CORE / "reviews.py"))
        self.assertNotIn("services.identity", _rc_source("reviews.py"))

    def test_opaque_secret_token_helpers_are_single_sourced(self) -> None:
        # The set grew when the run-wait key loader landed here: that key is
        # read from the environment or generated into the state root, so the
        # module owns file and env access now. Still exact — a token helper
        # that starts reaching for anything else has stopped being one.
        # urllib.parse encodes the authenticated subject in v2 wait URLs; it
        # performs no network access and remains part of this URL helper.
        self.assertEqual(
            _import_module_names(BACKEND_ROOT / "kernel" / "secret_tokens.py"),
            {
                "collections.abc",
                "env",
                "hashlib",
                "hmac",
                "merv.shared.errors",
                "os",
                "pathlib",
                "secrets",
                "urllib.parse",
            },
        )
        sensitive_paths = (RESEARCH_CORE / "reviews.py",)
        for path in sensitive_paths:
            with self.subTest(module=path.relative_to(BACKEND_ROOT).as_posix()):
                modules = _import_module_names(path)
                self.assertNotIn("hashlib", modules)
                self.assertNotIn("secrets", modules)
                # kernel-internal imports say "secret_tokens"; research_core
                # routes through the kernel package ("kernel.secret_tokens").
                self.assertTrue(
                    any(
                        module == "secret_tokens" or module.endswith(".secret_tokens")
                        for module in modules
                    ),
                    f"{path.name} must source tokens from kernel/secret_tokens.py",
                )

        for path in (RESEARCH_CORE / "reviews.py",):
            with self.subTest(module=path.relative_to(BACKEND_ROOT).as_posix()):
                self.assertNotIn("hmac", _import_module_names(path))
                self.assertNotIn("compare_digest(", path.read_text(encoding="utf-8"))

        self.assertNotIn(
            "def _hash_capability",
            (RESEARCH_CORE / "reviews.py").read_text(encoding="utf-8"),
        )

if __name__ == "__main__":
    unittest.main()
