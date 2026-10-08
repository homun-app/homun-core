"""Application approval is an exact, durable fence before native execution."""
import pytest
from homun.context import create_context
from homun.domain.models import Actor
from homun.domain.errors import ConflictError, PermissionDeniedError, ValidationError


class Backend:
    def __init__(self):self.calls=[];self.state=None
    def start(self,spec,stdin=False,pty=False):
        self.calls.append(('start',spec))
        self.state={'container_id':'a'*64,'status':'running','running':True,'exit_code':None,'oom_killed':False}
        return self.state.copy()
    def inspect(self,spec):
        from homun.execution.contracts import ExecutionUncertain
        self.calls.append(('inspect',spec))
        if self.state is None:raise ExecutionUncertain('missing')
        return self.state.copy()
    def logs(self,spec):return {'text':'done','truncated':False,'tail_only':True,'line_limit':1000}
    def stop(self,spec):
        self.calls.append(('stop',spec));self.state.update(status='exited',running=False,exit_code=137)
        return self.state.copy()


@pytest.fixture
def setup(tmp_path,monkeypatch):
    from homun.application import terminal_jobs
    ctx=create_context(db_path=tmp_path/'ws.db',data_dir=tmp_path,for_tests=True)
    actor=Actor(id='person_a',workspace_id=ctx.workspace_id,display_name='A')
    c=ctx.service.apply(actor,'c','conversation.create',{'title':'T'})
    w=ctx.service.apply(actor,'w','work.create',{'conversation_id':c['conversation_id'],'title':'T','objective':'O'})
    ctx.persist()
    backend=Backend();monkeypatch.setattr(terminal_jobs,'backend_for',lambda ctx, proposal=None: backend)
    body={'command_id':'job','image':'sha256:'+'a'*64,'command':'echo done','expected_version':1}
    yield ctx,actor,w['work_id'],body,backend
    ctx.close()


def propose(s):
    from homun.application import terminal_jobs
    return terminal_jobs.propose(*s[:3],s[3])


def approve(s,p):
    from homun.application import terminal_jobs
    return terminal_jobs.approve(*s[:3],p['id'],{'digest':p['digest']})


def test_proposal_is_inert_and_repeated_approval_never_restarts(setup):
    p=propose(setup);assert p['status']=='pending_approval' and not setup[-1].calls
    assert approve(setup,p)['status']=='running'
    approve(setup,p)
    assert sum(c[0]=='start' for c in setup[-1].calls)==1


def test_digest_and_work_version_are_checked_before_start(setup):
    from homun.application import terminal_jobs
    p=propose(setup)
    with pytest.raises(ValidationError):terminal_jobs.approve(*setup[:3],p['id'],{'digest':'wrong'})
    with setup[0].repository.transaction() as store:store.works[setup[2]].version+=1
    with pytest.raises(ConflictError):approve(setup,p)
    assert not setup[-1].calls


def test_only_owner_or_reviewer_person_can_approve(setup):
    from homun.application import terminal_jobs
    p=propose(setup)
    other=setup[1].model_copy(update={'id':'other'})
    with pytest.raises(PermissionDeniedError):terminal_jobs.approve(setup[0],other,setup[2],p['id'],{'digest':p['digest']})
    bot=setup[1].model_copy(update={'kind':'agent'})
    with pytest.raises(PermissionDeniedError):terminal_jobs.approve(setup[0],bot,setup[2],p['id'],{'digest':p['digest']})
    assert not setup[-1].calls


def test_crash_after_start_recovers_by_inspection(setup,monkeypatch):
    from homun.application import terminal_jobs
    p=propose(setup);backend=setup[-1];original=backend.start
    def crash(spec):original(spec);raise SystemExit('crash')
    monkeypatch.setattr(backend,'start',crash)
    with pytest.raises(SystemExit):approve(setup,p)
    assert setup[0].repository.load().commands[p['id']].result['status']=='dispatching'
    assert approve(setup,p)['status']=='dispatching'
    result=terminal_jobs.refresh(*setup[:3],p['id'])
    assert result['status']=='running'
    assert sum(c[0]=='start' for c in backend.calls)==1


