"""Supervised external-tool calls: the person approves, then the tool runs.

Mirrors the price-comparison contract (proposal record in commands, approval
by a person, execution outside the transaction, artifact for review) so MCP
tools flow through the same grammar as every other capability.
"""
from __future__ import annotations
import json
from copy import deepcopy
from typing import Any

import hashlib


def _digest(proposal: dict) -> str:
    """Binds the approval to the exact server/tool/arguments the person saw."""
    bound = {k: proposal.get(k) for k in ("id", "work_id", "server_id", "tool", "arguments")}
    bound["action"] = "external_tool_call"
    return hashlib.sha256(json.dumps(bound, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
from homun.domain.errors import NotFoundError, PermissionDeniedError, ValidationError
from homun.domain.models import CommandRecord, utc_now
from homun.policy.work import require_work_access

PROPOSAL_TYPE = "external_tool.call"
ACTIVE = {"pending_approval", "queued", "running"}


def _record_public(record: CommandRecord) -> dict[str, Any]:
    r = record.result
    return {k: v for k, v in r.items() if not k.startswith("_")}


def _lookup(store, proposal_id: str, work_id: str | None = None) -> CommandRecord:
    record = store.commands.get(proposal_id)
    if isinstance(record, dict):  # tests may inject a bare result dict
        record = CommandRecord(command_id=proposal_id, type=PROPOSAL_TYPE,
                               actor_id="", workspace_id=store.workspace_id, result=record)
    if record is None or record.type != PROPOSAL_TYPE:
        raise NotFoundError("External tool proposal not found")
    if work_id and record.result.get("work_id") != work_id:
        raise NotFoundError("External tool proposal not found for this work")
    return record


def propose(ctx, actor, body) -> dict[str, Any]:
    """Stage a tool call for human approval. Persists; never executes."""
    work_id = str(body.get("work_id") or "")
    server_id = str(body.get("server_id") or "")
    tool = str(body.get("tool") or "").strip()
    if not work_id or not server_id or not tool:
        raise ValidationError("work_id, server_id and tool are required")
    raw_args = body.get("arguments") or {}
    if not isinstance(raw_args, dict):
        raise ValidationError("arguments must be a JSON object")
    arguments = {str(k): v for k, v in raw_args.items()}
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            require_work_access(store, actor, work_id)
            server = store.external_servers.get(server_id)
            if server is None:
                raise NotFoundError("External server not found")
            if server.status != "enabled":
                raise ValidationError("Server is disabled")
            for existing in store.commands.values():
                if existing.type != PROPOSAL_TYPE:
                    continue
                prior = existing.result
                if prior.get("work_id") == work_id and prior.get("status") in ACTIVE:
                    if prior.get("server_id") == server_id and prior.get("tool") == tool:
                        return deepcopy(_record_public(existing))
                    raise ValidationError("This work already has an active external tool call")
            from homun.domain.models import Actor as _Actor  # noqa: F401
            result = {
                "id": body["command_id"], "status": "pending_approval", "work_id": work_id,
                "server_id": server_id, "server_name": server.name, "tool": tool,
                "arguments": arguments, "expected_version": None,
                "created_by": actor.id, "created_at": utc_now().isoformat(),
            }
            result["digest"] = _digest(result)
            store.commands[body["command_id"]] = CommandRecord(
                command_id=body["command_id"], type=PROPOSAL_TYPE, actor_id=actor.id,
                workspace_id=store.workspace_id, result=result,
            )
        ctx.service.store = store
    return deepcopy(_record_public(ctx.repository.load().commands[body["command_id"]]))


def approve(ctx, actor, proposal_id: str, body) -> dict[str, Any]:
    """A person approves; the call runs and lands as a reviewable artifact."""
    if str(actor.kind) != "person":
        raise PermissionDeniedError("Only a person may approve an external tool call")
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            record = _lookup(store, proposal_id)
            proposal = record.result
            require_work_access(store, actor, str(proposal.get("work_id")))
            if body.get("digest") != proposal.get("digest"):
                raise ValidationError("Approval does not match the proposed call")
            if proposal.get("status") not in ("pending_approval", "queued"):
                raise ValidationError("Proposal already resolved")
            proposal["status"] = "running"
        ctx.service.store = store
    work_id = str(proposal.get("work_id"))
    try:
        store = ctx.repository.load()
        server = store.external_servers.get(str(proposal.get("server_id")))
        if server is None:
            raise RuntimeError("Declared server disappeared")
        from homun.application.mcp_client import call_tool
        outcome = call_tool(server, str(proposal.get("tool")), dict(proposal.get("arguments") or {}))
        if outcome.get("is_error"):
            raise RuntimeError("The tool reported an error result")
        text = str(outcome.get("text") or "").strip() or "(nessun testo restituito)"
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                record = _lookup(store, proposal_id)
                work = require_work_access(store, actor, work_id)
                service = ctx.service.for_store(store)
                version = work.version
                if work.status.value == "draft":
                    plan = service.apply(actor, f"{proposal_id}:plan", "plan.propose", {
                        "work_id": work_id, "expected_version": version, "steps": [
                            {"title": f"Strumento esterno · {proposal.get('tool')}",
                             "assignee_id": actor.id, "capability": "external_tool"}]})
                    accepted = service.apply(actor, f"{proposal_id}:accept", "plan.accept",
                                             {"work_id": work_id, "expected_version": plan["version"]})
                    version = accepted.get("version") or version
                if work.status.value in ("draft", "ready"):
                    started = service.apply(actor, f"{proposal_id}:start", "work.start",
                                            {"work_id": work_id, "expected_version": version})
                else:
                    started = {"version": work.version}
                artifact = service.apply(actor, f"{proposal_id}:artifact", "work.submit_artifact", {
                    "work_id": work_id, "expected_version": started["version"],
                    "title": f"{server.name} · {proposal.get('tool')}",
                    "content": text,
                })
                from homun.domain.commands.conversations import append_engine_message
                append_engine_message(
                    service._context, actor=actor, command_id=f"{proposal_id}:msg",
                    conversation_id=work.primary_conversation_id, author_id="homun_engine",
                    text=(f"Strumento esterno completato: {server.name} · {proposal.get('tool')}. "
                          "Il risultato è pronto per la tua revisione. Fonte: strumento dichiarato da te."),
                    event_payload={"artifact_id": artifact["artifact_id"], "proposal_id": proposal_id, "work_id": work_id},
                )
                record.result.update(status="completed", artifact_id=artifact["artifact_id"])
        ctx.service.store = store
        return deepcopy(_record_public(ctx.repository.load().commands[proposal_id]))
    except BaseException as cause:
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                record = _lookup(store, proposal_id)
                record.result.update(status="failed", error=str(cause)[:300])
            ctx.service.store = store
        return deepcopy(_record_public(ctx.repository.load().commands[proposal_id]))


def list_for_work(ctx, actor, work_id: str) -> dict[str, Any]:
    store = ctx.repository.load()
    require_work_access(store, actor, work_id, "read")
    return {"items": [deepcopy(_record_public(r)) for r in
                      sorted(store.commands.values(), key=lambda r: r.created_at)
                      if r.type == PROPOSAL_TYPE and r.result.get("work_id") == work_id]}
