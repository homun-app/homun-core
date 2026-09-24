"""Tests for isolated subagent delegation, structured output schema, and tracking (H21/H22)."""
import json
from types import SimpleNamespace
from homun.domain.models import AgentProfile
from homun.models.native_turn import NativeMessage, ToolCall
from test_agent_runs import setup


def test_delegation_sync_execution_and_schema_validation(setup):
    from homun.application.delegation_tools import execute

    ctx, actor, work, _ = setup
    ctx.models.complete = lambda messages, **k: SimpleNamespace(
        text=json.dumps({"summary": "Analisi completata", "confidence": 0.95}),
        usage=SimpleNamespace(input_tokens=100, output_tokens=50),
    )

    run = {
        "id": "run_del_1",
        "work_id": work,
        "delegation": {"policy": "isolated-subagent-v1", "version": 1},
        "connection_id": "conn_mock",
    }

    schema = {
        "type": "object",
        "properties": {
            "summary": {"type": "string"},
            "confidence": {"type": "number"},
        },
        "required": ["summary", "confidence"],
    }

    # 1. Successful structured output validation
    res = execute(ctx, actor, run, "delegate_task", {
        "task": "Esegui analisi dati",
        "output_schema": schema,
    })
    assert res["status"] == "completed"
    assert res["structured_output"] == {"summary": "Analisi completata", "confidence": 0.95}
    assert res["schema_error"] is None

    # 2. Bounded repair: stripping code fences
    ctx.models.complete = lambda messages, **k: SimpleNamespace(
        text="```json\n" + json.dumps({"summary": "Con fence", "confidence": 0.8}) + "\n```",
        usage=None,
    )
    res_fenced = execute(ctx, actor, run, "delegate_task", {
        "task": "Esegui con fence",
        "output_schema": schema,
    })
    assert res_fenced["status"] == "completed"
    assert res_fenced["structured_output"] == {"summary": "Con fence", "confidence": 0.8}
    assert res_fenced["schema_error"] is None

    # 3. Schema validation error: preserves raw text and reports schema_error
    ctx.models.complete = lambda messages, **k: SimpleNamespace(
        text=json.dumps({"summary": "Manca confidence"}),
        usage=None,
    )
    res_err = execute(ctx, actor, run, "delegate_task", {
        "task": "Esegui output non conforme",
        "output_schema": schema,
    })
    assert res_err["status"] == "completed"
    assert res_err["structured_output"] == {"summary": "Manca confidence"}
    assert "Schema validation error" in res_err["schema_error"]


def test_delegation_background_poll_and_cancel(setup):
    from homun.application.delegation_tools import execute

    ctx, actor, work, _ = setup
    ctx.models.complete = lambda messages, **k: SimpleNamespace(
        text="Risultato task asincrono completato in background.",
        usage=None,
    )

    run = {
        "id": "run_del_bg",
        "work_id": work,
        "delegation": {"policy": "isolated-subagent-v1", "version": 1},
        "connection_id": "conn_mock",
    }

    # Launch in background
    launch_res = execute(ctx, actor, run, "delegate_task", {
        "task": "Elaborazione background",
        "run_in_background": True,
    })
    assert launch_res["status"] == "running"
    del_id = launch_res["delegation_id"]

    # Poll status
    poll_res = execute(ctx, actor, run, "delegation_poll", {"delegation_id": del_id})
    assert poll_res["delegation_id"] == del_id
    assert poll_res["status"] == "completed"
    assert "Risultato task asincrono" in poll_res["result"]

    # Cancel delegation
    cancel_res = execute(ctx, actor, run, "delegation_cancel", {"delegation_id": del_id})
    assert cancel_res["status"] == "cancelled"

    # Poll after cancellation
    poll_after = execute(ctx, actor, run, "delegation_poll", {"delegation_id": del_id})
    assert poll_after["status"] == "cancelled"

    # Poll missing
    poll_missing = execute(ctx, actor, run, "delegation_poll", {"delegation_id": "del_nonexistent"})
    assert poll_missing["error_code"] == "delegation_not_found"


