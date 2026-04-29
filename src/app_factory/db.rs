use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;

use super::blueprint::AppBlueprint;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct InternalAppRow {
    pub id: i64,
    pub user_id: String,
    pub profile_id: Option<i64>,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub blueprint_json: String,
    pub db_path: String,
    pub schema_version: i64,
    pub storage_mode: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct InternalAppBridgePolicyRow {
    pub id: i64,
    pub app_id: i64,
    pub policy_json: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct AppRecordRow {
    pub id: i64,
    pub entity_name: String,
    pub data_json: String,
    pub status: Option<String>,
    pub created_by_user_id: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct AppEventRow {
    pub id: i64,
    pub record_id: Option<i64>,
    pub event_type: String,
    pub payload_json: String,
    pub actor_user_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct AppUserRow {
    pub id: i64,
    pub email: String,
    pub display_name: String,
    pub password_hash: String,
    pub role: String,
    pub status: String,
    pub contact_id: Option<i64>,
    pub created_at: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct AppSessionRow {
    pub id: String,
    pub app_user_id: i64,
    pub expires_at: String,
    pub created_at: String,
}

pub fn app_db_path(data_dir: &Path, user_id: &str, app_slug: &str) -> PathBuf {
    data_dir
        .join("apps")
        .join(user_id)
        .join(app_slug)
        .join("app.db")
}

pub async fn open_app_pool(db_path: &Path) -> Result<SqlitePool> {
    if let Some(parent) = db_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("Failed to create app DB directory {}", parent.display()))?;
    }

    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
        .with_context(|| format!("Failed to open app database at {}", db_path.display()))?;

    migrate_app_db(&pool).await?;
    Ok(pool)
}

pub async fn migrate_app_db(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS app_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_name TEXT NOT NULL,
            data_json TEXT NOT NULL,
            status TEXT,
            created_by_user_id TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT
        )",
    )
    .execute(pool)
    .await
    .context("Failed to create app_records table")?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS app_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            record_id INTEGER,
            event_type TEXT NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}',
            actor_user_id TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(pool)
    .await
    .context("Failed to create app_events table")?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS app_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            contact_id INTEGER,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT
        )",
    )
    .execute(pool)
    .await
    .context("Failed to create app_users table")?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS app_sessions (
            id TEXT PRIMARY KEY,
            app_user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(pool)
    .await
    .context("Failed to create app_sessions table")?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS app_invites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL,
            role TEXT NOT NULL,
            token_hash TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(pool)
    .await
    .context("Failed to create app_invites table")?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_app_records_entity ON app_records(entity_name)")
        .execute(pool)
        .await
        .context("Failed to create app_records entity index")?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_app_events_record ON app_events(record_id)")
        .execute(pool)
        .await
        .context("Failed to create app_events record index")?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_app_users_email ON app_users(email)")
        .execute(pool)
        .await
        .context("Failed to create app_users email index")?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_app_sessions_user ON app_sessions(app_user_id)")
        .execute(pool)
        .await
        .context("Failed to create app_sessions user index")?;

    Ok(())
}

pub async fn insert_app(
    control_pool: &SqlitePool,
    data_dir: &Path,
    user_id: &str,
    profile_id: Option<i64>,
    blueprint: &AppBlueprint,
) -> Result<i64> {
    let blueprint_json = serde_json::to_string(blueprint)?;
    let db_path = app_db_path(data_dir, user_id, &blueprint.app.slug);
    let app_pool = open_app_pool(&db_path).await?;
    app_pool.close().await;
    let db_path = db_path.to_string_lossy().into_owned();

    let id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO internal_apps (user_id, profile_id, slug, name, description, blueprint_json, db_path)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id",
    )
    .bind(user_id)
    .bind(profile_id)
    .bind(&blueprint.app.slug)
    .bind(&blueprint.app.name)
    .bind(blueprint.app.description.as_deref())
    .bind(blueprint_json)
    .bind(db_path)
    .fetch_one(control_pool)
    .await
    .context("Failed to insert internal app metadata")?;

    Ok(id)
}

