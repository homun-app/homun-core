use crate::{
    ApprovalState, ArtifactRecord, ComputerEventRecord, ComputerSessionRecord, SessionStatus,
    TakeoverState,
};
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;
use time::OffsetDateTime;

pub struct LocalComputerSessionStore {
    connection: Connection,
}

impl LocalComputerSessionStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let store = Self {
            connection: Connection::open(path).map_err(|error| error.to_string())?,
        };
        store.run_migrations()?;
        Ok(store)
    }

    pub fn open_in_memory() -> Result<Self, String> {
        let store = Self {
            connection: Connection::open_in_memory().map_err(|error| error.to_string())?,
        };
        store.run_migrations()?;
        Ok(store)
    }

    pub fn run_migrations(&self) -> Result<(), String> {
        self.connection
            .execute_batch(
                "
                CREATE TABLE IF NOT EXISTS local_computer_metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS computer_sessions (
                    session_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    workspace_id TEXT NOT NULL,
                    task_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    session_json TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_computer_sessions_scope_task
                    ON computer_sessions(user_id, workspace_id, task_id);

                CREATE TABLE IF NOT EXISTS computer_events (
                    event_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    workspace_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    event_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_computer_events_session
                    ON computer_events(user_id, workspace_id, session_id, sequence);

                CREATE TABLE IF NOT EXISTS computer_artifacts (
                    artifact_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    workspace_id TEXT NOT NULL,
                    artifact_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_computer_artifacts_session
                    ON computer_artifacts(user_id, workspace_id, session_id, created_at);

                INSERT INTO local_computer_metadata(key, value)
                VALUES ('schema_version', '1')
                ON CONFLICT(key) DO UPDATE SET value = excluded.value;
                ",
            )
            .map_err(|error| error.to_string())
    }

    pub fn schema_version(&self) -> Result<u32, String> {
        let value: String = self
            .connection
            .query_row(
                "SELECT value FROM local_computer_metadata WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        value.parse::<u32>().map_err(|error| error.to_string())
    }

    pub fn upsert_session(&self, session: &ComputerSessionRecord) -> Result<(), String> {
        self.connection
            .execute(
                "
                INSERT INTO computer_sessions (
                    session_id, user_id, workspace_id, task_id, status, session_json, updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                ON CONFLICT(session_id) DO UPDATE SET
                    status = excluded.status,
                    session_json = excluded.session_json,
                    updated_at = excluded.updated_at
                ",
                params![
                    session.session_id,
                    session.user_id,
                    session.workspace_id,
                    session.task_id,
                    enum_string(&session.status)?,
                    serde_json::to_string(session).map_err(|error| error.to_string())?,
                    session.updated_at.unix_timestamp(),
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn session(
        &self,
        session_id: &str,
        user_id: &str,
        workspace_id: &str,
    ) -> Result<Option<ComputerSessionRecord>, String> {
        self.connection
            .query_row(
                "
                SELECT session_json
                FROM computer_sessions
                WHERE session_id = ?1 AND user_id = ?2 AND workspace_id = ?3
                ",
                params![session_id, user_id, workspace_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .map(|json| serde_json::from_str(&json).map_err(|error| error.to_string()))
            .transpose()
    }

    pub fn session_by_id(&self, session_id: &str) -> Result<Option<ComputerSessionRecord>, String> {
        self.connection
            .query_row(
                "
                SELECT session_json
                FROM computer_sessions
                WHERE session_id = ?1
                ",
                params![session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .map(|json| serde_json::from_str(&json).map_err(|error| error.to_string()))
            .transpose()
    }

    pub fn append_event(&self, event: &ComputerEventRecord) -> Result<(), String> {
        let sequence =
            self.next_sequence(&event.session_id, &event.user_id, &event.workspace_id)?;
        self.connection
            .execute(
                "
                INSERT INTO computer_events (
                    event_id, session_id, user_id, workspace_id, sequence, event_json, created_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                ",
                params![
                    event.event_id,
                    event.session_id,
                    event.user_id,
                    event.workspace_id,
                    sequence,
                    serde_json::to_string(event).map_err(|error| error.to_string())?,
                    event.created_at.unix_timestamp(),
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn events_for_session(
        &self,
        session_id: &str,
        user_id: &str,
        workspace_id: &str,
    ) -> Result<Vec<ComputerEventRecord>, String> {
        let mut statement = self
            .connection
            .prepare(
                "
                SELECT event_json
                FROM computer_events
                WHERE session_id = ?1 AND user_id = ?2 AND workspace_id = ?3
                ORDER BY sequence ASC
                ",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![session_id, user_id, workspace_id], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| error.to_string())?;

        let mut events = Vec::new();
        for row in rows {
            events.push(
                serde_json::from_str(&row.map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())?,
            );
        }
        Ok(events)
    }

    pub fn upsert_artifact(&self, artifact: &ArtifactRecord) -> Result<(), String> {
        self.connection
            .execute(
                "
                INSERT INTO computer_artifacts (
                    artifact_id, session_id, user_id, workspace_id, artifact_json, created_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(artifact_id) DO UPDATE SET
                    artifact_json = excluded.artifact_json
                ",
                params![
                    artifact.artifact_id,
                    artifact.session_id,
                    artifact.user_id,
                    artifact.workspace_id,
                    serde_json::to_string(artifact).map_err(|error| error.to_string())?,
                    artifact.created_at.unix_timestamp(),
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn artifacts_for_session(
        &self,
        session_id: &str,
        user_id: &str,
        workspace_id: &str,
    ) -> Result<Vec<ArtifactRecord>, String> {
        let mut statement = self
            .connection
            .prepare(
                "
                SELECT artifact_json
                FROM computer_artifacts
                WHERE session_id = ?1 AND user_id = ?2 AND workspace_id = ?3
                ORDER BY created_at ASC, artifact_id ASC
                ",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![session_id, user_id, workspace_id], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| error.to_string())?;

        let mut artifacts = Vec::new();
        for row in rows {
            artifacts.push(
                serde_json::from_str(&row.map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())?,
            );
        }
        Ok(artifacts)
    }

    pub fn update_session_status(
        &self,
        session_id: &str,
        user_id: &str,
        workspace_id: &str,
        status: SessionStatus,
    ) -> Result<(), String> {
        let mut session = self
            .session(session_id, user_id, workspace_id)?
            .ok_or_else(|| format!("session not found: {session_id}"))?;
        session.status = status;
        session.updated_at = OffsetDateTime::now_utc();
        self.upsert_session(&session)
    }

    pub fn update_takeover(
        &self,
        session_id: &str,
        user_id: &str,
        workspace_id: &str,
        takeover_state: TakeoverState,
        last_error: Option<String>,
    ) -> Result<(), String> {
        let mut session = self
            .session(session_id, user_id, workspace_id)?
            .ok_or_else(|| format!("session not found: {session_id}"))?;
        session.status = SessionStatus::WaitingUser;
        session.takeover_state = takeover_state;
        session.last_error = last_error;
        session.updated_at = OffsetDateTime::now_utc();
        self.upsert_session(&session)
    }

    pub fn update_approval(
        &self,
        session_id: &str,
        user_id: &str,
        workspace_id: &str,
        approval_state: ApprovalState,
    ) -> Result<(), String> {
        let mut session = self
            .session(session_id, user_id, workspace_id)?
            .ok_or_else(|| format!("session not found: {session_id}"))?;
        session.status = SessionStatus::WaitingUser;
        session.approval_state = approval_state;
        session.updated_at = OffsetDateTime::now_utc();
        self.upsert_session(&session)
    }

    fn next_sequence(
        &self,
        session_id: &str,
        user_id: &str,
        workspace_id: &str,
    ) -> Result<i64, String> {
        let sequence: Option<i64> = self
            .connection
            .query_row(
                "
                SELECT MAX(sequence)
                FROM computer_events
                WHERE session_id = ?1 AND user_id = ?2 AND workspace_id = ?3
                ",
                params![session_id, user_id, workspace_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        Ok(sequence.unwrap_or_default() + 1)
    }
}

fn enum_string<T: serde::Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_value(value)
        .map_err(|error| error.to_string())?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "enum did not serialize to string".to_string())
}
