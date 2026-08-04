//! Always-on memory briefing for prompt assembly.
//!
//! This owner contains the memory profile that is pushed into chat prompts: the
//! authorized source policy, cache source fingerprint, profile memory gathering,
//! prompt block formatting, and memory-intent injection policy. Artifact memory,
//! wiki rebuilds, and HTTP embedding calls remain in their current owners.

use crate::*;

/// Character budget for the always-on memory profile injected into the chat
/// prompt. The always-on "what I know about you / this project" briefing — push, not
/// the on-demand `recall` tool. Raised from 1500: on capable models the context window
/// is large and a starved briefing was the main reason the assistant "didn't seem to
/// know" the project. Still bounded so it never dominates the prompt.
pub(crate) const CHAT_MEMORY_BUDGET_CHARS: usize = 4000;

pub(crate) fn briefing_authorized_sources(
    facade: &MemoryFacade,
    user: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
    now_unix: i64,
) -> Vec<local_first_memory::AuthorizedMemorySource> {
    let local_only = || {
        local_first_memory::resolve_memory_sources(user, workspace, &[], now_unix)
            .unwrap_or_default()
    };
    if workspace.as_str() == PERSONAL_WORKSPACE || !memory_sources_enabled() {
        return local_only();
    }
    let Ok(sources) = facade.resolve_memory_sources(user, workspace, now_unix) else {
        return local_only();
    };
    sources
        .into_iter()
        .filter(|source| {
            source.grant_id.is_none()
                || (source.source_workspace_id.as_str() == PERSONAL_WORKSPACE
                    && source.policy.as_ref().is_some_and(|policy| {
                        policy
                            .collections
                            .contains(&MemoryCollectionKey::Preferences)
                    }))
        })
        .collect()
}

