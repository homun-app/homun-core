use anyhow::{anyhow, Result};
use serde_json::{Map, Value};

use super::blueprint::{AppBlueprint, FieldDefinition};
use super::runtime;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordScope {
    All,
    Own,
    None,
}

pub fn can_create(blueprint: &AppBlueprint, role: &str, entity: &str) -> bool {
    if blueprint.permissions.is_empty() {
        return matches!(role, "admin" | "approver" | "employee");
    }
    role == "admin" || is_allowed(blueprint, role, &format!("{entity}:create"))
}

pub fn read_scope(blueprint: &AppBlueprint, role: &str, entity: &str) -> RecordScope {
    if blueprint.permissions.is_empty() {
        return if role == "employee" {
            RecordScope::Own
        } else {
            RecordScope::All
        };
    }
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
    if blueprint.permissions.is_empty() {
        return role == "approver" && matches!(action, "approve" | "reject");
    }

    let workflow_transition_allows = blueprint
        .workflows
        .iter()
        .find(|workflow| workflow.entity == entity)
        .and_then(|workflow| {
            workflow
                .transitions
                .iter()
                .find(|transition| transition.name == action)
        })
        .map(|transition| {
            transition.roles.is_empty() || transition.roles.iter().any(|allowed| allowed == role)
        })
        .unwrap_or(false);

    workflow_transition_allows
        && is_allowed(blueprint, role, &format!("{entity}:transition:{action}"))
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
    let Some(policy) = blueprint
        .permissions
        .iter()
        .find(|policy| policy.role == role)
    else {
        return false;
    };
    if policy
        .deny
        .iter()
        .any(|pattern| matches_permission(pattern, permission))
    {
        return false;
    }
    policy
        .allow
        .iter()
        .any(|pattern| matches_permission(pattern, permission))
}

fn matches_permission(pattern: &str, permission: &str) -> bool {
    pattern == "*"
        || pattern == permission
        || pattern
            .strip_suffix(":*")
            .is_some_and(|prefix| permission.starts_with(prefix))
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
        }))
        .unwrap()
    }

    #[test]
    fn admin_has_all_app_permissions() {
        assert!(can_create(&blueprint(), "admin", "leave_request"));
        assert_eq!(
            read_scope(&blueprint(), "admin", "leave_request"),
            RecordScope::All
        );
        assert!(can_transition(
            &blueprint(),
            "admin",
            "leave_request",
            "approve"
        ));
    }

    #[test]
    fn employee_can_create_and_read_own_but_not_transition() {
        assert!(can_create(&blueprint(), "employee", "leave_request"));
        assert_eq!(
            read_scope(&blueprint(), "employee", "leave_request"),
            RecordScope::Own
        );
        assert!(!can_transition(
            &blueprint(),
            "employee",
            "leave_request",
            "approve"
        ));
    }

    #[test]
    fn strips_system_fields_from_create_payload() {
        let sanitized = sanitize_create_input(
            &blueprint(),
            "employee",
            "leave_request",
            &json!({
                "kind": "ferie",
                "status": "approved"
            }),
        )
        .unwrap();

        assert_eq!(sanitized["kind"], "ferie");
        assert!(sanitized.get("status").is_none());
    }
}
