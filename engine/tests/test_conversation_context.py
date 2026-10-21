"""Authorized, bounded model context is a projection, never a transcript edit.

The front-door turn is the only path a chat message takes to the model; these
tests hook its native tool call and look at what the provider would receive.
"""
import pytest

from homun.application.sessions.command_delivery import admit, complete
from homun.application.sessions.command_types import CommandRequest
from homun.context import create_context
from homun.domain.errors import PermissionDeniedError, ValidationError
from homun.domain.models import Actor, Work
from homun.models.native_turn import NativeMessage, NativeResult, ToolCall
from homun.models.types import UsageEntry


@pytest.fixture
def setup(tmp_path):
    ctx = create_context(db_path=tmp_path / 'context.db', data_dir=tmp_path, for_tests=True)
    actor = Actor(id='owner', workspace_id=ctx.workspace_id, display_name='Owner')
    with ctx.repository.transaction() as store:
        svc = ctx.service.for_store(store)
        conv = svc.apply(actor, 'conv', 'conversation.create', {'title': 'Context'})['conversation_id']
        project = svc.apply(actor, 'project', 'project.create', {'name': 'Private'})['project_id']
    yield ctx, actor, conv, project
    ctx.close()


def linked_work(setup, *, ident='private_work', revoke=False):
    ctx, actor, conv, project = setup
    with ctx.repository.transaction() as store:
        store.works[ident] = Work(id=ident, workspace_id=ctx.workspace_id,
            title='Sensitive work', objective='Secret objective', primary_conversation_id=conv,
            project_id=project, requester_id=actor.id, owner_id=actor.id)
        if revoke:
            store.grants.clear()


def post(setup, *, text='E il prossimo passo?', command_id='current'):
    ctx, actor, conv, _ = setup
    return admit(ctx, actor, CommandRequest(command_id=command_id,
        type='conversation.post_message', payload={'conversation_id': conv, 'text': text}))


def reply(text):
    return NativeMessage(role='assistant', content=text)


def propose(**arguments):
    return NativeMessage(role='assistant', content='', tool_calls=[
        ToolCall(id='call_1', name='propose_work', arguments=arguments)])


def history(messages):
    """What the model sees of the conversation: between the system prompt and the current request."""
    return messages[1:-1]


def hook(monkeypatch, ctx, respond):
    """Replace the native tool call; ``respond(messages)`` returns the assistant message.

    Each call is recorded as a snapshot: the turn appends corrections to the
    same list between rounds.
    """
    seen = []

    def complete_tools(messages, *, tools=None, connection_id=None, **_kw):
        seen.append(list(messages))
        return NativeResult(message=respond(messages), usage=UsageEntry(
            id='usage_test', provider_id='fake', model_id='fake-deterministic-v1',
            input_tokens=4, output_tokens=4, status='ok'))
    monkeypatch.setattr(ctx.models, 'complete_tools', complete_tools)
    return seen


def test_forbidden_linked_work_prevents_any_provider_call(setup, monkeypatch):
    linked_work(setup, revoke=True)
    ctx = setup[0]
    calls = hook(monkeypatch, ctx, lambda messages: reply('Secret objective'))
    with pytest.raises(PermissionDeniedError):
        complete(ctx, post(setup))
    assert calls == []
    saved = ctx.repository.load()
    assert len(saved.messages) == 1
    assert 'private_work' not in str(saved.commands['current'].result)


def test_linked_work_revoked_during_model_prevents_reply_publication(setup, monkeypatch):
    linked_work(setup)
    ctx = setup[0]

    def revoke(messages):
        with ctx.repository.transaction() as store:
            store.grants.clear()
        return reply('Secret objective')
    hook(monkeypatch, ctx, revoke)
    with pytest.raises(PermissionDeniedError):
        complete(ctx, post(setup))
    saved = ctx.repository.load()
    assert len(saved.messages) == 1
    assert 'Secret objective' not in str(saved.commands['current'].result)
    assert saved.commands['current'].followup_next_attempt_at is None


def test_ambiguous_linked_work_does_not_select_first(setup, monkeypatch):
    linked_work(setup)
    linked_work(setup, ident='second_work')
    calls = hook(monkeypatch, setup[0], lambda messages: reply('ok'))
    with pytest.raises(ValidationError, match='ambiguous'):
        complete(setup[0], post(setup))
    assert calls == []


