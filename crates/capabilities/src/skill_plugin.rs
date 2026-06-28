use crate::{
    CapabilityError, CapabilityResult, PluginInstallRecord, PluginManifest, SkillInstallRecord,
    SkillManifest, UserId, WorkspaceId,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};
use std::path::Path;
use time::OffsetDateTime;

pub struct SkillPluginRegistryStore {
    connection: Connection,
}

impl SkillPluginRegistryStore {
    pub fn open(path: impl AsRef<Path>) -> CapabilityResult<Self> {
        let store = Self {
            connection: Connection::open(path).map_err(to_store_error)?,
        };
        store.run_migrations()?;
        Ok(store)
    }

    pub fn open_in_memory() -> CapabilityResult<Self> {
        let store = Self {
            connection: Connection::open_in_memory().map_err(to_store_error)?,
        };
        store.run_migrations()?;
        Ok(store)
    }

    pub fn run_migrations(&self) -> CapabilityResult<()> {
        self.connection
            .execute_batch(
                "
                CREATE TABLE IF NOT EXISTS skill_plugin_registry_metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS skill_manifests (
                    skill_id TEXT NOT NULL,
                    version TEXT NOT NULL,
                    runtime TEXT NOT NULL,
                    manifest_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (skill_id, version)
                );

                CREATE TABLE IF NOT EXISTS plugin_manifests (
                    plugin_id TEXT NOT NULL,
                    version TEXT NOT NULL,
                    manifest_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (plugin_id, version)
                );

                CREATE TABLE IF NOT EXISTS skill_installs (
                    skill_id TEXT NOT NULL,
                    version TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    workspace_id TEXT NOT NULL,
                    enabled INTEGER NOT NULL,
                    trust_level TEXT NOT NULL,
                    source_path TEXT NOT NULL,
                    manifest_hash TEXT,
                    install_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (skill_id, version, user_id, workspace_id)
                );

                CREATE INDEX IF NOT EXISTS idx_skill_installs_scope
                    ON skill_installs(user_id, workspace_id, enabled);

                CREATE TABLE IF NOT EXISTS plugin_installs (
                    plugin_id TEXT NOT NULL,
                    version TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    workspace_id TEXT NOT NULL,
                    enabled INTEGER NOT NULL,
                    trust_level TEXT NOT NULL,
                    source_path TEXT NOT NULL,
                    manifest_hash TEXT,
                    install_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (plugin_id, version, user_id, workspace_id)
                );

                CREATE INDEX IF NOT EXISTS idx_plugin_installs_scope
                    ON plugin_installs(user_id, workspace_id, enabled);

                INSERT INTO skill_plugin_registry_metadata(key, value)
                VALUES ('schema_version', '1')
                ON CONFLICT(key) DO UPDATE SET value = excluded.value;
                ",
            )
            .map_err(to_store_error)?;
        Ok(())
    }

