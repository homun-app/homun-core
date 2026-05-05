use std::collections::{HashMap, HashSet};

use super::blueprint::{AppBlueprint, FieldDefinition, FieldType, ViewType};

const MAX_BLUEPRINT_BYTES: usize = 128 * 1024;
const MAX_ENTITIES: usize = 12;
const MAX_FIELDS_PER_ENTITY: usize = 40;
const MAX_VIEWS: usize = 20;
const MAX_TRANSITIONS: usize = 20;
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
        errors.push(format!(
            "Blueprint cannot define more than {MAX_ENTITIES} entities"
        ));
    }
    if blueprint.views.is_empty() {
        errors.push("Blueprint must define at least one view".to_string());
    }
    if blueprint.views.len() > MAX_VIEWS {
        errors.push(format!(
            "Blueprint cannot define more than {MAX_VIEWS} views"
        ));
    }
    validate_modules(blueprint, &mut errors);

    let mut entity_names = HashSet::new();
    let mut field_map: HashMap<&str, HashMap<&str, &FieldDefinition>> = HashMap::new();

    for entity in &blueprint.entities {
        validate_ident("entity.name", &entity.name, &mut errors);
        validate_len("entity.label", &entity.label, 1, 80, &mut errors);
        if !entity_names.insert(entity.name.as_str()) {
            errors.push(format!("Duplicate entity '{}'", entity.name));
        }
        if entity.fields.is_empty() {
            errors.push(format!(
                "Entity '{}' must define at least one field",
                entity.name
            ));
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

            match field.field_type {
                FieldType::Enum => {
                    if field.options.is_empty() || field.options.len() > 32 {
                        errors.push(format!(
                            "Enum field '{}.{}' must define 1-32 options",
                            entity.name, field.name
                        ));
                    }
                    validate_unique_options(&entity.name, &field.name, &field.options, &mut errors);
                }
                FieldType::Relation if field.to.as_deref().unwrap_or("").trim().is_empty() => {
                    errors.push(format!(
                        "Relation field '{}.{}' must define target entity",
                        entity.name, field.name
                    ));
                }
                _ => {}
            }
            fields.insert(field.name.as_str(), field);
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

    let mut view_refs = HashSet::new();
    for view in &blueprint.views {
        if !entity_names.contains(view.entity.as_str()) {
            errors.push(format!(
                "View '{}' references unknown entity '{}'",
                view.name, view.entity
            ));
            continue;
        }
        view_refs.insert(view.name.clone());
        if let Some(id) = view.id.as_deref() {
            validate_ident("view.id", id, &mut errors);
            view_refs.insert(id.to_string());
        }
        validate_len("view.name", &view.name, 1, 80, &mut errors);
        if view.view_type == ViewType::Table && view.columns.is_empty() {
            errors.push(format!("Table view '{}' must define columns", view.name));
        }
        if view.view_type == ViewType::Kanban
            && !blueprint
                .workflows
                .iter()
                .any(|workflow| workflow.entity == view.entity && !workflow.states.is_empty())
        {
            errors.push(format!(
                "Kanban view '{}' requires a workflow with states for entity '{}'",
                view.name, view.entity
            ));
        }
        if view.view_type == ViewType::Calendar {
            let Some(fields) = field_map.get(view.entity.as_str()) else {
                continue;
            };
            let has_date_field = fields
                .values()
                .any(|field| field.field_type == FieldType::Date);
            if !has_date_field {
                errors.push(format!(
                    "Calendar view '{}' requires at least one date field on entity '{}'",
                    view.name, view.entity
                ));
            }
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
        for role in &view.roles {
            validate_ident("view.role", role, &mut errors);
        }
    }

    for item in &blueprint.navigation {
        validate_len("navigation.label", &item.label, 1, 80, &mut errors);
        if !view_refs.contains(&item.view) {
            errors.push(format!(
                "Navigation item '{}' references unknown view '{}'",
                item.label, item.view
            ));
        }
        for role in &item.roles {
            validate_ident("navigation.role", role, &mut errors);
        }
    }

    for workflow in &blueprint.workflows {
        if !entity_names.contains(workflow.entity.as_str()) {
            errors.push(format!(
                "Workflow references unknown entity '{}'",
                workflow.entity
            ));
            continue;
        }
        let Some(fields) = field_map.get(workflow.entity.as_str()) else {
            continue;
        };
        let state_field = fields.get(workflow.state_field.as_str());
        match state_field {
            Some(field) if field.field_type == FieldType::Enum => {
                validate_workflow_states_match_enum(workflow, &field.options, &mut errors);
            }
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
            errors.push(format!(
                "Workflow cannot define more than {MAX_TRANSITIONS} transitions"
            ));
        }
        let states: HashSet<&str> = workflow.states.iter().map(String::as_str).collect();
        if let Some(initial_state) = workflow.initial_state.as_deref() {
            if !states.contains(initial_state) {
                errors.push(format!(
                    "Workflow '{}.{}' initial_state '{}' is not listed in states",
                    workflow.entity, workflow.state_field, initial_state
                ));
            }
        }
        for transition in &workflow.transitions {
            validate_ident("transition.name", &transition.name, &mut errors);
            validate_len("transition.label", &transition.label, 1, 80, &mut errors);
            if !states.contains(transition.from.as_str()) {
                errors.push(format!(
                    "Transition '{}' has unknown from state '{}'",
                    transition.name, transition.from
                ));
            }
            if !states.contains(transition.to.as_str()) {
                errors.push(format!(
                    "Transition '{}' has unknown to state '{}'",
                    transition.name, transition.to
                ));
            }
            for role in &transition.roles {
                validate_ident("transition.role", role, &mut errors);
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(ValidationReport { errors })
    }
}

fn validate_workflow_states_match_enum(
    workflow: &super::blueprint::WorkflowDefinition,
    options: &[String],
    errors: &mut Vec<String>,
) {
    let workflow_states: HashSet<&str> = workflow.states.iter().map(String::as_str).collect();
    let enum_options: HashSet<&str> = options.iter().map(String::as_str).collect();

    if workflow_states != enum_options {
        errors.push(format!(
            "Workflow states for '{}.{}' must match enum options",
            workflow.entity, workflow.state_field
        ));
    }
}

fn validate_modules(blueprint: &AppBlueprint, errors: &mut Vec<String>) {
    let mut seen = HashSet::new();
    for module in &blueprint.modules {
        validate_ident("module.name", &module.name, errors);
        if !seen.insert(module.name.as_str()) {
            errors.push(format!("Duplicate module '{}'", module.name));
        }
        if module.version != 1 {
            errors.push(format!(
                "Module '{}' version {} is not supported",
                module.name, module.version
            ));
        }
        if module.required && !SUPPORTED_MODULES.contains(&module.name.as_str()) {
            errors.push(format!("Unsupported required module '{}'", module.name));
        }
        for feature in &module.features {
            validate_ident("module.feature", feature, errors);
        }
    }
}

fn validate_unique_options(
    entity_name: &str,
    field_name: &str,
    options: &[String],
    errors: &mut Vec<String>,
) {
    let mut seen = HashSet::new();
    for option in options {
        validate_ident("field.option", option, errors);
        if !seen.insert(option.as_str()) {
            errors.push(format!(
                "Enum field '{}.{}' has duplicate option '{}'",
                entity_name, field_name, option
            ));
        }
    }
}

fn validate_slug(field: &str, value: &str, errors: &mut Vec<String>) {
    if value.is_empty() || value.len() > 64 {
        errors.push(format!("{field} must be 1-64 characters"));
        return;
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        errors.push(format!(
            "{field} must contain only lowercase letters, numbers, and hyphens"
        ));
    }
}

fn validate_ident(field: &str, value: &str, errors: &mut Vec<String>) {
    if value.is_empty() || value.len() > 64 {
        errors.push(format!("{field} must be 1-64 characters"));
        return;
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
        errors.push(format!(
            "{field} must contain only lowercase letters, numbers, and underscores"
        ));
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
    use crate::app_factory::blueprint::AppBlueprint;

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

        assert!(report
            .errors
            .iter()
            .any(|e| e.contains("unknown entity 'missing'")));
    }

    #[test]
    fn rejects_view_unknown_field() {
        let mut bp = valid_leave_blueprint();
        bp.views[0].columns.push("missing".to_string());

        let report = validate_blueprint(&bp).unwrap_err();

        assert!(report
            .errors
            .iter()
            .any(|e| e.contains("unknown field 'leave_request.missing'")));
    }

    #[test]
    fn rejects_workflow_on_non_enum_state() {
        let mut bp = valid_leave_blueprint();
        bp.workflows[0].state_field = "employee".to_string();

        let report = validate_blueprint(&bp).unwrap_err();

        assert!(report.errors.iter().any(|e| e.contains("must be enum")));
    }

    #[test]
    fn rejects_workflow_states_that_do_not_match_enum_options() {
        let mut bp = valid_leave_blueprint();
        bp.workflows[0].states.push("archived".to_string());

        let report = validate_blueprint(&bp).unwrap_err();

        assert!(report
            .errors
            .iter()
            .any(|e| e.contains("must match enum options")));
    }

    #[test]
    fn accepts_kanban_view_when_entity_has_workflow() {
        let mut bp = valid_leave_blueprint();
        bp.views.push(
            serde_json::from_value(serde_json::json!({
                "id": "leave_board",
                "type": "kanban",
                "entity": "leave_request",
                "name": "Board",
                "columns": ["employee", "status"]
            }))
            .unwrap(),
        );

        assert!(validate_blueprint(&bp).is_ok());
    }

    #[test]
    fn rejects_kanban_view_without_workflow() {
        let mut bp = valid_leave_blueprint();
        bp.workflows.clear();
        bp.views.push(
            serde_json::from_value(serde_json::json!({
                "id": "leave_board",
                "type": "kanban",
                "entity": "leave_request",
                "name": "Board",
                "columns": ["employee", "status"]
            }))
            .unwrap(),
        );

        let report = validate_blueprint(&bp).unwrap_err();

        assert!(report
            .errors
            .iter()
            .any(|e| e.contains("Kanban view 'Board' requires a workflow")));
    }

    #[test]
    fn accepts_calendar_view_when_entity_has_date_field() {
        let mut bp = valid_leave_blueprint();
        bp.entities[1].fields.push(
            serde_json::from_value(serde_json::json!({
                "name": "start_date",
                "type": "date",
                "label": "Data inizio"
            }))
            .unwrap(),
        );
        bp.views.push(
            serde_json::from_value(serde_json::json!({
                "id": "leave_calendar",
                "type": "calendar",
                "entity": "leave_request",
                "name": "Calendario",
                "columns": ["employee", "start_date", "status"]
            }))
            .unwrap(),
        );

        assert!(validate_blueprint(&bp).is_ok());
    }

    #[test]
    fn rejects_calendar_view_without_date_field() {
        let mut bp = valid_leave_blueprint();
        bp.views.push(
            serde_json::from_value(serde_json::json!({
                "id": "leave_calendar",
                "type": "calendar",
                "entity": "leave_request",
                "name": "Calendario",
                "columns": ["employee", "status"]
            }))
            .unwrap(),
        );

        let report = validate_blueprint(&bp).unwrap_err();

        assert!(report
            .errors
            .iter()
            .any(|e| e.contains("Calendar view 'Calendario' requires at least one date field")));
    }
}

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
        })))
        .unwrap_err();
        assert!(err
            .errors
            .iter()
            .any(|e| e.contains("Unsupported required module 'payroll'")));
    }

    #[test]
    fn rejects_workflow_initial_state_not_in_states() {
        let err = validate_blueprint_json(&raw_blueprint(json!({
            "workflows": [{"entity": "leave_request", "state_field": "status", "initial_state": "draft", "states": ["pending", "approved"], "transitions": []}]
        })))
        .unwrap_err();
        assert!(err
            .errors
            .iter()
            .any(|e| e.contains("initial_state 'draft' is not listed")));
    }

    #[test]
    fn rejects_navigation_unknown_view() {
        let err = validate_blueprint_json(&raw_blueprint(json!({
            "navigation": [{"label": "Missing", "view": "missing_view", "roles": ["admin"]}]
        })))
        .unwrap_err();
        assert!(err.errors.iter().any(|e| {
            e.contains("Navigation item 'Missing' references unknown view 'missing_view'")
        }));
    }
}
