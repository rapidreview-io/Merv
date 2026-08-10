"""Executable component and layer laws for the brain modular monolith.

``docs/MODULE_BOUNDARIES.md`` is the human-readable decision record.  Every
brain production file is independently classified by capability ownership
(component) and architectural role (layer).  Imports, including function-local
imports, must satisfy *both* laws.  Transitional layer violations are frozen as
exact file pairs: new violations fail and repaired pairs must be removed.
"""

from __future__ import annotations

import ast
import re
import unittest
from collections import Counter
from pathlib import Path

from tests.paths import BACKEND_ROOT

KERNEL = "kernel"
RESEARCH_CORE = "research_core"
ARTIFACTS = "artifacts"
OBJECT_STORAGE = "object_storage"
SANDBOX = "sandbox"
FEED = "feed"
MLFLOW = "mlflow"
AGENT_SESSIONS = "agent_sessions"
APPLICATION_COMPONENT = "application"
SURFACE = "surface"

MODULES = (
    KERNEL,
    RESEARCH_CORE,
    ARTIFACTS,
    OBJECT_STORAGE,
    SANDBOX,
    FEED,
    MLFLOW,
    AGENT_SESSIONS,
    APPLICATION_COMPONENT,
    SURFACE,
)

# Directory-level component assignments (deepest matching prefix wins;
# FILE_COMPONENTS wins over all prefixes). Paths are brain-relative posix.
PACKAGE_COMPONENTS = {
    "kernel": KERNEL,
    "research_core": RESEARCH_CORE,
    "literature": RESEARCH_CORE,
    "artifacts": ARTIFACTS,
    "object_storage": OBJECT_STORAGE,
    "sandbox": SANDBOX,
    "feed": FEED,
    "mlflow": MLFLOW,
    "agent_sessions": AGENT_SESSIONS,
    "application": APPLICATION_COMPONENT,
    "surface": SURFACE,
}

PUBLIC_COMPONENT_ROOTS = frozenset(
    package for package in PACKAGE_COMPONENTS if "/" not in package
)

# File-level component overrides.
FILE_COMPONENTS = {
    # kernel: package root docstring/version shell.
    "__init__.py": KERNEL,
}

# Component answers "which capability owns this file?"  MLflow and concrete
# object storage are integrations, while cross-component coordination belongs
# to Application.  Surface is the outer delivery/composition component.
ALLOWED_COMPONENT_EDGES = (
    {(KERNEL, KERNEL)}
    | {(RESEARCH_CORE, dependency) for dependency in (RESEARCH_CORE, KERNEL)}
    | {(ARTIFACTS, dependency) for dependency in (ARTIFACTS, KERNEL)}
    | {(SANDBOX, dependency) for dependency in (SANDBOX, KERNEL)}
    | {(FEED, dependency) for dependency in (FEED, KERNEL)}
    | {
        (AGENT_SESSIONS, dependency)
        for dependency in (AGENT_SESSIONS, RESEARCH_CORE, KERNEL)
    }
    | {
        (APPLICATION_COMPONENT, dependency)
        for dependency in (
            APPLICATION_COMPONENT,
            RESEARCH_CORE,
            ARTIFACTS,
            SANDBOX,
            FEED,
            OBJECT_STORAGE,
            AGENT_SESSIONS,
            KERNEL,
        )
    }
    | {(MLFLOW, dependency) for dependency in (MLFLOW, APPLICATION_COMPONENT, KERNEL)}
    | {
        (OBJECT_STORAGE, dependency)
        for dependency in (OBJECT_STORAGE, APPLICATION_COMPONENT, KERNEL)
    }
    | {(SURFACE, dependency) for dependency in MODULES}
)

# Layer is independent of component ownership. A provider driver can therefore
# be an adapter in the Sandbox component, while ObjectStorage is application
# policy in the Storage component.
FOUNDATION = "foundation"
PORT = "port"
DOMAIN = "domain"
APPLICATION_LAYER = "application"
ADAPTER = "adapter"
DELIVERY = "delivery"
BOOTSTRAP = "bootstrap"

LAYERS = (
    FOUNDATION,
    PORT,
    DOMAIN,
    APPLICATION_LAYER,
    ADAPTER,
    DELIVERY,
    BOOTSTRAP,
)

PACKAGE_LAYERS = {
    "kernel": FOUNDATION,
    "kernel/ports": PORT,
    "research_core": APPLICATION_LAYER,
    "literature": APPLICATION_LAYER,
    "artifacts": APPLICATION_LAYER,
    "feed": APPLICATION_LAYER,
    "sandbox": APPLICATION_LAYER,
    "sandbox/adapters": ADAPTER,
    "sandbox/remote": ADAPTER,
    "mlflow": ADAPTER,
    "object_storage": ADAPTER,
    "agent_sessions": APPLICATION_LAYER,
    "application": APPLICATION_LAYER,
    "surface": DELIVERY,
}

