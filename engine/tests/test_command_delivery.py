"""User commands survive model failures; HTTP and SSE share delivery semantics."""
import json

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests


@pytest.fixture
def setup(tmp_path):
    ctx = create_context(db_path=tmp_path / 'ws.db', data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(ctx)
    client = TestClient(create_app())  # no runtime lifecycle needed for conversation commands
    headers = {'X-Homun-Actor-Id': 'person_fabio'}
    response = client.post('/v1/workspaces/ws_local/commands', headers=headers,
                           json={'command_id': 'create', 'type': 'conversation.create', 'payload': {'title': 'Test'}})
    conv = response.json()['result']['conversation_id']
    body = {'command_id': 'message', 'type': 'conversation.post_message', 'payload': {'conversation_id': conv, 'text': 'Ciao'}}
    yield ctx, client, headers, body
    client.close()
    reset_context_for_tests(None)


@pytest.mark.parametrize('suffix', ['', '/stream'])
def test_model_failure_keeps_committed_user_message_and_retry_resumes(setup, monkeypatch, suffix):
    ctx, client, headers, body = setup
    original = ctx.models.interpret
    def unavailable(*args, **kwargs):
        saved = ctx.repository.load()
        assert 'message' in saved.commands, 'Provider started before command commit'
        assert len(saved.messages) == 1
        raise RuntimeError('Provider offline')
    monkeypatch.setattr(ctx.models, 'interpret', unavailable)
    response = client.post('/v1/workspaces/ws_local/commands' + suffix, headers=headers, json=body)
    if suffix:
        assert 'provider_unavailable' in response.text
    else:
        assert response.status_code == 503
    saved = ctx.repository.load()
    assert len(saved.messages) == 1
    assert saved.commands['message'].followup_status == 'failed'
    monkeypatch.setattr(ctx.models, 'interpret', original)
    response = client.post('/v1/workspaces/ws_local/commands' + suffix, headers=headers, json=body)
    assert response.status_code == 200
    assert len(ctx.repository.load().messages) == 2
    # Completed replay never calls the model again.
    monkeypatch.setattr(ctx.models, 'interpret', unavailable)
    replay = client.post('/v1/workspaces/ws_local/commands', headers=headers, json=body)
    assert replay.status_code == 200
    assert replay.json()['result']['assistant_text']
    assert len(ctx.repository.load().messages) == 2


def test_failed_domain_command_does_not_leak_partial_mutations(setup, monkeypatch):
    ctx, client, headers, body = setup
    from homun.domain.service import HANDLERS
    from homun.domain.errors import ValidationError
    def fail_after_mutation(command_ctx, actor, command_id, payload):
        command_ctx.store.conversations.clear()
        raise ValidationError('late validation failure')
    monkeypatch.setitem(HANDLERS, 'conversation.create', fail_after_mutation)
    response = client.post('/v1/workspaces/ws_local/commands', headers=headers,
                           json={'command_id': 'broken', 'type': 'conversation.create', 'payload': {}})
    assert response.status_code == 400
    assert len(ctx.service.store.conversations) == 1
    assert len(ctx.repository.load().conversations) == 1


def test_pending_claim_blocks_duplicate_but_not_other_commands(setup, monkeypatch):
    from homun.application.command_delivery import admit, complete
    from homun.application.command_types import CommandRequest
    from homun.domain.errors import CommandInProgressError
    from homun.domain.models import Actor
    ctx, client, headers, body = setup
    actor = Actor(id=headers['X-Homun-Actor-Id'], workspace_id=ctx.workspace_id, display_name='Fabio')
    request = CommandRequest.model_validate(body)
    delivery = admit(ctx, actor, request)
    with pytest.raises(CommandInProgressError):
        admit(ctx, actor, request)
    original = ctx.models.interpret
    def interleaved(*args, **kwargs):
        # No SQL write transaction or shared connection is held across generation.
        ctx.memory.add_approved(text='A durable memory', actor_id=actor.id)
        response = client.post('/v1/workspaces/ws_local/commands', headers=headers,
                               json={'command_id': 'parallel', 'type': 'conversation.create', 'payload': {'title': 'Parallel'}})
        assert response.status_code == 200
        return original(*args, **kwargs)
    monkeypatch.setattr(ctx.models, 'interpret', interleaved)
    result = complete(ctx, delivery)
    assert result['assistant_message_id']
    saved = ctx.repository.load()
    assert len(saved.conversations) == 2
    assert len(saved.messages) == 2
    assert len(ctx.memory.list()) == 1


def test_expired_attempt_is_fenced_after_recovery(setup):
    from datetime import timedelta
    from homun.application.command_delivery import admit, complete
    from homun.application.command_types import CommandRequest
    from homun.domain.errors import ConflictError
    from homun.domain.models import Actor, utc_now
    ctx, _, headers, body = setup
    actor = Actor(id=headers['X-Homun-Actor-Id'], workspace_id=ctx.workspace_id, display_name='Fabio')
    request = CommandRequest.model_validate(body)
    old = admit(ctx, actor, request)
    with ctx.repository.transaction() as store:
        store.commands['message'].followup_expires_at = utc_now() - timedelta(seconds=1)
    recovered = admit(ctx, actor, request)
    result = complete(ctx, recovered)
    with pytest.raises(ConflictError):
        complete(ctx, old)
    saved = ctx.repository.load()
    assert len(saved.messages) == 2
    assert saved.commands['message'].result == result
    assert saved.commands['message'].followup_status == 'completed'


def test_sse_persisted_is_emitted_after_actual_commit(setup, monkeypatch):
    from homun.routes import domain
    ctx, client, headers, body = setup
    original = domain.sse_event
    checked = []
    def verify(event, data):
        if event == 'phase' and data.get('phase') == 'persisted':
            assert 'message' in ctx.repository.load().commands
            checked.append(True)
        return original(event, data)
    monkeypatch.setattr(domain, 'sse_event', verify)
    response = client.post('/v1/workspaces/ws_local/commands/stream', headers=headers, json=body)
    assert 'event: result' in response.text
    assert checked == [True]


def test_disconnect_at_first_persisted_event_keeps_completed_reply(setup):
    import asyncio
    from homun.application.command_types import CommandRequest
    from homun.routes.domain import post_command_stream
    ctx, _, headers, body = setup
    async def disconnect():
        response = post_command_stream(ctx.workspace_id, CommandRequest.model_validate(body),
                                       headers['X-Homun-Actor-Id'], 'Fabio')
        iterator = response.body_iterator
        assert 'accepted' in await anext(iterator)
        assert 'persisted' in await anext(iterator)
        await iterator.aclose()
    asyncio.run(disconnect())
    saved = ctx.repository.load()
    assert saved.commands['message'].followup_status == 'completed'
    assert len(saved.messages) == 2
