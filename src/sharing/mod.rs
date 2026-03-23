//! Shared resources — explicit sharing of skills, MCP, tools, namespaces with contacts.
//!
//! The only way for a contact to access resources outside their perimeter base.
//! Each shared resource has per-contact permissions (read/write/admin) and optional
//! scope_json for sub-resource filtering (e.g. specific Notion pages).

pub mod db;

use serde::{Deserialize, Serialize};

// ── Domain types ────────────────────────────────────────────────────

/// A shared resource definition.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct SharedResource {
    pub id: i64,
    /// Resource type: "skill", "mcp", "tool", "knowledge_namespace".
    pub resource_type: String,
    /// Resource identifier (skill name, MCP server name, tool name, namespace).
    pub resource_id: String,
    /// Profile that owns this resource.
    pub owner_profile_id: i64,
    /// Human-readable description.
    pub description: String,
    pub created_at: String,
}

/// Access grant for a contact to a shared resource.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct SharedResourceAccess {
    pub id: i64,
    pub shared_resource_id: i64,
    pub contact_id: i64,
    /// Permission level: "read", "write", "admin".
    pub permission: String,
    /// Scope for sub-resource filtering (e.g. allowed MCP pages/databases).
    pub scope_json: String,
    pub created_at: String,
}

/// Resolved view of what a contact can access (computed at runtime).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ContactSharedAccess {
    /// Skill names this contact can use.
    pub skills: Vec<(String, String)>, // (name, permission)
    /// MCP server names this contact can use.
    pub mcp_servers: Vec<(String, String, String)>, // (name, permission, scope_json)
    /// Tool names granted beyond the perimeter.
    pub tools: Vec<String>,
    /// Additional knowledge namespaces beyond the perimeter.
    pub namespaces: Vec<String>,
}