FILE_LAYERS = {
    "__init__.py": FOUNDATION,
    "kernel/state/dialects.py": ADAPTER,
    "surface/web_preview.py": ADAPTER,
    "sandbox/models.py": DOMAIN,
    "sandbox/adapters/__init__.py": BOOTSTRAP,
    "sandbox/keys.py": ADAPTER,
    "object_storage/__init__.py": APPLICATION_LAYER,
    "object_storage/provider.py": PORT,
    "object_storage/storage.py": APPLICATION_LAYER,
    "surface/config.py": BOOTSTRAP,
    "surface/transport/http_server.py": BOOTSTRAP,
    "surface/surface.py": BOOTSTRAP,
    "surface/telemetry.py": DELIVERY,
    "surface/project_keys.py": APPLICATION_LAYER,
    "surface/oauth.py": APPLICATION_LAYER,
    "surface/oauth_store.py": ADAPTER,
    # Write-only per-user HF-token facade over the KERNEL-owned user_hf_tokens
    # store methods (no-dataplane Phase C); the analog of project_keys.py.
    "surface/user_settings.py": APPLICATION_LAYER,
    # Write-only per-project provider-connection facade over the KERNEL-owned
    # sandbox_provider_settings store methods; the analog of user_settings.py.
    # The fleet resolver is composition-injected so it never imports bootstrap.
    "surface/sandbox_providers.py": APPLICATION_LAYER,
}

ALLOWED_LAYER_EDGES = (
    {(FOUNDATION, FOUNDATION)}
    | {(PORT, dependency) for dependency in (PORT, FOUNDATION)}
    | {(DOMAIN, dependency) for dependency in (DOMAIN, PORT, FOUNDATION)}
    | {
        (APPLICATION_LAYER, dependency)
        for dependency in (APPLICATION_LAYER, DOMAIN, PORT, FOUNDATION)
    }
    | {
        (ADAPTER, dependency)
        for dependency in (ADAPTER, APPLICATION_LAYER, DOMAIN, PORT, FOUNDATION)
    }
    | {
        (DELIVERY, dependency)
        for dependency in (DELIVERY, APPLICATION_LAYER, PORT, FOUNDATION)
    }
    | {(BOOTSTRAP, dependency) for dependency in LAYERS}
)

# Exact-pair compatibility ledger for unrelated Surface work that has not yet
# moved inward. This may only shrink. Experiment-transition/exhibit pairs are
# deliberately absent from the final ledger.
LAYER_EXCEPTIONS: frozenset[tuple[str, str]] = frozenset()

# SQL follows the import law: a module may name its own tables, Kernel tables,
# and tables behind ratified component edges. Every stable table is explicit;
# temporary ``*_migrate`` rebuild tables are ignored by the ownership check.
TABLE_OWNERS = {
    "projects": KERNEL,
    "project_members": KERNEL,
    "user_hf_tokens": KERNEL,
    # Same shape as user_hf_tokens: kernel owns the rows, the surface facade
    # (sandbox_providers.py) is the only writer, provisioning the only reader.
    "sandbox_provider_settings": KERNEL,
    "project_api_keys": SURFACE,
    "oauth_clients": SURFACE,
    "oauth_authorization_codes": SURFACE,
    "oauth_refresh_tokens": SURFACE,
    "events": KERNEL,
    # Written from the surface dispatcher through a kernel-owned ledger, the
    # same shape as events: kernel owns the table, everyone feeds it.
    "tool_calls": KERNEL,
    "schema_migrations": KERNEL,
    "tenants": KERNEL,
    "experiments": RESEARCH_CORE,
    "experiment_claims": RESEARCH_CORE,
    # The MLflow delivery barrier's key. Written and read only by the keyed
    # tracking write in research_core; it names a kernel `events` row the way
    # experiment_claims names a claim.
    "tracking_deliveries": RESEARCH_CORE,
    "claims": RESEARCH_CORE,
    "reviews": RESEARCH_CORE,
    "review_requests": RESEARCH_CORE,
    "review_sessions": RESEARCH_CORE,
    "reflections": RESEARCH_CORE,
    "reflection_claim_changes": RESEARCH_CORE,
    "reflection_experiments": RESEARCH_CORE,
    # Written by the wave lifecycle (spec validation reserves and pins,
    # publish or abandon releases); read by the tool create path to refuse
    # name races and by the cap check to hold the wave's slots.
    "reflection_reserved_names": RESEARCH_CORE,
    "project_candidates": RESEARCH_CORE,
    "litreview_sections": RESEARCH_CORE,
    "papers": RESEARCH_CORE,
    "paper_links": RESEARCH_CORE,
    "artifacts": ARTIFACTS,
    "artifact_figures": ARTIFACTS,
    # The seal writes both, and only Artifacts writes them.
    "submissions": ARTIFACTS,
    "storage_objects": OBJECT_STORAGE,
    "storage_completion_tokens": OBJECT_STORAGE,
    "sandboxes": SANDBOX,
    "sandbox_attachments": SANDBOX,
    "sandbox_generations": SANDBOX,
    "sandbox_runs": SANDBOX,
    "tenant_quotas": SANDBOX,
    "provider_user_caps": SANDBOX,
    "spend_kill_switches": SANDBOX,
    "posts": FEED,
    "feed_authors": FEED,
    "post_reactions": FEED,
    "feed_upload_tokens": FEED,
    "agent_sessions": AGENT_SESSIONS,
    "experiment_workspaces": AGENT_SESSIONS,
    "consolidation_proposals": RESEARCH_CORE,
    "consolidation_decisions": RESEARCH_CORE,
    "reflection_advances": RESEARCH_CORE,
}
SQL_TABLE_REF = re.compile(r"\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_]+)\b", re.IGNORECASE)
CREATE_TABLE_REF = re.compile(
    r"\bCREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z_]+)\s*\(",
    re.IGNORECASE,
)
FOREIGN_SQL_TABLE_REF = re.compile(
    r"\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM|REFERENCES)\s+([a-z_]+)\b",
    re.IGNORECASE,
)

