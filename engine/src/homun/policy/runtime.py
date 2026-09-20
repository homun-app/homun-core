"""Authorize deferred work using persisted command provenance and current grants."""
from homun.domain.errors import NotFoundError, PermissionDeniedError
from homun.domain.models import Actor
from homun.policy.work import require_work_access, work_project_ids


def intent_has_authority(store, intent):
    run = store.runs.get(intent.run_id)
    work = store.works.get(run.work_id) if run else None
    if work is None:
        return False
    record = store.commands.get(intent.command_id)
    if record is None:
        # Legacy workspace-only intents predate project access enforcement.
        # Missing provenance must never grant access to a scoped project.
        return not work_project_ids(store, work)
    if not record.actor_id or record.workspace_id != store.workspace_id:
        return False
    actor = Actor(id=record.actor_id, workspace_id=record.workspace_id, display_name=record.actor_id)
    try:
        require_work_access(store, actor, work.id)
    except (NotFoundError, PermissionDeniedError):
        return False
    return True
