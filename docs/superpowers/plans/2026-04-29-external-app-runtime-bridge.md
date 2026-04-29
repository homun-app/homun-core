# External App Runtime Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the P0 external app runtime: `/a/{slug}` with app-local login/users/roles, isolated app data access, and a fail-closed Homun bridge policy foundation.

**Architecture:** Homun remains the control plane in `homun.db`; each generated app keeps operational data, app users, and app sessions in its per-app SQLite database. The external runtime uses separate routes, cookies, and UI from Homun Studio, while Studio retains ownership and bridge policy configuration. The bridge policy is persisted in Homun's control plane and is checked before any app-to-Homun capability is allowed.

**Tech Stack:** Rust, Axum, sqlx SQLite, existing Homun web auth password hashing, static JS/CSS, existing App Factory storage/runtime modules.

---

## File Map

- `src/app_factory/db.rs`  
  Extend per-app SQLite migration and add app-local user/session/invite/event query helpers.

- `src/app_factory/external_auth.rs`  
  New focused module for app-local login/session cookie helpers and role checks.

- `src/app_factory/bridge.rs`  
  New focused module for bridge policy structs, defaults, validation, and persistence helpers.

- `src/app_factory/mod.rs`  
  Export `external_auth` and `bridge`.

- `migrations/057_internal_app_bridge_policies.sql`  
  Control-plane migration for bridge policy records.

- `src/web/external_apps.rs`  
  New external runtime pages and app-local HTML endpoints: login, logout, shell.

- `src/web/api/external_apps.rs`  
  New app-local API routes under `/api/a/{slug}` for login, current user, records, actions, and minimal admin user management.

- `src/web/api/apps.rs`  
  Extend Studio API with bridge policy read/update and app user listing/creation for Homun owners.

- `src/web/api/mod.rs`, `src/web/server.rs`, `src/web/pages.rs`  
  Register routes and expose the public app link in Studio.

- `static/js/external-app.js`, `static/css/external-app.css`  
  New UI runtime without Homun sidebar.

- `static/js/apps.js`, `static/css/pages.css`  
  Add Studio panels/links for published URL and app users.

- `docs/demo/app-factory-runbook.md`  
  Update demo flow to use `/a/ferie-permessi` with employee/approver logins.

---

## Task 1: Per-App Identity Storage

**Files:**
- Modify: `src/app_factory/db.rs`
- Test: `src/app_factory/db.rs`

- [ ] **Step 1: Add failing tests for app users and sessions**

Add these tests inside `#[cfg(test)] mod tests` in `src/app_factory/db.rs`:

```rust
#[tokio::test]
async fn app_db_migration_creates_app_identity_tables() {
    let (_tmp, pool) = test_app_pool().await;

    let app_users: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'app_users'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let app_sessions: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'app_sessions'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let app_invites: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'app_invites'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(app_users, 1);
    assert_eq!(app_sessions, 1);
    assert_eq!(app_invites, 1);
}

#[tokio::test]
async fn app_user_crud_and_session_lookup_work() {
    let (_tmp, pool) = test_app_pool().await;

    let user_id = insert_app_user(
        &pool,
        "employee@example.com",
        "Mario Rossi",
        "hash",
        "employee",
        None,
    )
    .await
    .unwrap();
    let user = load_app_user_by_email(&pool, "employee@example.com")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(user.id, user_id);
    assert_eq!(user.role, "employee");

    insert_app_session(&pool, "session-1", user_id, "2099-01-01T00:00:00Z")
        .await
        .unwrap();
    let session = load_app_session(&pool, "session-1").await.unwrap().unwrap();
    assert_eq!(session.app_user_id, user_id);
}
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cargo test --all-features app_user
```

Expected failure: missing tables/helpers such as `insert_app_user`.

- [ ] **Step 3: Add row structs and migration SQL**

In `src/app_factory/db.rs`, add:

```rust
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
```

Extend `migrate_app_db()` after `app_events`:

```rust
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

sqlx::query("CREATE INDEX IF NOT EXISTS idx_app_users_email ON app_users(email)")
    .execute(pool)
    .await
    .context("Failed to create app_users email index")?;

sqlx::query("CREATE INDEX IF NOT EXISTS idx_app_sessions_user ON app_sessions(app_user_id)")
    .execute(pool)
    .await
    .context("Failed to create app_sessions user index")?;
```

- [ ] **Step 4: Add DB helper functions**

Add:

