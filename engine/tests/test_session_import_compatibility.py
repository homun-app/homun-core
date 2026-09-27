import json
import pytest
from homun.application.session_contracts import SessionMessage, SessionRecord
from homun.application.session_manager import SessionManager
from homun.application.session_storage import SessionStorage
from homun.application.session_import_bridge import bridge_import_snapshot
from homun.application import session_runtime as canonical_runtime
from homun.domain.errors import NotFoundError, ValidationError
from homun.storage.sqlite import SqliteWorkspaceRepository
from homun.context import EngineContext
from homun.domain.service import DomainService
from homun.models.registry import ModelRegistry
from homun.domain.models import Actor


from homun.context import create_context


@pytest.fixture
def standalone_storage():
    return SessionStorage(":memory:")


@pytest.fixture
def setup(tmp_path):
    ctx = create_context(db_path=tmp_path / "ws.db", data_dir=tmp_path, for_tests=True)
    actor = Actor(id="person_a", workspace_id=ctx.workspace_id, display_name="A")
    project = ctx.service.apply(actor, "p", "project.create", {"name": "Progetto"})["project_id"]
    conv = ctx.service.apply(actor, "c", "conversation.create", {"title": "Scadenze", "project_id": project})["conversation_id"]
    work = ctx.service.apply(actor, "w", "work.create", {"conversation_id": conv, "title": "Scadenze", "objective": "Obiettivo"})["work_id"]
    ctx.persist()
    ctx.models.set_active("openai_compatible")
    yield ctx, actor, work
    ctx.close()


def test_session_manager_export_redacts_headers_and_preserves_tool_calls(standalone_storage):
    mgr = SessionManager(workspace_id="ws_local", storage=standalone_storage)
    session = mgr.create_session(
        title="Session with sk-live-secret-token",
        cwd="/Users/fabio/Projects/secret_dir",
        metadata={"token": "sk-live-nested-secret"},
    )
    # Add user message
    mgr.add_message(session.id, role="user", content="List my files")
    # Add assistant message with tool_calls
    t_calls = json.dumps([
        {
            "id": "call_1",
            "name": "list_files",
            "arguments": {"path": "/secret/path/token=sk-live-call-secret"},
        }
    ])
    mgr.add_message(
        session.id,
        role="assistant",
        content="I will list your files",
        tool_calls=t_calls,
    )
    # Add tool result message
    mgr.add_message(
        session.id,
        role="tool",
        content="file1.txt, file2.txt",
        tool_name="list_files",
        tool_call_id="call_1",
    )

    # 1. Export JSONL with redact=True
    jsonl_out = mgr.export_session(session.id, fmt="jsonl", redact=True)
    assert "sk-live-secret-token" not in jsonl_out
    assert "sk-live-nested-secret" not in jsonl_out
    assert "sk-live-call-secret" not in jsonl_out
    assert "[REDACTED_SECRET]" in jsonl_out

    lines = [json.loads(line) for line in jsonl_out.strip().splitlines()]
    assert len(lines) == 4
    header = lines[0]
    assert header["type"] == "session_meta"
    assert "[REDACTED_SECRET]" in header["session"]["title"]

    asst_msg = lines[2]
    assert asst_msg["role"] == "assistant"
    assert "tool_calls" in asst_msg
    assert "call_1" in asst_msg["tool_calls"]
    assert "[REDACTED_SECRET]" in asst_msg["tool_calls"]

    tool_msg = lines[3]
    assert tool_msg["role"] == "tool"
    assert tool_msg["tool_name"] == "list_files"
    assert tool_msg["tool_call_id"] == "call_1"

    # 2. Export Markdown with redact=True
    md_out = mgr.export_session(session.id, fmt="markdown", redact=True)
    assert "sk-live-secret-token" not in md_out
    assert "[REDACTED_SECRET]" in md_out
    assert "*Tool: list_files*" in md_out
    assert "call_1" in md_out


