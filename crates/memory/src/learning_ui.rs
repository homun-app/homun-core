use crate::{
    AccessDecisionKind, AutomationCandidateRecord, AutomationCandidateStatus, AutomationRiskLevel,
    DataSensitivity, MemoryAccessRequest, MemoryFacade, MemoryRecord, MemoryRef, PrivacyDomain,
    RoutineRecord,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LearningInsightKind {
    Memory,
    Routine,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LearningUiSummary {
    pub learned_items: usize,
    pub candidate_items: usize,
    pub automation_candidates: usize,
    pub hidden_by_policy: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LearningInsightItem {
    pub reference: MemoryRef,
    pub kind: LearningInsightKind,
    pub title: String,
    pub summary: String,
    pub confidence: f64,
    pub status: String,
    pub privacy_domain: PrivacyDomain,
    pub sensitivity: DataSensitivity,
    pub evidence: Vec<MemoryRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LearningAutomationProposal {
    pub reference: MemoryRef,
    pub routine_ref: Option<MemoryRef>,
    pub title: String,
    pub summary: String,
    pub trigger: String,
    pub actions: Vec<String>,
    pub risk_level: AutomationRiskLevel,
    pub autonomy_level: u8,
    pub status: AutomationCandidateStatus,
    pub privacy_domain: PrivacyDomain,
    pub sensitivity: DataSensitivity,
    pub evidence: Vec<MemoryRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LearningUiSnapshot {
    pub summary: LearningUiSummary,
    pub insights: Vec<LearningInsightItem>,
    pub automation_proposals: Vec<LearningAutomationProposal>,
}

pub struct LearningUiReadModel<'a> {
    facade: &'a MemoryFacade,
}

impl<'a> LearningUiReadModel<'a> {
    pub fn new(facade: &'a MemoryFacade) -> Self {
        Self { facade }
    }

    pub fn snapshot(&self, request: &MemoryAccessRequest) -> Result<LearningUiSnapshot, String> {
        let mut hidden_by_policy = 0;
        let mut insights = Vec::new();

        for memory in self
            .facade
            .list_memories_for_ui(&request.user_id, &request.workspace_id)?
        {
            let decision = self.facade.decide_memory_for_ui(request, &memory);
            self.facade.audit_ui_decision(request, &decision)?;
            if decision.kind == AccessDecisionKind::Deny {
                hidden_by_policy += 1;
                continue;
            }
            insights.push(self.memory_insight(memory, request)?);
        }

        for routine in self
            .facade
            .list_routines_for_ui(&request.user_id, &request.workspace_id)?
        {
            if !allowed(request, &routine.privacy_domain, routine.sensitivity) {
                hidden_by_policy += 1;
                continue;
            }
            insights.push(routine_insight(routine));
        }

        let mut automation_proposals = Vec::new();
        for candidate in self
            .facade
            .list_automation_candidates_for_ui(&request.user_id, &request.workspace_id)?
        {
            if !allowed(request, &candidate.privacy_domain, candidate.sensitivity) {
                hidden_by_policy += 1;
                continue;
            }
            automation_proposals.push(automation_proposal(candidate));
        }

        let candidate_items = insights
            .iter()
            .filter(|insight| insight.status == "candidate")
            .count();

        Ok(LearningUiSnapshot {
            summary: LearningUiSummary {
                learned_items: insights.len(),
                candidate_items,
                automation_candidates: automation_proposals.len(),
                hidden_by_policy,
            },
            insights,
            automation_proposals,
        })
    }

    fn memory_insight(
        &self,
        memory: MemoryRecord,
        request: &MemoryAccessRequest,
    ) -> Result<LearningInsightItem, String> {
        Ok(LearningInsightItem {
            evidence: self
                .facade
                .evidence_for_ui(&memory.reference, &request.user_id, &request.workspace_id)?
                .into_iter()
                .map(|evidence| evidence.evidence_ref)
                .collect(),
            title: memory.memory_type.clone(),
            summary: memory.text.clone(),
            confidence: memory.confidence,
            status: enum_key(&memory.status),
            privacy_domain: memory.privacy_domain.clone(),
            sensitivity: memory.sensitivity,
            reference: memory.reference,
            kind: LearningInsightKind::Memory,
        })
    }
}

fn routine_insight(routine: RoutineRecord) -> LearningInsightItem {
    LearningInsightItem {
        reference: routine.reference,
        kind: LearningInsightKind::Routine,
        title: routine.name,
        summary: routine.intent,
        confidence: routine.confidence,
        status: enum_key(&routine.status),
        privacy_domain: routine.privacy_domain,
        sensitivity: routine.sensitivity,
        evidence: routine.evidence,
    }
}

fn automation_proposal(candidate: AutomationCandidateRecord) -> LearningAutomationProposal {
    LearningAutomationProposal {
        reference: candidate.reference,
        routine_ref: candidate.routine_ref,
        title: candidate.title,
        summary: candidate.summary,
        trigger: candidate.trigger,
        actions: candidate.actions,
        risk_level: candidate.risk_level,
        autonomy_level: candidate.autonomy_level,
        status: candidate.status,
        privacy_domain: candidate.privacy_domain,
        sensitivity: candidate.sensitivity,
        evidence: candidate.evidence,
    }
}

fn allowed(
    request: &MemoryAccessRequest,
    privacy_domain: &PrivacyDomain,
    sensitivity: DataSensitivity,
) -> bool {
    request
        .allowed_domains
        .iter()
        .any(|domain| domain == privacy_domain)
        && sensitivity <= request.max_sensitivity
}

fn enum_key<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(ToString::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}
