# Agent Runtime V2 First Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first Runtime v2 release slice: a typed turn reducer, a read-only consistency audit, scenario documentation, and gate wiring that expose contradictory turn state before runtime refactors begin.

**Architecture:** Add a pure reducer in `crates/task-runtime` that derives a `TurnStateSnapshot` from durable `TurnEvent` rows. Add a Python audit command that reads the existing SQLite stores and reports contradictions between reducer state, task status, agent run status, terminal event payload, and assistant message state. Wire focused tests into the existing kernel/pre-release gates without changing turn execution behavior.

**Tech Stack:** Rust (`local-first-task-runtime`), SQLite via existing `TaskStore`, Python 3 stdlib (`sqlite3`, `json`, `unittest`), existing Homun gate scripts.

---

## Source Baseline

Read before implementing:

- `/Users/fabio/Projects/Homun/app/docs/superpowers/specs/2026-08-10-homun-agent-runtime-v2-design.md`
- `/Users/fabio/Projects/Homun/app/docs/CAPISALDI.md`
- `/Users/fabio/Projects/Homun/app/crates/task-runtime/src/types.rs`
- `/Users/fabio/Projects/Homun/app/crates/task-runtime/src/store.rs`
- `/Users/fabio/Projects/Homun/app/scripts/kernel_regression_gate.py`
- `/Users/fabio/Projects/Homun/app/scripts/pre_release_gate.py`

## Worktree Rule

Run this plan in a dedicated clean worktree or after the current dirty runtime changes have been intentionally handled. This plan must not stage unrelated files.

Current known dirty areas at plan creation were runtime/UI/browser files outside this plan. Do not include them in commits for this slice.

## Kill List

- Legacy code removed: no runtime code removed in this first slice; this slice creates the audit that names stale owners.
- Feature flags removed or expired: none introduced.
- Compatibility fallbacks removed: none introduced.
- Old tests updated or deleted: gate tests are updated to include reducer/audit checks.
- Old owner made unable to decide: no behavior move in this slice; every contradiction reported by the audit includes `owner_to_remove`.
- Historical-data compatibility retained: existing `turn_events.kind` vocabulary remains accepted.
- Retained compatibility expiry/removal trigger: once Runtime v2 typed events are emitted, audit cases that depend on legacy `done/error/cancelled/suspended` payload shapes must move to fixture-only compatibility tests.

## File Structure

Create:

- `/Users/fabio/Projects/Homun/app/crates/task-runtime/src/turn_reducer.rs`
  Pure reducer from `TurnEvent` rows to `TurnStateSnapshot`.
- `/Users/fabio/Projects/Homun/app/crates/task-runtime/tests/turn_reducer_contract.rs`
  Rust contract tests for reducer behavior.
- `/Users/fabio/Projects/Homun/app/scripts/audit_turn_consistency.py`
  Read-only SQLite audit command for one turn.
- `/Users/fabio/Projects/Homun/app/scripts/test_audit_turn_consistency.py`
  Python unit tests for audit contradictions.
- `/Users/fabio/Projects/Homun/app/docs/testing/agent-runtime-v2-scenarios.md`
  Permanent scenario matrix for first release.

Modify:

- `/Users/fabio/Projects/Homun/app/crates/task-runtime/src/lib.rs`
  Export `turn_reducer` types.
- `/Users/fabio/Projects/Homun/app/scripts/kernel_regression_gate.py`
  Add reducer and audit unit checks.
- `/Users/fabio/Projects/Homun/app/scripts/pre_release_gate.py`
  Add audit unit check to release gate.

Do not modify:

- `crates/engine/src/agent_loop.rs`
- `crates/desktop-gateway/src/execution_projection.rs`
- `apps/desktop/src/**`
- `runtimes/browser-automation/**`

Those runtime changes belong to later slices and must have their own Kill Lists.

---

### Task 1: Add the Pure Turn Reducer

