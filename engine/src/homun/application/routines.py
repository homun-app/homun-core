"""Routine orchestration: DBOS schedules around transactional commands; the
recurrence run itself lives in routine_runs (keeps the import graph acyclic).

The automation repeats the assignment, never the approval: each recurrence
creates a real work with the template's phases, waiting for the person's
explicit go exactly like a hand-made one. Schedule lifecycle (create/pause/
resume/delete) lives here because DBOS is engine runtime, not domain state.
"""
from __future__ import annotations
import threading
from copy import deepcopy
from typing import Any

from homun.domain.errors import NotFoundError, ValidationError

_SCHEDULE_SYNC = threading.Event()


def request_schedule_sync() -> None:
    """Domain mutation happened; schedules converge on the next runtime tick."""
    _SCHEDULE_SYNC.set()


def take_schedule_sync_request() -> bool:
    """Runtime-side consume: True once per pending mutation batch."""
    return _SCHEDULE_SYNC.is_set() and (_SCHEDULE_SYNC.clear() is None)


def public(routine) -> dict[str, Any]:
    return {
        "id": routine.id, "name": routine.name, "cron": routine.cron,
        "cron_timezone": routine.cron_timezone,
        "conversation_id": routine.conversation_id,
        "template": deepcopy(routine.template),
        "status": routine.status, "last_run_work_id": routine.last_run_work_id,
        "last_scheduled_for": routine.last_scheduled_for, "skip_until": routine.skip_until,
        "revision": routine.revision,
    }


def _schedule_name(routine_id: str) -> str:
    return f"routine:{routine_id}"


def _schedule_context(routine_id: str) -> dict[str, Any]:
    return {"routine_id": routine_id}


def next_occurrence(cron: str, cron_timezone: str) -> str:
    """The next ISO occurrence strictly after now, in the routine's timezone."""
    from dbos._scheduler import croniter
    from datetime import datetime
    from zoneinfo import ZoneInfo
    from homun.domain.errors import ValidationError as _ValidationError
    zone = ZoneInfo(cron_timezone)
    try:
        iterator = croniter(cron, datetime.now(zone))
        return iterator.get_next(datetime).astimezone(zone).isoformat()
    except Exception as exc:
        raise _ValidationError(f"invalid cron: {exc}") from exc


def deep_validate_cron(cron: str) -> str:
    """Full croniter validation; the domain keeps structural checks only."""
    from homun.domain.commands.routines import validate_cron
    from homun.domain.errors import ValidationError as _ValidationError
    validate_cron(cron)
    from dbos._scheduler import croniter  # the same engine DBOS relies on
    from datetime import datetime, timezone
    try:
        croniter(cron, datetime.now(timezone.utc))
    except Exception as exc:
        raise _ValidationError(f"invalid cron: {exc}") from exc
    return cron


def create_routine(ctx, actor, body) -> dict[str, Any]:
    """Transactional routine.create, then the durable DBOS schedule."""
    deep_validate_cron(body["cron"])
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            service = ctx.service.for_store(store)
            result = service.apply(actor, body["command_id"], "routine.create", {
                "name": body.get("name") or "",
                "cron": body["cron"],
                "cron_timezone": body.get("cron_timezone") or "Europe/Rome",
                "conversation_id": body["conversation_id"],
                "template": body["template"],
            })
        ctx.service.store = store
    _register_schedule(result["routine_id"], body["cron"],
                       body.get("cron_timezone") or "Europe/Rome")
    request_schedule_sync()  # if the in-request registration drifted, converge
    return result


def _register_schedule(routine_id: str, cron: str, cron_timezone: str) -> None:
    from dbos import DBOS
    from homun.runtime.workflows.routine_recurrence import routine_recurrence_workflow
    DBOS.create_schedule(
        schedule_name=_schedule_name(routine_id),
        workflow_fn=routine_recurrence_workflow,
        schedule=cron,
        context=_schedule_context(routine_id),
        cron_timezone=cron_timezone,
    )


def routine_action(ctx, actor, action: str, body) -> dict[str, Any]:
    """pause/resume/stop/update/skip_next: domain transition + schedule twin.

    A cron change recreates the schedule under the same name; every other
    mutation keeps it and lets reconcile converge any drift.
    """
    from dbos import DBOS
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            routine = store.routines.get(str(body.get("routine_id") or ""))
            if routine is None:
                raise NotFoundError("Routine not found")
            name = _schedule_name(routine.id)
            old_cron = (routine.cron, routine.cron_timezone)
            payload = {"routine_id": routine.id, "expected_version": body["expected_version"]}
            for key in ("name", "cron", "cron_timezone", "template"):
                if body.get(key) is not None:
                    payload[key] = body[key]
            if action == "skip_next":
                deep_validate_cron(routine.cron)
                payload["skip_until"] = next_occurrence(routine.cron, routine.cron_timezone)
            service = ctx.service.for_store(store)
            result = service.apply(actor, body["command_id"], f"routine.{action}", payload)
            new_cron = (store.routines[routine.id].cron, store.routines[routine.id].cron_timezone)
        ctx.service.store = store
    try:
        if action == "pause":
            DBOS.pause_schedule(name)
        elif action == "resume":
            DBOS.resume_schedule(name)
        elif action == "stop":
            DBOS.delete_schedule(name)
        elif action == "update" and new_cron != old_cron:
            # A changed cadence needs a fresh schedule definition.
            DBOS.delete_schedule(name)
            _register_schedule(routine.id, new_cron[0], new_cron[1])
    finally:
        # Domain state is the truth; any drift converges on the next runtime
        # tick, not just at startup.
        request_schedule_sync()
    return result


def reconcile_routine_schedules(ctx) -> list[str]:
    """On startup, align DBOS schedules with routine domain state.

    Deleted schedules for stopped routines, paused threads for paused ones,
    and re-registration for active ones whose schedule is missing (e.g. a
    wiped dbos.sqlite) keep the two worlds from drifting apart.
    """
    from dbos import DBOS
    from homun.runtime.workflows.routine_recurrence import routine_recurrence_workflow
    store = ctx.repository.load()
    existing = {s["schedule_name"] for s in DBOS.list_schedules()}
    repaired: list[str] = []
    for routine in store.routines.values():
        name = _schedule_name(routine.id)
        if routine.status == "stopped":
            if name in existing:
                DBOS.delete_schedule(name)
            continue
        if name not in existing:
            if routine.status == "active":
                DBOS.create_schedule(
                    schedule_name=name,
                    workflow_fn=routine_recurrence_workflow,
                    schedule=routine.cron,
                    context=_schedule_context(routine.id),
                    cron_timezone=routine.cron_timezone,
                )
                repaired.append(routine.id)
            continue
        schedule = next((s for s in DBOS.list_schedules() if s["schedule_name"] == name), None)
        if schedule is None:
            continue
        paused_in_dbos = schedule.get("status", "ACTIVE") != "ACTIVE"
        if routine.status == "paused" and not paused_in_dbos:
            DBOS.pause_schedule(name)
        elif routine.status == "active" and paused_in_dbos:
            DBOS.resume_schedule(name)
    return repaired


def list_routines(ctx, actor) -> dict[str, Any]:
    from homun.policy import require_workspace_actor
    store = ctx.repository.load()
    require_workspace_actor(actor, store.workspace_id)
    return {"items": [public(r) for r in
                      sorted(store.routines.values(), key=lambda r: r.created_at)]}
