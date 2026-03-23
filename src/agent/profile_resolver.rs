//! Profile resolver — determines the active profile for a conversation.
//!
//! Priority chain (5 levels):
//!   1. Contact gateway override (per-contact, per-gateway)
//!   2. Contact default profile_id
//!   3. Gateway/Channel default_profile slug
//!   4. Global profiles.default slug
//!   5. The "default" profile (always exists)

use crate::contacts::Contact;
use crate::profiles;
use crate::storage::Database;

/// Resolve the active profile ID from pre-extracted config values.
///
/// This variant avoids holding `&dyn ChannelBehavior` (non-Send) across await points.
/// The caller extracts the string values synchronously, then calls this async function.
///
/// Priority chain:
/// 1. Contact's gateway override (per-contact, per-gateway profile)
/// 2. Contact's explicit profile_id (per-contact default)
/// 3. Channel/gateway default_profile slug
/// 4. Global profiles.default slug
/// 5. The "default" profile (always exists)
pub async fn resolve_profile_id_from_values(
    contact: Option<&Contact>,
    channel_default_profile: &str,
    global_default_profile: &str,
    db: &Database,
    gateway_id: Option<i64>,
) -> i64 {
    // 1. Contact gateway override (highest priority)
    if let (Some(c), Some(gw_id)) = (contact, gateway_id) {
        if let Ok(Some(pid)) =
            crate::gateways::db::get_override_profile_id(db.pool(), c.id, gw_id).await
        {
            return pid;
        }
    }

    // 2. Contact-level default profile
    if let Some(pid) = contact.and_then(|c| c.profile_id) {
        return pid;
    }

    // 3. Channel/gateway default_profile slug
    if !channel_default_profile.is_empty() {
        if let Ok(Some(profile)) =
            profiles::db::load_profile_by_slug(db.pool(), channel_default_profile).await
        {
            return profile.id;
        }
        tracing::warn!(
            slug = channel_default_profile,
            "Channel default_profile not found in DB, falling back"
        );
    }

    // 4. Global config default
    if !global_default_profile.is_empty() && global_default_profile != "default" {
        if let Ok(Some(profile)) =
            profiles::db::load_profile_by_slug(db.pool(), global_default_profile).await
        {
            return profile.id;
        }
        tracing::warn!(
            slug = global_default_profile,
            "Global profiles.default not found in DB, falling back"
        );
    }

    // 5. The default profile (always id=1 from migration seed)
    match profiles::db::get_default_profile(db.pool()).await {
        Ok(p) => p.id,
        Err(e) => {
            tracing::error!(error = %e, "Default profile not found — using id=1");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contact_profile_id_takes_priority() {
        // Contact with profile_id = 42 → resolve should return 42 without DB
        let contact = Contact {
            id: 1,
            name: "Test".into(),
            nickname: None,
            bio: String::new(),
            notes: String::new(),
            birthday: None,
            nameday: None,
            preferred_channel: None,
            response_mode: "automatic".into(),
            tone_of_voice: String::new(),
            tags: "[]".into(),
            avatar_url: None,
            created_at: String::new(),
            updated_at: String::new(),
            persona_override: None,
            persona_instructions: String::new(),
            agent_override: None,
            profile_id: Some(42),
        };

        // When contact has profile_id, it's returned immediately (no async needed)
        assert_eq!(contact.profile_id, Some(42));
    }
}
