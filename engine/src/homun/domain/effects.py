"""Pure runtime intent preparation; delivery happens only after persistence."""
from homun.domain.ids import new_id
from homun.domain.models import Run, RuntimeIntent, utc_now
from homun.domain.store import WorkspaceStore


def current_run_for_work(store: WorkspaceStore, work_id: str) -> Run | None:
    return max((r for r in store.runs.values() if r.work_id == work_id),
               key=lambda r: r.created_at, default=None)


def stage_intent(store, command_id, run, kind, payload):
    intent_id = f"{command_id}:{kind}"
    store.outbox[intent_id] = RuntimeIntent(
        id=intent_id, command_id=command_id, run_id=run.id, kind=kind,
        payload=payload, sequence=max((i.sequence for i in store.outbox.values()), default=0) + 1)


def prepare_run(store, *, command_id, work_id, step_id, contribution_request_id,
                effect_command_id, crash_after_effect=False):
    run_id = new_id("run")
    run = Run(id=run_id, workspace_id=store.workspace_id, work_id=work_id,
              workflow_id=f"wf_{run_id}", command_id=effect_command_id,
              status="waiting_input", waiting_step_id=step_id,
              contribution_request_id=contribution_request_id)
    store.runs[run.id] = run
    stage_intent(store, command_id, run, "start", {
        "work_id": work_id, "step_id": step_id, "command_id": effect_command_id,
        "crash_after_effect": crash_after_effect})
    return run


def cancel_work_intents(store, work_id):
    """Revoke unsent work. An authorized/in-flight contribution is uncertain."""
    uncertain = False
    for run in store.runs.values():
        if run.work_id != work_id or run.status in {"completed", "failed", "cancelled"}:
            continue
        intents = [i for i in store.outbox.values() if i.run_id == run.id]
        in_flight = run.status == "cancellation_uncertain" or any(
            i.kind == "contribution" and (i.delivered or i.claim_token
                                         or i.error_code == "runtime_delivery_failed")
            for i in intents)
        for intent in intents:
            if not intent.delivered:
                intent.cancelled = True
                intent.error_code = "runtime_intent_cancelled"
        run.status = "cancellation_uncertain" if in_flight else "cancelled"
        run.last_error = "runtime_cancellation_uncertain" if in_flight else None
        run.updated_at = utc_now()
        uncertain |= in_flight
    return uncertain
