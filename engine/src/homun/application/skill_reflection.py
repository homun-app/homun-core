"""Post-run reflection: distill methodology lessons into staged skill changes.

Derived from Hermes agent/background_review.py at c9dca726 (MIT,
NousResearch/hermes-agent), adapted to Homun's staged-skill invariants:
the reviewer may only patch agent-authored skills or propose new ones,
every change lands in quarantine, and a person approves it. The reflection
marker is journaled per run, so the sweep can replay it safely.
"""
from __future__ import annotations

import json
import logging

from homun.models.json_payload import extract_json_payload
from homun.models.types import ChatMessage

logger = logging.getLogger(__name__)

_MARKER_TYPE = "skill.reflection"

_SYSTEM_PROMPT = (
    "You review a finished agent work session and distill durable methodology "
    "into the skill library. A skill is the procedure for a class of task: the "
    "steps in order, the concrete decisions, the pitfalls that cost time — not "
    "a narrative of this session. Rules: the same lesson twice is one rule, so "
    "patch an existing skill instead of duplicating it; fix the skill in place "
    "rather than appending updates; no ticket ids, dates or session narration; "
    "never capture environment failures, negative claims about tools, one-off "
    "tasks, or unvalidated sequences of failed attempts. Answer with a single "
    "JSON object only."
)

_OUTPUT_CONTRACT = (
    'Respond as JSON: {"proposals": [{"action": "patch", "skill_id": "<id>", '
    '"expected_version": <number>, "body": "<full updated SKILL body>"}, '
    '{"action": "propose", "name": "<kebab-name>", "description": "<one line>", '
    '"body": "<skill body>", "tags": ["..."]}], "summary": "<one line>"}. '
    "Use an empty proposals list when nothing generalizes; do not invent."
)

_TRANSCRIPT_TAIL = 24


def _agent_actor(ctx, run):
    from homun.domain.models import Actor
    actor_data = run.get("_actor")
    if isinstance(actor_data, dict):
        return Actor.model_validate(actor_data)
    return Actor(id="person_local", workspace_id=ctx.workspace_id, display_name="Reflection")


def _transcript_digest(run) -> str:
    messages = run.get("_messages") or []
    tail = messages[-_TRANSCRIPT_TAIL:]
    lines = []
    for message in tail:
        role = str(message.get("role") or "user")
        content = str(message.get("content") or "").strip()
        if not content:
            continue
        lines.append(f"{role}: {content[:1200]}")
    return "\n".join(lines)


def _catalog(store, agent_id: str) -> str:
    skills = [s for s in store.skills.values()
              if s.author_type == "agent" and s.status in ("approved", "staged")]
    if not skills:
        return "(no agent-authored skills yet)"
    lines = []
    for skill in sorted(skills, key=lambda s: s.name):
        lines.append(
            f"- id={skill.id} name={skill.name} revision={skill.revision} "
            f"status={skill.status}\n  description: {skill.description}\n  "
            f"body[:600]: {skill.body[:600]}")
    return "\n".join(lines)


def maybe_reflect(ctx, run_id: str) -> bool:
    """Reflect once per completed run; idempotent via the journaled marker."""
    from homun.application.agent_runs import PROPOSAL_TYPE
    from homun.application.price_comparisons import save
    store = ctx.repository.load()
    record = store.commands.get(run_id)
    if record is None or record.type != PROPOSAL_TYPE:
        return False
    run = record.result
    if run.get("status") != "completed":
        return False
    if (run.get("skills") or {}).get("policy") != "workspace-catalog-v1":
        return False
    marker_id = f"{run_id}:reflect"
    if marker_id in store.commands:
        return False
    digest = _transcript_digest(run)
    if not digest.strip():
        return False
    actor = _agent_actor(ctx, run)
    outcome = _reflect(ctx, actor, run, digest)
    with ctx.repository.locked():
        with ctx.repository.transaction() as write_store:
            save(write_store, actor, marker_id, _MARKER_TYPE, marker_id, outcome)
        ctx.service.store = write_store
    return bool(outcome.get("applied"))


def _reflect(ctx, actor, run, digest: str) -> dict:
    store = ctx.repository.load()
    assignee = run.get("assignee_id") or ""
    work = store.works.get(run.get("work_id"))
    objective = work.objective if work is not None else "(see transcript)"
    prompt = (
        f"Work objective: {objective}\n"
        f"Agent skill catalog (only these may be patched, by id):\n{_catalog(store, assignee)}\n\n"
        f"Session transcript (tail):\n{digest}\n\n{_OUTPUT_CONTRACT}"
    )
    try:
        result = ctx.models.complete([
            ChatMessage(role="system", content=_SYSTEM_PROMPT),
            ChatMessage(role="user", content=prompt),
        ])
        payload = json.loads(extract_json_payload(result.text))
    except Exception:
        logger.warning("Skill reflection produced no usable payload for %s", run.get("id"), exc_info=True)
        return {"applied": 0, "error": "reflection_payload_invalid"}

    applied = []
    errors = []
    for index, proposal in enumerate(payload.get("proposals") or []):
        if not isinstance(proposal, dict):
            continue
        command_id = f"{run['id']}:reflect:{index}"
        if command_id in ctx.repository.load().commands:
            continue
        try:
            if proposal.get("action") == "patch":
                outcome = _apply(ctx, actor, command_id, "skill.patch", {
                    "skill_id": str(proposal.get("skill_id") or ""),
                    "expected_version": int(proposal.get("expected_version") or 0) or None,
                    "body": str(proposal.get("body") or ""),
                    "author_type": "agent",
                })
            elif proposal.get("action") == "propose":
                outcome = _apply(ctx, actor, command_id, "skill.create", {
                    "name": str(proposal.get("name") or ""),
                    "description": str(proposal.get("description") or "")[:120],
                    "body": str(proposal.get("body") or ""),
                    "tags": [str(t) for t in (proposal.get("tags") or [])],
                    "author_type": "agent",
                    "author_id": assignee,
                })
            else:
                continue
            applied.append({"action": proposal.get("action"), "result": outcome})
        except Exception as exc:  # one bad proposal must not void the others
            errors.append(str(exc)[:200])
    return {"applied": len(applied), "results": applied, "errors": errors,
            "summary": str(payload.get("summary") or "")[:200]}


def _apply(ctx, actor, command_id, kind, payload):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            result = ctx.service.for_store(store).apply(actor, command_id, kind, payload)
        ctx.service.store = store
    return result
