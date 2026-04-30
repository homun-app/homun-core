# Modular App Factory Blueprint v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a modular Blueprint v1 foundation so generated apps compose identity, data, workflow, navigation, dashboard and calendar primitives instead of behaving like generic form builders.

**Architecture:** Extend the existing `AppBlueprint` schema in a backward-compatible way, then centralize app permission decisions in a new app-factory permission module. The external app API remains server-authoritative: the browser hides unauthorized fields/actions, but Rust validation enforces system fields, workflow transitions and record visibility.

**Tech Stack:** Rust, serde, serde_json, sqlx/SQLite, Axum web API, vanilla JavaScript external runtime, Markdown docs and demo blueprints.

---

## File Structure

- Modify `src/app_factory/blueprint.rs`: add module, permission, navigation, dashboard and calendar structs; add field/workflow/transition metadata.
- Modify `src/app_factory/validation.rs`: validate supported modules, dependencies, field metadata, initial workflow state, transition roles and navigation references.
- Create `src/app_factory/permissions.rs`: one focused module for `can_create`, `can_read`, `can_transition`, `visible_fields` and create-input sanitization.
- Modify `src/app_factory/mod.rs`: expose `permissions`.
- Modify `src/app_factory/runtime.rs`: apply initial workflow state and reject unauthorized system/managed fields.
- Modify `src/web/api/external_apps.rs`: use blueprint permissions instead of hardcoded role checks.
- Modify `static/js/external-app.js`: hide system fields, filter views/actions by role, use navigation when present.
- Modify `docs/demo/blueprints/ferie-permessi.json`: migrate demo blueprint to modular v1 metadata.
- Create `docs/demo/blueprints/ticket-interni.json`: second demo app proving reuse of the same modules.
- Modify `docs/demo/app-factory-runbook.md`: add demo flow for modular app creation and role checks.
- Modify the App Factory skill instructions under the Homun skill directory if present in-repo; otherwise update `docs/specs/APP-FACTORY-BLUEPRINT-V0.md` with a v1 addendum.

## Task 1: Blueprint v1 Schema

**Files:**
- Modify: `src/app_factory/blueprint.rs`

- [ ] **Step 1: Add failing serde tests for modular metadata**

Add tests at the bottom of `src/app_factory/blueprint.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn deserializes_modular_blueprint_v1_metadata() {
        let blueprint: AppBlueprint = serde_json::from_value(json!({
            "version": 1,
            "app": {"slug": "ferie-permessi", "name": "Ferie e Permessi"},
            "modules": [
                {"name": "identity", "version": 1, "features": ["local_users", "roles"], "required": true},
                {"name": "workflow", "version": 1, "features": ["state_machine"], "required": true}
            ],
            "entities": [{
                "name": "leave_request",
                "label": "Richiesta",
                "fields": [
                    {"name": "kind", "type": "enum", "label": "Tipo", "options": ["ferie"], "required": true},
                    {"name": "status", "type": "enum", "label": "Stato", "options": ["pending", "approved"], "default": "pending", "system": true, "managed_by": "workflow", "editable_by": []}
                ]
            }],
            "views": [{"id": "leave_requests", "type": "table", "entity": "leave_request", "name": "Richieste", "columns": ["kind", "status"]}],
            "workflows": [{
                "entity": "leave_request",
                "state_field": "status",
                "initial_state": "pending",
                "states": ["pending", "approved"],
                "transitions": [{"name": "approve", "from": "pending", "to": "approved", "label": "Approva", "roles": ["admin", "approver"]}]
            }],
            "permissions": [{"role": "employee", "allow": ["leave_request:create", "leave_request:read:own"], "deny": ["leave_request:transition:*"]}],
            "navigation": [{"label": "Richieste", "view": "leave_requests", "roles": ["admin", "employee"]}],
            "dashboards": [{"name": "overview", "widgets": [{"type": "count", "entity": "leave_request", "label": "Pending", "filter": {"status": "pending"}, "roles": ["admin"]}]}],
            "calendars": [{"name": "leave_calendar", "entity": "leave_request", "start_field": "start_date", "end_field": "end_date", "title_field": "kind", "roles": ["admin"]}]
        })).unwrap();

        assert_eq!(blueprint.modules.len(), 2);
        assert!(blueprint.entities[0].fields[1].system);
        assert_eq!(blueprint.entities[0].fields[1].managed_by.as_deref(), Some("workflow"));
        assert_eq!(blueprint.workflows[0].initial_state.as_deref(), Some("pending"));
        assert_eq!(blueprint.workflows[0].transitions[0].roles, vec!["admin", "approver"]);
        assert_eq!(blueprint.navigation[0].view, "leave_requests");
    }
}
```

