use std::collections::{HashMap, HashSet};

use super::blueprint::{AppBlueprint, FieldDefinition, FieldType, ViewType};

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

    for view in &blueprint.views {
        if !entity_names.contains(view.entity.as_str()) {
            errors.push(format!(
                "View '{}' references unknown entity '{}'",
                view.name, view.entity
            ));
            continue;
        }
        validate_len("view.name", &view.name, 1, 80, &mut errors);
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
}
