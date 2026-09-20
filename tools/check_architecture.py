#!/usr/bin/env python3
"""Dependency and source growth guardrails; no third-party dependencies.

Checks explicit Python imports (including function-local and relative imports),
not dynamic imports or runtime I/O. Size is a review signal, not modularity proof.
Legacy budgets and exact import exceptions must shrink when code is removed.
"""
from __future__ import annotations

import ast
import json
from pathlib import Path
import subprocess
import sys

SOURCE_SUFFIXES = {".py", ".ts", ".tsx"}
SKIP = {".git", ".venv", "node_modules", "__pycache__", "dist", "dist-prototype", ".output", ".tanstack"}
DOMAIN_FORBIDDEN = (
    "homun.routes", "homun.context", "homun.storage", "homun.models",
    "homun.runtime", "homun.application", "homun.materials.blob", "homun.materials.extract",
    "fastapi", "dbos", "sqlite3", "pydantic_ai", "openai", "httpx", "requests", "subprocess",
)


def sources(root):
    """Honor gitignore in the repository; fixture directories need no git repo."""
    if (root / ".git").exists():
        result = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
                                cwd=root, check=True, capture_output=True)
        candidates = (root / name for name in result.stdout.decode().split("\0") if name)
    else:
        candidates = root.rglob("*")
    return sorted({path for path in candidates if path.is_file() and path.suffix in SOURCE_SUFFIXES
                   and not (set(path.relative_to(root).parts) & SKIP)})


def module_name(path, python_root):
    parts = list(path.relative_to(python_root).with_suffix("").parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def import_nodes(tree, runtime_only):
    for node in ast.iter_child_nodes(tree):
        if runtime_only and isinstance(node, ast.If) and (
            isinstance(node.test, ast.Name) and node.test.id == "TYPE_CHECKING"
            or isinstance(node.test, ast.Attribute) and node.test.attr == "TYPE_CHECKING"
        ):
            for child in node.orelse:
                yield child
                yield from import_nodes(child, runtime_only)
            continue
        yield node
        yield from import_nodes(node, runtime_only)


def imports(tree, module, is_package, runtime_only=False):
    package = module if is_package else module.rpartition(".")[0]
    for node in import_nodes(tree, runtime_only):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield alias.name
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            if node.level:
                parts = package.split(".")
                base = ".".join(parts[:len(parts) - node.level + 1] + ([base] if base else []))
            for alias in node.names:
                yield base if alias.name == "*" else f"{base}.{alias.name}"


def matches(module, prefix):
    return module == prefix or module.startswith(prefix + ".")


def cycles(graph):
    """Return deterministic cycle paths from a directed explicit-import graph."""
    done, active, stack, found = set(), set(), [], []

    def visit(node):
        if node in active:
            found.append(stack[stack.index(node):] + [node])
            return
        if node in done:
            return
        active.add(node)
        stack.append(node)
        for dependency in sorted(graph[node]):
            visit(dependency)
        stack.pop()
        active.remove(node)
        done.add(node)

    for node in sorted(graph):
        visit(node)
    return found


def check(root: Path, baseline: dict):
    errors, reports = [], []
    files = sources(root)
    budgets = baseline.get("line_budgets", {})
    present = set()
    for path in files:
        name = path.relative_to(root).as_posix()
        present.add(name)
        lines = len(path.read_text().splitlines())
        if lines > 500:
            reports.append(f"Review size: {name}: {lines} lines (>500)")
        if name in budgets:
            if lines > budgets[name]:
                errors.append(f"legacy growth: {name}: {lines} > {budgets[name]}")
            elif lines < budgets[name]:
                errors.append(f"Shrink legacy budget: {name}: lower {budgets[name]} to {lines}, or remove if <=500")
        elif lines > 800:
            errors.append(f"New oversized file: {name}: {lines} >800 lines")
    for name in budgets.keys() - present:
        errors.append(f"Remove stale legacy budget: {name}")

    python_root = root / "engine/src"
    modules = {module_name(path, python_root): path for path in files
               if path.suffix == ".py" and path.is_relative_to(python_root)}
    graph = {name: set() for name in modules}
    exceptions = {(item["source"], item["target"]): item for item in baseline.get("import_exceptions", [])}
    used_exceptions = set()
    for module, path in modules.items():
        try:
            tree = ast.parse(path.read_text(), filename=str(path))
        except SyntaxError as exc:
            errors.append(f"Python syntax: {path}: {exc}")
            continue
        runtime_imports = set(imports(tree, module, path.name == "__init__.py", runtime_only=True))
        for imported in imports(tree, module, path.name == "__init__.py"):
            resolved = imported
            while resolved not in modules and "." in resolved:
                resolved = resolved.rpartition(".")[0]
            target = resolved if resolved in modules else imported
            forbidden = matches(module, "homun.domain") and any(matches(target, prefix) for prefix in DOMAIN_FORBIDDEN)
            if matches(module, "homun.routes") and any(matches(target, prefix) for prefix in ("sqlite3", "homun.storage.sqlite")):
                forbidden = True
            if forbidden:
                key = (module, target)
                if key in exceptions and exceptions[key].get("reason"):
                    used_exceptions.add(key)
                else:
                    errors.append(f"forbidden import: {module} -> {target}")
            if imported in runtime_imports and target in graph and target != module:
                graph[module].add(target)
    for key in exceptions.keys() - used_exceptions:
        errors.append(f"stale import exception: {key[0]} -> {key[1]}")
    for cycle in cycles(graph):
        errors.append("import cycle: " + " -> ".join(cycle))
    return errors, reports


def main():
    root = Path(__file__).resolve().parents[1]
    baseline = json.loads((root / "tools/architecture-baseline.json").read_text())
    errors, reports = check(root, baseline)
    for report in reports:
        print(report)
    for error in errors:
        print(f"ERROR: {error}")
    print(f"Architecture: {len(errors)} error(s), {len(reports)} size review notice(s)")
    return bool(errors)


if __name__ == "__main__":
    sys.exit(main())
