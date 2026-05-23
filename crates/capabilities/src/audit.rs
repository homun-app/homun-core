use crate::{ProviderId, UserId, WorkspaceId};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CapabilityAuditEvent {
    pub user_id: UserId,
    pub workspace_id: WorkspaceId,
    pub operation: String,
    pub provider_id: Option<ProviderId>,
    pub tool_name: Option<String>,
    pub decision: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Default)]
pub struct InMemoryCapabilityAudit {
    events: Vec<CapabilityAuditEvent>,
}

impl InMemoryCapabilityAudit {
    pub fn new() -> Self {
        Self { events: Vec::new() }
    }

    pub fn record(&mut self, mut event: CapabilityAuditEvent) {
        event.payload = redact_secrets(event.payload);
        self.events.push(event);
    }

    pub fn events(&self) -> Vec<CapabilityAuditEvent> {
        self.events.clone()
    }
}

fn redact_secrets(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.into_iter()
                .map(|(key, value)| {
                    if is_secret_key(&key) {
                        (key, serde_json::Value::String("[redacted]".to_string()))
                    } else {
                        (key, redact_secrets(value))
                    }
                })
                .collect(),
        ),
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.into_iter().map(redact_secrets).collect())
        }
        other => other,
    }
}

fn is_secret_key(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "access_token" | "refresh_token" | "api_key" | "password" | "secret"
    )
}
