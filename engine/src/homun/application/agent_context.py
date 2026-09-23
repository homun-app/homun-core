"""Budgeted context checkpoint preparation; canonical run history is never replaced."""
from homun.application import agent_native, budgets
from homun.application.agent_runs import authority, lookup
from homun.application.agent_usage import charge
from homun.domain.errors import ValidationError
from homun.domain.models import Actor, BudgetCounters, utc_now
from homun.models.context_plan import plan_context, build_checkpoint, project_checkpoint
from homun.models.context_summary import ContextSummaryError, summary_request, summary_text


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
    plan=plan_context(messages,tools,checkpoint=run.get('_context_checkpoint'),**policy)
    if plan.cut is None:
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
            if current['model_attempts']+2>current['limits']['max_model_attempts']:
                raise ValidationError('Insufficient model attempts for compaction and continuation')
            budgets.check_capacity(store,actor,run['work_id'],BudgetCounters(attempts=2),
                                   accounting_actor_id=run['assignee_id'])
            current['model_attempts']+=1
        ctx.service.store=store
    reservation=budgets.reserve(ctx,actor,run['work_id'],BudgetCounters(attempts=1),
        purpose='agent_run.compact',accounting_actor_id=run['assignee_id'])
    try:
        result=ctx.models.complete_summary(request,connection_id=run['connection_id'],
            context_window=policy['context_window'],max_output_tokens=output_tokens)
    except Exception as exc:
        budgets.reconcile_unknown(ctx,actor,run['work_id'],reservation)
        _defer_if_stale(ctx,run)
        raise ContextSummaryError('Context summary generation failed; history was retained') from exc
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
                current['context']={'compactions':candidate['generation'],
                    'estimated_input_tokens':candidate['estimated_after'],
                    'context_window':policy['context_window'],'estimate_is_usage':False}
        ctx.service.store=store
    if deferred:
        raise ContextPreparationDeferred()
    return project_checkpoint(messages,candidate)