```rust
pub async fn insert_app_user(
    app_pool: &SqlitePool,
    email: &str,
    display_name: &str,
    password_hash: &str,
    role: &str,
    contact_id: Option<i64>,
) -> Result<i64> {
    sqlx::query_scalar::<_, i64>(
        "INSERT INTO app_users (email, display_name, password_hash, role, contact_id)
         VALUES (?, ?, ?, ?, ?)
         RETURNING id",
    )
    .bind(email.trim().to_ascii_lowercase())
    .bind(display_name.trim())
    .bind(password_hash)
    .bind(role)
    .bind(contact_id)
    .fetch_one(app_pool)
    .await
    .context("Failed to insert app user")
}

pub async fn load_app_user_by_email(
    app_pool: &SqlitePool,
    email: &str,
) -> Result<Option<AppUserRow>> {
    sqlx::query_as::<_, AppUserRow>(
        "SELECT id, email, display_name, password_hash, role, status, contact_id, created_at, updated_at
         FROM app_users
         WHERE email = ?",
    )
    .bind(email.trim().to_ascii_lowercase())
    .fetch_optional(app_pool)
    .await
    .context("Failed to load app user by email")
}

pub async fn load_app_user(app_pool: &SqlitePool, id: i64) -> Result<Option<AppUserRow>> {
    sqlx::query_as::<_, AppUserRow>(
        "SELECT id, email, display_name, password_hash, role, status, contact_id, created_at, updated_at
         FROM app_users
         WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(app_pool)
    .await
    .context("Failed to load app user")
}

pub async fn list_app_users(app_pool: &SqlitePool) -> Result<Vec<AppUserRow>> {
    sqlx::query_as::<_, AppUserRow>(
        "SELECT id, email, display_name, password_hash, role, status, contact_id, created_at, updated_at
         FROM app_users
         ORDER BY created_at DESC, id DESC",
    )
    .fetch_all(app_pool)
    .await
    .context("Failed to list app users")
}

pub async fn insert_app_session(
    app_pool: &SqlitePool,
    id: &str,
    app_user_id: i64,
    expires_at: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO app_sessions (id, app_user_id, expires_at)
         VALUES (?, ?, ?)",
    )
    .bind(id)
    .bind(app_user_id)
    .bind(expires_at)
    .execute(app_pool)
    .await
    .context("Failed to insert app session")?;
    Ok(())
}

pub async fn load_app_session(
    app_pool: &SqlitePool,
    id: &str,
) -> Result<Option<AppSessionRow>> {
    sqlx::query_as::<_, AppSessionRow>(
        "SELECT id, app_user_id, expires_at, created_at
         FROM app_sessions
         WHERE id = ? AND expires_at > datetime('now')",
    )
    .bind(id)
    .fetch_optional(app_pool)
    .await
    .context("Failed to load app session")
}

pub async fn delete_app_session(app_pool: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM app_sessions WHERE id = ?")
        .bind(id)
        .execute(app_pool)
        .await
        .context("Failed to delete app session")?;
    Ok(())
}
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
cargo test --all-features app_user
cargo test --all-features app_factory::db
```

Expected: app identity tests pass.

Commit:

```bash
git add src/app_factory/db.rs
git commit -m "Add app-local identity storage"
```

---

## Task 2: Bridge Policy Control Plane

**Files:**
- Create: `migrations/057_internal_app_bridge_policies.sql`
- Create: `src/app_factory/bridge.rs`
- Modify: `src/app_factory/mod.rs`
- Modify: `src/app_factory/db.rs`
- Test: `src/app_factory/bridge.rs`, `src/app_factory/db.rs`

- [ ] **Step 1: Add migration**

Create `migrations/057_internal_app_bridge_policies.sql`:

```sql
-- Bridge policy for generated apps.
-- Fail-closed: missing row or missing capability means denied.
CREATE TABLE IF NOT EXISTS internal_app_bridge_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id INTEGER NOT NULL REFERENCES internal_apps(id) ON DELETE CASCADE,
    policy_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_app_bridge_policy_app
    ON internal_app_bridge_policies(app_id);
```

- [ ] **Step 2: Add bridge policy structs and tests**

Create `src/app_factory/bridge.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BridgePolicy {
    #[serde(default)]
    pub profiles: Vec<String>,
    #[serde(default)]
    pub contacts: ContactAccess,
    #[serde(default)]
    pub channels: ChannelAccess,
    #[serde(default)]
    pub knowledge_namespaces: Vec<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub writeback: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContactAccess {
    #[serde(default)]
    pub read: Vec<String>,
    #[serde(default)]
    pub link_app_users: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChannelAccess {
    #[serde(default)]
    pub send: Vec<String>,
    #[serde(default)]
    pub receive: Vec<String>,
}

impl BridgePolicy {
    pub fn deny_all() -> Self {
        Self {
            profiles: Vec::new(),
            contacts: ContactAccess::default(),
            channels: ChannelAccess::default(),
            knowledge_namespaces: Vec::new(),
            tools: Vec::new(),
            writeback: Vec::new(),
        }
    }

    pub fn allows_tool(&self, tool: &str) -> bool {
        self.tools.iter().any(|name| name == tool)
    }

    pub fn allows_channel_send(&self, channel: &str) -> bool {
        self.channels.send.iter().any(|name| name == channel)
    }

    pub fn allows_knowledge_namespace(&self, namespace: &str) -> bool {
        self.knowledge_namespaces.iter().any(|name| name == namespace)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deny_all_policy_blocks_everything() {
        let policy = BridgePolicy::deny_all();
        assert!(!policy.allows_tool("send_message"));
        assert!(!policy.allows_channel_send("email"));
        assert!(!policy.allows_knowledge_namespace("hr-policy"));
    }

    #[test]
    fn explicit_policy_allows_declared_capabilities() {
        let policy: BridgePolicy = serde_json::from_value(serde_json::json!({
            "tools": ["send_message"],
            "channels": {"send": ["email"]},
            "knowledge_namespaces": ["hr-policy"]
        }))
        .unwrap();

        assert!(policy.allows_tool("send_message"));
        assert!(policy.allows_channel_send("email"));
        assert!(policy.allows_knowledge_namespace("hr-policy"));
        assert!(!policy.allows_tool("vault"));
    }
}
```

