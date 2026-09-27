"""MoA product wiring: every advisor and aggregator is an admitted physical call."""
from homun.application.agent_model_attempts import reserve_auxiliary
from homun.application.agent_usage import charge
from homun.application.agent_streaming import complete
from homun.application.agent_context import provider_policy
from homun.application.moa_contracts import MoAAggregator, MoAPreset, MoAReferenceModel
from homun.application.moa_coordinator import MoACoordinator
from homun.domain.models import Actor


def execute(ctx, run, messages, tools):
    actor = Actor.model_validate(run['_actor'])
    config = run['moa']
    selected = run.get('_moa_models')
    connection = ctx.models.get_connection(run['connection_id'])
    if selected:
        references = [MoAReferenceModel(provider=item['connection_id'], model=item['model_id']) for item in selected['references']]
        aggregate = {'provider': selected['aggregator']['connection_id'], 'model': selected['aggregator']['model_id']}
    else:
        references = [MoAReferenceModel(**ref) for ref in config.get('reference_models', [])]
        if not references:
            references = [MoAReferenceModel(provider=connection.id, model=connection.model_id, label='Advisor-1')]
        aggregate = config.get('aggregator') or {}
    preset = MoAPreset(name=config.get('preset') or 'default', reference_models=references,
        aggregator=MoAAggregator(provider=aggregate.get('provider') or connection.id,
                                model=aggregate.get('model') or connection.model_id, label=aggregate.get('label') or 'Aggregator'),
        fanout=config.get('fanout') or 'user_turn', privacy_filter=config.get('privacy_filter') or 'none')
    coordinator = MoACoordinator(preset, session_id=run['id'], save_traces=bool(config.get('save_traces')))
    coordinator.cached_guidance = run.get('_moa_guidance')

    def invoke(provider, model, inputs, call_tools, purpose):
        reservation = reserve_auxiliary(ctx, actor, run, purpose=purpose, connection_id=provider, model_id=model)
        try:
            result = complete(ctx, run, inputs, tools=call_tools, connection_id=provider, model_id=model, **provider_policy(run))
        except Exception as exc:
            charge(ctx, actor, run, reservation, getattr(exc, 'usage', None), reason=getattr(exc, 'code', 'provider_error'))
            raise
        charge(ctx, actor, run, reservation, getattr(result, 'usage', None))
        return result

    def advisor(provider, model, inputs):
        result = invoke(provider, model, inputs, None, 'agent_run.moa_advisor')
        return result.message.content, result.usage

    def aggregator(provider, model, inputs, call_tools):
        result = invoke(provider, model, inputs, call_tools, 'agent_run.moa_aggregator')
        return result.message, result.usage

    result = coordinator.execute_turn(messages, tools=tools, iteration_index=len(run.get('observations', [])),
                                      advisor_executor=advisor, aggregator_executor=aggregator)
    run['_moa_guidance'] = coordinator.cached_guidance
    return result
