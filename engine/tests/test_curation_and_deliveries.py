"""Skill curator (inactivity maintenance) and cron delivery drain."""
from __future__ import annotations

from datetime import timedelta

import pytest

from homun.context import create_context
from homun.domain.models import Actor, utc_now


@pytest.fixture
def ctx(tmp_path):
    ctx = create_context(db_path=tmp_path / 'engine.db', data_dir=tmp_path, for_tests=True)
    yield ctx
    ctx.close()


def _apply(ctx, actor, command_id, kind, payload):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            result = ctx.service.for_store(store).apply(actor, command_id, kind, payload)
        ctx.service.store = store
    return result


def _skill(ctx, actor, name, *, author="agent", status="staged", age_days=0.0, use=False):
    created = _apply(ctx, actor, f'sk-{name}', 'skill.create', {
        'name': name, 'description': 'd', 'body': 'b',
        'author_type': author, 'author_id': 'agent_x',
        **({'status': 'approved'} if status == 'approved' and author == 'person' else {})})
    if status == 'approved' and author == 'agent':
        _apply(ctx, actor, f'sk-{name}-ap', 'skill.approve',
               {'skill_id': created['skill_id'], 'expected_version': 1})
    store = ctx.repository.load()
    skill = store.skills[created['skill_id']]
    backdated = utc_now() - timedelta(days=age_days)
    if age_days:
        with ctx.repository.locked():
            with ctx.repository.transaction() as s2:
                target = s2.skills[skill.id]
                target.created_at = backdated
                target.updated_at = backdated
            ctx.service.store = s2
    if use:
        from homun.application.skill_tools import _record_usage
        _record_usage(ctx, skill)
    return skill.id


def test_curator_archives_stale_staged_and_unused(ctx):
    from homun.application.skill_curator import curate
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')
    stale_staged = _skill(ctx, actor, 'vecchia-staged', status='staged', age_days=10)
    fresh_staged = _skill(ctx, actor, 'nuova-staged', status='staged', age_days=1)
    unused_approved = _skill(ctx, actor, 'mai-usata', status='approved', age_days=45)
    used_approved = _skill(ctx, actor, 'usata', status='approved', age_days=45, use=True)
    recent_approved = _skill(ctx, actor, 'recente', status='approved', age_days=5)
    person_skill = _skill(ctx, actor, 'della-persona', author='person', status='approved', age_days=400)

    report = curate(ctx, now=1_800_000_000.0)
    store = ctx.repository.load()
    assert store.skills[stale_staged].status == 'archived'
    assert store.skills[unused_approved].status == 'archived'
    assert store.skills[fresh_staged].status == 'staged'
    assert store.skills[used_approved].status == 'approved'      # usage protects
    assert store.skills[recent_approved].status == 'approved'    # age protects
    assert store.skills[person_skill].status == 'approved'       # person skills untouchable
    assert report['archived'] == 2


def test_curator_interval_gate_and_state(ctx):
    from homun.application.skill_curator import maybe_curate
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')
    _skill(ctx, actor, 'una', status='staged', age_days=10)
    first = maybe_curate(ctx, now=1_700_000_000.0, force=False)
    assert first is not None and first['archived'] == 1
    # Interval-gated: a second pass within the cadence is a no-op.
    _skill(ctx, actor, 'due', status='staged', age_days=10)
    assert maybe_curate(ctx, now=1_700_000_100.0, force=False) is None
    forced = maybe_curate(ctx, now=1_700_000_100.0, force=True)
    assert forced is not None and forced['archived'] == 1


