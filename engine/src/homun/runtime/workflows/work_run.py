"""Durable work workflow — wait for contribution, then idempotent effect (F4.1)."""

from __future__ import annotations

from dbos import DBOS, SetWorkflowID

from homun.runtime.dbos_app import receipts_dir
from homun.runtime.receipts import reconcile_or_apply

TOPIC_CONTRIBUTION = "contribution"
WORKFLOW_NAME = "homun_work_run"


@DBOS.step(retries_allowed=True, max_attempts=5, interval_seconds=0.2)
def publish_with_uncertain_effect(command_id: str, crash_after_effect: bool = False) -> dict:
    return reconcile_or_apply(
        receipts_dir(),
        command_id,
        crash_after_effect=crash_after_effect,
    )


@DBOS.workflow()
async def work_run_workflow(
    work_id: str,
    step_id: str,
    command_id: str,
    crash_after_effect: bool = False,
) -> dict:
    contribution_raw = await DBOS.recv_async(TOPIC_CONTRIBUTION, timeout_seconds=3600)
    if contribution_raw is None:
        raise TimeoutError(f"Timed out waiting for contribution on work {work_id}")
    if not isinstance(contribution_raw, dict):
        raise ValueError("Contribution payload must be an object")
    contrib_step = contribution_raw.get("step_id")
    if contrib_step is not None and str(contrib_step) != step_id:
        raise ValueError(f"Contribution step_id {contrib_step} does not match {step_id}")
    effect = publish_with_uncertain_effect(command_id, crash_after_effect)
    return {
        "workflow": WORKFLOW_NAME,
        "work_id": work_id,
        "step_id": step_id,
        "contribution": contribution_raw,
        "effect": effect,
    }


def start_work_run_workflow(
    workflow_id: str,
    *,
    work_id: str,
    step_id: str,
    command_id: str,
    crash_after_effect: bool = False,
) -> str:
    with SetWorkflowID(workflow_id):
        handle = DBOS.retrieve_queue("homun-work").enqueue(
            work_run_workflow,
            work_id,
            step_id,
            command_id,
            crash_after_effect,
        )
    return handle.get_workflow_id()


def send_contribution(workflow_id: str, payload: dict, *, idempotency_key: str | None = None) -> None:
    DBOS.send(workflow_id, payload, topic=TOPIC_CONTRIBUTION, idempotency_key=idempotency_key)


def get_workflow_status(workflow_id: str) -> str:
    handle = DBOS.retrieve_workflow(workflow_id)
    status = handle.get_status()
    if hasattr(status, "status"):
        return str(status.status)
    return str(status)


def try_get_workflow_result(workflow_id: str) -> dict | None:
    status = get_workflow_status(workflow_id).upper()
    if "SUCCESS" not in status and status not in {"COMPLETED", "FINISHED"}:
        return None
    handle = DBOS.retrieve_workflow(workflow_id)
    try:
        result = handle.get_result()
    except Exception:  # noqa: BLE001
        return None
    return result if isinstance(result, dict) else None
