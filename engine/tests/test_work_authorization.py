"""Current project authority applies before work mutations and cached replay."""
from copy import deepcopy
import pytest
from homun.domain.errors import PermissionDeniedError
from homun.domain.models import Actor, Work, ContributionRequest
from homun.domain.service import DomainService
from homun.domain.store import WorkspaceStore


def seeded():
    svc = DomainService(WorkspaceStore('ws_local'))
    owner = Actor(id='owner', workspace_id='ws_local', display_name='Owner')
    other = Actor(id='other', workspace_id='ws_local', display_name='Other')
    project = svc.apply(owner, 'project', 'project.create', {'name':'Private'})['project_id']
    conv = svc.apply(owner, 'conversation', 'conversation.create', {'project_id':project})['conversation_id']
    work = svc.apply(owner, 'work', 'work.create', {'conversation_id':conv,'title':'Private','objective':'Private'})['work_id']
    svc.store.contributions['req'] = ContributionRequest(id='req', work_id=work, step_id='step', to_actor_id=other.id, need='Private')
    return svc, owner, other, project, conv, work


WORK_COMMANDS = ['work.start','work.pause','work.cancel','work.link_conversation',
 'work.request_contribution','work.provide_contribution','work.submit_artifact',
 'work.review','work.preview_patch','work.apply_patch','plan.propose','plan.accept','plan.revise']

@pytest.mark.parametrize('command', WORK_COMMANDS)
@pytest.mark.parametrize('capability', [None, 'read'])
def test_work_commands_require_current_write_before_handler(command, capability):
    svc, owner, other, project, conv, work = seeded()
    if capability:
        svc.apply(owner,'read','grant.issue',{'project_id':project,'subject_id':other.id,'capability':capability})
    before = deepcopy(svc.store.__dict__)
    with pytest.raises(PermissionDeniedError):
        svc.apply(other,'denied',command,{'work_id':work,'conversation_id':conv,'request_id':'req','expected_version':1})
    assert svc.store.__dict__ == before


@pytest.mark.parametrize('command', ['conversation.create','conversation.post_message','work.create'])
def test_conversation_entry_requires_project_write(command):
    svc, _, other, project, conv, _ = seeded()
    with pytest.raises(PermissionDeniedError):
        svc.apply(other,'denied',command,{'project_id':project,'conversation_id':conv,'text':'No','title':'No','objective':'No'})


def test_cached_work_result_is_not_returned_after_revocation():
    svc, owner, other, project, conv, _ = seeded()
    grant = svc.apply(owner,'write','grant.issue',{'project_id':project,'subject_id':other.id,'capability':'write'})['grant_id']
    body = {'conversation_id':conv,'title':'Allowed','objective':'Allowed'}
    result = svc.apply(other,'created','work.create',body)
    assert svc.apply(other,'created','work.create',body) == result
    svc.apply(owner,'revoke','grant.revoke',{'grant_id':grant})
    with pytest.raises(PermissionDeniedError):
        svc.apply(other,'created','work.create',body)


def test_linking_requires_authority_on_target_conversation():
    svc, owner, other, project, conv, private_work = seeded()
    public = svc.apply(other,'public','conversation.create',{})['conversation_id']
    work = svc.apply(other,'public-work','work.create',{'conversation_id':public,'title':'Shared','objective':'Shared'})['work_id']
    with pytest.raises(PermissionDeniedError):
        svc.apply(other,'link','work.link_conversation',{'work_id':work,'conversation_id':conv,'expected_version':1})


def test_owner_can_mutate_and_workspace_only_work_keeps_existing_behavior():
    svc, owner, other, _, _, work = seeded()
    assert svc.apply(owner,'cancel','work.cancel',{'work_id':work,'expected_version':1})['status'] == 'cancelled'
    conv = svc.apply(other,'shared','conversation.create',{})['conversation_id']
    work = svc.apply(other,'shared-work','work.create',{'conversation_id':conv,'title':'Shared','objective':'Shared'})['work_id']
    assert svc.apply(other,'shared-cancel','work.cancel',{'work_id':work,'expected_version':1})['status'] == 'cancelled'


def test_http_denial_is_typed_and_does_not_persist_command(tmp_path):
    from fastapi.testclient import TestClient
    from homun.app import create_app
    from homun.context import create_context, reset_context_for_tests
    svc, owner, other, _, _, work = seeded()
    ctx = create_context(db_path=tmp_path/'workspace.sqlite', data_dir=tmp_path, for_tests=True)
    ctx.service.store = svc.store
    ctx.persist()
    reset_context_for_tests(ctx)
    try:
        with TestClient(create_app()) as client:
            result = client.post('/v1/workspaces/ws_local/commands',
                headers={'X-Homun-Actor-Id':other.id}, json={'command_id':'forbidden-http',
                'type':'work.cancel','payload':{'work_id':work,'expected_version':1}})
            assert result.status_code == 403
            assert result.json()['detail']['code'] == 'permission_denied'
            assert 'forbidden-http' not in ctx.repository.load().commands
            assert ctx.repository.load().works[work].status == 'draft'
    finally:
        reset_context_for_tests(None)


def test_linked_project_remains_part_of_work_authority_after_revocation():
    svc, owner, other, project, private_conv, _ = seeded()
    grant = svc.apply(owner,'write','grant.issue',{'project_id':project,'subject_id':other.id,'capability':'write'})['grant_id']
    shared = svc.apply(other,'shared','conversation.create',{})['conversation_id']
    work = svc.apply(other,'shared-work','work.create',{'conversation_id':shared,'title':'Shared','objective':'Shared'})['work_id']
    linked = svc.apply(other,'link','work.link_conversation',{'work_id':work,'conversation_id':private_conv,'expected_version':1})
    svc.apply(owner,'revoke','grant.revoke',{'grant_id':grant})
    with pytest.raises(PermissionDeniedError):
        svc.apply(other,'cancel','work.cancel',{'work_id':work,'expected_version':linked['version']})


def test_contribution_authority_uses_request_work_not_untrusted_work_id():
    svc, _, other, _, _, _ = seeded()
    conv = svc.apply(other,'shared','conversation.create',{})['conversation_id']
    public_work = svc.apply(other,'shared-work','work.create',{'conversation_id':conv,'title':'Shared','objective':'Shared'})['work_id']
    with pytest.raises(PermissionDeniedError):
        svc.apply(other,'spoofed','work.provide_contribution',{'request_id':'req','work_id':public_work,'text':'No','expected_version':1})
