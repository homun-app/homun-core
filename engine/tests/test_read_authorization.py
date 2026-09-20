"""Project read boundaries, including historical events after revocation."""
import pytest
from fastapi.testclient import TestClient
from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.domain.models import Project, AccessGrant, Conversation, Work, Run, DomainEvent, MaterialVersion

@pytest.fixture
def reads(tmp_path):
    ctx = create_context(workspace_id='ws_local', db_path=tmp_path / 'read.sqlite')
    store = ctx.service.store
    store.projects['p'] = Project(id='p', workspace_id='ws_local', name='Secret')
    store.grants['g'] = AccessGrant(id='g', workspace_id='ws_local', subject_id='reader', resource_id='p', capability='read', issuer_id='owner')
    store.conversations['c'] = Conversation(id='c', workspace_id='ws_local', title='Secret', project_id='p')
    store.works['w'] = Work(id='w', workspace_id='ws_local', title='Secret', objective='Secret', primary_conversation_id='c', requester_id='owner', owner_id='owner')
    store.runs['r'] = Run(id='r', workspace_id='ws_local', work_id='w', workflow_id='wf', command_id='cmd')
    store.materials['m'] = MaterialVersion(id='m', workspace_id='ws_local', project_id='p', title='Secret')
    for seq, (kind, ident, payload) in enumerate([('project','p',{}),('conversation','c',{}),('work','w',{}),('material','m',{}),('grant','g',{}),('agent','a',{'nested': {'work_id':'w'}}),('work','missing',{}),('agent','a',{})], 1):
        store.events.append(DomainEvent(event_id=str(seq), workspace_id='ws_local', aggregate_id=ident, aggregate_type=kind, aggregate_version=1, sequence=seq, type=f'{kind}.updated', actor_id='owner', payload=payload))
    ctx.repository.save(store)
    reset_context_for_tests(ctx)
    yield TestClient(create_app()), ctx
    reset_context_for_tests(None)

@pytest.mark.parametrize('path', ['/works','/works/w','/works/w/run','/runs/r','/events'])
def test_actor_required(reads, path):
    client, _ = reads
    response = client.get('/v1/workspaces/ws_local'+path)
    assert response.status_code == 401
    assert response.json()['detail']['code'] == 'unauthorized'

@pytest.mark.parametrize('path', ['/works/w','/works/w/run','/runs/r'])
def test_granted_denied_and_revoked(reads, path):
    client, ctx = reads
    url = '/v1/workspaces/ws_local'+path
    assert client.get(url, headers={'X-Homun-Actor-Id':'reader'}).status_code == 200
    denied = client.get(url, headers={'X-Homun-Actor-Id':'stranger'})
    assert denied.status_code == 403
    assert denied.json()['detail']['code'] == 'permission_denied'
    ctx.service.store.grants['g'].status = 'revoked'
    ctx.repository.save(ctx.service.store)
    assert client.get(url, headers={'X-Homun-Actor-Id':'reader'}).status_code == 403
    events = client.get('/v1/workspaces/ws_local/events', headers={'X-Homun-Actor-Id':'reader'}).json()
    assert [event['event_id'] for event in events['items']] == ['5','8']

def test_filtered_list_and_event_cursor(reads):
    client, _ = reads
    base = '/v1/workspaces/ws_local'
    headers = {'X-Homun-Actor-Id':'stranger'}
    assert client.get(base+'/works', headers=headers).json()['items'] == []
    first = client.get(base+'/events?limit=2', headers=headers).json()
    assert first == {'items': [], 'cursor': 2}
    cursor = 0
    visible = []
    for _ in range(10):
        page = client.get(base+f'/events?after={cursor}&limit=2', headers=headers).json()
        visible.extend(page['items'])
        if page['cursor'] == cursor:
            break
        cursor = page['cursor']
    assert [e['event_id'] for e in visible] == ['8']
    assert cursor == 8
    allowed = client.get(base+'/events', headers={'X-Homun-Actor-Id':'reader'}).json()
    assert [e['event_id'] for e in allowed['items']] == ['1','2','3','4','5','6','8']