def test_cron_delivery_chat_target_lands_in_conversation(ctx, tmp_path):
    from homun.application.cron_manager import CronManager
    from homun.application.cron_manager import reset_store
    from homun.application.cron_store import CronStore, set_cron_store
    from homun.application.cron_deliveries import deliver_pending
    actor = Actor(id='person_cron', workspace_id=ctx.workspace_id, display_name='Owner')
    project = _apply(ctx, actor, 'p', 'project.create', {'name': 'Cron'})['project_id']
    conversation = _apply(ctx, actor, 'c', 'conversation.create',
                          {'title': 'cron', 'project_id': project})['conversation_id']
    work = _apply(ctx, actor, 'w', 'work.create', {
        'conversation_id': conversation, 'title': 'deliver', 'objective': 'segna'})['work_id']

    store = CronStore(tmp_path / 'cron.db')
    set_cron_store(store)
    try:
        mgr = CronManager(workspace_id=ctx.workspace_id, store=store)
        job = mgr.create_job('5m', prompt='tick', repeat=1, deliver='chat',
                             owner_actor=actor.model_dump(mode='json'),
                             source_work_id=work)
        # Settle a successful occurrence with output → enqueue delivery.
        from homun.application.cron_contracts import CronExecutionResult
        claim = mgr.claim_job_for_fire(job.id, now=10)
        occurrence = mgr.run_job(job.id, now=10, claim=claim,
                                 custom_runner=lambda payload: CronExecutionResult('success', output='CRON-DELIK-OK'))
        assert occurrence.status == 'success'
        pending = store.pending_deliveries(ctx.workspace_id)
        assert len(pending) == 1 and pending[0][1]['target'] == 'chat'

        outcome = deliver_pending(ctx, store=store)
        assert outcome['processed'] == 1 and outcome['sent'] and not outcome['failed']
        rows = store.list_deliveries(ctx.workspace_id)
        assert rows[0]['status'] == 'sent'
        messages = ctx.repository.load().messages
        delivered = [m for m in messages.values()
                     if m.conversation_id == conversation and 'CRON-DELIK-OK' in (m.text or '')]
        assert delivered, 'the cron output must land in the source conversation'
    finally:
        reset_store()


def test_cron_delivery_unconfigured_channel_defers_then_fails(ctx, tmp_path):
    from homun.application.cron_manager import CronManager
    from homun.application.cron_manager import reset_store
    from homun.application.cron_store import CronStore, set_cron_store
    from homun.application.cron_contracts import CronExecutionResult
    from homun.application.cron_deliveries import deliver_pending
    actor = Actor(id='person_cron', workspace_id=ctx.workspace_id, display_name='Owner')
    store = CronStore(tmp_path / 'cron.db')
    set_cron_store(store)
    try:
        mgr = CronManager(workspace_id=ctx.workspace_id, store=store)
        job = mgr.create_job('5m', prompt='tick', repeat=1, deliver='telegram:999888',
                             owner_actor=actor.model_dump(mode='json'))
        claim = mgr.claim_job_for_fire(job.id, now=10)
        mgr.run_job(job.id, now=10, claim=claim,
                    custom_runner=lambda payload: CronExecutionResult('success', output='verso telegram'))
        for _ in range(3):
            outcome = deliver_pending(ctx, store=store)
            assert outcome['processed'] == 1
        rows = store.list_deliveries(ctx.workspace_id)
        # Unconfigured channel defers up to MAX_ATTEMPTS, then fails with a typed code.
        assert rows[0]['status'] == 'failed'
        assert rows[0]['error_code'] in ('channel_unconfigured', 'delivery_transport_failed')
        # Unsupported platform fails immediately and typed.
        mgr2 = CronManager(workspace_id=ctx.workspace_id, store=store)
        job2 = mgr2.create_job('5m', prompt='tick', repeat=1, deliver='nessunapi:1',
                               owner_actor=actor.model_dump(mode='json'))
        claim2 = mgr2.claim_job_for_fire(job2.id, now=20)
        mgr2.run_job(job2.id, now=20, claim=claim2,
                     custom_runner=lambda payload: CronExecutionResult('success', output='x'))
        deliver_pending(ctx, store=store)
        rows = store.list_deliveries(ctx.workspace_id)
        assert any(r.get('error_code') == 'channel_unsupported' for r in rows)
    finally:
        reset_store()
