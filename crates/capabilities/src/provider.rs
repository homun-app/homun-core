use crate::{
    CapabilityCall, CapabilityCallResult, CapabilityConnection, CapabilityError,
    CapabilityProviderKind, CapabilityResult, CapabilityTool, ManagedProviderMetadata, ProviderId,
};
use std::collections::HashMap;

pub trait CapabilityProvider {
    fn id(&self) -> &ProviderId;
    fn kind(&self) -> CapabilityProviderKind;
    fn is_enabled(&self) -> bool;
    fn managed_metadata(&self) -> Option<&ManagedProviderMetadata>;
    fn list_tools(&self) -> CapabilityResult<Vec<CapabilityTool>>;
    fn list_connections(&self) -> CapabilityResult<Vec<CapabilityConnection>>;
    fn call_tool(&self, call: &CapabilityCall) -> CapabilityResult<CapabilityCallResult>;
}

#[derive(Debug, Clone)]
pub struct FakeCapabilityProvider {
    id: ProviderId,
    kind: CapabilityProviderKind,
    enabled: bool,
    managed_metadata: Option<ManagedProviderMetadata>,
    tools: Vec<CapabilityTool>,
    connections: Vec<CapabilityConnection>,
    tool_responses: HashMap<String, serde_json::Value>,
}

impl FakeCapabilityProvider {
    pub fn new(
        id: ProviderId,
        kind: CapabilityProviderKind,
        enabled: bool,
        managed_metadata: Option<ManagedProviderMetadata>,
        tools: Vec<CapabilityTool>,
    ) -> Self {
        Self {
            id,
            kind,
            enabled,
            managed_metadata,
            tools,
            connections: Vec::new(),
            tool_responses: HashMap::new(),
        }
    }

    pub fn add_connection(&mut self, connection: CapabilityConnection) {
        self.connections.push(connection);
    }

    pub fn set_tool_response(&mut self, tool_name: impl Into<String>, response: serde_json::Value) {
        self.tool_responses.insert(tool_name.into(), response);
    }
}

impl CapabilityProvider for FakeCapabilityProvider {
    fn id(&self) -> &ProviderId {
        &self.id
    }

    fn kind(&self) -> CapabilityProviderKind {
        self.kind
    }

    fn is_enabled(&self) -> bool {
        self.enabled
    }

    fn managed_metadata(&self) -> Option<&ManagedProviderMetadata> {
        self.managed_metadata.as_ref()
    }

    fn list_tools(&self) -> CapabilityResult<Vec<CapabilityTool>> {
        Ok(self.tools.clone())
    }

    fn list_connections(&self) -> CapabilityResult<Vec<CapabilityConnection>> {
        Ok(self.connections.clone())
    }

    fn call_tool(&self, call: &CapabilityCall) -> CapabilityResult<CapabilityCallResult> {
        if !self.tools.iter().any(|tool| tool.name == call.tool_name) {
            return Err(CapabilityError::ToolExecutionFailed(format!(
                "tool_not_found:{}",
                call.tool_name
            )));
        }

        Ok(CapabilityCallResult {
            provider_id: self.id.clone(),
            tool_name: call.tool_name.clone(),
            output: self
                .tool_responses
                .get(&call.tool_name)
                .cloned()
                .unwrap_or_else(|| serde_json::json!({"ok": true})),
        })
    }
}
