"""Immutable settlement receipts are atomic with budget counters and survive reload."""
from datetime import timedelta
import pytest
from test_budgets import setup, budget
from homun.application import budgets
from homun.context import create_context
from homun.domain.errors import ConflictError
from homun.domain.models import BudgetCounters, utc_now


def receipts(ctx):
    return ctx.repository.load().budget_usage_receipts


def test_known_receipt_replay_is_atomic_and_survives_reopen(setup):
    ctx, actor, work, _ = setup
    reservation = budgets.reserve(ctx, actor, work, BudgetCounters(attempts=1), purpose='agent_run.decide', run_id='run', connection_id='primary', provider_id='provider', model_id='requested')
    usage = BudgetCounters(attempts=1, input_tokens=12, output_tokens=4)
    measured = {'input_tokens': 12, 'output_tokens': 4, 'provider_id': 'actual-provider', 'model_id': 'actual-model', 'estimated_cost': 0.002, 'currency': 'EUR'}
    budgets.reconcile(ctx, actor, work, reservation, usage=usage, measured_usage=measured)
    receipt = receipts(ctx)[reservation]
    assert receipt.status == 'known'
    assert receipt.run_id == 'run' and receipt.connection_id == 'primary'
    assert receipt.requested_provider_id == 'provider' and receipt.reported_model_id == 'actual-model'
    assert receipt.input_tokens == 12 and receipt.cost == 0.002 and receipt.currency == 'EUR'
    assert receipt.charged_known == usage
    version = budget(ctx, work).version
    budgets.reconcile(ctx, actor, work, reservation, usage=usage, measured_usage=measured)
    assert budget(ctx, work).version == version and len(receipts(ctx)) == 1
    reopened = create_context(db_path=ctx.data_dir/'ws.sqlite3', data_dir=ctx.data_dir, for_tests=True)
    try:
        assert receipts(reopened)[reservation] == receipt
        budgets.reconcile(reopened, actor, work, reservation, usage=usage, measured_usage=measured)
        assert budget(reopened, work).version == version
        with pytest.raises(ConflictError):
            budgets.reconcile(reopened, actor, work, reservation, usage=BudgetCounters(attempts=1, input_tokens=13))
        assert budget(reopened, work).spent == usage
    finally:
        reopened.close()


def test_unknown_normalization_release_and_partial_measurements(setup):
    ctx, actor, work, _ = setup
    unknown = budgets.reserve(ctx, actor, work, BudgetCounters(attempts=1))
    budgets.reconcile(ctx, actor, work, unknown, usage=None)
    version = budget(ctx, work).version
    budgets.reconcile_unknown(ctx, actor, work, unknown)
    assert budget(ctx, work).version == version
    assert receipts(ctx)[unknown].input_tokens is None and receipts(ctx)[unknown].cost is None
    released = budgets.reserve(ctx, actor, work, BudgetCounters(attempts=1))
    budgets.release(ctx, actor, work, released)
    version = budget(ctx, work).version
    budgets.release(ctx, actor, work, released)
    assert budget(ctx, work).version == version and receipts(ctx)[released].status == 'released'
    partial = budgets.reserve(ctx, actor, work, BudgetCounters(attempts=1))
    budgets.reconcile(ctx, actor, work, partial, usage=BudgetCounters(input_tokens=7), unknown_usage=BudgetCounters(attempts=1), measured_usage={'input_tokens': 7, 'output_tokens': None})
    receipt = receipts(ctx)[partial]
    assert receipt.status == 'partial' and receipt.input_tokens == 7 and receipt.output_tokens is None
    assert receipt.charged_known.input_tokens == 7 and receipt.charged_unknown.attempts == 1
    assert budget(ctx, work).unknown.attempts == 2


def test_recovery_settles_once_and_conflicts_with_late_known_usage(setup):
    ctx, actor, work, _ = setup
    reservation = budgets.reserve(ctx, actor, work, BudgetCounters(attempts=1), run_id='crashed')
    with ctx.repository.transaction() as store:
        store.work_budgets[work].pending[0].created_at = utc_now()-timedelta(hours=1)
    assert budgets.recover_pending(ctx) == 1
    assert budgets.recover_pending(ctx) == 0
    assert receipts(ctx)[reservation].reason == 'stale_reservation_recovered'
    assert receipts(ctx)[reservation].run_id == 'crashed'
    with pytest.raises(ConflictError):
        budgets.reconcile(ctx, actor, work, reservation, usage=BudgetCounters(attempts=1, input_tokens=9))
    assert budget(ctx, work).unknown.attempts == 1 and budget(ctx, work).spent.attempts == 0


