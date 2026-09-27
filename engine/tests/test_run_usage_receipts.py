"""Actual provider invocation paths retain immutable run-attributed receipts."""
from types import SimpleNamespace
import pytest
from test_agent_runs import setup, start
from test_native_agent import native_start
from test_agent_context import pressured, summary
from homun.application.agent_run_execution import advance
from homun.application.agent_runs import propose, approve
from homun.models.native_turn import NativeMessage
from homun.models.native_errors import NativeModelError, TIMEOUT
from homun.models.types import UsageEntry


def usage(input_tokens=10, output_tokens=3, **kwargs):
    return UsageEntry(id='measured', provider_id='reported-provider', model_id='reported-model', input_tokens=input_tokens, output_tokens=output_tokens, **kwargs)


def rows(ctx):
    return list(ctx.repository.load().budget_usage_receipts.values())


@pytest.mark.parametrize('measured,status', [(usage(), 'known'), (usage(output_tokens=None), 'partial'), (None, 'unknown')])
def test_native_actual_attempt_is_attributed_and_measured_nullable(setup, measured, status):
    ctx, actor, work, material = setup
    native_start(ctx, actor, work, material)
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(message=NativeMessage(role='assistant', content='Done'), usage=measured)
    assert advance(ctx, 'run') == 'completed'
    receipt, = rows(ctx)
    assert receipt.run_id == 'run' and receipt.connection_id == 'openai_compatible'
    assert receipt.status == status
    assert receipt.output_tokens == (measured.output_tokens if measured else None)
    assert receipt.cost is None


def test_fallback_records_actual_connections_and_primary_error_usage(setup, monkeypatch):
    ctx, actor, work, material = setup
    ctx.models.set_active('openai_compatible')
    original = ctx.models.get_connection
    monkeypatch.setattr(ctx.models, 'get_connection', lambda ident: original('openai_compatible').model_copy(update={'id': 'backup', 'model_id': 'backup-model', 'active': True}) if ident == 'backup' else original(ident))
    p = propose(ctx, actor, work, {'command_id': 'run', 'expected_version': 1, 'material_ids': [material], 'fallback_connection_id': 'backup'})
    approve(ctx, actor, work, 'run', {'command_id': 'approve', 'digest': p['digest'], 'expected_version': p['expected_version']})
    def model(*args, **kwargs):
        if kwargs['connection_id'] == 'openai_compatible':
            raise NativeModelError(TIMEOUT, 'Timeout', retryable=True, usage=usage(input_tokens=2, output_tokens=None))
        return SimpleNamespace(message=NativeMessage(role='assistant', content='Fallback'), usage=usage(input_tokens=4, output_tokens=1))
    ctx.models.complete_tools = model
    assert advance(ctx, 'run') == 'completed'
    receipts = rows(ctx)
    assert [r.connection_id for r in receipts] == ['openai_compatible', 'backup']
    assert receipts[1].requested_model_id == 'backup-model'
    assert [r.status for r in receipts] == ['partial', 'known']
    assert all(r.run_id == 'run' for r in receipts)


def test_compaction_retains_own_receipt(setup):
    from homun.application.agent_context import prepare
    ctx, actor, work, material = setup
    _, run = pressured(ctx, actor, work, material)
    ctx.models.complete_summary = lambda *a, **k: SimpleNamespace(message=summary().message, usage=usage())
    prepare(ctx, run, [])
    receipt, = rows(ctx)
    assert receipt.run_id == run['id'] and receipt.purpose == 'agent_run.compact'
    assert receipt.input_tokens == 10


def test_legacy_invalid_decision_preserves_reported_usage(setup):
    ctx, actor, work, material = setup
    start(ctx, actor, work, material)
    ctx.models.complete = lambda *a, **k: SimpleNamespace(text='invalid JSON', usage=usage(input_tokens=21))
    assert advance(ctx, 'run') == 'failed'
    receipt, = rows(ctx)
    assert receipt.run_id == 'run' and receipt.input_tokens == 21


def test_side_question_settles_measured_usage_without_overwriting_main_progress(setup):
    from homun.application.agent_side_questions import answer_side_question
    ctx, actor, work, material = setup
    native_start(ctx, actor, work, material)
    original = list(ctx.repository.load().commands['run'].result['_messages'])
    def side(*args, **kwargs):
        with ctx.repository.transaction() as store:
            store.commands['run'].result['_steering'] = [{'text': 'Concurrent user update'}]
        return SimpleNamespace(message=NativeMessage(role='assistant', content='Side answer'), usage=usage(output_tokens=None))
    ctx.models.complete_summary = side
    answer = answer_side_question(ctx, actor, work, 'run', 'Question?')
    assert answer['usage']['completion_tokens'] is None
    saved = ctx.repository.load().commands['run'].result
    assert saved['_messages'] == original and saved['_steering'][0]['text'] == 'Concurrent user update'
    receipt, = rows(ctx)
    assert receipt.run_id == 'run' and receipt.purpose == 'agent_run.side_question' and receipt.status == 'partial'


