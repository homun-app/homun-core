from homun.application.runtime_calls import complete
"""Execute a bounded model consultation for an approved teammate."""
import json
from pydantic import ValidationError as SchemaError
from homun.application.agent_team import Consultation
from homun.application import budgets
from homun.domain.errors import ConflictError, PermissionDeniedError, ValidationError
from homun.domain.models import BudgetCounters
from homun.models.types import ChatMessage
from homun.models.prompt_store import prompts_for


def consult(ctx, actor, run, arguments):
    from homun.application.agent_runs import authority, lookup
    from homun.application.agent_usage import charge, reserve as reserve_usage
    try:
        args = Consultation.model_validate(arguments)
    except SchemaError as exc:
        raise ValidationError('Invalid consultation arguments') from exc
    members = (run.get('team') or {}).get('members', [])
    if args.agent_id == run['assignee_id'] or args.agent_id not in {m['id'] for m in members}:
        raise PermissionDeniedError('Collaborator is outside the approved team')
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            current = lookup(store, run['id'])
            authority(ctx, store, actor, current, running=True)
            if current.get('_lease_token') != run['_lease_token']:
                raise ConflictError('Run lease changed')
            if current['model_attempts'] >= current['limits']['max_model_attempts']:
                raise ValidationError('Adaptive run reached its model attempt limit')
            agent = store.agents[args.agent_id]
            selection = current.get('_consultation_models', {}).get(agent.id)
            connection_id = selection['connection_id'] if selection else agent.preferred_connection_id or current['connection_id']
            model_id = selection['model_id'] if selection else None
            reservation = reserve_usage(ctx, actor, current, purpose='agent_run.consult',
                connection_id=connection_id, model_id=model_id, accounting_actor_id=agent.id, store=store)
            current['model_attempts'] += 1
        ctx.service.store = store
    try:
        result = complete(ctx, run, [
            ChatMessage(role='system', content=prompts_for(ctx.models).get('agent/consult').render(
                name=agent.name, instructions=agent.instructions)),
            ChatMessage(role='user', content=json.dumps({'task': args.task, 'observations': run['observations']}, ensure_ascii=False)),
        ], connection_id=connection_id, model_id=model_id)
    except Exception as exc:
        charge(ctx, actor, run, reservation, getattr(exc, 'usage', None))
        raise
    charge(ctx, actor, run, reservation, getattr(result, 'usage', None))
    return {'agent_id': agent.id, 'agent_name': agent.name, 'model_id': getattr(result, 'model_id', None),
            'text': result.text[:8000], 'truncated': len(result.text) > 8000}
