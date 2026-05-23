use crate::{
    ActionClass, CapabilityError, CapabilityProviderKind, CapabilityResult,
    ManagedProviderMetadata, PolicyContext, ProviderId, UserId, WorkspaceId,
};
use local_first_task_runtime::ResourceClass;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::Path;
use time::OffsetDateTime;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CapabilityProviderConfig {
    pub provider_id: ProviderId,
    pub provider_kind: CapabilityProviderKind,
    pub display_name: String,
    pub enabled_by_default: bool,
    pub managed_metadata: Option<ManagedProviderMetadata>,
    pub resource_class: ResourceClass,
    pub rate_limit_per_minute: Option<u32>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

impl CapabilityProviderConfig {
    pub fn new(
        provider_id: ProviderId,
        provider_kind: CapabilityProviderKind,
        display_name: String,
        enabled_by_default: bool,
    ) -> Self {
        let now = OffsetDateTime::now_utc();
        Self {
            provider_id,
            provider_kind,
            display_name,
            enabled_by_default,
            managed_metadata: None,
            resource_class: default_resource_for_kind(provider_kind),
            rate_limit_per_minute: None,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn with_managed_metadata(mut self, metadata: ManagedProviderMetadata) -> Self {
        self.managed_metadata = Some(metadata);
        self
    }

    pub fn with_resource_class(mut self, resource_class: ResourceClass) -> Self {
        self.resource_class = resource_class;
        self
    }

    pub fn with_rate_limit_per_minute(mut self, rate_limit_per_minute: u32) -> Self {
        self.rate_limit_per_minute = Some(rate_limit_per_minute);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CapabilityProviderGrant {
    pub provider_id: ProviderId,
    pub user_id: UserId,
    pub workspace_id: WorkspaceId,
    pub enabled: bool,
    pub allow_managed_cloud: bool,
    pub privacy_domains: Vec<String>,
    pub allowed_actions: Vec<ActionClass>,
    pub max_autonomy_level: u8,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

impl CapabilityProviderGrant {
    pub fn new(provider_id: ProviderId, user_id: UserId, workspace_id: WorkspaceId) -> Self {
        let now = OffsetDateTime::now_utc();
        Self {
            provider_id,
            user_id,
            workspace_id,
            enabled: true,
            allow_managed_cloud: false,
            privacy_domains: Vec::new(),
            allowed_actions: vec![ActionClass::Read],
            max_autonomy_level: 0,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn disabled(mut self) -> Self {
        self.enabled = false;
        self
    }

    pub fn with_allow_managed_cloud(mut self, allow_managed_cloud: bool) -> Self {
        self.allow_managed_cloud = allow_managed_cloud;
        self
    }

    pub fn with_privacy_domains(mut self, privacy_domains: Vec<String>) -> Self {
        self.privacy_domains = privacy_domains;
        self
    }

    pub fn with_allowed_actions(mut self, allowed_actions: Vec<ActionClass>) -> Self {
        self.allowed_actions = allowed_actions;
        self
    }

    pub fn with_max_autonomy_level(mut self, max_autonomy_level: u8) -> Self {
        self.max_autonomy_level = max_autonomy_level;
        self
    }
}

pub struct CapabilityRegistryStore {
    connection: Connection,
}

impl CapabilityRegistryStore {
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
                CREATE TABLE IF NOT EXISTS capability_registry_metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS capability_provider_configs (
                    provider_id TEXT PRIMARY KEY,
                    provider_kind TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    enabled_by_default INTEGER NOT NULL,
                    managed_metadata_json TEXT,
                    resource_class TEXT NOT NULL,
                    rate_limit_per_minute INTEGER,
                    config_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS capability_provider_grants (
                    provider_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    workspace_id TEXT NOT NULL,
                    enabled INTEGER NOT NULL,
                    allow_managed_cloud INTEGER NOT NULL,
                    grant_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (provider_id, user_id, workspace_id)
                );

                CREATE INDEX IF NOT EXISTS idx_capability_provider_grants_scope
                    ON capability_provider_grants(user_id, workspace_id, enabled);

                INSERT INTO capability_registry_metadata(key, value)
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
                "SELECT value FROM capability_registry_metadata WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .map_err(to_store_error)?;
        value
            .parse::<u32>()
            .map_err(|error| CapabilityError::ToolExecutionFailed(error.to_string()))
    }

    pub fn upsert_provider_config(
        &self,
        config: &CapabilityProviderConfig,
    ) -> CapabilityResult<()> {
        self.connection
            .execute(
                "
                INSERT INTO capability_provider_configs (
                    provider_id,
                    provider_kind,
                    display_name,
                    enabled_by_default,
                    managed_metadata_json,
                    resource_class,
                    rate_limit_per_minute,
                    config_json,
                    created_at,
                    updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                ON CONFLICT(provider_id) DO UPDATE SET
                    provider_kind = excluded.provider_kind,
                    display_name = excluded.display_name,
                    enabled_by_default = excluded.enabled_by_default,
                    managed_metadata_json = excluded.managed_metadata_json,
                    resource_class = excluded.resource_class,
                    rate_limit_per_minute = excluded.rate_limit_per_minute,
                    config_json = excluded.config_json,
                    updated_at = excluded.updated_at
                ",
                params![
                    config.provider_id.as_str(),
                    provider_kind_value(config.provider_kind)?,
                    config.display_name,
                    config.enabled_by_default,
                    option_json(&config.managed_metadata)?,
                    config.resource_class.as_str(),
                    config.rate_limit_per_minute,
                    serde_json::to_string(config).map_err(to_json_error)?,
                    config.created_at.unix_timestamp(),
                    OffsetDateTime::now_utc().unix_timestamp(),
                ],
            )
            .map_err(to_store_error)?;
        Ok(())
    }

    pub fn provider_config(
        &self,
        provider_id: &ProviderId,
    ) -> CapabilityResult<Option<CapabilityProviderConfig>> {
        self.connection
            .query_row(
                "SELECT config_json FROM capability_provider_configs WHERE provider_id = ?1",
                params![provider_id.as_str()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(to_store_error)?
            .map(|json| serde_json::from_str(&json).map_err(to_json_error))
            .transpose()
    }

    pub fn upsert_provider_grant(&self, grant: &CapabilityProviderGrant) -> CapabilityResult<()> {
        self.connection
            .execute(
                "
                INSERT INTO capability_provider_grants (
                    provider_id,
                    user_id,
                    workspace_id,
                    enabled,
                    allow_managed_cloud,
                    grant_json,
                    created_at,
                    updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                ON CONFLICT(provider_id, user_id, workspace_id) DO UPDATE SET
                    enabled = excluded.enabled,
                    allow_managed_cloud = excluded.allow_managed_cloud,
                    grant_json = excluded.grant_json,
                    updated_at = excluded.updated_at
                ",
                params![
                    grant.provider_id.as_str(),
                    grant.user_id.as_str(),
                    grant.workspace_id.as_str(),
                    grant.enabled,
                    grant.allow_managed_cloud,
                    serde_json::to_string(grant).map_err(to_json_error)?,
                    grant.created_at.unix_timestamp(),
                    OffsetDateTime::now_utc().unix_timestamp(),
                ],
            )
            .map_err(to_store_error)?;
        Ok(())
    }

    pub fn provider_grants(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> CapabilityResult<Vec<CapabilityProviderGrant>> {
        let mut statement = self
            .connection
            .prepare(
                "
                SELECT grant_json
                FROM capability_provider_grants
                WHERE user_id = ?1 AND workspace_id = ?2
                ORDER BY provider_id ASC
                ",
            )
            .map_err(to_store_error)?;
        let rows = statement
            .query_map(params![user_id.as_str(), workspace_id.as_str()], |row| {
                row.get::<_, String>(0)
            })
            .map_err(to_store_error)?;

        let mut grants = Vec::new();
        for row in rows {
            grants
                .push(serde_json::from_str(&row.map_err(to_store_error)?).map_err(to_json_error)?);
        }
        Ok(grants)
    }

    pub fn policy_context(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> CapabilityResult<PolicyContext> {
        let grants = self.provider_grants(user_id, workspace_id)?;
        let enabled_grants = grants.into_iter().filter(|grant| grant.enabled);
        let mut enabled_providers = Vec::new();
        let mut privacy_domains = BTreeSet::new();
        let mut allowed_actions = Vec::new();
        let mut max_autonomy_level = 0;
        let mut allow_managed_cloud = false;

        for grant in enabled_grants {
            enabled_providers.push(grant.provider_id.clone());
            allow_managed_cloud |= grant.allow_managed_cloud;
            max_autonomy_level = max_autonomy_level.max(grant.max_autonomy_level);
            for domain in grant.privacy_domains {
                privacy_domains.insert(domain);
            }
            for action in grant.allowed_actions {
                if !allowed_actions.contains(&action) {
                    allowed_actions.push(action);
                }
            }
        }

        Ok(PolicyContext {
            user_id: user_id.clone(),
            workspace_id: workspace_id.clone(),
            enabled_providers,
            privacy_domains: privacy_domains.into_iter().collect(),
            allowed_actions,
            max_autonomy_level,
            allow_managed_cloud,
        })
    }
}

fn default_resource_for_kind(kind: CapabilityProviderKind) -> ResourceClass {
    match kind {
        CapabilityProviderKind::Native => ResourceClass::FilesystemIo,
        CapabilityProviderKind::Mcp | CapabilityProviderKind::Managed => {
            ResourceClass::ConnectorApi
        }
        CapabilityProviderKind::Browser => ResourceClass::BrowserSession,
        CapabilityProviderKind::Skill => ResourceClass::BackgroundMaintenance,
    }
}

fn provider_kind_value(kind: CapabilityProviderKind) -> CapabilityResult<String> {
    serde_json::to_value(kind)
        .map_err(to_json_error)?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| {
            CapabilityError::ToolExecutionFailed("provider kind is not string".to_string())
        })
}

fn option_json<T: Serialize>(value: &Option<T>) -> CapabilityResult<Option<String>> {
    value
        .as_ref()
        .map(|value| serde_json::to_string(value).map_err(to_json_error))
        .transpose()
}

fn to_store_error(error: rusqlite::Error) -> CapabilityError {
    CapabilityError::ToolExecutionFailed(format!("registry_store:{error}"))
}

fn to_json_error(error: serde_json::Error) -> CapabilityError {
    CapabilityError::ToolExecutionFailed(format!("registry_json:{error}"))
}
