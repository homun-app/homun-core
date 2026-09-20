"""Durable transcript reads enforce current scope and canonical event provenance."""
import pytest
from fastapi.testclient import TestClient
from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.domain.models import AccessGrant, Conversation, DomainEvent, Message, Project, Work

BASE = '/v1/workspaces/ws_local/conversations/c/messages'
HEADERS = {'X-Homun-Actor-Id': 'reader'}


@pytest.fixture
def transcript(tmp_path):
    ctx = create_context(db_path=tmp_path / 'transcript.db', data_dir=tmp_path, for_tests=True)
    store = ctx.service.store
    store.projects['p'] = Project(id='p', workspace_id='ws_local', name='Private')
    store.grants['g'] = AccessGrant(id='g', workspace_id='ws_local', subject_id='reader', resource_id='p', capability='read', issuer_id='owner')
    store.conversations['c'] = Conversation(id='c', workspace_id='ws_local', title='Chat', project_id='p')
    for sequence, text in [(1, 'Original stored text'), (2, 'Stored assistant reply')]:
        ident = f'm{sequence}'
        store.messages[ident] = Message(id=ident, workspace_id='ws_local', conversation_id='c', author_id='homun_engine' if sequence == 2 else 'reader', text=text)
        store.events.append(DomainEvent(event_id=f'e{sequence}', workspace_id='ws_local', aggregate_id='c', aggregate_type='conversation', aggregate_version=sequence, sequence=sequence, type='message.interpreted' if sequence == 2 else 'message.created', actor_id='reader', payload={'message_id': ident}))
    ctx.repository.save(store)
    reset_context_for_tests(ctx)
    client = TestClient(create_app())
    yield client, ctx
    client.close()
    reset_context_for_tests(None)


def test_persisted_transcript_survives_restart_with_safe_metadata(transcript, tmp_path):
    client, ctx = transcript
    with ctx.repository.transaction() as store:
        store.events[1].payload.update(interpretation={'kind': 'reply'}, plan_draft={'title': 'Draft'}, patch_proposal={'status': 'proposed'}, private_debug='never return', context_manifest={'sources': []})
    restarted = create_context(db_path=tmp_path / 'transcript.db', data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(restarted)
    response = client.get(BASE, headers=HEADERS)
    assert response.status_code == 200
    page = response.json()
    assert [row['text'] for row in page['items']] == ['Original stored text', 'Stored assistant reply']
    assert page['cursor'] == 2 and page['has_more'] is False
    row = page['items'][1]
    assert row['sequence'] == 2 and row['interpretation'] == {'kind': 'reply'}
    assert row['plan_draft'] == {'title': 'Draft'}
    assert row['patch_proposal'] == {'status': 'proposed'}
    assert set(row) == {'id', 'conversation_id', 'author_id', 'text', 'created_at', 'sequence', 'interpretation', 'plan_draft', 'patch_proposal'}


def test_typed_authority_errors_and_revocation(transcript):
    client, ctx = transcript
    assert client.get(BASE).status_code == 401
    denied = client.get(BASE, headers={'X-Homun-Actor-Id': 'stranger'})
    assert denied.status_code == 403
    assert denied.json()['detail']['code'] == 'permission_denied'
    for url in [BASE.replace('/c/', '/missing/'), BASE.replace('ws_local', 'missing')]:
        response = client.get(url, headers=HEADERS)
        assert response.status_code == 404 and response.json()['detail']['code'] == 'not_found'
    with ctx.repository.transaction() as store:
        store.grants['g'].status = 'revoked'
    assert client.get(BASE, headers=HEADERS).status_code == 403


def test_multiple_linked_works_require_all_current_scope(transcript):
    client, ctx = transcript
    with ctx.repository.transaction() as store:
        for ident in ['w1', 'w2']:
            store.works[ident] = Work(id=ident, workspace_id='ws_local', title=ident, objective='Objective', primary_conversation_id='c', requester_id='owner', owner_id='owner')
    assert client.get(BASE, headers=HEADERS).status_code == 200
    with ctx.repository.transaction() as store:
        store.projects['secret'] = Project(id='secret', workspace_id='ws_local', name='Secret')
        store.works['w2'].project_id = 'secret'
    assert client.get(BASE, headers=HEADERS).status_code == 403


def test_denied_historical_provenance_advances_empty_page(transcript):
    client, ctx = transcript
    with ctx.repository.transaction() as store:
        store.projects['secret'] = Project(id='secret', workspace_id='ws_local', name='Secret')
        store.events[0].payload['context_manifest'] = {'resources': [{'resource_type': 'project', 'resource_id': 'secret'}]}
    first = client.get(BASE + '?limit=1', headers=HEADERS).json()
    assert first == {'items': [], 'cursor': 1, 'has_more': True}
    second = client.get(BASE + '?limit=1&after=1', headers=HEADERS).json()
    assert [row['id'] for row in second['items']] == ['m2']
    assert second['cursor'] == 2 and second['has_more'] is False


def test_missing_invalid_and_duplicate_events_fail_closed(transcript):
    client, ctx = transcript
    with ctx.repository.transaction() as store:
        store.messages['orphan'] = store.messages['m1'].model_copy(update={'id': 'orphan'})
        store.messages['m2'].workspace_id = 'another'
        base = store.events[0]
        store.events.extend([
            base.model_copy(update={'event_id': 'duplicate', 'sequence': 3}),
            base.model_copy(update={'event_id': 'unknown', 'sequence': 4, 'type': 'message.future', 'payload': {'message_id': 'orphan'}}),
        ])
    page = client.get(BASE, headers=HEADERS).json()
    assert [row['id'] for row in page['items']] == ['m1']
    assert client.get(BASE + '?after=2', headers=HEADERS).json()['items'] == []


@pytest.mark.parametrize('query', ['after=-1', 'limit=0', 'limit=201'])
def test_query_bounds(transcript, query):
    client, _ = transcript
    assert client.get(BASE + '?' + query, headers=HEADERS).status_code == 422


def test_duplicate_cannot_bypass_denied_original_and_still_advances_cursor(transcript):
    client, ctx = transcript
    with ctx.repository.transaction() as store:
        store.events[0].payload['material_id'] = 'missing-material'
        store.events.append(store.events[0].model_copy(update={
            'event_id': 'duplicate', 'sequence': 3, 'payload': {'message_id': 'm1'}}))
    page = client.get(BASE + '?after=2&limit=1', headers=HEADERS).json()
    assert page == {'items': [], 'cursor': 3, 'has_more': False}


@pytest.mark.parametrize('invalid', ['conversation', 'workspace', 'missing-message', 'event-workspace'])
def test_invalid_message_provenance_is_omitted(transcript, invalid):
    client, ctx = transcript
    with ctx.repository.transaction() as store:
        if invalid == 'conversation':
            store.messages['m1'].conversation_id = 'other'
        elif invalid == 'workspace':
            store.messages['m1'].workspace_id = 'other'
        elif invalid == 'missing-message':
            del store.messages['m1']
        else:
            store.events[0].workspace_id = 'other'
    page = client.get(BASE + '?limit=1', headers=HEADERS).json()
    assert page == {'items': [], 'cursor': 1, 'has_more': True}
