//! Gateway system — database operations.
//!
//! CRUD for gateway instances (channel configurations stored in SQLite).

use anyhow::{Context, Result};
use sqlx::{Pool, Sqlite};

use super::Gateway;

// ── CRUD ────────────────────────────────────────────────────────────

/// Insert a new gateway and return its id.
#[allow(clippy::too_many_arguments)] // SQL binding — each param maps 1:1 to a DB column
pub async fn insert_gateway(
    pool: &Pool<Sqlite>,
    name: &str,
    channel_type: &str,
    config_json: &str,
    default_profile: &str,
    default_agent: &str,
    response_mode: &str,
    user_id: Option<&str>,
) -> Result<i64> {
    let id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO gateways (name, channel_type, config_json, default_profile, default_agent, response_mode, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id",
    )
    .bind(name)
    .bind(channel_type)
    .bind(config_json)
    .bind(default_profile)
    .bind(default_agent)
    .bind(response_mode)
    .bind(user_id)
    .fetch_one(pool)
    .await
    .with_context(|| format!("Failed to insert gateway '{name}' ({channel_type})"))?;

    Ok(id)
}

/// Load a gateway by id.
pub async fn load_gateway_by_id(pool: &Pool<Sqlite>, id: i64) -> Result<Option<Gateway>> {
    let row = sqlx::query_as::<_, Gateway>("SELECT * FROM gateways WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .context("Failed to load gateway by id")?;
    Ok(row)
}

/// Load all gateways, ordered by channel_type then name.
pub async fn load_all_gateways(pool: &Pool<Sqlite>) -> Result<Vec<Gateway>> {
    let rows =
        sqlx::query_as::<_, Gateway>("SELECT * FROM gateways ORDER BY channel_type ASC, name ASC")
            .fetch_all(pool)
            .await
            .context("Failed to load gateways")?;
    Ok(rows)
}

/// Load only enabled gateways, ordered by channel_type then name.
pub async fn load_enabled_gateways(pool: &Pool<Sqlite>) -> Result<Vec<Gateway>> {
    let rows = sqlx::query_as::<_, Gateway>(
        "SELECT * FROM gateways WHERE enabled = 1 ORDER BY channel_type ASC, name ASC",
    )
    .fetch_all(pool)
    .await
    .context("Failed to load enabled gateways")?;
    Ok(rows)
}

/// Load gateways by channel type (e.g. "telegram").
pub async fn load_gateways_by_type(
    pool: &Pool<Sqlite>,
    channel_type: &str,
) -> Result<Vec<Gateway>> {
    let rows = sqlx::query_as::<_, Gateway>(
        "SELECT * FROM gateways WHERE channel_type = ? ORDER BY name ASC",
    )
    .bind(channel_type)
    .fetch_all(pool)
    .await
    .with_context(|| format!("Failed to load gateways for type '{channel_type}'"))?;
    Ok(rows)
}

/// Count total gateways (used to check if TOML migration is needed).
pub async fn count_gateways(pool: &Pool<Sqlite>) -> Result<i64> {
    let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM gateways")
        .fetch_one(pool)
        .await
        .context("Failed to count gateways")?;
    Ok(count)
}

/// Update a gateway's mutable fields.
#[allow(clippy::too_many_arguments)] // SQL binding — each param maps 1:1 to a DB column
pub async fn update_gateway(
    pool: &Pool<Sqlite>,
    id: i64,
    name: &str,
    enabled: bool,
    config_json: &str,
    default_profile: &str,
    default_agent: &str,
    response_mode: &str,
) -> Result<()> {
    sqlx::query(
        "UPDATE gateways
         SET name = ?, enabled = ?, config_json = ?, default_profile = ?,
             default_agent = ?, response_mode = ?, updated_at = datetime('now')
         WHERE id = ?",
    )
    .bind(name)
    .bind(enabled as i64)
    .bind(config_json)
    .bind(default_profile)
    .bind(default_agent)
    .bind(response_mode)
    .bind(id)
    .execute(pool)
    .await
    .with_context(|| format!("Failed to update gateway {id}"))?;
    Ok(())
}

/// Delete a gateway by id.
pub async fn delete_gateway(pool: &Pool<Sqlite>, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM gateways WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .with_context(|| format!("Failed to delete gateway {id}"))?;
    Ok(())
}

// ── Contact Gateway Overrides ────────────────────────────────────────

/// A contact's profile override for a specific gateway.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, sqlx::FromRow)]
pub struct ContactGatewayOverride {
    pub id: i64,
    pub contact_id: i64,
    pub gateway_id: i64,
    pub profile_id: i64,
    pub created_at: String,
}

/// Set (upsert) a contact's profile override for a gateway.
pub async fn upsert_gateway_override(
    pool: &Pool<Sqlite>,
    contact_id: i64,
    gateway_id: i64,
    profile_id: i64,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO contact_gateway_overrides (contact_id, gateway_id, profile_id)
         VALUES (?, ?, ?)
         ON CONFLICT(contact_id, gateway_id) DO UPDATE SET profile_id = excluded.profile_id",
    )
    .bind(contact_id)
    .bind(gateway_id)
    .bind(profile_id)
    .execute(pool)
    .await
    .with_context(|| {
        format!("Failed to upsert gateway override (contact={contact_id}, gateway={gateway_id})")
    })?;
    Ok(())
}