FOREIGN_ARTIFACT_SQL_BASELINE: Counter[tuple[str, str, str]] = Counter()

APPLICATION_FORBIDDEN_IMPORT_ROOTS = frozenset(
    {
        "boto3",
        "django",
        "dotenv",
        "fastapi",
        "flask",
        "httpx",
        "mlflow",
        "modal",
        "os",
        "psycopg",
        "pydantic",
        "requests",
        "socket",
        "sqlalchemy",
        "sqlite3",
        "starlette",
        "subprocess",
        "urllib",
        "uvicorn",
    }
)
APPLICATION_SQL = re.compile(
    r"\b(?:SELECT\b[\s\S]{0,300}?\bFROM|INSERT\s+INTO|"
    r"UPDATE\s+[a-z_]+\s+SET|DELETE\s+FROM|"
    r"(?:CREATE|ALTER|DROP)\s+TABLE)\b",
    re.IGNORECASE,
)
CONCRETE_COLLABORATOR_SUFFIXES = (
    "Backend",
    "Client",
    "Dispatcher",
    "Facade",
    "Handler",
    "Query",
    "Reader",
    "Repository",
    "Runtime",
    "Service",
    "Store",
    "Writer",
)
CONCRETE_FACTORY_PREFIXES = ("build_", "create_", "make_")
CONCRETE_FACTORY_SUFFIXES = tuple(
    f"_{suffix.lower()}" for suffix in CONCRETE_COLLABORATOR_SUFFIXES
)

DELIVERY_PERSISTENCE_MEMBERS = frozenset(
    {"store", "_store", "transaction", "connect", "cursor"}
)
DELIVERY_DYNAMIC_REACH_THROUGH_MEMBERS = DELIVERY_PERSISTENCE_MEMBERS | {"__dict__"}
DELIVERY_WHOLE_DEPENDENCY_CARRIERS = frozenset({"Surface"})


def _is_concrete_factory(name: str) -> bool:
    return name.startswith(CONCRETE_FACTORY_PREFIXES) and name.endswith(
        CONCRETE_FACTORY_SUFFIXES
    )


def _backend_files() -> list[Path]:
    return sorted(
        path for path in BACKEND_ROOT.rglob("*.py") if "__pycache__" not in path.parts
    )


def _classify_from(
    rel: str,
    *,
    packages: dict[str, str],
    files: dict[str, str],
) -> str | None:
    if rel in files:
        return files[rel]
    parts = rel.split("/")
    for depth in range(len(parts) - 1, 0, -1):
        prefix = "/".join(parts[:depth])
        if prefix in packages:
            return packages[prefix]
    return None


def _component(rel: str) -> str | None:
    return _classify_from(
        rel,
        packages=PACKAGE_COMPONENTS,
        files=FILE_COMPONENTS,
    )


def _layer(rel: str) -> str | None:
    return _classify_from(rel, packages=PACKAGE_LAYERS, files=FILE_LAYERS)


def _dotted_index() -> dict[str, str]:
    """Absolute dotted module name -> brain-relative file path."""
    index: dict[str, str] = {}
    for path in _backend_files():
        rel = path.relative_to(BACKEND_ROOT)
        parts = (
            rel.parent.parts
            if rel.name == "__init__.py"
            else (*rel.parent.parts, rel.stem)
        )
        index[".".join(("merv", "brain", *parts))] = rel.as_posix()
    return index


def _import_targets(path: Path, dotted: dict[str, str]) -> set[str]:
    """Brain files imported by ``path``, top-level and function-local alike.

    Relative imports resolve against the importing file's package; for
    ``from base import name`` the deeper ``base.name`` submodule wins when it
    exists, otherwise the edge points at ``base`` itself.
    """
    rel = path.relative_to(BACKEND_ROOT)
    package = ("merv", "brain", *rel.parent.parts)
    targets: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            targets.update(
                dotted[alias.name] for alias in node.names if alias.name in dotted
            )
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = ".".join(package[: len(package) - (node.level - 1)])
                if node.module:
                    base = f"{base}.{node.module}"
            elif node.module and node.module != "__future__":
                base = node.module
            else:
                continue
            for alias in node.names:
                candidate = f"{base}.{alias.name}"
                if candidate in dotted:
                    targets.add(dotted[candidate])
                elif base in dotted:
                    targets.add(dotted[base])
    return targets


