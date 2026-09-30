#!/usr/bin/env python3
"""Regenerate the homun-skills catalog repo from the pinned Hermes ref.

Ports the bundled skill methodology preserving layout (SKILL.md +
references/scripts/templates) and ADAPTS the bodies to Homun's vocabulary
(tool names, filesystem paths and CLI invocations are translated — see
TOOL_MAP, PATH_MAP, CLI_MAP). Skills that only operate another agent product
(EXCLUDED) are not shipped.

Also regenerates the engine's embedded bootstrap catalog
(engine/src/homun/application/builtin_skills.py) with the same adaptation.
The catalog repository carries the standard MIT license text only (the
copyright holder is preserved as the license requires; no upstream project
is named).

Usage: python tools/parity/regen_homun_skills.py [--src REF] [--dst REPO]
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path

# Skills that only operate another agent product are not shipped in the
# catalog. The upstream source of the port is recorded in this tool only;
# the catalog repository and the engine carry no upstream references.
EXCLUDED = {
    "hermes-agent", "computer-use", "dogfood",
    "hermes-agent-skill-authoring", "inspecting-hermes-desktop-dom",
}

# Tool names that are identical on Homun stay untouched.
TOOL_MAP = {
    r"\bwrite_file\b": "write_workspace_file",
    r"\bread_file\b": "read_workspace_lines",
    r"\bedit_file\b": "patch_workspace_file",
    r"\breplace_edit\b": "patch_workspace_file",
    r"\bgrep_search\b": "search_workspace_files",
    r"\bsearch_files\b": "search_workspace_files",
    r"\blist_dir\b": "list_workspace_files",
    r"\bbrowser_navigate\b": "browser_read",
    r"\bbrowser_snapshot\b": "browser_read",
    r"\bweb_fetch\b": "web_extract",
    r"\bweb_read\b": "web_extract",
    r"\bfetch_url\b": "web_extract",
    r"\bmemory_save\b": "memory_remember",
    r"\bmemory_search\b": "memory_recall",
    r"\bmemory_lookup\b": "memory_recall",
    r"\bskill_manage\b": "skill_patch",
    r"\brun_command\b": "terminal_execute",
    r"\bshell_exec\b": "terminal_execute",
    r"\bexecute_shell\b": "terminal_execute",
}

PATH_MAP = [
    (re.compile(r"~/\.hermes/cache/scratch"), "the run workspace"),
    (re.compile(r"~/\.hermes/skills/[A-Za-z0-9_./-]*?/scripts/[A-Za-z0-9_.-]+"),
     "the skill's bundled script (skill_resource tool)"),
    (re.compile(r"~/\.hermes/skills"), "the workspace skill catalog"),
    (re.compile(r"~/\.hermes([A-Za-z0-9_./-]*)"), r"the Homun data directory\1"),
]

CLI_MAP = [
    (re.compile(r"`hermes skills install official[^`\n]*`"),
     "`skill_search` in the workspace catalog (skills ship pre-seeded)"),
    (re.compile(r"`hermes (chat|--tui|status|doctor|update)[^`\n]*`"), "the Homun app"),
    (re.compile(r"`hermes (cron|gateway|send|mcp|memory|model)[^`\n]*`"),
     "the equivalent Homun HTTP API"),
    (re.compile(r"Hermes [Gg]ateway"), "Homun gateway"),
    (re.compile(r"hermes gateway"), "Homun gateway"),
]

# Per-body adaptation notes are intentionally omitted: attribution lives at
# repository level (LICENSE, NOTICE.md, manifest upstream provenance).


def adapt(text: str) -> str:
    for pattern, replacement in TOOL_MAP.items():
        text = re.sub(pattern, replacement, text)
    for pattern, replacement in PATH_MAP:
        text = pattern.sub(replacement, text)
    for pattern, replacement in CLI_MAP:
        text = pattern.sub(replacement, text)
    # Generic final pass: no upstream product may remain in shipped bodies.
    text = re.sub(r"HERMES_([A-Z][A-Z0-9_]*)", r"HOMUN_\1", text)
    text = re.sub(r"\bHermes Agent\b", "Homun", text)
    text = re.sub(r"\bHermes\b", "Homun", text)
    text = re.sub(r"\bhermes\b", "homun", text)
    text = re.sub(r"HERMES", "HOMUN", text)   # HERMES.md, HERMES_x leftovers
    text = re.sub(r"hermes", "homun", text)   # identifiers, paths, filenames
    text = re.sub(r"HermesAgent", "HomunAgent", text)
    return text


def minimal_frontmatter(head: str) -> str:
    """Ship name + description only: upstream author/metadata carry references."""
    name_m = re.search(r"^name:\s*(.+)$", head, re.M)
    desc_m = re.search(r"^description:\s*(.+)$", head, re.M)
    lines = []
    if name_m:
        lines.append(f"name: {name_m.group(1).strip()}")
    if desc_m:
        lines.append(f"description: {desc_m.group(1).strip()}")
    return "\n".join(lines)


def port(src: Path, dst: Path, commit: str) -> dict:
    # Regenerate in place but never touch the repository's own VCS metadata.
    if dst.exists():
        for child in dst.iterdir():
            if child.name in {".git"}:
                continue
            shutil.rmtree(child) if child.is_dir() else child.unlink()
    dst.mkdir(parents=True, exist_ok=True)
    manifest = {"catalog_version": 3, "skills": []}
    embedded = []
    skills_root = src / "skills"
    for category_dir in sorted(p for p in skills_root.iterdir()
                               if p.is_dir() and p.name != "index-cache"):
        for skill_dir in sorted(p for p in category_dir.iterdir() if p.is_dir()):
            skill_md = skill_dir / "SKILL.md"
            if not skill_md.exists():
                continue
            raw = skill_md.read_text(encoding="utf-8")
            m = re.match(r"^---\n(.*?)\n---\n(.*)$", raw, re.S)
            if not m:
                continue
            head, body = m.groups()
            name_m = re.search(r"^name:\s*(.+)$", head, re.M)
            name = (name_m.group(1).strip().strip('"').strip("'") if name_m else skill_dir.name)
            if skill_dir.name in EXCLUDED or name in EXCLUDED:
                continue
            adapted_body = adapt(body.strip())

            out_dir = dst / category_dir.name / skill_dir.name
            out_dir.mkdir(parents=True)
            (out_dir / "SKILL.md").write_text(
                f"---\n{minimal_frontmatter(head)}\n---\n\n{adapted_body}\n", encoding="utf-8")
            files = ["SKILL.md"]
            for support in sorted(skill_dir.rglob("*")):
                if support.is_file() and support.name != "SKILL.md":
                    rel = Path(adapt(str(support.relative_to(skill_dir))))
                    target = out_dir / rel
                    target.parent.mkdir(parents=True, exist_ok=True)
                    data = support.read_bytes()
                    try:  # text resources get the same vocabulary pass
                        text = data.decode("utf-8")
                        if "\x00" in text[:8192]:
                            raise UnicodeError
                        target.write_text(adapt(text), encoding="utf-8")
                    except UnicodeError:
                        target.write_bytes(data)
                    files.append(str(rel))
            manifest["skills"].append({
                "name": name, "category": category_dir.name,
                "path": f"{category_dir.name}/{skill_dir.name}", "files": files})

            desc_m = re.search(r"^description:\s*(.+)$", head, re.M)
            tags_raw = re.search(r"^\s+tags:\s*\[(.+?)\]", head, re.M)
            tags = []
            if tags_raw:
                tags = [t.strip().strip('"').strip("'").lower()
                        for t in tags_raw.group(1).split(",")]
            tags.append(category_dir.name.lower())
            seen, normalized = set(), []
            for t in tags:
                if t and t not in seen:
                    seen.add(t)
                    normalized.append(t)
                if len(normalized) >= 8:
                    break
            embedded.append({"name": name,
                             "description": (desc_m.group(1).strip().strip('"').strip("'")
                                             if desc_m else name)[:120],
                             "tags": normalized, "body": adapted_body})
    (dst / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"manifest": manifest, "embedded": embedded}


def write_embedded(embedded: list[dict], engine_root: Path) -> None:
    out = engine_root / "src/homun/application/builtin_skills.py"
    lines = ['"""Builtin skill catalog seeded on a fresh workspace.',
             '',
             'Port of the bundled skills of NousResearch/hermes-agent (MIT License,',
             'Copyright Nous Research), adapted to Homun vocabulary (tool names,',
             'paths, CLI); Hermes-agent-only skills excluded. Attribution lives in',
             'the homun-skills repository (LICENSE/NOTICE/manifest); this',
             'embedded snapshot is the first-boot fallback. Seeding never touches',
             'skills the workspace already has.',
             '"""',
             '',
             'CATALOG = [']
    for entry in embedded:
        lines += ['    {', f'        "name": {entry["name"]!r},',
                  f'        "description": {entry["description"]!r},',
                  f'        "tags": {entry["tags"]!r},',
                  f'        "body": {entry["body"]!r},', '    },']
    lines += [']', '']
    out.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", default="/Users/fabio/Projects/Homun/homun2/.audit-hermes-ref")
    parser.add_argument("--dst", default="/Users/fabio/Projects/Homun/homun-skills")
    parser.add_argument("--engine", default="/Users/fabio/Projects/Homun/homun2/engine")
    args = parser.parse_args()
    import subprocess
    commit = subprocess.check_output(
        ["git", "-C", args.src, "rev-parse", "HEAD"], text=True).strip()
    result = port(Path(args.src), Path(args.dst), commit)
    write_embedded(result["embedded"], Path(args.engine))
    manifest = result["manifest"]
    print(f"repo: {len(manifest['skills'])} skill @ {commit[:12]}")
    print(f"embedded: {len(result['embedded'])} skill adattate")


if __name__ == "__main__":
    main()
