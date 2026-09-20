"""Deferred delivery must use current grants and the durable command actor."""
from datetime import timedelta
import pytest
from homun.context import create_context
from homun.domain.models import utc_now
from homun.runtime import outbox, dispatcher, dbos_app
from test_work_authorization import seeded


def pending_context(tmp_path):
    svc, owner, _, project, conv, work = seeded()
    ctx = create_context(db_path=tmp_path/'workspace.sqlite', data_dir=tmp_path, for_tests=True)
    ctx.service.store = svc.store
    result = ctx.service.apply(owner,'plan','plan.propose',{'work_id':work,'expected_version':1,
                  'steps':[{'title':'Step','assignee_id':owner.id}]})
    result = ctx.service.apply(owner,'accept','plan.accept',{'work_id':work,'expected_version':result['version']})
    ctx.service.apply(owner,'start','work.start',{'work_id':work,'expected_version':result['version'],'durable':True})
    ctx.persist()
    return ctx


@pytest.mark.parametrize('denial', ['revoked', 'expired', 'missing_origin'])
def test_recovered_pending_delivery_denied_before_io(tmp_path, monkeypatch, denial):
    ctx = pending_context(tmp_path)
    try:
        with ctx.repository.transaction() as store:
            if denial == 'missing_origin':
                del store.commands['start']
            else:
                grant = next(iter(store.grants.values()))
                if denial == 'revoked': grant.status = 'revoked'
                else: grant.expires_at = utc_now()-timedelta(seconds=1)
        ctx.close()
        ctx = create_context(db_path=tmp_path/'workspace.sqlite', data_dir=tmp_path, for_tests=True)
        calls = []
        monkeypatch.setattr(dbos_app,'is_launched',lambda:True)
        monkeypatch.setattr(dispatcher,'reconcile_runs',lambda *a,**kw:None)
        monkeypatch.setattr(dispatcher.work_run,'start_work_run_workflow',lambda *a,**kw:calls.append(a))
        dispatcher.deliver_pending(ctx)
        assert calls == []
        saved = ctx.repository.load()
        assert saved.outbox['start:start'].error_code == 'permission_denied'
        assert not saved.outbox['start:start'].delivered
    finally:
        ctx.close()


@pytest.mark.parametrize('change', ['revoked', 'expired_lease'])
def test_final_dispatch_check_rejects_changed_authority(tmp_path, change):
    ctx = pending_context(tmp_path)
    try:
        intent, _ = outbox.claim(ctx,'start:start')
        with ctx.repository.transaction() as store:
            if change == 'revoked': next(iter(store.grants.values())).status = 'revoked'
            else: store.outbox[intent.id].claim_expires_at = utc_now()-timedelta(seconds=1)
        assert not outbox.still_authorized(ctx,intent.id,intent.claim_token)
    finally:
        ctx.close()


def test_regrant_allows_pending_intent_to_be_claimed(tmp_path):
    ctx = pending_context(tmp_path)
    try:
        with ctx.repository.transaction() as store:
            next(iter(store.grants.values())).status = 'revoked'
        assert outbox.claim(ctx,'start:start') is None
        with ctx.repository.transaction() as store:
            next(iter(store.grants.values())).status = 'active'
        intent, _ = outbox.claim(ctx,'start:start')
        assert outbox.still_authorized(ctx,intent.id,intent.claim_token)
    finally:
        ctx.close()


def test_revocation_between_claim_and_send_blocks_io_and_records_reason(tmp_path, monkeypatch):
    ctx = pending_context(tmp_path)
    try:
        original_claim = outbox.claim
        def claim_then_revoke(context, intent_id):
            claimed = original_claim(context, intent_id)
            with context.repository.transaction() as store:
                next(iter(store.grants.values())).status = 'revoked'
            return claimed
        monkeypatch.setattr(outbox, 'claim', claim_then_revoke)
        monkeypatch.setattr(dbos_app, 'is_launched', lambda:True)
        monkeypatch.setattr(dispatcher, 'reconcile_runs', lambda *a,**kw:None)
        def forbidden(*args, **kwargs):
            pytest.fail('Revoked work reached runtime IO')
        monkeypatch.setattr(dispatcher.work_run,'start_work_run_workflow',forbidden)
        dispatcher.deliver_pending(ctx)
        saved = ctx.repository.load()
        assert saved.outbox['start:start'].error_code == 'permission_denied'
        assert not saved.outbox['start:start'].delivered
    finally:
        ctx.close()