**Files:**
- Create: `/Users/fabio/Projects/Homun/app/crates/task-runtime/src/turn_reducer.rs`
- Modify: `/Users/fabio/Projects/Homun/app/crates/task-runtime/src/lib.rs`
- Test: `/Users/fabio/Projects/Homun/app/crates/task-runtime/tests/turn_reducer_contract.rs`

- [ ] **Step 1: Write the failing reducer tests**

Create `/Users/fabio/Projects/Homun/app/crates/task-runtime/tests/turn_reducer_contract.rs`:

```rust
use local_first_task_runtime::{
    ReducedTurnStatus, TurnEvent, TurnEventKind, reduce_turn_events,
};
use serde_json::json;

fn event(seq: i64, kind: TurnEventKind, payload: serde_json::Value) -> TurnEvent {
    TurnEvent {
        event_id: seq,
        turn_id: "turn-1".to_string(),
        seq,
        kind,
        payload,
        created_at: 1_786_000_000 + seq,
    }
}

#[test]
fn empty_event_log_reduces_to_empty() {
    let snapshot = reduce_turn_events(&[]);

    assert_eq!(snapshot.status, ReducedTurnStatus::Empty);
    assert!(!snapshot.is_terminal);
    assert_eq!(snapshot.last_seq, 0);
    assert!(snapshot.contradictions.is_empty());
}

#[test]
fn error_terminal_carries_visible_failure_text() {
    let snapshot = reduce_turn_events(&[event(
        1,
        TurnEventKind::Error,
        json!({
            "text": "Turn stopped before finishing: plan is incomplete",
            "projection_ref": "turn-1:1"
        }),
    )]);

    assert_eq!(snapshot.status, ReducedTurnStatus::Failed);
    assert!(snapshot.is_terminal);
    assert_eq!(snapshot.terminal_event_seq, Some(1));
    assert_eq!(
        snapshot.failure_text.as_deref(),
        Some("Turn stopped before finishing: plan is incomplete")
    );
    assert!(snapshot.contradictions.is_empty());
}

#[test]
fn terminal_state_ignores_later_activity_but_reports_the_contradiction() {
    let snapshot = reduce_turn_events(&[
        event(1, TurnEventKind::Done, json!({"text": "done"})),
        event(2, TurnEventKind::Activity, json!({"text": "still thinking"})),
    ]);

    assert_eq!(snapshot.status, ReducedTurnStatus::Completed);
    assert!(snapshot.is_terminal);
    assert_eq!(snapshot.terminal_event_seq, Some(1));
    assert_eq!(snapshot.last_seq, 2);
    assert_eq!(snapshot.contradictions.len(), 1);
    assert_eq!(snapshot.contradictions[0].code, "event_after_terminal");
    assert_eq!(snapshot.contradictions[0].owner_to_remove, "activity_projection");
}

#[test]
fn duplicate_terminal_events_keep_first_terminal_and_report_conflict() {
    let snapshot = reduce_turn_events(&[
        event(1, TurnEventKind::Error, json!({"text": "failed"})),
        event(2, TurnEventKind::Done, json!({"text": "done"})),
    ]);

    assert_eq!(snapshot.status, ReducedTurnStatus::Failed);
    assert_eq!(snapshot.terminal_event_kind, Some(TurnEventKind::Error));
    assert_eq!(snapshot.contradictions.len(), 1);
    assert_eq!(snapshot.contradictions[0].code, "multiple_terminal_events");
    assert_eq!(snapshot.contradictions[0].owner_to_remove, "terminal_writer");
}

#[test]
fn suspended_event_classifies_user_or_approval_wait() {
    let user = reduce_turn_events(&[event(
        1,
        TurnEventKind::Suspended,
        json!({"wake_kind": "user"}),
    )]);
    assert_eq!(user.status, ReducedTurnStatus::WaitingUser);
    assert!(!user.is_terminal);

    let approval = reduce_turn_events(&[event(
        1,
        TurnEventKind::Suspended,
        json!({"wake_kind": "approval"}),
    )]);
    assert_eq!(approval.status, ReducedTurnStatus::WaitingApproval);
    assert!(!approval.is_terminal);
}

#[test]
fn failed_terminal_without_visible_reason_is_a_contradiction() {
    let snapshot = reduce_turn_events(&[event(
        1,
        TurnEventKind::Error,
        json!({"text": null, "projection_ref": "turn-1:1"}),
    )]);

    assert_eq!(snapshot.status, ReducedTurnStatus::Failed);
    assert_eq!(snapshot.failure_text, None);
    assert_eq!(snapshot.contradictions.len(), 1);
    assert_eq!(snapshot.contradictions[0].code, "failed_terminal_missing_text");
    assert_eq!(snapshot.contradictions[0].owner_to_remove, "execution_projection");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cargo test -p local-first-task-runtime --test turn_reducer_contract -- --nocapture
```

