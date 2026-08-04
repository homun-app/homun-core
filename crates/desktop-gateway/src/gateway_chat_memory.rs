//! Chat message save-to-memory HTTP handlers for the desktop gateway.
//!
//! This owner contains the explicit user action that confirms a chat message as
//! memory and projects it to the memory wiki.

use crate::*;

pub(crate) async fn save_chat_message_to_memory(
    State(state): State<AppState>,
    Path((thread_id, message_id)): Path<(String, String)>,
) -> Result<Json<ChatMessagesSnapshot>, GatewayError> {
    let message = lock_store(&state)?
        .message(&thread_id, &message_id)
        .map_err(GatewayError::store)?
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "chat_message_not_found",
            message: format!("chat message not found: {message_id}"),
        })?;
    let reference = persist_explicit_memory(&state, &thread_id, &message_id, &message.text)?;
    backfill_embeddings(
        &state,
        &gateway_memory_user_id(),
        &gateway_memory_workspace_id(),
        4,
    )
    .await;
    lock_store(&state)?
        .set_message_saved_memory_ref(&thread_id, &message_id, &reference.to_string())
        .map_err(GatewayError::store)?;
    Ok(Json(
        lock_store(&state)?
            .messages(&thread_id)
            .map_err(GatewayError::store)?,
    ))
}

fn persist_explicit_memory(
    state: &AppState,
    thread_id: &str,
    message_id: &str,
    text: &str,
) -> Result<MemoryRef, GatewayError> {
    let user = gateway_memory_user_id();
    let workspace = gateway_memory_workspace_id();
    let lifecycle = MemoryLifecycleRequest {
        actor_id: "desktop-chat".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "explicit_save_to_memory".to_string(),
    };
    let redacted = redact_sensitive_text(text);

    let facade = memory_facade(state);
    let record = facade
        .create_memory_candidate(MemoryCreateRequest {
            request: lifecycle.clone(),
            memory_type: "note".to_string(),
            text: redacted.clone(),
            aliases: Vec::new(),
            language_hints: Vec::new(),
            confidence: 1.0,
            privacy_domain: PrivacyDomain::new("personal"),
            sensitivity: MemoryDataSensitivity::Private,
            evidence_refs: Vec::new(),
            metadata: serde_json::json!({
                "source": "desktop_chat",
                "thread_id": thread_id,
                "message_id": message_id,
            }),
        })
        .map_err(|error| GatewayError::memory(error.to_string()))?;
    facade
        .confirm_memory(&lifecycle, &record.reference, "explicit user save")
        .map_err(|error| GatewayError::memory(error.to_string()))?;

    let wiki = WikiFileStore::new(gateway_memory_wiki_dir().map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "memory_wiki_dir",
        message: error.to_string(),
    })?);
    let page = WikiPage {
        reference: MemoryRef::generated(MemoryRefKind::Wiki, user.clone(), workspace.clone()),
        user_id: user,
        workspace_id: workspace,
        path: format!(
            "notes/{}.md",
            sanitize_wiki_filename(&record.reference.to_string())
        ),
        title: wiki_title_from_text(&redacted),
        body: redacted,
        linked_refs: vec![record.reference.clone()],
        privacy_domain: PrivacyDomain::new("personal"),
        sensitivity: MemoryDataSensitivity::Private,
    };
    facade
        .project_to_wiki(&wiki, &MemoryWikiProjection { page })
        .map_err(|error| GatewayError::memory(error.to_string()))?;

    Ok(record.reference)
}

fn wiki_title_from_text(text: &str) -> String {
    local_first_memory::wiki_title_from_text(text)
}

fn sanitize_wiki_filename(reference: &str) -> String {
    reference
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wiki_title_and_filename_helpers_are_safe() {
        assert_eq!(
            wiki_title_from_text("\n  Prenota treno  \naltro"),
            "Prenota treno"
        );
        let long = "x".repeat(100);
        let title = wiki_title_from_text(&long);
        assert!(title.chars().count() <= 60 && title.ends_with('\u{2026}'));
        assert_eq!(sanitize_wiki_filename("mem:abc/12-3"), "mem-abc-12-3");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn save_to_memory_returns_not_found_for_missing_message() {
        let state = AppState::for_tests();
        let thread_id = {
            let store = lock_store(&state).unwrap();
            store
                .create_thread("memory-action-workspace")
                .unwrap()
                .thread_id
        };

        let error = save_chat_message_to_memory(
            State(state),
            Path((thread_id, "missing-message".to_string())),
        )
        .await
        .unwrap_err();

        assert_eq!(error.status, StatusCode::NOT_FOUND);
        assert_eq!(error.code, "chat_message_not_found");
    }
}
