//! Chat branch HTTP handlers for the desktop gateway.
//!
//! This owner keeps branch switcher endpoints separate from route assembly and
//! from the broader chat thread CRUD owner.

use axum::{
    Json,
    extract::{Path, State},
};
#[cfg(test)]
use local_first_desktop_gateway::ChatMessage;
use local_first_desktop_gateway::{
    ChatMessagesSnapshot, SetActiveLeafRequest, SetBranchLabelRequest,
};

use crate::chat_store::BranchPoint;
use crate::{AppState, GatewayError, lock_store};

/// Branch switcher: every branch point on the thread's active path.
pub(crate) async fn chat_branches(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> Result<Json<Vec<BranchPoint>>, GatewayError> {
    Ok(Json(
        lock_store(&state)?
            .branch_options(&thread_id)
            .map_err(GatewayError::store)?,
    ))
}

/// Point the displayed conversation at a specific leaf.
pub(crate) async fn set_active_leaf(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<SetActiveLeafRequest>,
) -> Result<Json<ChatMessagesSnapshot>, GatewayError> {
    let store = lock_store(&state)?;
    store
        .set_active_leaf(&thread_id, request.leaf_id.as_deref())
        .map_err(GatewayError::store)?;
    Ok(Json(
        store.messages(&thread_id).map_err(GatewayError::store)?,
    ))
}

/// Name or clear a branch label.
pub(crate) async fn set_branch_label(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<SetBranchLabelRequest>,
) -> Result<Json<Vec<BranchPoint>>, GatewayError> {
    let store = lock_store(&state)?;
    store
        .set_branch_label(&thread_id, &request.message_id, request.label.as_deref())
        .map_err(GatewayError::store)?;
    Ok(Json(
        store
            .branch_options(&thread_id)
            .map_err(GatewayError::store)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_message(id: &str, role: &str) -> ChatMessage {
        ChatMessage {
            id: id.to_string(),
            role: role.to_string(),
            text: format!("{id} text"),
            timestamp: "1".to_string(),
            metadata: None,
            metrics: None,
            feedback: None,
            saved_memory_ref: None,
            linked_task_id: None,
            linked_automation_ref: None,
            attachments: Vec::new(),
            event_parts: Vec::new(),
            memory_reuse: None,
            delivery_state: local_first_desktop_gateway::MessageDeliveryState::Delivered,
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn active_leaf_handler_returns_the_selected_branch_snapshot() {
        let state = AppState::for_tests();
        let (thread, seed_id) = {
            let store = lock_store(&state).unwrap();
            let thread = store.create_thread("branch-workspace").unwrap();
            let seed_id = store.messages(&thread.thread_id).unwrap().messages[0]
                .id
                .clone();
            store
                .commit_prompt_result(
                    &thread.thread_id,
                    &mk_message("u1", "user"),
                    &mk_message("a1", "assistant"),
                    None,
                )
                .unwrap();
            store
                .commit_prompt_result(
                    &thread.thread_id,
                    &mk_message("u1b", "user"),
                    &mk_message("a1b", "assistant"),
                    Some("u1"),
                )
                .unwrap();
            (thread, seed_id)
        };
        let first_branch_leaf = {
            let store = lock_store(&state).unwrap();
            store.branch_options(&thread.thread_id).unwrap()[0].options[0]
                .leaf_id
                .clone()
        };

        let Json(snapshot) = set_active_leaf(
            State(state),
            Path(thread.thread_id),
            Json(SetActiveLeafRequest {
                leaf_id: Some(first_branch_leaf),
            }),
        )
        .await
        .unwrap();

        let ids: Vec<&str> = snapshot
            .messages
            .iter()
            .map(|message| message.id.as_str())
            .collect();
        assert_eq!(ids, vec![seed_id.as_str(), "u1", "a1"]);
    }
}
