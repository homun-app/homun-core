#!/usr/bin/env python3
"""Apply tools/application_contexts.json: git mv and deterministic import rewrites.

Moves homun/application/<old>.py to homun/application/<ctx>/<new>.py (git mv,
empty subpackage __init__), then rewrites every reference in engine/src,
engine/tests and tools (*.py): dotted paths in code and strings
(`homun.application.agent_turn` -> `homun.application.agent.turn`, boundary-
safe so agent_turn_state is untouched) and `from homun.application import X`
statements (regrouped per context, aliases preserve the old binding name).
`--context <name>` applies only one context's entries (incremental moves);
`--dry-run` prints the planned operations and diffs without writing; `--check`
fails if any old path for the selected entries still resolves in scope.
"""
from __future__ import annotations

import argparse
import difflib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
APPLICATION_DIR = ROOT / "engine" / "src" / "homun" / "application"
MAP_PATH = ROOT / "tools" / "application_contexts.json"
SCOPE_DIRS = (ROOT / "engine" / "src", ROOT / "engine" / "tests", ROOT / "tools")
SKIP_PARTS = {".venv", "__pycache__", "node_modules"}


def load_entries(context: str | None) -> dict[str, str]:
    """Map vecchio modulo -> nuovo percorso relativo (senza .py), filtrato per contesto."""
    raw = json.loads(MAP_PATH.read_text(encoding="utf-8"))
    entries = {key.removesuffix(".py"): value.removesuffix(".py")
               for key, value in raw.items() if key != "__init__.py"}
    if context:
        entries = {old: new for old, new in entries.items() if new.startswith(context + "/")}
        if not entries:
            raise SystemExit(f"nessuna voce del contesto {context!r} nella mappa")
    return entries


def scope_files() -> list[Path]:
    files = []
    for directory in SCOPE_DIRS:
        for path in directory.rglob("*.py"):
            if not (set(path.relative_to(ROOT).parts) & SKIP_PARTS):
                files.append(path)
    return sorted(files)


def rewrite_dotted(content: str, entries: dict[str, str]) -> tuple[str, list[str]]:
    """Riscrive `homun.application.<old>` ovunque (codice e stringhe), bordo-parola."""
    changed = []
    for old in sorted(entries, key=len, reverse=True):
        new = entries[old].replace("/", ".")
        pattern = re.compile(rf"homun\.application\.{re.escape(old)}(?!\w)")
        if pattern.search(content):
            content = pattern.sub(f"homun.application.{new}", content)
            changed.append(old)
    return content, changed


def rewrite_from_imports(content: str, entries: dict[str, str]) -> tuple[str, list[str]]:
    """Riscrive `from homun.application import X[, Y] [as ...]` una riga per contesto."""
    statement = re.compile(r"^([ \t]*)from homun\.application import ([\w., ]+)$", re.M)
    changed: list[str] = []

    def replace(match: re.Match) -> str:
        indent, symbols_text = match.group(1), match.group(2)
        symbols = [part.strip() for part in symbols_text.split(",")]
        grouped: dict[str, list[str]] = {}
        unmapped: list[str] = []
        for symbol in symbols:
            name, _, alias = (part.strip() for part in symbol.partition(" as "))
            if name not in entries:
                unmapped.append(symbol)  # contesto non ancora applicato: riga residua intatta
                continue
            context, stem = entries[name].split("/", 1)
            binding = alias or name
            grouped.setdefault(context, []).append(stem if stem == binding else f"{stem} as {binding}")
        lines = []
        if unmapped:
            lines.append(f"{indent}from homun.application import {', '.join(unmapped)}")
        lines.extend(f"{indent}from homun.application.{context} import {', '.join(names)}"
                     for context, names in grouped.items())
        rebuilt = "\n".join(lines)
        if rebuilt != match.group(0):
            changed.append(match.group(0).strip())
        return rebuilt

    return statement.sub(replace, content), changed


