"""The scheduled recurrence workflow: minimal, deterministic, domain-driven."""
from __future__ import annotations

from dbos import DBOS


@DBOS.workflow()
def routine_recurrence_workflow(scheduled_at, context):
    """One DBOS step per occurrence: create the work, post the honest message."""
    from datetime import datetime, timezone

    from homun.context import get_context
    from homun.application.routine_runs import run_recurrence

    routine_id = str((context or {}).get("routine_id") or "")
    if not routine_id:
        return None
    if isinstance(scheduled_at, datetime):
        moment = scheduled_at.astimezone(timezone.utc).isoformat()
    else:
        moment = str(scheduled_at)
    ctx = get_context()
    from homun.domain.models import Actor
    actor = Actor(id="person_fabio", workspace_id=ctx.workspace_id, display_name="Fabio")
    return run_recurrence(ctx, actor, routine_id, moment)
