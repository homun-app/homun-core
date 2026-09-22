"""One routine occurrence: create the supervised work from the template.

Separated from routines.py so the scheduled workflow can import this without
cycling back into the schedule-management module.
"""
from __future__ import annotations


def run_recurrence(ctx, actor, routine_id: str, scheduled_for: str) -> dict[str, Any] | None:
    """Create the recurrence work from the template; idempotent per instant.

    Called by the DBOS scheduled workflow. Returns the work id, or None when
    the routine is no longer active or this occurrence already ran.
    """
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            routine = store.routines.get(routine_id)
            if routine is None or routine.status != "active":
                return None
            if routine.last_scheduled_for and routine.last_scheduled_for >= scheduled_for:
                return None  # already fired (idempotency on replay/recovery)
            template = routine.template
            service = ctx.service.for_store(store)
            work = service.apply(actor, f"routine:{routine_id}:{scheduled_for}:work", "work.create", {
                "conversation_id": routine.conversation_id,
                "title": template["title"],
                "objective": template["objective"],
            })
            wid = work["work_id"]
            store.works[wid].origin_routine_id = routine.id
            store.works[wid].scheduled_for = scheduled_for
            steps = [
                {"title": step["title"], "assignee_id": step["assignee_id"],
                 "capability": step.get("capability", "general"),
                 "output_expected": step.get("output_expected", "")}
                for step in template["plan_steps"]
            ]
            proposed = service.apply(actor, f"routine:{routine_id}:{scheduled_for}:plan", "plan.propose", {
                "work_id": wid, "steps": steps, "expected_version": store.works[wid].version,
            })
            service.apply(actor, f"routine:{routine_id}:{scheduled_for}:accept", "plan.accept", {
                "work_id": wid, "expected_version": proposed["version"],
            })
            from homun.domain.commands.conversations import append_engine_message
            append_engine_message(
                service._context, actor=actor,
                command_id=f"routine:{routine_id}:{scheduled_for}:msg",
                conversation_id=routine.conversation_id, author_id="homun_engine",
                text=(f"Ricorrenza pronta: «{template['title']}». Il lavoro aspetta il tuo via: "
                      "l'avvio è nel riepilogo del lavoro, come sempre."),
                event_payload={"work_id": wid, "routine_id": routine_id, "scheduled_for": scheduled_for},
            )
            routine.last_run_work_id = wid
            routine.last_scheduled_for = scheduled_for
            from homun.domain.models import utc_now
            routine.updated_at = utc_now()
        ctx.service.store = store
    return {"work_id": wid, "status": store.works[wid].status}
