"""F4.1 durable runtime — contribution wait + idempotent effect inside engine."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.runtime import dbos_app
from homun.runtime.receipts import load_receipt


@pytest.fixture
def durable_client(tmp_path: Path):
    db_path = tmp_path / "ws_local.sqlite3"
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    reset_context_for_tests(
        create_context(
            workspace_id="ws_local",
            db_path=db_path,
            data_dir=data_dir,
            for_tests=True,
        )
    )
    app = create_app()
    with TestClient(app) as client:
        yield client, data_dir
    try:
        dbos_app.shutdown_dbos()
    except Exception:  # noqa: BLE001
        pass
    reset_context_for_tests(None)


def _headers() -> dict[str, str]:
    return {"X-Homun-Actor-Id": "person_fabio", "X-Homun-Actor-Name": "Fabio"}


def _seed_ready_work(client: TestClient) -> tuple[str, int]:
    conv = client.post(
        "/v1/workspaces/ws_local/commands",
        headers=_headers(),
        json={
            "command_id": "cmd_f41_conv",
            "type": "conversation.create",
            "payload": {"title": "Catalogo"},
        },
    )
    assert conv.status_code == 200, conv.text
    conversation_id = conv.json()["result"]["conversation_id"]
    work = client.post(
        "/v1/workspaces/ws_local/commands",
        headers=_headers(),
        json={
            "command_id": "cmd_f41_work",
            "type": "work.create",
            "payload": {
                "conversation_id": conversation_id,
                "title": "Catalogo",
                "objective": "Preparare catalogo",
            },
        },
    )
    assert work.status_code == 200, work.text
    work_id = work.json()["result"]["work_id"]
    version = int(work.json()["result"]["version"])
    plan = client.post(
        "/v1/workspaces/ws_local/commands",
        headers=_headers(),
        json={
            "command_id": "cmd_f41_plan",
            "type": "plan.propose",
            "payload": {
                "work_id": work_id,
                "expected_version": version,
                "steps": [
                    {
                        "title": "Raccogliere listino",
                        "assignee_id": "person_fabio",
                        "output_expected": "Listino",
                        "depends_on": [],
                    }
                ],
            },
        },
    )
    assert plan.status_code == 200, plan.text
    # Accept plan so work can start
    accepted = client.post(
        "/v1/workspaces/ws_local/commands",
        headers=_headers(),
        json={
            "command_id": "cmd_f41_accept",
            "type": "plan.accept",
            "payload": {
                "work_id": work_id,
                "expected_version": plan.json()["result"]["version"],
                "plan_revision": plan.json()["result"]["plan_revision"],
            },
        },
    )
    assert accepted.status_code == 200, accepted.text
    return work_id, int(accepted.json()["result"]["version"])


def test_durable_start_contribute_completes(durable_client) -> None:
    client, data_dir = durable_client
    if not dbos_app.is_launched():
        pytest.skip("DBOS not launched in app lifespan")
    work_id, version = _seed_ready_work(client)
    started = client.post(
        "/v1/workspaces/ws_local/commands",
        headers=_headers(),
        json={
            "command_id": "cmd_f41_start",
            "type": "work.start",
            "payload": {
                "work_id": work_id,
                "expected_version": version,
                "durable": True,
                "to_actor_id": "person_fabio",
            },
        },
    )
    assert started.status_code == 200, started.text
    body = started.json()["result"]
    assert body["durable"] is True
    assert body["status"] == "waiting_input"
    request_id = body["request_id"]
    run_id = body["run_id"]

    provided = client.post(
        "/v1/workspaces/ws_local/commands",
        headers=_headers(),
        json={
            "command_id": "cmd_f41_contrib",
            "type": "work.provide_contribution",
            "payload": {
                "request_id": request_id,
                "expected_version": body["version"],
                "text": "Listino allegato",
            },
        },
    )
    assert provided.status_code == 200, provided.text
    result = provided.json()["result"]
    assert result["status"] == "completed"
    assert result.get("effect_status") in {"applied", "reconciled"}

    run_view = client.get(f"/v1/workspaces/ws_local/runs/{run_id}", headers={"X-Homun-Actor-Id": "person_fabio"})
    assert run_view.status_code == 200, run_view.text
    assert run_view.json()["status"] == "completed"

    work_run = client.get(f"/v1/workspaces/ws_local/works/{work_id}/run", headers={"X-Homun-Actor-Id": "person_fabio"})
    assert work_run.status_code == 200
    assert work_run.json()["id"] == run_id

    command_id = run_view.json()["command_id"]
    assert load_receipt(data_dir / "receipts", command_id) is not None


def test_reconcile_effect_after_crash_flag(durable_client) -> None:
    client, data_dir = durable_client
    if not dbos_app.is_launched():
        pytest.skip("DBOS not launched in app lifespan")
    work_id, version = _seed_ready_work(client)
    # First run crashes after writing receipt; retry reconciles.
    started = client.post(
        "/v1/workspaces/ws_local/commands",
        headers=_headers(),
        json={
            "command_id": "cmd_f41_crash_start",
            "type": "work.start",
            "payload": {
                "work_id": work_id,
                "expected_version": version,
                "durable": True,
                "to_actor_id": "person_fabio",
                "crash_after_effect": True,
                "effect_command_id": "fx_shared_crash",
            },
        },
    )
    assert started.status_code == 200, started.text
    body = started.json()["result"]
    provided = client.post(
        "/v1/workspaces/ws_local/commands", headers=_headers(),
        json={"command_id": "cmd_f41_crash_contrib", "type": "work.provide_contribution",
              "payload": {"request_id": body["request_id"], "expected_version": body["version"],
                          "text": "Recover effect"}},
    )
    assert provided.status_code == 200, provided.text
    assert provided.json()["result"]["status"] == "completed"
    assert provided.json()["result"]["effect_status"] == "reconciled"
    assert load_receipt(data_dir / "receipts", "fx_shared_crash") is not None
