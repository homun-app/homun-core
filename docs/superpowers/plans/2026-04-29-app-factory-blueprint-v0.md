# App Factory Blueprint v0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first usable Tool/App Factory path: a validated blueprint creates an internal app, renders a generic UI, stores records, supports approve/reject workflow actions, and exposes tools the agent can use.

**Architecture:** Use a declarative blueprint and per-app SQLite storage rather than generated code. `homun.db` is the control plane for app metadata, ownership, blueprint, and app DB paths. Each generated app has an isolated SQLite database for operational records and events. The backend owns validation, persistence, API, and agent tools; the web UI renders apps from blueprint; the `app-factory` skill guides the model to produce valid blueprints. Keep v0 scoped to CRUD + simple state workflows so it is demoable in 10 days.

**Tech Stack:** Rust, Axum, SQLx/SQLite migrations, Serde, existing Homun ToolRegistry, existing web static JS/CSS, existing skills loader.

---

## File Structure

Create:

- `migrations/056_internal_apps.sql` — app factory control-plane tables.
- `src/app_factory/mod.rs` — module exports.
- `src/app_factory/blueprint.rs` — serde structs for blueprint v0.
- `src/app_factory/validation.rs` — strict validator and tests.
- `src/app_factory/db.rs` — DB access helpers.
- `src/app_factory/runtime.rs` — record validation, filtering, workflow transitions.
- `src/tools/app_factory.rs` — agent tools for internal apps.
- `src/web/api/apps.rs` — `/api/v1/apps` API.
- `static/js/apps.js` — generic app renderer.
- `skills/app-factory/SKILL.md` — model-facing generation instructions.

Modify:

- `src/main.rs` — add `mod app_factory;`.
- `src/tools/mod.rs` and `src/tools/bootstrap.rs` — register app factory tools.
- `src/web/api/mod.rs` — merge apps API routes.
- `src/web/pages.rs` — add `/apps` and `/apps/{slug}` pages and add an `Apps` navigation entry in the existing sidebar.
- `static/css/pages.css` or `static/css/layout.css` — minimal app runtime styling.
- `docs/PRESENTATION-10-DAY-PLAN.md` — mark implementation status as it progresses.

---

## Task 1: Migration And Domain Types

**Files:**

- Create: `migrations/056_internal_apps.sql`
- Create: `src/app_factory/mod.rs`
- Create: `src/app_factory/blueprint.rs`
- Modify: `src/main.rs`

- [ ] **Step 1: Add the migration**

Create `migrations/056_internal_apps.sql`:

```sql
-- Internal App Factory: control-plane metadata.
-- Each generated app stores its operational records in a dedicated SQLite DB.
CREATE TABLE IF NOT EXISTS internal_apps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    profile_id INTEGER,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    blueprint_json TEXT NOT NULL,
    db_path TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    storage_mode TEXT NOT NULL DEFAULT 'sqlite_per_app',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT,
    UNIQUE(user_id, slug)
);

CREATE TABLE IF NOT EXISTS internal_app_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id INTEGER NOT NULL REFERENCES internal_apps(id) ON DELETE CASCADE,
    record_id INTEGER,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    actor_user_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_internal_apps_user_profile ON internal_apps(user_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_internal_app_events_app_record ON internal_app_events(app_id, record_id);
```

- [ ] **Step 2: Add blueprint structs**

Create `src/app_factory/mod.rs`:

```rust
pub mod blueprint;
pub mod validation;
```

Create `src/app_factory/blueprint.rs`:

```rust
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppBlueprint {
    pub version: u32,
    pub app: AppDefinition,
    #[serde(default)]
    pub entities: Vec<EntityDefinition>,
    #[serde(default)]
    pub views: Vec<ViewDefinition>,
    #[serde(default)]
    pub workflows: Vec<WorkflowDefinition>,
    #[serde(default)]
    pub roles: Vec<RoleDefinition>,
    #[serde(default)]
    pub notifications: Vec<NotificationDefinition>,
    #[serde(default)]
    pub automations: Vec<AutomationDefinition>,
    #[serde(default)]
    pub agent_commands: Vec<AgentCommandDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppDefinition {
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EntityDefinition {
    pub name: String,
    pub label: String,
    #[serde(default)]
    pub fields: Vec<FieldDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FieldDefinition {
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: FieldType,
    pub label: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default: Option<Value>,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FieldType {
    String,
    Text,
    Number,
    Date,
    Boolean,
    Enum,
    Relation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ViewDefinition {
    #[serde(rename = "type")]
    pub view_type: ViewType,
    pub entity: String,
    pub name: String,
    #[serde(default)]
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ViewType {
    Table,
    Form,
    Detail,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkflowDefinition {
    pub entity: String,
    pub state_field: String,
    #[serde(default)]
    pub states: Vec<String>,
    #[serde(default)]
    pub transitions: Vec<TransitionDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TransitionDefinition {
    pub name: String,
    pub from: String,
    pub to: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RoleDefinition {
    pub name: String,
    pub label: String,
    #[serde(default)]
    pub permissions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NotificationDefinition {
    pub on: String,
    pub channel: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AutomationDefinition {
    pub name: String,
    pub schedule: String,
    pub task: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentCommandDefinition {
    pub intent: String,
    pub entity: String,
    pub action: String,
    #[serde(default)]
    pub examples: Vec<String>,
}
```

- [ ] **Step 3: Register the module**

In `src/main.rs`, add:

```rust
mod app_factory;
```

near the other top-level modules.

- [ ] **Step 4: Verify**

Run:

```bash
cargo fmt --all -- --check
cargo check --all-features
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add migrations/056_internal_apps.sql src/app_factory/mod.rs src/app_factory/blueprint.rs src/main.rs
git commit -m "Add app factory blueprint domain"
```

---

## Task 2: Blueprint Validator

**Files:**

- Create: `src/app_factory/validation.rs`
- Modify: `src/app_factory/mod.rs` if needed

- [ ] **Step 1: Add validator with tests**

Create `src/app_factory/validation.rs`:

