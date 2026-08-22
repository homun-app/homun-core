//! Gateway privacy preflight owner.
//!
//! Owns the chat-turn Privacy Guard decision before the agent loop starts. The
//! stream root owns only transport emission of the typed early-response event.

use crate::{gateway_model_routing, privacy_guard};
use local_first_subagents::{GenerateStreamEvent, TokenMetrics};

pub(crate) struct PrivacyGuardPreflightInput<'a> {
    pub(crate) http: &'a reqwest::Client,
    pub(crate) pending_vault_proposals: &'a privacy_guard::PendingVaultProposalStore,
    pub(crate) request_id: &'a str,
    pub(crate) prompt: &'a str,
    pub(crate) applies_new_input: bool,
    pub(crate) orchestrator_is_local: bool,
}

pub(crate) struct ChatPrivacyGuardPreflightInput<'a> {
    pub(crate) http: &'a reqwest::Client,
    pub(crate) pending_vault_proposals: &'a privacy_guard::PendingVaultProposalStore,
    pub(crate) request_id: &'a str,
    pub(crate) prompt: &'a str,
    pub(crate) applies_new_input: bool,
    pub(crate) orchestrator_is_local: bool,
}

pub(crate) enum PrivacyGuardPreflightOutcome {
    Continue,
    EarlyResponse(PrivacyGuardEarlyResponse),
}

pub(crate) struct PrivacyGuardEarlyResponse {
    pub(crate) event: GenerateStreamEvent,
    pub(crate) effective_model: &'static str,
}

pub(crate) async fn evaluate_privacy_guard_preflight(
    input: PrivacyGuardPreflightInput<'_>,
) -> PrivacyGuardPreflightOutcome {
    let deterministic_decision =
        privacy_guard::classify_sensitive_input_deterministic(input.prompt);
    let guarded_decision = if input.applies_new_input {
        match gateway_model_routing::classify_sensitive_input_with_privacy_guard_model(
            input.http,
            input.prompt,
        )
        .await
        {
            privacy_guard::PrivacyGuardModelOutcome::Classified(model_decision) => {
                Ok(privacy_guard::merge_guard_decisions(
                    input.prompt,
                    model_decision,
                    deterministic_decision.clone(),
                ))
            }
            privacy_guard::PrivacyGuardModelOutcome::Unavailable(reason) => Err(reason),
            privacy_guard::PrivacyGuardModelOutcome::InvalidOutput => Err("invalid_output"),
        }
    } else {
        Ok(deterministic_decision.clone())
    };

    let privacy_decision = match guarded_decision {
        Ok(decision) => decision,
        Err(reason) => match privacy_guard::failure_policy(input.orchestrator_is_local) {
            privacy_guard::PrivacyGuardFailurePolicy::DeterministicLocalOnly => {
                tracing::warn!(
                    target: "privacy::guard",
                    %reason,
                    "privacy guard unavailable; using deterministic local-only fallback"
                );
                deterministic_decision
            }
            privacy_guard::PrivacyGuardFailurePolicy::BlockAndRetry => {
                tracing::warn!(
                    target: "privacy::guard",
                    %reason,
                    "privacy guard unavailable; blocking remote inference"
                );
                return PrivacyGuardPreflightOutcome::EarlyResponse(
                    PrivacyGuardEarlyResponse {
                        event: GenerateStreamEvent::Error {
                            code: "privacy_guard_unavailable".to_string(),
                            message: "Privacy Guard non disponibile. Riprova senza inviare dati al provider remoto.".to_string(),
                            retryable: true,
                        },
                        effective_model: "privacy_guard",
                    },
                );
            }
        },
    };

    match privacy_guard_intercept_response(
        input.pending_vault_proposals,
        input.request_id,
        &privacy_decision,
    ) {
        Some(response) => PrivacyGuardPreflightOutcome::EarlyResponse(response),
        None => PrivacyGuardPreflightOutcome::Continue,
    }
}

pub(crate) async fn evaluate_chat_privacy_guard_preflight(
    input: ChatPrivacyGuardPreflightInput<'_>,
) -> PrivacyGuardPreflightOutcome {
    let privacy_prompt = if input.applies_new_input {
        input.prompt
    } else {
        ""
    };
    evaluate_privacy_guard_preflight(PrivacyGuardPreflightInput {
        http: input.http,
        pending_vault_proposals: input.pending_vault_proposals,
        request_id: input.request_id,
        prompt: privacy_prompt,
        applies_new_input: input.applies_new_input,
        orchestrator_is_local: input.orchestrator_is_local,
    })
    .await
}

fn privacy_guard_intercept_response(
    pending_vault_proposals: &privacy_guard::PendingVaultProposalStore,
    request_id: &str,
    privacy_decision: &privacy_guard::PrivacyGuardDecision,
) -> Option<PrivacyGuardEarlyResponse> {
    let intercept = privacy_guard::build_privacy_guard_intercept(
        pending_vault_proposals,
        request_id,
        privacy_decision,
    )?;

    tracing::warn!(
        target: "privacy::guard",
        detections = privacy_decision.items.len(),
        kinds = %privacy_decision
            .items
            .iter()
            .map(|item| format!("{}:{}", item.category, item.kind))
            .collect::<Vec<_>>()
            .join(","),
        "privacy guard intercepted the turn (user text rewritten)"
    );

    Some(PrivacyGuardEarlyResponse {
        event: GenerateStreamEvent::Done {
            text: intercept.assistant_text,
            metrics: TokenMetrics::zero(),
            redacted_user_text: Some(intercept.user_text),
        },
        effective_model: "privacy_guard",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn chat_privacy_preflight_ignores_prompt_when_no_new_input_applies() {
        let store = privacy_guard::PendingVaultProposalStore::default();
        let outcome = evaluate_chat_privacy_guard_preflight(ChatPrivacyGuardPreflightInput {
            http: &reqwest::Client::new(),
            pending_vault_proposals: &store,
            request_id: "req_1",
            prompt: "ricordati che la targa della mia auto e' FM470BN",
            applies_new_input: false,
            orchestrator_is_local: true,
        })
        .await;

        assert!(matches!(outcome, PrivacyGuardPreflightOutcome::Continue));
    }

    #[test]
    fn privacy_guard_intercept_response_redacts_secret_and_uses_privacy_model() {
        let store = privacy_guard::PendingVaultProposalStore::default();
        let decision = privacy_guard::classify_sensitive_input_deterministic(
            "ricordati che la targa della mia auto e' FM470BN",
        );

        let response =
            privacy_guard_intercept_response(&store, "req_1", &decision).expect("response");

        assert_eq!(response.effective_model, "privacy_guard");
        match response.event {
            GenerateStreamEvent::Done {
                text,
                redacted_user_text,
                ..
            } => {
                assert!(text.contains("VAULT_PROPOSE"));
                assert!(!text.contains("FM470BN"));
                let redacted = redacted_user_text.expect("redacted text");
                assert!(redacted.contains("[VAULT:vehicles:plate]"));
                assert!(!redacted.contains("FM470BN"));
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }
}
