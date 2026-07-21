use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct GrantScope {
    pub user_id: String,
    pub workspace_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SignedAppIdentity {
    pub bundle_id: String,
    pub team_id: String,
    pub designated_requirement_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantLevel {
    Observe,
    Control,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppGrant {
    pub grant_id: String,
    pub scope: GrantScope,
    pub app: SignedAppIdentity,
    pub level: GrantLevel,
    pub expires_at_unix_ms: Option<i64>,
}

pub struct GrantStore {
    connection: Connection,
}

impl GrantStore {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let store = Self {
            connection: Connection::open(path)?,
        };
        store.migrate()?;
        Ok(store)
    }

    pub fn in_memory() -> rusqlite::Result<Self> {
        let store = Self {
            connection: Connection::open_in_memory()?,
        };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> rusqlite::Result<()> {
        self.connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS host_computer_app_grants (
                grant_id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                bundle_id TEXT NOT NULL,
                team_id TEXT NOT NULL,
                requirement_sha256 TEXT NOT NULL,
                level TEXT NOT NULL CHECK(level IN ('observe','control')),
                expires_at_unix_ms INTEGER,
                created_at_unix_ms INTEGER NOT NULL,
                updated_at_unix_ms INTEGER NOT NULL,
                UNIQUE(user_id, workspace_id, bundle_id, team_id, requirement_sha256)
            );",
        )
    }

    pub fn upsert(&self, grant: &AppGrant, now_unix_ms: i64) -> rusqlite::Result<()> {
        self.connection.execute(
            "INSERT INTO host_computer_app_grants
             (grant_id,user_id,workspace_id,bundle_id,team_id,requirement_sha256,level,expires_at_unix_ms,created_at_unix_ms,updated_at_unix_ms)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)
             ON CONFLICT(user_id,workspace_id,bundle_id,team_id,requirement_sha256)
             DO UPDATE SET level=excluded.level, expires_at_unix_ms=excluded.expires_at_unix_ms,
                           updated_at_unix_ms=excluded.updated_at_unix_ms",
            params![
                grant.grant_id, grant.scope.user_id, grant.scope.workspace_id,
                grant.app.bundle_id, grant.app.team_id, grant.app.designated_requirement_sha256,
                level_name(grant.level), grant.expires_at_unix_ms, now_unix_ms,
            ],
        )?;
        Ok(())
    }

    pub fn resolve(
        &self,
        scope: &GrantScope,
        app: &SignedAppIdentity,
        now_unix_ms: i64,
    ) -> rusqlite::Result<Option<GrantLevel>> {
        self.connection
            .query_row(
                "SELECT level FROM host_computer_app_grants
             WHERE user_id=?1 AND workspace_id=?2 AND bundle_id=?3 AND team_id=?4
               AND requirement_sha256=?5 AND (expires_at_unix_ms IS NULL OR expires_at_unix_ms>?6)",
                params![
                    scope.user_id,
                    scope.workspace_id,
                    app.bundle_id,
                    app.team_id,
                    app.designated_requirement_sha256,
                    now_unix_ms
                ],
                |row| parse_level(row.get::<_, String>(0)?),
            )
            .optional()
    }

    pub fn revoke(&self, grant_id: &str, scope: &GrantScope) -> rusqlite::Result<bool> {
        Ok(self.connection.execute(
            "DELETE FROM host_computer_app_grants WHERE grant_id=?1 AND user_id=?2 AND workspace_id=?3",
            params![grant_id, scope.user_id, scope.workspace_id],
        )? > 0)
    }

    pub fn list(&self, scope: &GrantScope, now_unix_ms: i64) -> rusqlite::Result<Vec<AppGrant>> {
        let mut statement = self.connection.prepare(
            "SELECT grant_id,bundle_id,team_id,requirement_sha256,level,expires_at_unix_ms
             FROM host_computer_app_grants WHERE user_id=?1 AND workspace_id=?2
               AND (expires_at_unix_ms IS NULL OR expires_at_unix_ms>?3)
             ORDER BY bundle_id, grant_id",
        )?;
        let rows = statement.query_map(
            params![scope.user_id, scope.workspace_id, now_unix_ms],
            |row| {
                Ok(AppGrant {
                    grant_id: row.get(0)?,
                    scope: scope.clone(),
                    app: SignedAppIdentity {
                        bundle_id: row.get(1)?,
                        team_id: row.get(2)?,
                        designated_requirement_sha256: row.get(3)?,
                    },
                    level: parse_level(row.get(4)?)?,
                    expires_at_unix_ms: row.get(5)?,
                })
            },
        )?;
        rows.collect()
    }

    pub fn clear_all(&self) -> rusqlite::Result<usize> {
        self.connection
            .execute("DELETE FROM host_computer_app_grants", [])
    }
}

fn level_name(level: GrantLevel) -> &'static str {
    match level {
        GrantLevel::Observe => "observe",
        GrantLevel::Control => "control",
    }
}

fn parse_level(value: String) -> rusqlite::Result<GrantLevel> {
    match value.as_str() {
        "observe" => Ok(GrantLevel::Observe),
        "control" => Ok(GrantLevel::Control),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}
