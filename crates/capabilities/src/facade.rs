use crate::{
    CapabilityAuditEvent, CapabilityCall, CapabilityCallResult, CapabilityConnection,
    CapabilityError, CapabilityPolicy, CapabilityProvider, CapabilityResult, CapabilityTool,
    InMemoryCapabilityAudit, PolicyContext, ProviderId, UserId, WorkspaceId,
};

pub struct CapabilityFacade {
    policy: CapabilityPolicy,
    audit: InMemoryCapabilityAudit,
    providers: Vec<Box<dyn CapabilityProvider>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolAccessPlan {
    pub visible_tools: Vec<CapabilityTool>,
    pub executable_tools: Vec<CapabilityTool>,
}

impl ToolAccessPlan {
    pub fn visible_tool_names(&self) -> Vec<&str> {
        self.visible_tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect()
    }

    pub fn executable_tool_names(&self) -> Vec<&str> {
        self.executable_tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect()
    }
}

impl CapabilityFacade {
    pub fn new(policy: CapabilityPolicy, audit: InMemoryCapabilityAudit) -> Self {
        Self {
            policy,
            audit,
            providers: Vec::new(),
        }
    }

    pub fn register_provider<P>(&mut self, provider: P)
    where
        P: CapabilityProvider + 'static,
    {
        self.providers.push(Box::new(provider));
    }

    pub fn audit(&self) -> &InMemoryCapabilityAudit {
        &self.audit
    }

    pub fn list_tools(&self, context: &PolicyContext) -> CapabilityResult<ToolAccessPlan> {
        let mut visible_tools = Vec::new();
        let mut executable_tools = Vec::new();
        for provider in &self.providers {
            if !provider.is_enabled() {
                continue;
            }
            for tool in provider.list_tools()? {
                let decision = self.policy.tool_access(context, &tool);
                if decision.model_visible {
                    visible_tools.push(tool.clone());
                }
                if decision.executable {
                    executable_tools.push(tool);
                }
            }
        }
        visible_tools.sort_by(|left, right| left.name.cmp(&right.name));
        executable_tools.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(ToolAccessPlan {
            visible_tools,
            executable_tools,
        })
    }

    pub fn list_connections(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> CapabilityResult<Vec<CapabilityConnection>> {
        let mut connections = Vec::new();
        for provider in &self.providers {
            for connection in provider.list_connections()? {
                if &connection.user_id == user_id && &connection.workspace_id == workspace_id {
                    connections.push(connection);
                }
            }
        }
        connections.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(connections)
    }

    pub fn call_tool(
        &mut self,
        context: &PolicyContext,
        call: CapabilityCall,
    ) -> CapabilityResult<CapabilityCallResult> {
        let provider = self.provider(&call.provider_id)?;
        let tool = provider
            .list_tools()?
            .into_iter()
            .find(|tool| tool.name == call.tool_name)
            .ok_or_else(|| {
                CapabilityError::ToolExecutionFailed(format!("tool_not_found:{}", call.tool_name))
            })?;
        let decision = self.policy.tool_access(context, &tool);
        if !decision.executable {
            self.audit.record(CapabilityAuditEvent {
                user_id: context.user_id.clone(),
                workspace_id: context.workspace_id.clone(),
                operation: "call_tool".to_string(),
                provider_id: Some(call.provider_id.clone()),
                tool_name: Some(call.tool_name.clone()),
                decision: "denied".to_string(),
                payload: serde_json::json!({
                    "arguments": call.arguments,
                    "reasons": decision.reasons,
                }),
            });
            return Err(error_from_denial(decision.reasons));
        }

        validate_arguments(&tool.input_schema, &call.arguments)?;
        let result = provider.call_tool(&call)?;
        self.audit.record(CapabilityAuditEvent {
            user_id: context.user_id.clone(),
            workspace_id: context.workspace_id.clone(),
            operation: "call_tool".to_string(),
            provider_id: Some(call.provider_id.clone()),
            tool_name: Some(call.tool_name.clone()),
            decision: "allowed".to_string(),
            payload: serde_json::json!({
                "arguments": call.arguments,
                "result": result.output,
            }),
        });
        Ok(result)
    }

    fn provider(&self, provider_id: &ProviderId) -> CapabilityResult<&dyn CapabilityProvider> {
        self.providers
            .iter()
            .find(|provider| provider.id() == provider_id)
            .map(|provider| provider.as_ref())
            .ok_or_else(|| {
                CapabilityError::ProviderUnavailable(format!(
                    "provider_not_found:{}",
                    provider_id.as_str()
                ))
            })
    }
}

fn error_from_denial(reasons: Vec<String>) -> CapabilityError {
    let first = reasons
        .first()
        .cloned()
        .unwrap_or_else(|| "policy_denied".to_string());
    if first.starts_with("managed_cloud_not_allowed:") {
        CapabilityError::ManagedProviderBoundary(first)
    } else {
        CapabilityError::PolicyDenied(first)
    }
}

fn validate_arguments(
    schema: &serde_json::Value,
    arguments: &serde_json::Value,
) -> CapabilityResult<()> {
    if schema.get("type").and_then(|value| value.as_str()) == Some("object")
        && !arguments.is_object()
    {
        return Err(CapabilityError::SchemaValidationFailed(
            "arguments must be object".to_string(),
        ));
    }

    if let Some(required) = schema.get("required").and_then(|value| value.as_array()) {
        for field in required.iter().filter_map(|value| value.as_str()) {
            if arguments.get(field).is_none() {
                return Err(CapabilityError::SchemaValidationFailed(format!(
                    "{field} is required"
                )));
            }
        }
    }

    if let Some(properties) = schema.get("properties").and_then(|value| value.as_object()) {
        for (field, field_schema) in properties {
            let Some(value) = arguments.get(field) else {
                continue;
            };
            match field_schema.get("type").and_then(|value| value.as_str()) {
                Some("string") if !value.is_string() => {
                    return Err(CapabilityError::SchemaValidationFailed(format!(
                        "{field} must be string"
                    )));
                }
                Some("number") if !value.is_number() => {
                    return Err(CapabilityError::SchemaValidationFailed(format!(
                        "{field} must be number"
                    )));
                }
                Some("boolean") if !value.is_boolean() => {
                    return Err(CapabilityError::SchemaValidationFailed(format!(
                        "{field} must be boolean"
                    )));
                }
                Some("array") if !value.is_array() => {
                    return Err(CapabilityError::SchemaValidationFailed(format!(
                        "{field} must be array"
                    )));
                }
                Some("object") if !value.is_object() => {
                    return Err(CapabilityError::SchemaValidationFailed(format!(
                        "{field} must be object"
                    )));
                }
                _ => {}
            }
        }
    }

    Ok(())
}
