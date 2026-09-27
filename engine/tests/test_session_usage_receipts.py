"""Canonical usage queries distinguish own calls, inherited context and missing coverage."""
from types import SimpleNamespace
import pytest
from test_agent_runs import setup
from test_native_agent import native_start
from test_run_usage_receipts import usage
from homun.application import budgets, session_runtime
from homun.application.agent_run_execution import advance
from homun.domain.models import BudgetCounters
from homun.domain.errors import PermissionDeniedError
from homun.models.native_turn import NativeMessage


def finish(setup):
    ctx, actor, work, material = setup
    native_start(ctx, actor, work, material)
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(message=NativeMessage(role='assistant', content='Done'), usage=usage(estimated_cost=0.01, currency='EUR'))
    assert advance(ctx, 'run') == 'completed'
    return ctx, actor, work, material


def query(ctx, actor, work, **options):
    return session_runtime.execute(ctx, actor, work, {'action': 'usage', **options})['usage']


def test_run_totals_fork_zero_own_and_revoke(setup):
    ctx, actor, work, material = finish(setup)
    measured = query(ctx, actor, work, session_id='run')
    assert measured['coverage']['complete'] is True
    assert measured['totals']['input_tokens'] == 10 and measured['totals']['total_cost'] == 0.01
    branch = session_runtime.execute(ctx, actor, work, {'action': 'fork', 'session_id': 'run', 'command_id': 'branch'})['session']
    inherited = query(ctx, actor, work, session_id=branch['id'])
    assert inherited['receipt_count'] == 0 and inherited['totals']['charged_known']['attempts'] == 0
    assert inherited['inherited_session_ids'] == ['run']
    with ctx.repository.transaction() as store:
        del store.materials[material]
    with pytest.raises(PermissionDeniedError):
        query(ctx, actor, work, session_id='run')
    with pytest.raises(PermissionDeniedError):
        query(ctx, actor, work, session_id='branch')


def test_pagination_partial_unknown_currency_and_legacy_incomplete(setup):
    ctx, actor, work, _ = finish(setup)
    r = budgets.reserve(ctx, actor, work, BudgetCounters(attempts=1), run_id='run')
    budgets.reconcile(ctx, actor, work, r, usage=BudgetCounters(attempts=1, input_tokens=5), measured_usage={'input_tokens': 5, 'output_tokens': 0, 'estimated_cost': 0.2, 'currency': 'USD'})
    unknown = budgets.reserve(ctx, actor, work, BudgetCounters(attempts=1), run_id='run')
    budgets.reconcile_unknown(ctx, actor, work, unknown)
    with ctx.repository.transaction() as store:
        store.commands['run'].result.pop('_usage_receipts_version')
        store.work_budgets[work].spent.attempts += 1  # Prior aggregate has no reconstructable receipt.
    first = query(ctx, actor, work, session_id='run', limit=1)
    second = query(ctx, actor, work, session_id='run', limit=1, cursor=first['next_cursor'])
    assert len(first['receipts']) == len(second['receipts']) == 1
    assert first['receipts'][0]['id'] != second['receipts'][0]['id']
    assert first['receipt_count'] == 3 and first['totals'] == second['totals']
    assert first['totals']['input_tokens'] is None and first['totals']['known_input_tokens'] == 15
    assert first['totals']['total_cost'] is None
    assert first['totals']['cost_by_currency'] == {'EUR': 0.01, 'USD': 0.2}
    assert first['coverage']['complete'] is False
    work_usage = query(ctx, actor, work)
    assert work_usage['coverage']['legacy_unattributed'] is True


def test_legacy_empty_history_never_reports_zero_final_usage(setup):
    ctx, actor, work, material = setup
    native_start(ctx, actor, work, material)
    with ctx.repository.transaction() as store:
        store.commands['run'].result.pop('_usage_receipts_version')
    result = query(ctx, actor, work, session_id='run')
    assert result['coverage']['complete'] is False
    assert result['totals']['input_tokens'] is None
    assert result['totals']['output_tokens'] is None
    assert result['totals']['total_cost'] is None
    assert result['totals']['known_input_tokens'] == 0


def test_work_usage_excludes_pending_reservations_for_unreadable_history(setup):
    ctx, actor, work, material = finish(setup)
    budgets.reserve(ctx, actor, work, BudgetCounters(attempts=1), run_id='run')
    with ctx.repository.transaction() as store:
        del store.materials[material]
    result = query(ctx, actor, work)
    assert result['pending_count'] == 0 and result['receipt_count'] == 0


def test_usage_tool_retains_off_page_legacy_source_authority(setup):
    from copy import deepcopy
    from homun.application.session_tools import execute
    from homun.application.agent_runs import list_runs
    ctx, actor, work, material = finish(setup)
    with ctx.repository.transaction() as store:
        original = store.commands['run']
        for ident in ('legacy-source', 'consumer'):
            record = original.model_copy(deep=True)
            record.result['id'] = ident
            record.result['session_management'] = {'policy': 'durable-sessions-v1'}
            record.result['materials'] = [] if ident == 'consumer' else deepcopy(original.result['materials'])
            if ident == 'legacy-source':
                record.result.pop('_messages')
            store.commands[ident] = record
        store.commands['run'].result['materials'] = []
    reservation = budgets.reserve(ctx, actor, work, BudgetCounters(attempts=1), run_id='legacy-source')
    budgets.reconcile_unknown(ctx, actor, work, reservation)
    consumer = ctx.repository.load().commands['consumer'].result
    result = execute(ctx, actor, consumer, 'session_manage', {'action': 'usage', 'limit': 1})
    assert result['usage']['receipt_count'] == 2 and len(result['usage']['receipts']) == 1
    assert result['usage']['receipts'][0]['run_id'] == 'run'
    with ctx.repository.transaction() as store:
        del store.materials[material]
    view = next(run for run in list_runs(ctx, actor, work)['items'] if run['id'] == 'consumer')
    assert view.get('history_redacted') is True
