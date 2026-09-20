"""Bridge DomainService work commands ↔ DBOS durable runs (F4.1)."""

from __future__ import annotations

import time
from typing import Any

from homun.domain.models import Run, utc_now
from homun.domain.store import WorkspaceStore
from homun.domain.effects import current_run_for_work  # public compatibility export
from homun.runtime.workflows import work_run as work_run_wf


def refresh_run_status(store: WorkspaceStore, run: Run, *, wait_seconds: float = 0) -> Run:
    deadline = time.monotonic() + max(0.0, wait_seconds)
    while True:
        dbos_status = work_run_wf.get_workflow_status(run.workflow_id)
        upper = dbos_status.upper()
        if "SUCCESS" in upper or upper in {"COMPLETED", "FINISHED"}:
            result = work_run_wf.try_get_workflow_result(run.workflow_id)
            run.status = "completed"
            if isinstance(result, dict):
                effect = result.get("effect")
                if isinstance(effect, dict):
                    run.effect_status = str(effect.get("status") or "")
            run.updated_at = utc_now()
            store.runs[run.id] = run
            return run
        if "FAIL" in upper or "ERROR" in upper or "CANCEL" in upper:
            run.status = "failed"
            run.last_error = dbos_status
            run.updated_at = utc_now()
            store.runs[run.id] = run
            return run
        if time.monotonic() >= deadline:
            if run.status not in {"completed", "failed", "cancelled"}:
                # Still waiting or running
                if "ENQUEUED" in upper or "PENDING" in upper:
                    run.status = "waiting_input" if run.waiting_step_id else "pending"
                elif "RUNNING" in upper:
                    run.status = "running" if run.status != "waiting_input" else run.status
            run.updated_at = utc_now()
            store.runs[run.id] = run
            return run
        time.sleep(0.05)


def run_public_view(store: WorkspaceStore, run: Run) -> dict[str, Any]:
    dbos_status = None
    try:
        # A read must not erase a committed cancellation or its uncertainty.
        if run.status not in {"cancelled", "cancellation_uncertain"}:
            refresh_run_status(store, run, wait_seconds=0)
        dbos_status = work_run_wf.get_workflow_status(run.workflow_id)
    except Exception as exc:  # runtime diagnostics remain explicit
        dbos_status = f"unavailable:{exc}"
    payload = run.model_dump(mode="json")
    payload["dbos_status"] = dbos_status
    return payload