def test_event_payload_reference_variants_fail_closed(reads):
    from homun.domain.models import Actor
    from homun.policy.read import can_read_event
    _, ctx = reads
    store = ctx.service.store
    actor = Actor(id='reader', workspace_id='ws_local', display_name='Reader')
    base = store.events[-1]
    for kind in ('project', 'work', 'conversation', 'material', 'grant', 'run'):
        assert not can_read_event(store, actor, base.model_copy(update={'aggregate_type':kind, 'aggregate_id':'missing'}))
        assert not can_read_event(store, actor, base.model_copy(update={'payload':{f'primary_{kind}_id':'missing'}}))
    assert not can_read_event(store, actor, base.model_copy(update={'aggregate_type':'future_protected_entity'}))

def test_read_requires_all_linked_projects_and_current_unexpired_grants(reads):
    from datetime import timedelta
    from homun.domain.models import utc_now
    client, ctx = reads
    store = ctx.service.store
    headers = {'X-Homun-Actor-Id':'reader'}
    base = '/v1/workspaces/ws_local'
    store.projects['other'] = Project(id='other', workspace_id='ws_local', name='Other')
    store.conversations['linked'] = Conversation(id='linked', workspace_id='ws_local', title='Other', project_id='other')
    store.works['w'].conversation_ids.append('linked')
    ctx.repository.save(store)
    assert client.get(base+'/works/w', headers=headers).status_code == 403
    assert client.get(base+'/works', headers=headers).json()['items'] == []
    store.works['w'].conversation_ids.clear()
    store.grants['g'].expires_at = utc_now() - timedelta(seconds=1)
    ctx.repository.save(store)
    assert client.get(base+'/works/w', headers=headers).status_code == 403
    assert [e['event_id'] for e in client.get(base+'/events', headers=headers).json()['items']] == ['5','8']

@pytest.mark.parametrize("project_event", ["project.created", "project.created_from_conversation"])
def test_grant_event_visibility_matches_grant_list_and_redacts_project_creation(reads, project_event):
    client, ctx = reads
    store = ctx.service.store
    store.grants['admin'] = AccessGrant(id='admin', workspace_id='ws_local', subject_id='owner', resource_id='p', capability='admin', issuer_id='owner')
    for seq, kind, ident, payload in [(9,'grant','admin',{'subject_id':'owner','resource_id':'p'}), (10,'project','p',{'name':'Secret','admin_grant_id':'admin'}), (11,'agent','a',{'grant_id':'admin'})]:
        store.events.append(DomainEvent(event_id=str(seq), workspace_id='ws_local', aggregate_id=ident, aggregate_type=kind, aggregate_version=1, sequence=seq, type=project_event if seq == 10 else kind+'.created', actor_id='owner', payload=payload))
    ctx.repository.save(store)
    base = '/v1/workspaces/ws_local'
    headers = {'X-Homun-Actor-Id':'reader'}
    assert [g['id'] for g in client.get(base+'/grants', headers=headers).json()['items']] == ['g']
    events = {e['event_id']: e for e in client.get(base+'/events', headers=headers).json()['items']}
    assert '9' not in events
    assert '11' not in events
    assert events['10']['payload'] == {'name':'Secret'}
    assert '5' in events  # own grant
    admin_events = {e['event_id']: e for e in client.get(base+'/events', headers={'X-Homun-Actor-Id':'owner'}).json()['items']}
    assert admin_events['10']['payload']['admin_grant_id'] == 'admin'
    assert {'5','9','11'} <= admin_events.keys()
    assert store.events[-2].payload['admin_grant_id'] == 'admin'  # projection never mutates history
    store.grants['g'].status = 'revoked'
    store.events[4].payload = {'subject_id':'reader', 'resource_id':'p'}
    ctx.repository.save(store)
    revoked = {e['event_id'] for e in client.get(base+'/events', headers=headers).json()['items']}
    assert revoked == {'5','8'}  # own grant audit remains readable after revocation
