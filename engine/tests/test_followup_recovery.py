"""Interrupted model follow-ups recover from durable input, without HTTP replay."""
from datetime import timedelta
import pytest
from homun.application.command_delivery import admit, complete
from homun.application.command_types import CommandRequest
from homun.context import create_context
from homun.domain.models import Actor, utc_now


@pytest.fixture
def context(tmp_path):
    ctx = create_context(db_path=tmp_path / 'ws.db', data_dir=tmp_path, for_tests=True)
    yield ctx
    ctx.close()


def pending(ctx):
    actor = Actor(id='fabio', workspace_id=ctx.workspace_id, display_name='Fabio')
    with ctx.repository.transaction() as store:
        service = ctx.service.for_store(store)
        conv = service.apply(actor, 'conversation', 'conversation.create', {'title': 'Test'})['conversation_id']
    body = CommandRequest(command_id='message', type='conversation.post_message', payload={'conversation_id': conv, 'text': 'Ciao'})
    delivery = admit(ctx, actor, body)
    with ctx.repository.transaction() as store:
        store.commands['message'].followup_expires_at = utc_now() - timedelta(seconds=1)
    return delivery


def test_admission_persists_recoverable_input(context):
    delivery = pending(context)
    record = context.repository.load().commands['message']
    assert getattr(record, 'followup_body', None) == delivery.body.model_dump(mode='json')
    assert getattr(record, 'followup_actor', None) == delivery.actor.model_dump(mode='json')


def test_restart_recovers_without_caller_retry(context):
    from homun.application.followup_recovery import recover_pending
    pending(context)
    root = context.data_dir
    context.close()
    restarted = create_context(db_path=root / 'ws.db', data_dir=root, for_tests=True)
    try:
        assert recover_pending(restarted) == {'completed': 1, 'failed': 0}
        saved = restarted.repository.load()
        assert len(saved.messages) == 2
        assert saved.commands['message'].followup_status == 'completed'
        assert not saved.works and not saved.plans
        assert recover_pending(restarted) == {'completed': 0, 'failed': 0}
    finally:
        restarted.close()


def test_competing_recovery_claims_and_superseded_token(context):
    from concurrent.futures import ThreadPoolExecutor
    from homun.application.followup_recovery import claim_next
    from homun.domain.errors import ConflictError
    old = pending(context)
    with ThreadPoolExecutor(max_workers=2) as workers:
        deliveries = list(workers.map(lambda _: claim_next(context), range(2)))
    claimed = [delivery for delivery in deliveries if delivery is not None]
    assert len(claimed) == 1
    result = complete(context, claimed[0])
    with pytest.raises(ConflictError):
        complete(context, old)
    saved = context.repository.load()
    assert len(saved.messages) == 2
    assert saved.commands['message'].result == result


def test_exhaustion_backoff_and_explicit_same_command_retry(context, monkeypatch):
    from homun.application.followup_recovery import recover_pending
    from homun.application.command_delivery import MAX_FOLLOWUP_ATTEMPTS
    original = context.models.interpret
    delivery = pending(context)
    calls = []
    def offline(*args, **kwargs):
        calls.append(True)
        raise RuntimeError('offline')
    monkeypatch.setattr(context.models, 'interpret', offline)
    assert recover_pending(context)['failed'] == 1
    assert recover_pending(context)['failed'] == 0  # backoff
    with context.repository.transaction() as store:
        store.commands['message'].followup_next_attempt_at = utc_now() - timedelta(seconds=1)
    assert recover_pending(context)['failed'] == 1
    record = context.repository.load().commands['message']
    assert record.followup_attempts == MAX_FOLLOWUP_ATTEMPTS
    assert record.followup_status == 'failed'
    assert record.followup_next_attempt_at is None
    assert record.followup_error == 'provider_unavailable'
    assert recover_pending(context)['failed'] == 0
    assert len(calls) == 2  # initial attempt was interrupted before model execution
    monkeypatch.setattr(context.models, 'interpret', original)
    retry = admit(context, delivery.actor, delivery.body)
    assert complete(context, retry)['assistant_message_id']
    assert len(context.repository.load().messages) == 2


def test_authority_revocation_during_model_generation_blocks_finalization(context, monkeypatch):
    from homun.application.followup_recovery import recover_pending
    delivery = pending(context)
    with context.repository.transaction() as store:
        service = context.service.for_store(store)
        project = service.apply(delivery.actor, 'project', 'project.create', {'name': 'P'})['project_id']
        store.conversations[delivery.body.payload['conversation_id']].project_id = project
    original = context.models.interpret
    def revoke(*args, **kwargs):
        with context.repository.transaction() as store:
            store.grants.clear()
        return original(*args, **kwargs)
    monkeypatch.setattr(context.models, 'interpret', revoke)
    assert recover_pending(context)['failed'] == 1
    saved = context.repository.load()
    assert len(saved.messages) == 1
    assert saved.commands['message'].followup_error == 'permission_denied'
    assert saved.commands['message'].followup_next_attempt_at is None
    assert not saved.works and not saved.plans


