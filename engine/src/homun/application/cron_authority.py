"""Recheck persisted cron authority before every effect, including scripts."""
from homun.domain.errors import PermissionDeniedError
from homun.domain.models import Actor
from homun.policy.work import require_work_access


def require_owner(ctx, job, actor=None):
    try:
        owner = actor or Actor.model_validate(job.owner_actor)
    except (ValueError, TypeError):
        raise PermissionDeniedError('Cron requires a persisted human owner') from None
    if owner.kind != 'person' or owner.workspace_id != ctx.workspace_id:
        raise PermissionDeniedError('Cron owner belongs to another workspace')
    if actor and job.owner_actor and actor.id != job.owner_actor.get('id') and not job.source_work_id:
        raise PermissionDeniedError('Cron job belongs to another person')
    if job.source_work_id:
        require_work_access(ctx.repository.load(), owner, job.source_work_id, 'write')
    return owner