Expected: FAIL because `turn_reducer` module, `ReducedTurnStatus`, and `reduce_turn_events` are not exported.

- [ ] **Step 3: Implement reducer module**

Create `/Users/fabio/Projects/Homun/app/crates/task-runtime/src/turn_reducer.rs`:

```rust
use crate::{TurnEvent, TurnEventKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReducedTurnStatus {
    Empty,
    Running,
    WaitingUser,
    WaitingApproval,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnContradiction {
    pub code: &'static str,
    pub detail: String,
    pub owner_to_remove: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnStateSnapshot {
    pub status: ReducedTurnStatus,
    pub is_terminal: bool,
    pub last_seq: i64,
    pub terminal_event_seq: Option<i64>,
    pub terminal_event_kind: Option<TurnEventKind>,
    pub failure_text: Option<String>,
    pub contradictions: Vec<TurnContradiction>,
}

impl Default for TurnStateSnapshot {
    fn default() -> Self {
        Self {
            status: ReducedTurnStatus::Empty,
            is_terminal: false,
            last_seq: 0,
            terminal_event_seq: None,
            terminal_event_kind: None,
            failure_text: None,
            contradictions: Vec::new(),
        }
    }
}

pub fn reduce_turn_events(events: &[TurnEvent]) -> TurnStateSnapshot {
    let mut snapshot = TurnStateSnapshot::default();
    let mut ordered = events.to_vec();
    ordered.sort_by_key(|event| (event.seq, event.event_id));

    for event in ordered {
        snapshot.last_seq = snapshot.last_seq.max(event.seq);
        if snapshot.is_terminal {
            if is_terminal(event.kind) {
                snapshot.contradictions.push(TurnContradiction {
                    code: "multiple_terminal_events",
                    detail: format!(
                        "terminal {:?} at seq {} after {:?} at seq {:?}",
                        event.kind,
                        event.seq,
                        snapshot.terminal_event_kind,
                        snapshot.terminal_event_seq
                    ),
                    owner_to_remove: "terminal_writer",
                });
            } else if matches!(
                event.kind,
                TurnEventKind::Activity
                    | TurnEventKind::PlanUpdate
                    | TurnEventKind::StepAdvance
                    | TurnEventKind::Heartbeat
            ) {
                snapshot.contradictions.push(TurnContradiction {
                    code: "event_after_terminal",
                    detail: format!("non-terminal {:?} at seq {} after terminal", event.kind, event.seq),
                    owner_to_remove: "activity_projection",
                });
            }
            continue;
        }

        match event.kind {
            TurnEventKind::Done => {
                snapshot.status = ReducedTurnStatus::Completed;
                snapshot.is_terminal = true;
                snapshot.terminal_event_seq = Some(event.seq);
                snapshot.terminal_event_kind = Some(event.kind);
            }
            TurnEventKind::Error => {
                snapshot.status = ReducedTurnStatus::Failed;
                snapshot.is_terminal = true;
                snapshot.terminal_event_seq = Some(event.seq);
                snapshot.terminal_event_kind = Some(event.kind);
                snapshot.failure_text = event
                    .payload
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .map(str::to_string);
                if snapshot.failure_text.is_none() {
                    snapshot.contradictions.push(TurnContradiction {
                        code: "failed_terminal_missing_text",
                        detail: "failed terminal event has no visible text".to_string(),
                        owner_to_remove: "execution_projection",
                    });
                }
            }
            TurnEventKind::Cancelled => {
                snapshot.status = ReducedTurnStatus::Cancelled;
                snapshot.is_terminal = true;
                snapshot.terminal_event_seq = Some(event.seq);
                snapshot.terminal_event_kind = Some(event.kind);
            }
            TurnEventKind::Suspended => {
                snapshot.status = match event.payload.get("wake_kind").and_then(serde_json::Value::as_str) {
                    Some("approval") | Some("effect_resolution") => ReducedTurnStatus::WaitingApproval,
                    _ => ReducedTurnStatus::WaitingUser,
                };
            }
            TurnEventKind::Delta
            | TurnEventKind::Reasoning
            | TurnEventKind::Activity
            | TurnEventKind::PlanUpdate
            | TurnEventKind::Tool
            | TurnEventKind::Recall
            | TurnEventKind::Retry
            | TurnEventKind::Queued
            | TurnEventKind::StepAdvance
            | TurnEventKind::Heartbeat
            | TurnEventKind::Aborted => {
                if snapshot.status == ReducedTurnStatus::Empty {
                    snapshot.status = ReducedTurnStatus::Running;
                }
            }
        }
    }

    snapshot
}

fn is_terminal(kind: TurnEventKind) -> bool {
    matches!(kind, TurnEventKind::Done | TurnEventKind::Error | TurnEventKind::Cancelled)
}
```

