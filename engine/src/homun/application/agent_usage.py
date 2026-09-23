"""Charge actual or partial model usage without treating unknown as zero."""
from homun.application import budgets
from homun.domain.models import BudgetCounters


def charge(ctx, actor, run, reservation, usage):
    if usage is None:
        budgets.reconcile_unknown(ctx, actor, run['work_id'], reservation)
        return
    known = BudgetCounters(input_tokens=usage.input_tokens or 0, output_tokens=usage.output_tokens or 0,
                           attempts=1 if usage.input_tokens is not None and usage.output_tokens is not None else 0)
    budgets.reconcile(ctx, actor, run['work_id'], reservation, usage=known,
                      unknown_usage=BudgetCounters(attempts=1) if not known.attempts else None)