pub async fn list_apps_for_user(
    control_pool: &SqlitePool,
    user_id: &str,
    profile_id: Option<i64>,
) -> Result<Vec<InternalAppRow>> {
    let rows = if let Some(profile_id) = profile_id {
        sqlx::query_as::<_, InternalAppRow>(
            "SELECT id, user_id, profile_id, slug, name, description, blueprint_json,
                    db_path, schema_version, storage_mode, status, created_at, updated_at
             FROM internal_apps
             WHERE user_id = ? AND (profile_id IS NULL OR profile_id = ?)
             ORDER BY COALESCE(updated_at, created_at) DESC, created_at DESC",
        )
        .bind(user_id)
        .bind(profile_id)
        .fetch_all(control_pool)
        .await?
    } else {
        sqlx::query_as::<_, InternalAppRow>(
            "SELECT id, user_id, profile_id, slug, name, description, blueprint_json,
                    db_path, schema_version, storage_mode, status, created_at, updated_at
             FROM internal_apps
             WHERE user_id = ?
             ORDER BY COALESCE(updated_at, created_at) DESC, created_at DESC",
        )
        .bind(user_id)
        .fetch_all(control_pool)
        .await?
    };

    Ok(rows)
}

pub async fn load_app_for_user(
    control_pool: &SqlitePool,
    user_id: &str,
    slug: &str,
) -> Result<Option<InternalAppRow>> {
    let row = sqlx::query_as::<_, InternalAppRow>(
        "SELECT id, user_id, profile_id, slug, name, description, blueprint_json,
                db_path, schema_version, storage_mode, status, created_at, updated_at
         FROM internal_apps
         WHERE user_id = ? AND slug = ?",
    )
    .bind(user_id)
    .bind(slug)
    .fetch_optional(control_pool)
    .await?;

    Ok(row)
}

pub async fn upsert_bridge_policy(
    control_pool: &SqlitePool,
    app_id: i64,
    policy: &crate::app_factory::bridge::BridgePolicy,
) -> Result<i64> {
    let policy_json = serde_json::to_string(policy)?;
    let id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO internal_app_bridge_policies (app_id, policy_json, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(app_id) DO UPDATE SET
             policy_json = excluded.policy_json,
             status = 'active',
             updated_at = datetime('now')
         RETURNING id",
    )
    .bind(app_id)
    .bind(policy_json)
    .fetch_one(control_pool)
    .await
    .context("Failed to upsert bridge policy")?;

    Ok(id)
}

pub async fn load_bridge_policy(
    control_pool: &SqlitePool,
    app_id: i64,
) -> Result<Option<InternalAppBridgePolicyRow>> {
    let row = sqlx::query_as::<_, InternalAppBridgePolicyRow>(
        "SELECT id, app_id, policy_json, status, created_at, updated_at
         FROM internal_app_bridge_policies
         WHERE app_id = ? AND status = 'active'",
    )
    .bind(app_id)
    .fetch_optional(control_pool)
    .await
    .context("Failed to load bridge policy")?;

    Ok(row)
}

pub async fn insert_record(
    app_pool: &SqlitePool,
    entity_name: &str,
    data: &serde_json::Value,
    status: Option<&str>,
    created_by_user_id: Option<&str>,
) -> Result<i64> {
    let data_json = serde_json::to_string(data)?;
    let id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO app_records (entity_name, data_json, status, created_by_user_id)
         VALUES (?, ?, ?, ?)
         RETURNING id",
    )
    .bind(entity_name)
    .bind(data_json)
    .bind(status)
    .bind(created_by_user_id)
    .fetch_one(app_pool)
    .await
    .context("Failed to insert app record")?;

    Ok(id)
}

pub async fn list_records(
    app_pool: &SqlitePool,
    entity_name: &str,
    limit: i64,
) -> Result<Vec<AppRecordRow>> {
    let rows = sqlx::query_as::<_, AppRecordRow>(
        "SELECT id, entity_name, data_json, status, created_by_user_id, created_at, updated_at
         FROM app_records
         WHERE entity_name = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?",
    )
    .bind(entity_name)
    .bind(limit)
    .fetch_all(app_pool)
    .await?;

    Ok(rows)
}

pub async fn load_record(app_pool: &SqlitePool, record_id: i64) -> Result<Option<AppRecordRow>> {
    let row = sqlx::query_as::<_, AppRecordRow>(
        "SELECT id, entity_name, data_json, status, created_by_user_id, created_at, updated_at
         FROM app_records
         WHERE id = ?",
    )
    .bind(record_id)
    .fetch_optional(app_pool)
    .await?;

    Ok(row)
}

