use crate::{
    ActionClass, CapabilityCall, CapabilityCallResult, CapabilityConnection, CapabilityError,
    CapabilityProvider, CapabilityProviderKind, CapabilityResult, CapabilityTool,
    CapabilityTrigger, ConnectionStatus, DataBoundary, ManagedProviderMetadata, ProviderId,
    TriggerStatus, UserId, WorkspaceId,
};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;

pub trait ComposioTransport {
    fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> CapabilityResult<serde_json::Value>;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComposioRequest {
    pub method: String,
    pub path: String,
    pub body: serde_json::Value,
}

#[derive(Debug, Clone, Default)]
pub struct InMemoryComposioTransport {
    responses: HashMap<(String, String), serde_json::Value>,
    requests: RefCell<Vec<ComposioRequest>>,
}

impl InMemoryComposioTransport {
    pub fn new() -> Self {
        Self {
            responses: HashMap::new(),
            requests: RefCell::new(Vec::new()),
        }
    }

    pub fn with_response(
        mut self,
        method: impl Into<String>,
        path: impl Into<String>,
        response: serde_json::Value,
    ) -> Self {
        self.responses
            .insert((method.into(), path.into()), response);
        self
    }

    pub fn requests(&self) -> Vec<ComposioRequest> {
        self.requests.borrow().clone()
    }
}

impl ComposioTransport for InMemoryComposioTransport {
    fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> CapabilityResult<serde_json::Value> {
        self.requests.borrow_mut().push(ComposioRequest {
            method: method.to_string(),
            path: path.to_string(),
            body: body.unwrap_or(serde_json::Value::Null),
        });
        self.responses
            .get(&(method.to_string(), path.to_string()))
            .cloned()
            .ok_or_else(|| {
                CapabilityError::ProviderUnavailable(format!(
                    "composio_response_not_found:{method}:{path}"
                ))
            })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComposioToolPolicy {
    pub tool_name: String,
    pub action: ActionClass,
    pub privacy_domains: Vec<String>,
    pub sensitivity: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComposioProviderConfig {
    pub provider_id: ProviderId,
    pub user_id: UserId,
    pub workspace_id: WorkspaceId,
    pub enabled: bool,
    pub privacy_domains: Vec<String>,
    pub tool_policies: Vec<ComposioToolPolicy>,
}

pub struct ComposioCapabilityProvider<T: ComposioTransport> {
    config: ComposioProviderConfig,
    transport: T,
    metadata: ManagedProviderMetadata,
}

impl<T: ComposioTransport> ComposioCapabilityProvider<T> {
    pub fn new(config: ComposioProviderConfig, transport: T) -> Self {
        Self {
            config,
            transport,
            metadata: ManagedProviderMetadata {
                provider_name: "Composio".to_string(),
                data_boundary: DataBoundary::ManagedCloud,
                auth_mode: "composio_connect_or_api_key".to_string(),
                data_categories: vec![
                    "connected_account_metadata".to_string(),
                    "tool_arguments".to_string(),
                    "tool_results".to_string(),
                    "trigger_payloads".to_string(),
                ],
                retention_notes: Some(
                    "Execution and retention depend on Composio account and connected toolkit."
                        .to_string(),
                ),
            },
        }
    }

    pub fn transport(&self) -> &T {
        &self.transport
    }
}

impl<T: ComposioTransport> CapabilityProvider for ComposioCapabilityProvider<T> {
    fn id(&self) -> &ProviderId {
        &self.config.provider_id
    }

    fn kind(&self) -> CapabilityProviderKind {
        CapabilityProviderKind::Managed
    }

    fn is_enabled(&self) -> bool {
        self.config.enabled
    }

    fn managed_metadata(&self) -> Option<&ManagedProviderMetadata> {
        Some(&self.metadata)
    }

    fn list_tools(&self) -> CapabilityResult<Vec<CapabilityTool>> {
        let response = self.transport.request("GET", "/tools", None)?;
        let tools = response
            .get("tools")
            .and_then(|value| value.as_array())
            .ok_or_else(|| {
                CapabilityError::ProviderUnavailable("composio tools missing tools".to_string())
            })?;
        tools
            .iter()
            .map(|tool| self.capability_tool_from_composio(tool))
            .collect()
    }

    fn list_connections(&self) -> CapabilityResult<Vec<CapabilityConnection>> {
        let response = self.transport.request("GET", "/connected_accounts", None)?;
        let accounts = response
            .get("accounts")
            .or_else(|| response.get("connected_accounts"))
            .and_then(|value| value.as_array())
            .ok_or_else(|| {
                CapabilityError::ProviderUnavailable(
                    "composio connected accounts missing accounts".to_string(),
                )
            })?;
        Ok(accounts
            .iter()
            .filter_map(|account| self.connection_from_account(account))
            .collect())
    }

    fn call_tool(&self, call: &CapabilityCall) -> CapabilityResult<CapabilityCallResult> {
        let path = format!("/tools/execute/{}", call.tool_name);
        let output = self.transport.request(
            "POST",
            &path,
            Some(serde_json::json!({
                "user_id": self.config.user_id.as_str(),
                "arguments": call.arguments,
            })),
        )?;
        Ok(CapabilityCallResult {
            provider_id: self.config.provider_id.clone(),
            tool_name: call.tool_name.clone(),
            output,
        })
    }

    fn list_triggers(&self) -> CapabilityResult<Vec<CapabilityTrigger>> {
        let response = self.transport.request("GET", "/triggers", None)?;
        let triggers = response
            .get("triggers")
            .and_then(|value| value.as_array())
            .ok_or_else(|| {
                CapabilityError::ProviderUnavailable(
                    "composio triggers missing triggers".to_string(),
                )
            })?;
        Ok(triggers
            .iter()
            .filter_map(|trigger| self.trigger_from_composio(trigger))
            .collect())
    }

    fn enable_trigger(&mut self, trigger_id: &str) -> CapabilityResult<()> {
        self.transport.request(
            "POST",
            &format!("/triggers/{trigger_id}/enable"),
            Some(serde_json::json!({
                "user_id": self.config.user_id.as_str()
            })),
        )?;
        Ok(())
    }

    fn disable_trigger(&mut self, trigger_id: &str) -> CapabilityResult<()> {
        self.transport.request(
            "POST",
            &format!("/triggers/{trigger_id}/disable"),
            Some(serde_json::json!({
                "user_id": self.config.user_id.as_str()
            })),
        )?;
        Ok(())
    }
}

impl<T: ComposioTransport> ComposioCapabilityProvider<T> {
    fn capability_tool_from_composio(
        &self,
        tool: &serde_json::Value,
    ) -> CapabilityResult<CapabilityTool> {
        let name = tool
            .get("slug")
            .or_else(|| tool.get("name"))
            .and_then(|value| value.as_str())
            .ok_or_else(|| {
                CapabilityError::ProviderUnavailable("composio tool missing slug".to_string())
            })?;
        let policy = self
            .config
            .tool_policies
            .iter()
            .find(|policy| policy.tool_name == name);
        Ok(CapabilityTool {
            name: name.to_string(),
            provider_id: self.config.provider_id.clone(),
            provider_kind: CapabilityProviderKind::Managed,
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
                .unwrap_or_else(|| self.config.privacy_domains.clone()),
            sensitivity: policy
                .map(|policy| policy.sensitivity.clone())
                .unwrap_or_else(|| "private".to_string()),
            input_schema: tool
                .get("input_schema")
                .or_else(|| tool.get("inputSchema"))
                .cloned()
                .unwrap_or_else(|| serde_json::json!({"type": "object"})),
        })
    }

    fn connection_from_account(&self, account: &serde_json::Value) -> Option<CapabilityConnection> {
        let id = account.get("id")?.as_str()?.to_string();
        let display_name = account
            .get("display_name")
            .or_else(|| account.get("name"))
            .and_then(|value| value.as_str())
            .or_else(|| {
                account
                    .get("toolkit")
                    .and_then(|toolkit| toolkit.get("slug"))
                    .and_then(|value| value.as_str())
            })
            .unwrap_or("Composio connection")
            .to_string();
        Some(CapabilityConnection {
            id,
            provider_id: self.config.provider_id.clone(),
            user_id: self.config.user_id.clone(),
            workspace_id: self.config.workspace_id.clone(),
            status: connection_status(account.get("status").and_then(|value| value.as_str())),
            display_name,
            privacy_domains: self.config.privacy_domains.clone(),
        })
    }

    fn trigger_from_composio(&self, trigger: &serde_json::Value) -> Option<CapabilityTrigger> {
        let id = trigger.get("id")?.as_str()?.to_string();
        let name = trigger
            .get("slug")
            .or_else(|| trigger.get("name"))
            .and_then(|value| value.as_str())?
            .to_string();
        Some(CapabilityTrigger {
            id,
            provider_id: self.config.provider_id.clone(),
            name,
            status: trigger_status(trigger.get("status").and_then(|value| value.as_str())),
            privacy_domains: self.config.privacy_domains.clone(),
            config: trigger
                .get("config")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({})),
        })
    }
}

fn connection_status(status: Option<&str>) -> ConnectionStatus {
    match status.map(str::to_ascii_uppercase).as_deref() {
        Some("ACTIVE") => ConnectionStatus::Active,
        Some("FAILED") => ConnectionStatus::Failed,
        Some("EXPIRED") | Some("INACTIVE") => ConnectionStatus::Expired,
        Some("DISABLED") => ConnectionStatus::Disabled,
        _ => ConnectionStatus::Failed,
    }
}

fn trigger_status(status: Option<&str>) -> TriggerStatus {
    match status.map(str::to_ascii_uppercase).as_deref() {
        Some("ACTIVE") | Some("ENABLED") => TriggerStatus::Active,
        Some("FAILED") => TriggerStatus::Failed,
        _ => TriggerStatus::Disabled,
    }
}
