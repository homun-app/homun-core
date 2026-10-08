"""Product wiring for H03 side questions and H04 prompt roots."""
from __future__ import annotations

from pathlib import Path

import pytest

from homun.application.agent_prompt_roots import resolve_prompt_roots
from homun.application.agent_side_questions import answer_side_question
from homun.application.automation_store import AutomationStore, set_automation_store
from homun.application.heartbeat_manager import HeartbeatManager
from homun.application.loop_manager import LoopManager
from homun.domain.errors import ValidationError
from homun.models.native_prompt import initial_messages


def test_prompt_roots_confined_under_agent_workspaces(tmp_path):
    cwd, root = resolve_prompt_roots(tmp_path, "ws1")
    assert root == (tmp_path / "agent-workspaces" / "ws1").resolve()
    assert cwd == root
    (root / "AGENTS.md").write_text("Use concise answers.", encoding="utf-8")
    msgs = initial_messages(
        "Say hi @file:AGENTS.md",
        "Be careful",
        cwd=cwd,
        workspace_root=root,
        expand_refs=True,
    )
    assert "Use concise answers." in msgs[0].content or "Use concise answers." in msgs[1].content


def test_prompt_roots_reject_escape(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    with pytest.raises(ValidationError):
        resolve_prompt_roots(tmp_path, "ws1", workspace_root=str(outside))


def test_heartbeat_and_loop_survive_reopen(tmp_path):
    db = tmp_path / "auto.sqlite"
    store = AutomationStore(db)
    set_automation_store(store)
    HeartbeatManager("s1", min_seconds=10).set("ping", interval_seconds=10)
    LoopManager("s1").set("watch", interval_seconds=30)
    store.close()

    store2 = AutomationStore(db)
    set_automation_store(store2)
    assert HeartbeatManager("s1", min_seconds=10).is_active()
    assert LoopManager("s1").is_active()
    set_automation_store(None)


from test_agent_runs import setup


def test_side_question_does_not_mutate_run_messages(setup):
    from test_native_agent import native_start
    ctx, actor, work, material = setup
    native_start(ctx, actor, work, material)
    before = ctx.repository.load().commands['run'].result['_messages']
    out = answer_side_question(ctx, actor, work, 'run', 'How many rows?',
        model_invoker=lambda messages, max_tokens=1024, tools=None: {
            'text': '3', 'prompt_tokens': 5, 'completion_tokens': 1, 'cost_estimate': 0.0})
    assert out['answer'] == '3' and out['main_transcript_unchanged'] is True
    assert ctx.repository.load().commands['run'].result['_messages'] == before


def test_write_approval_gate_survives_reopen(tmp_path, monkeypatch):
    monkeypatch.setenv("HOMUN_DATA_DIR", str(tmp_path))
    from homun.application.write_approval_gate import WriteApprovalGate

    gate = WriteApprovalGate(pending_dir=tmp_path / "approvals")
    rec = gate.stage_action("memory", "put", {"k": "v"}, summary="store fact")
    action_id = rec.id
    del gate

    gate2 = WriteApprovalGate(pending_dir=tmp_path / "approvals")
    loaded = gate2.get_record(action_id)
    assert loaded is not None
    assert loaded.status == "pending"
    assert loaded.payload == {"k": "v"}


def test_deliverable_ledger_survives_reopen(tmp_path):
    from homun.application.deliverable_ledger import DeliverableLedger

    db = tmp_path / "ledger.sqlite"
    led = DeliverableLedger(db)
    led.record_delivery("s1", "telegram", "/tmp/a.pdf", "a.pdf", "document")
    assert led.is_delivered("s1", "/tmp/a.pdf")
    del led

    led2 = DeliverableLedger(db)
    assert led2.is_delivered("s1", "/tmp/a.pdf")
    assert len(led2.list_receipts("s1")) == 1