```rust
use std::collections::{HashMap, HashSet};

use super::blueprint::{AppBlueprint, FieldType, ViewType};

const MAX_BLUEPRINT_BYTES: usize = 128 * 1024;
const MAX_ENTITIES: usize = 12;
const MAX_FIELDS_PER_ENTITY: usize = 40;
const MAX_VIEWS: usize = 20;
const MAX_TRANSITIONS: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationReport {
    pub errors: Vec<String>,
}

impl ValidationReport {
    pub fn ok(&self) -> bool {
        self.errors.is_empty()
    }
}

pub fn validate_blueprint_json(raw: &str) -> Result<AppBlueprint, ValidationReport> {
    if raw.len() > MAX_BLUEPRINT_BYTES {
        return Err(ValidationReport {
            errors: vec!["Blueprint exceeds 128 KB".to_string()],
        });
    }
    let blueprint: AppBlueprint = serde_json::from_str(raw).map_err(|e| ValidationReport {
        errors: vec![format!("Invalid blueprint JSON: {e}")],
    })?;
    validate_blueprint(&blueprint).map(|_| blueprint)
}

pub fn validate_blueprint(blueprint: &AppBlueprint) -> Result<(), ValidationReport> {
    let mut errors = Vec::new();

    if blueprint.version != 1 {
        errors.push("Only blueprint version 1 is supported".to_string());
    }
    validate_slug("app.slug", &blueprint.app.slug, &mut errors);
    validate_len("app.name", &blueprint.app.name, 1, 80, &mut errors);
    if let Some(description) = &blueprint.app.description {
        validate_len("app.description", description, 0, 500, &mut errors);
    }
    if blueprint.entities.is_empty() {
        errors.push("Blueprint must define at least one entity".to_string());
    }
    if blueprint.entities.len() > MAX_ENTITIES {
        errors.push(format!("Blueprint cannot define more than {MAX_ENTITIES} entities"));
    }
    if blueprint.views.is_empty() {
        errors.push("Blueprint must define at least one view".to_string());
    }
    if blueprint.views.len() > MAX_VIEWS {
        errors.push(format!("Blueprint cannot define more than {MAX_VIEWS} views"));
    }

    let mut entity_names = HashSet::new();
    let mut field_map: HashMap<&str, HashMap<&str, &FieldType>> = HashMap::new();

    for entity in &blueprint.entities {
        validate_ident("entity.name", &entity.name, &mut errors);
        validate_len("entity.label", &entity.label, 1, 80, &mut errors);
        if !entity_names.insert(entity.name.as_str()) {
            errors.push(format!("Duplicate entity '{}'", entity.name));
        }
        if entity.fields.is_empty() {
            errors.push(format!("Entity '{}' must define at least one field", entity.name));
        }
        if entity.fields.len() > MAX_FIELDS_PER_ENTITY {
            errors.push(format!(
                "Entity '{}' cannot define more than {MAX_FIELDS_PER_ENTITY} fields",
                entity.name
            ));
        }
        let mut fields = HashMap::new();
        let mut seen_fields = HashSet::new();
        for field in &entity.fields {
            validate_ident("field.name", &field.name, &mut errors);
            validate_len("field.label", &field.label, 1, 80, &mut errors);
            if !seen_fields.insert(field.name.as_str()) {
                errors.push(format!("Duplicate field '{}.{}'", entity.name, field.name));
            }
            match field.field_type {
                FieldType::Enum => {
                    if field.options.is_empty() || field.options.len() > 32 {
                        errors.push(format!(
                            "Enum field '{}.{}' must define 1-32 options",
                            entity.name, field.name
                        ));
                    }
                }
                FieldType::Relation => {
                    if field.to.as_deref().unwrap_or("").trim().is_empty() {
                        errors.push(format!(
                            "Relation field '{}.{}' must define target entity",
                            entity.name, field.name
                        ));
                    }
                }
                _ => {}
            }
            fields.insert(field.name.as_str(), &field.field_type);
        }
        field_map.insert(entity.name.as_str(), fields);
    }

    for entity in &blueprint.entities {
        for field in &entity.fields {
            if field.field_type == FieldType::Relation {
                if let Some(target) = field.to.as_deref() {
                    if !entity_names.contains(target) {
                        errors.push(format!(
                            "Relation field '{}.{}' references unknown entity '{}'",
                            entity.name, field.name, target
                        ));
                    }
                }
            }
        }
    }

    for view in &blueprint.views {
        if !entity_names.contains(view.entity.as_str()) {
            errors.push(format!("View '{}' references unknown entity '{}'", view.name, view.entity));
            continue;
        }
        if view.view_type == ViewType::Table && view.columns.is_empty() {
            errors.push(format!("Table view '{}' must define columns", view.name));
        }
        if let Some(fields) = field_map.get(view.entity.as_str()) {
            for column in &view.columns {
                if !fields.contains_key(column.as_str()) {
                    errors.push(format!(
                        "View '{}' references unknown field '{}.{}'",
                        view.name, view.entity, column
                    ));
                }
            }
        }
    }

    for workflow in &blueprint.workflows {
        if !entity_names.contains(workflow.entity.as_str()) {
            errors.push(format!("Workflow references unknown entity '{}'", workflow.entity));
            continue;
        }
        let Some(fields) = field_map.get(workflow.entity.as_str()) else {
            continue;
        };
        match fields.get(workflow.state_field.as_str()) {
            Some(FieldType::Enum) => {}
            Some(_) => errors.push(format!(
                "Workflow state field '{}.{}' must be enum",
                workflow.entity, workflow.state_field
            )),
            None => errors.push(format!(
                "Workflow references unknown state field '{}.{}'",
                workflow.entity, workflow.state_field
            )),
        }
        if workflow.transitions.len() > MAX_TRANSITIONS {
            errors.push(format!("Workflow cannot define more than {MAX_TRANSITIONS} transitions"));
        }
        let states: HashSet<&str> = workflow.states.iter().map(String::as_str).collect();
        for transition in &workflow.transitions {
            validate_ident("transition.name", &transition.name, &mut errors);
            if !states.contains(transition.from.as_str()) {
                errors.push(format!("Transition '{}' has unknown from state '{}'", transition.name, transition.from));
            }
            if !states.contains(transition.to.as_str()) {
                errors.push(format!("Transition '{}' has unknown to state '{}'", transition.name, transition.to));
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(ValidationReport { errors })
    }
}

fn validate_slug(field: &str, value: &str, errors: &mut Vec<String>) {
    if value.is_empty() || value.len() > 64 {
        errors.push(format!("{field} must be 1-64 characters"));
        return;
    }
    if !value.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        errors.push(format!("{field} must contain only lowercase letters, numbers, and hyphens"));
    }
}

fn validate_ident(field: &str, value: &str, errors: &mut Vec<String>) {
    if value.is_empty() || value.len() > 64 {
        errors.push(format!("{field} must be 1-64 characters"));
        return;
    }
    if !value.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
        errors.push(format!("{field} must contain only lowercase letters, numbers, and underscores"));
    }
}

fn validate_len(field: &str, value: &str, min: usize, max: usize, errors: &mut Vec<String>) {
    if value.len() < min || value.len() > max {
        errors.push(format!("{field} must be {min}-{max} characters"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_leave_blueprint() -> AppBlueprint {
        serde_json::from_value(serde_json::json!({
            "version": 1,
            "app": {"slug": "ferie-permessi", "name": "Ferie e Permessi"},
            "entities": [
                {"name": "employee", "label": "Dipendente", "fields": [
                    {"name": "full_name", "type": "string", "label": "Nome completo", "required": true}
                ]},
                {"name": "leave_request", "label": "Richiesta", "fields": [
                    {"name": "employee", "type": "relation", "to": "employee", "label": "Dipendente"},
                    {"name": "status", "type": "enum", "label": "Stato", "options": ["pending", "approved", "rejected"], "default": "pending"}
                ]}
            ],
            "views": [
                {"type": "table", "entity": "leave_request", "name": "Richieste", "columns": ["employee", "status"]}
            ],
            "workflows": [
                {"entity": "leave_request", "state_field": "status", "states": ["pending", "approved", "rejected"], "transitions": [
                    {"name": "approve", "from": "pending", "to": "approved", "label": "Approva"}
                ]}
            ]
        }))
        .unwrap()
    }

    #[test]
    fn accepts_valid_leave_blueprint() {
        assert!(validate_blueprint(&valid_leave_blueprint()).is_ok());
    }

    #[test]
    fn rejects_unknown_relation_target() {
        let mut bp = valid_leave_blueprint();
        bp.entities[1].fields[0].to = Some("missing".to_string());
        let report = validate_blueprint(&bp).unwrap_err();
        assert!(report.errors.iter().any(|e| e.contains("unknown entity 'missing'")));
    }

    #[test]
    fn rejects_view_unknown_field() {
        let mut bp = valid_leave_blueprint();
        bp.views[0].columns.push("missing".to_string());
        let report = validate_blueprint(&bp).unwrap_err();
        assert!(report.errors.iter().any(|e| e.contains("unknown field 'leave_request.missing'")));
    }

    #[test]
    fn rejects_workflow_on_non_enum_state() {
        let mut bp = valid_leave_blueprint();
        bp.workflows[0].state_field = "employee".to_string();
        let report = validate_blueprint(&bp).unwrap_err();
        assert!(report.errors.iter().any(|e| e.contains("must be enum")));
    }
}
```

