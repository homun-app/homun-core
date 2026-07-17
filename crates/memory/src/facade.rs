use crate::{
    AUTHORIZED_MEMORY_SEARCH_LIMIT_MAX, AccessDecisionKind, AuthorizedMemorySearchRequest,
    AuthorizedMemorySource, AutomationCandidateCreateRequest, AutomationCandidateRecord,
    AutomationCandidateStatus, DataSensitivity, GraphifyArtifacts, GraphifyCli, GraphifyImport,
    GraphifyImportSummary, GraphifyOperation, GraphifyQueryRequest, GraphifyQueryResult,
    MemoryAccessDecision, MemoryAccessRequest, MemoryBackupReport, MemoryContextItem,
    MemoryContextPack, MemoryCreateRequest, MemoryEntity, MemoryError, MemoryEvent, MemoryEvidence,
    MemoryExtraction, MemoryExtractionSummary, MemoryHealth, MemoryLifecycleRequest,
    MemoryMaintenanceReport, MemoryPolicyEngine, MemoryPublicationDestination,
    MemoryPublicationLink, MemoryPublicationProposal, MemoryPublicationResult,
    MemoryPublicationStatus, MemoryPublicationStoreError, MemoryRecord, MemoryRef, MemoryRefKind,
    MemoryRelation, MemoryResult, MemorySearchPage, MemorySearchRequest, MemorySearchResult,
    MemorySourceCandidateProjection, MemorySourceGrant, MemorySourceGrantStoreError, MemoryStatus,
    MemoryUpdatePatch, PERSONAL_WORKSPACE, PrivacyDomain, RoutineInference,
    RoutineInferenceSummary, RoutineRecord, RoutineStatus, SQLiteMemoryStore, THREADS_WORKSPACE,
    UserId, VectorHit, WikiCorrectionSyncReport, WikiFileStore, WikiPage, WorkspaceId,
    contains_secret, current_timestamp, ensure_artifacts_inside_root, ensure_transition,
    parse_wiki_markdown,
};
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
    ) -> Result<usize, String> {
        let count = self.store.purge_workspace(user_id, workspace_id)?;
        self.bump_briefing_generation(user_id, workspace_id);
        Ok(count)
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
        self.validate_publication_actor_and_destination(source, destination, actor)?;
        let source =
            self.load_publication_source(&source.reference, &source.user_id, &source.workspace_id)?;
        self.validate_publication_source(&source)?;
        let now = current_timestamp();
        let proposal = MemoryPublicationProposal {
            id: uuid::Uuid::new_v4().to_string(),
            source_ref: source.reference.clone(),
            source_user_id: source.user_id.clone(),
            source_workspace_id: source.workspace_id.clone(),
            destination_user_id: destination.user_id.clone(),
            destination_workspace_id: destination.workspace_id.clone(),
            proposed_text: source.text.clone(),
            proposed_memory_type: source.memory_type.clone(),
            proposed_privacy_domain: source.privacy_domain.clone(),
            proposed_sensitivity: source.sensitivity,
            duplicate_ref: self.find_publication_duplicate(&source, destination)?,
            status: MemoryPublicationStatus::Pending,
            proposed_by: actor.to_string(),
            decided_by: None,
            created_at: now.clone(),
            updated_at: now,
        };
        self.store
            .create_memory_publication_proposal(&proposal)
            .map_err(memory_publication_error)?;
        Ok(proposal)
    }

    pub fn get_publication_proposal(
        &self,
        id: &str,
    ) -> MemoryResult<Option<MemoryPublicationProposal>> {
        self.store
            .get_memory_publication_proposal(id)
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

    pub fn reject_publication(
        &self,
        id: &str,
        actor: &str,
    ) -> MemoryResult<MemoryPublicationProposal> {
        let proposal = self
            .get_publication_proposal(id)?
            .ok_or_else(|| MemoryError::not_found("publication_not_found"))?;
        self.validate_publication_actor(&proposal, actor)?;
        self.store
            .reject_memory_publication(id, actor, &current_timestamp())
            .map_err(memory_publication_error)
    }

    pub fn approve_publication(
        &self,
        id: &str,
        actor: &str,
    ) -> MemoryResult<MemoryPublicationResult> {
        let proposal = self
            .get_publication_proposal(id)?
            .ok_or_else(|| MemoryError::not_found("publication_not_found"))?;
        self.validate_publication_actor(&proposal, actor)?;
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
                self.mark_publication_failed_if_pending(&proposal.id, actor);
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
            self.mark_publication_failed_if_pending(&proposal.id, actor);
            return Err(error);
        }
        if source.text != proposal.proposed_text
            || source.memory_type != proposal.proposed_memory_type
            || source.privacy_domain != proposal.proposed_privacy_domain
            || source.sensitivity != proposal.proposed_sensitivity
        {
            self.mark_publication_failed_if_pending(&proposal.id, actor);
            return Err(MemoryError::policy("publication_source_changed"));
        }

        let destination_scope = MemoryPublicationDestination::new(
            proposal.destination_user_id.clone(),
            proposal.destination_workspace_id.clone(),
        );
        self.validate_publication_destination(&source, &destination_scope)?;
        let duplicate = self.find_publication_duplicate(&source, &destination_scope)?;
        let now = current_timestamp();
        let destination = match duplicate {
            Some(reference) => self
                .store
                .get_memory(
                    &reference,
                    &proposal.destination_user_id,
                    &proposal.destination_workspace_id,
                )?
                .ok_or_else(|| MemoryError::policy("publication_duplicate_changed"))?,
            None => self.publication_destination_record(&proposal, &source, &now),
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
            .commit_publication(&proposal, &destination, &source_with_alias, &link)
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
            Err(error) => {
                self.mark_publication_failed_if_pending(&proposal.id, actor);
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
        if source.sensitivity == DataSensitivity::Secret {
            return Err(MemoryError::policy("secret_never_shareable"));
        }
        let payload = serde_json::json!({
            "text": source.text,
            "aliases": source.aliases,
            "language_hints": source.language_hints,
            "metadata": source.metadata,
        });
        if contains_secret(&payload) {
            return Err(MemoryError::policy("vault_payload_never_shareable"));
        }
        if is_published_alias(source) || self.get_publication_link(&source.reference)?.is_some() {
            return Err(MemoryError::policy("publication_already_published"));
        }
        Ok(())
    }

    fn find_publication_duplicate(
        &self,
        source: &MemoryRecord,
        destination: &MemoryPublicationDestination,
    ) -> MemoryResult<Option<MemoryRef>> {
        Ok(self
            .store
            .list_memories(&destination.user_id, &destination.workspace_id)?
            .into_iter()
            .find(|candidate| {
                candidate.reference.kind == MemoryRefKind::Memory
                    && candidate.status != MemoryStatus::Deleted
                    && !is_published_alias(candidate)
                    && candidate.text == source.text
                    && candidate.memory_type == source.memory_type
                    && candidate.privacy_domain == source.privacy_domain
                    && candidate.sensitivity == source.sensitivity
            })
            .map(|candidate| candidate.reference))
    }

    fn publication_destination_record(
        &self,
        proposal: &MemoryPublicationProposal,
        source: &MemoryRecord,
        now: &str,
    ) -> MemoryRecord {
        MemoryRecord {
            reference: MemoryRef::generated(
                MemoryRefKind::Memory,
                proposal.destination_user_id.clone(),
                proposal.destination_workspace_id.clone(),
            ),
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
            metadata: serde_json::json!({
                "publication": {
                    "source_ref": &source.reference,
                    "proposal_id": &proposal.id,
                    "published_at": now,
                }
            }),
            created_at: now.to_string(),
            updated_at: now.to_string(),
            last_seen_at: Some(now.to_string()),
            supersedes: vec![],
            superseded_by: None,
            correction_of: None,
        }
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

    fn mark_publication_failed_if_pending(&self, id: &str, actor: &str) {
        let _ = self
            .store
            .mark_memory_publication_failed(id, actor, &current_timestamp());
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
