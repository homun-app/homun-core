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