- [ ] **Step 2: Run the focused failing test**

Run:

```bash
cargo test --all-features app_factory::blueprint::tests::deserializes_modular_blueprint_v1_metadata
```

Expected: compile failure for missing fields/types such as `modules`, `system`, `initial_state`, `roles`, `navigation`.

- [ ] **Step 3: Implement schema structs**

In `src/app_factory/blueprint.rs`, extend `AppBlueprint` and related structs:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppBlueprint {
    pub version: u32,
    pub app: AppDefinition,
    #[serde(default)]
    pub modules: Vec<ModuleDefinition>,
    #[serde(default)]
    pub entities: Vec<EntityDefinition>,
    #[serde(default)]
    pub views: Vec<ViewDefinition>,
    #[serde(default)]
    pub workflows: Vec<WorkflowDefinition>,
    #[serde(default)]
    pub roles: Vec<RoleDefinition>,
    #[serde(default)]
    pub permissions: Vec<PermissionDefinition>,
    #[serde(default)]
    pub navigation: Vec<NavigationItemDefinition>,
    #[serde(default)]
    pub dashboards: Vec<DashboardDefinition>,
    #[serde(default)]
    pub calendars: Vec<CalendarDefinition>,
    #[serde(default)]
    pub notifications: Vec<NotificationDefinition>,
    #[serde(default)]
    pub automations: Vec<AutomationDefinition>,
    #[serde(default)]
    pub agent_commands: Vec<AgentCommandDefinition>,
}
```

Add these structs:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModuleDefinition {
    pub name: String,
    #[serde(default = "default_module_version")]
    pub version: u32,
    #[serde(default)]
    pub features: Vec<String>,
    #[serde(default)]
    pub required: bool,
}

fn default_module_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PermissionDefinition {
    pub role: String,
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub deny: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NavigationItemDefinition {
    pub label: String,
    pub view: String,
    #[serde(default)]
    pub roles: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DashboardDefinition {
    pub name: String,
    #[serde(default)]
    pub widgets: Vec<DashboardWidgetDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DashboardWidgetDefinition {
    #[serde(rename = "type")]
    pub widget_type: String,
    pub entity: String,
    pub label: String,
    #[serde(default)]
    pub filter: serde_json::Map<String, Value>,
    #[serde(default)]
    pub roles: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CalendarDefinition {
    pub name: String,
    pub entity: String,
    pub start_field: String,
    pub end_field: String,
    pub title_field: String,
    #[serde(default)]
    pub roles: Vec<String>,
}
```

Extend existing structs:

```rust
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
    #[serde(default)]
    pub system: bool,
    #[serde(default)]
    pub managed_by: Option<String>,
    #[serde(default)]
    pub editable_by: Vec<String>,
}

pub struct ViewDefinition {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub view_type: ViewType,
    pub entity: String,
    pub name: String,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub roles: Vec<String>,
}

pub struct WorkflowDefinition {
    pub entity: String,
    pub state_field: String,
    #[serde(default)]
    pub initial_state: Option<String>,
    #[serde(default)]
    pub states: Vec<String>,
    #[serde(default)]
    pub transitions: Vec<TransitionDefinition>,
}

pub struct TransitionDefinition {
    pub name: String,
    pub from: String,
    pub to: String,
    pub label: String,
    #[serde(default)]
    pub roles: Vec<String>,
}
```

- [ ] **Step 4: Verify schema test passes**

Run:

```bash
cargo test --all-features app_factory::blueprint::tests::deserializes_modular_blueprint_v1_metadata
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app_factory/blueprint.rs
git commit -m "Add modular app blueprint schema"
```

## Task 2: Blueprint v1 Validation

**Files:**
- Modify: `src/app_factory/validation.rs`

- [ ] **Step 1: Add failing validation tests**

Add tests in `src/app_factory/validation.rs`:

```rust
#[cfg(test)]
mod modular_tests {
    use super::*;
    use serde_json::json;

    fn raw_blueprint(extra: serde_json::Value) -> String {
        let mut base = json!({
            "version": 1,
            "app": {"slug": "ferie-permessi", "name": "Ferie e Permessi"},
            "modules": [
                {"name": "identity", "version": 1, "features": ["local_users", "roles"], "required": true},
                {"name": "data", "version": 1, "features": ["ownership"], "required": true},
                {"name": "workflow", "version": 1, "features": ["state_machine"], "required": true},
                {"name": "navigation", "version": 1, "features": [], "required": true}
            ],
            "entities": [{
                "name": "leave_request",
                "label": "Richiesta",
                "fields": [
                    {"name": "kind", "type": "enum", "label": "Tipo", "options": ["ferie"], "required": true},
                    {"name": "status", "type": "enum", "label": "Stato", "options": ["pending", "approved"], "default": "pending", "system": true, "managed_by": "workflow"}
                ]
            }],
            "views": [{"id": "leave_requests", "type": "table", "entity": "leave_request", "name": "Richieste", "columns": ["kind", "status"]}],
            "workflows": [{
                "entity": "leave_request",
                "state_field": "status",
                "initial_state": "pending",
                "states": ["pending", "approved"],
                "transitions": [{"name": "approve", "from": "pending", "to": "approved", "label": "Approva", "roles": ["admin", "approver"]}]
            }],
            "roles": [{"name": "admin", "label": "Admin", "permissions": ["*"]}, {"name": "employee", "label": "Dipendente", "permissions": ["leave_request:create"]}],
            "permissions": [{"role": "employee", "allow": ["leave_request:create", "leave_request:read:own"], "deny": ["leave_request:transition:*"]}],
            "navigation": [{"label": "Richieste", "view": "leave_requests", "roles": ["admin", "employee"]}]
        });
        merge_json(&mut base, extra);
        serde_json::to_string(&base).unwrap()
    }

    fn merge_json(base: &mut serde_json::Value, extra: serde_json::Value) {
        if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
            for (key, value) in extra {
                base.insert(key.clone(), value.clone());
            }
        }
    }

    #[test]
    fn accepts_supported_modular_blueprint() {
        let parsed = validate_blueprint_json(&raw_blueprint(json!({}))).unwrap();
        assert_eq!(parsed.modules.len(), 4);
    }

    #[test]
    fn rejects_unknown_required_module() {
        let err = validate_blueprint_json(&raw_blueprint(json!({
            "modules": [{"name": "payroll", "version": 1, "required": true}]
        }))).unwrap_err();
        assert!(err.errors.iter().any(|e| e.contains("Unsupported required module 'payroll'")));
    }

    #[test]
    fn rejects_workflow_initial_state_not_in_states() {
        let err = validate_blueprint_json(&raw_blueprint(json!({
            "workflows": [{"entity": "leave_request", "state_field": "status", "initial_state": "draft", "states": ["pending", "approved"], "transitions": []}]
        }))).unwrap_err();
        assert!(err.errors.iter().any(|e| e.contains("initial_state 'draft' is not listed")));
    }

    #[test]
    fn rejects_navigation_unknown_view() {
        let err = validate_blueprint_json(&raw_blueprint(json!({
            "navigation": [{"label": "Missing", "view": "missing_view", "roles": ["admin"]}]
        }))).unwrap_err();
        assert!(err.errors.iter().any(|e| e.contains("Navigation item 'Missing' references unknown view 'missing_view'")));
    }
}
```

- [ ] **Step 2: Run failing validation tests**

Run:

```bash
cargo test --all-features app_factory::validation::modular_tests
```

Expected: failures for missing validation rules.

- [ ] **Step 3: Implement validation helpers**

Add supported module validation:

```rust
const SUPPORTED_MODULES: &[&str] = &[
    "identity",
    "data",
    "workflow",
    "navigation",
    "dashboard",
    "calendar",
    "directory",
    "notifications",
    "agent_bridge",
];

fn validate_modules(blueprint: &AppBlueprint, errors: &mut Vec<String>) {
    let mut seen = HashSet::new();
    for module in &blueprint.modules {
        validate_ident("module.name", &module.name, errors);
        if !seen.insert(module.name.as_str()) {
            errors.push(format!("Duplicate module '{}'", module.name));
        }
        if module.version != 1 {
            errors.push(format!("Module '{}' version {} is not supported", module.name, module.version));
        }
        if module.required && !SUPPORTED_MODULES.contains(&module.name.as_str()) {
            errors.push(format!("Unsupported required module '{}'", module.name));
        }
    }
}
```

Add validation calls inside `validate_blueprint`:

```rust
validate_modules(blueprint, &mut errors);
```

Validate view ids and navigation after views are processed:

```rust
let mut view_refs = HashSet::new();
for view in &blueprint.views {
    view_refs.insert(view.name.as_str());
    if let Some(id) = view.id.as_deref() {
        validate_ident("view.id", id, &mut errors);
        view_refs.insert(id);
    }
}

for item in &blueprint.navigation {
    validate_len("navigation.label", &item.label, 1, 80, &mut errors);
    if !view_refs.contains(item.view.as_str()) {
        errors.push(format!(
            "Navigation item '{}' references unknown view '{}'",
            item.label, item.view
        ));
    }
}
```

Validate workflow initial state and transition roles inside workflow loop:

```rust
if let Some(initial_state) = workflow.initial_state.as_deref() {
    if !states.contains(initial_state) {
        errors.push(format!(
            "Workflow '{}.{}' initial_state '{}' is not listed in states",
            workflow.entity, workflow.state_field, initial_state
        ));
    }
}
for role in &transition.roles {
    validate_ident("transition.role", role, &mut errors);
}
```

Validate `managed_by`:

```rust
if let Some(manager) = field.managed_by.as_deref() {
    if manager != "workflow" {
        errors.push(format!(
            "Field '{}.{}' has unsupported managed_by '{}'",
            entity.name, field.name, manager
        ));
    }
}
for role in &field.editable_by {
    validate_ident("field.editable_by", role, &mut errors);
}
```

- [ ] **Step 4: Verify validation tests pass**

Run:

```bash
cargo test --all-features app_factory::validation::modular_tests
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app_factory/validation.rs
git commit -m "Validate modular app blueprint metadata"
```

## Task 3: Central Permission Engine

**Files:**
- Create: `src/app_factory/permissions.rs`
- Modify: `src/app_factory/mod.rs`

- [ ] **Step 1: Write failing permission tests**

Create `src/app_factory/permissions.rs` with tests first:

```rust
use serde_json::Value;

use super::blueprint::{AppBlueprint, FieldDefinition, TransitionDefinition};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordScope {
    All,
    Own,
    None,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn blueprint() -> AppBlueprint {
        serde_json::from_value(json!({
            "version": 1,
            "app": {"slug": "ferie-permessi", "name": "Ferie e Permessi"},
            "entities": [{"name": "leave_request", "label": "Richiesta", "fields": [
                {"name": "kind", "type": "enum", "label": "Tipo", "options": ["ferie"], "required": true},
                {"name": "status", "type": "enum", "label": "Stato", "options": ["pending", "approved"], "default": "pending", "system": true, "managed_by": "workflow"}
            ]}],
            "views": [{"type": "table", "entity": "leave_request", "name": "Richieste", "columns": ["kind", "status"]}],
            "workflows": [{"entity": "leave_request", "state_field": "status", "initial_state": "pending", "states": ["pending", "approved"], "transitions": [
                {"name": "approve", "from": "pending", "to": "approved", "label": "Approva", "roles": ["admin", "approver"]}
            ]}],
            "permissions": [
                {"role": "employee", "allow": ["leave_request:create", "leave_request:read:own"], "deny": ["leave_request:transition:*"]},
                {"role": "approver", "allow": ["leave_request:read", "leave_request:transition:approve"], "deny": []}
            ]
        })).unwrap()
    }

    #[test]
    fn admin_has_all_app_permissions() {
        assert!(can_create(&blueprint(), "admin", "leave_request"));
        assert_eq!(read_scope(&blueprint(), "admin", "leave_request"), RecordScope::All);
        assert!(can_transition(&blueprint(), "admin", "leave_request", "approve"));
    }

    #[test]
    fn employee_can_create_and_read_own_but_not_transition() {
        assert!(can_create(&blueprint(), "employee", "leave_request"));
        assert_eq!(read_scope(&blueprint(), "employee", "leave_request"), RecordScope::Own);
        assert!(!can_transition(&blueprint(), "employee", "leave_request", "approve"));
    }

    #[test]
    fn strips_system_fields_from_create_payload() {
        let sanitized = sanitize_create_input(&blueprint(), "employee", "leave_request", &json!({
            "kind": "ferie",
            "status": "approved"
        })).unwrap();

        assert_eq!(sanitized["kind"], "ferie");
        assert!(sanitized.get("status").is_none());
    }
}
```

- [ ] **Step 2: Expose module and run failing tests**

Add to `src/app_factory/mod.rs`:

```rust
pub mod permissions;
```

Run:

```bash
cargo test --all-features app_factory::permissions::tests
```

Expected: compile failures for undefined functions.

- [ ] **Step 3: Implement permission functions**

Implement in `src/app_factory/permissions.rs`:

```rust
use anyhow::{anyhow, Result};
use serde_json::{Map, Value};

use super::blueprint::{AppBlueprint, FieldDefinition, TransitionDefinition};
use super::runtime;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordScope {
    All,
    Own,
    None,
}

pub fn can_create(blueprint: &AppBlueprint, role: &str, entity: &str) -> bool {
    role == "admin" || is_allowed(blueprint, role, &format!("{entity}:create"))
}

pub fn read_scope(blueprint: &AppBlueprint, role: &str, entity: &str) -> RecordScope {
    if role == "admin" || is_allowed(blueprint, role, &format!("{entity}:read")) {
        return RecordScope::All;
    }
    if is_allowed(blueprint, role, &format!("{entity}:read:own")) {
        return RecordScope::Own;
    }
    RecordScope::None
}

pub fn can_transition(blueprint: &AppBlueprint, role: &str, entity: &str, action: &str) -> bool {
    if role == "admin" {
        return true;
    }
    let workflow_transition_allows = blueprint
        .workflows
        .iter()
        .find(|workflow| workflow.entity == entity)
        .and_then(|workflow| workflow.transitions.iter().find(|transition| transition.name == action))
        .map(|transition| transition.roles.is_empty() || transition.roles.iter().any(|allowed| allowed == role))
        .unwrap_or(false);
    workflow_transition_allows && is_allowed(blueprint, role, &format!("{entity}:transition:{action}"))
}

pub fn sanitize_create_input(
    blueprint: &AppBlueprint,
    role: &str,
    entity_name: &str,
    data: &Value,
) -> Result<Value> {
    let entity = runtime::entity(blueprint, entity_name)?;
    let input = data
        .as_object()
        .ok_or_else(|| anyhow!("Record data must be a JSON object"))?;
    let mut out = Map::new();
    for field in &entity.fields {
        if let Some(value) = input.get(&field.name) {
            if can_write_field(role, field) {
                out.insert(field.name.clone(), value.clone());
            }
        }
    }
    Ok(Value::Object(out))
}

pub fn can_write_field(role: &str, field: &FieldDefinition) -> bool {
    if role == "admin" && field.managed_by.as_deref() != Some("workflow") {
        return true;
    }
    if field.system || field.managed_by.is_some() {
        return field.editable_by.iter().any(|allowed| allowed == role);
    }
    field.editable_by.is_empty() || field.editable_by.iter().any(|allowed| allowed == role)
}

fn is_allowed(blueprint: &AppBlueprint, role: &str, permission: &str) -> bool {
    let Some(policy) = blueprint.permissions.iter().find(|policy| policy.role == role) else {
        return false;
    };
    if policy.deny.iter().any(|pattern| matches_permission(pattern, permission)) {
        return false;
    }
    policy.allow.iter().any(|pattern| matches_permission(pattern, permission))
}

fn matches_permission(pattern: &str, permission: &str) -> bool {
    pattern == "*" || pattern == permission || pattern.strip_suffix(":*").is_some_and(|prefix| permission.starts_with(prefix))
}
```

- [ ] **Step 4: Verify permission tests pass**

Run:

```bash
cargo test --all-features app_factory::permissions::tests
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app_factory/mod.rs src/app_factory/permissions.rs
git commit -m "Add app blueprint permission engine"
```

## Task 4: Server-Side Enforcement For External Apps

**Files:**
- Modify: `src/app_factory/runtime.rs`
- Modify: `src/web/api/external_apps.rs`

- [ ] **Step 1: Add runtime test for system field sanitization plus initial state**

Add to `src/app_factory/runtime.rs` tests:

```rust
#[test]
fn create_validation_applies_workflow_initial_state_after_sanitized_input() {
    let blueprint = leave_blueprint();
    let sanitized = crate::app_factory::permissions::sanitize_create_input(
        &blueprint,
        "employee",
        "leave_request",
        &json!({"kind": "ferie", "status": "approved"})
    ).unwrap();

    let data = validate_record_data(&blueprint, "leave_request", &sanitized).unwrap();

    assert_eq!(data["kind"], "ferie");
    assert_eq!(data["status"], "pending");
}
```

Update `leave_blueprint()` in the same test module so `status` has `"system": true`, `"managed_by": "workflow"` and workflow has `"initial_state": "pending"`.

- [ ] **Step 2: Run failing runtime test**

Run:

```bash
cargo test --all-features app_factory::runtime::tests::create_validation_applies_workflow_initial_state_after_sanitized_input
```

