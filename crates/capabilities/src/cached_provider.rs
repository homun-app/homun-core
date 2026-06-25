use crate::{
    CapabilityCall, CapabilityCallResult, CapabilityConnection, CapabilityError,
    CapabilityProvider, CapabilityProviderKind, CapabilityResult, CapabilityTool,
    CapabilityTrigger, ManagedProviderMetadata, ProviderId,
};

/// A read-only capability provider that exposes a provider's cached tools for
/// PLANNING visibility only. Execution must go through a live executor, so
/// `call_tool` refuses. This is the transitional facade<-registry-cache shim
/// from ADR 0008 pillar #2: it lets the OrchestratorBrain see the gateway's
/// tools (to plan over them) before the live providers are assembled.
#[derive(Debug, Clone)]
pub struct CachedToolProvider {
    id: ProviderId,
    kind: CapabilityProviderKind,
    enabled: bool,
    tools: Vec<CapabilityTool>,
}

impl CachedToolProvider {
    pub fn new(id: ProviderId, kind: CapabilityProviderKind, tools: Vec<CapabilityTool>) -> Self {
        Self {
            id,
            kind,
            enabled: true,
            tools,
        }
    }
}

impl CapabilityProvider for CachedToolProvider {
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
        None
    }

    fn list_tools(&self) -> CapabilityResult<Vec<CapabilityTool>> {
        Ok(self.tools.clone())
    }

    fn list_connections(&self) -> CapabilityResult<Vec<CapabilityConnection>> {
        Ok(Vec::new())
    }

    fn call_tool(&self, call: &CapabilityCall) -> CapabilityResult<CapabilityCallResult> {
        // Planning-only: never silently "succeed" an execution.
        Err(CapabilityError::ProviderUnavailable(format!(
            "cached planning-only provider cannot execute {}; route through a live executor",
            call.tool_name
        )))
    }

    fn list_triggers(&self) -> CapabilityResult<Vec<CapabilityTrigger>> {
        Ok(Vec::new())
    }

    fn enable_trigger(&mut self, _trigger_id: &str) -> CapabilityResult<()> {
        Err(CapabilityError::ProviderUnavailable(
            "cached planning-only provider has no triggers".to_string(),
        ))
    }

    fn disable_trigger(&mut self, _trigger_id: &str) -> CapabilityResult<()> {
        Err(CapabilityError::ProviderUnavailable(
            "cached planning-only provider has no triggers".to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ActionClass, CapabilityCall, CapabilityProviderKind, ProviderId};

    fn tool(name: &str) -> CapabilityTool {
        CapabilityTool {
            name: name.to_string(),
            provider_id: ProviderId::new("trello"),
            provider_kind: CapabilityProviderKind::Native,
            action: ActionClass::Read,
            description: "read board".to_string(),
            privacy_domains: Vec::new(),
            sensitivity: "low".to_string(),
            input_schema: serde_json::json!({"type": "object"}),
        }
    }

    #[test]
    fn lists_cached_tools_for_planning() {
        let provider = CachedToolProvider::new(
            ProviderId::new("trello"),
            CapabilityProviderKind::Native,
            vec![tool("trello.read_board")],
        );
        assert!(provider.is_enabled());
        let tools = provider.list_tools().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "trello.read_board");
    }

    #[test]
    fn refuses_execution() {
        let provider = CachedToolProvider::new(
            ProviderId::new("trello"),
            CapabilityProviderKind::Native,
            vec![tool("trello.read_board")],
        );
        let call = CapabilityCall {
            provider_id: ProviderId::new("trello"),
            tool_name: "trello.read_board".to_string(),
            arguments: serde_json::json!({}),
        };
        let error = provider.call_tool(&call).unwrap_err();
        assert!(matches!(error, CapabilityError::ProviderUnavailable(_)));
    }
}