pub async fn insert_app_user(
    app_pool: &SqlitePool,
    email: &str,
    display_name: &str,
    password_hash: &str,
    role: &str,
    contact_id: Option<i64>,
) -> Result<i64> {
    let normalized_email = email.trim().to_ascii_lowercase();
    let display_name = display_name.trim();
    let id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO app_users (email, display_name, password_hash, role, contact_id)
         VALUES (?, ?, ?, ?, ?)
         RETURNING id",
    )
    .bind(normalized_email)
    .bind(display_name)
    .bind(password_hash)
    .bind(role)
    .bind(contact_id)
    .fetch_one(app_pool)
    .await
    .context("Failed to insert app user")?;

    Ok(id)
}

pub async fn load_app_user(app_pool: &SqlitePool, app_user_id: i64) -> Result<Option<AppUserRow>> {
    let row = sqlx::query_as::<_, AppUserRow>(
        "SELECT id, email, display_name, password_hash, role, status, contact_id, created_at, updated_at
         FROM app_users
         WHERE id = ?",
    )
    .bind(app_user_id)
    .fetch_optional(app_pool)
    .await?;

    Ok(row)
}

pub async fn load_app_user_by_email(
    app_pool: &SqlitePool,
    email: &str,
) -> Result<Option<AppUserRow>> {
    let normalized_email = email.trim().to_ascii_lowercase();
    let row = sqlx::query_as::<_, AppUserRow>(
        "SELECT id, email, display_name, password_hash, role, status, contact_id, created_at, updated_at
         FROM app_users
         WHERE email = ?",
    )
    .bind(normalized_email)
    .fetch_optional(app_pool)
    .await?;

    Ok(row)
}

pub async fn list_app_users(app_pool: &SqlitePool) -> Result<Vec<AppUserRow>> {
    let rows = sqlx::query_as::<_, AppUserRow>(
        "SELECT id, email, display_name, password_hash, role, status, contact_id, created_at, updated_at
         FROM app_users
         ORDER BY display_name COLLATE NOCASE ASC, email ASC",
    )
    .fetch_all(app_pool)
    .await?;

    Ok(rows)
}

pub async fn insert_app_session(
    app_pool: &SqlitePool,
    session_id: &str,
    app_user_id: i64,
    expires_at: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO app_sessions (id, app_user_id, expires_at)
         VALUES (?, ?, ?)",
    )
    .bind(session_id)
    .bind(app_user_id)
    .bind(expires_at)
    .execute(app_pool)
    .await
    .context("Failed to insert app session")?;

    Ok(())
}

pub async fn load_app_session(
    app_pool: &SqlitePool,
    session_id: &str,
) -> Result<Option<AppSessionRow>> {
    let row = sqlx::query_as::<_, AppSessionRow>(
        "SELECT id, app_user_id, expires_at, created_at
         FROM app_sessions
         WHERE id = ? AND expires_at > datetime('now')",
    )
    .bind(session_id)
    .fetch_optional(app_pool)
    .await?;

    Ok(row)
}

pub async fn delete_app_session(app_pool: &SqlitePool, session_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM app_sessions WHERE id = ?")
        .bind(session_id)
        .execute(app_pool)
        .await
        .context("Failed to delete app session")?;

    Ok(())
}

pub async fn update_record_data(
    app_pool: &SqlitePool,
    record_id: i64,
    data: &serde_json::Value,
    status: Option<&str>,
) -> Result<()> {
    let data_json = serde_json::to_string(data)?;
    sqlx::query(
        "UPDATE app_records
         SET data_json = ?, status = ?, updated_at = datetime('now')
         WHERE id = ?",
    )
    .bind(data_json)
    .bind(status)
    .bind(record_id)
    .execute(app_pool)
    .await
    .context("Failed to update app record")?;

    Ok(())
}

pub async fn insert_app_event(
    app_pool: &SqlitePool,
    record_id: Option<i64>,
    event_type: &str,
    payload: &serde_json::Value,
    actor_user_id: Option<&str>,
) -> Result<i64> {
    let id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO app_events (record_id, event_type, payload_json, actor_user_id)
         VALUES (?, ?, ?, ?)
         RETURNING id",
    )
    .bind(record_id)
    .bind(event_type)
    .bind(serde_json::to_string(payload)?)
    .bind(actor_user_id)
    .fetch_one(app_pool)
    .await
    .context("Failed to insert app event")?;

    Ok(id)
}

