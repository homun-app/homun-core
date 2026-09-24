from datetime import timedelta
import pytest
from test_terminal_jobs import setup,propose,approve
from homun.domain.models import utc_now


def test_expired_command_is_stopped_without_restart(setup):
    from homun.application.terminal_watchdog import reconcile
    p=propose(setup);approve(setup,p)
    assert setup[0].repository.load().commands[p['id']].result['deadline_at']
    reconcile(setup[0],now=utc_now()+timedelta(seconds=301))
    r=setup[0].repository.load().commands[p['id']].result
    assert r['status']=='exited' and r['timed_out'] and r['exit_code']==137
    reconcile(setup[0],now=utc_now()+timedelta(seconds=302))
    assert [c[0] for c in setup[-1].calls].count('start')==1
    assert [c[0] for c in setup[-1].calls].count('stop')==1


def test_pending_or_unexpired_command_is_not_stopped(setup):
    from homun.application.terminal_watchdog import reconcile
    p=propose(setup);reconcile(setup[0],now=utc_now()+timedelta(days=1))
    assert not setup[-1].calls
    approve(setup,p);reconcile(setup[0],now=utc_now())
    assert [c[0] for c in setup[-1].calls]==['start']


def test_already_finished_process_is_not_misreported_as_timeout(setup):
    from homun.application.terminal_watchdog import reconcile
    p=propose(setup);approve(setup,p)
    setup[-1].state.update(status='exited',running=False,exit_code=0)
    reconcile(setup[0],now=utc_now()+timedelta(seconds=301))
    r=setup[0].repository.load().commands[p['id']].result
    assert r['exit_code']==0 and not r.get('timed_out')
    assert not any(c[0]=='stop' for c in setup[-1].calls)


def test_duration_is_bound_and_deadline_never_extended(setup):
    from homun.application import terminal_jobs
    from homun.domain.errors import ConflictError
    p=propose(setup);assert p['timeout_seconds']==300
    with pytest.raises(ConflictError):terminal_jobs.propose(*setup[:3],{**setup[3],'timeout_seconds':301})
    approve(setup,p);first=setup[0].repository.load().commands[p['id']].result['deadline_at']
    approve(setup,p)
    assert setup[0].repository.load().commands[p['id']].result['deadline_at']==first


def test_legacy_proposal_keeps_digest_and_has_no_retroactive_timer(setup):
    from homun.application.terminal_contracts import consent
    p=propose(setup)
    with setup[0].repository.transaction() as store:
        r=store.commands[p['id']].result;r.pop('timeout_seconds');r['digest']=consent(r);old=r.copy()
    assert propose(setup)['digest']==old['digest']
    approve(setup,old)
    assert 'deadline_at' not in setup[0].repository.load().commands[p['id']].result


def test_restart_and_revoked_viewer_do_not_disable_resource_cleanup(setup,monkeypatch):
    from homun.application import terminal_jobs
    from homun.application.terminal_watchdog import reconcile
    from homun.context import create_context
    from homun.domain.errors import PermissionDeniedError
    p=propose(setup);approve(setup,p)
    def deny(*a,**k):raise PermissionDeniedError('revoked')
    monkeypatch.setattr(terminal_jobs,'require_work_access',deny)
    ctx=setup[0];second=create_context(db_path=ctx.data_dir/'ws.db',data_dir=ctx.data_dir,for_tests=True)
    try:
        reconcile(second,now=utc_now()+timedelta(seconds=301))
        assert second.repository.load().commands[p['id']].result['timed_out']
        assert setup[-1].state['status']=='exited'
    finally:second.close()


def test_failed_stop_is_uncertain_then_reconciles(setup,monkeypatch):
    from homun.application.terminal_watchdog import reconcile
    from homun.execution.contracts import ExecutionTimeout
    p=propose(setup);approve(setup,p);backend=setup[-1];original=backend.stop
    def failed(spec):raise ExecutionTimeout('secret')
    monkeypatch.setattr(backend,'stop',failed)
    reconcile(setup[0],now=utc_now()+timedelta(seconds=301))
    r=setup[0].repository.load().commands[p['id']].result
    assert r['status']=='outcome_unknown' and r['timed_out'] and 'secret' not in str(r)
    monkeypatch.setattr(backend,'stop',original)
    reconcile(setup[0],now=utc_now()+timedelta(seconds=302))
    assert setup[0].repository.load().commands[p['id']].result['status']=='exited'


def test_old_terminal_manifest_keeps_original_schema():
    from homun.application.agent_terminal_contracts import entry
    old=entry({'image':'sha256:'+'a'*64})
    new=entry({'image':'sha256:'+'a'*64,'version':2})
    assert old.version=='1' and 'timeout_seconds' not in old.definition.input_schema['properties']
    assert new.version=='2' and 'timeout_seconds' in new.definition.input_schema['properties']


def test_failed_jobs_do_not_starve_later_deadlines(setup,monkeypatch):
    from homun.application import terminal_jobs
    from homun.application.terminal_watchdog import reconcile
    from homun.execution.contracts import ExecutionUnavailable
    for i in range(5):
        p=terminal_jobs.propose(*setup[:3],{**setup[3],'command_id':f'job{i}'})
        approve(setup,p)
    seen=[]
    def unavailable(spec):seen.append(spec.call_id);raise ExecutionUnavailable('offline')
    monkeypatch.setattr(setup[-1],'inspect',unavailable)
    reconcile(setup[0],now=utc_now()+timedelta(seconds=301))
    assert len(seen)==4
    reconcile(setup[0],now=utc_now()+timedelta(seconds=302))
    assert set(seen)=={f'job{i}' for i in range(5)}


def test_newer_finished_observation_fences_stale_watchdog_stop(setup,monkeypatch):
    from homun.application import terminal_jobs
    from homun.application.terminal_watchdog import reconcile
    p=propose(setup);approve(setup,p);backend=setup[-1];original=backend.inspect;first=True
    def raced(spec):
        nonlocal first
        stale=original(spec)
        if first:
            first=False;backend.state.update(status='exited',running=False,exit_code=0)
            terminal_jobs.refresh(*setup[:3],p['id'])
        return stale
    monkeypatch.setattr(backend,'inspect',raced)
    reconcile(setup[0],now=utc_now()+timedelta(seconds=301))
    result=setup[0].repository.load().commands[p['id']].result
    assert result['exit_code']==0 and not result.get('timed_out')
    assert not any(c[0]=='stop' for c in backend.calls)
