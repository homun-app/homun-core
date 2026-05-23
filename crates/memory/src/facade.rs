use crate::{
    AccessDecisionKind, DataSensitivity, GraphifyArtifacts, GraphifyImport, GraphifyImportSummary,
    MemoryAccessRequest, MemoryContextItem, MemoryContextPack, MemoryEntity, MemoryEvent,
    MemoryEvidence, MemoryExtraction, MemoryExtractionSummary, MemoryPolicyEngine, MemoryRecord,
    MemoryRef, MemoryRefKind, MemoryRelation, MemoryStatus, PrivacyDomain, SQLiteMemoryStore,
    UserId, WikiFileStore, WikiPage, WorkspaceId,
};
use std::str::FromStr;

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

    pub fn apply_extraction(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        extraction: MemoryExtraction,
    ) -> Result<MemoryExtractionSummary, String> {
        let mut memory_refs = Vec::new();
        let mut entity_refs = Vec::new();
        let mut relation_refs = Vec::new();
        let mut evidence_links_imported = 0;

        for extracted in extraction.memories {
            let reference =
                MemoryRef::generated(MemoryRefKind::Memory, user_id.clone(), workspace_id.clone());
            let evidence_refs = extracted.evidence_refs.clone();
            let memory = MemoryRecord {
                reference: reference.clone(),
                user_id: user_id.clone(),
                workspace_id: workspace_id.clone(),
                memory_type: extracted.memory_type,
                text: extracted.text,
                aliases: extracted.aliases,
                language_hints: extracted.language_hints,
                confidence: extracted.confidence,
                status: MemoryStatus::Confirmed,
                privacy_domain: extracted.privacy_domain,
                sensitivity: extracted.sensitivity,
                metadata: extracted.metadata,
            };
            self.store.upsert_memory(&memory)?;
            for evidence_ref in evidence_refs {
                self.store.link_evidence(&MemoryEvidence {
                    memory_ref: reference.clone(),
                    evidence_ref: MemoryRef::from_str(&evidence_ref)?,
                    note: "MemoryAgent extraction evidence".to_string(),
                })?;
                evidence_links_imported += 1;
            }
            memory_refs.push(reference);
        }

        for extracted in extraction.entities {
            let reference = MemoryRef::new(
                MemoryRefKind::Entity,
                user_id.clone(),
                workspace_id.clone(),
                extracted.canonical_key.clone(),
            );
            let entity = MemoryEntity {
                reference: reference.clone(),
                user_id: user_id.clone(),
                workspace_id: workspace_id.clone(),
                entity_type: extracted.entity_type,
                name: extracted.name,
                canonical_key: extracted.canonical_key,
                aliases: extracted.aliases,
                privacy_domain: extracted.privacy_domain,
                sensitivity: extracted.sensitivity,
                metadata: extracted.metadata,
            };
            self.store.upsert_entity(&entity)?;
            entity_refs.push(reference);
        }

        for extracted in extraction.relations {
            let reference = MemoryRef::generated(
                MemoryRefKind::Relation,
                user_id.clone(),
                workspace_id.clone(),
            );
            let relation = MemoryRelation {
                reference: reference.clone(),
                user_id: user_id.clone(),
                workspace_id: workspace_id.clone(),
                source_ref: MemoryRef::from_str(&extracted.source_ref)?,
                relation_type: extracted.relation_type,
                target_ref: MemoryRef::from_str(&extracted.target_ref)?,
                confidence: extracted.confidence,
                privacy_domain: extracted.privacy_domain,
                sensitivity: extracted.sensitivity,
                evidence: extracted
                    .evidence_refs
                    .iter()
                    .map(|reference| MemoryRef::from_str(reference))
                    .collect::<Result<Vec<_>, _>>()?,
                metadata: extracted.metadata,
            };
            self.store.upsert_relation(&relation)?;
            relation_refs.push(reference);
        }

        Ok(MemoryExtractionSummary {
            memories_imported: memory_refs.len(),
            entities_imported: entity_refs.len(),
            relations_imported: relation_refs.len(),
            evidence_links_imported,
            memory_refs,
            entity_refs,
            relation_refs,
        })
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
