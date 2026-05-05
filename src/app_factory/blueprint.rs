use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

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
    #[serde(default)]
    pub system: bool,
    #[serde(default)]
    pub managed_by: Option<String>,
    #[serde(default)]
    pub editable_by: Vec<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ViewType {
    Table,
    Form,
    Detail,
    Kanban,
    Calendar,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TransitionDefinition {
    pub name: String,
    pub from: String,
    pub to: String,
    pub label: String,
    #[serde(default)]
    pub roles: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RoleDefinition {
    pub name: String,
    pub label: String,
    #[serde(default)]
    pub permissions: Vec<String>,
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
    pub filter: Map<String, Value>,
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
        }))
        .unwrap();

        assert_eq!(blueprint.modules.len(), 2);
        assert!(blueprint.entities[0].fields[1].system);
        assert_eq!(
            blueprint.entities[0].fields[1].managed_by.as_deref(),
            Some("workflow")
        );
        assert_eq!(
            blueprint.workflows[0].initial_state.as_deref(),
            Some("pending")
        );
        assert_eq!(
            blueprint.workflows[0].transitions[0].roles,
            vec!["admin", "approver"]
        );
        assert_eq!(blueprint.navigation[0].view, "leave_requests");
    }

    #[test]
    fn deserializes_kanban_and_calendar_view_types() {
        let blueprint: AppBlueprint = serde_json::from_value(json!({
            "version": 1,
            "app": {"slug": "ticket-interni", "name": "Ticket Interni"},
            "entities": [{
                "name": "ticket",
                "label": "Ticket",
                "fields": [
                    {"name": "title", "type": "string", "label": "Titolo"},
                    {"name": "status", "type": "enum", "label": "Stato", "options": ["open", "closed"]}
                ]
            }],
            "views": [
                {"id": "ticket_board", "type": "kanban", "entity": "ticket", "name": "Board", "columns": ["title", "status"]},
                {"id": "ticket_calendar", "type": "calendar", "entity": "ticket", "name": "Calendario", "columns": ["title"]}
            ]
        }))
        .unwrap();

        assert_eq!(blueprint.views[0].view_type, ViewType::Kanban);
        assert_eq!(blueprint.views[1].view_type, ViewType::Calendar);
    }
}
