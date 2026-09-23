"""Publish a durable tool receipt; never invoke external IO."""
from homun.policy.work import require_work_access
from homun.domain.errors import ConflictError, PermissionDeniedError


def publish(ctx, actor, proposal_id):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            record = store.commands[proposal_id]
            proposal = record.result
            if proposal['status'] == 'completed':
                return
            outcome = proposal['_receipt']
            text = str(outcome.get('text') or '').strip() or '(nessun testo restituito)'
            work_id = proposal['work_id']
            work = require_work_access(store, actor, work_id)
            if actor.id not in {work.owner_id, work.reviewer_id}:
                raise PermissionDeniedError('Publication authority changed')
            if work.version != proposal['expected_version']:
                raise ConflictError('Work changed after external approval')
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
                "title": f"{proposal['server_name']} · {proposal.get('tool')}",
                "content": text,
            })
            from homun.domain.commands.conversations import append_engine_message
            append_engine_message(
                service._context, actor=actor, command_id=f"{proposal_id}:msg",
                conversation_id=work.primary_conversation_id, author_id="homun_engine",
                text=(f"Strumento esterno completato: {proposal['server_name']} · {proposal.get('tool')}. "
                      "Il risultato è pronto per la tua revisione. Fonte: strumento dichiarato da te."),
                event_payload={"artifact_id": artifact["artifact_id"], "proposal_id": proposal_id, "work_id": work_id},
            )
            record.result.update(status="completed", artifact_id=artifact["artifact_id"])
            record.result.pop("error", None)
    ctx.service.store = store