def _import_pairs() -> set[tuple[str, str]]:
    dotted = _dotted_index()
    imports: set[tuple[str, str]] = set()
    for path in _backend_files():
        rel = path.relative_to(BACKEND_ROOT).as_posix()
        for target in _import_targets(path, dotted):
            if target == rel:
                continue
            imports.add((rel, target))
    return imports


def _component_violations() -> set[tuple[str, str]]:
    return {
        (importer, target)
        for importer, target in _import_pairs()
        if not _component_edge_allowed(importer=importer, target=target)
    }


def _component_edge_allowed(*, importer: str, target: str) -> bool:
    importer_component = _component(importer)
    target_component = _component(target)
    if importer_component == RESEARCH_CORE and target_component == ARTIFACTS:
        # Research shares the one typed public root with Application and
        # Surface. Artifacts still knows no Research module: its target
        # resolver is implemented by Research and injected at composition.
        return target == f"{ARTIFACTS}/__init__.py"
    return (importer_component, target_component) in ALLOWED_COMPONENT_EDGES


def _layer_violations() -> set[tuple[str, str]]:
    return {
        (importer, target)
        for importer, target in _import_pairs()
        if (_layer(importer), _layer(target)) not in ALLOWED_LAYER_EDGES
    }


def _public_entrypoint_violations() -> set[tuple[str, str]]:
    violations: set[tuple[str, str]] = set()
    for importer, target in _import_pairs():
        importer_component = _component(importer)
        target_component = _component(target)
        if (
            importer_component == target_component
            or target_component == KERNEL
            or _layer(importer) == BOOTSTRAP
        ):
            continue
        if target in {f"{package}/__init__.py" for package in PUBLIC_COMPONENT_ROOTS}:
            continue
        if (
            importer_component == MLFLOW
            and target == f"{APPLICATION_COMPONENT}/mlflow.py"
        ):
            # The optional adapter implements the single integration contract;
            # exporting its DTO forest from the Application root would turn
            # that root back into a service bag.
            continue
        relative_target = target.removeprefix(f"{target_component}/")
        if target_component == ARTIFACTS:
            if relative_target == "__init__.py":
                continue
            violations.add((importer, target))
            continue
        if relative_target in {
            "__init__.py",
            "api.py",
            "facade.py",
        } or relative_target.startswith("ports/"):
            continue
        violations.add((importer, target))
    return violations


def _created_tables() -> set[str]:
    tables: set[str] = set()
    for path in _backend_files():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                tables.update(
                    match.group(1).lower()
                    for match in CREATE_TABLE_REF.finditer(node.value)
                    if not match.group(1).lower().endswith("_migrate")
                )
    return tables


def _enclosing_function(node: ast.AST, parents: dict[ast.AST, ast.AST]) -> str:
    current = node
    while current in parents:
        current = parents[current]
        if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return current.name
    return "<module>"


def _foreign_artifact_sql() -> Counter[tuple[str, str, str]]:
    references: Counter[tuple[str, str, str]] = Counter()
    artifact_tables = {
        table for table, owner in TABLE_OWNERS.items() if owner == ARTIFACTS
    }
    for path in _backend_files():
        rel = path.relative_to(BACKEND_ROOT).as_posix()
        # Kernel owns the schema and released migrations. Runtime Artifact SQL
        # belongs exclusively to the consolidated Artifacts component.
        if _component(rel) == ARTIFACTS or rel == "kernel/state/store.py":
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        parents = {
            child: parent
            for parent in ast.walk(tree)
            for child in ast.iter_child_nodes(parent)
        }
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Constant) and isinstance(node.value, str)):
                continue
            for match in FOREIGN_SQL_TABLE_REF.finditer(node.value):
                table = match.group(1).lower()
                if table in artifact_tables:
                    references[(rel, _enclosing_function(node, parents), table)] += 1
    return references


def _application_purity_violations() -> list[str]:
    violations: list[str] = []
    dotted = _dotted_index()
    for path in sorted((BACKEND_ROOT / APPLICATION_COMPONENT).rglob("*.py")):
        rel = path.relative_to(BACKEND_ROOT).as_posix()
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source)
        for target in _import_targets(path, dotted):
            if target.startswith("kernel/state/") or target == "kernel/env.py":
                violations.append(f"{rel}: imports state/config module {target}")
            if _component(target) in (SURFACE, MLFLOW) or _layer(target) == ADAPTER:
                violations.append(f"{rel}: imports concrete adapter {target}")
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                roots = {alias.name.split(".", 1)[0] for alias in node.names}
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                roots = {node.module.split(".", 1)[0]}
            else:
                roots = set()
            for root in roots & APPLICATION_FORBIDDEN_IMPORT_ROOTS:
                violations.append(f"{rel}:{node.lineno}: imports {root}")
            if isinstance(node, ast.Name) and node.id in {
                "BaseStateStore",
                "StateStore",
            }:
                violations.append(f"{rel}:{node.lineno}: names {node.id}")
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                parameters = (
                    *node.args.posonlyargs,
                    *node.args.args,
                    *node.args.kwonlyargs,
                )
                for parameter in parameters:
                    if parameter.arg in {"conn", "connection", "cursor"}:
                        violations.append(
                            f"{rel}:{parameter.lineno}: accepts persistence parameter "
                            f"{parameter.arg}"
                        )
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr in {"connect", "cursor", "transaction"}
            ):
                violations.append(
                    f"{rel}:{node.lineno}: calls persistence method {node.func.attr}"
                )

        docstrings = {
            id(owner.body[0].value)
            for owner in ast.walk(tree)
            if isinstance(
                owner,
                (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef),
            )
            and owner.body
            and isinstance(owner.body[0], ast.Expr)
            and isinstance(owner.body[0].value, ast.Constant)
            and isinstance(owner.body[0].value.value, str)
        }
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and id(node) not in docstrings
                and APPLICATION_SQL.search(node.value)
            ):
                violations.append(f"{rel}:{node.lineno}: contains SQL")
    return sorted(set(violations))


