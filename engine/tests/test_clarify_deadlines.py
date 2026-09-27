"""Optional clarify deadlines resolve missing input, never human consent."""
import json
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from test_agent_runs import setup
from homun.application import agent_runs
from homun.application.agent_run_execution import advance
from homun.context import create_context
from homun.domain.models import utc_now
from homun.models.native_turn import NativeMessage, ToolCall


def start(setup, timeout=60):
    ctx, actor, work, _ = setup
    ctx.models.set_active('openai_compatible')
    proposal = agent_runs.propose(ctx, actor, work, {'command_id':'run', 'expected_version':1, 'clarify':True})
    agent_runs.approve(ctx, actor, work, 'run', {'command_id':'approve', 'digest':proposal['digest'], 'expected_version':proposal['expected_version']})
    args = {'questions':[{'id':'format', 'question':'Format?', 'choices':['PDF','CSV']},
                         {'id':'fields', 'question':'Fields?', 'multi_select':True, 'choices':['Name','Price']}]}
    if timeout is not None:
        args['timeout_seconds'] = timeout
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(message=NativeMessage(role='assistant',
        tool_calls=[ToolCall(id='clarify-call', name='clarify', arguments=args)]), usage=None)
    assert advance(ctx, 'run') == 'waiting_input'
    return ctx, actor, work


def contribute(ctx, actor, work, text, *, draft=False):
    with ctx.repository.locked(), ctx.repository.transaction() as store:
        request = store.commands['run'].result['request_id']
        result = ctx.service.for_store(store).apply(actor, 'draft' if draft else 'answer',
            'work.save_contribution_draft' if draft else 'work.provide_contribution',
            {'request_id':request, 'text':json.dumps(text), 'expected_version':store.works[work].version})
    return result


def test_deadline_reopens_expires_and_resumes_same_call_once(setup, monkeypatch):
    ctx, actor, work = start(setup)
    run = ctx.repository.load().commands['run'].result
    deadline = datetime.fromisoformat(run['clarify_deadline_at'])
    assert 55 <= (deadline - utc_now()).total_seconds() <= 60
    second = create_context(db_path=ctx.data_dir/'ws.db', data_dir=ctx.data_dir, for_tests=True)
    try:
        from homun.application import clarification_deadlines
        from homun.runtime.workflows import agent_run
        monkeypatch.setattr(clarification_deadlines, 'utc_now', lambda: deadline + timedelta(seconds=1))
        monkeypatch.setattr(agent_run, 'start', lambda *a: None)
        agent_run.deliver_agent_runs(second)
        agent_run.deliver_agent_runs(second)
        saved = second.repository.load()
        run = saved.commands['run'].result
        assert run['status'] == 'queued'
        replies = [m for m in run['_messages'] if m['role'] == 'tool']
        assert len(replies) == 1 and replies[0]['tool_call_id'] == 'clarify-call'
        result = json.loads(replies[0]['content'])
        assert result['timed_out'] is True
        assert result['resolution'] == 'expired'
        assert 'not approval' in result['notice']
        assert [r['id'] for r in result['responses']] == ['format','fields']
        assert [r['user_response'] for r in result['responses']] == ['', '']
        request = saved.contributions[run['request_id']]
        assert request.resolution == 'expired'
        events = [e for e in saved.events if e.type == 'contribution.expired']
        assert len(events) == 1 and events[0].actor_id == 'homun_engine'
    finally:
        second.close()


@pytest.mark.parametrize('timeout', [None, 60])
def test_no_deadline_or_not_due_stays_pending(setup, timeout):
    from homun.application.clarification_deadlines import expire_waiting
    ctx, actor, work = start(setup, timeout)
    assert not expire_waiting(ctx, 'run', now=utc_now())
    if timeout is None:
        assert not expire_waiting(ctx, 'run', now=utc_now()+timedelta(days=999))
    run = ctx.repository.load().commands['run'].result
    assert run['status'] == 'waiting_input'
    assert ctx.repository.load().contributions[run['request_id']].status == 'pending'


def test_saved_partial_draft_survives_expiry(setup):
    from homun.application.clarification_deadlines import expire_waiting
    ctx, actor, work = start(setup)
    contribute(ctx, actor, work, {'answers':{'fields':['Price']}, 'partial':True}, draft=True)
    second = create_context(db_path=ctx.data_dir/'ws.db', data_dir=ctx.data_dir, for_tests=True)
    try:
        assert expire_waiting(second, 'run', now=utc_now()+timedelta(days=1))
        assert agent_runs.resume_waiting(second, 'run')
        run = second.repository.load().commands['run'].result
        result = json.loads(run['_messages'][-1]['content'])
        assert [r['user_response'] for r in result['responses']] == ['', ['Price']]
        assert result['timed_out'] is True
    finally:
        second.close()


