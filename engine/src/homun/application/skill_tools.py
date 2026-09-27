"""Execution of skill discovery, progressive disclosure, and learning tools (H19/H20).

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
            "resources": sorted(list((skill.resources or {}).keys())),
            "author_type": skill.author_type,
            "revision": skill.revision,
        }

    if tool == "skill_resource":
        skill_id = (args.get("skill_id") or "").strip()
        name = (args.get("name") or "").strip().lower()
        res_path = (args.get("resource_path") or "").strip().replace("\\", "/")
        if not res_path or res_path.startswith("/") or res_path.startswith("../") or "/../" in res_path or res_path == ".." or "\x00" in res_path:
            return {"error_code": "invalid_resource_path", "message": f"Resource path traversal or invalid path: {res_path}"}

        if not skill_id and not name:
            return {"error_code": "invalid_arguments", "message": "Specify skill_id or name"}

        skill = store.skills.get(skill_id) if skill_id else None
        if skill is None and name:
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

        resources = skill.resources or {}
        if res_path not in resources:
            return {"error_code": "resource_not_found", "message": f"Resource '{res_path}' not found in skill '{skill.name}'"}

        return {
            "skill_id": skill.id,
            "name": skill.name,
            "resource_path": res_path,
            "content": resources[res_path],
            "revision": skill.revision,
        }

    if tool == "skill_trust":
        from homun.domain.errors import ConflictError
        is_agent = getattr(actor, "kind", "") == "agent" or (hasattr(actor, "is_person") and not actor.is_person())
        if is_agent:
            has_approval = bool(args.get("approval_token") or args.get("_skill_trust_approved") or run.get("_skill_trust_approved") or run.get("_write_approval_granted"))
            if not has_approval:
                raise ConflictError("skill_trust requires explicit human approval before execution")

        skill_id = (args.get("skill_id") or "").strip()
        name = (args.get("name") or "").strip().lower()
        if not skill_id and not name:
            return {"error_code": "invalid_arguments", "message": "Specify skill_id or name"}

        skill = store.skills.get(skill_id) if skill_id else None
        if skill is None and name:
            for s in store.skills.values():
                if s.name.lower() == name:
                    skill = s
                    break

        if skill is None:
            return {"error_code": "skill_not_found", "message": f"Skill not found: {skill_id or name}"}

        if skill.status == "archived":
            return {"error_code": "skill_archived", "message": f"Skill '{skill.name}' is archived and cannot change trust status"}

        exp_ver = args.get("expected_version")
        if exp_ver is not None and exp_ver != skill.revision:
            raise ConflictError(f"Skill version mismatch: expected {exp_ver}, got {skill.revision}")

        approved = bool(args.get("approved", True))
        cmd_name = "skill.approve" if approved else "skill.archive"
        cmd_id = f"cmd_skt_{uuid.uuid4().hex[:12]}"
        authority_actor = actor
        if is_agent:
            if run.get("_actor") and isinstance(run["_actor"], dict):
                from homun.domain.models import Actor as DomainActor
                authority_actor = DomainActor.model_validate(run["_actor"])
            elif run.get("work_id") and str(run["work_id"]) in store.works:
                work = store.works[str(run["work_id"])]
                from homun.domain.models import Actor as DomainActor
                human_id = work.requester_id or work.owner_id or "human_approver"
                authority_actor = DomainActor(id=human_id, workspace_id=store.workspace_id, display_name="Human Approver", kind="person")
            else:
                from homun.domain.models import Actor as DomainActor
                authority_actor = DomainActor(id="human_approver", workspace_id=store.workspace_id, display_name="Human Approver", kind="person")

        with ctx.repository.locked():
            with ctx.repository.transaction() as write_store:
                ctx.service.store = write_store
                res = ctx.service.apply(authority_actor, cmd_id, cmd_name, {"skill_id": skill.id, "expected_version": skill.revision})
            ctx.service.store = write_store
            ctx.persist()

        return {
            "status": res["status"],
            "skill_id": skill.id,
            "name": skill.name,
            "revision": res["revision"],
            "message": f"Skill '{skill.name}' trust status updated to {res['status']}.",
        }

    if tool == "skill_propose":
        name = args["name"].strip()
        description = args["description"].strip()
        body = args["body"].strip()
        tags = [str(t).strip() for t in (args.get("tags") or []) if str(t).strip()]
        resources = {str(k).strip(): str(v) for k, v in (args.get("resources") or {}).items() if str(k).strip()}

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
            "resources": resources,
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
