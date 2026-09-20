"""Durable admission and fenced model follow-up, shared by HTTP and SSE.

A model attempt is at-least-once after lease expiry. Its domain result commits
once, fenced by the claim token; no SQLite transaction spans model generation.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, replace
from datetime import timedelta
from uuid import uuid4

from homun.application.command_types import CommandRequest
from homun.application.interpretation import finalize_assistant, prepare_interpretation
from homun.application.conversation_context import authorized_conversation_work, revalidate_context
from homun.models.conversation_context import ContextManifest
from homun.context import EngineContext
from homun.domain.errors import CommandInProgressError, ConflictError
from homun.domain.models import Actor, utc_now
from homun.policy.work import require_conversation_access

FOLLOWUP_LEASE = timedelta(minutes=5)
MAX_FOLLOWUP_ATTEMPTS = 3
FOLLOWUP_BACKOFF_SECONDS = 5


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


def conversation_busy(store, body, now, *, recovering=False):
    conversation_id = body.payload.get('conversation_id')
    pending = []
    for record in sorted(store.commands.values(), key=lambda item: item.created_at):
        unfinished = (record.followup_status == 'processing' or
                      (record.followup_status == 'failed' and record.followup_next_attempt_at is not None))
        if not unfinished:
            continue
        message = store.messages.get(record.result.get('message_id'))
        linked = message.conversation_id if message else (record.followup_body or {}).get('payload', {}).get('conversation_id')
        if linked == conversation_id:
            pending.append(record.command_id)
    # Expiry permits takeover of this command, never overtaking by another one.
    if recovering:
        return bool(pending and pending[0] != body.command_id)
    return any(command_id != body.command_id for command_id in pending)


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
            if body.type == 'conversation.post_message' and record.followup_status == 'completed':
                # Cached replies carry the same source authority as fresh replies.
                authorized_conversation_work(store, actor, body.payload.get('conversation_id', ''))
                if manifest := record.result.get('context_manifest'):
                    revalidate_context(store, actor, ContextManifest.model_validate(manifest))
            if body.type == 'conversation.post_message' and record.followup_status != 'completed':
                now = utc_now()
                if (record.followup_status == 'processing' and record.followup_expires_at
                        and record.followup_expires_at > now):
                    raise CommandInProgressError('This message is already being processed; retry after completion')
                if conversation_busy(store, body, now):
                    raise CommandInProgressError('Another message in this conversation is being processed')
                # An explicit retry starts a fresh bounded recovery budget.
                record.followup_attempts = 0
                token = claim(record, actor, body, now)
        _publish(ctx, store)
        snapshot = replace(ctx, service=service) if token else None
        return Delivery(actor, body, deepcopy(result), token, snapshot)


def complete(ctx: EngineContext, delivery: Delivery) -> dict:
    if delivery.token is None:
        from homun.runtime.dispatcher import deliver_pending
        result = deliver_pending(ctx, command_id=delivery.body.command_id,
                                 wait_seconds=5 if delivery.body.type == "work.provide_contribution" else 0)
        return result if result is not None else delivery.result
    try:
        # Admission snapshots are not authority after time spent in a queue.
        # Read fresh grants without holding the repository lock across a model call.
        with ctx.repository.locked():
            current = ctx.repository.load()
            require_followup_authority(current, delivery.actor, delivery.body)
            model_context = replace(ctx, service=ctx.service.for_store(current))
        prepared, display = prepare_interpretation(
            model_context, delivery.actor, delivery.body, delivery.result,
        )
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                record = store.commands[delivery.body.command_id]
                if record.followup_token != delivery.token or record.followup_status != 'processing':
                    raise ConflictError('Model attempt superseded; its result was not applied')
                if record.followup_expires_at is None or record.followup_expires_at <= utc_now():
                    raise FollowupLeaseExpiredError('Model attempt lease expired; recovery will retry within its attempt budget')
                require_followup_authority(store, delivery.actor, delivery.body)
                fresh = replace(ctx, service=ctx.service.for_store(store))
                result = finalize_assistant(fresh, delivery.actor, delivery.body, prepared, display)
                record.result = deepcopy(result)
                record.followup_status = 'completed'
                record.followup_next_attempt_at = None
                record.followup_token = None
                record.followup_expires_at = None
                record.followup_error = None
            _publish(ctx, store)
        return result
    except Exception as exc:
        fail(ctx, delivery, getattr(exc, 'code', 'provider_unavailable'))
        raise


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
                retryable = code not in {'permission_denied', 'not_found', 'validation_error', 'version_conflict', 'budget_exhausted'}
                record.followup_next_attempt_at = (
                    utc_now() + timedelta(seconds=FOLLOWUP_BACKOFF_SECONDS * 2 ** (record.followup_attempts - 1))
                    if retryable and record.followup_attempts < MAX_FOLLOWUP_ATTEMPTS else None
                )
                record.followup_token = None
                record.followup_expires_at = None
        _publish(ctx, store)
