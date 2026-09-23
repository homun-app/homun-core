"""Resolve a model executor without inventing a collaborator profile."""
from homun.domain.errors import ValidationError


def resolve_executor(store, assignee_id, *, human_owner_id=None):
    """A human-owned phase runs as Homun; explicit agent identities stay strict."""
    agent = store.agents.get(assignee_id)
    if agent is not None:
        if agent.status != 'active':
            raise ValidationError('Execution requires an active assigned collaborator')
        return agent
    if assignee_id == human_owner_id and not assignee_id.startswith('agent_'):
        return None
    raise ValidationError('Assigned collaborator no longer exists')