def _delivery_boundary_violations(
    source: str, *, relative: str = "<synthetic>"
) -> list[str]:
    """Reject internal implementations and persistence reach-through in Delivery.

    A service deliberately exported from a component package root is public and
    may be named directly. Internal ``*Service`` types, stores, whole-app
    carriers, and persistence access remain forbidden.
    """
    tree = ast.parse(source, filename=relative)
    violations: set[str] = set()
    raw_aliases: set[str] = set()
    public_service_aliases: set[str] = set()
    carrier_aliases = set(DELIVERY_WHOLE_DEPENDENCY_CARRIERS)

    def is_raw_type(name: str) -> bool:
        return name == "Surface" or name.endswith(("Service", "Store"))

    def is_public_service_import(node: ast.ImportFrom, name: str) -> bool:
        if not name.endswith("Service") or not node.module:
            return False
        module = node.module
        if module.startswith("merv.brain."):
            module = module.removeprefix("merv.brain.")
        return module in PUBLIC_COMPONENT_ROOTS

    for node in ast.walk(tree):
        if not isinstance(node, ast.ImportFrom):
            continue
        for alias in node.names:
            bound_name = alias.asname or alias.name
            if is_public_service_import(node, alias.name):
                public_service_aliases.add(bound_name)
            elif is_raw_type(alias.name):
                raw_aliases.add(bound_name)
                violations.add(
                    f"{relative}:{node.lineno}: imports raw implementation type "
                    f"{alias.name}"
                )
            if alias.name in DELIVERY_WHOLE_DEPENDENCY_CARRIERS:
                carrier_aliases.add(bound_name)

    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and (
            node.id in raw_aliases
            or (is_raw_type(node.id) and node.id not in public_service_aliases)
        ):
            violations.add(
                f"{relative}:{node.lineno}: names raw implementation type {node.id}"
            )
        elif isinstance(node, ast.Attribute):
            if node.attr in DELIVERY_DYNAMIC_REACH_THROUGH_MEMBERS:
                violations.add(
                    f"{relative}:{node.lineno}: reaches through to {node.attr}"
                )
            elif is_raw_type(node.attr):
                violations.add(
                    f"{relative}:{node.lineno}: names raw implementation type "
                    f"{node.attr}"
                )
        elif (
            isinstance(node, ast.Call)
            and (
                isinstance(node.func, ast.Name)
                and node.func.id == "getattr"
                or isinstance(node.func, ast.Attribute)
                and node.func.attr == "getattr"
            )
            and len(node.args) >= 2
            and isinstance(node.args[1], ast.Constant)
            and node.args[1].value in DELIVERY_DYNAMIC_REACH_THROUGH_MEMBERS
        ):
            violations.add(
                f"{relative}:{node.lineno}: dynamically reaches through to "
                f"{node.args[1].value}"
            )

    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if node.name != "build_router" and not node.name.startswith("register_"):
            continue
        parameters = (*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs)
        for parameter in parameters:
            if parameter.annotation is None:
                continue
            annotation_names = {
                child.id
                for child in ast.walk(parameter.annotation)
                if isinstance(child, ast.Name)
            } | {
                child.attr
                for child in ast.walk(parameter.annotation)
                if isinstance(child, ast.Attribute)
            }
            if isinstance(parameter.annotation, ast.Constant) and isinstance(
                parameter.annotation.value, str
            ):
                annotation_names.update(
                    re.findall(r"[A-Za-z_][A-Za-z0-9_]*", parameter.annotation.value)
                )
            carriers = sorted(annotation_names & carrier_aliases)
            if carriers:
                violations.add(
                    f"{relative}:{parameter.lineno}: {node.name} receives whole "
                    f"dependency carrier {carriers[0]}"
                )

    return sorted(violations)