def test_side_question_source_revocation_retains_receipt_but_denies_response(setup):
    from homun.application.agent_side_questions import answer_side_question
    from homun.domain.errors import PermissionDeniedError
    ctx, actor, work, material = setup
    from homun.domain.models import Actor
    owner = Actor(id='source-owner', workspace_id=actor.workspace_id, display_name='Owner')
    with ctx.repository.transaction() as store:
        service = ctx.service.for_store(store)
        project = service.apply(owner, 'private-source', 'project.create', {'name': 'Source'})['project_id']
        grant = service.apply(owner, 'grant-source', 'grant.issue', {'project_id': project, 'subject_id': actor.id, 'capability': 'read'})['grant_id']
        store.materials[material].project_id = project
    native_start(ctx, actor, work, material)
    def side(*args, **kwargs):
        with ctx.repository.transaction() as store:
            ctx.service.for_store(store).apply(owner, 'revoke-source', 'grant.revoke', {'grant_id': grant})
        return SimpleNamespace(message=NativeMessage(role='assistant', content='Secret answer'), usage=usage())
    ctx.models.complete_summary = side
    with pytest.raises(PermissionDeniedError):
        answer_side_question(ctx, actor, work, 'run', 'Question?')
    receipt, = rows(ctx)
    assert receipt.input_tokens == 10


def test_moa_advisors_and_aggregator_each_have_one_receipt(setup):
    ctx, actor, work, material = setup
    ctx.models.set_active('openai_compatible')
    p = propose(ctx, actor, work, {'command_id': 'run', 'expected_version': 1, 'moa': {'reference_models': [{'provider': 'openai_compatible', 'model': 'advisor-one'}, {'provider': 'openai_compatible', 'model': 'advisor-two'}], 'aggregator': {'provider': 'openai_compatible', 'model': 'aggregate'}}})
    approve(ctx, actor, work, 'run', {'command_id': 'approve', 'digest': p['digest'], 'expected_version': p['expected_version']})
    calls = []
    def model(*args, **kwargs):
        calls.append(kwargs['model_id'])
        return SimpleNamespace(message=NativeMessage(role='assistant', content='Model answer'), usage=usage())
    ctx.models.complete_tools = model
    assert advance(ctx, 'run') == 'completed'
    receipts = rows(ctx)
    assert calls == ['advisor-one', 'advisor-two', 'aggregate']
    assert sorted(r.requested_model_id for r in receipts) == sorted(calls)
    assert len(receipts) == 3 and all(r.run_id == 'run' for r in receipts)
    store = ctx.repository.load()
    assert store.work_budgets[work].spent.attempts == 3
    assert store.commands['run'].result['model_attempts'] == 3


@pytest.mark.parametrize('cap_axis', ['work', 'run'])
def test_moa_denied_aggregator_never_calls_provider(cap_axis, setup):
    ctx, actor, work, _ = setup
    ctx.models.set_active('openai_compatible')
    p = propose(ctx, actor, work, {'command_id': 'run', 'expected_version': 1, 'moa': True})
    approve(ctx, actor, work, 'run', {'command_id': 'approve', 'digest': p['digest'], 'expected_version': p['expected_version']})
    with ctx.repository.transaction() as store:
        if cap_axis == 'work':
            from homun.application.budgets import ensure
            ensure(store, work).caps.model_attempts = 1
        else:
            store.commands['run'].result['limits']['max_model_attempts'] = 1
    calls = []
    ctx.models.complete_tools = lambda *a, **k: (calls.append(k) or SimpleNamespace(message=NativeMessage(role='assistant', content='Advice'), usage=usage()))
    assert advance(ctx, 'run') in {'failed', 'blocked'}
    assert len(calls) == 1 and len(rows(ctx)) == 1
    assert ctx.repository.load().commands['run'].result['model_attempts'] == 1


def test_moa_advisor_failure_retains_partial_usage_then_aggregator_runs(setup):
    ctx, actor, work, _ = setup
    ctx.models.set_active('openai_compatible')
    p = propose(ctx, actor, work, {'command_id': 'run', 'expected_version': 1, 'moa': True})
    approve(ctx, actor, work, 'run', {'command_id': 'approve', 'digest': p['digest'], 'expected_version': p['expected_version']})
    calls = []
    def model(*a, **k):
        calls.append(k)
        if len(calls) == 1:
            raise NativeModelError(TIMEOUT, 'Advisor timeout', retryable=False, usage=usage(input_tokens=2, output_tokens=None))
        return SimpleNamespace(message=NativeMessage(role='assistant', content='Result'), usage=usage())
    ctx.models.complete_tools = model
    assert advance(ctx, 'run') == 'completed'
    assert sorted(receipt.status for receipt in rows(ctx)) == ['known', 'partial']
    assert len(calls) == 2


