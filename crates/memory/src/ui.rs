use crate::{
    AccessDecisionKind, DataSensitivity, MemoryAccessRequest, MemoryEntity, MemoryFacade,
    MemoryRecord, MemoryRef, MemoryRelation, PrivacyDomain, UserId, WikiPage, WorkspaceId,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UiCount {
    pub key: String,
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryDashboard {
    pub total_memories: usize,
    pub total_entities: usize,
    pub total_relations: usize,
    pub total_wiki_pages: usize,
    pub by_status: Vec<UiCount>,
    pub by_privacy_domain: Vec<UiCount>,
    pub by_sensitivity: Vec<UiCount>,
    pub access_audit_count: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryListItem {
    pub reference: MemoryRef,
    pub memory_type: String,
    pub summary: String,
    pub confidence: f64,
    pub status: String,
    pub privacy_domain: PrivacyDomain,
    pub sensitivity: DataSensitivity,
    pub language_hints: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryDetail {
    pub memory: MemoryListItem,
    pub evidence: Vec<MemoryRef>,
    pub entities: Vec<MemoryEntity>,
    pub relations: Vec<MemoryRelation>,
    pub wiki_pages: Vec<WikiPage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrivacyDomainOverview {
    pub domain: String,
    pub memories: usize,
    pub entities: usize,
    pub relations: usize,
    pub wiki_pages: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrivacyOverview {
    pub domains: Vec<PrivacyDomainOverview>,
    pub secret_or_confidential_count: usize,
}

pub struct MemoryUiReadModel<'a> {
    facade: &'a MemoryFacade,
}

impl<'a> MemoryUiReadModel<'a> {
    pub fn new(facade: &'a MemoryFacade) -> Self {
        Self { facade }
    }

    pub fn dashboard(&self, request: &MemoryAccessRequest) -> Result<MemoryDashboard, String> {
        let memories = self.allowed_memories(request)?;
        let entities = self
            .facade
            .list_entities_for_ui(&request.user_id, &request.workspace_id)?;
        let relations = self
            .facade
            .list_relations_for_ui(&request.user_id, &request.workspace_id)?;
        let wiki_pages = self
            .facade
            .list_wiki_pages_for_ui(&request.user_id, &request.workspace_id)?;

        Ok(MemoryDashboard {
            total_memories: memories.len(),
            total_entities: filter_domain_sensitivity(&entities, request).len(),
            total_relations: filter_domain_sensitivity(&relations, request).len(),
            total_wiki_pages: filter_domain_sensitivity(&wiki_pages, request).len(),
            by_status: counts(memories.iter().map(|memory| enum_key(&memory.status))),
            by_privacy_domain: counts(
                memories
                    .iter()
                    .map(|memory| memory.privacy_domain.as_str().to_string()),
            ),
            by_sensitivity: counts(memories.iter().map(|memory| enum_key(&memory.sensitivity))),
            access_audit_count: self.facade.access_audit_count()?,
        })
    }

    pub fn list_memories(
        &self,
        request: &MemoryAccessRequest,
    ) -> Result<Vec<MemoryListItem>, String> {
        Ok(self
            .allowed_memories(request)?
            .into_iter()
            .map(memory_list_item)
            .collect())
    }

    pub fn memory_detail(
        &self,
        request: &MemoryAccessRequest,
        reference: &MemoryRef,
    ) -> Result<Option<MemoryDetail>, String> {
        let Some(memory) =
            self.facade
                .get_memory_for_ui(reference, &request.user_id, &request.workspace_id)?
        else {
            return Ok(None);
        };
        let decision = self.facade.decide_memory_for_ui(request, &memory);
        self.facade.audit_ui_decision(request, &decision)?;
        if decision.kind == AccessDecisionKind::Deny {
            return Ok(None);
        }

        let entities = filter_domain_sensitivity(
            &self
                .facade
                .list_entities_for_ui(&request.user_id, &request.workspace_id)?,
            request,
        );
        let relations = filter_domain_sensitivity(
            &self
                .facade
                .list_relations_for_ui(&request.user_id, &request.workspace_id)?,
            request,
        );
        let wiki_pages = filter_domain_sensitivity(
            &self
                .facade
                .list_wiki_pages_for_ui(&request.user_id, &request.workspace_id)?,
            request,
        )
        .into_iter()
        .filter(|page| page.linked_refs.contains(reference))
        .collect();

        Ok(Some(MemoryDetail {
            evidence: self
                .facade
                .evidence_for_ui(reference, &request.user_id, &request.workspace_id)?
                .into_iter()
                .map(|evidence| evidence.evidence_ref)
                .collect(),
            memory: memory_list_item(memory),
            entities,
            relations,
            wiki_pages,
        }))
    }

    pub fn privacy_overview(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<PrivacyOverview, String> {
        let memories = self.facade.list_memories_for_ui(user_id, workspace_id)?;
        let entities = self.facade.list_entities_for_ui(user_id, workspace_id)?;
        let relations = self.facade.list_relations_for_ui(user_id, workspace_id)?;
        let wiki_pages = self.facade.list_wiki_pages_for_ui(user_id, workspace_id)?;

        let mut by_domain: BTreeMap<String, PrivacyDomainOverview> = BTreeMap::new();
        for memory in &memories {
            by_domain
                .entry(memory.privacy_domain.as_str().to_string())
                .or_insert_with(|| overview(memory.privacy_domain.as_str()))
                .memories += 1;
        }
        for entity in &entities {
            by_domain
                .entry(entity.privacy_domain.as_str().to_string())
                .or_insert_with(|| overview(entity.privacy_domain.as_str()))
                .entities += 1;
        }
        for relation in &relations {
            by_domain
                .entry(relation.privacy_domain.as_str().to_string())
                .or_insert_with(|| overview(relation.privacy_domain.as_str()))
                .relations += 1;
        }
        for page in &wiki_pages {
            by_domain
                .entry(page.privacy_domain.as_str().to_string())
                .or_insert_with(|| overview(page.privacy_domain.as_str()))
                .wiki_pages += 1;
        }

        let secret_or_confidential_count = memories
            .iter()
            .filter(|memory| {
                matches!(
                    memory.sensitivity,
                    DataSensitivity::Confidential | DataSensitivity::Secret
                )
            })
            .count()
            + entities
                .iter()
                .filter(|entity| {
                    matches!(
                        entity.sensitivity,
                        DataSensitivity::Confidential | DataSensitivity::Secret
                    )
                })
                .count()
            + relations
                .iter()
                .filter(|relation| {
                    matches!(
                        relation.sensitivity,
                        DataSensitivity::Confidential | DataSensitivity::Secret
                    )
                })
                .count()
            + wiki_pages
                .iter()
                .filter(|page| {
                    matches!(
                        page.sensitivity,
                        DataSensitivity::Confidential | DataSensitivity::Secret
                    )
                })
                .count();

        Ok(PrivacyOverview {
            domains: by_domain.into_values().collect(),
            secret_or_confidential_count,
        })
    }

    fn allowed_memories(&self, request: &MemoryAccessRequest) -> Result<Vec<MemoryRecord>, String> {
        let mut allowed = Vec::new();
        for memory in self
            .facade
            .list_memories_for_ui(&request.user_id, &request.workspace_id)?
        {
            let decision = self.facade.decide_memory_for_ui(request, &memory);
            self.facade.audit_ui_decision(request, &decision)?;
            if decision.kind != AccessDecisionKind::Deny {
                allowed.push(memory);
            }
        }
        Ok(allowed)
    }
}

trait UiScoped {
    fn privacy_domain(&self) -> &PrivacyDomain;
    fn sensitivity(&self) -> DataSensitivity;
}

impl UiScoped for MemoryEntity {
    fn privacy_domain(&self) -> &PrivacyDomain {
        &self.privacy_domain
    }

    fn sensitivity(&self) -> DataSensitivity {
        self.sensitivity
    }
}

impl UiScoped for MemoryRelation {
    fn privacy_domain(&self) -> &PrivacyDomain {
        &self.privacy_domain
    }

    fn sensitivity(&self) -> DataSensitivity {
        self.sensitivity
    }
}

impl UiScoped for WikiPage {
    fn privacy_domain(&self) -> &PrivacyDomain {
        &self.privacy_domain
    }

    fn sensitivity(&self) -> DataSensitivity {
        self.sensitivity
    }
}

fn filter_domain_sensitivity<T: UiScoped + Clone>(
    values: &[T],
    request: &MemoryAccessRequest,
) -> Vec<T> {
    values
        .iter()
        .filter(|value| {
            request
                .allowed_domains
                .iter()
                .any(|domain| domain == value.privacy_domain())
                && value.sensitivity() <= request.max_sensitivity
        })
        .cloned()
        .collect()
}

fn memory_list_item(memory: MemoryRecord) -> MemoryListItem {
    MemoryListItem {
        reference: memory.reference,
        memory_type: memory.memory_type,
        summary: memory.text,
        confidence: memory.confidence,
        status: enum_key(&memory.status),
        privacy_domain: memory.privacy_domain,
        sensitivity: memory.sensitivity,
        language_hints: memory.language_hints,
    }
}

fn counts(values: impl Iterator<Item = String>) -> Vec<UiCount> {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for value in values {
        *counts.entry(value).or_default() += 1;
    }
    counts
        .into_iter()
        .map(|(key, count)| UiCount { key, count })
        .collect()
}

fn enum_key<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(ToString::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

fn overview(domain: &str) -> PrivacyDomainOverview {
    PrivacyDomainOverview {
        domain: domain.to_string(),
        memories: 0,
        entities: 0,
        relations: 0,
        wiki_pages: 0,
    }
}
