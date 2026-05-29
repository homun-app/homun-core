use crate::provider::Locality;

/// Privacy gate for inference routing. Cloud delegation moves local data off the
/// device, so it is deny-by-default per PROJECT.md (local-first; cloud is an
/// explicit, opt-in boundary). The Rust Core owns this decision; it is never
/// delegated to an external tool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrivacyPolicy {
    /// Cloud providers are only eligible when the user has explicitly opted in.
    allow_cloud_delegation: bool,
}

impl Default for PrivacyPolicy {
    fn default() -> Self {
        Self {
            allow_cloud_delegation: false,
        }
    }
}

impl PrivacyPolicy {
    /// Local-only: no provider that leaves the device is eligible.
    pub fn local_only() -> Self {
        Self::default()
    }

    /// Explicit opt-in to cloud delegation.
    pub fn allowing_cloud() -> Self {
        Self {
            allow_cloud_delegation: true,
        }
    }

    pub fn cloud_delegation_allowed(&self) -> bool {
        self.allow_cloud_delegation
    }

    /// Whether a provider with the given locality may be used under this policy.
    pub fn permits(&self, locality: Locality) -> bool {
        match locality {
            Locality::Local => true,
            Locality::Cloud => self.allow_cloud_delegation,
        }
    }
}
