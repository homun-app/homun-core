use crate::policy::PrivacyPolicy;
use crate::provider::{InferenceProvider, Requirements};
use local_first_subagents::{
    GenerateJsonRequest, GenerateJsonResponse, JsonRuntime, RuntimeClientError,
};

/// Routes inference calls across providers under a privacy policy, then exposes
/// the same `JsonRuntime` contract the rest of the system already consumes — so
/// the Brain, subagents and the desktop gateway need no changes to gain
/// local+cloud routing.
///
/// Selection is local-first: among providers that satisfy the call's
/// requirements and are permitted by policy, local providers are always
/// preferred over cloud, and ties keep insertion order (so the configured
/// preference wins).
pub struct ModelRouter {
    providers: Vec<Box<dyn InferenceProvider>>,
    policy: PrivacyPolicy,
}

impl ModelRouter {
    pub fn new(policy: PrivacyPolicy) -> Self {
        Self {
            providers: Vec::new(),
            policy,
        }
    }

    pub fn with_provider(mut self, provider: Box<dyn InferenceProvider>) -> Self {
        self.providers.push(provider);
        self
    }

    pub fn policy(&self) -> &PrivacyPolicy {
        &self.policy
    }

    /// Picks the provider for a call, local-first, honoring requirements and the
    /// privacy gate. Returns the chosen provider, or `None` if nothing is
    /// eligible (e.g. only cloud providers exist but cloud is denied).
    pub fn select(&self, requirements: &Requirements) -> Option<&dyn InferenceProvider> {
        let eligible = |provider: &&Box<dyn InferenceProvider>| {
            let descriptor = provider.descriptor();
            self.policy.permits(descriptor.locality) && descriptor.satisfies(requirements)
        };
        // Local-first: prefer an eligible local provider; otherwise fall back to
        // an eligible cloud provider. Insertion order breaks ties within a tier.
        self.providers
            .iter()
            .find(|provider| eligible(provider) && !provider.descriptor().locality.is_cloud())
            .or_else(|| self.providers.iter().find(eligible))
            .map(|provider| provider.as_ref())
    }

    /// Context window of the provider that would currently serve a call with
    /// the given requirements. Callers use this to size context (e.g. choose a
    /// full vs compact browser snapshot) to the model that will actually run.
    pub fn active_context_window(&self, requirements: &Requirements) -> Option<u32> {
        self.select(requirements)
            .map(|provider| provider.descriptor().context_window)
    }

