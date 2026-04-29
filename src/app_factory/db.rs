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
pub struct AppRecordRow {
    pub id: i64,
    pub entity_name: String,
    pub data_json: String,
    pub status: Option<String>,
    pub created_by_user_id: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
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

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_app_records_entity ON app_records(entity_name)")
        .execute(pool)
        .await
        .context("Failed to create app_records entity index")?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_app_events_record ON app_events(record_id)")
        .execute(pool)
        .await
        .context("Failed to create app_events record index")?;

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

        pool
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
}
