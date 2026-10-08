from homun.application.runtime_calls import complete_summary
"""Budgeted context checkpoint preparation; canonical run history is never replaced."""
from homun.application import agent_native, agent_recovery, budgets
from homun.application.agent_runs import authority, lookup
from homun.application.agent_usage import charge, reserve as reserve_usage
import logging
from homun.domain.errors import ValidationError
from homun.domain.models import Actor, BudgetCounters, utc_now
from homun.models.context_plan import plan_context, build_checkpoint, project_checkpoint
from homun.models.context_summary import ContextSummaryError, summary_request, summary_text
from homun.models.native_errors import NativeModelError


class ContextPreparationDeferred(Exception):
    """New human input or another owner superseded the context generation."""


def _same_owner(current,run):
    return current.get('_lease_token')==run['_lease_token'] and current['_epoch']==run['_epoch']


def _stale(current,run):
    return (not _same_owner(current,run) or current['_messages']!=run['_messages']
            or current.get('_steering',[])!=run.get('_steering',[]))


def _release_own_lease(current,run):
    if current.get('_lease_token')==run['_lease_token']:
        current.pop('_lease_token',None)
        current.pop('_lease_until',None)


def _defer_if_stale(ctx,run):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            current=lookup(store,run['id'])
            deferred=_stale(current,run)
            if deferred:_release_own_lease(current,run)
        ctx.service.store=store
    if deferred:raise ContextPreparationDeferred()


def prepare(ctx,run,tools):
    messages=agent_native.history(run)
    policy=run.get('_context_policy')
    if not policy:
        return messages
    micro_policy = policy.get('micro_compaction', run.get('micro_compaction', False))
    plan_kwargs = {k: v for k, v in policy.items() if k != 'micro_compaction'}
    plan=plan_context(messages,tools,checkpoint=run.get('_context_checkpoint'),
                      force=bool(run.get('_force_context_compaction')),**plan_kwargs)
    if plan.cut is None:
        if micro_policy:
            from homun.models.micro_compaction import micro_compact_messages
            kwargs = micro_policy if isinstance(micro_policy, dict) else {}
            return micro_compact_messages(plan.messages, **kwargs)
        return plan.messages
    actor=Actor.model_validate(run['_actor'])
    output_tokens=min(2000,max(256,policy['context_window']//10),policy['max_output_tokens'])
    request,clipped=summary_request(plan.source,context_window=policy['context_window'],output_tokens=output_tokens)
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            current=lookup(store,run['id'])
            if not _same_owner(current,run):
                raise ContextPreparationDeferred()
            authority(ctx,store,actor,current,running=True)
            if not agent_recovery.can_attempt(current,'decide'):
                raise agent_recovery.RecoveryAttemptsExhausted('No acting attempt remains after compaction')
            if current['model_attempts']+2>current['limits']['max_model_attempts']:
                raise ValidationError('Insufficient model attempts for compaction and continuation')
            budgets.check_capacity(store,actor,run['work_id'],BudgetCounters(attempts=2),
                                   accounting_actor_id=run['assignee_id'])
            reservation=reserve_usage(ctx, actor, current, purpose='agent_run.compact', store=store)
            agent_recovery.begin(current,'summary')
            current['model_attempts']+=1
        ctx.service.store=store
    from types import SimpleNamespace
    settled = False
    try:
        result=complete_summary(ctx, run, request,connection_id=run['connection_id'],
            context_window=policy['context_window'],max_output_tokens=output_tokens)
    except NativeModelError as exc:
        charge(ctx,actor,run,reservation,exc.usage,reason=exc.code)
        if exc.retryable:
            outcome=agent_recovery.schedule(ctx,actor,run,exc,phase='summary',
                expected_steering=run.get('_steering',[]))
            if outcome in {'waiting','fenced'}:
                # The wait holds no lease; the busy path resumes preparation when due.
                raise ContextPreparationDeferred() from exc
        # Il riassunto è un'ottimizzazione, non un requisito: il run continua
        # con un riassunto deterministico invece di morire a fine lavoro.
        logging.getLogger(__name__).warning(
            'riassunto di contesto non disponibile (%s): degrado deterministico per %s',
            exc.code, run.get('id'))
        settled = exc.usage is not None
        result=SimpleNamespace(message=SimpleNamespace(content=(
            '[riassunto di contesto non disponibile: cronologia ridotta deterministicamente. '
            'I turni di mezzo sono stati omessi per rispettare la finestra del modello.]'),
            tool_calls=None), usage=None)
    except Exception as exc:
        charge(ctx, actor, run, reservation, getattr(exc, 'usage', None))
        _defer_if_stale(ctx,run)
        logging.getLogger(__name__).warning(
            'riassunto di contesto fallito (%s): degrado deterministico per %s',
            exc, run.get('id'))
        settled = getattr(exc, 'usage', None) is not None
        result=SimpleNamespace(message=SimpleNamespace(content=(
            '[riassunto di contesto non disponibile: cronologia ridotta deterministicamente.]'),
            tool_calls=None), usage=None)
    if not settled:
        charge(ctx,actor,run,reservation,getattr(result,'usage',None))
    _defer_if_stale(ctx,run)
    candidate=build_checkpoint(messages,plan,summary_text(result),tools)
    candidate['coverage']['sampled']=bool(clipped) or (run.get('_context_checkpoint') or {}).get('coverage',{}).get('sampled',False)
    candidate.update(connection_id=run['connection_id'],
        model_id=getattr(getattr(result,'usage',None),'model_id',None),
        generation=(run.get('_context_checkpoint') or {}).get('generation',0)+1,
        created_at=utc_now().isoformat(),summary_input_clipped_records=clipped)
    deferred=False
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            current=lookup(store,run['id'])
            if _stale(current,run):
                deferred=True
                _release_own_lease(current,run)
            else:
                authority(ctx,store,actor,current,running=True)
                current['_context_checkpoint']=candidate
                current.pop('_force_context_compaction',None)
                agent_recovery.accept(current,'summary')
                current['context']={'compactions':candidate['generation'],
                    'estimated_input_tokens':candidate['estimated_after'],
                    'context_window':policy['context_window'],'estimate_is_usage':False}
        ctx.service.store=store
    if deferred:
        raise ContextPreparationDeferred()
    projected = project_checkpoint(messages, candidate)
    if micro_policy:
        from homun.models.micro_compaction import micro_compact_messages
        kwargs = micro_policy if isinstance(micro_policy, dict) else {}
        return micro_compact_messages(projected, **kwargs)
    return projected


def provider_policy(run):
    """Keep context projection settings out of provider call arguments."""
    policy = run.get('_context_policy', {})
    return {key: policy[key] for key in ('context_window', 'max_output_tokens') if key in policy}
