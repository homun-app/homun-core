from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import scripts.audit_homun_state as audit
import scripts.repair_homun_logs as log_repair


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
        create table agent_run_events (
            event_id integer primary key autoincrement,
            run_id text not null,
            seq integer not null,
            round integer,
            kind text not null,
            payload_json text not null,
            created_at integer not null
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
        create table execution_wakes (
            execution_id text not null,
            revision integer not null,
            dedup_key text not null,
            condition_json text not null,
            status text not null,
            delivery_json text,
            created_at integer not null,
            delivered_at integer,
            primary key(execution_id, revision, dedup_key)
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

    def test_report_identifies_explicit_input_paths(self):
        paths = self.with_paths()

        report = audit.audit_homun_state(paths)

        self.assertEqual(report["paths"]["data_dir"], None)
        self.assertEqual(report["paths"]["sources"]["runtime_db"], "explicit_inputs")
        self.assertEqual(report["paths"]["sources"]["memory_db"], "explicit_inputs")
        self.assertEqual(report["paths"]["sources"]["vault_db"], "explicit_inputs")
        self.assertEqual(report["paths"]["sources"]["logs_dir"], "explicit_inputs")
        self.assertEqual(report["paths"]["sources"]["routing_decisions"], "explicit_inputs")

    def test_data_dir_arg_resolves_profile_paths_ahead_of_environment_overrides(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            env = {
                "HOMUN_DATA_DIR": os.fspath(root / "env-profile"),
                "HOMUN_DESKTOP_GATEWAY_DB": os.fspath(root / "env.sqlite"),
                "HOMUN_MEMORY_DB": os.fspath(root / "env-memory.sqlite"),
                "HOMUN_VAULT_DB": os.fspath(root / "env-vault.sqlite"),
            }

            with patch.dict(os.environ, env, clear=True):
                args = audit.parse_args(["--data-dir", os.fspath(root / "cli-profile")])
                paths = audit.inputs_from_args(args)

        self.assertEqual(paths.data_dir, root / "cli-profile")
        self.assertEqual(paths.data_dir_source, "--data-dir")
        self.assertEqual(paths.runtime_db, root / "cli-profile" / "homun.sqlite")
        self.assertEqual(paths.memory_db, root / "cli-profile" / "memory.sqlite")
        self.assertEqual(paths.vault_db, root / "cli-profile" / "vault.sqlite")
        self.assertEqual(paths.logs_dir, root / "cli-profile" / "logs")
        self.assertEqual(paths.routing_decisions, root / "cli-profile" / "routing-decisions.json")
        self.assertEqual(paths.runtime_db_source, "--data-dir/homun.sqlite")
        self.assertEqual(paths.memory_db_source, "--data-dir/memory.sqlite")
        self.assertEqual(paths.vault_db_source, "--data-dir/vault.sqlite")

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

    def test_completed_turn_with_incomplete_latest_plan_without_delivered_answer_is_reported(self):
        paths = self.with_paths()
        conn = sqlite3.connect(paths.runtime_db)
        self.addCleanup(conn.close)
        create_runtime_schema(conn)
        conn.execute(
            """
            insert into tasks (
                task_id, user_id, workspace_id, kind, status, created_at,
                updated_at, blocked_reason, task_json, thread_id
            ) values ('turn-plan-open', 'user-1', 'workspace-1', 'chat_turn',
                'completed', 10, 40, null, '{}', 'thread-1')
            """
        )
        conn.execute(
            """
            insert into turn_events (turn_id, seq, kind, payload_json, created_at)
            values ('turn-plan-open', 1, 'plan_update',
                '{"markdown":"- [x] **Gather** (`gather`): done\\n- [-] **Verify** (`verify`): pending"}',
                20)
            """
        )
        conn.execute(
            """
            insert into turn_events (turn_id, seq, kind, payload_json, created_at)
            values ('turn-plan-open', 2, 'done', '{}', 40)
            """
        )
        conn.commit()

        report = audit.audit_homun_state(paths)

        self.assertIn("completed_turn_with_incomplete_plan", self.finding_codes(report))

    def test_completed_turn_with_incomplete_latest_plan_and_delivered_answer_is_warning(self):
        paths = self.with_paths()
        conn = sqlite3.connect(paths.runtime_db)
        self.addCleanup(conn.close)
        create_runtime_schema(conn)
        conn.execute(
            """
            insert into tasks (
                task_id, user_id, workspace_id, kind, status, created_at,
                updated_at, blocked_reason, task_json, thread_id
            ) values ('turn-plan-delivered', 'user-1', 'workspace-1', 'chat_turn',
                'completed', 10, 40, null, '{}', 'thread-1')
            """
        )
        conn.execute(
            """
            insert into turn_events (turn_id, seq, kind, payload_json, created_at)
            values ('turn-plan-delivered', 1, 'plan_update',
                '{"markdown":"- [x] **Gather** (`gather`): done\\n- [-] **Verify** (`verify`): pending"}',
                20)
            """
        )
        conn.execute(
            """
            insert into turn_events (turn_id, seq, kind, payload_json, created_at)
            values ('turn-plan-delivered', 2, 'done',
                '{"assistant_message_id":"assistant-1","text":"Final answer"}',
                40)
            """
        )
        conn.commit()

        report = audit.audit_homun_state(paths)
        by_code = report["summary"]["by_code"]

        self.assertNotIn("completed_turn_with_incomplete_plan", by_code)
        self.assertEqual(
            by_code["completed_turn_with_unreconciled_delivered_plan"]["severity"],
            "warning",
        )

    def test_completed_turn_with_streamed_answer_after_incomplete_plan_is_warning(self):
        paths = self.with_paths()
        conn = sqlite3.connect(paths.runtime_db)
        self.addCleanup(conn.close)
        create_runtime_schema(conn)
        conn.execute(
            """
            insert into tasks (
                task_id, user_id, workspace_id, kind, status, created_at,
                updated_at, blocked_reason, task_json, thread_id
            ) values ('turn-plan-streamed', 'user-1', 'workspace-1', 'chat_turn',
                'completed', 10, 40, null, '{}', 'thread-1')
            """
        )
        conn.execute(
            """
            insert into turn_events (turn_id, seq, kind, payload_json, created_at)
            values ('turn-plan-streamed', 1, 'plan_update',
                '{"markdown":"- [-] **Gather** (`gather`): pending"}',
                20)
            """
        )
        conn.execute(
            """
            insert into turn_events (turn_id, seq, kind, payload_json, created_at)
            values ('turn-plan-streamed', 2, 'delta', '{"text":"Final"}', 30)
            """
        )
        conn.execute(
            """
            insert into turn_events (turn_id, seq, kind, payload_json, created_at)
            values ('turn-plan-streamed', 3, 'done',
                '{"assistant_message_id":"assistant-1"}',
                40)
            """
        )
        conn.commit()

        report = audit.audit_homun_state(paths)
        by_code = report["summary"]["by_code"]

        self.assertNotIn("completed_turn_with_incomplete_plan", by_code)
        self.assertEqual(
            by_code["completed_turn_with_unreconciled_delivered_plan"]["severity"],
            "warning",
        )

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

    def test_waiting_time_task_without_pending_wake_is_reported(self):
        paths = self.with_paths()
        conn = sqlite3.connect(paths.runtime_db)
        self.addCleanup(conn.close)
        create_runtime_schema(conn)
        conn.execute(
            """
            insert into tasks (
                task_id, user_id, workspace_id, kind, status, created_at,
                updated_at, blocked_reason, task_json, thread_id
            ) values ('turn-stuck', 'user-1', 'workspace-1', 'chat_turn',
                'waiting_time', 1, 2, null, '{}', 'thread-1')
            """
        )
        conn.execute(
            """
            insert into tasks (
                task_id, user_id, workspace_id, kind, status, created_at,
                updated_at, blocked_reason, task_json, thread_id
            ) values ('turn-waked', 'user-1', 'workspace-1', 'chat_turn',
                'waiting_time', 1, 2, null, '{}', 'thread-2')
            """
        )
        conn.execute(
            """
            insert into execution_wakes (
                execution_id, revision, dedup_key, condition_json, status,
                delivery_json, created_at, delivered_at
            ) values (
                'turn-waked', 1, 'v1:at:123', '{"type":"at","unix_seconds":123}',
                'pending', null, 2, null
            )
            """
        )
        conn.commit()

        report = audit.audit_homun_state(paths)

        stuck = [
            finding for finding in report["findings"]
            if finding["code"] == "waiting_time_task_without_pending_wake"
        ]
        self.assertEqual([finding["ref"] for finding in stuck], ["turn-stuck"])

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
                        "candidates": ["qwen3.5:4b"],
                        "chosen_provider": "legacy",
                        "chosen_model": "qwen3.5:4b",
                        "stage": "chat_config",
                    },
                    {
                        "ts": 2,
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

    def test_log_repair_previews_applies_with_backup_and_removes_sensitive_plaintext(self):
        paths = self.with_paths()
        paths.logs_dir.mkdir()
        trace = paths.logs_dir / "turn-trace.jsonl"
        trace.write_text(
            '{"prompt_head":"utente RSSMRA80A01H501U"}\n'
            '{"prompt_head":"Authorization: Bearer abcdefghijklmnop utente ok"}\n'
            '{"prompt_head":"safe"}\n',
            encoding="utf-8",
        )
        backup_dir = paths.logs_dir.parent / "backups" / "privacy-logs" / "test-backup"

        preview = log_repair.preview_log_repair(paths.logs_dir)

        self.assertEqual(preview["total_files"], 1)
        self.assertEqual(preview["total_redactions"], 2)
        self.assertIn("RSSMRA80A01H501U", trace.read_text(encoding="utf-8"))
        with self.assertRaises(ValueError):
            log_repair.apply_log_repair(paths.logs_dir, backup_dir, confirm=False)

        result = log_repair.apply_log_repair(paths.logs_dir, backup_dir, confirm=True)

        self.assertTrue(result["backup"]["created"])
        self.assertEqual(result["backup"]["files"], 1)
        self.assertTrue((backup_dir / "turn-trace.jsonl").is_file())
        redacted = trace.read_text(encoding="utf-8")
        self.assertNotIn("RSSMRA80A01H501U", redacted)
        self.assertNotIn("Bearer abcdefghijklmnop", redacted)
        self.assertIn("[REDACTED:identity]", redacted)
        self.assertIn("[REDACTED:credential]", redacted)
        report = audit.audit_homun_state(paths)
        self.assertNotIn("log_contains_sensitive_plaintext", self.finding_codes(report))
        encoded = json.dumps(result)
        self.assertNotIn("RSSMRA80A01H501U", encoded)
        self.assertNotIn(str(trace), encoded)
        second = log_repair.apply_log_repair(
            paths.logs_dir,
            paths.logs_dir.parent / "backups" / "privacy-logs" / "second-backup",
            confirm=True,
        )
        self.assertFalse(second["backup"]["created"])
        self.assertEqual(second["total_redactions"], 0)

    def test_report_caps_repeated_legacy_memory_findings_and_keeps_summary_counts(self):
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
            if finding["code"] == "legacy_memory_without_evidence"
        ]
        self.assertEqual(len(memory_without_evidence), 2)
        self.assertEqual(
            report["summary"]["by_code"]["legacy_memory_without_evidence"]["count"],
            5,
        )
        self.assertEqual(
            report["summary"]["by_code"]["legacy_memory_without_evidence"]["omitted"],
            3,
        )

    def test_modern_memory_without_evidence_remains_current_pipeline_warning(self):
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
                'mem-modern', 'user-1', 'workspace-1', 'fact',
                'ordinary memory', '[]', '[]', 0.9, 'Active',
                'personal', 'Private',
                '{"admission":{"origin":"user_explicit","durability":"durable"}}',
                '1', '1', null, '[]', null, null
            )
            """
        )
        conn.commit()

        report = audit.audit_homun_state(paths)

        self.assertIn("memory_without_evidence", self.finding_codes(report))
        self.assertNotIn("legacy_memory_without_evidence", self.finding_codes(report))

    def test_observability_timeline_summarizes_runtime_without_leaking_payload_text(self):
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
                'completed', 10, 40, null, '{}', 'thread-1')
            """
        )
        conn.execute(
            """
            insert into agent_runs (
                run_id, turn_id, thread_id, user_id, workspace_id, attempt,
                status, role, model, provider, prompt_fingerprint, started_at,
                completed_at, terminal_reason, schema_version
            ) values ('run-1', 'turn-1', 'thread-1', 'user-1', 'workspace-1',
                1, 'completed', 'orchestrator', 'qwen', 'ollama', 'fp', 11,
                39, 'canonical_completed', 1)
            """
        )
        conn.execute(
            """
            insert into agent_run_events (
                run_id, seq, round, kind, payload_json, created_at
            ) values (
                'run-1', 1, 0, 'prompt_snapshot',
                '{"prompt_head":"utente RSSMRA80A01H501U"}', 12
            )
            """
        )
        conn.execute(
            """
            insert into agent_run_events (
                run_id, seq, round, kind, payload_json, created_at
            ) values (
                'run-1', 2, 0, 'model_response',
                '{"tool_calls":[{"name":"browser.open"}],"content":"ok"}', 20
            )
            """
        )
        conn.execute(
            """
            insert into turn_events (turn_id, seq, kind, payload_json, created_at)
            values ('turn-1', 1, 'activity', '{"status":"browser_done: ok"}', 30)
            """
        )
        conn.execute(
            """
            insert into turn_events (turn_id, seq, kind, payload_json, created_at)
            values ('turn-1', 2, 'done', '{"text":"done RSSMRA80A01H501U"}', 40)
            """
        )
        conn.commit()

        report = audit.audit_homun_state(paths)

        timelines = report["observability"]["timelines"]
        self.assertEqual(len(timelines), 1)
        timeline = timelines[0]
        self.assertEqual(timeline["turn_id"], "turn-1")
        self.assertEqual(timeline["status"], "completed")
        self.assertEqual(timeline["model"], {"role": "orchestrator", "provider": "ollama", "model": "qwen"})
        self.assertEqual(
            [event["phase"] for event in timeline["events"]],
            [
                "task_created",
                "run_started",
                "run_event:prompt_snapshot",
                "run_event:model_response",
                "turn_event:activity",
                "run_completed",
                "turn_event:done",
                "task_updated",
            ],
        )
        encoded = json.dumps(report)
        self.assertNotIn("RSSMRA80A01H501U", encoded)
        self.assertNotIn("prompt_head", encoded)
        self.assertNotIn("text", encoded)

    def test_observability_reports_gaps_that_make_runtime_debugging_ambiguous(self):
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
                'completed', 10, 40, null, '{}', 'thread-1')
            """
        )
        conn.execute(
            """
            insert into agent_runs (
                run_id, turn_id, thread_id, user_id, workspace_id, attempt,
                status, role, model, provider, prompt_fingerprint, started_at,
                completed_at, terminal_reason, schema_version
            ) values ('run-1', 'turn-1', 'thread-1', 'user-1', 'workspace-1',
                1, 'completed', 'orchestrator', '', '', 'fp', 11,
                39, null, 1)
            """
        )
        conn.commit()

        report = audit.audit_homun_state(paths)

        gap_codes = {gap["code"] for gap in report["observability"]["diagnostic_gaps"]}
        self.assertIn("completed_run_missing_terminal_reason", gap_codes)
        self.assertIn("run_missing_model_attribution", gap_codes)
        self.assertIn("run_without_agent_run_events", gap_codes)
        self.assertIn("turn_without_turn_events", gap_codes)
        self.assertEqual(report["observability"]["summary"]["diagnostic_gaps"], 4)

    def test_observability_timeline_caps_noisy_events_but_keeps_terminal_tail(self):
        paths = self.with_paths()
        conn = sqlite3.connect(paths.runtime_db)
        self.addCleanup(conn.close)
        create_runtime_schema(conn)
        conn.execute(
            """
            insert into tasks (
                task_id, user_id, workspace_id, kind, status, created_at,
                updated_at, blocked_reason, task_json, thread_id
            ) values ('turn-noisy', 'user-1', 'workspace-1', 'chat_turn',
                'completed', 10, 100, null, '{}', 'thread-1')
            """
        )
        conn.execute(
            """
            insert into agent_runs (
                run_id, turn_id, thread_id, user_id, workspace_id, attempt,
                status, role, model, provider, prompt_fingerprint, started_at,
                completed_at, terminal_reason, schema_version
            ) values ('run-noisy', 'turn-noisy', 'thread-1', 'user-1', 'workspace-1',
                1, 'completed', 'orchestrator', 'qwen', 'ollama', 'fp', 11,
                99, 'canonical_completed', 1)
            """
        )
        for seq in range(1, 40):
            conn.execute(
                """
                insert into agent_run_events (
                    run_id, seq, round, kind, payload_json, created_at
                ) values ('run-noisy', ?, ?, 'model_response', '{}', ?)
                """,
                (seq, seq, 20 + seq),
            )
        conn.execute(
            """
            insert into turn_events (turn_id, seq, kind, payload_json, created_at)
            values ('turn-noisy', 1, 'done', '{"status":"done"}', 99)
            """
        )
        conn.commit()

        report = audit.audit_homun_state(paths, max_timeline_events=12)

        timeline = report["observability"]["timelines"][0]
        self.assertEqual(timeline["events_total"], 44)
        self.assertEqual(timeline["events_omitted"], 33)
        self.assertEqual(len(timeline["events"]), 12)
        self.assertIn({"phase": "events_omitted", "count": 33}, timeline["events"])
        self.assertEqual(timeline["events"][-3]["phase"], "turn_event:done")
        self.assertEqual(timeline["events"][-2]["phase"], "run_completed")
        self.assertEqual(timeline["events"][-1]["phase"], "task_updated")


if __name__ == "__main__":
    unittest.main()
