use local_first_vault::VaultCategory;
use serde::Deserialize;
use std::{collections::HashMap, sync::Mutex};

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PrivacyGuardDecision {
    pub(crate) has_sensitive_data: bool,
    pub(crate) items: Vec<PrivacyGuardItem>,
    pub(crate) redacted_text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PrivacyGuardItem {
    pub(crate) category: String,
    pub(crate) kind: String,
    pub(crate) label: String,
    pub(crate) secret_value: String,
    pub(crate) redacted_preview: String,
    pub(crate) confidence: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum PrivacyGuardModelOutcome {
    Classified(PrivacyGuardDecision),
    Unavailable(&'static str),
    InvalidOutput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PrivacyGuardFailurePolicy {
    DeterministicLocalOnly,
    BlockAndRetry,
}

pub(crate) fn failure_policy(orchestrator_is_local: bool) -> PrivacyGuardFailurePolicy {
    if orchestrator_is_local {
        PrivacyGuardFailurePolicy::DeterministicLocalOnly
    } else {
        PrivacyGuardFailurePolicy::BlockAndRetry
    }
}

pub(crate) fn merge_guard_decisions(
    original_text: &str,
    model: PrivacyGuardDecision,
    deterministic: PrivacyGuardDecision,
) -> PrivacyGuardDecision {
    let mut items = deterministic.items;
    for item in model.items {
        let duplicate = items.iter().any(|existing| {
            existing.category == item.category
                && existing.kind == item.kind
                && existing.secret_value == item.secret_value
        });
        if !duplicate {
            items.push(item);
        }
    }
    let mut redacted_text = original_text.to_string();
    for item in &items {
        redacted_text = redacted_text.replace(&item.secret_value, &item.redacted_preview);
    }
    PrivacyGuardDecision {
        has_sensitive_data: !items.is_empty(),
        items,
        redacted_text,
    }
}

pub(crate) fn classify_sensitive_input_deterministic(text: &str) -> PrivacyGuardDecision {
    let classification = local_first_vault::classify_sensitive_text(text);
    let items = classification
        .detections
        .iter()
        .map(|detection| PrivacyGuardItem {
            category: category_key(detection.category).to_string(),
            kind: detection.kind.clone(),
            label: label_for_detection(detection.kind.as_str()).to_string(),
            secret_value: text[detection.start..detection.end].to_string(),
            redacted_preview: detection.placeholder.clone(),
            confidence: 0.95,
        })
        .collect::<Vec<_>>();
    PrivacyGuardDecision {
        has_sensitive_data: !items.is_empty(),
        items,
        redacted_text: if classification.has_critical {
            classification.redacted_text
        } else {
            text.to_string()
        },
    }
}

fn category_key(category: VaultCategory) -> &'static str {
    match category {
        VaultCategory::Payments => "payments",
        VaultCategory::Identity => "identity",
        VaultCategory::Health => "health",
        VaultCategory::Vehicles => "vehicles",
        VaultCategory::Credentials => "credentials",
        VaultCategory::PrivateNotes => "private_notes",
    }
}

fn label_for_detection(kind: &str) -> &'static str {
    match kind {
        "plate" => "Targa auto",
        "codice_fiscale" => "Codice fiscale",
        "card_number" => "Carta di pagamento",
        "cvv_one_shot" => "CVV one-shot",
        "health_note" => "Dato sanitario",
        "secret" => "Credenziale",
        _ => "Dato sensibile",
    }
}

#[derive(Debug, Deserialize)]
struct ModelGuardOutput {
    #[serde(default)]
    has_sensitive_data: bool,
    #[serde(default)]
    items: Vec<ModelGuardItem>,
}

#[derive(Debug, Deserialize)]
struct ModelGuardItem {
    category: String,
    kind: String,
    label: String,
    secret_value: String,
    #[serde(default)]
    confidence: f32,
}

pub(crate) fn decision_from_model_output(
    original_text: &str,
    model_output: &str,
) -> Option<PrivacyGuardDecision> {
    let json = extract_json_object(model_output)?;
    let output: ModelGuardOutput = serde_json::from_str(json).ok()?;
    if !output.has_sensitive_data {
        return Some(PrivacyGuardDecision {
            has_sensitive_data: false,
            items: Vec::new(),
            redacted_text: original_text.to_string(),
        });
    }

    let mut redacted_text = original_text.to_string();
    let mut items = Vec::new();
    for item in output.items {
        let secret = item.secret_value.trim();
        if secret.is_empty() || !original_text.contains(secret) {
            continue;
        }
        let category = normalize_category(&item.category);
        let kind = normalize_kind(&item.kind);
        let label = if item.label.trim().is_empty() {
            label_for_detection(&kind).to_string()
        } else {
            item.label.trim().to_string()
        };
        let redacted_preview = format!("[VAULT:{category}:{kind}]");
        redacted_text = redacted_text.replace(secret, &redacted_preview);
        items.push(PrivacyGuardItem {
            category,
            kind,
            label,
            secret_value: secret.to_string(),
            redacted_preview,
            confidence: item.confidence.clamp(0.0, 1.0),
        });
    }

    Some(PrivacyGuardDecision {
        has_sensitive_data: !items.is_empty(),
        items,
        redacted_text,
    })
}

fn extract_json_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    (end >= start).then_some(&text[start..=end])
}

fn normalize_category(category: &str) -> String {
    match category.trim().to_ascii_lowercase().as_str() {
        "payment" | "payments" | "card" | "cards" => "payments",
        "identity" | "document" | "documents" | "id" => "identity",
        "health" | "medical" => "health",
        "vehicle" | "vehicles" | "car" => "vehicles",
        "credential" | "credentials" | "password" | "api_key" => "credentials",
        _ => "private_notes",
    }
    .to_string()
}

fn normalize_kind(kind: &str) -> String {
    let normalized = kind.trim().to_ascii_lowercase().replace([' ', '-'], "_");
    if normalized.is_empty() {
        "sensitive_data".to_string()
    } else {
        normalized
    }
}

#[derive(Debug, Clone)]
pub(crate) struct PendingVaultProposal {
    pub(crate) category: String,
    pub(crate) label: String,
    pub(crate) redacted_preview: String,
    pub(crate) secret_value: String,
}

#[derive(Default)]
pub(crate) struct PendingVaultProposalStore {
    inner: Mutex<HashMap<String, PendingVaultProposal>>,
}

impl PendingVaultProposalStore {
    pub(crate) fn insert(&self, proposal: PendingVaultProposal) -> String {
        let id = format!("vault_pending_{}", uuid::Uuid::new_v4().simple());
        if let Ok(mut inner) = self.inner.lock() {
            inner.insert(id.clone(), proposal);
        }
        id
    }

    pub(crate) fn take(&self, id: &str) -> Option<PendingVaultProposal> {
        self.inner.lock().ok()?.remove(id)
    }

    pub(crate) fn get(&self, id: &str) -> Option<PendingVaultProposal> {
        self.inner.lock().ok()?.get(id).cloned()
    }
}

pub(crate) struct PrivacyGuardIntercept {
    pub(crate) user_text: String,
    pub(crate) assistant_text: String,
}

pub(crate) fn build_privacy_guard_intercept(
    store: &PendingVaultProposalStore,
    _request_id: &str,
    decision: &PrivacyGuardDecision,
) -> Option<PrivacyGuardIntercept> {
    if !decision.has_sensitive_data {
        return None;
    }
    let mut markers = Vec::new();
    for item in &decision.items {
        let pending_id = store.insert(PendingVaultProposal {
            category: item.category.clone(),
            label: item.label.clone(),
            redacted_preview: item.redacted_preview.clone(),
            secret_value: item.secret_value.clone(),
        });
        let marker = serde_json::json!({
            "category": item.category,
            "label": item.label,
            "redacted_preview": item.redacted_preview,
            "pending_id": pending_id,
        });
        markers.push(format!("‹‹VAULT_PROPOSE››{marker}‹‹/VAULT_PROPOSE››"));
    }
    Some(PrivacyGuardIntercept {
        user_text: decision.redacted_text.clone(),
        assistant_text: markers.join("\n"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_guard_blocks_remote_but_allows_local_deterministic_fallback() {
        assert_eq!(
            failure_policy(false),
            PrivacyGuardFailurePolicy::BlockAndRetry
        );
        assert_eq!(
            failure_policy(true),
            PrivacyGuardFailurePolicy::DeterministicLocalOnly
        );
    }

    #[test]
    fn deterministic_guard_detects_vehicle_plate_and_redacts_text() {
        let decision = classify_sensitive_input_deterministic(
            "ricordati che la targa della mia auto e' FM470BN e' un'audi q2",
        );

        assert!(decision.has_sensitive_data);
        assert_eq!(decision.items.len(), 1);
        assert_eq!(decision.items[0].category, "vehicles");
        assert_eq!(decision.items[0].kind, "plate");
        assert_eq!(decision.items[0].secret_value, "FM470BN");
        assert!(decision.redacted_text.contains("[VAULT:vehicles:plate]"));
        assert!(!decision.redacted_text.contains("FM470BN"));
    }

    #[test]
    fn deterministic_guard_ignores_non_sensitive_preference() {
        let decision = classify_sensitive_input_deterministic(
            "ricordati che preferisco partire da Napoli al mattino",
        );

        assert!(!decision.has_sensitive_data);
        assert!(decision.items.is_empty());
    }

    #[test]
    fn pending_proposal_store_consumes_secret_once() {
        let store = PendingVaultProposalStore::default();
        let id = store.insert(PendingVaultProposal {
            category: "vehicles".to_string(),
            label: "Targa auto".to_string(),
            redacted_preview: "[VAULT:vehicles:plate]".to_string(),
            secret_value: "FM470BN".to_string(),
        });

        let first = store.take(&id).expect("first take");
        assert_eq!(first.secret_value, "FM470BN");
        assert!(store.take(&id).is_none());
    }

    #[test]
    fn sensitive_turn_builds_redacted_user_and_vault_proposal_answer() {
        let store = PendingVaultProposalStore::default();
        let decision = classify_sensitive_input_deterministic(
            "ricordati che la targa della mia auto e' FM470BN e' un'audi q2",
        );

        let intercept =
            build_privacy_guard_intercept(&store, "req_1", &decision).expect("intercept");

        assert!(!intercept.user_text.contains("FM470BN"));
        assert!(intercept.user_text.contains("[VAULT:vehicles:plate]"));
        assert!(intercept.assistant_text.contains("VAULT_PROPOSE"));
        assert!(intercept.assistant_text.contains("\"pending_id\""));
        assert!(!intercept.assistant_text.contains("FM470BN"));
    }

    #[test]
    fn model_output_builds_decision_only_for_values_present_in_prompt() {
        let decision = decision_from_model_output(
            "ricordati che la targa della mia auto e' FM470BN",
            r#"{
              "has_sensitive_data": true,
              "items": [
                {"category":"vehicles","kind":"plate","label":"Targa auto","secret_value":"FM470BN","confidence":0.91},
                {"category":"identity","kind":"document","label":"Inventato","secret_value":"ABC123","confidence":0.99}
              ]
            }"#,
        )
        .expect("model output parses");

        assert!(decision.has_sensitive_data);
        assert_eq!(decision.items.len(), 1);
        assert_eq!(decision.items[0].secret_value, "FM470BN");
        assert!(decision.redacted_text.contains("[VAULT:vehicles:plate]"));
        assert!(!decision.redacted_text.contains("FM470BN"));
    }

    #[test]
    fn model_and_deterministic_detections_are_merged_without_exposing_values() {
        let original = "La parola che uso per entrare è orchidea; targa FM470BN";
        let model = decision_from_model_output(
            original,
            r#"{"has_sensitive_data":true,"items":[{"category":"credentials","kind":"account_password","label":"Password account","secret_value":"orchidea","confidence":0.99}]}"#,
        )
        .unwrap();
        let deterministic = classify_sensitive_input_deterministic(original);

        let merged = merge_guard_decisions(original, model, deterministic);

        assert_eq!(merged.items.len(), 2);
        assert!(!merged.redacted_text.contains("orchidea"));
        assert!(!merged.redacted_text.contains("FM470BN"));
    }
}
