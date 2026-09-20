"""Failure boundaries of the transactional runtime outbox and process lifecycle."""
import os
from pathlib import Path
import subprocess
import sys

from homun.context import create_context
from homun.domain.effects import prepare_run
from homun.domain.models import CommandRecord, Run, RuntimeIntent
from homun.runtime import dbos_app, dispatcher


def test_prepare_run_has_no_runtime_side_effect(tmp_path, monkeypatch):
    from homun.domain.store import WorkspaceStore
    from homun.runtime.workflows import work_run
    monkeypatch.setattr(work_run, 'start_work_run_workflow', lambda *a, **kw: (_ for _ in ()).throw(AssertionError('precommit IO')))
    store = WorkspaceStore('ws_local')
    run = prepare_run(store, command_id='cmd', work_id='w', step_id='s',
                      contribution_request_id='req', effect_command_id='fx')
    assert store.outbox['cmd:start'].run_id == run.id
    assert not store.outbox['cmd:start'].delivered


def test_failed_delivery_remains_durable_and_retry_uses_same_key(tmp_path, monkeypatch):
    ctx = create_context(workspace_id='ws_local', db_path=tmp_path/'ws.sqlite', data_dir=tmp_path, for_tests=True)
    try:
        from homun.domain.models import Work
        ctx.service.store.works['w'] = Work(id='w', workspace_id='ws_local', title='Work',
            objective='Work', primary_conversation_id='conv', requester_id='person_fabio', owner_id='person_fabio')
        run = Run(id='run', workspace_id='ws_local', work_id='w', workflow_id='wf', command_id='fx')
        ctx.service.store.runs[run.id] = run
        ctx.service.store.outbox['cmd:contribution'] = RuntimeIntent(
            id='cmd:contribution', command_id='cmd', run_id=run.id, kind='contribution',
            sequence=1, payload={'note':'hello'})
        ctx.service.store.commands['cmd'] = CommandRecord(command_id='cmd', type='work.provide_contribution', actor_id='person_fabio', workspace_id='ws_local', result={'run_id':'run'})
        ctx.persist()
        monkeypatch.setattr(dbos_app, 'is_launched', lambda: True)
        monkeypatch.setattr(dispatcher, 'reconcile_runs', lambda *a, **kw: None)
        calls=[]
        def send(*args, **kwargs):
            calls.append(kwargs['idempotency_key'])
            if len(calls)==1: raise RuntimeError('delivery uncertainty')
        monkeypatch.setattr(dispatcher.work_run, 'send_contribution', send)
        result=dispatcher.deliver_pending(ctx,'cmd')
        assert result['runtime_error']=='runtime_delivery_failed'
        assert not ctx.repository.load().outbox['cmd:contribution'].delivered
        dispatcher.deliver_pending(ctx,'cmd')
        assert calls==['cmd:contribution']*2
        assert ctx.repository.load().outbox['cmd:contribution'].delivered
    finally:
        ctx.close()


def test_pending_workflow_shutdown_and_restart(tmp_path):
    # Each subprocess must really exit. A pytest assertion cannot detect a worker
    # that only blocks interpreter shutdown after the suite finishes.
    code = '''
import sys,time,faulthandler
from pathlib import Path
from homun.runtime import dbos_app
from homun.runtime.workflows import work_run
faulthandler.dump_traceback_later(12)
root=Path(sys.argv[1])
dbos_app.configure_dbos(root)
dbos_app.launch_dbos()
if sys.argv[2]=='start':
 work_run.start_work_run_workflow('wf_restart',work_id='w',step_id='s',command_id='fx')
 time.sleep(1)
else:
 work_run.send_contribution('wf_restart',{'step_id':'s'},idempotency_key='message1')
 from dbos import DBOS
 assert DBOS.retrieve_workflow('wf_restart').get_result()['effect']['status']=='applied'
 work_run.send_contribution('wf_restart',{'step_id':'s'},idempotency_key='message1')
 import sqlite3
 with sqlite3.connect(root/'dbos.sqlite') as conn:
  assert conn.execute("SELECT COUNT(*) FROM notifications WHERE destination_uuid='wf_restart'").fetchone()[0] == 1
dbos_app.shutdown_dbos()
'''
    env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1]/'src'))
    for phase in ('start','resume'):
        result=subprocess.run([sys.executable,'-c',code,str(tmp_path),phase],env=env,
                              capture_output=True,text=True,timeout=18)
        assert result.returncode==0, result.stdout+result.stderr


def test_rolled_back_intent_is_not_delivered(tmp_path, monkeypatch):
    import pytest
    ctx = create_context(workspace_id='ws_local', db_path=tmp_path/'ws.sqlite', data_dir=tmp_path, for_tests=True)
    try:
        with pytest.raises(RuntimeError):
            with ctx.repository.transaction() as store:
                prepare_run(store, command_id='cmd', work_id='w', step_id='s',
                            contribution_request_id='req', effect_command_id='fx')
                raise RuntimeError('commit rejected')
        monkeypatch.setattr(dbos_app, 'is_launched', lambda: False)
        monkeypatch.setattr(dispatcher.work_run, 'start_work_run_workflow',
                            lambda *a, **kw: (_ for _ in ()).throw(AssertionError('orphan start')))
        dispatcher.deliver_pending(ctx)
        assert not ctx.repository.load().outbox
        assert not ctx.repository.load().runs
    finally:
        ctx.close()


