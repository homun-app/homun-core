import pytest
from homun.context import create_context
from homun.domain.models import Actor
from homun.domain.states import WorkStatus
from homun.domain.errors import PermissionDeniedError, ConflictError

@pytest.fixture
def setup(tmp_path):
    ctx = create_context(workspace_id='ws_local',db_path=tmp_path/'db',data_dir=tmp_path,for_tests=True)
    owner = Actor(id='owner',display_name='Owner',workspace_id='ws_local')
    project = ctx.service.apply(owner,'project','project.create',{'name':'Private'})
    conv = ctx.service.apply(owner,'conversation','conversation.create',{'title':'Private work','project_id':project['project_id']})
    work = ctx.service.apply(owner,'work','work.create',{'conversation_id':conv['conversation_id'],'title':'Approve price','objective':'Check','project_id':project['project_id']})
    ctx.service.store.works[work['work_id']].status = WorkStatus.RUNNING
    request = ctx.service.apply(owner,'request','work.request_contribution',{'work_id':work['work_id'],'expected_version':1,'step_id':'human','to_actor_id':'person_anna','need':'What price?'})
    ctx.persist()
    yield ctx,owner,request['request_id'],work['work_id']
    ctx.close()

def issue(setup):
    from homun.application.contribution_invitations import issue_invitation
    ctx,owner,rid,_ = setup
    return issue_invitation(ctx,owner,rid,{'recipient_name':'Anna'})

def test_two_identities_scoped_response_and_idempotent_replay(setup):
    from homun.application.contribution_invitations import read_invitation, respond
    ctx,owner,rid,wid = setup
    invitation = issue(setup)
    view = read_invitation(ctx,invitation['token'])
    assert view['recipient_name'] == 'Anna' and view['need'] == 'What price?'
    result = respond(ctx,invitation['token'],'Twenty')
    assert respond(ctx,invitation['token'],'Twenty') == result
    with pytest.raises(ConflictError):
        respond(ctx,invitation['token'],'Thirty')
    store = ctx.repository.load()
    assert store.works[wid].status == WorkStatus.READY
    assert store.contributions[rid].response_text == 'Twenty'
    record = next(r for r in store.commands.values() if r.type == 'work.provide_contribution')
    assert record.actor_id == 'person_anna'
    assert not any(g.subject_id == 'person_anna' for g in store.grants.values())
    assert invitation['token'] not in str([r.model_dump() for r in store.commands.values()])

def test_revoked_expired_foreign_and_stale_invites_denied(setup):
    from homun.application.contribution_invitations import read_invitation, revoke_invitation, issue_invitation
    ctx,owner,rid,wid = setup
    foreign = Actor(id='stranger',display_name='Other',workspace_id='ws_local')
    with pytest.raises(PermissionDeniedError):
        issue_invitation(ctx,foreign,rid,{'recipient_name':'Anna'})
    invitation = issue(setup)
    revoke_invitation(ctx,owner,invitation['id'])
    with pytest.raises(PermissionDeniedError):
        read_invitation(ctx,invitation['token'])
    second = issue(setup)
    with ctx.repository.transaction() as store:
        store.commands[second['id']].result['expires_at'] = '2000-01-01T00:00:00+00:00'
    with pytest.raises(PermissionDeniedError):
        read_invitation(ctx,second['token'])
    third = issue(setup)
    with ctx.repository.transaction() as store:
        store.works[wid].version += 1
    with pytest.raises(ConflictError):
        read_invitation(ctx,third['token'])

def test_guest_http_auth_is_narrow_and_actor_is_fixed(setup):
    from fastapi.testclient import TestClient
    from homun.context import reset_context_for_tests
    from homun.app import create_app
    ctx,owner,rid,wid = setup
    reset_context_for_tests(ctx)
    invitation = issue(setup)
    headers = {'Authorization':'Bearer '+invitation['token'],'X-Homun-Actor-Id':'owner'}
    with TestClient(create_app(session_token='s'*32,session_actor_id='owner')) as client:
        read = client.post('/v1/contribution-portal/read',headers=headers)
        assert read.status_code == 200
        assert read.json()['recipient_id'] == 'person_anna'
        assert set(read.json()) == {'work_title','need','recipient_name','recipient_id','status','expires_at','response_text'}
        assert client.get('/v1/workspaces/ws_local/works',headers=headers).status_code == 401
        assert client.post('/v1/contribution-portal/respond',headers=headers,json={'text':'30','request_id':'other'}).status_code == 422
        assert client.post('/v1/contribution-portal/respond',headers=headers,json={'text':'30'}).status_code == 200
        assert client.post('/v1/contribution-portal/respond',headers=headers,json={'text':'30'}).status_code == 200
        assert client.post('/v1/contribution-portal/read/other',headers=headers).status_code == 401
        assert client.post('/v1/contribution-portal/read',headers={'Authorization':'Bearer '+'s'*32}).status_code == 403
    record = next(r for r in ctx.repository.load().commands.values() if r.type == 'work.provide_contribution')
    assert record.actor_id == 'person_anna'

def test_issuer_access_revocation_disables_invitation(setup):
    from homun.application.contribution_invitations import read_invitation
    ctx,owner,rid,wid = setup
    invitation = issue(setup)
    with ctx.repository.transaction() as store:
        store.works[wid].owner_id = 'someone_else'
    with pytest.raises(PermissionDeniedError):
        read_invitation(ctx,invitation['token'])

def test_scoped_authority_never_leaks_after_response(setup):
    from homun.application.contribution_invitations import respond
    ctx,owner,rid,wid = setup
    invitation = issue(setup)
    respond(ctx,invitation['token'],'30')
    recipient = Actor(id='person_anna',display_name='Anna',workspace_id='ws_local')
    with pytest.raises(PermissionDeniedError):
        ctx.service.apply(recipient,'outside','work.provide_contribution',{'request_id':rid,'text':'30','expected_version':3})

def test_named_recipient_persists_and_owner_requests_real_contribution(setup):
    from homun.application.contribution_people import create_person, list_people, request_contribution
    ctx,owner,rid,wid = setup
    person = create_person(ctx,owner,{'command_id':'person','name':'Anna Verdi'})
    assert list_people(ctx.snapshot(),owner)['items'] == [person]
    with ctx.repository.transaction() as store:
        store.works[wid].status = WorkStatus.RUNNING
        store.contributions[rid].status = 'resolved'
    result = request_contribution(ctx,owner,wid,{'command_id':'human-request','person_id':person['id'],'need':'Confermi?', 'expected_version':2,'step_id':'review'})
    assert ctx.repository.load().contributions[result['request_id']].to_actor_id == person['id']
    assert not ctx.repository.load().agents
