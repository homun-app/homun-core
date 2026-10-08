"""Ephemeral authority for one validated invitation; never a project grant."""
from contextlib import contextmanager
from contextvars import ContextVar

_scope = ContextVar('contribution_invitation_scope', default=None)

@contextmanager
def invited_contribution(actor_id, request_id, work_id, version):
    token = _scope.set((actor_id,request_id,work_id,version))
    try:
        yield
    finally:
        _scope.reset(token)

def permits(store, actor, payload):
    scope = _scope.get()
    request = store.contributions.get(str(payload.get('request_id','')))
    if not scope or not request:
        return False
    work = store.works.get(request.work_id)
    return bool(work and actor.workspace_id == store.workspace_id and actor.kind == 'person'
                and request.to_actor_id == actor.id and not payload.get('material_ids')
                and scope == (actor.id,request.id,work.id,work.version)
                and payload.get('expected_version') == work.version)
