use crate::{
    CapabilityProviderKind, CapabilityResult, CapabilityTool, ManagedProviderMetadata, ProviderId,
};

pub trait CapabilityProvider {
    fn id(&self) -> &ProviderId;
    fn kind(&self) -> CapabilityProviderKind;
    fn is_enabled(&self) -> bool;
    fn managed_metadata(&self) -> Option<&ManagedProviderMetadata>;
    fn list_tools(&self) -> CapabilityResult<Vec<CapabilityTool>>;
}

#[derive(Debug, Clone)]
pub struct FakeCapabilityProvider {
    id: ProviderId,
    kind: CapabilityProviderKind,
    enabled: bool,
    managed_metadata: Option<ManagedProviderMetadata>,
    tools: Vec<CapabilityTool>,
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
        }
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
}
