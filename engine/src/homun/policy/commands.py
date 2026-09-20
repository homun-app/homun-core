"""Project resource authority before mutation and before cached result disclosure."""
from homun.domain.errors import NotFoundError
from homun.policy import require_project_capability
from homun.policy.work import require_work_command_authority, require_work_access, require_conversation_access


def _lookup(collection, identity, label):
    resource = collection.get(str(identity))
    if resource is None:
        raise NotFoundError(f'{label} not found')
    return resource


def require_command_authority(store, actor, command_type, payload, cached_result=None):
    require_work_command_authority(store, actor, command_type, payload)
    if command_type in {'project.update', 'project.archive'}:
        require_project_capability(store, actor, str(payload.get('project_id', '')), 'write')
    elif command_type in {'material.create', 'material.ingest', 'grant.issue'}:
        project_id = payload.get('project_id') or (payload.get('resource_id') if command_type == 'grant.issue' else None)
        if project_id is not None:
            project_id = str(project_id).strip() if command_type != 'material.ingest' else str(project_id)
        if project_id:
            require_project_capability(store, actor, project_id, 'admin' if command_type == 'grant.issue' else 'write')
    elif command_type in {'material.update', 'material.archive'}:
        material = _lookup(store.materials, payload.get('material_id', ''), 'Material')
        require_project_capability(store, actor, material.project_id, 'write')
    elif command_type == 'grant.revoke':
        grant = _lookup(store.grants, str(payload.get('grant_id', '')).strip(), 'Grant')
        require_project_capability(store, actor, grant.resource_id, 'admin')
    if cached_result is not None:
        # Creation payloads may predate a resource being attached to a project.
        # Resolve current scopes from persisted resources, not cached metadata.
        if cached_result.get('work_id'):
            require_work_access(store, actor, cached_result['work_id'])
        if cached_result.get('conversation_id'):
            require_conversation_access(store, actor, cached_result['conversation_id'])
        if cached_result.get('material_id'):
            material = _lookup(store.materials, cached_result['material_id'], 'Material')
            require_project_capability(store, actor, material.project_id, 'write')
        if cached_result.get('project_id'):
            require_project_capability(store, actor, cached_result['project_id'], 'write')
