"""Grant metadata is visible to its subject or the resource's current admin."""
from homun.policy import has_project_capability


def can_read_grant(store, actor, grant):
    return (
        actor.workspace_id == store.workspace_id
        and grant.workspace_id == store.workspace_id
        and grant.resource_type == 'project'
        and (
            grant.subject_id == actor.id
            or has_project_capability(store, actor.id, grant.resource_id, 'admin')
        )
    )
