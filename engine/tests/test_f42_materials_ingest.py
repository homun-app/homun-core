"""F4.2 materials ingest — extract, blob store, HTTP, contribution attach."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, get_context, reset_context_for_tests
from homun.materials.extract import extract_text


def test_extract_txt_and_unsupported() -> None:
    ok = extract_text(b"hello listino", filename="listino.txt")
    assert ok.status == "extracted"
    assert "listino" in ok.text

    csv_ok = extract_text(b"a,b\n1,2\n", filename="prices.csv")
    assert csv_ok.status == "extracted"
    assert "1, 2" in csv_ok.text or "1,2" in csv_ok.text.replace(" ", "")

    bad = extract_text(b"\x00\x01\x02", filename="scan.bin")
    assert bad.status == "unsupported"
    assert bad.text == ""


@pytest.fixture
def client(tmp_path: Path):
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
    with TestClient(app) as tc:
        yield tc, data_dir
    reset_context_for_tests(None)


def _headers() -> dict[str, str]:
    return {"X-Homun-Actor-Id": "person_fabio", "X-Homun-Actor-Name": "Fabio"}


def _project(client: TestClient) -> str:
    created = client.post(
        "/v1/workspaces/ws_local/commands",
        headers=_headers(),
        json={
            "command_id": "cmd_f42_proj",
            "type": "project.create",
            "payload": {"name": "Acme"},
        },
    )
    assert created.status_code == 200, created.text
    return str(created.json()["result"]["project_id"])


def test_http_ingest_extract_and_blob(client) -> None:
    tc, data_dir = client
    project_id = _project(tc)
    ingest = tc.post(
        f"/v1/workspaces/ws_local/projects/{project_id}/materials/ingest",
        headers=_headers(),
        files={"file": ("listino.txt", b"SKU,Price\nA,10\n", "text/plain")},
        data={"relative_path": "docs/listino.txt"},
    )
    assert ingest.status_code == 200, ingest.text
    body = ingest.json()
    assert body["extract_status"] == "extracted"
    material_id = body["material_id"]

    content = tc.get(
        f"/v1/workspaces/ws_local/materials/{material_id}/content",
        headers=_headers(),
    )
    assert content.status_code == 200
    assert "SKU" in content.json()["text"] or "A" in content.json()["text"]

    blob = tc.get(
        f"/v1/workspaces/ws_local/materials/{material_id}/blob",
        headers=_headers(),
    )
    assert blob.status_code == 200
    assert b"SKU" in blob.content
    assert (data_dir / get_context().repository.load().materials[material_id].storage_relpath).exists()


def test_http_ingest_unsupported_not_claimed_read(client) -> None:
    tc, _data_dir = client
    project_id = _project(tc)
    ingest = tc.post(
        f"/v1/workspaces/ws_local/projects/{project_id}/materials/ingest",
        headers=_headers(),
        files={"file": ("photo.png", b"\x89PNG\r\n", "image/png")},
    )
    assert ingest.status_code == 200, ingest.text
    assert ingest.json()["extract_status"] == "unsupported"
    material_id = ingest.json()["material_id"]
    content = tc.get(
        f"/v1/workspaces/ws_local/materials/{material_id}/content",
        headers=_headers(),
    )
    assert content.json()["text"] == ""
    assert content.json()["extract_status"] == "unsupported"


def test_reingesting_same_bytes_is_idempotent_per_project(client) -> None:
    tc, _data_dir = client
    project_id = _project(tc)
    first = tc.post(
        f"/v1/workspaces/ws_local/projects/{project_id}/materials/ingest",
        headers=_headers(),
        files={"file": ("listino-marzo.csv", b"sku,price\nA,10\n", "text/csv")},
    )
    assert first.status_code == 200, first.text
    assert first.json()["created"] is True
    material_id = first.json()["material_id"]

    again = tc.post(
        f"/v1/workspaces/ws_local/projects/{project_id}/materials/ingest",
        headers=_headers(),
        files={"file": ("listino-marzo-di-nuovo.csv", b"sku,price\nA,10\n", "text/csv")},
    )
    assert again.status_code == 200, again.text
    assert again.json()["created"] is False
    assert again.json()["material_id"] == material_id

    materials = tc.get(
        f"/v1/workspaces/ws_local/projects/{project_id}/materials",
        headers=_headers(),
    ).json()["items"]
    assert len(materials) == 1, materials

    # Same bytes in another project stay a separate material.
    other = tc.post(
        "/v1/workspaces/ws_local/commands",
        headers=_headers(),
        json={
            "command_id": "cmd_f42_proj2",
            "type": "project.create",
            "payload": {"name": "Altro"},
        },
    )
    other_id = str(other.json()["result"]["project_id"])
    elsewhere = tc.post(
        f"/v1/workspaces/ws_local/projects/{other_id}/materials/ingest",
        headers=_headers(),
        files={"file": ("listino-marzo.csv", b"sku,price\nA,10\n", "text/csv")},
    )
    assert elsewhere.status_code == 200, elsewhere.text
    assert elsewhere.json()["created"] is True
    assert elsewhere.json()["material_id"] != material_id


def test_ingest_requires_write_grant(client) -> None:
    tc, _data_dir = client
    project_id = _project(tc)
    denied = tc.post(
        f"/v1/workspaces/ws_local/projects/{project_id}/materials/ingest",
        headers={"X-Homun-Actor-Id": "person_other", "X-Homun-Actor-Name": "Other"},
        files={"file": ("a.txt", b"hi", "text/plain")},
    )
    assert denied.status_code == 403


def test_provide_contribution_with_material_only(client) -> None:
    tc, _data_dir = client
    project_id = _project(tc)
    ingest = tc.post(
        f"/v1/workspaces/ws_local/projects/{project_id}/materials/ingest",
        headers=_headers(),
        files={"file": ("listino.txt", b"listino ok", "text/plain")},
    )
    assert ingest.status_code == 200, ingest.text
    material_id = ingest.json()["material_id"]

    conv = tc.post(
        "/v1/workspaces/ws_local/commands",
        headers=_headers(),
        json={
            "command_id": "cmd_f42_conv",
            "type": "conversation.create",
            "payload": {"title": "C", "project_id": project_id},
        },
    )
    assert conv.status_code == 200, conv.text
    conversation_id = conv.json()["result"]["conversation_id"]
    work = tc.post(
        "/v1/workspaces/ws_local/commands",
        headers=_headers(),
        json={
            "command_id": "cmd_f42_work",
            "type": "work.create",
            "payload": {
                "conversation_id": conversation_id,
                "title": "Catalogo",
                "objective": "Prep",
            },
        },
    )
    assert work.status_code == 200, work.text
    work_id = work.json()["result"]["work_id"]
    version = int(work.json()["result"]["version"])
    plan = tc.post(
        "/v1/workspaces/ws_local/commands",
        headers=_headers(),
        json={
            "command_id": "cmd_f42_plan",
            "type": "plan.propose",
            "payload": {
                "work_id": work_id,
                "expected_version": version,
                "steps": [
                    {
                        "title": "Listino",
                        "assignee_id": "person_fabio",
                        "output_expected": "File",
                        "depends_on": [],
                    }
                ],
            },
        },
    )
    assert plan.status_code == 200, plan.text
    accepted = tc.post(
        "/v1/workspaces/ws_local/commands",
        headers=_headers(),
        json={
            "command_id": "cmd_f42_accept",
            "type": "plan.accept",
            "payload": {
                "work_id": work_id,
                "expected_version": plan.json()["result"]["version"],
                "plan_revision": plan.json()["result"]["plan_revision"],
            },
        },
    )
    assert accepted.status_code == 200, accepted.text
    version = int(accepted.json()["result"]["version"])
    started = tc.post(
        "/v1/workspaces/ws_local/commands",
        headers=_headers(),
        json={
            "command_id": "cmd_f42_start",
            "type": "work.start",
            "payload": {"work_id": work_id, "expected_version": version, "durable": False},
        },
    )
    assert started.status_code == 200, started.text
    version = int(started.json()["result"]["version"])

    ctx = get_context()
    plans = [p for p in ctx.service.store.plans.values() if p.work_id == work_id]
    step_id = plans[-1].steps[0].id
    req = tc.post(
        "/v1/workspaces/ws_local/commands",
        headers=_headers(),
        json={
            "command_id": "cmd_f42_req",
            "type": "work.request_contribution",
            "payload": {
                "work_id": work_id,
                "expected_version": version,
                "to_actor_id": "person_fabio",
                "need": "Listino",
                "step_id": step_id,
            },
        },
    )
    assert req.status_code == 200, req.text
    request_id = req.json()["result"]["request_id"]
    version = int(req.json()["result"]["version"])

    provided = tc.post(
        "/v1/workspaces/ws_local/commands",
        headers=_headers(),
        json={
            "command_id": "cmd_f42_contrib",
            "type": "work.provide_contribution",
            "payload": {
                "request_id": request_id,
                "expected_version": version,
                "material_ids": [material_id],
            },
        },
    )
    assert provided.status_code == 200, provided.text
    assert material_id in provided.json()["result"]["material_ids"]
