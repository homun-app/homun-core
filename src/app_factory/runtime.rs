use anyhow::{anyhow, bail, Result};
use serde_json::{Map, Value};

use super::blueprint::{AppBlueprint, EntityDefinition, FieldDefinition, FieldType};

pub fn entity<'a>(blueprint: &'a AppBlueprint, name: &str) -> Result<&'a EntityDefinition> {
    blueprint
        .entities
        .iter()
        .find(|entity| entity.name == name)
        .ok_or_else(|| anyhow!("Unknown entity '{name}'"))
}

pub fn validate_record_data(
    blueprint: &AppBlueprint,
    entity_name: &str,
    data: &Value,
) -> Result<Value> {
    let entity = entity(blueprint, entity_name)?;
    let input = data
        .as_object()
        .ok_or_else(|| anyhow!("Record data must be a JSON object"))?;
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
            if !field.options.iter().any(|option| option == raw) {
                bail!("Field '{}' has unsupported option '{}'", field.name, raw);
            }
        }
        FieldType::Relation => {
            if !(value.is_number() || value.is_string()) {
                bail!(
                    "Field '{}' relation must be record id or string label",
                    field.name
                );
            }
        }
    }

    Ok(())
}

pub fn apply_transition(
    blueprint: &AppBlueprint,
    entity_name: &str,
    record_data: &mut Value,
    action: &str,
) -> Result<String> {
    let workflow = blueprint
        .workflows
        .iter()
        .find(|workflow| workflow.entity == entity_name)
        .ok_or_else(|| anyhow!("Entity '{entity_name}' has no workflow"))?;
    let transition = workflow
        .transitions
        .iter()
        .find(|transition| transition.name == action)
        .ok_or_else(|| anyhow!("Unknown action '{action}'"))?;
    let object = record_data
        .as_object_mut()
        .ok_or_else(|| anyhow!("Record data must be object"))?;
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

    object.insert(
        workflow.state_field.clone(),
        Value::String(transition.to.clone()),
    );
    Ok(format!("{entity_name}.{}", transition.to))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_factory::blueprint::AppBlueprint;
    use serde_json::json;

    fn leave_blueprint() -> AppBlueprint {
        serde_json::from_value(json!({
            "version": 1,
            "app": {"slug": "ferie-permessi", "name": "Ferie e Permessi"},
            "entities": [
                {"name": "leave_request", "label": "Richiesta", "fields": [
                    {"name": "kind", "type": "enum", "label": "Tipo", "required": true, "options": ["ferie", "permesso"]},
                    {"name": "status", "type": "enum", "label": "Stato", "options": ["pending", "approved", "rejected"], "default": "pending"},
                    {"name": "days", "type": "number", "label": "Giorni"},
                    {"name": "notes", "type": "text", "label": "Note"}
                ]}
            ],
            "views": [
                {"type": "table", "entity": "leave_request", "name": "Richieste", "columns": ["kind", "status"]}
            ],
            "workflows": [
                {"entity": "leave_request", "state_field": "status", "states": ["pending", "approved", "rejected"], "transitions": [
                    {"name": "approve", "from": "pending", "to": "approved", "label": "Approva"},
                    {"name": "reject", "from": "pending", "to": "rejected", "label": "Rifiuta"}
                ]}
            ]
        }))
        .unwrap()
    }

    #[test]
    fn validates_leave_request_and_applies_defaults() {
        let data = validate_record_data(
            &leave_blueprint(),
            "leave_request",
            &json!({"kind": "ferie", "days": 3, "notes": "Agosto"}),
        )
        .unwrap();

        assert_eq!(data["kind"], "ferie");
        assert_eq!(data["days"], 3);
        assert_eq!(data["notes"], "Agosto");
        assert_eq!(data["status"], "pending");
    }

    #[test]
    fn rejects_missing_required_kind() {
        let err = validate_record_data(&leave_blueprint(), "leave_request", &json!({"days": 1}))
            .unwrap_err();

        assert!(err.to_string().contains("Missing required field 'kind'"));
    }

    #[test]
    fn applies_approve_transition_from_pending_to_approved() {
        let mut record = json!({"kind": "ferie", "status": "pending"});

        let event =
            apply_transition(&leave_blueprint(), "leave_request", &mut record, "approve").unwrap();

        assert_eq!(record["status"], "approved");
        assert_eq!(event, "leave_request.approved");
    }

    #[test]
    fn rejects_approve_when_current_state_is_rejected() {
        let mut record = json!({"kind": "ferie", "status": "rejected"});

        let err = apply_transition(&leave_blueprint(), "leave_request", &mut record, "approve")
            .unwrap_err();

        assert!(err
            .to_string()
            .contains("requires state 'pending' but record is 'rejected'"));
    }
}