Expected: FAIL if initial state is not applied after sanitization.

- [ ] **Step 3: Apply workflow initial state in validation**

In `validate_record_data`, before returning `Value::Object(out)`, add:

```rust
apply_initial_workflow_state(blueprint, entity_name, &mut out)?;
```

Add helper:

```rust
fn apply_initial_workflow_state(
    blueprint: &AppBlueprint,
    entity_name: &str,
    out: &mut Map<String, Value>,
) -> Result<()> {
    for workflow in blueprint.workflows.iter().filter(|workflow| workflow.entity == entity_name) {
        if let Some(initial_state) = workflow.initial_state.as_deref() {
            out.insert(workflow.state_field.clone(), Value::String(initial_state.to_string()));
        }
    }
    Ok(())
}
```

- [ ] **Step 4: Replace hardcoded external API role checks**

In `src/web/api/external_apps.rs`:

Use:

```rust
use crate::app_factory::permissions::{self, RecordScope};
```

In `list_records`, replace employee-only filtering with:

```rust
let rows = match permissions::read_scope(&blueprint, &user.role, &entity_name) {
    RecordScope::All => rows,
    RecordScope::Own => {
        let app_user_id = user.app_user_id.to_string();
        rows.into_iter()
            .filter(|row| row.created_by_user_id.as_deref() == Some(app_user_id.as_str()))
            .collect()
    }
    RecordScope::None => {
        app_pool.close().await;
        return Err(forbidden("This role cannot read records"));
    }
};
```

In `create_record`, replace `external_auth::can_create_record` with:

```rust
external_auth::ensure_role(
    permissions::can_create(&blueprint, &user.role, &entity_name),
    "This role cannot create records",
)
.map_err(forbidden)?;
let sanitized = permissions::sanitize_create_input(&blueprint, &user.role, &entity_name, &body.data)
    .map_err(bad_request)?;
let data = runtime::validate_record_data(&blueprint, &entity_name, &sanitized).map_err(bad_request)?;
```

In `run_action`, replace `external_auth::can_run_action` with:

```rust
external_auth::ensure_role(
    permissions::can_transition(&blueprint, &user.role, &entity_name, &action),
    "This role cannot run this action",
)
.map_err(forbidden)?;
```

- [ ] **Step 5: Verify Rust tests**

Run:

```bash
cargo test --all-features app_factory::runtime::tests app_factory::permissions::tests
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app_factory/runtime.rs src/web/api/external_apps.rs
git commit -m "Enforce modular app permissions server side"
```

## Task 5: Runtime UI Becomes Module-Aware

**Files:**
- Modify: `static/js/external-app.js`

- [ ] **Step 1: Add JS syntax guard**

Run before editing:

```bash
node --check static/js/external-app.js
```

Expected: no output and exit code 0.

- [ ] **Step 2: Add helpers for role, navigation and fields**

Add near existing helper functions:

```javascript
function role() {
    return state.app && state.app.user ? state.app.user.role : '';
}

function roleAllowed(roles) {
    return role() === 'admin' || !roles || !roles.length || roles.indexOf(role()) !== -1;
}

function viewRef(view) {
    return view.id || view.name;
}

function fieldWritable(field) {
    if (role() === 'admin' && field.managed_by !== 'workflow') return true;
    if (field.system || field.managed_by) {
        return (field.editable_by || []).indexOf(role()) !== -1;
    }
    return !(field.editable_by || []).length || field.editable_by.indexOf(role()) !== -1;
}

function formFields(entity, workflow) {
    return (entity.fields || []).filter(function (field) {
        if (workflow && field.name === workflow.state_field) return false;
        if (field.system || field.managed_by) return false;
        return fieldWritable(field);
    });
}
```

- [ ] **Step 3: Replace `visibleViews` with navigation-aware logic**

Replace the body of `visibleViews()`:

```javascript
function visibleViews() {
    var views = state.app.blueprint.views || [];
    var navigation = state.app.blueprint.navigation || [];
    if (navigation.length) {
        return navigation
            .filter(function (item) { return roleAllowed(item.roles); })
            .map(function (item) {
                return views.find(function (view) { return viewRef(view) === item.view || view.name === item.view; });
            })
            .filter(Boolean);
    }
    return views.filter(function (view) { return roleAllowed(view.roles); });
}
```

- [ ] **Step 4: Hide system fields in forms**

In `renderForm`, replace:

```javascript
(entity.fields || []).forEach(function (field) {
```

with:

```javascript
formFields(entity, workflow).forEach(function (field) {
```

