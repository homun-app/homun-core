//! Visible conversation turn persistence owner.
//!
//! Owns creation of the transcript-visible user/assistant pair for a running
//! turn and the `thread.turn_started` app event that lets the UI attach to it.
//! Broker enqueue, stream draining, finalization, and executor logic remain in
//! their own modules.

use super::*;

#[derive(Debug, Clone)]
pub(crate) struct VisibleConversationTurn {
    pub(crate) turn_id: String,
    pub(crate) user_message_id: String,
    pub(crate) assistant_message_id: String,
}

pub(crate) fn thread_turn_started_event(
    thread_id: &str,
    workspace: &str,
    source: &str,
    channel: Option<&str>,
    title: &str,
    turn: &VisibleConversationTurn,
) -> serde_json::Value {
    let mut event = serde_json::json!({
        "type": "thread.turn_started",
        "thread_id": thread_id,
        "workspace": workspace,
        "source": source,
        "title": title,
        "turn_id": turn.turn_id,
        "user_message_id": turn.user_message_id,
        "assistant_message_id": turn.assistant_message_id,
    });
    if let Some(channel) = channel {
        event["channel"] = serde_json::Value::String(channel.to_string());
    }
    event
}

/// A store error a retry (fresh transaction) can plausibly clear: SQLite BUSY/LOCKED
/// under the unified homun.sqlite/WAL when another writer is active. `busy_timeout`
/// handles pure busy-waiting, but a write-write snapshot conflict returns immediately;
/// only re-running the transaction, not waiting, resolves it.
fn is_transient_store_error(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(e, _)
            if matches!(
                e.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            )
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn start_visible_conversation_turn(
    state: &AppState,
    thread_id: &str,
    workspace: &str,
    source: &str,
    channel: Option<&str>,
    title: &str,
    user_text: &str,
    // When the broker's atomic enqueue already persisted a tree-linked prompt
    // (`local_user_{request_id}`), REUSE its id here so `commit_prompt_result`'s
    // INSERT OR IGNORE no-ops on it instead of minting a second `msg_...` row.
    // `None` for the inline paths (channel / automation / approval) that have no
    // pre-seeded message and must mint a fresh id.
    preseeded_user_message_id: Option<&str>,
    // The assistant placeholder is preallocated with the user prompt by broker
    // enqueue. Reusing this stable id across worker attempts prevents duplicate
    // assistant bubbles after a retry.
    preseeded_assistant_message_id: Option<&str>,
    // The broker turn id (`turn_{request_id}` = the task id) to advertise in the
    // `thread.turn_started` event. This is the SAME id the live WS `turn.event`
    // fan-out and the resumable turn stream key on, so a client that receives the
    // event can attach to the running turn (live island + transcript), including
    // a channel turn it never launched.
    // `None` for legacy inline paths with no broker task: they mint a throwaway
    // id (nothing downstream joins on the visible turn_id, so it stays cosmetic
    // for those).
    turn_id_override: Option<&str>,
    // A persisted-bubble executor (currently proactive automation) owns this
    // assistant from creation, so an inline action card can later resolve the
    // exact waiting task without guessing from thread state.
    linked_task_id: Option<&str>,
) -> Option<VisibleConversationTurn> {
    let user_message = match preseeded_user_message_id {
        Some(id) => channel_chat_message_with_id("user", user_text, id),
        None => channel_chat_message("user", user_text),
    };
    let mut assistant_message = match preseeded_assistant_message_id {
        Some(id) => channel_chat_message_with_id("assistant", "", id),
        None => channel_chat_message("assistant", "…"),
    };
    assistant_message.memory_reuse =
        Some(local_first_memory::MemoryReuseEnvelope::blocked_unknown());
    assistant_message.delivery_state = local_first_desktop_gateway::MessageDeliveryState::Streaming;
    assistant_message.linked_task_id = linked_task_id.map(str::to_string);
    let turn = VisibleConversationTurn {
        turn_id: match turn_id_override {
            Some(id) => id.to_string(),
            None => format!(
                "turn_{}_{}",
                now_epoch_secs(),
                uuid::Uuid::new_v4().simple()
            ),
        },
        user_message_id: user_message.id.clone(),
        assistant_message_id: assistant_message.id.clone(),
    };
    // Persist the visible turn via commit_prompt_result (inserts both messages AND
    // synthesizes the provisional title from the first prompt when the thread is
    // still titled "New task"). This is a fail-closed safety boundary: a failure
    // here aborts the whole turn ("could not start a visible ... turn").
    //
    // Under the UNIFIED homun.sqlite (chat + task stores on ONE WAL file), a
    // concurrent writer can make this hit a TRANSIENT `SQLITE_BUSY`/`LOCKED`.
    // `busy_timeout` alone doesn't cover a write-write snapshot conflict (it
    // returns immediately; only a fresh transaction -- a retry -- resolves it,
    // not waiting). That's why unattended automations failed intermittently
    // while interactive chats mostly succeeded. So retry a few times before
    // giving up, and never swallow the error silently.
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        let persisted = match lock_store(state) {
            Ok(store) => {
                store.commit_prompt_result(thread_id, &user_message, &assistant_message, None)
            }
            Err(error) => {
                tracing::error!(
                    target: "gateway::visible_turn",
                    %thread_id, %source, error = %error.message,
                    "start_visible_conversation_turn: chat store lock failed"
                );
                return None;
            }
        };
        match persisted {
            Ok(_) => break,
            Err(error) if is_transient_store_error(&error) && attempt < 5 => {
                tracing::warn!(
                    target: "gateway::visible_turn",
                    %thread_id, %source, attempt, error = %error,
                    "start_visible_conversation_turn: transient store contention — retrying"
                );
                std::thread::sleep(std::time::Duration::from_millis(u64::from(attempt) * 40));
            }
            Err(error) => {
                tracing::error!(
                    target: "gateway::visible_turn",
                    %thread_id, %source, attempt, error = %error,
                    "start_visible_conversation_turn: could not persist the turn — failing closed"
                );
                return None;
            }
        }
    }
    if let Some(assistant_message_id) = preseeded_assistant_message_id {
        let reopened = lock_store(state).ok().and_then(|store| {
            store
                .set_message_delivery_state(
                    thread_id,
                    assistant_message_id,
                    local_first_desktop_gateway::MessageDeliveryState::Streaming,
                )
                .ok()
        });
        if reopened != Some(true) {
            tracing::error!(
                target: "gateway::visible_turn",
                %thread_id,
                %assistant_message_id,
                "start_visible_conversation_turn: could not reopen assistant stream"
            );
            return None;
        }
    }
    // Re-read the (now provisional) title so the event reflects what was
    // persisted, rather than echoing the raw prompt passed in by the caller.
    let started_title = lock_store(state)
        .ok()
        .and_then(|store| store.thread(thread_id).ok().flatten())
        .map(|t| t.title)
        .unwrap_or_else(|| title.to_string());
    publish_app_event(thread_turn_started_event(
        thread_id,
        workspace,
        source,
        channel,
        &started_title,
        &turn,
    ));
    Some(turn)
}
