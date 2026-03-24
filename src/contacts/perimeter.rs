//! Contact perimeter — isolation by default.
//!
//! Controls what the agent can access when responding to a specific contact.
//! Default: contact_only memory, _public namespace, vault denied.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sqlx::{Pool, Sqlite};

/// A contact's access perimeter.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ContactPerimeter {
    pub id: i64,
    pub contact_id: i64,
    /// JSON array of accessible knowledge namespaces (e.g. `["_public", "acme"]`).
    pub knowledge_namespaces: String,
    /// Memory scope: `contact_only`, `namespace`, or `profile`.
    pub memory_scope: String,
    /// JSON array of allowed tools (empty = all non-denied).
    pub tools_allowed: String,
    /// JSON array of denied tools (takes priority over allowed).
    pub tools_denied: String,
    /// Whether the agent can mention other contacts.
    pub can_see_contacts: i64,
    /// Whether the agent can mention calendar events.
    pub can_see_calendar: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl ContactPerimeter {
    /// Parse knowledge_namespaces JSON into a Vec.
    pub fn namespaces(&self) -> Vec<String> {
        serde_json::from_str(&self.knowledge_namespaces).unwrap_or_else(|_| vec!["_public".into()])
    }

    /// Parse tools_allowed JSON into a Vec.
    pub fn allowed_tools(&self) -> Vec<String> {
        serde_json::from_str(&self.tools_allowed).unwrap_or_default()
    }

    /// Parse tools_denied JSON into a Vec.
    pub fn denied_tools(&self) -> Vec<String> {
        serde_json::from_str(&self.tools_denied).unwrap_or_else(|_| vec!["vault".into()])
    }
}

/// Safe defaults for contacts without an explicit perimeter row.
pub fn default_perimeter(contact_id: i64) -> ContactPerimeter {
    ContactPerimeter {
        id: 0,
        contact_id,
        knowledge_namespaces: r#"["_public"]"#.into(),
        memory_scope: "contact_only".into(),
        tools_allowed: "[]".into(),
        tools_denied: r#"["vault"]"#.into(),
        can_see_contacts: 0,
        can_see_calendar: 0,
        created_at: String::new(),
        updated_at: String::new(),
    }
}

// ── DB operations ───────────────────────────────────────────────────

/// Load a contact's perimeter, returning safe defaults if none exists.
pub async fn load_perimeter(pool: &Pool<Sqlite>, contact_id: i64) -> Result<ContactPerimeter> {
    let row = sqlx::query_as::<_, ContactPerimeter>(
        "SELECT * FROM contact_perimeters WHERE contact_id = ?",
    )
    .bind(contact_id)
    .fetch_optional(pool)
    .await
    .with_context(|| format!("Failed to load perimeter for contact {contact_id}"))?;

    Ok(row.unwrap_or_else(|| default_perimeter(contact_id)))
}

/// Load a contact's perimeter row (None if not configured).
pub async fn load_perimeter_optional(
    pool: &Pool<Sqlite>,
    contact_id: i64,
) -> Result<Option<ContactPerimeter>> {
    sqlx::query_as::<_, ContactPerimeter>("SELECT * FROM contact_perimeters WHERE contact_id = ?")
        .bind(contact_id)
        .fetch_optional(pool)
        .await
        .with_context(|| format!("Failed to load perimeter for contact {contact_id}"))
}

/// Upsert a contact's perimeter.
#[allow(clippy::too_many_arguments)] // SQL binding — each param maps 1:1 to a DB column
pub async fn upsert_perimeter(
    pool: &Pool<Sqlite>,
    contact_id: i64,
    knowledge_namespaces: &str,
    memory_scope: &str,
    tools_allowed: &str,
    tools_denied: &str,
    can_see_contacts: bool,
    can_see_calendar: bool,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO contact_perimeters
            (contact_id, knowledge_namespaces, memory_scope, tools_allowed, tools_denied,
             can_see_contacts, can_see_calendar)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(contact_id) DO UPDATE SET
            knowledge_namespaces = excluded.knowledge_namespaces,
            memory_scope = excluded.memory_scope,
            tools_allowed = excluded.tools_allowed,
            tools_denied = excluded.tools_denied,
            can_see_contacts = excluded.can_see_contacts,
            can_see_calendar = excluded.can_see_calendar,
            updated_at = datetime('now')",
    )
    .bind(contact_id)
    .bind(knowledge_namespaces)
    .bind(memory_scope)
    .bind(tools_allowed)
    .bind(tools_denied)
    .bind(can_see_contacts as i64)
    .bind(can_see_calendar as i64)
    .execute(pool)
    .await
    .with_context(|| format!("Failed to upsert perimeter for contact {contact_id}"))?;
    Ok(())
}

/// Delete a contact's perimeter (reverts to safe defaults).
pub async fn delete_perimeter(pool: &Pool<Sqlite>, contact_id: i64) -> Result<()> {
    sqlx::query("DELETE FROM contact_perimeters WHERE contact_id = ?")
        .bind(contact_id)
        .execute(pool)
        .await
        .with_context(|| format!("Failed to delete perimeter for contact {contact_id}"))?;
    Ok(())
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_perimeter_values() {
        let p = default_perimeter(42);
        assert_eq!(p.contact_id, 42);
        assert_eq!(p.namespaces(), vec!["_public"]);
        assert_eq!(p.memory_scope, "contact_only");
        assert!(p.allowed_tools().is_empty());
        assert_eq!(p.denied_tools(), vec!["vault"]);
        assert_eq!(p.can_see_contacts, 0);
        assert_eq!(p.can_see_calendar, 0);
    }

    #[test]
    fn parse_namespaces() {
        let mut p = default_perimeter(1);
        p.knowledge_namespaces = r#"["acme", "_public", "shared"]"#.into();
        assert_eq!(p.namespaces(), vec!["acme", "_public", "shared"]);
    }

    #[test]
    fn parse_tools() {
        let mut p = default_perimeter(1);
        p.tools_denied = r#"["vault", "file_read", "shell"]"#.into();
        assert_eq!(p.denied_tools(), vec!["vault", "file_read", "shell"]);
    }
}
