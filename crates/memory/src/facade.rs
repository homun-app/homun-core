use crate::{
    AccessAuditEntry, AccessDecisionKind, AutomationCandidateCreateRequest,
    AutomationCandidateRecord,
    DataSensitivity, GraphifyArtifacts, GraphifyCli, GraphifyImport, GraphifyImportSummary,
    GraphifyOperation, GraphifyQueryRequest, GraphifyQueryResult, MemoryAccessDecision,
    MemoryAccessRequest, MemoryBackupReport, MemoryContextItem, MemoryContextPack,
    MemoryCreateRequest, MemoryEntity, MemoryError, MemoryEvent, MemoryEvidence, MemoryExtraction,
    MemoryExtractionSummary, MemoryHealth, MemoryLifecycleRequest, MemoryMaintenanceReport,
    MemoryPolicyEngine, MemoryRecord, MemoryRef, MemoryRefKind, MemoryRelation, MemoryResult,
    MemorySearchPage, MemorySearchRequest, MemorySearchResult, MemoryStatus, MemoryUpdatePatch,
    PrivacyDomain, RoutineInference, RoutineInferenceSummary, RoutineRecord, RoutineStatus,
    SQLiteMemoryStore, UserId, WikiCorrectionSyncReport, WikiFileStore, WikiPage, WorkspaceId,
    current_timestamp, ensure_artifacts_inside_root, ensure_transition, parse_wiki_markdown,
};
use std::path::Path;
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

    pub fn record_event(&self, event: &MemoryEvent) -> MemoryResult<()> {
        Ok(self.store.record_event(event)?)
    }

    pub fn upsert_memory(&self, memory: &MemoryRecord) -> MemoryResult<()> {
        Ok(self.store.upsert_memory(memory)?)
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
        Ok(self
            .store
            .tombstone(reference, user_id, workspace_id, reason)?)
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
        Ok(())
    }

    pub fn record_wiki_page_for_ui(&self, page: &WikiPage) -> MemoryResult<()> {
        Ok(self.store.record_wiki_page(page)?)
    }

    pub fn upsert_embedding(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        model: &str,
        vector: &[f32],
    ) -> MemoryResult<()> {
        Ok(self
            .store
            .upsert_embedding(reference, user_id, workspace_id, model, vector)?)
    }

    pub fn list_embeddings(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> MemoryResult<Vec<(MemoryRef, Vec<f32>)>> {
        Ok(self.store.list_embeddings(user_id, workspace_id)?)
    }

    pub fn refs_without_embeddings(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        limit: usize,
    ) -> MemoryResult<Vec<MemoryRef>> {
        Ok(self.store.refs_without_embeddings(user_id, workspace_id, limit)?)
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

    pub fn project_to_wiki(
        &self,
        wiki: &WikiFileStore,
        projection: &MemoryWikiProjection,
    ) -> MemoryResult<()> {
        Ok(wiki.write_page(&self.store, &projection.page)?)
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

    pub fn list_access_audit(&self, limit: u32) -> MemoryResult<Vec<AccessAuditEntry>> {
        Ok(self.store.list_access_audit(limit)?)
    }

    pub fn clear_access_audit(&self) -> MemoryResult<u64> {
        Ok(self.store.clear_access_audit()?)
    }

    pub fn memory_health(&self) -> MemoryResult<MemoryHealth> {
        Ok(self.store.health()?)
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
