"""Read projections reveal recovery state without stored prompts or actors."""
from fastapi.testclient import TestClient
from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.application.command_delivery import admit, fail
from homun.application.command_types import CommandRequest
from homun.domain.models import Actor


def test_conversation_read_recovery_projection_and_authorization(tmp_path):
    ctx = create_context(db_path=tmp_path / 'ws.db', data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(ctx)
    actor = Actor(id='person_fabio', workspace_id=ctx.workspace_id, display_name='Fabio')
    with ctx.repository.transaction() as store:
        service = ctx.service.for_store(store)
        project = service.apply(actor, 'p', 'project.create', {'name': 'Private'})['project_id']
        conv = service.apply(actor, 'c', 'conversation.create', {'title': 'Private', 'project_id': project})['conversation_id']
    body = CommandRequest(command_id='m', type='conversation.post_message', payload={'conversation_id': conv, 'text': 'private prompt'})
    delivery = admit(ctx, actor, body)
    fail(ctx, delivery, 'provider_unavailable')
    reset_context_for_tests(None)
    ctx = create_context(db_path=tmp_path / 'ws.db', data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(ctx)
    client = TestClient(create_app())
    try:
        assert client.get('/v1/workspaces/ws_local/conversations').status_code == 401
        response = client.get('/v1/workspaces/ws_local/conversations', headers={'X-Homun-Actor-Id': actor.id})
        row = response.json()['items'][0]
        assert 'followups' in row
        notice = row['followups'][0]
        assert notice['status'] == 'retry_scheduled'
        assert notice['error_code'] == 'provider_unavailable'
        assert notice['attempts'] == 1
        assert set(notice) == {'command_id', 'status', 'error_code', 'attempts'}
        assert 'private prompt' not in response.text
        other = client.get('/v1/workspaces/ws_local/conversations', headers={'X-Homun-Actor-Id': 'other'})
        assert other.json()['items'] == []
        with ctx.repository.transaction() as store:
            store.commands['m'].followup_next_attempt_at = None
        assert client.get('/v1/workspaces/ws_local/conversations', headers={'X-Homun-Actor-Id': actor.id}).json()['items'][0]['followups'][0]['status'] == 'failed'
        with ctx.repository.transaction() as store:
            store.commands['m'].followup_status = 'completed'
        assert client.get('/v1/workspaces/ws_local/conversations', headers={'X-Homun-Actor-Id': actor.id}).json()['items'][0]['followups'] == []
    finally:
        client.close()
        reset_context_for_tests(None)
