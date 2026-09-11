"""Shrinking inventory of untyped cross-component collaborators."""

from __future__ import annotations

import ast
import unittest
from collections import Counter
from pathlib import Path

from tests.paths import BACKEND_ROOT


_BOOTSTRAP_FILES = {
    "sandbox/adapters/__init__.py",
    "surface/config.py",
    "surface/surface.py",
    "surface/transport/api/app.py",
    "surface/transport/http_server.py",
}


def _is_bootstrap(rel: str) -> bool:
    return rel in _BOOTSTRAP_FILES


def _debt(lines: str) -> Counter[tuple[str, str, str, str]]:
    return Counter(tuple(line.split(" | ", 3)) for line in lines.splitlines() if line)


DEPENDENCY_TYPE_DEBT = _debt(
    """kernel/state/dialects.py | PostgresConnection.__init__ | raw | Any
surface/telemetry.py | StructuredLogger.__init__ | stream | Any | None
surface/transport/api/gateway.py | RequestAuthenticator | verifier | Any | None
surface/transport/mcp_http.py | register_mcp_routes | list_tools | ToolCatalog
surface/transport/mcp_http.py | register_mcp_routes | call_tool | ToolCaller"""
)


def _contains_name(node: ast.AST, names: set[str]) -> bool:
    return any(
        isinstance(item, ast.Name) and item.id in names for item in ast.walk(node)
    )


def _bare_any(node: ast.AST) -> bool:
    if isinstance(node, ast.Name):
        return node.id == "Any"
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        return _bare_any(node.left) or _bare_any(node.right)
    return False


def _callable_aliases(tree: ast.Module) -> set[str]:
    aliases: set[str] = set()
    changed = True
    while changed:
        changed = False
        for node in tree.body:
            if not (
                isinstance(node, ast.Assign)
                and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name)
            ):
                continue
            if _contains_name(node.value, {"Callable", *aliases}):
                name = node.targets[0].id
                if name not in aliases:
                    aliases.add(name)
                    changed = True
    return aliases


def _is_untyped_dependency(annotation: ast.AST, aliases: set[str]) -> bool:
    return _bare_any(annotation) or _contains_name(annotation, {"Callable", *aliases})


def _parameters(function: ast.FunctionDef | ast.AsyncFunctionDef) -> list[ast.arg]:
    return [
        *function.args.posonlyargs,
        *function.args.args,
        *function.args.kwonlyargs,
    ]


def _dependency_type_debt() -> Counter[tuple[str, str, str, str]]:
    debt: Counter[tuple[str, str, str, str]] = Counter()
    for path in sorted(BACKEND_ROOT.rglob("*.py")):
        rel = path.relative_to(BACKEND_ROOT).as_posix()
        tree = ast.parse(path.read_text(encoding="utf-8"))
        aliases = _callable_aliases(tree)

        if _is_bootstrap(rel):
            continue
        for owner in tree.body:
            if isinstance(owner, ast.ClassDef):
                for field in owner.body:
                    if (
                        isinstance(field, ast.AnnAssign)
                        and isinstance(field.target, ast.Name)
                        and _is_untyped_dependency(field.annotation, aliases)
                    ):
                        debt[
                            (
                                rel,
                                owner.name,
                                field.target.id,
                                ast.unparse(field.annotation),
                            )
                        ] += 1
                init_name = f"{owner.name}.__init__"
                for method in owner.body:
                    if not (
                        isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef))
                        and method.name == "__init__"
                    ):
                        continue
                    for parameter in _parameters(method):
                        if parameter.annotation and _is_untyped_dependency(
                            parameter.annotation, aliases
                        ):
                            debt[
                                (
                                    rel,
                                    init_name,
                                    parameter.arg,
                                    ast.unparse(parameter.annotation),
                                )
                            ] += 1
            elif isinstance(
                owner, (ast.FunctionDef, ast.AsyncFunctionDef)
            ) and owner.name.startswith(("build_", "register_")):
                for parameter in _parameters(owner):
                    if (
                        parameter.arg != "http"
                        and parameter.annotation
                        and _is_untyped_dependency(parameter.annotation, aliases)
                    ):
                        debt[
                            (
                                rel,
                                owner.name,
                                parameter.arg,
                                ast.unparse(parameter.annotation),
                            )
                        ] += 1
    return debt


def _format(counter: Counter[tuple[str, str, str, str]]) -> str:
    return ", ".join(
        f"{file}:{owner}.{name} ({annotation}) x{count}"
        for (file, owner, name, annotation), count in sorted(counter.items())
    )


class DependencyContractTest(unittest.TestCase):
    def test_untyped_cross_component_dependency_inventory_only_shrinks(self) -> None:
        current = _dependency_type_debt()
        new = current - DEPENDENCY_TYPE_DEBT
        stale = DEPENDENCY_TYPE_DEBT - current
        self.assertFalse(
            new,
            "new Any/generic Callable collaborator; define a named Protocol: "
            + _format(new),
        )
        self.assertFalse(
            stale,
            "dependency typing improved; lower DEPENDENCY_TYPE_DEBT: " + _format(stale),
        )


if __name__ == "__main__":
    unittest.main()
