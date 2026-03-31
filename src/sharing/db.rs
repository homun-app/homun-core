//! Shared resources — database operations.

use anyhow::{Context, Result};
use sqlx::{Pool, Sqlite};

use super::{ContactSharedAccess, SharedResource, SharedResourceAccess};

// ── Shared Resources CRUD ───────────────────────────────────────────

/// Create a shared resource definition.
pub async fn create_resource(
    pool: &Pool<Sqlite>,
    resource_type: &str,
    resource_id: &str,
    owner_profile_id: i64,
    description: &str,
) -> Result<i64> {
    let id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO shared_resources (resource_type, resource_id, owner_profile_id, description)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(resource_type, resource_id, owner_profile_id)
         DO UPDATE SET description = excluded.description
         RETURNING id",
    )
    .bind(resource_type)
    .bind(resource_id)
    .bind(owner_profile_id)
    .bind(description)
    .fetch_one(pool)
    .await
    .with_context(|| format!("Failed to create shared resource {resource_type}:{resource_id}"))?;
    Ok(id)
}

/// List all shared resources (all profiles).
pub async fn list_all_resources(pool: &Pool<Sqlite>) -> Result<Vec<SharedResource>> {
    sqlx::query_as::<_, SharedResource>(
        "SELECT * FROM shared_resources ORDER BY resource_type, resource_id",
    )
    .fetch_all(pool)
    .await
    .context("Failed to list all shared resources")
}

/// Delete a shared resource (cascades to access grants).
pub async fn delete_resource(pool: &Pool<Sqlite>, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM shared_resources WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .with_context(|| format!("Failed to delete shared resource {id}"))?;
    Ok(())
}

// ── Access Grants CRUD ──────────────────────────────────────────────

/// Grant a contact access to a shared resource.
pub async fn grant_access(
    pool: &Pool<Sqlite>,
    shared_resource_id: i64,
    contact_id: i64,
    permission: &str,
    scope_json: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO shared_resource_access (shared_resource_id, contact_id, permission, scope_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(shared_resource_id, contact_id)
         DO UPDATE SET permission = excluded.permission, scope_json = excluded.scope_json",
    )
    .bind(shared_resource_id)
    .bind(contact_id)
    .bind(permission)
    .bind(scope_json)
    .execute(pool)
    .await
    .with_context(|| format!("Failed to grant access (resource={shared_resource_id}, contact={contact_id})"))?;
    Ok(())
}

/// List all access grants for a shared resource.
pub async fn list_access_for_resource(
    pool: &Pool<Sqlite>,
    shared_resource_id: i64,
) -> Result<Vec<SharedResourceAccess>> {
    sqlx::query_as::<_, SharedResourceAccess>(
        "SELECT * FROM shared_resource_access WHERE shared_resource_id = ? ORDER BY contact_id",
    )
    .bind(shared_resource_id)
    .fetch_all(pool)
    .await
    .context("Failed to list access for resource")
}

/// Revoke a contact's access to a shared resource.
pub async fn revoke_access(
    pool: &Pool<Sqlite>,
    shared_resource_id: i64,
    contact_id: i64,
) -> Result<()> {
    sqlx::query(
        "DELETE FROM shared_resource_access WHERE shared_resource_id = ? AND contact_id = ?",
    )
    .bind(shared_resource_id)
    .bind(contact_id)
    .execute(pool)
    .await
    .context("Failed to revoke access")?;
    Ok(())
}