- [ ] **Step 2: Run validator tests**

Run:

```bash
cargo test --all-features app_factory::validation::tests
```

Expected: tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/app_factory/validation.rs src/app_factory/mod.rs
git commit -m "Add app factory blueprint validator"
```

---

## Task 3: Persistence Layer With Per-App SQLite Isolation

**Files:**

- Create: `src/app_factory/db.rs`
- Modify: `src/app_factory/mod.rs`

- [ ] **Step 1: Add DB row structs, path resolution, and helpers**

Create `src/app_factory/db.rs` with:

```rust
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use super::blueprint::AppBlueprint;

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    data_dir.join("apps").join(user_id).join(app_slug).join("app.db")
}

pub async fn open_app_pool(db_path: &Path) -> Result<SqlitePool> {
    if let Some(parent) = db_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;
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
    .await?;

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
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_app_records_entity ON app_records(entity_name)")
        .execute(pool)
        .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_app_events_record ON app_events(record_id)")
        .execute(pool)
        .await?;

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
    open_app_pool(&db_path).await?;
    let id = sqlx::query_scalar(
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
    .bind(db_path.to_string_lossy().as_ref())
    .fetch_one(control_pool)
    .await?;
    Ok(id)
}

pub async fn list_apps_for_user(
    control_pool: &SqlitePool,
    user_id: &str,
    profile_id: Option<i64>,
) -> Result<Vec<InternalAppRow>> {
    let rows = if let Some(profile_id) = profile_id {
        sqlx::query_as!(
            InternalAppRow,
            "SELECT id, user_id, profile_id, slug, name, description, blueprint_json, db_path, schema_version, storage_mode, status, created_at, updated_at
             FROM internal_apps
             WHERE user_id = ? AND (profile_id IS NULL OR profile_id = ?)
             ORDER BY updated_at DESC, created_at DESC",
            user_id,
            profile_id
        )
        .fetch_all(control_pool)
        .await?
    } else {
        sqlx::query_as!(
            InternalAppRow,
            "SELECT id, user_id, profile_id, slug, name, description, blueprint_json, db_path, schema_version, storage_mode, status, created_at, updated_at
             FROM internal_apps
             WHERE user_id = ?
             ORDER BY updated_at DESC, created_at DESC",
            user_id
        )
        .fetch_all(control_pool)
        .await?
    };
    Ok(rows)
}

pub async fn load_app_for_user(control_pool: &SqlitePool, user_id: &str, slug: &str) -> Result<Option<InternalAppRow>> {
    let row = sqlx::query_as!(
        InternalAppRow,
        "SELECT id, user_id, profile_id, slug, name, description, blueprint_json, db_path, schema_version, storage_mode, status, created_at, updated_at
         FROM internal_apps
         WHERE user_id = ? AND slug = ?",
        user_id,
        slug
    )
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
    let id = sqlx::query_scalar(
        "INSERT INTO app_records (entity_name, data_json, status, created_by_user_id)
         VALUES (?, ?, ?, ?)
         RETURNING id",
    )
    .bind(entity_name)
    .bind(serde_json::to_string(data)?)
    .bind(status)
    .bind(created_by_user_id)
    .fetch_one(app_pool)
    .await?;
    Ok(id)
}

pub async fn list_records(app_pool: &SqlitePool, entity_name: &str, limit: i64) -> Result<Vec<AppRecordRow>> {
    let rows = sqlx::query_as!(
        AppRecordRow,
        "SELECT id, entity_name, data_json, status, created_by_user_id, created_at, updated_at
         FROM app_records
         WHERE entity_name = ?
         ORDER BY created_at DESC
         LIMIT ?",
        entity_name,
        limit
    )
    .fetch_all(app_pool)
    .await?;
    Ok(rows)
}
```

Add to `src/app_factory/mod.rs`:

```rust
pub mod db;
```

- [ ] **Step 2: Verify**

Run:

```bash
cargo check --all-features
```

Expected: pass. If `query_as!` requires prepared DB metadata, switch these helpers to `sqlx::query_as::<_, InternalAppRow>(...)` and derive `sqlx::FromRow`.

- [ ] **Step 3: Commit**

```bash
git add migrations/056_internal_apps.sql docs/specs/APP-FACTORY-BLUEPRINT-V0.md docs/superpowers/plans/2026-04-29-app-factory-blueprint-v0.md src/app_factory/db.rs src/app_factory/mod.rs
git commit -m "Add internal app persistence helpers"
```

---

## Task 4: Runtime Record Validation And Workflow Actions

**Files:**

- Create: `src/app_factory/runtime.rs`
- Modify: `src/app_factory/mod.rs`

- [ ] **Step 1: Add runtime validation**

Create `src/app_factory/runtime.rs` with functions:

```rust
use anyhow::{bail, Result};
use serde_json::{Map, Value};

use super::blueprint::{AppBlueprint, EntityDefinition, FieldDefinition, FieldType};

pub fn entity<'a>(blueprint: &'a AppBlueprint, name: &str) -> Result<&'a EntityDefinition> {
    blueprint
        .entities
        .iter()
        .find(|e| e.name == name)
        .ok_or_else(|| anyhow::anyhow!("Unknown entity '{name}'"))
}

