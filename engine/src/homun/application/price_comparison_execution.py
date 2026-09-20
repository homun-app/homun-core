"""Fenced, bounded deterministic execution and atomic artifact publication."""
from homun.application.price_comparison_policy import PROPOSAL_TYPE, authority, validate_sources
from homun.domain.errors import ConflictError, DomainError
from homun.domain.models import Actor, DomainEvent, utc_now
from homun.domain.ids import new_id
from homun.domain.states import WorkStatus, StepStatus
from homun.tools.price_comparison import compare_csv


def _running_authority(ctx, store, proposal):
    actor = Actor.model_validate(proposal['_actor'])
    work = authority(store, actor, proposal, approval=True)
    if work.version != proposal['_run_version'] or work.status != WorkStatus.RUNNING:
        raise ConflictError('Work changed after comparison approval')
    data = validate_sources(ctx, store, actor, proposal)
    return actor, work, data


def fail(ctx, proposal_id, code, *, blocked=False, attempt=None):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            proposal = store.commands[proposal_id].result
            if (proposal['status'] in {'queued', 'running'}
                    and (attempt is None or proposal['_attempts'] == attempt)):
                _record_failure(store, proposal, code, blocked=blocked)
        ctx.service.store = store


def execute(ctx, proposal_id):
    """DBOS may replay this step; domain publication remains exactly once."""
    attempt = None
    try:
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                record = store.commands[proposal_id]
                proposal = record.result
                if record.type != PROPOSAL_TYPE or proposal['status'] not in {'queued', 'running'}:
                    return
                actor, work, data = _running_authority(ctx, store, proposal)
                if proposal['_attempts'] >= proposal['limits']['max_attempts']:
                    _record_failure(store, proposal, 'comparison_attempt_budget_exhausted')
                    return
                proposal['_attempts'] += 1
                attempt = proposal['_attempts']
                proposal['status'] = 'running'
                max_rows = proposal['limits']['max_rows']
            ctx.service.store = store
        report = compare_csv(*data, max_rows=max_rows)
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                proposal = store.commands[proposal_id].result
                if proposal['status'] != 'running' or proposal['_attempts'] != attempt:
                    return
                actor, work, _ = _running_authority(ctx, store, proposal)
                service = ctx.service.for_store(store)
                result = service.apply(actor, f'{proposal_id}:artifact', 'work.submit_artifact', {
                    'work_id': work.id, 'expected_version': work.version,
                    'title': 'Confronto prezzi CSV', 'content': report['report_markdown'],
                })
                service.append_engine_message(
                    actor=actor, command_id=f'{proposal_id}:report',
                    conversation_id=work.primary_conversation_id, author_id='homun_engine',
                    text=_report_message(report['summary']),
                    event_payload={'artifact_id': result['artifact_id'], 'comparison_id': proposal_id, 'work_id': work.id,
                                   'material_ids': [proposal['left']['id'], proposal['right']['id']]},
                )
                proposal.update(status='completed', artifact_id=result['artifact_id'],
                                report_markdown=report['report_markdown'], report_csv=report['report_csv'],
                                summary=report['summary'])
            ctx.service.store = store
    except DomainError as exc:
        fail(ctx, proposal_id, exc.code, blocked=exc.code in {'permission_denied', 'version_conflict', 'not_found'}, attempt=attempt)


def _report_message(summary):
    counts = summary['counts']
    return (f"Confronto completato: {counts['increased']} aumenti, "
            f"{counts['decreased']} diminuzioni, {counts['unchanged']} prezzi invariati, "
            f"{counts['new']} nuovi prodotti, {counts['removed']} rimossi e "
            f"{counts['excluded']} esclusi. "
            "Report pronto per la revisione umana. Fonte: motore.")


def _record_failure(store, proposal, code, *, blocked=False):
    proposal.update(status='blocked' if blocked else 'failed', error_code=code)
    work = store.works[proposal['work_id']]
    if work.version != proposal.get('_run_version') or work.status != WorkStatus.RUNNING:
        return
    work.status = WorkStatus.FAILED
    work.version += 1
    work.updated_at = utc_now()
    plan = store.plans.get(store.plan_key(work.id, work.current_plan_revision))
    if plan:
        for step in plan.steps:
            if step.status == StepStatus.RUNNING:
                step.status = StepStatus.FAILED
    store.events.append(DomainEvent(
        event_id=new_id('evt'), workspace_id=store.workspace_id,
        aggregate_id=work.id, aggregate_type='work', aggregate_version=work.version,
        sequence=store.next_sequence(), type='work.state_changed',
        actor_id=proposal['_actor']['id'], command_id=proposal['id'],
        payload={'status': work.status, 'error_code': code, 'comparison_id': proposal['id']}))
