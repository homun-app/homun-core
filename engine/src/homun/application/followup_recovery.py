"""Bounded background recovery of committed messages with unfinished model work."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from copy import deepcopy
from dataclasses import replace
import logging

from homun.application.command_delivery import (
    Delivery, MAX_FOLLOWUP_ATTEMPTS, claim, complete, conversation_busy,
    require_followup_authority,
)
from homun.application.command_types import CommandRequest
from homun.domain.command_identity import request_fingerprint
from homun.domain.errors import DomainError
from homun.domain.models import Actor, utc_now
from pydantic import ValidationError

logger = logging.getLogger(__name__)


def _terminal(record, code):
    record.followup_status = 'failed'
    record.followup_error = code
    record.followup_token = None
    record.followup_expires_at = None
    record.followup_next_attempt_at = None


def claim_next(ctx, *, now=None) -> Delivery | None:
    """Atomically claim one due follow-up; never reapply its user command."""
    now = now or utc_now()
    selected = None
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            for record in sorted(store.commands.values(), key=lambda item: item.created_at):
                if record.type != 'conversation.post_message' or record.followup_status not in {'processing', 'failed'}:
                    continue
                if record.followup_status == 'processing' and record.followup_expires_at and record.followup_expires_at > now:
                    continue
                if not record.followup_body or not record.followup_actor:
                    _terminal(record, 'followup_context_missing')
                    continue
                if record.followup_status == 'failed' and (record.followup_next_attempt_at is None or record.followup_next_attempt_at > now):
                    continue
                if record.followup_attempts >= MAX_FOLLOWUP_ATTEMPTS:
                    _terminal(record, record.followup_error or 'followup_attempts_exhausted')
                    continue
                try:
                    body = CommandRequest.model_validate(record.followup_body)
                    actor = Actor.model_validate(record.followup_actor)
                    fingerprint = request_fingerprint(actor, body.type, body.payload)
                    if body.command_id != record.command_id or body.type != record.type or fingerprint != record.request_fingerprint:
                        _terminal(record, 'followup_context_invalid')
                        continue
                    require_followup_authority(store, actor, body)
                except (ValidationError, DomainError) as exc:
                    _terminal(record, getattr(exc, 'code', 'followup_context_invalid'))
                    continue
                if conversation_busy(store, body, now, recovering=True):
                    continue
                token = claim(record, actor, body, now)
                selected = Delivery(actor, body, deepcopy(record.result), token,
                                    replace(ctx, service=ctx.service.for_store(store)))
                break
        ctx.service.store = store
    return selected


def recover_pending(ctx, *, limit=8) -> dict[str, int]:
    """One bounded synchronous pass; callers run this outside the event loop."""
    counts = {'completed': 0, 'failed': 0}
    for _ in range(limit):
        delivery = claim_next(ctx)
        if delivery is None:
            break
        try:
            complete(ctx, delivery)
            counts['completed'] += 1
        except Exception:
            # complete() persisted the typed failure/backoff with token fencing.
            counts['failed'] += 1
    return counts


@asynccontextmanager
async def followup_recovery_lifespan(ctx, *, interval=1.0):
    """Stop scheduling on shutdown and await the in-flight provider pass."""
    stop = asyncio.Event()

    async def pump():
        while not stop.is_set():
            try:
                await asyncio.to_thread(recover_pending, ctx, limit=1)
            except Exception:
                logger.exception('Follow-up recovery pass failed')
            try:
                await asyncio.wait_for(stop.wait(), timeout=interval)
            except TimeoutError:
                pass

    task = asyncio.create_task(pump(), name='homun-followup-recovery')
    try:
        yield
    finally:
        stop.set()
        await task