pub fn validate_record_data(blueprint: &AppBlueprint, entity_name: &str, data: &Value) -> Result<Value> {
    let entity = entity(blueprint, entity_name)?;
    let input = data.as_object().ok_or_else(|| anyhow::anyhow!("Record data must be a JSON object"))?;
    let mut out = Map::new();

    for field in &entity.fields {
        match input.get(&field.name).or(field.default.as_ref()) {
            Some(value) => {
                validate_field_value(field, value)?;
                out.insert(field.name.clone(), value.clone());
            }
            None if field.required => bail!("Missing required field '{}'", field.name),
            None => {}
        }
    }

    Ok(Value::Object(out))
}

fn validate_field_value(field: &FieldDefinition, value: &Value) -> Result<()> {
    match field.field_type {
        FieldType::String | FieldType::Text | FieldType::Date => {
            if !value.is_string() {
                bail!("Field '{}' must be a string", field.name);
            }
        }
        FieldType::Number => {
            if !value.is_number() {
                bail!("Field '{}' must be a number", field.name);
            }
        }
        FieldType::Boolean => {
            if !value.is_boolean() {
                bail!("Field '{}' must be a boolean", field.name);
            }
        }
        FieldType::Enum => {
            let Some(raw) = value.as_str() else {
                bail!("Field '{}' must be a string enum value", field.name);
            };
            if !field.options.iter().any(|opt| opt == raw) {
                bail!("Field '{}' has unsupported option '{}'", field.name, raw);
            }
        }
        FieldType::Relation => {
            if !(value.is_number() || value.is_string()) {
                bail!("Field '{}' relation must be record id or string label", field.name);
            }
        }
    }
    Ok(())
}

