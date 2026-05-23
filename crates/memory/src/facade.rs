use crate::{
    AccessDecisionKind, DataSensitivity, GraphifyArtifacts, GraphifyImport, GraphifyImportSummary,
    MemoryAccessRequest, MemoryContextItem, MemoryContextPack, MemoryEntity, MemoryEvent,
    MemoryEvidence, MemoryPolicyEngine, MemoryRecord, MemoryRelation, PrivacyDomain,
    SQLiteMemoryStore, UserId, WikiFileStore, WikiPage, WorkspaceId,
};

pub struct MemoryWikiProjection {
    pub page: WikiPage,
}

pub struct MemoryFacade {
    store: SQLiteMemoryStore,
    policy: MemoryPolicyEngine,
}

impl MemoryFacade {
    pub fn new(store: SQLiteMemoryStore) -> Self {
        Self {
            store,
            policy: MemoryPolicyEngine,
        }
    }

    pub fn record_event(&self, event: &MemoryEvent) -> Result<(), String> {
        self.store.record_event(event)
    }

    pub fn upsert_memory(&self, memory: &MemoryRecord) -> Result<(), String> {
        self.store.upsert_memory(memory)
    }

    pub fn upsert_entity(&self, entity: &MemoryEntity) -> Result<(), String> {
        self.store.upsert_entity(entity)
    }

    pub fn upsert_relation(&self, relation: &MemoryRelation) -> Result<(), String> {
        self.store.upsert_relation(relation)
    }

    pub fn link_evidence(&self, evidence: &MemoryEvidence) -> Result<(), String> {
        self.store.link_evidence(evidence)
    }

    pub fn context_pack(&self, request: &MemoryAccessRequest) -> Result<MemoryContextPack, String> {
        let export_decision = self.policy.decide_export(request);
        if export_decision.kind == AccessDecisionKind::Deny {
            self.store
                .record_access_decision(request, &export_decision)?;
            return Ok(MemoryContextPack {
                user_id: request.user_id.clone(),
                workspace_id: request.workspace_id.clone(),
                purpose: request.purpose.clone(),
                items: vec![],
                redacted: false,
            });
        }

        let mut items = Vec::new();
        let mut redacted = false;
        for memory in self
            .store
            .list_memories(&request.user_id, &request.workspace_id)?
        {
            let decision = self.policy.decide_memory(request, &memory);
            self.store.record_access_decision(request, &decision)?;
            match decision.kind {
                AccessDecisionKind::Allow => {
                    items.push(self.context_item(&memory)?);
                }
                AccessDecisionKind::Redact | AccessDecisionKind::SummarizeOnly => {
                    redacted = true;
                    items.push(self.context_item(&memory)?);
                }
                AccessDecisionKind::RequiresUserApproval | AccessDecisionKind::Deny => {}
            }
        }

        Ok(MemoryContextPack {
            user_id: request.user_id.clone(),
            workspace_id: request.workspace_id.clone(),
            purpose: request.purpose.clone(),
            items,
            redacted,
        })
    }

    pub fn project_to_wiki(
        &self,
        wiki: &WikiFileStore,
        projection: &MemoryWikiProjection,
    ) -> Result<(), String> {
        wiki.write_page(&self.store, &projection.page)
    }

    pub fn import_graphify_artifacts(
        &self,
        artifacts: &GraphifyArtifacts,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        privacy_domain: PrivacyDomain,
        sensitivity: DataSensitivity,
    ) -> Result<GraphifyImportSummary, String> {
        GraphifyImport::new(&self.store).import_artifacts(
            artifacts,
            user_id,
            workspace_id,
            privacy_domain,
            sensitivity,
        )
    }

    pub fn access_audit_count(&self) -> Result<u64, String> {
        self.store.access_audit_count()
    }

    fn context_item(&self, memory: &MemoryRecord) -> Result<MemoryContextItem, String> {
        let evidence = self
            .store
            .evidence_for(&memory.reference, &memory.user_id, &memory.workspace_id)?
            .into_iter()
            .map(|evidence| evidence.evidence_ref)
            .collect();
        Ok(MemoryContextItem {
            reference: memory.reference.clone(),
            summary: memory.text.clone(),
            sensitivity: memory.sensitivity,
            privacy_domain: memory.privacy_domain.clone(),
            evidence,
        })
    }
}