    pub fn schema_version(&self) -> CapabilityResult<u32> {
        let value: String = self
            .connection
            .query_row(
                "SELECT value FROM skill_plugin_registry_metadata WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .map_err(to_store_error)?;
        value
            .parse::<u32>()
            .map_err(|error| CapabilityError::ToolExecutionFailed(error.to_string()))
    }

    pub fn upsert_skill_manifest(&self, manifest: &SkillManifest) -> CapabilityResult<()> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        self.connection
            .execute(
                "
                INSERT INTO skill_manifests (
                    skill_id,
                    version,
                    runtime,
                    manifest_json,
                    created_at,
                    updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(skill_id, version) DO UPDATE SET
                    runtime = excluded.runtime,
                    manifest_json = excluded.manifest_json,
                    updated_at = excluded.updated_at
                ",
                params![
                    manifest.id,
                    manifest.version,
                    manifest.runtime,
                    json(manifest)?,
                    now,
                    now,
                ],
            )
            .map_err(to_store_error)?;
        Ok(())
    }

    pub fn skill_manifest(
        &self,
        skill_id: &str,
        version: &str,
    ) -> CapabilityResult<Option<SkillManifest>> {
        self.query_json(
            "SELECT manifest_json FROM skill_manifests WHERE skill_id = ?1 AND version = ?2",
            params![skill_id, version],
        )
    }

    pub fn upsert_skill_install(&self, install: &SkillInstallRecord) -> CapabilityResult<()> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        self.connection
            .execute(
                "
                INSERT INTO skill_installs (
                    skill_id,
                    version,
                    user_id,
                    workspace_id,
                    enabled,
                    trust_level,
                    source_path,
                    manifest_hash,
                    install_json,
                    created_at,
                    updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                ON CONFLICT(skill_id, version, user_id, workspace_id) DO UPDATE SET
                    enabled = excluded.enabled,
                    trust_level = excluded.trust_level,
                    source_path = excluded.source_path,
                    manifest_hash = excluded.manifest_hash,
                    install_json = excluded.install_json,
                    updated_at = excluded.updated_at
                ",
                params![
                    install.skill_id,
                    install.version,
                    install.user_id.as_str(),
                    install.workspace_id.as_str(),
                    install.enabled,
                    enum_json(install.trust_level)?,
                    install.source_path,
                    install.manifest_hash,
                    json(install)?,
                    install.created_at.unix_timestamp(),
                    now,
                ],
            )
            .map_err(to_store_error)?;
        Ok(())
    }

    pub fn skill_installs(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> CapabilityResult<Vec<SkillInstallRecord>> {
        self.query_json_list(
            "
            SELECT install_json
            FROM skill_installs
            WHERE user_id = ?1 AND workspace_id = ?2
            ORDER BY skill_id ASC, version ASC
            ",
            params![user_id.as_str(), workspace_id.as_str()],
        )
    }

    pub fn upsert_plugin_manifest(&self, manifest: &PluginManifest) -> CapabilityResult<()> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        self.connection
            .execute(
                "
                INSERT INTO plugin_manifests (
                    plugin_id,
                    version,
                    manifest_json,
                    created_at,
                    updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(plugin_id, version) DO UPDATE SET
                    manifest_json = excluded.manifest_json,
                    updated_at = excluded.updated_at
                ",
                params![manifest.id, manifest.version, json(manifest)?, now, now],
            )
            .map_err(to_store_error)?;

        for skill in &manifest.skills {
            self.upsert_skill_manifest(skill)?;
        }
        Ok(())
    }

    pub fn plugin_manifest(
        &self,
        plugin_id: &str,
        version: &str,
    ) -> CapabilityResult<Option<PluginManifest>> {
        self.query_json(
            "SELECT manifest_json FROM plugin_manifests WHERE plugin_id = ?1 AND version = ?2",
            params![plugin_id, version],
        )
    }

    pub fn upsert_plugin_install(&self, install: &PluginInstallRecord) -> CapabilityResult<()> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        self.connection
            .execute(
                "
                INSERT INTO plugin_installs (
                    plugin_id,
                    version,
                    user_id,
                    workspace_id,
                    enabled,
                    trust_level,
                    source_path,
                    manifest_hash,
                    install_json,
                    created_at,
                    updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                ON CONFLICT(plugin_id, version, user_id, workspace_id) DO UPDATE SET
                    enabled = excluded.enabled,
                    trust_level = excluded.trust_level,
                    source_path = excluded.source_path,
                    manifest_hash = excluded.manifest_hash,
                    install_json = excluded.install_json,
                    updated_at = excluded.updated_at
                ",
                params![
                    install.plugin_id,
                    install.version,
                    install.user_id.as_str(),
                    install.workspace_id.as_str(),
                    install.enabled,
                    enum_json(install.trust_level)?,
                    install.source_path,
                    install.manifest_hash,
                    json(install)?,
                    install.created_at.unix_timestamp(),
                    now,
                ],
            )
            .map_err(to_store_error)?;
        Ok(())
    }

    pub fn plugin_installs(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> CapabilityResult<Vec<PluginInstallRecord>> {
        self.query_json_list(
            "
            SELECT install_json
            FROM plugin_installs
            WHERE user_id = ?1 AND workspace_id = ?2
            ORDER BY plugin_id ASC, version ASC
            ",
            params![user_id.as_str(), workspace_id.as_str()],
        )
    }

    fn query_json<T, P>(&self, sql: &str, params: P) -> CapabilityResult<Option<T>>
    where
        T: DeserializeOwned,
        P: rusqlite::Params,
    {
        self.connection
            .query_row(sql, params, |row| row.get::<_, String>(0))
            .optional()
            .map_err(to_store_error)?
            .map(|value| serde_json::from_str(&value).map_err(to_json_error))
            .transpose()
    }

    fn query_json_list<T, P>(&self, sql: &str, params: P) -> CapabilityResult<Vec<T>>
    where
        T: DeserializeOwned,
        P: rusqlite::Params,
    {
        let mut statement = self.connection.prepare(sql).map_err(to_store_error)?;
        let rows = statement
            .query_map(params, |row| row.get::<_, String>(0))
            .map_err(to_store_error)?;
        let mut values = Vec::new();
        for row in rows {
            values
                .push(serde_json::from_str(&row.map_err(to_store_error)?).map_err(to_json_error)?);
        }
        Ok(values)
    }
}

fn json<T: Serialize>(value: &T) -> CapabilityResult<String> {
    serde_json::to_string(value).map_err(to_json_error)
}

fn enum_json<T: Serialize>(value: T) -> CapabilityResult<String> {
    serde_json::to_value(value)
        .map_err(to_json_error)?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| CapabilityError::ToolExecutionFailed("enum is not string".to_string()))
}

fn to_store_error(error: rusqlite::Error) -> CapabilityError {
    CapabilityError::ToolExecutionFailed(format!("skill_plugin_registry:{error}"))
}

fn to_json_error(error: serde_json::Error) -> CapabilityError {
    CapabilityError::ToolExecutionFailed(format!("skill_plugin_registry_json:{error}"))
}

// NOTE (F1.b / caposaldo #5): there used to be a `SkillCapabilityProvider` here — a
// `CapabilityProvider` that listed a skill's manifest tools but whose `call_tool` ALWAYS
// returned `skill_execution_unavailable`. That was a category error: a skill is prose +
// scripts the model FOLLOWS, not a typed callable tool (see docs/architecture/skills.md
// "Perché è così"). The single, canonical skill-execution path is the gateway's
// filesystem one (`skills.rs` + `use_skill` + `run_in_sandbox`). This module is now a
// METADATA store only (manifests, installs, trust, scoping) — the future signed-
// distribution foundation (plugins.md WS9) — never a parallel execution provider.