- [ ] **Step 3: Export bridge module**

In `src/app_factory/mod.rs`:

```rust
pub mod bridge;
```

- [ ] **Step 4: Add DB helpers**

In `src/app_factory/db.rs`, add `InternalAppBridgePolicyRow` and helpers:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct InternalAppBridgePolicyRow {
    pub id: i64,
    pub app_id: i64,
    pub policy_json: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: Option<String>,
}

pub async fn upsert_bridge_policy(
    control_pool: &SqlitePool,
    app_id: i64,
    policy: &crate::app_factory::bridge::BridgePolicy,
) -> Result<i64> {
    let policy_json = serde_json::to_string(policy)?;
    sqlx::query_scalar::<_, i64>(
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
    .context("Failed to upsert bridge policy")
}

pub async fn load_bridge_policy(
    control_pool: &SqlitePool,
    app_id: i64,
) -> Result<Option<InternalAppBridgePolicyRow>> {
    sqlx::query_as::<_, InternalAppBridgePolicyRow>(
        "SELECT id, app_id, policy_json, status, created_at, updated_at
         FROM internal_app_bridge_policies
         WHERE app_id = ? AND status = 'active'",
    )
    .bind(app_id)
    .fetch_optional(control_pool)
    .await
    .context("Failed to load bridge policy")
}
```

- [ ] **Step 5: Add migration to database initialization**

Find the migration sequence in `src/storage/db.rs` and add migration 057 after 056:

```rust
// Migration 057 — internal app bridge policies
sqlx::query(include_str!("../../migrations/057_internal_app_bridge_policies.sql"))
    .execute(&pool)
    .await?;
```

Follow the exact migration pattern used around `056_internal_apps.sql`; if migrations are split by semicolon there, use the same helper loop.

- [ ] **Step 6: Verify and commit**

Run:

```bash
cargo test --all-features app_factory::bridge
cargo test --all-features bridge_policy
cargo check --all-features
```

Commit:

```bash
git add migrations/057_internal_app_bridge_policies.sql src/app_factory/bridge.rs src/app_factory/mod.rs src/app_factory/db.rs src/storage/db.rs
git commit -m "Add internal app bridge policy model"
```

---

## Task 3: App-Local Auth Helpers

**Files:**
- Create: `src/app_factory/external_auth.rs`
- Modify: `src/app_factory/mod.rs`
- Test: `src/app_factory/external_auth.rs`

- [ ] **Step 1: Add external auth module**

Create `src/app_factory/external_auth.rs`:

```rust
use anyhow::{bail, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use ring::rand::{SecureRandom, SystemRandom};

use crate::app_factory::db::AppUserRow;

pub const APP_SESSION_COOKIE_PREFIX: &str = "homun_app_session_";
const SESSION_ID_LEN: usize = 32;

#[derive(Debug, Clone)]
pub struct AppAuthUser {
    pub app_slug: String,
    pub app_user_id: i64,
    pub email: String,
    pub display_name: String,
    pub role: String,
}

pub fn cookie_name(slug: &str) -> String {
    format!("{APP_SESSION_COOKIE_PREFIX}{}", slug.replace('-', "_"))
}

pub fn generate_session_id() -> Result<String> {
    let rng = SystemRandom::new();
    let mut bytes = [0u8; SESSION_ID_LEN];
    rng.fill(&mut bytes)
        .map_err(|_| anyhow::anyhow!("RNG failed generating app session id"))?;
    Ok(B64.encode(bytes))
}

pub fn can_manage_users(role: &str) -> bool {
    role == "admin"
}

pub fn can_create_record(role: &str) -> bool {
    matches!(role, "admin" | "approver" | "employee")
}

pub fn can_run_action(role: &str, action: &str) -> bool {
    match role {
        "admin" => true,
        "approver" => matches!(action, "approve" | "reject"),
        _ => false,
    }
}

pub fn ensure_role(predicate: bool, message: &str) -> Result<()> {
    if !predicate {
        bail!("{message}");
    }
    Ok(())
}

impl From<(&str, AppUserRow)> for AppAuthUser {
    fn from((app_slug, row): (&str, AppUserRow)) -> Self {
        Self {
            app_slug: app_slug.to_string(),
            app_user_id: row.id,
            email: row.email,
            display_name: row.display_name,
            role: row.role,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_name_is_slug_scoped() {
        assert_eq!(cookie_name("ferie-permessi"), "homun_app_session_ferie_permessi");
    }

    #[test]
    fn role_permissions_are_fail_closed() {
        assert!(can_manage_users("admin"));
        assert!(!can_manage_users("approver"));
        assert!(can_create_record("employee"));
        assert!(can_run_action("approver", "approve"));
        assert!(!can_run_action("employee", "approve"));
    }
}
```

- [ ] **Step 2: Export module**

In `src/app_factory/mod.rs`:

```rust
pub mod external_auth;
```

- [ ] **Step 3: Verify and commit**

Run:

```bash
cargo test --all-features external_auth
cargo check --all-features
```

Commit:

```bash
git add src/app_factory/external_auth.rs src/app_factory/mod.rs
git commit -m "Add app-local auth helpers"
```

---

## Task 4: External App API

**Files:**
- Create: `src/web/api/external_apps.rs`
- Modify: `src/web/api/mod.rs`
- Test: `src/web/api/external_apps.rs`

- [ ] **Step 1: Create routes skeleton**

Create `src/web/api/external_apps.rs` with:

```rust
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{AppendHeaders, Json};
use axum::routing::{get, post};
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::app_factory::{db as app_db, external_auth, runtime, validation};
use crate::web::auth::{hash_password, verify_password};
use crate::web::server::AppState;

type ApiErr = (StatusCode, Json<Value>);

#[derive(Debug, Deserialize)]
struct LoginRequest {
    email: String,
    password: String,
}

#[derive(Debug, Serialize)]
struct AppMeResponse {
    id: i64,
    email: String,
    display_name: String,
    role: String,
}

#[derive(Debug, Deserialize)]
struct CreateRecordRequest {
    data: Value,
}

pub(super) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/a/{slug}/login", post(login))
        .route("/a/{slug}/logout", post(logout))
        .route("/a/{slug}/me", get(me))
        .route("/a/{slug}/entities/{entity}/records", get(list_records).post(create_record))
        .route(
            "/a/{slug}/entities/{entity}/records/{record_id}/actions/{action}",
            post(run_action),
        )
}
```

- [ ] **Step 2: Add shared app/session loading helpers**

Add helpers in the same file:

```rust
fn internal<E: std::fmt::Display>(e: E) -> ApiErr {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e.to_string()})))
}

