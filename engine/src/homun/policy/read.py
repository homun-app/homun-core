"""Read visibility resolved against current grants, including historical events."""
from itertools import islice

from homun.domain.errors import NotFoundError, PermissionDeniedError
from homun.policy import require_project_capability, require_workspace_actor
from homun.policy.grants import can_read_grant
from homun.policy.work import require_conversation_access, require_work_access


def can_read_work(store, actor, work_id):
    try:
        require_work_access(store, actor, work_id, 'read')
        return True
    except (NotFoundError, PermissionDeniedError):
        return False


def _require_reference(store, actor, kind, ident):
    if kind == 'project':
        require_project_capability(store, actor, ident, 'read')
    elif kind == 'work':
        require_work_access(store, actor, ident, 'read')
    elif kind == 'conversation':
        require_conversation_access(store, actor, ident, 'read')
    elif kind == 'run':
        run = store.runs.get(ident)
        if run is None:
            raise NotFoundError('Unknown event run')
        require_work_access(store, actor, run.work_id, 'read')
    elif kind in {'material', 'grant'}:
        record = getattr(store, kind + 's').get(ident)
        if record is None:
            raise NotFoundError('Unknown event reference')
        if kind == 'grant':
            if not can_read_grant(store, actor, record):
                raise PermissionDeniedError('Grant is not visible to actor')
        else:
            require_project_capability(store, actor, record.project_id, 'read')
    elif kind not in {'agent', 'team', 'workspace'}:
        raise PermissionDeniedError('Unsupported event aggregate')


_REFERENCE_KINDS = {'project', 'work', 'conversation', 'material', 'grant', 'run'}


def payload_references(payload):
    if isinstance(payload, dict):
        for key, value in payload.items():
            for kind in _REFERENCE_KINDS:
                if key.endswith(kind + '_id') and value is not None:
                    yield kind, str(value)
                elif key.endswith(kind + '_ids') and isinstance(value, list):
                    for ident in value:
                        yield kind, str(ident)
            if key == 'resource_id' and value is not None:
                yield payload.get('resource_type', 'project'), str(value)
            yield from payload_references(value)
    elif isinstance(payload, list):
        for value in payload:
            yield from payload_references(value)


def visible_event(store, actor, event):
    """Project permitted history while retaining the narrower grant boundary."""
    try:
        require_workspace_actor(actor, store.workspace_id)
        if event.workspace_id != store.workspace_id:
            return None
        _require_reference(store, actor, event.aggregate_type, event.aggregate_id)
        payload = dict(event.payload)
        if event.aggregate_type == 'project' and event.type in {
            'project.created', 'project.created_from_conversation',
        } and payload.get('admin_grant_id') is not None:
            grant = store.grants.get(str(payload['admin_grant_id']))
            if grant is None:
                return None
            # The creating admin's grant is optional metadata on readable
            # project history. Remove that field only, never the stored event.
            if not can_read_grant(store, actor, grant):
                del payload['admin_grant_id']
        checked_payload = payload
        if event.aggregate_type == 'grant':
            grant = store.grants[event.aggregate_id]
            if (payload.get('resource_id') == grant.resource_id
                    and payload.get('resource_type', 'project') == grant.resource_type):
                # Own grant metadata stays visible after revocation, matching
                # /grants. A matching resource ID is already part of that grant.
                checked_payload = {key: value for key, value in payload.items() if key != 'resource_id'}
        for kind, ident in payload_references(checked_payload):
            _require_reference(store, actor, kind, ident)
        return event.model_copy(update={'payload': payload}).model_dump(mode='json')
    except (NotFoundError, PermissionDeniedError):
        return None


def can_read_event(store, actor, event):
    return visible_event(store, actor, event) is not None


def readable_event_page(store, actor, after, limit):
    # Limit scanned records, not only visible ones. Returning the scanned cursor
    # lets consumers move through arbitrarily long inaccessible stretches.
    scanned = list(islice((event for event in store.events if event.sequence > after), limit))
    return {
        'items': [view for event in scanned if (view := visible_event(store, actor, event)) is not None],
        'cursor': scanned[-1].sequence if scanned else after,
    }
