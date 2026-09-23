"""Model-driven phase execution: compose the artifact, publish exactly once."""
from homun.application.synthesis import PROPOSAL_TYPE, authority
from homun.domain.errors import DomainError, ValidationError
from homun.domain.ids import new_id
from homun.domain.models import Actor, DomainEvent, utc_now
from homun.domain.states import StepStatus, WorkStatus
from homun.models.types import UsageAttempt
from homun.policy.intake import latest_intake


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
                actor, work = _running_authority(store, proposal)
                if proposal['_attempts'] >= proposal['limits']['max_attempts']:
                    _record_failure(store, proposal, 'synthesis_attempt_budget_exhausted')
                    return
                proposal['_attempts'] += 1
                attempt = proposal['_attempts']
                proposal['status'] = 'running'
            ctx.service.store = store
        document, meta = compose(ctx, proposal)
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                proposal = store.commands[proposal_id].result
                if proposal['status'] != 'running' or proposal['_attempts'] != attempt:
                    return
                actor, work = _running_authority(store, proposal)
                service = ctx.service.for_store(store)
                result = service.apply(actor, f'{proposal_id}:artifact', 'work.submit_artifact', {
                    'work_id': work.id, 'expected_version': work.version,
                    'title': f'Sintesi · {proposal["step_title"]}', 'content': document,
                })
                service.append_engine_message(
                    actor=actor, command_id=f'{proposal_id}:report',
                    conversation_id=work.primary_conversation_id, author_id='homun_engine',
                    text=_report_message(proposal, meta),
                    event_payload={'artifact_id': result['artifact_id'], 'synthesis_id': proposal_id,
                                   'work_id': work.id, 'material_ids': [m['id'] for m in proposal['materials']]},
                )
                proposal.update(status='completed', artifact_id=result['artifact_id'],
                                summary={'characters': len(document), **meta})
            ctx.service.store = store
    except DomainError as exc:
        fail(ctx, proposal_id, exc.code,
             blocked=exc.code in {'permission_denied', 'version_conflict', 'not_found'}, attempt=attempt)
    except RuntimeError:
        # Provider failures are honest failures: no artifact, retryable by a new proposal.
        fail(ctx, proposal_id, 'synthesis_model_error', attempt=attempt)


def _running_authority(store, proposal):
    from homun.domain.errors import ConflictError
    actor = Actor.model_validate(proposal['_actor'])
    work = authority(store, actor, proposal, approval=True)
    if work.version != proposal['_run_version'] or work.status != WorkStatus.RUNNING:
        raise ConflictError('Work changed after synthesis approval')
    return actor, work


def _connection(ctx, agent):
    """The agent's preferred connection when it exists; honest fallback otherwise."""
    from homun.domain.errors import NotFoundError
    if agent.preferred_connection_id:
        try:
            ctx.models.get_connection(agent.preferred_connection_id)
            return agent.preferred_connection_id, 'collaboratore'
        except NotFoundError:
            pass
    return None, 'spazio'


def _identity_lines(agent):
    parts = []
    if agent.responsibility:
        parts.append(f"Responsabilità: {agent.responsibility}")
    if agent.specializations:
        parts.append(f"Specializzazioni: {', '.join(agent.specializations)}")
    if agent.method:
        parts.append(f"Metodo: {agent.method}")
    if agent.tone:
        parts.append(f"Tono: {agent.tone}")
    return "\n".join(parts) or "Identità professionale non dichiarata."