fn forbidden<E: std::fmt::Display>(e: E) -> ApiErr {
    (StatusCode::FORBIDDEN, Json(json!({"error": e.to_string()})))
}

async fn load_public_app(
    state: &AppState,
    slug: &str,
) -> Result<(app_db::InternalAppRow, crate::app_factory::blueprint::AppBlueprint), ApiErr> {
    let db = state.db.as_ref().ok_or_else(|| internal("Database not available"))?;
    let row = app_db::load_app_by_slug(db.pool(), slug)
        .await
        .map_err(internal)?
        .ok_or_else(|| (StatusCode::NOT_FOUND, Json(json!({"error": "App not found"}))))?;
    let blueprint = serde_json::from_str(&row.blueprint_json).map_err(internal)?;
    validation::validate_blueprint(&blueprint).map_err(|report| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "Stored blueprint is invalid", "details": report.errors})),
        )
    })?;
    Ok((row, blueprint))
}

fn app_session_cookie(headers: &HeaderMap, slug: &str) -> Option<String> {
    let name = external_auth::cookie_name(slug);
    let cookie = headers.get(header::COOKIE)?.to_str().ok()?;
    cookie.split(';').map(str::trim).find_map(|part| {
        let (key, value) = part.split_once('=')?;
        (key == name).then(|| value.to_string())
    })
}

async fn require_app_user(
    state: &AppState,
    slug: &str,
    headers: &HeaderMap,
) -> Result<(app_db::InternalAppRow, crate::app_factory::blueprint::AppBlueprint, sqlx::SqlitePool, external_auth::AppAuthUser), ApiErr> {
    let (app, blueprint) = load_public_app(state, slug).await?;
    let session_id = app_session_cookie(headers, slug)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, Json(json!({"error": "Not signed in"}))))?;
    let app_pool = app_db::open_app_pool(std::path::Path::new(&app.db_path))
        .await
        .map_err(internal)?;
    let session = app_db::load_app_session(&app_pool, &session_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, Json(json!({"error": "Session expired"}))))?;
    let user = app_db::load_app_user(&app_pool, session.app_user_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, Json(json!({"error": "User not found"}))))?;
    Ok((app, blueprint, app_pool, external_auth::AppAuthUser::from((slug, user))))
}
```

This requires adding `load_app_by_slug` in `src/app_factory/db.rs`:

```rust
pub async fn load_app_by_slug(
    control_pool: &SqlitePool,
    slug: &str,
) -> Result<Option<InternalAppRow>> {
    sqlx::query_as::<_, InternalAppRow>(
        "SELECT id, user_id, profile_id, slug, name, description, blueprint_json,
                db_path, schema_version, storage_mode, status, created_at, updated_at
         FROM internal_apps
         WHERE slug = ?",
    )
    .bind(slug)
    .fetch_optional(control_pool)
    .await
    .context("Failed to load internal app by slug")
}
```

- [ ] **Step 3: Implement login/logout/me**

Add:

```rust
async fn login(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Json(body): Json<LoginRequest>,
) -> Result<(AppendHeaders<[(header::HeaderName, String); 1]>, Json<AppMeResponse>), ApiErr> {
    let (app, _) = load_public_app(&state, &slug).await?;
    let app_pool = app_db::open_app_pool(std::path::Path::new(&app.db_path)).await.map_err(internal)?;
    let user = app_db::load_app_user_by_email(&app_pool, &body.email)
        .await
        .map_err(internal)?
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, Json(json!({"error": "Invalid credentials"}))))?;
    if user.status != "active" || !verify_password(&body.password, &user.password_hash) {
        return Err((StatusCode::UNAUTHORIZED, Json(json!({"error": "Invalid credentials"}))));
    }

    let session_id = external_auth::generate_session_id().map_err(internal)?;
    app_db::insert_app_session(&app_pool, &session_id, user.id, "2099-01-01T00:00:00Z")
        .await
        .map_err(internal)?;
    app_pool.close().await;

    let cookie = format!(
        "{}={}; Path=/a/{}; HttpOnly; SameSite=Lax; Secure",
        external_auth::cookie_name(&slug),
        session_id,
        slug
    );
    Ok((
        AppendHeaders([(header::SET_COOKIE, cookie)]),
        Json(AppMeResponse {
            id: user.id,
            email: user.email,
            display_name: user.display_name,
            role: user.role,
        }),
    ))
}

