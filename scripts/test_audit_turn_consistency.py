from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import scripts.audit_turn_consistency as audit


def create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        create table tasks (
            task_id text primary key,
            user_id text not null,
            workspace_id text not null,
            kind text not null,
            status text not null,
            created_at integer not null,
            updated_at integer not null,
            blocked_reason text,
            task_json text not null,
            thread_id text
        );
        create table turn_events (
            event_id integer primary key autoincrement,
            turn_id text not null,
            seq integer not null,
            kind text not null,
            payload_json text not null,
            created_at integer not null
        );
        create table agent_runs (
            run_id text primary key,
            turn_id text not null,
            thread_id text not null,
            user_id text not null,
            workspace_id text not null,
            attempt integer not null,
            status text not null,
            started_at integer not null,
            completed_at integer,
            terminal_reason text,
            schema_version integer not null
        );
        create table chat_messages (
            id text primary key,
            thread_id text not null,
            role text not null,
            text text not null,
            timestamp text not null,
            linked_task_id text,
            delivery_state text not null default 'delivered'
        );
        """
    )


def seed_task(
    conn: sqlite3.Connection,
    status: str = "failed",
    blocked_reason: str | None = None,
) -> None:
    task_json = {
        "input_json": {
            "thread_id": "thread-1",
            "assistant_message_id": "assistant-1",
        }
    }
    conn.execute(
        """
        insert into tasks (
            task_id, user_id, workspace_id, kind, status, created_at, updated_at,
            blocked_reason, task_json, thread_id
        ) values (?, 'user-1', 'workspace-1', 'chat_turn', ?, 1, 2, ?, ?, 'thread-1')
        """,
        ("turn-1", status, blocked_reason, json.dumps(task_json)),
    )


class AuditTurnConsistencyTests(unittest.TestCase):
    def with_db(self):
        temp = tempfile.TemporaryDirectory()
        path = Path(temp.name) / "homun.sqlite"
        conn = sqlite3.connect(path)
        create_schema(conn)
        self.addCleanup(temp.cleanup)
        self.addCleanup(conn.close)
        return path, conn

    def test_failed_task_with_empty_assistant_message_reports_projection_owner(self):
        path, conn = self.with_db()
        seed_task(conn, "failed", "Turn stopped before finishing")
        conn.execute(
            "insert into turn_events (turn_id, seq, kind, payload_json, created_at) values (?, 1, 'error', ?, 2)",
            ("turn-1", json.dumps({"text": None, "projection_ref": "turn-1:1"})),
        )
        conn.execute(
            "insert into chat_messages (id, thread_id, role, text, timestamp, linked_task_id, delivery_state) values (?, 'thread-1', 'assistant', '', '2', 'turn-1', 'failed')",
            ("assistant-1",),
        )
        conn.commit()

        report = audit.audit_turn(path, "turn-1")

        codes = {item["code"] for item in report["contradictions"]}
        owners = {item["owner_to_remove"] for item in report["contradictions"]}
        self.assertIn("failed_terminal_missing_text", codes)
        self.assertIn("failed_message_empty", codes)
        self.assertIn("execution_projection", owners)

    def test_terminal_task_with_running_agent_run_reports_agent_run_owner(self):
        path, conn = self.with_db()
        seed_task(conn, "failed", "failed")
        conn.execute(
            "insert into turn_events (turn_id, seq, kind, payload_json, created_at) values ('turn-1', 1, 'error', ?, 2)",
            (json.dumps({"text": "failed"}),),
        )
        conn.execute(
            """
            insert into agent_runs (
                run_id, turn_id, thread_id, user_id, workspace_id, attempt, status,
                started_at, completed_at, terminal_reason, schema_version
            ) values ('run-1', 'turn-1', 'thread-1', 'user-1', 'workspace-1', 1, 'running', 1, null, null, 1)
            """
        )
        conn.commit()

        report = audit.audit_turn(path, "turn-1")

        self.assertIn(
            "terminal_task_with_running_agent_run",
            {item["code"] for item in report["contradictions"]},
        )

    def test_completed_task_with_active_event_after_terminal_reports_activity_owner(self):
        path, conn = self.with_db()
        seed_task(conn, "completed", None)
        conn.execute(
            "insert into turn_events (turn_id, seq, kind, payload_json, created_at) values ('turn-1', 1, 'done', ?, 2)",
            (json.dumps({"text": "done"}),),
        )
        conn.execute(
            "insert into turn_events (turn_id, seq, kind, payload_json, created_at) values ('turn-1', 2, 'activity', ?, 3)",
            (json.dumps({"text": "still thinking"}),),
        )
        conn.commit()

        report = audit.audit_turn(path, "turn-1")

        self.assertIn(
            "event_after_terminal",
            {item["code"] for item in report["contradictions"]},
        )

    def test_terminal_task_status_must_match_reducer_terminal_status(self):
        path, conn = self.with_db()
        seed_task(conn, "completed", None)
        conn.execute(
            "insert into turn_events (turn_id, seq, kind, payload_json, created_at) values ('turn-1', 1, 'error', ?, 2)",
            (json.dumps({"text": "failed"}),),
        )
        conn.commit()

        report = audit.audit_turn(path, "turn-1")

        self.assertIn(
            "task_reducer_terminal_status_mismatch",
            {item["code"] for item in report["contradictions"]},
        )

    def test_failed_task_with_completed_agent_run_reports_run_mismatch(self):
        path, conn = self.with_db()
        seed_task(conn, "failed", "failed")
        conn.execute(
            "insert into turn_events (turn_id, seq, kind, payload_json, created_at) values ('turn-1', 1, 'error', ?, 2)",
            (json.dumps({"text": "failed"}),),
        )
        conn.execute(
            """
            insert into agent_runs (
                run_id, turn_id, thread_id, user_id, workspace_id, attempt, status,
                started_at, completed_at, terminal_reason, schema_version
            ) values ('run-1', 'turn-1', 'thread-1', 'user-1', 'workspace-1', 1, 'completed', 1, 2, 'done', 1)
            """
        )
        conn.commit()

        report = audit.audit_turn(path, "turn-1")

        self.assertIn(
            "terminal_task_agent_run_status_mismatch",
            {item["code"] for item in report["contradictions"]},
        )

    def test_failed_empty_assistant_message_is_reported_even_if_still_streaming(self):
        path, conn = self.with_db()
        seed_task(conn, "failed", "failed")
        conn.execute(
            "insert into turn_events (turn_id, seq, kind, payload_json, created_at) values ('turn-1', 1, 'error', ?, 2)",
            (json.dumps({"text": "failed"}),),
        )
        conn.execute(
            "insert into chat_messages (id, thread_id, role, text, timestamp, linked_task_id, delivery_state) values (?, 'thread-1', 'assistant', '', '2', 'turn-1', 'streaming')",
            ("assistant-1",),
        )
        conn.commit()

        report = audit.audit_turn(path, "turn-1")

        codes = {item["code"] for item in report["contradictions"]}
        self.assertIn("failed_message_empty", codes)
        self.assertIn("failed_message_delivery_state_mismatch", codes)

    def test_missing_database_path_is_not_created(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name) / "missing.sqlite"

        with self.assertRaises(FileNotFoundError):
            audit.audit_turn(path, "turn-1")

        self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
