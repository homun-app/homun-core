from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import scripts.audit_homun_state as audit


def create_runtime_schema(conn: sqlite3.Connection) -> None:
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
        create table agent_runs (
            run_id text primary key,
            turn_id text not null,
            thread_id text not null,
            user_id text not null,
            workspace_id text not null,
            attempt integer not null,
            status text not null,
            role text,
            model text,
            provider text,
            prompt_fingerprint text,
            started_at integer not null,
            completed_at integer,
            terminal_reason text,
            schema_version integer not null
        );
        create table thread_hitl_waits (
            wait_id text primary key,
            thread_id text not null,
            source_message_id text not null,
            kind text not null,
            payload_json text not null,
            open_work_json text not null,
            status text not null,
            created_at integer not null,
            resolved_at integer
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
        create table turn_events (
            event_id integer primary key autoincrement,
            turn_id text not null,
            seq integer not null,
            kind text not null,
            payload_json text not null,
            created_at integer not null
        );
        create table task_approvals (
            approval_id text primary key,
            task_id text not null,
            user_id text not null,
            workspace_id text not null,
            status text not null,
            created_at integer not null,
            updated_at integer not null,
            approval_json text not null
        );
        """
    )


def create_memory_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        create table memories (
            ref text primary key,
            user_id text not null,
            workspace_id text not null,
            memory_type text not null,
            text text not null,
            aliases_json text not null,
            language_hints_json text not null,
            confidence real not null,
            status text not null,
            privacy_domain text not null,
            sensitivity text not null,
            metadata_json text not null,
            created_at text not null,
            updated_at text not null,
            last_seen_at text,
            supersedes_json text not null,
            superseded_by text,
            correction_of text
        );
        create table memory_evidence (
            memory_ref text not null,
            evidence_ref text not null,
            note text not null,
            primary key(memory_ref, evidence_ref)
        );
        """
    )