@pytest.mark.parametrize('failure', ['parse', 'transport'])
def test_goal_judge_parse_and_transport_failures_retain_usage(setup, failure):
    from homun.application.agent_run_execution import _claim
    from homun.application.goal_judge import judge
    ctx, actor, work, material = setup
    native_start(ctx, actor, work, material)
    _, run = _claim(ctx, 'run')
    def model(*a, **k):
        if failure == 'transport':
            raise NativeModelError(TIMEOUT, 'Timeout', retryable=False, usage=usage(input_tokens=2, output_tokens=None))
        return SimpleNamespace(text='not JSON', usage=usage())
    ctx.models.complete = model
    judge(ctx, run)
    receipt, = rows(ctx)
    assert receipt.run_id == 'run' and receipt.purpose == 'agent_run.goal_judge'
    assert receipt.input_tokens == (2 if failure == 'transport' else 10)


@pytest.mark.parametrize('denied', [False, True])
def test_consultation_uses_selected_teammate_connection_and_accounting_actor(setup, denied):
    from homun.application.agent_run_execution import _claim
    from homun.application.agent_consultation import consult
    ctx, actor, work, material = setup
    with ctx.repository.transaction() as store:
        service = ctx.service.for_store(store)
        lead = service.apply(actor, 'lead', 'agent.create', {'name': 'Lead', 'role': 'Lead', 'instructions': 'Lead'})['agent_id']
        member = service.apply(actor, 'member', 'agent.create', {'name': 'Member', 'role': 'Member', 'instructions': 'Help', 'preferred_connection_id': 'fake'})['agent_id']
        team = service.apply(actor, 'team', 'team.create', {'name': 'Team', 'member_ids': [lead, member], 'coordinator_id': lead})['team_id']
    ctx.models.set_active('openai_compatible')
    p = propose(ctx, actor, work, {'command_id': 'run', 'expected_version': 1, 'team_id': team})
    approve(ctx, actor, work, 'run', {'command_id': 'approve', 'digest': p['digest'], 'expected_version': p['expected_version']})
    _, run = _claim(ctx, 'run')
    ctx.models.complete = lambda *a, **k: SimpleNamespace(text='Consulted', usage=usage())
    if denied:
        from homun.application.budgets import ensure
        from homun.domain.models import BudgetAllocation
        from homun.domain.errors import DomainError, ValidationError
        with ctx.repository.transaction() as store:
            ensure(store, work).allocations[member] = BudgetAllocation(actor_id=member, model_attempts=0)
        ctx.models.complete = lambda *a, **k: pytest.fail('Denied consultation called provider')
        with pytest.raises(DomainError):
            consult(ctx, actor, run, {'agent_id': member, 'task': 'Check'})
        assert ctx.repository.load().commands['run'].result['model_attempts'] == 0
        assert rows(ctx) == []
        return
    consult(ctx, actor, run, {'agent_id': member, 'task': 'Check'})
    receipt, = rows(ctx)
    assert receipt.connection_id == 'fake' and receipt.accounting_actor_id == member and receipt.run_id == 'run'


def test_delegated_child_receipts_are_own_spend_and_not_copied_to_parent(setup):
    from test_delegation_runtime import start as delegated_start, delegate
    from homun.application.session_usage import query
    ctx, actor, work, material, p = delegated_start(setup)
    result = delegate(ctx, p)
    child = result['child_run_id']
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(message=NativeMessage(role='assistant', content='Child result'), usage=usage())
    assert advance(ctx, child) == 'completed'
    own_child = query(ctx, actor, work, session_id=child)
    own_parent = query(ctx, actor, work, session_id=p['id'])
    assert own_child['receipt_count'] == own_parent['receipt_count'] == 1
    assert own_child['receipts'][0]['run_id'] == child
    assert own_parent['receipts'][0]['run_id'] == p['id']
    assert len(rows(ctx)) == 2


