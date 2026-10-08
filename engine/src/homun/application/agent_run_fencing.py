"""Canonical epoch fencing shared by controls and supervised child runs."""
from homun.application.agent_recovery_state import interrupt

LEASE_SECONDS = 180


def _fence(run,actor,*,preserve_active=False):
    run['_epoch']+=1
    run['_workflow_id']=f'agent:{actor.workspace_id}:{run["id"]}:{run["_epoch"]}'
    run.pop('_lease_token',None)
    run.pop('_lease_until',None)
    run.pop('stream_progress',None)
    # A new control generation fences any unresolved retry; it starts fresh.
    interrupt(run)
    if not preserve_active:
        run.pop('_active_call_id',None)
        run.pop('_active_call_ids',None)

