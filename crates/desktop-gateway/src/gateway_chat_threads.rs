//! Chat thread HTTP handlers for the desktop gateway.
//!
//! This owner keeps sidebar thread lifecycle and transcript message listing out
//! of the gateway root. Route assembly remains in `gateway_routes`.

use crate::*;

/// Optional `?workspace=<id>` selects a SPECIFIC workspace's threads (default: the
/// active one). Lets the sidebar show the base/Personale list while a project is
/// active, and create a free task in the base from within a project.
#[derive(Debug, Deserialize, Default)]
pub(crate) struct ChatThreadsQuery {
    #[serde(default)]
    workspace: Option<String>,
}

fn resolve_threads_workspace(query: &ChatThreadsQuery) -> String {
    query
        .workspace
        .as_ref()
        .map(|w| w.trim())
        .filter(|w| !w.is_empty())
        .map(|w| w.to_string())
        .unwrap_or_else(active_workspace_id)
}

pub(crate) async fn chat_threads(
    State(state): State<AppState>,
    Query(query): Query<ChatThreadsQuery>,
) -> Result<Json<ChatThreadSnapshot>, GatewayError> {
    Ok(Json(
        lock_store(&state)?
            .threads(&resolve_threads_workspace(&query))
            .map_err(GatewayError::store)?,
    ))
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ThreadAttentionResponse {
    thread_id: String,
    status: String,
    latest_terminal_event_id: Option<i64>,
    last_seen_terminal_event_id: i64,
    updated_at: i64,
}

impl ThreadAttentionResponse {
    fn from_projection(
        projection: local_first_task_runtime::ThreadAttention,
        last_seen_terminal_event_id: i64,
    ) -> Self {
        Self {
            thread_id: projection.thread_id,
            status: projection.status,
            latest_terminal_event_id: projection.latest_terminal_event_id,
            last_seen_terminal_event_id,
            updated_at: projection.updated_at,
        }
    }
}

pub(crate) async fn chat_thread_attentions(
    State(state): State<AppState>,
    Query(query): Query<ChatThreadsQuery>,
) -> Result<Json<Vec<ThreadAttentionResponse>>, GatewayError> {
    let workspace_id = resolve_threads_workspace(&query);
    let thread_receipts = {
        let store = lock_store(&state)?;
        let snapshot = store.threads(&workspace_id).map_err(GatewayError::store)?;
        snapshot
            .threads
            .into_iter()
            .map(|thread| {
                let seen = store
                    .thread_terminal_seen(&thread.thread_id)
                    .map_err(GatewayError::store)?;
                Ok((thread.thread_id, seen))
            })
            .collect::<Result<Vec<_>, GatewayError>>()?
    };
    let task_store = lock_task_store(&state)?;
    let mut response = Vec::with_capacity(thread_receipts.len());
    for (thread_id, seen) in thread_receipts {
        let projection = task_store
            .thread_attention(&thread_id)
            .map_err(GatewayError::task)?;
        response.push(ThreadAttentionResponse::from_projection(projection, seen));
    }
    Ok(Json(response))
}

#[derive(Debug, Deserialize)]
pub(crate) struct MarkThreadSeenRequest {
    terminal_event_id: i64,
}

fn seen_terminal_cursor_to_persist(requested: i64, latest: Option<i64>) -> i64 {
    requested.max(0).min(latest.unwrap_or(0).max(0))
}

pub(crate) async fn mark_chat_thread_seen(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<MarkThreadSeenRequest>,
) -> Result<Json<ThreadAttentionResponse>, GatewayError> {
    let projection = {
        let task_store = lock_task_store(&state)?;
        task_store
            .thread_attention(&thread_id)
            .map_err(GatewayError::task)?
    };
    let cursor = seen_terminal_cursor_to_persist(
        request.terminal_event_id,
        projection.latest_terminal_event_id,
    );
    let seen = {
        let store = lock_store(&state)?;
        store
            .mark_thread_terminal_seen(&thread_id, cursor)
            .map_err(GatewayError::store)?;
        store
            .thread_terminal_seen(&thread_id)
            .map_err(GatewayError::store)?
    };
    Ok(Json(ThreadAttentionResponse::from_projection(
        projection, seen,
    )))
}

pub(crate) async fn create_chat_thread(
    State(state): State<AppState>,
    Query(query): Query<ChatThreadsQuery>,
) -> Result<Json<ChatThread>, GatewayError> {
    Ok(Json(
        lock_store(&state)?
            .create_thread(&resolve_threads_workspace(&query))
            .map_err(GatewayError::store)?,
    ))
}

pub(crate) async fn select_chat_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> Result<Json<ChatThreadSnapshot>, GatewayError> {
    Ok(Json(
        lock_store(&state)?
            .select_thread(&thread_id)
            .map_err(GatewayError::store)?,
    ))
}

pub(crate) async fn set_chat_thread_pinned(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<SetThreadPinnedRequest>,
) -> Result<Json<ChatThreadSnapshot>, GatewayError> {
    Ok(Json(
        lock_store(&state)?
            .set_pinned(&thread_id, request.pinned)
            .map_err(GatewayError::store)?,
    ))
}

#[derive(Deserialize)]
pub(crate) struct RenameChatThreadRequest {
    title: String,
}

pub(crate) async fn rename_chat_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<RenameChatThreadRequest>,
) -> Result<Json<ChatThreadSnapshot>, GatewayError> {
    let title = request.title.trim();
    if title.is_empty() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "thread_title_required",
            message: "title must not be empty".to_string(),
        });
    }
    Ok(Json(
        lock_store(&state)?
            .rename_thread(&thread_id, title)
            .map_err(GatewayError::store)?,
    ))
}