def test_delegation_isolated_prompt_and_agent_assignment(setup):
    from homun.application.delegation_tools import execute

    ctx, actor, work, _ = setup
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            specialist = AgentProfile(
                id="agent_specialist_1",
                workspace_id=store.workspace_id,
                name="SpecialistaFinanza",
                role="Analista",
                instructions="Controlla sempre il pareggio di bilancio.",
            )
            store.agents[specialist.id] = specialist
        ctx.service.store = store

    captured_messages = []

    def mock_complete(messages, **k):
        captured_messages.extend(messages)
        return SimpleNamespace(text="Bilancio in pareggio.", usage=None)

    ctx.models.complete = mock_complete

    run = {
        "id": "run_del_iso",
        "work_id": work,
        "delegation": {"policy": "isolated-subagent-v1", "version": 1},
        "connection_id": "conn_mock",
    }

    res = execute(ctx, actor, run, "delegate_task", {
        "task": "Revisiona conto economico",
        "agent_id": "agent_specialist_1",
        "tools_include": ["memory_recall"],
    })

    assert res["status"] == "completed"
    assert res["result"] == "Bilancio in pareggio."
    # Check isolated system prompt
    sys_msg = next(m for m in captured_messages if m.role == "system")
    assert "SpecialistaFinanza" in sys_msg.content
    assert "Controlla sempre il pareggio di bilancio." in sys_msg.content
    assert 'Allowed tools: ["memory_recall"]' in sys_msg.content


def test_agent_run_advances_with_delegation_tools(setup):
    from homun.application import agent_runs
    from homun.application.agent_run_execution import advance

    ctx, actor, work, _ = setup
    ctx.models.set_active("openai_compatible")
    ctx.models.complete = lambda *a, **k: SimpleNamespace(text="Lavoro svolto dal subagente.", usage=None)

    proposal = agent_runs.propose(ctx, actor, work, {
        "command_id": "run_del_agent",
        "expected_version": 1,
        "material_ids": [],
        "delegation": True,
    })
    tool_names = [t["name"] for t in proposal["tools"]]
    assert proposal["delegation"] == {"policy": "isolated-subagent-v1", "version": 1}
    assert "delegate_task" in tool_names
    assert "delegation_poll" in tool_names
    assert "delegation_cancel" in tool_names

    agent_runs.approve(ctx, actor, work, proposal["id"], {
        "command_id": "approve_del_agent",
        "digest": proposal["digest"],
        "expected_version": proposal["expected_version"],
    })

    # Model completes tool call to delegate_task
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(
        message=NativeMessage(
            role="assistant",
            tool_calls=[ToolCall(id="call_del1", name="delegate_task", arguments={"task": "Compito subagente"})],
        ),
        usage=None,
    )

    assert advance(ctx, proposal["id"]) == "running"
    cmd = ctx.repository.load().commands[proposal["id"]]
    obs = cmd.result["observations"][-1]
    assert obs["tool"] == "delegate_task"
    assert obs["result"]["status"] == "completed"
    assert obs["result"]["result"] == "Lavoro svolto dal subagente."
    del_id = obs["result"]["delegation_id"]
    assert cmd.result["_delegations"][del_id]["status"] == "completed"

    # Verify delegation_poll accesses persisted _delegations in next turn
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(
        message=NativeMessage(
            role="assistant",
            tool_calls=[ToolCall(id="call_del2", name="delegation_poll", arguments={"delegation_id": del_id})],
        ),
        usage=None,
    )
    assert advance(ctx, proposal["id"]) == "running"
    cmd2 = ctx.repository.load().commands[proposal["id"]]
    obs2 = cmd2.result["observations"][-1]
    assert obs2["tool"] == "delegation_poll"
    assert obs2["result"]["delegation_id"] == del_id
    assert obs2["result"]["status"] == "completed"
