//! Chat turn setup context owner.
//!
//! Owns the stateful setup that must happen before prompt assembly: binding the
//! memory workspace to the target thread, deriving channel/contact context,
//! resolving contact memory perimeter flags, and recording real user activity
//! for in-app or owner-authored channel turns. It does not own prompt
//! construction, the stream transport, the agent loop, or browser/subagent
//! execution.

use super::*;

pub(crate) struct ChatTurnContextInput<'a> {
    pub(crate) state: &'a AppState,
    pub(crate) thread_id: Option<&'a str>,
}

pub(crate) struct ChatTurnContext {
    pub(crate) contact: Option<ContactTurnContext>,
    pub(crate) channel_owner: bool,
}

pub(crate) struct ChatTurnPolicy {
    pub(crate) mode: String,
    pub(crate) read_only: bool,
    pub(crate) autonomous: bool,
}

pub(crate) struct ContactMemoryPerimeter {
    pub(crate) contact_only: bool,
    pub(crate) can_see_contacts: bool,
    pub(crate) can_see_calendar: bool,
    pub(crate) can_use_project_memory: bool,
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

pub(crate) fn resolve_chat_turn_policy(
    mode: Option<&str>,
    tool_policy: Option<&str>,
) -> ChatTurnPolicy {
    // Composer interaction mode: agent is the default. plan/ask/debug refine behavior;
    // "ask" later drops the toolset in the agent loop.
    let mode = mode.unwrap_or("agent").to_string();
    // Channel turns run read-only. Autonomous is only set by automation rules whose
    // approval policy explicitly allows direct side effects.
    let read_only = tool_policy == Some("read_only");
    let autonomous = tool_policy == Some("autonomous");
    ChatTurnPolicy {
        mode,
        read_only,
        autonomous,
    }
}

pub(crate) fn resolve_contact_memory_perimeter(
    contact: Option<&ContactTurnContext>,
) -> ContactMemoryPerimeter {
    match contact {
        Some(contact) => ContactMemoryPerimeter {
            contact_only: contact.perimeter.memory_scope == "contact_only",
            can_see_contacts: contact.perimeter.can_see_contacts,
            can_see_calendar: contact.perimeter.can_see_calendar,
            can_use_project_memory: contact.can_use_project_memory,
        },
        None => ContactMemoryPerimeter {
            contact_only: false,
            can_see_contacts: true,
            can_see_calendar: true,
            can_use_project_memory: true,
        },
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

#[cfg(test)]
mod tests {
    use super::{resolve_chat_turn_policy, resolve_contact_memory_perimeter};
    use crate::chat_store::StoredPerimeter;

    #[test]
    fn chat_turn_policy_defaults_to_agent_mode_with_confirming_tools() {
        let policy = resolve_chat_turn_policy(None, None);

        assert_eq!(policy.mode, "agent");
        assert!(!policy.read_only);
        assert!(!policy.autonomous);
    }

    #[test]
    fn chat_turn_policy_maps_read_only_and_autonomous_tool_policy() {
        let read_only = resolve_chat_turn_policy(Some("ask"), Some("read_only"));
        assert_eq!(read_only.mode, "ask");
        assert!(read_only.read_only);
        assert!(!read_only.autonomous);

        let autonomous = resolve_chat_turn_policy(Some("debug"), Some("autonomous"));
        assert_eq!(autonomous.mode, "debug");
        assert!(!autonomous.read_only);
        assert!(autonomous.autonomous);
    }

    #[test]
    fn contact_memory_perimeter_defaults_to_unrestricted_without_contact() {
        let perimeter = resolve_contact_memory_perimeter(None);

        assert!(!perimeter.contact_only);
        assert!(perimeter.can_see_contacts);
        assert!(perimeter.can_see_calendar);
        assert!(perimeter.can_use_project_memory);
    }

    #[test]
    fn contact_memory_perimeter_projects_stored_contact_limits() {
        let contact = crate::ContactTurnContext {
            name: "Laura".to_string(),
            tone_of_voice: String::new(),
            persona_instructions: String::new(),
            handles: vec!["email:laura@example.test".to_string()],
            perimeter: StoredPerimeter {
                memory_scope: "contact_only".to_string(),
                knowledge_folders: Vec::new(),
                tools_allowed: Vec::new(),
                tools_denied: Vec::new(),
                can_see_contacts: false,
                can_see_calendar: true,
            },
            can_use_project_memory: false,
            relationships: Vec::new(),
        };

        let perimeter = resolve_contact_memory_perimeter(Some(&contact));

        assert!(perimeter.contact_only);
        assert!(!perimeter.can_see_contacts);
        assert!(perimeter.can_see_calendar);
        assert!(!perimeter.can_use_project_memory);
    }
}
