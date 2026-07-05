use crate::{
    ApprovalRequest, Automation, AutomationRun, ResourceClass, TaskCheckpoint,
    TaskDependencyOutput, TaskId, TaskRecord, TaskRuntimeError, TaskRuntimeResult, TaskStatus,
    TurnEvent, TurnEventKind, UserId, WorkspaceId,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use std::path::Path;
use time::OffsetDateTime;

pub struct TaskStore {
    connection: Connection,
}

impl TaskStore {
    pub fn open(path: impl AsRef<Path>) -> TaskRuntimeResult<Self> {
        let store = Self {
            connection: Connection::open(path)?,
        };
        store.run_migrations()?;
        Ok(store)
    }

    pub fn open_in_memory() -> TaskRuntimeResult<Self> {
        let store = Self {
            connection: Connection::open_in_memory()?,
        };
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

            CREATE TABLE IF NOT EXISTS broker_meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            INSERT INTO task_runtime_metadata(key, value)
            VALUES ('schema_version', '4')
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

    /// Purge ALL tasks, dependencies and resource reservations for a workspace.
    /// Called when a project workspace is deleted. Safe: uses the same
    /// (user_id, workspace_id) composite key the store indexes on.
    pub fn purge_workspace(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> TaskRuntimeResult<usize> {
        let count = self.connection.execute(
            "DELETE FROM tasks WHERE user_id = ?1 AND workspace_id = ?2",
            rusqlite::params![user_id.as_str(), workspace_id.as_str()],
        )?;
        self.connection.execute(
            "DELETE FROM task_dependencies WHERE user_id = ?1 AND workspace_id = ?2",
            rusqlite::params![user_id.as_str(), workspace_id.as_str()],
        )?;
        self.connection.execute(
            "DELETE FROM resource_reservations WHERE user_id = ?1 AND workspace_id = ?2",
            rusqlite::params![user_id.as_str(), workspace_id.as_str()],
        )?;
        Ok(count)
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
        let now = OffsetDateTime::now_utc().unix_timestamp();
        // next seq per turn_id
        let seq: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM turn_events WHERE turn_id = ?1",
            params![turn_id],
            |row| row.get(0),
        )?;
        self.connection.execute(
            "INSERT INTO turn_events (turn_id, seq, kind, payload_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![turn_id, seq, kind.as_str(), serde_json::to_string(&payload)?, now],
        )?;
        let event_id = self.connection.last_insert_rowid();
        Ok(TurnEvent { event_id, turn_id: turn_id.to_string(), seq, kind, payload, created_at: now })
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
        let task_id: Option<String> = self.connection
            .query_row(
                "SELECT task_id FROM tasks
                 WHERE thread_id = ?1 AND kind = 'chat_turn'
                   AND status IN ('queued', 'running')
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
        assert_eq!(store.schema_version().unwrap(), 4);
    }

    #[test]
    fn chat_turn_index_exists() {
        let store = TaskStore::open_in_memory().expect("open");
        assert!(index_exists(&store.connection, "idx_tasks_chat_turn_thread"));
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
}

#[cfg(test)]
mod upgrade_tests {
    use super::*;
    use crate::{TaskId, TaskRecord, UserId, WorkspaceId};
    use rusqlite::Connection;

    #[test]
    fn upgrades_v3_to_v4_adding_chat_turn_cols() {
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
        assert_eq!(store.schema_version().unwrap(), 4);
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