- [ ] **Step 4: Export reducer types**

Modify `/Users/fabio/Projects/Homun/app/crates/task-runtime/src/lib.rs`:

```rust
pub mod turn_reducer;
```

Add this to the public exports:

```rust
pub use turn_reducer::{
    ReducedTurnStatus, TurnContradiction, TurnStateSnapshot, reduce_turn_events,
};
```

- [ ] **Step 5: Run reducer tests**

Run:

```bash
cargo test -p local-first-task-runtime --test turn_reducer_contract -- --nocapture
```

Expected: PASS.

- [ ] **Step 6: Run adjacent runtime tests**

Run:

```bash
cargo test -p local-first-task-runtime turn_lifecycle -- --nocapture
cargo test -p local-first-task-runtime projection_outbox -- --nocapture
```

Expected: PASS.

- [ ] **Step 7: Commit reducer slice**

Run:

```bash
git add crates/task-runtime/src/lib.rs crates/task-runtime/src/turn_reducer.rs crates/task-runtime/tests/turn_reducer_contract.rs
git commit -m "feat(task-runtime): add turn state reducer"
```

---

### Task 2: Add the Read-Only Turn Consistency Audit

**Files:**
- Create: `/Users/fabio/Projects/Homun/app/scripts/audit_turn_consistency.py`
- Create: `/Users/fabio/Projects/Homun/app/scripts/test_audit_turn_consistency.py`

- [ ] **Step 1: Write audit tests**

Create `/Users/fabio/Projects/Homun/app/scripts/test_audit_turn_consistency.py`:

```python
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


def seed_task(conn: sqlite3.Connection, status: str = "failed", blocked_reason: str | None = None) -> None:
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


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run audit tests to verify they fail**

Run:

```bash
python3 -m unittest scripts.test_audit_turn_consistency -v
```

Expected: FAIL because `scripts/audit_turn_consistency.py` does not exist.

- [ ] **Step 3: Implement audit command**

Create `/Users/fabio/Projects/Homun/app/scripts/audit_turn_consistency.py`:

```python
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
import sys
from pathlib import Path
from typing import Any


TERMINAL_TASK_STATUSES = {"completed", "failed", "cancelled", "expired"}
TERMINAL_EVENT_KINDS = {"done", "error", "cancelled"}
ACTIVE_AFTER_TERMINAL_KINDS = {"activity", "plan_update", "step_advance", "heartbeat"}