def _cross_component_constructions_outside_bootstrap() -> list[str]:
    """Find construction of another component's concrete collaborator."""
    dotted = _dotted_index()
    violations: list[str] = []
    for path in _backend_files():
        rel = path.relative_to(BACKEND_ROOT).as_posix()
        if _layer(rel) == BOOTSTRAP:
            continue
        package = ("merv", "brain", *path.relative_to(BACKEND_ROOT).parent.parts)
        imported: dict[str, tuple[str, str]] = {}
        imported_modules: dict[tuple[str, ...], str] = {}
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    target = dotted.get(alias.name)
                    if target:
                        prefix = (
                            (alias.asname,)
                            if alias.asname
                            else tuple(alias.name.split("."))
                        )
                        imported_modules[prefix] = target
                continue
            if not isinstance(node, ast.ImportFrom):
                continue
            if node.level:
                base = ".".join(package[: len(package) - (node.level - 1)])
                if node.module:
                    base = f"{base}.{node.module}"
            elif node.module:
                base = node.module
            else:
                continue
            target = dotted.get(base)
            for alias in node.names:
                candidate = dotted.get(f"{base}.{alias.name}") or target
                if candidate and (
                    alias.name.endswith(CONCRETE_COLLABORATOR_SUFFIXES)
                    or _is_concrete_factory(alias.name)
                ):
                    imported[alias.asname or alias.name] = (candidate, alias.name)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            if isinstance(node.func, ast.Name) and node.func.id in imported:
                target, class_name = imported[node.func.id]
            elif isinstance(node.func, ast.Attribute):
                chain: list[str] = []
                current: ast.AST = node.func
                while isinstance(current, ast.Attribute):
                    chain.append(current.attr)
                    current = current.value
                if isinstance(current, ast.Name):
                    chain.append(current.id)
                parts = tuple(reversed(chain))
                target = ""
                class_name = parts[-1] if parts else ""
                for prefix, candidate in imported_modules.items():
                    if parts[:-1] == prefix:
                        target = candidate
                        break
                if not target or not (
                    class_name.endswith(CONCRETE_COLLABORATOR_SUFFIXES)
                    or _is_concrete_factory(class_name)
                ):
                    continue
            else:
                continue
            if _component(target) not in {_component(rel), KERNEL}:
                violations.append(
                    f"{rel}:{node.lineno} constructs {class_name} from {target}"
                )
    return sorted(violations)


