use crate::{
    AUTHORIZED_MEMORY_SEARCH_LIMIT_MAX, AccessDecisionKind, AuthorizedMemorySearchRequest,
    AuthorizedMemorySource, AutomationCandidateCreateRequest, AutomationCandidateRecord,
    AutomationCandidateStatus, DataSensitivity, GraphifyArtifacts, GraphifyCli, GraphifyImport,
    GraphifyImportSummary, GraphifyOperation, GraphifyQueryRequest, GraphifyQueryResult,
    MemoryAccessDecision, MemoryAccessRequest, MemoryBackupReport, MemoryCollectionKey,
    MemoryContextItem, MemoryContextPack, MemoryCreateRequest, MemoryEntity, MemoryError,
    MemoryEvent, MemoryEvidence, MemoryExtraction, MemoryExtractionSummary, MemoryHealth,
    MemoryLifecycleRequest, MemoryMaintenanceReport, MemoryPolicyEngine,
    MemoryPublicationCandidate, MemoryPublicationDestination, MemoryPublicationEditInput,
    MemoryPublicationLink, MemoryPublicationProposal, MemoryPublicationReasonCode,
    MemoryPublicationResolution, MemoryPublicationResult, MemoryPublicationStatus,
    MemoryPublicationStoreError, MemoryRecord, MemoryRef, MemoryRefKind, MemoryRelation,
    MemoryResult, MemorySearchPage, MemorySearchRequest, MemorySearchResult,
    MemorySourceCandidateProjection, MemorySourceGrant, MemorySourceGrantStoreError, MemoryStatus,
    MemoryUpdatePatch, PERSONAL_WORKSPACE, PrivacyDomain, ProjectGraphImportError,
    ProjectGraphImportReport, RoutineInference, RoutineInferenceSummary, RoutineRecord,
    RoutineStatus, SQLiteMemoryStore, THREADS_WORKSPACE, UserId, VectorHit,
    WikiCorrectionSyncReport, WikiFileStore, WikiPage, WorkspaceId, WorkspacePurgeReport,
    contains_secret, current_timestamp, ensure_artifacts_inside_root, ensure_transition,
    normalize_graphify_value, parse_wiki_markdown,
};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::str::FromStr;
use std::sync::Mutex;

const AUTHORIZED_VECTOR_INDEX_CACHE_MAX: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct AuthorizedVectorIndexKey {
    source_user_id: String,
    source_workspace_id: String,
    policy_fingerprint: u64,
    source_generation: u64,
}

pub struct MemoryWikiProjection {
    pub page: WikiPage,
}

pub struct MemoryFacade {
    store: SQLiteMemoryStore,
    policy: MemoryPolicyEngine,
    vector_indexes: Mutex<HashMap<String, crate::MemoryVectorIndexCache>>,
    authorized_vector_indexes:
        Mutex<HashMap<AuthorizedVectorIndexKey, crate::MemoryVectorIndexCache>>,
    /// ADR 0022 (Tappa 1.5) — generation counter per scope, usato per invalidare
    /// la cache del briefing. Ogni scrittura che muta il contenuto di uno scope
    /// (memorie/wiki) incrementa la generation; la cache del briefing confronta
    /// la sua generation con questa per decidere hit/miss. Keyed come il vector
    /// index (`vector_index_scope_key`). `Mutex` perché le scritture sono da thread
    /// concorrenti (learn/consolidate/backfill).
    briefing_generations: Mutex<HashMap<String, u64>>,
}

fn memory_source_grant_error(error: MemorySourceGrantStoreError) -> MemoryError {
    match error {
        MemorySourceGrantStoreError::Validation(message) => MemoryError::validation(message),
        MemorySourceGrantStoreError::Conflict(message) => MemoryError::policy(message),
        MemorySourceGrantStoreError::NotFound(message) => MemoryError::not_found(message),
        MemorySourceGrantStoreError::Store(message) => MemoryError::Store(message),
    }
}

fn memory_publication_error(error: MemoryPublicationStoreError) -> MemoryError {
    match error {
        MemoryPublicationStoreError::Validation(message) => MemoryError::validation(message),
        MemoryPublicationStoreError::Conflict(message) => MemoryError::policy(message),
        MemoryPublicationStoreError::NotFound(message) => MemoryError::not_found(message),
        MemoryPublicationStoreError::Store(message) => MemoryError::Store(message),
    }
}

impl MemoryFacade {
    pub fn new(store: SQLiteMemoryStore) -> Self {
        Self {
            store,
            policy: MemoryPolicyEngine,
            vector_indexes: Mutex::new(HashMap::new()),
            authorized_vector_indexes: Mutex::new(HashMap::new()),
            briefing_generations: Mutex::new(HashMap::new()),
        }
    }

    /// ADR 0022 (Tappa 1.5) — generation corrente del contenuto di uno scope.
    /// Incrementata a ogni scrittura. La cache del briefing la usa per invalidarsi:
    /// se la sua generation differisce da questa, il briefing è stale → rebuild.
    /// 0 = mai scritto (o non ancora mutato): equivalente a "nessuna cache possibile".
    pub fn briefing_generation(&self, user_id: &UserId, workspace_id: &WorkspaceId) -> u64 {
        let key = vector_index_scope_key(user_id, workspace_id);
        self.briefing_generations
            .lock()
            .map(|generations| *generations.get(&key).unwrap_or(&0))
            .unwrap_or(0)
    }

    /// ADR 0022 (Tappa 1.5) — incrementa la generation di uno scope. Chiamato da
    /// ogni metodo mutating del facade per invalidare la cache del briefing.
    fn bump_briefing_generation(&self, user_id: &UserId, workspace_id: &WorkspaceId) {
        if let Ok(mut generations) = self.briefing_generations.lock() {
            let key = vector_index_scope_key(user_id, workspace_id);
            let entry = generations.entry(key).or_insert(0);
            *entry = entry.wrapping_add(1);
        }
        // Se il lock è avvelenato, non incrementiamo: la cache potrebbe servire
        // stale, ma un lock avvelenato indica già un panic altrove (blast radius
        // maggiore del briefing). Meglio non propagare il panico qui.
    }

