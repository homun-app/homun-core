"""Integration test for the HTTP agent-runs API routes and capability contracts."""
from fastapi.testclient import TestClient
import pytest
from homun.app import create_app
from homun.context import create_context
from homun.domain.models import Actor
from homun.routes import price_comparisons


@pytest.fixture
def api_setup(tmp_path, monkeypatch):
    ctx = create_context(db_path=tmp_path / "ws.db", data_dir=tmp_path, for_tests=True)
    actor = Actor(id="person_owner", workspace_id=ctx.workspace_id, display_name="Owner")
    project = ctx.service.apply(actor, "p", "project.create", {"name": "Test Project"})["project_id"]
    conv = ctx.service.apply(actor, "c", "conversation.create", {"title": "Conv", "project_id": project})["conversation_id"]
    work = ctx.service.apply(actor, "w", "work.create", {
        "conversation_id": conv, "title": "Work", "objective": "Test full capability agent run."
    })["work_id"]
    ctx.models.set_active("openai_compatible")
    ctx.persist()

    monkeypatch.setattr(price_comparisons, "get_context", lambda: ctx)
    client = TestClient(create_app(session_token="t" * 32, session_actor_id=actor.id))
    headers = {"Authorization": "Bearer " + "t" * 32}

    yield ctx, actor, work, client, headers
    ctx.close()


def test_agent_runs_route_preserves_all_capability_flags(api_setup):
    ctx, actor, work_id, client, headers = api_setup
    base_url = f"/v1/workspaces/{ctx.workspace_id}/works/{work_id}/agent-runs"

    payload = {
        "command_id": "run_full_caps",
        "expected_version": 1,
        "material_ids": [],
        "memory": True,
        "skills": True,
        "delegation": True,
        "clarify": True,
        "goals": True,
        "cron": True,
        "session_management": True,
        "gateway": True,
        "code_execution": True,
        "plugins": True,
        "moa": {"preset": "fast", "fanout": "user_turn"},
    }

    resp = client.post(base_url, headers=headers, json=payload)
    assert resp.status_code == 200, resp.text
    data = resp.json()

    # Verify all capabilities were preserved through RunRequest -> propose -> RunView
    assert data["id"] == "run_full_caps"
    assert data["status"] == "pending_approval"
    assert data["memory"] == {"policy": "scoped-workspace-v1", "version": 1}
    assert data["skills"] == {"policy": "workspace-catalog-v1", "version": 1}
    assert data["delegation"] == {"policy": "isolated-subagent-v1", "version": 1}
    assert data["clarify"] == {"policy": "structured-clarify-v1", "version": 1}
    assert data["goals"] == {"policy": "persistent-goals-v1", "version": 1}
    assert data["cron"] == {"policy": "durable-cron-v1", "version": 1}
    assert data["session_management"] == {"policy": "durable-sessions-v1", "version": 1}
    assert data["gateway"] == {"policy": "core-gateway-v1", "version": 1}
    assert data["code_execution"] == {"policy": "programmatic-v1", "version": 1}
    assert data["plugins"] == {"policy": "extensible-plugins-v1", "version": 1}
    assert data["moa"]["policy"] == "mixture-of-agents-v1"
    assert data["moa"]["preset"] == "fast"

    # Verify that the registered tools include the respective tool names
    tool_names = {t["name"] for t in data["tools"]}
    assert "memory_recall" in tool_names
    assert "memory_remember" in tool_names
    assert "skill_search" in tool_names
    assert "delegate_task" in tool_names
    assert "clarify" in tool_names
    assert "goal_set" in tool_names
    assert "cronjob_manage" in tool_names
    assert "session_manage" in tool_names
    assert "gateway_manage" in tool_names
    assert "execute_code" in tool_names

    # Test GET list_runs route preserves capability flags
    list_resp = client.get(base_url, headers=headers)
    assert list_resp.status_code == 200
    items = list_resp.json()["items"]
    assert len(items) == 1
    item = items[0]
    assert item["id"] == "run_full_caps"
    assert item["memory"]["policy"] == "scoped-workspace-v1"
    assert item["skills"]["policy"] == "workspace-catalog-v1"
    assert item["delegation"]["policy"] == "isolated-subagent-v1"
    assert item["clarify"]["policy"] == "structured-clarify-v1"
    assert item["goals"]["policy"] == "persistent-goals-v1"

    # Test approve route
    approve_payload = {
        "command_id": "approve_caps",
        "expected_version": data["expected_version"],
        "digest": data["digest"],
    }
    appr_resp = client.post(f"{base_url}/{data['id']}/approve", headers=headers, json=approve_payload)
    assert appr_resp.status_code == 200, appr_resp.text
    appr_data = appr_resp.json()
    assert appr_data["status"] == "queued"
    assert appr_data["memory"]["policy"] == "scoped-workspace-v1"
    assert appr_data["goals"]["policy"] == "persistent-goals-v1"

    # Test control route
    curr_work_version = ctx.repository.load().works[work_id].version
    ctrl_payload = {
        "command_id": "pause_caps",
        "expected_version": curr_work_version,
        "action": "pause",
    }
    ctrl_resp = client.post(f"{base_url}/{data['id']}/control", headers=headers, json=ctrl_payload)
    assert ctrl_resp.status_code == 200, ctrl_resp.text
    assert ctrl_resp.json()["status"] == "paused"

    # Idempotent double approval returns the existing approved run
    dup_appr = client.post(f"{base_url}/{data['id']}/approve", headers=headers, json=approve_payload)
    assert dup_appr.status_code == 200
    assert dup_appr.json()["id"] == data["id"]