    /// Like `generate_json` but with explicit capability requirements (e.g. a
    /// vision call routes only to vision-capable providers).
    pub fn generate_json_with(
        &self,
        requirements: &Requirements,
        request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError> {
        let provider = self.select(requirements).ok_or_else(|| {
            RuntimeClientError::Runtime {
                code: "no_provider_available".to_string(),
                message: no_provider_message(requirements, &self.policy),
            }
        })?;
        provider.generate_json(request)
    }
}

impl JsonRuntime for ModelRouter {
    fn generate_json(
        &self,
        request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError> {
        self.generate_json_with(&Requirements::default(), request)
    }
}

fn no_provider_message(requirements: &Requirements, policy: &PrivacyPolicy) -> String {
    let mut wants = Vec::new();
    if requirements.needs_vision {
        wants.push("vision");
    }
    if requirements.needs_tools {
        wants.push("tools");
    }
    let capabilities = if wants.is_empty() {
        "json generation".to_string()
    } else {
        wants.join("+")
    };
    format!(
        "no eligible inference provider for {capabilities} (cloud delegation {})",
        if policy.cloud_delegation_allowed() {
            "allowed"
        } else {
            "denied"
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{CapabilityDescriptor, InferenceProvider, Locality};
    use local_first_subagents::TokenMetrics;

    struct FakeProvider {
        descriptor: CapabilityDescriptor,
    }

    impl FakeProvider {
        fn new(id: &str, locality: Locality, vision: bool) -> Box<dyn InferenceProvider> {
            Box::new(Self {
                descriptor: CapabilityDescriptor {
                    id: id.to_string(),
                    locality,
                    supports_vision: vision,
                    supports_tools: false,
                    context_window: 8_192,
                    approx_tokens_per_second: None,
                },
            })
        }
    }

    impl InferenceProvider for FakeProvider {
        fn descriptor(&self) -> &CapabilityDescriptor {
            &self.descriptor
        }

        fn generate_json(
            &self,
            _request: &GenerateJsonRequest,
        ) -> Result<GenerateJsonResponse, RuntimeClientError> {
            Ok(GenerateJsonResponse {
                valid: true,
                errors: Vec::new(),
                json: serde_json::json!({ "provider": self.descriptor.id }),
                raw_output: String::new(),
                repaired: false,
                metrics: TokenMetrics::zero(),
            })
        }
    }

    fn request() -> GenerateJsonRequest {
        GenerateJsonRequest {
            prompt: "test".to_string(),
            max_tokens: 16,
            temperature: 0.0,
            wait_if_busy: true,
            request_timeout_seconds: None,
            json_schema: None,
            required_keys: Vec::new(),
            repair: false,
        }
    }

    #[test]
    fn prefers_local_provider_over_cloud() {
        let router = ModelRouter::new(PrivacyPolicy::allowing_cloud())
            .with_provider(FakeProvider::new("cloud", Locality::Cloud, false))
            .with_provider(FakeProvider::new("local", Locality::Local, false));

        let selected = router.select(&Requirements::default()).unwrap();
        assert_eq!(selected.descriptor().id, "local");
    }

    #[test]
    fn cloud_is_denied_by_default() {
        let router = ModelRouter::new(PrivacyPolicy::local_only())
            .with_provider(FakeProvider::new("cloud", Locality::Cloud, false));

        assert!(router.select(&Requirements::default()).is_none());
        let error = router.generate_json(&request()).unwrap_err();
        match error {
            RuntimeClientError::Runtime { code, message } => {
                assert_eq!(code, "no_provider_available");
                assert!(message.contains("denied"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn cloud_is_used_when_explicitly_allowed_and_no_local_exists() {
        let router = ModelRouter::new(PrivacyPolicy::allowing_cloud())
            .with_provider(FakeProvider::new("cloud", Locality::Cloud, false));

        let response = router.generate_json(&request()).unwrap();
        assert_eq!(response.json["provider"], "cloud");
    }

    #[test]
    fn vision_requirement_skips_non_vision_providers() {
        let router = ModelRouter::new(PrivacyPolicy::local_only())
            .with_provider(FakeProvider::new("text-local", Locality::Local, false))
            .with_provider(FakeProvider::new("vision-local", Locality::Local, true));

        let requirements = Requirements {
            needs_vision: true,
            ..Requirements::default()
        };
        let selected = router.select(&requirements).unwrap();
        assert_eq!(selected.descriptor().id, "vision-local");
    }

    #[test]
    fn active_context_window_reports_selected_provider() {
        let router = ModelRouter::new(PrivacyPolicy::local_only())
            .with_provider(FakeProvider::new("local", Locality::Local, false));
        assert_eq!(
            router.active_context_window(&Requirements::default()),
            Some(8_192)
        );

        let empty = ModelRouter::new(PrivacyPolicy::local_only());
        assert_eq!(empty.active_context_window(&Requirements::default()), None);
    }

    #[test]
    fn vision_requirement_with_only_text_providers_has_no_route() {
        let router = ModelRouter::new(PrivacyPolicy::local_only())
            .with_provider(FakeProvider::new("text-local", Locality::Local, false));

        let requirements = Requirements {
            needs_vision: true,
            ..Requirements::default()
        };
        assert!(router.select(&requirements).is_none());
    }
}
