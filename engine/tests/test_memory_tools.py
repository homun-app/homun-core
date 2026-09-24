"""Tests for curated persistent memory tools and session search (H17/H18)."""
from datetime import datetime, timezone
from types import SimpleNamespace
from homun.domain.models import Message
from homun.models.native_turn import NativeMessage, ToolCall
from test_agent_runs import setup


def test_memory_remember_and_recall(setup):
    from homun.application import agent_runs
    from homun.application.memory_tools import execute

    ctx, actor, work, _ = setup
    run = {
        "id": "run_test_mem",
        "work_id": work,
        "memory": {"policy": "scoped-workspace-v1", "version": 1},
    }

    # Remember a new fact
    res1 = execute(ctx, actor, run, "memory_remember", {"text": "Il cliente preferisce report in formato Markdown"})
    assert res1["status"] == "stored"
    assert res1["text"] == "Il cliente preferisce report in formato Markdown"
    note_id = res1["id"]

    # Recall the fact
    res_recall = execute(ctx, actor, run, "memory_recall", {"query": "Markdown"})
    assert res_recall["count"] >= 1
    assert any(m["id"] == note_id for m in res_recall["memories"])

    # Duplicate check: storing the same fact again returns duplicate status
    res_dup = execute(ctx, actor, run, "memory_remember", {"text": "  il cliente preferisce report in formato markdown  "})
    assert res_dup["status"] == "duplicate"
    assert res_dup["id"] == note_id


def test_session_search_with_filters(setup):
    from homun.application.memory_tools import execute

    ctx, actor, work_id, _ = setup
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            conv = store.conversations[store.works[work_id].primary_conversation_id]
            # Add past messages to this conversation
            m1 = Message(
                id="msg_1",
                workspace_id=store.workspace_id,
                conversation_id=conv.id,
                author_id=actor.id,
                text="Discutiamo il piano per il lancio del nuovo portale clienti",
                created_at=datetime(2026, 9, 10, 10, 0, 0, tzinfo=timezone.utc),
            )
            m2 = Message(
                id="msg_2",
                workspace_id=store.workspace_id,
                conversation_id=conv.id,
                author_id=actor.id,
                text="Abbiamo concordato di usare Tailwind CSS e Next.js",
                created_at=datetime(2026, 9, 15, 14, 30, 0, tzinfo=timezone.utc),
            )
            store.messages[m1.id] = m1
            store.messages[m2.id] = m2
        ctx.service.store = store

    run = {
        "id": "run_search",
        "work_id": work_id,
        "memory": {"policy": "scoped-workspace-v1", "version": 1},
    }

    # Query search
    res = execute(ctx, actor, run, "session_search", {"query": "Tailwind"})
    assert res["count"] == 1
    assert res["results"][0]["message_id"] == "msg_2"
    assert "Tailwind CSS" in res["results"][0]["text_excerpt"]

    # Date filter search: from 2026-09-12 onwards
    res_date = execute(ctx, actor, run, "session_search", {"query": "portale", "from_date": "2026-09-12"})
    assert res_date["count"] == 0  # msg_1 was on 2026-09-10

    res_all_dates = execute(ctx, actor, run, "session_search", {"query": "portale", "from_date": "2026-09-01", "to_date": "2026-09-11"})
    assert res_all_dates["count"] == 1
    assert res_all_dates["results"][0]["message_id"] == "msg_1"


def test_agent_run_advances_with_memory_tool(setup):
    from homun.application import agent_runs
    from homun.application.agent_run_execution import advance

    ctx, actor, work, _ = setup
    ctx.models.set_active("openai_compatible")

    # Seed an approved memory note
    ctx.memory.add_approved(
        text="Standard aziendale: consegna in tre capitoli",
        actor_id=actor.id,
        work_id=work,
    )

    # Propose run with memory=True
    proposal = agent_runs.propose(ctx, actor, work, {
        "command_id": "run_mem",
        "expected_version": 1,
        "material_ids": [],
        "memory": True,
    })
    tool_names = [t["name"] for t in proposal["tools"]]
    assert proposal["memory"] == {"policy": "scoped-workspace-v1", "version": 1}
    assert "memory_recall" in tool_names
    assert "memory_remember" in tool_names
    assert "session_search" in tool_names

    agent_runs.approve(ctx, actor, work, proposal["id"], {
        "command_id": "approve_mem",
        "digest": proposal["digest"],
        "expected_version": proposal["expected_version"],
    })

    # Model completes tool call to memory_recall
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(
        message=NativeMessage(
            role="assistant",
            tool_calls=[ToolCall(id="call_m1", name="memory_recall", arguments={"query": "Standard aziendale"})],
        ),
        usage=None,
    )

    assert advance(ctx, proposal["id"]) == "running"
    cmd = ctx.repository.load().commands[proposal["id"]]
    obs = cmd.result["observations"][-1]
    assert obs["tool"] == "memory_recall"
    assert any("tre capitoli" in m["text"] for m in obs["result"]["memories"])


def test_memory_validation_and_capacity(setup, monkeypatch):
    from homun.application.memory_tools import execute
    import homun.application.memory_tools as mem_module

    ctx, actor, work, _ = setup
    run = {
        "id": "run_cap",
        "work_id": work,
        "memory": {"policy": "scoped-workspace-v1", "version": 1},
    }

    # Empty text error
    res_empty = execute(ctx, actor, run, "memory_remember", {"text": "   "})
    assert res_empty["error_code"] == "invalid_memory"

    # Invalid date format in session_search
    import pytest
    from homun.domain.errors import ValidationError
    with pytest.raises(ValidationError):
        execute(ctx, actor, run, "session_search", {"query": "test", "from_date": "invalid-date"})

    # Capacity limit reached
    monkeypatch.setattr(mem_module, "MAX_MEMORY_CAPACITY", 2)
    execute(ctx, actor, run, "memory_remember", {"text": "Nota 1"})
    execute(ctx, actor, run, "memory_remember", {"text": "Nota 2"})
    res_cap = execute(ctx, actor, run, "memory_remember", {"text": "Nota 3"})
    assert res_cap["error_code"] == "memory_capacity_exceeded"