@pytest.mark.parametrize('fallback', [False, True])
def test_refused_work_admission_does_not_increment_run_attempts(setup, monkeypatch, fallback):
    from homun.application.budgets import ensure
    ctx, actor, work, _ = setup
    ctx.models.set_active('openai_compatible')
    original = ctx.models.get_connection
    monkeypatch.setattr(ctx.models, 'get_connection', lambda ident: original('openai_compatible').model_copy(update={'id': 'backup', 'active': True}) if ident == 'backup' else original(ident))
    proposal = propose(ctx, actor, work, {'command_id': 'run', 'expected_version': 1, 'fallback_connection_id': 'backup' if fallback else None})
    approve(ctx, actor, work, 'run', {'command_id': 'approve', 'digest': proposal['digest'], 'expected_version': proposal['expected_version']})
    with ctx.repository.transaction() as store:
        ensure(store, work).caps.model_attempts = 1 if fallback else 0
    calls = []
    def model(*args, **kwargs):
        calls.append(kwargs['connection_id'])
        raise NativeModelError(TIMEOUT, 'Timeout', retryable=True, usage=usage())
    ctx.models.complete_tools = model
    assert advance(ctx, 'run') in {'failed', 'blocked'}
    expected = 1 if fallback else 0
    assert calls == (['openai_compatible'] if fallback else [])
    assert len(rows(ctx)) == expected
    assert ctx.repository.load().commands['run'].result['model_attempts'] == expected


@pytest.mark.parametrize('operation', ['compact', 'judge'])
def test_auxiliary_denied_reservation_rolls_back_attempt_and_recovery(setup, monkeypatch, operation):
    from copy import deepcopy
    from homun.application import budgets
    from homun.application.agent_context import prepare
    from homun.application.agent_run_execution import _claim
    from homun.application.goal_judge import judge
    from homun.domain.errors import DomainError, ValidationError
    ctx, actor, work, material = setup
    if operation == 'compact':
        _, run = pressured(ctx, actor, work, material)
    else:
        native_start(ctx, actor, work, material)
        _, run = _claim(ctx, 'run')
        with ctx.repository.transaction() as store:
            budgets.ensure(store, work).caps.model_attempts = 0
    before = deepcopy(ctx.repository.load().commands['run'].result)
    if operation == 'compact':
        # Capacity precheck succeeds; admission itself fails before provider IO.
        def denied(*a, **k):
            raise ValidationError('Reservation admission denied')
        monkeypatch.setattr(budgets, 'reserve_in_store', denied)
    ctx.models.complete_summary = lambda *a, **k: pytest.fail('Denied compact called provider')
    ctx.models.complete = lambda *a, **k: pytest.fail('Denied judge called provider')
    with pytest.raises(DomainError):
        prepare(ctx, run, []) if operation == 'compact' else judge(ctx, run)
    after = ctx.repository.load().commands['run'].result
    assert after['model_attempts'] == before['model_attempts']
    assert after.get('_recovery') == before.get('_recovery')
    assert rows(ctx) == []


def test_legacy_receipt_queries_authorize_without_native_transcript(setup):
    from homun.application.session_usage import query
    from homun.domain.errors import PermissionDeniedError
    ctx, actor, work, material = setup
    start(ctx, actor, work, material)
    ctx.models.complete = lambda *a, **k: SimpleNamespace(text='invalid JSON', usage=usage())
    assert advance(ctx, 'run') == 'failed'
    assert query(ctx, actor, work, session_id='run')['receipt_count'] == 1
    assert query(ctx, actor, work)['receipt_count'] == 1
    with ctx.repository.transaction() as store:
        del store.materials[material]
    with pytest.raises(PermissionDeniedError):
        query(ctx, actor, work, session_id='run')
    assert query(ctx, actor, work)['receipt_count'] == 0


def test_side_question_connection_is_pinned_across_concurrent_main_fallback(setup, monkeypatch):
    from homun.application import agent_side_questions
    ctx, actor, work, material = setup
    native_start(ctx, actor, work, material)
    original_connection = ctx.models.get_connection
    monkeypatch.setattr(ctx.models, 'get_connection', lambda ident: original_connection('openai_compatible').model_copy(update={'id': 'backup', 'model_id': 'backup-model', 'active': True}) if ident == 'backup' else original_connection(ident))
    original_reserve = agent_side_questions.reserve_auxiliary
    def concurrent_fallback(*args, **kwargs):
        with ctx.repository.transaction() as store:
            store.commands['run'].result['connection_id'] = 'backup'
        return original_reserve(*args, **kwargs)
    monkeypatch.setattr(agent_side_questions, 'reserve_auxiliary', concurrent_fallback)
    called = []
    def model(*args, **kwargs):
        called.append(kwargs['connection_id'])
        return SimpleNamespace(message=NativeMessage(role='assistant', content='Answer'), usage=usage())
    ctx.models.complete_summary = model
    agent_side_questions.answer_side_question(ctx, actor, work, 'run', 'Question?')
    receipt, = rows(ctx)
    assert called == ['openai_compatible']
    assert receipt.connection_id == called[0]
    assert receipt.requested_model_id == original_connection(called[0]).model_id
    assert ctx.repository.load().commands['run'].result['connection_id'] == 'backup'