def _materials_block(ctx, store, actor, proposal):
    from homun.materials.extract import extract_text
    from homun.materials.source import verify_material
    from homun.domain.capabilities import SYNTHESIZE
    bindings = proposal['materials']
    if not bindings:
        return 'Nessun materiale: la bozza nasce da obiettivo e vincoli dichiarati.'
    per_material = max(500, SYNTHESIZE.limits['max_context_characters'] // len(bindings))
    blocks = []
    for binding in bindings:
        material = store.materials[binding['id']]
        _, data = verify_material(ctx, store, actor, material.id,
                                  max_bytes=SYNTHESIZE.limits['max_bytes_per_material'])
        extracted = extract_text(data, filename=material.origin_name or material.title,
                                 mime_type=material.mime_type)
        text = extracted.text[:per_material]
        if len(extracted.text) > per_material:
            text += '\n[… estratto limitato]'
        blocks.append(f"### {material.title} (file: {material.origin_name or material.title}, "
                      f"sha256: {(material.content_hash or '')[:12]}, versione {material.version})\n{text}")
    return '\n\n'.join(blocks)


def compose(ctx, proposal):
    """One supervised model call on the assignee's connection; provenance travels with the artifact."""
    from homun.application import budgets as work_budgets
    from homun.domain.capabilities import SYNTHESIZE
    from homun.domain.models import BudgetCounters
    from homun.models.types import ChatMessage

    store = ctx.repository.load()
    actor = Actor.model_validate(proposal['_actor'])
    work = store.works[proposal['work_id']]
    agent = store.agents[proposal['assignee_id']]
    brief = latest_intake(store, work.id) or {}
    from homun.application.phase_execution import phase_plan_step
    step = phase_plan_step(store, work, 'synthesize')
    template = ctx.models.prompts.get('synthesis/compose', proposal.get('language'))
    system = template.render(
        agent_name=agent.name,
        agent_identity=_identity_lines(agent),
        agent_instructions=agent.instructions or 'Nessuna istruzione aggiuntiva.',
        step_title=proposal['step_title'],
        output_expected=(step.output_expected if step is not None and step.output_expected
                         else brief.get('output') or 'La bozza concordata del lavoro'),
        objective=work.objective,
        constraints='; '.join(brief.get('constraints') or []) or 'nessuno dichiarato',
        materials=_materials_block(ctx, store, actor, proposal),
        skills=_skills_block(),
    )
    connection_id, connection_kind = _connection(ctx, agent)
    reservation = work_budgets.reserve(ctx, actor, work.id, BudgetCounters(attempts=1),
                                       purpose='synthesis.compose')
    usage_before = len(ctx.models.usage)
    try:
        result = ctx.models.complete(
            [ChatMessage(role='system', content=system),
             ChatMessage(role='user', content=f"Fase: {proposal['step_title']}\nLavoro: {work.title}")],
            connection_id=connection_id)
    except RuntimeError:
        work_budgets.reconcile_unknown(ctx, actor, work.id, reservation)
        ctx.models.append_attempt(_attempt(proposal, connection_id, None, status='error',
                                           error_code='synthesis_model_error'))
        raise
    usage_entry = ctx.models.usage[-1] if len(ctx.models.usage) > usage_before else None
    work_budgets.reconcile(ctx, actor, work.id, reservation, usage=BudgetCounters(
        attempts=1,
        input_tokens=(usage_entry.input_tokens if usage_entry else None) or 0,
        output_tokens=(usage_entry.output_tokens if usage_entry else None) or 0))
    ctx.models.append_attempt(_attempt(proposal, connection_id,
                                       getattr(usage_entry, 'model_id', None), status='ok'))
    text = (result.text or '').strip()
    if not text:
        raise ValidationError('The model returned an empty synthesis')
    limit = SYNTHESIZE.limits['max_output_characters']
    truncated = len(text) > limit
    if truncated:
        text = text[:limit] + '\n\n[… bozza interrotta al limite di caratteri]'
    model_id = getattr(usage_entry, 'model_id', None) or _provider_default(ctx, connection_id)
    provenance = (f"> Sintesi di {agent.name} · modello {model_id} · connessione "
                  f"{'del collaboratore' if connection_kind == 'collaboratore' else 'attiva dello spazio (nessuna dedicata)'}"
                  f" · materiali: {len(proposal['materials'])} · bozza in revisione: nessun invio esterno.")
    return provenance + '\n\n' + text, {'model_id': model_id, 'connection': connection_kind,
                                        'truncated': truncated, 'connection_id': connection_id}


def _skills_block():
    from homun.models.intake import approved_skills_index
    skills = approved_skills_index()
    if not skills:
        return 'nessuna procedura approvata'
    return '\n'.join(f"- {s['name']}: {s['description']}" for s in skills)


def _provider_default(ctx, connection_id):
    pid = connection_id or ctx.models.active_provider_id
    provider = ctx.models._providers.get(pid)
    return getattr(provider, 'default_model', None) or pid


def _attempt(proposal, connection_id, model_id, *, status, error_code=None):
    return UsageAttempt(
        id=new_id('uat'), workspace_id=proposal['_actor']['workspace_id'],
        command_id=proposal['id'], work_id=proposal['work_id'],
        actor_id=proposal['_actor']['id'], purpose='synthesize',
        attempt_index=proposal['_attempts'] - 1,
        provider_id=connection_id or 'active',
        model_id=model_id, status=status, error_code=error_code,
        started_at=utc_now(), finished_at=utc_now(),
        notes='Synthesis phase attempt; artifact submitted for human review.')


def _report_message(proposal, meta):
    return (f"Sintesi pronta: «{proposal['step_title']}». Bozza scritta dal modello "
            f"{meta.get('model_id') or 'del collaboratore'} e lasciata in revisione nella conversazione. "
            f"Fonte: motore.")


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
        payload={'status': work.status, 'error_code': code, 'synthesis_id': proposal['id']}))