pub fn apply_transition(blueprint: &AppBlueprint, entity_name: &str, record_data: &mut Value, action: &str) -> Result<String> {
    let workflow = blueprint
        .workflows
        .iter()
        .find(|w| w.entity == entity_name)
        .ok_or_else(|| anyhow::anyhow!("Entity '{entity_name}' has no workflow"))?;
    let transition = workflow
        .transitions
        .iter()
        .find(|t| t.name == action)
        .ok_or_else(|| anyhow::anyhow!("Unknown action '{action}'"))?;
    let object = record_data
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("Record data must be object"))?;
    let current = object
        .get(&workflow.state_field)
        .and_then(Value::as_str)
        .unwrap_or("");
    if current != transition.from {
        bail!(
            "Action '{}' requires state '{}' but record is '{}'",
            action,
            transition.from,
            current
        );
    }
    object.insert(workflow.state_field.clone(), Value::String(transition.to.clone()));
    Ok(format!("{entity_name}.{}", transition.to))
}
```

Add to `src/app_factory/mod.rs`:

```rust
pub mod runtime;
```

- [ ] **Step 2: Add tests**

Add tests in `runtime.rs` that:

- validate a leave request with required fields;
- reject missing `kind`;
- apply `approve` from `pending` to `approved`;
- reject `approve` when current state is `rejected`.

- [ ] **Step 3: Run tests**

```bash
cargo test --all-features app_factory::runtime::tests
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add src/app_factory/runtime.rs src/app_factory/mod.rs
git commit -m "Add internal app runtime validation"
```

---

## Task 5: Apps API

**Files:**

- Create: `src/web/api/apps.rs`
- Modify: `src/web/api/mod.rs`

- [ ] **Step 1: Add API routes**

Create `src/web/api/apps.rs` with endpoints:

- `GET /v1/apps`
- `POST /v1/apps`
- `GET /v1/apps/{slug}`
- `GET /v1/apps/{slug}/entities/{entity}/records`
- `POST /v1/apps/{slug}/entities/{entity}/records`
- `POST /v1/apps/{slug}/entities/{entity}/records/{record_id}/actions/{action}`

Use `AuthUser` from `src/web/auth.rs`. Resolve profile slugs using `crate::profiles::db::load_profile_by_slug_for_user`.

Implementation rules:

- return `403` when a profile slug is not owned by `auth.user_id`;
- always load apps with `WHERE user_id = ?`;
- validate blueprint before insert;
- validate record data before insert;
- validate transition before update;
- write `internal_app_events` for create and transition.

- [ ] **Step 2: Register routes**

In `src/web/api/mod.rs`, add:

```rust
mod apps;
```

and merge:

```rust
.merge(apps::routes())
```

- [ ] **Step 3: Verify**

Run:

```bash
cargo check --all-features
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add src/web/api/apps.rs src/web/api/mod.rs
git commit -m "Add internal apps API"
```

---

## Task 6: Agent Tools

**Files:**

- Create: `src/tools/app_factory.rs`
- Modify: `src/tools/mod.rs`
- Modify: `src/tools/bootstrap.rs`

- [ ] **Step 1: Add tools**

Create tools:

- `create_internal_app`
- `list_internal_apps`
- `create_app_record`
- `query_app_records`
- `run_app_action`

Each tool must use `ToolContext.user_id`, `ToolContext.profile_id`, and `ToolContext.profile_slug`.

Tool behavior:

- `create_internal_app` validates blueprint and inserts app.
- `list_internal_apps` lists apps for the active user/profile.
- `create_app_record` validates entity data and inserts record.
- `query_app_records` supports v0 filters in Rust over JSON data.
- `run_app_action` applies workflow transition and writes event.

- [ ] **Step 2: Register tools**

In `src/tools/mod.rs`, expose:

```rust
pub mod app_factory;
```

In `src/tools/bootstrap.rs`, register the five tools with the same permissions pattern as other built-in tools.

- [ ] **Step 3: Add unit tests**

At minimum:

- tool descriptions mention internal apps and blueprint;
- missing `user_id` returns an error;
- invalid blueprint returns validation errors.

- [ ] **Step 4: Verify**

```bash
cargo test --all-features tools::app_factory::tests
cargo check --all-features
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/app_factory.rs src/tools/mod.rs src/tools/bootstrap.rs
git commit -m "Add internal app agent tools"
```

---

## Task 7: Web Pages And Generic Renderer

**Files:**

- Modify: `src/web/pages.rs`
- Create: `static/js/apps.js`
- Modify: `static/css/pages.css`

- [ ] **Step 1: Add pages**

In `src/web/pages.rs`, add routes:

```rust
.route("/apps", get(apps_page))
.route("/apps/{slug}", get(app_detail_page))
```

Add page bodies:

- `/apps`: list container `#apps-list`, empty state, create/import blueprint button.
- `/apps/{slug}`: root container `#app-runtime` with `data-app-slug="{slug}"`.

