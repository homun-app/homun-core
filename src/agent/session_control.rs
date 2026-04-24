use std::sync::Arc;

use tokio::sync::RwLock;

use crate::config::Config;
use crate::provider::Provider;
use crate::storage::Database;

use super::memory::MemoryConsolidator;

pub(super) async fn handle_profile_command(
    db: &Database,
    config: &Arc<RwLock<Config>>,
    content: &str,
) -> Option<String> {
    let trimmed = content.trim();
    if !trimmed.starts_with("/profile") {
        return None;
    }
    let rest = trimmed.strip_prefix("/profile")?.trim();

    if rest == "list" {
        match crate::profiles::db::load_all_profiles(db.pool()).await {
            Ok(profiles) => {
                let lines: Vec<String> = profiles
                    .iter()
                    .map(|p| {
                        let badge = if p.is_default != 0 { " (default)" } else { "" };
                        format!(
                            "{} **{}**{} — {}",
                            p.avatar_emoji, p.slug, badge, p.display_name
                        )
                    })
                    .collect();
                return Some(format!("Available profiles:\n{}", lines.join("\n")));
            }
            Err(e) => return Some(format!("Failed to list profiles: {e}")),
        }
    }

    if rest.is_empty() {
        let config = config.read().await;
        let default_slug = &config.profiles.default;
        return Some(format!("Current default profile: **{default_slug}**\nUse `/profile <slug>` to switch, or `/profile list` to see all."));
    }

    match crate::profiles::db::load_profile_by_slug(db.pool(), rest).await {
        Ok(Some(profile)) => Some(format!(
            "{} Switched to profile **{}** ({})",
            profile.avatar_emoji, profile.slug, profile.display_name
        )),
        Ok(None) => Some(format!(
            "Profile '{}' not found. Use `/profile list` to see available profiles.",
            rest
        )),
        Err(e) => Some(format!("Failed to load profile: {e}")),
    }
}

/// Resolve contact_id from a session key (format: "channel:chat_id").
pub(super) async fn resolve_contact_from_session(db: &Database, session_key: &str) -> Option<i64> {
    let (channel, chat_id) = session_key.split_once(':')?;
    let channel_key = if channel.starts_with("email") {
        "email"
    } else {
        channel
    };
    db.find_contact_by_identity(channel_key, chat_id)
        .await
        .ok()
        .flatten()
        .map(|c| c.id)
}

/// Check if the session belongs to the owner.
///
/// Web UI and CLI sessions are always owner. Unknown session formats are
/// treated as owner to preserve the previous behavior.
pub(super) fn is_owner_session(session_key: &str) -> bool {
    let Some((channel, _)) = session_key.split_once(':') else {
        return true;
    };
    matches!(channel, "web" | "cli")
}

/// Try to compact a session if its message count exceeds the configured window.
pub(super) async fn try_compact(
    memory: &MemoryConsolidator,
    session_key: &str,
    memory_window: u32,
    provider: &dyn Provider,
    model: &str,
) {
    match memory.should_compact(session_key, memory_window).await {
        Ok(true) => {
            match memory
                .compact_session(session_key, memory_window, provider, model)
                .await
            {
                Ok(r) => {
                    tracing::info!(
                        session = %session_key,
                        messages_removed = r.messages_removed,
                        summary_inserted = r.summary_inserted,
                        "Background session compaction complete"
                    );
                }
                Err(e) => {
                    tracing::error!(
                        session = %session_key,
                        error = %e,
                        "Background session compaction failed"
                    );
                }
            }
        }
        Ok(false) => {}
        Err(e) => {
            tracing::warn!(error = %e, "Failed to check compaction status");
        }
    }
}
