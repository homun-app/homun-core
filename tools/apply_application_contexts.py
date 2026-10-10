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


def load_entries(map_path: Path, context: str | None) -> dict[str, str]:
    """Map vecchio modulo -> nuovo percorso relativo (senza .py), filtrato per contesto."""
    raw = json.loads(map_path.read_text(encoding="utf-8"))
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
    """Riscrive `homun.application.<old>` ovunque (codice e stringhe), bordo-parola.

    Un'unica regex in alternanza (chiavi più lunghe prima) con callback:
    re.sub non riscansiona il testo sostituito, quindi una chiave corta
    (agent/runs) non può mai infilarsi nel risultato di una chiave lunga
    (agent/run_execution -> agent.runs.run_execution).
    """
    if not entries:
        return content, []
    keys = sorted(entries, key=len, reverse=True)
    pattern = re.compile("|".join(
        rf"homun\.application\.{re.escape(key.replace('/', '.'))}(?!\w)" for key in keys))
    by_dotted = {key.replace("/", "."): key for key in keys}
    changed: list[str] = []

    def replace(match: re.Match) -> str:
        old = by_dotted[match.group(0)[len("homun.application."):]]
        changed.append(old)
        return f"homun.application.{entries[old].replace('/', '.')}"

    return pattern.sub(replace, content), changed


def rewrite_from_imports(content: str, entries: dict[str, str]) -> tuple[str, list[str]]:
    """Riscrive `from homun.application[.<pkg>] import X[, Y] [as ...]` una riga per pacchetto.

    Va eseguita DOPO rewrite_dotted: se un modulo spostato dà nome a un gruppo
    (es. agent/runs.py -> agent/runs/runs.py) la riga emessa contiene il nuovo
    pacchetto, e un pass dotted successivo la corromperebbe.
    """
    statement = re.compile(
        r"^([ \t]*)from (homun\.application(?:\.[\w.]+)?) import ([\w., ]+?)(\s*#.*)?$", re.M)
    changed: list[str] = []

    def replace(match: re.Match) -> str:
        indent, prefix, symbols_text, comment = (match.group(1), match.group(2),
                                                 match.group(3), match.group(4) or "")
        prefix_path = prefix.removeprefix("homun.application").lstrip(".").replace(".", "/")
        symbols = [part.strip() for part in symbols_text.split(",")]
        grouped: dict[str, list[str]] = {}
        unmapped: list[str] = []
        for symbol in symbols:
            name, _, alias = (part.strip() for part in symbol.partition(" as "))
            key = f"{prefix_path}/{name}" if prefix_path else name
            if key not in entries:
                unmapped.append(symbol)  # pacchetto non coinvolto dalla mappa: riga residua intatta
                continue
            package, stem = entries[key].rsplit("/", 1)
            binding = alias or name
            grouped.setdefault(package, []).append(stem if stem == binding else f"{stem} as {binding}")
        lines = []
        if unmapped:
            lines.append(f"{indent}from {prefix} import {', '.join(unmapped)}")
        lines.extend(f"{indent}from homun.application.{package.replace('/', '.')} import {', '.join(names)}"
                     for package, names in grouped.items())
        rebuilt = "\n".join(lines)
        if comment:  # il commento resta sulla prima riga emessa
            rebuilt = rebuilt.replace("\n", f"{comment}\n", 1) if "\n" in rebuilt else rebuilt + comment
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


def run(args: argparse.Namespace, entries: dict[str, str]) -> int:
    moves = [] if args.rewrite_only else plan_moves(entries)
    contexts = sorted({new.split("/", 1)[0] for new in entries.values()})
    print(f"contesti: {', '.join(contexts)} | spostamenti: {len(moves)} | voci mappa: {len(entries)}")

    diffs: list[str] = []
    for path in scope_files():
        original = path.read_text(encoding="utf-8")
        rewritten, _ = rewrite_dotted(original, entries)
        rewritten, from_imports = rewrite_from_imports(rewritten, entries)
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
        rewritten, _ = rewrite_dotted(original, entries)
        rewritten, _ = rewrite_from_imports(rewritten, entries)
        if rewritten != original:
            path.write_text(rewritten, encoding="utf-8")
            rewritten_files += 1
    print(f"spostati {len(moves)} file, riscritti {rewritten_files} file")
    return check(entries)


def check(entries: dict[str, str]) -> int:
    """Fallisce se resta un riferimento ai vecchi percorsi delle voci selezionate."""
    from_import = re.compile(
        r"^from (homun\.application(?:\.[\w.]+)?) import ([\w., ]+?)(?:\s*#.*)?$", re.M)
    leftovers = []
    for path in scope_files():
        content = path.read_text(encoding="utf-8")
        for old in entries:
            for match in re.finditer(
                    rf"homun\.application\.{re.escape(old.replace('/', '.'))}(?!\w)", content):
                # `agent.runs.<modulo>` è un prefisso di pacchetto legittimo quando
                # agent/runs/ esiste come directory: solo il riferimento NUDO al
                # vecchio modulo (o a un suo attributo inesistente) è residuo.
                tail = content[match.end():]
                if tail.startswith("."):
                    member = re.match(r"\w+", tail[1:])
                    if member and ((APPLICATION_DIR / old / member.group(0)).with_suffix(".py").is_file()
                                   or (APPLICATION_DIR / old / member.group(0)).is_dir()):
                        continue
                leftovers.append(f"{path.relative_to(ROOT)}: homun.application.{old}")
        for match in from_import.finditer(content):
            prefix_path = match.group(1).removeprefix("homun.application").lstrip(".").replace(".", "/")
            names = [part.partition(" as ")[0].strip() for part in match.group(2).split(",")]
            keys = {f"{prefix_path}/{n}" if prefix_path else n for n in names}
            stale = sorted(keys & set(entries))
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
    parser.add_argument("--map", type=Path, default=MAP_PATH,
                        help="mappa JSON da applicare (predefinita: tools/application_contexts.json)")
    parser.add_argument("--context", help="applica solo le voci di un contesto")
    parser.add_argument("--dry-run", action="store_true", help="stampa le operazioni e i diff senza scrivere")
    parser.add_argument("--rewrite-only", action="store_true",
                        help="salta i git mv (spostamenti già applicati) e riscrive soltanto gli import")
    parser.add_argument("--check", action="store_true", help="verifica che non restino vecchi percorsi")
    args = parser.parse_args()
    entries = load_entries(args.map, args.context)
    if args.check:
        return check(entries)
    return run(args, entries)


if __name__ == "__main__":
    sys.exit(main())