    /// Hard purge of all memory data for a workspace. Delegates to the store.
    pub fn purge_workspace(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<WorkspacePurgeReport, String> {
        let report = self.store.purge_workspace(user_id, workspace_id)?;
        let key = vector_index_scope_key(user_id, workspace_id);
        if let Ok(mut indexes) = self.vector_indexes.lock() {
            indexes.remove(&key);
        }
        if let Ok(mut indexes) = self.authorized_vector_indexes.lock() {
            indexes.retain(|cache_key, _| {
                cache_key.source_user_id != user_id.as_str()
                    || cache_key.source_workspace_id != workspace_id.as_str()
            });
        }
        self.bump_briefing_generation(user_id, workspace_id);
        Ok(report)
    }

    /// Reclaims free space in the SQLite database file.
    pub fn vacuum(&self) -> Result<(), String> {
        self.store.vacuum()
    }

    pub fn record_event(&self, event: &MemoryEvent) -> MemoryResult<()> {
        Ok(self.store.record_event(event)?)
    }

    pub fn upsert_memory(&self, memory: &MemoryRecord) -> MemoryResult<()> {
        self.store.upsert_memory(memory)?;
        self.bump_briefing_generation(&memory.user_id, &memory.workspace_id);
        Ok(())
    }

    pub fn upsert_entity(&self, entity: &MemoryEntity) -> MemoryResult<()> {
        Ok(self.store.upsert_entity(entity)?)
    }

    pub fn upsert_relation(&self, relation: &MemoryRelation) -> MemoryResult<()> {
        Ok(self.store.upsert_relation(relation)?)
    }

    /// Tombstones an entity (hidden from listings/lookups). Used to merge a
    /// duplicate contact into another after its handles have been moved over.
    pub fn tombstone_entity(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        reason: &str,
    ) -> MemoryResult<()> {
        self.store
            .tombstone(reference, user_id, workspace_id, reason)?;
        self.bump_briefing_generation(user_id, workspace_id);
        Ok(())
    }

    pub fn tombstone_ref(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        reason: &str,
    ) -> MemoryResult<()> {
        self.store
            .tombstone(reference, user_id, workspace_id, reason)?;
        self.bump_briefing_generation(user_id, workspace_id);
        Ok(())
    }

    pub fn link_evidence(&self, evidence: &MemoryEvidence) -> MemoryResult<()> {
        Ok(self.store.link_evidence(evidence)?)
    }

    pub fn create_memory_candidate(
        &self,
        create: MemoryCreateRequest,
    ) -> MemoryResult<MemoryRecord> {
        let now = current_timestamp();
        let reference = MemoryRef::generated(
            MemoryRefKind::Memory,
            create.request.user_id.clone(),
            create.request.workspace_id.clone(),
        );
        let memory = MemoryRecord {
            reference: reference.clone(),
            user_id: create.request.user_id.clone(),
            workspace_id: create.request.workspace_id.clone(),
            memory_type: create.memory_type,
            text: create.text,
            aliases: create.aliases,
            language_hints: create.language_hints,
            confidence: create.confidence,
            status: MemoryStatus::Candidate,
            privacy_domain: create.privacy_domain,
            sensitivity: create.sensitivity,
            metadata: create.metadata,
            created_at: now.clone(),
            updated_at: now.clone(),
            last_seen_at: Some(now),
            supersedes: vec![],
            superseded_by: None,
            correction_of: None,
        };
        self.store.upsert_memory(&memory)?;
        for evidence_ref in create.evidence_refs {
            self.store.link_evidence(&MemoryEvidence {
                memory_ref: reference.clone(),
                evidence_ref,
                note: "Lifecycle create evidence".to_string(),
            })?;
        }
        self.audit_lifecycle(&create.request, AccessDecisionKind::Allow, vec![])?;
        self.bump_briefing_generation(&memory.user_id, &memory.workspace_id);
        Ok(memory)
    }

    pub fn update_memory(
        &self,
        request: &MemoryLifecycleRequest,
        reference: &MemoryRef,
        patch: MemoryUpdatePatch,
    ) -> MemoryResult<MemoryRecord> {
        let mut memory = self.load_lifecycle_memory(request, reference)?;
        if let Some(text) = patch.text {
            memory.text = text;
        }
        if let Some(aliases) = patch.aliases {
            memory.aliases = aliases;
        }
        if let Some(language_hints) = patch.language_hints {
            memory.language_hints = language_hints;
        }
        if let Some(confidence) = patch.confidence {
            memory.confidence = confidence;
        }
        if let Some(privacy_domain) = patch.privacy_domain {
            memory.privacy_domain = privacy_domain;
        }
        if let Some(sensitivity) = patch.sensitivity {
            memory.sensitivity = sensitivity;
        }
        if let Some(metadata) = patch.metadata {
            memory.metadata = metadata;
        }
        if let Some(last_seen_at) = patch.last_seen_at {
            memory.last_seen_at = Some(last_seen_at);
        }
        memory.updated_at = current_timestamp();
        self.store.upsert_memory(&memory)?;
        self.audit_lifecycle(request, AccessDecisionKind::Allow, vec![])?;
        self.bump_briefing_generation(&request.user_id, &request.workspace_id);
        Ok(memory)
    }

    pub fn confirm_memory(
        &self,
        request: &MemoryLifecycleRequest,
        reference: &MemoryRef,
        reason: &str,
    ) -> MemoryResult<MemoryRecord> {
        self.transition_memory(request, reference, MemoryStatus::Confirmed, reason)
    }

    pub fn reject_memory(
        &self,
        request: &MemoryLifecycleRequest,
        reference: &MemoryRef,
        reason: &str,
    ) -> MemoryResult<MemoryRecord> {
        self.transition_memory(request, reference, MemoryStatus::Rejected, reason)
    }

    pub fn mark_memory_stale(
        &self,
        request: &MemoryLifecycleRequest,
        reference: &MemoryRef,
        reason: &str,
    ) -> MemoryResult<MemoryRecord> {
        self.transition_memory(request, reference, MemoryStatus::Stale, reason)
    }

    pub fn merge_memories(
        &self,
        request: &MemoryLifecycleRequest,
        canonical_ref: &MemoryRef,
        source_refs: Vec<MemoryRef>,
        reason: &str,
    ) -> MemoryResult<MemoryRecord> {
        let mut canonical = self.load_lifecycle_memory(request, canonical_ref)?;
        let now = current_timestamp();
        for source_ref in source_refs {
            let mut source = self.load_lifecycle_memory(request, &source_ref)?;
            if !canonical.supersedes.contains(&source.reference) {
                canonical.supersedes.push(source.reference.clone());
            }
            source.superseded_by = Some(canonical.reference.clone());
            source.updated_at = now.clone();
            source.metadata = merge_reason(source.metadata, reason);
            self.store.upsert_memory(&source)?;
        }
        canonical.updated_at = now;
        canonical.metadata = merge_reason(canonical.metadata, reason);
        self.store.upsert_memory(&canonical)?;
        self.audit_lifecycle(request, AccessDecisionKind::Allow, vec![])?;
        self.bump_briefing_generation(&request.user_id, &request.workspace_id);
        Ok(canonical)
    }

    pub fn delete_memory(
        &self,
        request: &MemoryLifecycleRequest,
        reference: &MemoryRef,
        reason: &str,
    ) -> MemoryResult<()> {
        if reference.user_id != request.user_id || reference.workspace_id != request.workspace_id {
            self.audit_lifecycle(
                request,
                AccessDecisionKind::Deny,
                vec!["scope_mismatch".to_string()],
            )?;
            return Err(MemoryError::validation(
                "cannot access ref outside user/workspace",
            ));
        }
        if let Some(mut memory) =
            self.store
                .get_memory(reference, &request.user_id, &request.workspace_id)?
        {
            ensure_transition(memory.status, MemoryStatus::Deleted)?;
            memory.status = MemoryStatus::Deleted;
            memory.updated_at = current_timestamp();
            memory.metadata = merge_reason(memory.metadata, reason);
            self.store.upsert_memory(&memory)?;
        }
        self.store
            .tombstone(reference, &request.user_id, &request.workspace_id, reason)?;
        self.audit_lifecycle(request, AccessDecisionKind::Allow, vec![])?;
        self.bump_briefing_generation(&request.user_id, &request.workspace_id);
        Ok(())
    }

    pub fn record_wiki_page_for_ui(&self, page: &WikiPage) -> MemoryResult<()> {
        self.store.record_wiki_page(page)?;
        self.bump_briefing_generation(&page.user_id, &page.workspace_id);
        Ok(())
    }

    pub fn upsert_embedding(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        model: &str,
        vector: &[f32],
    ) -> MemoryResult<()> {
        self.store
            .upsert_embedding(reference, user_id, workspace_id, model, vector)?;
        self.bump_briefing_generation(user_id, workspace_id);
        self.update_vector_index_cache(reference, user_id, workspace_id, vector)?;
        Ok(())
    }

    pub fn list_embeddings(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> MemoryResult<Vec<(MemoryRef, Vec<f32>)>> {
        Ok(self.store.list_embeddings(user_id, workspace_id)?)
    }

    pub fn search_embeddings(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        query: &[f32],
        limit: usize,
    ) -> MemoryResult<Vec<VectorHit>> {
        let key = vector_index_scope_key(user_id, workspace_id);
        let mut indexes = self
            .vector_indexes
            .lock()
            .map_err(|_| MemoryError::Store("memory vector index cache poisoned".to_string()))?;
        if !indexes.contains_key(&key) {
            let embeddings = self.store.list_embeddings(user_id, workspace_id)?;
            let index = crate::MemoryVectorIndexCache::from_embeddings(embeddings)?;
            indexes.insert(key.clone(), index);
        }
        let Some(index) = indexes.get(&key) else {
            return Ok(Vec::new());
        };
        crate::MemoryVectorIndex::search(index, query, limit)
    }

    /// Dense search for a single authorized source. This derived cache is
    /// separate from the full scoped index and its key includes effective policy
    /// plus source generation, so stale/denied embeddings cannot influence a hit.
    pub fn search_authorized_embeddings(
        &self,
        source: &AuthorizedMemorySource,
        query: &[f32],
        limit: usize,
    ) -> MemoryResult<Vec<VectorHit>> {
        let key = AuthorizedVectorIndexKey {
            source_user_id: source.source_user_id.as_str().to_string(),
            source_workspace_id: source.source_workspace_id.as_str().to_string(),
            policy_fingerprint: crate::memory_source_policy_fingerprint(std::slice::from_ref(
                source,
            )),
            source_generation: self
                .briefing_generation(&source.source_user_id, &source.source_workspace_id),
        };
        {
            let indexes = self.authorized_vector_indexes.lock().map_err(|_| {
                MemoryError::Store("authorized memory vector index cache poisoned".to_string())
            })?;
            if let Some(index) = indexes.get(&key) {
                return crate::MemoryVectorIndex::search(index, query, limit);
            }
        }

        let allowed_refs: std::collections::HashSet<MemoryRef> = self
            .store
            .list_memories(&source.source_user_id, &source.source_workspace_id)?
            .into_iter()
            .filter(|memory| self.memory_is_allowed_for_source(source, memory))
            .map(|memory| memory.reference)
            .collect();
        let embeddings = self
            .store
            .list_embeddings(&source.source_user_id, &source.source_workspace_id)?
            .into_iter()
            .filter(|(reference, _)| allowed_refs.contains(reference));
        let index = crate::MemoryVectorIndexCache::from_embeddings(embeddings)?;
        let result = crate::MemoryVectorIndex::search(&index, query, limit)?;
        let mut indexes = self.authorized_vector_indexes.lock().map_err(|_| {
            MemoryError::Store("authorized memory vector index cache poisoned".to_string())
        })?;
        indexes.entry(key.clone()).or_insert(index);
        while indexes.len() > AUTHORIZED_VECTOR_INDEX_CACHE_MAX {
            let eviction_key = indexes
                .keys()
                .min_by(|left, right| {
                    (
                        left.source_generation,
                        left.source_user_id.as_str(),
                        left.source_workspace_id.as_str(),
                        left.policy_fingerprint,
                    )
                        .cmp(&(
                            right.source_generation,
                            right.source_user_id.as_str(),
                            right.source_workspace_id.as_str(),
                            right.policy_fingerprint,
                        ))
                })
                .cloned();
            let Some(eviction_key) = eviction_key else {
                break;
            };
            indexes.remove(&eviction_key);
        }
        Ok(result)
    }

    fn update_vector_index_cache(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        vector: &[f32],
    ) -> MemoryResult<()> {
        let key = vector_index_scope_key(user_id, workspace_id);
        let mut indexes = self
            .vector_indexes
            .lock()
            .map_err(|_| MemoryError::Store("memory vector index cache poisoned".to_string()))?;
        if let Some(index) = indexes.get_mut(&key) {
            crate::MemoryVectorIndex::upsert(index, reference, vector)?;
        }
        Ok(())
    }

    #[doc(hidden)]
    pub fn vector_index_cache_len_for_tests(&self) -> usize {
        self.vector_indexes
            .lock()
            .map(|indexes| indexes.len())
            .unwrap_or_default()
    }

    #[doc(hidden)]
    pub fn authorized_vector_index_cache_len_for_tests(&self) -> usize {
        self.authorized_vector_indexes
            .lock()
            .map(|indexes| indexes.len())
            .unwrap_or_default()
    }

    #[doc(hidden)]
    pub fn authorized_vector_index_cache_workspaces_for_tests(&self) -> Vec<String> {
        let mut workspaces = self
            .authorized_vector_indexes
            .lock()
            .map(|indexes| {
                indexes
                    .keys()
                    .map(|key| key.source_workspace_id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        workspaces.sort();
        workspaces
    }

    #[doc(hidden)]
    pub fn vector_index_backend_for_tests(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Option<&'static str> {
        let key = vector_index_scope_key(user_id, workspace_id);
        self.vector_indexes
            .lock()
            .ok()
            .and_then(|indexes| indexes.get(&key).map(|index| index.backend_name()))
    }

    pub fn refs_without_embeddings(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        limit: usize,
    ) -> MemoryResult<Vec<MemoryRef>> {
        Ok(self
            .store
            .refs_without_embeddings(user_id, workspace_id, limit)?)
    }

    pub fn apply_extraction(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        extraction: MemoryExtraction,
    ) -> MemoryResult<MemoryExtractionSummary> {
        let mut memory_refs = Vec::new();
        let mut entity_refs = Vec::new();
        let mut relation_refs = Vec::new();
        let mut evidence_links_imported = 0;

        for extracted in extraction.memories {
            let reference =
                MemoryRef::generated(MemoryRefKind::Memory, user_id.clone(), workspace_id.clone());
            let evidence_refs = extracted.evidence_refs.clone();
            let now = current_timestamp();
            let memory = MemoryRecord {
                reference: reference.clone(),
                user_id: user_id.clone(),
                workspace_id: workspace_id.clone(),
                memory_type: extracted.memory_type,
                text: extracted.text,
                aliases: extracted.aliases,
                language_hints: extracted.language_hints,
                confidence: extracted.confidence,
                status: MemoryStatus::Candidate,
                privacy_domain: extracted.privacy_domain,
                sensitivity: extracted.sensitivity,
                metadata: extracted.metadata,
                created_at: now.clone(),
                updated_at: now.clone(),
                last_seen_at: Some(now),
                supersedes: vec![],
                superseded_by: None,
                correction_of: None,
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

    pub fn apply_routine_inference(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        inference: RoutineInference,
    ) -> MemoryResult<RoutineInferenceSummary> {
        let mut routine_refs = Vec::new();
        for extracted in inference.routines {
            let now = current_timestamp();
            let reference = MemoryRef::generated(
                MemoryRefKind::Routine,
                user_id.clone(),
                workspace_id.clone(),
            );
            let routine = RoutineRecord {
                reference: reference.clone(),
                user_id: user_id.clone(),
                workspace_id: workspace_id.clone(),
                name: extracted.name,
                intent: extracted.intent,
                confidence: extracted.confidence,
                status: RoutineStatus::Candidate,
                schedule_hint: extracted.schedule_hint,
                privacy_domain: extracted.privacy_domain,
                sensitivity: extracted.sensitivity,
                evidence: extracted
                    .evidence_refs
                    .iter()
                    .map(|reference| MemoryRef::from_str(reference))
                    .collect::<Result<Vec<_>, _>>()?,
                metadata: extracted.metadata,
                created_at: now.clone(),
                updated_at: now,
            };
            self.store.upsert_routine(&routine)?;
            routine_refs.push(reference);
        }
        Ok(RoutineInferenceSummary {
            routines_imported: routine_refs.len(),
            routine_refs,
        })
    }

    pub fn propose_automation(
        &self,
        create: AutomationCandidateCreateRequest,
    ) -> MemoryResult<AutomationCandidateRecord> {
        if let Some(routine_ref) = &create.routine_ref
            && (routine_ref.user_id != create.request.user_id
                || routine_ref.workspace_id != create.request.workspace_id)
        {
            return Err(MemoryError::validation(
                "cannot propose automation for routine outside user/workspace",
            ));
        }
        let now = current_timestamp();
        let reference = MemoryRef::generated(
            MemoryRefKind::Automation,
            create.request.user_id.clone(),
            create.request.workspace_id.clone(),
        );
        let candidate = AutomationCandidateRecord {
            reference,
            user_id: create.request.user_id,
            workspace_id: create.request.workspace_id,
            routine_ref: create.routine_ref,
            title: create.title,
            summary: create.summary,
            trigger: create.trigger,
            actions: create.actions,
            risk_level: create.risk_level,
            autonomy_level: create.autonomy_level,
            status: create.status,
            privacy_domain: create.privacy_domain,
            sensitivity: create.sensitivity,
            evidence: create.evidence_refs,
            proposal_json: create.proposal_json,
            created_at: now.clone(),
            updated_at: now,
        };
        self.store.upsert_automation_candidate(&candidate)?;
        Ok(candidate)
    }

    /// Entities of a scope INCLUDING tombstoned ones, each with its tombstoned flag.
    /// Regeneration uses this to resurrect entities a previous orphan-sweep killed.
    pub fn list_entities_including_tombstoned(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> MemoryResult<Vec<(MemoryEntity, bool)>> {
        Ok(self
            .store
            .list_entities_including_tombstoned(user_id, workspace_id)?)
    }

    /// Re-point every relation of one entity onto another (entity merge).
    pub fn repoint_relations(
        &self,
        from_ref: &MemoryRef,
        to_ref: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> MemoryResult<()> {
        Ok(self
            .store
            .repoint_relations(from_ref, to_ref, user_id, workspace_id)?)
    }

    /// Canonical entity merge: keep `survivor_ref`, move graph edges from
    /// `absorbed_ref`, fold aliases/metadata, and tombstone the absorbed node.
    pub fn merge_entities(
        &self,
        survivor_ref: &MemoryRef,
        absorbed_ref: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        reason: &str,
    ) -> MemoryResult<MemoryEntity> {
        if survivor_ref == absorbed_ref {
            return self
                .store
                .get_entity(survivor_ref, user_id, workspace_id)?
                .ok_or_else(|| MemoryError::not_found(survivor_ref.to_string()));
        }
        let mut survivor = self
            .store
            .get_entity(survivor_ref, user_id, workspace_id)?
            .ok_or_else(|| MemoryError::not_found(survivor_ref.to_string()))?;
        let mut absorbed = self
            .store
            .get_entity(absorbed_ref, user_id, workspace_id)?
            .ok_or_else(|| MemoryError::not_found(absorbed_ref.to_string()))?;

        let mut aliases: std::collections::BTreeSet<String> = survivor
            .aliases
            .iter()
            .filter(|a| !a.trim().is_empty())
            .cloned()
            .collect();
        for value in absorbed
            .aliases
            .iter()
            .chain(std::iter::once(&absorbed.name))
            .chain(std::iter::once(&absorbed.canonical_key))
        {
            if !value.trim().is_empty() && value != &survivor.canonical_key {
                aliases.insert(value.trim().to_string());
            }
        }
        survivor.aliases = aliases.into_iter().collect();
        merge_entity_metadata(
            &mut survivor.metadata,
            &absorbed.metadata,
            absorbed_ref,
            reason,
        );
        if let serde_json::Value::Object(map) = &mut absorbed.metadata {
            map.insert(
                "merged_into".to_string(),
                serde_json::Value::String(survivor_ref.to_string()),
            );
            map.insert(
                "merge_reason".to_string(),
                serde_json::Value::String(reason.to_string()),
            );
        } else {
            absorbed.metadata = serde_json::json!({
                "merged_into": survivor_ref.to_string(),
                "merge_reason": reason,
            });
        }

        self.store.upsert_entity(&survivor)?;
        self.store.upsert_entity(&absorbed)?;
        self.store
            .repoint_relations(absorbed_ref, survivor_ref, user_id, workspace_id)?;
        self.store
            .tombstone(absorbed_ref, user_id, workspace_id, reason)?;
        Ok(survivor)
    }

    /// Change a memory's type (e.g. promote a decision to a goal). User-driven, no LLM.
    pub fn set_memory_type(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        new_type: &str,
    ) -> MemoryResult<()> {
        Ok(self
            .store
            .set_memory_type(reference, user_id, workspace_id, new_type)?)
    }

    /// Drop a scope's imported code-graph (entities/relations source="graphify"),
    /// before a re-import (idempotent project-graph rebuild).
    pub fn clear_graphify(&self, user_id: &UserId, workspace_id: &WorkspaceId) -> MemoryResult<()> {
        Ok(self.store.clear_graphify(user_id, workspace_id)?)
    }

    /// Find imported code entities whose name matches any term (briefing "already exists").
    pub fn search_code_entities(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        terms: &[String],
        limit: usize,
    ) -> MemoryResult<Vec<(String, String, String)>> {
        Ok(self
            .store
            .search_code_entities(user_id, workspace_id, terms, limit)?)
    }

    /// Bulk-replace a scope's imported code graph in one transaction (clear + insert).
    /// Returns (entities, relations) written. Scales to tens of thousands of records.
    pub fn import_graphify_batch(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        entities: &[MemoryEntity],
        relations: &[MemoryRelation],
    ) -> MemoryResult<(usize, usize)> {
        Ok(self
            .store
            .import_graphify_batch(user_id, workspace_id, entities, relations)?)
    }

    /// Normalize and atomically replace one workspace's derived project graph.
    /// A failed write preserves the previously committed projection.
    pub fn import_graphify_value(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        graph: &serde_json::Value,
    ) -> MemoryResult<ProjectGraphImportReport> {
        let normalized = normalize_graphify_value(
            graph,
            user_id,
            workspace_id,
            PrivacyDomain::new("personal"),
            DataSensitivity::Internal,
        )
        .map_err(|error| match error {
            ProjectGraphImportError::InvalidRoot | ProjectGraphImportError::InvalidJson(_) => {
                MemoryError::validation(error.to_string())
            }
            ProjectGraphImportError::Store(_) => MemoryError::Store(error.to_string()),
        })?;
        let report = normalized.report.clone();
        let (entities, relations) = self.store.import_graphify_batch(
            user_id,
            workspace_id,
            &normalized.entities,
            &normalized.relations,
        )?;
        if entities != report.unique_nodes || relations != report.unique_edges {
            return Err(MemoryError::Store(format!(
                "graphify import report mismatch: expected {}/{} entities/relations, stored {entities}/{relations}",
                report.unique_nodes, report.unique_edges
            )));
        }
        self.bump_briefing_generation(user_id, workspace_id);
        Ok(report)
    }

    /// Resurrect an entity (drop its tombstone) — used when a live memory references it.
    pub fn untombstone_entity(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> MemoryResult<()> {
        Ok(self
            .store
            .untombstone_entity(reference, user_id, workspace_id)?)
    }

    /// Wipe the auto-derived "mentions" edges for a scope (graph regeneration
    /// deletes-then-rebuilds them from the live facts). Returns how many removed.
    pub fn clear_mention_links(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> MemoryResult<usize> {
        Ok(self.store.clear_mention_links(user_id, workspace_id)?)
    }

    /// Transition an automation candidate (approve/reject/execute/stale). The
    /// "agisci" loop calls this when the user accepts or declines a proposal.
    pub fn update_automation_status(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        status: AutomationCandidateStatus,
    ) -> MemoryResult<()> {
        Ok(self
            .store
            .set_automation_candidate_status(reference, user_id, workspace_id, &status)?)
    }

    pub fn context_pack(&self, request: &MemoryAccessRequest) -> MemoryResult<MemoryContextPack> {
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
            if memory.status != MemoryStatus::Confirmed {
                continue;
            }
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

    pub fn search_memories(&self, request: MemorySearchRequest) -> MemoryResult<MemorySearchPage> {
        let refs = self.store.search_memory_refs(
            &request.access.user_id,
            &request.access.workspace_id,
            &request.query,
        )?;
        let mut allowed = Vec::new();
        for reference in refs {
            let Some(memory) = self.store.get_memory(
                &reference,
                &request.access.user_id,
                &request.access.workspace_id,
            )?
            else {
                continue;
            };
            let decision = self.policy.decide_memory(&request.access, &memory);
            self.store
                .record_access_decision(&request.access, &decision)?;
            if decision.kind == AccessDecisionKind::Deny {
                continue;
            }
            if !request.statuses.is_empty() && !request.statuses.contains(&memory.status) {
                continue;
            }
            if !request.memory_types.is_empty()
                && !request
                    .memory_types
                    .iter()
                    .any(|memory_type| memory_type == &memory.memory_type)
            {
                continue;
            }
            allowed.push(memory);
        }

        let total = allowed.len();
        let items = allowed
            .into_iter()
            .skip(request.offset)
            .take(request.limit)
            .enumerate()
            .map(|(index, memory)| MemorySearchResult {
                reference: memory.reference,
                memory_type: memory.memory_type,
                summary: memory.text,
                metadata: memory.metadata,
                status: memory.status,
                privacy_domain: memory.privacy_domain,
                sensitivity: memory.sensitivity,
                rank: request.offset + index + 1,
            })
            .collect();

        Ok(MemorySearchPage {
            items,
            total,
            limit: request.limit,
            offset: request.offset,
        })
    }

    /// Lexical search constrained by the compiled source policy before a
    /// record is admitted to the returned candidate set.
    pub fn search_authorized_memories(
        &self,
        request: AuthorizedMemorySearchRequest,
    ) -> MemoryResult<MemorySearchPage> {
        let (refs, total) = self.store.search_memory_refs_filtered(
            &request.access.user_id,
            &request.access.workspace_id,
            &request.query,
            request.limit,
            request.offset,
            |memory| self.memory_is_allowed_for_authorized_search(&request, memory),
        )?;
        let mut allowed = Vec::with_capacity(refs.len());
        for reference in refs {
            let Some(memory) = self.store.get_visible_memory_exact(
                &reference,
                &request.access.user_id,
                &request.access.workspace_id,
            )?
            else {
                continue;
            };
            if !self.memory_is_allowed_for_authorized_search(&request, &memory) {
                continue;
            }
            let decision = self.policy.decide_memory(&request.access, &memory);
            self.store
                .record_access_decision(&request.access, &decision)?;
            allowed.push(memory);
        }

        let items = allowed
            .into_iter()
            .enumerate()
            .map(|(index, memory)| MemorySearchResult {
                reference: memory.reference,
                memory_type: memory.memory_type,
                summary: memory.text,
                metadata: memory.metadata,
                status: memory.status,
                privacy_domain: memory.privacy_domain,
                sensitivity: memory.sensitivity,
                rank: request.offset + index + 1,
            })
            .collect();

        Ok(MemorySearchPage {
            items,
            total,
            limit: request.limit.min(AUTHORIZED_MEMORY_SEARCH_LIMIT_MAX),
            offset: request.offset,
        })
    }

    fn memory_is_allowed_for_authorized_search(
        &self,
        request: &AuthorizedMemorySearchRequest,
        memory: &MemoryRecord,
    ) -> bool {
        self.policy.decide_memory(&request.access, memory).kind != AccessDecisionKind::Deny
            && request
                .source_policy
                .as_ref()
                .is_none_or(|policy| policy.allows(memory).is_allowed())
            && !is_published_alias(memory)
            && (request.statuses.is_empty() || request.statuses.contains(&memory.status))
            && (request.memory_types.is_empty()
                || request
                    .memory_types
                    .iter()
                    .any(|memory_type| memory_type == &memory.memory_type))
    }

    /// Revalidation used immediately before a hit is materialized. Keeping it
    /// on the facade composes exact source scope, base privacy policy and grant
    /// policy without widening `MemoryPolicyEngine` to cross-scope access.
    pub fn get_authorized_memory_for_source(
        &self,
        source: &AuthorizedMemorySource,
        reference: &MemoryRef,
    ) -> MemoryResult<Option<MemoryRecord>> {
        let Some(memory) = self.store.get_visible_memory_exact(
            reference,
            &source.source_user_id,
            &source.source_workspace_id,
        )?
        else {
            return Ok(None);
        };
        Ok(self
            .memory_is_allowed_for_source(source, &memory)
            .then_some(memory))
    }

    /// Canonical subject derived only from the typed graph relation used by
    /// the existing mention linker (`memory --mentions--> entity`). Multiple
    /// distinct entities are ambiguous and fail closed.
    pub fn canonical_subject_key_for_memory(
        &self,
        source: &AuthorizedMemorySource,
        reference: &MemoryRef,
    ) -> MemoryResult<Option<String>> {
        if reference.kind != MemoryRefKind::Memory
            || reference.user_id != source.source_user_id
            || reference.workspace_id != source.source_workspace_id
        {
            return Ok(None);
        }
        let max_sensitivity = source
            .policy
            .as_ref()
            .map(|policy| policy.max_sensitivity)
            .unwrap_or(DataSensitivity::Private);
        let mut subject = None::<String>;
        for relation in self.store.visible_relations_for_exact(
            reference,
            &source.source_user_id,
            &source.source_workspace_id,
        )? {
            if relation.relation_type != "mentions"
                || relation.source_ref != *reference
                || relation.target_ref.kind != MemoryRefKind::Entity
                || relation.target_ref.user_id != source.source_user_id
                || relation.target_ref.workspace_id != source.source_workspace_id
                || !matches!(
                    relation.privacy_domain.as_str(),
                    "personal" | "work" | "general"
                )
                || relation.sensitivity == DataSensitivity::Secret
                || relation.sensitivity > max_sensitivity
                || contains_secret(&relation.metadata)
            {
                continue;
            }
            let Some(entity) = self.store.get_visible_entity_exact(
                &relation.target_ref,
                &source.source_user_id,
                &source.source_workspace_id,
            )?
            else {
                continue;
            };
            let canonical_key = entity.canonical_key.trim();
            let payload = serde_json::json!({
                "canonical_key": canonical_key,
                "metadata": &entity.metadata,
            });
            if canonical_key.is_empty()
                || entity.reference.key != canonical_key
                || !matches!(
                    entity.privacy_domain.as_str(),
                    "personal" | "work" | "general"
                )
                || entity.sensitivity == DataSensitivity::Secret
                || entity.sensitivity > max_sensitivity
                || contains_secret(&payload)
            {
                continue;
            }
            match subject.as_deref() {
                None => subject = Some(canonical_key.to_string()),
                Some(existing) if existing == canonical_key => {}
                Some(_) => return Ok(None),
            }
        }
        Ok(subject)
    }

    fn memory_is_allowed_for_source(
        &self,
        source: &AuthorizedMemorySource,
        memory: &MemoryRecord,
    ) -> bool {
        if memory.user_id != source.source_user_id
            || memory.workspace_id != source.source_workspace_id
            || !matches!(
                memory.status,
                MemoryStatus::Candidate | MemoryStatus::Confirmed
            )
            || is_published_alias(memory)
        {
            return false;
        }
        let access = MemoryAccessRequest {
            actor_id: "chat_rag".to_string(),
            user_id: source.source_user_id.clone(),
            workspace_id: source.source_workspace_id.clone(),
            purpose: "chat_context".to_string(),
            allowed_domains: vec![
                PrivacyDomain::new("personal"),
                PrivacyDomain::new("work"),
                PrivacyDomain::new("general"),
            ],
            max_sensitivity: source
                .policy
                .as_ref()
                .map(|policy| policy.max_sensitivity)
                .unwrap_or(DataSensitivity::Private),
            allow_raw_payload: false,
            allow_export: true,
            broad_query: false,
        };
        self.policy.decide_memory(&access, memory).kind != AccessDecisionKind::Deny
            && source
                .policy
                .as_ref()
                .is_none_or(|policy| policy.allows(memory).is_allowed())
    }

    pub fn project_to_wiki(
        &self,
        wiki: &WikiFileStore,
        projection: &MemoryWikiProjection,
    ) -> MemoryResult<()> {
        wiki.write_page(&self.store, &projection.page)?;
        self.bump_briefing_generation(&projection.page.user_id, &projection.page.workspace_id);
        Ok(())
    }

    pub fn import_wiki_correction(
        &self,
        request: &MemoryLifecycleRequest,
        markdown: &str,
    ) -> MemoryResult<WikiCorrectionSyncReport> {
        let parsed = parse_wiki_markdown(markdown)?;
        if parsed.user_id != request.user_id || parsed.workspace_id != request.workspace_id {
            self.audit_lifecycle(
                request,
                AccessDecisionKind::Deny,
                vec!["scope_mismatch".to_string()],
            )?;
            return Err(MemoryError::validation(
                "cannot import wiki correction outside user/workspace",
            ));
        }
        let Some(correction_of) = parsed.linked_refs.first().cloned() else {
            return Ok(WikiCorrectionSyncReport {
                created_candidates: 0,
                unchanged: 0,
                conflicted: 0,
                rejected: 1,
                candidate_refs: vec![],
            });
        };

        if let Some(existing_page) =
            self.store
                .get_wiki_page(&parsed.wiki_ref, &request.user_id, &request.workspace_id)?
        {
            if existing_page.body.trim() == parsed.body.trim() {
                self.audit_lifecycle(request, AccessDecisionKind::Allow, vec![])?;
                return Ok(WikiCorrectionSyncReport {
                    created_candidates: 0,
                    unchanged: 1,
                    conflicted: 0,
                    rejected: 0,
                    candidate_refs: vec![],
                });
            }
        }

        let now = current_timestamp();
        let candidate_ref = MemoryRef::generated(
            MemoryRefKind::Memory,
            request.user_id.clone(),
            request.workspace_id.clone(),
        );
        let candidate = MemoryRecord {
            reference: candidate_ref.clone(),
            user_id: request.user_id.clone(),
            workspace_id: request.workspace_id.clone(),
            memory_type: "wiki_correction".to_string(),
            text: parsed.body,
            aliases: vec![parsed.title],
            language_hints: vec![],
            confidence: 0.5,
            status: MemoryStatus::Candidate,
            privacy_domain: parsed.privacy_domain,
            sensitivity: parsed.sensitivity,
            metadata: serde_json::json!({
                "source": "wiki_sync",
                "wiki_ref": parsed.wiki_ref.to_string()
            }),
            created_at: now.clone(),
            updated_at: now.clone(),
            last_seen_at: Some(now),
            supersedes: vec![],
            superseded_by: None,
            correction_of: Some(correction_of),
        };
        self.store.upsert_memory(&candidate)?;
        self.audit_lifecycle(request, AccessDecisionKind::Allow, vec![])?;
        self.bump_briefing_generation(&request.user_id, &request.workspace_id);
        Ok(WikiCorrectionSyncReport {
            created_candidates: 1,
            unchanged: 0,
            conflicted: 0,
            rejected: 0,
            candidate_refs: vec![candidate_ref],
        })
    }

    pub fn import_graphify_artifacts(
        &self,
        artifacts: &GraphifyArtifacts,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        privacy_domain: PrivacyDomain,
        sensitivity: DataSensitivity,
    ) -> MemoryResult<GraphifyImportSummary> {
        Ok(GraphifyImport::new(&self.store).import_artifacts(
            artifacts,
            user_id,
            workspace_id,
            privacy_domain,
            sensitivity,
        )?)
    }

    pub fn graphify_query(
        &self,
        request: GraphifyQueryRequest,
    ) -> MemoryResult<GraphifyQueryResult> {
        ensure_artifacts_inside_root(&request.artifacts, &request.allowed_output_root)?;
        if matches!(request.operation, GraphifyOperation::Query { .. })
            && !request.access.allow_export
        {
            self.store.record_access_decision(
                &request.access,
                &MemoryAccessDecision::deny("export_not_allowed"),
            )?;
            return Err(MemoryError::policy(
                "graphify query requires export permission",
            ));
        }

        let cli = GraphifyCli::new("graphify");
        let command = match &request.operation {
            GraphifyOperation::Query { question, budget } => {
                cli.query_args(&request.artifacts, question, *budget)
            }
            GraphifyOperation::Path { source, target } => {
                cli.path_args(&request.artifacts, source, target)
            }
            GraphifyOperation::Explain { label } => cli.explain_args(&request.artifacts, label),
        };

        let entity_refs = self
            .store
            .list_entities(&request.access.user_id, &request.access.workspace_id)?
            .into_iter()
            .filter(|entity| {
                request
                    .access
                    .allowed_domains
                    .iter()
                    .any(|domain| domain == &entity.privacy_domain)
                    && entity.sensitivity <= request.access.max_sensitivity
            })
            .map(|entity| entity.reference)
            .collect::<Vec<_>>();
        let relation_refs = self
            .store
            .list_relations(&request.access.user_id, &request.access.workspace_id)?
            .into_iter()
            .filter(|relation| {
                request
                    .access
                    .allowed_domains
                    .iter()
                    .any(|domain| domain == &relation.privacy_domain)
                    && relation.sensitivity <= request.access.max_sensitivity
            })
            .map(|relation| relation.reference)
            .collect::<Vec<_>>();

        self.store
            .record_access_decision(&request.access, &MemoryAccessDecision::allow())?;
        Ok(GraphifyQueryResult {
            command,
            summaries: vec![format!(
                "Graphify {:?} scoped to {} entities and {} relations",
                request.operation,
                entity_refs.len(),
                relation_refs.len()
            )],
            entity_refs,
            relation_refs,
        })
    }

    pub fn access_audit_count(&self) -> MemoryResult<u64> {
        Ok(self.store.access_audit_count()?)
    }

    pub fn memory_health(&self) -> MemoryResult<MemoryHealth> {
        Ok(self.store.health()?)
    }

    pub fn upsert_memory_source_grant(&self, grant: &MemorySourceGrant) -> MemoryResult<()> {
        crate::store::validate_memory_source_grant(grant).map_err(MemoryError::validation)?;
        self.store
            .upsert_memory_source_grant(grant)
            .map_err(memory_source_grant_error)
    }

    pub fn list_memory_source_grants(
        &self,
        consumer_user_id: &UserId,
        consumer_workspace_id: &WorkspaceId,
    ) -> MemoryResult<Vec<MemorySourceGrant>> {
        Ok(self
            .store
            .list_memory_source_grants(consumer_user_id, consumer_workspace_id)
            .map_err(memory_source_grant_error)?)
    }

    pub fn resolve_memory_sources(
        &self,
        user: &UserId,
        workspace: &WorkspaceId,
        now_unix: i64,
    ) -> MemoryResult<Vec<AuthorizedMemorySource>> {
        if workspace.as_str() == PERSONAL_WORKSPACE {
            return crate::resolve_memory_sources(user, workspace, &[], now_unix)
                .map_err(MemoryError::validation);
        }
        let grants = self.list_memory_source_grants(user, workspace)?;
        crate::resolve_memory_sources(user, workspace, &grants, now_unix).map_err(|error| {
            if matches!(
                error.as_str(),
                "duplicate_active_source" | "duplicate_grant_id"
            ) {
                MemoryError::Store(error)
            } else {
                MemoryError::validation(error)
            }
        })
    }

    pub fn get_memory_source_grant(
        &self,
        consumer_user_id: &UserId,
        consumer_workspace_id: &WorkspaceId,
        id: &str,
    ) -> MemoryResult<Option<MemorySourceGrant>> {
        self.store
            .get_memory_source_grant(consumer_user_id, consumer_workspace_id, id)
            .map_err(memory_source_grant_error)
    }

    pub fn revoke_memory_source_grant(
        &self,
        consumer_user_id: &UserId,
        consumer_workspace_id: &WorkspaceId,
        id: &str,
        revoked_at: i64,
    ) -> MemoryResult<()> {
        self.store
            .revoke_memory_source_grant(consumer_user_id, consumer_workspace_id, id, revoked_at)
            .map_err(memory_source_grant_error)
    }

    pub fn record_memory_source_access(
        &self,
        event: &crate::MemorySourceAccessEvent,
    ) -> MemoryResult<()> {
        self.store
            .record_memory_source_access(event)
            .map_err(MemoryError::from)
    }

    pub fn last_memory_source_access(
        &self,
        grant_id: &str,
    ) -> MemoryResult<Option<crate::MemorySourceAccessEvent>> {
        self.store
            .last_memory_source_access(grant_id)
            .map_err(MemoryError::from)
    }

    pub fn create_publication_proposal(
        &self,
        source: &MemoryRecord,
        destination: &MemoryPublicationDestination,
        actor: &str,
    ) -> MemoryResult<MemoryPublicationProposal> {
        self.create_publication_proposal_with_edit(source, destination, actor, None)
    }

    pub fn create_publication_proposal_with_edit(
        &self,
        source: &MemoryRecord,
        destination: &MemoryPublicationDestination,
        actor: &str,
        edit: Option<&MemoryPublicationEditInput>,
    ) -> MemoryResult<MemoryPublicationProposal> {
        self.validate_publication_actor_and_destination(source, destination, actor)?;
        let source =
            self.load_publication_source(&source.reference, &source.user_id, &source.workspace_id)?;
        self.validate_publication_source(&source)?;
        let source_evidence = self
            .store
            .evidence_for(&source.reference, &source.user_id, &source.workspace_id)
            .map_err(MemoryError::Store)?;
        let source_revision = publication_source_revision(&source, &source_evidence)?;
        let (destination_snapshot, destination_revision) =
            self.publication_destination_snapshot(destination)?;

        // Opening the publish UI again is a resume operation, not a second
        // request. Only the server-first/no-edit path may resume: it returns
        // the exact persisted draft (including review edits and its version).
        if edit.is_none() {
            for _ in 0..8 {
                let Some(pending) = self
                    .store
                    .pending_memory_publication_for_source(&source.reference)
                    .map_err(memory_publication_error)?
                else {
                    break;
                };
                let same_owner_and_destination = pending.proposed_by == actor
                    && pending.source_user_id == source.user_id
                    && pending.source_workspace_id == source.workspace_id
                    && pending.destination_user_id == destination.user_id
                    && pending.destination_workspace_id == destination.workspace_id;
                if !same_owner_and_destination {
                    return Err(MemoryError::policy("publication_already_pending"));
                }
                if pending.source_revision == source_revision {
                    if pending.destination_revision == destination_revision {
                        return Ok(pending);
                    }
                    match self.rebase_publication_destination(
                        &pending,
                        &source,
                        destination,
                        &destination_snapshot,
                        destination_revision.clone(),
                        actor,
                    ) {
                        Ok(rebased) => return Ok(rebased),
                        Err(MemoryError::Policy(message)) if message == "publication_conflict" => {
                            continue;
                        }
                        Err(error) => return Err(error),
                    }
                }
                match self.store.mark_memory_publication_failed(
                    &pending.id,
                    actor,
                    pending.proposal_version,
                    "publication_source_changed",
                    &current_timestamp(),
                ) {
                    Ok(_) => continue,
                    Err(MemoryPublicationStoreError::Conflict(_)) => continue,
                    Err(error) => return Err(memory_publication_error(error)),
                }
            }
        }

        let proposed = publication_edited_payload(&source, edit)?;
        let proposed_collection = MemoryCollectionKey::for_memory(&proposed)
            .ok_or_else(|| MemoryError::validation("publication_collection_unknown"))?;
        let candidate = Self::find_publication_candidate_in(
            &destination_snapshot,
            &proposed,
            proposed_collection,
        );
        let now = current_timestamp();
        let proposal = MemoryPublicationProposal {
            id: uuid::Uuid::new_v4().to_string(),
            proposal_version: 1,
            source_ref: source.reference.clone(),
            source_user_id: source.user_id.clone(),
            source_workspace_id: source.workspace_id.clone(),
            destination_user_id: destination.user_id.clone(),
            destination_workspace_id: destination.workspace_id.clone(),
            proposed_text: proposed.text,
            proposed_memory_type: proposed.memory_type,
            proposed_collection,
            proposed_privacy_domain: proposed.privacy_domain,
            proposed_sensitivity: proposed.sensitivity,
            source_revision: source_revision.clone(),
            destination_revision: destination_revision.clone(),
            reason_code: publication_pending_reason(candidate.as_ref()),
            candidate,
            resolution: None,
            status: MemoryPublicationStatus::Pending,
            failure_reason: None,
            proposed_by: actor.to_string(),
            decided_by: None,
            created_at: now.clone(),
            updated_at: now,
        };
        match self.store.create_memory_publication_proposal(&proposal) {
            Ok(()) => Ok(proposal),
            // A concurrent no-edit create may have won after our resumability
            // read. Reload its exact persisted preview rather than producing a
            // duplicate or forcing the UI to reject it.
            Err(MemoryPublicationStoreError::Conflict(message))
                if edit.is_none() && message == "publication_already_pending" =>
            {
                let pending = self
                    .store
                    .pending_memory_publication_for_source(&source.reference)
                    .map_err(memory_publication_error)?
                    .ok_or_else(|| MemoryError::policy("publication_conflict"))?;
                let same_owner_and_destination = pending.proposed_by == actor
                    && pending.source_user_id == source.user_id
                    && pending.source_workspace_id == source.workspace_id
                    && pending.destination_user_id == destination.user_id
                    && pending.destination_workspace_id == destination.workspace_id;
                if same_owner_and_destination
                    && pending.source_revision == source_revision
                    && pending.destination_revision == destination_revision
                {
                    Ok(pending)
                } else if same_owner_and_destination {
                    // The winner was built from a now-stale source. Terminally
                    // fail it by version and re-enter the normal resume/create
                    // path, which reloads whichever proposal wins next.
                    if pending.source_revision == source_revision {
                        return self.rebase_publication_destination(
                            &pending,
                            &source,
                            destination,
                            &destination_snapshot,
                            destination_revision,
                            actor,
                        );
                    }
                    match self.store.mark_memory_publication_failed(
                        &pending.id,
                        actor,
                        pending.proposal_version,
                        "publication_source_changed",
                        &current_timestamp(),
                    ) {
                        Ok(_) | Err(MemoryPublicationStoreError::Conflict(_)) => {
                            self.create_publication_proposal(&source, destination, actor)
                        }
                        Err(error) => Err(memory_publication_error(error)),
                    }
                } else {
                    Err(MemoryError::policy("publication_conflict"))
                }
            }
            Err(error) => Err(memory_publication_error(error)),
        }
    }

    pub fn get_publication_proposal(
        &self,
        id: &str,
    ) -> MemoryResult<Option<MemoryPublicationProposal>> {
        self.store
            .get_memory_publication_proposal(id)
            .map_err(memory_publication_error)
    }

    /// Revalidates a pending proposal after an explicit user edit. The source is
    /// always reloaded here so a client can never turn stale recall data into a
    /// publication payload.
    pub fn update_publication_proposal(
        &self,
        id: &str,
        actor: &str,
        edit: &MemoryPublicationEditInput,
    ) -> MemoryResult<MemoryPublicationProposal> {
        let version = self
            .get_publication_proposal(id)?
            .ok_or_else(|| MemoryError::not_found("publication_not_found"))?
            .proposal_version;
        self.update_publication_proposal_at_version(id, actor, version, edit)
    }

    pub fn update_publication_proposal_at_version(
        &self,
        id: &str,
        actor: &str,
        expected_version: u64,
        edit: &MemoryPublicationEditInput,
    ) -> MemoryResult<MemoryPublicationProposal> {
        let proposal = self
            .get_publication_proposal(id)?
            .ok_or_else(|| MemoryError::not_found("publication_not_found"))?;
        self.validate_publication_actor(&proposal, actor)?;
        if proposal.proposal_version != expected_version {
            return Err(MemoryError::policy("publication_conflict"));
        }
        if proposal.status != MemoryPublicationStatus::Pending {
            return Err(MemoryError::policy("publication_not_pending"));
        }
        let source = match self.load_publication_source(
            &proposal.source_ref,
            &proposal.source_user_id,
            &proposal.source_workspace_id,
        ) {
            Ok(source) => source,
            Err(error) => {
                self.mark_publication_failed_if_pending(
                    id,
                    actor,
                    expected_version,
                    error.as_str(),
                );
                return Err(error);
            }
        };
        if let Err(error) = self.validate_publication_source(&source) {
            self.mark_publication_failed_if_pending(id, actor, expected_version, error.as_str());
            return Err(error);
        }
        let source_evidence = self
            .store
            .evidence_for(&source.reference, &source.user_id, &source.workspace_id)
            .map_err(MemoryError::Store)?;
        if publication_source_revision(&source, &source_evidence)? != proposal.source_revision {
            self.mark_publication_failed_if_pending(
                id,
                actor,
                expected_version,
                "publication_source_changed",
            );
            return Err(MemoryError::policy("publication_source_changed"));
        }

        let proposed = publication_edited_payload(
            &publication_candidate_record(&source, &proposal),
            Some(edit),
        )?;
        let proposed_collection = MemoryCollectionKey::for_memory(&proposed)
            .ok_or_else(|| MemoryError::validation("publication_collection_unknown"))?;
        let destination = MemoryPublicationDestination::new(
            proposal.destination_user_id.clone(),
            proposal.destination_workspace_id.clone(),
        );
        let (destination_snapshot, destination_revision) =
            self.publication_destination_snapshot(&destination)?;
        let candidate = Self::find_publication_candidate_in(
            &destination_snapshot,
            &proposed,
            proposed_collection,
        );
        let mut updated = proposal;
        updated.proposed_text = proposed.text;
        updated.proposed_memory_type = proposed.memory_type;
        updated.proposed_collection = proposed_collection;
        updated.proposed_privacy_domain = proposed.privacy_domain;
        updated.proposed_sensitivity = proposed.sensitivity;
        updated.candidate = candidate;
        updated.destination_revision = destination_revision;
        updated.reason_code = publication_pending_reason(updated.candidate.as_ref());
        // Any prior decision is for the previous payload and must never carry
        // forward to a changed proposal.
        updated.resolution = None;
        updated.proposal_version = expected_version
            .checked_add(1)
            .ok_or_else(|| MemoryError::validation("publication_version_invalid"))?;
        updated.updated_at = current_timestamp();
        self.store
            .update_memory_publication_proposal(&updated, actor, expected_version)
            .map_err(memory_publication_error)
    }

    pub fn get_publication_link(
        &self,
        source_ref: &MemoryRef,
    ) -> MemoryResult<Option<MemoryPublicationLink>> {
        self.store
            .get_memory_publication_link(source_ref)
            .map_err(memory_publication_error)
    }

    pub fn set_publication_resolution(
        &self,
        id: &str,
        actor: &str,
        resolution: MemoryPublicationResolution,
    ) -> MemoryResult<MemoryPublicationProposal> {
        let version = self
            .get_publication_proposal(id)?
            .ok_or_else(|| MemoryError::not_found("publication_not_found"))?
            .proposal_version;
        self.set_publication_resolution_at_version(id, actor, version, resolution)
    }

    pub fn set_publication_resolution_at_version(
        &self,
        id: &str,
        actor: &str,
        expected_version: u64,
        resolution: MemoryPublicationResolution,
    ) -> MemoryResult<MemoryPublicationProposal> {
        let proposal = self
            .get_publication_proposal(id)?
            .ok_or_else(|| MemoryError::not_found("publication_not_found"))?;
        self.validate_publication_actor(&proposal, actor)?;
        if proposal.proposal_version != expected_version {
            return Err(MemoryError::policy("publication_conflict"));
        }
        if proposal.status != MemoryPublicationStatus::Pending {
            return Err(MemoryError::policy("publication_not_pending"));
        }
        let source = self.load_publication_source(
            &proposal.source_ref,
            &proposal.source_user_id,
            &proposal.source_workspace_id,
        )?;
        self.validate_publication_source(&source)?;
        let destination = MemoryPublicationDestination::new(
            proposal.destination_user_id.clone(),
            proposal.destination_workspace_id.clone(),
        );
        let (destination_snapshot, destination_revision) =
            self.publication_destination_snapshot(&destination)?;
        if proposal.destination_revision != destination_revision {
            match self.rebase_publication_destination(
                &proposal,
                &source,
                &destination,
                &destination_snapshot,
                destination_revision,
                actor,
            ) {
                Ok(_) | Err(MemoryError::Policy(_)) => {
                    return Err(MemoryError::policy("publication_preview_stale"));
                }
                Err(error) => return Err(error),
            }
        }
        let candidate = Self::find_publication_candidate_in(
            &destination_snapshot,
            &publication_candidate_record(&source, &proposal),
            proposal.proposed_collection,
        );
        if candidate != proposal.candidate
            || !publication_resolution_matches_candidate(&resolution, candidate.as_ref())
        {
            return Err(MemoryError::policy("publication_conflict"));
        }
        self.store
            .set_memory_publication_resolution(
                id,
                actor,
                expected_version,
                &resolution,
                &current_timestamp(),
            )
            .map_err(memory_publication_error)
    }

    pub fn reject_publication(
        &self,
        id: &str,
        actor: &str,
    ) -> MemoryResult<MemoryPublicationProposal> {
        let version = self
            .get_publication_proposal(id)?
            .ok_or_else(|| MemoryError::not_found("publication_not_found"))?
            .proposal_version;
        self.reject_publication_at_version(id, actor, version)
    }

    pub fn reject_publication_at_version(
        &self,
        id: &str,
        actor: &str,
        expected_version: u64,
    ) -> MemoryResult<MemoryPublicationProposal> {
        let proposal = self
            .get_publication_proposal(id)?
            .ok_or_else(|| MemoryError::not_found("publication_not_found"))?;
        self.validate_publication_actor(&proposal, actor)?;
        if proposal.proposal_version != expected_version {
            return Err(MemoryError::policy("publication_conflict"));
        }
        self.store
            .reject_memory_publication(id, actor, expected_version, &current_timestamp())
            .map_err(memory_publication_error)
    }

    pub fn approve_publication(
        &self,
        id: &str,
        actor: &str,
    ) -> MemoryResult<MemoryPublicationResult> {
        let version = self
            .get_publication_proposal(id)?
            .ok_or_else(|| MemoryError::not_found("publication_not_found"))?
            .proposal_version;
        self.approve_publication_at_version(id, actor, version)
    }

    pub fn approve_publication_at_version(
        &self,
        id: &str,
        actor: &str,
        expected_version: u64,
    ) -> MemoryResult<MemoryPublicationResult> {
        let proposal = self
            .get_publication_proposal(id)?
            .ok_or_else(|| MemoryError::not_found("publication_not_found"))?;
        self.validate_publication_actor(&proposal, actor)?;
        if proposal.proposal_version != expected_version {
            return Err(MemoryError::policy("publication_conflict"));
        }
        if proposal.status == MemoryPublicationStatus::Approved {
            return self.approved_publication_result(proposal);
        }
        if proposal.status != MemoryPublicationStatus::Pending {
            return Err(MemoryError::policy("publication_not_pending"));
        }

        let source = match self.load_publication_source(
            &proposal.source_ref,
            &proposal.source_user_id,
            &proposal.source_workspace_id,
        ) {
            Ok(source) => source,
            Err(error) => {
                self.mark_publication_failed_if_pending(
                    &proposal.id,
                    actor,
                    proposal.proposal_version,
                    error.as_str(),
                );
                return Err(error);
            }
        };
        if let Err(error) = self.validate_publication_source(&source) {
            // A concurrent approver may have committed between this turn's source
            // reload and validation. Re-read only the durable proposal state: an
            // approved result is safely idempotent; every other state stays closed.
            if error.as_str() == "publication_already_published" {
                if let Some(latest) = self.get_publication_proposal(id)? {
                    if latest.status == MemoryPublicationStatus::Approved {
                        return self.approved_publication_result(latest);
                    }
                }
            }
            self.mark_publication_failed_if_pending(
                &proposal.id,
                actor,
                proposal.proposal_version,
                error.as_str(),
            );
            return Err(error);
        }
        let source_evidence = self
            .store
            .evidence_for(&source.reference, &source.user_id, &source.workspace_id)
            .map_err(MemoryError::Store)?;
        if publication_source_revision(&source, &source_evidence)? != proposal.source_revision {
            self.mark_publication_failed_if_pending(
                &proposal.id,
                actor,
                proposal.proposal_version,
                "publication_source_changed",
            );
            return Err(MemoryError::policy("publication_source_changed"));
        }

        let destination_scope = MemoryPublicationDestination::new(
            proposal.destination_user_id.clone(),
            proposal.destination_workspace_id.clone(),
        );
        self.validate_publication_destination(&source, &destination_scope)?;
        validate_publication_proposed_payload(&proposal)?;
        let destination_snapshot = self
            .store
            .list_memories(&destination_scope.user_id, &destination_scope.workspace_id)?;
        let destination_revision = publication_destination_revision(&destination_snapshot)?;
        if proposal.destination_revision != destination_revision {
            match self.rebase_publication_destination(
                &proposal,
                &source,
                &destination_scope,
                &destination_snapshot,
                destination_revision,
                actor,
            ) {
                Ok(_) | Err(MemoryError::Policy(_)) => {
                    return self.approved_publication_result_or_preview_stale(id);
                }
                Err(error) => return Err(error),
            }
        }
        let candidate = Self::find_publication_candidate_in(
            &destination_snapshot,
            &publication_candidate_record(&source, &proposal),
            proposal.proposed_collection,
        );
        if candidate != proposal.candidate {
            // The first approver may have committed atomically after this turn
            // loaded the pending proposal but before candidate revalidation.
            // Only an already durable approval is idempotent; every other
            // candidate change remains a fail-closed conflict.
            if let Some(latest) = self.get_publication_proposal(id)? {
                if latest.status == MemoryPublicationStatus::Approved {
                    return self.approved_publication_result(latest);
                }
            }
            return Err(MemoryError::policy("publication_conflict"));
        }
        let now = current_timestamp();
        let destination = match (&candidate, &proposal.resolution) {
            (None, Some(MemoryPublicationResolution::CreateNew)) => {
                self.publication_destination_record(&proposal, &source, None, &now)?
            }
            (None, None) => return Err(MemoryError::policy("publication_decision_required")),
            (Some(_), None) => return Err(MemoryError::policy("publication_conflict")),
            (Some(_), Some(MemoryPublicationResolution::CreateNew)) => {
                self.publication_destination_record(&proposal, &source, None, &now)?
            }
            (
                Some(candidate),
                Some(MemoryPublicationResolution::UpdateExisting { destination_ref }),
            ) if publication_candidate_ref(candidate) == destination_ref => {
                let existing = self
                    .store
                    .get_memory(
                        destination_ref,
                        &proposal.destination_user_id,
                        &proposal.destination_workspace_id,
                    )?
                    .ok_or_else(|| MemoryError::policy("publication_conflict"))?;
                self.publication_destination_record(&proposal, &source, Some(&existing), &now)?
            }
            _ => return Err(MemoryError::policy("publication_conflict")),
        };
        let source_with_alias =
            self.publication_source_alias(&source, &proposal, &destination, &now)?;
        let link = MemoryPublicationLink {
            source_ref: source.reference.clone(),
            destination_ref: destination.reference.clone(),
            approved_by: actor.to_string(),
            created_at: now,
        };
        match self
            .store
            .commit_publication(
                &proposal,
                &destination,
                &source_with_alias,
                &link,
                &source,
                &source_evidence,
                &destination_snapshot,
            )
            .map_err(memory_publication_error)
        {
            Ok(approved) => {
                self.bump_briefing_generation(&source.user_id, &source.workspace_id);
                self.bump_briefing_generation(&destination.user_id, &destination.workspace_id);
                Ok(MemoryPublicationResult {
                    proposal: approved,
                    destination,
                    link,
                })
            }
            Err(error) if error.as_str() == "publication_not_pending" => {
                let latest = self
                    .get_publication_proposal(id)?
                    .ok_or_else(|| MemoryError::not_found("publication_not_found"))?;
                if latest.status == MemoryPublicationStatus::Approved {
                    self.approved_publication_result(latest)
                } else {
                    Err(error)
                }
            }
            Err(error) if error.as_str() == "publication_conflict" => {
                // A writer changed the destination after the facade snapshot
                // but before commit. Keep the pending review resumable: rebase
                // its candidate/version instead of terminally failing it.
                let (snapshot, revision) =
                    self.publication_destination_snapshot(&destination_scope)?;
                match self.rebase_publication_destination(
                    &proposal,
                    &source,
                    &destination_scope,
                    &snapshot,
                    revision,
                    actor,
                ) {
                    Ok(_) | Err(MemoryError::Policy(_)) => {
                        self.approved_publication_result_or_preview_stale(id)
                    }
                    Err(rebase_error) => Err(rebase_error),
                }
            }
            Err(error) => {
                self.mark_publication_failed_if_pending(
                    &proposal.id,
                    actor,
                    proposal.proposal_version,
                    error.as_str(),
                );
                Err(error)
            }
        }
    }

    fn validate_publication_actor_and_destination(
        &self,
        source: &MemoryRecord,
        destination: &MemoryPublicationDestination,
        actor: &str,
    ) -> MemoryResult<()> {
        if actor.trim().is_empty() || actor != source.user_id.as_str() {
            return Err(MemoryError::policy("publication_actor_mismatch"));
        }
        self.validate_publication_destination(source, destination)
    }

    fn validate_publication_actor(
        &self,
        proposal: &MemoryPublicationProposal,
        actor: &str,
    ) -> MemoryResult<()> {
        if actor.trim().is_empty()
            || actor != proposal.proposed_by
            || actor != proposal.source_user_id.as_str()
            || proposal.source_user_id != proposal.destination_user_id
        {
            return Err(MemoryError::policy("publication_actor_mismatch"));
        }
        Ok(())
    }

    fn validate_publication_destination(
        &self,
        source: &MemoryRecord,
        destination: &MemoryPublicationDestination,
    ) -> MemoryResult<()> {
        if destination.user_id != source.user_id {
            return Err(MemoryError::validation("publication_scope_mismatch"));
        }
        if destination.workspace_id.as_str().trim().is_empty()
            || destination.workspace_id.as_str() == THREADS_WORKSPACE
        {
            return Err(MemoryError::validation("publication_destination_invalid"));
        }
        if destination.workspace_id == source.workspace_id {
            return Err(MemoryError::validation("publication_same_scope"));
        }
        Ok(())
    }

    fn load_publication_source(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> MemoryResult<MemoryRecord> {
        if reference.kind != MemoryRefKind::Memory
            || reference.user_id != *user_id
            || reference.workspace_id != *workspace_id
            || workspace_id.as_str().trim().is_empty()
            || workspace_id.as_str() == THREADS_WORKSPACE
        {
            return Err(MemoryError::validation("publication_source_scope_mismatch"));
        }
        self.store
            .get_memory(reference, user_id, workspace_id)?
            .ok_or_else(|| MemoryError::not_found("publication_source_not_found"))
    }

    fn validate_publication_source(&self, source: &MemoryRecord) -> MemoryResult<()> {
        if source.status == MemoryStatus::Deleted {
            return Err(MemoryError::not_found("publication_source_not_found"));
        }
        if !matches!(
            source.status,
            MemoryStatus::Candidate | MemoryStatus::Confirmed
        ) {
            return Err(MemoryError::policy("publication_source_inactive"));
        }
        if source.sensitivity == DataSensitivity::Secret {
            return Err(MemoryError::policy("secret_never_shareable"));
        }
        if is_published_alias(source) || self.get_publication_link(&source.reference)?.is_some() {
            return Err(MemoryError::policy("publication_already_published"));
        }
        let metadata = publication_user_metadata_for_secret_scan(source)?;
        let payload = serde_json::json!({
            "text": source.text,
            "aliases": source.aliases,
            "language_hints": source.language_hints,
            "metadata": metadata,
        });
        if contains_secret(&payload) {
            return Err(MemoryError::policy("vault_payload_never_shareable"));
        }
        Ok(())
    }

    fn find_publication_candidate_in(
        candidates: &[MemoryRecord],
        source: &MemoryRecord,
        collection: MemoryCollectionKey,
    ) -> Option<MemoryPublicationCandidate> {
        if let Some(candidate) = candidates.iter().find(|candidate| {
            publication_candidate_is_eligible(candidate)
                && !is_published_alias(candidate)
                && candidate.text == source.text
                && candidate.memory_type == source.memory_type
                && candidate.privacy_domain == source.privacy_domain
                && candidate.sensitivity == source.sensitivity
        }) {
            return Some(MemoryPublicationCandidate::CompatibleDuplicate {
                destination_ref: candidate.reference.clone(),
            });
        }
        let source_subject = publication_subject_key(source);
        source_subject.and_then(|subject| {
            candidates
                .iter()
                .filter(|candidate| {
                    publication_candidate_is_eligible(candidate)
                        && !is_published_alias(candidate)
                        && candidate.memory_type == source.memory_type
                        && collection.matches(candidate)
                        && publication_subject_key(candidate) == Some(subject)
                })
                .min_by(|left, right| left.reference.to_string().cmp(&right.reference.to_string()))
                .map(|candidate| MemoryPublicationCandidate::Conflict {
                    destination_ref: candidate.reference.clone(),
                })
        })
    }

    fn publication_destination_snapshot(
        &self,
        destination: &MemoryPublicationDestination,
    ) -> MemoryResult<(Vec<MemoryRecord>, String)> {
        let snapshot = self
            .store
            .list_memories(&destination.user_id, &destination.workspace_id)
            .map_err(MemoryError::Store)?;
        let revision = publication_destination_revision(&snapshot)?;
        Ok((snapshot, revision))
    }

    /// Re-derives a pending review after destination drift. The store update is
    /// a versioned IMMEDIATE transaction: concurrent rebases converge on one
    /// durable candidate/version and callers simply reload it.
    fn rebase_publication_destination(
        &self,
        proposal: &MemoryPublicationProposal,
        source: &MemoryRecord,
        destination: &MemoryPublicationDestination,
        snapshot: &[MemoryRecord],
        destination_revision: String,
        actor: &str,
    ) -> MemoryResult<MemoryPublicationProposal> {
        let candidate = Self::find_publication_candidate_in(
            snapshot,
            &publication_candidate_record(source, proposal),
            proposal.proposed_collection,
        );
        let mut rebased = proposal.clone();
        rebased.candidate = candidate;
        rebased.reason_code = publication_pending_reason(rebased.candidate.as_ref());
        rebased.resolution = None;
        rebased.destination_revision = destination_revision;
        rebased.proposal_version = proposal
            .proposal_version
            .checked_add(1)
            .ok_or_else(|| MemoryError::validation("publication_version_invalid"))?;
        rebased.updated_at = current_timestamp();
        if rebased.destination_user_id != destination.user_id
            || rebased.destination_workspace_id != destination.workspace_id
        {
            return Err(MemoryError::policy("publication_conflict"));
        }
        self.store
            .update_memory_publication_proposal(&rebased, actor, proposal.proposal_version)
            .map_err(memory_publication_error)
    }

    fn publication_destination_record(
        &self,
        proposal: &MemoryPublicationProposal,
        source: &MemoryRecord,
        existing: Option<&MemoryRecord>,
        now: &str,
    ) -> MemoryResult<MemoryRecord> {
        let reference = existing
            .map(|record| record.reference.clone())
            .unwrap_or_else(|| {
                MemoryRef::generated(
                    MemoryRefKind::Memory,
                    proposal.destination_user_id.clone(),
                    proposal.destination_workspace_id.clone(),
                )
            });
        let metadata =
            publication_destination_metadata(source, existing, proposal, &reference, now)?;
        Ok(MemoryRecord {
            reference,
            user_id: proposal.destination_user_id.clone(),
            workspace_id: proposal.destination_workspace_id.clone(),
            memory_type: proposal.proposed_memory_type.clone(),
            text: proposal.proposed_text.clone(),
            aliases: vec![],
            language_hints: source.language_hints.clone(),
            confidence: source.confidence,
            status: MemoryStatus::Confirmed,
            privacy_domain: proposal.proposed_privacy_domain.clone(),
            sensitivity: proposal.proposed_sensitivity,
            metadata,
            created_at: existing
                .map(|record| record.created_at.clone())
                .unwrap_or_else(|| now.to_string()),
            updated_at: now.to_string(),
            last_seen_at: Some(now.to_string()),
            supersedes: vec![],
            superseded_by: None,
            correction_of: None,
        })
    }

    fn publication_source_alias(
        &self,
        source: &MemoryRecord,
        proposal: &MemoryPublicationProposal,
        destination: &MemoryRecord,
        now: &str,
    ) -> MemoryResult<MemoryRecord> {
        let mut alias = source.clone();
        if !alias.metadata.is_object() {
            alias.metadata = serde_json::json!({ "previous_metadata": alias.metadata });
        }
        let metadata = alias.metadata.as_object_mut().ok_or_else(|| {
            MemoryError::Store("publication alias metadata is not an object".to_string())
        })?;
        metadata.insert("published_alias".to_string(), serde_json::Value::Bool(true));
        metadata.insert(
            "publication_link".to_string(),
            serde_json::Value::String(
                serde_json::to_string(&destination.reference)
                    .map_err(|error| MemoryError::Store(error.to_string()))?,
            ),
        );
        metadata.insert(
            "publication".to_string(),
            serde_json::json!({
                "proposal_id": &proposal.id,
                "destination_ref": &destination.reference,
                "published_at": now,
            }),
        );
        alias.updated_at = now.to_string();
        Ok(alias)
    }

    fn approved_publication_result(
        &self,
        proposal: MemoryPublicationProposal,
    ) -> MemoryResult<MemoryPublicationResult> {
        let link = self
            .get_publication_link(&proposal.source_ref)?
            .ok_or_else(|| {
                MemoryError::Store("approved publication link is missing".to_string())
            })?;
        let destination = self
            .store
            .get_memory(
                &link.destination_ref,
                &proposal.destination_user_id,
                &proposal.destination_workspace_id,
            )?
            .ok_or_else(|| {
                MemoryError::Store("approved publication destination is missing".to_string())
            })?;
        Ok(MemoryPublicationResult {
            proposal,
            destination,
            link,
        })
    }

    fn approved_publication_result_or_preview_stale(
        &self,
        id: &str,
    ) -> MemoryResult<MemoryPublicationResult> {
        match self.get_publication_proposal(id)? {
            Some(proposal) if proposal.status == MemoryPublicationStatus::Approved => {
                self.approved_publication_result(proposal)
            }
            _ => Err(MemoryError::policy("publication_preview_stale")),
        }
    }

    fn mark_publication_failed_if_pending(
        &self,
        id: &str,
        actor: &str,
        expected_version: u64,
        reason: &str,
    ) {
        let _ = self.store.mark_memory_publication_failed(
            id,
            actor,
            expected_version,
            reason,
            &current_timestamp(),
        );
    }

    pub fn backup_to(&self, destination: impl AsRef<Path>) -> MemoryResult<MemoryBackupReport> {
        Ok(self.store.backup_to(destination)?)
    }

    pub fn run_memory_maintenance(&self) -> MemoryResult<MemoryMaintenanceReport> {
        Ok(self.store.run_maintenance()?)
    }

    pub fn get_memory_for_ui(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Option<MemoryRecord>, String> {
        self.store.get_memory(reference, user_id, workspace_id)
    }

    pub fn get_routine_for_test(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Option<RoutineRecord>, String> {
        self.store.get_routine(reference, user_id, workspace_id)
    }

    pub fn list_memories_for_ui(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<MemoryRecord>, String> {
        self.store.list_memories(user_id, workspace_id)
    }

    pub fn list_memory_source_candidates(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        offset: usize,
        limit: usize,
    ) -> MemoryResult<Vec<MemorySourceCandidateProjection>> {
        Ok(self
            .store
            .list_memory_source_candidates(user_id, workspace_id, offset, limit)?)
    }

    /// Texts of forgotten (deleted/rejected) memories in a scope — the suppression
    /// list for a permanent forget. Bypasses the tombstone filter on purpose.
    pub fn list_forgotten_texts(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<String>, String> {
        self.store.list_forgotten_texts(user_id, workspace_id)
    }

    pub fn list_entities_for_ui(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<MemoryEntity>, String> {
        self.store.list_entities(user_id, workspace_id)
    }

    pub fn list_relations_for_ui(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<MemoryRelation>, String> {
        self.store.list_relations(user_id, workspace_id)
    }

    pub fn list_wiki_pages_for_ui(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<WikiPage>, String> {
        self.store.list_wiki_pages(user_id, workspace_id)
    }

    pub fn list_routines_for_ui(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<RoutineRecord>, String> {
        self.store.list_routines(user_id, workspace_id)
    }

    pub fn list_automation_candidates_for_ui(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<AutomationCandidateRecord>, String> {
        self.store.list_automation_candidates(user_id, workspace_id)
    }

    pub fn evidence_for_ui(
        &self,
        memory_ref: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<MemoryEvidence>, String> {
        self.store.evidence_for(memory_ref, user_id, workspace_id)
    }

    pub fn decide_memory_for_ui(
        &self,
        request: &MemoryAccessRequest,
        memory: &MemoryRecord,
    ) -> MemoryAccessDecision {
        self.policy.decide_memory(request, memory)
    }

    pub fn audit_ui_decision(
        &self,
        request: &MemoryAccessRequest,
        decision: &MemoryAccessDecision,
    ) -> MemoryResult<MemoryRef> {
        Ok(self.store.record_access_decision(request, decision)?)
    }

    fn context_item(&self, memory: &MemoryRecord) -> MemoryResult<MemoryContextItem> {
        let evidence = self
            .store
            .evidence_for(&memory.reference, &memory.user_id, &memory.workspace_id)?
            .into_iter()
            .map(|evidence| evidence.evidence_ref)
            .collect();
        Ok(MemoryContextItem {
            reference: memory.reference.clone(),
            summary: memory.text.clone(),
            memory_type: memory.memory_type.clone(),
            sensitivity: memory.sensitivity,
            privacy_domain: memory.privacy_domain.clone(),
            evidence,
            confidence: memory.confidence,
        })
    }

    fn transition_memory(
        &self,
        request: &MemoryLifecycleRequest,
        reference: &MemoryRef,
        status: MemoryStatus,
        reason: &str,
    ) -> MemoryResult<MemoryRecord> {
        let mut memory = self.load_lifecycle_memory(request, reference)?;
        ensure_transition(memory.status, status)?;
        memory.status = status;
        memory.updated_at = current_timestamp();
        memory.metadata = merge_reason(memory.metadata, reason);
        self.store.upsert_memory(&memory)?;
        self.audit_lifecycle(request, AccessDecisionKind::Allow, vec![])?;
        self.bump_briefing_generation(&request.user_id, &request.workspace_id);
        Ok(memory)
    }

    fn load_lifecycle_memory(
        &self,
        request: &MemoryLifecycleRequest,
        reference: &MemoryRef,
    ) -> MemoryResult<MemoryRecord> {
        if reference.user_id != request.user_id || reference.workspace_id != request.workspace_id {
            self.audit_lifecycle(
                request,
                AccessDecisionKind::Deny,
                vec!["scope_mismatch".to_string()],
            )?;
            return Err(MemoryError::validation(
                "cannot access ref outside user/workspace",
            ));
        }
        Ok(self
            .store
            .get_memory(reference, &request.user_id, &request.workspace_id)?
            .ok_or_else(|| MemoryError::not_found("memory not found"))?)
    }

    fn audit_lifecycle(
        &self,
        request: &MemoryLifecycleRequest,
        kind: AccessDecisionKind,
        reasons: Vec<String>,
    ) -> MemoryResult<MemoryRef> {
        let access_request = MemoryAccessRequest {
            actor_id: request.actor_id.clone(),
            user_id: request.user_id.clone(),
            workspace_id: request.workspace_id.clone(),
            purpose: request.purpose.clone(),
            allowed_domains: vec![],
            max_sensitivity: DataSensitivity::Secret,
            allow_raw_payload: false,
            allow_export: false,
            broad_query: false,
        };
        Ok(self
            .store
            .record_access_decision(&access_request, &MemoryAccessDecision { kind, reasons })?)
    }
}

const PUBLICATION_EDIT_TEXT_MAX: usize = 8 * 1024;
const PUBLICATION_SEMANTIC_VALUE_MAX: usize = 256;

fn publication_edited_payload(
    source: &MemoryRecord,
    edit: Option<&MemoryPublicationEditInput>,
) -> MemoryResult<MemoryRecord> {
    let mut proposed = source.clone();
    let Some(edit) = edit else {
        validate_publication_editable_fields(&proposed)?;
        return Ok(proposed);
    };
    if let Some(text) = &edit.proposed_text {
        proposed.text = text.trim().to_string();
    }
    if let Some(memory_type) = &edit.proposed_memory_type {
        proposed.memory_type = memory_type.clone();
    }
    if let Some(domain) = &edit.proposed_privacy_domain {
        proposed.privacy_domain = domain.clone();
    }
    if let Some(sensitivity) = edit.proposed_sensitivity {
        proposed.sensitivity = sensitivity;
    }
    validate_publication_editable_fields(&proposed)?;
    Ok(proposed)
}

fn validate_publication_editable_fields(proposed: &MemoryRecord) -> MemoryResult<()> {
    if proposed.text.trim().is_empty() || proposed.text.len() > PUBLICATION_EDIT_TEXT_MAX {
        return Err(MemoryError::validation("publication_text_invalid"));
    }
    if !matches!(
        proposed.memory_type.as_str(),
        "preference"
            | "fact"
            | "note"
            | "decision"
            | "goal"
            | "objective"
            | "open_loop"
            | "artifact"
            | "episode"
    ) {
        return Err(MemoryError::validation("publication_memory_type_invalid"));
    }
    if !matches!(
        proposed.privacy_domain.as_str(),
        "personal" | "work" | "general"
    ) {
        return Err(MemoryError::validation(
            "publication_privacy_domain_invalid",
        ));
    }
    if proposed.sensitivity > DataSensitivity::Private {
        return Err(MemoryError::policy("publication_sensitivity_not_allowed"));
    }
    if contains_secret(&serde_json::json!({ "text": proposed.text })) {
        return Err(MemoryError::policy("secret_never_shareable"));
    }
    Ok(())
}

fn validate_publication_proposed_payload(proposal: &MemoryPublicationProposal) -> MemoryResult<()> {
    let record = MemoryRecord {
        reference: proposal.source_ref.clone(),
        user_id: proposal.source_user_id.clone(),
        workspace_id: proposal.source_workspace_id.clone(),
        memory_type: proposal.proposed_memory_type.clone(),
        text: proposal.proposed_text.clone(),
        aliases: Vec::new(),
        language_hints: Vec::new(),
        confidence: 1.0,
        status: MemoryStatus::Confirmed,
        privacy_domain: proposal.proposed_privacy_domain.clone(),
        sensitivity: proposal.proposed_sensitivity,
        metadata: serde_json::json!({}),
        created_at: String::new(),
        updated_at: String::new(),
        last_seen_at: None,
        supersedes: Vec::new(),
        superseded_by: None,
        correction_of: None,
    };
    validate_publication_editable_fields(&record)
}

fn publication_candidate_record(
    source: &MemoryRecord,
    proposal: &MemoryPublicationProposal,
) -> MemoryRecord {
    let mut candidate = source.clone();
    candidate.text = proposal.proposed_text.clone();
    candidate.memory_type = proposal.proposed_memory_type.clone();
    candidate.privacy_domain = proposal.proposed_privacy_domain.clone();
    candidate.sensitivity = proposal.proposed_sensitivity;
    candidate
}

fn publication_source_revision(
    source: &MemoryRecord,
    evidence: &[MemoryEvidence],
) -> MemoryResult<String> {
    let payload = serde_json::json!({
        "record": source,
        "evidence": evidence,
    });
    let encoded = serde_json::to_vec(&payload).map_err(|_| {
        MemoryError::Store("publication source revision serialization failed".to_string())
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(encoded)))
}

fn publication_destination_revision(snapshot: &[MemoryRecord]) -> MemoryResult<String> {
    // `list_memories` is ordered by ref and filters tombstoned rows. It is the
    // exact visible-scope snapshot rechecked by commit, so the fingerprint
    // changes for every active insert/update/removal without trusting timestamps.
    let encoded = serde_json::to_vec(snapshot).map_err(|_| {
        MemoryError::Store("publication destination revision serialization failed".to_string())
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(encoded)))
}

fn publication_system_ref(value: &serde_json::Value, user_id: &UserId) -> MemoryResult<MemoryRef> {
    let reference = serde_json::from_value::<MemoryRef>(value.clone())
        .map_err(|_| MemoryError::policy("publication_provenance_invalid"))?;
    if reference.kind != MemoryRefKind::Memory
        || reference.user_id != *user_id
        || reference.scope != "local"
        || reference.workspace_id.as_str().trim().is_empty()
        || reference.workspace_id.as_str() == THREADS_WORKSPACE
    {
        return Err(MemoryError::policy("publication_provenance_invalid"));
    }
    Ok(reference)
}

fn publication_user_metadata_for_secret_scan(
    record: &MemoryRecord,
) -> MemoryResult<serde_json::Value> {
    let Some(object) = record.metadata.as_object() else {
        return Ok(record.metadata.clone());
    };
    let mut user = object.clone();
    if let Some(value) = object.get("publication_link") {
        let encoded = value
            .as_str()
            .ok_or_else(|| MemoryError::policy("publication_provenance_invalid"))?;
        let reference: serde_json::Value = serde_json::from_str(encoded)
            .map_err(|_| MemoryError::policy("publication_provenance_invalid"))?;
        publication_system_ref(&reference, &record.user_id)?;
        user.remove("publication_link");
    }
    if let Some(value) = object.get("publication_source_ref") {
        publication_system_ref(value, &record.user_id)?;
        user.remove("publication_source_ref");
    }
    if let Some(value) = object.get("publication_source_refs") {
        let values = value
            .as_array()
            .ok_or_else(|| MemoryError::policy("publication_provenance_invalid"))?;
        if values.is_empty() {
            return Err(MemoryError::policy("publication_provenance_invalid"));
        }
        for value in values {
            publication_system_ref(value, &record.user_id)?;
        }
        user.remove("publication_source_refs");
    }
    if let Some(value) = object.get("publication") {
        let nested = value
            .as_object()
            .ok_or_else(|| MemoryError::policy("publication_provenance_invalid"))?;
        if nested.keys().any(|key| {
            !matches!(
                key.as_str(),
                "source_ref" | "destination_ref" | "proposal_id" | "published_at"
            )
        }) {
            return Err(MemoryError::policy("publication_provenance_invalid"));
        }
        if let Some(reference) = nested.get("source_ref") {
            publication_system_ref(reference, &record.user_id)?;
        }
        if let Some(reference) = nested.get("destination_ref") {
            publication_system_ref(reference, &record.user_id)?;
        }
        if nested.get("source_ref").is_none() == nested.get("destination_ref").is_none() {
            return Err(MemoryError::policy("publication_provenance_invalid"));
        }
        let proposal_id = nested
            .get("proposal_id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| MemoryError::policy("publication_provenance_invalid"))?;
        if uuid::Uuid::parse_str(proposal_id).is_err() {
            return Err(MemoryError::policy("publication_provenance_invalid"));
        }
        let published_at = nested
            .get("published_at")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| MemoryError::policy("publication_provenance_invalid"))?;
        let valid_timestamp = published_at
            .strip_prefix("unix:")
            .and_then(|value| value.split_once('.'))
            .is_some_and(|(seconds, nanos)| {
                !seconds.is_empty()
                    && seconds.bytes().all(|byte| byte.is_ascii_digit())
                    && nanos.len() == 9
                    && nanos.bytes().all(|byte| byte.is_ascii_digit())
            });
        if !valid_timestamp {
            return Err(MemoryError::policy("publication_provenance_invalid"));
        }
        user.remove("publication");
    }
    Ok(serde_json::Value::Object(user))
}

fn publication_semantic_metadata(
    record: &MemoryRecord,
) -> MemoryResult<serde_json::Map<String, serde_json::Value>> {
    let mut projected = serde_json::Map::new();
    let Some(metadata) = record.metadata.as_object() else {
        return Ok(projected);
    };
    for key in ["subject_key", "canonical_key"] {
        let Some(value) = metadata.get(key) else {
            continue;
        };
        let Some(value) = value.as_str().map(str::trim) else {
            return Err(MemoryError::policy("publication_semantic_metadata_invalid"));
        };
        if value.is_empty()
            || value.len() > PUBLICATION_SEMANTIC_VALUE_MAX
            || contains_secret(&serde_json::Value::String(value.to_string()))
        {
            return Err(MemoryError::policy("publication_semantic_metadata_unsafe"));
        }
        projected.insert(
            key.to_string(),
            serde_json::Value::String(value.to_string()),
        );
    }
    if let Some(value) = metadata.get("scope") {
        let Some(scope) = value.as_str() else {
            return Err(MemoryError::policy("publication_semantic_metadata_invalid"));
        };
        if scope == "personal" {
            projected.insert(
                "scope".to_string(),
                serde_json::Value::String(scope.to_string()),
            );
        }
    }
    Ok(projected)
}

fn publication_destination_metadata(
    source: &MemoryRecord,
    existing: Option<&MemoryRecord>,
    proposal: &MemoryPublicationProposal,
    destination_ref: &MemoryRef,
    now: &str,
) -> MemoryResult<serde_json::Value> {
    let mut metadata = existing
        .map(publication_semantic_metadata)
        .transpose()?
        .unwrap_or_default();
    for (key, value) in publication_semantic_metadata(source)? {
        metadata.entry(key).or_insert(value);
    }
    let mut refs = Vec::<MemoryRef>::new();
    if let Some(existing) = existing {
        if let Some(values) = existing.metadata.get("publication_source_refs") {
            let Some(values) = values.as_array() else {
                return Err(MemoryError::policy("publication_provenance_invalid"));
            };
            for value in values {
                let reference = serde_json::from_value::<MemoryRef>(value.clone())
                    .map_err(|_| MemoryError::policy("publication_provenance_invalid"))?;
                if !refs.contains(&reference) {
                    refs.push(reference);
                }
            }
        }
        if let Some(value) = existing.metadata.get("publication_source_ref") {
            let reference = serde_json::from_value::<MemoryRef>(value.clone())
                .map_err(|_| MemoryError::policy("publication_provenance_invalid"))?;
            if !refs.contains(&reference) {
                refs.push(reference);
            }
        }
        if let Some(value) = existing.metadata.get("publication") {
            metadata.insert("publication".to_string(), value.clone());
        }
    }
    if !refs.contains(&source.reference) {
        refs.push(source.reference.clone());
    }
    let first = refs
        .first()
        .cloned()
        .ok_or_else(|| MemoryError::policy("publication_provenance_invalid"))?;
    metadata.insert(
        "publication_source_refs".to_string(),
        serde_json::to_value(&refs).map_err(|e| MemoryError::Store(e.to_string()))?,
    );
    metadata.insert(
        "publication_source_ref".to_string(),
        serde_json::to_value(&first).map_err(|e| MemoryError::Store(e.to_string()))?,
    );
    metadata.entry("publication".to_string()).or_insert_with(|| serde_json::json!({"source_ref": first, "proposal_id": proposal.id, "published_at": now}));
    metadata.insert(
        "publication_link".to_string(),
        serde_json::Value::String(
            serde_json::to_string(destination_ref)
                .map_err(|e| MemoryError::Store(e.to_string()))?,
        ),
    );
    Ok(serde_json::Value::Object(metadata))
}

fn merge_reason(mut metadata: serde_json::Value, reason: &str) -> serde_json::Value {
    if let Some(object) = metadata.as_object_mut() {
        object.insert(
            "last_lifecycle_reason".to_string(),
            serde_json::Value::String(reason.to_string()),
        );
        metadata
    } else {
        serde_json::json!({ "previous_metadata": metadata, "last_lifecycle_reason": reason })
    }
}

fn vector_index_scope_key(user_id: &UserId, workspace_id: &WorkspaceId) -> String {
    format!("{}|{}", user_id.as_str(), workspace_id.as_str())
}

fn is_published_alias(memory: &MemoryRecord) -> bool {
    memory
        .metadata
        .get("published_alias")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

fn publication_candidate_is_eligible(memory: &MemoryRecord) -> bool {
    memory.reference.kind == MemoryRefKind::Memory
        && matches!(
            memory.status,
            MemoryStatus::Candidate | MemoryStatus::Confirmed
        )
        && memory.sensitivity != DataSensitivity::Secret
        && !is_published_alias(memory)
        && publication_user_metadata_for_secret_scan(memory).is_ok_and(|metadata| {
            !contains_secret(&serde_json::json!({
                "text": memory.text,
                "aliases": memory.aliases,
                "language_hints": memory.language_hints,
                "metadata": metadata,
            }))
        })
}

fn publication_subject_key(memory: &MemoryRecord) -> Option<&str> {
    ["subject_key", "canonical_key"]
        .into_iter()
        .find_map(|key| {
            memory
                .metadata
                .get(key)
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
}

fn publication_candidate_ref(candidate: &MemoryPublicationCandidate) -> &MemoryRef {
    match candidate {
        MemoryPublicationCandidate::CompatibleDuplicate { destination_ref }
        | MemoryPublicationCandidate::Conflict { destination_ref } => destination_ref,
    }
}

fn publication_pending_reason(
    candidate: Option<&MemoryPublicationCandidate>,
) -> MemoryPublicationReasonCode {
    match candidate {
        Some(MemoryPublicationCandidate::CompatibleDuplicate { .. }) => {
            MemoryPublicationReasonCode::PublicationDuplicateCompatible
        }
        Some(MemoryPublicationCandidate::Conflict { .. }) => {
            MemoryPublicationReasonCode::PublicationConflict
        }
        None => MemoryPublicationReasonCode::Pending,
    }
}

fn publication_resolution_matches_candidate(
    resolution: &MemoryPublicationResolution,
    candidate: Option<&MemoryPublicationCandidate>,
) -> bool {
    match (resolution, candidate) {
        (MemoryPublicationResolution::CreateNew, _) => true,
        (MemoryPublicationResolution::UpdateExisting { destination_ref }, Some(candidate)) => {
            publication_candidate_ref(candidate) == destination_ref
        }
        _ => false,
    }
}

fn merge_entity_metadata(
    survivor: &mut serde_json::Value,
    absorbed: &serde_json::Value,
    absorbed_ref: &MemoryRef,
    reason: &str,
) {
    if !survivor.is_object() {
        *survivor = serde_json::json!({ "previous_metadata": survivor.clone() });
    }
    let Some(object) = survivor.as_object_mut() else {
        return;
    };
    object.insert(
        "last_entity_merge_reason".to_string(),
        serde_json::Value::String(reason.to_string()),
    );
    let merged = object
        .entry("merged_entity_refs")
        .or_insert_with(|| serde_json::Value::Array(Vec::new()));
    if let Some(items) = merged.as_array_mut() {
        let value = serde_json::Value::String(absorbed_ref.to_string());
        if !items.iter().any(|item| item == &value) {
            items.push(value);
        }
    }
    let merged_meta = object
        .entry("merged_entity_metadata")
        .or_insert_with(|| serde_json::Value::Array(Vec::new()));
    if let Some(items) = merged_meta.as_array_mut() {
        items.push(absorbed.clone());
    }
}