def test_command_id_is_bound_to_exact_request(setup):
    from homun.application import terminal_jobs
    propose(setup)
    with pytest.raises(ConflictError):terminal_jobs.propose(*setup[:3],{**setup[3],'command':'other'})
    with pytest.raises(ConflictError):terminal_jobs.propose(*setup[:3],{**setup[3],'command_id':'w'})


def test_refresh_records_nonzero_and_stop_is_owned(setup):
    from homun.application import terminal_jobs
    p=propose(setup);approve(setup,p)
    assert terminal_jobs.stop(*setup[:3],p['id'])['status']=='exited'
    result=terminal_jobs.refresh(*setup[:3],p['id'])
    assert result['exit_code']==137 and result['logs']['text']=='done'


def test_unknown_status_is_not_a_success_or_permission_to_retry(setup,monkeypatch):
    from homun.application import terminal_jobs
    from homun.execution.contracts import ExecutionTimeout
    p=propose(setup);backend=setup[-1]
    def failure(spec):backend.calls.append(('start',spec));raise ExecutionTimeout('secret path')
    monkeypatch.setattr(backend,'start',failure)
    result=approve(setup,p)
    assert result['status']=='outcome_unknown' and 'secret path' not in str(result)
    approve(setup,p)
    assert terminal_jobs.refresh(*setup[:3],p['id'])['status']=='outcome_unknown'
    assert sum(c[0]=='start' for c in backend.calls)==1


def test_logs_failure_keeps_process_state_but_reports_missing_logs(setup,monkeypatch):
    from homun.application import terminal_jobs
    from homun.execution.contracts import ExecutionUnavailable
    p=propose(setup);approve(setup,p)
    def fail(spec):raise ExecutionUnavailable('secret')
    monkeypatch.setattr(setup[-1],'logs',fail)
    result=terminal_jobs.refresh(*setup[:3],p['id'])
    assert result['status']=='running' and result['error_code']=='execution_logs_unavailable'
    assert 'logs' not in result and 'secret' not in str(result)


def test_revocation_during_io_keeps_receipt_without_returning_it(setup,monkeypatch):
    from homun.application import terminal_jobs
    p=propose(setup);original=setup[-1].start
    def revoke(spec):
        result=original(spec)
        def deny(*a,**k):raise PermissionDeniedError('Revoked')
        monkeypatch.setattr(terminal_jobs,'require_work_access',deny)
        return result
    monkeypatch.setattr(setup[-1],'start',revoke)
    with pytest.raises(PermissionDeniedError):approve(setup,p)
    assert setup[0].repository.load().commands[p['id']].result['status']=='running'


def test_authenticated_routes_validate_shape_and_approval(setup,monkeypatch):
    from fastapi.testclient import TestClient
    from homun.app import create_app
    from homun.routes import price_comparisons
    monkeypatch.setattr(price_comparisons,'get_context',lambda:setup[0])
    client=TestClient(create_app(session_token='a'*32,session_actor_id=setup[1].id))
    url=f'/v1/workspaces/{setup[0].workspace_id}/works/{setup[2]}/terminal-jobs'
    assert client.get(url).status_code==401
    headers={'Authorization':'Bearer '+'a'*32}
    assert client.post(url,headers=headers,json={**setup[3],'image':'debian:latest'}).status_code==422
    proposed=client.post(url,headers=headers,json=setup[3]);assert proposed.status_code==200,proposed.text
    p=proposed.json()
    assert client.post(url+'/job/approve',headers=headers,json={'digest':'b'*64}).status_code==400
    response=client.post(url+'/job/approve',headers=headers,json={'digest':p['digest']})
    assert response.status_code==200,response.text
    assert response.json()['status']=='running' and '_approved_by' not in response.json()
    assert client.post(url+'/job/refresh',headers=headers).json()['logs']['text']=='done'
    assert client.post(url+'/job/stop',headers=headers).json()['status']=='exited'