async fn logout(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    headers: HeaderMap,
) -> Result<AppendHeaders<[(header::HeaderName, String); 1]>, ApiErr> {
    if let Some(session_id) = app_session_cookie(&headers, &slug) {
        let (app, _) = load_public_app(&state, &slug).await?;
        let app_pool = app_db::open_app_pool(std::path::Path::new(&app.db_path)).await.map_err(internal)?;
        let _ = app_db::delete_app_session(&app_pool, &session_id).await;
        app_pool.close().await;
    }
    let cookie = format!(
        "{}=; Path=/a/{}; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
        external_auth::cookie_name(&slug),
        slug
    );
    Ok(AppendHeaders([(header::SET_COOKIE, cookie)]))
}

async fn me(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    headers: HeaderMap,
) -> Result<Json<AppMeResponse>, ApiErr> {
    let (_, _, app_pool, user) = require_app_user(&state, &slug, &headers).await?;
    app_pool.close().await;
    Ok(Json(AppMeResponse {
        id: user.app_user_id,
        email: user.email,
        display_name: user.display_name,
        role: user.role,
    }))
}
```

- [ ] **Step 4: Implement record/action endpoints**

Add app-user-scoped variants of existing `/api/v1/apps` record logic:

```rust
#[derive(Debug, Serialize)]
struct ExternalRecordView {
    id: i64,
    entity_name: String,
    data: Value,
    status: Option<String>,
    created_by_user_id: Option<String>,
    created_at: String,
    updated_at: Option<String>,
}

fn external_record_view(row: app_db::AppRecordRow) -> Result<ExternalRecordView, ApiErr> {
    let data = serde_json::from_str::<Value>(&row.data_json).map_err(internal)?;
    Ok(ExternalRecordView {
        id: row.id,
        entity_name: row.entity_name,
        data,
        status: row.status,
        created_by_user_id: row.created_by_user_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

async fn list_records(
    State(state): State<Arc<AppState>>,
    Path((slug, entity_name)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Vec<ExternalRecordView>>, ApiErr> {
    let (_, blueprint, app_pool, user) = require_app_user(&state, &slug, &headers).await?;
    runtime::entity(&blueprint, &entity_name).map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({"error": e.to_string()}))))?;
    let rows = app_db::list_records(&app_pool, &entity_name, 500).await.map_err(internal)?;
    app_pool.close().await;

    let rows = if user.role == "employee" {
        rows.into_iter()
            .filter(|row| row.created_by_user_id.as_deref() == Some(&user.app_user_id.to_string()))
            .collect()
    } else {
        rows
    };

    Ok(Json(rows.into_iter().map(external_record_view).collect::<Result<Vec<_>, _>>()?))
}
```

For create:

```rust
external_auth::ensure_role(
    external_auth::can_create_record(&user.role),
    "This role cannot create records",
)
.map_err(forbidden)?;
```

Pass `Some(&user.app_user_id.to_string())` to `insert_record`.

For action:

```rust
external_auth::ensure_role(
    external_auth::can_run_action(&user.role, &action),
    "This role cannot run this action",
)
.map_err(forbidden)?;
```

- [ ] **Step 5: Register API routes**

In `src/web/api/mod.rs`, add:

```rust
mod external_apps;
```

and merge:

```rust
.merge(external_apps::routes())
```

- [ ] **Step 6: Verify and commit**

Run:

```bash
cargo check --all-features
cargo test --all-features external_apps
```

Commit:

```bash
git add src/web/api/external_apps.rs src/web/api/mod.rs src/app_factory/db.rs
git commit -m "Add external app runtime API"
```

---

## Task 5: External App Pages And UI

**Files:**
- Create: `src/web/external_apps.rs`
- Create: `static/js/external-app.js`
- Create: `static/css/external-app.css`
- Modify: `src/web/server.rs`

- [ ] **Step 1: Add page module**

Create `src/web/external_apps.rs`:

```rust
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::response::Html;

use crate::web::server::AppState;

pub fn routes() -> axum::Router<Arc<AppState>> {
    axum::Router::new()
        .route("/a/{slug}/login", axum::routing::get(login_page))
        .route("/a/{slug}", axum::routing::get(app_page))
}

async fn login_page(Path(slug): Path<String>) -> Html<String> {
    Html(external_page(
        "Sign in",
        &format!(
            r#"<main class="external-app-login" data-app-slug="{slug}">
                <section class="external-login-panel">
                    <h1>Sign in</h1>
                    <p>Access this workspace app.</p>
                    <form id="external-login-form">
                        <label>Email<input class="input" name="email" type="email" autocomplete="email" required></label>
                        <label>Password<input class="input" name="password" type="password" autocomplete="current-password" required></label>
                        <button class="btn btn-primary" type="submit">Sign in</button>
                        <p class="external-error" id="external-login-error"></p>
                    </form>
                </section>
            </main>"#
        ),
        &slug,
    ))
}

async fn app_page(Path(slug): Path<String>, State(_state): State<Arc<AppState>>) -> Html<String> {
    Html(external_page(
        "App",
        &format!(
            r#"<main class="external-app-shell" data-app-slug="{slug}">
                <header class="external-app-header">
                    <div>
                        <h1 id="external-app-title">App</h1>
                        <p id="external-app-user"></p>
                    </div>
                    <button class="btn btn-secondary btn-sm" id="external-logout">Logout</button>
                </header>
                <nav class="external-app-nav" id="external-app-nav"></nav>
                <section class="external-app-dashboard" id="external-app-dashboard"></section>
                <section class="external-app-body">
                    <div class="external-app-table" id="external-app-table"></div>
                    <aside class="external-app-form" id="external-app-form"></aside>
                </section>
            </main>"#
        ),
        &slug,
    ))
}

fn external_page(title: &str, body: &str, slug: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title} — {slug}</title>
  <link rel="stylesheet" href="/static/css/tokens.css">
  <link rel="stylesheet" href="/static/css/reset.css">
  <link rel="stylesheet" href="/static/css/primitives.css">
  <link rel="stylesheet" href="/static/css/external-app.css">
</head>
<body>
{body}
<script src="/static/js/external-app.js"></script>
</body>
</html>"#
    )
}
```

- [ ] **Step 2: Register page routes**

In `src/web/server.rs`, where page routes are mounted, merge:

```rust
.merge(crate::web::external_apps::routes())
```

If `src/web/mod.rs` controls module exports, add:

```rust
pub mod external_apps;
```

- [ ] **Step 3: Add external UI JS**

Create `static/js/external-app.js` with:

```javascript
'use strict';

