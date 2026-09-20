"""Revocation must cover cached project/material/grant results, not just work."""
import pytest
from homun.domain.errors import PermissionDeniedError
from homun.domain.models import Actor
from homun.domain.service import DomainService
from homun.domain.store import WorkspaceStore


@pytest.mark.parametrize('kind', ['project.create','project.update','project.archive',
    'material.create','material.update','material.archive','grant.issue','grant.revoke'])
def test_resource_replay_rechecks_authority(kind):
    svc = DomainService(WorkspaceStore('ws_local'))
    actor = Actor(id='owner', workspace_id='ws_local', display_name='Owner')
    created = svc.apply(actor,'project','project.create',{'name':'Private'})
    project = created['project_id']
    if kind == 'project.create':
        command_id, payload = 'project', {'name':'Private'}
    elif kind.startswith('project.'):
        command_id, payload = 'operation', {'project_id':project,'expected_version':1,'name':'Changed'}
    elif kind == 'material.create':
        command_id, payload = 'operation', {'project_id':project,'title':'Private note','kind':'note','text':'Private'}
    elif kind.startswith('material.'):
        material = svc.apply(actor,'material','material.create',{'project_id':project,'title':'Note'})['material_id']
        command_id, payload = 'operation', {'material_id':material,'expected_version':1,'title':'Changed'}
    elif kind == 'grant.issue':
        command_id, payload = 'operation', {'project_id':project,'subject_id':'other','capability':'read'}
    else:
        grant = svc.apply(actor,'grant','grant.issue',{'project_id':project,'subject_id':'other','capability':'read'})['grant_id']
        command_id, payload = 'operation', {'grant_id':grant}
    expected = svc.apply(actor,command_id,kind,payload)
    assert svc.apply(actor,command_id,kind,payload) == expected
    # Simulate current persisted revocation without changing command identity/history.
    for grant in svc.store.grants.values():
        if grant.subject_id == actor.id:
            grant.status = 'revoked'
    with pytest.raises(PermissionDeniedError):
        svc.apply(actor,command_id,kind,payload)


@pytest.mark.parametrize('kind', ['material.create','grant.issue','grant.revoke'])
def test_authority_matches_handler_identity_normalization(kind):
    svc = DomainService(WorkspaceStore('ws_local'))
    actor = Actor(id='owner', workspace_id='ws_local', display_name='Owner')
    project = svc.apply(actor,'project','project.create',{'name':'Private'})['project_id']
    if kind == 'material.create':
        payload = {'project_id':' '+project+' ', 'title':'Note'}
    elif kind == 'grant.issue':
        payload = {'project_id':' '+project+' ', 'subject_id':'other','capability':'read'}
    else:
        grant = svc.apply(actor,'grant','grant.issue',{'project_id':project,'subject_id':'other','capability':'read'})['grant_id']
        payload = {'grant_id':' '+grant+' '}
    result = svc.apply(actor,'padded',kind,payload)
    assert svc.apply(actor,'padded',kind,payload) == result