/// Resolve all shared access for a contact (computed view).
///
/// Returns skills, MCP servers, tools, and namespaces the contact can access
/// through explicit sharing grants.
pub async fn resolve_contact_access(
    pool: &Pool<Sqlite>,
    contact_id: i64,
) -> Result<ContactSharedAccess> {
    let rows = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT sr.resource_type, sr.resource_id, sra.permission, sra.scope_json
         FROM shared_resource_access sra
         JOIN shared_resources sr ON sr.id = sra.shared_resource_id
         WHERE sra.contact_id = ?",
    )
    .bind(contact_id)
    .fetch_all(pool)
    .await
    .with_context(|| format!("Failed to resolve shared access for contact {contact_id}"))?;

    let mut access = ContactSharedAccess::default();
    for (rtype, rid, perm, scope) in rows {
        match rtype.as_str() {
            "skill" => access.skills.push((rid, perm)),
            "mcp" => access.mcp_servers.push((rid, perm, scope)),
            "tool" => access.tools.push(rid),
            "knowledge_namespace" => access.namespaces.push(rid),
            _ => {}
        }
    }
    Ok(access)
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
            "CREATE TABLE profiles (id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL);
             INSERT INTO profiles (id, slug) VALUES (1, 'default');
             CREATE TABLE contacts (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
             INSERT INTO contacts (id, name) VALUES (1, 'ACME');
             INSERT INTO contacts (id, name) VALUES (2, 'Felicia');
             CREATE TABLE shared_resources (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 resource_type TEXT NOT NULL,
                 resource_id TEXT NOT NULL,
                 owner_profile_id INTEGER NOT NULL REFERENCES profiles(id),
                 description TEXT NOT NULL DEFAULT '',
                 created_at TEXT NOT NULL DEFAULT (datetime('now')),
                 UNIQUE(resource_type, resource_id, owner_profile_id)
             );
             CREATE TABLE shared_resource_access (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 shared_resource_id INTEGER NOT NULL REFERENCES shared_resources(id) ON DELETE CASCADE,
                 contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
                 permission TEXT NOT NULL DEFAULT 'read',
                 scope_json TEXT NOT NULL DEFAULT '{}',
                 created_at TEXT NOT NULL DEFAULT (datetime('now')),
                 UNIQUE(shared_resource_id, contact_id)
             );",
        )
        .execute(&pool)
        .await
        .expect("setup");

        pool
    }

    #[tokio::test]
    async fn sharing_lifecycle() {
        let pool = test_pool().await;

        // Create a shared resource
        let rid = create_resource(&pool, "skill", "lista-spesa", 1, "Shopping list")
            .await
            .expect("create");

        // Grant access to Felicia
        grant_access(&pool, rid, 2, "write", "{}")
            .await
            .expect("grant");

        // Check access
        let access = resolve_contact_access(&pool, 2).await.expect("resolve");
        assert_eq!(access.skills.len(), 1);
        assert_eq!(access.skills[0].0, "lista-spesa");
        assert_eq!(access.skills[0].1, "write");

        // ACME should have no access
        let acme_access = resolve_contact_access(&pool, 1).await.expect("resolve");
        assert!(acme_access.skills.is_empty());

        // Revoke
        revoke_access(&pool, rid, 2).await.expect("revoke");
        let access = resolve_contact_access(&pool, 2).await.expect("resolve");
        assert!(access.skills.is_empty());
    }

    #[tokio::test]
    async fn multi_type_sharing() {
        let pool = test_pool().await;

        let r1 = create_resource(&pool, "skill", "lista-spesa", 1, "")
            .await
            .expect("create");
        let r2 = create_resource(&pool, "mcp", "notion", 1, "")
            .await
            .expect("create");
        let r3 = create_resource(&pool, "knowledge_namespace", "famiglia", 1, "")
            .await
            .expect("create");

        grant_access(&pool, r1, 2, "write", "{}")
            .await
            .expect("grant");
        grant_access(&pool, r2, 2, "read", r#"{"pages":["abc"]}"#)
            .await
            .expect("grant");
        grant_access(&pool, r3, 2, "read", "{}")
            .await
            .expect("grant");

        let access = resolve_contact_access(&pool, 2).await.expect("resolve");
        assert_eq!(access.skills.len(), 1);
        assert_eq!(access.mcp_servers.len(), 1);
        assert_eq!(access.mcp_servers[0].2, r#"{"pages":["abc"]}"#);
        assert_eq!(access.namespaces, vec!["famiglia"]);
    }
}
