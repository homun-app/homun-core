use crate::turn_reducer::{
    KernelEffectProjection, KernelProjectionInput, REDUCED_TERMINAL_TURN_EVENT_KIND_SQL_LIST,
    ReducedTurnStatus, reduce_kernel_projection, turn_event_kind_is_terminal,
};
use crate::{
    AgentCheckpoint, AgentRun, AgentRunEvent, AgentRunStatus, ApprovalRequest, Automation,
    AutomationRun, BrowserCheckpointRecord, EffectReceiptClaim, ExecutionEffectReceipt,
    KernelActivityRow, KernelApprovalView, KernelAttentionView, KernelBlockedCapabilityView,
    KernelBrowserView, KernelCapabilityRuntimeView, KernelPlanStepView, KernelPlanView,
    KernelThreadActions, KernelThreadProjection, KernelTurnView, KernelUncertainEffectView,
    NewAgentRun, NewBrowserCheckpoint, NewExecutionEffectReceipt, NewTurnSteering,
    ObjectiveContractRecord, ObjectiveMode, ProjectionClaim, ResourceClass,
    RuntimeIntegrityFinding, RuntimeIntegrityReport, RuntimePlanRecord, SubagentInfo,
    TaskCheckpoint, TaskDependencyOutput, TaskId, TaskRecord, TaskRuntimeError, TaskRuntimeResult,
    TaskStatus, TerminalWrite, ThreadAttention, TurnEvent, TurnEventKind, TurnSteeringRecord,
    TurnSteeringStatus, UserId, WorkspaceId,
};
use local_first_execution_protocol::{EffectClass, EffectReceiptRef, EffectReceiptStatus};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use time::OffsetDateTime;

/// "subagent.review" → "Review"; "subagent.code_reviewer" → "Code reviewer".
fn subagent_name_from_kind(kind: &str) -> String {
    let raw = kind
        .strip_prefix("subagent.")
        .unwrap_or(kind)
        .replace(['_', '-'], " ");
    let mut chars = raw.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => raw,
    }
}

fn runtime_plan_markdown(plan: &Value, steps: &[KernelPlanStepView]) -> Option<String> {
    if steps.is_empty() {
        return None;
    }
    let mut lines = Vec::new();
    if let Some(goal) = plan
        .get("goal")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|goal| !goal.is_empty())
    {
        lines.push(format!("**Goal**: {goal}"));
        lines.push(String::new());
    }
    for (index, step) in steps.iter().enumerate() {
        let title = step.title.trim();
        if title.is_empty() {
            continue;
        }
        let status = step.status.trim();
        let marker = match status {
            "done" => "x",
            "doing" | "in_progress" | "in-progress" => "-",
            "blocked" => "!",
            _ => " ",
        };
        let id = if step.id.trim().is_empty() {
            format!("s{}", index + 1)
        } else {
            step.id.trim().to_string()
        };
        let detail = step
            .detail
            .as_deref()
            .map(str::trim)
            .filter(|detail| !detail.is_empty())
            .unwrap_or("—");
        lines.push(format!("- [{marker}] **{title}** (`{id}`): {detail}"));
    }
    Some(lines.join("\n"))
}

fn runtime_plan_steps(plan: &Value) -> Vec<Value> {
    plan.get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn kernel_plan_step_status(
    raw_status: Option<&str>,
    turn_is_terminal: bool,
    terminal_reason: Option<&str>,
) -> String {
    let status = raw_status
        .map(str::trim)
        .filter(|status| !status.is_empty())
        .unwrap_or("todo");
    if turn_is_terminal && matches!(status, "doing" | "in_progress" | "in-progress") {
        if terminal_reason == Some("canonical_completed") {
            "done".to_string()
        } else {
            "blocked".to_string()
        }
    } else {
        status.to_string()
    }
}

fn kernel_plan_view(
    plan: &RuntimePlanRecord,
    turn_is_terminal: bool,
    terminal_reason: Option<&str>,
) -> Option<KernelPlanView> {
    let steps = runtime_plan_steps(&plan.plan_json)
        .into_iter()
        .enumerate()
        .filter_map(|(index, step)| {
            let title = step
                .get("title")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|title| !title.is_empty())?
                .to_string();
            let id = step
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("s{}", index + 1));
            let status = kernel_plan_step_status(
                step.get("status").and_then(Value::as_str),
                turn_is_terminal,
                terminal_reason,
            );
            let detail = step
                .get("detail")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|detail| !detail.is_empty())
                .map(str::to_string);
            Some(KernelPlanStepView {
                id,
                title,
                status,
                detail,
            })
        })
        .collect::<Vec<_>>();
    let markdown = runtime_plan_markdown(&plan.plan_json, &steps)?;
    Some(KernelPlanView {
        goal: plan
            .plan_json
            .get("goal")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|goal| !goal.is_empty())
            .map(str::to_string),
        revision: i64::try_from(plan.revision).unwrap_or(i64::MAX),
        steps,
        markdown,
    })
}

fn reduced_turn_status_token(status: ReducedTurnStatus) -> &'static str {
    match status {
        ReducedTurnStatus::Empty => "idle",
        ReducedTurnStatus::Running => "running",
        ReducedTurnStatus::WaitingUser => "waiting_user",
        ReducedTurnStatus::WaitingApproval => "waiting_approval",
        ReducedTurnStatus::Completed => "completed",
        ReducedTurnStatus::Failed => "failed",
        ReducedTurnStatus::Cancelled => "cancelled",
    }
}

fn task_status_kernel_turn_token(status: &str) -> Option<&'static str> {
    match status {
        "queued"
        | "pending"
        | "running"
        | "waiting_resource"
        | "waiting_time"
        | "waiting_external_event"
        | "parked" => Some("running"),
        "waiting_user_approval" => Some("waiting_approval"),
        "completed" => Some("completed"),
        "failed" => Some("failed"),
        "cancelled" | "expired" => Some("cancelled"),
        "finalizing" => Some("finalizing"),
        _ => None,
    }
}

fn effect_class_token(effect_class: &EffectClass) -> &'static str {
    match effect_class {
        EffectClass::Read => "read",
        EffectClass::FilesystemWrite => "filesystem_write",
        EffectClass::ArtifactCreation => "artifact_creation",
        EffectClass::ExternalWrite => "external_write",
        EffectClass::RequestAuthorization => "request_authorization",
    }
}

fn browser_budget_failure_reason(text: &str) -> Option<&str> {
    let reason = text.trim().strip_prefix("browser_budget_exceeded:")?;
    match reason {
        "wall_clock" | "failed_navigations" | "no_progress" => Some(reason),
        _ => Some("unknown"),
    }
}

fn browser_tool_name(payload: &Value) -> Option<&str> {
    for key in ["name", "tool_name"] {
        if let Some(name) = payload.get(key).and_then(Value::as_str) {
            return Some(name);
        }
    }
    for key in ["payload", "call", "tool"] {
        if let Some(name) = payload.get(key).and_then(browser_tool_name) {
            return Some(name);
        }
    }
    None
}

fn event_text(event: &TurnEvent) -> Option<String> {
    event
        .payload
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn capability_runtime_value(payload: &Value) -> Option<&Value> {
    if let Some(runtime) = payload
        .get("capability_runtime")
        .filter(|value| value.is_object())
    {
        return Some(runtime);
    }
    payload.get("payload").and_then(capability_runtime_value)
}

fn string_array_field(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

fn project_kernel_capability_runtime(events: &[TurnEvent]) -> KernelCapabilityRuntimeView {
    let mut loaded_tools = BTreeSet::new();
    let mut armed_sensitive_domains = BTreeSet::new();
    let mut blocked_seen = BTreeSet::new();
    let mut blocked_capabilities = Vec::new();
    let mut pending_capability = None;

    for runtime in events
        .iter()
        .filter(|event| event.kind == TurnEventKind::Tool)
        .filter_map(|event| capability_runtime_value(&event.payload))
    {
        loaded_tools.extend(string_array_field(runtime, "loaded_tools"));
        armed_sensitive_domains.extend(string_array_field(runtime, "armed_sensitive_domains"));
        if let Some(pending) = runtime
            .get("pending_capability")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            pending_capability = Some(pending.to_string());
        }
        for blocked in runtime
            .get("blocked_capabilities")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(key) = blocked
                .get("key")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            let reason = blocked
                .get("reason")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("blocked");
            let dedupe_key = format!("{key}\u{1f}{reason}");
            if blocked_seen.insert(dedupe_key) {
                blocked_capabilities.push(KernelBlockedCapabilityView {
                    key: key.to_string(),
                    reason: reason.to_string(),
                });
            }
        }
    }

    KernelCapabilityRuntimeView {
        loaded_tools: loaded_tools.into_iter().collect(),
        armed_sensitive_domains: armed_sensitive_domains.into_iter().collect(),
        pending_capability,
        blocked_capabilities,
    }
}

fn latest_browser_progress(events: &[TurnEvent]) -> Option<String> {
    events
        .iter()
        .rev()
        .filter(|event| event.kind == TurnEventKind::Activity)
        .filter_map(event_text)
        .find(|text| browser_budget_failure_reason(text).is_none())
}

fn browser_done_observed(events: &[TurnEvent], terminal_reason: Option<&str>) -> bool {
    terminal_reason == Some("browser_done_terminal")
        || events.iter().any(|event| {
            event.kind == TurnEventKind::Tool
                && browser_tool_name(&event.payload) == Some("browser_done")
        })
}

fn tool_result_text(payload: &Value) -> Option<&str> {
    for key in ["result", "content", "text"] {
        if let Some(text) = payload.get(key).and_then(Value::as_str) {
            return Some(text);
        }
    }
    for key in ["payload", "call", "tool"] {
        if let Some(text) = payload.get(key).and_then(tool_result_text) {
            return Some(text);
        }
    }
    None
}

fn completed_delegated_browse_observed(events: &[TurnEvent]) -> bool {
    events.iter().any(|event| {
        if event.kind != TurnEventKind::Tool || browser_tool_name(&event.payload) != Some("browse")
        {
            return false;
        }
        let Some(result_text) = tool_result_text(&event.payload) else {
            return false;
        };
        let Ok(result) = serde_json::from_str::<Value>(result_text.trim()) else {
            return false;
        };
        let grounded = result
            .get("sources")
            .and_then(Value::as_array)
            .is_some_and(|sources| !sources.is_empty())
            || result
                .get("items")
                .and_then(Value::as_array)
                .is_some_and(|items| !items.is_empty())
            || result
                .get("evidence")
                .and_then(Value::as_array)
                .is_some_and(|evidence| !evidence.is_empty());
        result.get("found").and_then(Value::as_bool) == Some(true)
            && result.get("status").and_then(Value::as_str) == Some("completed")
            && grounded
    })
}

fn project_kernel_browser_view(
    events: &[TurnEvent],
    checkpoint: Option<&BrowserCheckpointRecord>,
    terminal_reason: Option<&str>,
) -> KernelBrowserView {
    let latest_progress = latest_browser_progress(events);
    if browser_done_observed(events, terminal_reason) || completed_delegated_browse_observed(events)
    {
        return KernelBrowserView {
            state: "done".to_string(),
            target_id: checkpoint.map(|checkpoint| checkpoint.target_id.clone()),
            latest_progress,
            failure_reason: None,
            snapshot_verified: checkpoint.is_some(),
        };
    }
    if let Some(reason) = events
        .iter()
        .rev()
        .filter(|event| event.kind == TurnEventKind::Activity)
        .filter_map(event_text)
        .find_map(|text| browser_budget_failure_reason(&text).map(str::to_string))
    {
        return KernelBrowserView {
            state: "failed".to_string(),
            target_id: checkpoint.map(|checkpoint| checkpoint.target_id.clone()),
            latest_progress,
            failure_reason: Some(reason),
            snapshot_verified: checkpoint.is_some(),
        };
    }
    if let Some(checkpoint) = checkpoint {
        return KernelBrowserView {
            state: "active".to_string(),
            target_id: Some(checkpoint.target_id.clone()),
            latest_progress,
            failure_reason: None,
            snapshot_verified: true,
        };
    }
    KernelBrowserView {
        state: "idle".to_string(),
        latest_progress,
        ..KernelBrowserView::default()
    }
}

pub struct TaskStore {
    pub(crate) connection: Connection,
}

pub(crate) fn insert_turn_event_on(
    connection: &Connection,
    turn_id: &str,
    kind: TurnEventKind,
    payload: Value,
) -> TaskRuntimeResult<TurnEvent> {
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let seq: i64 = connection.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM turn_events WHERE turn_id = ?1",
        params![turn_id],
        |row| row.get(0),
    )?;
    connection.execute(
        "INSERT INTO turn_events (turn_id, seq, kind, payload_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            turn_id,
            seq,
            kind.as_str(),
            serde_json::to_string(&payload)?,
            now
        ],
    )?;
    Ok(TurnEvent {
        event_id: connection.last_insert_rowid(),
        turn_id: turn_id.to_string(),
        seq,
        kind,
        payload,
        created_at: now,
    })
}

pub(crate) fn first_terminal_event_on(
    connection: &Connection,
    turn_id: &str,
) -> TaskRuntimeResult<Option<TurnEvent>> {
    let query = format!(
        "SELECT event_id, turn_id, seq, kind, payload_json, created_at
               FROM turn_events
              WHERE turn_id = ?1 AND kind IN ({})
              ORDER BY seq ASC
              LIMIT 1",
        REDUCED_TERMINAL_TURN_EVENT_KIND_SQL_LIST,
    );
    let row = connection
        .query_row(&query, params![turn_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .optional()?;
    row.map(|(event_id, turn_id, seq, kind, payload_json, created_at)| {
        let kind = TurnEventKind::parse(&kind).ok_or_else(|| {
            TaskRuntimeError::Store("unknown terminal turn event kind".to_string())
        })?;
        Ok(TurnEvent {
            event_id,
            turn_id,
            seq,
            kind,
            payload: serde_json::from_str(&payload_json)?,
            created_at,
        })
    })
    .transpose()
}

fn projection_event_on(
    connection: &Connection,
    turn_id: &str,
    projection_ref: &str,
) -> TaskRuntimeResult<Option<TurnEvent>> {
    let mut statement = connection.prepare(
        "SELECT event_id, turn_id, seq, kind, payload_json, created_at
         FROM turn_events WHERE turn_id = ?1 ORDER BY seq",
    )?;
    let rows = statement.query_map([turn_id], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, i64>(5)?,
        ))
    })?;
    for row in rows {
        let (event_id, turn_id, seq, kind, payload_json, created_at) = row?;
        let payload: Value = serde_json::from_str(&payload_json)?;
        if payload.get("projection_ref").and_then(Value::as_str) != Some(projection_ref) {
            continue;
        }
        let kind = TurnEventKind::parse(&kind)
            .ok_or_else(|| TaskRuntimeError::Store("unknown projected event kind".to_string()))?;
        return Ok(Some(TurnEvent {
            event_id,
            turn_id,
            seq,
            kind,
            payload,
            created_at,
        }));
    }
    Ok(None)
}

