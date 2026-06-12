use crate::{
    ApprovalRequest, Automation, ResourceClass, TaskCheckpoint, TaskDependencyOutput, TaskId,
    TaskRecord, TaskRuntimeError, TaskRuntimeResult, TaskStatus, UserId, WorkspaceId,
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

            INSERT INTO task_runtime_metadata(key, value)
            VALUES ('schema_version', '2')
            ON CONFLICT(key) DO UPDATE SET value = excluded.value;
            ",
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
        let rows = statement.query_map(
            params![user_id.as_str(), workspace_id.as_str()],
            |row| row.get::<_, String>(0),
        )?;
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
        Ok(())
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
}

fn enum_value<T: serde::Serialize>(value: &T) -> TaskRuntimeResult<String> {
    serde_json::to_value(value)?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| TaskRuntimeError::Store("enum did not serialize to string".to_string()))
}