pub(crate) fn memory_briefing_source_fingerprint(
    state: &AppState,
    user: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
    now_unix: i64,
) -> u64 {
    let facade = memory_facade(state);
    let sources = briefing_authorized_sources(facade, user, workspace, now_unix);
    let mut hasher = Sha256::new();
    hasher.update(b"homun-memory-briefing-sources-v1");
    hasher.update(local_first_memory::memory_source_policy_fingerprint(&sources).to_be_bytes());
    for source in &sources {
        for field in [
            source.source_user_id.as_str(),
            source.source_workspace_id.as_str(),
        ] {
            hasher.update((field.len() as u64).to_be_bytes());
            hasher.update(field.as_bytes());
        }
        hasher.update(
            facade
                .briefing_generation(&source.source_user_id, &source.source_workspace_id)
                .to_be_bytes(),
        );
    }
    let digest = hasher.finalize();
    u64::from_be_bytes(digest[..8].try_into().expect("SHA-256 prefix is 8 bytes"))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn revalidated_cached_briefing<F>(
    state: &AppState,
    user: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
    scope_key: &str,
    generation: u64,
    source_fingerprint: u64,
    prompt_fingerprint: u64,
    before_revalidation: F,
) -> Option<BriefingPack>
where
    F: FnOnce(),
{
    let cached = briefing_cache().get(
        scope_key,
        generation,
        source_fingerprint,
        prompt_fingerprint,
    )?;
    before_revalidation();
    let current_generation = memory_facade(state).briefing_generation(user, workspace);
    let current_source_fingerprint = memory_briefing_source_fingerprint(
        state,
        user,
        workspace,
        i64::try_from(now_epoch_secs()).unwrap_or(i64::MAX),
    );
    (current_generation == generation && current_source_fingerprint == source_fingerprint)
        .then_some(cached)
}

#[derive(Debug, Clone)]
pub(crate) struct BriefingMemoryItem {
    pub(crate) text: String,
    pub(crate) linked_hit: Option<RecallHit>,
}

pub(crate) fn briefing_items_for_authorized_source(
    facade: &MemoryFacade,
    source: &local_first_memory::AuthorizedMemorySource,
    preferences_only: bool,
) -> Vec<BriefingMemoryItem> {
    let mut records = facade
        .list_memories_for_ui(&source.source_user_id, &source.source_workspace_id)
        .unwrap_or_default()
        .into_iter()
        .filter(|memory| memory.status == MemoryStatus::Confirmed)
        .filter(|memory| !preferences_only || MemoryCollectionKey::Preferences.matches(memory))
        .filter_map(|memory| {
            facade
                .get_authorized_memory_for_source(source, &memory.reference)
                .ok()
                .flatten()
        })
        .collect::<Vec<_>>();
    records.sort_by(|left, right| {
        right
            .confidence
            .partial_cmp(&left.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    records
        .into_iter()
        .filter(|memory| {
            let low = memory.text.to_lowercase();
            !(low.starts_with("runtime plan step")
                || low.starts_with("runtime plan state")
                || low.starts_with("validation test:"))
        })
        .map(|memory| {
            let linked_hit = source.grant_id.as_ref().map(|grant_id| RecallHit {
                memory_ref: memory.reference.to_string(),
                text: memory.text.clone(),
                score: memory.confidence as f32,
                kind: memory.memory_type.clone(),
                source_user_id: source.source_user_id.clone(),
                source_workspace_id: source.source_workspace_id.clone(),
                source_label: source.source_label.clone(),
                collection: MemoryCollectionKey::for_memory(&memory)
                    .unwrap_or(MemoryCollectionKey::Knowledge),
                grant_id: Some(grant_id.clone()),
                policy_version: Some(source.policy_version),
                source_revision: memory_record_revision(&memory),
                sensitivity: memory.sensitivity,
                status: memory.status,
                updated_at: memory.updated_at.clone(),
                subject_key: memory
                    .metadata
                    .get("subject_key")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                conflict: false,
                publication_link: memory
                    .metadata
                    .get("publication_link")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                graph_path: Vec::new(),
            });
            BriefingMemoryItem {
                text: memory.text,
                linked_hit,
            }
        })
        .collect()
}

#[cfg(test)]
pub(crate) fn gather_profile_memory_for_prompt(
    state: &AppState,
    intent: &semantic_decision::MemoryIntent,
) -> (Vec<String>, Vec<String>) {
    gather_profile_memory_with_options(state, !intent.search_personal, intent.search_project)
}

pub(crate) fn gather_profile_memory_for_intent_with_provenance(
    state: &AppState,
    intent: &semantic_decision::MemoryIntent,
) -> (Vec<BriefingMemoryItem>, Vec<BriefingMemoryItem>) {
    gather_profile_memory_with_provenance(state, !intent.search_personal, intent.search_project)
}

#[cfg(test)]
pub(crate) fn gather_profile_memory_with_options(
    state: &AppState,
    personal_preferences_only_override: bool,
    include_project: bool,
) -> (Vec<String>, Vec<String>) {
    let (personal, project) = gather_profile_memory_with_provenance(
        state,
        personal_preferences_only_override,
        include_project,
    );
    (
        personal.into_iter().map(|item| item.text).collect(),
        project.into_iter().map(|item| item.text).collect(),
    )
}

pub(crate) fn gather_profile_memory_with_provenance(
    state: &AppState,
    personal_preferences_only_override: bool,
    include_project: bool,
) -> (Vec<BriefingMemoryItem>, Vec<BriefingMemoryItem>) {
    let facade = memory_facade(state);
    let user = gateway_memory_user_id();
    let active = gateway_memory_workspace_id();
    let in_project = active.as_str() != PERSONAL_WORKSPACE;
    let sources = briefing_authorized_sources(
        facade,
        &user,
        &active,
        i64::try_from(now_epoch_secs()).unwrap_or(i64::MAX),
    );
    let personal = sources
        .iter()
        .find(|source| source.source_workspace_id.as_str() == PERSONAL_WORKSPACE)
        .map(|source| {
            briefing_items_for_authorized_source(
                facade,
                source,
                in_project || personal_preferences_only_override,
            )
        })
        .unwrap_or_default();
    let project = if in_project && include_project {
        sources
            .iter()
            .find(|source| source.grant_id.is_none())
            .map(|source| briefing_items_for_authorized_source(facade, source, false))
            .unwrap_or_default()
    } else {
        Default::default()
    };
    (personal, project)
}

#[derive(Debug, Default)]
pub(crate) struct FormattedMemoryBlock {
    pub(crate) block: Option<String>,
    pub(crate) linked_hits: Vec<RecallHit>,
}

pub(crate) fn format_memory_block_with_provenance(
    open_loops: &[String],
    personal: &[BriefingMemoryItem],
    project: &[BriefingMemoryItem],
    budget: usize,
) -> FormattedMemoryBlock {
    if budget == 0 {
        return FormattedMemoryBlock::default();
    }
    let open_loop_items = open_loops
        .iter()
        .cloned()
        .map(|text| BriefingMemoryItem {
            text,
            linked_hit: None,
        })
        .collect::<Vec<_>>();
    let sections = [
        (
            "OPEN LOOPS — unfinished work, resume from here",
            open_loop_items.as_slice(),
        ),
        ("Personal", personal),
        ("Project", project),
    ];
    let mut body = String::new();
    let mut used = 0usize;
    let mut truncated = false;
    let mut linked_hits = Vec::new();
    for (title, items) in sections {
        let mut section = String::new();
        for item in items {
            let one = item.text.trim().replace('\n', " ");
            if one.is_empty() {
                continue;
            }
            let clipped = if one.chars().count() > 200 {
                format!("{}…", one.chars().take(199).collect::<String>())
            } else {
                one
            };
            let line = format!("- {clipped}\n");
            if used + line.len() > budget {
                truncated = true;
                break;
            }
            used += line.len();
            section.push_str(&line);
            if let Some(hit) = &item.linked_hit {
                linked_hits.push(hit.clone());
            }
        }
        if !section.is_empty() {
            body.push_str(title);
            body.push_str(":\n");
            body.push_str(&section);
        }
        if truncated {
            break;
        }
    }
    if body.trim().is_empty() {
        return FormattedMemoryBlock::default();
    }
    let mut block = String::from(
        "PROFILE AND MEMORY — what you remember about the user and the project. Use it if relevant; don't list it back verbatim and don't invent anything that isn't here.\n",
    );
    block.push_str(&body);
    if truncated {
        block.push_str("- … (more available in memory)\n");
    }
    FormattedMemoryBlock {
        block: Some(block.trim_end().to_string()),
        linked_hits,
    }
}

#[cfg(test)]
pub(crate) fn format_memory_block(
    open_loops: &[String],
    personal: &[String],
    project: &[String],
    budget: usize,
) -> Option<String> {
    let personal = personal
        .iter()
        .cloned()
        .map(|text| BriefingMemoryItem {
            text,
            linked_hit: None,
        })
        .collect::<Vec<_>>();
    let project = project
        .iter()
        .cloned()
        .map(|text| BriefingMemoryItem {
            text,
            linked_hit: None,
        })
        .collect::<Vec<_>>();
    format_memory_block_with_provenance(open_loops, &personal, &project, budget).block
}

pub(crate) fn memory_intent_for_execution(
    state: &AppState,
    thread_id: Option<&str>,
) -> semantic_decision::MemoryIntent {
    objective_contract_for_execution(state, thread_id)
        .as_ref()
        .and_then(semantic_decision::semantic_decision_from_contract)
        .map(|validated| validated.decision.memory_intent)
        .unwrap_or_else(semantic_decision::MemoryIntent::safe_default)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MemoryInjectionPolicy {
    pub(crate) include_current_thread: bool,
    pub(crate) include_cross_thread: bool,
}

pub(crate) fn memory_injection_policy(
    intent: &semantic_decision::MemoryIntent,
) -> MemoryInjectionPolicy {
    MemoryInjectionPolicy {
        include_current_thread: intent.use_current_thread,
        include_cross_thread: !intent.standalone_choice_request
            && (intent.search_personal || intent.search_project),
    }
}

pub(crate) fn memory_intent_allows_recall(intent: &semantic_decision::MemoryIntent) -> bool {
    intent.search_personal || intent.search_project || intent.vault_value_requested
}

#[cfg(test)]
mod tests {
    use super::*;

    fn linked_hit(key: &str, text: &str) -> RecallHit {
        RecallHit {
            memory_ref: format!("memory:owner:personal:{key}"),
            text: text.to_string(),
            score: 1.0,
            kind: "preference".to_string(),
            source_user_id: MemoryUserId::new("owner"),
            source_workspace_id: MemoryWorkspaceId::new(PERSONAL_WORKSPACE),
            source_label: "Personal".to_string(),
            collection: MemoryCollectionKey::Preferences,
            grant_id: Some("grant-a".to_string()),
            policy_version: Some(3),
            source_revision: format!("sha256:{key}"),
            sensitivity: MemoryDataSensitivity::Private,
            status: MemoryStatus::Confirmed,
            updated_at: "unix:1.000000000".to_string(),
            subject_key: None,
            conflict: false,
            publication_link: None,
            graph_path: Vec::new(),
        }
    }

    #[test]
    fn memory_block_labels_sections_and_includes_text() {
        let personal = vec!["Preferisce risposte concise in italiano".to_string()];
        let project = vec!["Repo principale: /Clients/Acme/app".to_string()];
        let block = format_memory_block(&[], &personal, &project, 1500).expect("block");
        assert!(block.contains("Personal:"));
        assert!(block.contains("risposte concise"));
        assert!(block.contains("Project:"));
        assert!(block.contains("/Clients/Acme/app"));
    }

    #[test]
    fn memory_block_puts_open_loops_first() {
        let open_loops = vec!["Preventivo Rossi incompleto: manca assistenza".to_string()];
        let personal = vec!["Preferisce risposte in italiano".to_string()];
        let block = format_memory_block(&open_loops, &personal, &[], 1500).expect("block");
        assert!(block.contains("OPEN LOOPS"));
        assert!(block.contains("Preventivo Rossi"));
        assert!(
            block.find("OPEN LOOPS").unwrap() < block.find("Personal:").unwrap(),
            "open loops must come before personal"
        );
    }

    #[test]
    fn budgeted_briefing_attests_only_linked_items_that_enter_the_prompt() {
        let first_text = "First linked preference";
        let second_text = "Second linked preference that must not fit";
        let personal = vec![
            BriefingMemoryItem {
                text: first_text.to_string(),
                linked_hit: Some(linked_hit("first", first_text)),
            },
            BriefingMemoryItem {
                text: second_text.to_string(),
                linked_hit: Some(linked_hit("second", second_text)),
            },
        ];
        let budget = format!("- {first_text}\n").len();

        let formatted = format_memory_block_with_provenance(&[], &personal, &[], budget);

        assert!(
            formatted
                .block
                .as_deref()
                .is_some_and(|block| block.contains(first_text))
        );
        assert!(
            formatted
                .block
                .as_deref()
                .is_some_and(|block| !block.contains(second_text))
        );
        assert_eq!(formatted.linked_hits.len(), 1);
        assert!(formatted.linked_hits[0].memory_ref.ends_with(":first"));
    }

    #[test]
    fn memory_block_respects_budget_and_marks_truncation() {
        let many: Vec<String> = (0..200)
            .map(|i| format!("fatto numero {i} con testo abbastanza lungo da occupare spazio"))
            .collect();
        let block = format_memory_block(&[], &many, &[], 300).expect("block");
        assert!(
            block.len() < 600,
            "block should be bounded, got {}",
            block.len()
        );
        assert!(block.contains("more available in memory"));
    }

    #[test]
    fn memory_intent_policy_controls_cross_thread_injection_and_recall() {
        let mut intent = semantic_decision::MemoryIntent::safe_default();
        assert_eq!(
            memory_injection_policy(&intent),
            MemoryInjectionPolicy {
                include_current_thread: true,
                include_cross_thread: false,
            }
        );
        assert!(!memory_intent_allows_recall(&intent));

        intent.search_project = true;
        assert!(memory_injection_policy(&intent).include_cross_thread);
        assert!(memory_intent_allows_recall(&intent));

        intent.standalone_choice_request = true;
        assert!(!memory_injection_policy(&intent).include_cross_thread);
    }
}