(function () {
    var root = document.querySelector('[data-app-slug]');
    if (!root) return;
    var slug = root.dataset.appSlug;

    function api(path, options) {
        return fetch('/api/a/' + encodeURIComponent(slug) + path, options).then(function (res) {
            return res.text().then(function (text) {
                var body = text ? JSON.parse(text) : null;
                if (!res.ok) throw new Error((body && body.error) || 'Request failed');
                return body;
            });
        });
    }

    var loginForm = document.getElementById('external-login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', function (event) {
            event.preventDefault();
            var data = new FormData(loginForm);
            api('/login', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    email: data.get('email'),
                    password: data.get('password')
                })
            }).then(function () {
                location.href = '/a/' + encodeURIComponent(slug);
            }).catch(function (err) {
                document.getElementById('external-login-error').textContent = err.message;
            });
        });
        return;
    }

    var userEl = document.getElementById('external-app-user');
    api('/me').then(function (me) {
        if (userEl) userEl.textContent = me.display_name + ' · ' + me.role;
    }).catch(function () {
        location.href = '/a/' + encodeURIComponent(slug) + '/login';
    });

    var logout = document.getElementById('external-logout');
    if (logout) {
        logout.addEventListener('click', function () {
            api('/logout', {method: 'POST'}).finally(function () {
                location.href = '/a/' + encodeURIComponent(slug) + '/login';
            });
        });
    }
})();
```

This is only the shell. Task 6 will render blueprint views.

- [ ] **Step 4: Add external UI CSS**

Create `static/css/external-app.css`:

```css
body {
    min-height: 100vh;
    background: var(--bg);
    color: var(--t1);
    font-family: var(--sans);
}

.external-app-login {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
}

.external-login-panel {
    width: min(420px, 100%);
    padding: 24px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--r-md);
    background: var(--surface);
}

.external-login-panel h1,
.external-app-header h1 {
    margin: 0;
    color: var(--t1);
    font-size: 24px;
    font-weight: 700;
}

.external-login-panel p,
.external-app-header p {
    margin: 6px 0 18px;
    color: var(--t3);
    font-size: 13px;
}

.external-login-panel form,
.external-login-panel label {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.external-login-panel form {
    gap: 14px;
}

.external-error {
    min-height: 18px;
    color: var(--err);
    font-size: 12px;
}

.external-app-shell {
    width: min(1200px, 100%);
    margin: 0 auto;
    padding: 24px;
}

.external-app-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 18px;
}

.external-app-nav,
.external-app-dashboard {
    display: flex;
    gap: 8px;
    margin-bottom: 14px;
}

.external-app-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 340px;
    gap: 16px;
}

.external-app-table,
.external-app-form {
    min-height: 260px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--r-md);
    background: var(--surface);
}

@media (max-width: 860px) {
    .external-app-body {
        grid-template-columns: 1fr;
    }
}
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
node --check static/js/external-app.js
cargo check --all-features
```

Commit:

```bash
git add src/web/external_apps.rs src/web/mod.rs src/web/server.rs static/js/external-app.js static/css/external-app.css
git commit -m "Add external app runtime shell"
```

---

## Task 6: External Runtime Blueprint Rendering

**Files:**
- Modify: `src/web/api/external_apps.rs`
- Modify: `static/js/external-app.js`
- Modify: `static/css/external-app.css`

- [ ] **Step 1: Add app metadata endpoint**

Add route:

```rust
.route("/a/{slug}/meta", get(meta))
```

Add handler:

```rust
async fn meta(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiErr> {
    let (app, blueprint, app_pool, user) = require_app_user(&state, &slug, &headers).await?;
    app_pool.close().await;
    Ok(Json(json!({
        "slug": app.slug,
        "name": app.name,
        "description": app.description,
        "blueprint": blueprint,
        "user": {
            "id": user.app_user_id,
            "email": user.email,
            "display_name": user.display_name,
            "role": user.role
        }
    })))
}
```

- [ ] **Step 2: Render nav/table/form/actions in JS**

Extend `static/js/external-app.js` with a small renderer copied in spirit from `static/js/apps.js`, but without Homun Studio controls:

```javascript
var state = { app: null, activeView: 0, records: [], selected: null };

function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
}

