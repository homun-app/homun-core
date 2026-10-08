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


def test_agent_runs_control_lifecycle_and_steering(api_setup):
    ctx, actor, work_id, client, headers = api_setup
    base_url = f"/v1/workspaces/{ctx.workspace_id}/works/{work_id}/agent-runs"

    payload = {
        "command_id": "run_ctrl_test",
        "expected_version": 1,
        "material_ids": [],
    }
    resp = client.post(base_url, headers=headers, json=payload)
    assert resp.status_code == 200
    run_data = resp.json()

    # Approve the run
    appr_resp = client.post(
        f"{base_url}/{run_data['id']}/approve",
        headers=headers,
        json={
            "command_id": "appr_ctrl_test",
            "expected_version": run_data["expected_version"],
            "digest": run_data["digest"],
        },
    )
    assert appr_resp.status_code == 200

    # 1. Pause
    work_ver = ctx.repository.load().works[work_id].version
    pause_resp = client.post(
        f"{base_url}/{run_data['id']}/control",
        headers=headers,
        json={"command_id": "ctrl_pause", "expected_version": work_ver, "action": "pause"},
    )
    assert pause_resp.status_code == 200
    assert pause_resp.json()["status"] == "paused"

    # 2. Steer while paused
    work_ver = ctx.repository.load().works[work_id].version
    steer_resp = client.post(
        f"{base_url}/{run_data['id']}/control",
        headers=headers,
        json={
            "command_id": "ctrl_steer",
            "expected_version": work_ver,
            "action": "steer",
            "text": "Focus on section 2",
        },
    )
    assert steer_resp.status_code == 200

    # 3. Resume
    work_ver = ctx.repository.load().works[work_id].version
    resume_resp = client.post(
        f"{base_url}/{run_data['id']}/control",
        headers=headers,
        json={"command_id": "ctrl_resume", "expected_version": work_ver, "action": "resume"},
    )
    assert resume_resp.status_code == 200
    assert resume_resp.json()["status"] == "queued"

    # 4. Cancel
    work_ver = ctx.repository.load().works[work_id].version
    cancel_resp = client.post(
        f"{base_url}/{run_data['id']}/control",
        headers=headers,
        json={"command_id": "ctrl_cancel", "expected_version": work_ver, "action": "cancel"},
    )
    assert cancel_resp.status_code == 200
    assert cancel_resp.json()["status"] == "cancelled"


def test_agent_runs_terminal_wait_id_view(api_setup):
    ctx, actor, work_id, client, headers = api_setup
    base_url = f"/v1/workspaces/{ctx.workspace_id}/works/{work_id}/agent-runs"

    payload = {
        "command_id": "run_term_wait",
        "expected_version": 1,
        "material_ids": [],
    }
    resp = client.post(base_url, headers=headers, json=payload)
    assert resp.status_code == 200
    run_id = resp.json()["id"]

    # In store, simulate transition to waiting_external with terminal_wait_id
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            run = store.commands[run_id].result
            run["status"] = "waiting_external"
            run["terminal_wait_id"] = "term_sess_xyz"
        ctx.service.store = store

    # GET list_runs returns terminal_wait_id in RunView
    list_resp = client.get(base_url, headers=headers)
    assert list_resp.status_code == 200
    matching = [r for r in list_resp.json()["items"] if r["id"] == run_id]
    assert len(matching) == 1
    assert matching[0]["status"] == "waiting_external"
    assert matching[0]["terminal_wait_id"] == "term_sess_xyz"


