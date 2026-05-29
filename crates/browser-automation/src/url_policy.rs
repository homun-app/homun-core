use crate::{BrowserAutomationError, BrowserResult};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::path::Path;
use time::OffsetDateTime;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserUrlApprovalScope {
    Once,
    Always,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserVisibilityMode {
    Auto,
    Headless,
    Visible,
}

impl BrowserVisibilityMode {
    pub fn headless_env_value(self, fallback: &str) -> String {
        match self {
            Self::Auto => fallback.to_string(),
            Self::Headless => "1".to_string(),
            Self::Visible => "0".to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserUrlApprovalGrant {
    pub user_id: String,
    pub workspace_id: String,
    pub url: String,
    pub action: String,
    pub scope: BrowserUrlApprovalScope,
    pub visibility: BrowserVisibilityMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserUrlApprovalRule {
    pub rule_id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub origin: String,
    pub action: String,
    pub visibility: BrowserVisibilityMode,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

pub struct BrowserUrlPolicyStore {
    connection: Connection,
}

impl BrowserUrlPolicyStore {
    pub fn open(path: impl AsRef<Path>) -> BrowserResult<Self> {
        let store = Self {
            connection: Connection::open(path)
                .map_err(|error| BrowserAutomationError::InvalidResponse(error.to_string()))?,
        };
        store.run_migrations()?;
        Ok(store)
    }

    pub fn open_in_memory() -> BrowserResult<Self> {
        let store = Self {
            connection: Connection::open_in_memory()
                .map_err(|error| BrowserAutomationError::InvalidResponse(error.to_string()))?,
        };
        store.run_migrations()?;
        Ok(store)
    }

    pub fn run_migrations(&self) -> BrowserResult<()> {
        self.connection
            .execute_batch(
                "
                CREATE TABLE IF NOT EXISTS browser_url_approval_rules (
                    rule_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    workspace_id TEXT NOT NULL,
                    origin TEXT NOT NULL,
                    action TEXT NOT NULL,
                    visibility TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    UNIQUE(user_id, workspace_id, origin, action)
                );

                CREATE INDEX IF NOT EXISTS idx_browser_url_rules_scope
                    ON browser_url_approval_rules(user_id, workspace_id, origin, action);
                ",
            )
            .map_err(|error| BrowserAutomationError::InvalidResponse(error.to_string()))?;
        Ok(())
    }

    pub fn grant(
        &self,
        grant: &BrowserUrlApprovalGrant,
    ) -> BrowserResult<Option<BrowserUrlApprovalRule>> {
        if grant.scope == BrowserUrlApprovalScope::Once {
            return Ok(None);
        }
        let origin = origin_for_url(&grant.url)?;
        let now = OffsetDateTime::now_utc();
        let existing =
            self.rule_for_origin(&grant.user_id, &grant.workspace_id, &origin, &grant.action)?;
        let rule_id = existing
            .as_ref()
            .map(|rule| rule.rule_id.clone())
            .unwrap_or_else(|| new_rule_id(&origin, &grant.action, now));
        self.connection
            .execute(
                "
                INSERT INTO browser_url_approval_rules (
                    rule_id, user_id, workspace_id, origin, action, visibility, created_at, updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                ON CONFLICT(user_id, workspace_id, origin, action) DO UPDATE SET
                    visibility = excluded.visibility,
                    updated_at = excluded.updated_at
                ",
                params![
                    rule_id,
                    grant.user_id,
                    grant.workspace_id,
                    origin,
                    grant.action,
                    visibility_label(grant.visibility),
                    existing
                        .as_ref()
                        .map(|rule| rule.created_at.unix_timestamp())
                        .unwrap_or_else(|| now.unix_timestamp()),
                    now.unix_timestamp(),
                ],
            )
            .map_err(|error| BrowserAutomationError::InvalidResponse(error.to_string()))?;
        self.rule_for_origin(&grant.user_id, &grant.workspace_id, &origin, &grant.action)
    }

    pub fn rule_for_url(
        &self,
        user_id: &str,
        workspace_id: &str,
        url: &str,
        action: &str,
    ) -> BrowserResult<Option<BrowserUrlApprovalRule>> {
        let origin = origin_for_url(url)?;
        self.rule_for_origin(user_id, workspace_id, &origin, action)
    }

    pub fn rules(
        &self,
        user_id: &str,
        workspace_id: &str,
    ) -> BrowserResult<Vec<BrowserUrlApprovalRule>> {
        let mut statement = self
            .connection
            .prepare(
                "
                SELECT rule_id, user_id, workspace_id, origin, action, visibility, created_at, updated_at
                FROM browser_url_approval_rules
                WHERE user_id = ?1 AND workspace_id = ?2
                ORDER BY updated_at DESC, origin ASC
                ",
            )
            .map_err(|error| BrowserAutomationError::InvalidResponse(error.to_string()))?;
        let rows = statement
            .query_map(params![user_id, workspace_id], row_to_rule)
            .map_err(|error| BrowserAutomationError::InvalidResponse(error.to_string()))?;
        let mut rules = Vec::new();
        for row in rows {
            rules.push(
                row.map_err(|error| BrowserAutomationError::InvalidResponse(error.to_string()))?,
            );
        }
        Ok(rules)
    }

    fn rule_for_origin(
        &self,
        user_id: &str,
        workspace_id: &str,
        origin: &str,
        action: &str,
    ) -> BrowserResult<Option<BrowserUrlApprovalRule>> {
        self.connection
            .query_row(
                "
                SELECT rule_id, user_id, workspace_id, origin, action, visibility, created_at, updated_at
                FROM browser_url_approval_rules
                WHERE user_id = ?1 AND workspace_id = ?2 AND origin = ?3 AND action = ?4
                ",
                params![user_id, workspace_id, origin, action],
                row_to_rule,
            )
            .optional()
            .map_err(|error| BrowserAutomationError::InvalidResponse(error.to_string()))
    }
}

pub fn origin_for_url(url: &str) -> BrowserResult<String> {
    let trimmed = url.trim();
    let Some((scheme, rest)) = trimmed.split_once("://") else {
        return Err(BrowserAutomationError::NavigationBlocked(
            "invalid URL".to_string(),
        ));
    };
    let host_port = rest
        .split(['/', '?', '#'])
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| BrowserAutomationError::NavigationBlocked("invalid URL".to_string()))?;
    Ok(format!(
        "{}://{}",
        scheme.to_ascii_lowercase(),
        host_port.to_ascii_lowercase()
    ))
}

fn row_to_rule(row: &rusqlite::Row<'_>) -> rusqlite::Result<BrowserUrlApprovalRule> {
    let created_at: i64 = row.get(6)?;
    let updated_at: i64 = row.get(7)?;
    Ok(BrowserUrlApprovalRule {
        rule_id: row.get(0)?,
        user_id: row.get(1)?,
        workspace_id: row.get(2)?,
        origin: row.get(3)?,
        action: row.get(4)?,
        visibility: parse_visibility(&row.get::<_, String>(5)?),
        created_at: OffsetDateTime::from_unix_timestamp(created_at)
            .unwrap_or(OffsetDateTime::UNIX_EPOCH),
        updated_at: OffsetDateTime::from_unix_timestamp(updated_at)
            .unwrap_or(OffsetDateTime::UNIX_EPOCH),
    })
}

fn parse_visibility(value: &str) -> BrowserVisibilityMode {
    match value {
        "headless" => BrowserVisibilityMode::Headless,
        "visible" => BrowserVisibilityMode::Visible,
        _ => BrowserVisibilityMode::Auto,
    }
}

fn visibility_label(value: BrowserVisibilityMode) -> &'static str {
    match value {
        BrowserVisibilityMode::Auto => "auto",
        BrowserVisibilityMode::Headless => "headless",
        BrowserVisibilityMode::Visible => "visible",
    }
}

fn new_rule_id(origin: &str, action: &str, now: OffsetDateTime) -> String {
    let safe_origin = origin
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    format!(
        "browser_url_rule_{}_{}_{}",
        safe_origin,
        action,
        now.unix_timestamp_nanos()
    )
}
