#!/usr/bin/env python3
"""Read-only Homun system audit for cross-domain regression classes.

This script is diagnostic only. It never repairs rows and it never prints raw
sensitive matches. The output is meant to identify which owner/gate class should
catch a regression before the user discovers it in a live chat.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


TERMINAL_TASK_STATUSES = {"completed", "failed", "cancelled", "expired"}
ACTIVE_TASK_STATUSES = {
    "queued",
    "pending",
    "running",
    "waiting_time",
    "waiting_external_event",
    "waiting_user_approval",
    "waiting_resource",
    "paused",
    "parked",
}
ALLOWED_ROUTING_STAGES = {
    "semantic",
    "heuristic_fallback",
    "single_candidate",
    "heuristic_disabled",
    "chat_config",
    "manual_override",
}
LOG_EXTENSIONS = {".log", ".jsonl", ".json", ".txt"}
SENSITIVE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "identity:codice_fiscale",
        re.compile(r"\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b", re.IGNORECASE),
    ),
    ("credentials:openai_key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b")),
    ("credentials:bearer", re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b", re.IGNORECASE)),
)


@dataclass(frozen=True)
class AuditInputs:
    runtime_db: Path
    memory_db: Path
    vault_db: Path
    logs_dir: Path
    routing_decisions: Path
    data_dir: Path | None = None
    data_dir_source: str = "explicit_inputs"
    runtime_db_source: str = "explicit_inputs"
    memory_db_source: str = "explicit_inputs"
    vault_db_source: str = "explicit_inputs"
    logs_dir_source: str = "explicit_inputs"
    routing_decisions_source: str = "explicit_inputs"


def default_data_dir_with_source() -> tuple[Path, str]:
    if value := os.environ.get("HOMUN_DATA_DIR"):
        return Path(value), "HOMUN_DATA_DIR"
    return Path(os.path.expanduser("~/.homun")), "default:~/.homun"


def default_data_dir() -> Path:
    root, _ = default_data_dir_with_source()
    return root


def default_inputs() -> AuditInputs:
    root, root_source = default_data_dir_with_source()
    runtime_env = os.environ.get("HOMUN_DESKTOP_GATEWAY_DB")
    memory_env = os.environ.get("HOMUN_MEMORY_DB")
    vault_env = os.environ.get("HOMUN_VAULT_DB")
    return AuditInputs(
        runtime_db=Path(runtime_env) if runtime_env else root / "homun.sqlite",
        memory_db=Path(memory_env) if memory_env else root / "memory.sqlite",
        vault_db=Path(vault_env) if vault_env else root / "vault.sqlite",
        logs_dir=root / "logs",
        routing_decisions=root / "routing-decisions.json",
        data_dir=root,
        data_dir_source=root_source,
        runtime_db_source="HOMUN_DESKTOP_GATEWAY_DB" if runtime_env else f"{root_source}/homun.sqlite",
        memory_db_source="HOMUN_MEMORY_DB" if memory_env else f"{root_source}/memory.sqlite",
        vault_db_source="HOMUN_VAULT_DB" if vault_env else f"{root_source}/vault.sqlite",
        logs_dir_source=f"{root_source}/logs",
        routing_decisions_source=f"{root_source}/routing-decisions.json",
    )


def inputs_from_args(args: argparse.Namespace) -> AuditInputs:
    if args.data_dir is not None:
        root = args.data_dir
        root_source = "--data-dir"
        prefer_data_dir_defaults = True
    else:
        root, root_source = default_data_dir_with_source()
        prefer_data_dir_defaults = False

    runtime_env = os.environ.get("HOMUN_DESKTOP_GATEWAY_DB")
    memory_env = os.environ.get("HOMUN_MEMORY_DB")
    vault_env = os.environ.get("HOMUN_VAULT_DB")

    runtime_db = args.runtime_db or (
        root / "homun.sqlite" if prefer_data_dir_defaults or not runtime_env else Path(runtime_env)
    )
    memory_db = args.memory_db or (
        root / "memory.sqlite" if prefer_data_dir_defaults or not memory_env else Path(memory_env)
    )
    vault_db = args.vault_db or (
        root / "vault.sqlite" if prefer_data_dir_defaults or not vault_env else Path(vault_env)
    )
    logs_dir = args.logs_dir or root / "logs"
    routing_decisions = args.routing_decisions or root / "routing-decisions.json"

    return AuditInputs(
        runtime_db=runtime_db,
        memory_db=memory_db,
        vault_db=vault_db,
        logs_dir=logs_dir,
        routing_decisions=routing_decisions,
        data_dir=root,
        data_dir_source=root_source,
        runtime_db_source=path_source(
            flag=args.runtime_db,
            flag_name="--runtime-db",
            env=runtime_env,
            env_name="HOMUN_DESKTOP_GATEWAY_DB",
            root_source=root_source,
            suffix="homun.sqlite",
            prefer_data_dir_defaults=prefer_data_dir_defaults,
        ),
        memory_db_source=path_source(
            flag=args.memory_db,
            flag_name="--memory-db",
            env=memory_env,
            env_name="HOMUN_MEMORY_DB",
            root_source=root_source,
            suffix="memory.sqlite",
            prefer_data_dir_defaults=prefer_data_dir_defaults,
        ),
        vault_db_source=path_source(
            flag=args.vault_db,
            flag_name="--vault-db",
            env=vault_env,
            env_name="HOMUN_VAULT_DB",
            root_source=root_source,
            suffix="vault.sqlite",
            prefer_data_dir_defaults=prefer_data_dir_defaults,
        ),
        logs_dir_source="--logs-dir" if args.logs_dir else f"{root_source}/logs",
        routing_decisions_source=(
            "--routing-decisions" if args.routing_decisions else f"{root_source}/routing-decisions.json"
        ),
    )


def path_source(
    *,
    flag: Path | None,
    flag_name: str,
    env: str | None,
    env_name: str,
    root_source: str,
    suffix: str,
    prefer_data_dir_defaults: bool,
) -> str:
    if flag is not None:
        return flag_name
    if env and not prefer_data_dir_defaults:
        return env_name
    return f"{root_source}/{suffix}"


def connect_read_only(db_path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)


def table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "select 1 from sqlite_master where type in ('table', 'view') and name = ?",
        (table,),
    ).fetchone()
    return row is not None


def column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    if not table_exists(conn, table):
        return False
    return any(row[1] == column for row in conn.execute(f"pragma table_info({table})"))


def row_dicts(conn: sqlite3.Connection, query: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    conn.row_factory = sqlite3.Row
    return [dict(row) for row in conn.execute(query, params).fetchall()]


def json_object(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, str) or not raw.strip():
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def plan_markdown_is_incomplete(markdown: str) -> bool:
    return any(marker in markdown for marker in ("- [-]", "- [ ]"))


def done_payload_has_delivered_answer(payload: dict[str, Any]) -> bool:
    assistant_message_id = str(payload.get("assistant_message_id") or "").strip()
    text = str(payload.get("text") or "").strip()
    return bool(assistant_message_id and text)


def events_have_delivered_answer_after_plan(events: Iterable[dict[str, Any]]) -> bool:
    has_terminal_assistant_id = False
    has_visible_text = False
    for row in events:
        kind = str(row.get("kind") or "")
        payload = json_object(row.get("payload_json"))
        if kind == "done" and done_payload_has_delivered_answer(payload):
            has_terminal_assistant_id = True
            has_visible_text = True
        elif kind == "done" and str(payload.get("assistant_message_id") or "").strip():
            has_terminal_assistant_id = True
        if kind == "delta" and str(payload.get("text") or "").strip():
            has_visible_text = True
    return has_terminal_assistant_id and has_visible_text


def runtime_plan_json_has_open_step(raw: str) -> bool:
    payload = json_object(raw)
    steps = payload.get("steps")
    if not isinstance(steps, list):
        return False
    for step in steps:
        if not isinstance(step, dict):
            continue
        status = str(step.get("status") or "").strip().lower()
        if status in {"todo", "doing", "in_progress", "in-progress"}:
            return True
    return False


def thread_has_open_runtime_plan(conn: sqlite3.Connection, thread_id: str) -> bool:
    if not thread_id or not table_exists(conn, "runtime_plans"):
        return False
    row = conn.execute(
        """
        select status, plan_json
        from runtime_plans
        where thread_id = ?
        order by updated_at desc
        limit 1
        """,
        (thread_id,),
    ).fetchone()
    if row is None:
        return False
    return str(row["status"] or "").strip().lower() == "open" and runtime_plan_json_has_open_step(
        str(row["plan_json"] or "")
    )


def finding(
    findings: list[dict[str, Any]],
    *,
    domain: str,
    code: str,
    severity: str,
    owner: str,
    summary: str,
    ref: str | None = None,
) -> None:
    item: dict[str, Any] = {
        "domain": domain,
        "code": code,
        "severity": severity,
        "owner": owner,
        "summary": summary,
    }
    if ref:
        item["ref"] = ref
    findings.append(item)


def warn(warnings: list[dict[str, str]], domain: str, message: str, path: Path | None = None) -> None:
    item = {"domain": domain, "message": message}
    if path is not None:
        item["path"] = os.fspath(path)
    warnings.append(item)


def open_optional_db(path: Path, domain: str, warnings: list[dict[str, str]]) -> sqlite3.Connection | None:
    if not path.exists():
        warn(warnings, domain, "database not found; audit skipped", path)
        return None
    try:
        return connect_read_only(path)
    except sqlite3.Error as error:
        warn(warnings, domain, f"database open failed: {error}", path)
        return None


def audit_runtime(paths: AuditInputs, findings: list[dict[str, Any]], warnings: list[dict[str, str]]) -> None:
    conn = open_optional_db(paths.runtime_db, "runtime", warnings)
    if conn is None:
        return
    try:
        required = {"tasks", "agent_runs"}
        missing = sorted(table for table in required if not table_exists(conn, table))
        if missing:
            warn(warnings, "runtime", f"missing tables: {', '.join(missing)}", paths.runtime_db)
            return
        for row in row_dicts(
            conn,
            """
            select t.task_id, t.status as task_status, r.run_id, r.status as run_status
            from tasks t
            join agent_runs r on r.turn_id = t.task_id
            where t.status in ('completed', 'failed', 'cancelled', 'expired')
              and r.status = 'running'
            order by t.updated_at desc, r.started_at desc
            limit 100
            """,
        ):
            finding(
                findings,
                domain="chat_runtime",
                code="terminal_task_with_running_agent_run",
                severity="error",
                owner="agent_run_projection",
                summary=f"terminal task {row['task_id']} is {row['task_status']} but agent run is still running",
                ref=row["run_id"],
            )
        for row in row_dicts(
            conn,
            """
            select r.run_id, r.turn_id, r.thread_id, r.started_at
            from agent_runs r
            left join tasks t on t.task_id = r.turn_id
            where r.status = 'running'
              and (t.task_id is null or t.status not in (
                'queued', 'pending', 'running', 'waiting_time',
                'waiting_external_event', 'waiting_user_approval',
                'waiting_resource', 'paused', 'parked'
              ))
            order by r.started_at desc
            limit 100
            """,
        ):
            finding(
                findings,
                domain="chat_runtime",
                code="running_agent_run_without_active_task",
                severity="error",
                owner="agent_run_projection",
                summary="running agent run has no matching active task",
                ref=row["run_id"],
            )
        if table_exists(conn, "chat_messages") and column_exists(conn, "chat_messages", "delivery_state"):
            for row in row_dicts(
                conn,
                """
                select m.id, m.thread_id, m.linked_task_id, m.delivery_state
                from chat_messages m
                left join agent_runs r on r.turn_id = m.linked_task_id and r.status = 'running'
                where m.role = 'assistant'
                  and m.delivery_state in ('streaming', 'retrying')
                  and coalesce(m.linked_task_id, '') <> ''
                  and r.run_id is null
                order by m.timestamp desc
                limit 100
                """,
            ):
                finding(
                    findings,
                    domain="chat_runtime",
                    code="streaming_assistant_without_active_run",
                    severity="error",
                    owner="message_delivery_projection",
                    summary=f"assistant message remains {row['delivery_state']} without an active agent run",
                    ref=row["id"],
                )
        if table_exists(conn, "turn_events"):
            terminal_wait_exemptions: list[str] = []
            if table_exists(conn, "task_approvals"):
                terminal_wait_exemptions.append(
                    """
                    exists (
                      select 1 from task_approvals a
                      where a.task_id = t.task_id
                        and a.user_id = t.user_id
                        and a.workspace_id = t.workspace_id
                        and a.status = 'pending'
                    )
                    """
                )
            if table_exists(conn, "thread_hitl_waits"):
                terminal_wait_exemptions.append(
                    """
                    exists (
                      select 1 from thread_hitl_waits h
                      where h.thread_id = t.thread_id
                        and h.status = 'open'
                    )
                    """
                )
            terminal_wait_clause = ""
            if terminal_wait_exemptions:
                terminal_wait_clause = f"""
                  and not (
                    t.status = 'waiting_user_approval'
                    and ({' or '.join(terminal_wait_exemptions)})
                  )
                """
            for row in row_dicts(
                conn,
                f"""
                select t.task_id, t.status as task_status, max(e.created_at) as terminal_at
                from tasks t
                join turn_events e on e.turn_id = t.task_id
                where t.status in (
                  'queued', 'pending', 'running', 'waiting_time',
                  'waiting_external_event', 'waiting_user_approval',
                  'waiting_resource', 'paused', 'parked'
                )
                  and e.kind in ('done', 'error', 'cancelled')
                {terminal_wait_clause}
                group by t.task_id, t.status
                order by terminal_at desc
                limit 100
                """,
            ):
                finding(
                    findings,
                    domain="chat_runtime",
                    code="active_task_with_terminal_turn_event",
                    severity="error",
                    owner="turn_lifecycle_projection",
                    summary=f"active task {row['task_id']} is {row['task_status']} but has a terminal turn event",
                    ref=row["task_id"],
                )
            for row in row_dicts(
                conn,
                """
                select t.task_id
                from tasks t
                join turn_events e on e.turn_id = t.task_id
                where t.status = 'completed'
                  and e.payload_json like '%browser_budget_exceeded%'
                group by t.task_id
                order by max(e.created_at) desc
                limit 100
                """,
            ):
                finding(
                    findings,
                    domain="browser",
                    code="completed_task_with_browser_budget_exceeded",
                    severity="error",
                    owner="browser_outcome_projection",
                    summary="completed task contains a browser budget exhaustion event",
                    ref=row["task_id"],
                )
            latest_plan_by_turn: dict[str, tuple[str, int, str]] = {}
            for row in row_dicts(
                conn,
                """
                select t.task_id, t.thread_id, e.seq, e.payload_json
                from tasks t
                join turn_events e on e.turn_id = t.task_id
                where t.kind = 'chat_turn'
                  and t.status = 'completed'
                  and e.kind = 'plan_update'
                order by t.updated_at desc, e.seq asc
                limit 5000
                """,
            ):
                payload = json_object(row["payload_json"])
                markdown = str(payload.get("markdown") or "")
                latest_plan_by_turn[row["task_id"]] = (
                    str(row["thread_id"] or ""),
                    int(row["seq"]),
                    markdown,
                )
            for task_id, (thread_id, _seq, markdown) in latest_plan_by_turn.items():
                if not plan_markdown_is_incomplete(markdown):
                    continue
                if not thread_has_open_runtime_plan(conn, thread_id):
                    continue
                delivered_answer = events_have_delivered_answer_after_plan(
                    row_dicts(
                        conn,
                        """
                        select seq, kind, payload_json
                        from turn_events
                        where turn_id = ?
                          and kind in ('delta', 'done')
                          and seq > ?
                        order by seq asc
                        limit 5000
                        """,
                        (task_id, _seq),
                    )
                )
                if delivered_answer:
                    finding(
                        findings,
                        domain="chat_runtime",
                        code="completed_turn_with_unreconciled_delivered_plan",
                        severity="warning",
                        owner="runtime_plan_projection",
                        summary="completed chat turn delivered an answer after an open latest plan_update",
                        ref=task_id,
                    )
                    continue
                finding(
                    findings,
                    domain="chat_runtime",
                    code="completed_turn_with_incomplete_plan",
                    severity="error",
                    owner="runtime_plan_projection",
                    summary="completed chat turn has a latest plan_update with an open step",
                    ref=task_id,
                )
        if table_exists(conn, "task_approvals"):
            for row in row_dicts(
                conn,
                """
                select t.task_id, t.thread_id
                from tasks t
                where t.status = 'waiting_user_approval'
                  and not exists (
                    select 1 from task_approvals a
                    where a.task_id = t.task_id
                      and a.user_id = t.user_id
                      and a.workspace_id = t.workspace_id
                      and a.status = 'pending'
                  )
                  and (
                    not exists (
                      select 1 from sqlite_master
                      where type in ('table', 'view') and name = 'thread_hitl_waits'
                    )
                    or not exists (
                      select 1 from thread_hitl_waits h
                      where h.thread_id = t.thread_id
                        and h.status = 'open'
                    )
                  )
                order by t.updated_at desc
                limit 100
                """,
            ):
                finding(
                    findings,
                    domain="chat_runtime",
                    code="waiting_approval_task_without_canonical_approval",
                    severity="error",
                    owner="approval_projection",
                    summary="task waits for user approval but no canonical pending approval or open HITL wait is visible",
                    ref=row["task_id"],
                )
        if table_exists(conn, "execution_wakes"):
            for row in row_dicts(
                conn,
                """
                select t.task_id
                from tasks t
                where t.status = 'waiting_time'
                  and not exists (
                    select 1 from execution_wakes w
                    where w.execution_id = t.task_id
                      and w.status = 'pending'
                  )
                order by t.updated_at desc
                limit 100
                """,
            ):
                finding(
                    findings,
                    domain="chat_runtime",
                    code="waiting_time_task_without_pending_wake",
                    severity="error",
                    owner="execution_wake_projection",
                    summary="task waits for time but no canonical pending execution wake is visible",
                    ref=row["task_id"],
                )
        if table_exists(conn, "thread_hitl_waits"):
            for row in row_dicts(
                conn,
                """
                select wait_id, thread_id, resolved_at
                from thread_hitl_waits
                where status = 'resolved'
                  and resolved_at is not null
                  and exists (
                    select 1 from agent_runs r
                    where r.thread_id = thread_hitl_waits.thread_id
                  )
                  and not exists (
                    select 1 from agent_runs r
                    where r.thread_id = thread_hitl_waits.thread_id
                      and r.started_at >= thread_hitl_waits.resolved_at
                  )
                order by resolved_at desc
                limit 100
                """,
            ):
                finding(
                    findings,
                    domain="chat_runtime",
                    code="resolved_hitl_without_followup_run",
                    severity="warning",
                    owner="hitl_resume",
                    summary="resolved HITL wait has no later agent run in the same thread",
                    ref=row["wait_id"],
                )
        if all(column_exists(conn, "agent_runs", column) for column in ("role", "model", "provider")):
            snapshot_evidence_clause = ""
            if table_exists(conn, "agent_run_events"):
                snapshot_evidence_clause = """
                    and not exists (
                        select 1
                        from agent_run_events e
                        where e.run_id = agent_runs.run_id
                          and e.kind = 'prompt_snapshot'
                          and coalesce(json_extract(e.payload_json, '$.model'), '') <> ''
                          and coalesce(json_extract(e.payload_json, '$.provider'), '') <> ''
                    )
                """
            for row in row_dicts(
                conn,
                f"""
                select run_id, role, model, provider, status
                from agent_runs
                where status in ('running', 'completed', 'failed', 'aborted')
                  and (
                    coalesce(role, '') = ''
                    or (
                      (coalesce(model, '') = '' or coalesce(provider, '') = '')
                      {snapshot_evidence_clause}
                    )
                  )
                order by started_at desc
                limit 100
                """,
            ):
                finding(
                    findings,
                    domain="model_routing",
                    code="agent_run_missing_model_attribution",
                    severity="warning",
                    owner="model_routing",
                    summary="agent run lacks role/model/provider attribution",
                    ref=row["run_id"],
                )
    finally:
        conn.close()


def sensitive_detector(text: str) -> str | None:
    scrubbed = re.sub(r"\[VAULT:[^\]]+\]", "[VAULT]", text)
    scrubbed = scrubbed.replace("[REDACTED]", "")
    for label, pattern in SENSITIVE_PATTERNS:
        if pattern.search(scrubbed):
            return label
    return None


def audit_memory(paths: AuditInputs, findings: list[dict[str, Any]], warnings: list[dict[str, str]]) -> None:
    conn = open_optional_db(paths.memory_db, "memory", warnings)
    if conn is None:
        return
    try:
        if not table_exists(conn, "memories"):
            warn(warnings, "memory", "missing table: memories", paths.memory_db)
            return
        for row in row_dicts(
            conn,
            """
            select ref, status, text, sensitivity
            from memories
            where status not in ('Deleted', 'Rejected', 'Stale', 'deleted', 'rejected', 'stale')
            limit 1000
            """,
        ):
            detector = sensitive_detector(row.get("text") or "")
            if detector:
                finding(
                    findings,
                    domain="memory",
                    code="memory_contains_sensitive_plaintext",
                    severity="error",
                    owner="memory_admission_privacy",
                    summary=f"live memory text matches sensitive detector {detector}",
                    ref=row["ref"],
                )
            if (row.get("sensitivity") or "").lower() == "secret":
                finding(
                    findings,
                    domain="memory",
                    code="active_secret_memory_requires_vault_review",
                    severity="warning",
                    owner="memory_admission_privacy",
                    summary="live memory is marked Secret and should be reviewed for Vault containment",
                    ref=row["ref"],
                )
        if table_exists(conn, "memory_evidence"):
            for row in row_dicts(
                conn,
                """
                select m.ref, m.memory_type, m.metadata_json
                from memories m
                left join memory_evidence e on e.memory_ref = m.ref
                where m.status not in ('Deleted', 'Rejected', 'Stale', 'deleted', 'rejected', 'stale')
                  and e.memory_ref is null
                limit 100
                """,
            ):
                metadata = json_object(row.get("metadata_json"))
                if metadata.get("source") in {"runtime_plan", "runtime_plan_step"}:
                    continue
                if (
                    (row.get("memory_type") or "") == "episode"
                    and metadata.get("scope") == "thread"
                ):
                    continue
                admission = metadata.get("admission") if isinstance(metadata.get("admission"), dict) else None
                is_legacy = admission is None
                finding(
                    findings,
                    domain="memory",
                    code="legacy_memory_without_evidence" if is_legacy else "memory_without_evidence",
                    severity="warning",
                    owner="memory_provenance",
                    summary=(
                        "legacy live memory has no admission metadata or evidence link"
                        if is_legacy
                        else "live memory with admission metadata has no evidence link"
                    ),
                    ref=row["ref"],
                )
    finally:
        conn.close()


def audit_vault(paths: AuditInputs, findings: list[dict[str, Any]], warnings: list[dict[str, str]]) -> None:
    conn = open_optional_db(paths.vault_db, "vault", warnings)
    if conn is None:
        return
    try:
        required = {"vault_records", "vault_secret_material"}
        missing = sorted(table for table in required if not table_exists(conn, table))
        if missing:
            warn(warnings, "vault", f"missing tables: {', '.join(missing)}", paths.vault_db)
            return
        for row in row_dicts(
            conn,
            """
            select r.id
            from vault_records r
            left join vault_secret_material m on m.record_id = r.id
            where m.record_id is null
            limit 100
            """,
        ):
            finding(
                findings,
                domain="vault",
                code="vault_record_missing_secret_material",
                severity="error",
                owner="vault_store_integrity",
                summary="Vault record has no encrypted secret material row",
                ref=row["id"],
            )
        for row in row_dicts(
            conn,
            """
            select m.record_id
            from vault_secret_material m
            left join vault_records r on r.id = m.record_id
            where r.id is null
            limit 100
            """,
        ):
            finding(
                findings,
                domain="vault",
                code="vault_secret_material_orphan",
                severity="error",
                owner="vault_store_integrity",
                summary="encrypted secret material has no Vault record",
                ref=row["record_id"],
            )
    finally:
        conn.close()


def iter_log_files(logs_dir: Path) -> Iterable[Path]:
    if not logs_dir.exists():
        return []
    return (
        path
        for path in sorted(logs_dir.rglob("*"))
        if path.is_file() and path.suffix.lower() in LOG_EXTENSIONS
    )


def audit_logs(paths: AuditInputs, findings: list[dict[str, Any]], warnings: list[dict[str, str]]) -> None:
    if not paths.logs_dir.exists():
        warn(warnings, "privacy_logs", "logs directory not found; audit skipped", paths.logs_dir)
        return
    for path in iter_log_files(paths.logs_dir):
        try:
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                for line_number, line in enumerate(handle, 1):
                    detector = sensitive_detector(line)
                    if detector:
                        finding(
                            findings,
                            domain="privacy_logs",
                            code="log_contains_sensitive_plaintext",
                            severity="error",
                            owner="gateway_text_safety",
                            summary=f"log line matches sensitive detector {detector}",
                            ref=f"{path}:{line_number}",
                        )
        except OSError as error:
            warn(warnings, "privacy_logs", f"log read failed: {error}", path)


def audit_routing_decisions(
    paths: AuditInputs,
    findings: list[dict[str, Any]],
    warnings: list[dict[str, str]],
) -> None:
    if not paths.routing_decisions.exists():
        warn(warnings, "model_routing", "routing decisions log not found; audit skipped", paths.routing_decisions)
        return
    try:
        decisions = json.loads(paths.routing_decisions.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        finding(
            findings,
            domain="model_routing",
            code="routing_decisions_invalid_json",
            severity="error",
            owner="model_routing",
            summary=f"routing decisions log is unreadable: {error}",
            ref=os.fspath(paths.routing_decisions),
        )
        return
    if not isinstance(decisions, list):
        finding(
            findings,
            domain="model_routing",
            code="routing_decisions_invalid_shape",
            severity="error",
            owner="model_routing",
            summary="routing decisions log root is not a list",
            ref=os.fspath(paths.routing_decisions),
        )
        return
    for index, decision in enumerate(decisions[-100:]):
        if not isinstance(decision, dict):
            continue
        stage = decision.get("stage")
        provider = str(decision.get("chosen_provider") or "").strip()
        model = str(decision.get("chosen_model") or "").strip()
        candidates = decision.get("candidates")
        if stage not in ALLOWED_ROUTING_STAGES or not provider or not model or not candidates:
            finding(
                findings,
                domain="model_routing",
                code="routing_decision_unexplained",
                severity="warning",
                owner="model_routing",
                summary="routing decision lacks accepted stage, chosen provider/model, or candidates",
                ref=f"{paths.routing_decisions}:{index}",
            )


def safe_payload_summary(raw: str | None) -> dict[str, Any]:
    """Extract non-sensitive diagnostic fields without returning raw payloads."""
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return {"payload": "invalid_json"}
    if not isinstance(payload, dict):
        return {"payload": type(payload).__name__}
    summary: dict[str, Any] = {}
    for key in ("status", "code", "error_code", "tool", "tool_name", "terminal_reason"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            summary[key] = scrub_observability_value(value)
    tool_calls = payload.get("tool_calls")
    if isinstance(tool_calls, list):
        names = []
        for call in tool_calls[:5]:
            name = call.get("name") if isinstance(call, dict) else None
            if isinstance(name, str) and name.strip():
                names.append(scrub_observability_value(name))
        if names:
            summary["tool_calls"] = names
            summary["tool_call_count"] = len(tool_calls)
    return summary


def scrub_observability_value(value: str) -> str:
    stripped = value.strip()
    if sensitive_detector(stripped):
        return "[REDACTED]"
    if len(stripped) > 160:
        return f"{stripped[:157]}..."
    return stripped


def add_diagnostic_gap(
    gaps: list[dict[str, Any]],
    *,
    code: str,
    owner: str,
    summary: str,
    ref: str,
    severity: str = "warning",
) -> None:
    gaps.append(
        {
            "code": code,
            "severity": severity,
            "owner": owner,
            "summary": summary,
            "ref": ref,
        }
    )


def build_runtime_observability(
    paths: AuditInputs,
    warnings: list[dict[str, str]],
    *,
    max_timelines: int = 20,
    max_gaps: int = 100,
    max_events_per_timeline: int = 120,
) -> dict[str, Any]:
    conn = open_optional_db(paths.runtime_db, "runtime_observability", warnings)
    if conn is None:
        return {"summary": {"timelines": 0, "diagnostic_gaps": 0}, "timelines": [], "diagnostic_gaps": []}
    try:
        required = {"tasks", "agent_runs", "turn_events"}
        missing = sorted(table for table in required if not table_exists(conn, table))
        if missing:
            warn(
                warnings,
                "runtime_observability",
                f"missing tables: {', '.join(missing)}",
                paths.runtime_db,
            )
            return {"summary": {"timelines": 0, "diagnostic_gaps": 0}, "timelines": [], "diagnostic_gaps": []}

        recent_tasks = row_dicts(
            conn,
            """
            select task_id, thread_id, user_id, workspace_id, status, created_at,
                   updated_at, blocked_reason
            from tasks
            where kind = 'chat_turn'
            order by updated_at desc, created_at desc
            limit ?
            """,
            (max_timelines,),
        )
        timelines = [
            build_turn_timeline(conn, task, max_events=max_events_per_timeline)
            for task in recent_tasks
        ]
        gaps = build_runtime_diagnostic_gaps(conn, max_gaps=max_gaps)
        return {
            "summary": {
                "timelines": len(timelines),
                "diagnostic_gaps": len(gaps),
            },
            "timelines": timelines,
            "diagnostic_gaps": gaps,
        }
    finally:
        conn.close()


def build_turn_timeline(
    conn: sqlite3.Connection,
    task: dict[str, Any],
    *,
    max_events: int = 120,
) -> dict[str, Any]:
    turn_id = task["task_id"]
    runs = row_dicts(
        conn,
        """
        select run_id, attempt, status, role, model, provider, started_at,
               completed_at, terminal_reason
        from agent_runs
        where turn_id = ?
        order by attempt asc, started_at asc
        """,
        (turn_id,),
    )
    turn_events = row_dicts(
        conn,
        """
        select seq, kind, payload_json, created_at
        from turn_events
        where turn_id = ?
        order by seq asc
        """,
        (turn_id,),
    )
    run_events: list[dict[str, Any]] = []
    if table_exists(conn, "agent_run_events"):
        run_events = row_dicts(
            conn,
            """
            select e.run_id, e.seq, e.round, e.kind, e.payload_json, e.created_at
            from agent_run_events e
            join agent_runs r on r.run_id = e.run_id
            where r.turn_id = ?
            order by e.created_at asc, e.seq asc
            """,
            (turn_id,),
        )

    events: list[dict[str, Any]] = [
        {
            "phase": "task_created",
            "at": task["created_at"],
            "status": task["status"],
        }
    ]
    for run in runs:
        events.append(
            {
                "phase": "run_started",
                "at": run["started_at"],
                "run_id": run["run_id"],
                "attempt": run["attempt"],
                "status": run["status"],
                "role": run.get("role") or None,
                "provider": run.get("provider") or None,
                "model": run.get("model") or None,
            }
        )
        if run.get("completed_at") is not None:
            run_completed = {
                "phase": "run_completed",
                "at": run["completed_at"],
                "run_id": run["run_id"],
                "status": run["status"],
            }
            if run.get("terminal_reason"):
                run_completed["terminal_reason"] = run["terminal_reason"]
            events.append(run_completed)
    for event in run_events:
        timeline_event = {
            "phase": f"run_event:{event['kind']}",
            "at": event["created_at"],
            "run_id": event["run_id"],
            "seq": event["seq"],
        }
        if event.get("round") is not None:
            timeline_event["round"] = event["round"]
        summary = safe_payload_summary(event.get("payload_json"))
        if summary:
            timeline_event["payload"] = summary
        events.append(timeline_event)
    for event in turn_events:
        timeline_event = {
            "phase": f"turn_event:{event['kind']}",
            "at": event["created_at"],
            "seq": event["seq"],
        }
        summary = safe_payload_summary(event.get("payload_json"))
        if summary:
            timeline_event["payload"] = summary
        events.append(timeline_event)
    events.append(
        {
            "phase": "task_updated",
            "at": task["updated_at"],
            "status": task["status"],
        }
    )
    events.sort(key=lambda item: (item.get("at") is None, item.get("at") or 0, phase_sort_key(item["phase"])))
    events_total = len(events)
    events = cap_timeline_events(events, max_events)
    events_omitted = sum(
        int(event.get("count") or 0)
        for event in events
        if event.get("phase") == "events_omitted"
    )

    latest_run = runs[-1] if runs else {}
    return {
        "turn_id": turn_id,
        "thread_id": task.get("thread_id"),
        "status": task["status"],
        "blocked_reason": task.get("blocked_reason"),
        "model": {
            "role": latest_run.get("role") or None,
            "provider": latest_run.get("provider") or None,
            "model": latest_run.get("model") or None,
        },
        "events_total": events_total,
        "events_omitted": events_omitted,
        "events": events,
    }


def cap_timeline_events(events: list[dict[str, Any]], max_events: int) -> list[dict[str, Any]]:
    if max_events <= 0:
        return [{"phase": "events_omitted", "count": len(events)}] if events else []
    if len(events) <= max_events:
        return events
    if max_events == 1:
        return [{"phase": "events_omitted", "count": len(events)}]

    prefix_count = min(10, max(1, max_events // 3))
    suffix_count = max_events - prefix_count - 1
    if suffix_count <= 0:
        prefix_count = max_events - 1
        suffix_count = 0
    omitted = len(events) - prefix_count - suffix_count
    capped = [*events[:prefix_count], {"phase": "events_omitted", "count": omitted}]
    if suffix_count:
        capped.extend(events[-suffix_count:])
    return capped


def phase_sort_key(phase: str) -> int:
    order = {
        "task_created": 0,
        "run_started": 1,
        "run_completed": 90,
        "task_updated": 100,
    }
    if phase.startswith("run_event:"):
        return 10
    if phase.startswith("turn_event:"):
        return 80
    return order.get(phase, 50)


def build_runtime_diagnostic_gaps(conn: sqlite3.Connection, *, max_gaps: int) -> list[dict[str, Any]]:
    gaps: list[dict[str, Any]] = []
    for row in row_dicts(
        conn,
        """
        select run_id, status
        from agent_runs
        where status in ('completed', 'failed', 'aborted')
          and coalesce(terminal_reason, '') = ''
        order by completed_at desc, started_at desc
        limit ?
        """,
        (max_gaps,),
    ):
        add_diagnostic_gap(
            gaps,
            code=f"{row['status']}_run_missing_terminal_reason",
            owner="agent_run_projection",
            summary=f"{row['status']} agent run has no terminal_reason",
            ref=row["run_id"],
        )
    remaining = max(0, max_gaps - len(gaps))
    if remaining:
        snapshot_evidence_clause = ""
        if table_exists(conn, "agent_run_events"):
            snapshot_evidence_clause = """
                 and not exists (
                   select 1
                   from agent_run_events e
                   where e.run_id = agent_runs.run_id
                     and e.kind = 'prompt_snapshot'
                     and coalesce(json_extract(e.payload_json, '$.model'), '') <> ''
                     and coalesce(json_extract(e.payload_json, '$.provider'), '') <> ''
                 )
            """
        for row in row_dicts(
            conn,
            f"""
            select run_id
            from agent_runs
            where status in ('running', 'completed', 'failed', 'aborted')
              and (
                coalesce(role, '') = ''
                or (
                  (coalesce(model, '') = '' or coalesce(provider, '') = '')
                  {snapshot_evidence_clause}
                )
              )
            order by started_at desc
            limit ?
            """,
            (remaining,),
        ):
            add_diagnostic_gap(
                gaps,
                code="run_missing_model_attribution",
                owner="model_routing",
                summary="agent run lacks role/model/provider, so Auto/Unavailable cannot be explained from the run row",
                ref=row["run_id"],
            )
    remaining = max(0, max_gaps - len(gaps))
    if remaining and table_exists(conn, "agent_run_events"):
        for row in row_dicts(
            conn,
            """
            select r.run_id
            from agent_runs r
            left join agent_run_events e on e.run_id = r.run_id
            where r.status in ('running', 'completed', 'failed', 'aborted')
              and e.run_id is null
            order by r.started_at desc
            limit ?
            """,
            (remaining,),
        ):
            add_diagnostic_gap(
                gaps,
                code="run_without_agent_run_events",
                owner="agent_journal",
                summary="agent run has no round/tool/model journal events",
                ref=row["run_id"],
            )
    remaining = max(0, max_gaps - len(gaps))
    if remaining:
        for row in row_dicts(
            conn,
            """
            select t.task_id
            from tasks t
            left join turn_events e on e.turn_id = t.task_id
            where t.kind = 'chat_turn'
              and t.status not in ('queued', 'pending')
              and e.turn_id is null
            order by t.updated_at desc
            limit ?
            """,
            (remaining,),
        ):
            add_diagnostic_gap(
                gaps,
                code="turn_without_turn_events",
                owner="turn_executor",
                summary="non-pending chat turn has no durable turn_events timeline",
                ref=row["task_id"],
            )
    return gaps


def summarize_findings(findings: list[dict[str, Any]]) -> dict[str, Any]:
    by_code: dict[str, dict[str, Any]] = {}
    by_domain: dict[str, int] = {}
    errors = 0
    warnings = 0
    for item in findings:
        code = item["code"]
        domain = item["domain"]
        severity = item["severity"]
        by_domain[domain] = by_domain.get(domain, 0) + 1
        bucket = by_code.setdefault(
            code,
            {
                "count": 0,
                "omitted": 0,
                "domain": domain,
                "severity": severity,
                "owner": item["owner"],
            },
        )
        bucket["count"] += 1
        if severity == "error":
            errors += 1
        else:
            warnings += 1
    return {
        "total": len(findings),
        "errors": errors,
        "warnings": warnings,
        "by_domain": dict(sorted(by_domain.items())),
        "by_code": dict(sorted(by_code.items())),
    }


def cap_findings_by_code(
    findings: list[dict[str, Any]],
    summary: dict[str, Any],
    max_findings_per_code: int,
) -> list[dict[str, Any]]:
    if max_findings_per_code <= 0:
        for bucket in summary["by_code"].values():
            bucket["omitted"] = bucket["count"]
        return []
    kept: list[dict[str, Any]] = []
    seen: dict[str, int] = {}
    for item in findings:
        code = item["code"]
        current = seen.get(code, 0)
        if current < max_findings_per_code:
            kept.append(item)
        seen[code] = current + 1
    for code, count in seen.items():
        summary["by_code"][code]["omitted"] = max(0, count - max_findings_per_code)
    return kept


def audit_homun_state(
    inputs: AuditInputs | None = None,
    *,
    max_findings_per_code: int = 20,
    max_timeline_events: int = 120,
) -> dict[str, Any]:
    paths = inputs or default_inputs()
    findings: list[dict[str, Any]] = []
    warnings: list[dict[str, str]] = []
    audit_runtime(paths, findings, warnings)
    audit_memory(paths, findings, warnings)
    audit_vault(paths, findings, warnings)
    audit_logs(paths, findings, warnings)
    audit_routing_decisions(paths, findings, warnings)
    observability = build_runtime_observability(
        paths,
        warnings,
        max_events_per_timeline=max_timeline_events,
    )
    findings.sort(key=lambda item: (item["severity"] != "error", item["domain"], item["code"], item.get("ref", "")))
    summary = summarize_findings(findings)
    capped_findings = cap_findings_by_code(findings, summary, max_findings_per_code)
    return {
        "ok": summary["errors"] == 0,
        "summary": summary,
        "observability": observability,
        "findings": capped_findings,
        "warnings": warnings,
        "paths": {
            "data_dir": os.fspath(paths.data_dir) if paths.data_dir is not None else None,
            "runtime_db": os.fspath(paths.runtime_db),
            "memory_db": os.fspath(paths.memory_db),
            "vault_db": os.fspath(paths.vault_db),
            "logs_dir": os.fspath(paths.logs_dir),
            "routing_decisions": os.fspath(paths.routing_decisions),
            "sources": {
                "data_dir": paths.data_dir_source,
                "runtime_db": paths.runtime_db_source,
                "memory_db": paths.memory_db_source,
                "vault_db": paths.vault_db_source,
                "logs_dir": paths.logs_dir_source,
                "routing_decisions": paths.routing_decisions_source,
            },
        },
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data-dir",
        type=Path,
        help="Audit a complete Homun profile directory; individual path flags still override this",
    )
    parser.add_argument("--runtime-db", type=Path)
    parser.add_argument("--memory-db", type=Path)
    parser.add_argument("--vault-db", type=Path)
    parser.add_argument("--logs-dir", type=Path)
    parser.add_argument("--routing-decisions", type=Path)
    parser.add_argument(
        "--max-findings-per-code",
        type=int,
        default=20,
        help="Maximum sample findings to print per finding code; summary keeps total counts",
    )
    parser.add_argument(
        "--max-timeline-events",
        type=int,
        default=120,
        help="Maximum sample events to print per runtime timeline; summary keeps total counts",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    report = audit_homun_state(
        inputs_from_args(args),
        max_findings_per_code=args.max_findings_per_code,
        max_timeline_events=args.max_timeline_events,
    )
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
