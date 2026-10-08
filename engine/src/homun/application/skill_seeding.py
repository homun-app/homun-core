"""Idempotent seeding of the builtin skill catalog into a workspace.

Seeds run at engine startup and on demand via the API. Rules:
- a skill whose name already exists (any status) is never touched again, so
  human edits, approvals and archives always win over the catalog;
- builtin skills are person-authored and pre-approved: they are starting
  methodology, and the curator ignores person-authored skills by design.
"""
from __future__ import annotations

import logging
from typing import Any, Dict

from homun.domain.models import Actor

logger = logging.getLogger(__name__)

BUILTIN_AUTHOR = "homun:builtin"


def seed_builtin_skills(ctx) -> Dict[str, Any]:
    from homun.application.builtin_skills import CATALOG
    actor = Actor(id="person_local", workspace_id=ctx.workspace_id, display_name="Homun builtin catalog")
    created, skipped, retagged = [], [], []
    store = ctx.repository.load()
    by_name = {s.name.lower(): s for s in store.skills.values()}
    for entry in CATALOG:
        current = by_name.get(entry["name"].lower())
        if current is not None:
            # Tag-only realignment for pristine builtins (never human-touched:
            # same body, revision 1, still approved). Everything else is left alone.
            if (current.author_id == BUILTIN_AUTHOR and current.revision == 1
                    and current.status == "approved" and current.body == entry["body"]
                    and sorted(current.tags) != sorted(entry["tags"])):
                try:
                    with ctx.repository.locked():
                        with ctx.repository.transaction() as write_store:
                            ctx.service.for_store(write_store).apply(
                                actor, f"builtin-skill:{entry['name']}:retag", "skill.patch", {
                                    "skill_id": current.id,
                                    "expected_version": current.revision,
                                    "tags": entry["tags"],
                                })
                        ctx.service.store = write_store
                    retagged.append(entry["name"])
                except Exception:
                    logger.warning("Builtin tag realignment failed for %s", entry["name"], exc_info=True)
            skipped.append(entry["name"])
            continue
        try:
            with ctx.repository.locked():
                with ctx.repository.transaction() as write_store:
                    ctx.service.for_store(write_store).apply(
                        actor, f"builtin-skill:{entry['name']}", "skill.create", {
                            "name": entry["name"],
                            "description": entry["description"],
                            "body": entry["body"],
                            "tags": entry["tags"],
                            "author_type": "person",
                            "author_id": BUILTIN_AUTHOR,
                            "status": "approved",
                        })
                ctx.service.store = write_store
            created.append(entry["name"])
        except Exception:
            logger.warning("Builtin skill %s could not be seeded", entry["name"], exc_info=True)
    if created or retagged:
        logger.info("Builtin skill catalog: seeded %d, retagged %d, %d already present",
                    len(created), len(retagged), len(skipped))
    return {"created": created, "skipped": skipped, "retagged": retagged,
            "total_catalog": len(CATALOG)}