def default_db_path() -> Path:
    return Path(os.path.expanduser("~/.homun/homun.sqlite"))


def rows(conn: sqlite3.Connection, query: str, params: tuple[Any, ...]) -> list[dict[str, Any]]:
    conn.row_factory = sqlite3.Row
    return [dict(row) for row in conn.execute(query, params).fetchall()]


def one(conn: sqlite3.Connection, query: str, params: tuple[Any, ...]) -> dict[str, Any] | None:
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
            status = "waiting_approval" if wake in {"approval", "effect_resolution"} else "waiting_user"
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
    conn = sqlite3.connect(db_path)
    try:
        task = one(
            conn,
            "select task_id, user_id, workspace_id, kind, status, blocked_reason, task_json, thread_id from tasks where task_id = ?",
            (turn_id,),
        )
        events = rows(
            conn,
            "select event_id, turn_id, seq, kind, payload_json, created_at from turn_events where turn_id = ? order by seq asc",
            (turn_id,),
        )
        runs = rows(
            conn,
            "select run_id, turn_id, thread_id, user_id, workspace_id, attempt, status, completed_at, terminal_reason from agent_runs where turn_id = ? order by attempt asc, started_at asc",
            (turn_id,),
        )
        thread_id, assistant_message_id = assistant_identity(task)
        message = None
        if thread_id and assistant_message_id:
            message = one(
                conn,
                "select id, thread_id, role, text, linked_task_id, delivery_state from chat_messages where thread_id = ? and id = ?",
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
        if task_status in TERMINAL_TASK_STATUSES and reduced["status"] in {"running", "empty"}:
            contradictions.append(
                {
                    "code": "terminal_task_without_terminal_event",
                    "detail": f"task is {task_status} but reducer is {reduced['status']}",
                    "owner_to_remove": "execution_projection",
                }
            )
        if task_status in TERMINAL_TASK_STATUSES:
            for run in runs:
                if run["status"] == "running":
                    contradictions.append(
                        {
                            "code": "terminal_task_with_running_agent_run",
                            "detail": f"agent run {run['run_id']} is still running",
                            "owner_to_remove": "agent_run_projection",
                        }
                    )
        if task_status == "failed" and message:
            if message["delivery_state"] == "failed" and not (message["text"] or "").strip():
                contradictions.append(
                    {
                        "code": "failed_message_empty",
                        "detail": f"assistant message {message['id']} is failed with empty text",
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
    parser.add_argument("--db", type=Path, default=default_db_path(), help="Path to homun.sqlite")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    report = audit_turn(args.db, args.turn_id)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run audit tests**

Run:

```bash
python3 -m unittest scripts.test_audit_turn_consistency -v
```

Expected: PASS.

- [ ] **Step 5: Run the audit against the latest local failed turn if present**

Run:

```bash
python3 scripts/audit_turn_consistency.py turn_chat_stream_1786364926300_j52nwcwo0to --db ~/.homun/homun.sqlite
```

Expected: exit code `1` if the local database still contains the historical failed-empty-message contradiction; exit code `0` if the row was repaired or deleted. Either result is acceptable. The output must include JSON with `turn_id`, `reducer`, and `contradictions`.

- [ ] **Step 6: Commit audit slice**

Run:

```bash
git add scripts/audit_turn_consistency.py scripts/test_audit_turn_consistency.py
git commit -m "test(runtime): add turn consistency audit"
```

---

### Task 3: Document Permanent Runtime V2 Scenarios

**Files:**
- Create: `/Users/fabio/Projects/Homun/app/docs/testing/agent-runtime-v2-scenarios.md`

- [ ] **Step 1: Create scenario document**

Create `/Users/fabio/Projects/Homun/app/docs/testing/agent-runtime-v2-scenarios.md`:

```markdown
# Agent Runtime V2 Scenario Gate

Date: 2026-08-10
Status: Active once wired into `scripts/kernel_regression_gate.py`.

This document defines goal-level fixtures for the Runtime v2 refactor. These
scenarios test system invariants, not one-off bugs.

## Global Rules

- Every scenario records canonical turn state, projected task state, assistant
  message state, plan state, and UI/read-model expectation.
- Every scenario has a Kill List entry in the implementation slice that changes
  runtime behavior.
- Passing a scenario by adding a guard while leaving the old owner active is not
  sufficient.

## Scenario 1: Build App Complex

Prompt:

```text
Crea una piccola applicazione web locale per gestire viaggi in treno.
React + TypeScript, CRUD, filtri, riepilogo, localStorage, test unitari, build finale.
Non usare browser o internet.
```

Required invariant:

- a runnable open plan cannot reduce to `Completed`;
- tests/build observations are evidence for final plan steps;
- failed turns show visible failure text.

First automated owner:

- `crates/task-runtime/src/turn_reducer.rs`
- `scripts/audit_turn_consistency.py`

## Scenario 2: Plan Read-Only

Prompt:

```text
Analizza questo codice e proponi un piano, senza modificare file.
```

Required invariant:

- `AgentProfile=plan` cannot execute write actions;
- any denied action is an observation, not a hidden terminal state.

First automated owner:

- RFC Phase 4 `AgentProfile` slice, outside this first slice.

## Scenario 3: Browser Train Search

Prompt:

```text
Mi trovi un treno da Milano a Roma per il 25 agosto alle 8 del mattino.
```

Required invariant:

- browser returns `found`, `partial`, `needs_user`, `failed`, or `no_result`;
- parent turn cannot remain active after a terminal browser result is projected.

First automated owner:

- RFC Phase 5 `BrowserResult` slice, outside this first slice.

## Scenario 4: Open Plan Stall

Prompt:

```text
Completa una task multi-step ma il modello continua a dire che prosegue senza azioni utili.
```

Required invariant:

- repeated no-progress is bounded;
- terminal failure has visible text;
- plan remains open with an owning blocked reason.

First automated owner:

- `crates/task-runtime/src/turn_reducer.rs`
- Runtime v2 engine budget slice, outside this first slice.

## Scenario 5: Failure Visibility

Prompt:

```text
Forza un errore runtime o tool.
```

Required invariant:

- `TurnFailed`, `tasks.status=failed`, terminal `error`, agent run terminal state,
  and assistant message failure text agree.

First automated owner:

- `scripts/audit_turn_consistency.py`

## Scenario 6: User Wait and Resume

Prompt:

```text
Esegui una task che richiede una scelta utente o approvazione.
```

Required invariant:

- waiting-user state stops model work UI;
- resume does not duplicate assistant identity;
- successor revision is traceable.

First automated owner:

- Runtime v2 reducer revision/wake slice, outside this first slice.

## Scenario 7: Crash/Restart Recovery

Prompt:

```text
Interrompi una task attiva e riavvia il gateway.
```

Required invariant:

- no terminal task has a running agent run;
- projection retry cannot hide terminality;
- UI read model agrees after replay.

First automated owner:

- `scripts/audit_turn_consistency.py`
```

- [ ] **Step 2: Check markdown**

Run:

```bash
python3 - <<'PY'
from pathlib import Path

bad = ["TB" + "D", "TO" + "DO", "implement " + "later", "cleanup " + "later", "place" + "holder"]
path = Path("docs/testing/agent-runtime-v2-scenarios.md")
for line_no, line in enumerate(path.read_text().splitlines(), 1):
    for term in bad:
        if term in line:
            raise SystemExit(f"{path}:{line_no}: contains {term!r}")
PY
```

Expected: exit code `0`.

- [ ] **Step 3: Commit scenario document**

Run:

```bash
git add docs/testing/agent-runtime-v2-scenarios.md
git commit -m "docs: add runtime v2 scenario gate"
```

---

### Task 4: Wire Focused Checks Into Existing Gates

**Files:**
- Modify: `/Users/fabio/Projects/Homun/app/scripts/kernel_regression_gate.py`
- Modify: `/Users/fabio/Projects/Homun/app/scripts/pre_release_gate.py`

- [ ] **Step 1: Add kernel gate steps**

Modify `/Users/fabio/Projects/Homun/app/scripts/kernel_regression_gate.py` inside `build_plan`, after the existing `task runtime turn lifecycle` step:

```python
        Step(
            "task runtime turn reducer",
            ["cargo", "test", "-p", "local-first-task-runtime", "--test", "turn_reducer_contract"],
        ),
        Step(
            "turn consistency audit unit tests",
            [PYTHON, "-m", "unittest", "scripts.test_audit_turn_consistency", "-v"],
        ),
```

- [ ] **Step 2: Add pre-release gate step**

Modify `/Users/fabio/Projects/Homun/app/scripts/pre_release_gate.py` inside `build_plan`, after the existing `task runtime tests` step:

```python
        Step(
            "turn consistency audit unit tests",
            [PYTHON, "-m", "unittest", "scripts.test_audit_turn_consistency", "-v"],
        ),
```

- [ ] **Step 3: Run focused gate checks**

Run:

```bash
python3 -m unittest scripts.test_audit_turn_consistency -v
cargo test -p local-first-task-runtime --test turn_reducer_contract -- --nocapture
python3 scripts/kernel_regression_gate.py
```

Expected: all pass. If `kernel_regression_gate.py` fails due unrelated dirty runtime changes, stop and report the failing step without broadening this slice.

- [ ] **Step 4: Run pre-release gate plan unit coverage**

Run:

```bash
python3 -m unittest scripts.test_pre_release_gate -v
```

Expected: PASS. If this test asserts the exact gate labels, update it to include `"turn consistency audit unit tests"` and rerun.

- [ ] **Step 5: Commit gate wiring**

Run:

```bash
git add scripts/kernel_regression_gate.py scripts/pre_release_gate.py scripts/test_pre_release_gate.py
git commit -m "test: gate runtime v2 audit checks"
```

---

### Task 5: Final Verification and Release Readiness Checkpoint

**Files:**
- No new files.
- Verify only files from Tasks 1-4.

- [ ] **Step 1: Run focused full slice checks**

Run:

```bash
cargo fmt --check
cargo test -p local-first-task-runtime --test turn_reducer_contract -- --nocapture
python3 -m unittest scripts.test_audit_turn_consistency -v
python3 -m unittest scripts.test_pre_release_gate -v
python3 scripts/kernel_regression_gate.py
git diff --check
```

Expected: PASS. If full kernel gate fails outside files touched by this plan, capture the failing command and leave unrelated runtime work untouched.

- [ ] **Step 2: Inspect final diff ownership**

Run:

```bash
git status --short
git diff --stat HEAD~4..HEAD
```

Expected: only these files changed across the Runtime v2 first-slice commits:

```text
crates/task-runtime/src/lib.rs
crates/task-runtime/src/turn_reducer.rs
crates/task-runtime/tests/turn_reducer_contract.rs
scripts/audit_turn_consistency.py
scripts/test_audit_turn_consistency.py
docs/testing/agent-runtime-v2-scenarios.md
scripts/kernel_regression_gate.py
scripts/pre_release_gate.py
scripts/test_pre_release_gate.py
```

- [ ] **Step 3: Confirm Kill List outcome**

Write this in the final implementation summary:

```text
Kill List result:
- No runtime behavior moved.
- No feature flags introduced.
- No compatibility fallback introduced.
- Audit now identifies stale owners for contradictions.
- Reducer is the only new canonical classification API.
```

- [ ] **Step 4: Prepare next slice decision**

Use the audit output and reducer tests to choose the next implementation slice:

```text
Recommended next slice: TurnState reducer authority.
Reason: remove duplicated terminal status decisions from gateway/UI paths by consuming reducer-derived read models.
First removal target: duplicated terminal-state sets outside `crates/task-runtime`.
```

Do not implement the next slice in this plan.