@pytest.mark.parametrize('first', ['answer', 'expiry'])
def test_first_resolution_wins(setup, first):
    from homun.application.clarification_deadlines import expire_waiting
    from homun.domain.errors import ValidationError
    ctx, actor, work = start(setup)
    answer = {'answers':{'format':'CSV', 'fields':['Name']}}
    if first == 'answer':
        contribute(ctx, actor, work, answer)
        assert not expire_waiting(ctx, 'run', now=utc_now()+timedelta(days=1))
    else:
        assert expire_waiting(ctx, 'run', now=utc_now()+timedelta(days=1))
        with pytest.raises(ValidationError):
            contribute(ctx, actor, work, answer)
    assert agent_runs.resume_waiting(ctx, 'run')
    assert not agent_runs.resume_waiting(ctx, 'run')


@pytest.mark.parametrize('timeout', [0, -1, 604801, True, '60', 1.5])
def test_timeout_is_strict_optional_bounded(timeout):
    from homun.application.clarify_contracts import ClarifyArguments
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        ClarifyArguments.model_validate({'questions':[{'question':'Input?'}], 'timeout_seconds':timeout})


@pytest.mark.parametrize('change', ['cancel', 'revoke', 'version', 'epoch', 'call', 'questions'])
def test_expiry_fenced_by_current_run_and_authority(setup, change):
    from homun.application.clarification_deadlines import expire_waiting
    from homun.domain.errors import DomainError
    from homun.application.agent_control import control
    ctx, actor, work = start(setup)
    if change == 'cancel':
        control(ctx, actor, work, 'run', {'command_id':'cancel', 'action':'cancel',
            'expected_version':ctx.repository.load().works[work].version})
    else:
        with ctx.repository.locked(), ctx.repository.transaction() as store:
            run = store.commands['run'].result
            if change == 'revoke':
                store.grants.clear()
            elif change == 'version':
                store.works[work].version += 1
            elif change == 'epoch':
                run['_epoch'] += 1
            elif change == 'questions':
                run['clarify_request'][0]['question'] = 'Changed question'
            else:
                run['_messages'][-1]['tool_calls'][0]['id'] = 'other-call'
    if change == 'cancel':
        assert not expire_waiting(ctx, 'run', now=utc_now()+timedelta(days=1))
    else:
        with pytest.raises(DomainError):
            expire_waiting(ctx, 'run', now=utc_now()+timedelta(days=1))
    store = ctx.repository.load()
    assert not any(e.type == 'contribution.expired' for e in store.events)
    assert not any(m['role']=='tool' and 'timed_out' in (m.get('content') or '')
                   for m in store.commands['run'].result['_messages'])


def test_ordinary_contribution_never_autoexpires(setup, monkeypatch):
    from homun.runtime.workflows import agent_run
    from homun.application import clarification_deadlines
    ctx, actor, work, _ = setup
    ctx.models.set_active('openai_compatible')
    proposal = agent_runs.propose(ctx, actor, work, {'command_id':'run','expected_version':1})
    agent_runs.approve(ctx, actor, work, 'run', {'command_id':'approve', 'digest':proposal['digest'], 'expected_version':proposal['expected_version']})
    from homun.application.agent_tool_contracts import QUESTION
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(message=NativeMessage(role='assistant',
        tool_calls=[ToolCall(id='ordinary', name=QUESTION.name, arguments={'question':'Approve input?'})]), usage=None)
    assert advance(ctx, 'run') == 'waiting_input'
    monkeypatch.setattr(clarification_deadlines, 'utc_now', lambda: utc_now()+timedelta(days=999))
    agent_run.deliver_agent_runs(ctx)
    store = ctx.repository.load()
    run = store.commands['run'].result
    assert run['status'] == 'waiting_input'
    assert store.contributions[run['request_id']].status == 'pending'


