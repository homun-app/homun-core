#!/usr/bin/env python3
"""Import graph of homun.application modules, built with ast (no execution).

Covers module-level and function-local imports; TYPE_CHECKING blocks included
because a move must rewrite them too. Plain `graph` prints one JSON object
{modulo: [target ordinati]}; `--map` compares a proposed contexts map
(tools/application_contexts.json) against the graph: files per context,
cross-context edge matrix, context-level cycles, and modules whose strongest
coupling suggests a different context than the one assigned.
"""
from __future__ import annotations

import argparse
import ast
from collections import defaultdict
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
APPLICATION_DIR = ROOT / "engine" / "src" / "homun" / "application"
PACKAGE = "homun.application"


def module_paths() -> dict[str, Path]:
    """Nome modulo relativo al pacchetto (contesto incluso, es. agent/turn) -> percorso."""
    return {path.relative_to(APPLICATION_DIR).with_suffix("").as_posix(): path
            for path in sorted(APPLICATION_DIR.rglob("*.py")) if path.name != "__init__.py"}


def imports(tree: ast.AST) -> set[str]:
    """Absolute dotted names for every import in the tree, `from X import Y` as X.Y."""
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            if node.level:
                raise SystemExit(f"relative import non gestito: line {node.lineno} (il pacchetto oggi non ne ha)")
            for alias in node.names:
                found.add(base if alias.name == "*" else f"{base}.{alias.name}")
    return found


def graph() -> dict[str, list[str]]:
    """Edges between application modules, resolved to the longest known module prefix."""
    paths = module_paths()
    dotted = {name: name.replace("/", ".") for name in paths}
    modules = {f"{PACKAGE}.{module}" for module in dotted.values()}
    edges: dict[str, set[str]] = {name: set() for name in paths}
    for name, path in paths.items():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for imported in imports(tree):
            resolved = imported
            while resolved not in modules and resolved.startswith(PACKAGE + "."):
                resolved = resolved.rpartition(".")[0]
            if resolved in modules and resolved != f"{PACKAGE}.{dotted[name]}":
                target = resolved.removeprefix(f"{PACKAGE}.")
                edges[name].add(target.replace(".", "/", 1))
    return {name: sorted(targets) for name, targets in edges.items()}


def context_of(entry: str) -> str:
    parts = entry.split("/")
    return parts[0] if len(parts) > 1 else "(radice)"


def report(mapped: dict[str, str]) -> str:
    mapped = {key.removesuffix(".py"): value for key, value in mapped.items()}
    edges = graph()
    lines: list[str] = []
    unknown = sorted(set(edges) - set(mapped))
    if unknown:
        lines.append(f"ATTENZIONE: {len(unknown)} moduli senza mappa: {', '.join(unknown)}")
    stale = sorted(set(mapped) - set(edges))
    if stale:
        lines.append(f"ATTENZIONE: voci di mappa senza modulo: {', '.join(stale)}")

    per_context: dict[str, list[str]] = defaultdict(list)
    for module, target in mapped.items():
        if module in edges:
            per_context[context_of(target)].append(module)

    lines.append("")
    lines.append("File per contesto:")
    for context in sorted(per_context, key=lambda c: (-len(per_context[c]), c)):
        lines.append(f"  {context}: {len(per_context[context])}")

    cross: dict[tuple[str, str], set[tuple[str, str]]] = defaultdict(set)
    context_graph: dict[str, set[str]] = defaultdict(set)
    for source, targets in edges.items():
        if source not in mapped:
            continue
        source_context = context_of(mapped[source])
        for target in targets:
            target_context = context_of(mapped[target]) if target in mapped else "(?)"
            if target_context != source_context:
                cross[(source_context, target_context)].add((source, target))
                context_graph[source_context].add(target_context)

    contexts = sorted(per_context)
    lines.append("")
    lines.append("Archi fra contesti (coppie distinte modulo->modulo, riga importa colonna):")
    lines.append("  " + " ".join(f"{c[:9]:>9}" for c in contexts))
    for source in contexts:
        row = " ".join(f"{len(cross.get((source, target), [])):>9}" if source != target else "        -"
                       for target in contexts)
        lines.append(f"  {source[:9]:>9} {row}")
    total_cross = sum(len(pairs) for pairs in cross.values())
    lines.append(f"  totale archi fra contesti: {total_cross}")

    # Cicli a livello di contesto (grafo contesti), percorsi minimi deterministici.
    def find_cycles() -> list[list[str]]:
        done, active, stack, found = set(), set(), [], []

        def visit(node: str) -> None:
            if node in active:
                found.append(stack[stack.index(node):] + [node])
                return
            if node in done:
                return
            active.add(node)
            stack.append(node)
            for dependency in sorted(context_graph[node]):
                visit(dependency)
            stack.pop()
            active.remove(node)
            done.add(node)

        for node in sorted(context_graph):
            visit(node)
        return found

    context_cycles = find_cycles()
    lines.append("")
    lines.append(f"Cicli fra contesti: {len(context_cycles)}")
    for cycle in context_cycles[:20]:
        lines.append("  " + " -> ".join(cycle))

    # Per ogni modulo, il contesto con più peso di import (uscita+ingresso):
    # evidenzia dove la classificazione per prefisso contrasta con il grafo.
    in_edges: dict[str, set[str]] = defaultdict(set)
    for source, targets in edges.items():
        for target in targets:
            in_edges[target].add(source)

    def weights(module: str) -> dict[str, int]:
        counts: dict[str, int] = defaultdict(int)
        related = [(m, mapped.get(m, "?")) for m in edges.get(module, ())] + \
                  [(m, mapped.get(m, "?")) for m in in_edges.get(module, ())]
        for _, target in related:
            counts[context_of(target)] += 1
        return counts

    lines.append("")
    lines.append("Moduli il cui contesto assegnato non è quello di massima affinità (peso uscita+ingresso):")
    flagged = 0
    for module in sorted(edges):
        if module not in mapped:
            continue
        assigned = context_of(mapped[module])
        counts = weights(module)
        counts.pop("(?)", None)
        counts.pop(assigned, None)
        if not counts:
            continue
        best = max(sorted(counts), key=lambda c: counts[c])
        assigned_weight = weights(module).get(assigned, 0)
        if counts[best] > assigned_weight and counts[best] >= 3:
            flagged += 1
            lines.append(f"  {module} -> {mapped[module]} | {assigned}={assigned_weight}, "
                         f"{best}={counts[best]}")
    if not flagged:
        lines.append("  (nessuno)")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--map", type=Path, default=None,
                        help="report della mappa contesti (JSON modulo -> nuovo percorso)")
    args = parser.parse_args()
    if args.map:
        raw = json.loads(args.map.read_text(encoding="utf-8"))
        print(report(raw))
    else:
        json.dump(graph(), sys.stdout, indent=2, sort_keys=True)
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
