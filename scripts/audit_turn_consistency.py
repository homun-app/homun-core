#!/usr/bin/env python3
"""Audit one Homun turn for Runtime v2 state contradictions.

This command is read-only. It does not repair rows and does not define runtime
truth. It reports contradictions that the Rust reducer and downstream
projections must eliminate.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
from pathlib import Path
from typing import Any


TERMINAL_TASK_STATUSES = {"completed", "failed", "cancelled", "expired"}
REDUCED_TERMINAL_STATUSES = {"completed", "failed", "cancelled"}
TERMINAL_EVENT_KINDS = {"done", "error", "cancelled"}
ACTIVE_AFTER_TERMINAL_KINDS = {
    "activity",
    "plan_update",
    "step_advance",
    "heartbeat",
}


def default_db_path() -> Path:
    return Path(os.path.expanduser("~/.homun/homun.sqlite"))


def connect_read_only(db_path: Path) -> sqlite3.Connection:
    if not db_path.exists():
        raise FileNotFoundError(db_path)
    return sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)


def rows(
    conn: sqlite3.Connection,
    query: str,
    params: tuple[Any, ...],
) -> list[dict[str, Any]]:
    conn.row_factory = sqlite3.Row
    return [dict(row) for row in conn.execute(query, params).fetchall()]


def one(
    conn: sqlite3.Connection,
    query: str,
    params: tuple[Any, ...],
) -> dict[str, Any] | None:
    conn.row_factory = sqlite3.Row
    row = conn.execute(query, params).fetchone()
    return dict(row) if row else None


def parse_json(raw: str | None) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"_invalid_json": raw}


def assistant_identity(task: dict[str, Any] | None) -> tuple[str | None, str | None]:
    if not task:
        return None, None
    task_json = parse_json(task.get("task_json")) or {}
    input_json = task_json.get("input_json") if isinstance(task_json, dict) else {}
    thread_id = task.get("thread_id") or input_json.get("thread_id")
    assistant_message_id = input_json.get("assistant_message_id")
    return thread_id, assistant_message_id


def expected_agent_run_statuses(task_status: str | None) -> set[str]:
    if task_status == "completed":
        return {"completed"}
    if task_status == "failed":
        return {"failed"}
    if task_status in {"cancelled", "expired"}:
        return {"aborted"}
    return set()


def reduce_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    ordered = sorted(events, key=lambda row: (row["seq"], row["event_id"]))
    status = "empty"
    terminal_seq = None
    terminal_kind = None
    failure_text = None
    contradictions: list[dict[str, str]] = []
    for event in ordered:
        kind = event["kind"]
        payload = parse_json(event.get("payload_json")) or {}
        if terminal_kind:
            if kind in TERMINAL_EVENT_KINDS:
                contradictions.append(
                    {
                        "code": "multiple_terminal_events",
                        "detail": f"{kind} at seq {event['seq']} after {terminal_kind} at seq {terminal_seq}",
                        "owner_to_remove": "terminal_writer",
                    }
                )
            elif kind in ACTIVE_AFTER_TERMINAL_KINDS:
                contradictions.append(
                    {
                        "code": "event_after_terminal",
                        "detail": f"{kind} at seq {event['seq']} after terminal event",
                        "owner_to_remove": "activity_projection",
                    }
                )
            continue
        if kind == "done":
            status = "completed"
            terminal_seq = event["seq"]
            terminal_kind = kind
        elif kind == "error":
            status = "failed"
            terminal_seq = event["seq"]
            terminal_kind = kind
            text = payload.get("text") if isinstance(payload, dict) else None
            failure_text = text.strip() if isinstance(text, str) and text.strip() else None
            if failure_text is None:
                contradictions.append(
                    {
                        "code": "failed_terminal_missing_text",
                        "detail": "error terminal event has no visible text",
                        "owner_to_remove": "execution_projection",
                    }
                )
        elif kind == "cancelled":
            status = "cancelled"
            terminal_seq = event["seq"]
            terminal_kind = kind
        elif kind == "suspended":
            wake = payload.get("wake_kind") if isinstance(payload, dict) else None
            status = (
                "waiting_approval"
                if wake in {"approval", "effect_resolution"}
                else "waiting_user"
            )
        elif status == "empty":
            status = "running"
    return {
        "status": status,
        "terminal_seq": terminal_seq,
        "terminal_kind": terminal_kind,
        "failure_text": failure_text,
        "last_seq": ordered[-1]["seq"] if ordered else 0,
        "contradictions": contradictions,
    }


def audit_turn(db_path: Path, turn_id: str) -> dict[str, Any]:
    conn = connect_read_only(db_path)
    try:
        task = one(
            conn,
            """
            select task_id, user_id, workspace_id, kind, status, blocked_reason,
                   task_json, thread_id
            from tasks
            where task_id = ?
            """,
            (turn_id,),
        )
        events = rows(
            conn,
            """
            select event_id, turn_id, seq, kind, payload_json, created_at
            from turn_events
            where turn_id = ?
            order by seq asc
            """,
            (turn_id,),
        )
        runs = rows(
            conn,
            """
            select run_id, turn_id, thread_id, user_id, workspace_id, attempt,
                   status, completed_at, terminal_reason
            from agent_runs
            where turn_id = ?
            order by attempt asc, started_at asc
            """,
            (turn_id,),
        )
        thread_id, assistant_message_id = assistant_identity(task)
        message = None
        if thread_id and assistant_message_id:
            message = one(
                conn,
                """
                select id, thread_id, role, text, linked_task_id, delivery_state
                from chat_messages
                where thread_id = ? and id = ?
                """,
                (thread_id, assistant_message_id),
            )

        reduced = reduce_events(events)
        contradictions = list(reduced["contradictions"])
        task_status = task["status"] if task else None

        if task is None:
            contradictions.append(
                {
                    "code": "missing_task",
                    "detail": f"no task row for {turn_id}",
                    "owner_to_remove": "task_writer",
                }
            )

        if task_status in TERMINAL_TASK_STATUSES and reduced["status"] in {
            "running",
            "empty",
        }:
            contradictions.append(
                {
                    "code": "terminal_task_without_terminal_event",
                    "detail": f"task is {task_status} but reducer is {reduced['status']}",
                    "owner_to_remove": "execution_projection",
                }
            )

        if (
            task_status in TERMINAL_TASK_STATUSES
            and reduced["status"] in REDUCED_TERMINAL_STATUSES
            and task_status != reduced["status"]
        ):
            contradictions.append(
                {
                    "code": "task_reducer_terminal_status_mismatch",
                    "detail": f"task is {task_status} but reducer terminal is {reduced['status']}",
                    "owner_to_remove": "execution_projection",
                }
            )

        if task_status in TERMINAL_TASK_STATUSES:
            expected_run_statuses = expected_agent_run_statuses(task_status)
            for run in runs:
                if run["status"] == "running":
                    contradictions.append(
                        {
                            "code": "terminal_task_with_running_agent_run",
                            "detail": f"agent run {run['run_id']} is still running",
                            "owner_to_remove": "agent_run_projection",
                        }
                    )
                elif expected_run_statuses and run["status"] not in expected_run_statuses:
                    contradictions.append(
                        {
                            "code": "terminal_task_agent_run_status_mismatch",
                            "detail": f"task is {task_status} but agent run {run['run_id']} is {run['status']}",
                            "owner_to_remove": "agent_run_projection",
                        }
                    )

        if task_status == "failed" and message:
            if not (message["text"] or "").strip():
                contradictions.append(
                    {
                        "code": "failed_message_empty",
                        "detail": f"assistant message {message['id']} is failed with empty text",
                        "owner_to_remove": "execution_projection",
                    }
                )
            if message["delivery_state"] != "failed":
                contradictions.append(
                    {
                        "code": "failed_message_delivery_state_mismatch",
                        "detail": f"assistant message {message['id']} delivery state is {message['delivery_state']}",
                        "owner_to_remove": "execution_projection",
                    }
                )

        return {
            "turn_id": turn_id,
            "task": task,
            "reducer": reduced,
            "agent_runs": runs,
            "assistant_message": message,
            "contradictions": contradictions,
            "ok": not contradictions,
        }
    finally:
        conn.close()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("turn_id", help="Turn/task id to audit")
    parser.add_argument(
        "--db",
        type=Path,
        default=default_db_path(),
        help="Path to homun.sqlite",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    report = audit_turn(args.db, args.turn_id)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