#[derive(Deserialize)]
pub(crate) struct ReorderThreadsRequest {
    workspace_id: String,
    ordered_ids: Vec<String>,
}

pub(crate) async fn reorder_chat_threads(
    State(state): State<AppState>,
    Json(request): Json<ReorderThreadsRequest>,
) -> Result<Json<ChatThreadSnapshot>, GatewayError> {
    Ok(Json(
        lock_store(&state)?
            .set_threads_order(&request.workspace_id, &request.ordered_ids)
            .map_err(GatewayError::store)?,
    ))
}

pub(crate) async fn archive_chat_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> Result<Json<ChatThreadSnapshot>, GatewayError> {
    let workspace_id = lock_store(&state)?
        .workspace_for_thread(&thread_id)
        .map_err(GatewayError::store)?;
    let snapshot = lock_store(&state)?
        .set_status(&thread_id, "archived")
        .map_err(GatewayError::store)?;
    let st = state.clone();
    let tid = thread_id.clone();
    let _ =
        tokio::task::spawn_blocking(move || close_thread_browser_session(&st, &tid, &workspace_id))
            .await;
    Ok(Json(snapshot))
}

pub(crate) async fn unarchive_chat_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> Result<Json<ChatThreadSnapshot>, GatewayError> {
    Ok(Json(
        lock_store(&state)?
            .set_status(&thread_id, "active")
            .map_err(GatewayError::store)?,
    ))
}

pub(crate) async fn delete_chat_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> Result<Json<ChatThreadSnapshot>, GatewayError> {
    // Read the owning workspace before removing the thread, then purge its execution journal.
    // This step runs first so a task-store failure leaves the visible chat available for retry.
    let workspace_id = lock_store(&state)?
        .workspace_for_thread(&thread_id)
        .map_err(GatewayError::store)?;
    {
        let task_store = lock_task_store(&state)?;
        task_store
            .purge_agent_runs_for_thread(&thread_id, gateway_user_id().as_str(), &workspace_id)
            .map_err(GatewayError::task)?;
        task_store
            .purge_runtime_plan_for_thread(gateway_user_id().as_str(), &workspace_id, &thread_id)
            .map_err(GatewayError::task)?;
        task_store
            .purge_chat_turns_for_thread(&thread_id, gateway_user_id().as_str(), &workspace_id)
            .map_err(GatewayError::task)?;
    }
    let snapshot = lock_store(&state)?
        .delete_thread(&thread_id)
        .map_err(GatewayError::store)?;
    if let Ok(data_dir) = gateway_data_dir() {
        let _ = std::fs::remove_file(working_ledger::ledger_path(&data_dir, &thread_id));
    }
    let st = state.clone();
    let tid = thread_id.clone();
    let cleanup_workspace = workspace_id.clone();
    let _ = tokio::task::spawn_blocking(move || {
        close_thread_browser_session(&st, &tid, &cleanup_workspace)
    })
    .await;
    // WS2-3.3: deleting chat history must NOT delete deliverables. Artifacts are
    // product outputs with their own lifecycle; users delete them explicitly from
    // the Artifacts surface so memory/provenance can be tombstoned coherently.
    if delete_chat_thread_should_remove_artifacts() {
        let artifacts = sandbox::artifacts_dir().join(artifact_thread_slug(Some(&thread_id)));
        let _ = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&artifacts)).await;
    }
    Ok(Json(snapshot))
}

