use crate::{
    ActionClass, CapabilityCall, CapabilityCallResult, CapabilityConnection, CapabilityError,
    CapabilityProvider, CapabilityProviderKind, CapabilityResult, CapabilityTool,
    CapabilityTrigger, ManagedProviderMetadata, ProviderId,
};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;

pub trait McpTransport {
    fn request(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> CapabilityResult<serde_json::Value>;

    fn notify(&self, method: &str, params: Option<serde_json::Value>) -> CapabilityResult<()>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpToolPolicy {
    pub tool_name: String,
    pub action: ActionClass,
    pub privacy_domains: Vec<String>,
    pub sensitivity: String,
}

#[derive(Debug, Clone)]
pub struct InMemoryMcpTransport {
    responses: HashMap<String, serde_json::Value>,
    requests: RefCell<Vec<(String, Option<serde_json::Value>)>>,
    notifications: RefCell<Vec<String>>,
}

impl InMemoryMcpTransport {
    pub fn new() -> Self {
        Self {
            responses: HashMap::new(),
            requests: RefCell::new(Vec::new()),
            notifications: RefCell::new(Vec::new()),
        }
    }

    pub fn with_response(mut self, method: impl Into<String>, response: serde_json::Value) -> Self {
        self.responses.insert(method.into(), response);
        self
    }

    pub fn notifications(&self) -> Vec<String> {
        self.notifications.borrow().clone()
    }

    pub fn requests(&self) -> Vec<(String, Option<serde_json::Value>)> {
        self.requests.borrow().clone()
    }
}

impl Default for InMemoryMcpTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl McpTransport for InMemoryMcpTransport {
    fn request(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> CapabilityResult<serde_json::Value> {
        self.requests
            .borrow_mut()
            .push((method.to_string(), params.clone()));
        self.responses.get(method).cloned().ok_or_else(|| {
            CapabilityError::ProviderUnavailable(format!("mcp_response_not_found:{method}"))
        })
    }

    fn notify(&self, method: &str, _params: Option<serde_json::Value>) -> CapabilityResult<()> {
        self.notifications.borrow_mut().push(method.to_string());
        Ok(())
    }
}

pub struct McpCapabilityProvider<T: McpTransport> {
    id: ProviderId,
    enabled: bool,
    transport: T,
    tool_policies: Vec<McpToolPolicy>,
}

impl<T: McpTransport> McpCapabilityProvider<T> {
    pub fn new(
        id: ProviderId,
        enabled: bool,
        transport: T,
        tool_policies: Vec<McpToolPolicy>,
    ) -> Self {
        Self {
            id,
            enabled,
            transport,
            tool_policies,
        }
    }

    pub fn initialize(&self, protocol_version: &str) -> CapabilityResult<serde_json::Value> {
        let result = self.transport.request(
            "initialize",
            Some(serde_json::json!({
                "protocolVersion": protocol_version,
                "capabilities": {},
                "clientInfo": {
                    "name": "local-first-personal-assistant",
                    "version": "0.1.0"
                }
            })),
        )?;
        self.transport
            .notify("notifications/initialized", Some(serde_json::json!({})))?;
        Ok(result)
    }

    pub fn transport(&self) -> &T {
        &self.transport
    }
}

impl<T: McpTransport> CapabilityProvider for McpCapabilityProvider<T> {
    fn id(&self) -> &ProviderId {
        &self.id
    }

    fn kind(&self) -> CapabilityProviderKind {
        CapabilityProviderKind::Mcp
    }

    fn is_enabled(&self) -> bool {
        self.enabled
    }

    fn managed_metadata(&self) -> Option<&ManagedProviderMetadata> {
        None
    }

    fn list_tools(&self) -> CapabilityResult<Vec<CapabilityTool>> {
        let response = self.transport.request("tools/list", None)?;
        let tools = response
            .get("tools")
            .and_then(|value| value.as_array())
            .ok_or_else(|| {
                CapabilityError::ProviderUnavailable("mcp tools/list missing tools".to_string())
            })?;

        tools
            .iter()
            .map(|tool| self.capability_tool_from_mcp(tool))
            .collect()
    }

    fn list_connections(&self) -> CapabilityResult<Vec<CapabilityConnection>> {
        Ok(Vec::new())
    }

    fn call_tool(&self, call: &CapabilityCall) -> CapabilityResult<CapabilityCallResult> {
        let output = self.transport.request(
            "tools/call",
            Some(serde_json::json!({
                "name": call.tool_name,
                "arguments": call.arguments,
            })),
        )?;
        Ok(CapabilityCallResult {
            provider_id: self.id.clone(),
            tool_name: call.tool_name.clone(),
            output,
        })
    }

    fn list_triggers(&self) -> CapabilityResult<Vec<CapabilityTrigger>> {
        Ok(Vec::new())
    }

    fn enable_trigger(&mut self, trigger_id: &str) -> CapabilityResult<()> {
        Err(CapabilityError::TriggerFailed(format!(
            "mcp_triggers_not_supported:{trigger_id}"
        )))
    }

    fn disable_trigger(&mut self, trigger_id: &str) -> CapabilityResult<()> {
        Err(CapabilityError::TriggerFailed(format!(
            "mcp_triggers_not_supported:{trigger_id}"
        )))
    }
}

impl<T: McpTransport> McpCapabilityProvider<T> {
    fn capability_tool_from_mcp(&self, tool: &serde_json::Value) -> CapabilityResult<CapabilityTool> {
        let name = tool
            .get("name")
            .and_then(|value| value.as_str())
            .ok_or_else(|| {
                CapabilityError::ProviderUnavailable("mcp tool missing name".to_string())
            })?;
        let policy = self
            .tool_policies
            .iter()
            .find(|policy| policy.tool_name == name);
        Ok(CapabilityTool {
            name: name.to_string(),
            provider_id: self.id.clone(),
            provider_kind: CapabilityProviderKind::Mcp,
            action: policy
                .map(|policy| policy.action)
                .unwrap_or(ActionClass::Read),
            description: tool
                .get("description")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
            privacy_domains: policy
                .map(|policy| policy.privacy_domains.clone())
                .unwrap_or_default(),
            sensitivity: policy
                .map(|policy| policy.sensitivity.clone())
                .unwrap_or_else(|| "private".to_string()),
            input_schema: tool
                .get("inputSchema")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({"type": "object"})),
        })
    }
}
