//! Chat turn setup context owner.
//!
//! Owns the stateful setup that must happen before prompt assembly: binding the
//! memory workspace to the target thread, deriving channel/contact context, and
//! recording real user activity for in-app or owner-authored channel turns. It
//! does not own prompt construction, the stream transport, the agent loop, or
//! browser/subagent execution.

use super::*;

pub(crate) struct ChatTurnContextInput<'a> {
    pub(crate) state: &'a AppState,
    pub(crate) thread_id: Option<&'a str>,
}

pub(crate) struct ChatTurnContext {
    pub(crate) contact: Option<ContactTurnContext>,
    pub(crate) channel_owner: bool,
}

pub(crate) fn prepare_chat_turn_context(input: ChatTurnContextInput<'_>) -> ChatTurnContext {
    bind_thread_memory_workspace(input.state, input.thread_id);

    let (contact, channel_owner) = contact_turn_context(input.state, input.thread_id);
    if verbose_debug()
        && input
            .thread_id
            .is_some_and(|thread| thread.starts_with("channel_"))
    {
        eprintln!(
            "channel-turn: thread={} owner={} contact={}",
            input.thread_id.unwrap_or("-"),
            channel_owner,
            contact.as_ref().map(|c| c.name.as_str()).unwrap_or("-"),
        );
    }

    note_real_user_activity(input.thread_id, channel_owner);

    ChatTurnContext {
        contact,
        channel_owner,
    }
}

fn bind_thread_memory_workspace(state: &AppState, thread_id: Option<&str>) {
    if let Some(thread_id) = thread_id {
        if let Ok(store) = lock_store(state)
            && let Ok(workspace) = store.workspace_for_thread(thread_id)
        {
            set_memory_workspace(&workspace);
        }
    } else {
        set_memory_workspace("");
    }
}

fn note_real_user_activity(thread_id: Option<&str>, channel_owner: bool) {
    let is_channel = thread_id.is_some_and(|thread| thread.starts_with("channel_"));
    let is_homun = thread_id == Some("homun");
    if !is_homun && (!is_channel || channel_owner) {
        note_user_activity();
    }
}