def test_recent_history_bounded_current_exact_and_manifest_metadata_only(setup, monkeypatch):
    ctx, actor, conv, _ = setup
    with ctx.repository.transaction() as store:
        svc = ctx.service.for_store(store)
        for i in range(14):
            svc.apply(actor, f'old{i}', 'conversation.post_message',
                {'conversation_id': conv, 'text': f'Prior {i} ' + 'x' * 1900})
    exact = '  Conferma soltanto il punto 2.\nMantieni le maiuscole: CSV  '
    delivery = post(setup, text=exact)
    before = {k: v.model_dump() for k, v in delivery.snapshot.service.store.messages.items()}

    def inspect(messages):
        selected = history(messages)
        assert messages[-1].role == 'user' and messages[-1].content.endswith(exact)
        assert len(selected) <= 8
        assert sum(len(m.content) for m in selected) <= 12000
        assert selected
        assert all('Prior' in m.content for m in selected)
        return reply('Ricevuto')
    calls = hook(monkeypatch, ctx, inspect)
    result = complete(ctx, delivery)
    saved = ctx.repository.load()
    assert {k: saved.messages[k].model_dump() for k in before} == before
    manifest = result['context_manifest']
    assert manifest['omitted_count'] > 0
    assert 'Prior' not in str(manifest) and 'Conferma' not in str(manifest)
    assert delivery.result['message_id'] not in [s['message_id'] for s in manifest['sources']]
    assert len(manifest['sources']) == len(history(calls[0]))
    assert all(len(s['content_hash']) == 64 for s in manifest['sources'])


def test_history_event_provenance_revocation_excludes_text(setup, monkeypatch):
    ctx, actor, conv, project = setup
    with ctx.repository.transaction() as store:
        svc = ctx.service.for_store(store)
        svc.append_engine_message(actor=actor, command_id='oldreply', conversation_id=conv,
            author_id='homun_engine', text='Never expose private finding',
            event_type='message.interpreted', event_payload={'project_id': project})
        store.grants.clear()

    def inspect(messages):
        assert history(messages) == []
        assert 'Never expose' not in str([m.content for m in messages])
        return reply('ok')
    calls = hook(monkeypatch, ctx, inspect)
    result = complete(ctx, post(setup))
    assert calls
    assert project not in str(result['context_manifest'])


def test_history_selection_uses_event_sequence_after_repository_reload(setup, monkeypatch):
    ctx, actor, conv, _ = setup
    with ctx.repository.transaction() as store:
        svc = ctx.service.for_store(store)
        first = svc.apply(actor, 'first', 'conversation.post_message', {'conversation_id': conv, 'text': 'first'})['message_id']
        second = svc.append_engine_message(actor=actor, command_id='second', conversation_id=conv,
            author_id='homun_engine', text='second')['message_id']
        # Deliberately invert timestamps: append order is the durable event sequence.
        store.messages[first].created_at = store.messages[second].created_at
    calls = hook(monkeypatch, ctx, lambda messages: reply('ok'))
    complete(ctx, post(setup))
    assert [m.content for m in history(calls[0])] == ['first', 'second']
    assert [m.role for m in history(calls[0])] == ['user', 'assistant']


def test_revocation_after_admission_prevents_provider_call(setup, monkeypatch):
    linked_work(setup)
    ctx = setup[0]
    delivery = post(setup)
    with ctx.repository.transaction() as store:
        store.grants.clear()
    calls = hook(monkeypatch, ctx, lambda messages: reply('secret'))
    with pytest.raises(PermissionDeniedError):
        complete(ctx, delivery)
    assert calls == []


def test_revocation_during_model_prevents_the_correction_round(setup, monkeypatch):
    """A tool error would send the same context to the provider again: not after a revocation."""
    linked_work(setup)
    ctx = setup[0]

    def revoke_then_misfire(messages):
        with ctx.repository.transaction() as store:
            store.grants.clear()
        return propose(title='T', objective='O', output='R', capability='nope')
    calls = hook(monkeypatch, ctx, revoke_then_misfire)
    with pytest.raises(PermissionDeniedError):
        complete(ctx, post(setup))
    assert len(calls) == 1


def test_oversized_current_message_fails_explicitly_without_truncation(setup, monkeypatch):
    from homun.models.conversation_context import MAX_CURRENT_CHARACTERS
    calls = hook(monkeypatch, setup[0], lambda messages: reply('ok'))
    exact = 'x' * (MAX_CURRENT_CHARACTERS + 1)
    delivery = post(setup, text=exact)
    with pytest.raises(ValidationError, match='character limit'):
        complete(setup[0], delivery)
    assert calls == []
    assert setup[0].repository.load().messages[delivery.result['message_id']].text == exact


