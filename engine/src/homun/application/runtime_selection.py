"""Immutable requested model choices, independent of ambient provider defaults."""
from urllib.parse import urlsplit
from ipaddress import ip_address
from pydantic import BaseModel, ConfigDict, Field, ValidationError as SchemaError
from typing import Literal
from homun.domain.errors import ConflictError, ValidationError


class RuntimeSelection(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    version: Literal[1] = 1
    connection_id: str = Field(min_length=1, max_length=160)
    provider_id: str = Field(min_length=1, max_length=160)
    kind: str
    model_id: str = Field(min_length=1, max_length=256)
    endpoint: str | None = None


def _endpoint(connection):
    endpoint = connection.base_url
    if endpoint:
        parsed = urlsplit(endpoint)
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValidationError('Model endpoints must not contain embedded credentials or query parameters')
        endpoint = endpoint.rstrip('/')
    return endpoint


def _configured(connection):
    if not connection.configured:
        raise ValidationError('Model connection is not configured')
    if connection.kind == 'openai_compatible' and not connection.credential_present:
        host = urlsplit(connection.base_url or '').hostname or ''
        try:
            local = ip_address(host).is_loopback
        except ValueError:
            local = host == 'localhost'
        if not local:
            raise ValidationError('Model connection requires current credentials')


def identifier(value, *, maximum=256):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or '\x00' in value:
        raise ValidationError('Runtime identifiers must be bounded non-empty strings')
    return value


def resolve(models, *, connection_id=None, provider_id=None, model_id=None):
    for value, maximum in ((connection_id, 160), (provider_id, 160), (model_id, 256)):
        if value is not None:
            identifier(value, maximum=maximum)
    if connection_id:
        connection = models.get_connection(connection_id)
        if provider_id and provider_id not in {connection.id, connection.kind, connection.pydantic_provider}:
            raise ValidationError('Connection and provider preference disagree')
    else:
        candidates = [connection for connection in models.list_connections()
            if provider_id in {connection.id, connection.kind, connection.pydantic_provider}] if provider_id else [connection for connection in models.list_connections() if connection.active]
        exact = [connection for connection in candidates if connection.id == provider_id]
        if exact:
            candidates = exact
        if len(candidates) != 1:
            raise ValidationError('Model connection selection is missing or ambiguous')
        connection = candidates[0]
    _configured(connection)
    try:
        return RuntimeSelection(connection_id=connection.id, provider_id=connection.pydantic_provider or connection.kind,
            kind=connection.kind, model_id=model_id or connection.model_id, endpoint=_endpoint(connection)).model_dump()
    except SchemaError as exc:
        raise ValidationError('Invalid requested model selection') from exc


def validate(models, selection):
    try:
        pinned = RuntimeSelection.model_validate(selection).model_dump()
    except SchemaError as exc:
        raise ValidationError('Invalid approved runtime selection') from exc
    current = resolve(models, connection_id=pinned['connection_id'], model_id=pinned['model_id'])
    if current != pinned:
        raise ConflictError('Approved model connection identity changed; propose again')
    return pinned


def for_call(models, run, *, connection_id=None, model_id=None):
    selected = connection_id or run['connection_id']
    routes = run.get('_runtime_routes')
    if not routes:
        # Old approved runs have no immutable model contract. Their established
        # runtime remains explicit; fresh continuations require known provenance.
        return resolve(models, connection_id=selected, model_id=model_id)
    candidates = [route for route in routes if route['connection_id'] == selected and (model_id is None or route['model_id'] == model_id)]
    effective = run.get('runtime_selection')
    if model_id is None and effective and effective['connection_id'] == selected:
        return validate(models, effective)
    if model_id is None and routes[0]['connection_id'] == selected:
        return validate(models, routes[0])
    if model_id is None and run.get('_fallback_runtime', {}).get('connection_id') == selected:
        return validate(models, run['_fallback_runtime'])
    unique = {route['model_id']: route for route in candidates}
    if len(unique) != 1:
        raise ValidationError('Model call is not bound to one approved runtime choice')
    return validate(models, next(iter(unique.values())))


def kwargs(models, run, *, connection_id=None, model_id=None):
    selected = for_call(models, run, connection_id=connection_id, model_id=model_id)
    return {key: selected[key] for key in ('connection_id', 'model_id')} | {'expected_runtime': selected}


def bind(ctx, store, run, body):
    primary = resolve(ctx.models, connection_id=run['connection_id'], provider_id=body.get('provider_id'), model_id=body.get('model_id'))
    run['runtime_selection'] = primary
    routes = [primary]
    if run.get('fallback_connection_id'):
        fallback = resolve(ctx.models, connection_id=run['fallback_connection_id'])
        run['_fallback_runtime'] = fallback
        routes.append(fallback)
    collaborators = {}
    for member in (run.get('team') or {}).get('members', []):
        agent = store.agents[member['id']]
        selection = resolve(ctx.models, connection_id=agent.preferred_connection_id or run['connection_id'])
        collaborators[agent.id] = selection
        routes.append(selection)
    run['_consultation_models'] = collaborators
    if run.get('moa'):
        config = run['moa']
        references = config.get('reference_models') or [{'provider': primary['connection_id'], 'model': primary['model_id']}]
        selected = [resolve(ctx.models, connection_id=ref['provider'], model_id=ref['model']) for ref in references]
        aggregate = config.get('aggregator') or {}
        aggregator = resolve(ctx.models, connection_id=aggregate.get('provider') or primary['connection_id'], model_id=aggregate.get('model') or primary['model_id'])
        run['_moa_models'] = {'references': selected, 'aggregator': aggregator}
        routes.extend(selected + [aggregator])
    run['_runtime_routes'] = list({(route['connection_id'], route['model_id']): route for route in routes}.values())
