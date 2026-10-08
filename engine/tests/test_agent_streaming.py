"""Pinned native streaming uses canonical cancellation and safe progress."""
from types import SimpleNamespace
from test_agent_runs import setup
from homun.application.agent_runs import propose, approve
from homun.application.agent_run_execution import advance
from homun.application.agent_control import control
from homun.models.native_turn import NativeMessage
from homun.models.native_errors import NativeModelError


def start(setup, **options):
    ctx,actor,work,material=setup
    ctx.models.set_active('openai_compatible')
    run=propose(ctx,actor,work,{'command_id':'stream','expected_version':1,
        'material_ids':[material],'native_stream':True,**options})
    approve(ctx,actor,work,run['id'],{'command_id':'approve','digest':run['digest'],'expected_version':run['expected_version']})
    return ctx,actor,work,run


def test_streaming_progress_contains_no_unvalidated_provider_text(setup):
    ctx,actor,work,run=start(setup)
    def model(*a,**kw):
        assert kw.get('stream') is True
        assert not kw['cancel_check']()
        kw['on_delta']({'type':'native_stream_progress','chunks':1,'text_chars':8,'tool_calls':0,'text':'do not persist'})
        current=ctx.repository.load().commands[run['id']].result
        assert current['stream_progress']=={'chunks':1,'text_chars':8,'tool_calls':0}
        assert not ctx.repository.load().artifacts
        return SimpleNamespace(message=NativeMessage(role='assistant',content='Verified result'),usage=None)
    ctx.models.complete_tools=model
    assert advance(ctx,run['id'])=='completed'
    current=ctx.repository.load().commands[run['id']].result
    assert 'stream_progress' not in current
    assert current['native_stream'] is True


def test_pause_cancels_model_stream_without_overwriting_human_state(setup):
    ctx,actor,work,run=start(setup)
    def model(*a,**kw):
        assert kw.get('stream') is True
        control(ctx,actor,work,run['id'],{'command_id':'pause','action':'pause',
            'expected_version':ctx.repository.load().works[work].version})
        assert kw['cancel_check']()
        raise NativeModelError('agent_model_network',retryable=False)
    ctx.models.complete_tools=model
    assert advance(ctx,run['id'])=='paused'
    assert not ctx.repository.load().artifacts
    assert not ctx.repository.load().commands[run['id']].result.get('stream_progress')


def test_human_correction_cancels_stream_then_uses_corrected_context(setup):
    ctx,actor,work,run=start(setup)
    calls=[]
    def model(messages,**kw):
        calls.append(1)
        if len(calls)==1:
            control(ctx,actor,work,run['id'],{'command_id':'steer','action':'steer','text':'Use the new requirement',
                'expected_version':ctx.repository.load().works[work].version})
            assert kw['cancel_check']()
            raise NativeModelError('agent_model_network',retryable=False)
        assert any('Use the new requirement' in m.content for m in messages)
        assert not kw['cancel_check']()
        return SimpleNamespace(message=NativeMessage(role='assistant',content='Corrected answer'),usage=None)
    ctx.models.complete_tools=model
    assert advance(ctx,run['id'])=='running'
    assert not ctx.repository.load().artifacts
    assert advance(ctx,run['id'])=='completed'
    assert len(calls)==2


def test_nonretryable_stream_failure_never_silently_calls_fallback(setup,monkeypatch):
    ctx=setup[0]
    from homun.models.port import Connection
    original=ctx.models.get_connection
    backup=Connection(id='backup',kind='openai_compatible',display_name='Backup',model_id='fixture',base_url='http://127.0.0.1:8000/v1',credential_present=True,active=True)
    monkeypatch.setattr(ctx.models,'get_connection',lambda cid: backup if cid=='backup' else original(cid))
    ctx,actor,work,run=start(setup,fallback_connection_id='backup')
    calls=[]
    def model(*a,**kw):
        calls.append(kw['connection_id'])
        if len(calls)==1:
            raise NativeModelError('agent_model_timeout','Stream stopped after partial output',retryable=False)
        return SimpleNamespace(message=NativeMessage(role='assistant',content='Unintended fallback'),usage=None)
    ctx.models.complete_tools=model
    assert advance(ctx,run['id'])=='failed'
    assert calls==['openai_compatible']
    assert not ctx.repository.load().artifacts


def test_live_stream_renews_owned_lease_before_another_claim(setup):
    from datetime import datetime,timedelta
    from homun.domain.models import utc_now
    ctx,actor,work,run=start(setup)
    def model(*a,**kw):
        # A previous stage has nearly exhausted this composite turn's lease.
        with ctx.repository.transaction() as store:
            store.commands[run['id']].result['_lease_until']=(utc_now()+timedelta(seconds=1)).isoformat()
        assert not kw['cancel_check']()
        current=ctx.repository.load().commands[run['id']].result
        assert datetime.fromisoformat(current['_lease_until']) > utc_now()+timedelta(seconds=120)
        return SimpleNamespace(message=NativeMessage(role='assistant',content='Verified result'),usage=None)
    ctx.models.complete_tools=model
    assert advance(ctx,run['id'])=='completed'
