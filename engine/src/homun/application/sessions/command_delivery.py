"""Durable admission and fenced model follow-up, shared by HTTP and SSE.

A model attempt is at-least-once after lease expiry. Its domain result commits
once, fenced by the claim token; no SQLite transaction spans model generation.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, replace
from datetime import timedelta
from uuid import uuid4

from homun.application.sessions.command_types import CommandRequest
from homun.application.sessions.front_door.turn import finalize_front_door, run_front_door_turn
from homun.application.sessions.conversation_context import authorized_conversation_work, revalidate_context
from homun.models.conversation_context import ContextManifest
from homun.context import EngineContext
from homun.domain.errors import CommandInProgressError, ConflictError
from homun.domain.models import Actor, utc_now
from homun.policy.work import require_conversation_access

FOLLOWUP_LEASE = timedelta(minutes=5)
MAX_FOLLOWUP_ATTEMPTS = 3
FOLLOWUP_BACKOFF_SECONDS = 5
# Model-output failures are never retried automatically: the person sends the
# message again (or re-posts it by hand). Transport failures stay retryable.
NON_RETRYABLE_CODES = frozenset({
    'permission_denied', 'not_found', 'validation_error', 'version_conflict',
    'budget_exhausted', 'model.output_invalid', 'model.empty_response',
})


class FollowupLeaseExpiredError(ConflictError):
    """The current claim expired, but retains a bounded recovery budget."""

    code = 'followup_lease_expired'


@dataclass(frozen=True)
class Delivery:
    actor: Actor
    body: CommandRequest
    result: dict
    token: str | None = None
    snapshot: EngineContext | None = None


def _publish(ctx: EngineContext, store) -> None:
    # Cache publication is inside repository.locked(); request reads use snapshots.
    ctx.service.store = store


def require_followup_authority(store, actor, body):
    require_conversation_access(store, actor, body.payload.get('conversation_id', ''))


def _conversation_records(store, conversation_id):
    """Post-message commands linked to one conversation, oldest first."""
    for record in sorted(store.commands.values(), key=lambda item: item.created_at):
        if record.type != 'conversation.post_message':
            continue
        message = store.messages.get(record.result.get('message_id'))
        linked = message.conversation_id if message else (record.followup_body or {}).get('payload', {}).get('conversation_id')
        if linked == conversation_id:
            yield record


def conversation_busy(store, body, now, *, recovering=False):
    conversation_id = body.payload.get('conversation_id')
    pending = []
    for record in _conversation_records(store, conversation_id):
        unfinished = (record.followup_status == 'processing' or
                      (record.followup_status == 'failed' and record.followup_next_attempt_at is not None))
        if unfinished and record.command_id != body.command_id:
            pending.append(record.command_id)
    # Expiry permits takeover of this command, never overtaking by another one.
    if recovering:
        return bool(pending and pending[0] != body.command_id)
    return bool(pending)


def turn_in_flight(store, conversation_id, *, now, exclude):
    """A turn is TRULY in flight: processing under a still-valid lease."""
    for record in _conversation_records(store, conversation_id):
        if record.command_id == exclude or record.followup_status != 'processing':
            continue
        if record.followup_expires_at is None or record.followup_expires_at <= now:
            continue
        return True
    return False


def cancel_superseded_turns(store, conversation_id, *, now, exclude):
    """The new message wins: automatic retries of older turns are cancelled.

    A failed record with a pending retry loses its schedule; an expired
    processing record is fenced out for good. Both stay saved, incomplete and
    manually retryable (re-posting the same message re-claims it).
    """
    for record in _conversation_records(store, conversation_id):
        if record.command_id == exclude:
            continue
        if record.followup_status == 'failed' and record.followup_next_attempt_at is not None:
            record.followup_next_attempt_at = None
        elif record.followup_status == 'processing' and (
                record.followup_expires_at is None or record.followup_expires_at <= now):
            record.followup_status = 'failed'
            record.followup_error = record.followup_error or 'followup_superseded'
            record.followup_token = None
            record.followup_expires_at = None
            record.followup_next_attempt_at = None


def claim(record, actor, body, now):
    record.followup_body = body.model_dump(mode='json')
    record.followup_actor = actor.model_dump(mode='json')
    record.followup_attempts += 1
    record.followup_status = 'processing'
    record.followup_token = uuid4().hex
    record.followup_expires_at = now + FOLLOWUP_LEASE
    record.followup_next_attempt_at = None
    record.followup_error = None
    return record.followup_token


def admit(ctx: EngineContext, actor: Actor, body: CommandRequest) -> Delivery:
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            service = ctx.service.for_store(store)
            if body.type == 'conversation.post_message':
                require_followup_authority(store, actor, body)
            result = service.apply(actor, body.command_id, body.type, body.payload)
            record = store.commands[body.command_id]
            token = None
            if body.type == 'conversation.post_message' and record.followup_status == 'none':
                from homun.application.agent.chat_control import route_message
                route_message(ctx,store,actor,body,result)
            if body.type == 'conversation.post_message' and record.followup_status == 'completed':
                # Cached replies carry the same source authority as fresh replies.
                authorized_conversation_work(store, actor, body.payload.get('conversation_id', ''))
                if manifest := record.result.get('context_manifest'):
                    revalidate_context(store, actor, ContextManifest.model_validate(manifest))
            if body.type == 'conversation.post_message' and record.followup_status != 'completed':
                now = utc_now()
                if (record.followup_status == 'processing' and record.followup_expires_at
                        and record.followup_expires_at > now):
                    raise CommandInProgressError('This message is already being processed; retry after completion',
                                         reason='message.in_progress.same')
                conversation_id = body.payload.get('conversation_id')
                # A new message is only refused while a turn is REALLY in
                # flight; pending automatic retries of older messages step
                # aside (they stay saved and manually retryable).
                if turn_in_flight(store, conversation_id, now=now, exclude=body.command_id):
                    raise CommandInProgressError('Another message in this conversation is being processed',
                                         reason='message.in_progress.other')
                cancel_superseded_turns(store, conversation_id, now=now, exclude=body.command_id)
                # An explicit retry starts a fresh bounded recovery budget.
                record.followup_attempts = 0
                token = claim(record, actor, body, now)
        _publish(ctx, store)
        snapshot = replace(ctx, service=service) if token else None
        return Delivery(actor, body, deepcopy(result), token, snapshot)


def complete(ctx: EngineContext, delivery: Delivery) -> dict:
    # Conversazioni legate a un agente: il messaggio avvia (o steera) il run
    # dell'agente e la risposta torna in chat — la chat singola è con l'agente.
    if (delivery.token is not None and delivery.body.type == "conversation.post_message"
            and getattr(delivery.actor, "kind", "person") == "person"):
        from homun.application.agent import chat_agent
        store_now = ctx.repository.snapshot()
        if chat_agent.handles(ctx, store_now, delivery.body):
            from homun.domain.errors import DomainError as _DE
            try:
                chat_agent.ensure_chat_persona(ctx, delivery.actor)
                outcome = chat_agent.start_chat_turn(
                    ctx, delivery.actor,
                    str(delivery.body.payload.get("conversation_id") or ""),
                    str(delivery.body.payload.get("text") or ""),
                    connection_id=(str(delivery.body.payload.get("connection_id") or "").strip()
                                   or None))
            except _DE as exc:
                fail(ctx, delivery, exc.code)
                raise
            with ctx.repository.locked():
                with ctx.repository.transaction() as store:
                    record = store.commands.get(delivery.body.command_id)
                    if record is not None and record.followup_token == delivery.token:
                        record.result = {**record.result, "assistant_text": None,
                                         "agent_run_id": outcome["agent_run_id"],
                                         "steered": outcome["steered"]}
                        record.followup_status = "completed"
                        record.followup_token = None
                        record.followup_expires_at = None
                ctx.service.store = store
            _publish(ctx, store)
            return {"message_id": record.result.get("message_id"),
                    "agent_run_id": outcome["agent_run_id"],
                    "steered": outcome["steered"],
                    "chat_agent": True}
    if delivery.token is None:
        from homun.runtime.dispatcher import deliver_pending
        result = deliver_pending(ctx, command_id=delivery.body.command_id,
                                 wait_seconds=5 if delivery.body.type == "work.provide_contribution" else 0)
        return result if result is not None else delivery.result
    try:
        # Admission snapshots are not authority after time spent in a queue.
        # Read fresh grants without holding the repository lock across a model call.
        with ctx.repository.locked():
            current = ctx.repository.snapshot()
            require_followup_authority(current, delivery.actor, delivery.body)
            model_context = replace(ctx, service=ctx.service.for_store(current))
        prepared, display = run_front_door_turn(
            model_context, delivery.actor, delivery.body, delivery.result,
        )
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                record = store.commands[delivery.body.command_id]
                if record.followup_token != delivery.token or record.followup_status != 'processing':
                    raise ConflictError('Model attempt superseded; its result was not applied',
                            reason='message.superseded')
                if record.followup_expires_at is None or record.followup_expires_at <= utc_now():
                    raise FollowupLeaseExpiredError('Model attempt lease expired; recovery will retry within its attempt budget')
                require_followup_authority(store, delivery.actor, delivery.body)
                fresh = replace(ctx, service=ctx.service.for_store(store))
                result = finalize_front_door(fresh, delivery.actor, delivery.body, prepared, display)
                record.result = deepcopy(result)
                record.followup_status = 'completed'
                record.followup_next_attempt_at = None
                record.followup_token = None
                record.followup_expires_at = None
                record.followup_error = None
            _publish(ctx, store)
    except Exception as exc:
        fail(ctx, delivery, getattr(exc, 'code', 'provider_unavailable'))
        raise
    # «Procedi»: the start runs after the reply commits; its outcome (or typed
    # refusal) is the sentence the person reads — never a retryable failure.
    from homun.application.sessions.front_door.start import start_after_turn
    return start_after_turn(ctx, delivery.actor, delivery.body, result)


def fail(ctx: EngineContext, delivery: Delivery, code: str) -> None:
    """Make the same command retryable without appending another user message."""
    if not delivery.token:
        return
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            record = store.commands.get(delivery.body.command_id)
            if record is not None and record.followup_token == delivery.token:
                record.followup_status = 'failed'
                record.followup_error = code
                retryable = code not in NON_RETRYABLE_CODES
                record.followup_next_attempt_at = (
                    utc_now() + timedelta(seconds=FOLLOWUP_BACKOFF_SECONDS * 2 ** (record.followup_attempts - 1))
                    if retryable and record.followup_attempts < MAX_FOLLOWUP_ATTEMPTS else None
                )
                record.followup_token = None
                record.followup_expires_at = None
        _publish(ctx, store)