class ModuleBoundaryTest(unittest.TestCase):
    def test_no_source_references_tracking_credentials_allowed(self) -> None:
        # The v29 per-sandbox trust column is moot under the no-dataplane
        # transition (MLflow suspension + project-shared sandboxes) and must
        # never be ported: no column, no read site, no reference anywhere.
        offenders = [
            path.relative_to(BACKEND_ROOT).as_posix()
            for path in _backend_files()
            if "tracking_credentials_allowed" in path.read_text(encoding="utf-8")
        ]
        self.assertEqual(offenders, [])

    def test_tool_dispatcher_is_delivery(self) -> None:
        self.assertEqual(_layer("surface/tools/dispatcher.py"), DELIVERY)

    def test_every_backend_file_is_classified_by_component_and_layer(self) -> None:
        for label, classifier in (("component", _component), ("layer", _layer)):
            with self.subTest(classification=label):
                unclassified = sorted(
                    rel
                    for path in _backend_files()
                    if classifier(rel := path.relative_to(BACKEND_ROOT).as_posix())
                    is None
                )
                self.assertFalse(
                    unclassified,
                    f"new brain files must be assigned a {label} in "
                    "tests/structure/test_module_boundaries.py: "
                    f"{unclassified}",
                )

    def test_classification_tables_carry_no_stale_paths(self) -> None:
        for table_name, paths in (
            ("FILE_COMPONENTS", FILE_COMPONENTS),
            ("FILE_LAYERS", FILE_LAYERS),
        ):
            for rel in sorted(paths):
                with self.subTest(table=table_name, file=rel):
                    self.assertTrue(
                        (BACKEND_ROOT / rel).is_file(),
                        f"stale {table_name} entry: {rel}",
                    )
        for table_name, paths in (
            ("PACKAGE_COMPONENTS", PACKAGE_COMPONENTS),
            ("PACKAGE_LAYERS", PACKAGE_LAYERS),
        ):
            for prefix in sorted(paths):
                with self.subTest(table=table_name, package=prefix):
                    self.assertTrue(
                        (BACKEND_ROOT / prefix).is_dir(),
                        f"stale {table_name} entry: {prefix}",
                    )

    def test_component_import_law(self) -> None:
        violations = sorted(_component_violations())
        self.assertFalse(
            violations,
            "component-boundary violation (see docs/MODULE_BOUNDARIES.md): "
            + ", ".join(
                f"{importer} -> {target} "
                f"[{_component(importer)} -> {_component(target)}]"
                for importer, target in violations
            ),
        )

    def test_research_enters_only_the_public_artifacts_root(self) -> None:
        importer = "research_core/reflections.py"
        self.assertTrue(
            _component_edge_allowed(importer=importer, target="artifacts/__init__.py")
        )
        self.assertFalse(
            _component_edge_allowed(importer=importer, target="artifacts/artifacts.py")
        )

    def test_no_new_layer_boundary_violations(self) -> None:
        new = sorted(_layer_violations() - LAYER_EXCEPTIONS)
        self.assertFalse(
            new,
            "new layer-boundary violation (see docs/MODULE_BOUNDARIES.md): "
            + ", ".join(
                f"{importer} -> {target} [{_layer(importer)} -> {_layer(target)}]"
                for importer, target in new
            ),
        )

    def test_module_sql_respects_table_ownership(self) -> None:
        """Fitness assertion (conformance scan, no grandfathering): SQL string
        literals follow the same edges as imports — a module may only name its
        own tables, kernel tables, and tables of modules it may import.
        Supersedes the phase-4a sandbox-only lint. Cross-module reads belong
        behind the owning component's public root."""
        offenders: list[str] = []
        for path in _backend_files():
            rel = path.relative_to(BACKEND_ROOT).as_posix()
            module = _component(rel)
            if module in (None, KERNEL, SURFACE):
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if not (isinstance(node, ast.Constant) and isinstance(node.value, str)):
                    continue
                for match in SQL_TABLE_REF.finditer(node.value):
                    owner = TABLE_OWNERS.get(match.group(1).lower())
                    if owner is None or owner == module:
                        continue
                    if (module, owner) not in ALLOWED_COMPONENT_EDGES:
                        offenders.append(
                            f"{rel}:{node.lineno} ({module} SQL names "
                            f"{owner} table {match.group(1)})"
                        )
        self.assertFalse(
            offenders,
            "module SQL crosses an unratified boundary; inject the query from "
            "the owning module at composition instead: "
            + ", ".join(sorted(set(offenders))),
        )

    def test_every_stable_table_has_one_explicit_owner(self) -> None:
        created = _created_tables()
        unowned = sorted(created - TABLE_OWNERS.keys())
        stale = sorted(TABLE_OWNERS.keys() - created)
        self.assertFalse(
            unowned,
            "new persistent tables need an explicit component owner: "
            + ", ".join(unowned),
        )
        self.assertFalse(
            stale,
            "stale table-owner entries must be deleted: " + ", ".join(stale),
        )
        self.assertNotIn(
            APPLICATION_COMPONENT,
            TABLE_OWNERS.values(),
            "Application coordinates components and may not own persistence",
        )

    def test_layer_exception_baseline_only_shrinks(self) -> None:
        stale = sorted(LAYER_EXCEPTIONS - _layer_violations())
        self.assertFalse(
            stale,
            "stale layer exception — boundary improved, DELETE this pair: "
            + ", ".join(f"{importer} -> {target}" for importer, target in stale),
        )

    def test_cross_component_imports_use_public_entrypoints(self) -> None:
        """Every caller enters components through a typed API, facade, or port."""
        violations = sorted(_public_entrypoint_violations())
        self.assertFalse(
            violations,
            "cross-component internal import; use the component's facade/port "
            "or the Artifacts package entrypoint: "
            + ", ".join(f"{source} -> {target}" for source, target in violations),
        )

    def test_artifact_sql_stays_inside_artifacts(self) -> None:
        current = _foreign_artifact_sql()
        new = current - FOREIGN_ARTIFACT_SQL_BASELINE
        stale = FOREIGN_ARTIFACT_SQL_BASELINE - current
        self.assertFalse(
            new,
            "SQL outside Artifacts names Artifact-owned tables: "
            + ", ".join(f"{key} x{count}" for key, count in sorted(new.items())),
        )
        self.assertFalse(
            stale,
            "Artifacts SQL boundary improved; lower the baseline: "
            + ", ".join(f"{key} x{count}" for key, count in sorted(stale.items())),
        )

    def test_application_has_no_adapter_framework_connection_or_sql_access(
        self,
    ) -> None:
        violations = _application_purity_violations()
        self.assertFalse(
            violations,
            "Application may call concrete public module roots, but not adapters, "
            "connections, transactions, frameworks, or SQL: " + ", ".join(violations),
        )

    def test_delivery_has_no_raw_implementation_or_persistence_access(self) -> None:
        violations: list[str] = []
        for path in _backend_files():
            relative = path.relative_to(BACKEND_ROOT).as_posix()
            if _layer(relative) != DELIVERY:
                continue
            violations.extend(
                _delivery_boundary_violations(
                    path.read_text(encoding="utf-8"), relative=relative
                )
            )
        self.assertFalse(
            violations,
            "Delivery may use public package-root services/facades/use cases but "
            "may not name internal implementations or reach through to persistence "
            "or whole-app dependency carriers: " + ", ".join(violations),
        )

    def test_delivery_boundary_scan_rejects_adversarial_reach_through(self) -> None:
        cases = {
            "raw Surface": (
                "from surface import Surface as Backend\nvalue: Backend\n",
                "raw implementation type",
            ),
            "raw service": (
                "from records import ResourceService as Records\nvalue: Records\n",
                "raw implementation type",
            ),
            "raw store": (
                "from state import BaseStateStore as Database\nvalue: Database\n",
                "raw implementation type",
            ),
            "direct persistence": (
                "def route(api):\n    return api.store\n",
                "reaches through to store",
            ),
            "private persistence": (
                "def route(api):\n    return api._store\n",
                "reaches through to _store",
            ),
            "one-hop alias": (
                "def route(api):\n"
                "    records = api.resources\n"
                "    return records.store\n",
                "reaches through to store",
            ),
            "multi-hop alias": (
                "def route(ctx):\n"
                "    api = ctx.api\n"
                "    records = api.resources\n"
                "    return records.store\n",
                "reaches through to store",
            ),
            "transaction": (
                "def route(unit):\n    return unit.transaction()\n",
                "reaches through to transaction",
            ),
            "connection": (
                "def route(database):\n    return database.connect()\n",
                "reaches through to connect",
            ),
            "cursor": (
                "def route(connection):\n    return connection.cursor()\n",
                "reaches through to cursor",
            ),
            "dynamic getattr": (
                "def route(api):\n    return getattr(api, 'store')\n",
                "dynamically reaches through to store",
            ),
            "dynamic private getattr": (
                "def route(api):\n    return getattr(api, '_store')\n",
                "dynamically reaches through to _store",
            ),
            "qualified getattr": (
                "import builtins\n"
                "def route(api):\n"
                "    return builtins.getattr(api, 'transaction')\n",
                "dynamically reaches through to transaction",
            ),
            "introspection": (
                "def route(api):\n    return api.__dict__['resources']\n",
                "reaches through to __dict__",
            ),
            "Surface router carrier": (
                "def build_router(app: 'Surface'):\n    return app\n",
                "build_router receives whole dependency carrier Surface",
            ),
        }
        for name, (source, expected) in cases.items():
            with self.subTest(case=name):
                violations = _delivery_boundary_violations(source)
                self.assertTrue(
                    any(expected in violation for violation in violations),
                    f"scanner missed {name}: {violations}",
                )

    def test_delivery_boundary_scan_allows_narrow_public_dependencies(self) -> None:
        source = """
def build_router(ctx: RouteContext, *, records: ArtifactRecords):
    def route(project_id: str):
        return records.list(project_id=project_id, cursor_token=None)
    return route
"""
        self.assertEqual(_delivery_boundary_violations(source), [])

    def test_delivery_boundary_scan_allows_public_package_root_services(self) -> None:
        source = """
from merv.brain.feed import FeedService
def register_routes(*, feed: FeedService):
    return feed.list_posts(project_id="proj_1")
"""
        self.assertEqual(_delivery_boundary_violations(source), [])

    def test_delivery_boundary_scan_rejects_internal_service_imports(self) -> None:
        source = """
from merv.brain.feed.feed import FeedService
def register_routes(*, feed: FeedService):
    return feed.list_posts(project_id="proj_1")
"""
        violations = _delivery_boundary_violations(source)
        self.assertTrue(
            any("raw implementation type FeedService" in item for item in violations),
            violations,
        )

    def test_only_bootstrap_constructs_cross_component_collaborators(self) -> None:
        violations = _cross_component_constructions_outside_bootstrap()
        self.assertFalse(
            violations,
            "construct concrete cross-component collaborators in bootstrap and "
            "inject a facade/port instead: " + ", ".join(violations),
        )

    def test_composite_reads_are_application_owned_and_surface_delegates(self) -> None:
        queries = (BACKEND_ROOT / "application/queries.py").read_text(encoding="utf-8")
        application = (BACKEND_ROOT / "application/application.py").read_text(
            encoding="utf-8"
        )
        figure = (BACKEND_ROOT / "surface/experiment_figure.py").read_text(
            encoding="utf-8"
        )
        workflow = (BACKEND_ROOT / "application/workflow.py").read_text(
            encoding="utf-8"
        )
        control = (BACKEND_ROOT / "surface/surface.py").read_text(
            encoding="utf-8"
        )
        views = (BACKEND_ROOT / "surface/transport/api/views.py").read_text(
            encoding="utf-8"
        )
        routes = "\n".join(
            (BACKEND_ROOT / f"surface/transport/api/{name}.py").read_text(
                encoding="utf-8"
            )
            for name in ("experiments", "projects")
        )
        self.assertIn("class LogicGraphQuery:", queries)
        self.assertIn("def figure_facts(", application)
        self.assertEqual(control.count("Application("), 1)
        self.assertIn("def build_experiment_figure(", figure)
        self.assertFalse((BACKEND_ROOT / "artifacts/figure_view.py").exists())
        self.assertNotIn(
            "build_experiment_figure",
            (BACKEND_ROOT / "artifacts/artifacts.py").read_text(encoding="utf-8"),
        )
        self.assertIn("class StatusAndNextQuery:", workflow)
        self.assertNotIn("class ProjectDashboardQuery:", workflow)
        for escaped_policy in (
            "build_experiment_figure",
            "tracking_experiment_name",
            "ACTIVE_SANDBOX_STATUSES",
        ):
            self.assertNotIn(escaped_policy, views)
        for delegate in ("dashboard(", "tracking_overview(", "figure_facts("):
            self.assertIn(delegate, routes)


if __name__ == "__main__":
    unittest.main()
