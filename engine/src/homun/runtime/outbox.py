"""Transactional delivery authorization and lease-fenced acknowledgements."""
from copy import deepcopy
from datetime import timedelta
from uuid import uuid4

from homun.domain.effects import cancel_work_intents
from homun.domain.models import utc_now
from homun.domain.states import WorkStatus
from homun.policy.runtime import intent_has_authority

CLAIM_LEASE = timedelta(seconds=60)


def claim(ctx, intent_id):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            intent = store.outbox[intent_id]
            run = store.runs[intent.run_id]
            work = store.works.get(run.work_id)
            now = utc_now()
            if intent.delivered or intent.cancelled:
                return None
            if work and work.status == WorkStatus.CANCELLED:
                cancel_work_intents(store, work.id)
                return None
            if work and work.status == WorkStatus.PAUSED:
                return None
            if not intent_has_authority(store, intent):
                intent.error_code = 'permission_denied'
                run.last_error = 'permission_denied'
                return None
            if intent.claim_token and intent.claim_expires_at and intent.claim_expires_at > now:
                return None
            # Ordering is per run; a paused or failed run cannot starve other work.
            if any(i.run_id == run.id and i.sequence < intent.sequence
                   and not i.delivered and not i.cancelled for i in store.outbox.values()):
                return None
            intent.claim_token = uuid4().hex
            intent.claim_expires_at = now + CLAIM_LEASE
            authorized = deepcopy(intent), deepcopy(run)
        ctx.service.store = store
        return authorized


def still_authorized(ctx, intent_id, token):
    """Best-effort last check. Cancellation after authorization may race IO."""
    store = ctx.repository.load()
    intent = store.outbox[intent_id]
    run = store.runs[intent.run_id]
    work = store.works.get(run.work_id)
    return (bool(token) and intent.claim_token == token
            and intent.claim_expires_at is not None and intent.claim_expires_at > utc_now()
            and intent_has_authority(store, intent)
            and not intent.cancelled and not intent.delivered
            and (not work or work.status not in {WorkStatus.CANCELLED, WorkStatus.PAUSED}))


def acknowledge(ctx, intent_id, token, *, sent, error=None):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            intent = store.outbox[intent_id]
            if intent.claim_token != token:
                return
            intent.claim_token = None
            intent.claim_expires_at = None
            intent.attempts += 1
            intent.delivered = sent
            if not sent and error is None and not intent_has_authority(store, intent):
                error = 'permission_denied'
            intent.error_code = error if not intent.cancelled else 'runtime_intent_cancelled'
            run = store.runs[intent.run_id]
            work = store.works.get(run.work_id)
            if work and work.status == WorkStatus.CANCELLED:
                # IO errors may occur after acceptance. Do not claim cancellation
                # is safe merely because a provider acknowledgement was lost.
                if error and intent.kind == 'contribution':
                    run.status = 'cancellation_uncertain'
                    run.last_error = 'runtime_cancellation_uncertain'
                elif run.status != 'cancelled':
                    cancel_work_intents(store, work.id)
            else:
                run.last_error = error
        ctx.service.store = store