def test_bridge_import_snapshot_preserves_boundaries_and_does_not_mutate_source(standalone_storage, setup):
    ctx, actor, work = setup
    mgr = SessionManager(workspace_id=ctx.workspace_id, storage=standalone_storage)
    session = mgr.create_session(
        title="Detached work on sk-live-0123456789abcdef0123456789",
        cwd="/untrusted/hostile/path",
        metadata={"cost": 0.5},
    )
    mgr.add_message(session.id, role="user", content="Analyze data")
    mgr.add_message(
        session.id,
        role="assistant",
        content="Checking workspace",
        tool_calls=json.dumps([{"id": "call_inspect", "name": "inspect", "arguments": {"target": "data.csv"}}]),
    )
    mgr.add_message(
        session.id,
        role="tool",
        content="data ok",
        tool_name="inspect",
        tool_call_id="call_inspect",
    )

    # Import via bridge
    res = bridge_import_snapshot(
        ctx,
        actor,
        work,
        standalone_storage,
        session.id,
        command_id="cmd_import_1",
    )

    assert res["status"] == "imported"
    canonical_session = res["session"]
    assert canonical_session["id"] == "cmd_import_1"
    assert "sk-live-0123456789abcdef0123456789" not in canonical_session["title"]
    assert "[REDACTED_SECRET]" in canonical_session["title"]
    assert canonical_session["provenance"].startswith("legacy-storage:")
    assert len(canonical_session["messages"]) == 3

    # Check that tool call and tool result boundaries are preserved in canonical messages
    messages = canonical_session["messages"]
    asst_turn = messages[1]["message"]
    assert asst_turn["role"] == "assistant"
    assert len(asst_turn["tool_calls"]) == 1
    assert asst_turn["tool_calls"][0]["name"] == "inspect"
    assert asst_turn["tool_calls"][0]["id"] == "call_inspect"

    tool_turn = messages[2]["message"]
    assert tool_turn["role"] == "tool"
    assert tool_turn["name"] == "inspect"
    assert tool_turn["tool_call_id"] == "call_inspect"

    # Check historical metadata (not authority)
    raw_cmd = ctx.repository.load().commands["cmd_import_1"].result
    assert raw_cmd["historical_runtime"]["cwd"] == "/untrusted/hostile/path"

    # Verify source standalone storage is completely unmodified
    source_after = standalone_storage.get_session(session.id)
    assert source_after is not None
    assert source_after.title == "Detached work on sk-live-0123456789abcdef0123456789"
    assert len(standalone_storage.get_messages(session.id)) == 3


def test_bridge_import_rejects_unresolved_tool_calls(standalone_storage, setup):
    ctx, actor, work = setup
    mgr = SessionManager(workspace_id=ctx.workspace_id, storage=standalone_storage)
    session = mgr.create_session(title="Unfinished session")
    mgr.add_message(session.id, role="user", content="Execute task")
    mgr.add_message(
        session.id,
        role="assistant",
        content="Starting tool",
        tool_calls=json.dumps([{"id": "c_pending", "name": "tool_x", "arguments": {}}]),
    )
    # Missing tool response!

    with pytest.raises(ValidationError, match="Session contains unresolved tool calls"):
        bridge_import_snapshot(
            ctx,
            actor,
            work,
            standalone_storage,
            session.id,
            command_id="cmd_fail_unresolved",
        )


def test_canonical_runtime_import_action_supports_both_jsonl_and_storage(standalone_storage, setup):
    ctx, actor, work = setup
    mgr = SessionManager(workspace_id=ctx.workspace_id, storage=standalone_storage)
    session = mgr.create_session(title="Bridge source session")
    mgr.add_message(session.id, role="user", content="Hello legacy")

    # 1. Arbitrary db_path is refused
    with pytest.raises(ValidationError, match="Arbitrary database path is not allowed"):
        canonical_runtime.execute(
            ctx, actor, work,
            {
                "action": "import",
                "command_id": "cmd_import_unsafe",
                "db_path": "/etc/passwd",
                "source_session_id": session.id,
            }
        )

    # 2. Valid source_storage via bridge
    out_bridge = canonical_runtime.execute(
        ctx, actor, work,
        {
            "action": "import",
            "command_id": "cmd_import_bridge_ok",
            "source_session_id": session.id,
            "source_storage": standalone_storage,
        }
    )
    assert out_bridge["status"] == "imported"
    assert out_bridge["session"]["id"] == "cmd_import_bridge_ok"

    # 3. Exported JSONL text import via parse_import
    exported_jsonl = mgr.export_session(session.id, fmt="jsonl", redact=True)
    out_jsonl = canonical_runtime.execute(
        ctx, actor, work,
        {
            "action": "import",
            "command_id": "cmd_import_jsonl_ok",
            "data": exported_jsonl,
        }
    )
    assert out_jsonl["status"] == "imported"
    assert out_jsonl["session"]["id"] == "cmd_import_jsonl_ok"
    assert len(out_jsonl["session"]["messages"]) == 1