def test_configured_directory_cannot_drift(tmp_path, monkeypatch):
    import pytest
    monkeypatch.setattr(dbos_app, '_CONFIGURED', True)
    monkeypatch.setattr(dbos_app, '_DATA_DIR', tmp_path.resolve())
    with pytest.raises(RuntimeError, match='different data directory'):
        dbos_app.configure_dbos(tmp_path/'other')
    assert dbos_app.data_dir() == tmp_path.resolve()


def test_shutdown_cleans_configured_but_unlaunched_runtime(tmp_path, monkeypatch):
    calls=[]
    monkeypatch.setattr(dbos_app, '_CONFIGURED', True)
    monkeypatch.setattr(dbos_app, '_LAUNCHED', False)
    monkeypatch.setattr(dbos_app, '_DATA_DIR', tmp_path)
    monkeypatch.setattr(dbos_app.DBOS, 'destroy', lambda: calls.append('destroy'))
    dbos_app.shutdown_dbos()
    assert calls == ['destroy']
    assert not dbos_app.is_launched()
    assert dbos_app._DATA_DIR is None


def _seed_cancellable(ctx, status='ready'):
    from homun.domain.models import Work
    store = ctx.service.store
    store.works['w'] = Work(id='w', workspace_id='ws_local', title='work', objective='work',
                            primary_conversation_id='conv', requester_id='person_fabio',
                            owner_id='person_fabio', status=status)
    run = prepare_run(store, command_id='cmd', work_id='w', step_id='s',
                      contribution_request_id='req', effect_command_id='fx')
    from homun.domain.effects import stage_intent
    stage_intent(store, 'contrib', run, 'contribution', {'step_id':'s'})
    ctx.persist()
    return run


def _cancel(ctx):
    from homun.domain.models import Actor
    with ctx.repository.transaction() as store:
        ctx.service.for_store(store).apply(
            Actor(id='person_fabio', workspace_id='ws_local', display_name='Fabio', kind='person'),
            'cancel', 'work.cancel', {'work_id':'w', 'expected_version':store.works['w'].version})


def test_cancel_before_dispatch_suppresses_start_and_contribution(tmp_path, monkeypatch):
    ctx = create_context(workspace_id='ws_local', db_path=tmp_path/'ws.sqlite', data_dir=tmp_path, for_tests=True)
    try:
        run = _seed_cancellable(ctx)
        _cancel(ctx)
        monkeypatch.setattr(dbos_app, 'is_launched', lambda: True)
        monkeypatch.setattr(dispatcher.work_run, 'start_work_run_workflow', lambda *a, **kw: (_ for _ in ()).throw(AssertionError('cancelled start')))
        monkeypatch.setattr(dispatcher.work_run, 'send_contribution', lambda *a, **kw: (_ for _ in ()).throw(AssertionError('cancelled contribution')))
        dispatcher.deliver_pending(ctx)
        store = ctx.repository.load()
        assert all(i.cancelled and not i.delivered for i in store.outbox.values())
        assert store.runs[run.id].status == 'cancelled'
    finally:
        ctx.close()


def test_cancel_after_claim_reports_uncertain_effect(tmp_path, monkeypatch):
    ctx = create_context(workspace_id='ws_local', db_path=tmp_path/'ws.sqlite', data_dir=tmp_path, for_tests=True)
    try:
        run = _seed_cancellable(ctx)
        with ctx.repository.transaction() as store:
            store.outbox['cmd:start'].delivered=True
        monkeypatch.setattr(dbos_app, 'is_launched', lambda: True)
        monkeypatch.setattr(dispatcher, 'reconcile_runs', lambda *a, **kw: None)
        calls=[]
        def send(*args, **kwargs):
            _cancel(ctx)
            calls.append(kwargs['idempotency_key'])
        monkeypatch.setattr(dispatcher.work_run, 'send_contribution', send)
        dispatcher.deliver_pending(ctx)
        store = ctx.repository.load()
        assert calls == ['contrib:contribution']
        assert store.works['w'].status == 'cancelled'
        assert store.runs[run.id].status == 'cancellation_uncertain'
        assert store.commands['cancel'].result['runtime_error'] == 'runtime_cancellation_uncertain'
        assert store.outbox['contrib:contribution'].delivered
    finally:
        ctx.close()


def test_paused_work_does_not_claim_pending_delivery(tmp_path, monkeypatch):
    ctx = create_context(workspace_id='ws_local', db_path=tmp_path/'ws.sqlite', data_dir=tmp_path, for_tests=True)
    try:
        _seed_cancellable(ctx, status='paused')
        monkeypatch.setattr(dbos_app, 'is_launched', lambda: False)
        dispatcher.deliver_pending(ctx)
        assert all(i.attempts == 0 and i.claim_token is None for i in ctx.repository.load().outbox.values())
    finally:
        ctx.close()


