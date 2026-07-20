use local_first_inference_usage::{CostProvenance, Locality};
use serde::{Deserialize, Serialize};

use crate::model_registry::ModelTier;

pub const SCORING_POLICY_VERSION: &str = "usage-suggestion-v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuggestionRequirements {
    pub cloud_allowed: bool,
    pub tools: bool,
    pub vision: bool,
    pub reasoning: bool,
    pub min_context_window: u32,
    pub minimum_tier: ModelTier,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateFacts {
    pub provider_id: String,
    pub model_id: String,
    pub locality: Locality,
    pub enabled: bool,
    pub tools: bool,
    pub vision: bool,
    pub reasoning: bool,
    pub context_window: u32,
    pub tier: ModelTier,
    pub predicted_cost_microusd: Option<u64>,
    pub headroom_percent: Option<u8>,
    pub median_latency_ms: Option<u64>,
    pub success_rate_basis_points: Option<u16>,
    pub successful_sample_count: u64,
    pub cost_provenance: CostProvenance,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuggestionInput {
    pub role: String,
    pub window: String,
    pub requirements: SuggestionRequirements,
    pub current: CandidateFacts,
    pub candidates: Vec<CandidateFacts>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SuggestionConfidence {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SuggestionFactKind {
    Cost,
    Latency,
    Headroom,
    Reliability,
    Capability,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuggestionFact {
    pub kind: SuggestionFactKind,
    pub delta_percent: Option<i64>,
    pub value: Option<u64>,
    pub provenance: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SuggestionActionScope {
    UseForTask,
    ChangeRolePreference,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplyUsageSuggestionRequest {
    pub confirmed: bool,
    pub action: SuggestionActionScope,
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ApplyInstruction {
    UseForTask {
        provider_id: String,
        model_id: String,
        thread_id: Option<String>,
    },
    ChangeRolePreference {
        role: String,
        provider_id: String,
        model_id: String,
    },
}

pub fn validate_apply_request(
    request: &ApplyUsageSuggestionRequest,
    allowed: &[SuggestionActionScope],
    target_provider: &str,
    target_model: &str,
    role: &str,
) -> Result<ApplyInstruction, &'static str> {
    if !request.confirmed {
        return Err("usage_suggestion_confirmation_required");
    }
    if !allowed.contains(&request.action) {
        return Err("usage_suggestion_scope_invalid");
    }
    match request.action {
        SuggestionActionScope::UseForTask => Ok(ApplyInstruction::UseForTask {
            provider_id: target_provider.to_string(),
            model_id: target_model.to_string(),
            thread_id: request.thread_id.clone(),
        }),
        SuggestionActionScope::ChangeRolePreference => {
            Ok(ApplyInstruction::ChangeRolePreference {
                role: role.to_string(),
                provider_id: target_provider.to_string(),
                model_id: target_model.to_string(),
            })
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelSuggestion {
    pub suggestion_key: String,
    pub current_provider: String,
    pub current_model: String,
    pub target_provider: String,
    pub target_model: String,
    pub role: String,
    pub confidence: SuggestionConfidence,
    pub facts: Vec<SuggestionFact>,
    pub action_scopes: Vec<SuggestionActionScope>,
    pub scoring_policy_version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EligibilityFailure {
    Disabled,
    CloudForbidden,
    MissingTools,
    MissingVision,
    MissingReasoning,
    ContextTooSmall,
    TierTooLow,
}

const COST_WEIGHT: u64 = 3_000;
const HEADROOM_WEIGHT: u64 = 2_500;
const QUALITY_WEIGHT: u64 = 2_000;
const LATENCY_WEIGHT: u64 = 1_500;
const RELIABILITY_WEIGHT: u64 = 1_000;

pub fn eligibility(
    requirements: &SuggestionRequirements,
    candidate: &CandidateFacts,
) -> Result<(), EligibilityFailure> {
    if !candidate.enabled {
        return Err(EligibilityFailure::Disabled);
    }
    if !requirements.cloud_allowed && candidate.locality == Locality::Cloud {
        return Err(EligibilityFailure::CloudForbidden);
    }
    if requirements.tools && !candidate.tools {
        return Err(EligibilityFailure::MissingTools);
    }
    if requirements.vision && !candidate.vision {
        return Err(EligibilityFailure::MissingVision);
    }
    if requirements.reasoning && !candidate.reasoning {
        return Err(EligibilityFailure::MissingReasoning);
    }
    if candidate.context_window < requirements.min_context_window {
        return Err(EligibilityFailure::ContextTooSmall);
    }
    if tier_rank(candidate.tier) < tier_rank(requirements.minimum_tier) {
        return Err(EligibilityFailure::TierTooLow);
    }
    Ok(())
}

pub fn suggest(input: &SuggestionInput) -> Option<ModelSuggestion> {
    input
        .candidates
        .iter()
        .filter(|candidate| {
            eligibility(&input.requirements, candidate).is_ok()
                && (candidate.provider_id != input.current.provider_id
                    || candidate.model_id != input.current.model_id)
        })
        .filter_map(|candidate| scored_candidate(input, candidate))
        .max_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| right.1.target_provider.cmp(&left.1.target_provider))
                .then_with(|| right.1.target_model.cmp(&left.1.target_model))
        })
        .map(|(_, suggestion)| suggestion)
}

fn scored_candidate(
    input: &SuggestionInput,
    candidate: &CandidateFacts,
) -> Option<(u64, ModelSuggestion)> {
    let mut score_sum = 0_u64;
    let mut weight_sum = 0_u64;
    let mut known_dimensions = 1_u8;
    let mut facts = Vec::new();
    let current = &input.current;

    score_sum += u64::from(tier_score(candidate.tier)) * QUALITY_WEIGHT;
    weight_sum += QUALITY_WEIGHT;

    if let (Some(current_cost), Some(candidate_cost)) = (
        current.predicted_cost_microusd,
        candidate.predicted_cost_microusd,
    ) && current_cost > 0
    {
        known_dimensions += 1;
        let ratio = candidate_cost.saturating_mul(100) / current_cost;
        let saving_score = 100_u64.saturating_sub(ratio.min(100));
        score_sum += saving_score * COST_WEIGHT;
        weight_sum += COST_WEIGHT;
        if candidate_cost.saturating_mul(100) <= current_cost.saturating_mul(80) {
            facts.push(SuggestionFact {
                kind: SuggestionFactKind::Cost,
                delta_percent: Some(percent_delta(candidate_cost, current_cost)),
                value: Some(candidate_cost),
                provenance: cost_provenance_label(candidate.cost_provenance).to_string(),
            });
        }
    }

    if let (Some(current_headroom), Some(candidate_headroom)) =
        (current.headroom_percent, candidate.headroom_percent)
    {
        known_dimensions += 1;
        score_sum += u64::from(candidate_headroom.min(100)) * HEADROOM_WEIGHT;
        weight_sum += HEADROOM_WEIGHT;
        if current_headroom <= 20 && candidate_headroom >= current_headroom.saturating_add(20) {
            facts.push(SuggestionFact {
                kind: SuggestionFactKind::Headroom,
                delta_percent: Some(i64::from(candidate_headroom) - i64::from(current_headroom)),
                value: Some(u64::from(candidate_headroom)),
                provenance: "provider_account_or_manual_budget".into(),
            });
        }
    }

    if current.successful_sample_count >= 10 && candidate.successful_sample_count >= 10 {
        if let (Some(current_latency), Some(candidate_latency)) =
            (current.median_latency_ms, candidate.median_latency_ms)
            && current_latency > 0
        {
            known_dimensions += 1;
            let ratio = candidate_latency.saturating_mul(100) / current_latency;
            let faster_score = 100_u64.saturating_sub(ratio.min(100));
            score_sum += faster_score * LATENCY_WEIGHT;
            weight_sum += LATENCY_WEIGHT;
            if candidate_latency.saturating_mul(100) <= current_latency.saturating_mul(75) {
                facts.push(SuggestionFact {
                    kind: SuggestionFactKind::Latency,
                    delta_percent: Some(percent_delta(candidate_latency, current_latency)),
                    value: Some(candidate_latency),
                    provenance: "observed_recent_calls".into(),
                });
            }
        }
        if let Some(reliability) = candidate.success_rate_basis_points {
            known_dimensions += 1;
            score_sum += u64::from(reliability.min(10_000)) * RELIABILITY_WEIGHT / 100;
            weight_sum += RELIABILITY_WEIGHT;
        }
    }

    if facts.is_empty() || weight_sum == 0 {
        return None;
    }
    let confidence = match known_dimensions {
        0 | 1 => SuggestionConfidence::Low,
        2 | 3 => SuggestionConfidence::Medium,
        _ => SuggestionConfidence::High,
    };
    if confidence == SuggestionConfidence::Low {
        return None;
    }
    let score = score_sum / weight_sum;
    let suggestion_key = stable_suggestion_key(
        &current.provider_id,
        &current.model_id,
        &candidate.provider_id,
        &candidate.model_id,
        &input.role,
        &input.window,
    );
    Some((
        score,
        ModelSuggestion {
            suggestion_key,
            current_provider: current.provider_id.clone(),
            current_model: current.model_id.clone(),
            target_provider: candidate.provider_id.clone(),
            target_model: candidate.model_id.clone(),
            role: input.role.clone(),
            confidence,
            facts,
            action_scopes: vec![
                SuggestionActionScope::UseForTask,
                SuggestionActionScope::ChangeRolePreference,
            ],
            scoring_policy_version: SCORING_POLICY_VERSION.into(),
        },
    ))
}

fn tier_rank(tier: ModelTier) -> u8 {
    match tier {
        ModelTier::Fast => 0,
        ModelTier::Balanced => 1,
        ModelTier::Reasoning => 2,
    }
}

fn tier_score(tier: ModelTier) -> u8 {
    match tier {
        ModelTier::Fast => 40,
        ModelTier::Balanced => 70,
        ModelTier::Reasoning => 100,
    }
}

fn percent_delta(value: u64, baseline: u64) -> i64 {
    if baseline == 0 {
        return 0;
    }
    let delta = i128::from(value).saturating_sub(i128::from(baseline));
    (delta.saturating_mul(100) / i128::from(baseline))
        .clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64
}

fn cost_provenance_label(provenance: CostProvenance) -> &'static str {
    match provenance {
        CostProvenance::ProviderReported => "provider_reported",
        CostProvenance::CatalogEstimated => "catalog_estimated",
        CostProvenance::ManualEstimated => "manual_estimated",
        CostProvenance::NotBilled => "not_billed",
        CostProvenance::Unavailable => "unavailable",
    }
}

fn stable_suggestion_key(
    current_provider: &str,
    current_model: &str,
    target_provider: &str,
    target_model: &str,
    role: &str,
    window: &str,
) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for part in [
        current_provider,
        current_model,
        target_provider,
        target_model,
        role,
        window,
        SCORING_POLICY_VERSION,
    ] {
        for byte in part.as_bytes().iter().chain(std::iter::once(&0_u8)) {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    format!("usage-{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(provider: &str, model: &str, locality: Locality) -> CandidateFacts {
        CandidateFacts {
            provider_id: provider.into(),
            model_id: model.into(),
            locality,
            enabled: true,
            tools: true,
            vision: true,
            reasoning: true,
            context_window: 32_000,
            tier: ModelTier::Balanced,
            predicted_cost_microusd: Some(1_000),
            headroom_percent: Some(60),
            median_latency_ms: Some(1_000),
            success_rate_basis_points: Some(9_900),
            successful_sample_count: 20,
            cost_provenance: CostProvenance::ProviderReported,
        }
    }

    fn fixture() -> SuggestionInput {
        SuggestionInput {
            role: "orchestrator".into(),
            window: "30d".into(),
            requirements: SuggestionRequirements {
                cloud_allowed: true,
                tools: true,
                vision: true,
                reasoning: true,
                min_context_window: 32_000,
                minimum_tier: ModelTier::Balanced,
            },
            current: candidate("current-provider", "current", Locality::Cloud),
            candidates: vec![],
        }
    }

    #[test]
    fn cloud_candidate_cannot_compensate_for_local_only_policy() {
        let mut input = fixture();
        input.requirements.cloud_allowed = false;
        let mut cheap = candidate("cloud", "candidate", Locality::Cloud);
        cheap.predicted_cost_microusd = Some(1);
        input.candidates.push(cheap);
        assert!(suggest(&input).is_none());
    }

    #[test]
    fn missing_required_capabilities_or_context_excludes_candidate() {
        for mutate in 0..4 {
            let mut input = fixture();
            let mut next = candidate("other", "candidate", Locality::Local);
            next.predicted_cost_microusd = Some(500);
            match mutate {
                0 => next.tools = false,
                1 => next.vision = false,
                2 => next.reasoning = false,
                _ => next.context_window = 8_000,
            }
            input.candidates.push(next);
            assert!(suggest(&input).is_none());
        }
    }

    #[test]
    fn material_cost_gain_with_equal_capability_is_explained() {
        let mut input = fixture();
        let mut next = candidate("other", "candidate", Locality::Cloud);
        next.predicted_cost_microusd = Some(600);
        input.candidates.push(next);
        let result = suggest(&input).expect("material suggestion");
        assert_eq!(result.target_model, "candidate");
        assert!(result.facts.iter().any(|fact| {
            fact.kind == SuggestionFactKind::Cost && fact.delta_percent == Some(-40)
        }));
        assert_ne!(result.confidence, SuggestionConfidence::Low);
    }
}
