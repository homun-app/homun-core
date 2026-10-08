"""Adaptive questions use the approved human recipient and scoped invitation."""
import pytest
from test_agent_runs import setup, scripted
from homun.application.agent_runs import propose, approve, resume_waiting
from homun.application.agent_run_execution import advance
from homun.application.contribution_people import create_person
from homun.domain.errors import ValidationError, ConflictError
from homun.domain.models import Actor


def test_question_invitation_response_resumes_selected_person_run(setup, monkeypatch):
    from homun.application.contribution_invitations import issue_invitation, read_invitation, respond
    ctx, actor, work, material = setup
    person = create_person(ctx, actor, {'command_id':'person', 'name':'Marta'})
    p = propose(ctx, actor, work, {'command_id':'run', 'expected_version':1,
        'material_ids':[material], 'person_id':person['id']})
    assert p['person'] == person
    approve(ctx, actor, work, p['id'], {'command_id':'approve', 'digest':p['digest'], 'expected_version':p['expected_version']})
    seen = []
    scripted(ctx, [{'kind':'ask', 'message':'A chi è destinata la nota?'},
                   {'kind':'finish', 'message':'Nota per il cliente'}], seen)
    assert advance(ctx, p['id']) == 'waiting_input'
    store = ctx.repository.load()
    request = store.contributions[store.commands[p['id']].result['request_id']]
    assert request.to_actor_id == person['id']
    from homun.routes import reads
    monkeypatch.setattr(reads, 'get_context', lambda: ctx)
    view = reads.list_works(ctx.workspace_id, actor.id, actor.display_name)['items'][0]
    assert view['pending_contribution']['recipient_name'] == 'Marta'
    invitation = issue_invitation(ctx, actor, request.id, {})
    assert read_invitation(ctx, invitation['token'])['recipient_name'] == 'Marta'
    respond(ctx, invitation['token'], 'Per il cliente')
    assert resume_waiting(ctx, p['id'])
    assert advance(ctx, p['id']) == 'completed'
    assert seen[1]['observations'][-1]['result']['text'] == 'Per il cliente'
    store = ctx.repository.load()
    assert store.works[work].status == 'review' and len(store.artifacts) == 1
    assert not any(g.subject_id == person['id'] for g in store.grants.values())
    ctx.service = ctx.service.for_store(store)
    artifact = next(iter(store.artifacts.values()))
    ctx.service.apply(actor, 'review', 'work.review', {'work_id': work,
        'expected_version': store.works[work].version, 'artifact_version_id': artifact.id,
        'decision': 'request_changes', 'comment': 'Integra il chiarimento ricevuto'})
    ctx.persist()
    revision = propose(ctx, actor, work, {'command_id': 'revision',
        'expected_version': ctx.repository.load().works[work].version, 'material_ids': [material]})
    import json
    objective = json.loads(ctx.repository.load().commands[revision['id']].result['_objective'])
    assert objective['revision']['clarifications'][0] == {
        'question': 'A chi è destinata la nota?', 'text': 'Per il cliente'}
    approve(ctx, actor, work, revision['id'], {'command_id': 'revision-go',
        'digest': revision['digest'], 'expected_version': revision['expected_version']})
    scripted(ctx, [{'kind': 'finish', 'message': 'Bozza rivista'}], [])
    assert advance(ctx, revision['id']) == 'completed'
    store = ctx.repository.load()
    ctx.service = ctx.service.for_store(store)
    ctx.service.apply(actor, 'review-again', 'work.review', {'work_id': work,
        'expected_version': store.works[work].version,
        'artifact_version_id': store.commands[revision['id']].result['artifact_id'],
        'decision': 'request_changes', 'comment': 'Rivedi ancora'})
    ctx.persist()
    second = propose(ctx, actor, work, {'command_id': 'revision-two',
        'expected_version': ctx.repository.load().works[work].version, 'material_ids': [material]})
    second_objective = json.loads(ctx.repository.load().commands[second['id']].result['_objective'])
    assert second_objective['revision']['clarifications'] == objective['revision']['clarifications']




@pytest.mark.parametrize('recipient', ['missing', 'foreign'])
def test_proposal_rejects_person_not_defined_by_actor(setup, recipient):
    ctx, actor, work, material = setup
    person_id = 'person_missing'
    if recipient == 'foreign':
        other = Actor(id='other', workspace_id=actor.workspace_id, display_name='Other')
        person_id = create_person(ctx, other, {'command_id':'foreign', 'name':'Marta'})['id']
    with pytest.raises(ValidationError):
        propose(ctx, actor, work, {'command_id':'run', 'expected_version':1,
            'material_ids':[material], 'person_id':person_id})
    assert not ctx.repository.load().plans


def test_recipient_snapshot_cannot_change_before_approval(setup):
    ctx, actor, work, material = setup
    person = create_person(ctx, actor, {'command_id':'person', 'name':'Marta'})
    p = propose(ctx, actor, work, {'command_id':'run', 'expected_version':1,
        'material_ids':[material], 'person_id':person['id']})
    with ctx.repository.transaction() as store:
        store.commands['person'].result['name'] = 'Someone else'
    with pytest.raises(ConflictError):
        approve(ctx, actor, work, p['id'], {'command_id':'approve', 'digest':p['digest'], 'expected_version':p['expected_version']})


def test_http_proposal_preserves_reviewed_recipient(setup):
    from fastapi.testclient import TestClient
    from homun.app import create_app
    from homun.context import reset_context_for_tests
    ctx, actor, work, material = setup
    person = create_person(ctx, actor, {'command_id':'person', 'name':'Marta'})
    reset_context_for_tests(ctx)
    try:
        with TestClient(create_app()) as client:
            url = f'/v1/workspaces/{ctx.workspace_id}/works/{work}/agent-runs'
            headers = {'X-Homun-Actor-Id':actor.id}
            response = client.post(url, headers=headers, json={'command_id':'run', 'expected_version':1,
                'material_ids':[material], 'person_id':person['id']})
            assert response.status_code == 200, response.text
            assert response.json()['person'] == person
            assert client.get(url, headers=headers).json()['items'][0]['person'] == person
    finally:
        reset_context_for_tests(None)
