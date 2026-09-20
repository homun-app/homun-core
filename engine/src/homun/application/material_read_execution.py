"""Fenced, bounded deterministic read execution and atomic artifact publication."""
from homun.application.material_reads import PROPOSAL_TYPE, authority
from homun.domain.errors import ConflictError, DomainError
from homun.domain.ids import new_id
from homun.domain.models import Actor, DomainEvent, utc_now
from homun.domain.states import WorkStatus, StepStatus
from homun.materials.extract import extract_text


def _running_authority(ctx, store, proposal):
    actor = Actor.model_validate(proposal['_actor'])
    work = authority(store, actor, proposal, approval=True)
    if work.version != proposal['_run_version'] or work.status != WorkStatus.RUNNING:
        raise ConflictError('Work changed after read approval')
    material = store.materials[proposal['material']['id']]
    from homun.materials.source import verify_material
    from homun.domain.capabilities import READ_MATERIAL
    binding, data = verify_material(ctx, store, actor, material.id,
                                    max_bytes=READ_MATERIAL.limits['max_bytes_per_material'])
    if binding != proposal['material']:
        raise ConflictError('Read source changed; create a new proposal')
    return actor, work, material, data


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
                actor, work, material, data = _running_authority(ctx, store, proposal)
                if proposal['_attempts'] >= proposal['limits']['max_attempts']:
                    _record_failure(store, proposal, 'read_attempt_budget_exhausted')
                    return
                proposal['_attempts'] += 1
                attempt = proposal['_attempts']
                proposal['status'] = 'running'
            ctx.service.store = store
        report = build_reading(material, data, proposal['limits']['max_extract_characters'])
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                proposal = store.commands[proposal_id].result
                if proposal['status'] != 'running' or proposal['_attempts'] != attempt:
                    return
                actor, work, _, _ = _running_authority(ctx, store, proposal)
                service = ctx.service.for_store(store)
                result = service.apply(actor, f'{proposal_id}:artifact', 'work.submit_artifact', {
                    'work_id': work.id, 'expected_version': work.version,
                    'title': f'Lettura · {material_title(proposal)}', 'content': report,
                })
                service.append_engine_message(
                    actor=actor, command_id=f'{proposal_id}:report',
                    conversation_id=work.primary_conversation_id, author_id='homun_engine',
                    text=_report_message(proposal),
                    event_payload={'artifact_id': result['artifact_id'], 'read_id': proposal_id,
                                   'work_id': work.id, 'material_ids': [proposal['material']['id']]},
                )
                proposal.update(status='completed', artifact_id=result['artifact_id'],
                                extract=report, summary={'characters': len(report)})
            ctx.service.store = store
    except DomainError as exc:
        fail(ctx, proposal_id, exc.code, blocked=exc.code in {'permission_denied', 'version_conflict', 'not_found'}, attempt=attempt)


def material_title(proposal):
    return proposal['material']['title']


def build_reading(material, data, max_characters):
    """Deterministic reading artifact: provenance first, bounded extract, no model."""
    from homun.domain.capabilities import READ_MATERIAL
    extracted = extract_text(data, filename=material.origin_name or material.title,
                             mime_type=material.mime_type)
    header = [
        f'# Lettura materiale · {material.title}',
        '',
        f'- File: {material.origin_name or material.title}',
        f'- Formato: {material.mime_type or "sconosciuto"}',
        f'- Dimensione: {material.byte_size} byte',
        f'- SHA-256: {material.content_hash}',
        f'- Versione materiale: v{material.version}',
        f"- Estratto limitato ai primi {max_characters} caratteri. Nessuna interpretazione automatica: il contenuto è riportato così com'è.",
        '',
        '## Estratto',
        '',
    ]
    body = extracted.text[:max_characters]
    if len(extracted.text) > max_characters:
        body += '\n\n[… estratto interrotto al limite di caratteri]'
    return '\n'.join(header) + body


def _report_message(proposal):
    return (f"Lettura completata: {material_title(proposal)}. "
            f"Estratto e provenienza nell'artifact, pronto per la revisione umana. Fonte: motore.")


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
        payload={'status': work.status, 'error_code': code, 'read_id': proposal['id']}))