Load `apps.js` on both pages.

- [ ] **Step 2: Add renderer**

Create `static/js/apps.js`:

- fetch `/api/v1/apps`;
- fetch `/api/v1/apps/{slug}`;
- render tabs from `views`;
- render table rows from records endpoint;
- render form fields from entity fields;
- submit create record;
- render detail/action buttons for workflow transitions.

Security rule: dynamic text uses `textContent`, not raw `innerHTML`, except for static markup created by code.

- [ ] **Step 3: Add styling**

Add minimal CSS:

- `.app-runtime-header`
- `.app-runtime-tabs`
- `.app-runtime-table`
- `.app-runtime-form`
- `.app-runtime-actions`

Keep cards at existing radius and density.

- [ ] **Step 4: Browser smoke**

After build/restart, verify:

- `/apps` loads;
- `/apps/ferie-permessi` loads for a seeded app;
- create record works;
- approve action works.

- [ ] **Step 5: Commit**

```bash
git add src/web/pages.rs static/js/apps.js static/css/pages.css
git commit -m "Add internal app web runtime"
```

---

## Task 8: App Factory Skill

**Files:**

- Create: `skills/app-factory/SKILL.md`

- [ ] **Step 1: Add skill**

Create `skills/app-factory/SKILL.md`:

```markdown
---
name: app-factory
description: Use when the user asks to create, design, generate, or modify an internal business app, tool, database-backed workflow, approval system, tracker, CRM-like mini app, or operational interface.
allowed-tools: create_internal_app, list_internal_apps, create_app_record, query_app_records, run_app_action, read_file, write_file
---

# App Factory

You create internal business tools using Homun blueprint v0.

Do not generate arbitrary Rust, JavaScript, SQL, shell commands, or external scaffolds.
Always produce or update a blueprint first.

Supported components:
- App
- Entity
- Field
- View
- Workflow
- Role
- Notification
- Automation
- AgentCommand

For ambiguous requests, ask one concise question only when the missing answer changes the data model.
For common business tools, make conservative assumptions and keep the blueprint small.

When ready, call `create_internal_app` with the validated blueprint.
After creation, return the internal app link and summarize entities, views, and workflow actions.
```

