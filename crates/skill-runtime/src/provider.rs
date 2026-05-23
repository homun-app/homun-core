use crate::{SkillRunner, SkillRuntime, SkillRuntimeRequest};
use local_first_capabilities::{
    CapabilityCall, CapabilityCallResult, CapabilityConnection, CapabilityError,
    CapabilityProvider, CapabilityProviderKind, CapabilityResult, CapabilityTool,
    CapabilityTrigger, ManagedProviderMetadata, ProviderId, SkillManifest,
};
use std::sync::Arc;

pub struct SkillRuntimeCapabilityProvider {
    id: ProviderId,
    manifest: SkillManifest,
    runtime: SkillRuntime,
}

impl SkillRuntimeCapabilityProvider {
    pub fn new(manifest: SkillManifest, runner: Arc<dyn SkillRunner>) -> Self {
        Self {
            id: ProviderId::new(format!("skill:{}", manifest.id)),
            manifest,
            runtime: SkillRuntime::new(runner),
        }
    }
}

impl CapabilityProvider for SkillRuntimeCapabilityProvider {
    fn id(&self) -> &ProviderId {
        &self.id
    }

    fn kind(&self) -> CapabilityProviderKind {
        CapabilityProviderKind::Skill
    }

    fn is_enabled(&self) -> bool {
        true
    }

    fn managed_metadata(&self) -> Option<&ManagedProviderMetadata> {
        None
    }

    fn list_tools(&self) -> CapabilityResult<Vec<CapabilityTool>> {
        Ok(self
            .manifest
            .tools
            .iter()
            .map(|tool| CapabilityTool {
                name: tool.name.clone(),
                provider_id: self.id.clone(),
                provider_kind: CapabilityProviderKind::Skill,
                action: tool.action,
                description: tool.description.clone(),
                privacy_domains: tool.privacy_domains.clone(),
                sensitivity: tool.sensitivity.clone(),
                input_schema: tool.input_schema.clone(),
            })
            .collect())
    }

    fn list_connections(&self) -> CapabilityResult<Vec<CapabilityConnection>> {
        Ok(Vec::new())
    }

    fn call_tool(&self, call: &CapabilityCall) -> CapabilityResult<CapabilityCallResult> {
        let output = self
            .runtime
            .execute(SkillRuntimeRequest::new(
                self.manifest.clone(),
                call.tool_name.clone(),
                call.arguments.clone(),
            ))
            .map_err(|error| CapabilityError::ToolExecutionFailed(error.to_string()))?;
        Ok(CapabilityCallResult {
            provider_id: self.id.clone(),
            tool_name: call.tool_name.clone(),
            output: output.output,
        })
    }

    fn list_triggers(&self) -> CapabilityResult<Vec<CapabilityTrigger>> {
        Ok(Vec::new())
    }

    fn enable_trigger(&mut self, trigger_id: &str) -> CapabilityResult<()> {
        Err(CapabilityError::TriggerFailed(format!(
            "skill_trigger_unavailable:{trigger_id}"
        )))
    }

    fn disable_trigger(&mut self, trigger_id: &str) -> CapabilityResult<()> {
        Err(CapabilityError::TriggerFailed(format!(
            "skill_trigger_unavailable:{trigger_id}"
        )))
    }
}
