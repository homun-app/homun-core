"""Sync a skill catalog repository into the workspace (H20 hub/source).

The repository layout mirrors the homun-skills catalog:
``<category>/<name>/SKILL.md`` plus optional support files (references/,
scripts/, templates/) which land in the skill's ``resources``.

Safety rules — the human always wins:
- a skill name not in the workspace is seeded approved as ``homun:builtin``;
- a builtin nobody touched since the last sync (body hash matches the
  recorded state, or the embedded snapshot on first migration) is updated
  to the repository version;
- anything a human edited, approved differently, or archived is reported as
  ``kept_human`` and never modified.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Any, Dict

from homun.domain.models import Actor

logger = logging.getLogger(__name__)

BUILTIN_AUTHOR = "homun:builtin"
MAX_RESOURCE_BYTES = 64 * 1024
MAX_RESOURCE_FILES = 24
_STATE_FILENAME = "skill_catalog_state.json"


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _load_state(ctx) -> Dict[str, str]:
    try:
        return json.loads((ctx.data_dir / _STATE_FILENAME).read_text())
    except Exception:
        return {}


def _save_state(ctx, state: Dict[str, str]) -> None:
    try:
        (ctx.data_dir / _STATE_FILENAME).write_text(
            json.dumps(state, ensure_ascii=False, sort_keys=True))
    except Exception:
        logger.warning("Skill catalog state could not be persisted", exc_info=True)


def _parse_skill_md(path: Path, category: str) -> Dict[str, Any] | None:
    text = path.read_text(encoding="utf-8")
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    if not m:
        return None
    head, body = m.groups()

    def field(name: str) -> str:
        mm = re.search(rf"^{name}:\s*(.+)$", head, re.M)
        return mm.group(1).strip().strip('"').strip("'") if mm else ""

    name = field("name") or path.parent.name
    tags_raw = re.search(r"^\s+tags:\s*\[(.+?)\]", head, re.M)
    tags = []
    if tags_raw:
        tags = [t.strip().strip('"').strip("'").lower() for t in tags_raw.group(1).split(",")]
    tags.append(category.lower())
    seen, normalized = set(), []
    for t in tags:
        if t and t not in seen:
            seen.add(t)
            normalized.append(t)
        if len(normalized) >= 8:
            break
    return {"name": name, "description": field("description")[:120],
            "body": body.strip(), "tags": normalized, "dir": path.parent}


def _collect_resources(skill_dir: Path) -> tuple[Dict[str, str], list[str]]:
    resources: Dict[str, str] = {}
    notes: list[str] = []
    candidates = sorted(p for p in skill_dir.rglob("*")
                        if p.is_file() and p.name != "SKILL.md")
    for support in candidates[:MAX_RESOURCE_FILES]:
        rel = str(support.relative_to(skill_dir))
        try:
            data = support.read_bytes()
        except OSError:
            notes.append(f"unreadable:{rel}")
            continue
        if len(data) > MAX_RESOURCE_BYTES or b"\x00" in data[:8192]:
            notes.append(f"skipped_too_large_or_binary:{rel}")
            continue
        try:
            resources[rel] = data.decode("utf-8")
        except UnicodeDecodeError:
            notes.append(f"skipped_binary:{rel}")
    if len(candidates) > MAX_RESOURCE_FILES:
        notes.append(f"truncated:{len(candidates) - MAX_RESOURCE_FILES} more files")
    return resources, notes


def _machine_only_history(store, skill_id: str) -> bool:
    """True se ogni comando registrato su questa skill viene dai tool di catalogo."""
    machine_prefixes = ("catalog-sync:", "builtin-skill:", "curate:")
    for record in store.commands.values():
        result = record.result if isinstance(record.result, dict) else {}
        if result.get("skill_id") == skill_id and not record.command_id.startswith(machine_prefixes):
            return False
    return True


def sync_skill_catalog(ctx, catalog_path: str | Path, *, rebase: bool = False) -> Dict[str, Any]:
    from homun.application.builtin_skills import CATALOG
    root = Path(catalog_path).expanduser().resolve()
    if not root.is_dir():
        from homun.domain.errors import ValidationError
        raise ValidationError(f"Skill catalog path is not a directory: {root}")
    manifest_path = root / "manifest.json"
    external_only: set[str] = set()
    if manifest_path.exists():
        manifest_skills = json.loads(manifest_path.read_text()).get("skills", [])
        entries = [root / s["path"] for s in manifest_skills]
        external_only = {str(s.get("name", "")).lower() for s in manifest_skills
                       if s.get("external_only")}
    else:
        entries = [p.parent for p in sorted(root.glob("*/*/SKILL.md"))]
    entries = [e for e in entries if (e / "SKILL.md").exists()]

    actor = Actor(id="person_local", workspace_id=ctx.workspace_id,
                  display_name="Skill catalog sync")
    embedded = {e["name"]: e for e in CATALOG}
    state = _load_state(ctx)
    created, updated, kept_human, errors = [], [], [], []
    skipped_external_only: list[str] = []
    res_notes: list[str] = []

    for entry in entries:
        category = entry.parent.parent.name if entry.parent.parent != root else "general"
        parsed = _parse_skill_md(entry / "SKILL.md", category)
        if parsed is None or not parsed["name"]:
            errors.append(f"unparsable:{entry}")
            continue
        name = parsed["name"]
        if name.lower() in external_only:
            skipped_external_only.append(name)
            continue
        resources, res_notes = _collect_resources(parsed["dir"])
        payload = {"name": name, "description": parsed["description"],
                   "body": parsed["body"], "tags": parsed["tags"],
                   "resources": resources}
        try:
            outcome = _sync_one(ctx, actor, payload, embedded.get(name), state, rebase=rebase)
            if outcome == "created":
                created.append(name)
            elif outcome == "updated":
                updated.append(name)
            elif outcome == "kept_human":
                kept_human.append(name)
        except Exception:
            errors.append(name)
            logger.warning("Skill catalog sync failed for %s", name, exc_info=True)

    archived_removed = _archive_absent_pristine(ctx, actor, entries, external_only, state)
    _save_state(ctx, state)
    return {"source": str(root), "skills_seen": len(entries), "created": created,
            "updated": updated, "kept_human": kept_human, "errors": errors,
            "external_only": skipped_external_only, "archived_absent": archived_removed,
            "resource_notes": res_notes}


def _archive_absent_pristine(ctx, actor, entries, external_only, state) -> list[str]:
    """Catalog hygiene: pristine builtins the repo no longer ships get archived."""
    from homun.domain.errors import DomainError
    shipped = {e.name.lower() for e in entries} - {h.lower() for h in external_only}
    archived = []
    for skill in list(ctx.repository.load().skills.values()):
        if (skill.author_id != BUILTIN_AUTHOR or skill.status != "approved"
                or skill.name.lower() in shipped):
            continue  # hermes-only skills are, by definition, no longer shipped
        baseline = state.get(skill.name) or None
        if baseline is not None and _sha(skill.body) != baseline:
            continue  # human-touched: keep it
        try:
            with ctx.repository.locked():
                with ctx.repository.transaction() as write_store:
                    ctx.service.for_store(write_store).apply(
                        actor, f"catalog-sync:{skill.name}:absent", "skill.archive",
                        {"skill_id": skill.id, "expected_version": skill.revision})
                ctx.service.store = write_store
            state.pop(skill.name, None)
            archived.append(skill.name)
        except DomainError:
            continue
    return archived


def _sync_one(ctx, actor, payload, embedded_entry, state, *, rebase: bool = False) -> str:
    name = payload["name"]
    store = ctx.repository.load()
    current = next((s for s in store.skills.values() if s.name.lower() == name.lower()), None)
    with ctx.repository.locked():
        with ctx.repository.transaction() as write_store:
            service = ctx.service.for_store(write_store)
            fingerprint = _sha(payload["body"] + json.dumps(payload["resources"], sort_keys=True))[:12]
            if current is None:
                service.apply(actor, f"catalog-sync:{name}:{fingerprint}:c", "skill.create", {
                    **payload, "author_type": "person", "author_id": BUILTIN_AUTHOR,
                    "status": "approved"})
                state[name] = _sha(payload["body"])
                return "created"
            if current.author_id != BUILTIN_AUTHOR:
                return "kept_human"
            baseline = state.get(name) or (
                _sha(embedded_entry["body"]) if embedded_entry else None)
            drifted = baseline is not None and _sha(current.body) != baseline
            if drifted and not (rebase and _machine_only_history(write_store, current.id)):
                return "kept_human"  # a human changed it since the last sync
            if drifted:
                state[name] = _sha(current.body)  # machine-only drift, rebased
            if (current.body == payload["body"]
                    and sorted(current.tags) == sorted(payload["tags"])
                    and (current.resources or {}) == payload["resources"]
                    and current.description == payload["description"]):
                return "unchanged"
            # Unique per attempt: a recorded-but-failed intent must never poison
            # a later retry with the same id and a different expected_version.
            service.apply(actor, f"catalog-sync:{name}:{fingerprint}:r{current.revision}:p", "skill.patch", {
                "skill_id": current.id, "expected_version": current.revision,
                "description": payload["description"],
                "body": payload["body"], "tags": payload["tags"],
                "resources": payload["resources"]})
            state[name] = _sha(payload["body"])
            return "updated"

