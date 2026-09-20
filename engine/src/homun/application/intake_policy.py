"""Shared intake authority and immutable proposal identity."""
import hashlib
import json
from homun.domain.errors import ConflictError, NotFoundError, PermissionDeniedError
from homun.domain.states import WorkStatus
from homun.policy.work import require_work_access

PROPOSAL_TYPE = 'intake.propose'

def public(proposal):
    return {key:value for key,value in proposal.items() if not key.startswith('_')}

def digest(proposal):
    return hashlib.sha256(json.dumps({k:v for k,v in proposal.items() if k not in {'digest','status','error_code'}},sort_keys=True,ensure_ascii=False).encode()).hexdigest()

def lookup(store, pid, wid):
    record=store.commands.get(pid)
    if not record or record.type != PROPOSAL_TYPE or record.result['work_id'] != wid:
        raise NotFoundError('Intake proposal not found')
    return record.result

def authority(store, actor, proposal, needed='write'):
    work=require_work_access(store,actor,proposal['work_id'],needed)
    if needed != 'read' and actor.kind != 'person':
        raise PermissionDeniedError('A person must confirm staffing')
    return work

def idle(work):
    if work.status != WorkStatus.DRAFT or work.current_plan_revision or work.current_artifact_version:
        raise ConflictError('Intake requires an idle draft without a plan')

def permission_snapshot(store, actor, work):
    from homun.policy.work import work_project_ids
    projects=work_project_ids(store,work)
    return hashlib.sha256(json.dumps({
        'projects':[store.projects[p].model_dump(mode='json') for p in sorted(projects)],
        'grants':[g.model_dump(mode='json') for g in sorted(store.grants.values(),key=lambda x:x.id) if g.resource_id in projects],
        'teams':[t.model_dump(mode='json') for t in sorted(store.teams.values(),key=lambda x:x.id) if any(t.id in store.projects[p].team_ids for p in projects)]
    },sort_keys=True).encode()).hexdigest()

