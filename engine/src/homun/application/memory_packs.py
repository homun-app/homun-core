"""Transferable agent dossiers: professional identity + craft memory + skills.

A pack is what a trained collaborator carries between Homun installations:
the structured AgentProfile, the agent's craft memories (methodology, no
project data), and the agent-authored approved skills. Project memories are
deliberately absent — they never travel. Imported skills land in staging
quarantine so a human confirms them before use, exactly like local proposals.
"""
from __future__ import annotations

from homun.domain.errors import ValidationError

PACK_VERSION = 1
_IDENTITY_FIELDS = (
    "responsibility", "specializations", "method", "tone", "autonomy_mode",
    "capabilities", "role", "instructions",
)


def _identity_payload(agent) -> dict:
    payload = {"name": agent.name}
    for field in _IDENTITY_FIELDS:
        value = getattr(agent, field, None)
        if value:
            payload[field] = value
    return payload


def export_pack(ctx, agent_id: str) -> dict:
    store = ctx.repository.load()
    agent = store.agents.get(agent_id)
    if agent is None:
        from homun.domain.errors import NotFoundError
        raise NotFoundError("Agent not found")
    craft = ctx.memory.list(scope="agent", subject_id=agent_id, include_deleted=False)
    skills = [
        s for s in store.skills.values()
        if s.author_type == "agent" and s.author_id == agent_id and s.status == "approved"
    ]
    return {
        "pack_version": PACK_VERSION,
        "workspace_id": ctx.workspace_id,
        "agent": _identity_payload(agent),
        "memories": [
            {"text": n.text, "source_memory_id": n.source_memory_id}
            for n in craft
        ],
        "skills": [
            {"name": s.name, "description": s.description, "body": s.body,
             "tags": s.tags, "resources": s.resources, "revision": s.revision}
            for s in skills
        ],
    }


def import_pack(ctx, actor, pack: dict) -> dict:
    if actor.kind != "person":
        raise ValidationError("Only a person can import agent dossiers")
    if not isinstance(pack, dict) or not isinstance(pack.get("agent"), dict):
        raise ValidationError("A pack requires an agent identity object")
    name = str(pack["agent"].get("name") or "").strip()
    if not name:
        raise ValidationError("Pack agent name is required")
    store = ctx.repository.load()
    if any(a.name.lower() == name.lower() and a.status != "retired" for a in store.agents.values()):
        raise ValidationError(f"An agent named '{name}' already exists")

    def apply(command_id, kind, payload):
        with ctx.repository.locked():
            with ctx.repository.transaction() as transaction_store:
                result = ctx.service.for_store(transaction_store).apply(
                    actor, command_id, kind, payload)
            ctx.service.store = transaction_store
        return result

    identity = {k: v for k, v in pack["agent"].items() if k != "name"}
    agent = apply("pack:agent", "agent.create", {"name": name, **identity})
    agent_id = agent["agent_id"]

    imported_memories = 0
    for item in pack.get("memories") or []:
        text = str((item or {}).get("text") or "").strip()
        if not text:
            continue
        ctx.memory.add_approved(
            text=text, actor_id=actor.id, scope="agent", subject_id=agent_id,
            source_memory_id=str(item.get("source_memory_id") or "imported") or "imported",
        )
        imported_memories += 1

    imported_skills = 0
    for index, item in enumerate(pack.get("skills") or []):
        if not isinstance(item, dict) or not str(item.get("name") or "").strip():
            continue
        apply(f"pack:skill:{index}", "skill.create", {
            "name": str(item["name"])[:80],
            "description": str(item.get("description") or "")[:120],
            "body": str(item.get("body") or ""),
            "tags": [str(t) for t in (item.get("tags") or [])],
            "resources": {str(k): str(v) for k, v in (item.get("resources") or {}).items()},
            "author_type": "agent",
            "author_id": agent_id,
        })
        imported_skills += 1

    return {"agent_id": agent_id, "memories": imported_memories,
            "skills": imported_skills, "skills_status": "staged"}