/// Load all gateway overrides for a contact.
pub async fn load_overrides_for_contact(
    pool: &Pool<Sqlite>,
    contact_id: i64,
) -> Result<Vec<ContactGatewayOverride>> {
    let rows = sqlx::query_as::<_, ContactGatewayOverride>(
        "SELECT * FROM contact_gateway_overrides WHERE contact_id = ? ORDER BY gateway_id",
    )
    .bind(contact_id)
    .fetch_all(pool)
    .await
    .with_context(|| format!("Failed to load overrides for contact {contact_id}"))?;
    Ok(rows)
}

/// Get the profile override for a specific contact + gateway pair.
pub async fn get_override_profile_id(
    pool: &Pool<Sqlite>,
    contact_id: i64,
    gateway_id: i64,
) -> Result<Option<i64>> {
    let row = sqlx::query_scalar::<_, i64>(
        "SELECT profile_id FROM contact_gateway_overrides
         WHERE contact_id = ? AND gateway_id = ?",
    )
    .bind(contact_id)
    .bind(gateway_id)
    .fetch_optional(pool)
    .await
    .with_context(|| {
        format!("Failed to get override (contact={contact_id}, gateway={gateway_id})")
    })?;
    Ok(row)
}

/// Delete a contact's gateway override.
pub async fn delete_gateway_override(
    pool: &Pool<Sqlite>,
    contact_id: i64,
    gateway_id: i64,
) -> Result<()> {
    sqlx::query("DELETE FROM contact_gateway_overrides WHERE contact_id = ? AND gateway_id = ?")
        .bind(contact_id)
        .bind(gateway_id)
        .execute(pool)
        .await
        .with_context(|| {
            format!("Failed to delete override (contact={contact_id}, gateway={gateway_id})")
        })?;
    Ok(())
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> Pool<Sqlite> {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("in-memory pool");

        sqlx::query(
            "CREATE TABLE gateways (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                channel_type TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                config_json TEXT NOT NULL DEFAULT '{}',
                default_profile TEXT NOT NULL DEFAULT '',
                default_agent TEXT NOT NULL DEFAULT '',
                response_mode TEXT NOT NULL DEFAULT 'automatic',
                user_id TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )",
        )
        .execute(&pool)
        .await
        .expect("create gateways table");

        pool
    }

    #[tokio::test]
    async fn crud_lifecycle() {
        let pool = test_pool().await;

        // Insert
        let id = insert_gateway(
            &pool,
            "My Telegram",
            "telegram",
            r#"{"token":"***ENCRYPTED***"}"#,
            "personal",
            "",
            "automatic",
            Some("fabio"),
        )
        .await
        .expect("insert");

        assert!(id > 0);

        // Load by id
        let gw = load_gateway_by_id(&pool, id)
            .await
            .expect("load")
            .expect("exists");
        assert_eq!(gw.name, "My Telegram");
        assert_eq!(gw.channel_type, "telegram");
        assert_eq!(gw.default_profile, "personal");
        assert!(gw.is_enabled());

        // Load all
        let all = load_all_gateways(&pool).await.expect("load all");
        assert_eq!(all.len(), 1);

        // Update
        update_gateway(
            &pool,
            id,
            "Work Telegram",
            true,
            r#"{"token":"***ENCRYPTED***"}"#,
            "work",
            "default",
            "assisted",
        )
        .await
        .expect("update");

        let gw = load_gateway_by_id(&pool, id)
            .await
            .expect("load")
            .expect("exists");
        assert_eq!(gw.name, "Work Telegram");
        assert_eq!(gw.default_profile, "work");
        assert_eq!(gw.response_mode, "assisted");

        // Delete
        delete_gateway(&pool, id).await.expect("delete");
        let gone = load_gateway_by_id(&pool, id).await.expect("load");
        assert!(gone.is_none());
    }

    #[tokio::test]
    async fn load_enabled_only() {
        let pool = test_pool().await;

        let id1 = insert_gateway(&pool, "Active", "telegram", "{}", "", "", "automatic", None)
            .await
            .expect("insert 1");
        let id2 = insert_gateway(
            &pool,
            "Disabled",
            "discord",
            "{}",
            "",
            "",
            "automatic",
            None,
        )
        .await
        .expect("insert 2");

        // Disable the second one
        update_gateway(&pool, id2, "Disabled", false, "{}", "", "", "automatic")
            .await
            .expect("disable");

        let enabled = load_enabled_gateways(&pool).await.expect("load enabled");
        assert_eq!(enabled.len(), 1);
        assert_eq!(enabled[0].id, id1);
    }

    #[tokio::test]
    async fn load_by_type() {
        let pool = test_pool().await;

        insert_gateway(&pool, "TG1", "telegram", "{}", "", "", "automatic", None)
            .await
            .expect("insert");
        insert_gateway(&pool, "TG2", "telegram", "{}", "", "", "automatic", None)
            .await
            .expect("insert");
        insert_gateway(&pool, "DC1", "discord", "{}", "", "", "automatic", None)
            .await
            .expect("insert");

        let tg = load_gateways_by_type(&pool, "telegram")
            .await
            .expect("load");
        assert_eq!(tg.len(), 2);

        let dc = load_gateways_by_type(&pool, "discord").await.expect("load");
        assert_eq!(dc.len(), 1);
    }

    #[tokio::test]
    async fn count() {
        let pool = test_pool().await;

        assert_eq!(count_gateways(&pool).await.expect("count"), 0);

        insert_gateway(&pool, "GW1", "telegram", "{}", "", "", "automatic", None)
            .await
            .expect("insert");
        assert_eq!(count_gateways(&pool).await.expect("count"), 1);
    }
}
