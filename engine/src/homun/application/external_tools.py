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
    bound = {k: proposal.get(k) for k in ("id", "work_id", "server_id", "tool", "arguments", "expected_version", "_server_hash", "_tool_descriptor")}
    bound["action"] = "external_tool_call"
    return hashlib.sha256(json.dumps(bound, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
from homun.domain.errors import ConflictError, NotFoundError, PermissionDeniedError, ValidationError
from homun.domain.models import CommandRecord, utc_now
from homun.policy.work import require_work_access

PROPOSAL_TYPE = "external_tool.call"
ACTIVE = {"pending_approval", "queued", "running", "publication_pending"}


def server_hash(server):
    return hashlib.sha256(server.model_dump_json().encode()).hexdigest()


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
    raw_args = body.get("arguments", {})
    if not isinstance(raw_args, dict):
        raise ValidationError("arguments must be a JSON object")
    arguments = {str(k): v for k, v in raw_args.items()}
    from homun.application import mcp_client
    from homun.application.mcp_contracts import select_descriptor, validate_arguments
    initial = ctx.repository.load()
    require_work_access(initial, actor, work_id)
    prior = initial.commands.get(body['command_id'])
    if prior is not None:
        if (prior.type != PROPOSAL_TYPE or prior.actor_id != actor.id or
                any(prior.result.get(k) != v for k,v in {'work_id':work_id,'server_id':server_id,'tool':tool,'arguments':arguments}.items())):
            raise ConflictError('Command id already used for a different request')
        return deepcopy(_record_public(prior))
    initial_server = initial.external_servers.get(server_id)
    if initial_server is None:
        raise NotFoundError('External server not found')
    if initial_server.status != 'enabled' or not mcp_client.filtered_tools(initial_server,[{'name':tool}]):
        raise PermissionDeniedError('Tool is outside the enabled server surface')
    discovered_hash = server_hash(initial_server)
    try:
        discovered = mcp_client.probe_server(initial_server)
    except Exception as exc:
        raise ValidationError('Cannot verify external tool schema; check the server') from exc
    descriptor = select_descriptor(discovered.get('tool_descriptors',[]),tool)
    validate_arguments(descriptor,arguments)
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            work = require_work_access(store, actor, work_id)
            server = store.external_servers.get(server_id)
            if server is None:
                raise NotFoundError("External server not found")
            if server_hash(server) != discovered_hash:
                raise ConflictError("Server changed during discovery; create a new proposal")
            if server.status != "enabled":
                raise ValidationError("Server is disabled")
            from homun.application.mcp_client import filtered_tools
            if not filtered_tools(server, [{'name': tool}]):
                raise PermissionDeniedError('Tool is outside the declared server surface')
            prior_command = store.commands.get(body['command_id'])
            if prior_command is not None:
                prior = prior_command.result
                if (prior_command.type != PROPOSAL_TYPE or prior_command.actor_id != actor.id
                        or any(prior.get(k) != v for k,v in {'work_id':work_id,'server_id':server_id,'tool':tool,'arguments':arguments}.items())):
                    raise ConflictError('Command id already used for a different request')
                return deepcopy(_record_public(prior_command))
            for existing in store.commands.values():
                if existing.type != PROPOSAL_TYPE:
                    continue
                prior = existing.result
                if prior.get("work_id") == work_id and prior.get("status") in ACTIVE:
                    prior_server = store.external_servers.get(prior.get('server_id'))
                    if prior.get('status') in {'pending_approval', 'queued'} and (
                            prior.get('expected_version') != work.version or prior_server is None
                            or prior_server.status != 'enabled' or prior.get('_server_hash') != server_hash(prior_server)
                            or (prior.get('server_id') == server_id and prior.get('tool') == tool and prior.get('_tool_descriptor') != descriptor)):
                        prior.update(status='blocked', error='Proposta superata: lavoro o configurazione cambiati.')
                        continue
                    if (prior.get("server_id") == server_id and prior.get("tool") == tool
                            and prior.get("arguments") == arguments and prior.get("_server_hash") == server_hash(server)):
                        return deepcopy(_record_public(existing))
                    raise ValidationError("This work already has an active external tool call")
            result = {
                "id": body["command_id"], "status": "pending_approval", "work_id": work_id,
                "server_id": server_id, "server_name": server.name, "tool": tool,
                "arguments": deepcopy(arguments), "expected_version": work.version,
                "_server_hash": server_hash(server), "_tool_descriptor": descriptor,
                "tool_description": str(descriptor.get("description") or ""),
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
    """Authorize one dispatch or resume publication from its durable receipt."""
    from datetime import datetime, timedelta
    from homun.application import external_publication, mcp_client
    if str(actor.kind) != "person":
        raise PermissionDeniedError("Only a person may approve an external tool call")
    dispatch = False
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            record = _lookup(store, proposal_id)
            proposal = record.result
            work = require_work_access(store, actor, proposal['work_id'])
            if actor.id not in {work.owner_id, work.reviewer_id}:
                raise PermissionDeniedError('Only the owner or reviewer may approve this call')
            if body.get('digest') != proposal.get('digest'):
                raise ValidationError('Approval does not match the proposed call')
            status = proposal['status']
            if status == 'running':
                deadline = proposal.get('_dispatch_deadline')
                if not deadline or datetime.fromisoformat(deadline) <= utc_now():
                    proposal.update(status='outcome_unknown', error='Esito esterno incerto: verificare sul servizio prima di una nuova azione.')
            elif status in {'pending_approval', 'queued'}:
                server = store.external_servers.get(proposal['server_id'])
                if not proposal.get('_server_hash') or not proposal.get('_tool_descriptor'):
                    proposal.update(status='blocked', error='Proposta precedente: creare una nuova approvazione con configurazione verificata.')
                else:
                    if server is None or server.status != 'enabled' or server_hash(server) != proposal['_server_hash']:
                        raise ConflictError('Server configuration changed; create a new proposal')
                    if _digest(proposal) != proposal['digest']:
                        raise ConflictError('Proposed call changed')
                    if work.version != proposal['expected_version']:
                        raise ConflictError('Work changed; create a new proposal')
                    if not mcp_client.filtered_tools(server, [{'name': proposal['tool']}]):
                        raise PermissionDeniedError('Tool is outside the approved server surface')
                    server = server.model_copy(deep=True)
                    proposal.update(status='running', _dispatch_deadline=(utc_now()+timedelta(seconds=30)).isoformat(),
                                    _approved_by=actor.id, _dispatch_started_at=utc_now().isoformat())
                    dispatch = True
            snapshot = deepcopy(proposal)
        ctx.service.store = store
    if dispatch:
        try:
            outcome = mcp_client.call_tool(server, snapshot['tool'], deepcopy(snapshot['arguments']), snapshot['_tool_descriptor'])
        except mcp_client.MCPPreflightError:
            with ctx.repository.locked():
                with ctx.repository.transaction() as store:
                    _lookup(store,proposal_id).result.update(status="blocked",
                        error="Contratto dello strumento cambiato o non valido: crea una nuova proposta.")
                ctx.service.store=store
        except Exception:
            with ctx.repository.locked():
                with ctx.repository.transaction() as store:
                    _lookup(store,proposal_id).result.update(status='outcome_unknown',
                        error='Esito esterno incerto: verificare sul servizio prima di una nuova azione.')
                ctx.service.store=store
        else:
            # Receipt commit is independent of work access/publication. A crash
            # before this commit leaves the intent uncertain, never redispatched.
            with ctx.repository.locked():
                with ctx.repository.transaction() as store:
                    current=_lookup(store,proposal_id).result
                    current.update(_receipt=deepcopy(outcome), _received_at=utc_now().isoformat(),
                                   status='tool_error' if outcome.get('is_error') else 'publication_pending')
                    current.pop('error',None)
                    if outcome.get('is_error'):
                        current['error']='Lo strumento ha restituito un errore; nessun ritentativo automatico.'
                ctx.service.store=store
    current=ctx.repository.load().commands[proposal_id].result
    if current['status']=='publication_pending':
        try:
            external_publication.publish(ctx,actor,proposal_id)
        except Exception:
            # Keep the receipt even if work changed, access was revoked, or
            # artifact creation failed. A later approval only retries publication.
            with ctx.repository.locked():
                with ctx.repository.transaction() as store:
                    current=_lookup(store,proposal_id).result
                    if current['status']=='publication_pending':
                        current['error']='Risultato salvato; pubblicazione da riprendere senza ripetere la chiamata.'
                ctx.service.store=store
    return deepcopy(_record_public(ctx.repository.load().commands[proposal_id]))


def list_for_work(ctx, actor, work_id: str) -> dict[str, Any]:
    store = ctx.repository.load()
    require_work_access(store, actor, work_id, "read")
    return {"items": [deepcopy(_record_public(r)) for r in
                      sorted(store.commands.values(), key=lambda r: r.created_at)
                      if r.type == PROPOSAL_TYPE and r.result.get("work_id") == work_id]}
