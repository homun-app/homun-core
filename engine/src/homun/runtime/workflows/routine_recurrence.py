"""The routine workflows on DBOS: one durable heartbeat, one child per occurrence.

`routine_tick_workflow` runs from the single schedule (`TICK_SCHEDULE_NAME`,
every minute, UTC) and composes the same three functions as the in-process
heartbeat (`routine_tick.fire_due_routines`): the due query and the pointer
advance are steps (replayed, not repeated, on recovery), the child launches
stay in the workflow body with the idempotency key (routine, occurrence) —
DBOS forbids starting workflows from inside a step.
"""
from __future__ import annotations

import logging

from dbos import DBOS, SetWorkflowID

logger = logging.getLogger(__name__)


@DBOS.workflow()
def routine_recurrence_workflow(scheduled_at, context):
    """One occurrence: create the work, post the honest message (routine_runs)."""
    from datetime import datetime, timezone

    from homun.context import get_context
    from homun.application.automation.routine_runs import run_recurrence

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


def launch_recurrence(routine_id: str, occurrence: str):
    """Start (or find) the child workflow of an occurrence: same key, same run."""
    from datetime import datetime

    from homun.application.automation.routine_tick import recurrence_workflow_id

    with SetWorkflowID(recurrence_workflow_id(routine_id, occurrence)):
        return DBOS.start_workflow(routine_recurrence_workflow,
                                   datetime.fromisoformat(occurrence), {"routine_id": routine_id})


@DBOS.step()
def _due_occurrences_step() -> list[dict[str, str]]:
    from homun.context import get_context
    from homun.application.automation.routine_tick import due_occurrences

    return due_occurrences(get_context())


@DBOS.step()
def _advance_step(launched: list[dict[str, str]]) -> None:
    from homun.context import get_context
    from homun.application.automation.routine_tick import advance_after_launch

    advance_after_launch(get_context(), launched)


@DBOS.workflow()
def routine_tick_workflow(scheduled_at, context):
    """One heartbeat: due query (step), child launches (idempotent), advance (step)."""
    from homun.application.automation.routine_tick import launch_all

    launched = launch_all(_due_occurrences_step(), launch_recurrence)
    _advance_step(launched)
    return len(launched)