def test_cancel_after_snapshot_before_claim_does_not_send(tmp_path, monkeypatch):
    from homun.runtime import outbox
    ctx = create_context(workspace_id='ws_local', db_path=tmp_path/'ws.sqlite', data_dir=tmp_path, for_tests=True)
    try:
        _seed_cancellable(ctx)
        original = outbox.claim
        cancelled=[]
        def racing_claim(*args):
            if not cancelled:
                _cancel(ctx)
                cancelled.append(True)
            return original(*args)
        monkeypatch.setattr(outbox, 'claim', racing_claim)
        monkeypatch.setattr(dbos_app, 'is_launched', lambda: True)
        calls=[]
        monkeypatch.setattr(dispatcher.work_run, 'start_work_run_workflow', lambda *a, **kw: calls.append('start'))
        monkeypatch.setattr(dispatcher.work_run, 'send_contribution', lambda *a, **kw: calls.append('send'))
        dispatcher.deliver_pending(ctx)
        assert calls == []
    finally:
        ctx.close()


def test_expired_claim_is_retried_and_old_ack_fenced(tmp_path):
    from datetime import timedelta
    from homun.runtime import outbox
    from homun.domain.models import utc_now
    ctx = create_context(workspace_id='ws_local', db_path=tmp_path/'ws.sqlite', data_dir=tmp_path, for_tests=True)
    try:
        _seed_cancellable(ctx)
        first,_=outbox.claim(ctx,'cmd:start')
        assert outbox.claim(ctx,'cmd:start') is None
        with ctx.repository.transaction() as store:
            store.outbox['cmd:start'].claim_expires_at=utc_now()-timedelta(seconds=1)
        second,_=outbox.claim(ctx,'cmd:start')
        assert first.claim_token != second.claim_token
        outbox.acknowledge(ctx,'cmd:start',first.claim_token,sent=True)
        assert not ctx.repository.load().outbox['cmd:start'].delivered
        outbox.acknowledge(ctx,'cmd:start',second.claim_token,sent=True)
        assert ctx.repository.load().outbox['cmd:start'].delivered
    finally:
        ctx.close()


def test_late_completion_after_cancel_keeps_replay_and_run_view_consistent(tmp_path, monkeypatch):
    from homun.runtime import bridge
    ctx = create_context(workspace_id='ws_local', db_path=tmp_path/'ws.sqlite', data_dir=tmp_path, for_tests=True)
    try:
        run = _seed_cancellable(ctx)
        with ctx.repository.transaction() as store:
            for intent in store.outbox.values():
                intent.delivered = True
            store.commands['contrib'] = CommandRecord(
                command_id='contrib', type='work.provide_contribution', actor_id='person_fabio',
                workspace_id='ws_local', result={'run_id':run.id, 'run_status':'running'})
        _cancel(ctx)
        def complete_observation(store, observed, **kwargs):
            observed.status = 'completed'
            observed.effect_status = 'applied'
        monkeypatch.setattr(dispatcher, 'refresh_run_status', complete_observation)
        monkeypatch.setattr(bridge.work_run_wf, 'get_workflow_status', lambda _: 'SUCCESS')
        dispatcher.reconcile_runs(ctx)
        store = ctx.repository.load()
        replay = store.commands['contrib'].result
        public = bridge.run_public_view(store, store.runs[run.id])
        assert replay['status'] == store.works['w'].status == 'cancelled'
        assert replay['run_status'] == public['status'] == 'cancelled'
        assert replay['effect_status'] == public['effect_status'] == 'applied'
        assert public['last_error'] == 'runtime_effect_completed_after_cancellation'
    finally:
        ctx.close()


def test_failed_run_does_not_block_unrelated_runtime_delivery(tmp_path, monkeypatch):
    ctx = create_context(workspace_id='ws_local', db_path=tmp_path/'ws.sqlite', data_dir=tmp_path, for_tests=True)
    try:
        first = _seed_cancellable(ctx)
        with ctx.repository.transaction() as store:
            store.works['w2'] = store.works['w'].model_copy(update={'id':'w2'})
            second = prepare_run(store, command_id='other', work_id='w2', step_id='s2',
                                 contribution_request_id='req2', effect_command_id='fx2')
        calls=[]
        def start(workflow_id, **kwargs):
            calls.append(workflow_id)
            if workflow_id == first.workflow_id:
                raise RuntimeError('first workflow unavailable')
        monkeypatch.setattr(dispatcher.work_run, 'start_work_run_workflow', start)
        monkeypatch.setattr(dispatcher.work_run, 'send_contribution', lambda *a, **kw: calls.append('unexpected contribution'))
        monkeypatch.setattr(dbos_app, 'is_launched', lambda: True)
        monkeypatch.setattr(dispatcher, 'reconcile_runs', lambda *a, **kw: None)
        dispatcher.deliver_pending(ctx)
        store = ctx.repository.load()
        assert calls == [first.workflow_id, second.workflow_id]
        assert not store.outbox['cmd:start'].delivered
        assert store.outbox['contrib:contribution'].attempts == 0
        assert store.outbox['other:start'].delivered
    finally:
        ctx.close()