@pytest.mark.parametrize('identity', ['recipient', 'wrong_recipient', 'outsider'])
def test_draft_http_uses_requested_recipient_and_project_access(setup, monkeypatch, identity):
    from fastapi.testclient import TestClient
    from homun.app import create_app
    from homun.routes import domain
    ctx, actor, work = start(setup)
    if identity == 'wrong_recipient':
        with ctx.repository.locked(), ctx.repository.transaction() as store:
            request = store.contributions[store.commands['run'].result['request_id']]
            request.to_actor_id = 'someone_else'
    monkeypatch.setattr(domain, 'get_context', lambda: ctx)
    who = 'outsider' if identity == 'outsider' else actor.id
    client = TestClient(create_app(session_token='t'*32, session_actor_id=who))
    store = ctx.repository.load()
    request_id = store.commands['run'].result['request_id']
    response = client.post(f'/v1/workspaces/{ctx.workspace_id}/commands', headers={'Authorization':'Bearer '+'t'*32},
        json={'command_id':'save-draft', 'type':'work.save_contribution_draft', 'payload':{
            'request_id':request_id, 'expected_version':store.works[work].version,
            'text':json.dumps({'answers':{'format':'CSV'}, 'partial':True})}})
    if identity == 'recipient':
        assert response.status_code == 200, response.text
        saved = ctx.repository.load().contributions[request_id]
        assert saved.status == 'pending'
        assert json.loads(saved.draft_response_text)['answers'] == {'format':'CSV'}
    else:
        assert response.status_code in {403, 422}, response.text
        assert ctx.repository.load().contributions[request_id].draft_response_text is None


def test_answer_and_expiry_compete_atomically(setup):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from homun.application.clarification_deadlines import expire_waiting
    from homun.domain.errors import ValidationError
    ctx, actor, work = start(setup)
    barrier = Barrier(2)
    def reply():
        barrier.wait()
        try:
            contribute(ctx, actor, work, {'answers':{'format':'CSV', 'fields':['Price']}})
            return True
        except ValidationError:
            return False
    def expire():
        barrier.wait()
        return expire_waiting(ctx, 'run', now=utc_now()+timedelta(days=1))
    with ThreadPoolExecutor(max_workers=2) as pool:
        human, clock = pool.submit(reply), pool.submit(expire)
        assert sum([human.result(), clock.result()]) == 1
    assert agent_runs.resume_waiting(ctx, 'run')
    saved = ctx.repository.load()
    assert len([e for e in saved.events if e.type in {'contribution.resolved','contribution.expired'}]) == 1
    assert len([m for m in saved.commands['run'].result['_messages'] if m['role']=='tool']) == 1


def test_crash_after_expiry_before_resume_preserves_exact_receipt(setup):
    from homun.application.clarification_deadlines import expire_waiting
    ctx, actor, work = start(setup)
    assert expire_waiting(ctx, 'run', now=utc_now()+timedelta(days=1))
    second = create_context(db_path=ctx.data_dir/'ws.db', data_dir=ctx.data_dir, for_tests=True)
    try:
        assert not expire_waiting(second, 'run', now=utc_now()+timedelta(days=1))
        assert agent_runs.resume_waiting(second, 'run')
        assert not agent_runs.resume_waiting(second, 'run')
        store = second.repository.load()
        assert len([e for e in store.events if e.type == 'contribution.expired']) == 1
        replies = [m for m in store.commands['run'].result['_messages'] if m['role']=='tool']
        assert len(replies) == 1 and replies[0]['tool_call_id'] == 'clarify-call'
    finally:
        second.close()


def test_expired_missing_input_does_not_complete_plan_step(setup):
    from homun.application.clarification_deadlines import expire_waiting
    ctx, actor, work = start(setup)
    with ctx.repository.locked(), ctx.repository.transaction() as store:
        plan = ctx.service.for_store(store).current_plan(store.works[work])
        step = next(s for s in plan.steps if s.status == 'running')
        request = store.contributions[store.commands['run'].result['request_id']]
        request.step_id = step.id
        step_id = step.id
    assert expire_waiting(ctx, 'run', now=utc_now()+timedelta(days=1))
    store = ctx.repository.load()
    plan = ctx.service.for_store(store).current_plan(store.works[work])
    assert next(s for s in plan.steps if s.id == step_id).status == 'running'


def test_deadline_requires_current_pinned_clarify_tool(setup):
    from homun.application.clarification_deadlines import expire_waiting
    from homun.domain.errors import DomainError
    ctx, actor, work = start(setup)
    with ctx.repository.locked(), ctx.repository.transaction() as store:
        store.commands['run'].result['clarify'] = None
    with pytest.raises(DomainError):
        expire_waiting(ctx, 'run', now=utc_now()+timedelta(days=1))
    assert not any(e.type == 'contribution.expired' for e in ctx.repository.load().events)
