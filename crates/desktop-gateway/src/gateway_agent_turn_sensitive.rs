//! Agent turn sensitive confirmation seed owner.
//!
//! Owns the pre-loop seed that projects workspace/global skill confirmation
//! policy into `LoopState::active_sensitive`. It does not own tool safety,
//! approval execution, the agent loop, browser execution, or subagents.

use super::*;

pub(crate) fn seed_agent_turn_sensitive_confirmations(
    state: &AppState,
    thread_id: Option<&str>,
    loop_state: &mut local_first_engine::LoopState,
) {
    let existing: Vec<crate::skills::SensitiveCategory> = loop_state
        .active_sensitive
        .iter()
        .filter_map(|token| crate::skills::SensitiveCategory::parse(token))
        .collect();
    let project_sensitive = resolved_skill_confirmations(state, thread_id);
    loop_state.active_sensitive = sensitive_confirmation_tokens(&existing, &project_sensitive);
}

fn sensitive_confirmation_tokens(
    existing: &[crate::skills::SensitiveCategory],
    project_sensitive: &[crate::skills::SensitiveCategory],
) -> Vec<String> {
    let existing = existing.to_vec();
    let project_sensitive = project_sensitive.to_vec();
    merged_sensitive(&existing, &project_sensitive)
        .iter()
        .map(|cat| cat.as_token().to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::sensitive_confirmation_tokens;
    use crate::skills::SensitiveCategory;

    #[test]
    fn sensitive_confirmation_tokens_preserve_existing_before_project_policy() {
        let tokens = sensitive_confirmation_tokens(
            &[SensitiveCategory::Financial],
            &[SensitiveCategory::Delete, SensitiveCategory::Financial],
        );

        assert_eq!(tokens, vec!["financial", "delete"]);
    }

    #[test]
    fn sensitive_confirmation_tokens_seed_project_policy_without_existing_skill() {
        let tokens = sensitive_confirmation_tokens(&[], &[SensitiveCategory::SensitiveData]);

        assert_eq!(tokens, vec!["sensitive-data"]);
    }
}
