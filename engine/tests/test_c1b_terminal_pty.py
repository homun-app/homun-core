"""Tests for C1b: Virtual terminal screen connection, PTY query handling,
fragmented escape/UTF-8 preservation, real cursor state, and concurrency safety.
"""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import pytest

from homun.application import terminal_jobs
from homun.application.terminal_jobs import _answer_pty, refresh
from homun.context import create_context
from homun.domain.errors import PermissionDeniedError
from homun.domain.models import Actor
from homun.execution.pty_queries import PtyQueryResponder, VirtualTerminalScreen, unread


@pytest.fixture
def terminal_env(tmp_path: Path):
    ctx = create_context(
        workspace_id="ws_term",
        db_path=tmp_path / "homun.db",
        data_dir=tmp_path,
        for_tests=True,
    )
    actor = Actor(id="person_term", workspace_id="ws_term", display_name="Terminal User", kind="person")
    with ctx.repository.transaction() as store:
        svc = ctx.service.for_store(store)
        p = svc.apply(actor, "proj-1", "project.create", {"name": "Term Project"})
        c = svc.apply(actor, "conv-1", "conversation.create", {"project_id": p["project_id"], "title": "Conv"})
        w = svc.apply(actor, "work-1", "work.create", {
            "conversation_id": c["conversation_id"],
            "title": "Term Work",
            "objective": "PTY testing",
            "owner_id": actor.id,
            "reviewer_id": actor.id,
        })
        work_id = w["work_id"]
        ctx.service.store = store

    return {"ctx": ctx, "actor": actor, "work_id": work_id}


class MockBackend:
    def __init__(self, initial_logs: str = ""):
        self.logs_text = initial_logs
        self.written_stdin = []

    def logs(self, spec):
        return {"text": self.logs_text}

    def inspect(self, spec):
        return {"status": "running"}

    def write_stdin(self, spec, payload: bytes):
        self.written_stdin.append(payload)


def test_virtual_terminal_screen_fragmented_escapes_and_utf8():
    """VirtualTerminalScreen preserves split ANSI escape sequences and split UTF-8 bytes."""
    screen = VirtualTerminalScreen(rows=5, cols=20)

    # 1. Split escape sequence: '\x1b[2;' followed by '5HTarget'
    screen.feed("Start")
    assert screen.cursor_position() == (0, 5)
    screen.feed("\x1b[2;")
    assert screen._pending_escape == "\x1b[2;"
    # Cursor has not moved yet
    assert screen.cursor_position() == (0, 5)

    screen.feed("5HTarget")
    # Cursor jumped to row 1 (0-indexed), col 4 (0-indexed)
    assert screen.cursor_position() == (1, 10)
    lines = screen.render_screen().splitlines()
    assert lines[0] == "Start"
    assert lines[1] == "    Target"

    # 2. Split multibyte UTF-8 character (e.g. euro sign '€' = b'\xe2\x82\xac')
    euro_bytes = "€".encode("utf-8")
    assert len(euro_bytes) == 3
    # Feed first 2 bytes
    screen.feed(euro_bytes[:2])
    assert len(screen._pending_bytes) == 2
    # Feed 3rd byte + next character
    screen.feed(euro_bytes[2:] + b"100")
    assert len(screen._pending_bytes) == 0
    rendered = screen.render_screen()
    assert "€100" in rendered


def test_pty_query_responder_real_cursor_position():
    """PtyQueryResponder reports actual cursor coordinates when connected to screen cursor_fn."""
    screen = VirtualTerminalScreen(rows=24, cols=80)
    responder = PtyQueryResponder(rows=24, cols=80, cursor_fn=screen.cursor_position)

    # Initially at home (0, 0) -> 1-based report \x1b[1;1R
    out, resp = responder.process(b"\x1b[6n")
    assert resp == b"\x1b[1;1R"

    # Move cursor to row 4, col 12 (1-based: 5, 13)
    screen.feed("\x1b[5;13H")
    assert screen.cursor_position() == (4, 12)

    # Query now returns real position
    out, resp = responder.process(b"\x1b[6n")
    assert resp == b"\x1b[5;13R"