def test_agent_runs_negative_and_validation(api_setup):
    ctx, actor, work_id, client, headers = api_setup
    base_url = f"/v1/workspaces/{ctx.workspace_id}/works/{work_id}/agent-runs"

    # 1. Reject invalid approval digest
    payload = {
        "command_id": "run_neg",
        "expected_version": 1,
        "material_ids": [],
        "memory": True,
    }
    p_resp = client.post(base_url, headers=headers, json=payload)
    assert p_resp.status_code == 200
    p = p_resp.json()

    bad_digest_resp = client.post(f"{base_url}/{p['id']}/approve", headers=headers, json={
        "command_id": "appr_neg",
        "expected_version": p["expected_version"],
        "digest": "0" * 64,
    })
    assert bad_digest_resp.status_code == 409

    # 2. Reject control with invalid action
    bad_ctrl = client.post(f"{base_url}/{p['id']}/control", headers=headers, json={
        "command_id": "bad_ctrl",
        "expected_version": p["expected_version"],
        "action": "invalid_action",
    })
    assert bad_ctrl.status_code == 422


def test_agent_runs_restart_survival(tmp_path, monkeypatch):
    from homun.application.agent_runs import lookup
    db_file = tmp_path / "ws_restart.db"
    ctx = create_context(db_path=db_file, data_dir=tmp_path, for_tests=True)
    actor = Actor(id="person_owner", workspace_id=ctx.workspace_id, display_name="Owner")
    project = ctx.service.apply(actor, "p", "project.create", {"name": "Test Project"})["project_id"]
    conv = ctx.service.apply(actor, "c", "conversation.create", {"title": "Conv", "project_id": project})["conversation_id"]
    work = ctx.service.apply(actor, "w", "work.create", {
        "conversation_id": conv, "title": "Work", "objective": "Restart test."
    })["work_id"]
    ctx.models.set_active("openai_compatible")
    ctx.persist()

    monkeypatch.setattr(price_comparisons, "get_context", lambda: ctx)
    client = TestClient(create_app(session_token="t" * 32, session_actor_id=actor.id))
    headers = {"Authorization": "Bearer " + "t" * 32}
    base_url = f"/v1/workspaces/{ctx.workspace_id}/works/{work}/agent-runs"

    payload = {
        "command_id": "run_restart",
        "expected_version": 1,
        "material_ids": [],
        "memory": True,
        "skills": True,
        "cron": True,
        "goals": True,
    }
    resp = client.post(base_url, headers=headers, json=payload)
    assert resp.status_code == 200
    run_id = resp.json()["id"]

    # Close and reopen repository from SQLite file
    ctx.close()
    ctx2 = create_context(db_path=db_file, data_dir=tmp_path, for_tests=True)
    store2 = ctx2.repository.load()
    reloaded = lookup(store2, run_id, work)
    assert reloaded["id"] == "run_restart"
    assert reloaded["memory"] == {"policy": "scoped-workspace-v1", "version": 1}
    assert reloaded["skills"] == {"policy": "workspace-catalog-v1", "version": 1}
    assert reloaded["cron"] == {"policy": "durable-cron-v1", "version": 1}
    assert reloaded["goals"] == {"policy": "persistent-goals-v1", "version": 1}
    ctx2.close()