- [ ] **Step 5: Filter workflow buttons by transition roles**

In `renderActions`, before creating each button add:

```javascript
if (!roleAllowed(transition.roles)) return;
```

- [ ] **Step 6: Verify JS syntax**

Run:

```bash
node --check static/js/external-app.js
```

Expected: no output and exit code 0.

- [ ] **Step 7: Commit**

```bash
git add static/js/external-app.js
git commit -m "Make external app runtime module aware"
```

## Task 6: Demo Blueprints And Skill Guidance

**Files:**
- Modify: `docs/demo/blueprints/ferie-permessi.json`
- Create: `docs/demo/blueprints/ticket-interni.json`
- Modify: `docs/demo/app-factory-runbook.md`
- Modify: `docs/specs/APP-FACTORY-BLUEPRINT-V0.md`

- [ ] **Step 1: Update ferie/permessi blueprint**

Add these root sections to `docs/demo/blueprints/ferie-permessi.json`:

```json
"modules": [
  {"name": "identity", "version": 1, "features": ["local_users", "roles", "ownership"], "required": true},
  {"name": "data", "version": 1, "features": ["relations", "ownership"], "required": true},
  {"name": "workflow", "version": 1, "features": ["state_machine", "approval_actions"], "required": true},
  {"name": "navigation", "version": 1, "features": [], "required": true},
  {"name": "dashboard", "version": 1, "features": ["counts"], "required": false},
  {"name": "calendar", "version": 1, "features": ["date_range"], "required": false},
  {"name": "notifications", "version": 1, "features": ["homun_channels"], "required": false}
]
```

Mark `status`:

```json
{
  "name": "status",
  "type": "enum",
  "label": "Stato",
  "options": ["pending", "approved", "rejected"],
  "default": "pending",
  "system": true,
  "managed_by": "workflow",
  "editable_by": []
}
```

Add workflow `initial_state` and transition roles:

```json
"initial_state": "pending",
"transitions": [
  {"name": "approve", "from": "pending", "to": "approved", "label": "Approva", "roles": ["admin", "approver"]},
  {"name": "reject", "from": "pending", "to": "rejected", "label": "Rifiuta", "roles": ["admin", "approver"]}
]
```

Add:

```json
"permissions": [
  {"role": "employee", "allow": ["leave_request:create", "leave_request:read:own"], "deny": ["leave_request:update:status", "leave_request:transition:*"]},
  {"role": "approver", "allow": ["leave_request:read", "leave_request:transition:approve", "leave_request:transition:reject"], "deny": []},
  {"role": "admin", "allow": ["*"], "deny": []}
],
"navigation": [
  {"label": "Richieste", "view": "Richieste", "roles": ["admin", "approver", "employee"]},
  {"label": "Nuova richiesta", "view": "Nuova richiesta", "roles": ["admin", "employee"]}
]
```

- [ ] **Step 2: Create ticket interni blueprint**

Create `docs/demo/blueprints/ticket-interni.json` with one `ticket` entity:

