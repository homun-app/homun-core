//! Chat message task-action HTTP handlers for the desktop gateway.
//!
//! This owner keeps transcript task actions separate from route assembly and
//! from memory-save actions, which have a broader memory/embedding boundary.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use local_first_desktop_gateway::ChatMessagesSnapshot;

use crate::{
    AppState, GatewayError, brain_materialize_enabled, brain_materialize_tasks, lock_store,
};

pub(crate) async fn create_task_from_chat_message(
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
    if brain_materialize_enabled() {
        let state_for_brain = state.clone();
        let thread_for_brain = thread_id.clone();
        let goal = message.text.clone();
        if let Err(error) = tokio::task::spawn_blocking(move || {
            brain_materialize_tasks(&state_for_brain, &thread_for_brain, &goal)
        })
        .await
        .map_err(|join_error| format!("join error: {join_error}"))
        .and_then(|result| result.map_err(|error| error.message))
        {
            eprintln!("brain_materialize (create_task): {error}");
        }
    }
    Ok(Json(
        lock_store(&state)?
            .messages(&thread_id)
            .map_err(GatewayError::store)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn create_task_returns_not_found_for_missing_message() {
        let state = AppState::for_tests();
        let thread_id = {
            let store = lock_store(&state).unwrap();
            store
                .create_thread("task-action-workspace")
                .unwrap()
                .thread_id
        };

        let error = create_task_from_chat_message(
            State(state),
            Path((thread_id, "missing-message".to_string())),
        )
        .await
        .unwrap_err();

        assert_eq!(error.status, StatusCode::NOT_FOUND);
        assert_eq!(error.code, "chat_message_not_found");
    }
}