def test_failed_transaction_commits_neither_receipt_nor_counters(setup, monkeypatch):
    ctx, actor, work, _ = setup
    reservation = budgets.reserve(ctx, actor, work, BudgetCounters(attempts=1))
    from homun.application import budget_settlement
    original = budget_settlement.settle_in_store
    def fail_after_settlement(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError('rollback')
    monkeypatch.setattr(budget_settlement, 'settle_in_store', fail_after_settlement)
    with pytest.raises(RuntimeError, match='rollback'):
        budgets.reconcile_unknown(ctx, actor, work, reservation)
    assert not receipts(ctx)
    assert budget(ctx, work).reserved.attempts == 1 and budget(ctx, work).unknown.attempts == 0


def test_only_original_admitted_caller_can_settle_after_work_revocation(setup):
    from homun.domain.models import Actor
    from homun.domain.errors import PermissionDeniedError
    ctx, actor, work, _ = setup
    with ctx.repository.transaction() as store:
        project = ctx.service.for_store(store).apply(actor, 'private', 'project.create', {'name': 'Private'})
        store.works[work].project_id = project['project_id']
    reservation = budgets.reserve(ctx, actor, work, BudgetCounters(attempts=1))
    with ctx.repository.transaction() as store:
        grant = next(grant for grant in store.grants.values() if grant.subject_id == actor.id and grant.resource_id == project['project_id'])
        ctx.service.for_store(store).apply(actor, 'revoke-own', 'grant.revoke', {'grant_id': grant.id})
    stranger = Actor(id='stranger', workspace_id=actor.workspace_id, display_name='Stranger')
    with pytest.raises(PermissionDeniedError):
        budgets.settle_admitted(ctx, stranger, work, reservation, usage=BudgetCounters(attempts=1))
    budgets.settle_admitted(ctx, actor, work, reservation, usage=BudgetCounters(attempts=1, input_tokens=8), measured_usage={'input_tokens': 8, 'output_tokens': 0})
    assert receipts(ctx)[reservation].input_tokens == 8


def test_budget_counters_do_not_invent_measurements_and_numeric_cost_replay_normalizes(setup):
    ctx, actor, work, _ = setup
    reservation = budgets.reserve(ctx, actor, work, BudgetCounters(attempts=1))
    budgets.reconcile(ctx, actor, work, reservation, usage=BudgetCounters(attempts=1))
    receipt = receipts(ctx)[reservation]
    assert receipt.input_tokens is None and receipt.output_tokens is None and receipt.status != 'known'
    priced = budgets.reserve(ctx, actor, work, BudgetCounters(attempts=1))
    args = {'usage': BudgetCounters(attempts=1), 'measured_usage': {'input_tokens': 0, 'output_tokens': 0, 'estimated_cost': 0, 'currency': 'USD'}}
    budgets.reconcile(ctx, actor, work, priced, **args)
    args['measured_usage']['estimated_cost'] = 0.0
    budgets.reconcile(ctx, actor, work, priced, **args)


def test_legacy_pending_reservation_needs_current_authority_not_new_admitted_id(setup):
    ctx, actor, work, _ = setup
    reservation = budgets.reserve(ctx, actor, work, BudgetCounters(attempts=1))
    with ctx.repository.transaction() as store:
        store.work_budgets[work].pending[0].admitted_actor_id = ''
    budgets.settle_admitted(ctx, actor, work, reservation)
    assert receipts(ctx)[reservation].status == 'unknown'


def test_explicit_measurement_cannot_contradict_charged_known_counter(setup):
    from homun.domain.errors import ValidationError
    ctx, actor, work, _ = setup
    reservation = budgets.reserve(ctx, actor, work, BudgetCounters(attempts=1))
    with pytest.raises(ValidationError, match='measurement'):
        budgets.reconcile(ctx, actor, work, reservation, usage=BudgetCounters(attempts=1, input_tokens=12), measured_usage={'input_tokens': 13, 'output_tokens': 0})
    assert budget(ctx, work).reserved.attempts == 1 and not receipts(ctx)