function humanName(raw) {
    return String(raw || '').replace(/_/g, ' ').replace(/\b\w/g, function (m) { return m.toUpperCase(); });
}

function entityDef(name) {
    return (state.app.blueprint.entities || []).find(function (entity) { return entity.name === name; });
}

function currentView() {
    return state.app.blueprint.views[state.activeView] || state.app.blueprint.views[0];
}

function renderApp() {
    document.getElementById('external-app-title').textContent = state.app.name;
    document.getElementById('external-app-user').textContent =
        state.app.user.display_name + ' · ' + state.app.user.role;
    renderNav();
    loadRecords();
}
```

Implement:

- `renderNav()` creates one button per blueprint view.
- `loadRecords()` calls `/entities/{entity}/records`.
- `renderTable()` displays records and sets `state.selected`.
- `renderForm()` creates records using `/entities/{entity}/records`.
- `renderActions()` shows workflow buttons only if returned record status allows them.

Use DOM APIs and `textContent`; do not use `innerHTML`.

- [ ] **Step 3: Add role-specific default behavior**

In JS:

```javascript
function visibleViews() {
    var role = state.app.user.role;
    var views = state.app.blueprint.views || [];
    if (role === 'employee') {
        return views.filter(function (view) {
            return /request|richiest/i.test(view.entity) || /request|richiest/i.test(view.name);
        });
    }
    return views;
}
```

If `visibleViews()` returns empty, fall back to all views.

- [ ] **Step 4: Verify and commit**

Run:

```bash
node --check static/js/external-app.js
cargo check --all-features
```

Commit:

```bash
git add src/web/api/external_apps.rs static/js/external-app.js static/css/external-app.css
git commit -m "Render external app blueprint runtime"
```

---

## Task 7: Homun Studio App Users And Public Link

**Files:**
- Modify: `src/web/api/apps.rs`
- Modify: `static/js/apps.js`
- Modify: `static/css/pages.css`

- [ ] **Step 1: Add Studio API for app users**

In `src/web/api/apps.rs`, add routes:

```rust
.route("/v1/apps/{slug}/users", get(list_app_users).post(create_app_user))
.route("/v1/apps/{slug}/bridge-policy", get(get_bridge_policy).put(update_bridge_policy))
```

Add request/response structs:

```rust
#[derive(Debug, Deserialize)]
struct CreateAppUserRequest {
    email: String,
    display_name: String,
    password: String,
    role: String,
    contact_id: Option<i64>,
}