@pytest.mark.parametrize("known_usage,attempt_cap", [(False, 8), (True, 8), (True, 1)])
def test_agent_runs_fallback_connection_and_failover(api_setup, monkeypatch, known_usage, attempt_cap):
    from types import SimpleNamespace
    from homun.models.port import Connection
    from homun.models.native_errors import NativeModelError, RATE_LIMITED
    from homun.models.native_turn import NativeMessage
    from homun.application.agent_run_execution import advance

    ctx, actor, work_id, client, headers = api_setup
    base_url = f"/v1/workspaces/{ctx.workspace_id}/works/{work_id}/agent-runs"

    secondary_conn = Connection(
        id="secondary_provider",
        kind="openai_compatible",
        display_name="Secondary Provider",
        model_id="secondary-model",
        base_url="http://127.0.0.1:8000/v1",
        credential_present=True,
        context_window=8192, max_output_tokens=1024,
        active=True,
    )
    orig_get_connection = ctx.models.get_connection
    def custom_get_connection(cid):
        if cid == "secondary_provider":
            return secondary_conn
        return orig_get_connection(cid)
    monkeypatch.setattr(ctx.models, "get_connection", custom_get_connection)

    # 1. Propose run with fallback_connection_id
    payload = {
        "command_id": "run_with_failover",
        "expected_version": 1,
        "material_ids": [],
        "fallback_connection_id": "secondary_provider",
    }
    resp = client.post(base_url, headers=headers, json=payload)
    assert resp.status_code == 200, resp.text
    run_view = resp.json()
    assert run_view["id"] == "run_with_failover"
    assert run_view["connection_id"] == "openai_compatible"
    assert run_view["fallback_connection_id"] == "secondary_provider"

    # 2. Approve run
    approve_resp = client.post(
        f"{base_url}/run_with_failover/approve",
        headers=headers,
        json={
            "command_id": "appr_failover",
            "expected_version": run_view["expected_version"],
            "digest": run_view["digest"],
        },
    )
    assert approve_resp.status_code == 200

    with ctx.repository.transaction() as store:
        store.commands["run_with_failover"].result["limits"]["max_model_attempts"] = attempt_cap
    from homun.models.types import UsageEntry
    primary_usage = UsageEntry(id="primary", provider_id="primary", model_id="m", input_tokens=7, output_tokens=2) if known_usage else None
    secondary_usage = UsageEntry(id="secondary", provider_id="secondary", model_id="m", input_tokens=11, output_tokens=3) if known_usage else None

    # 3. Simulate complete_tools: primary fails with 429 RATE_LIMITED, secondary succeeds
    attempts = []
    def mock_complete_tools(messages, **kwargs):
        conn_id = kwargs.get("connection_id")
        attempts.append(conn_id)
        if conn_id != "secondary_provider":
            raise NativeModelError(RATE_LIMITED, "Rate limit exceeded (429)", status_code=429, usage=primary_usage)
        return SimpleNamespace(message=NativeMessage(role="assistant", content="Answer from secondary"), usage=secondary_usage)

    monkeypatch.setattr(ctx.models, "complete_tools", mock_complete_tools)

    # 4. Advance execution turn
    outcome = advance(ctx, "run_with_failover")
    if attempt_cap == 1:
        assert outcome == "failed"
        assert attempts == ["openai_compatible"]
        budget = ctx.repository.load().work_budgets[work_id]
        assert budget.spent.input_tokens == 7
        assert budget.spent.attempts == 1
        assert not budget.pending
        return
    assert outcome == "completed"
    assert attempts == ["openai_compatible", "secondary_provider"]
    budget = ctx.repository.load().work_budgets[work_id]
    assert budget.unknown.attempts == (0 if known_usage else 2)
    if known_usage:
        assert budget.spent.input_tokens == 18
        assert budget.spent.output_tokens == 5
        assert budget.spent.attempts == 2
    assert not budget.pending
    assert ctx.repository.load().commands['run_with_failover'].result['model_attempts'] == 2
    persisted = ctx.repository.load().commands["run_with_failover"].result
    assert persisted["_context_policy"] == {"context_window":8192, "max_output_tokens":1024}

    # 5. Verify persisted run and RunView
    list_resp = client.get(base_url, headers=headers)
    assert list_resp.status_code == 200
    run_after = next(r for r in list_resp.json()["items"] if r["id"] == "run_with_failover")
    assert run_after["connection_id"] == "secondary_provider"
    assert run_after["fallback_connection_id"] == "secondary_provider"
    assert "recovery" in run_after
    assert run_after["recovery"]["failover"]["from_connection"] == "openai_compatible"
    assert run_after["recovery"]["failover"]["to_connection"] == "secondary_provider"
    assert run_after["recovery"]["failover"]["reason"] == RATE_LIMITED


def test_agent_runs_side_question_endpoint(api_setup, monkeypatch):
    from types import SimpleNamespace
    from homun.models.native_turn import NativeMessage

    ctx, actor, work_id, client, headers = api_setup
    base_url = f"/v1/workspaces/{ctx.workspace_id}/works/{work_id}/agent-runs"

    # 1. Propose and approve run
    resp = client.post(base_url, headers=headers, json={"command_id": "run_side_q", "expected_version": 1, "material_ids": []})
    assert resp.status_code == 200
    rv = resp.json()
    appr = client.post(
        f"{base_url}/run_side_q/approve",
        headers=headers,
        json={"command_id": "appr_side", "expected_version": rv["expected_version"], "digest": rv["digest"]},
    )
    assert appr.status_code == 200

    # 2. Put run in active running state with messages
    with ctx.repository.transaction() as store:
        store.commands["run_side_q"].result["status"] = "running"
        store.commands["run_side_q"].result["_messages"] = [
            {"role": "user", "content": "Process invoices"},
            {"role": "assistant", "content": "I found 5 invoices."},
        ]

    # 3. Mock complete_summary for side question
    monkeypatch.setattr(
        ctx.models,
        "complete_summary",
        lambda msgs, **kw: SimpleNamespace(
            message=NativeMessage(role="assistant", content="The total is 5 invoices."),
            usage=SimpleNamespace(input_tokens=15, output_tokens=8, estimated_cost=0.0002),
        ),
    )

    # 4. Ask side question via HTTP endpoint
    side_resp = client.post(
        f"{base_url}/run_side_q/side-question",
        headers=headers,
        json={"question": "What is the count?"},
    )
    assert side_resp.status_code == 200, side_resp.text
    side_data = side_resp.json()
    assert side_data["answer"] == "The total is 5 invoices."
    assert side_data["main_transcript_unchanged"] is True
    assert side_data["usage"]["prompt_tokens"] == 15
    assert side_data["usage"]["completion_tokens"] == 8

    # 5. Verify main run messages remain intact
    store = ctx.repository.load()
    main_run = store.commands["run_side_q"].result
    assert len(main_run["_messages"]) == 2
