"""Canonical future-run preferences; retention pinning and reported aliases are separate."""
from homun.application import runtime_selection
from homun.domain.errors import ValidationError


def inherited(store, source):
    if source.get('runtime_preferences'):
        return source['runtime_preferences']
    record = store.commands[source['id']]
    seen = set()
    while record.type != 'agent_run.propose':
        if record.result['id'] in seen or len(seen) >= 64:
            raise ValidationError('Runtime preference lineage is cyclic or too deep')
        seen.add(record.result['id'])
        sources = record.result.get('sources', [])
        if not sources:
            return None  # Imported identifiers do not establish runtime authority.
        if len(sources) != 1:
            raise ValidationError('Choose an explicit runtime for ambiguous session lineage')
        record = store.commands[sources[0]['session_id']]
    run = record.result
    selected = run.get('runtime_selection')
    if selected:
        return {key: selected[key] for key in ('connection_id', 'provider_id', 'model_id')}
    receipts = [receipt for receipt in store.budget_usage_receipts.values()
        if receipt.run_id == run['id'] and receipt.connection_id == run['connection_id']
        and receipt.purpose in {'agent_run.decide', 'agent_run.fallback'} and receipt.requested_model_id]
    if receipts:
        latest = max(receipts, key=lambda receipt: (receipt.settled_at, receipt.id))
        return {'connection_id': latest.connection_id, 'model_id': latest.requested_model_id}
    raise ValidationError('This historical run has no reliable requested model; choose a fresh runtime explicitly')


def continuation(ctx, store, source, options):
    explicit = any(options.get(key) is not None for key in ('connection_id', 'provider_id', 'model_id'))
    base = {} if explicit else (inherited(store, source) or {})
    selection = runtime_selection.resolve(ctx.models,
        connection_id=options.get('connection_id') or base.get('connection_id'),
        provider_id=options.get('provider_id') or base.get('provider_id'),
        model_id=options.get('model_id') or base.get('model_id'))
    return {**options, **{key: selection[key] for key in ('connection_id', 'provider_id', 'model_id')}}


def update(ctx, store, source, args):
    for key, maximum in (('model_pin', 256), ('provider_pin', 160)):
        if args.get(key) is not None:
            runtime_selection.identifier(args[key], maximum=maximum)
    base = source.get('runtime_preferences') or {}
    provider = args.get('provider_pin')
    if not provider and not base:
        base = inherited(store, source) or {}
    selection = runtime_selection.resolve(ctx.models,
        connection_id=None if provider else base.get('connection_id'),
        provider_id=provider or base.get('provider_id'), model_id=args.get('model_pin') or base.get('model_id'))
    return {'version': 1, **{key: selection[key] for key in ('connection_id', 'provider_id', 'model_id')}}
