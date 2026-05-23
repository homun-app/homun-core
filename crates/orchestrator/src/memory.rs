use crate::{OrchestratorError, OrchestratorRequest, OrchestratorResult};
use serde::{Deserialize, Serialize};

pub trait MemoryContextProvider {
    fn load_context(
        &self,
        request: &OrchestratorRequest,
    ) -> OrchestratorResult<Vec<MemoryContextSnippet>>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryContextSnippet {
    pub reference: String,
    pub summary: String,
    pub privacy_domain: String,
    pub sensitivity: String,
}

#[derive(Debug, Clone, Default)]
pub struct NoopMemoryContextProvider;

impl MemoryContextProvider for NoopMemoryContextProvider {
    fn load_context(
        &self,
        _request: &OrchestratorRequest,
    ) -> OrchestratorResult<Vec<MemoryContextSnippet>> {
        Ok(Vec::new())
    }
}

#[derive(Debug, Clone)]
pub struct StaticMemoryContextProvider {
    snippets: Vec<MemoryContextSnippet>,
}

impl StaticMemoryContextProvider {
    pub fn new(snippets: Vec<MemoryContextSnippet>) -> Self {
        Self { snippets }
    }
}

impl MemoryContextProvider for StaticMemoryContextProvider {
    fn load_context(
        &self,
        _request: &OrchestratorRequest,
    ) -> OrchestratorResult<Vec<MemoryContextSnippet>> {
        Ok(self.snippets.clone())
    }
}

impl MemoryContextProvider for local_first_memory::MemoryFacade {
    fn load_context(
        &self,
        request: &OrchestratorRequest,
    ) -> OrchestratorResult<Vec<MemoryContextSnippet>> {
        let access = local_first_memory::MemoryAccessRequest {
            actor_id: "orchestrator".to_string(),
            user_id: local_first_memory::UserId::new(request.policy_context.user_id.as_str()),
            workspace_id: local_first_memory::WorkspaceId::new(
                request.policy_context.workspace_id.as_str(),
            ),
            purpose: format!("orchestrator:{}", request.request_id),
            allowed_domains: request
                .policy_context
                .privacy_domains
                .iter()
                .map(|domain| local_first_memory::PrivacyDomain::new(domain.clone()))
                .collect(),
            max_sensitivity: local_first_memory::DataSensitivity::Private,
            allow_raw_payload: false,
            allow_export: false,
            broad_query: false,
        };
        let pack = self
            .context_pack(&access)
            .map_err(|error| OrchestratorError::Memory(error.to_string()))?;
        Ok(pack
            .items
            .into_iter()
            .map(|item| MemoryContextSnippet {
                reference: item.reference.to_string(),
                summary: item.summary,
                privacy_domain: item.privacy_domain.as_str().to_string(),
                sensitivity: format!("{:?}", item.sensitivity).to_lowercase(),
            })
            .collect())
    }
}