fn delete_chat_thread_should_remove_artifacts() -> bool {
    false
}

pub(crate) async fn chat_messages(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> Result<Json<ChatMessagesSnapshot>, GatewayError> {
    Ok(Json(
        lock_store(&state)?
            .messages(&thread_id)
            .map_err(GatewayError::store)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::seen_terminal_cursor_to_persist;

    #[test]
    fn seen_cursor_is_clamped_to_the_latest_terminal() {
        assert_eq!(seen_terminal_cursor_to_persist(99, Some(41)), 41);
        assert_eq!(seen_terminal_cursor_to_persist(20, Some(41)), 20);
        assert_eq!(seen_terminal_cursor_to_persist(-1, Some(41)), 0);
        assert_eq!(seen_terminal_cursor_to_persist(10, None), 0);
    }

    #[test]
    fn delete_chat_thread_preserves_artifact_lifecycle() {
        assert!(
            !super::delete_chat_thread_should_remove_artifacts(),
            "chat deletion must not remove deliverables; artifact deletion is explicit"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn delete_chat_thread_purges_its_execution_journal() {
        let state = super::AppState::for_tests();
        let thread = state
            .chat_store
            .lock()
            .unwrap()
            .create_thread("journal-workspace")
            .unwrap();
        let user = super::gateway_user_id();
        state
            .task_store
            .lock()
            .unwrap()
            .create_agent_run(&local_first_task_runtime::NewAgentRun {
                run_id: "delete-thread-run".to_string(),
                turn_id: "delete-thread-turn".to_string(),
                thread_id: thread.thread_id.clone(),
                user_id: user.as_str().to_string(),
                workspace_id: "journal-workspace".to_string(),
                role: None,
                model: None,
                provider: None,
                prompt_fingerprint: None,
            })
            .unwrap();
        let mut waiting_turn = local_first_task_runtime::TaskRecord::new(
            "delete-thread-waiting-turn",
            user.clone(),
            local_first_task_runtime::WorkspaceId::new("journal-workspace"),
            "chat_turn",
            "waiting approval",
            serde_json::json!({}),
        );
        waiting_turn.status = local_first_task_runtime::TaskStatus::WaitingUserApproval;
        state
            .task_store
            .lock()
            .unwrap()
            .insert_chat_turn(
                &waiting_turn,
                &thread.thread_id,
                "delete-thread-request",
                "interactive",
                "full",
            )
            .unwrap();

        let _ = super::delete_chat_thread(
            axum::extract::State(state.clone()),
            axum::extract::Path(thread.thread_id.clone()),
        )
        .await
        .unwrap();

        assert!(
            state
                .task_store
                .lock()
                .unwrap()
                .list_agent_runs_for_turn("delete-thread-turn", user.as_str(), "journal-workspace",)
                .unwrap()
                .is_empty()
        );
        assert!(
            state
                .task_store
                .lock()
                .unwrap()
                .get_task(
                    &local_first_task_runtime::TaskId::new("delete-thread-waiting-turn"),
                    &user,
                    &local_first_task_runtime::WorkspaceId::new("journal-workspace"),
                )
                .unwrap()
                .is_none()
        );
        assert!(
            state
                .chat_store
                .lock()
                .unwrap()
                .thread(&thread.thread_id)
                .unwrap()
                .is_none()
        );
    }
}
