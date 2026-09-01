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


def default_data_dir() -> Path:
    if value := os.environ.get("HOMUN_DATA_DIR"):
        return Path(value)
    return Path(os.path.expanduser("~/.homun"))


def default_inputs() -> AuditInputs:
    root = default_data_dir()
    return AuditInputs(
        runtime_db=Path(os.environ.get("HOMUN_DESKTOP_GATEWAY_DB", root / "homun.sqlite")),
        memory_db=Path(os.environ.get("HOMUN_MEMORY_DB", root / "memory.sqlite")),
        vault_db=Path(os.environ.get("HOMUN_VAULT_DB", root / "vault.sqlite")),
        logs_dir=root / "logs",
        routing_decisions=root / "routing-decisions.json",
    )


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
        if table_exists(conn, "thread_hitl_waits"):
            for row in row_dicts(
                conn,
                """
                select wait_id, thread_id, resolved_at
                from thread_hitl_waits
                where status = 'resolved'
                  and resolved_at is not null
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
            for row in row_dicts(
                conn,
                """
                select run_id, role, model, provider, status
                from agent_runs
                where status in ('running', 'completed', 'failed', 'aborted')
                  and (coalesce(role, '') = '' or coalesce(model, '') = '' or coalesce(provider, '') = '')
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
                select m.ref
                from memories m
                left join memory_evidence e on e.memory_ref = m.ref
                where m.status not in ('Deleted', 'Rejected', 'Stale', 'deleted', 'rejected', 'stale')
                  and e.memory_ref is null
                limit 100
                """,
            ):
                finding(
                    findings,
                    domain="memory",
                    code="memory_without_evidence",
                    severity="warning",
                    owner="memory_provenance",
                    summary="live memory has no evidence link",
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
) -> dict[str, Any]:
    paths = inputs or default_inputs()
    findings: list[dict[str, Any]] = []
    warnings: list[dict[str, str]] = []
    audit_runtime(paths, findings, warnings)
    audit_memory(paths, findings, warnings)
    audit_vault(paths, findings, warnings)
    audit_logs(paths, findings, warnings)
    audit_routing_decisions(paths, findings, warnings)
    findings.sort(key=lambda item: (item["severity"] != "error", item["domain"], item["code"], item.get("ref", "")))
    summary = summarize_findings(findings)
    capped_findings = cap_findings_by_code(findings, summary, max_findings_per_code)
    return {
        "ok": summary["errors"] == 0,
        "summary": summary,
        "findings": capped_findings,
        "warnings": warnings,
        "paths": {
            "runtime_db": os.fspath(paths.runtime_db),
            "memory_db": os.fspath(paths.memory_db),
            "vault_db": os.fspath(paths.vault_db),
            "logs_dir": os.fspath(paths.logs_dir),
            "routing_decisions": os.fspath(paths.routing_decisions),
        },
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    defaults = default_inputs()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-db", type=Path, default=defaults.runtime_db)
    parser.add_argument("--memory-db", type=Path, default=defaults.memory_db)
    parser.add_argument("--vault-db", type=Path, default=defaults.vault_db)
    parser.add_argument("--logs-dir", type=Path, default=defaults.logs_dir)
    parser.add_argument("--routing-decisions", type=Path, default=defaults.routing_decisions)
    parser.add_argument(
        "--max-findings-per-code",
        type=int,
        default=20,
        help="Maximum sample findings to print per finding code; summary keeps total counts",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    report = audit_homun_state(
        AuditInputs(
            runtime_db=args.runtime_db,
            memory_db=args.memory_db,
            vault_db=args.vault_db,
            logs_dir=args.logs_dir,
            routing_decisions=args.routing_decisions,
        ),
        max_findings_per_code=args.max_findings_per_code,
    )
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