#[derive(Debug, Serialize)]
struct AppUserView {
    id: i64,
    email: String,
    display_name: String,
    role: String,
    status: String,
    contact_id: Option<i64>,
    created_at: String,
}
```

Implement `create_app_user` using `require_write(&auth)?`, `load_owned_app`, `open_app_pool`, `hash_password`, and `insert_app_user`.

- [ ] **Step 2: Seed default admin when first user is created manually**

For P0, do not auto-copy Homun users into app users. Studio should let the owner create the first app admin manually.

Validation:

```rust
if !matches!(body.role.as_str(), "admin" | "approver" | "employee" | "viewer") {
    return Err(bad_request("Unsupported app role"));
}
if body.password.len() < 8 {
    return Err(bad_request("Password must be at least 8 characters"));
}
```

- [ ] **Step 3: Add Studio UI panel**

In `static/js/apps.js`, when rendering app detail, add a Studio-only card:

- public URL: `/a/{slug}`;
- copy/open button;
- app users list;
- create user form: email, display name, password, role.

Keep this in `/apps/{slug}`, not `/a/{slug}`.

- [ ] **Step 4: Verify and commit**

Run:

```bash
node --check static/js/apps.js
cargo check --all-features
```

Commit:

```bash
git add src/web/api/apps.rs static/js/apps.js static/css/pages.css
git commit -m "Add app user management in Studio"
```

---

## Task 8: Bridge Policy API And Fail-Closed Checks

**Files:**
- Modify: `src/web/api/apps.rs`
- Modify: `src/web/api/external_apps.rs`
- Modify: `src/app_factory/bridge.rs`
- Test: `src/app_factory/bridge.rs`

- [ ] **Step 1: Implement bridge policy Studio endpoints**

`GET /api/v1/apps/{slug}/bridge-policy`:

- owner auth required;
- load app by owner;
- return stored policy or `BridgePolicy::deny_all()`.

`PUT /api/v1/apps/{slug}/bridge-policy`:

- write auth required;
- validate JSON as `BridgePolicy`;
- persist with `upsert_bridge_policy`.

- [ ] **Step 2: Add bridge enforcement helper**

In `src/app_factory/bridge.rs`:

```rust
pub fn ensure_tool_allowed(policy: &BridgePolicy, tool: &str) -> anyhow::Result<()> {
    if !policy.allows_tool(tool) {
        anyhow::bail!("Bridge policy does not allow tool '{tool}'");
    }
    Ok(())
}
```

- [ ] **Step 3: Apply fail-closed checks in external API**

For P0, external runtime does not yet call contacts/knowledge/send_message directly. Add a helper in `src/web/api/external_apps.rs`:

```rust
async fn load_bridge_policy_or_deny_all(
    state: &AppState,
    app_id: i64,
) -> crate::app_factory::bridge::BridgePolicy {
    let Some(db) = state.db.as_ref() else {
        return crate::app_factory::bridge::BridgePolicy::deny_all();
    };
    match app_db::load_bridge_policy(db.pool(), app_id).await {
        Ok(Some(row)) => serde_json::from_str(&row.policy_json)
            .unwrap_or_else(|_| crate::app_factory::bridge::BridgePolicy::deny_all()),
        _ => crate::app_factory::bridge::BridgePolicy::deny_all(),
    }
}
```

Use it when writing bridge-related events and when adding future notification hooks. This establishes the fail-closed pattern before notifications are implemented.

- [ ] **Step 4: Verify and commit**

Run:

```bash
cargo test --all-features bridge
cargo check --all-features
```

Commit:

```bash
git add src/app_factory/bridge.rs src/web/api/apps.rs src/web/api/external_apps.rs
git commit -m "Add bridge policy API and checks"
```

---

## Task 9: Demo Blueprint, Runbook, And Smoke Flow

**Files:**
- Modify: `docs/demo/blueprints/ferie-permessi.json`
- Modify: `docs/demo/app-factory-runbook.md`
- Modify: `docs/specs/APP-FACTORY-BLUEPRINT-V0.md`

- [ ] **Step 1: Update demo blueprint roles**

Ensure `docs/demo/blueprints/ferie-permessi.json` includes:

```json
"roles": [
  {
    "name": "admin",
    "label": "Admin",
    "permissions": ["*"]
  },
  {
    "name": "approver",
    "label": "Responsabile",
    "permissions": ["leave_request:read", "leave_request:update", "leave_request:transition:approve", "leave_request:transition:reject"]
  },
  {
    "name": "employee",
    "label": "Dipendente",
    "permissions": ["leave_request:create", "leave_request:read:own"]
  }
]
```

- [ ] **Step 2: Update runbook**

Add this smoke flow:

```text
1. Open Homun Studio: /apps/ferie-permessi
2. Create app user:
   email: employee@example.com
   name: Mario Rossi
   role: employee
   password: Password123!
3. Create app user:
   email: approver@example.com
   name: Responsabile HR
   role: approver
   password: Password123!
4. Open /a/ferie-permessi/login in a private browser.
5. Login as employee and create a leave request.
6. Logout.
7. Login as approver and approve the request.
8. Return to Homun chat and ask:
   Quante richieste ferie approvate risultano?
```

- [ ] **Step 3: Verify docs and commit**

Run:

```bash
node -e "JSON.parse(require('fs').readFileSync('docs/demo/blueprints/ferie-permessi.json','utf8')); console.log('json ok')"
rg -n "/a/ferie-permessi|employee@example.com|approver@example.com" docs/demo docs/specs
```

Commit:

```bash
git add docs/demo/blueprints/ferie-permessi.json docs/demo/app-factory-runbook.md docs/specs/APP-FACTORY-BLUEPRINT-V0.md
git commit -m "Document external app demo flow"
```

---

## Task 10: Final Verification And Release Build

**Files:**
- No source edits unless verification finds a blocker.

- [ ] **Step 1: Run automated checks**

Run:

```bash
cargo fmt --all -- --check
cargo check --all-features
cargo test --all-features app_factory
cargo test --all-features external_app
cargo clippy --all-features -- -D warnings
cargo build --release --all-features
```

Expected: all pass.

- [ ] **Step 2: Manual smoke**

With release gateway:

1. Open `/apps/ferie-permessi`.
2. Confirm public link `/a/ferie-permessi` is shown.
3. Create `employee@example.com` as `employee`.
4. Create `approver@example.com` as `approver`.
5. Open `/a/ferie-permessi/login`.
6. Login employee and create request.
7. Logout.
8. Login approver and approve request.
9. Confirm Homun Studio sees the record/event.
10. Confirm direct access to `/a/ferie-permessi` without app session redirects to login.
11. Confirm app user cannot access Homun `/apps`.

- [ ] **Step 3: Commit verification docs if needed**

If the runbook or spec needs status updates:

```bash
git add docs/demo/app-factory-runbook.md docs/superpowers/specs/2026-04-29-external-app-runtime-bridge-design.md
git commit -m "Document external app runtime verification"
```

---

## Implementation Notes

- Keep `/apps/{slug}` as Homun Studio. Do not remove the current internal renderer.
- Add `/a/{slug}` as the published runtime. It must not use `page_html()` because that injects Homun sidebar/topbar.
- Use existing `hash_password` / `verify_password` from `src/web/auth.rs` for app-local passwords.
- Use separate app session cookies. Do not reuse `homun_session`.
- Keep bridge permissions fail-closed. Missing policy means no app-to-Homun tool/channel/knowledge access.
- Do not implement real notifications in P0 unless all P0 runtime pieces are complete.
- Do not add generated JavaScript/SQL from blueprint.
- Prefer local app DB helpers in `src/app_factory/db.rs`; keep web handlers thin.
