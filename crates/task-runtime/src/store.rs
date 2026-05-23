use crate::{
    ResourceClass, TaskId, TaskRecord, TaskRuntimeError, TaskRuntimeResult, TaskStatus, UserId,
    WorkspaceId,
};
use rusqlite::{Connection, OptionalExtension, params};
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

            INSERT INTO task_runtime_metadata(key, value)
            VALUES ('schema_version', '1')
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
}

fn enum_value<T: serde::Serialize>(value: &T) -> TaskRuntimeResult<String> {
    serde_json::to_value(value)?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| TaskRuntimeError::Store("enum did not serialize to string".to_string()))
}