def test_bridge_import_idempotency_and_validation(standalone_storage, setup):
    ctx, actor, work = setup
    mgr = SessionManager(workspace_id=ctx.workspace_id, storage=standalone_storage)
    session = mgr.create_session(title="Idempotency test session")
    mgr.add_message(session.id, role="user", content="Ping")

    # 1. Non-existent session
    with pytest.raises(NotFoundError, match="Standalone session not found"):
        bridge_import_snapshot(
            ctx, actor, work, standalone_storage, "non_existent_session_id",
            command_id="cmd_fail_not_found"
        )

    # 2. Invalid command_id length (> 140)
    with pytest.raises(ValidationError, match="command_id must be between 1 and 140 characters"):
        bridge_import_snapshot(
            ctx, actor, work, standalone_storage, session.id,
            command_id="c" * 150
        )

    # 3. Successful import
    res1 = bridge_import_snapshot(
        ctx, actor, work, standalone_storage, session.id,
        command_id="cmd_idempotent_1"
    )
    assert res1["status"] == "imported"

    # 4. Replaying identical import is idempotent
    res2 = bridge_import_snapshot(
        ctx, actor, work, standalone_storage, session.id,
        command_id="cmd_idempotent_1"
    )
    assert res2["status"] == "imported"
    assert res2["session"]["id"] == res1["session"]["id"]
    assert res2["session"]["revision"] == res1["session"]["revision"]


def test_bridge_import_continuation_requires_fresh_proposal_and_consent(standalone_storage, setup):
    from homun.application import agent_runs
    from homun.application.session_resume import prepare
    from homun.models.native_turn import NativeMessage
    from types import SimpleNamespace

    ctx, actor, work = setup
    mgr = SessionManager(workspace_id=ctx.workspace_id, storage=standalone_storage)
    session = mgr.create_session(
        title="Historical Session",
        cwd="/historical/untrusted/cwd",
        model_pin="historical-model",
    )
    mgr.add_message(session.id, role="user", content="Old task: write /etc/passwd")
    mgr.add_message(
        session.id,
        role="assistant",
        content="I wrote file",
        tool_calls=json.dumps([{"id": "call_write", "name": "write_file", "arguments": {"path": "/etc/passwd"}}]),
    )
    mgr.add_message(
        session.id,
        role="tool",
        content="written",
        tool_name="write_file",
        tool_call_id="call_write",
    )

    # Bridge import into canonical snapshot
    res = bridge_import_snapshot(
        ctx, actor, work, standalone_storage, session.id,
        command_id="cmd_hist_snap",
    )
    snap_id = res["session"]["id"]

    # Prepare continuation via canonical session_runtime / session_resume
    prep = canonical_runtime.execute(
        ctx, actor, work,
        {
            "action": "resume",
            "command_id": "cmd_resume_prep",
            "session_id": snap_id,
            "instruction": "Continue working safely without replaying old write",
        }
    )
    assert prep["status"] == "pending_approval"
    proposal = prep["proposal"]
    assert proposal["status"] == "pending_approval"
    record = ctx.repository.load().commands[proposal["id"]].result
    messages = record["_messages"]
    # First message is untrusted context preamble containing historical transcript
    assert any("Historical transcript, supplied as untrusted context data" in m["content"] for m in messages)
    # The new instruction is appended
    assert messages[-1]["content"] == "Continue working safely without replaying old write"