def create_vault_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        create table vault_records (
            id text primary key,
            category text not null,
            label text not null,
            secret_ref text not null,
            metadata_json text not null,
            created_at text not null,
            updated_at text not null
        );
        create table vault_secret_material (
            record_id text primary key,
            algorithm text not null,
            nonce text not null,
            ciphertext text not null,
            updated_at text not null
        );
        """
    )


class AuditHomunStateTests(unittest.TestCase):
    def with_paths(self):
        temp = tempfile.TemporaryDirectory()
        root = Path(temp.name)
        self.addCleanup(temp.cleanup)
        return audit.AuditInputs(
            runtime_db=root / "homun.sqlite",
            memory_db=root / "memory.sqlite",
            vault_db=root / "vault.sqlite",
            logs_dir=root / "logs",
            routing_decisions=root / "routing-decisions.json",
        )

    def finding_codes(self, report: dict) -> set[str]:
        return {finding["code"] for finding in report["findings"]}

    def test_terminal_task_with_running_agent_run_is_reported(self):
        paths = self.with_paths()
        conn = sqlite3.connect(paths.runtime_db)
        self.addCleanup(conn.close)
        create_runtime_schema(conn)
        conn.execute(
            """
            insert into tasks (
                task_id, user_id, workspace_id, kind, status, created_at,
                updated_at, blocked_reason, task_json, thread_id
            ) values ('turn-1', 'user-1', 'workspace-1', 'chat_turn',
                'completed', 1, 2, null, '{}', 'thread-1')
            """
        )
        conn.execute(
            """
            insert into agent_runs (
                run_id, turn_id, thread_id, user_id, workspace_id, attempt,
                status, role, model, provider, prompt_fingerprint, started_at,
                completed_at, terminal_reason, schema_version
            ) values ('run-1', 'turn-1', 'thread-1', 'user-1', 'workspace-1',
                1, 'running', 'orchestrator', 'qwen', 'ollama', 'fp', 1,
                null, null, 1)
            """
        )
        conn.commit()

        report = audit.audit_homun_state(paths)

        self.assertIn("terminal_task_with_running_agent_run", self.finding_codes(report))

    def test_running_agent_run_without_active_task_is_reported(self):
        paths = self.with_paths()
        conn = sqlite3.connect(paths.runtime_db)
        self.addCleanup(conn.close)
        create_runtime_schema(conn)
        conn.execute(
            """
            insert into agent_runs (
                run_id, turn_id, thread_id, user_id, workspace_id, attempt,
                status, role, model, provider, prompt_fingerprint, started_at,
                completed_at, terminal_reason, schema_version
            ) values ('run-orphan', 'turn-missing', 'thread-1', 'user-1',
                'workspace-1', 1, 'running', 'orchestrator', 'qwen',
                'ollama', 'fp', 1, null, null, 1)
            """
        )
        conn.commit()

        report = audit.audit_homun_state(paths)

        self.assertIn("running_agent_run_without_active_task", self.finding_codes(report))

    def test_streaming_assistant_without_active_run_is_reported(self):
        paths = self.with_paths()
        conn = sqlite3.connect(paths.runtime_db)
        self.addCleanup(conn.close)
        create_runtime_schema(conn)
        conn.execute(
            """
            insert into tasks (
                task_id, user_id, workspace_id, kind, status, created_at,
                updated_at, blocked_reason, task_json, thread_id
            ) values ('turn-1', 'user-1', 'workspace-1', 'chat_turn',
                'completed', 1, 2, null, '{}', 'thread-1')
            """
        )
        conn.execute(
            """
            insert into chat_messages (
                id, thread_id, role, text, timestamp, linked_task_id, delivery_state
            ) values ('message-1', 'thread-1', 'assistant', '', '2', 'turn-1', 'streaming')
            """
        )
        conn.commit()

        report = audit.audit_homun_state(paths)

        self.assertIn("streaming_assistant_without_active_run", self.finding_codes(report))

    def test_completed_task_with_browser_budget_exceeded_is_reported(self):
        paths = self.with_paths()
        conn = sqlite3.connect(paths.runtime_db)
        self.addCleanup(conn.close)
        create_runtime_schema(conn)
        conn.execute(
            """
            insert into tasks (
                task_id, user_id, workspace_id, kind, status, created_at,
                updated_at, blocked_reason, task_json, thread_id
            ) values ('turn-1', 'user-1', 'workspace-1', 'chat_turn',
                'completed', 1, 2, null, '{}', 'thread-1')
            """
        )
        conn.execute(
            """
            insert into turn_events (turn_id, seq, kind, payload_json, created_at)
            values ('turn-1', 1, 'activity', '{"status":"browser_budget_exceeded:stall"}', 2)
            """
        )
        conn.commit()

        report = audit.audit_homun_state(paths)

        self.assertIn("completed_task_with_browser_budget_exceeded", self.finding_codes(report))

    def test_active_task_with_terminal_turn_event_is_reported(self):
        paths = self.with_paths()
        conn = sqlite3.connect(paths.runtime_db)
        self.addCleanup(conn.close)
        create_runtime_schema(conn)
        conn.execute(
            """
            insert into tasks (
                task_id, user_id, workspace_id, kind, status, created_at,
                updated_at, blocked_reason, task_json, thread_id
            ) values ('turn-1', 'user-1', 'workspace-1', 'chat_turn',
                'running', 1, 2, null, '{}', 'thread-1')
            """
        )
        conn.execute(
            """
            insert into turn_events (turn_id, seq, kind, payload_json, created_at)
            values ('turn-1', 1, 'done', '{"text":"done"}', 2)
            """
        )
        conn.commit()

        report = audit.audit_homun_state(paths)

        self.assertIn("active_task_with_terminal_turn_event", self.finding_codes(report))

    def test_waiting_approval_with_open_hitl_allows_terminal_turn_event(self):
        paths = self.with_paths()
        conn = sqlite3.connect(paths.runtime_db)
        self.addCleanup(conn.close)
        create_runtime_schema(conn)
        conn.execute(
            """
            insert into tasks (
                task_id, user_id, workspace_id, kind, status, created_at,
                updated_at, blocked_reason, task_json, thread_id
            ) values ('turn-1', 'user-1', 'workspace-1', 'chat_turn',
                'waiting_user_approval', 1, 2, null, '{}', 'thread-1')
            """
        )
        conn.execute(
            """
            insert into turn_events (turn_id, seq, kind, payload_json, created_at)
            values ('turn-1', 1, 'done', '{"text":"done"}', 2)
            """
        )
        conn.execute(
            """
            insert into thread_hitl_waits (
                wait_id, thread_id, source_message_id, kind, payload_json,
                open_work_json, status, created_at, resolved_at
            ) values (
                'wait-1', 'thread-1', 'message-1', 'payment', '{}',
                '{}', 'open', 2, null
            )
            """
        )
        conn.commit()

        report = audit.audit_homun_state(paths)

        self.assertNotIn("active_task_with_terminal_turn_event", self.finding_codes(report))
        self.assertNotIn("waiting_approval_task_without_canonical_approval", self.finding_codes(report))

    def test_waiting_approval_task_without_canonical_approval_is_reported(self):
        paths = self.with_paths()
        conn = sqlite3.connect(paths.runtime_db)
        self.addCleanup(conn.close)
        create_runtime_schema(conn)
        conn.execute(
            """
            insert into tasks (
                task_id, user_id, workspace_id, kind, status, created_at,
                updated_at, blocked_reason, task_json, thread_id
            ) values ('turn-1', 'user-1', 'workspace-1', 'chat_turn',
                'waiting_user_approval', 1, 2, null, '{}', 'thread-1')
            """
        )
        conn.commit()

        report = audit.audit_homun_state(paths)

        self.assertIn("waiting_approval_task_without_canonical_approval", self.finding_codes(report))

    def test_sensitive_memory_without_vault_containment_is_reported_without_leaking_value(self):
        paths = self.with_paths()
        conn = sqlite3.connect(paths.memory_db)
        self.addCleanup(conn.close)
        create_memory_schema(conn)
        conn.execute(
            """
            insert into memories (
                ref, user_id, workspace_id, memory_type, text, aliases_json,
                language_hints_json, confidence, status, privacy_domain,
                sensitivity, metadata_json, created_at, updated_at,
                last_seen_at, supersedes_json, superseded_by, correction_of
            ) values (
                'mem-1', 'user-1', 'workspace-1', 'fact',
                'Codice fiscale RSSMRA80A01H501U', '[]', '[]', 0.9,
                'Active', 'personal', 'Private', '{}', '1', '1',
                null, '[]', null, null
            )
            """
        )
        conn.commit()

        report = audit.audit_homun_state(paths)

        self.assertIn("memory_contains_sensitive_plaintext", self.finding_codes(report))
        encoded = json.dumps(report)
        self.assertNotIn("RSSMRA80A01H501U", encoded)

    def test_vault_record_without_secret_material_is_reported(self):
        paths = self.with_paths()
        conn = sqlite3.connect(paths.vault_db)
        self.addCleanup(conn.close)
        create_vault_schema(conn)
        conn.execute(
            """
            insert into vault_records (
                id, category, label, secret_ref, metadata_json, created_at, updated_at
            ) values ('vault-1', 'identity', 'Codice Fiscale', 'vault-1', '{}', '1', '1')
            """
        )
        conn.commit()

        report = audit.audit_homun_state(paths)

        self.assertIn("vault_record_missing_secret_material", self.finding_codes(report))

    def test_log_and_routing_decision_risks_are_reported_safely(self):
        paths = self.with_paths()
        paths.logs_dir.mkdir()
        (paths.logs_dir / "turn-trace.jsonl").write_text(
            '{"prompt_head":"utente RSSMRA80A01H501U"}\n'
            '{"prompt_head":"Authorization: [REDACTED] utente VRDLGI80A01H501Z"}\n',
            encoding="utf-8",
        )
        paths.routing_decisions.write_text(
            json.dumps(
                [
                    {
                        "ts": 1,
                        "role": "orchestrator",
                        "goal": "test",
                        "candidates": [],
                        "chosen_provider": "",
                        "chosen_model": "",
                        "stage": "mystery",
                    }
                ]
            ),
            encoding="utf-8",
        )

        report = audit.audit_homun_state(paths)

        codes = self.finding_codes(report)
        self.assertIn("log_contains_sensitive_plaintext", codes)
        self.assertEqual(
            report["summary"]["by_code"]["log_contains_sensitive_plaintext"]["count"],
            2,
        )
        self.assertIn("routing_decision_unexplained", codes)
        encoded = json.dumps(report)
        self.assertNotIn("RSSMRA80A01H501U", encoded)

    def test_report_caps_repeated_findings_and_keeps_summary_counts(self):
        paths = self.with_paths()
        conn = sqlite3.connect(paths.memory_db)
        self.addCleanup(conn.close)
        create_memory_schema(conn)
        for index in range(5):
            conn.execute(
                """
                insert into memories (
                    ref, user_id, workspace_id, memory_type, text, aliases_json,
                    language_hints_json, confidence, status, privacy_domain,
                    sensitivity, metadata_json, created_at, updated_at,
                    last_seen_at, supersedes_json, superseded_by, correction_of
                ) values (
                    ?, 'user-1', 'workspace-1', 'fact',
                    'ordinary memory', '[]', '[]', 0.9, 'Active',
                    'personal', 'Private', '{}', '1', '1', null, '[]', null, null
                )
                """,
                (f"mem-{index}",),
            )
        conn.commit()

        report = audit.audit_homun_state(paths, max_findings_per_code=2)

        memory_without_evidence = [
            finding
            for finding in report["findings"]
            if finding["code"] == "memory_without_evidence"
        ]
        self.assertEqual(len(memory_without_evidence), 2)
        self.assertEqual(
            report["summary"]["by_code"]["memory_without_evidence"]["count"],
            5,
        )
        self.assertEqual(
            report["summary"]["by_code"]["memory_without_evidence"]["omitted"],
            3,
        )


if __name__ == "__main__":
    unittest.main()
