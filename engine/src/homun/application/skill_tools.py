"""Execution of skill discovery, progressive disclosure, and learning tools (H19/H20).

Derived from Hermes tools/skills_tool.py, tools/skill_manager.py, and
tools/skills_guard.py (MIT).
Homun keeps untrusted or newly proposed skills in a staged quarantine until
approved by a human person. Staged skills cannot be executed or viewed as trusted guidance.
"""
from __future__ import annotations

import uuid
from homun.domain.errors import ValidationError


def execute(ctx, actor, run, tool, args):
    if run.get("skills", {}).get("policy") != "workspace-catalog-v1":
        raise ValidationError("Skills tools are not enabled for this run")

    store = ctx.repository.load()

    if tool == "skill_search":
        query = (args.get("query") or "").strip().lower()
        tag = (args.get("tag") or "").strip().lower()
        limit = max(1, min(args.get("limit", 5), 20))

        matches = []
        for s in sorted(store.skills.values(), key=lambda item: item.name):
            if s.status != "approved":
                continue
            if tag and tag not in [t.lower() for t in s.tags]:
                continue
            if query and query not in s.name.lower() and query not in s.description.lower():
                continue
            matches.append({
                "id": s.id,
                "name": s.name,
                "description": s.description,
                "tags": s.tags,
                "revision": s.revision,
            })
            if len(matches) >= limit:
                break
        return {"skills": matches, "count": len(matches)}

    if tool == "skill_view":
        skill_id = (args.get("skill_id") or "").strip()
        name = (args.get("name") or "").strip().lower()
        if not skill_id and not name:
            return {"error_code": "invalid_arguments", "message": "Specify skill_id or name"}

        skill = None
        if skill_id:
            skill = store.skills.get(skill_id)
        elif name:
            for s in store.skills.values():
                if s.name.lower() == name:
                    skill = s
                    break

        if skill is None:
            return {"error_code": "skill_not_found", "message": f"Skill not found: {skill_id or name}"}

        if skill.status != "approved":
            return {
                "error_code": "skill_untrusted",
                "message": f"Skill '{skill.name}' is {skill.status} (quarantined) and requires human approval before use.",
            }

        return {
            "id": skill.id,
            "name": skill.name,
            "description": skill.description,
            "tags": skill.tags,
            "body": skill.body,
            "author_type": skill.author_type,
            "revision": skill.revision,
        }

    if tool == "skill_propose":
        name = args["name"].strip()
        description = args["description"].strip()
        body = args["body"].strip()
        tags = [str(t).strip() for t in (args.get("tags") or []) if str(t).strip()]

        for s in store.skills.values():
            if s.name.lower() == name.lower() and s.status != "archived":
                return {
                    "error_code": "skill_already_exists",
                    "message": f"A skill with name '{name}' already exists (status: {s.status}).",
                }

        cmd_id = f"cmd_skp_{uuid.uuid4().hex[:12]}"
        payload = {
            "name": name,
            "description": description,
            "body": body,
            "tags": tags,
            "author_type": "agent",
            "author_id": actor.id,
        }
        with ctx.repository.locked():
            with ctx.repository.transaction() as write_store:
                ctx.service.store = write_store
                res = ctx.service.apply(actor, cmd_id, "skill.create", payload)
            ctx.service.store = write_store
            ctx.persist()

        return {
            "status": "staged",
            "skill_id": res["skill_id"],
            "name": name,
            "message": "Skill proposed and placed in staging quarantine. A human must review and approve it.",
        }

    raise ValidationError(f"Unknown skill tool: {tool}")