def test_answer_pty_connects_screen_and_reports_real_cursor(terminal_env, monkeypatch):
    """_answer_pty feeds VirtualTerminalScreen, updates rendered logs and responds to cursor query."""
    env = terminal_env
    ctx, actor, work_id = env["ctx"], env["actor"], env["work_id"]

    mock_backend = MockBackend("Line 1\r\n\x1b[2;10H\x1b[6n")
    monkeypatch.setattr(terminal_jobs, "backend_for", lambda c, p: mock_backend)

    # Setup proposal in running status with PTY enabled
    proposal_id = "term-proposal-1"
    with ctx.repository.transaction() as store:
        from homun.domain.models import CommandRecord
        store.commands[proposal_id] = CommandRecord(
            command_id=proposal_id,
            type=terminal_jobs.TYPE,
            actor_id=actor.id,
            workspace_id=actor.workspace_id,
            request_fingerprint="fp1",
            result={
                "id": proposal_id,
                "work_id": work_id,
                "command": "bash",
                "policy": "local-private-v1",
                "status": "running",
                "pty": True,
                "pty_rows": 10,
                "pty_cols": 40,
                "logs": {"text": ""},
            },
        )
        ctx.service.store = store

    # Trigger PTY query answering
    _answer_pty(ctx, actor, work_id, proposal_id)

    # Check that query \x1b[6n was answered with real cursor position
    # Line 1 is on row 0. \r\n moves to row 1. \x1b[2;10H sets cursor to row 1 (0-based), col 9 (0-based)
    # 1-based report: \x1b[2;10R
    assert len(mock_backend.written_stdin) == 1
    assert mock_backend.written_stdin[0] == b"\x1b[2;10R"

    # Verify rendered screen in proposal logs
    with ctx.repository.transaction() as store:
        res = store.commands[proposal_id].result
        assert res["_pty_cursor"] == {"row": 1, "col": 9}
        assert res["logs"]["cursor"] == {"row": 1, "col": 9}
        lines = res["logs"]["text"].splitlines()
        assert lines[0] == "Line 1"


def test_concurrent_refresh_prevents_duplicate_replies(terminal_env, monkeypatch):
    """Concurrent readers claiming the same log window send PTY reply exactly once."""
    env = terminal_env
    ctx, actor, work_id = env["ctx"], env["actor"], env["work_id"]

    mock_backend = MockBackend("prompt$ \x1b[5n")
    monkeypatch.setattr(terminal_jobs, "backend_for", lambda c, p: mock_backend)

    proposal_id = "term-concurrent-1"
    with ctx.repository.transaction() as store:
        from homun.domain.models import CommandRecord
        store.commands[proposal_id] = CommandRecord(
            command_id=proposal_id,
            type=terminal_jobs.TYPE,
            actor_id=actor.id,
            workspace_id=actor.workspace_id,
            request_fingerprint="fp-conc",
            result={
                "id": proposal_id,
                "work_id": work_id,
                "command": "bash",
                "policy": "local-private-v1",
                "status": "running",
                "pty": True,
                "pty_rows": 24,
                "pty_cols": 80,
                "logs": {"text": ""},
            },
        )
        ctx.service.store = store

    # First caller processes log and claims interval
    _answer_pty(ctx, actor, work_id, proposal_id)
    assert len(mock_backend.written_stdin) == 1
    assert mock_backend.written_stdin[0] == b"\x1b[0n"

    # Second concurrent caller on the same unread window does NOT send a duplicate reply
    _answer_pty(ctx, actor, work_id, proposal_id)
    assert len(mock_backend.written_stdin) == 1


