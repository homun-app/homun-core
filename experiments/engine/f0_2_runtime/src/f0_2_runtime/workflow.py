"""DBOS + Pydantic AI candidate workflow for F0.2."""

from __future__ import annotations

from pathlib import Path

from dbos import DBOS, SetWorkflowID
from pydantic_ai import Agent
from pydantic_ai.durable_exec.dbos import DBOSDurability
from pydantic_ai.models.test import TestModel

from f0_2_runtime.models import Contribution, PlanStep, WorkPlan
from f0_2_runtime.side_effects import apply_uncertain_effect, load_receipt

TOPIC_CONTRIBUTION = "contribution"
WORKFLOW_NAME = "catalog_work"


def workspace_root() -> Path:
    return Path(__file__).resolve().parents[2]


def data_dir() -> Path:
    path = workspace_root() / ".data"
    path.mkdir(parents=True, exist_ok=True)
    return path


def sqlite_url() -> str:
    return f"sqlite:///{(data_dir() / 'dbos.sqlite').as_posix()}"


def receipts_dir() -> Path:
    path = data_dir() / "receipts"
    path.mkdir(parents=True, exist_ok=True)
    return path


def fixture_request_path() -> Path:
    return workspace_root() / "fixtures" / "catalog-request.txt"


def configure_dbos() -> None:
    DBOS(
        config={
            "name": "homun-f0-2-runtime",
            "application_version": "0.1.0",
            "system_database_url": sqlite_url(),
            "run_admin_server": False,
        }
    )


def build_plan_agent() -> Agent[None, WorkPlan]:
    """Deterministic offline agent — no live LLM for this spike."""
    custom_plan = WorkPlan(
        objective="Preparare il catalogo prodotti per il cliente",
        steps=[
            PlanStep(
                id="step_collect",
                title="Raccogliere listino prezzi",
                assignee="Vera",
                needs_material=True,
            ),
            PlanStep(
                id="step_draft",
                title="Redigere bozza catalogo",
                assignee="Marta",
                needs_material=False,
            ),
            PlanStep(
                id="step_publish",
                title="Pubblicare bozza (effetto esterno incerto)",
                assignee="Marta",
                needs_material=False,
            ),
        ],
    )
    return Agent(
        TestModel(custom_output_args=custom_plan.model_dump()),
        output_type=WorkPlan,
        name="plan_proposer",
        instructions="Propose a concrete work plan from the request text.",
        capabilities=[DBOSDurability()],
    )


_plan_agent = build_plan_agent()


@DBOS.step()
def read_request(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


@DBOS.step()
def record_plan(plan: dict) -> dict:
    out = data_dir() / "last_plan.json"
    text = WorkPlan.model_validate(plan).model_dump_json(indent=2)
    out.write_text(text, encoding="utf-8")
    return plan


@DBOS.step(retries_allowed=True, max_attempts=5, interval_seconds=0.2)
def publish_with_uncertain_effect(command_id: str, crash_after_effect: bool) -> dict:
    """
    Homun-owned idempotency around an uncertain external write.

    If a previous attempt wrote the receipt then crashed before the step
    completed, the next attempt reconciles instead of applying twice.
    """
    existing = load_receipt(receipts_dir(), command_id)
    if existing is not None:
        return {"status": "reconciled", "receipt": existing.model_dump()}

    receipt = apply_uncertain_effect(
        receipts_dir(),
        command_id,
        crash_after_effect=crash_after_effect,
    )
    return {"status": "applied", "receipt": receipt.model_dump()}


@DBOS.workflow()
def catalog_work(request_path: str, command_id: str, crash_after_effect: bool = False) -> dict:
    request_text = read_request(request_path)
    result = _plan_agent.run_sync(
        f"Build a plan for this request:\n\n{request_text}",
    )
    plan = result.output
    record_plan(plan.model_dump())

    material_step = next(step for step in plan.steps if step.needs_material)
    contribution_raw = DBOS.recv(TOPIC_CONTRIBUTION, timeout_seconds=3600)
    if contribution_raw is None:
        raise TimeoutError("Timed out waiting for human contribution")

    contribution = Contribution.model_validate(contribution_raw)
    if contribution.request_id != material_step.id:
        raise ValueError(
            f"Contribution request_id {contribution.request_id} "
            f"does not match {material_step.id}"
        )

    effect = publish_with_uncertain_effect(command_id, crash_after_effect)
    return {
        "objective": plan.objective,
        "contribution": contribution.model_dump(),
        "effect": effect,
        "workflow": WORKFLOW_NAME,
    }


def start_catalog_work(
    workflow_id: str,
    *,
    crash_after_effect: bool = False,
    command_id: str = "cmd_publish_1",
) -> str:
    request = str(fixture_request_path())
    with SetWorkflowID(workflow_id):
        handle = DBOS.start_workflow(
            catalog_work,
            request,
            command_id,
            crash_after_effect,
        )
    return handle.get_workflow_id()


def send_contribution(workflow_id: str, material_path: str) -> None:
    contribution = Contribution(
        request_id="step_collect",
        material_path=material_path,
        note="Listino allegato da Giulia",
    )
    DBOS.send(workflow_id, contribution.model_dump(), topic=TOPIC_CONTRIBUTION)


def get_workflow_status(workflow_id: str) -> str:
    handle = DBOS.retrieve_workflow(workflow_id)
    status = handle.get_status()
    # DBOS status object exposes .status string in recent versions
    if hasattr(status, "status"):
        return str(status.status)
    return str(status)