pub async fn insert_internal_app_event(
    control_pool: &SqlitePool,
    app_id: i64,
    record_id: Option<i64>,
    event_type: &str,
    payload: &serde_json::Value,
    actor_user_id: Option<&str>,
) -> Result<i64> {
    let id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO internal_app_events (app_id, record_id, event_type, payload_json, actor_user_id)
         VALUES (?, ?, ?, ?, ?)
         RETURNING id",
    )
    .bind(app_id)
    .bind(record_id)
    .bind(event_type)
    .bind(serde_json::to_string(payload)?)
    .bind(actor_user_id)
    .fetch_one(control_pool)
    .await
    .context("Failed to insert internal app event")?;

    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_factory::blueprint::AppBlueprint;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    fn valid_leave_blueprint(slug: &str) -> AppBlueprint {
        serde_json::from_value(serde_json::json!({
            "version": 1,
            "app": {"slug": slug, "name": "Ferie e Permessi"},
            "entities": [
                {"name": "leave_request", "label": "Richiesta", "fields": [
                    {"name": "status", "type": "enum", "label": "Stato", "options": ["pending", "approved"], "default": "pending"}
                ]}
            ],
            "views": [
                {"type": "table", "entity": "leave_request", "name": "Richieste", "columns": ["status"]}
            ]
        }))
        .unwrap()
    }

    async fn test_control_pool(dir: &TempDir) -> SqlitePool {
        let db_path = dir.path().join("homun.db");
        let options = SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();

        for statement in include_str!("../../migrations/056_internal_apps.sql").split(';') {
            let statement = statement.trim();
            if !statement.is_empty() {
                sqlx::query(statement).execute(&pool).await.unwrap();
            }
        }
        for statement in
            include_str!("../../migrations/057_internal_app_bridge_policies.sql").split(';')
        {
            let statement = statement.trim();
            if !statement.is_empty() {
                sqlx::query(statement).execute(&pool).await.unwrap();
            }
        }

        pool
    }

    async fn test_app_pool(dir: &TempDir, slug: &str) -> SqlitePool {
        let db_path = app_db_path(dir.path(), "user-1", slug);
        open_app_pool(&db_path).await.unwrap()
    }

    #[test]
    fn app_db_path_places_database_under_user_and_app_slug() {
        let base = std::path::Path::new("/tmp/homun-data");

        let path = app_db_path(base, "user-1", "ferie-permessi");

        assert_eq!(
            path,
            base.join("apps")
                .join("user-1")
                .join("ferie-permessi")
                .join("app.db")
        );
    }

    #[tokio::test]
    async fn insert_app_creates_metadata_row_and_app_database() {
        let dir = TempDir::new().unwrap();
        let control_pool = test_control_pool(&dir).await;
        let blueprint = valid_leave_blueprint("ferie-permessi");

        let app_id = insert_app(&control_pool, dir.path(), "user-1", Some(7), &blueprint)
            .await
            .unwrap();
        let row = load_app_for_user(&control_pool, "user-1", "ferie-permessi")
            .await
            .unwrap()
            .unwrap();

        assert_eq!(row.id, app_id);
        assert_eq!(row.user_id, "user-1");
        assert_eq!(row.profile_id, Some(7));
        assert_eq!(row.storage_mode, "sqlite_per_app");
        assert!(std::path::Path::new(&row.db_path).exists());
        assert!(row.db_path.ends_with("apps/user-1/ferie-permessi/app.db"));
    }

    #[tokio::test]
    async fn load_app_for_user_does_not_cross_user_boundary() {
        let dir = TempDir::new().unwrap();
        let control_pool = test_control_pool(&dir).await;
        let blueprint = valid_leave_blueprint("ferie-permessi");

        insert_app(&control_pool, dir.path(), "user-1", None, &blueprint)
            .await
            .unwrap();

        let row = load_app_for_user(&control_pool, "user-2", "ferie-permessi")
            .await
            .unwrap();

        assert!(row.is_none());
    }

    #[tokio::test]
    async fn app_records_are_isolated_by_database_file() {
        let dir = TempDir::new().unwrap();
        let first_path = app_db_path(dir.path(), "user-1", "ferie");
        let second_path = app_db_path(dir.path(), "user-1", "crm");
        let first_pool = open_app_pool(&first_path).await.unwrap();
        let second_pool = open_app_pool(&second_path).await.unwrap();

        insert_record(
            &first_pool,
            "leave_request",
            &serde_json::json!({"status": "pending"}),
            Some("pending"),
            Some("user-1"),
        )
        .await
        .unwrap();

        let first_records = list_records(&first_pool, "leave_request", 20)
            .await
            .unwrap();
        let second_records = list_records(&second_pool, "leave_request", 20)
            .await
            .unwrap();

        assert_eq!(first_records.len(), 1);
        assert_eq!(first_records[0].status.as_deref(), Some("pending"));
        assert!(second_records.is_empty());
    }

    #[tokio::test]
    async fn app_db_migration_creates_app_identity_tables() {
        let dir = TempDir::new().unwrap();
        let pool = test_app_pool(&dir, "identity").await;

        let table_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
             FROM sqlite_master
             WHERE type = 'table' AND name IN ('app_users', 'app_sessions', 'app_invites')",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(table_count, 3);
    }

    #[tokio::test]
    async fn app_user_crud_and_session_lookup_work() {
        let dir = TempDir::new().unwrap();
        let pool = test_app_pool(&dir, "identity").await;

        let user_id = insert_app_user(
            &pool,
            " Employee@Example.COM ",
            " Mario Rossi ",
            "hash",
            "employee",
            Some(42),
        )
        .await
        .unwrap();

        let user = load_app_user_by_email(&pool, "employee@example.com")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(user.id, user_id);
        assert_eq!(user.email, "employee@example.com");
        assert_eq!(user.display_name, "Mario Rossi");
        assert_eq!(user.password_hash, "hash");
        assert_eq!(user.role, "employee");
        assert_eq!(user.status, "active");
        assert_eq!(user.contact_id, Some(42));

        let loaded_by_id = load_app_user(&pool, user_id).await.unwrap().unwrap();
        assert_eq!(loaded_by_id.email, "employee@example.com");

        let all_users = list_app_users(&pool).await.unwrap();
        assert_eq!(all_users.len(), 1);

        insert_app_session(&pool, "session-1", user_id, "2099-01-01 00:00:00")
            .await
            .unwrap();
        let session = load_app_session(&pool, "session-1").await.unwrap().unwrap();
        assert_eq!(session.id, "session-1");
        assert_eq!(session.app_user_id, user_id);

        delete_app_session(&pool, "session-1").await.unwrap();
        assert!(load_app_session(&pool, "session-1")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn bridge_policy_upsert_and_load_work() {
        let dir = TempDir::new().unwrap();
        let control_pool = test_control_pool(&dir).await;
        let blueprint = valid_leave_blueprint("ferie-permessi");
        let app_id = insert_app(&control_pool, dir.path(), "user-1", None, &blueprint)
            .await
            .unwrap();
        let policy = crate::app_factory::bridge::BridgePolicy {
            tools: vec!["send_message".to_string()],
            ..crate::app_factory::bridge::BridgePolicy::deny_all()
        };

        let first_policy_id = upsert_bridge_policy(&control_pool, app_id, &policy)
            .await
            .unwrap();
        let row = load_bridge_policy(&control_pool, app_id)
            .await
            .unwrap()
            .unwrap();
        let loaded_policy: crate::app_factory::bridge::BridgePolicy =
            serde_json::from_str(&row.policy_json).unwrap();

        assert_eq!(row.id, first_policy_id);
        assert_eq!(row.app_id, app_id);
        assert!(loaded_policy.allows_tool("send_message"));
        assert!(!loaded_policy.allows_tool("vault"));

        let updated_policy = crate::app_factory::bridge::BridgePolicy {
            tools: vec!["contacts".to_string()],
            ..crate::app_factory::bridge::BridgePolicy::deny_all()
        };
        let second_policy_id = upsert_bridge_policy(&control_pool, app_id, &updated_policy)
            .await
            .unwrap();
        let updated_row = load_bridge_policy(&control_pool, app_id)
            .await
            .unwrap()
            .unwrap();
        let loaded_updated_policy: crate::app_factory::bridge::BridgePolicy =
            serde_json::from_str(&updated_row.policy_json).unwrap();

        assert_eq!(second_policy_id, first_policy_id);
        assert!(loaded_updated_policy.allows_tool("contacts"));
        assert!(!loaded_updated_policy.allows_tool("send_message"));
    }
}