- [ ] **Step 2: Verify skill loads**

Run:

```bash
cargo check --all-features
```

Then start gateway and verify logs include `app-factory` among loaded skills.

- [ ] **Step 3: Commit**

```bash
git add skills/app-factory/SKILL.md
git commit -m "Add app factory skill"
```

---

## Task 9: Demo Seed And Runbook

**Files:**

- Create: `docs/demo/app-factory-runbook.md`
- Create: `docs/demo/blueprints/ferie-permessi.json`

- [ ] **Step 1: Add demo blueprint**

Copy the blueprint from `docs/specs/APP-FACTORY-BLUEPRINT-V0.md` into `docs/demo/blueprints/ferie-permessi.json`.

- [ ] **Step 2: Add runbook**

Create `docs/demo/app-factory-runbook.md` with:

- setup prerequisites;
- prompt live;
- fallback using pre-seed blueprint;
- expected screenshots/pages;
- demo script 5-7 minutes;
- failure fallback table.

- [ ] **Step 3: Commit**

```bash
git add docs/demo/app-factory-runbook.md docs/demo/blueprints/ferie-permessi.json
git commit -m "Add app factory demo runbook"
```

---

## Task 10: Final Verification

**Files:**

- Modify: `docs/PRESENTATION-10-DAY-PLAN.md`
- Modify: `docs/specs/APP-FACTORY-BLUEPRINT-V0.md`

- [ ] **Step 1: Update docs status**

Mark implemented v0 pieces and remaining risks.

- [ ] **Step 2: Full verification**

Run:

```bash
cargo fmt --all -- --check
cargo check --all-features
cargo test --all-features app_factory
cargo test --all-features tools::app_factory
cargo clippy --all-features -- -D warnings
cargo build --release --all-features
```

Expected: all pass.

- [ ] **Step 3: Manual smoke**

With release gateway:

1. Open `/apps`.
2. Create app from ferie blueprint.
3. Open `/apps/ferie-permessi`.
4. Create employee.
5. Create leave request.
6. Approve leave request.
7. Ask chat: `Quante richieste ferie sono state approvate questa settimana?`
8. Switch user/profile and confirm app/records are scoped.

- [ ] **Step 4: Commit**

```bash
git add docs/PRESENTATION-10-DAY-PLAN.md docs/specs/APP-FACTORY-BLUEPRINT-V0.md
git commit -m "Document app factory v0 verification"
```

---

## Implementation Notes

- Prefer storage-generic v0 over dynamic SQL tables.
- Keep workflow transitions local to app records for P0; only use `WorkflowEngine` for future multi-step app processes.
- Keep notification blueprint metadata in P0; real outbound notifications are P1 unless trivial.
- If time gets tight, seed the ferie blueprint and demo the runtime. Live blueprint generation via LLM can be shown as preview, with fallback to pre-seed.
- Do not add public webhooks or custom code execution in v0.