impl TaskStore {
    pub fn open(path: impl AsRef<Path>) -> TaskRuntimeResult<Self> {
        let store = Self {
            connection: Connection::open(path)?,
        };
        // WAL enables concurrent readers + serialized writers — required when two
        // stores (chat + task) point at the same file. busy_timeout avoids transient
        // SQLITE_BUSY when the other writer is mid-commit.
        store.connection.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
        )?;
        store.run_migrations()?;
        Ok(store)
    }

    pub fn open_in_memory() -> TaskRuntimeResult<Self> {
        let store = Self {
            connection: Connection::open_in_memory()?,
        };
        // WAL is a no-op on in-memory DBs but busy_timeout still applies.
        store
            .connection
            .execute_batch("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;")?;
        store.run_migrations()?;
        Ok(store)
    }

    pub fn run_migrations(&self) -> TaskRuntimeResult<()> {
        self.connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS task_runtime_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tasks (
                task_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                workflow_id TEXT,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                priority TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                blocked_reason TEXT,
                task_json TEXT NOT NULL,
                PRIMARY KEY (task_id, user_id, workspace_id)
            );

            CREATE INDEX IF NOT EXISTS idx_tasks_scope_status
                ON tasks(user_id, workspace_id, status, priority, created_at);

            CREATE TABLE IF NOT EXISTS task_dependencies (
                task_id TEXT NOT NULL,
                depends_on_task_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (task_id, depends_on_task_id, user_id, workspace_id)
            );

            CREATE INDEX IF NOT EXISTS idx_task_dependencies_scope
                ON task_dependencies(user_id, workspace_id, task_id);

            CREATE TABLE IF NOT EXISTS resource_reservations (
                task_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                resource_class TEXT NOT NULL,
                units INTEGER NOT NULL,
                owner TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (task_id, user_id, workspace_id, resource_class)
            );

            CREATE INDEX IF NOT EXISTS idx_resource_reservations_scope
                ON resource_reservations(user_id, workspace_id, resource_class);

            CREATE TABLE IF NOT EXISTS task_checkpoints (
                checkpoint_id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                payload_json TEXT NOT NULL,
                redacted_payload_json TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_task_checkpoints_task
                ON task_checkpoints(user_id, workspace_id, task_id, sequence);

            CREATE TABLE IF NOT EXISTS task_approvals (
                approval_id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                approval_json TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_task_approvals_task
                ON task_approvals(user_id, workspace_id, task_id, created_at);

            CREATE TABLE IF NOT EXISTS automations (
                id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                enabled INTEGER NOT NULL,
                trigger_kind TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                automation_json TEXT NOT NULL,
                PRIMARY KEY (id, user_id, workspace_id)
            );

            CREATE INDEX IF NOT EXISTS idx_automations_scope
                ON automations(user_id, workspace_id, enabled);

            CREATE TABLE IF NOT EXISTS automation_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                automation_id TEXT NOT NULL,
                ran_at INTEGER NOT NULL,
                ok INTEGER NOT NULL,
                late INTEGER NOT NULL DEFAULT 0,
                detail TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_automation_runs
                ON automation_runs(automation_id, ran_at DESC);

            CREATE TABLE IF NOT EXISTS automation_event_dedup (
                automation_id TEXT NOT NULL,
                event_key TEXT NOT NULL,
                seen_at INTEGER NOT NULL,
                PRIMARY KEY (automation_id, event_key)
            );

            CREATE INDEX IF NOT EXISTS idx_automation_event_dedup_seen
                ON automation_event_dedup(automation_id, seen_at DESC);

            CREATE TABLE IF NOT EXISTS turn_events (
                event_id    INTEGER PRIMARY KEY AUTOINCREMENT,
                turn_id     TEXT NOT NULL,
                seq         INTEGER NOT NULL,
                kind        TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at  INTEGER NOT NULL,
                UNIQUE(turn_id, seq)
            );

            CREATE INDEX IF NOT EXISTS idx_turn_events_turn
                ON turn_events(turn_id, seq);

            CREATE TABLE IF NOT EXISTS agent_runs (
                run_id TEXT PRIMARY KEY,
                turn_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                attempt INTEGER NOT NULL,
                status TEXT NOT NULL,
                role TEXT,
                model TEXT,
                provider TEXT,
                prompt_fingerprint TEXT,
                started_at INTEGER NOT NULL,
                completed_at INTEGER,
                terminal_reason TEXT,
                schema_version INTEGER NOT NULL DEFAULT 1,
                UNIQUE(turn_id, attempt)
            );

            CREATE INDEX IF NOT EXISTS idx_agent_runs_turn
                ON agent_runs(turn_id, attempt);

            CREATE INDEX IF NOT EXISTS idx_agent_runs_scope
                ON agent_runs(user_id, workspace_id, started_at DESC);

            CREATE TABLE IF NOT EXISTS agent_run_events (
                event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                round INTEGER,
                kind TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                UNIQUE(run_id, seq),
                FOREIGN KEY(run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_agent_run_events_run
                ON agent_run_events(run_id, seq);

            CREATE TABLE IF NOT EXISTS runtime_plans (
                user_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                status TEXT NOT NULL,
                plan_json TEXT NOT NULL,
                objective_revision INTEGER NOT NULL DEFAULT 0,
                revision INTEGER NOT NULL DEFAULT 1,
                stall_turns INTEGER NOT NULL DEFAULT 0,
                last_resume_done INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (user_id, workspace_id, thread_id)
            );

            CREATE INDEX IF NOT EXISTS idx_runtime_plans_scope_status
                ON runtime_plans(user_id, workspace_id, status, updated_at DESC);

            CREATE TABLE IF NOT EXISTS objective_contracts (
                user_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                source_message_id TEXT NOT NULL,
                objective TEXT NOT NULL,
                mode TEXT NOT NULL,
                scope_json TEXT NOT NULL,
                allowed_actions_json TEXT NOT NULL,
                completion_json TEXT NOT NULL,
                status TEXT NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (user_id, workspace_id, thread_id)
            );

            CREATE INDEX IF NOT EXISTS idx_objective_contracts_scope_status
                ON objective_contracts(user_id, workspace_id, status, updated_at DESC);

            CREATE TABLE IF NOT EXISTS browser_checkpoints (
                checkpoint_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                target_id TEXT NOT NULL,
                objective_revision INTEGER NOT NULL,
                schema_version INTEGER NOT NULL,
                url TEXT NOT NULL,
                origin TEXT NOT NULL,
                browser_epoch TEXT NOT NULL,
                cdp_target_id TEXT,
                generation INTEGER NOT NULL,
                draft_secret_ref TEXT,
                draft_control_count INTEGER NOT NULL,
                omitted_sensitive_count INTEGER NOT NULL,
                omitted_bounded_count INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (user_id, workspace_id, thread_id, target_id)
            );

            CREATE INDEX IF NOT EXISTS idx_browser_checkpoints_expiry
                ON browser_checkpoints(expires_at);

            CREATE TABLE IF NOT EXISTS turn_steering (
                steering_id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                active_turn_id TEXT NOT NULL,
                source_message_id TEXT NOT NULL,
                content TEXT NOT NULL,
                objective_revision INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at INTEGER NOT NULL,
                consumed_at INTEGER,
                UNIQUE(user_id, workspace_id, thread_id, source_message_id)
            );

            CREATE INDEX IF NOT EXISTS idx_turn_steering_pending
                ON turn_steering(user_id, workspace_id, thread_id, active_turn_id, status, steering_id);

            CREATE TABLE IF NOT EXISTS agent_checkpoints (
                checkpoint_id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                turn_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                round INTEGER NOT NULL,
                state_json TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                resumable INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                UNIQUE(run_id, round),
                FOREIGN KEY(run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_recovery
                ON agent_checkpoints(turn_id, user_id, workspace_id, round DESC, created_at DESC);

            CREATE TABLE IF NOT EXISTS execution_effect_receipts (
                receipt_ref TEXT PRIMARY KEY,
                execution_id TEXT NOT NULL,
                revision INTEGER NOT NULL CHECK(revision > 0),
                idempotency_key TEXT NOT NULL,
                run_id TEXT,
                thread_id TEXT,
                user_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                effect_class TEXT NOT NULL,
                operation TEXT NOT NULL,
                arguments_hash TEXT NOT NULL,
                status TEXT NOT NULL CHECK(
                    status IN ('prepared', 'started', 'completed', 'failed', 'uncertain', 'compensated')
                ),
                result_json TEXT,
                effects_json TEXT,
                error_json TEXT,
                compensation_json TEXT,
                prepared_at INTEGER NOT NULL,
                started_at INTEGER,
                resolved_at INTEGER,
                UNIQUE(execution_id, idempotency_key)
            );

            CREATE INDEX IF NOT EXISTS idx_execution_effect_receipts_scope
                ON execution_effect_receipts(user_id, workspace_id, thread_id, prepared_at DESC);

            CREATE TABLE IF NOT EXISTS execution_effect_compensations (
                receipt_ref TEXT PRIMARY KEY,
                compensation_execution_id TEXT NOT NULL UNIQUE,
                compensated_at INTEGER NOT NULL,
                FOREIGN KEY(receipt_ref) REFERENCES execution_effect_receipts(receipt_ref) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS executions (
                execution_id TEXT PRIMARY KEY,
                parent_execution_id TEXT,
                kind TEXT NOT NULL,
                revision INTEGER NOT NULL CHECK(revision > 0),
                fencing_token INTEGER NOT NULL CHECK(fencing_token > 0),
                state TEXT NOT NULL CHECK(
                    state IN ('ready', 'running', 'suspended', 'completed', 'cancelled', 'failed')
                ),
                user_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                thread_id TEXT,
                contract_json TEXT NOT NULL,
                outcome_json TEXT,
                outcome_committed_at INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE(execution_id, revision),
                CHECK(
                    (outcome_json IS NULL AND outcome_committed_at IS NULL
                        AND state IN ('ready', 'running'))
                    OR
                    (outcome_json IS NOT NULL AND outcome_committed_at IS NOT NULL
                        AND state IN ('suspended', 'completed', 'cancelled', 'failed'))
                )
            );

            CREATE TABLE IF NOT EXISTS execution_events (
                event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                execution_id TEXT NOT NULL,
                revision INTEGER NOT NULL CHECK(revision > 0),
                seq INTEGER NOT NULL CHECK(seq > 0),
                kind TEXT NOT NULL CHECK(length(trim(kind)) > 0),
                payload_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                UNIQUE(execution_id, revision, seq)
            );

            CREATE TABLE IF NOT EXISTS execution_wakes (
                execution_id TEXT NOT NULL,
                revision INTEGER NOT NULL CHECK(revision > 0),
                dedup_key TEXT NOT NULL CHECK(length(trim(dedup_key)) > 0),
                condition_json TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('pending', 'delivered')),
                delivery_json TEXT,
                created_at INTEGER NOT NULL,
                delivered_at INTEGER,
                PRIMARY KEY(execution_id, revision, dedup_key),
                CHECK(
                    (delivery_json IS NULL AND delivered_at IS NULL)
                    OR (delivery_json IS NOT NULL AND delivered_at IS NOT NULL)
                ),
                CHECK(delivered_at IS NULL OR delivered_at >= created_at)
            );

            CREATE TABLE IF NOT EXISTS broker_meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            INSERT INTO task_runtime_metadata(key, value)
            VALUES ('schema_version', '8')
            ON CONFLICT(key) DO NOTHING;
            ",
        )?;
        crate::execution_store::migrate_execution_schema_v13(&self.connection)?;
        migrate_effect_receipts_v14(&self.connection)?;
        migrate_effect_compensations_v15(&self.connection)?;
        crate::projection_outbox::migrate_projection_outbox_v16(&self.connection)?;

        if !column_exists(&self.connection, "agent_runs", "role") {
            self.connection
                .execute("ALTER TABLE agent_runs ADD COLUMN role TEXT", [])?;
        }

        // ── chat_turn columns (schema_version 4). Guarded: idempotent on existing DBs.
        // Indexed columns for chat turns. Remain NULL on non-chat_turn rows.
        let chat_turn_cols = ["thread_id", "request_id", "source", "approval"];
        for col in chat_turn_cols {
            if !column_exists(&self.connection, "tasks", col) {
                self.connection
                    .execute(&format!("ALTER TABLE tasks ADD COLUMN {col} TEXT"), [])?;
            }
        }
        if !column_exists(&self.connection, "runtime_plans", "objective_revision") {
            self.connection.execute(
                "ALTER TABLE runtime_plans ADD COLUMN objective_revision INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        let steering_columns = [
            ("payload_json", "TEXT NOT NULL DEFAULT '{}'"),
            ("revision", "INTEGER NOT NULL DEFAULT 1"),
            ("updated_at", "INTEGER NOT NULL DEFAULT 0"),
            ("claimed_run_id", "TEXT"),
            ("claimed_round", "INTEGER"),
            ("claimed_at", "INTEGER"),
            ("applied_at", "INTEGER"),
            ("cancelled_at", "INTEGER"),
            ("semantic_decision_json", "TEXT"),
            ("interpreted_at", "INTEGER"),
            ("completed_at", "INTEGER"),
            ("last_interpretation_error", "TEXT"),
            ("next_retry_at", "INTEGER"),
            ("interpretation_attempts", "INTEGER NOT NULL DEFAULT 0"),
        ];
        for (column, definition) in steering_columns {
            if !column_exists(&self.connection, "turn_steering", column) {
                self.connection.execute(
                    &format!("ALTER TABLE turn_steering ADD COLUMN {column} {definition}"),
                    [],
                )?;
            }
        }
        self.connection.execute(
            "UPDATE turn_steering SET updated_at = created_at WHERE updated_at = 0",
            [],
        )?;
        self.connection.execute(
            "UPDATE task_runtime_metadata SET value = '15' WHERE key = 'schema_version'",
            [],
        )?;
        // Partial index: only chat_turn rows (thread_id IS NOT NULL). Indexes the
        // 409-per-thread query (status queued/running) without polluting it with non-chat tasks.
        if !index_exists(&self.connection, "idx_tasks_chat_turn_thread") {
            self.connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_tasks_chat_turn_thread
                    ON tasks(thread_id, status, kind)
                    WHERE thread_id IS NOT NULL",
                [],
            )?;
        }

        // ── Hot-path query optimization indices (schema_version 15+) ────────────
        //
        // Each index below targets a specific hot-path query that previously did a full
        // table scan because no existing index covered its WHERE/ORDER BY columns.
        // Verified with EXPLAIN QUERY PLAN assertions in `query_plan_tests`.

        // agent_runs by thread_id: list_agent_runs_for_thread,
        // has_agent_runs_for_thread, and delete_agent_runs_for_thread all filter on
        // thread_id. idx_agent_runs_scope starts with (user_id, workspace_id) and
        // idx_agent_runs_turn starts with turn_id — neither covers thread_id.
        self.connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_agent_runs_thread
                ON agent_runs(thread_id, user_id, workspace_id, started_at DESC)",
            [],
        )?;

        // agent_runs by (status, completed_at): abort_running_agent_runs seeks
        // status = 'running' (equality), and purge_terminal_agent_runs_before
        // filters status != 'running' AND completed_at < ? ORDER BY completed_at.
        self.connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_agent_runs_status_completed
                ON agent_runs(status, completed_at)",
            [],
        )?;

        // execution_events by kind: committed_executions() and the projection-outbox
        // backfill both filter WHERE kind = 'outcome_committed' ORDER BY created_at.
        // The UNIQUE(execution_id, revision, seq) constraint cannot serve a kind-first
        // scan, so these queries full-scanned execution_events before this index.
        self.connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_execution_events_kind_created
                ON execution_events(kind, created_at, execution_id, revision)",
            [],
        )?;

        // tasks by (thread_id, kind, created_at): project_kernel_thread and
        // thread_attention select the latest chat_turn or subagent rows for a thread
        // ordered by created_at DESC. idx_tasks_chat_turn_thread(thread_id, status,
        // kind) has status between thread_id and kind and lacks created_at, so it
        // cannot satisfy the ORDER BY — SQLite sorted in memory after the index seek.
        // This partial index (only rows where thread_id IS NOT NULL) covers the
        // ordering directly.
        self.connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_tasks_thread_kind_created
                ON tasks(thread_id, kind, created_at DESC, task_id DESC)
                WHERE thread_id IS NOT NULL",
            [],
        )?;

        // turn_steering due-scan: list_due_pending_turn_steering filters
        // status = 'pending' across ALL user/workspace scopes, then orders by
        // steering_id. idx_turn_steering_pending starts with (user_id, workspace_id)
        // so it cannot seek to pending rows cross-scope. This partial index covers
        // only pending rows in steering_id order, so the due-scan reads a small slice
        // instead of the full table.
        self.connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_turn_steering_due
                ON turn_steering(status, steering_id)
                WHERE status = 'pending'",
            [],
        )?;

        Ok(())
    }

    pub fn schema_version(&self) -> TaskRuntimeResult<u32> {
        let value: String = self.connection.query_row(
            "SELECT value FROM task_runtime_metadata WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )?;
        value
            .parse::<u32>()
            .map_err(|error| TaskRuntimeError::Store(error.to_string()))
    }

    pub fn insert_task(&self, task: &TaskRecord) -> TaskRuntimeResult<()> {
        self.connection.execute(
            "
            INSERT INTO tasks (
                task_id,
                user_id,
                workspace_id,
                workflow_id,
                kind,
                status,
                priority,
                created_at,
                updated_at,
                blocked_reason,
                task_json
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            ON CONFLICT(task_id, user_id, workspace_id) DO UPDATE SET
                workflow_id = excluded.workflow_id,
                kind = excluded.kind,
                status = excluded.status,
                priority = excluded.priority,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                blocked_reason = excluded.blocked_reason,
                task_json = excluded.task_json
            ",
            params![
                task.task_id.as_str(),
                task.user_id.as_str(),
                task.workspace_id.as_str(),
                task.workflow_id.as_ref().map(|id| id.as_str()),
                task.kind,
                enum_value(&task.status)?,
                enum_value(&task.priority)?,
                task.created_at.unix_timestamp(),
                task.updated_at.unix_timestamp(),
                task.blocked_reason,
                serde_json::to_string(task)?,
            ],
        )?;
        Ok(())
    }

    pub fn link_task_to_thread(
        &self,
        task_id: &TaskId,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        thread_id: &str,
    ) -> TaskRuntimeResult<bool> {
        let updated = self.connection.execute(
            "UPDATE tasks SET thread_id = ?1
             WHERE task_id = ?2 AND user_id = ?3 AND workspace_id = ?4",
            params![
                thread_id,
                task_id.as_str(),
                user_id.as_str(),
                workspace_id.as_str(),
            ],
        )?;
        Ok(updated > 0)
    }

    /// Purge ALL tasks, dependencies and resource reservations for a workspace.
    /// Called when a project workspace is deleted. Safe: uses the same
    /// (user_id, workspace_id) composite key the store indexes on.
    pub fn purge_workspace(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> TaskRuntimeResult<usize> {
        let tx = self.connection.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM turn_steering WHERE user_id = ?1 AND workspace_id = ?2",
            rusqlite::params![user_id.as_str(), workspace_id.as_str()],
        )?;
        tx.execute(
            "DELETE FROM browser_checkpoints WHERE user_id = ?1 AND workspace_id = ?2",
            rusqlite::params![user_id.as_str(), workspace_id.as_str()],
        )?;
        tx.execute(
            "DELETE FROM objective_contracts WHERE user_id = ?1 AND workspace_id = ?2",
            rusqlite::params![user_id.as_str(), workspace_id.as_str()],
        )?;
        tx.execute(
            "DELETE FROM runtime_plans WHERE user_id = ?1 AND workspace_id = ?2",
            rusqlite::params![user_id.as_str(), workspace_id.as_str()],
        )?;
        tx.execute(
            "DELETE FROM execution_effect_receipts WHERE user_id = ?1 AND workspace_id = ?2",
            rusqlite::params![user_id.as_str(), workspace_id.as_str()],
        )?;
        tx.execute(
            "DELETE FROM agent_runs WHERE user_id = ?1 AND workspace_id = ?2",
            rusqlite::params![user_id.as_str(), workspace_id.as_str()],
        )?;
        let count = tx.execute(
            "DELETE FROM tasks WHERE user_id = ?1 AND workspace_id = ?2",
            rusqlite::params![user_id.as_str(), workspace_id.as_str()],
        )?;
        tx.execute(
            "DELETE FROM task_dependencies WHERE user_id = ?1 AND workspace_id = ?2",
            rusqlite::params![user_id.as_str(), workspace_id.as_str()],
        )?;
        tx.execute(
            "DELETE FROM resource_reservations WHERE user_id = ?1 AND workspace_id = ?2",
            rusqlite::params![user_id.as_str(), workspace_id.as_str()],
        )?;
        tx.commit()?;
        Ok(count)
    }

    pub fn upsert_runtime_plan(
        &self,
        user_id: &str,
        workspace_id: &str,
        thread_id: &str,
        objective_revision: u64,
        plan: &Value,
        status: &str,
    ) -> TaskRuntimeResult<RuntimePlanRecord> {
        if !matches!(status, "open" | "settled" | "blocked") {
            return Err(TaskRuntimeError::Store(format!(
                "invalid runtime plan status: {status}"
            )));
        }
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO runtime_plans (
                user_id, workspace_id, thread_id, status, plan_json, objective_revision, revision,
                stall_turns, last_resume_done, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 0, NULL, ?7, ?7)
             ON CONFLICT(user_id, workspace_id, thread_id) DO UPDATE SET
                status = excluded.status,
                plan_json = excluded.plan_json,
                objective_revision = excluded.objective_revision,
                revision = runtime_plans.revision + 1,
                updated_at = excluded.updated_at",
            params![
                user_id,
                workspace_id,
                thread_id,
                status,
                serde_json::to_string(plan)?,
                objective_revision as i64,
                now,
            ],
        )?;
        let record =
            load_runtime_plan_on(&tx, user_id, workspace_id, thread_id)?.ok_or_else(|| {
                TaskRuntimeError::Store("runtime plan disappeared after upsert".into())
            })?;
        tx.commit()?;
        Ok(record)
    }

    /// Upserts the thread's single objective contract. Idempotent on the objective's
    /// SUBSTANTIVE identity (review I1, steering park+resume Build 2): `revision`
    /// only bumps when `objective` (text) or `mode` actually differ from the stored
    /// row; every other field (scope/allowed_actions/completion/status) still always
    /// updates to the latest projection, just without forcing a new revision.
    ///
    /// This matters because `execute_chat_turn_task` calls this on EVERY dispatch of
    /// a chat_turn, including a coordinator-driven RESUME of a parked turn — which
    /// re-derives the objective from a fresh model call. A fresh call's raw semantic
    /// decision (confidence/rationale, embedded in `scope_json`) is essentially never
    /// byte-identical even when the underlying objective is unchanged, so gating the
    /// bump on the full row (as an unconditional `revision + 1` effectively did) bumps
    /// on every resume — desyncing the resumed run's objective revision from the
    /// `objective_revision` a pending steering row was queued against. That mismatch
    /// makes `steering_requires_confirmation`'s `!revision_matches` unconditionally
    /// true, silently downgrading an otherwise-actionable steering decision to
    /// `NeedsClarification` right when resume is supposed to apply it. Comparing only
    /// `objective` + `mode` (the contract's actual identity) keeps "a genuinely
    /// different objective forces reinterpretation" intact while making "the exact
    /// same ask, re-derived" a no-op on the revision counter.
    #[allow(clippy::too_many_arguments)]
    pub fn upsert_objective_contract(
        &self,
        user_id: &str,
        workspace_id: &str,
        thread_id: &str,
        source_message_id: &str,
        objective: &str,
        mode: ObjectiveMode,
        scope: &Value,
        allowed_actions: &Value,
        completion: &Value,
        status: &str,
    ) -> TaskRuntimeResult<ObjectiveContractRecord> {
        if !matches!(status, "active" | "completed" | "cancelled") {
            return Err(TaskRuntimeError::Store(format!(
                "invalid objective contract status: {status}"
            )));
        }
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO objective_contracts (
                user_id, workspace_id, thread_id, source_message_id, objective, mode,
                scope_json, allowed_actions_json, completion_json, status, revision,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, ?11)
             ON CONFLICT(user_id, workspace_id, thread_id) DO UPDATE SET
                source_message_id = excluded.source_message_id,
                objective = excluded.objective,
                mode = excluded.mode,
                scope_json = excluded.scope_json,
                allowed_actions_json = excluded.allowed_actions_json,
                completion_json = excluded.completion_json,
                status = excluded.status,
                revision = CASE
                    WHEN objective_contracts.objective = excluded.objective
                     AND objective_contracts.mode = excluded.mode
                    THEN objective_contracts.revision
                    ELSE objective_contracts.revision + 1
                END,
                updated_at = excluded.updated_at",
            params![
                user_id,
                workspace_id,
                thread_id,
                source_message_id,
                objective,
                enum_value(&mode)?,
                serde_json::to_string(scope)?,
                serde_json::to_string(allowed_actions)?,
                serde_json::to_string(completion)?,
                status,
                now,
            ],
        )?;
        let record = load_objective_contract_on(&tx, user_id, workspace_id, thread_id)?
            .ok_or_else(|| {
                TaskRuntimeError::Store("objective contract disappeared after upsert".into())
            })?;
        tx.commit()?;
        Ok(record)
    }

    pub fn load_objective_contract(
        &self,
        user_id: &str,
        workspace_id: &str,
        thread_id: &str,
    ) -> TaskRuntimeResult<Option<ObjectiveContractRecord>> {
        load_objective_contract_on(&self.connection, user_id, workspace_id, thread_id)
    }

    /// Moves the currently active objective to a terminal state only when the
    /// caller still owns the revision it executed against.
    pub fn transition_objective_contract_status(
        &self,
        user_id: &str,
        workspace_id: &str,
        thread_id: &str,
        expected_revision: u64,
        status: &str,
    ) -> TaskRuntimeResult<bool> {
        if !matches!(status, "completed" | "cancelled") {
            return Err(TaskRuntimeError::Store(format!(
                "invalid terminal objective contract status: {status}"
            )));
        }
        let expected_revision = i64::try_from(expected_revision).map_err(|_| {
            TaskRuntimeError::Store("objective revision exceeds SQLite range".to_string())
        })?;
        let changed = self.connection.execute(
            "UPDATE objective_contracts
             SET status = ?1, updated_at = ?2
             WHERE user_id = ?3 AND workspace_id = ?4 AND thread_id = ?5
               AND revision = ?6 AND status = 'active'",
            params![
                status,
                OffsetDateTime::now_utc().unix_timestamp(),
                user_id,
                workspace_id,
                thread_id,
                expected_revision,
            ],
        )?;
        Ok(changed == 1)
    }

    pub fn upsert_browser_checkpoint(
        &self,
        checkpoint: &NewBrowserCheckpoint,
    ) -> TaskRuntimeResult<bool> {
        let objective_revision = i64::try_from(checkpoint.objective_revision).map_err(|_| {
            TaskRuntimeError::Store("objective revision exceeds SQLite range".into())
        })?;
        let generation = i64::try_from(checkpoint.generation).map_err(|_| {
            TaskRuntimeError::Store("browser generation exceeds SQLite range".into())
        })?;
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let changed = self.connection.execute(
            "INSERT INTO browser_checkpoints (
                checkpoint_id, user_id, workspace_id, thread_id, target_id,
                objective_revision, schema_version, url, origin, browser_epoch,
                cdp_target_id, generation, draft_secret_ref, draft_control_count,
                omitted_sensitive_count, omitted_bounded_count, expires_at, created_at, updated_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                    ?14, ?15, ?16, ?17, ?18, ?18
               FROM objective_contracts
              WHERE user_id = ?2 AND workspace_id = ?3 AND thread_id = ?4
                AND revision = ?6 AND status = 'active'
             ON CONFLICT(user_id, workspace_id, thread_id, target_id) DO UPDATE SET
                checkpoint_id = excluded.checkpoint_id,
                objective_revision = excluded.objective_revision,
                schema_version = excluded.schema_version,
                url = excluded.url,
                origin = excluded.origin,
                browser_epoch = excluded.browser_epoch,
                cdp_target_id = excluded.cdp_target_id,
                generation = excluded.generation,
                draft_secret_ref = excluded.draft_secret_ref,
                draft_control_count = excluded.draft_control_count,
                omitted_sensitive_count = excluded.omitted_sensitive_count,
                omitted_bounded_count = excluded.omitted_bounded_count,
                expires_at = excluded.expires_at,
                updated_at = excluded.updated_at",
            params![
                checkpoint.checkpoint_id,
                checkpoint.user_id,
                checkpoint.workspace_id,
                checkpoint.thread_id,
                checkpoint.target_id,
                objective_revision,
                checkpoint.schema_version as i64,
                checkpoint.url,
                checkpoint.origin,
                checkpoint.browser_epoch,
                checkpoint.cdp_target_id,
                generation,
                checkpoint.draft_secret_ref,
                checkpoint.draft_control_count as i64,
                checkpoint.omitted_sensitive_count as i64,
                checkpoint.omitted_bounded_count as i64,
                checkpoint.expires_at,
                now,
            ],
        )?;
        Ok(changed == 1)
    }

    pub fn load_active_browser_checkpoint(
        &self,
        user_id: &str,
        workspace_id: &str,
        thread_id: &str,
        target_id: &str,
    ) -> TaskRuntimeResult<Option<BrowserCheckpointRecord>> {
        self.connection
            .query_row(
                "SELECT b.checkpoint_id, b.user_id, b.workspace_id, b.thread_id, b.target_id,
                        b.objective_revision, b.schema_version, b.url, b.origin, b.browser_epoch,
                        b.cdp_target_id, b.generation, b.draft_secret_ref, b.draft_control_count,
                        b.omitted_sensitive_count, b.omitted_bounded_count, b.expires_at,
                        b.created_at, b.updated_at
                   FROM browser_checkpoints b
                   JOIN objective_contracts o
                     ON o.user_id = b.user_id AND o.workspace_id = b.workspace_id
                    AND o.thread_id = b.thread_id AND o.revision = b.objective_revision
                  WHERE b.user_id = ?1 AND b.workspace_id = ?2 AND b.thread_id = ?3
                    AND b.target_id = ?4 AND o.status = 'active' AND b.expires_at > ?5",
                params![
                    user_id,
                    workspace_id,
                    thread_id,
                    target_id,
                    OffsetDateTime::now_utc().unix_timestamp()
                ],
                map_browser_checkpoint_row,
            )
            .optional()
            .map_err(Into::into)
    }

    /// Returns the newest checkpoint that can continue this thread's active objective.
    /// The caller uses this only as a capability-liveness signal; exact target restore still
    /// goes through `load_active_browser_checkpoint` immediately before use.
    pub fn load_active_browser_checkpoint_for_thread(
        &self,
        user_id: &str,
        workspace_id: &str,
        thread_id: &str,
    ) -> TaskRuntimeResult<Option<BrowserCheckpointRecord>> {
        self.connection
            .query_row(
                "SELECT b.checkpoint_id, b.user_id, b.workspace_id, b.thread_id, b.target_id,
                        b.objective_revision, b.schema_version, b.url, b.origin, b.browser_epoch,
                        b.cdp_target_id, b.generation, b.draft_secret_ref, b.draft_control_count,
                        b.omitted_sensitive_count, b.omitted_bounded_count, b.expires_at,
                        b.created_at, b.updated_at
                   FROM browser_checkpoints b
                   JOIN objective_contracts o
                     ON o.user_id = b.user_id AND o.workspace_id = b.workspace_id
                    AND o.thread_id = b.thread_id AND o.revision = b.objective_revision
                  WHERE b.user_id = ?1 AND b.workspace_id = ?2 AND b.thread_id = ?3
                    AND o.status = 'active' AND b.expires_at > ?4
                  ORDER BY b.updated_at DESC, b.target_id ASC
                  LIMIT 1",
                params![
                    user_id,
                    workspace_id,
                    thread_id,
                    OffsetDateTime::now_utc().unix_timestamp()
                ],
                map_browser_checkpoint_row,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn delete_browser_checkpoints_for_thread(
        &self,
        user_id: &str,
        workspace_id: &str,
        thread_id: &str,
    ) -> TaskRuntimeResult<Vec<String>> {
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let refs = {
            let mut statement = tx.prepare(
                "SELECT draft_secret_ref FROM browser_checkpoints
                 WHERE user_id = ?1 AND workspace_id = ?2 AND thread_id = ?3
                   AND draft_secret_ref IS NOT NULL ORDER BY draft_secret_ref",
            )?;
            statement
                .query_map(params![user_id, workspace_id, thread_id], |row| row.get(0))?
                .collect::<Result<Vec<String>, _>>()?
        };
        tx.execute(
            "DELETE FROM browser_checkpoints
             WHERE user_id = ?1 AND workspace_id = ?2 AND thread_id = ?3",
            params![user_id, workspace_id, thread_id],
        )?;
        tx.commit()?;
        Ok(refs)
    }

    pub fn delete_browser_checkpoints_for_workspace(
        &self,
        user_id: &str,
        workspace_id: &str,
    ) -> TaskRuntimeResult<Vec<String>> {
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let refs = {
            let mut statement = tx.prepare(
                "SELECT draft_secret_ref FROM browser_checkpoints
                 WHERE user_id = ?1 AND workspace_id = ?2
                   AND draft_secret_ref IS NOT NULL ORDER BY draft_secret_ref",
            )?;
            statement
                .query_map(params![user_id, workspace_id], |row| row.get(0))?
                .collect::<Result<Vec<String>, _>>()?
        };
        tx.execute(
            "DELETE FROM browser_checkpoints WHERE user_id = ?1 AND workspace_id = ?2",
            params![user_id, workspace_id],
        )?;
        tx.commit()?;
        Ok(refs)
    }

    pub fn delete_browser_checkpoints_for_objective(
        &self,
        user_id: &str,
        workspace_id: &str,
        thread_id: &str,
        objective_revision: u64,
    ) -> TaskRuntimeResult<Vec<String>> {
        let revision = i64::try_from(objective_revision).map_err(|_| {
            TaskRuntimeError::Store("objective revision exceeds SQLite range".into())
        })?;
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let refs = {
            let mut statement = tx.prepare(
                "SELECT draft_secret_ref FROM browser_checkpoints
                 WHERE user_id = ?1 AND workspace_id = ?2 AND thread_id = ?3
                   AND objective_revision = ?4 AND draft_secret_ref IS NOT NULL
                 ORDER BY draft_secret_ref",
            )?;
            statement
                .query_map(params![user_id, workspace_id, thread_id, revision], |row| {
                    row.get(0)
                })?
                .collect::<Result<Vec<String>, _>>()?
        };
        tx.execute(
            "DELETE FROM browser_checkpoints
             WHERE user_id = ?1 AND workspace_id = ?2 AND thread_id = ?3
               AND objective_revision = ?4",
            params![user_id, workspace_id, thread_id, revision],
        )?;
        tx.commit()?;
        Ok(refs)
    }

    pub fn take_expired_browser_checkpoint_secret_refs(
        &self,
        now: i64,
    ) -> TaskRuntimeResult<Vec<String>> {
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let refs = {
            let mut statement = tx.prepare(
                "SELECT draft_secret_ref FROM browser_checkpoints
                 WHERE expires_at <= ?1 AND draft_secret_ref IS NOT NULL
                 ORDER BY draft_secret_ref",
            )?;
            statement
                .query_map(params![now], |row| row.get(0))?
                .collect::<Result<Vec<String>, _>>()?
        };
        tx.execute(
            "DELETE FROM browser_checkpoints WHERE expires_at <= ?1",
            params![now],
        )?;
        tx.commit()?;
        Ok(refs)
    }

    pub fn append_turn_steering(
        &self,
        user_id: &str,
        workspace_id: &str,
        thread_id: &str,
        active_turn_id: &str,
        input: &NewTurnSteering,
        objective_revision: u64,
    ) -> TaskRuntimeResult<TurnSteeringRecord> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        self.connection.execute(
            "INSERT INTO turn_steering (
                user_id, workspace_id, thread_id, active_turn_id, source_message_id,
                content, payload_json, objective_revision, status, revision, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', 1, ?9, ?9)
             ON CONFLICT(user_id, workspace_id, thread_id, source_message_id) DO NOTHING",
            params![
                user_id,
                workspace_id,
                thread_id,
                active_turn_id,
                input.source_message_id,
                input.prompt,
                serde_json::to_string(input)?,
                objective_revision as i64,
                now,
            ],
        )?;
        load_turn_steering_by_source_message(
            &self.connection,
            user_id,
            workspace_id,
            thread_id,
            &input.source_message_id,
        )?
        .ok_or_else(|| TaskRuntimeError::Store("steering message disappeared after append".into()))
    }

    pub fn claim_pending_turn_steering(
        &self,
        user_id: &str,
        workspace_id: &str,
        thread_id: &str,
        active_turn_id: &str,
        run_id: &str,
        round: u32,
    ) -> TaskRuntimeResult<Vec<TurnSteeringRecord>> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let records = {
            let mut statement = tx.prepare(
                "SELECT steering_id, user_id, workspace_id, thread_id, active_turn_id,
                        source_message_id, content, payload_json, objective_revision, status,
                        revision, created_at, updated_at, claimed_run_id, claimed_round,
                        claimed_at, applied_at, cancelled_at, consumed_at,
                        semantic_decision_json, interpreted_at, completed_at,
                        last_interpretation_error, next_retry_at, interpretation_attempts
                 FROM turn_steering
                 WHERE user_id = ?1 AND workspace_id = ?2 AND thread_id = ?3
                   AND active_turn_id = ?4 AND status = 'pending'
                   AND (next_retry_at IS NULL OR next_retry_at <= ?5)
                 ORDER BY steering_id ASC",
            )?;
            statement
                .query_map(
                    params![user_id, workspace_id, thread_id, active_turn_id, now],
                    map_turn_steering_row,
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        tx.execute(
            "UPDATE turn_steering
             SET status = 'claimed', claimed_run_id = ?1, claimed_round = ?2,
                 claimed_at = ?3, consumed_at = ?3, updated_at = ?3,
                 revision = revision + 1
             WHERE user_id = ?4 AND workspace_id = ?5 AND thread_id = ?6
               AND active_turn_id = ?7 AND status = 'pending'
               AND (next_retry_at IS NULL OR next_retry_at <= ?3)",
            params![
                run_id,
                round as i64,
                now,
                user_id,
                workspace_id,
                thread_id,
                active_turn_id
            ],
        )?;
        tx.commit()?;
        Ok(records
            .into_iter()
            .map(|mut record| {
                record.status = TurnSteeringStatus::Claimed;
                record.claimed_run_id = Some(run_id.to_string());
                record.claimed_round = Some(round);
                record.claimed_at = Some(now);
                record.updated_at = now;
                record.consumed_at = Some(now);
                record.revision += 1;
                record
            })
            .collect())
    }

    pub fn consume_pending_turn_steering(
        &self,
        user_id: &str,
        workspace_id: &str,
        thread_id: &str,
        active_turn_id: &str,
    ) -> TaskRuntimeResult<Vec<TurnSteeringRecord>> {
        self.claim_pending_turn_steering(
            user_id,
            workspace_id,
            thread_id,
            active_turn_id,
            "legacy",
            0,
        )
    }

    pub fn list_turn_steering(
        &self,
        user_id: &str,
        workspace_id: &str,
        thread_id: &str,
    ) -> TaskRuntimeResult<Vec<TurnSteeringRecord>> {
        let mut statement = self.connection.prepare(
            "SELECT steering_id, user_id, workspace_id, thread_id, active_turn_id,
                    source_message_id, content, payload_json, objective_revision, status,
                    revision, created_at, updated_at, claimed_run_id, claimed_round,
                    claimed_at, applied_at, cancelled_at, consumed_at,
                    semantic_decision_json, interpreted_at, completed_at,
                    last_interpretation_error, next_retry_at, interpretation_attempts
             FROM turn_steering
             WHERE user_id = ?1 AND workspace_id = ?2 AND thread_id = ?3
             ORDER BY steering_id ASC",
        )?;
        Ok(statement
            .query_map(
                params![user_id, workspace_id, thread_id],
                map_turn_steering_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn list_interpreted_turn_steering(
        &self,
        user_id: &str,
        workspace_id: &str,
        thread_id: &str,
        active_turn_id: &str,
        run_id: &str,
    ) -> TaskRuntimeResult<Vec<TurnSteeringRecord>> {
        let mut statement = self.connection.prepare(
            "SELECT steering_id, user_id, workspace_id, thread_id, active_turn_id,
                    source_message_id, content, payload_json, objective_revision, status,
                    revision, created_at, updated_at, claimed_run_id, claimed_round,
                    claimed_at, applied_at, cancelled_at, consumed_at,
                    semantic_decision_json, interpreted_at, completed_at,
                    last_interpretation_error, next_retry_at, interpretation_attempts
             FROM turn_steering
             WHERE user_id=?1 AND workspace_id=?2 AND thread_id=?3 AND active_turn_id=?4
               AND claimed_run_id=?5 AND status='interpreted'
             ORDER BY steering_id ASC",
        )?;
        Ok(statement
            .query_map(
                params![user_id, workspace_id, thread_id, active_turn_id, run_id],
                map_turn_steering_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn list_due_pending_turn_steering(
        &self,
        now: i64,
        limit: usize,
    ) -> TaskRuntimeResult<Vec<TurnSteeringRecord>> {
        let mut statement = self.connection.prepare(
            "SELECT steering_id, user_id, workspace_id, thread_id, active_turn_id,
                    source_message_id, content, payload_json, objective_revision, status,
                    revision, created_at, updated_at, claimed_run_id, claimed_round,
                    claimed_at, applied_at, cancelled_at, consumed_at,
                    semantic_decision_json, interpreted_at, completed_at,
                    last_interpretation_error, next_retry_at, interpretation_attempts
             FROM turn_steering
             WHERE status='pending' AND (next_retry_at IS NULL OR next_retry_at <= ?1)
             ORDER BY steering_id ASC LIMIT ?2",
        )?;
        Ok(statement
            .query_map(params![now, limit as i64], map_turn_steering_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn update_turn_steering(
        &self,
        steering_id: i64,
        user_id: &str,
        workspace_id: &str,
        expected_revision: u64,
        input: &NewTurnSteering,
    ) -> TaskRuntimeResult<TurnSteeringRecord> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let changed = self.connection.execute(
            "UPDATE turn_steering SET source_message_id=?1, content=?2, payload_json=?3,
                    revision=revision+1, updated_at=?4
             WHERE steering_id=?5 AND user_id=?6 AND workspace_id=?7 AND revision=?8
               AND status IN ('pending','held')",
            params![
                input.source_message_id,
                input.prompt,
                serde_json::to_string(input)?,
                now,
                steering_id,
                user_id,
                workspace_id,
                expected_revision as i64
            ],
        )?;
        if changed == 0 {
            return Err(TaskRuntimeError::Conflict(
                "steering changed or is no longer editable".into(),
            ));
        }
        self.load_turn_steering(steering_id, user_id, workspace_id)?
            .ok_or_else(|| TaskRuntimeError::NotFound("steering".into()))
    }

    pub fn cancel_turn_steering(
        &self,
        steering_id: i64,
        user_id: &str,
        workspace_id: &str,
        expected_revision: u64,
    ) -> TaskRuntimeResult<TurnSteeringRecord> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let changed = self.connection.execute(
            "UPDATE turn_steering SET status='cancelled', revision=revision+1,
                    cancelled_at=?1, updated_at=?1
             WHERE steering_id=?2 AND user_id=?3 AND workspace_id=?4 AND revision=?5
               AND status IN ('pending','held')",
            params![
                now,
                steering_id,
                user_id,
                workspace_id,
                expected_revision as i64
            ],
        )?;
        if changed == 0 {
            return Err(TaskRuntimeError::Conflict(
                "steering changed or is no longer cancellable".into(),
            ));
        }
        self.load_turn_steering(steering_id, user_id, workspace_id)?
            .ok_or_else(|| TaskRuntimeError::NotFound("steering".into()))
    }

    pub fn load_turn_steering(
        &self,
        steering_id: i64,
        user_id: &str,
        workspace_id: &str,
    ) -> TaskRuntimeResult<Option<TurnSteeringRecord>> {
        load_turn_steering_by_id_on(&self.connection, steering_id, user_id, workspace_id)
    }

    pub(crate) fn load_turn_steering_by_id_on(
        conn: &Connection,
        steering_id: i64,
        user_id: &str,
        workspace_id: &str,
    ) -> TaskRuntimeResult<Option<TurnSteeringRecord>> {
        load_turn_steering_by_id_on(conn, steering_id, user_id, workspace_id)
    }

    pub(crate) fn promote_turn_steering_on(
        tx: &Transaction<'_>,
        steering_id: i64,
        user_id: &str,
        workspace_id: &str,
        expected_revision: u64,
    ) -> TaskRuntimeResult<TurnSteeringRecord> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let changed = tx.execute(
            "UPDATE turn_steering SET status='promoted', revision=revision+1, updated_at=?1
             WHERE steering_id=?2 AND user_id=?3 AND workspace_id=?4 AND revision=?5 AND status='held'",
            params![now, steering_id, user_id, workspace_id, expected_revision as i64],
        )?;
        if changed == 0 {
            return Err(TaskRuntimeError::Conflict("held steering changed".into()));
        }
        load_turn_steering_by_id_on(tx, steering_id, user_id, workspace_id)?
            .ok_or_else(|| TaskRuntimeError::NotFound("steering".into()))
    }

    pub fn current_turn_steering(
        &self,
        steering_id: i64,
        user_id: &str,
        workspace_id: &str,
    ) -> TaskRuntimeResult<Option<TurnSteeringRecord>> {
        self.load_turn_steering(steering_id, user_id, workspace_id)
    }

    pub fn workspace_for_turn_steering(
        &self,
        steering_id: i64,
        user_id: &str,
    ) -> TaskRuntimeResult<Option<String>> {
        self.connection
            .query_row(
                "SELECT workspace_id FROM turn_steering WHERE steering_id=?1 AND user_id=?2",
                params![steering_id, user_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn mark_turn_steering_interpreted(
        &self,
        steering_id: i64,
        expected_revision: u64,
        semantic_decision_json: &Value,
        run_id: &str,
    ) -> TaskRuntimeResult<TurnSteeringRecord> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let changed = self.connection.execute(
            "UPDATE turn_steering
             SET status='interpreted', semantic_decision_json=?1, interpreted_at=?2,
                 last_interpretation_error=NULL, next_retry_at=NULL,
                 revision=revision+1, updated_at=?2
             WHERE steering_id=?3 AND revision=?4 AND status='claimed' AND claimed_run_id=?5",
            params![
                serde_json::to_string(semantic_decision_json)?,
                now,
                steering_id,
                expected_revision as i64,
                run_id
            ],
        )?;
        if changed == 0 {
            return Err(TaskRuntimeError::Conflict(
                "steering changed before interpretation".into(),
            ));
        }
        load_turn_steering_unscoped_by_id(&self.connection, steering_id)?
            .ok_or_else(|| TaskRuntimeError::NotFound("steering".into()))
    }

    pub fn mark_turn_steering_applied(
        &self,
        steering_id: i64,
        expected_revision: u64,
        run_id: &str,
    ) -> TaskRuntimeResult<TurnSteeringRecord> {
        self.transition_interpreted_steering(
            steering_id,
            expected_revision,
            run_id,
            "interpreted",
            "applied",
            "applied_at",
        )
    }

    pub fn mark_turn_steering_completed(
        &self,
        steering_id: i64,
        expected_revision: u64,
        run_id: &str,
    ) -> TaskRuntimeResult<TurnSteeringRecord> {
        self.transition_interpreted_steering(
            steering_id,
            expected_revision,
            run_id,
            "applied",
            "completed",
            "completed_at",
        )
    }

    fn transition_interpreted_steering(
        &self,
        steering_id: i64,
        expected_revision: u64,
        run_id: &str,
        from_status: &str,
        to_status: &str,
        timestamp_column: &str,
    ) -> TaskRuntimeResult<TurnSteeringRecord> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let sql = format!(
            "UPDATE turn_steering SET status=?1, {timestamp_column}=?2,
                    revision=revision+1, updated_at=?2
             WHERE steering_id=?3 AND revision=?4 AND status=?5 AND claimed_run_id=?6"
        );
        let changed = self.connection.execute(
            &sql,
            params![
                to_status,
                now,
                steering_id,
                expected_revision as i64,
                from_status,
                run_id
            ],
        )?;
        if changed == 0 {
            return Err(TaskRuntimeError::Conflict(format!(
                "steering changed before transition to {to_status}"
            )));
        }
        load_turn_steering_unscoped_by_id(&self.connection, steering_id)?
            .ok_or_else(|| TaskRuntimeError::NotFound("steering".into()))
    }

    pub fn release_turn_steering_for_retry(
        &self,
        steering_id: i64,
        expected_revision: u64,
        error: &str,
        next_retry_at: i64,
    ) -> TaskRuntimeResult<TurnSteeringRecord> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let changed = self.connection.execute(
            "UPDATE turn_steering
             SET status='pending', claimed_run_id=NULL, claimed_round=NULL, claimed_at=NULL,
                 semantic_decision_json=NULL, interpreted_at=NULL,
                 last_interpretation_error=?1, next_retry_at=?2,
                 interpretation_attempts=interpretation_attempts+1,
                 revision=revision+1, updated_at=?3
             WHERE steering_id=?4 AND revision=?5 AND status='claimed'",
            params![
                error,
                next_retry_at,
                now,
                steering_id,
                expected_revision as i64
            ],
        )?;
        if changed == 0 {
            return Err(TaskRuntimeError::Conflict(
                "steering changed before retry release".into(),
            ));
        }
        load_turn_steering_unscoped_by_id(&self.connection, steering_id)?
            .ok_or_else(|| TaskRuntimeError::NotFound("steering".into()))
    }

    /// Records a coordinator interpretation attempt against a row that is STILL
    /// `pending` (never claimed) — the `status='pending'` counterpart of
    /// `release_turn_steering_for_retry` (which requires `status='claimed'`).
    /// Needed because the coordinator's park-resume probe and its orphan-row
    /// detection (steering park+resume, Build 2) both deliberately do NOT claim
    /// before they touch the model/diagnose the turn (design: no `claimed_run_id`
    /// binding to a dead parked/orphaned run) — bounded backoff on those rows has
    /// nowhere else to live. The row stays `pending`; only the bookkeeping columns
    /// change, so a later poll cycle can still pick it up once `next_retry_at` passes.
    pub fn defer_pending_turn_steering(
        &self,
        steering_id: i64,
        expected_revision: u64,
        error: &str,
        next_retry_at: i64,
    ) -> TaskRuntimeResult<TurnSteeringRecord> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let changed = self.connection.execute(
            "UPDATE turn_steering
             SET last_interpretation_error=?1, next_retry_at=?2,
                 interpretation_attempts=interpretation_attempts+1,
                 revision=revision+1, updated_at=?3
             WHERE steering_id=?4 AND revision=?5 AND status='pending'",
            params![
                error,
                next_retry_at,
                now,
                steering_id,
                expected_revision as i64
            ],
        )?;
        if changed == 0 {
            return Err(TaskRuntimeError::Conflict(
                "steering changed before retry defer".into(),
            ));
        }
        load_turn_steering_unscoped_by_id(&self.connection, steering_id)?
            .ok_or_else(|| TaskRuntimeError::NotFound("steering".into()))
    }

    pub fn hold_pending_turn_steering(
        &self,
        user_id: &str,
        workspace_id: &str,
        active_turn_id: &str,
    ) -> TaskRuntimeResult<usize> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        Ok(self.connection.execute(
            "UPDATE turn_steering SET status='held', revision=revision+1, updated_at=?1
             WHERE user_id=?2 AND workspace_id=?3 AND active_turn_id=?4
               AND status IN ('pending','claimed','interpreted')",
            params![now, user_id, workspace_id, active_turn_id],
        )?)
    }

    pub fn close_unsettled_turn_steering(
        &self,
        user_id: &str,
        workspace_id: &str,
        thread_id: &str,
        active_turn_id: &str,
    ) -> TaskRuntimeResult<usize> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        Ok(self.connection.execute(
            "UPDATE turn_steering
             SET status='cancelled',
                 cancelled_at=COALESCE(cancelled_at, ?1),
                 updated_at=?1,
                 revision=revision+1
             WHERE user_id=?2 AND workspace_id=?3 AND thread_id=?4 AND active_turn_id=?5
               AND status IN ('pending','held','claimed','interpreted','applied')",
            params![now, user_id, workspace_id, thread_id, active_turn_id],
        )?)
    }

    /// Atomically fences terminal delivery against newly queued steering.
    /// `false` means the engine must continue; `true` changes the task to the
    /// internal SQL-only `finalizing` state so later input becomes a new turn.
    pub fn fence_chat_turn_finalization(
        &self,
        user_id: &str,
        workspace_id: &str,
        active_turn_id: &str,
    ) -> TaskRuntimeResult<bool> {
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let pending: i64 = tx.query_row(
            "SELECT COUNT(*) FROM turn_steering
             WHERE user_id=?1 AND workspace_id=?2 AND active_turn_id=?3
               AND status IN ('pending','claimed','interpreted')",
            params![user_id, workspace_id, active_turn_id],
            |row| row.get(0),
        )?;
        if pending > 0 {
            tx.commit()?;
            return Ok(false);
        }
        tx.execute(
            "UPDATE tasks SET status='finalizing', updated_at=?1
             WHERE task_id=?2 AND user_id=?3 AND workspace_id=?4 AND status='running'",
            params![
                OffsetDateTime::now_utc().unix_timestamp(),
                active_turn_id,
                user_id,
                workspace_id
            ],
        )?;
        tx.commit()?;
        Ok(true)
    }

    pub fn load_runtime_plan(
        &self,
        user_id: &str,
        workspace_id: &str,
        thread_id: &str,
    ) -> TaskRuntimeResult<Option<RuntimePlanRecord>> {
        load_runtime_plan_on(&self.connection, user_id, workspace_id, thread_id)
    }

    pub fn bump_runtime_plan_stall(
        &self,
        user_id: &str,
        workspace_id: &str,
        thread_id: &str,
        current_done: usize,
    ) -> TaskRuntimeResult<Option<RuntimePlanRecord>> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        tx.execute(
            "UPDATE runtime_plans
             SET stall_turns = CASE
                    WHEN last_resume_done IS NULL OR last_resume_done != ?1 THEN 0
                    ELSE stall_turns + 1
                 END,
                 last_resume_done = ?1,
                 updated_at = ?2
             WHERE user_id = ?3 AND workspace_id = ?4 AND thread_id = ?5",
            params![current_done as i64, now, user_id, workspace_id, thread_id],
        )?;
        let record = load_runtime_plan_on(&tx, user_id, workspace_id, thread_id)?;
        tx.commit()?;
        Ok(record)
    }

    pub fn purge_runtime_plan_for_thread(
        &self,
        user_id: &str,
        workspace_id: &str,
        thread_id: &str,
    ) -> TaskRuntimeResult<usize> {
        Ok(self.connection.execute(
            "DELETE FROM runtime_plans
             WHERE user_id = ?1 AND workspace_id = ?2 AND thread_id = ?3",
            params![user_id, workspace_id, thread_id],
        )?)
    }

    pub fn append_agent_checkpoint(
        &self,
        run_id: &str,
        round: u32,
        state: &Value,
        fingerprint: &str,
        resumable: bool,
    ) -> TaskRuntimeResult<AgentCheckpoint> {
        let (turn_id, thread_id, user_id, workspace_id): (String, String, String, String) =
            self.connection.query_row(
                "SELECT turn_id, thread_id, user_id, workspace_id FROM agent_runs WHERE run_id = ?1",
                params![run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
        let checkpoint_id = format!("{run_id}:{round}");
        let created_at = OffsetDateTime::now_utc().unix_timestamp();
        self.connection.execute(
            "INSERT INTO agent_checkpoints (
                checkpoint_id, run_id, turn_id, thread_id, user_id, workspace_id,
                round, state_json, fingerprint, resumable, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(run_id, round) DO UPDATE SET
                state_json = excluded.state_json,
                fingerprint = excluded.fingerprint,
                resumable = excluded.resumable,
                created_at = excluded.created_at",
            params![
                checkpoint_id,
                run_id,
                turn_id,
                thread_id,
                user_id,
                workspace_id,
                round as i64,
                serde_json::to_string(state)?,
                fingerprint,
                if resumable { 1 } else { 0 },
                created_at,
            ],
        )?;
        Ok(AgentCheckpoint {
            checkpoint_id,
            run_id: run_id.to_string(),
            turn_id,
            thread_id,
            user_id,
            workspace_id,
            round,
            state_json: state.clone(),
            fingerprint: fingerprint.to_string(),
            resumable,
            created_at,
        })
    }

    pub fn latest_resumable_checkpoint_for_turn(
        &self,
        turn_id: &str,
        user_id: &str,
        workspace_id: &str,
    ) -> TaskRuntimeResult<Option<AgentCheckpoint>> {
        self.connection
            .query_row(
                "SELECT c.checkpoint_id, c.run_id, c.turn_id, c.thread_id, c.user_id,
                        c.workspace_id, c.round, c.state_json, c.fingerprint,
                        c.resumable, c.created_at
                 FROM agent_checkpoints c
                 JOIN agent_runs r ON r.run_id = c.run_id
                 WHERE c.turn_id = ?1 AND c.user_id = ?2 AND c.workspace_id = ?3
                   AND c.resumable = 1 AND r.status = 'aborted'
                   AND r.terminal_reason IN ('gateway_restart', 'parked_waiting_for_model')
                 ORDER BY r.attempt DESC, c.round DESC, c.created_at DESC
                 LIMIT 1",
                params![turn_id, user_id, workspace_id],
                |row| {
                    let state_json: String = row.get(7)?;
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                        state_json,
                        row.get::<_, String>(8)?,
                        row.get::<_, i64>(9)?,
                        row.get::<_, i64>(10)?,
                    ))
                },
            )
            .optional()?
            .map(
                |(
                    checkpoint_id,
                    run_id,
                    turn_id,
                    thread_id,
                    user_id,
                    workspace_id,
                    round,
                    state_json,
                    fingerprint,
                    resumable,
                    created_at,
                )| {
                    Ok(AgentCheckpoint {
                        checkpoint_id,
                        run_id,
                        turn_id,
                        thread_id,
                        user_id,
                        workspace_id,
                        round: round as u32,
                        state_json: serde_json::from_str(&state_json)?,
                        fingerprint,
                        resumable: resumable != 0,
                        created_at,
                    })
                },
            )
            .transpose()
    }

    pub fn prepare_effect_receipt(
        &self,
        new_receipt: &NewExecutionEffectReceipt,
    ) -> TaskRuntimeResult<ExecutionEffectReceipt> {
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let receipt = prepare_effect_receipt_on(&tx, new_receipt)?;
        tx.commit()?;
        Ok(receipt)
    }

    /// Atomically verifies the current task/execution attempt, prepares the receipt, and claims it.
    /// A worker that lost its lease or execution fence therefore cannot cross the effect boundary.
    pub fn prepare_and_claim_effect_receipt(
        &self,
        new_receipt: &NewExecutionEffectReceipt,
        expected_owner: &str,
        expected_fencing_token: u64,
    ) -> TaskRuntimeResult<EffectReceiptClaim> {
        if expected_owner.trim().is_empty() || expected_fencing_token == 0 {
            return Err(TaskRuntimeError::InvalidTransition(
                "effect claim requires an active execution attempt".into(),
            ));
        }
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        if let Some(claim) =
            claim_existing_non_executable_receipt_on(&tx, &new_receipt.receipt_ref)?
        {
            tx.commit()?;
            return Ok(claim);
        }
        let task_json = tx
            .query_row(
                "SELECT task_json FROM tasks
                 WHERE task_id = ?1 AND user_id = ?2 AND workspace_id = ?3",
                params![
                    new_receipt.execution_id,
                    new_receipt.user_id,
                    new_receipt.workspace_id,
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| TaskRuntimeError::NotFound(new_receipt.execution_id.clone()))?;
        let task: TaskRecord = serde_json::from_str(&task_json)?;
        let now = OffsetDateTime::now_utc();
        let lease_current = task.status == TaskStatus::Running
            && task.lease_owner.as_deref() == Some(expected_owner)
            && task.effective_lease_fencing_token() == Some(expected_fencing_token)
            && task
                .lease_expires_at
                .is_some_and(|expires_at| expires_at > now)
            && task.deadline.is_none_or(|deadline| deadline > now)
            && task.expires_at.is_none_or(|expires_at| expires_at > now);
        let execution_current = tx.query_row(
            "SELECT COUNT(*) FROM executions
                 WHERE execution_id = ?1 AND revision = ?2 AND fencing_token = ?3
                   AND state = 'running'",
            params![
                new_receipt.execution_id,
                i64::try_from(new_receipt.revision).map_err(|_| {
                    TaskRuntimeError::Store("effect receipt revision is out of range".into())
                })?,
                i64::try_from(expected_fencing_token).map_err(|_| {
                    TaskRuntimeError::Store("effect fencing token is out of range".into())
                })?,
            ],
            |row| row.get::<_, i64>(0),
        )? == 1;
        if !lease_current || !execution_current {
            return Err(TaskRuntimeError::InvalidTransition(
                "stale execution attempt cannot claim an effect".into(),
            ));
        }

        prepare_effect_receipt_on(&tx, new_receipt)?;
        let claim = claim_effect_receipt_on(&tx, &new_receipt.receipt_ref)?;
        tx.commit()?;
        Ok(claim)
    }

    /// Claims an adapter-output receipt against the authoritative execution revision. Projection
    /// may run after the adapter outcome is terminal, so it is fenced by revision/token rather than
    /// by the worker lease used for capability dispatch.
    pub fn prepare_and_claim_effect_receipt_for_projection(
        &self,
        new_receipt: &NewExecutionEffectReceipt,
        expected_fencing_token: u64,
        projection_claim: &ProjectionClaim,
    ) -> TaskRuntimeResult<EffectReceiptClaim> {
        if projection_claim.record.execution_id != new_receipt.execution_id
            || projection_claim.record.revision != new_receipt.revision
        {
            return Err(TaskRuntimeError::InvalidTransition(
                "projection claim does not own the adapter effect execution revision".into(),
            ));
        }
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        crate::projection_outbox::assert_projection_claim_current_on(&tx, projection_claim)?;
        if let Some(claim) =
            claim_existing_non_executable_receipt_on(&tx, &new_receipt.receipt_ref)?
        {
            tx.commit()?;
            return Ok(claim);
        }
        let execution_current = tx.query_row(
            "SELECT COUNT(*) FROM executions
                 WHERE execution_id = ?1 AND revision = ?2 AND fencing_token = ?3
                   AND user_id = ?4 AND workspace_id = ?5 AND thread_id IS ?6",
            params![
                new_receipt.execution_id,
                i64::try_from(new_receipt.revision).map_err(|_| {
                    TaskRuntimeError::Store("effect receipt revision is out of range".into())
                })?,
                i64::try_from(expected_fencing_token).map_err(|_| {
                    TaskRuntimeError::Store("effect fencing token is out of range".into())
                })?,
                new_receipt.user_id,
                new_receipt.workspace_id,
                new_receipt.thread_id,
            ],
            |row| row.get::<_, i64>(0),
        )? == 1;
        if !execution_current {
            return Err(TaskRuntimeError::InvalidTransition(
                "stale execution revision cannot claim adapter output".into(),
            ));
        }
        prepare_effect_receipt_on(&tx, new_receipt)?;
        let claim = claim_effect_receipt_on(&tx, &new_receipt.receipt_ref)?;
        tx.commit()?;
        Ok(claim)
    }

    pub fn claim_effect_receipt(
        &self,
        receipt_ref: &EffectReceiptRef,
    ) -> TaskRuntimeResult<EffectReceiptClaim> {
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let claim = claim_effect_receipt_on(&tx, receipt_ref)?;
        tx.commit()?;
        Ok(claim)
    }

    pub fn complete_effect_receipt(
        &self,
        receipt_ref: &EffectReceiptRef,
        result: &Value,
        effects: &Value,
    ) -> TaskRuntimeResult<ExecutionEffectReceipt> {
        let completed_at = OffsetDateTime::now_utc().unix_timestamp();
        let changed = self.connection.execute(
            "UPDATE execution_effect_receipts
             SET status = 'completed', result_json = ?1, effects_json = ?2, resolved_at = ?3
             WHERE receipt_ref = ?4 AND status = 'started'",
            params![
                serde_json::to_string(result)?,
                serde_json::to_string(effects)?,
                completed_at,
                receipt_ref.as_ref(),
            ],
        )?;
        if changed != 1 {
            return Err(TaskRuntimeError::Store(
                "effect receipt is not started".into(),
            ));
        }
        load_effect_receipt_on(&self.connection, receipt_ref)?
            .ok_or_else(|| TaskRuntimeError::Store("completed effect receipt disappeared".into()))
    }

    pub fn mark_effect_receipt_uncertain(
        &self,
        receipt_ref: &EffectReceiptRef,
        evidence: &Value,
    ) -> TaskRuntimeResult<ExecutionEffectReceipt> {
        let changed = self.connection.execute(
            "UPDATE execution_effect_receipts
             SET status = 'uncertain', effects_json = ?1
             WHERE receipt_ref = ?2 AND status = 'started'",
            params![serde_json::to_string(evidence)?, receipt_ref.as_ref()],
        )?;
        if changed != 1 {
            return Err(TaskRuntimeError::InvalidTransition(
                "only a started effect may become uncertain".into(),
            ));
        }
        load_effect_receipt_on(&self.connection, receipt_ref)?
            .ok_or_else(|| TaskRuntimeError::Store("uncertain effect receipt disappeared".into()))
    }

    pub fn release_effect_receipt_not_applied(
        &self,
        receipt_ref: &EffectReceiptRef,
        error: &Value,
    ) -> TaskRuntimeResult<ExecutionEffectReceipt> {
        let resolved_at = OffsetDateTime::now_utc().unix_timestamp();
        let changed = self.connection.execute(
            "UPDATE execution_effect_receipts
             SET status = 'prepared', result_json = NULL, effects_json = NULL,
                 error_json = ?1, started_at = NULL, resolved_at = ?2
             WHERE receipt_ref = ?3 AND status = 'started'",
            params![
                serde_json::to_string(error)?,
                resolved_at,
                receipt_ref.as_ref(),
            ],
        )?;
        if changed != 1 {
            return Err(TaskRuntimeError::InvalidTransition(
                "only a started effect may be released as verified not applied".into(),
            ));
        }
        load_effect_receipt_on(&self.connection, receipt_ref)?
            .ok_or_else(|| TaskRuntimeError::Store("released effect receipt disappeared".into()))
    }

    pub fn list_effect_receipts_for_thread(
        &self,
        thread_id: &str,
        user_id: &str,
        workspace_id: &str,
    ) -> TaskRuntimeResult<Vec<ExecutionEffectReceipt>> {
        let mut stmt = self.connection.prepare(
            "SELECT receipt_ref, execution_id, revision, idempotency_key, run_id, thread_id,
                    user_id, workspace_id, effect_class, operation, arguments_hash, status,
                    result_json, effects_json, error_json, compensation_json,
                    prepared_at, started_at, resolved_at
             FROM execution_effect_receipts
             WHERE thread_id = ?1 AND user_id = ?2 AND workspace_id = ?3
             ORDER BY prepared_at ASC, idempotency_key ASC",
        )?;
        let rows = stmt.query_map(
            params![thread_id, user_id, workspace_id],
            map_effect_receipt_row,
        )?;
        rows.map(|row| row.map_err(Into::into)).collect()
    }

    pub fn effect_receipt(
        &self,
        receipt_ref: &EffectReceiptRef,
    ) -> TaskRuntimeResult<Option<ExecutionEffectReceipt>> {
        load_effect_receipt_on(&self.connection, receipt_ref)
    }

    pub fn uncertain_effect_receipts_for_user(
        &self,
        user_id: &str,
    ) -> TaskRuntimeResult<Vec<ExecutionEffectReceipt>> {
        let mut stmt = self.connection.prepare(
            "SELECT receipt_ref, execution_id, revision, idempotency_key, run_id, thread_id,
                    user_id, workspace_id, effect_class, operation, arguments_hash, status,
                    result_json, effects_json, error_json, compensation_json,
                    prepared_at, started_at, resolved_at
             FROM execution_effect_receipts
             WHERE user_id = ?1 AND status = 'uncertain' AND effect_class != 'read'
             ORDER BY prepared_at ASC, idempotency_key ASC",
        )?;
        let rows = stmt.query_map([user_id], map_effect_receipt_row)?;
        rows.map(|row| row.map_err(Into::into)).collect()
    }

    pub fn list_effect_receipts_for_execution(
        &self,
        execution_id: &str,
        revision: u64,
    ) -> TaskRuntimeResult<Vec<ExecutionEffectReceipt>> {
        let revision = i64::try_from(revision).map_err(|_| {
            TaskRuntimeError::Store("effect receipt revision is out of range".into())
        })?;
        let mut stmt = self.connection.prepare(
            "SELECT receipt_ref, execution_id, revision, idempotency_key, run_id, thread_id,
                    user_id, workspace_id, effect_class, operation, arguments_hash, status,
                    result_json, effects_json, error_json, compensation_json,
                    prepared_at, started_at, resolved_at
             FROM execution_effect_receipts
             WHERE execution_id = ?1 AND revision = ?2
             ORDER BY prepared_at ASC, idempotency_key ASC",
        )?;
        let rows = stmt.query_map(params![execution_id, revision], map_effect_receipt_row)?;
        rows.map(|row| row.map_err(Into::into)).collect()
    }

    pub fn pending_compensations(
        &self,
        execution_id: &str,
    ) -> TaskRuntimeResult<Vec<ExecutionEffectReceipt>> {
        let mut stmt = self.connection.prepare(
            "SELECT receipt_ref, execution_id, revision, idempotency_key, run_id, thread_id,
                    user_id, workspace_id, effect_class, operation, arguments_hash, status,
                    result_json, effects_json, error_json, compensation_json,
                    prepared_at, started_at, resolved_at
             FROM execution_effect_receipts
             WHERE execution_id = ?1 AND status = 'completed' AND compensation_json IS NOT NULL
             ORDER BY prepared_at DESC, idempotency_key DESC",
        )?;
        let rows = stmt.query_map([execution_id], map_effect_receipt_row)?;
        rows.map(|row| row.map_err(Into::into)).collect()
    }

    /// Reclaims free space. Call periodically, NOT on every delete.
    pub fn vacuum(&self) -> TaskRuntimeResult<()> {
        self.connection.execute_batch("VACUUM")?;
        Ok(())
    }

    pub fn get_task(
        &self,
        task_id: &TaskId,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> TaskRuntimeResult<Option<TaskRecord>> {
        self.connection
            .query_row(
                "
                SELECT task_json
                FROM tasks
                WHERE task_id = ?1 AND user_id = ?2 AND workspace_id = ?3
                ",
                params![task_id.as_str(), user_id.as_str(), workspace_id.as_str()],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|json| Ok(serde_json::from_str::<TaskRecord>(&json)?))
            .transpose()
    }

    pub fn update_task_status(
        &self,
        task_id: &TaskId,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        status: TaskStatus,
        blocked_reason: Option<&str>,
    ) -> TaskRuntimeResult<()> {
        let mut task = self
            .get_task(task_id, user_id, workspace_id)?
            .ok_or_else(|| TaskRuntimeError::NotFound(task_id.as_str().to_string()))?;
        task.status = status;
        task.blocked_reason = blocked_reason.map(str::to_string);
        task.updated_at = OffsetDateTime::now_utc();
        self.insert_task(&task)
    }

    /// Distinct (user, workspace) pairs that own tasks. Lets a maintenance sweep
    /// (GC, dedup) reach tasks in EVERY workspace — `list_tasks` is per-workspace, so
    /// cruft accumulated under old projects would otherwise be invisible to a sweep
    /// scoped to the active workspace.
    pub fn task_owner_scopes(&self) -> TaskRuntimeResult<Vec<(UserId, WorkspaceId)>> {
        let mut statement = self
            .connection
            .prepare("SELECT DISTINCT user_id, workspace_id FROM tasks")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut scopes = Vec::new();
        for row in rows {
            let (user, workspace) = row?;
            scopes.push((UserId::new(user), WorkspaceId::new(workspace)));
        }
        Ok(scopes)
    }

    /// Workspace scopes for this user that still contain work the runtime may
    /// need to recover, requeue, or execute. Terminal-only scopes stay out of
    /// the background worker's polling set.
    pub fn non_terminal_workspace_ids(
        &self,
        user_id: &UserId,
    ) -> TaskRuntimeResult<Vec<WorkspaceId>> {
        let mut statement = self.connection.prepare(
            "SELECT DISTINCT workspace_id
             FROM tasks
             WHERE user_id = ?1
               AND status NOT IN ('completed', 'failed', 'cancelled', 'expired')
             ORDER BY workspace_id ASC",
        )?;
        let rows = statement.query_map(params![user_id.as_str()], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(WorkspaceId::new(row?))).collect()
    }

    pub fn list_tasks(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> TaskRuntimeResult<Vec<TaskRecord>> {
        let mut statement = self.connection.prepare(
            "
            SELECT task_json
            FROM tasks
            WHERE user_id = ?1 AND workspace_id = ?2
            ORDER BY created_at ASC, task_id ASC
            ",
        )?;
        let rows = statement
            .query_map(params![user_id.as_str(), workspace_id.as_str()], |row| {
                row.get::<_, String>(0)
            })?;

        let mut tasks = Vec::new();
        for row in rows {
            tasks.push(serde_json::from_str::<TaskRecord>(&row?)?);
        }
        Ok(tasks)
    }

    // ── Automations (the user-facing rules; runs are TaskRecords) ──────────────

    pub fn upsert_automation(&self, automation: &Automation) -> TaskRuntimeResult<()> {
        self.connection.execute(
            "
            INSERT INTO automations (
                id, user_id, workspace_id, enabled, trigger_kind,
                created_at, updated_at, automation_json
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ON CONFLICT(id, user_id, workspace_id) DO UPDATE SET
                enabled = excluded.enabled,
                trigger_kind = excluded.trigger_kind,
                updated_at = excluded.updated_at,
                automation_json = excluded.automation_json
            ",
            params![
                automation.id,
                automation.user_id.as_str(),
                automation.workspace_id.as_str(),
                automation.enabled as i64,
                automation.trigger_kind(),
                automation.created_at.unix_timestamp(),
                automation.updated_at.unix_timestamp(),
                serde_json::to_string(automation)?,
            ],
        )?;
        Ok(())
    }

    pub fn get_automation(
        &self,
        id: &str,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> TaskRuntimeResult<Option<Automation>> {
        self.connection
            .query_row(
                "
                SELECT automation_json
                FROM automations
                WHERE id = ?1 AND user_id = ?2 AND workspace_id = ?3
                ",
                params![id, user_id.as_str(), workspace_id.as_str()],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|json| Ok(serde_json::from_str::<Automation>(&json)?))
            .transpose()
    }

    pub fn list_automations(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> TaskRuntimeResult<Vec<Automation>> {
        let mut statement = self.connection.prepare(
            "
            SELECT automation_json
            FROM automations
            WHERE user_id = ?1 AND workspace_id = ?2
            ORDER BY created_at DESC, id ASC
            ",
        )?;
        let rows = statement
            .query_map(params![user_id.as_str(), workspace_id.as_str()], |row| {
                row.get::<_, String>(0)
            })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(serde_json::from_str::<Automation>(&row?)?);
        }
        Ok(out)
    }

    /// All ENABLED Event automations across every workspace for a user — the set an
    /// inbound event is matched against. Filtering by event kind/filters happens in
    /// the caller (cheap; the enabled set is small).
    pub fn list_enabled_event_automations(
        &self,
        user_id: &UserId,
    ) -> TaskRuntimeResult<Vec<Automation>> {
        let mut statement = self.connection.prepare(
            "
            SELECT automation_json
            FROM automations
            WHERE user_id = ?1 AND enabled = 1 AND trigger_kind = 'event'
            ORDER BY created_at ASC
            ",
        )?;
        let rows = statement.query_map(params![user_id.as_str()], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(serde_json::from_str::<Automation>(&row?)?);
        }
        Ok(out)
    }

    pub fn delete_automation(
        &self,
        id: &str,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> TaskRuntimeResult<()> {
        self.connection.execute(
            "DELETE FROM automations WHERE id = ?1 AND user_id = ?2 AND workspace_id = ?3",
            params![id, user_id.as_str(), workspace_id.as_str()],
        )?;
        // The run history is keyed by automation_id (no FK), so clean it up here.
        self.connection.execute(
            "DELETE FROM automation_runs WHERE automation_id = ?1",
            params![id],
        )?;
        self.connection.execute(
            "DELETE FROM automation_event_dedup WHERE automation_id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Mark an event as seen for one automation rule. Returns true only for the
    /// first observation of `(automation_id, event_key)`; later deliveries are
    /// duplicates and should not materialize another run.
    pub fn mark_automation_event_seen(
        &self,
        automation_id: &str,
        event_key: &str,
        seen_at: OffsetDateTime,
    ) -> TaskRuntimeResult<bool> {
        let inserted = self.connection.execute(
            "INSERT OR IGNORE INTO automation_event_dedup (automation_id, event_key, seen_at)
             VALUES (?1, ?2, ?3)",
            params![automation_id, event_key, seen_at.unix_timestamp()],
        )?;
        self.connection.execute(
            "DELETE FROM automation_event_dedup
              WHERE automation_id = ?1 AND rowid NOT IN (
                  SELECT rowid FROM automation_event_dedup
                   WHERE automation_id = ?1
                   ORDER BY seen_at DESC, event_key DESC LIMIT 500
              )",
            params![automation_id],
        )?;
        Ok(inserted == 1)
    }

    /// Append one execution to an automation's run history (when it fired + outcome),
    /// keeping only the most recent ~50 per automation so it never grows unbounded.
    pub fn record_automation_run(
        &self,
        automation_id: &str,
        ran_at: OffsetDateTime,
        ok: bool,
        late: bool,
        detail: Option<&str>,
    ) -> TaskRuntimeResult<()> {
        self.connection.execute(
            "INSERT INTO automation_runs (automation_id, ran_at, ok, late, detail)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                automation_id,
                ran_at.unix_timestamp(),
                ok as i64,
                late as i64,
                detail
            ],
        )?;
        self.connection.execute(
            "DELETE FROM automation_runs
              WHERE automation_id = ?1 AND id NOT IN (
                  SELECT id FROM automation_runs
                   WHERE automation_id = ?1
                   ORDER BY ran_at DESC, id DESC LIMIT 50
              )",
            params![automation_id],
        )?;
        Ok(())
    }

    /// The most recent runs of an automation, newest first.
    pub fn recent_automation_runs(
        &self,
        automation_id: &str,
        limit: usize,
    ) -> TaskRuntimeResult<Vec<AutomationRun>> {
        let mut statement = self.connection.prepare(
            "SELECT ran_at, ok, late, detail FROM automation_runs
              WHERE automation_id = ?1
              ORDER BY ran_at DESC, id DESC LIMIT ?2",
        )?;
        let rows = statement.query_map(params![automation_id, limit as i64], |row| {
            Ok(AutomationRun {
                ran_at: row.get::<_, i64>(0)?,
                ok: row.get::<_, i64>(1)? != 0,
                late: row.get::<_, i64>(2)? != 0,
                detail: row.get::<_, Option<String>>(3)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn add_dependency(
        &self,
        task_id: &TaskId,
        depends_on_task_id: &TaskId,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> TaskRuntimeResult<()> {
        self.connection.execute(
            "
            INSERT INTO task_dependencies (
                task_id,
                depends_on_task_id,
                user_id,
                workspace_id,
                created_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(task_id, depends_on_task_id, user_id, workspace_id) DO NOTHING
            ",
            params![
                task_id.as_str(),
                depends_on_task_id.as_str(),
                user_id.as_str(),
                workspace_id.as_str(),
                OffsetDateTime::now_utc().unix_timestamp(),
            ],
        )?;
        Ok(())
    }

    pub fn dependencies_for(
        &self,
        task_id: &TaskId,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> TaskRuntimeResult<Vec<TaskId>> {
        let mut statement = self.connection.prepare(
            "
            SELECT depends_on_task_id
            FROM task_dependencies
            WHERE task_id = ?1 AND user_id = ?2 AND workspace_id = ?3
            ORDER BY created_at ASC, depends_on_task_id ASC
            ",
        )?;
        let rows = statement.query_map(
            params![task_id.as_str(), user_id.as_str(), workspace_id.as_str()],
            |row| row.get::<_, String>(0),
        )?;

        let mut dependencies = Vec::new();
        for row in rows {
            dependencies.push(TaskId::new(row?));
        }
        Ok(dependencies)
    }

    pub fn dependency_outputs_for(
        &self,
        task_id: &TaskId,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> TaskRuntimeResult<Vec<TaskDependencyOutput>> {
        // Batched single query: LEFT JOINs task_dependencies with the latest
        // task_checkpoints per dependency (correlated MAX subquery). This replaces
        // the previous N+1 pattern that called latest_checkpoint() in a loop.
        // idx_task_checkpoints_task(user_id, workspace_id, task_id, sequence) serves
        // the subquery's MAX(sequence) seek per dependency.
        let mut statement = self.connection.prepare(
            "SELECT d.depends_on_task_id,
                    c.payload_json,
                    c.redacted_payload_json
               FROM task_dependencies d
               LEFT JOIN task_checkpoints c
                 ON c.task_id = d.depends_on_task_id
                AND c.user_id = d.user_id
                AND c.workspace_id = d.workspace_id
                AND c.sequence = (
                    SELECT MAX(c2.sequence)
                    FROM task_checkpoints c2
                    WHERE c2.task_id = d.depends_on_task_id
                      AND c2.user_id = d.user_id
                      AND c2.workspace_id = d.workspace_id
                )
              WHERE d.task_id = ?1 AND d.user_id = ?2 AND d.workspace_id = ?3
              ORDER BY d.created_at ASC, d.depends_on_task_id ASC",
        )?;
        let rows = statement.query_map(
            params![task_id.as_str(), user_id.as_str(), workspace_id.as_str()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )?;

        let mut outputs = Vec::new();
        for row in rows {
            let (depends_on_task_id, payload_json, redacted_payload_json) = row?;
            // A NULL payload means the LEFT JOIN found no checkpoint for this
            // dependency — same error the old per-dependency lookup produced.
            let Some(payload_json) = payload_json else {
                return Err(TaskRuntimeError::Store(format!(
                    "dependency_output_missing:{}",
                    depends_on_task_id
                )));
            };
            let redacted_payload_json = redacted_payload_json.unwrap_or_else(|| {
                // Should not happen (both columns are NOT NULL), but stay defensive.
                payload_json.clone()
            });
            let payload: Value = serde_json::from_str(&payload_json)?;
            let redacted_payload: Value = serde_json::from_str(&redacted_payload_json)?;
            outputs.push(TaskDependencyOutput {
                task_id: TaskId::new(depends_on_task_id),
                output: payload.get("output").cloned().unwrap_or(payload),
                redacted_output: redacted_payload
                    .get("output")
                    .cloned()
                    .unwrap_or(redacted_payload),
            });
        }
        Ok(outputs)
    }

    pub fn reserve_resources(&self, task: &TaskRecord, owner: &str) -> TaskRuntimeResult<()> {
        for requirement in &task.resource_requirements {
            self.connection.execute(
                "
                INSERT INTO resource_reservations (
                    task_id,
                    user_id,
                    workspace_id,
                    resource_class,
                    units,
                    owner,
                    created_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                ON CONFLICT(task_id, user_id, workspace_id, resource_class) DO UPDATE SET
                    units = excluded.units,
                    owner = excluded.owner,
                    created_at = excluded.created_at
                ",
                params![
                    task.task_id.as_str(),
                    task.user_id.as_str(),
                    task.workspace_id.as_str(),
                    requirement.class.as_str(),
                    requirement.units,
                    owner,
                    OffsetDateTime::now_utc().unix_timestamp(),
                ],
            )?;
        }
        Ok(())
    }

    pub fn release_resources(&self, task: &TaskRecord) -> TaskRuntimeResult<()> {
        self.connection.execute(
            "
            DELETE FROM resource_reservations
            WHERE task_id = ?1 AND user_id = ?2 AND workspace_id = ?3
            ",
            params![
                task.task_id.as_str(),
                task.user_id.as_str(),
                task.workspace_id.as_str(),
            ],
        )?;
        Ok(())
    }

    pub fn has_resource_reservation(&self, task: &TaskRecord) -> TaskRuntimeResult<bool> {
        let present: i64 = self.connection.query_row(
            "
            SELECT EXISTS(
                SELECT 1
                FROM resource_reservations
                WHERE task_id = ?1 AND user_id = ?2 AND workspace_id = ?3
            )
            ",
            params![
                task.task_id.as_str(),
                task.user_id.as_str(),
                task.workspace_id.as_str(),
            ],
            |row| row.get(0),
        )?;
        Ok(present != 0)
    }

    pub fn resource_usage(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        resource_class: ResourceClass,
    ) -> TaskRuntimeResult<u32> {
        let units: Option<i64> = self.connection.query_row(
            "
            SELECT SUM(units)
            FROM resource_reservations
            WHERE user_id = ?1 AND workspace_id = ?2 AND resource_class = ?3
            ",
            params![
                user_id.as_str(),
                workspace_id.as_str(),
                resource_class.as_str()
            ],
            |row| row.get(0),
        )?;
        Ok(units.unwrap_or_default() as u32)
    }

    pub fn resource_usage_for_task(
        &self,
        task: &TaskRecord,
        resource_class: ResourceClass,
    ) -> TaskRuntimeResult<u32> {
        let units: Option<i64> = self.connection.query_row(
            "
            SELECT SUM(units)
            FROM resource_reservations
            WHERE task_id = ?1
              AND user_id = ?2
              AND workspace_id = ?3
              AND resource_class = ?4
            ",
            params![
                task.task_id.as_str(),
                task.user_id.as_str(),
                task.workspace_id.as_str(),
                resource_class.as_str()
            ],
            |row| row.get(0),
        )?;
        Ok(units.unwrap_or_default() as u32)
    }

    pub fn append_checkpoint(
        &self,
        task_id: &TaskId,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        payload: Value,
        redacted_payload: Value,
    ) -> TaskRuntimeResult<TaskCheckpoint> {
        let sequence = self.next_checkpoint_sequence(task_id, user_id, workspace_id)?;
        let checkpoint = TaskCheckpoint::new(
            uuid::Uuid::new_v4().simple().to_string(),
            task_id.clone(),
            user_id.clone(),
            workspace_id.clone(),
            sequence,
            payload,
            redacted_payload,
        );
        self.connection.execute(
            "
            INSERT INTO task_checkpoints (
                checkpoint_id,
                task_id,
                user_id,
                workspace_id,
                sequence,
                payload_json,
                redacted_payload_json,
                created_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ",
            params![
                checkpoint.checkpoint_id,
                checkpoint.task_id.as_str(),
                checkpoint.user_id.as_str(),
                checkpoint.workspace_id.as_str(),
                checkpoint.sequence,
                serde_json::to_string(&checkpoint.payload)?,
                serde_json::to_string(&checkpoint.redacted_payload)?,
                checkpoint.created_at.unix_timestamp(),
            ],
        )?;

        if let Some(mut task) = self.get_task(task_id, user_id, workspace_id)? {
            task.checkpoint_json = Some(checkpoint.redacted_payload.clone());
            task.updated_at = checkpoint.created_at;
            self.insert_task(&task)?;
        }

        Ok(checkpoint)
    }

    pub fn latest_checkpoint(
        &self,
        task_id: &TaskId,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> TaskRuntimeResult<Option<TaskCheckpoint>> {
        self.connection
            .query_row(
                "
                SELECT
                    checkpoint_id,
                    sequence,
                    payload_json,
                    redacted_payload_json,
                    created_at
                FROM task_checkpoints
                WHERE task_id = ?1 AND user_id = ?2 AND workspace_id = ?3
                ORDER BY sequence DESC
                LIMIT 1
                ",
                params![task_id.as_str(), user_id.as_str(), workspace_id.as_str()],
                |row| {
                    let checkpoint_id: String = row.get(0)?;
                    let sequence: u32 = row.get(1)?;
                    let payload_json: String = row.get(2)?;
                    let redacted_payload_json: String = row.get(3)?;
                    let created_at: i64 = row.get(4)?;
                    Ok((
                        checkpoint_id,
                        sequence,
                        payload_json,
                        redacted_payload_json,
                        created_at,
                    ))
                },
            )
            .optional()?
            .map(
                |(checkpoint_id, sequence, payload_json, redacted_payload_json, created_at)| {
                    Ok(TaskCheckpoint {
                        checkpoint_id,
                        task_id: task_id.clone(),
                        user_id: user_id.clone(),
                        workspace_id: workspace_id.clone(),
                        sequence,
                        payload: serde_json::from_str(&payload_json)?,
                        redacted_payload: serde_json::from_str(&redacted_payload_json)?,
                        created_at: OffsetDateTime::from_unix_timestamp(created_at)
                            .map_err(|error| TaskRuntimeError::Store(error.to_string()))?,
                    })
                },
            )
            .transpose()
    }

    pub fn checkpoint(
        &self,
        checkpoint_id: &str,
        task_id: &TaskId,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> TaskRuntimeResult<Option<TaskCheckpoint>> {
        self.connection
            .query_row(
                "SELECT sequence, payload_json, redacted_payload_json, created_at
                 FROM task_checkpoints
                 WHERE checkpoint_id = ?1 AND task_id = ?2 AND user_id = ?3 AND workspace_id = ?4",
                params![
                    checkpoint_id,
                    task_id.as_str(),
                    user_id.as_str(),
                    workspace_id.as_str(),
                ],
                |row| {
                    Ok((
                        row.get::<_, u32>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()?
            .map(|(sequence, payload, redacted_payload, created_at)| {
                Ok(TaskCheckpoint {
                    checkpoint_id: checkpoint_id.to_string(),
                    task_id: task_id.clone(),
                    user_id: user_id.clone(),
                    workspace_id: workspace_id.clone(),
                    sequence,
                    payload: serde_json::from_str(&payload)?,
                    redacted_payload: serde_json::from_str(&redacted_payload)?,
                    created_at: OffsetDateTime::from_unix_timestamp(created_at).map_err(
                        |error| {
                            TaskRuntimeError::Store(format!(
                                "invalid checkpoint timestamp: {error}"
                            ))
                        },
                    )?,
                })
            })
            .transpose()
    }

    /// Appends an event to a turn's stream. Returns the event with seq/event_id
    /// assigned. `seq` is monotonic per turn_id (1-based). Used by the broker to
    /// persist every delta.
    pub fn insert_turn_event(
        &self,
        turn_id: &str,
        kind: TurnEventKind,
        payload: Value,
    ) -> TaskRuntimeResult<TurnEvent> {
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let event = insert_turn_event_on(&tx, turn_id, kind, payload)?;
        tx.commit()?;
        Ok(event)
    }

    /// Atomically commits the first logical terminal for a turn. Later terminal
    /// attempts return the canonical event and must not be broadcast again.
    pub fn insert_terminal_event_once(
        &self,
        turn_id: &str,
        kind: TurnEventKind,
        payload: Value,
    ) -> TaskRuntimeResult<TerminalWrite> {
        if !turn_event_kind_is_terminal(kind) {
            return Err(TaskRuntimeError::InvalidTransition(
                "non-terminal turn event kind".to_string(),
            ));
        }
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        if let Some(existing) = first_terminal_event_on(&tx, turn_id)? {
            tx.commit()?;
            return Ok(TerminalWrite::Existing(existing));
        }
        let event = insert_turn_event_on(&tx, turn_id, kind, payload)?;
        tx.commit()?;
        Ok(TerminalWrite::Inserted(event))
    }

    /// Atomically persists one visible event for a canonical execution projection.
    /// The projection reference is the idempotency identity across overlapping workers.
    pub fn insert_turn_projection_event_once(
        &self,
        turn_id: &str,
        kind: TurnEventKind,
        projection_ref: &str,
        payload: Value,
    ) -> TaskRuntimeResult<TerminalWrite> {
        if projection_ref.trim().is_empty()
            || payload.get("projection_ref").and_then(Value::as_str) != Some(projection_ref)
        {
            return Err(TaskRuntimeError::InvalidTransition(
                "projection event requires its exact projection reference".into(),
            ));
        }
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        if let Some(existing) = projection_event_on(&tx, turn_id, projection_ref)? {
            tx.commit()?;
            return Ok(TerminalWrite::Existing(existing));
        }
        if turn_event_kind_is_terminal(kind)
            && let Some(mut existing) = first_terminal_event_on(&tx, turn_id)?
        {
            let may_adopt_legacy_terminal = existing
                .payload
                .get("projection_ref")
                .and_then(Value::as_str)
                .is_none()
                && (existing.kind == kind || kind == TurnEventKind::Cancelled);
            if may_adopt_legacy_terminal {
                let changed = tx.execute(
                    "UPDATE turn_events SET kind = ?1, payload_json = ?2
                     WHERE event_id = ?3",
                    params![
                        kind.as_str(),
                        serde_json::to_string(&payload)?,
                        existing.event_id,
                    ],
                )?;
                if changed != 1 {
                    return Err(TaskRuntimeError::Store(
                        "legacy terminal event disappeared during projection adoption".into(),
                    ));
                }
                existing.kind = kind;
                existing.payload = payload;
                tx.commit()?;
                return Ok(TerminalWrite::Inserted(existing));
            }
            return Err(TaskRuntimeError::Conflict(
                "canonical projection conflicts with an unacknowledged terminal event".into(),
            ));
        }
        let event = insert_turn_event_on(&tx, turn_id, kind, payload)?;
        tx.commit()?;
        Ok(TerminalWrite::Inserted(event))
    }

    /// Reads a turn's events with seq > since (for stream resume). Returned in
    /// ascending seq order.
    pub fn read_turn_events(&self, turn_id: &str, since: i64) -> TaskRuntimeResult<Vec<TurnEvent>> {
        let mut stmt = self.connection.prepare(
            "SELECT event_id, turn_id, seq, kind, payload_json, created_at
             FROM turn_events
             WHERE turn_id = ?1 AND seq > ?2
             ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map(params![turn_id, since], |row| {
            let event_id: i64 = row.get(0)?;
            let turn_id: String = row.get(1)?;
            let seq: i64 = row.get(2)?;
            let kind_str: String = row.get(3)?;
            let payload_json: String = row.get(4)?;
            let created_at: i64 = row.get(5)?;
            Ok((event_id, turn_id, seq, kind_str, payload_json, created_at))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (event_id, turn_id, seq, kind_str, payload_json, created_at) = row?;
            let kind = TurnEventKind::parse(&kind_str).ok_or_else(|| {
                TaskRuntimeError::Store(format!("unknown turn_event kind: {kind_str}"))
            })?;
            let payload: Value = serde_json::from_str(&payload_json)?;
            out.push(TurnEvent {
                event_id,
                turn_id,
                seq,
                kind,
                payload,
                created_at,
            });
        }
        Ok(out)
    }

    /// Allocates the next attempt and creates its first event in one immediate transaction.
    /// Event sequence 1 is therefore always `run_started`, or the run does not exist at all.
    pub fn create_agent_run(&self, run: &NewAgentRun) -> TaskRuntimeResult<AgentRun> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let attempt = tx.query_row(
            "SELECT COALESCE(MAX(attempt), 0) + 1 FROM agent_runs WHERE turn_id = ?1",
            params![run.turn_id],
            |row| row.get::<_, u32>(0),
        )?;
        tx.execute(
            "INSERT INTO agent_runs (
                run_id, turn_id, thread_id, user_id, workspace_id, attempt, status,
                role, model, provider, prompt_fingerprint, started_at, schema_version
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'running', ?7, ?8, ?9, ?10, ?11, 1)",
            params![
                run.run_id,
                run.turn_id,
                run.thread_id,
                run.user_id,
                run.workspace_id,
                attempt,
                run.role,
                run.model,
                run.provider,
                run.prompt_fingerprint,
                now,
            ],
        )?;
        tx.execute(
            "INSERT INTO agent_run_events (run_id, seq, round, kind, payload_json, created_at)
             VALUES (?1, 1, NULL, 'run_started', ?2, ?3)",
            params![
                run.run_id,
                serde_json::to_string(&serde_json::json!({
                    "attempt": attempt,
                    "schema_version": 1,
                }))?,
                now,
            ],
        )?;
        tx.commit()?;
        Ok(AgentRun {
            run_id: run.run_id.clone(),
            turn_id: run.turn_id.clone(),
            thread_id: run.thread_id.clone(),
            user_id: run.user_id.clone(),
            workspace_id: run.workspace_id.clone(),
            attempt,
            status: AgentRunStatus::Running,
            role: run.role.clone(),
            model: run.model.clone(),
            provider: run.provider.clone(),
            prompt_fingerprint: run.prompt_fingerprint.clone(),
            started_at: now,
            completed_at: None,
            terminal_reason: None,
            schema_version: 1,
        })
    }

    /// Fill attribution discovered after run creation, typically from the first
    /// prompt snapshot. Existing values win so retry/replay cannot rewrite a
    /// run's canonical model/provider record.
    pub fn backfill_agent_run_attribution(
        &self,
        run_id: &str,
        model: Option<&str>,
        provider: Option<&str>,
        prompt_fingerprint: Option<&str>,
    ) -> TaskRuntimeResult<usize> {
        let model = model
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let provider = provider
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let prompt_fingerprint = prompt_fingerprint
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        Ok(self.connection.execute(
            "UPDATE agent_runs
             SET model = CASE
                    WHEN (model IS NULL OR model = '') AND ?2 IS NOT NULL THEN ?2
                    ELSE model
                 END,
                 provider = CASE
                    WHEN (provider IS NULL OR provider = '') AND ?3 IS NOT NULL THEN ?3
                    ELSE provider
                 END,
                 prompt_fingerprint = CASE
                    WHEN (prompt_fingerprint IS NULL OR prompt_fingerprint = '') AND ?4 IS NOT NULL THEN ?4
                    ELSE prompt_fingerprint
                 END
             WHERE run_id = ?1
               AND (
                    ((model IS NULL OR model = '') AND ?2 IS NOT NULL)
                 OR ((provider IS NULL OR provider = '') AND ?3 IS NOT NULL)
                 OR ((prompt_fingerprint IS NULL OR prompt_fingerprint = '') AND ?4 IS NOT NULL)
               )",
            params![run_id, model, provider, prompt_fingerprint],
        )?)
    }

    pub fn append_agent_run_event(
        &self,
        run_id: &str,
        seq: i64,
        round: Option<i64>,
        kind: &str,
        payload: &Value,
    ) -> TaskRuntimeResult<AgentRunEvent> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let tx = self.connection.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO agent_run_events (run_id, seq, round, kind, payload_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                run_id,
                seq,
                round,
                kind,
                serde_json::to_string(payload)?,
                now
            ],
        )?;
        let event_id = tx.last_insert_rowid();
        if kind == "prompt_snapshot"
            && let Some(fingerprint) = payload.get("fingerprint").and_then(Value::as_str)
        {
            tx.execute(
                "UPDATE agent_runs SET prompt_fingerprint = ?2 WHERE run_id = ?1",
                params![run_id, fingerprint],
            )?;
        }
        tx.commit()?;
        Ok(AgentRunEvent {
            event_id,
            run_id: run_id.to_string(),
            seq,
            round,
            kind: kind.to_string(),
            payload: payload.clone(),
            created_at: now,
        })
    }

    pub fn finish_agent_run(
        &self,
        run_id: &str,
        status: AgentRunStatus,
        terminal_reason: Option<&str>,
    ) -> TaskRuntimeResult<()> {
        if status == AgentRunStatus::Running {
            return Err(TaskRuntimeError::Store(
                "finish_agent_run requires a terminal status".to_string(),
            ));
        }
        let changed = self.connection.execute(
            "UPDATE agent_runs
             SET status = ?2, completed_at = ?3, terminal_reason = ?4
             WHERE run_id = ?1 AND status = 'running'",
            params![
                run_id,
                status.as_str(),
                OffsetDateTime::now_utc().unix_timestamp(),
                terminal_reason,
            ],
        )?;
        if changed == 0 {
            return Err(TaskRuntimeError::Store(format!(
                "agent run is missing or already terminal: {run_id}"
            )));
        }
        Ok(())
    }

    pub fn list_agent_runs_for_turn(
        &self,
        turn_id: &str,
        user_id: &str,
        workspace_id: &str,
    ) -> TaskRuntimeResult<Vec<AgentRun>> {
        let mut stmt = self.connection.prepare(
            "SELECT run_id, turn_id, thread_id, user_id, workspace_id, attempt, status,
                    role, model, provider, prompt_fingerprint, started_at, completed_at,
                    terminal_reason, schema_version
             FROM agent_runs
             WHERE turn_id = ?1 AND user_id = ?2 AND workspace_id = ?3
             ORDER BY attempt ASC, started_at ASC",
        )?;
        let rows = stmt.query_map(params![turn_id, user_id, workspace_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, u32>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<String>>(10)?,
                row.get::<_, i64>(11)?,
                row.get::<_, Option<i64>>(12)?,
                row.get::<_, Option<String>>(13)?,
                row.get::<_, u32>(14)?,
            ))
        })?;
        let mut runs = Vec::new();
        for row in rows {
            let (
                run_id,
                turn_id,
                thread_id,
                user_id,
                workspace_id,
                attempt,
                status,
                role,
                model,
                provider,
                prompt_fingerprint,
                started_at,
                completed_at,
                terminal_reason,
                schema_version,
            ) = row?;
            runs.push(AgentRun {
                run_id,
                turn_id,
                thread_id,
                user_id,
                workspace_id,
                attempt,
                status: AgentRunStatus::parse(&status).ok_or_else(|| {
                    TaskRuntimeError::Store(format!("unknown agent run status: {status}"))
                })?,
                role,
                model,
                provider,
                prompt_fingerprint,
                started_at,
                completed_at,
                terminal_reason,
                schema_version,
            });
        }
        Ok(runs)
    }

    pub fn list_agent_runs_for_thread(
        &self,
        thread_id: &str,
        user_id: &str,
        workspace_id: &str,
    ) -> TaskRuntimeResult<Vec<AgentRun>> {
        let mut stmt = self.connection.prepare(
            "SELECT run_id, turn_id, thread_id, user_id, workspace_id, attempt, status,
                    role, model, provider, prompt_fingerprint, started_at, completed_at,
                    terminal_reason, schema_version
             FROM agent_runs
             WHERE thread_id = ?1 AND user_id = ?2 AND workspace_id = ?3
             ORDER BY started_at DESC, rowid DESC, attempt DESC",
        )?;
        let rows = stmt.query_map(params![thread_id, user_id, workspace_id], |row| {
            let status: String = row.get(6)?;
            Ok((
                AgentRun {
                    run_id: row.get(0)?,
                    turn_id: row.get(1)?,
                    thread_id: row.get(2)?,
                    user_id: row.get(3)?,
                    workspace_id: row.get(4)?,
                    attempt: row.get(5)?,
                    status: AgentRunStatus::parse(&status).unwrap_or(AgentRunStatus::Failed),
                    role: row.get(7)?,
                    model: row.get(8)?,
                    provider: row.get(9)?,
                    prompt_fingerprint: row.get(10)?,
                    started_at: row.get(11)?,
                    completed_at: row.get(12)?,
                    terminal_reason: row.get(13)?,
                    schema_version: row.get(14)?,
                },
                status,
            ))
        })?;
        let mut runs = Vec::new();
        for row in rows {
            let (run, status) = row?;
            if AgentRunStatus::parse(&status).is_none() {
                return Err(TaskRuntimeError::Store(format!(
                    "unknown agent run status: {status}"
                )));
            }
            runs.push(run);
        }
        Ok(runs)
    }

    pub fn has_agent_runs_for_thread(&self, thread_id: &str) -> TaskRuntimeResult<bool> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_runs WHERE thread_id = ?1)",
            params![thread_id],
            |row| row.get::<_, bool>(0),
        )?)
    }

    pub fn workspace_for_agent_run(
        &self,
        run_id: &str,
        user_id: &str,
    ) -> TaskRuntimeResult<Option<String>> {
        Ok(self
            .connection
            .query_row(
                "SELECT workspace_id FROM agent_runs WHERE run_id = ?1 AND user_id = ?2",
                params![run_id, user_id],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn latest_agent_checkpoint(
        &self,
        run_id: &str,
        user_id: &str,
        workspace_id: &str,
    ) -> TaskRuntimeResult<Option<AgentCheckpoint>> {
        self.connection
            .query_row(
                "SELECT c.checkpoint_id, c.run_id, c.turn_id, c.thread_id, c.user_id,
                    c.workspace_id, c.round, c.state_json, c.fingerprint,
                    c.resumable, c.created_at
             FROM agent_checkpoints c
             JOIN agent_runs r ON r.run_id = c.run_id
             WHERE c.run_id = ?1 AND r.user_id = ?2 AND r.workspace_id = ?3
             ORDER BY c.round DESC LIMIT 1",
                params![run_id, user_id, workspace_id],
                |row| {
                    let state_json: String = row.get(7)?;
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                        state_json,
                        row.get::<_, String>(8)?,
                        row.get::<_, i64>(9)?,
                        row.get::<_, i64>(10)?,
                    ))
                },
            )
            .optional()?
            .map(
                |(
                    checkpoint_id,
                    run_id,
                    turn_id,
                    thread_id,
                    user_id,
                    workspace_id,
                    round,
                    state_json,
                    fingerprint,
                    resumable,
                    created_at,
                )| {
                    Ok(AgentCheckpoint {
                        checkpoint_id,
                        run_id,
                        turn_id,
                        thread_id,
                        user_id,
                        workspace_id,
                        round: round as u32,
                        state_json: serde_json::from_str(&state_json)?,
                        fingerprint,
                        resumable: resumable != 0,
                        created_at,
                    })
                },
            )
            .transpose()
    }

    pub fn list_agent_run_events(
        &self,
        run_id: &str,
        user_id: &str,
        workspace_id: &str,
        since: Option<i64>,
    ) -> TaskRuntimeResult<Vec<AgentRunEvent>> {
        let mut stmt = self.connection.prepare(
            "SELECT e.event_id, e.run_id, e.seq, e.round, e.kind, e.payload_json, e.created_at
             FROM agent_run_events e
             JOIN agent_runs r ON r.run_id = e.run_id
             WHERE e.run_id = ?1 AND r.user_id = ?2 AND r.workspace_id = ?3 AND e.seq > ?4
             ORDER BY e.seq ASC",
        )?;
        let rows = stmt.query_map(
            params![run_id, user_id, workspace_id, since.unwrap_or(0)],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            },
        )?;
        let mut events = Vec::new();
        for row in rows {
            let (event_id, run_id, seq, round, kind, payload_json, created_at) = row?;
            events.push(AgentRunEvent {
                event_id,
                run_id,
                seq,
                round,
                kind,
                payload: serde_json::from_str(&payload_json)?,
                created_at,
            });
        }
        Ok(events)
    }

    pub fn latest_agent_prompt_snapshot(
        &self,
        run_id: &str,
        user_id: &str,
        workspace_id: &str,
    ) -> TaskRuntimeResult<Option<AgentRunEvent>> {
        let mut events = self.connection.prepare(
            "SELECT e.event_id, e.run_id, e.seq, e.round, e.kind, e.payload_json, e.created_at
             FROM agent_run_events e
             JOIN agent_runs r ON r.run_id = e.run_id
             WHERE e.run_id = ?1 AND r.user_id = ?2 AND r.workspace_id = ?3
               AND e.kind = 'prompt_snapshot'
             ORDER BY e.seq DESC LIMIT 1",
        )?;
        let row = events
            .query_row(params![run_id, user_id, workspace_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            })
            .optional()?;
        row.map(
            |(event_id, run_id, seq, round, kind, payload_json, created_at)| {
                Ok(AgentRunEvent {
                    event_id,
                    run_id,
                    seq,
                    round,
                    kind,
                    payload: serde_json::from_str(&payload_json)?,
                    created_at,
                })
            },
        )
        .transpose()
    }

    pub fn abort_running_agent_runs(&self, terminal_reason: &str) -> TaskRuntimeResult<usize> {
        Ok(self.connection.execute(
            "UPDATE agent_runs
             SET status = 'aborted', completed_at = ?1, terminal_reason = ?2
             WHERE status = 'running'",
            params![OffsetDateTime::now_utc().unix_timestamp(), terminal_reason],
        )?)
    }

    /// Abort only runs that have no canonical outcome waiting to be projected.
    /// A committed execution still owns its running journal until the projector
    /// converges the visible task/run/message state.
    pub fn abort_orphaned_running_agent_runs(
        &self,
        terminal_reason: &str,
    ) -> TaskRuntimeResult<usize> {
        Ok(self.connection.execute(
            "UPDATE agent_runs
             SET status = 'aborted', completed_at = ?1, terminal_reason = ?2
             WHERE status = 'running'
               AND NOT EXISTS (
                   SELECT 1 FROM executions
                   WHERE executions.execution_id = agent_runs.turn_id
                     AND executions.outcome_committed_at IS NOT NULL
               )",
            params![OffsetDateTime::now_utc().unix_timestamp(), terminal_reason],
        )?)
    }

    /// Abort stale running agent-run journals whose owning chat turn is already
    /// terminal. This is narrower than `abort_running_agent_runs`: it does not
    /// touch genuinely active work, but repairs read-model contradictions left
    /// behind when projection/tail paths reached terminal task state before the
    /// agent run row was finalized.
    pub fn abort_running_agent_runs_for_terminal_tasks(
        &self,
        terminal_reason: &str,
    ) -> TaskRuntimeResult<usize> {
        Ok(self.connection.execute(
            "UPDATE agent_runs
             SET status = 'aborted', completed_at = ?1, terminal_reason = ?2
             WHERE status = 'running'
               AND EXISTS (
                   SELECT 1 FROM tasks
                   WHERE tasks.task_id = agent_runs.turn_id
                     AND tasks.user_id = agent_runs.user_id
                     AND tasks.workspace_id = agent_runs.workspace_id
                     AND tasks.kind = 'chat_turn'
                     AND tasks.status IN ('completed', 'failed', 'cancelled', 'expired')
               )",
            params![OffsetDateTime::now_utc().unix_timestamp(), terminal_reason],
        )?)
    }

    pub fn abort_running_agent_runs_for_turn(
        &self,
        turn_id: &str,
        user_id: &str,
        workspace_id: &str,
        terminal_reason: &str,
    ) -> TaskRuntimeResult<usize> {
        Ok(self.connection.execute(
            "UPDATE agent_runs
             SET status = 'aborted', completed_at = ?1, terminal_reason = ?2
             WHERE turn_id = ?3 AND user_id = ?4 AND workspace_id = ?5 AND status = 'running'",
            params![
                OffsetDateTime::now_utc().unix_timestamp(),
                terminal_reason,
                turn_id,
                user_id,
                workspace_id,
            ],
        )?)
    }

    /// Parks a running chat turn at its finalization boundary: aborts the running
    /// agent run with `terminal_reason = "parked_waiting_for_model"` (preserving its
    /// resumable checkpoint intact — mirrors `abort_running_agent_runs_for_turn`'s
    /// gateway-restart abort, just with a different reason string) and flips the
    /// chat_turn task `running -> parked`. `Parked` is an active, non-terminal status
    /// the scheduler's `Queued|Pending` dispatch never picks up; only the coordinator's
    /// resume trigger (`unpark_chat_turn_to_queued`) moves it forward. Still-`pending`
    /// steering rows are untouched (left `pending` for the resumed run to interpret);
    /// any `claimed`-but-not-yet-`interpreted` row is released back to `pending` (see
    /// below — review I2). Idempotent: a no-op if the task is not currently `running`
    /// (already parked/terminal/gone).
    ///
    /// Releasing `claimed` rows (review I2, steering park+resume Build 2): the
    /// finalization fence only parks once its bounded wait finds nothing newly
    /// INTERPRETED (an interpreted row is drained/applied before park — see
    /// `agent_loop`'s fence), so the only steering states that can still be present
    /// at park time are `pending` (never claimed) or `claimed` (the coordinator
    /// claimed it under the run that's being aborted right now, but interpretation
    /// hadn't finished within the park budget). A `claimed` row left bound to the
    /// now-aborted run would (a) never appear in `list_due_pending_turn_steering`
    /// (pending-only — the coordinator would never re-probe it) and (b) permanently
    /// block `fence_chat_turn_finalization` (which counts `pending|claimed|interpreted`)
    /// on the RESUMED run too, since nothing can ever finish interpreting a claim bound
    /// to a dead run — re-parking at every fence forever. Releasing it back to
    /// `pending` here lets the resumed run's coordinator poll re-claim and interpret it
    /// normally, same as any other pending row.
    ///
    /// Releases the task's resource reservation (e.g. the single shared `BrowserSession`
    /// slot, `broker::chat_turn_resource_requirements`) and clears its lease, mirroring
    /// EVERY other "leave Running" transition in this codebase
    /// (`mark_task_waiting_external`/`mark_task_completed` in the gateway,
    /// `recover_chat_turns_at_boot` here) — a parked turn can wait for the model
    /// indefinitely, so without this it would hold the slot for the whole park, blocking
    /// every OTHER chat's browser use (the "stuck turn holds browser_session" class this
    /// project already fixed elsewhere). Resume (`unpark_chat_turn_to_queued` ->
    /// `Queued`) re-reserves through the normal dispatch path
    /// (`acquire_task_for_execution` -> `ResourceGovernor::reserve`), same as any other
    /// queued task.
    pub fn park_chat_turn(
        &self,
        turn_id: &str,
        user_id: &str,
        workspace_id: &str,
    ) -> TaskRuntimeResult<()> {
        self.abort_running_agent_runs_for_turn(
            turn_id,
            user_id,
            workspace_id,
            "parked_waiting_for_model",
        )?;

        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let task_json: Option<String> = tx
            .query_row(
                "SELECT task_json FROM tasks
                 WHERE task_id = ?1 AND user_id = ?2 AND workspace_id = ?3
                   AND kind = 'chat_turn' AND status = 'running'",
                params![turn_id, user_id, workspace_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(task_json) = task_json else {
            tx.commit()?;
            return Ok(());
        };
        // Keep the task_json blob's embedded status in sync with the status column —
        // unlike the SQL-only `finalizing` sentinel, `Parked` is a real TaskStatus
        // variant that `get_task`/`list_tasks` readers (dispatch, projections) rely on.
        let mut task: TaskRecord = serde_json::from_str(&task_json)?;
        // Same connection, still inside `tx`'s open transaction (rusqlite statements are
        // connection-scoped, not handle-scoped) — this DELETE commits/rolls back atomically
        // with the status flip below. `lease_owner`/`lease_expires_at`/`last_heartbeat_at`
        // have no dedicated SQL columns (they only live inside `task_json`, same as every
        // other TaskRecord field besides status/priority/kind/etc.), so clearing them on
        // the struct before re-serializing is sufficient — there is nothing else to null out.
        self.release_resources(&task)?;
        task.status = TaskStatus::Parked;
        task.clear_lease();
        task.updated_at = OffsetDateTime::now_utc();
        tx.execute(
            "UPDATE tasks SET status = ?1, updated_at = ?2, task_json = ?3
             WHERE task_id = ?4 AND user_id = ?5 AND workspace_id = ?6 AND status = 'running'",
            params![
                TaskStatus::Parked.as_str(),
                task.updated_at.unix_timestamp(),
                serde_json::to_string(&task)?,
                turn_id,
                user_id,
                workspace_id,
            ],
        )?;
        // Release any `claimed`-but-not-`interpreted` steering row back to `pending`
        // (review I2 — see the doc comment above): unbinds it from the run just
        // aborted so the due-scan (pending-only) and a resumed run's fresh claim can
        // both see it again, instead of parking forever on a claim nothing can ever
        // finish.
        tx.execute(
            "UPDATE turn_steering
             SET status = 'pending', claimed_run_id = NULL, claimed_round = NULL,
                 claimed_at = NULL, revision = revision + 1, updated_at = ?1
             WHERE user_id = ?2 AND workspace_id = ?3 AND active_turn_id = ?4
               AND status = 'claimed'",
            params![
                OffsetDateTime::now_utc().unix_timestamp(),
                user_id,
                workspace_id,
                turn_id,
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Flips a parked chat turn back to `queued` (the resume trigger): the normal
    /// scheduler re-dispatches it, and the resumed run reseeds from the park
    /// checkpoint via the now-widened `latest_resumable_checkpoint_for_turn`.
    /// Returns whether a parked row was actually flipped (`false` if the task
    /// wasn't `parked` — e.g. already resumed by a concurrent call, or cancelled).
    ///
    /// Also resets `interpretation_attempts`/backoff on the turn's still-`pending`
    /// steering (review C1 hardening, steering park+resume Build 2): that counter is
    /// SHARED by the parked-model-down probe's backoff and the coordinator's orphan
    /// budget (`MAX_ORPHAN_INTERPRETATION_ATTEMPTS` in `steering_control.rs`).
    /// Without this reset, attempts built up purely from waiting out a model outage
    /// would carry forward into the resumed turn — letting ordinary probe backoffs
    /// alone tip a resumed (and about-to-be-applied) steering into `held` the moment
    /// any later poll is misread as orphaned. A successful resume is a natural,
    /// deliberate point to zero the slate.
    pub fn unpark_chat_turn_to_queued(
        &self,
        turn_id: &str,
        user_id: &str,
        workspace_id: &str,
    ) -> TaskRuntimeResult<bool> {
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let task_json: Option<String> = tx
            .query_row(
                "SELECT task_json FROM tasks
                 WHERE task_id = ?1 AND user_id = ?2 AND workspace_id = ?3
                   AND kind = 'chat_turn' AND status = 'parked'",
                params![turn_id, user_id, workspace_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(task_json) = task_json else {
            tx.commit()?;
            return Ok(false);
        };
        let mut task: TaskRecord = serde_json::from_str(&task_json)?;
        task.status = TaskStatus::Queued;
        task.updated_at = OffsetDateTime::now_utc();
        let changed = tx.execute(
            "UPDATE tasks SET status = ?1, updated_at = ?2, task_json = ?3
             WHERE task_id = ?4 AND user_id = ?5 AND workspace_id = ?6 AND status = 'parked'",
            params![
                TaskStatus::Queued.as_str(),
                task.updated_at.unix_timestamp(),
                serde_json::to_string(&task)?,
                turn_id,
                user_id,
                workspace_id,
            ],
        )?;
        if changed == 1 {
            tx.execute(
                "UPDATE turn_steering
                 SET interpretation_attempts = 0, next_retry_at = NULL,
                     last_interpretation_error = NULL, revision = revision + 1, updated_at = ?1
                 WHERE user_id = ?2 AND workspace_id = ?3 AND active_turn_id = ?4
                   AND status = 'pending'",
                params![
                    OffsetDateTime::now_utc().unix_timestamp(),
                    user_id,
                    workspace_id,
                    turn_id,
                ],
            )?;
        }
        tx.commit()?;
        Ok(changed == 1)
    }

    /// Deletes every journal owned by one chat thread; event rows cascade with each run.
    pub fn purge_agent_runs_for_thread(
        &self,
        thread_id: &str,
        user_id: &str,
        workspace_id: &str,
    ) -> TaskRuntimeResult<usize> {
        Ok(self.connection.execute(
            "DELETE FROM agent_runs
             WHERE thread_id = ?1 AND user_id = ?2 AND workspace_id = ?3",
            params![thread_id, user_id, workspace_id],
        )?)
    }

    /// Deletes a bounded batch of old terminal runs; event rows cascade with their parent run.
    pub fn purge_terminal_agent_runs_before(
        &self,
        completed_before: i64,
        limit: usize,
    ) -> TaskRuntimeResult<usize> {
        if limit == 0 {
            return Ok(0);
        }
        Ok(self.connection.execute(
            "DELETE FROM agent_runs
             WHERE run_id IN (
                 SELECT run_id FROM agent_runs
                 WHERE status != 'running' AND completed_at IS NOT NULL AND completed_at < ?1
                 ORDER BY completed_at ASC
                 LIMIT ?2
             )",
            params![completed_before, limit as i64],
        )?)
    }

    /// Projects the durable per-turn log into the canonical Runtime V2 thread view.
    /// Activity accumulates across chat turns, while liveness, plan, browser,
    /// attention, capability runtime, and composer actions are owned by this one
    /// kernel projection.
    pub fn project_kernel_thread(
        &self,
        thread_id: &str,
        activity_cap: usize,
    ) -> TaskRuntimeResult<KernelThreadProjection> {
        let latest_turn: Option<(String, String, String, i64, Option<String>)> = self
            .connection
            .query_row(
                "SELECT task_id, status, task_json, updated_at, blocked_reason FROM tasks WHERE thread_id = ?1 AND kind = 'chat_turn'
                 ORDER BY created_at DESC LIMIT 1",
                params![thread_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()?;
        let latest_turn_id = latest_turn.as_ref().map(|(id, _, _, _, _)| id.clone());
        let latest_turn_record = latest_turn
            .as_ref()
            .and_then(|(_, _, task_json, _, _)| serde_json::from_str::<TaskRecord>(task_json).ok());
        let latest_runtime_plan = match latest_turn_record.as_ref() {
            Some(task) => load_runtime_plan_on(
                &self.connection,
                task.user_id.as_str(),
                task.workspace_id.as_str(),
                thread_id,
            )?,
            None => None,
        };
        let latest_turn_events = match latest_turn_id.as_deref() {
            Some(turn_id) => self.read_turn_events(turn_id, 0)?,
            None => Vec::new(),
        };
        let latest_uncertain_receipts = match latest_turn_record.as_ref() {
            Some(task) => self
                .list_effect_receipts_for_thread(
                    thread_id,
                    task.user_id.as_str(),
                    task.workspace_id.as_str(),
                )?
                .into_iter()
                .filter(|receipt| receipt.status == EffectReceiptStatus::Uncertain)
                .collect::<Vec<_>>(),
            None => Vec::new(),
        };
        let reducer_effects = latest_uncertain_receipts
            .iter()
            .map(|receipt| KernelEffectProjection {
                effect_class: receipt.effect_class.clone(),
                status: receipt.status,
            })
            .collect::<Vec<_>>();
        let terminal_reason = match (latest_turn_id.as_deref(), latest_turn_record.as_ref()) {
            (Some(turn_id), Some(task)) => self
                .list_agent_runs_for_turn(
                    turn_id,
                    task.user_id.as_str(),
                    task.workspace_id.as_str(),
                )?
                .into_iter()
                .rev()
                .find(|run| run.status != AgentRunStatus::Running)
                .and_then(|run| run.terminal_reason),
            _ => None,
        };
        let browser_checkpoint = match latest_turn_record.as_ref() {
            Some(task) => self.load_active_browser_checkpoint_for_thread(
                task.user_id.as_str(),
                task.workspace_id.as_str(),
                thread_id,
            )?,
            None => None,
        };
        let reduced = reduce_kernel_projection(KernelProjectionInput {
            turn_events: &latest_turn_events,
            runtime_plan: latest_runtime_plan.as_ref(),
            uncertain_effects: &reducer_effects,
            terminal_reason: terminal_reason.as_deref(),
        });
        let terminal_reason_for_projection = reduced.terminal_reason.clone();
        let pending_approvals = match (latest_turn_id.as_deref(), latest_turn_record.as_ref()) {
            (Some(turn_id), Some(task)) => {
                let mut stmt = self.connection.prepare(
                    "SELECT approval_json FROM task_approvals
                     WHERE task_id = ?1 AND user_id = ?2 AND workspace_id = ?3 AND status = 'pending'
                     ORDER BY created_at ASC, approval_id ASC",
                )?;
                let rows = stmt.query_map(
                    params![turn_id, task.user_id.as_str(), task.workspace_id.as_str()],
                    |row| row.get::<_, String>(0),
                )?;
                rows.map(|row| Ok(serde_json::from_str::<ApprovalRequest>(&row?)?))
                    .collect::<TaskRuntimeResult<Vec<_>>>()?
            }
            _ => Vec::new(),
        };
        let mut activity_stmt = self.connection.prepare(
            "SELECT te.payload_json, te.created_at
             FROM turn_events te JOIN tasks t ON t.task_id = te.turn_id
             WHERE t.thread_id = ?1 AND t.kind = 'chat_turn' AND te.kind = 'activity'
             ORDER BY t.created_at ASC, te.seq ASC",
        )?;
        let activity_rows = activity_stmt.query_map(params![thread_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        let mut activity = Vec::new();
        for row in activity_rows {
            let (payload_json, created_at) = row?;
            let payload: Value = serde_json::from_str(&payload_json)?;
            if let Some(text) = payload
                .get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .filter(|text| browser_budget_failure_reason(text).is_none())
            {
                activity.push(KernelActivityRow {
                    text: text.to_string(),
                    created_at,
                });
            }
        }
        if activity_cap > 0 && activity.len() > activity_cap {
            activity.drain(0..activity.len() - activity_cap);
        }
        let uncertain_effects = latest_uncertain_receipts
            .iter()
            .filter(|receipt| receipt.effect_class != EffectClass::Read)
            .map(|receipt| KernelUncertainEffectView {
                receipt_ref: receipt.receipt_ref.as_ref().to_string(),
                execution_id: receipt.execution_id.clone(),
                operation: receipt.operation.clone(),
                effect_class: effect_class_token(&receipt.effect_class).to_string(),
            })
            .collect::<Vec<_>>();
        let approvals = pending_approvals
            .iter()
            .map(|approval| {
                Ok(KernelApprovalView {
                    approval_id: approval.approval_id.clone(),
                    task_id: approval.task_id.as_str().to_string(),
                    action: approval.action.clone(),
                    risk_level: approval.risk_level.clone(),
                    data_boundary: approval.data_boundary.clone(),
                    explanation: approval.explanation.clone(),
                    status: enum_value(&approval.status)?,
                })
            })
            .collect::<TaskRuntimeResult<Vec<_>>>()?;
        let awaiting_user = reduced.requires_user_effect_resolution || !approvals.is_empty();
        let active_turn_id = latest_turn.as_ref().and_then(|(turn_id, status, _, _, _)| {
            if reduced.turn.is_terminal {
                return None;
            }
            if !crate::turn_lifecycle::status_has_active_turn_projection(status.as_str()) {
                return None;
            }
            Some(turn_id.clone())
        });
        let stored_turn_status = latest_turn
            .as_ref()
            .map(|(_, status, _, _, _)| status.as_str());
        let turn_status = if stored_turn_status == Some("finalizing") {
            "finalizing"
        } else {
            match reduced.turn.status {
                ReducedTurnStatus::Empty => stored_turn_status
                    .and_then(task_status_kernel_turn_token)
                    .unwrap_or("idle"),
                status => reduced_turn_status_token(status),
            }
        }
        .to_string();
        let composer_mode = if awaiting_user && active_turn_id.is_none() {
            "approval_only"
        } else if matches!(turn_status.as_str(), "waiting_user" | "waiting_approval") {
            "reply_to_user_wait"
        } else if active_turn_id.is_some() {
            "steer_active_turn"
        } else {
            "new_turn"
        }
        .to_string();
        let latest_updated_at = latest_turn
            .as_ref()
            .map(|(_, _, _, updated_at, _)| *updated_at)
            .unwrap_or(0);
        let plan = latest_runtime_plan
            .as_ref()
            .filter(|plan| plan.status == "open")
            .and_then(|plan| {
                kernel_plan_view(
                    plan,
                    reduced.turn.is_terminal,
                    terminal_reason_for_projection.as_deref(),
                )
            });
        let mut sub_stmt = self.connection.prepare(
            "SELECT kind, status, task_json, blocked_reason, created_at, updated_at FROM tasks
             WHERE thread_id = ?1 AND kind LIKE 'subagent.%'
             ORDER BY created_at ASC",
        )?;
        let subagents = sub_stmt
            .query_map(params![thread_id], |row| {
                let kind: String = row.get(0)?;
                let status: String = row.get(1)?;
                let task_json: String = row.get(2)?;
                let blocked_reason: Option<String> = row.get(3)?;
                let created_at: i64 = row.get(4)?;
                let updated_at: i64 = row.get(5)?;
                let goal = serde_json::from_str::<Value>(&task_json)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("goal")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .map(str::to_string)
                    })
                    .filter(|value| !value.is_empty());
                Ok(SubagentInfo {
                    name: subagent_name_from_kind(&kind),
                    status,
                    summary: blocked_reason.or(goal),
                    created_at,
                    updated_at,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let revision = plan
            .as_ref()
            .map(|plan| plan.revision)
            .unwrap_or_default()
            .max(reduced.turn.last_seq);
        let can_stop = latest_turn.as_ref().is_some_and(|_| {
            !reduced.turn.is_terminal
                && matches!(
                    composer_mode.as_str(),
                    "steer_active_turn" | "reply_to_user_wait"
                )
        });
        Ok(KernelThreadProjection {
            thread_id: thread_id.to_string(),
            revision,
            turn: KernelTurnView {
                active_turn_id,
                status: turn_status,
                last_event_seq: reduced.turn.last_seq,
                terminal_reason: reduced.terminal_reason,
                failure_text: reduced.turn.failure_text,
                updated_at: latest_updated_at,
            },
            plan,
            activity,
            subagents,
            browser: project_kernel_browser_view(
                &latest_turn_events,
                browser_checkpoint.as_ref(),
                terminal_reason_for_projection.as_deref(),
            ),
            capability_runtime: project_kernel_capability_runtime(&latest_turn_events),
            attention: KernelAttentionView {
                awaiting_user,
                approvals,
                uncertain_effects,
            },
            actions: KernelThreadActions {
                can_stop,
                composer_mode,
            },
        })
    }

    /// Projects the latest logical turn and terminal cursor for a chat thread.
    /// A terminal cursor is global (`event_id`), so the gateway can persist one
    /// monotonic seen watermark per thread across reloads and app restarts.
    pub fn thread_attention(&self, thread_id: &str) -> TaskRuntimeResult<ThreadAttention> {
        let latest_task: Option<(String, i64)> = self
            .connection
            .query_row(
                "SELECT status, updated_at
                   FROM tasks
                  WHERE thread_id = ?1 AND kind = 'chat_turn'
                  ORDER BY created_at DESC, task_id DESC
                  LIMIT 1",
                params![thread_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let latest_terminal_event_query = format!(
            "SELECT MAX(te.event_id)
               FROM turn_events te
               JOIN tasks t ON t.task_id = te.turn_id
              WHERE t.thread_id = ?1
                AND t.kind = 'chat_turn'
                AND te.kind IN ({})",
            REDUCED_TERMINAL_TURN_EVENT_KIND_SQL_LIST,
        );
        let latest_terminal_event_id =
            self.connection
                .query_row(&latest_terminal_event_query, params![thread_id], |row| {
                    row.get::<_, Option<i64>>(0)
                })?;
        let (status, updated_at) = latest_task.unwrap_or_else(|| ("idle".to_string(), 0));

        Ok(ThreadAttention {
            thread_id: thread_id.to_string(),
            status,
            latest_terminal_event_id,
            updated_at,
        })
    }

    /// Increments and persists the process_generation. Call ONCE at process startup,
    /// before any acquire. Uniquely identifies this incarnation of the process: leases
    /// written by previous generations are stale at boot recovery.
    pub fn bump_process_generation(&self) -> TaskRuntimeResult<u64> {
        // read-modify-write in a single explicit tx (atomicity on the meta row).
        let tx = self.connection.unchecked_transaction()?;
        let current: Option<String> = tx
            .query_row(
                "SELECT value FROM broker_meta WHERE key = 'process_generation'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let next: u64 = current
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0)
            .saturating_add(1);
        tx.execute(
            "INSERT INTO broker_meta (key, value) VALUES ('process_generation', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![next.to_string()],
        )?;
        tx.commit()?;
        Ok(next)
    }

    /// The currently-persisted generation (the last one that bumped).
    pub fn get_process_generation(&self) -> TaskRuntimeResult<u64> {
        let value: Option<String> = self
            .connection
            .query_row(
                "SELECT value FROM broker_meta WHERE key = 'process_generation'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        Ok(value.and_then(|s| s.parse::<u64>().ok()).unwrap_or(0))
    }

    fn next_checkpoint_sequence(
        &self,
        task_id: &TaskId,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> TaskRuntimeResult<u32> {
        let sequence: Option<i64> = self.connection.query_row(
            "
            SELECT MAX(sequence)
            FROM task_checkpoints
            WHERE task_id = ?1 AND user_id = ?2 AND workspace_id = ?3
            ",
            params![task_id.as_str(), user_id.as_str(), workspace_id.as_str()],
            |row| row.get(0),
        )?;
        Ok(sequence.unwrap_or_default() as u32 + 1)
    }

    pub fn insert_approval(&self, approval: &ApprovalRequest) -> TaskRuntimeResult<()> {
        self.connection.execute(
            "
            INSERT INTO task_approvals (
                approval_id,
                task_id,
                user_id,
                workspace_id,
                status,
                created_at,
                updated_at,
                approval_json
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ON CONFLICT(approval_id) DO UPDATE SET
                status = excluded.status,
                updated_at = excluded.updated_at,
                approval_json = excluded.approval_json
            ",
            params![
                approval.approval_id,
                approval.task_id.as_str(),
                approval.user_id.as_str(),
                approval.workspace_id.as_str(),
                enum_value(&approval.status)?,
                approval.created_at.unix_timestamp(),
                approval.updated_at.unix_timestamp(),
                serde_json::to_string(approval)?,
            ],
        )?;
        Ok(())
    }

    pub fn approval_by_id(&self, approval_id: &str) -> TaskRuntimeResult<Option<ApprovalRequest>> {
        self.connection
            .query_row(
                "SELECT approval_json FROM task_approvals WHERE approval_id = ?1",
                params![approval_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|json| Ok(serde_json::from_str::<ApprovalRequest>(&json)?))
            .transpose()
    }

    pub fn latest_approval(
        &self,
        task_id: &TaskId,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> TaskRuntimeResult<Option<ApprovalRequest>> {
        self.connection
            .query_row(
                "
                SELECT approval_json
                FROM task_approvals
                WHERE task_id = ?1 AND user_id = ?2 AND workspace_id = ?3
                ORDER BY created_at DESC, approval_id DESC
                LIMIT 1
                ",
                params![task_id.as_str(), user_id.as_str(), workspace_id.as_str()],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|json| Ok(serde_json::from_str::<ApprovalRequest>(&json)?))
            .transpose()
    }

    /// Returns the task_id of the active (queued/running) chat_turn for a thread, if any.
    /// Used by enqueue to enforce the 1-turn-per-thread constraint (409 if busy).
    /// Uses the partial index idx_tasks_chat_turn_thread.
    pub fn active_chat_turn_for_thread(
        &self,
        thread_id: &str,
    ) -> TaskRuntimeResult<Option<String>> {
        // An "active" turn is any non-terminal chat_turn: the 1-turn-per-thread
        // constraint must hold while a turn is queued, running, OR paused/waiting
        // (e.g. waiting_resource, waiting_external_event, waiting_user_approval).
        // Terminal states and the internal SQL-only finalizing boundary free the
        // thread for a new turn. Waiting/parked states must keep blocking, otherwise
        // a waiting_external_event turn could race a second turn on the transcript.
        let query = format!(
            "SELECT task_id FROM tasks
             WHERE thread_id = ?1 AND kind = 'chat_turn'
               AND status NOT IN ({})
             LIMIT 1",
            crate::turn_lifecycle::ACTIVE_CHAT_TURN_EXCLUDED_SQL_STATUSES,
        );
        let task_id: Option<String> = self
            .connection
            .query_row(&query, params![thread_id], |row| row.get(0))
            .optional()?;
        Ok(task_id)
    }

    /// Inserts a chat_turn populating the indexed columns (thread_id, request_id, source,
    /// approval). The task_json blob (managed by insert_task) remains the source of truth
    /// for non-indexed fields.
    pub fn insert_chat_turn(
        &self,
        task: &TaskRecord,
        thread_id: &str,
        request_id: &str,
        source: &str,
        approval: &str,
    ) -> TaskRuntimeResult<()> {
        // insert_task first (blob + base columns), then update the chat_turn columns
        self.insert_task(task)?;
        self.connection.execute(
            "UPDATE tasks SET thread_id = ?1, request_id = ?2, source = ?3, approval = ?4
             WHERE task_id = ?5 AND user_id = ?6 AND workspace_id = ?7",
            params![
                thread_id,
                request_id,
                source,
                approval,
                task.task_id.as_str(),
                task.user_id.as_str(),
                task.workspace_id.as_str(),
            ],
        )?;
        Ok(())
    }

    /// Runs a closure with a transaction handle. Use for cross-table atomic
    /// operations (e.g., broker enqueue that must also insert a chat_message in
    /// the same tx). The closure receives a `&Transaction` and can run arbitrary
    /// SQL. Commits on Ok, rolls back on Err.
    pub fn with_transaction<F, T>(&self, f: F) -> TaskRuntimeResult<T>
    where
        F: FnOnce(&rusqlite::Transaction<'_>) -> TaskRuntimeResult<T>,
    {
        let tx = self.connection.unchecked_transaction()?;
        let result = f(&tx)?;
        tx.commit()?;
        Ok(result)
    }
}

fn load_runtime_plan_on(
    conn: &Connection,
    user_id: &str,
    workspace_id: &str,
    thread_id: &str,
) -> TaskRuntimeResult<Option<RuntimePlanRecord>> {
    conn.query_row(
        "SELECT user_id, workspace_id, thread_id, status, plan_json, objective_revision,
                revision, stall_turns, last_resume_done, created_at, updated_at
         FROM runtime_plans
         WHERE user_id = ?1 AND workspace_id = ?2 AND thread_id = ?3",
        params![user_id, workspace_id, thread_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, Option<i64>>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, i64>(10)?,
            ))
        },
    )
    .optional()?
    .map(
        |(
            user_id,
            workspace_id,
            thread_id,
            status,
            plan_json,
            objective_revision,
            revision,
            stall_turns,
            last_resume_done,
            created_at,
            updated_at,
        )| {
            Ok(RuntimePlanRecord {
                user_id,
                workspace_id,
                thread_id,
                status,
                plan_json: serde_json::from_str(&plan_json)?,
                objective_revision: objective_revision as u64,
                revision: revision as u64,
                stall_turns: stall_turns as u32,
                last_resume_done: last_resume_done.map(|value| value as usize),
                created_at,
                updated_at,
            })
        },
    )
    .transpose()
}

fn load_objective_contract_on(
    conn: &Connection,
    user_id: &str,
    workspace_id: &str,
    thread_id: &str,
) -> TaskRuntimeResult<Option<ObjectiveContractRecord>> {
    conn.query_row(
        "SELECT user_id, workspace_id, thread_id, source_message_id, objective, mode,
                scope_json, allowed_actions_json, completion_json, status, revision,
                created_at, updated_at
         FROM objective_contracts
         WHERE user_id = ?1 AND workspace_id = ?2 AND thread_id = ?3",
        params![user_id, workspace_id, thread_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, i64>(10)?,
                row.get::<_, i64>(11)?,
                row.get::<_, i64>(12)?,
            ))
        },
    )
    .optional()?
    .map(
        |(
            user_id,
            workspace_id,
            thread_id,
            source_message_id,
            objective,
            mode,
            scope_json,
            allowed_actions_json,
            completion_json,
            status,
            revision,
            created_at,
            updated_at,
        )| {
            Ok(ObjectiveContractRecord {
                user_id,
                workspace_id,
                thread_id,
                source_message_id,
                objective,
                mode: serde_json::from_value(Value::String(mode))?,
                scope_json: serde_json::from_str(&scope_json)?,
                allowed_actions_json: serde_json::from_str(&allowed_actions_json)?,
                completion_json: serde_json::from_str(&completion_json)?,
                status,
                revision: revision as u64,
                created_at,
                updated_at,
            })
        },
    )
    .transpose()
}

fn map_browser_checkpoint_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<BrowserCheckpointRecord> {
    Ok(BrowserCheckpointRecord {
        checkpoint_id: row.get(0)?,
        user_id: row.get(1)?,
        workspace_id: row.get(2)?,
        thread_id: row.get(3)?,
        target_id: row.get(4)?,
        objective_revision: row.get::<_, i64>(5)? as u64,
        schema_version: row.get::<_, i64>(6)? as u32,
        url: row.get(7)?,
        origin: row.get(8)?,
        browser_epoch: row.get(9)?,
        cdp_target_id: row.get(10)?,
        generation: row.get::<_, i64>(11)? as u64,
        draft_secret_ref: row.get(12)?,
        draft_control_count: row.get::<_, i64>(13)? as u32,
        omitted_sensitive_count: row.get::<_, i64>(14)? as u32,
        omitted_bounded_count: row.get::<_, i64>(15)? as u32,
        expires_at: row.get(16)?,
        created_at: row.get(17)?,
        updated_at: row.get(18)?,
    })
}

fn map_turn_steering_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TurnSteeringRecord> {
    let content: String = row.get(6)?;
    let payload_json: String = row.get(7)?;
    let payload = serde_json::from_str::<NewTurnSteering>(&payload_json).unwrap_or_else(|_| {
        NewTurnSteering {
            source_message_id: row.get::<_, String>(5).unwrap_or_default(),
            prompt: content.clone(),
            visible_prompt: content.clone(),
            images: Vec::new(),
            attachments: Value::Array(Vec::new()),
            mode: None,
            model: None,
        }
    });
    let status_text: String = row.get(9)?;
    let status = status_text.parse::<TurnSteeringStatus>().map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            9,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
        )
    })?;
    Ok(TurnSteeringRecord {
        steering_id: row.get(0)?,
        user_id: row.get(1)?,
        workspace_id: row.get(2)?,
        thread_id: row.get(3)?,
        active_turn_id: row.get(4)?,
        source_message_id: payload.source_message_id,
        content,
        prompt: payload.prompt,
        visible_prompt: payload.visible_prompt,
        images: payload.images,
        attachments: payload.attachments,
        mode: payload.mode,
        model: payload.model,
        objective_revision: row.get::<_, i64>(8)? as u64,
        status,
        revision: row.get::<_, i64>(10)? as u64,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        claimed_run_id: row.get(13)?,
        claimed_round: row.get::<_, Option<i64>>(14)?.map(|value| value as u32),
        claimed_at: row.get(15)?,
        applied_at: row.get(16)?,
        cancelled_at: row.get(17)?,
        consumed_at: row.get(18)?,
        semantic_decision_json: row
            .get::<_, Option<String>>(19)?
            .and_then(|raw| serde_json::from_str(&raw).ok()),
        interpreted_at: row.get(20)?,
        completed_at: row.get(21)?,
        last_interpretation_error: row.get(22)?,
        next_retry_at: row.get(23)?,
        interpretation_attempts: row.get::<_, i64>(24)? as u32,
    })
}

pub(crate) fn load_turn_steering_by_source_message(
    conn: &Connection,
    user_id: &str,
    workspace_id: &str,
    thread_id: &str,
    source_message_id: &str,
) -> TaskRuntimeResult<Option<TurnSteeringRecord>> {
    conn.query_row(
        "SELECT steering_id, user_id, workspace_id, thread_id, active_turn_id,
                source_message_id, content, payload_json, objective_revision, status,
                revision, created_at, updated_at, claimed_run_id, claimed_round,
                claimed_at, applied_at, cancelled_at, consumed_at,
                semantic_decision_json, interpreted_at, completed_at,
                last_interpretation_error, next_retry_at, interpretation_attempts
         FROM turn_steering
         WHERE user_id = ?1 AND workspace_id = ?2 AND thread_id = ?3 AND source_message_id = ?4",
        params![user_id, workspace_id, thread_id, source_message_id],
        map_turn_steering_row,
    )
    .optional()
    .map_err(Into::into)
}

fn load_turn_steering_by_id_on(
    conn: &Connection,
    steering_id: i64,
    user_id: &str,
    workspace_id: &str,
) -> TaskRuntimeResult<Option<TurnSteeringRecord>> {
    conn.query_row(
        "SELECT steering_id, user_id, workspace_id, thread_id, active_turn_id,
                source_message_id, content, payload_json, objective_revision, status,
                revision, created_at, updated_at, claimed_run_id, claimed_round,
                claimed_at, applied_at, cancelled_at, consumed_at,
                semantic_decision_json, interpreted_at, completed_at,
                last_interpretation_error, next_retry_at, interpretation_attempts
         FROM turn_steering WHERE steering_id=?1 AND user_id=?2 AND workspace_id=?3",
        params![steering_id, user_id, workspace_id],
        map_turn_steering_row,
    )
    .optional()
    .map_err(Into::into)
}

fn load_turn_steering_unscoped_by_id(
    conn: &Connection,
    steering_id: i64,
) -> TaskRuntimeResult<Option<TurnSteeringRecord>> {
    conn.query_row(
        "SELECT steering_id, user_id, workspace_id, thread_id, active_turn_id,
                source_message_id, content, payload_json, objective_revision, status,
                revision, created_at, updated_at, claimed_run_id, claimed_round,
                claimed_at, applied_at, cancelled_at, consumed_at,
                semantic_decision_json, interpreted_at, completed_at,
                last_interpretation_error, next_retry_at, interpretation_attempts
         FROM turn_steering WHERE steering_id=?1",
        params![steering_id],
        map_turn_steering_row,
    )
    .optional()
    .map_err(Into::into)
}

fn map_effect_receipt_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExecutionEffectReceipt> {
    let raw_ref: String = row.get(0)?;
    let raw_effect_class: String = row.get(8)?;
    let raw_status: String = row.get(11)?;
    let result_json: Option<String> = row.get(12)?;
    let effects_json: Option<String> = row.get(13)?;
    let error_json: Option<String> = row.get(14)?;
    let compensation_json: Option<String> = row.get(15)?;
    Ok(ExecutionEffectReceipt {
        receipt_ref: EffectReceiptRef::parse(raw_ref)
            .map_err(|error| invalid_receipt_column(0, error.to_string()))?,
        execution_id: row.get(1)?,
        revision: u64::try_from(row.get::<_, i64>(2)?)
            .map_err(|error| invalid_receipt_column(2, error.to_string()))?,
        idempotency_key: row.get(3)?,
        run_id: row.get(4)?,
        thread_id: row.get(5)?,
        user_id: row.get(6)?,
        workspace_id: row.get(7)?,
        effect_class: parse_effect_class(&raw_effect_class)
            .ok_or_else(|| invalid_receipt_column(8, "unknown effect class"))?,
        operation: row.get(9)?,
        arguments_hash: row.get(10)?,
        status: parse_effect_receipt_status(&raw_status)
            .ok_or_else(|| invalid_receipt_column(11, "unknown effect receipt status"))?,
        result_json: result_json.and_then(|raw| serde_json::from_str(&raw).ok()),
        effects_json: effects_json.and_then(|raw| serde_json::from_str(&raw).ok()),
        error_json: error_json.and_then(|raw| serde_json::from_str(&raw).ok()),
        compensation: compensation_json.and_then(|raw| serde_json::from_str(&raw).ok()),
        prepared_at: row.get(16)?,
        started_at: row.get(17)?,
        resolved_at: row.get(18)?,
    })
}

fn prepare_effect_receipt_on(
    connection: &Connection,
    new_receipt: &NewExecutionEffectReceipt,
) -> TaskRuntimeResult<ExecutionEffectReceipt> {
    if new_receipt.revision == 0
        || new_receipt.execution_id.trim().is_empty()
        || new_receipt.operation.trim().is_empty()
        || new_receipt.arguments_hash.trim().is_empty()
        || new_receipt.idempotency_key.trim().is_empty()
    {
        return Err(TaskRuntimeError::Store(
            "effect receipt identity and operation fields must be nonempty".into(),
        ));
    }
    let now = OffsetDateTime::now_utc().unix_timestamp();
    connection.execute(
        "INSERT OR IGNORE INTO execution_effect_receipts (
            receipt_ref, execution_id, revision, idempotency_key, run_id, thread_id,
            user_id, workspace_id, effect_class, operation, arguments_hash, status,
            compensation_json, prepared_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'prepared', ?12, ?13)",
        params![
            new_receipt.receipt_ref.as_ref(),
            new_receipt.execution_id,
            i64::try_from(new_receipt.revision).map_err(|_| {
                TaskRuntimeError::Store("effect receipt revision is out of range".into())
            })?,
            new_receipt.idempotency_key,
            new_receipt.run_id,
            new_receipt.thread_id,
            new_receipt.user_id,
            new_receipt.workspace_id,
            effect_class_str(&new_receipt.effect_class),
            new_receipt.operation,
            new_receipt.arguments_hash,
            new_receipt
                .compensation
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?,
            now,
        ],
    )?;
    let receipt =
        load_effect_receipt_on(connection, &new_receipt.receipt_ref)?.ok_or_else(|| {
            TaskRuntimeError::Store("effect receipt disappeared after prepare".into())
        })?;
    if receipt.execution_id != new_receipt.execution_id
        || receipt.revision != new_receipt.revision
        || receipt.idempotency_key != new_receipt.idempotency_key
        || receipt.effect_class != new_receipt.effect_class
        || receipt.operation != new_receipt.operation
        || receipt.arguments_hash != new_receipt.arguments_hash
        || receipt.user_id != new_receipt.user_id
        || receipt.workspace_id != new_receipt.workspace_id
    {
        return Err(TaskRuntimeError::Store(
            "effect receipt reference or idempotency key conflicts with existing scope".into(),
        ));
    }
    Ok(receipt)
}

fn claim_effect_receipt_on(
    connection: &Connection,
    receipt_ref: &EffectReceiptRef,
) -> TaskRuntimeResult<EffectReceiptClaim> {
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let receipt = load_effect_receipt_on(connection, receipt_ref)?
        .ok_or_else(|| TaskRuntimeError::NotFound(receipt_ref.as_ref().to_string()))?;
    match receipt.status {
        EffectReceiptStatus::Prepared => {
            let changed = connection.execute(
                "UPDATE execution_effect_receipts
                 SET status = 'started', started_at = ?1, result_json = NULL,
                     effects_json = NULL, error_json = NULL, resolved_at = NULL
                 WHERE receipt_ref = ?2 AND status = 'prepared'",
                params![now, receipt_ref.as_ref()],
            )?;
            if changed != 1 {
                return Err(TaskRuntimeError::Store(
                    "effect receipt was claimed concurrently".into(),
                ));
            }
            Ok(EffectReceiptClaim::Execute(
                load_effect_receipt_on(connection, receipt_ref)?.ok_or_else(|| {
                    TaskRuntimeError::Store("claimed effect receipt disappeared".into())
                })?,
            ))
        }
        EffectReceiptStatus::Started => {
            connection.execute(
                "UPDATE execution_effect_receipts SET status = 'uncertain'
                 WHERE receipt_ref = ?1 AND status = 'started'",
                params![receipt_ref.as_ref()],
            )?;
            Ok(EffectReceiptClaim::Resolve(
                load_effect_receipt_on(connection, receipt_ref)?.ok_or_else(|| {
                    TaskRuntimeError::Store("uncertain effect receipt disappeared".into())
                })?,
            ))
        }
        EffectReceiptStatus::Completed | EffectReceiptStatus::Compensated => {
            Ok(EffectReceiptClaim::Replay(receipt))
        }
        EffectReceiptStatus::Failed | EffectReceiptStatus::Uncertain => {
            Ok(EffectReceiptClaim::Resolve(receipt))
        }
    }
}

fn claim_existing_non_executable_receipt_on(
    connection: &Connection,
    receipt_ref: &EffectReceiptRef,
) -> TaskRuntimeResult<Option<EffectReceiptClaim>> {
    let Some(receipt) = load_effect_receipt_on(connection, receipt_ref)? else {
        return Ok(None);
    };
    if receipt.status == EffectReceiptStatus::Prepared {
        return Ok(None);
    }
    claim_effect_receipt_on(connection, receipt_ref).map(Some)
}

pub(crate) fn load_effect_receipt_on(
    conn: &Connection,
    receipt_ref: &EffectReceiptRef,
) -> TaskRuntimeResult<Option<ExecutionEffectReceipt>> {
    Ok(conn
        .query_row(
            "SELECT receipt_ref, execution_id, revision, idempotency_key, run_id, thread_id,
                    user_id, workspace_id, effect_class, operation, arguments_hash, status,
                    result_json, effects_json, error_json, compensation_json,
                    prepared_at, started_at, resolved_at
             FROM execution_effect_receipts WHERE receipt_ref = ?1",
            params![receipt_ref.as_ref()],
            map_effect_receipt_row,
        )
        .optional()?)
}

impl TaskStore {
    pub fn audit_runtime_integrity(&self) -> TaskRuntimeResult<RuntimeIntegrityReport> {
        let mut findings = Vec::new();

        let mut stmt = self.connection.prepare(
            "SELECT t.task_id, t.status, r.run_id
             FROM tasks t
             JOIN agent_runs r ON r.turn_id = t.task_id
             WHERE t.status IN ('completed', 'failed', 'cancelled', 'expired')
               AND r.status = 'running'
             ORDER BY t.updated_at DESC, r.started_at DESC
             LIMIT 100",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (task_id, task_status, run_id) = row?;
            findings.push(runtime_integrity_finding(
                "chat_runtime",
                "terminal_task_with_running_agent_run",
                "error",
                "agent_run_projection",
                format!("terminal task {task_id} is {task_status} but agent run is still running"),
                Some(run_id),
            ));
        }

        let mut stmt = self.connection.prepare(
            "SELECT r.run_id
             FROM agent_runs r
             LEFT JOIN tasks t ON t.task_id = r.turn_id
             WHERE r.status = 'running'
               AND (t.task_id IS NULL OR t.status NOT IN (
                 'queued', 'pending', 'running', 'waiting_time',
                 'waiting_external_event', 'waiting_user_approval',
                 'waiting_resource', 'paused', 'parked'
               ))
             ORDER BY r.started_at DESC
             LIMIT 100",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        for run_id in rows {
            findings.push(runtime_integrity_finding(
                "chat_runtime",
                "running_agent_run_without_active_task",
                "error",
                "agent_run_projection",
                "running agent run has no matching active task",
                Some(run_id?),
            ));
        }

        if table_exists(&self.connection, "chat_messages")
            && column_exists(&self.connection, "chat_messages", "delivery_state")
        {
            let mut stmt = self.connection.prepare(
                "SELECT m.id, m.delivery_state
                 FROM chat_messages m
                 LEFT JOIN agent_runs r
                   ON r.turn_id = m.linked_task_id AND r.status = 'running'
                 WHERE m.role = 'assistant'
                   AND m.delivery_state IN ('streaming', 'retrying')
                   AND COALESCE(m.linked_task_id, '') <> ''
                   AND r.run_id IS NULL
                 ORDER BY m.timestamp DESC
                 LIMIT 100",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (message_id, delivery_state) = row?;
                findings.push(runtime_integrity_finding(
                    "chat_runtime",
                    "streaming_assistant_without_active_run",
                    "error",
                    "message_delivery_projection",
                    format!(
                        "assistant message remains {delivery_state} without an active agent run"
                    ),
                    Some(message_id),
                ));
            }
        }

        let mut stmt = self.connection.prepare(
            "SELECT t.task_id
             FROM tasks t
             JOIN turn_events e ON e.turn_id = t.task_id
             WHERE t.status = 'completed'
               AND e.payload_json LIKE '%browser_budget_exceeded%'
             GROUP BY t.task_id
             ORDER BY MAX(e.created_at) DESC
             LIMIT 100",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        for task_id in rows {
            findings.push(runtime_integrity_finding(
                "browser",
                "completed_task_with_browser_budget_exceeded",
                "error",
                "browser_outcome_projection",
                "completed task contains a browser budget exhaustion event",
                Some(task_id?),
            ));
        }

        let waiting_approval_sql = if table_exists(&self.connection, "thread_hitl_waits") {
            "SELECT t.task_id
             FROM tasks t
             WHERE t.status = 'waiting_user_approval'
               AND NOT EXISTS (
                 SELECT 1 FROM task_approvals a
                 WHERE a.task_id = t.task_id
                   AND a.user_id = t.user_id
                   AND a.workspace_id = t.workspace_id
                   AND a.status = 'pending'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM thread_hitl_waits h
                 WHERE h.thread_id = t.thread_id
                   AND h.status = 'open'
               )
             ORDER BY t.updated_at DESC
             LIMIT 100"
        } else {
            "SELECT t.task_id
             FROM tasks t
             WHERE t.status = 'waiting_user_approval'
               AND NOT EXISTS (
                 SELECT 1 FROM task_approvals a
                 WHERE a.task_id = t.task_id
                   AND a.user_id = t.user_id
                   AND a.workspace_id = t.workspace_id
                   AND a.status = 'pending'
               )
             ORDER BY t.updated_at DESC
             LIMIT 100"
        };
        let mut stmt = self.connection.prepare(waiting_approval_sql)?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        for task_id in rows {
            findings.push(runtime_integrity_finding(
                "chat_runtime",
                "waiting_approval_task_without_canonical_approval",
                "error",
                "approval_projection",
                "task waits for user approval but no canonical pending approval or open HITL wait is visible",
                Some(task_id?),
            ));
        }

        Ok(runtime_integrity_report(findings))
    }
}

fn runtime_integrity_finding(
    domain: impl Into<String>,
    code: impl Into<String>,
    severity: impl Into<String>,
    owner: impl Into<String>,
    summary: impl Into<String>,
    ref_id: Option<String>,
) -> RuntimeIntegrityFinding {
    RuntimeIntegrityFinding {
        domain: domain.into(),
        code: code.into(),
        severity: severity.into(),
        owner: owner.into(),
        summary: summary.into(),
        ref_id,
    }
}

fn runtime_integrity_report(mut findings: Vec<RuntimeIntegrityFinding>) -> RuntimeIntegrityReport {
    findings.sort_by(|left, right| {
        (
            left.severity.as_str() != "error",
            left.domain.as_str(),
            left.code.as_str(),
            left.ref_id.as_deref().unwrap_or_default(),
        )
            .cmp(&(
                right.severity.as_str() != "error",
                right.domain.as_str(),
                right.code.as_str(),
                right.ref_id.as_deref().unwrap_or_default(),
            ))
    });
    let mut finding_counts = BTreeMap::new();
    let mut error_count = 0;
    let mut warning_count = 0;
    for finding in &findings {
        *finding_counts.entry(finding.code.clone()).or_insert(0) += 1;
        if finding.severity == "error" {
            error_count += 1;
        } else {
            warning_count += 1;
        }
    }
    RuntimeIntegrityReport {
        integrity_ok: error_count == 0,
        total_findings: findings.len() as u64,
        error_count,
        warning_count,
        finding_counts,
        findings,
    }
}

fn invalid_receipt_column(index: usize, message: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        index,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            message.into(),
        )),
    )
}

fn effect_class_str(effect_class: &EffectClass) -> &'static str {
    match effect_class {
        EffectClass::Read => "read",
        EffectClass::FilesystemWrite => "filesystem_write",
        EffectClass::ArtifactCreation => "artifact_creation",
        EffectClass::ExternalWrite => "external_write",
        EffectClass::RequestAuthorization => "request_authorization",
    }
}

fn parse_effect_class(value: &str) -> Option<EffectClass> {
    match value {
        "read" => Some(EffectClass::Read),
        "filesystem_write" => Some(EffectClass::FilesystemWrite),
        "artifact_creation" => Some(EffectClass::ArtifactCreation),
        "external_write" => Some(EffectClass::ExternalWrite),
        "request_authorization" => Some(EffectClass::RequestAuthorization),
        _ => None,
    }
}

fn parse_effect_receipt_status(value: &str) -> Option<EffectReceiptStatus> {
    match value {
        "prepared" => Some(EffectReceiptStatus::Prepared),
        "started" => Some(EffectReceiptStatus::Started),
        "completed" => Some(EffectReceiptStatus::Completed),
        "failed" => Some(EffectReceiptStatus::Failed),
        "uncertain" => Some(EffectReceiptStatus::Uncertain),
        "compensated" => Some(EffectReceiptStatus::Compensated),
        _ => None,
    }
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> bool {
    let Ok(mut stmt) = conn.prepare(&format!("PRAGMA table_info({table})")) else {
        return false;
    };
    let names = stmt.query_map([], |row| row.get::<_, String>(1));
    match names {
        Ok(iter) => iter.filter_map(Result::ok).any(|name| name == column),
        Err(_) => false,
    }
}

fn migrate_effect_receipts_v14(connection: &Connection) -> TaskRuntimeResult<()> {
    if !table_exists(connection, "agent_tool_receipts") {
        return Ok(());
    }
    let tx = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
    tx.execute(
        "INSERT OR IGNORE INTO execution_effect_receipts (
            receipt_ref, execution_id, revision, idempotency_key, run_id, thread_id,
            user_id, workspace_id, effect_class, operation, arguments_hash, status,
            result_json, effects_json, prepared_at, started_at, resolved_at
         )
         SELECT
            'effect:v1:32:' || printf('%032x', rowid),
            turn_id,
            COALESCE((SELECT revision FROM executions WHERE execution_id = turn_id), 1),
            idempotency_key,
            run_id,
            thread_id,
            user_id,
            workspace_id,
            CASE
                WHEN tool_name LIKE '%write_project_file%' OR tool_name LIKE '%filesystem%'
                    THEN 'filesystem_write'
                WHEN tool_name LIKE '%make_deck%' OR tool_name LIKE '%make_document%'
                    THEN 'artifact_creation'
                ELSE 'external_write'
            END,
            tool_name,
            arguments_hash,
            CASE WHEN status = 'completed' THEN 'completed' ELSE 'uncertain' END,
            result_json,
            effects_json,
            started_at,
            started_at,
            completed_at
         FROM agent_tool_receipts",
        [],
    )?;
    tx.execute_batch(
        "DROP INDEX IF EXISTS idx_agent_tool_receipts_scope;
         DROP TABLE agent_tool_receipts;",
    )?;
    tx.commit()?;
    Ok(())
}

fn migrate_effect_compensations_v15(connection: &Connection) -> TaskRuntimeResult<()> {
    connection.execute(
        "INSERT INTO task_runtime_metadata(key, value) VALUES ('schema_version', '15')
         ON CONFLICT(key) DO UPDATE SET value = '15'",
        [],
    )?;
    Ok(())
}

fn table_exists(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        rusqlite::params![table],
        |_| Ok(()),
    )
    .is_ok()
}

fn index_exists(conn: &Connection, index_name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1",
        rusqlite::params![index_name],
        |_| Ok(()),
    )
    .is_ok()
}

fn enum_value<T: serde::Serialize>(value: &T) -> TaskRuntimeResult<String> {
    serde_json::to_value(value)?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| TaskRuntimeError::Store("enum did not serialize to string".to_string()))
}

#[cfg(test)]
mod migration_tests {
    use super::*;

    #[test]
    fn migrations_run_idempotently_with_chat_turn_cols() {
        let store = TaskStore::open_in_memory().expect("open");
        // Columns exist after the first migration.
        for col in ["thread_id", "request_id", "source", "approval"] {
            assert!(
                column_exists(&store.connection, "tasks", col),
                "missing col {col}"
            );
        }
        // Re-running migrations must not panic (guarded ALTER).
        store.run_migrations().expect("idempotent re-run");
        assert_eq!(store.schema_version().unwrap(), 15);
        assert!(table_exists(&store.connection, "agent_runs"));
        assert!(table_exists(&store.connection, "agent_run_events"));
        assert!(table_exists(&store.connection, "runtime_plans"));
        assert!(table_exists(&store.connection, "agent_checkpoints"));
        assert!(table_exists(&store.connection, "execution_effect_receipts"));
        assert!(!table_exists(&store.connection, "agent_tool_receipts"));
        assert!(table_exists(&store.connection, "objective_contracts"));
        assert!(table_exists(&store.connection, "turn_steering"));
        assert!(table_exists(&store.connection, "executions"));
        assert!(table_exists(&store.connection, "execution_events"));
        assert!(table_exists(&store.connection, "execution_wakes"));
    }

    #[test]
    fn agent_run_role_migrates_old_rows_as_unknown() {
        let database = std::env::temp_dir().join(format!(
            "homun-agent-run-role-migration-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        {
            let connection = Connection::open(&database).expect("open pre-role database");
            connection
                .execute_batch(
                    "CREATE TABLE agent_runs (
                        run_id TEXT PRIMARY KEY,
                        turn_id TEXT NOT NULL,
                        thread_id TEXT NOT NULL,
                        user_id TEXT NOT NULL,
                        workspace_id TEXT NOT NULL,
                        attempt INTEGER NOT NULL,
                        status TEXT NOT NULL,
                        model TEXT,
                        provider TEXT,
                        prompt_fingerprint TEXT,
                        started_at INTEGER NOT NULL,
                        completed_at INTEGER,
                        terminal_reason TEXT,
                        schema_version INTEGER NOT NULL DEFAULT 1,
                        UNIQUE(turn_id, attempt)
                    );
                    INSERT INTO agent_runs (
                        run_id, turn_id, thread_id, user_id, workspace_id, attempt, status,
                        model, provider, prompt_fingerprint, started_at, schema_version
                    ) VALUES (
                        'old-run', 'old-turn', 'old-thread', 'user', 'workspace', 1, 'completed',
                        NULL, NULL, NULL, 1, 1
                    );",
                )
                .expect("seed pre-role schema");
        }

        let store = TaskStore::open(&database).expect("migrate pre-role database");
        store.run_migrations().expect("idempotent role migration");
        let runs = store
            .list_agent_runs_for_thread("old-thread", "user", "workspace")
            .expect("read migrated run");

        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].role, None);
        assert!(column_exists(&store.connection, "agent_runs", "role"));
        drop(store);
        let _ = std::fs::remove_file(database);
    }

    #[test]
    fn chat_turn_index_exists() {
        let store = TaskStore::open_in_memory().expect("open");
        assert!(index_exists(
            &store.connection,
            "idx_tasks_chat_turn_thread"
        ));
    }
}

#[cfg(test)]
mod runtime_plan_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn objective_contract_is_created_and_replaced_in_place() {
        let store = TaskStore::open_in_memory().unwrap();
        let first = store
            .upsert_objective_contract(
                "u",
                "w",
                "t",
                "message-1",
                "Analyze the project without changing it",
                ObjectiveMode::ReadOnlyAnalysis,
                &json!({"roots": ["/project"]}),
                &json!(["read", "search"]),
                &json!({"kind": "report"}),
                "active",
            )
            .unwrap();
        let second = store
            .upsert_objective_contract(
                "u",
                "w",
                "t",
                "message-2",
                "Analyze the project and include memory diagnostics",
                ObjectiveMode::ReadOnlyAnalysis,
                &json!({"roots": ["/project"]}),
                &json!(["read", "search"]),
                &json!({"kind": "report", "memory_status": true}),
                "active",
            )
            .unwrap();

        assert_eq!((first.revision, second.revision), (1, 2));
        assert_eq!(second.source_message_id, "message-2");
        assert_eq!(second.mode, ObjectiveMode::ReadOnlyAnalysis);
        assert_eq!(
            store
                .load_objective_contract("u", "w", "t")
                .unwrap()
                .unwrap(),
            second
        );
        assert!(
            store
                .load_objective_contract("u", "other", "t")
                .unwrap()
                .is_none()
        );
    }

    /// Review I1 regression: a resumed chat_turn re-derives its objective from a
    /// fresh model call (`execute_chat_turn_task` calls `upsert_objective_contract`
    /// on every dispatch, resume included). An unconditional `revision + 1` on that
    /// re-derivation desyncs the resumed run's revision from whatever a pending
    /// steering row was stamped with, forcing it into `NeedsClarification`. Same
    /// `objective` + `mode` must be a no-op on the revision counter even when the
    /// surrounding scope/allowed_actions/completion differ (as they realistically do —
    /// scope_json embeds the raw semantic decision, including volatile
    /// confidence/rationale text that is never byte-identical across two model calls).
    #[test]
    fn upsert_objective_contract_is_idempotent_on_unchanged_objective_and_mode() {
        let store = TaskStore::open_in_memory().unwrap();
        let first = store
            .upsert_objective_contract(
                "u",
                "w",
                "t",
                "message-1",
                "Investigate the failing test and report findings",
                ObjectiveMode::ReadOnlyAnalysis,
                &json!({"resources": ["project"], "semantic_decision": {"confidence": 0.91, "rationale": "first pass"}}),
                &json!(["read"]),
                &json!({"kind": "report"}),
                "active",
            )
            .unwrap();

        // Re-derived (e.g. a resume's fresh model call): SAME objective + mode, but a
        // DIFFERENT scope_json (different confidence/rationale) and source_message_id.
        let second = store
            .upsert_objective_contract(
                "u",
                "w",
                "t",
                "message-2",
                "Investigate the failing test and report findings",
                ObjectiveMode::ReadOnlyAnalysis,
                &json!({"resources": ["project"], "semantic_decision": {"confidence": 0.87, "rationale": "second pass, slightly different wording"}}),
                &json!(["read"]),
                &json!({"kind": "report"}),
                "active",
            )
            .unwrap();

        assert_eq!(
            first.revision, second.revision,
            "unchanged objective/mode must not bump revision"
        );
        assert_eq!(
            second.source_message_id, "message-2",
            "provenance still updates"
        );
        assert_eq!(
            second.scope_json["semantic_decision"]["confidence"], 0.87,
            "other fields still update"
        );

        // A genuinely different objective still bumps (existing behavior preserved —
        // matches `objective_contract_is_created_and_replaced_in_place` above).
        let third = store
            .upsert_objective_contract(
                "u",
                "w",
                "t",
                "message-3",
                "Investigate the failing test AND fix the underlying bug",
                ObjectiveMode::ReadOnlyAnalysis,
                &json!({"resources": ["project"]}),
                &json!(["read"]),
                &json!({"kind": "report"}),
                "active",
            )
            .unwrap();
        assert_eq!(
            third.revision,
            second.revision + 1,
            "a changed objective still bumps"
        );
    }

    #[test]
    fn objective_terminal_transition_requires_matching_revision() {
        let store = TaskStore::open_in_memory().unwrap();
        let objective = store
            .upsert_objective_contract(
                "u",
                "w",
                "t",
                "message-1",
                "Complete the analysis",
                ObjectiveMode::ReadOnlyAnalysis,
                &json!({}),
                &json!(["read"]),
                &json!({"kind": "report"}),
                "active",
            )
            .unwrap();

        assert!(
            store
                .transition_objective_contract_status(
                    "u",
                    "w",
                    "t",
                    objective.revision,
                    "completed",
                )
                .unwrap()
        );
        assert_eq!(
            store
                .load_objective_contract("u", "w", "t")
                .unwrap()
                .unwrap()
                .status,
            "completed"
        );
    }

    #[test]
    fn stale_turn_cannot_close_a_replacement_objective() {
        let store = TaskStore::open_in_memory().unwrap();
        let old = store
            .upsert_objective_contract(
                "u",
                "w",
                "t",
                "message-1",
                "Analyze",
                ObjectiveMode::ReadOnlyAnalysis,
                &json!({}),
                &json!(["read"]),
                &json!({}),
                "active",
            )
            .unwrap();
        let replacement = store
            .upsert_objective_contract(
                "u",
                "w",
                "t",
                "message-2",
                "Analyze and implement",
                ObjectiveMode::Mixed,
                &json!({}),
                &json!(["read", "filesystem_write"]),
                &json!({}),
                "active",
            )
            .unwrap();

        assert!(
            !store
                .transition_objective_contract_status("u", "w", "t", old.revision, "cancelled",)
                .unwrap()
        );
        assert_eq!(
            store
                .load_objective_contract("u", "w", "t")
                .unwrap()
                .unwrap(),
            replacement
        );
    }

    #[test]
    fn runtime_plan_is_bound_to_an_objective_revision() {
        let store = TaskStore::open_in_memory().unwrap();
        let objective = store
            .upsert_objective_contract(
                "u",
                "w",
                "t",
                "message-1",
                "Analyze only",
                ObjectiveMode::ReadOnlyAnalysis,
                &json!({}),
                &json!(["read"]),
                &json!({"kind": "report"}),
                "active",
            )
            .unwrap();

        let plan = store
            .upsert_runtime_plan(
                "u",
                "w",
                "t",
                objective.revision,
                &json!({"steps": []}),
                "open",
            )
            .unwrap();

        assert_eq!(plan.objective_revision, objective.revision);
    }

    #[test]
    fn runtime_plan_is_scoped_and_revisioned() {
        let store = TaskStore::open_in_memory().unwrap();
        let first = store
            .upsert_runtime_plan("u", "w", "t", 0, &json!({"steps": []}), "open")
            .unwrap();
        let second = store
            .upsert_runtime_plan("u", "w", "t", 0, &json!({"steps": [1]}), "open")
            .unwrap();
        assert_eq!((first.revision, second.revision), (1, 2));
        assert_eq!(second.plan_json, json!({"steps": [1]}));
        assert!(
            store
                .load_runtime_plan("u", "other", "t")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn runtime_plan_stall_bookkeeping_is_atomic() {
        let store = TaskStore::open_in_memory().unwrap();
        store
            .upsert_runtime_plan(
                "u",
                "w",
                "t",
                0,
                &json!({"steps": [{"status": "in_progress"}]}),
                "open",
            )
            .unwrap();
        let first = store
            .bump_runtime_plan_stall("u", "w", "t", 0)
            .unwrap()
            .unwrap();
        let repeated = store
            .bump_runtime_plan_stall("u", "w", "t", 0)
            .unwrap()
            .unwrap();
        let progressed = store
            .bump_runtime_plan_stall("u", "w", "t", 1)
            .unwrap()
            .unwrap();
        assert_eq!(first.stall_turns, 0);
        assert_eq!(repeated.stall_turns, 1);
        assert_eq!(progressed.stall_turns, 0);
        assert_eq!(progressed.last_resume_done, Some(1));
    }

    #[test]
    fn runtime_plan_cleanup_is_scope_safe() {
        let store = TaskStore::open_in_memory().unwrap();
        for (workspace, thread) in [("w", "t"), ("w", "other"), ("other", "t")] {
            store
                .upsert_runtime_plan("u", workspace, thread, 0, &json!({"steps": []}), "open")
                .unwrap();
        }
        assert_eq!(
            store.purge_runtime_plan_for_thread("u", "w", "t").unwrap(),
            1
        );
        assert!(store.load_runtime_plan("u", "w", "t").unwrap().is_none());
        assert!(
            store
                .load_runtime_plan("u", "w", "other")
                .unwrap()
                .is_some()
        );
        assert!(
            store
                .load_runtime_plan("u", "other", "t")
                .unwrap()
                .is_some()
        );
        store
            .purge_workspace(&UserId::new("u"), &WorkspaceId::new("other"))
            .unwrap();
        assert!(
            store
                .load_runtime_plan("u", "other", "t")
                .unwrap()
                .is_none()
        );
    }
}

#[cfg(test)]
mod turn_steering_tests {
    use super::*;

    fn new_steering(text: &str) -> NewTurnSteering {
        NewTurnSteering {
            source_message_id: format!("message-{text}"),
            prompt: text.into(),
            visible_prompt: text.into(),
            images: Vec::new(),
            attachments: serde_json::json!([]),
            mode: None,
            model: None,
        }
    }

    #[test]
    fn pending_steering_is_ordered_and_consumed_once() {
        let store = TaskStore::open_in_memory().unwrap();
        store
            .append_turn_steering("u", "w", "thread", "turn-1", &new_steering("first"), 3)
            .unwrap();
        store
            .append_turn_steering("u", "w", "thread", "turn-1", &new_steering("second"), 3)
            .unwrap();

        let consumed = store
            .consume_pending_turn_steering("u", "w", "thread", "turn-1")
            .unwrap();
        assert_eq!(
            consumed
                .iter()
                .map(|message| message.content.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
        assert!(
            store
                .consume_pending_turn_steering("u", "w", "thread", "turn-1")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn steering_cannot_cross_workspace_or_active_turn() {
        let store = TaskStore::open_in_memory().unwrap();
        store
            .append_turn_steering("u", "w", "thread", "turn-1", &new_steering("only"), 1)
            .unwrap();

        assert!(
            store
                .consume_pending_turn_steering("u", "other", "thread", "turn-1")
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .consume_pending_turn_steering("u", "w", "thread", "turn-2")
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            store
                .consume_pending_turn_steering("u", "w", "thread", "turn-1")
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn steering_envelope_round_trips_and_claims_fifo() {
        let store = TaskStore::open_in_memory().unwrap();
        let mut first = new_steering("first");
        first.images.push("data:image/png;base64,abc".into());
        let row = store
            .append_turn_steering("u", "w", "thread", "turn-1", &first, 3)
            .unwrap();
        store
            .append_turn_steering("u", "w", "thread", "turn-1", &new_steering("second"), 3)
            .unwrap();
        assert_eq!(row.revision, 1);
        assert_eq!(row.status, TurnSteeringStatus::Pending);
        assert_eq!(row.images.len(), 1);
        let claimed = store
            .claim_pending_turn_steering("u", "w", "thread", "turn-1", "run-1", 2)
            .unwrap();
        assert_eq!(
            claimed
                .iter()
                .map(|row| row.prompt.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
        assert!(
            claimed
                .iter()
                .all(|row| row.status == TurnSteeringStatus::Claimed)
        );
    }

    #[test]
    fn held_rows_are_revision_guarded() {
        let store = TaskStore::open_in_memory().unwrap();
        let row = store
            .append_turn_steering("u", "w", "thread", "turn-1", &new_steering("first"), 1)
            .unwrap();
        store
            .hold_pending_turn_steering("u", "w", "turn-1")
            .unwrap();
        let held = store
            .list_turn_steering("u", "w", "thread")
            .unwrap()
            .remove(0);
        assert_eq!(held.status, TurnSteeringStatus::Held);
        let edited = store
            .update_turn_steering(
                row.steering_id,
                "u",
                "w",
                held.revision,
                &new_steering("edited"),
            )
            .unwrap();
        assert!(matches!(
            store.update_turn_steering(
                row.steering_id,
                "u",
                "w",
                held.revision,
                &new_steering("stale")
            ),
            Err(TaskRuntimeError::Conflict(_))
        ));
        assert_eq!(
            store
                .cancel_turn_steering(row.steering_id, "u", "w", edited.revision)
                .unwrap()
                .status,
            TurnSteeringStatus::Cancelled
        );
    }

    #[test]
    fn manual_stop_holds_claimed_or_interpreted_steering_for_recovery() {
        let store = TaskStore::open_in_memory().unwrap();
        store
            .append_turn_steering("u", "w", "thread", "turn-1", &new_steering("recover me"), 1)
            .unwrap();
        let claimed = store
            .claim_pending_turn_steering("u", "w", "thread", "turn-1", "run-1", 1)
            .unwrap()
            .remove(0);
        store
            .mark_turn_steering_interpreted(
                claimed.steering_id,
                claimed.revision,
                &serde_json::json!({"steering_disposition": "finalize_with_current_evidence"}),
                "run-1",
            )
            .unwrap();

        assert_eq!(
            store
                .hold_pending_turn_steering("u", "w", "turn-1")
                .unwrap(),
            1
        );
        let held = store
            .list_turn_steering("u", "w", "thread")
            .unwrap()
            .remove(0);
        assert_eq!(held.status, TurnSteeringStatus::Held);
        assert!(held.semantic_decision_json.is_some());
    }

    #[test]
    fn steering_lifecycle_is_revision_guarded_until_runtime_completion() {
        let store = TaskStore::open_in_memory().unwrap();
        store
            .append_turn_steering(
                "u",
                "w",
                "thread",
                "turn-1",
                &new_steering("answer from current evidence"),
                1,
            )
            .unwrap();
        let claimed = store
            .claim_pending_turn_steering("u", "w", "thread", "turn-1", "run-1", 2)
            .unwrap()
            .remove(0);
        let interpreted = store
            .mark_turn_steering_interpreted(
                claimed.steering_id,
                claimed.revision,
                &serde_json::json!({"steering_disposition": "finalize_with_current_evidence"}),
                "run-1",
            )
            .unwrap();
        assert_eq!(interpreted.status, TurnSteeringStatus::Interpreted);
        assert_eq!(
            interpreted.semantic_decision_json,
            Some(serde_json::json!({"steering_disposition": "finalize_with_current_evidence"}))
        );

        let applied = store
            .mark_turn_steering_applied(interpreted.steering_id, interpreted.revision, "run-1")
            .unwrap();
        assert_eq!(applied.status, TurnSteeringStatus::Applied);
        let completed = store
            .mark_turn_steering_completed(applied.steering_id, applied.revision, "run-1")
            .unwrap();
        assert_eq!(completed.status, TurnSteeringStatus::Completed);
        assert!(completed.completed_at.is_some());
        assert!(matches!(
            store.mark_turn_steering_completed(applied.steering_id, applied.revision, "run-1"),
            Err(TaskRuntimeError::Conflict(_))
        ));
    }

    #[test]
    fn finalization_fence_blocks_every_unapplied_steering_state() {
        let store = TaskStore::open_in_memory().unwrap();
        let pending = store
            .append_turn_steering(
                "u",
                "w",
                "thread",
                "turn-1",
                &new_steering("finish from current evidence"),
                1,
            )
            .unwrap();
        assert!(
            !store
                .fence_chat_turn_finalization("u", "w", "turn-1")
                .unwrap()
        );

        let claimed = store
            .claim_pending_turn_steering("u", "w", "thread", "turn-1", "run-1", 1)
            .unwrap()
            .remove(0);
        assert_eq!(claimed.steering_id, pending.steering_id);
        assert!(
            !store
                .fence_chat_turn_finalization("u", "w", "turn-1")
                .unwrap()
        );

        let interpreted = store
            .mark_turn_steering_interpreted(
                claimed.steering_id,
                claimed.revision,
                &serde_json::json!({"steering_disposition": "finalize_with_current_evidence"}),
                "run-1",
            )
            .unwrap();
        assert!(
            !store
                .fence_chat_turn_finalization("u", "w", "turn-1")
                .unwrap()
        );

        store
            .mark_turn_steering_applied(interpreted.steering_id, interpreted.revision, "run-1")
            .unwrap();
        assert!(
            store
                .fence_chat_turn_finalization("u", "w", "turn-1")
                .unwrap()
        );
    }

    #[test]
    fn terminal_turn_stale_steering_can_be_closed_by_turn_owner() {
        let store = TaskStore::open_in_memory().unwrap();
        let held = store
            .append_turn_steering("u", "w", "thread", "turn-1", &new_steering("held"), 1)
            .unwrap();
        assert_eq!(
            store
                .hold_pending_turn_steering("u", "w", "turn-1")
                .unwrap(),
            1
        );
        let claimed = store
            .append_turn_steering("u", "w", "thread", "turn-1", &new_steering("claimed"), 1)
            .unwrap();
        let claimed = store
            .claim_pending_turn_steering("u", "w", "thread", "turn-1", "run-1", 1)
            .unwrap()
            .into_iter()
            .find(|row| row.steering_id == claimed.steering_id)
            .unwrap();
        let interpreted = store
            .append_turn_steering(
                "u",
                "w",
                "thread",
                "turn-1",
                &new_steering("interpreted"),
                1,
            )
            .unwrap();
        let interpreted = store
            .claim_pending_turn_steering("u", "w", "thread", "turn-1", "run-1", 1)
            .unwrap()
            .into_iter()
            .find(|row| row.steering_id == interpreted.steering_id)
            .unwrap();
        let interpreted = store
            .mark_turn_steering_interpreted(
                interpreted.steering_id,
                interpreted.revision,
                &serde_json::json!({"steering_disposition": "continue"}),
                "run-1",
            )
            .unwrap();
        let applied = store
            .append_turn_steering("u", "w", "thread", "turn-1", &new_steering("applied"), 1)
            .unwrap();
        let applied = store
            .claim_pending_turn_steering("u", "w", "thread", "turn-1", "run-1", 1)
            .unwrap()
            .into_iter()
            .find(|row| row.steering_id == applied.steering_id)
            .unwrap();
        let applied = store
            .mark_turn_steering_interpreted(
                applied.steering_id,
                applied.revision,
                &serde_json::json!({"steering_disposition": "continue"}),
                "run-1",
            )
            .unwrap();
        let applied = store
            .mark_turn_steering_applied(applied.steering_id, applied.revision, "run-1")
            .unwrap();
        let completed = store
            .append_turn_steering("u", "w", "thread", "turn-1", &new_steering("completed"), 1)
            .unwrap();
        let completed = store
            .claim_pending_turn_steering("u", "w", "thread", "turn-1", "run-1", 1)
            .unwrap()
            .into_iter()
            .find(|row| row.steering_id == completed.steering_id)
            .unwrap();
        let completed = store
            .mark_turn_steering_interpreted(
                completed.steering_id,
                completed.revision,
                &serde_json::json!({"steering_disposition": "continue"}),
                "run-1",
            )
            .unwrap();
        let completed = store
            .mark_turn_steering_applied(completed.steering_id, completed.revision, "run-1")
            .unwrap();
        let completed = store
            .mark_turn_steering_completed(completed.steering_id, completed.revision, "run-1")
            .unwrap();
        let pending = store
            .append_turn_steering("u", "w", "thread", "turn-1", &new_steering("pending"), 1)
            .unwrap();
        let other_turn = store
            .append_turn_steering("u", "w", "thread", "turn-2", &new_steering("other turn"), 1)
            .unwrap();

        assert_eq!(
            store
                .close_unsettled_turn_steering("u", "w", "thread", "turn-1")
                .unwrap(),
            5
        );
        let rows = store.list_turn_steering("u", "w", "thread").unwrap();
        for id in [
            held.steering_id,
            pending.steering_id,
            claimed.steering_id,
            interpreted.steering_id,
            applied.steering_id,
        ] {
            let row = rows.iter().find(|row| row.steering_id == id).unwrap();
            assert_eq!(row.status, TurnSteeringStatus::Cancelled);
            assert!(row.cancelled_at.is_some());
        }
        assert_eq!(
            rows.iter()
                .find(|row| row.steering_id == completed.steering_id)
                .unwrap()
                .status,
            TurnSteeringStatus::Completed
        );
        assert_eq!(
            rows.iter()
                .find(|row| row.steering_id == other_turn.steering_id)
                .unwrap()
                .status,
            TurnSteeringStatus::Pending
        );
    }

    #[test]
    fn unavailable_interpreter_returns_steering_to_pending_with_retry_time() {
        let store = TaskStore::open_in_memory().unwrap();
        store
            .append_turn_steering(
                "u",
                "w",
                "thread",
                "turn-1",
                &new_steering("use what you already found"),
                1,
            )
            .unwrap();
        let claimed = store
            .claim_pending_turn_steering("u", "w", "thread", "turn-1", "run-1", 3)
            .unwrap()
            .remove(0);
        let pending = store
            .release_turn_steering_for_retry(
                claimed.steering_id,
                claimed.revision,
                "model_unavailable",
                12345,
            )
            .unwrap();
        assert_eq!(pending.status, TurnSteeringStatus::Pending);
        assert_eq!(pending.next_retry_at, Some(12345));
        assert_eq!(
            pending.last_interpretation_error.as_deref(),
            Some("model_unavailable")
        );
        assert_eq!(pending.interpretation_attempts, 1);
        assert!(pending.applied_at.is_none());
    }

    #[test]
    fn defer_pending_turn_steering_backs_off_a_never_claimed_row() {
        let store = TaskStore::open_in_memory().unwrap();
        let row = store
            .append_turn_steering(
                "u",
                "w",
                "thread",
                "turn-1",
                &new_steering("still waiting"),
                1,
            )
            .unwrap();
        assert_eq!(row.status, TurnSteeringStatus::Pending);

        let deferred = store
            .defer_pending_turn_steering(row.steering_id, row.revision, "model_unavailable", 999)
            .unwrap();
        assert_eq!(
            deferred.status,
            TurnSteeringStatus::Pending,
            "stays pending — never claimed"
        );
        assert_eq!(deferred.next_retry_at, Some(999));
        assert_eq!(
            deferred.last_interpretation_error.as_deref(),
            Some("model_unavailable")
        );
        assert_eq!(deferred.interpretation_attempts, 1);
        assert!(deferred.claimed_run_id.is_none());

        // Revision-guarded like every other steering transition.
        assert!(matches!(
            store.defer_pending_turn_steering(row.steering_id, row.revision, "stale", 1000),
            Err(TaskRuntimeError::Conflict(_))
        ));
    }

    #[test]
    fn retry_backoff_rows_are_not_claimed_early() {
        let store = TaskStore::open_in_memory().unwrap();
        store
            .append_turn_steering(
                "u",
                "w",
                "thread",
                "turn-1",
                &new_steering("wait for semantic model"),
                1,
            )
            .unwrap();
        let claimed = store
            .claim_pending_turn_steering("u", "w", "thread", "turn-1", "run-1", 1)
            .unwrap()
            .remove(0);
        store
            .release_turn_steering_for_retry(
                claimed.steering_id,
                claimed.revision,
                "model_unavailable",
                i64::MAX,
            )
            .unwrap();

        assert!(
            store
                .claim_pending_turn_steering("u", "w", "thread", "turn-1", "run-2", 2)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            store
                .list_turn_steering("u", "w", "thread")
                .unwrap()
                .remove(0)
                .status,
            TurnSteeringStatus::Pending
        );
    }

    #[test]
    fn interpreted_rows_can_be_loaded_for_the_active_turn_without_pending_text() {
        let store = TaskStore::open_in_memory().unwrap();
        store
            .append_turn_steering(
                "u",
                "w",
                "thread",
                "turn-1",
                &new_steering("semantic control"),
                1,
            )
            .unwrap();
        let claimed = store
            .claim_pending_turn_steering("u", "w", "thread", "turn-1", "run-1", 1)
            .unwrap()
            .remove(0);
        store
            .mark_turn_steering_interpreted(
                claimed.steering_id,
                claimed.revision,
                &serde_json::json!({"steering_disposition": "replan_current_work"}),
                "run-1",
            )
            .unwrap();

        let rows = store
            .list_interpreted_turn_steering("u", "w", "thread", "turn-1", "run-1")
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, TurnSteeringStatus::Interpreted);
        assert_eq!(rows[0].content, "semantic control");
    }

    #[test]
    fn due_pending_scan_excludes_future_backoff_and_non_pending_rows() {
        let store = TaskStore::open_in_memory().unwrap();
        store
            .append_turn_steering("u", "w", "thread", "turn-1", &new_steering("due"), 1)
            .unwrap();
        store
            .append_turn_steering("u", "w", "thread", "turn-1", &new_steering("future"), 1)
            .unwrap();
        let mut claimed = store
            .claim_pending_turn_steering("u", "w", "thread", "turn-1", "run-1", 1)
            .unwrap();
        let future = claimed.pop().unwrap();
        let due = claimed.pop().unwrap();
        store
            .release_turn_steering_for_retry(
                future.steering_id,
                future.revision,
                "model_unavailable",
                i64::MAX,
            )
            .unwrap();
        store
            .release_turn_steering_for_retry(due.steering_id, due.revision, "model_unavailable", 1)
            .unwrap();

        let rows = store.list_due_pending_turn_steering(10, 20).unwrap();
        assert_eq!(
            rows.iter()
                .map(|row| row.content.as_str())
                .collect::<Vec<_>>(),
            vec!["due"]
        );
    }
}

#[cfg(test)]
mod agent_control_state_tests {
    use super::*;
    use serde_json::json;

    fn run(run_id: &str) -> NewAgentRun {
        NewAgentRun {
            run_id: run_id.into(),
            turn_id: "turn".into(),
            thread_id: "thread".into(),
            user_id: "user".into(),
            workspace_id: "workspace".into(),
            role: None,
            model: None,
            provider: None,
            prompt_fingerprint: None,
        }
    }

    #[test]
    fn agent_run_role_round_trips() {
        let store = TaskStore::open_in_memory().unwrap();
        let mut new_run = run("run-with-role");
        new_run.role = Some("coding".to_string());

        let created = store.create_agent_run(&new_run).unwrap();
        let loaded = store
            .list_agent_runs_for_turn("turn", "user", "workspace")
            .unwrap();

        assert_eq!(created.role.as_deref(), Some("coding"));
        assert_eq!(loaded[0].role.as_deref(), Some("coding"));
    }

    #[test]
    fn agent_run_attribution_backfills_missing_model_provider_from_prompt_snapshot() {
        let store = TaskStore::open_in_memory().unwrap();
        let mut new_run = run("run-attribution");
        new_run.role = Some("orchestrator".to_string());
        store.create_agent_run(&new_run).unwrap();

        assert_eq!(
            store
                .backfill_agent_run_attribution(
                    "run-attribution",
                    Some("gpt-test"),
                    Some("openai-compatible"),
                    Some("prompt-fingerprint"),
                )
                .unwrap(),
            1
        );
        let loaded = store
            .list_agent_runs_for_turn("turn", "user", "workspace")
            .unwrap();
        assert_eq!(loaded[0].role.as_deref(), Some("orchestrator"));
        assert_eq!(loaded[0].model.as_deref(), Some("gpt-test"));
        assert_eq!(loaded[0].provider.as_deref(), Some("openai-compatible"));
        assert_eq!(
            loaded[0].prompt_fingerprint.as_deref(),
            Some("prompt-fingerprint")
        );

        assert_eq!(
            store
                .backfill_agent_run_attribution(
                    "run-attribution",
                    Some("other-model"),
                    Some("other-provider"),
                    Some("other-fingerprint"),
                )
                .unwrap(),
            0
        );
        let loaded = store
            .list_agent_runs_for_turn("turn", "user", "workspace")
            .unwrap();
        assert_eq!(loaded[0].model.as_deref(), Some("gpt-test"));
        assert_eq!(loaded[0].provider.as_deref(), Some("openai-compatible"));
        assert_eq!(
            loaded[0].prompt_fingerprint.as_deref(),
            Some("prompt-fingerprint")
        );
    }

    #[test]
    fn checkpoint_recovery_requires_gateway_restart_abort() {
        let store = TaskStore::open_in_memory().unwrap();
        store.create_agent_run(&run("run")).unwrap();
        store
            .append_agent_checkpoint("run", 2, &json!({"round": 2}), "fp", true)
            .unwrap();
        assert!(
            store
                .latest_resumable_checkpoint_for_turn("turn", "user", "workspace")
                .unwrap()
                .is_none()
        );
        store
            .abort_running_agent_runs_for_turn("turn", "user", "workspace", "gateway_restart")
            .unwrap();
        let checkpoint = store
            .latest_resumable_checkpoint_for_turn("turn", "user", "workspace")
            .unwrap()
            .unwrap();
        assert_eq!(checkpoint.round, 2);
    }

    #[test]
    fn checkpoint_recovery_prefers_the_newest_attempt_before_round() {
        let store = TaskStore::open_in_memory().unwrap();
        store.create_agent_run(&run("run-1")).unwrap();
        store
            .append_agent_checkpoint("run-1", 9, &json!({"attempt": 1}), "fp-1", true)
            .unwrap();
        store
            .abort_running_agent_runs_for_turn("turn", "user", "workspace", "gateway_restart")
            .unwrap();

        store.create_agent_run(&run("run-2")).unwrap();
        store
            .append_agent_checkpoint("run-2", 1, &json!({"attempt": 2}), "fp-2", true)
            .unwrap();
        store
            .abort_running_agent_runs_for_turn("turn", "user", "workspace", "gateway_restart")
            .unwrap();

        store
            .connection
            .execute("UPDATE agent_checkpoints SET created_at = 1", [])
            .unwrap();
        let checkpoint = store
            .latest_resumable_checkpoint_for_turn("turn", "user", "workspace")
            .unwrap()
            .unwrap();
        assert_eq!(checkpoint.run_id, "run-2");
        assert_eq!(checkpoint.round, 1);
    }

    /// Seeds a `chat_turn` task (Running) mirroring `chat_turn_query_tests::make_chat_turn`,
    /// with the same `BrowserSession` resource requirement real chat turns carry
    /// (`broker::chat_turn_resource_requirements`) so park/unpark resource release can be
    /// exercised. Returns the record so the caller can reserve it the same way the real
    /// dispatcher (`acquire_task_for_execution` -> `ResourceGovernor::reserve`) would.
    fn seed_chat_turn(store: &TaskStore, task_id: &str) -> TaskRecord {
        let mut task = TaskRecord::new(
            task_id,
            UserId::new("user"),
            WorkspaceId::new("workspace"),
            "chat_turn",
            "seed goal",
            json!({}),
        );
        task.status = TaskStatus::Running;
        task.resource_requirements = vec![crate::ResourceRequirement::new(
            ResourceClass::BrowserSession,
            1,
        )];
        store
            .insert_chat_turn(&task, "thread", "req-1", "interactive", "full")
            .unwrap();
        task
    }

    #[test]
    fn park_then_resumable_checkpoint_is_readable_and_unpark_queues() {
        let store = TaskStore::open_in_memory().unwrap();
        let user = UserId::new("user");
        let workspace = WorkspaceId::new("workspace");
        let task = seed_chat_turn(&store, "turn");
        // Reserve the BrowserSession slot the way the real dispatcher does on acquire.
        store.reserve_resources(&task, "worker_a").unwrap();
        assert_eq!(
            store
                .resource_usage(&user, &workspace, ResourceClass::BrowserSession)
                .unwrap(),
            1,
            "the running turn holds the shared browser_session slot"
        );
        store.create_agent_run(&run("run")).unwrap();
        store
            .append_agent_checkpoint("run", 3, &json!({"round": 3}), "fp", true)
            .unwrap();

        // Before park: nothing resumable (mirrors the gateway-restart case).
        assert!(
            store
                .latest_resumable_checkpoint_for_turn("turn", "user", "workspace")
                .unwrap()
                .is_none()
        );

        store.park_chat_turn("turn", "user", "workspace").unwrap();

        let parked_task = store
            .get_task(
                &TaskId::new("turn"),
                &UserId::new("user"),
                &WorkspaceId::new("workspace"),
            )
            .unwrap()
            .unwrap();
        assert_eq!(parked_task.status, TaskStatus::Parked, "task is parked");
        assert!(
            parked_task.lease_owner.is_none(),
            "park clears the lease owner"
        );
        assert!(
            parked_task.lease_expires_at.is_none(),
            "park clears the lease expiry"
        );
        assert!(
            parked_task.last_heartbeat_at.is_none(),
            "park clears the heartbeat"
        );

        // The critical fix under test: parking releases the shared resource reservation.
        // Without it, a turn parked indefinitely (model down) would hold the single
        // BrowserSession slot forever and block every other chat's browser use.
        assert_eq!(
            store
                .resource_usage(&user, &workspace, ResourceClass::BrowserSession)
                .unwrap(),
            0,
            "park releases the browser_session reservation, not just the agent run"
        );

        let runs = store
            .list_agent_runs_for_turn("turn", "user", "workspace")
            .unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, AgentRunStatus::Aborted);
        assert_eq!(
            runs[0].terminal_reason.as_deref(),
            Some("parked_waiting_for_model")
        );

        // The park checkpoint is now resumable (filter widened beyond gateway_restart).
        let checkpoint = store
            .latest_resumable_checkpoint_for_turn("turn", "user", "workspace")
            .unwrap()
            .unwrap();
        assert_eq!(checkpoint.round, 3);

        // Unpark: task flips back to queued, and returns true exactly once.
        assert!(
            store
                .unpark_chat_turn_to_queued("turn", "user", "workspace")
                .unwrap()
        );
        let queued_task = store
            .get_task(
                &TaskId::new("turn"),
                &UserId::new("user"),
                &WorkspaceId::new("workspace"),
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            queued_task.status,
            TaskStatus::Queued,
            "unpark queues the task"
        );
        assert!(
            !store
                .unpark_chat_turn_to_queued("turn", "user", "workspace")
                .unwrap(),
            "second unpark call is a no-op (already queued, not parked)"
        );

        // Resume re-reserves through the normal dispatch path (out of this crate's scope to
        // simulate the gateway's acquire loop, but the store-level primitive works the same
        // way it did the first time the turn was dispatched):
        store.reserve_resources(&queued_task, "worker_b").unwrap();
        assert_eq!(
            store
                .resource_usage(&user, &workspace, ResourceClass::BrowserSession)
                .unwrap(),
            1,
            "re-dispatch re-reserves the slot exactly like the first acquire"
        );
    }

    /// Review I2 regression: a steering row still `claimed` under the run being
    /// aborted must NOT stay `claimed` across park — it must be released back to
    /// `pending` so (a) the due-scan (pending-only) can see it again and (b) a later
    /// fence check doesn't count it as blocking forever against a run that will never
    /// finish interpreting it.
    #[test]
    fn park_releases_a_claimed_but_uninterpreted_steering_row_back_to_pending() {
        let store = TaskStore::open_in_memory().unwrap();
        let task = seed_chat_turn(&store, "turn");
        store.reserve_resources(&task, "worker_a").unwrap();
        store.create_agent_run(&run("run")).unwrap();

        store
            .append_turn_steering(
                "user",
                "workspace",
                "thread",
                "turn",
                &NewTurnSteering {
                    source_message_id: "message-1".to_string(),
                    prompt: "finish now".to_string(),
                    visible_prompt: "finish now".to_string(),
                    images: Vec::new(),
                    attachments: json!([]),
                    mode: None,
                    model: None,
                },
                1,
            )
            .unwrap();
        // The coordinator claimed it under "run" but interpretation didn't finish
        // before the fence's park budget expired.
        let claimed = store
            .claim_pending_turn_steering("user", "workspace", "thread", "turn", "run", 0)
            .unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(
            claimed[0].status,
            TurnSteeringStatus::Claimed,
            "precondition"
        );

        // Before park: a claimed row is invisible to the due-scan and blocks the fence.
        assert!(
            store
                .list_due_pending_turn_steering(i64::MAX, 10)
                .unwrap()
                .is_empty()
        );
        assert!(
            !store
                .fence_chat_turn_finalization("user", "workspace", "turn")
                .unwrap()
        );

        store.park_chat_turn("turn", "user", "workspace").unwrap();

        let released = store
            .list_turn_steering("user", "workspace", "thread")
            .unwrap()
            .into_iter()
            .find(|row| row.steering_id == claimed[0].steering_id)
            .unwrap();
        assert_eq!(
            released.status,
            TurnSteeringStatus::Pending,
            "released back to pending"
        );
        assert!(released.claimed_run_id.is_none());
        assert!(released.claimed_round.is_none());
        assert!(released.claimed_at.is_none());

        // After park: it reappears in the due-scan, ready for the resumed run to claim.
        let due = store.list_due_pending_turn_steering(i64::MAX, 10).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].steering_id, claimed[0].steering_id);

        // A resumed run re-claims and interprets it normally.
        let reclaimed = store
            .claim_pending_turn_steering("user", "workspace", "thread", "turn", "run-2", 0)
            .unwrap();
        assert_eq!(reclaimed.len(), 1);
        assert_eq!(reclaimed[0].claimed_run_id.as_deref(), Some("run-2"));
    }
}

#[cfg(test)]
mod turn_event_tests {
    use super::*;
    use serde_json::json;

    fn store() -> TaskStore {
        TaskStore::open_in_memory().expect("open")
    }

    #[test]
    fn append_assigns_monotonic_seq_per_turn() {
        let s = store();
        let e1 = s
            .insert_turn_event("t1", TurnEventKind::Delta, json!({"text":"a"}))
            .unwrap();
        let e2 = s
            .insert_turn_event("t1", TurnEventKind::Delta, json!({"text":"b"}))
            .unwrap();
        let e3 = s
            .insert_turn_event("t2", TurnEventKind::Delta, json!({"text":"other"}))
            .unwrap();
        assert_eq!(e1.seq, 1);
        assert_eq!(e2.seq, 2);
        assert_eq!(e3.seq, 1, "seq is per turn_id, independent across turns");
    }

    #[test]
    fn terminal_event_is_written_once() {
        let store = TaskStore::open_in_memory().unwrap();
        let first = store
            .insert_terminal_event_once("turn", TurnEventKind::Done, json!({"attempt": 2}))
            .unwrap();
        let late = store
            .insert_terminal_event_once("turn", TurnEventKind::Error, json!({"attempt": 1}))
            .unwrap();

        assert!(matches!(first, TerminalWrite::Inserted(_)));
        assert!(matches!(late, TerminalWrite::Existing(_)));
        assert_eq!(store.read_turn_events("turn", 0).unwrap().len(), 1);
    }

    #[test]
    fn canonical_projection_replaces_unacknowledged_legacy_terminal_event() {
        let store = TaskStore::open_in_memory().unwrap();
        store
            .insert_terminal_event_once("turn", TurnEventKind::Done, json!({"text": "legacy"}))
            .unwrap();

        let projected = store
            .insert_turn_projection_event_once(
                "turn",
                TurnEventKind::Cancelled,
                "turn:2",
                json!({"projection_ref": "turn:2", "reason": "user"}),
            )
            .unwrap();

        assert!(matches!(projected, TerminalWrite::Inserted(_)));
        let events = store.read_turn_events("turn", 0).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, TurnEventKind::Cancelled);
        assert_eq!(
            events[0]
                .payload
                .get("projection_ref")
                .and_then(Value::as_str),
            Some("turn:2")
        );
    }

    #[test]
    fn canonical_projection_conflicts_with_existing_canonical_terminal_event() {
        let store = TaskStore::open_in_memory().unwrap();
        store
            .insert_turn_projection_event_once(
                "turn",
                TurnEventKind::Done,
                "turn:1",
                json!({"projection_ref": "turn:1", "text": "done"}),
            )
            .unwrap();

        let err = store
            .insert_turn_projection_event_once(
                "turn",
                TurnEventKind::Cancelled,
                "turn:2",
                json!({"projection_ref": "turn:2", "reason": "user"}),
            )
            .expect_err("a second canonical terminal must conflict");

        assert!(err.to_string().contains("canonical projection conflicts"));
    }

    #[test]
    fn read_since_returns_only_newer_in_order() {
        let s = store();
        s.insert_turn_event("t1", TurnEventKind::Delta, json!({"i":1}))
            .unwrap();
        s.insert_turn_event("t1", TurnEventKind::Activity, json!({"i":2}))
            .unwrap();
        s.insert_turn_event("t1", TurnEventKind::PlanUpdate, json!({"i":3}))
            .unwrap();
        let since1 = s.read_turn_events("t1", 1).unwrap();
        assert_eq!(since1.len(), 2);
        assert_eq!(since1[0].seq, 2);
        assert_eq!(since1[1].seq, 3);
        let since0 = s.read_turn_events("t1", 0).unwrap();
        assert_eq!(since0.len(), 3);
        assert_eq!(since0[2].kind, TurnEventKind::PlanUpdate);
    }

    #[test]
    fn kind_round_trips() {
        let s = store();
        for k in [
            TurnEventKind::Delta,
            TurnEventKind::Aborted,
            TurnEventKind::Cancelled,
        ] {
            s.insert_turn_event("t", k, json!({})).unwrap();
        }
        let events = s.read_turn_events("t", 0).unwrap();
        assert_eq!(
            events.iter().map(|e| e.kind).collect::<Vec<_>>(),
            vec![
                TurnEventKind::Delta,
                TurnEventKind::Aborted,
                TurnEventKind::Cancelled
            ]
        );
    }
}

#[cfg(test)]
mod agent_run_tests {
    use super::*;
    use crate::{AgentRunStatus, NewAgentRun};
    use serde_json::json;

    fn new_run(run_id: &str, turn_id: &str, user_id: &str, workspace_id: &str) -> NewAgentRun {
        NewAgentRun {
            run_id: run_id.to_string(),
            turn_id: turn_id.to_string(),
            thread_id: "thread-1".to_string(),
            user_id: user_id.to_string(),
            workspace_id: workspace_id.to_string(),
            role: None,
            model: Some("test-model".to_string()),
            provider: Some("test-provider".to_string()),
            prompt_fingerprint: None,
        }
    }

    #[test]
    fn agent_run_json_without_role_remains_compatible() {
        let run: AgentRun = serde_json::from_value(json!({
            "run_id": "legacy-run",
            "turn_id": "legacy-turn",
            "thread_id": "legacy-thread",
            "user_id": "u",
            "workspace_id": "w",
            "attempt": 1,
            "status": "completed",
            "model": null,
            "provider": null,
            "prompt_fingerprint": null,
            "started_at": 1,
            "completed_at": 2,
            "terminal_reason": null,
            "schema_version": 1
        }))
        .unwrap();
        let new_run: NewAgentRun = serde_json::from_value(json!({
            "run_id": "legacy-run",
            "turn_id": "legacy-turn",
            "thread_id": "legacy-thread",
            "user_id": "u",
            "workspace_id": "w",
            "model": null,
            "provider": null,
            "prompt_fingerprint": null
        }))
        .unwrap();

        assert_eq!(run.role, None);
        assert_eq!(new_run.role, None);
    }

    #[test]
    fn agent_run_events_are_append_only_and_scope_filtered() {
        let store = TaskStore::open_in_memory().unwrap();
        store
            .create_agent_run(&new_run("run-1", "turn-1", "u1", "w1"))
            .unwrap();
        store
            .append_agent_run_event("run-1", 2, Some(1), "model_response", &json!({"ok": true}))
            .unwrap();
        assert!(
            store
                .append_agent_run_event("run-1", 2, Some(1), "model_response", &json!({}))
                .is_err(),
            "duplicate sequence numbers must be rejected"
        );

        let events = store
            .list_agent_run_events("run-1", "u1", "w1", Some(1))
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].seq, 2);
        assert!(
            store
                .list_agent_run_events("run-1", "other", "w1", None)
                .unwrap()
                .is_empty(),
            "foreign scopes must not observe the run"
        );
        assert!(
            store
                .list_agent_runs_for_turn("turn-1", "u1", "other")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn latest_prompt_snapshot_returns_only_the_latest_snapshot() {
        let store = TaskStore::open_in_memory().unwrap();
        store
            .create_agent_run(&new_run("run-2", "turn-2", "u", "w"))
            .unwrap();
        store
            .append_agent_run_event("run-2", 2, Some(1), "prompt_snapshot", &json!({"round": 1}))
            .unwrap();
        store
            .append_agent_run_event("run-2", 3, Some(2), "prompt_snapshot", &json!({"round": 2}))
            .unwrap();

        let latest = store
            .latest_agent_prompt_snapshot("run-2", "u", "w")
            .unwrap()
            .unwrap();
        assert_eq!(latest.seq, 3);
        assert_eq!(latest.payload["round"], 2);
        assert!(
            store
                .latest_agent_prompt_snapshot("run-2", "u", "foreign")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn thread_runs_use_insertion_order_when_start_timestamps_tie() {
        let store = TaskStore::open_in_memory().unwrap();
        store
            .create_agent_run(&new_run("run-old", "turn-old", "u", "w"))
            .unwrap();
        store
            .create_agent_run(&new_run("run-new", "turn-new", "u", "w"))
            .unwrap();
        store
            .connection
            .execute("UPDATE agent_runs SET started_at = 1", [])
            .unwrap();

        let runs = store
            .list_agent_runs_for_thread("thread-1", "u", "w")
            .unwrap();
        assert_eq!(runs[0].run_id, "run-new");
    }

    #[test]
    fn agent_run_lifecycle_is_explicit() {
        let store = TaskStore::open_in_memory().unwrap();
        store
            .create_agent_run(&new_run("run-3", "turn-3", "u", "w"))
            .unwrap();
        store
            .finish_agent_run("run-3", AgentRunStatus::Completed, Some("delivered"))
            .unwrap();
        let runs = store.list_agent_runs_for_turn("turn-3", "u", "w").unwrap();
        assert_eq!(runs[0].status, AgentRunStatus::Completed);
        assert_eq!(runs[0].terminal_reason.as_deref(), Some("delivered"));
        assert!(runs[0].completed_at.is_some());
    }

    #[test]
    fn agent_run_attempt_is_allocated_atomically_by_the_store() {
        let store = TaskStore::open_in_memory().unwrap();
        let first = store
            .create_agent_run(&new_run("attempt-a", "turn-retry", "u", "w"))
            .unwrap();
        let second = store
            .create_agent_run(&new_run("attempt-b", "turn-retry", "u", "w"))
            .unwrap();

        assert_eq!(first.attempt, 1);
        assert_eq!(second.attempt, 2);
    }

    #[test]
    fn workspace_purge_deletes_owned_runs_and_events_only() {
        let store = TaskStore::open_in_memory().unwrap();
        store
            .create_agent_run(&new_run("owned", "turn-owned", "u", "w"))
            .unwrap();
        store
            .create_agent_run(&new_run("other", "turn-other", "u", "other"))
            .unwrap();

        store
            .purge_workspace(&UserId::new("u"), &WorkspaceId::new("w"))
            .unwrap();

        assert!(
            store
                .list_agent_runs_for_turn("turn-owned", "u", "w")
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            store
                .list_agent_runs_for_turn("turn-other", "u", "other")
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn thread_purge_deletes_owned_runs_and_events_only() {
        let store = TaskStore::open_in_memory().unwrap();
        store
            .create_agent_run(&new_run("owned-thread", "turn-a", "u", "w"))
            .unwrap();
        store
            .append_agent_run_event("owned-thread", 2, Some(1), "model_response", &json!({}))
            .unwrap();
        let mut other = new_run("other-thread", "turn-b", "u", "w");
        other.thread_id = "thread-2".to_string();
        store.create_agent_run(&other).unwrap();

        assert_eq!(
            store
                .purge_agent_runs_for_thread("thread-1", "u", "w")
                .unwrap(),
            1
        );
        assert!(
            store
                .list_agent_runs_for_turn("turn-a", "u", "w")
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            store
                .list_agent_runs_for_turn("turn-b", "u", "w")
                .unwrap()
                .len(),
            1
        );
        let event_count: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM agent_run_events WHERE run_id = 'owned-thread'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(event_count, 0);
    }

    #[test]
    fn retention_deletes_only_old_terminal_runs() {
        let store = TaskStore::open_in_memory().unwrap();
        store
            .create_agent_run(&new_run("old", "turn-old", "u", "w"))
            .unwrap();
        store
            .create_agent_run(&new_run("recent", "turn-recent", "u", "w"))
            .unwrap();
        store
            .create_agent_run(&new_run("active", "turn-active", "u", "w"))
            .unwrap();
        store
            .finish_agent_run("old", AgentRunStatus::Completed, None)
            .unwrap();
        store
            .finish_agent_run("recent", AgentRunStatus::Completed, None)
            .unwrap();
        store
            .connection
            .execute(
                "UPDATE agent_runs SET completed_at = 10 WHERE run_id = 'old'",
                [],
            )
            .unwrap();

        assert_eq!(store.purge_terminal_agent_runs_before(100, 10).unwrap(), 1);
        assert!(
            store
                .list_agent_runs_for_turn("turn-old", "u", "w")
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            store
                .list_agent_runs_for_turn("turn-recent", "u", "w")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .list_agent_runs_for_turn("turn-active", "u", "w")
                .unwrap()
                .len(),
            1
        );
    }
}

#[cfg(test)]
mod generation_tests {
    use super::*;

    #[test]
    fn bump_is_monotonic() {
        let s = TaskStore::open_in_memory().unwrap();
        assert_eq!(s.bump_process_generation().unwrap(), 1);
        assert_eq!(s.bump_process_generation().unwrap(), 2);
        assert_eq!(s.get_process_generation().unwrap(), 2);
    }
}

#[cfg(test)]
mod chat_turn_query_tests {
    use super::*;
    use crate::{TaskPriority, TaskRecord, TaskStatus, UserId, WorkspaceId};
    use serde_json::json;

    fn store() -> TaskStore {
        TaskStore::open_in_memory().unwrap()
    }

    fn make_chat_turn(task_id: &str, thread_id: &str, status: TaskStatus) -> TaskRecord {
        let mut t = TaskRecord::new(
            task_id,
            UserId::new("u"),
            WorkspaceId::new("w"),
            "chat_turn",
            format!("prompt for {thread_id}"),
            json!({}),
        );
        t.status = status;
        t.priority = TaskPriority::High;
        t
    }

    fn insert_browser_turn(store: &TaskStore, turn_id: &str, thread_id: &str, status: TaskStatus) {
        let mut task = make_chat_turn(turn_id, thread_id, status);
        task.created_at = OffsetDateTime::from_unix_timestamp(100).unwrap();
        store
            .insert_chat_turn(
                &task,
                thread_id,
                &format!("req-{turn_id}"),
                "interactive",
                "full",
            )
            .unwrap();
    }

    fn browser_checkpoint(thread_id: &str, target_id: &str) -> NewBrowserCheckpoint {
        NewBrowserCheckpoint {
            checkpoint_id: format!("checkpoint-{thread_id}-{target_id}"),
            user_id: "u".into(),
            workspace_id: "w".into(),
            thread_id: thread_id.into(),
            target_id: target_id.into(),
            objective_revision: 1,
            schema_version: 1,
            url: "https://rail.example/search".into(),
            origin: "https://rail.example".into(),
            browser_epoch: "browser-epoch-1".into(),
            cdp_target_id: Some("cdp-target-1".into()),
            generation: 1,
            draft_secret_ref: None,
            draft_control_count: 0,
            omitted_sensitive_count: 0,
            omitted_bounded_count: 0,
            expires_at: 2_000_000_000,
        }
    }

    #[test]
    fn active_chat_turn_returns_none_when_empty() {
        let s = store();
        assert_eq!(s.active_chat_turn_for_thread("thread_x").unwrap(), None);
    }

    #[test]
    fn active_chat_turn_finds_queued_or_running() {
        let s = store();
        let t1 = make_chat_turn("t1", "thread_x", TaskStatus::Queued);
        s.insert_chat_turn(&t1, "thread_x", "chat_stream_1", "interactive", "full")
            .unwrap();
        assert_eq!(
            s.active_chat_turn_for_thread("thread_x")
                .unwrap()
                .as_deref(),
            Some("t1")
        );

        // a second thread doesn't collide
        let t2 = make_chat_turn("t2", "thread_y", TaskStatus::Running);
        s.insert_chat_turn(&t2, "thread_y", "chat_stream_2", "interactive", "full")
            .unwrap();
        assert_eq!(
            s.active_chat_turn_for_thread("thread_y")
                .unwrap()
                .as_deref(),
            Some("t2")
        );
        assert_eq!(
            s.active_chat_turn_for_thread("thread_x")
                .unwrap()
                .as_deref(),
            Some("t1")
        );
    }

    #[test]
    fn active_chat_turn_ignores_completed() {
        let s = store();
        let t = make_chat_turn("t1", "thread_x", TaskStatus::Completed);
        s.insert_chat_turn(&t, "thread_x", "chat_stream_1", "interactive", "full")
            .unwrap();
        assert_eq!(
            s.active_chat_turn_for_thread("thread_x").unwrap(),
            None,
            "completed turns do not block a new enqueue"
        );
    }

    #[test]
    fn abort_terminal_task_agent_runs_aborts_running_run_left_behind() {
        let s = store();
        let terminal = make_chat_turn("turn_terminal", "thread_x", TaskStatus::Completed);
        s.insert_chat_turn(
            &terminal,
            "thread_x",
            "chat_stream_terminal",
            "interactive",
            "full",
        )
        .unwrap();
        s.create_agent_run(&NewAgentRun {
            run_id: "run-terminal".into(),
            turn_id: "turn_terminal".into(),
            thread_id: "thread_x".into(),
            user_id: "u".into(),
            workspace_id: "w".into(),
            role: Some("orchestrator".into()),
            model: Some("qwen".into()),
            provider: Some("ollama".into()),
            prompt_fingerprint: Some("fp".into()),
        })
        .unwrap();

        assert_eq!(
            s.abort_running_agent_runs_for_terminal_tasks("gateway_restart")
                .unwrap(),
            1
        );

        let runs = s
            .list_agent_runs_for_turn("turn_terminal", "u", "w")
            .unwrap();
        assert_eq!(runs[0].status, AgentRunStatus::Aborted);
        assert_eq!(runs[0].terminal_reason.as_deref(), Some("gateway_restart"));
    }

    #[test]
    fn active_chat_turn_ignores_internal_finalizing() {
        let s = store();
        let t = make_chat_turn("t1", "thread_x", TaskStatus::Running);
        s.insert_chat_turn(&t, "thread_x", "chat_stream_1", "interactive", "full")
            .unwrap();
        s.connection
            .execute(
                "UPDATE tasks SET status = 'finalizing' WHERE task_id = ?1",
                params!["t1"],
            )
            .unwrap();

        assert_eq!(
            s.active_chat_turn_for_thread("thread_x").unwrap(),
            None,
            "finalizing is an internal free-thread state for active-turn queries"
        );
    }

    #[test]
    fn thread_attention_reports_latest_terminal_event() {
        let s = TaskStore::open_in_memory().unwrap();
        let task = make_chat_turn("turn-a", "thread-a", TaskStatus::Completed);
        s.insert_chat_turn(&task, "thread-a", "chat_stream_1", "interactive", "full")
            .unwrap();
        let event = s
            .insert_turn_event("turn-a", TurnEventKind::Done, json!({}))
            .unwrap();

        assert_eq!(
            s.thread_attention("thread-a")
                .unwrap()
                .latest_terminal_event_id,
            Some(event.event_id)
        );
    }

    #[test]
    fn active_chat_turn_ignores_non_chat_turn_kind() {
        let s = store();
        let mut other = TaskRecord::new(
            "bg1",
            UserId::new("u"),
            WorkspaceId::new("w"),
            "background_job",
            "do thing",
            json!({}),
        );
        other.status = TaskStatus::Running;
        s.insert_task(&other).unwrap();
        // even if thread_id were set, kind != chat_turn -> ignored
        s.connection
            .execute(
                "UPDATE tasks SET thread_id = 'thread_x' WHERE task_id = 'bg1'",
                [],
            )
            .unwrap();
        assert_eq!(s.active_chat_turn_for_thread("thread_x").unwrap(), None);
    }

    #[test]
    fn active_turn_projection_exposes_the_replay_cursor() {
        let s = store();
        let task = make_chat_turn("turn_cursor", "thread_cursor", TaskStatus::Running);
        s.insert_chat_turn(
            &task,
            "thread_cursor",
            "request_cursor",
            "interactive",
            "full",
        )
        .unwrap();
        s.insert_turn_event("turn_cursor", TurnEventKind::Delta, json!({"text": "A"}))
            .unwrap();
        let last = s
            .insert_turn_event("turn_cursor", TurnEventKind::Activity, json!({"text": "B"}))
            .unwrap();

        let projection = s.project_kernel_thread("thread_cursor", 200).unwrap();
        assert_eq!(
            projection.turn.active_turn_id.as_deref(),
            Some("turn_cursor")
        );
        assert_eq!(projection.turn.last_event_seq, last.seq);
    }

    #[test]
    fn finalizing_turn_is_latest_but_not_active_in_kernel_projection() {
        let s = store();
        let task = make_chat_turn("turn_finalizing", "thread_finalizing", TaskStatus::Running);
        s.insert_chat_turn(
            &task,
            "thread_finalizing",
            "request_finalizing",
            "interactive",
            "full",
        )
        .unwrap();
        s.insert_turn_event(
            "turn_finalizing",
            TurnEventKind::Activity,
            json!({"text": "Almost done"}),
        )
        .unwrap();
        assert!(
            s.fence_chat_turn_finalization("u", "w", "turn_finalizing")
                .unwrap()
        );

        let projection = s.project_kernel_thread("thread_finalizing", 200).unwrap();
        assert_eq!(projection.turn.status, "finalizing");
        assert_eq!(projection.turn.active_turn_id, None);
        assert_eq!(
            projection.activity[0].text, "Almost done",
            "finalizing preserves durable activity rows"
        );
    }

    #[test]
    fn runtime_integrity_audit_reports_lifecycle_contradictions() {
        let s = store();
        let completed = make_chat_turn("turn_done", "thread_done", TaskStatus::Completed);
        s.insert_chat_turn(&completed, "thread_done", "req-done", "interactive", "full")
            .unwrap();
        s.create_agent_run(&NewAgentRun {
            run_id: "run-stale".into(),
            turn_id: "turn_done".into(),
            thread_id: "thread_done".into(),
            user_id: "u".into(),
            workspace_id: "w".into(),
            role: Some("orchestrator".into()),
            model: Some("qwen".into()),
            provider: Some("ollama".into()),
            prompt_fingerprint: None,
        })
        .unwrap();
        s.insert_turn_event(
            "turn_done",
            TurnEventKind::Activity,
            json!({"status": "browser_budget_exceeded:stall"}),
        )
        .unwrap();

        let waiting = make_chat_turn(
            "turn_waiting_approval",
            "thread_waiting",
            TaskStatus::WaitingUserApproval,
        );
        s.insert_chat_turn(
            &waiting,
            "thread_waiting",
            "req-waiting",
            "interactive",
            "full",
        )
        .unwrap();

        let report = s.audit_runtime_integrity().unwrap();
        let codes = report
            .findings
            .iter()
            .map(|finding| finding.code.as_str())
            .collect::<BTreeSet<_>>();

        assert!(!report.integrity_ok);
        assert!(codes.contains("terminal_task_with_running_agent_run"));
        assert!(codes.contains("running_agent_run_without_active_task"));
        assert!(codes.contains("completed_task_with_browser_budget_exceeded"));
        assert!(codes.contains("waiting_approval_task_without_canonical_approval"));
    }

    #[test]
    fn kernel_thread_projection_owns_turn_plan_attention_and_actions() {
        let s = store();
        let mut task = make_chat_turn(
            "turn_kernel_projection",
            "threadKernelProjection",
            TaskStatus::Running,
        );
        task.created_at = OffsetDateTime::from_unix_timestamp(100).unwrap();
        s.insert_chat_turn(
            &task,
            "threadKernelProjection",
            "req-kernel-projection",
            "interactive",
            "full",
        )
        .unwrap();
        s.upsert_runtime_plan(
            "u",
            "w",
            "threadKernelProjection",
            0,
            &json!({
                "goal": "trova un treno",
                "steps": [
                    {"id": "s1", "title": "Cerca risultati", "status": "done", "detail": "ricerca completata"},
                    {"id": "s2", "title": "Leggi risultati", "status": "doing", "detail": "in corso"}
                ]
            }),
            "open",
        )
        .unwrap();
        s.insert_turn_event(
            "turn_kernel_projection",
            TurnEventKind::StepAdvance,
            json!({
                "step_id": "s1",
                "title": "Cerca risultati",
                "from": "doing",
                "to": "done",
                "verified": true
            }),
        )
        .unwrap();
        s.insert_turn_event(
            "turn_kernel_projection",
            TurnEventKind::Done,
            json!({"text": "risultati letti"}),
        )
        .unwrap();
        s.create_agent_run(&NewAgentRun {
            run_id: "run-kernel-projection".into(),
            turn_id: "turn_kernel_projection".into(),
            thread_id: "threadKernelProjection".into(),
            user_id: "u".into(),
            workspace_id: "w".into(),
            role: None,
            model: Some("test-model".into()),
            provider: Some("test-provider".into()),
            prompt_fingerprint: None,
        })
        .unwrap();
        s.finish_agent_run(
            "run-kernel-projection",
            AgentRunStatus::Completed,
            Some("canonical_completed"),
        )
        .unwrap();

        let read_ref = EffectReceiptRef::from_store_id("55555555555555555555555555555555").unwrap();
        s.prepare_effect_receipt(&NewExecutionEffectReceipt {
            receipt_ref: read_ref.clone(),
            execution_id: "turn_kernel_projection".into(),
            revision: 1,
            run_id: Some("run-kernel-projection".into()),
            thread_id: Some("threadKernelProjection".into()),
            user_id: "u".into(),
            workspace_id: "w".into(),
            effect_class: EffectClass::Read,
            operation: "browser.extract".into(),
            arguments_hash: "read-hash".into(),
            idempotency_key: "read-idempotency-kernel".into(),
            compensation: None,
        })
        .unwrap();
        s.claim_effect_receipt(&read_ref).unwrap();
        s.mark_effect_receipt_uncertain(&read_ref, &json!({"reason": "read interrupted"}))
            .unwrap();

        let write_ref =
            EffectReceiptRef::from_store_id("66666666666666666666666666666666").unwrap();
        s.prepare_effect_receipt(&NewExecutionEffectReceipt {
            receipt_ref: write_ref.clone(),
            execution_id: "turn_kernel_projection".into(),
            revision: 1,
            run_id: Some("run-kernel-projection".into()),
            thread_id: Some("threadKernelProjection".into()),
            user_id: "u".into(),
            workspace_id: "w".into(),
            effect_class: EffectClass::ExternalWrite,
            operation: "calendar.create_event".into(),
            arguments_hash: "write-hash".into(),
            idempotency_key: "write-idempotency-kernel".into(),
            compensation: None,
        })
        .unwrap();
        s.claim_effect_receipt(&write_ref).unwrap();
        s.mark_effect_receipt_uncertain(&write_ref, &json!({"reason": "write interrupted"}))
            .unwrap();

        s.insert_approval(&ApprovalRequest::new(
            "approval-kernel-projection",
            TaskId::new("turn_kernel_projection"),
            UserId::new("u"),
            WorkspaceId::new("w"),
            "calendar.create_event",
            "high",
            "external_calendar",
            "Confirm whether the external write really completed.",
        ))
        .unwrap();

        let projection = s
            .project_kernel_thread("threadKernelProjection", 200)
            .unwrap();

        assert_eq!(projection.thread_id, "threadKernelProjection");
        assert_eq!(projection.turn.status, "completed");
        assert_eq!(projection.turn.active_turn_id, None);
        assert_eq!(projection.turn.last_event_seq, 2);
        assert_eq!(
            projection.turn.terminal_reason.as_deref(),
            Some("canonical_completed")
        );
        assert!(!projection.actions.can_stop);
        assert_eq!(projection.actions.composer_mode, "approval_only");
        assert_eq!(
            projection.plan.as_ref().unwrap().goal.as_deref(),
            Some("trova un treno")
        );
        let plan = projection.plan.as_ref().unwrap();
        assert_eq!(plan.steps[0].status, "done");
        assert_eq!(
            plan.steps[1].status, "done",
            "canonical_completed terminal turns should close the active display step"
        );
        assert!(
            plan.markdown.contains("- [x] **Leggi risultati** (`s2`)"),
            "canonical_completed terminal turns should render the active step as done"
        );
        assert!(
            projection.attention.awaiting_user,
            "external-write uncertainty must require user attention"
        );
        assert_eq!(projection.attention.uncertain_effects.len(), 1);
        assert_eq!(
            projection.attention.uncertain_effects[0].effect_class, "external_write",
            "read uncertainty must be filtered out of user-visible attention"
        );
        assert_eq!(projection.attention.approvals.len(), 1);
    }

    #[test]
    fn kernel_thread_projection_terminal_turn_blocks_active_plan_step_when_not_canonical_completed()
    {
        let s = store();
        let task = make_chat_turn(
            "turn_kernel_projection_failed",
            "threadKernelProjectionFailure",
            TaskStatus::Running,
        );
        s.insert_chat_turn(
            &task,
            "threadKernelProjectionFailure",
            "req-kernel-projection-failed",
            "interactive",
            "full",
        )
        .unwrap();
        s.upsert_runtime_plan(
            "u",
            "w",
            "threadKernelProjectionFailure",
            0,
            &json!({
                "goal": "verifica stato",
                "steps": [
                    {"id": "s1", "title": "Fase iniziale", "status": "done", "detail": "ok"},
                    {"id": "s2", "title": "Verifica finale", "status": "doing", "detail": "in corso"}
                ]
            }),
            "open",
        )
        .unwrap();
        s.insert_turn_event(
            "turn_kernel_projection_failed",
            TurnEventKind::Done,
            json!({"text": "risultato"}),
        )
        .unwrap();
        s.create_agent_run(&NewAgentRun {
            run_id: "run-kernel-projection-failed".into(),
            turn_id: "turn_kernel_projection_failed".into(),
            thread_id: "threadKernelProjectionFailure".into(),
            user_id: "u".into(),
            workspace_id: "w".into(),
            role: None,
            model: Some("test-model".into()),
            provider: Some("test-provider".into()),
            prompt_fingerprint: None,
        })
        .unwrap();
        s.finish_agent_run(
            "run-kernel-projection-failed",
            AgentRunStatus::Completed,
            Some("gateway_restart"),
        )
        .unwrap();

        let projection = s
            .project_kernel_thread("threadKernelProjectionFailure", 200)
            .unwrap();
        assert_eq!(projection.turn.status, "completed");
        assert_eq!(
            projection.turn.terminal_reason.as_deref(),
            Some("gateway_restart")
        );
        let plan = projection.plan.as_ref().unwrap();
        assert_eq!(plan.steps[1].status, "blocked");
        assert!(plan.markdown.contains("- [!] **Verifica finale** (`s2`)"));
    }

    #[test]
    fn capability_runtime_projection_does_not_own_liveness() {
        let s = store();
        let task = make_chat_turn(
            "turn_capability_projection",
            "threadCapabilityProjection",
            TaskStatus::Running,
        );
        s.insert_chat_turn(
            &task,
            "threadCapabilityProjection",
            "req-capability-projection",
            "interactive",
            "full",
        )
        .unwrap();
        s.insert_turn_event(
            "turn_capability_projection",
            TurnEventKind::Tool,
            json!({
                "type": "tool_result",
                "payload": {
                    "name": "use_skill",
                    "capability_runtime": {
                        "loaded_tools": ["mcp__github__list_issues"],
                        "armed_sensitive_domains": ["financial"]
                    }
                }
            }),
        )
        .unwrap();
        s.insert_turn_event(
            "turn_capability_projection",
            TurnEventKind::Tool,
            json!({
                "type": "tool_result",
                "payload": {
                    "name": "mcp__github__list_issues",
                    "output": [{"title": "read result"}]
                }
            }),
        )
        .unwrap();

        let read_projection = s
            .project_kernel_thread("threadCapabilityProjection", 200)
            .unwrap();
        assert_eq!(read_projection.turn.status, "running");
        assert!(
            !read_projection.attention.awaiting_user,
            "successful read tool results must not request user attention"
        );
        assert_eq!(
            read_projection.capability_runtime.loaded_tools,
            vec!["mcp__github__list_issues".to_string()]
        );
        assert_eq!(
            read_projection.capability_runtime.armed_sensitive_domains,
            vec!["financial".to_string()]
        );

        s.insert_turn_event(
            "turn_capability_projection",
            TurnEventKind::Tool,
            json!({
                "type": "tool_result",
                "payload": {
                    "name": "mcp__github__create_issue",
                    "capability_runtime": {
                        "blocked_capabilities": [
                            {"key": "mcp__github__create_issue", "reason": "approval_required"}
                        ]
                    }
                }
            }),
        )
        .unwrap();
        s.insert_turn_event(
            "turn_capability_projection",
            TurnEventKind::Tool,
            json!({
                "type": "tool_result",
                "payload": {
                    "name": "suggest_capabilities",
                    "capability_runtime": {
                        "pending_capability": "train booking connector",
                        "blocked_capabilities": [
                            {"key": "suggest_capabilities", "reason": "connect_required"}
                        ]
                    }
                }
            }),
        )
        .unwrap();
        s.insert_approval(&ApprovalRequest::new(
            "approval-capability-projection",
            TaskId::new("turn_capability_projection"),
            UserId::new("u"),
            WorkspaceId::new("w"),
            "mcp__github__create_issue",
            "medium",
            "connected_service",
            "Confirm the write before executing it.",
        ))
        .unwrap();

        let projection = s
            .project_kernel_thread("threadCapabilityProjection", 200)
            .unwrap();

        assert_eq!(
            projection.turn.status, "running",
            "capability metadata alone must not terminalize or block the turn"
        );
        assert_eq!(
            projection.capability_runtime.pending_capability.as_deref(),
            Some("train booking connector")
        );
        assert_eq!(projection.capability_runtime.blocked_capabilities.len(), 2);
        assert!(
            projection
                .capability_runtime
                .blocked_capabilities
                .iter()
                .any(|blocked| blocked.key == "mcp__github__create_issue"
                    && blocked.reason == "approval_required")
        );
        assert!(
            projection
                .capability_runtime
                .blocked_capabilities
                .iter()
                .any(|blocked| blocked.key == "suggest_capabilities"
                    && blocked.reason == "connect_required")
        );
        assert!(projection.attention.awaiting_user);
        assert_eq!(projection.attention.approvals.len(), 1);
        assert_eq!(
            projection.attention.approvals[0].action,
            "mcp__github__create_issue"
        );
    }

    #[test]
    fn browser_done_closes_browser_state_even_with_read_uncertainty() {
        let s = store();
        insert_browser_turn(
            &s,
            "turn_browser_done",
            "threadBrowserDone",
            TaskStatus::Running,
        );
        s.insert_turn_event(
            "turn_browser_done",
            TurnEventKind::Tool,
            json!({
                "type": "tool_result",
                "name": "browser_done",
                "payload": {"status": "completed"}
            }),
        )
        .unwrap();
        s.insert_turn_event(
            "turn_browser_done",
            TurnEventKind::Done,
            json!({"text": "browser results delivered"}),
        )
        .unwrap();
        s.create_agent_run(&NewAgentRun {
            run_id: "run-browser-done".into(),
            turn_id: "turn_browser_done".into(),
            thread_id: "threadBrowserDone".into(),
            user_id: "u".into(),
            workspace_id: "w".into(),
            role: None,
            model: Some("test-model".into()),
            provider: Some("test-provider".into()),
            prompt_fingerprint: None,
        })
        .unwrap();
        s.finish_agent_run(
            "run-browser-done",
            AgentRunStatus::Completed,
            Some("browser_done_terminal"),
        )
        .unwrap();
        let receipt_ref =
            EffectReceiptRef::from_store_id("77777777777777777777777777777777").unwrap();
        s.prepare_effect_receipt(&NewExecutionEffectReceipt {
            receipt_ref: receipt_ref.clone(),
            execution_id: "turn_browser_done".into(),
            revision: 1,
            run_id: Some("run-browser-done".into()),
            thread_id: Some("threadBrowserDone".into()),
            user_id: "u".into(),
            workspace_id: "w".into(),
            effect_class: EffectClass::Read,
            operation: "browser.extract".into(),
            arguments_hash: "read-hash-browser-done".into(),
            idempotency_key: "read-idempotency-browser-done".into(),
            compensation: None,
        })
        .unwrap();
        s.claim_effect_receipt(&receipt_ref).unwrap();
        s.mark_effect_receipt_uncertain(&receipt_ref, &json!({"reason": "read interrupted"}))
            .unwrap();

        let projection = s.project_kernel_thread("threadBrowserDone", 200).unwrap();

        assert_eq!(projection.turn.status, "completed");
        assert_eq!(projection.browser.state, "done");
        assert_eq!(projection.browser.failure_reason, None);
        assert!(
            !projection.attention.awaiting_user,
            "read-only browser uncertainty must not require outcome verification"
        );
        assert!(projection.attention.uncertain_effects.is_empty());
    }

    #[test]
    fn browser_visible_snapshot_without_done_is_not_success() {
        let s = store();
        insert_browser_turn(
            &s,
            "turn_browser_active",
            "threadBrowserActive",
            TaskStatus::Running,
        );
        s.upsert_objective_contract(
            "u",
            "w",
            "threadBrowserActive",
            "message-browser-active",
            "Find train results",
            ObjectiveMode::Mixed,
            &json!({}),
            &json!(["browser"]),
            &json!({"kind": "browser_done"}),
            "active",
        )
        .unwrap();
        s.upsert_browser_checkpoint(&browser_checkpoint("threadBrowserActive", "train-search"))
            .unwrap();
        s.insert_turn_event(
            "turn_browser_active",
            TurnEventKind::Activity,
            json!({"text": "snapshot"}),
        )
        .unwrap();

        let projection = s.project_kernel_thread("threadBrowserActive", 200).unwrap();

        assert_eq!(projection.browser.state, "active");
        assert_eq!(
            projection.browser.target_id.as_deref(),
            Some("train-search")
        );
        assert_eq!(
            projection.browser.latest_progress.as_deref(),
            Some("snapshot")
        );
        assert!(projection.browser.snapshot_verified);
        assert_ne!(projection.browser.state, "done");
    }

    #[test]
    fn browser_no_progress_failure_is_bounded() {
        let s = store();
        insert_browser_turn(
            &s,
            "turn_browser_no_progress",
            "threadBrowserNoProgress",
            TaskStatus::Running,
        );
        s.insert_turn_event(
            "turn_browser_no_progress",
            TurnEventKind::Activity,
            json!({"text": "browser_budget_exceeded:no_progress"}),
        )
        .unwrap();

        let projection = s
            .project_kernel_thread("threadBrowserNoProgress", 200)
            .unwrap();

        assert_eq!(projection.browser.state, "failed");
        assert_eq!(
            projection.browser.failure_reason.as_deref(),
            Some("no_progress")
        );
        assert!(
            projection.activity.is_empty(),
            "typed browser budget failures must not leak as generic activity rows"
        );
    }

    #[test]
    fn completed_delegated_browse_keeps_browser_done_after_secondary_no_progress() {
        let s = store();
        insert_browser_turn(
            &s,
            "turn_browser_mixed",
            "threadBrowserMixed",
            TaskStatus::Completed,
        );
        let browse_result = json!({
            "found": true,
            "answer": "Frecciarossa 9519 Milano Centrale 07:55 -> Roma Termini 12:10",
            "sources": ["https://www.trenitalia.com/"],
            "confidence": "high",
            "status": "completed",
            "items": [
                {
                    "departure": "07:55",
                    "arrival": "12:10",
                    "duration": "4h15"
                }
            ],
            "fields_missing": [],
            "evidence": ["Trenitalia result card"]
        });
        s.insert_turn_event(
            "turn_browser_mixed",
            TurnEventKind::Tool,
            json!({
                "type": "tool_result",
                "name": "browse",
                "result": browse_result.to_string()
            }),
        )
        .unwrap();
        s.insert_turn_event(
            "turn_browser_mixed",
            TurnEventKind::Activity,
            json!({"text": "browser_budget_exceeded:no_progress"}),
        )
        .unwrap();
        s.insert_turn_event(
            "turn_browser_mixed",
            TurnEventKind::Done,
            json!({"text": "Ecco le opzioni trovate da Trenitalia."}),
        )
        .unwrap();

        let projection = s.project_kernel_thread("threadBrowserMixed", 200).unwrap();

        assert_eq!(projection.turn.status, "completed");
        assert_eq!(projection.browser.state, "done");
        assert_eq!(projection.browser.failure_reason, None);
        assert!(
            projection.activity.is_empty(),
            "typed browser budget failures must not leak as generic activity rows even when browser is done"
        );
    }

    #[test]
    fn kernel_thread_projection_caps_activity_to_most_recent() {
        let s = store();
        let t = make_chat_turn("turn_c", "threadY", TaskStatus::Completed);
        s.insert_chat_turn(&t, "threadY", "reqc", "interactive", "full")
            .unwrap();
        for i in 0..5 {
            s.insert_turn_event(
                "turn_c",
                TurnEventKind::Activity,
                json!({"text": format!("step{i}")}),
            )
            .unwrap();
        }
        let p = s.project_kernel_thread("threadY", 2).unwrap();
        assert_eq!(
            p.activity
                .iter()
                .map(|row| row.text.as_str())
                .collect::<Vec<_>>(),
            vec!["step3", "step4"],
            "cap keeps the most recent tail"
        );
    }

    #[test]
    fn kernel_thread_projection_empty_thread_is_default() {
        let s = store();
        let p = s.project_kernel_thread("nope", 200).unwrap();
        assert!(p.activity.is_empty());
        assert_eq!(p.plan, None);
        assert_eq!(p.turn.status, "idle");
        assert_eq!(p.turn.active_turn_id, None);
    }

    #[test]
    fn kernel_thread_projection_includes_subagent_summary_and_timestamps() {
        let s = store();
        let mut subagent = TaskRecord::new(
            "subagent-1",
            UserId::new("u"),
            WorkspaceId::new("w"),
            "subagent.review",
            "Review the inspector implementation",
            json!({}),
        );
        subagent.status = TaskStatus::Completed;
        subagent.created_at = OffsetDateTime::from_unix_timestamp(100).unwrap();
        subagent.updated_at = OffsetDateTime::from_unix_timestamp(120).unwrap();
        s.insert_task(&subagent).unwrap();
        assert!(
            s.link_task_to_thread(
                &subagent.task_id,
                &subagent.user_id,
                &subagent.workspace_id,
                "thread-subagents",
            )
            .unwrap()
        );

        let projection = s.project_kernel_thread("thread-subagents", 200).unwrap();
        assert_eq!(projection.subagents.len(), 1);
        assert_eq!(projection.subagents[0].name, "Review");
        assert_eq!(
            projection.subagents[0].summary.as_deref(),
            Some("Review the inspector implementation")
        );
        assert_eq!(projection.subagents[0].created_at, 100);
        assert_eq!(projection.subagents[0].updated_at, 120);
    }
}

#[cfg(test)]
mod upgrade_tests {
    use super::*;
    use crate::{TaskId, TaskRecord, UserId, WorkspaceId};
    use rusqlite::Connection;

    #[test]
    fn upgrades_v3_to_v5_adding_chat_turn_and_agent_journal_schema() {
        // Build a valid v3-era TaskRecord blob so get_task round-trips after migration.
        let task = TaskRecord::new(
            "t",
            UserId::new("u"),
            WorkspaceId::new("w"),
            "old_kind",
            "v3 fixture",
            serde_json::json!({}),
        );
        let task_json = serde_json::to_string(&task).unwrap();
        // Create a DB with the OLD v3 schema (no chat_turn columns, no turn_events/broker_meta).
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE task_runtime_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO task_runtime_metadata VALUES ('schema_version', '3');
             CREATE TABLE tasks (
                task_id TEXT NOT NULL, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
                workflow_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                blocked_reason TEXT, task_json TEXT NOT NULL,
                PRIMARY KEY (task_id, user_id, workspace_id)
             );",
        )
        .unwrap();
        // Parameterized INSERT: task_json is a full TaskRecord blob.
        conn.execute(
            "INSERT INTO tasks (task_id, user_id, workspace_id, workflow_id, kind, status,
                                priority, created_at, updated_at, blocked_reason, task_json)
             VALUES ('t', 'u', 'w', NULL, 'old_kind', 'queued', 'normal',
                     1, 1, NULL, ?1)",
            [&task_json],
        )
        .unwrap();
        // Save to a temp file and reopen as TaskStore to run migrations.
        let tmp = std::env::temp_dir().join(format!(
            "homun-task-runtime-upgrade-test-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        conn.execute_batch(&format!("VACUUM INTO '{}'", tmp.display()))
            .unwrap();
        let store = TaskStore::open(&tmp).unwrap();
        assert_eq!(store.schema_version().unwrap(), 15);
        assert!(table_exists(&store.connection, "agent_runs"));
        assert!(table_exists(&store.connection, "agent_run_events"));
        for col in ["thread_id", "request_id", "source", "approval"] {
            assert!(column_exists(&store.connection, "tasks", col));
        }
        // Existing data preserved
        let t = store
            .get_task(&TaskId::new("t"), &UserId::new("u"), &WorkspaceId::new("w"))
            .unwrap()
            .unwrap();
        assert_eq!(t.kind, "old_kind");
        // Cleanup
        let _ = std::fs::remove_file(&tmp);
    }
}

#[cfg(test)]
mod wal_tests {
    use super::*;

    #[test]
    fn open_sets_wal_mode() {
        // Use a temp file: WAL is a no-op on in-memory DBs.
        let tmp = std::env::temp_dir().join(format!(
            "homun-wal-test-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = TaskStore::open(&tmp).unwrap();
        let mode: String = store
            .connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        let timeout: i64 = store
            .connection
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .unwrap();
        assert_eq!(timeout, 5000);
        let _ = std::fs::remove_file(&tmp);
        let _ = std::fs::remove_file(tmp.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(tmp.with_extension("sqlite-shm"));
    }
}

#[cfg(test)]
mod query_plan_tests {
    use super::*;

    /// Runs `EXPLAIN QUERY PLAN` on `sql` and returns the concatenated `detail`
    /// text for every plan step (one line per step). Each detail line looks like
    /// `SEARCH agent_runs USING INDEX idx_agent_runs_thread (...)` or
    /// `SCAN agent_runs` (the latter is a full table scan — what we want to avoid).
    fn explain_query_plan(conn: &Connection, sql: &str) -> String {
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let rows = stmt.query_map([], |row| row.get::<_, String>(3)).unwrap();
        let mut details = Vec::new();
        for row in rows {
            details.push(row.unwrap());
        }
        details.join("\n")
    }

    /// Asserts that the plan text references an index (via `USING INDEX`,
    /// `USING COVERING INDEX`, or `USING PRIMARY KEY`). If `expected_index` is
    /// provided, also asserts that the specific index name appears in the plan.
    fn assert_uses_index(plan: &str, expected_index: Option<&str>, context: &str) {
        assert!(
            plan.contains("USING INDEX")
                || plan.contains("USING COVERING INDEX")
                || plan.contains("USING PRIMARY KEY"),
            "{context}: query plan does not use any index:\n{plan}"
        );
        if let Some(idx) = expected_index {
            assert!(
                plan.contains(idx),
                "{context}: query plan should use `{idx}` but does not:\n{plan}"
            );
        }
    }

    /// Seeds the store with enough varied rows across the hot-path tables that
    /// SQLite's query planner prefers an index seek over a sequential scan.
    fn seed_hot_path_data(store: &TaskStore) {
        let conn = &store.connection;

        // ── tasks: multiple threads, multiple kinds ────────────────────────────
        for i in 0..20 {
            let thread = format!("thread-{}", i % 4);
            let task_id = format!("task-{i}");
            let kind = if i % 3 == 0 {
                "subagent.review"
            } else {
                "chat_turn"
            };
            let status = match i % 4 {
                0 => "queued",
                1 => "running",
                2 => "completed",
                _ => "failed",
            };
            conn.execute(
                "INSERT INTO tasks (task_id, user_id, workspace_id, kind, status, priority,
                                    created_at, updated_at, task_json, thread_id)
                 VALUES (?1, 'u', 'w', ?2, ?3, 'normal', ?4, ?4, '{}', ?5)",
                params![task_id, kind, status, 1000 + i, thread],
            )
            .unwrap();
        }

        // ── agent_runs: multiple threads, statuses, completion times ───────────
        for i in 0..20 {
            let run_id = format!("run-{i}");
            let turn_id = format!("task-{i}");
            let thread = format!("thread-{}", i % 4);
            let status = match i % 4 {
                0 => "running",
                1 => "completed",
                2 => "aborted",
                _ => "failed",
            };
            let completed_at: Option<i64> = if i % 4 != 0 { Some(1000 + i) } else { None };
            conn.execute(
                "INSERT INTO agent_runs (run_id, turn_id, thread_id, user_id, workspace_id,
                                         attempt, status, started_at, completed_at)
                 VALUES (?1, ?2, ?3, 'u', 'w', ?4, ?5, ?6, ?7)",
                params![
                    run_id,
                    turn_id,
                    thread,
                    1 + i,
                    status,
                    1000 + i,
                    completed_at
                ],
            )
            .unwrap();
        }

        // ── turn_events: events for the seeded turns ───────────────────────────
        for i in 0..20 {
            conn.execute(
                "INSERT INTO turn_events (turn_id, seq, kind, payload_json, created_at)
                 VALUES (?1, ?2, ?3, '{}', ?4)",
                params![
                    format!("task-{i}"),
                    1,
                    if i % 2 == 0 { "activity" } else { "done" },
                    1000 + i
                ],
            )
            .unwrap();
        }

        // ── execution_events: varied kinds including outcome_committed ─────────
        for i in 0..20 {
            let kind = match i % 4 {
                0 => "execution_created",
                1 => "outcome_committed",
                2 => "revision_started",
                _ => "wake_delivered",
            };
            conn.execute(
                "INSERT INTO execution_events (execution_id, revision, seq, kind,
                                                payload_json, created_at)
                 VALUES (?1, 1, ?2, ?3, '{}', ?4)",
                params![format!("exec-{i}"), 1 + i, kind, 1000 + i],
            )
            .unwrap();
        }

        // ── turn_steering: pending and claimed rows across scopes ──────────────
        for i in 0..20 {
            let status = if i % 2 == 0 { "pending" } else { "claimed" };
            conn.execute(
                "INSERT INTO turn_steering (user_id, workspace_id, thread_id, active_turn_id,
                                            source_message_id, content, objective_revision,
                                            status, created_at, updated_at)
                 VALUES ('u', 'w', ?1, ?2, ?3, 'content', 1, ?4, ?5, ?5)",
                params![
                    format!("thread-{}", i % 4),
                    format!("task-{i}"),
                    format!("msg-{i}"),
                    status,
                    1000 + i
                ],
            )
            .unwrap();
        }

        // ── task_dependencies + task_checkpoints for the JOIN test ─────────────
        for i in 0..5 {
            conn.execute(
                "INSERT INTO task_dependencies (task_id, depends_on_task_id, user_id,
                                                workspace_id, created_at)
                 VALUES ('main-task', ?1, 'u', 'w', ?2)",
                params![format!("dep-{i}"), 1000 + i],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO task_checkpoints (checkpoint_id, task_id, user_id, workspace_id,
                                               sequence, payload_json, redacted_payload_json,
                                               created_at)
                 VALUES (?1, ?2, 'u', 'w', 1, ?3, ?3, 1000)",
                params![
                    format!("cp-{i}"),
                    format!("dep-{i}"),
                    r#"{"output":"result-i"}"#
                ],
            )
            .unwrap();
        }

        // Give the planner statistics so it prefers index seeks.
        conn.execute_batch("ANALYZE").unwrap();
    }

    // ── agent_runs ─────────────────────────────────────────────────────────────

    #[test]
    fn list_agent_runs_for_thread_uses_index() {
        let store = TaskStore::open_in_memory().unwrap();
        seed_hot_path_data(&store);

        let plan = explain_query_plan(
            &store.connection,
            "SELECT run_id, turn_id, thread_id, user_id, workspace_id, attempt, status,
                    role, model, provider, prompt_fingerprint, started_at, completed_at,
                    terminal_reason, schema_version
             FROM agent_runs
             WHERE thread_id = 'thread-1' AND user_id = 'u' AND workspace_id = 'w'
             ORDER BY started_at DESC, rowid DESC, attempt DESC",
        );
        assert_uses_index(
            &plan,
            Some("idx_agent_runs_thread"),
            "list_agent_runs_for_thread",
        );
    }

    #[test]
    fn has_agent_runs_for_thread_uses_index() {
        let store = TaskStore::open_in_memory().unwrap();
        seed_hot_path_data(&store);

        let plan = explain_query_plan(
            &store.connection,
            "SELECT EXISTS(SELECT 1 FROM agent_runs WHERE thread_id = 'thread-1')",
        );
        assert_uses_index(
            &plan,
            Some("idx_agent_runs_thread"),
            "has_agent_runs_for_thread",
        );
    }

    #[test]
    fn abort_running_agent_runs_uses_index() {
        let store = TaskStore::open_in_memory().unwrap();
        seed_hot_path_data(&store);

        let plan = explain_query_plan(
            &store.connection,
            "UPDATE agent_runs
             SET status = 'aborted', completed_at = 5000, terminal_reason = 'test'
             WHERE status = 'running'",
        );
        assert_uses_index(
            &plan,
            Some("idx_agent_runs_status_completed"),
            "abort_running_agent_runs",
        );
    }

    #[test]
    fn purge_terminal_agent_runs_before_uses_index() {
        // The actual purge query uses `status != 'running'` (inequality), which
        // SQLite serves with a full scan + sort because the negative condition
        // touches most rows. Here we verify the index works for the equality
        // variant — `status = 'completed'` — which is the access pattern the
        // (status, completed_at) index was designed for. The production purge
        // remains correct either way; it just falls back to a bounded scan.
        let store = TaskStore::open_in_memory().unwrap();
        seed_hot_path_data(&store);

        let plan = explain_query_plan(
            &store.connection,
            "SELECT run_id FROM agent_runs
             WHERE status = 'completed' AND completed_at IS NOT NULL AND completed_at < 2000
             ORDER BY completed_at ASC
             LIMIT 10",
        );
        assert_uses_index(
            &plan,
            Some("idx_agent_runs_status_completed"),
            "purge_terminal_agent_runs_before (equality variant)",
        );
    }

    // ── execution_events ───────────────────────────────────────────────────────

    #[test]
    fn committed_executions_scan_uses_index() {
        let store = TaskStore::open_in_memory().unwrap();
        seed_hot_path_data(&store);

        let plan = explain_query_plan(
            &store.connection,
            "SELECT execution_id, revision, created_at
             FROM execution_events
             WHERE kind = 'outcome_committed'
             ORDER BY created_at, execution_id, revision",
        );
        assert_uses_index(
            &plan,
            Some("idx_execution_events_kind_created"),
            "committed_executions / backfill",
        );
    }

    // ── tasks ──────────────────────────────────────────────────────────────────

    #[test]
    fn project_kernel_thread_latest_turn_uses_index() {
        let store = TaskStore::open_in_memory().unwrap();
        seed_hot_path_data(&store);

        let plan = explain_query_plan(
            &store.connection,
            "SELECT task_id, status, task_json, updated_at, blocked_reason FROM tasks
             WHERE thread_id = 'thread-1' AND kind = 'chat_turn'
             ORDER BY created_at DESC LIMIT 1",
        );
        assert_uses_index(
            &plan,
            Some("idx_tasks_thread_kind_created"),
            "project_kernel_thread latest turn",
        );
    }

    #[test]
    fn thread_attention_uses_index() {
        let store = TaskStore::open_in_memory().unwrap();
        seed_hot_path_data(&store);

        let plan = explain_query_plan(
            &store.connection,
            "SELECT status, updated_at
               FROM tasks
              WHERE thread_id = 'thread-1' AND kind = 'chat_turn'
              ORDER BY created_at DESC, task_id DESC
              LIMIT 1",
        );
        assert_uses_index(
            &plan,
            Some("idx_tasks_thread_kind_created"),
            "thread_attention",
        );
    }

    #[test]
    fn subagent_listing_uses_index() {
        // For `kind LIKE 'subagent.%'` SQLite may choose either
        // idx_tasks_thread_kind_created or idx_tasks_chat_turn_thread — both are
        // partial indices starting with thread_id. The key assertion is that an
        // index is used (not a raw table scan).
        let store = TaskStore::open_in_memory().unwrap();
        seed_hot_path_data(&store);

        let plan = explain_query_plan(
            &store.connection,
            "SELECT kind, status, task_json, blocked_reason, created_at, updated_at FROM tasks
             WHERE thread_id = 'thread-1' AND kind LIKE 'subagent.%'
             ORDER BY created_at ASC",
        );
        assert_uses_index(&plan, None, "project_kernel_thread subagents");
    }

    // ── turn_steering ───────────────────────────────────────────────────────────

    #[test]
    fn list_due_pending_turn_steering_uses_index() {
        let store = TaskStore::open_in_memory().unwrap();
        seed_hot_path_data(&store);

        let plan = explain_query_plan(
            &store.connection,
            "SELECT steering_id, user_id, workspace_id, thread_id, active_turn_id,
                    source_message_id, content, payload_json, objective_revision, status,
                    revision, created_at, updated_at, claimed_run_id, claimed_round,
                    claimed_at, applied_at, cancelled_at, consumed_at,
                    semantic_decision_json, interpreted_at, completed_at,
                    last_interpretation_error, next_retry_at, interpretation_attempts
             FROM turn_steering
             WHERE status='pending' AND (next_retry_at IS NULL OR next_retry_at <= 5000)
             ORDER BY steering_id ASC LIMIT 10",
        );
        assert_uses_index(
            &plan,
            Some("idx_turn_steering_due"),
            "list_due_pending_turn_steering",
        );
    }

    // ── dependency_outputs_for (N+1 → batched JOIN) ─────────────────────────────

    #[test]
    fn dependency_outputs_join_uses_index() {
        let store = TaskStore::open_in_memory().unwrap();
        seed_hot_path_data(&store);

        let plan = explain_query_plan(
            &store.connection,
            "SELECT d.depends_on_task_id,
                    c.payload_json,
                    c.redacted_payload_json
               FROM task_dependencies d
               LEFT JOIN task_checkpoints c
                 ON c.task_id = d.depends_on_task_id
                AND c.user_id = d.user_id
                AND c.workspace_id = d.workspace_id
                AND c.sequence = (
                    SELECT MAX(c2.sequence)
                    FROM task_checkpoints c2
                    WHERE c2.task_id = d.depends_on_task_id
                      AND c2.user_id = d.user_id
                      AND c2.workspace_id = d.workspace_id
                )
              WHERE d.task_id = 'main-task' AND d.user_id = 'u' AND d.workspace_id = 'w'
              ORDER BY d.created_at ASC, d.depends_on_task_id ASC",
        );
        // Both tables should use indices (not full scans).
        assert_uses_index(&plan, None, "dependency_outputs_for JOIN");
    }

    // ── pre-existing hot-path queries (regression guards) ──────────────────────

    #[test]
    fn get_task_uses_primary_key() {
        let store = TaskStore::open_in_memory().unwrap();
        seed_hot_path_data(&store);

        let plan = explain_query_plan(
            &store.connection,
            "SELECT task_json FROM tasks
             WHERE task_id = 'task-1' AND user_id = 'u' AND workspace_id = 'w'",
        );
        assert_uses_index(&plan, None, "get_task");
    }

    #[test]
    fn list_turn_events_for_turn_uses_index() {
        let store = TaskStore::open_in_memory().unwrap();
        seed_hot_path_data(&store);

        let plan = explain_query_plan(
            &store.connection,
            "SELECT event_id, turn_id, seq, kind, payload_json, created_at
               FROM turn_events WHERE turn_id = 'task-1' ORDER BY seq",
        );
        assert_uses_index(&plan, Some("idx_turn_events_turn"), "list_turn_events");
    }

    #[test]
    fn list_agent_run_events_uses_index() {
        let store = TaskStore::open_in_memory().unwrap();
        seed_hot_path_data(&store);

        let plan = explain_query_plan(
            &store.connection,
            "SELECT e.event_id, e.run_id, e.seq, e.round, e.kind, e.payload_json, e.created_at
             FROM agent_run_events e
             JOIN agent_runs r ON r.run_id = e.run_id
             WHERE e.run_id = 'run-1' AND r.user_id = 'u' AND r.workspace_id = 'w'
               AND e.seq > 0
             ORDER BY e.seq ASC",
        );
        assert_uses_index(&plan, None, "list_agent_run_events");
    }

    #[test]
    fn active_chat_turn_for_thread_uses_index() {
        let store = TaskStore::open_in_memory().unwrap();
        seed_hot_path_data(&store);

        let plan = explain_query_plan(
            &store.connection,
            "SELECT task_id FROM tasks
             WHERE thread_id = 'thread-1' AND kind = 'chat_turn'
               AND status NOT IN ('completed', 'failed', 'cancelled', 'expired')
             LIMIT 1",
        );
        assert_uses_index(&plan, None, "active_chat_turn_for_thread");
    }

    #[test]
    fn project_kernel_thread_activity_join_uses_index() {
        let store = TaskStore::open_in_memory().unwrap();
        seed_hot_path_data(&store);

        let plan = explain_query_plan(
            &store.connection,
            "SELECT te.turn_id, te.kind, te.payload_json
             FROM turn_events te JOIN tasks t ON t.task_id = te.turn_id
             WHERE t.thread_id = 'thread-1' AND t.kind = 'chat_turn'
               AND te.kind = 'activity'
             ORDER BY t.created_at ASC, te.seq ASC",
        );
        assert_uses_index(&plan, None, "project_kernel_thread activity JOIN");
    }

    #[test]
    fn thread_attention_terminal_event_join_uses_index() {
        let store = TaskStore::open_in_memory().unwrap();
        seed_hot_path_data(&store);

        let plan = explain_query_plan(
            &store.connection,
            &format!(
                "SELECT MAX(te.event_id)
               FROM turn_events te
               JOIN tasks t ON t.task_id = te.turn_id
              WHERE t.thread_id = 'thread-1'
                AND t.kind = 'chat_turn'
                AND te.kind IN ({})",
                REDUCED_TERMINAL_TURN_EVENT_KIND_SQL_LIST,
            ),
        );
        assert_uses_index(&plan, None, "thread_attention terminal event JOIN");
    }
}