def test_historical_provenance_revoked_during_model_blocks_publication(setup, monkeypatch):
    ctx, actor, conv, project = setup
    with ctx.repository.transaction() as store:
        ctx.service.for_store(store).append_engine_message(actor=actor, command_id='prior',
            conversation_id=conv, author_id='homun_engine', text='Private source content',
            event_type='message.interpreted', event_payload={'project_id': project})

    def revoke(messages):
        assert history(messages)[0].content == 'Private source content'
        with ctx.repository.transaction() as store:
            store.grants.clear()
        return reply('Derivative private answer')
    hook(monkeypatch, ctx, revoke)
    with pytest.raises(PermissionDeniedError):
        complete(ctx, post(setup))
    assert 'Derivative private answer' not in str(setup[0].repository.load().commands['current'].result)


def test_reply_carries_transitive_resource_provenance(setup, monkeypatch):
    from homun.policy.read import can_read_event
    ctx, actor, conv, project = setup
    with ctx.repository.transaction() as store:
        ctx.service.for_store(store).append_engine_message(actor=actor, command_id='prior',
            conversation_id=conv, author_id='homun_engine', text='Private source content',
            event_type='message.interpreted', event_payload={'project_id': project})
    hook(monkeypatch, ctx, lambda messages: reply('Derived'))
    result = complete(ctx, post(setup))
    assert {'resource_type': 'project', 'resource_id': project} in result['context_manifest']['resources']
    with ctx.repository.transaction() as store:
        store.grants.clear()
    saved = ctx.repository.load()
    reply_event = next(e for e in saved.events if e.payload.get('message_id') == result['assistant_message_id'])
    assert not can_read_event(saved, actor, reply_event)


@pytest.mark.parametrize('legacy', [False, True])
def test_completed_replay_after_work_revocation_denies_cached_reply(setup, monkeypatch, legacy):
    linked_work(setup)
    ctx = setup[0]
    delivery = post(setup)
    complete(ctx, delivery)
    with ctx.repository.transaction() as store:
        store.grants.clear()
        if legacy:
            store.commands['current'].result.pop('context_manifest', None)
    calls = hook(monkeypatch, ctx, lambda messages: reply('ok'))
    with pytest.raises(PermissionDeniedError):
        admit(ctx, delivery.actor, delivery.body)
    assert calls == []


@pytest.mark.parametrize('tamper', ['workspace', 'conversation', 'aggregate'])
def test_source_identity_change_during_model_denies_reply(setup, monkeypatch, tamper):
    ctx, actor, conv, _ = setup
    with ctx.repository.transaction() as store:
        svc = ctx.service.for_store(store)
        other = svc.apply(actor, 'other', 'conversation.create', {'title': 'Other'})['conversation_id']
        ident = svc.apply(actor, 'old', 'conversation.post_message', {'conversation_id': conv, 'text': 'Prior'})['message_id']

    def change(messages):
        with ctx.repository.transaction() as store:
            if tamper == 'workspace':
                store.messages[ident].workspace_id = 'other_workspace'
            elif tamper == 'conversation':
                store.messages[ident].conversation_id = other
            else:
                next(e for e in store.events if e.payload.get('message_id') == ident).aggregate_id = other
        return reply('Do not publish')
    hook(monkeypatch, ctx, change)
    with pytest.raises(PermissionDeniedError):
        complete(ctx, post(setup))


def test_correction_round_receives_the_same_selected_history(setup, monkeypatch):
    ctx, actor, conv, _ = setup
    with ctx.repository.transaction() as store:
        ctx.service.for_store(store).apply(actor, 'prior', 'conversation.post_message',
            {'conversation_id': conv, 'text': 'Prepare the September list.'})
    answers = iter([propose(title='T', objective='O', output='R', capability='nope'),
                    reply('Only Italy, understood.')])
    calls = hook(monkeypatch, ctx, lambda messages: next(answers))
    result = complete(ctx, post(setup, text='Only Italy.'))
    assert result['assistant_text'] == 'Only Italy, understood.'
    assert len(calls) == 2
    first, second = calls
    assert history(first)[0].content == 'Prepare the September list.'
    # The second round is the first one plus the model's call and the tool error.
    assert second[:len(first)] == first
    assert [m.role for m in second[len(first):]] == ['assistant', 'tool']
    assert first[-1].content.endswith('Only Italy.')


def test_later_messages_are_not_included_when_an_older_command_resumes(setup, monkeypatch):
    ctx, actor, conv, _ = setup
    delivery = post(setup)
    with ctx.repository.transaction() as store:
        ctx.service.for_store(store).apply(actor, 'later', 'conversation.post_message',
            {'conversation_id': conv, 'text': 'Later message not part of current request'})
    calls = hook(monkeypatch, ctx, lambda messages: reply('ok'))
    complete(ctx, delivery)
    assert history(calls[0]) == []