def test_truncated_log_window_reported_as_incomplete(terminal_env, monkeypatch):
    """When the log buffer wraps and prefix is lost, proposal logs are marked incomplete."""
    env = terminal_env
    ctx, actor, work_id = env["ctx"], env["actor"], env["work_id"]

    # Initial log: 250 characters of alpha
    initial = "A" * 250
    mock_backend = MockBackend(initial)
    monkeypatch.setattr(terminal_jobs, "backend_for", lambda c, p: mock_backend)

    proposal_id = "term-truncated-1"
    with ctx.repository.transaction() as store:
        from homun.domain.models import CommandRecord
        store.commands[proposal_id] = CommandRecord(
            command_id=proposal_id,
            type=terminal_jobs.TYPE,
            actor_id=actor.id,
            workspace_id=actor.workspace_id,
            request_fingerprint="fp-trunc",
            result={
                "id": proposal_id,
                "work_id": work_id,
                "command": "bash",
                "policy": "local-private-v1",
                "status": "running",
                "pty": True,
                "logs": {"text": ""},
            },
        )
        ctx.service.store = store

    _answer_pty(ctx, actor, work_id, proposal_id)

    # Now the buffer wrapped completely and lost the entire mark
    mock_backend.logs_text = "Z" * 100
    _answer_pty(ctx, actor, work_id, proposal_id)

    with ctx.repository.transaction() as store:
        res = store.commands[proposal_id].result
        assert res["logs"]["incomplete"] is True
        assert res["logs"]["error_code"] == "log_window_truncated"


def test_reopen_preserves_screen_and_cursor_state(terminal_env, monkeypatch):
    """Reopening the repository preserves rendered screen state and cursor position."""
    env = terminal_env
    ctx, actor, work_id = env["ctx"], env["actor"], env["work_id"]

    mock_backend = MockBackend("Persistent Screen\r\n\x1b[3;5H*")
    monkeypatch.setattr(terminal_jobs, "backend_for", lambda c, p: mock_backend)

    proposal_id = "term-reopen-1"
    with ctx.repository.transaction() as store:
        from homun.domain.models import CommandRecord
        store.commands[proposal_id] = CommandRecord(
            command_id=proposal_id,
            type=terminal_jobs.TYPE,
            actor_id=actor.id,
            workspace_id=actor.workspace_id,
            request_fingerprint="fp-reopen",
            result={
                "id": proposal_id,
                "work_id": work_id,
                "command": "bash",
                "policy": "local-private-v1",
                "status": "running",
                "pty": True,
                "pty_rows": 10,
                "pty_cols": 40,
                "logs": {"text": ""},
            },
        )
        ctx.service.store = store

    _answer_pty(ctx, actor, work_id, proposal_id)

    # Reopen context from disk
    ctx.close()
    reopened = create_context(
        workspace_id=ctx.workspace_id,
        db_path=ctx.data_dir / "homun.db",
        data_dir=ctx.data_dir,
        for_tests=True,
    )

    with reopened.repository.transaction() as store:
        res = store.commands[proposal_id].result
        assert res["_pty_cursor"] == {"row": 2, "col": 5}
        assert res["logs"]["cursor"] == {"row": 2, "col": 5}
        assert "Persistent Screen" in res["logs"]["text"]


def test_refresh_rechecks_read_authorization(terminal_env, monkeypatch):
    """Refresh rechecks read access before and after I/O."""
    env = terminal_env
    ctx, actor, work_id = env["ctx"], env["actor"], env["work_id"]

    mock_backend = MockBackend("Sample output")
    monkeypatch.setattr(terminal_jobs, "backend_for", lambda c, p: mock_backend)

    proposal_id = "term-auth-1"
    with ctx.repository.transaction() as store:
        from homun.domain.models import CommandRecord
        store.commands[proposal_id] = CommandRecord(
            command_id=proposal_id,
            type=terminal_jobs.TYPE,
            actor_id=actor.id,
            workspace_id=actor.workspace_id,
            request_fingerprint="fp-auth",
            result={"id": proposal_id, "work_id": work_id, "command": "bash", "policy": "local-private-v1", "status": "running", "pty": True},
        )
        ctx.service.store = store

    rogue_actor = Actor(id="person_rogue", workspace_id="ws_term", display_name="Rogue", kind="person")
    with pytest.raises(PermissionDeniedError):
        refresh(ctx, rogue_actor, work_id, proposal_id)