```json
{
  "version": 1,
  "app": {"slug": "ticket-interni", "name": "Ticket Interni", "description": "Gestione richieste operative interne", "icon": "ticket"},
  "modules": [
    {"name": "identity", "version": 1, "features": ["local_users", "roles", "ownership"], "required": true},
    {"name": "data", "version": 1, "features": ["ownership"], "required": true},
    {"name": "workflow", "version": 1, "features": ["state_machine"], "required": true},
    {"name": "navigation", "version": 1, "features": [], "required": true},
    {"name": "dashboard", "version": 1, "features": ["counts"], "required": false}
  ],
  "entities": [{
    "name": "ticket",
    "label": "Ticket",
    "fields": [
      {"name": "title", "type": "string", "label": "Titolo", "required": true},
      {"name": "description", "type": "text", "label": "Descrizione", "required": true},
      {"name": "priority", "type": "enum", "label": "Priorita", "options": ["low", "normal", "high"], "default": "normal"},
      {"name": "status", "type": "enum", "label": "Stato", "options": ["open", "in_progress", "closed"], "default": "open", "system": true, "managed_by": "workflow", "editable_by": []}
    ]
  }],
  "views": [
    {"type": "table", "entity": "ticket", "name": "Ticket", "columns": ["title", "priority", "status"]},
    {"type": "form", "entity": "ticket", "name": "Nuovo ticket"},
    {"type": "detail", "entity": "ticket", "name": "Dettaglio ticket"}
  ],
  "workflows": [{
    "entity": "ticket",
    "state_field": "status",
    "initial_state": "open",
    "states": ["open", "in_progress", "closed"],
    "transitions": [
      {"name": "start", "from": "open", "to": "in_progress", "label": "Prendi in carico", "roles": ["admin", "support"]},
      {"name": "close", "from": "in_progress", "to": "closed", "label": "Chiudi", "roles": ["admin", "support"]}
    ]
  }],
  "roles": [
    {"name": "admin", "label": "Admin", "permissions": ["*"]},
    {"name": "support", "label": "Supporto", "permissions": ["ticket:read", "ticket:transition:start", "ticket:transition:close"]},
    {"name": "employee", "label": "Dipendente", "permissions": ["ticket:create", "ticket:read:own"]}
  ],
  "permissions": [
    {"role": "employee", "allow": ["ticket:create", "ticket:read:own"], "deny": ["ticket:transition:*"]},
    {"role": "support", "allow": ["ticket:read", "ticket:transition:start", "ticket:transition:close"], "deny": []},
    {"role": "admin", "allow": ["*"], "deny": []}
  ],
  "navigation": [
    {"label": "Ticket", "view": "Ticket", "roles": ["admin", "support", "employee"]},
    {"label": "Nuovo ticket", "view": "Nuovo ticket", "roles": ["admin", "employee"]}
  ],
  "dashboards": [{"name": "overview", "widgets": [{"type": "count", "entity": "ticket", "label": "Ticket aperti", "filter": {"status": "open"}, "roles": ["admin", "support"]}]}],
  "agent_commands": [{"intent": "create_ticket", "entity": "ticket", "action": "create", "examples": ["Apri un ticket per sistemare la stampante"]}]
}
```

- [ ] **Step 3: Validate demo blueprints through existing tool path**

Run:

```bash
cargo test --all-features app_factory::validation
```

Expected: PASS.

- [ ] **Step 4: Update docs**

Append to `docs/demo/app-factory-runbook.md`:

```markdown
## Modular Blueprint v1 Demo Checks

Use `ferie-permessi` to show identity + workflow + calendar:

1. Login as employee.
2. Create a leave request.
3. Confirm the form does not expose `status`.
4. Confirm the created record starts as `pending`.
5. Login as approver.
6. Approve or reject the pending request.
7. Login as admin.
8. Confirm all records and actions are visible.

Use `ticket-interni` to show the same modules applied to a different domain.
```

Add a v1 addendum to `docs/specs/APP-FACTORY-BLUEPRINT-V0.md` pointing to:

```markdown
See `docs/superpowers/specs/2026-04-30-modular-app-factory-blueprint-v1-design.md` for the modular Blueprint v1 direction.
```

- [ ] **Step 5: Commit**

```bash
git add docs/demo/blueprints/ferie-permessi.json docs/demo/blueprints/ticket-interni.json docs/demo/app-factory-runbook.md docs/specs/APP-FACTORY-BLUEPRINT-V0.md
git commit -m "Add modular app factory demo blueprints"
```

## Task 7: Full Verification

**Files:**
- No code changes unless verification finds defects.

- [ ] **Step 1: Run JS syntax check**

```bash
node --check static/js/external-app.js
```

Expected: no output and exit code 0.

- [ ] **Step 2: Run focused Rust tests**

```bash
cargo test --all-features app_factory::
```

Expected: all app factory tests pass.

- [ ] **Step 3: Run full check**

```bash
cargo check --all-features
```

Expected: `Finished` with exit code 0.

- [ ] **Step 4: Manual smoke test with running gateway**

Start or restart Homun release build, then open:

```text
https://localhost:18443/a/ferie-permessi/login
```

Expected:

- employee login can create a request;
- form does not show `status`;
- created request starts as `pending`;
- employee does not see approve/reject;
- approver sees approve/reject for pending requests;
- admin can see all records.

- [ ] **Step 5: Commit any verification fixes**

If fixes were needed:

```bash
git add <changed-files>
git commit -m "Fix modular app factory verification issues"
```

If no fixes were needed, do not create an empty commit.

## Execution Notes

- Keep commits exactly task-sized.
- Do not broaden into custom code generation.
- Server-side authorization is mandatory; client filtering is presentation only.
- Backward compatibility matters: existing v0 blueprints without `modules`, `permissions`, `navigation`, `dashboards` or `calendars` must still deserialize and run.
- If time gets tight for the demo, ship Tasks 1-5 first. Task 6 improves the story, but Tasks 1-5 fix the dangerous behavior.
