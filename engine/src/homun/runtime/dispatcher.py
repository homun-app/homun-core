"""Postcommit, retryable runtime delivery and completion projection."""
from copy import deepcopy
from homun.domain.ids import new_id
from homun.domain.models import DomainEvent, utc_now
from homun.domain.states import WorkStatus
from homun.runtime import dbos_app, outbox
from homun.runtime.bridge import refresh_run_status
from homun.runtime.workflows import work_run


def _publish(ctx, store):
    ctx.service.store = store


def deliver_pending(ctx, command_id: str | None = None, wait_seconds: float = 0):
    """Deliver durable intents in order; failure remains visible and retryable.

    No repository lock spans runtime IO. Duplicate dispatch is safe through the
    persisted workflow ID and DBOS message idempotency key. Claims serialize delivery per run so a contribution cannot overtake creation.
    Cancellation after the claim boundary is explicitly uncertain.
    """
    snapshot = ctx.repository.load()
    intents = sorted((i for i in snapshot.outbox.values() if not i.delivered and not i.cancelled),
                     key=lambda i: i.sequence)
    for candidate in intents:
        authorized = outbox.claim(ctx, candidate.id)
        if authorized is None:
            continue
        intent, run = authorized
        if not outbox.still_authorized(ctx, intent.id, intent.claim_token):
            outbox.acknowledge(ctx, intent.id, intent.claim_token, sent=False)
            continue
        error = None
        try:
            if not dbos_app.is_launched():
                raise RuntimeError('Runtime unavailable')
            if intent.kind == 'start':
                work_run.start_work_run_workflow(run.workflow_id, **intent.payload)
            elif intent.kind == 'contribution':
                work_run.send_contribution(run.workflow_id, intent.payload, idempotency_key=intent.id)
            else:
                raise ValueError('Unknown runtime intent')
        except Exception:
            error = 'runtime_delivery_failed'
        outbox.acknowledge(ctx, intent.id, intent.claim_token, sent=error is None, error=error)
    if dbos_app.is_launched():
        from homun.runtime.workflows.material_read import deliver_reads
        from homun.runtime.workflows.price_comparison import deliver_comparisons
        from homun.runtime.workflows.synthesis import deliver_syntheses
        from homun.runtime.workflows.tool_chain import deliver_chains
        deliver_comparisons(ctx)
        deliver_reads(ctx)
        deliver_syntheses(ctx)
        deliver_chains(ctx)
        reconcile_runs(ctx, command_id=command_id, wait_seconds=wait_seconds)
    store = ctx.repository.load()
    if command_id is None:
        return None
    record = store.commands.get(command_id)
    result = deepcopy(record.result) if record else None
    pending = [i for i in store.outbox.values() if i.command_id == command_id and not i.delivered and not i.cancelled]
    if pending and result is not None:
        result['runtime_delivery'] = 'pending'
        result['runtime_error'] = pending[0].error_code
    return result


def reconcile_runs(ctx, *, command_id=None, wait_seconds=0):
    snapshot = ctx.repository.load()
    for run in snapshot.runs.values():
        if run.status in {'completed', 'failed', 'cancelled'}:
            continue
        if any(i.run_id == run.id and not i.delivered and not i.cancelled for i in snapshot.outbox.values()):
            continue
        related = [i for i in snapshot.outbox.values() if i.run_id == run.id and i.kind == 'contribution']
        wait = wait_seconds if any(i.command_id == command_id for i in related) else 0
        try:
            refresh_run_status(snapshot, run, wait_seconds=wait)
        except Exception:
            continue
        if run.status not in {'completed', 'failed'}:
            continue
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                current = store.runs[run.id]
                if current.status in {'completed', 'failed', 'cancelled'}:
                    continue
                cancelled = store.works[run.work_id].status == WorkStatus.CANCELLED
                current.status = "cancelled" if cancelled else run.status
                current.effect_status = run.effect_status
                current.last_error = ("runtime_effect_completed_after_cancellation"
                                      if cancelled and run.status == "completed" else run.last_error)
                current.updated_at = run.updated_at
                work = store.works[run.work_id]
                # A user pause/cancellation must never be overwritten by runtime completion.
                if run.status == 'completed' and work.status == WorkStatus.READY:
                    work.status = WorkStatus.COMPLETED
                    work.version += 1
                    work.updated_at = utc_now()
                    origin = related[-1].command_id if related else None
                    record = store.commands.get(origin)
                    store.events.append(DomainEvent(
                        event_id=new_id('evt'), workspace_id=store.workspace_id,
                        aggregate_id=work.id, aggregate_type='work', aggregate_version=work.version,
                        sequence=store.next_sequence(), type='work.state_changed',
                        actor_id=record.actor_id if record else 'engine', command_id=origin,
                        payload={'status': work.status, 'run_id': run.id}))
                for intent in related:
                    record = store.commands.get(intent.command_id)
                    if record:
                        record.result.update(status=work.status, version=work.version,
                                             run_status=current.status, effect_status=current.effect_status)
            _publish(ctx, store)
