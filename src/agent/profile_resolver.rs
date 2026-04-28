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

/// Resolve the effective profile for a session (web/mobile chat).
///
/// Used by GET /chat/profile and `/profile` command to show the active profile.
/// Cascade:
/// 1. Explicit session override (`sessions.profile_id`)
/// 2. Global config default slug (`profiles.default`)
/// 3. The DB default profile (`is_default = 1`)
///
/// This is a simplified cascade for channels without contact/gateway context
/// (web chat, mobile). For full resolution with contact overrides, use
/// [`resolve_profile_id_from_values`].
pub async fn resolve_session_profile(
    db: &Database,
    session_key: &str,
    global_default_slug: &str,
) -> profiles::Profile {
    // 1. Session override
    if let Some(pid) = db.get_session_profile_id(session_key).await {
        if let Ok(Some(profile)) = profiles::db::load_profile_by_id(db.pool(), pid).await {
            return profile;
        }
    }

    // 2. Global config default
    if !global_default_slug.is_empty() && global_default_slug != "default" {
        if let Ok(Some(profile)) =
            profiles::db::load_profile_by_slug(db.pool(), global_default_slug).await
        {
            return profile;
        }
    }

    // 3. DB default (always exists)
    profiles::db::get_default_profile(db.pool())
        .await
        .unwrap_or_else(|_| profiles::Profile {
            id: 1,
            slug: "default".into(),
            display_name: "Default".into(),
            avatar_emoji: "\u{1f464}".into(),
            color: "#64748B".into(),
            profile_json: "{}".into(),
            is_default: 1,
            user_id: None,
            created_at: String::new(),
            updated_at: String::new(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn test_db() -> (Database, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let db = Database::open(&db_path).await.unwrap();
        (db, dir)
    }

    fn test_contact(id: i64, profile_id: Option<i64>) -> Contact {
        Contact {
            id,
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
            profile_id,
            user_id: None,
        }
    }

    #[test]
    fn contact_profile_id_takes_priority() {
        // Contact with profile_id = 42 → resolve should return 42 without DB
        let contact = test_contact(1, Some(42));

        // When contact has profile_id, it's returned immediately (no async needed)
        assert_eq!(contact.profile_id, Some(42));
    }

    #[tokio::test]
    async fn gateway_override_wins_over_contact_profile_and_channel_default() {
        let (db, _dir) = test_db().await;

        let contact_profile = profiles::db::insert_profile(
            db.pool(),
            "contact-profile",
            "Contact Profile",
            "C",
            "#111111",
            "{}",
            None,
        )
        .await
        .unwrap();
        let channel_profile = profiles::db::insert_profile(
            db.pool(),
            "channel-profile",
            "Channel Profile",
            "T",
            "#222222",
            "{}",
            None,
        )
        .await
        .unwrap();
        let override_profile = profiles::db::insert_profile(
            db.pool(),
            "override-profile",
            "Override Profile",
            "O",
            "#333333",
            "{}",
            None,
        )
        .await
        .unwrap();
        let gateway_id = crate::gateways::db::insert_gateway(
            db.pool(),
            "Telegram",
            "telegram",
            "{}",
            "channel-profile",
            "",
            "automatic",
            None,
        )
        .await
        .unwrap();
        let contact_id = db
            .insert_contact(
                "Gateway Override Contact",
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap();
        db.update_contact(
            contact_id,
            &crate::contacts::db::ContactUpdate {
                profile_id: Some(contact_profile),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let contact = db.load_contact(contact_id).await.unwrap().unwrap();
        crate::gateways::db::upsert_gateway_override(
            db.pool(),
            contact.id,
            gateway_id,
            override_profile,
        )
        .await
        .unwrap();

        let resolved = resolve_profile_id_from_values(
            Some(&contact),
            "channel-profile",
            "default",
            &db,
            Some(gateway_id),
        )
        .await;

        assert_eq!(resolved, override_profile);
        assert_ne!(resolved, contact_profile);
        assert_ne!(resolved, channel_profile);
    }

    #[tokio::test]
    async fn channel_default_profile_is_used_when_contact_has_no_override() {
        let (db, _dir) = test_db().await;

        let channel_profile = profiles::db::insert_profile(
            db.pool(),
            "client-work",
            "Client Work",
            "W",
            "#444444",
            "{}",
            None,
        )
        .await
        .unwrap();
        let contact = test_contact(100, None);

        let resolved =
            resolve_profile_id_from_values(Some(&contact), "client-work", "default", &db, None)
                .await;

        assert_eq!(resolved, channel_profile);
    }

    #[tokio::test]
    async fn invalid_channel_and_global_profiles_fall_back_to_db_default() {
        let (db, _dir) = test_db().await;
        let default_profile = profiles::db::get_default_profile(db.pool()).await.unwrap();

        let resolved = resolve_profile_id_from_values(
            None,
            "missing-channel-profile",
            "missing-global-profile",
            &db,
            None,
        )
        .await;

        assert_eq!(resolved, default_profile.id);
    }
}