def plan_moves(entries: dict[str, str]) -> list[tuple[Path, Path]]:
    moves = []
    for old, new in sorted(entries.items()):
        source = APPLICATION_DIR / f"{old}.py"
        target = APPLICATION_DIR / new
        target = target.with_suffix(".py")
        if not source.exists():
            raise SystemExit(f"origine mancante (già spostato?): {source}")
        if target.exists():
            raise SystemExit(f"destinazione esistente: {target}")
        moves.append((source, target))
    return moves


def run(args: argparse.Namespace) -> int:
    entries = load_entries(args.context)
    moves = [] if args.rewrite_only else plan_moves(entries)
    contexts = sorted({new.split("/", 1)[0] for new in entries.values()})
    print(f"contesti: {', '.join(contexts)} | spostamenti: {len(moves)} | voci mappa: {len(entries)}")

    diffs: list[str] = []
    for path in scope_files():
        original = path.read_text(encoding="utf-8")
        rewritten, from_imports = rewrite_from_imports(original, entries)
        rewritten, _ = rewrite_dotted(rewritten, entries)
        if from_imports:
            print(f"  from-import riscritti in {path.relative_to(ROOT)}: {len(from_imports)}")
        if rewritten != original:
            diffs.append("\n".join(difflib.unified_diff(
                original.splitlines(keepends=True), rewritten.splitlines(keepends=True),
                fromfile=str(path.relative_to(ROOT)), tofile=str(path.relative_to(ROOT)))))

    if args.dry_run:
        print("\n".join(f"git mv {src.relative_to(ROOT)} -> {dst.relative_to(ROOT)}" for src, dst in moves))
        for context in contexts:
            print(f"mkdir + __init__.py vuoto: {APPLICATION_DIR.relative_to(ROOT) / context}")
        print("\n".join(diffs))
        return 0

    for source, target in moves:
        target.parent.mkdir(parents=True, exist_ok=True)
        init = target.parent / "__init__.py"
        if not init.exists():
            init.write_text("", encoding="utf-8")
        subprocess.run(["git", "mv", str(source), str(target)], cwd=ROOT, check=True)
    rewritten_files = 0
    for path in scope_files():
        original = path.read_text(encoding="utf-8")
        rewritten, _ = rewrite_from_imports(original, entries)
        rewritten, _ = rewrite_dotted(rewritten, entries)
        if rewritten != original:
            path.write_text(rewritten, encoding="utf-8")
            rewritten_files += 1
    print(f"spostati {len(moves)} file, riscritti {rewritten_files} file")
    return check(entries)


def check(entries: dict[str, str]) -> int:
    """Fallisce se resta un riferimento ai vecchi percorsi delle voci selezionate."""
    from_import = re.compile(r"^from homun\.application import ([\w., ]+)$", re.M)
    leftovers = []
    for path in scope_files():
        content = path.read_text(encoding="utf-8")
        for old in entries:
            if re.search(rf"homun\.application\.{re.escape(old)}(?!\w)", content):
                leftovers.append(f"{path.relative_to(ROOT)}: homun.application.{old}")
        for match in from_import.finditer(content):
            names = [part.partition(" as ")[0].strip() for part in match.group(1).split(",")]
            stale = sorted(set(names) & set(entries))
            if stale:
                leftovers.append(f"{path.relative_to(ROOT)}: {match.group(0).strip()} (simboli: {', '.join(stale)})")
    if leftovers:
        print("VECCHI PERCORSI RESIDUI:", file=sys.stderr)
        print("\n".join(leftovers), file=sys.stderr)
        return 1
    print("check: nessun vecchio percorso residuo")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", help="applica solo le voci di un contesto")
    parser.add_argument("--dry-run", action="store_true", help="stampa le operazioni e i diff senza scrivere")
    parser.add_argument("--rewrite-only", action="store_true",
                        help="salta i git mv (spostamenti già applicati) e riscrive soltanto gli import")
    parser.add_argument("--check", action="store_true", help="verifica che non restino vecchi percorsi")
    args = parser.parse_args()
    entries = load_entries(args.context)
    if args.check:
        return check(entries)
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
