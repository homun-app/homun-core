use crate::{
    AgentCheckpoint, AgentRun, AgentRunEvent, AgentRunStatus, AgentToolReceipt, ApprovalRequest,
    Automation, AutomationRun, NewAgentRun, NewAgentToolReceipt, ObjectiveContractRecord,
    ObjectiveMode, ResourceClass, RuntimePlanRecord, SubagentInfo, TaskCheckpoint, ToolReceiptClaim,
    TaskDependencyOutput, TaskId, TaskRecord, TaskRuntimeError, TaskRuntimeResult, TaskStatus,
    ActiveTurnProjection, NewTurnSteering, TerminalWrite, ThreadActivityProjection, ThreadAttention,
    TurnEvent, TurnEventKind,
    TurnSteeringRecord, TurnSteeringStatus, UserId, WorkspaceId,
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::Value;
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

pub struct TaskStore {
    connection: Connection,
}

fn insert_turn_event_on(
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

fn first_terminal_event_on(
    connection: &Connection,
    turn_id: &str,
) -> TaskRuntimeResult<Option<TurnEvent>> {
    let row = connection
        .query_row(
            "SELECT event_id, turn_id, seq, kind, payload_json, created_at
               FROM turn_events
              WHERE turn_id = ?1 AND kind IN ('done', 'error', 'cancelled')
              ORDER BY seq ASC
              LIMIT 1",
            params![turn_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            },
        )
        .optional()?;
    row.map(
        |(event_id, turn_id, seq, kind, payload_json, created_at)| {
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
        },
    )
    .transpose()
}

impl TaskStore {
    pub fn open(path: impl AsRef<Path>) -> TaskRuntimeResult<Self> {
        let store = Self {
            connection: Connection::open(path)?,
        };
        // WAL enables concurrent readers + serialized writers — required when two
        // stores (chat + task) point at the same file. busy_timeout avoids transient
        // SQLITE_BUSY when the other writer is mid-commit.
        store
            .connection
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;")?;
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

            CREATE TABLE IF NOT EXISTS agent_tool_receipts (
                turn_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                run_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                arguments_hash TEXT NOT NULL,
                status TEXT NOT NULL,
                result_json TEXT,
                effects_json TEXT,
                started_at INTEGER NOT NULL,
                completed_at INTEGER,
                PRIMARY KEY (turn_id, idempotency_key)
            );

            CREATE INDEX IF NOT EXISTS idx_agent_tool_receipts_scope
                ON agent_tool_receipts(user_id, workspace_id, thread_id, started_at DESC);

            CREATE TABLE IF NOT EXISTS broker_meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            INSERT INTO task_runtime_metadata(key, value)
            VALUES ('schema_version', '8')
            ON CONFLICT(key) DO UPDATE SET value = excluded.value;
            ",
        )?;

        // ── chat_turn columns (schema_version 4). Guarded: idempotent on existing DBs.
        // Indexed columns for chat turns. Remain NULL on non-chat_turn rows.
        let chat_turn_cols = ["thread_id", "request_id", "source", "approval"];
        for col in chat_turn_cols {
            if !column_exists(&self.connection, "tasks", col) {
                self.connection.execute(
                    &format!("ALTER TABLE tasks ADD COLUMN {col} TEXT"),
                    [],
                )?;
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
            "UPDATE task_runtime_metadata SET value = '10' WHERE key = 'schema_version'",
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
            "DELETE FROM objective_contracts WHERE user_id = ?1 AND workspace_id = ?2",
            rusqlite::params![user_id.as_str(), workspace_id.as_str()],
        )?;
        tx.execute(
            "DELETE FROM runtime_plans WHERE user_id = ?1 AND workspace_id = ?2",
            rusqlite::params![user_id.as_str(), workspace_id.as_str()],
        )?;
        tx.execute(
            "DELETE FROM agent_tool_receipts WHERE user_id = ?1 AND workspace_id = ?2",
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
        let record = load_runtime_plan_on(&tx, user_id, workspace_id, thread_id)?
            .ok_or_else(|| TaskRuntimeError::Store("runtime plan disappeared after upsert".into()))?;
        tx.commit()?;
        Ok(record)
    }

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
                revision = objective_contracts.revision + 1,
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
            .ok_or_else(|| TaskRuntimeError::Store("objective contract disappeared after upsert".into()))?;
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
                .query_map(params![user_id, workspace_id, thread_id, active_turn_id, now], map_turn_steering_row)?
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
            params![run_id, round as i64, now, user_id, workspace_id, thread_id, active_turn_id],
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
            user_id, workspace_id, thread_id, active_turn_id, "legacy", 0,
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
            .query_map(params![user_id, workspace_id, thread_id], map_turn_steering_row)?
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
            params![input.source_message_id, input.prompt, serde_json::to_string(input)?, now,
                steering_id, user_id, workspace_id, expected_revision as i64],
        )?;
        if changed == 0 { return Err(TaskRuntimeError::Conflict("steering changed or is no longer editable".into())); }
        self.load_turn_steering(steering_id, user_id, workspace_id)?.ok_or_else(|| TaskRuntimeError::NotFound("steering".into()))
    }

    pub fn cancel_turn_steering(
        &self, steering_id: i64, user_id: &str, workspace_id: &str, expected_revision: u64,
    ) -> TaskRuntimeResult<TurnSteeringRecord> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let changed = self.connection.execute(
            "UPDATE turn_steering SET status='cancelled', revision=revision+1,
                    cancelled_at=?1, updated_at=?1
             WHERE steering_id=?2 AND user_id=?3 AND workspace_id=?4 AND revision=?5
               AND status IN ('pending','held')",
            params![now, steering_id, user_id, workspace_id, expected_revision as i64],
        )?;
        if changed == 0 { return Err(TaskRuntimeError::Conflict("steering changed or is no longer cancellable".into())); }
        self.load_turn_steering(steering_id, user_id, workspace_id)?.ok_or_else(|| TaskRuntimeError::NotFound("steering".into()))
    }

    pub fn load_turn_steering(&self, steering_id: i64, user_id: &str, workspace_id: &str) -> TaskRuntimeResult<Option<TurnSteeringRecord>> {
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
        tx: &Transaction<'_>, steering_id: i64, user_id: &str, workspace_id: &str,
        expected_revision: u64,
    ) -> TaskRuntimeResult<TurnSteeringRecord> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let changed = tx.execute(
            "UPDATE turn_steering SET status='promoted', revision=revision+1, updated_at=?1
             WHERE steering_id=?2 AND user_id=?3 AND workspace_id=?4 AND revision=?5 AND status='held'",
            params![now, steering_id, user_id, workspace_id, expected_revision as i64],
        )?;
        if changed == 0 { return Err(TaskRuntimeError::Conflict("held steering changed".into())); }
        load_turn_steering_by_id_on(tx, steering_id, user_id, workspace_id)?.ok_or_else(|| TaskRuntimeError::NotFound("steering".into()))
    }

    pub fn current_turn_steering(&self, steering_id: i64, user_id: &str, workspace_id: &str) -> TaskRuntimeResult<Option<TurnSteeringRecord>> {
        self.load_turn_steering(steering_id, user_id, workspace_id)
    }

    pub fn workspace_for_turn_steering(&self, steering_id: i64, user_id: &str) -> TaskRuntimeResult<Option<String>> {
        self.connection.query_row(
            "SELECT workspace_id FROM turn_steering WHERE steering_id=?1 AND user_id=?2",
            params![steering_id, user_id], |row| row.get(0),
        ).optional().map_err(Into::into)
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
            params![serde_json::to_string(semantic_decision_json)?, now, steering_id, expected_revision as i64, run_id],
        )?;
        if changed == 0 {
            return Err(TaskRuntimeError::Conflict("steering changed before interpretation".into()));
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
            steering_id, expected_revision, run_id, "interpreted", "applied", "applied_at",
        )
    }

    pub fn mark_turn_steering_completed(
        &self,
        steering_id: i64,
        expected_revision: u64,
        run_id: &str,
    ) -> TaskRuntimeResult<TurnSteeringRecord> {
        self.transition_interpreted_steering(
            steering_id, expected_revision, run_id, "applied", "completed", "completed_at",
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
            params![to_status, now, steering_id, expected_revision as i64, from_status, run_id],
        )?;
        if changed == 0 {
            return Err(TaskRuntimeError::Conflict(format!("steering changed before transition to {to_status}")));
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
            params![error, next_retry_at, now, steering_id, expected_revision as i64],
        )?;
        if changed == 0 {
            return Err(TaskRuntimeError::Conflict("steering changed before retry release".into()));
        }
        load_turn_steering_unscoped_by_id(&self.connection, steering_id)?
            .ok_or_else(|| TaskRuntimeError::NotFound("steering".into()))
    }

    pub fn hold_pending_turn_steering(&self, user_id: &str, workspace_id: &str, active_turn_id: &str) -> TaskRuntimeResult<usize> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        Ok(self.connection.execute(
            "UPDATE turn_steering SET status='held', revision=revision+1, updated_at=?1
             WHERE user_id=?2 AND workspace_id=?3 AND active_turn_id=?4
               AND status IN ('pending','claimed','interpreted')",
            params![now, user_id, workspace_id, active_turn_id],
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
            params![OffsetDateTime::now_utc().unix_timestamp(), active_turn_id, user_id, workspace_id],
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
                checkpoint_id, run_id, turn_id, thread_id, user_id, workspace_id,
                round as i64, serde_json::to_string(state)?, fingerprint,
                if resumable { 1 } else { 0 }, created_at,
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
                   AND r.terminal_reason = 'gateway_restart'
                 ORDER BY c.created_at DESC, c.round DESC
                 LIMIT 1",
                params![turn_id, user_id, workspace_id],
                |row| {
                    let state_json: String = row.get(7)?;
                    Ok((
                        row.get::<_, String>(0)?, row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?, row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?, row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?, state_json,
                        row.get::<_, String>(8)?, row.get::<_, i64>(9)?,
                        row.get::<_, i64>(10)?,
                    ))
                },
            )
            .optional()?
            .map(|(checkpoint_id, run_id, turn_id, thread_id, user_id, workspace_id,
                   round, state_json, fingerprint, resumable, created_at)| {
                Ok(AgentCheckpoint {
                    checkpoint_id, run_id, turn_id, thread_id, user_id, workspace_id,
                    round: round as u32,
                    state_json: serde_json::from_str(&state_json)?, fingerprint,
                    resumable: resumable != 0, created_at,
                })
            })
            .transpose()
    }

    pub fn claim_tool_receipt(
        &self,
        new_receipt: &NewAgentToolReceipt,
    ) -> TaskRuntimeResult<ToolReceiptClaim> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO agent_tool_receipts (
                turn_id, idempotency_key, run_id, thread_id, user_id, workspace_id,
                tool_name, arguments_hash, status, started_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'started', ?9)",
            params![
                new_receipt.turn_id, new_receipt.idempotency_key, new_receipt.run_id,
                new_receipt.thread_id, new_receipt.user_id, new_receipt.workspace_id,
                new_receipt.tool_name, new_receipt.arguments_hash, now,
            ],
        )?;
        let receipt = load_tool_receipt_on(&tx, &new_receipt.turn_id, &new_receipt.idempotency_key)?
            .ok_or_else(|| TaskRuntimeError::Store("tool receipt disappeared after claim".into()))?;
        let claim = if inserted == 1 {
            ToolReceiptClaim::Execute
        } else if receipt.status == "completed" {
            ToolReceiptClaim::Replay(receipt)
        } else {
            ToolReceiptClaim::Uncertain(receipt)
        };
        tx.commit()?;
        Ok(claim)
    }

    pub fn complete_tool_receipt(
        &self,
        turn_id: &str,
        idempotency_key: &str,
        result: &Value,
        effects: &Value,
    ) -> TaskRuntimeResult<AgentToolReceipt> {
        let completed_at = OffsetDateTime::now_utc().unix_timestamp();
        let changed = self.connection.execute(
            "UPDATE agent_tool_receipts
             SET status = 'completed', result_json = ?1, effects_json = ?2, completed_at = ?3
             WHERE turn_id = ?4 AND idempotency_key = ?5 AND status = 'started'",
            params![serde_json::to_string(result)?, serde_json::to_string(effects)?,
                    completed_at, turn_id, idempotency_key],
        )?;
        if changed != 1 {
            return Err(TaskRuntimeError::Store("tool receipt is not claimable".into()));
        }
        load_tool_receipt_on(&self.connection, turn_id, idempotency_key)?
            .ok_or_else(|| TaskRuntimeError::Store("completed tool receipt disappeared".into()))
    }

    pub fn list_tool_receipts_for_thread(
        &self,
        thread_id: &str,
        user_id: &str,
        workspace_id: &str,
    ) -> TaskRuntimeResult<Vec<AgentToolReceipt>> {
        let mut stmt = self.connection.prepare(
            "SELECT turn_id, idempotency_key, run_id, thread_id, user_id, workspace_id,
                    tool_name, arguments_hash, status, result_json, effects_json,
                    started_at, completed_at
             FROM agent_tool_receipts
             WHERE thread_id = ?1 AND user_id = ?2 AND workspace_id = ?3
             ORDER BY started_at ASC, idempotency_key ASC",
        )?;
        let rows = stmt.query_map(params![thread_id, user_id, workspace_id], map_tool_receipt_row)?;
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
        let dependencies = self.dependencies_for(task_id, user_id, workspace_id)?;
        let mut outputs = Vec::new();
        for dependency in dependencies {
            let Some(checkpoint) = self.latest_checkpoint(&dependency, user_id, workspace_id)?
            else {
                return Err(TaskRuntimeError::Store(format!(
                    "dependency_output_missing:{}",
                    dependency.as_str()
                )));
            };
            outputs.push(TaskDependencyOutput {
                task_id: dependency,
                output: checkpoint
                    .payload
                    .get("output")
                    .cloned()
                    .unwrap_or(checkpoint.payload),
                redacted_output: checkpoint
                    .redacted_payload
                    .get("output")
                    .cloned()
                    .unwrap_or(checkpoint.redacted_payload),
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
            uuid::Uuid::new_v4().to_string(),
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
        if !matches!(
            kind,
            TurnEventKind::Done | TurnEventKind::Error | TurnEventKind::Cancelled
        ) {
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
            let kind = TurnEventKind::parse(&kind_str)
                .ok_or_else(|| TaskRuntimeError::Store(format!("unknown turn_event kind: {kind_str}")))?;
            let payload: Value = serde_json::from_str(&payload_json)?;
            out.push(TurnEvent { event_id, turn_id, seq, kind, payload, created_at });
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
                model, provider, prompt_fingerprint, started_at, schema_version
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'running', ?7, ?8, ?9, ?10, 1)",
            params![
                run.run_id,
                run.turn_id,
                run.thread_id,
                run.user_id,
                run.workspace_id,
                attempt,
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
            model: run.model.clone(),
            provider: run.provider.clone(),
            prompt_fingerprint: run.prompt_fingerprint.clone(),
            started_at: now,
            completed_at: None,
            terminal_reason: None,
            schema_version: 1,
        })
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
        if kind == "prompt_snapshot" {
            if let Some(fingerprint) = payload.get("fingerprint").and_then(Value::as_str) {
                tx.execute(
                    "UPDATE agent_runs SET prompt_fingerprint = ?2 WHERE run_id = ?1",
                    params![run_id, fingerprint],
                )?;
            }
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
                    model, provider, prompt_fingerprint, started_at, completed_at,
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
                row.get::<_, i64>(10)?,
                row.get::<_, Option<i64>>(11)?,
                row.get::<_, Option<String>>(12)?,
                row.get::<_, u32>(13)?,
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
                    model, provider, prompt_fingerprint, started_at, completed_at,
                    terminal_reason, schema_version
             FROM agent_runs
             WHERE thread_id = ?1 AND user_id = ?2 AND workspace_id = ?3
             ORDER BY started_at DESC, attempt DESC",
        )?;
        let rows = stmt.query_map(params![thread_id, user_id, workspace_id], |row| {
            let status: String = row.get(6)?;
            Ok((
                AgentRun {
                    run_id: row.get(0)?, turn_id: row.get(1)?, thread_id: row.get(2)?,
                    user_id: row.get(3)?, workspace_id: row.get(4)?, attempt: row.get(5)?,
                    status: AgentRunStatus::parse(&status).unwrap_or(AgentRunStatus::Failed),
                    model: row.get(7)?, provider: row.get(8)?, prompt_fingerprint: row.get(9)?,
                    started_at: row.get(10)?, completed_at: row.get(11)?,
                    terminal_reason: row.get(12)?, schema_version: row.get(13)?,
                },
                status,
            ))
        })?;
        let mut runs = Vec::new();
        for row in rows {
            let (run, status) = row?;
            if AgentRunStatus::parse(&status).is_none() {
                return Err(TaskRuntimeError::Store(format!("unknown agent run status: {status}")));
            }
            runs.push(run);
        }
        Ok(runs)
    }

    pub fn workspace_for_agent_run(
        &self,
        run_id: &str,
        user_id: &str,
    ) -> TaskRuntimeResult<Option<String>> {
        Ok(self.connection.query_row(
            "SELECT workspace_id FROM agent_runs WHERE run_id = ?1 AND user_id = ?2",
            params![run_id, user_id],
            |row| row.get(0),
        ).optional()?)
    }

    pub fn latest_agent_checkpoint(
        &self,
        run_id: &str,
        user_id: &str,
        workspace_id: &str,
    ) -> TaskRuntimeResult<Option<AgentCheckpoint>> {
        self.connection.query_row(
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
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?, row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?, row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?, state_json, row.get::<_, String>(8)?,
                    row.get::<_, i64>(9)?, row.get::<_, i64>(10)?))
            },
        ).optional()?.map(|(checkpoint_id, run_id, turn_id, thread_id, user_id,
                            workspace_id, round, state_json, fingerprint, resumable, created_at)| {
            Ok(AgentCheckpoint { checkpoint_id, run_id, turn_id, thread_id, user_id, workspace_id,
                round: round as u32, state_json: serde_json::from_str(&state_json)?, fingerprint,
                resumable: resumable != 0, created_at })
        }).transpose()
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

    /// Projects the durable per-turn log into a thread-level cockpit view for the working
    /// island (see `ThreadActivityProjection`). ONE JOIN turn_events⋈tasks(thread_id) — both
    /// tables live in the same sqlite — yields every activity+plan_update across the thread's
    /// turns in chronological order. Activity ACCUMULATES across the thread; the PLAN is scoped
    /// to the LATEST turn only (a new task that emits no plan must not leave the previous task's
    /// plan on screen — the island has to reflect the current request, not the first one). We
    /// read the latest turn's id+status once, then keep only plan_updates from that turn. This
    /// is why the island survives turn-end/reload/thread-switch without parsing lossy message
    /// markers. `activity_cap` bounds the payload by keeping the most recent steps.
    pub fn project_thread_activity(
        &self,
        thread_id: &str,
        activity_cap: usize,
    ) -> TaskRuntimeResult<ThreadActivityProjection> {
        // Latest turn (id + status) first: the plan is scoped to it.
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
        let latest_turn_status = latest_turn.as_ref().map(|(_, status, _, _, _)| status.clone());
        let latest_turn_last_seq = latest_turn_id
            .as_deref()
            .map(|turn_id| {
                self.connection.query_row(
                    "SELECT COALESCE(MAX(seq), 0) FROM turn_events WHERE turn_id = ?1",
                    params![turn_id],
                    |row| row.get::<_, i64>(0),
                )
            })
            .transpose()?
            .unwrap_or(0);
        let active_turn = latest_turn.as_ref().and_then(|(turn_id, status, task_json, updated_at, blocked_reason)| {
            if matches!(status.as_str(), "completed" | "failed" | "cancelled" | "expired" | "finalizing") {
                return None;
            }
            let task = serde_json::from_str::<TaskRecord>(task_json).ok()?;
            Some(ActiveTurnProjection {
                turn_id: turn_id.clone(),
                last_event_seq: latest_turn_last_seq,
                status: status.clone(),
                attempt: task.attempt_count,
                max_attempts: task.retry_policy.max_attempts,
                not_before: task.not_before.map(|value| value.unix_timestamp()),
                blocked_reason: blocked_reason.clone(),
                updated_at: *updated_at,
            })
        });

        let mut stmt = self.connection.prepare(
            "SELECT te.turn_id, te.kind, te.payload_json
             FROM turn_events te JOIN tasks t ON t.task_id = te.turn_id
             WHERE t.thread_id = ?1 AND t.kind = 'chat_turn'
               AND te.kind IN ('activity', 'plan_update')
             ORDER BY t.created_at ASC, te.seq ASC",
        )?;
        let rows = stmt.query_map(params![thread_id], |row| {
            let turn_id: String = row.get(0)?;
            let kind: String = row.get(1)?;
            let payload: String = row.get(2)?;
            Ok((turn_id, kind, payload))
        })?;
        let mut activity: Vec<String> = Vec::new();
        let mut plan_markdown: Option<String> = None;
        for row in rows {
            let (turn_id, kind, payload_json) = row?;
            let payload: Value = serde_json::from_str(&payload_json)?;
            match kind.as_str() {
                "activity" => {
                    if let Some(text) = payload.get("text").and_then(|v| v.as_str()) {
                        let text = text.trim();
                        if !text.is_empty() {
                            activity.push(text.to_string());
                        }
                    }
                }
                // Plan is scoped to the LATEST turn: a newer, plan-less task clears the old plan.
                "plan_update" if Some(&turn_id) == latest_turn_id.as_ref() => {
                    if let Some(md) = payload.get("markdown").and_then(|v| v.as_str()) {
                        if !md.trim().is_empty() {
                            plan_markdown = Some(md.to_string());
                        }
                    }
                }
                _ => {}
            }
        }
        // Bound the payload: keep the most recent `activity_cap` steps (the tail is what the
        // cockpit shows). A cap of 0 would be nonsensical here, so treat it as "no cap".
        if activity_cap > 0 && activity.len() > activity_cap {
            activity.drain(0..activity.len() - activity_cap);
        }
        // Turn count — served by idx_tasks_chat_turn_thread.
        let turn_count: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM tasks WHERE thread_id = ?1 AND kind = 'chat_turn'",
            params![thread_id],
            |row| row.get(0),
        )?;
        // Subagents spawned on this thread (kind `subagent.<role>`). Forward-looking: empty
        // until spawn_subagent actually fires. `subagent.review` → "Review".
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
        Ok(ThreadActivityProjection {
            plan_markdown,
            activity,
            latest_turn_status,
            turn_count: turn_count as usize,
            subagents,
            active_turn,
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
        let latest_terminal_event_id = self.connection.query_row(
            "SELECT MAX(te.event_id)
               FROM turn_events te
               JOIN tasks t ON t.task_id = te.turn_id
              WHERE t.thread_id = ?1
                AND t.kind = 'chat_turn'
                AND te.kind IN ('done', 'error', 'cancelled')",
            params![thread_id],
            |row| row.get::<_, Option<i64>>(0),
        )?;
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
    pub fn active_chat_turn_for_thread(&self, thread_id: &str) -> TaskRuntimeResult<Option<String>> {
        // An "active" turn is any non-terminal chat_turn: the 1-turn-per-thread
        // constraint must hold while a turn is queued, running, OR paused/waiting
        // (e.g. waiting_resource, waiting_external_event, waiting_user_approval).
        // Only terminal states (completed/failed/cancelled/expired) free the thread
        // for a new turn — otherwise a turn stuck in waiting_external_event would
        // silently stop blocking, letting a second turn race on the same transcript.
        let task_id: Option<String> = self.connection
            .query_row(
                "SELECT task_id FROM tasks
                 WHERE thread_id = ?1 AND kind = 'chat_turn'
                   AND status NOT IN ('completed', 'failed', 'cancelled', 'expired', 'finalizing')
                 LIMIT 1",
                params![thread_id],
                |row| row.get(0),
            )
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
                thread_id, request_id, source, approval,
                task.task_id.as_str(), task.user_id.as_str(), task.workspace_id.as_str(),
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
    .map(|(user_id, workspace_id, thread_id, status, plan_json, objective_revision, revision,
           stall_turns, last_resume_done, created_at, updated_at)| {
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
    })
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

fn map_turn_steering_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TurnSteeringRecord> {
    let content: String = row.get(6)?;
    let payload_json: String = row.get(7)?;
    let payload = serde_json::from_str::<NewTurnSteering>(&payload_json).unwrap_or_else(|_| NewTurnSteering {
        source_message_id: row.get::<_, String>(5).unwrap_or_default(),
        prompt: content.clone(),
        visible_prompt: content.clone(),
        images: Vec::new(),
        attachments: Value::Array(Vec::new()),
        mode: None,
        model: None,
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
    ).optional().map_err(Into::into)
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
    ).optional().map_err(Into::into)
}

fn map_tool_receipt_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentToolReceipt> {
    let result_json: Option<String> = row.get(9)?;
    let effects_json: Option<String> = row.get(10)?;
    Ok(AgentToolReceipt {
        turn_id: row.get(0)?,
        idempotency_key: row.get(1)?,
        run_id: row.get(2)?,
        thread_id: row.get(3)?,
        user_id: row.get(4)?,
        workspace_id: row.get(5)?,
        tool_name: row.get(6)?,
        arguments_hash: row.get(7)?,
        status: row.get(8)?,
        result_json: result_json.and_then(|raw| serde_json::from_str(&raw).ok()),
        effects_json: effects_json.and_then(|raw| serde_json::from_str(&raw).ok()),
        started_at: row.get(11)?,
        completed_at: row.get(12)?,
    })
}

fn load_tool_receipt_on(
    conn: &Connection,
    turn_id: &str,
    idempotency_key: &str,
) -> TaskRuntimeResult<Option<AgentToolReceipt>> {
    Ok(conn
        .query_row(
            "SELECT turn_id, idempotency_key, run_id, thread_id, user_id, workspace_id,
                    tool_name, arguments_hash, status, result_json, effects_json,
                    started_at, completed_at
             FROM agent_tool_receipts
             WHERE turn_id = ?1 AND idempotency_key = ?2",
            params![turn_id, idempotency_key],
            map_tool_receipt_row,
        )
        .optional()?)
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

// Required by the Phase 0 plan; consumed by later tasks.
#[allow(dead_code)]
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
            assert!(column_exists(&store.connection, "tasks", col), "missing col {col}");
        }
        // Re-running migrations must not panic (guarded ALTER).
        store.run_migrations().expect("idempotent re-run");
        assert_eq!(store.schema_version().unwrap(), 10);
        assert!(table_exists(&store.connection, "agent_runs"));
        assert!(table_exists(&store.connection, "agent_run_events"));
        assert!(table_exists(&store.connection, "runtime_plans"));
        assert!(table_exists(&store.connection, "agent_checkpoints"));
        assert!(table_exists(&store.connection, "agent_tool_receipts"));
        assert!(table_exists(&store.connection, "objective_contracts"));
        assert!(table_exists(&store.connection, "turn_steering"));
    }

    #[test]
    fn chat_turn_index_exists() {
        let store = TaskStore::open_in_memory().expect("open");
        assert!(index_exists(&store.connection, "idx_tasks_chat_turn_thread"));
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
        assert!(store
            .load_objective_contract("u", "other", "t")
            .unwrap()
            .is_none());
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
        assert!(store.load_runtime_plan("u", "other", "t").unwrap().is_none());
    }

    #[test]
    fn runtime_plan_stall_bookkeeping_is_atomic() {
        let store = TaskStore::open_in_memory().unwrap();
        store
            .upsert_runtime_plan(
                "u", "w", "t", 0,
                &json!({"steps": [{"status": "in_progress"}]}),
                "open",
            )
            .unwrap();
        let first = store.bump_runtime_plan_stall("u", "w", "t", 0).unwrap().unwrap();
        let repeated = store.bump_runtime_plan_stall("u", "w", "t", 0).unwrap().unwrap();
        let progressed = store.bump_runtime_plan_stall("u", "w", "t", 1).unwrap().unwrap();
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
        assert_eq!(store.purge_runtime_plan_for_thread("u", "w", "t").unwrap(), 1);
        assert!(store.load_runtime_plan("u", "w", "t").unwrap().is_none());
        assert!(store.load_runtime_plan("u", "w", "other").unwrap().is_some());
        assert!(store.load_runtime_plan("u", "other", "t").unwrap().is_some());
        store
            .purge_workspace(&UserId::new("u"), &WorkspaceId::new("other"))
            .unwrap();
        assert!(store.load_runtime_plan("u", "other", "t").unwrap().is_none());
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
        assert!(store
            .consume_pending_turn_steering("u", "w", "thread", "turn-1")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn steering_cannot_cross_workspace_or_active_turn() {
        let store = TaskStore::open_in_memory().unwrap();
        store
            .append_turn_steering("u", "w", "thread", "turn-1", &new_steering("only"), 1)
            .unwrap();

        assert!(store
            .consume_pending_turn_steering("u", "other", "thread", "turn-1")
            .unwrap()
            .is_empty());
        assert!(store
            .consume_pending_turn_steering("u", "w", "thread", "turn-2")
            .unwrap()
            .is_empty());
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
        let row = store.append_turn_steering("u", "w", "thread", "turn-1", &first, 3).unwrap();
        store.append_turn_steering("u", "w", "thread", "turn-1", &new_steering("second"), 3).unwrap();
        assert_eq!(row.revision, 1);
        assert_eq!(row.status, TurnSteeringStatus::Pending);
        assert_eq!(row.images.len(), 1);
        let claimed = store.claim_pending_turn_steering("u", "w", "thread", "turn-1", "run-1", 2).unwrap();
        assert_eq!(claimed.iter().map(|row| row.prompt.as_str()).collect::<Vec<_>>(), vec!["first", "second"]);
        assert!(claimed.iter().all(|row| row.status == TurnSteeringStatus::Claimed));
    }

    #[test]
    fn held_rows_are_revision_guarded() {
        let store = TaskStore::open_in_memory().unwrap();
        let row = store.append_turn_steering("u", "w", "thread", "turn-1", &new_steering("first"), 1).unwrap();
        store.hold_pending_turn_steering("u", "w", "turn-1").unwrap();
        let held = store.list_turn_steering("u", "w", "thread").unwrap().remove(0);
        assert_eq!(held.status, TurnSteeringStatus::Held);
        let edited = store.update_turn_steering(row.steering_id, "u", "w", held.revision, &new_steering("edited")).unwrap();
        assert!(matches!(store.update_turn_steering(row.steering_id, "u", "w", held.revision, &new_steering("stale")), Err(TaskRuntimeError::Conflict(_))));
        assert_eq!(store.cancel_turn_steering(row.steering_id, "u", "w", edited.revision).unwrap().status, TurnSteeringStatus::Cancelled);
    }

    #[test]
    fn manual_stop_holds_claimed_or_interpreted_steering_for_recovery() {
        let store = TaskStore::open_in_memory().unwrap();
        store.append_turn_steering("u", "w", "thread", "turn-1", &new_steering("recover me"), 1).unwrap();
        let claimed = store.claim_pending_turn_steering("u", "w", "thread", "turn-1", "run-1", 1).unwrap().remove(0);
        store.mark_turn_steering_interpreted(
            claimed.steering_id,
            claimed.revision,
            &serde_json::json!({"steering_disposition": "finalize_with_current_evidence"}),
            "run-1",
        ).unwrap();

        assert_eq!(store.hold_pending_turn_steering("u", "w", "turn-1").unwrap(), 1);
        let held = store.list_turn_steering("u", "w", "thread").unwrap().remove(0);
        assert_eq!(held.status, TurnSteeringStatus::Held);
        assert!(held.semantic_decision_json.is_some());
    }

    #[test]
    fn steering_lifecycle_is_revision_guarded_until_runtime_completion() {
        let store = TaskStore::open_in_memory().unwrap();
        store.append_turn_steering("u", "w", "thread", "turn-1", &new_steering("answer from current evidence"), 1).unwrap();
        let claimed = store.claim_pending_turn_steering("u", "w", "thread", "turn-1", "run-1", 2).unwrap().remove(0);
        let interpreted = store.mark_turn_steering_interpreted(
            claimed.steering_id,
            claimed.revision,
            &serde_json::json!({"steering_disposition": "finalize_with_current_evidence"}),
            "run-1",
        ).unwrap();
        assert_eq!(interpreted.status, TurnSteeringStatus::Interpreted);
        assert_eq!(interpreted.semantic_decision_json, Some(serde_json::json!({"steering_disposition": "finalize_with_current_evidence"})));

        let applied = store.mark_turn_steering_applied(interpreted.steering_id, interpreted.revision, "run-1").unwrap();
        assert_eq!(applied.status, TurnSteeringStatus::Applied);
        let completed = store.mark_turn_steering_completed(applied.steering_id, applied.revision, "run-1").unwrap();
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
        assert!(!store.fence_chat_turn_finalization("u", "w", "turn-1").unwrap());

        let claimed = store
            .claim_pending_turn_steering("u", "w", "thread", "turn-1", "run-1", 1)
            .unwrap()
            .remove(0);
        assert_eq!(claimed.steering_id, pending.steering_id);
        assert!(!store.fence_chat_turn_finalization("u", "w", "turn-1").unwrap());

        let interpreted = store
            .mark_turn_steering_interpreted(
                claimed.steering_id,
                claimed.revision,
                &serde_json::json!({"steering_disposition": "finalize_with_current_evidence"}),
                "run-1",
            )
            .unwrap();
        assert!(!store.fence_chat_turn_finalization("u", "w", "turn-1").unwrap());

        store
            .mark_turn_steering_applied(
                interpreted.steering_id,
                interpreted.revision,
                "run-1",
            )
            .unwrap();
        assert!(store.fence_chat_turn_finalization("u", "w", "turn-1").unwrap());
    }

    #[test]
    fn unavailable_interpreter_returns_steering_to_pending_with_retry_time() {
        let store = TaskStore::open_in_memory().unwrap();
        store.append_turn_steering("u", "w", "thread", "turn-1", &new_steering("use what you already found"), 1).unwrap();
        let claimed = store.claim_pending_turn_steering("u", "w", "thread", "turn-1", "run-1", 3).unwrap().remove(0);
        let pending = store.release_turn_steering_for_retry(
            claimed.steering_id, claimed.revision, "model_unavailable", 12345,
        ).unwrap();
        assert_eq!(pending.status, TurnSteeringStatus::Pending);
        assert_eq!(pending.next_retry_at, Some(12345));
        assert_eq!(pending.last_interpretation_error.as_deref(), Some("model_unavailable"));
        assert_eq!(pending.interpretation_attempts, 1);
        assert!(pending.applied_at.is_none());
    }

    #[test]
    fn retry_backoff_rows_are_not_claimed_early() {
        let store = TaskStore::open_in_memory().unwrap();
        store.append_turn_steering("u", "w", "thread", "turn-1", &new_steering("wait for semantic model"), 1).unwrap();
        let claimed = store.claim_pending_turn_steering("u", "w", "thread", "turn-1", "run-1", 1).unwrap().remove(0);
        store.release_turn_steering_for_retry(
            claimed.steering_id, claimed.revision, "model_unavailable", i64::MAX,
        ).unwrap();

        assert!(store.claim_pending_turn_steering("u", "w", "thread", "turn-1", "run-2", 2).unwrap().is_empty());
        assert_eq!(store.list_turn_steering("u", "w", "thread").unwrap().remove(0).status, TurnSteeringStatus::Pending);
    }

    #[test]
    fn interpreted_rows_can_be_loaded_for_the_active_turn_without_pending_text() {
        let store = TaskStore::open_in_memory().unwrap();
        store.append_turn_steering("u", "w", "thread", "turn-1", &new_steering("semantic control"), 1).unwrap();
        let claimed = store.claim_pending_turn_steering("u", "w", "thread", "turn-1", "run-1", 1).unwrap().remove(0);
        store.mark_turn_steering_interpreted(
            claimed.steering_id,
            claimed.revision,
            &serde_json::json!({"steering_disposition": "replan_current_work"}),
            "run-1",
        ).unwrap();

        let rows = store.list_interpreted_turn_steering("u", "w", "thread", "turn-1", "run-1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, TurnSteeringStatus::Interpreted);
        assert_eq!(rows[0].content, "semantic control");
    }

    #[test]
    fn due_pending_scan_excludes_future_backoff_and_non_pending_rows() {
        let store = TaskStore::open_in_memory().unwrap();
        store.append_turn_steering("u", "w", "thread", "turn-1", &new_steering("due"), 1).unwrap();
        store.append_turn_steering("u", "w", "thread", "turn-1", &new_steering("future"), 1).unwrap();
        let mut claimed = store.claim_pending_turn_steering("u", "w", "thread", "turn-1", "run-1", 1).unwrap();
        let future = claimed.pop().unwrap();
        let due = claimed.pop().unwrap();
        store.release_turn_steering_for_retry(future.steering_id, future.revision, "model_unavailable", i64::MAX).unwrap();
        store.release_turn_steering_for_retry(due.steering_id, due.revision, "model_unavailable", 1).unwrap();

        let rows = store.list_due_pending_turn_steering(10, 20).unwrap();
        assert_eq!(rows.iter().map(|row| row.content.as_str()).collect::<Vec<_>>(), vec!["due"]);
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
            model: None,
            provider: None,
            prompt_fingerprint: None,
        }
    }

    fn receipt() -> NewAgentToolReceipt {
        NewAgentToolReceipt {
            turn_id: "turn".into(),
            idempotency_key: "write_file:abc".into(),
            run_id: "run".into(),
            thread_id: "thread".into(),
            user_id: "user".into(),
            workspace_id: "workspace".into(),
            tool_name: "write_file".into(),
            arguments_hash: "abc".into(),
        }
    }

    #[test]
    fn checkpoint_recovery_requires_gateway_restart_abort() {
        let store = TaskStore::open_in_memory().unwrap();
        store.create_agent_run(&run("run")).unwrap();
        store
            .append_agent_checkpoint("run", 2, &json!({"round": 2}), "fp", true)
            .unwrap();
        assert!(store
            .latest_resumable_checkpoint_for_turn("turn", "user", "workspace")
            .unwrap()
            .is_none());
        store
            .abort_running_agent_runs_for_turn(
                "turn", "user", "workspace", "gateway_restart",
            )
            .unwrap();
        let checkpoint = store
            .latest_resumable_checkpoint_for_turn("turn", "user", "workspace")
            .unwrap()
            .unwrap();
        assert_eq!(checkpoint.round, 2);
    }

    #[test]
    fn tool_receipt_never_reclaims_uncertain_started_action() {
        let store = TaskStore::open_in_memory().unwrap();
        assert!(matches!(store.claim_tool_receipt(&receipt()).unwrap(), ToolReceiptClaim::Execute));
        assert!(matches!(
            store.claim_tool_receipt(&receipt()).unwrap(),
            ToolReceiptClaim::Uncertain(_)
        ));
        store
            .complete_tool_receipt("turn", "write_file:abc", &json!({"ok": true}), &json!({}))
            .unwrap();
        assert!(matches!(
            store.claim_tool_receipt(&receipt()).unwrap(),
            ToolReceiptClaim::Replay(_)
        ));
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
        let e1 = s.insert_turn_event("t1", TurnEventKind::Delta, json!({"text":"a"})).unwrap();
        let e2 = s.insert_turn_event("t1", TurnEventKind::Delta, json!({"text":"b"})).unwrap();
        let e3 = s.insert_turn_event("t2", TurnEventKind::Delta, json!({"text":"other"})).unwrap();
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
    fn read_since_returns_only_newer_in_order() {
        let s = store();
        s.insert_turn_event("t1", TurnEventKind::Delta, json!({"i":1})).unwrap();
        s.insert_turn_event("t1", TurnEventKind::Activity, json!({"i":2})).unwrap();
        s.insert_turn_event("t1", TurnEventKind::PlanUpdate, json!({"i":3})).unwrap();
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
        for k in [TurnEventKind::Delta, TurnEventKind::Aborted, TurnEventKind::Cancelled] {
            s.insert_turn_event("t", k, json!({})).unwrap();
        }
        let events = s.read_turn_events("t", 0).unwrap();
        assert_eq!(
            events.iter().map(|e| e.kind).collect::<Vec<_>>(),
            vec![TurnEventKind::Delta, TurnEventKind::Aborted, TurnEventKind::Cancelled]
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
            model: Some("test-model".to_string()),
            provider: Some("test-provider".to_string()),
            prompt_fingerprint: None,
        }
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
            .execute("UPDATE agent_runs SET completed_at = 10 WHERE run_id = 'old'", [])
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
        assert_eq!(s.active_chat_turn_for_thread("thread_x").unwrap().as_deref(), Some("t1"));

        // a second thread doesn't collide
        let t2 = make_chat_turn("t2", "thread_y", TaskStatus::Running);
        s.insert_chat_turn(&t2, "thread_y", "chat_stream_2", "interactive", "full")
            .unwrap();
        assert_eq!(s.active_chat_turn_for_thread("thread_y").unwrap().as_deref(), Some("t2"));
        assert_eq!(s.active_chat_turn_for_thread("thread_x").unwrap().as_deref(), Some("t1"));
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
    fn thread_attention_reports_latest_terminal_event() {
        let s = TaskStore::open_in_memory().unwrap();
        let task = make_chat_turn("turn-a", "thread-a", TaskStatus::Completed);
        s.insert_chat_turn(
            &task,
            "thread-a",
            "chat_stream_1",
            "interactive",
            "full",
        )
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
            .execute("UPDATE tasks SET thread_id = 'thread_x' WHERE task_id = 'bg1'", [])
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

        let active = s
            .project_thread_activity("thread_cursor", 200)
            .unwrap()
            .active_turn
            .expect("active turn projection");
        assert_eq!(active.turn_id, "turn_cursor");
        assert_eq!(active.last_event_seq, last.seq);
    }

    #[test]
    fn project_thread_activity_accumulates_cross_turn_and_takes_latest_plan() {
        let s = store();
        // Turn 1 (older): one activity + one plan. created_at set explicitly so the JOIN's
        // `t.created_at ASC` ordering is deterministic across turns.
        let mut t1 = make_chat_turn("turn_a", "threadX", TaskStatus::Completed);
        t1.created_at = OffsetDateTime::from_unix_timestamp(100).unwrap();
        s.insert_chat_turn(&t1, "threadX", "reqa", "interactive", "full").unwrap();
        s.insert_turn_event("turn_a", TurnEventKind::Activity, json!({"text": "A1"})).unwrap();
        s.insert_turn_event("turn_a", TurnEventKind::PlanUpdate, json!({"markdown": "- [ ] uno"})).unwrap();
        // Turn 2 (newer, still running): one activity + a superseding plan.
        let mut t2 = make_chat_turn("turn_b", "threadX", TaskStatus::Running);
        t2.created_at = OffsetDateTime::from_unix_timestamp(200).unwrap();
        s.insert_chat_turn(&t2, "threadX", "reqb", "interactive", "full").unwrap();
        s.insert_turn_event("turn_b", TurnEventKind::Activity, json!({"text": "B1"})).unwrap();
        s.insert_turn_event("turn_b", TurnEventKind::PlanUpdate, json!({"markdown": "- [x] due"})).unwrap();

        let p = s.project_thread_activity("threadX", 200).unwrap();
        assert_eq!(p.activity, vec!["A1".to_string(), "B1".to_string()], "activity accumulates across turns in order");
        assert_eq!(p.plan_markdown.as_deref(), Some("- [x] due"), "latest plan wins");
        assert_eq!(p.turn_count, 2);
        assert_eq!(p.latest_turn_status.as_deref(), Some("running"), "status of the most recent turn");
    }

    #[test]
    fn project_thread_activity_plan_is_scoped_to_latest_turn() {
        let s = store();
        // Turn 1 (older): a planned task that completes with a plan.
        let mut t1 = make_chat_turn("turn_a", "threadZ", TaskStatus::Completed);
        t1.created_at = OffsetDateTime::from_unix_timestamp(100).unwrap();
        s.insert_chat_turn(&t1, "threadZ", "reqa", "interactive", "full").unwrap();
        s.insert_turn_event("turn_a", TurnEventKind::Activity, json!({"text": "A1"})).unwrap();
        s.insert_turn_event("turn_a", TurnEventKind::PlanUpdate, json!({"markdown": "- [x] mini-ricerca"})).unwrap();
        // Turn 2 (newer): a DIFFERENT task with no plan (e.g. a one-shot web search).
        let mut t2 = make_chat_turn("turn_b", "threadZ", TaskStatus::Completed);
        t2.created_at = OffsetDateTime::from_unix_timestamp(200).unwrap();
        s.insert_chat_turn(&t2, "threadZ", "reqb", "interactive", "full").unwrap();
        s.insert_turn_event("turn_b", TurnEventKind::Activity, json!({"text": "B1 search"})).unwrap();

        let p = s.project_thread_activity("threadZ", 200).unwrap();
        assert_eq!(p.plan_markdown, None, "the plan-less latest turn must clear the previous task's plan");
        assert_eq!(p.activity, vec!["A1".to_string(), "B1 search".to_string()], "activity still accumulates");
    }

    #[test]
    fn project_thread_activity_caps_to_most_recent() {
        let s = store();
        let t = make_chat_turn("turn_c", "threadY", TaskStatus::Completed);
        s.insert_chat_turn(&t, "threadY", "reqc", "interactive", "full").unwrap();
        for i in 0..5 {
            s.insert_turn_event("turn_c", TurnEventKind::Activity, json!({"text": format!("step{i}")})).unwrap();
        }
        let p = s.project_thread_activity("threadY", 2).unwrap();
        assert_eq!(p.activity, vec!["step3".to_string(), "step4".to_string()], "cap keeps the most recent tail");
    }

    #[test]
    fn project_thread_activity_empty_thread_is_default() {
        let s = store();
        let p = s.project_thread_activity("nope", 200).unwrap();
        assert!(p.activity.is_empty());
        assert_eq!(p.plan_markdown, None);
        assert_eq!(p.latest_turn_status, None);
        assert_eq!(p.turn_count, 0);
    }

    #[test]
    fn project_thread_activity_includes_subagent_summary_and_timestamps() {
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

        let projection = s.project_thread_activity("thread-subagents", 200).unwrap();
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
        assert_eq!(store.schema_version().unwrap(), 10);
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
