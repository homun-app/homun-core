#!/usr/bin/env python3
"""Census of error literals still without a stable `reason`.

Counts (AST, no imports needed):
- raises of DomainError subclasses without a literal `reason=` keyword;
- HTTPException raises whose `detail` is a dict literal without a `reason` key.

Shared by tools/error-reasons-baseline.json and
engine/tests/test_error_reason_baseline.py — the baseline can only go down
(docs/development/2026-10-15-errori-multilingua.md, §6).
"""
from __future__ import annotations

import argparse
import ast
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ENGINE_SRC = REPO / "engine" / "src"

DOMAIN_ERROR_CLASSES = {
    "DomainError",
    "ValidationError",
    "InvalidTransitionError",
    "ConflictError",
    "PermissionDeniedError",
    "NotFoundError",
    "CommandInProgressError",
    "BudgetExhaustedError",
    "BackendUnavailableError",
}


def _domain_error_class_names(src_root: Path = ENGINE_SRC) -> set[str]:
    """Known DomainError classes plus every subclass defined in the sources.

    Discovery is iterative (subclasses of subclasses) so custom names like
    MaterialTooLargeError cannot slip past the ratchet.
    """
    names = set(DOMAIN_ERROR_CLASSES)
    changed = True
    trees = [(path, tree) for path, tree in _iter_files(src_root)]
    while changed:
        changed = False
        for _path, tree in trees:
            for node in ast.walk(tree):
                if not isinstance(node, ast.ClassDef):
                    continue
                if node.name in names:
                    continue
                bases = {b.id for b in node.bases if isinstance(b, ast.Name)}
                if bases & names:
                    names.add(node.name)
                    changed = True
    return names


def _iter_files(src_root: Path):
    for path in sorted(src_root.rglob("*.py")):
        if "__pycache__" not in str(path):
            try:
                yield path, ast.parse(path.read_text(encoding="utf-8"))
            except SyntaxError:
                continue


def domain_raises_without_reason(src_root: Path = ENGINE_SRC) -> list[dict]:
    class_names = _domain_error_class_names(src_root)
    rows: list[dict] = []
    for path, tree in _iter_files(src_root):
        for node in ast.walk(tree):
            if not isinstance(node, ast.Raise) or not isinstance(node.exc, ast.Call):
                continue
            func = node.exc.func
            name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", "")
            if name not in class_names:
                continue
            if any(kw.arg == "reason" for kw in node.exc.keywords):
                continue
            rows.append({"file": str(path.relative_to(src_root)), "line": node.lineno,
                         "class": name})
    return rows


def _embeds_exception_text(node: ast.AST, aliases: frozenset[str]) -> bool:
    """A param expression that references an active `except ... as X` alias,
    or calls repr(): both leak technical exception text into user-facing params."""
    for sub in ast.walk(node):
        if isinstance(sub, ast.Name) and sub.id in aliases:
            return True
        if (isinstance(sub, ast.Call) and isinstance(sub.func, ast.Name)
                and sub.func.id == "repr"):
            return True
    return False


def params_with_raw_exception_text(src_root: Path = ENGINE_SRC) -> list[dict]:
    """Raises whose `params` interpolate raw exception text (str(exc), f'{exc}',
    repr(...)). Those values would surface untranslated library messages in the
    user-facing sentence; the exception text belongs to `message` only
    (docs/development/2026-10-15-errori-multilingua.md, invariant of the fixes).
    """
    class_names = _domain_error_class_names(src_root)
    rows: list[dict] = []
    try_nodes = (ast.Try, ast.TryStar) if hasattr(ast, "TryStar") else (ast.Try,)

    def check_raise(node: ast.Raise, aliases: frozenset[str]) -> None:
        if not isinstance(node.exc, ast.Call):
            return
        func = node.exc.func
        name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", "")
        if name not in class_names or not any(kw.arg == "reason" for kw in node.exc.keywords):
            return
        for kw in node.exc.keywords:
            if kw.arg != "params" or not isinstance(kw.value, ast.Dict):
                continue
            for key, value in zip(kw.value.keys, kw.value.values):
                if _embeds_exception_text(value, aliases):
                    rows.append({
                        "file": str(_current_file.relative_to(src_root)),
                        "line": node.lineno,
                        "param": key.value if isinstance(key, ast.Constant) else "?",
                    })

    def visit(node: ast.AST, aliases: frozenset[str]) -> None:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            # New scope: except aliases from the enclosing function are not
            # visible here, so the nested body starts with no aliases.
            for stmt in node.body:
                visit(stmt, frozenset())
            return
        if isinstance(node, try_nodes):
            for stmt in node.body + node.orelse + node.finalbody:
                visit(stmt, aliases)
            for handler in node.handlers:
                inner = aliases | {handler.name} if handler.name else aliases
                for stmt in handler.body:
                    visit(stmt, inner)
            return
        if isinstance(node, ast.Raise):
            check_raise(node, aliases)
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.stmt):
                visit(child, aliases)

    for path, tree in _iter_files(src_root):
        _current_file = path
        visit(tree, frozenset())
    return rows


def http_details_without_reason(src_root: Path = ENGINE_SRC) -> list[dict]:
    rows: list[dict] = []
    for path, tree in _iter_files(src_root):
        for node in ast.walk(tree):
            if not isinstance(node, ast.Raise) or not isinstance(node.exc, ast.Call):
                continue
            func = node.exc.func
            name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", "")
            if name != "HTTPException":
                continue
            for kw in node.exc.keywords:
                if kw.arg == "detail" and isinstance(kw.value, ast.Dict):
                    keys = {k.value for k in kw.value.keys if isinstance(k, ast.Constant)}
                    if "reason" not in keys:
                        rows.append({"file": str(path.relative_to(src_root)),
                                     "line": node.lineno})
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args()
    domain = domain_raises_without_reason()
    http = http_details_without_reason()
    if args.json:
        print(json.dumps({
            "domain_raises_without_reason": len(domain),
            "http_details_without_reason": len(http),
        }))
        return 0
    print(f"DomainError raises without reason: {len(domain)}")
    print(f"HTTPException dict details without reason: {len(http)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