def test_missing_or_tampered_legacy_context_fails_explicitly(context):
    from homun.application.followup_recovery import recover_pending
    pending(context)
    with context.repository.transaction() as store:
        store.commands['message'].followup_actor = None
    assert recover_pending(context) == {'completed': 0, 'failed': 0}
    record = context.repository.load().commands['message']
    assert record.followup_status == 'failed'
    assert record.followup_error == 'followup_context_missing'
    assert len(context.repository.load().messages) == 1


def test_lifecycle_pump_runs_without_http_retry_and_stops(context):
    import asyncio
    from homun.application.followup_recovery import followup_recovery_lifespan
    pending(context)
    async def run():
        async with followup_recovery_lifespan(context, interval=0.01):
            for _ in range(100):
                if context.repository.load().commands['message'].followup_status == 'completed':
                    break
                await asyncio.sleep(0.01)
            else:
                pytest.fail('Recovery did not finish')
        assert not [task for task in asyncio.all_tasks() if task.get_name() == 'homun-followup-recovery']
    asyncio.run(run())
    assert len(context.repository.load().messages) == 2


def test_tampered_recovery_context_never_reaches_provider(context, monkeypatch):
    from homun.application.followup_recovery import recover_pending
    pending(context)
    with context.repository.transaction() as store:
        store.commands['message'].followup_body['payload']['text'] = 'changed'
    def unexpected(*args, **kwargs):
        pytest.fail('Invalid recovery context reached model')
    monkeypatch.setattr(context.models, 'interpret', unexpected)
    recover_pending(context)
    assert context.repository.load().commands['message'].followup_error == 'followup_context_invalid'


def test_active_conversation_claim_blocks_second_message_atomically(context):
    from homun.domain.errors import CommandInProgressError
    delivery = pending(context)
    current = admit(context, delivery.actor, delivery.body)
    another = delivery.body.model_copy(update={'command_id': 'another'})
    with pytest.raises(CommandInProgressError):
        admit(context, delivery.actor, another)
    saved = context.repository.load()
    assert len(saved.messages) == 1
    assert 'another' not in saved.commands
    complete(context, current)
    complete(context, admit(context, delivery.actor, another))
    assert len(context.repository.load().messages) == 4


def test_crashed_final_attempt_becomes_terminal_without_provider(context):
    from homun.application.command_delivery import MAX_FOLLOWUP_ATTEMPTS
    from homun.application.followup_recovery import claim_next
    pending(context)
    with context.repository.transaction() as store:
        store.commands['message'].followup_attempts = MAX_FOLLOWUP_ATTEMPTS
    assert claim_next(context) is None
    record = context.repository.load().commands['message']
    assert record.followup_error == 'followup_attempts_exhausted'
    assert record.followup_status == 'failed'
    assert record.followup_token is None


def test_expired_and_backoff_followups_keep_conversation_ownership(context):
    from homun.application.command_delivery import fail
    from homun.application.followup_recovery import claim_next
    from homun.domain.errors import CommandInProgressError
    expired = pending(context)
    newer = expired.body.model_copy(update={'command_id': 'newer'})
    with pytest.raises(CommandInProgressError):
        admit(context, expired.actor, newer)
    recovered = claim_next(context)
    assert recovered is not None
    fail(context, recovered, 'provider_unavailable')
    with pytest.raises(CommandInProgressError):
        admit(context, expired.actor, newer)
    assert len(context.repository.load().messages) == 1


def test_expired_current_attempt_schedules_recovery_instead_of_terminal_conflict(context):
    from homun.application.followup_recovery import recover_pending
    from homun.domain.errors import DomainError
    expired = pending(context)
    with pytest.raises(DomainError) as raised:
        complete(context, expired)
    assert raised.value.code == 'followup_lease_expired'
    record = context.repository.load().commands['message']
    assert record.followup_next_attempt_at is not None
    assert record.followup_error == 'followup_lease_expired'
    assert len(context.repository.load().messages) == 1
    with context.repository.transaction() as store:
        store.commands['message'].followup_next_attempt_at = utc_now() - timedelta(seconds=1)
    assert recover_pending(context)['completed'] == 1
    assert len(context.repository.load().messages) == 2
