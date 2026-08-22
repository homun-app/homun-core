//! Core contact routes and shared contact projections.

use std::{
    collections::{HashMap, HashSet},
    str::FromStr,
};

use axum::{Json, extract::State};
use serde::{Deserialize, Serialize};

use crate::gateway_memory_briefing::CHAT_MEMORY_BUDGET_CHARS;
use crate::*;

#[derive(Serialize)]
pub(crate) struct ContactChannel {
    channel: String,
    address: String,
}

#[derive(Serialize)]
pub(crate) struct ContactView {
    reference: String,
    name: String,
    contact_type: String,
    is_self: bool,
    channels: Vec<ContactChannel>,
    notes: String,
    soul_md: String,
    memory_count: usize,
    /// '' = inherit channel/global default; automatic | draft | silent.
    response_mode: String,
    tone_of_voice: String,
    persona_instructions: String,
    /// Default named profile; per-channel overrides below win at reply time.
    profile_id: Option<i64>,
    birthday: Option<String>,
    channel_profiles: Vec<ChannelProfileView>,
}

#[derive(Serialize)]
pub(crate) struct ChannelProfileView {
    channel: String,
    profile_id: i64,
}

/// "contact_{id}" -> id. Keeps the frontend's opaque-`reference` API contract while
/// the source of truth moves to the curated `contacts` table.
pub(crate) fn parse_contact_ref(reference: &str) -> Option<i64> {
    reference
        .strip_prefix("contact_")
        .and_then(|s| s.parse().ok())
}

pub(crate) fn contact_meta_str(meta: &serde_json::Value, key: &str) -> String {
    meta.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

pub(crate) fn contact_is_self(entity: &MemoryEntity) -> bool {
    entity.canonical_key == "person:self"
        || entity
            .metadata
            .get("self")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        || contact_meta_str(&entity.metadata, "contact_type") == "self"
}

/// A contact's channel handles: its aliases, plus the handle embedded in the
/// canonical_key ("person:telegram:123" -> "telegram:123") so contacts created
/// before aliases were populated still resolve their channels + history.
pub(crate) fn contact_handles(entity: &MemoryEntity) -> Vec<String> {
    let mut handles = entity.aliases.clone();
    if let Some(rest) = entity.canonical_key.strip_prefix("person:")
        && rest != "self"
        && rest.contains(':')
        && !handles.iter().any(|h| h == rest)
    {
        handles.push(rest.to_string());
    }
    handles
}

/// Conversation history for a set of contact handles ("channel:identifier"): thread
/// episodes whose thread_id is one of the handles (a merged contact = many handles).
pub(crate) fn episode_texts_by_handles(
    facade: &MemoryFacade,
    user: &MemoryUserId,
    handles: &[String],
) -> Vec<String> {
    if handles.is_empty() {
        return Vec::new();
    }
    let threads = MemoryWorkspaceId::new(THREADS_WORKSPACE);
    let set: HashSet<&str> = handles.iter().map(|s| s.as_str()).collect();
    facade
        .list_memories_for_ui(user, &threads)
        .unwrap_or_default()
        // Exclude deleted/rejected: list_memories_for_ui returns ALL statuses, so
        // without this a deleted episode kept showing in a contact's "Cosa so...".
        .into_iter()
        .filter(|m| !matches!(m.status, MemoryStatus::Deleted | MemoryStatus::Rejected))
        .filter(|m| {
            m.metadata
                .get("thread_id")
                .and_then(|v| v.as_str())
                .map(|t| set.contains(t))
                .unwrap_or(false)
        })
        .map(|m| m.text)
        .collect()
}

pub(crate) fn contact_history_prompt_block(episodes: &[String]) -> Option<String> {
    if episodes.is_empty() {
        return None;
    }
    let mut block = String::from("HISTORY WITH THIS CONTACT (the only memory available):");
    let mut used = 0usize;
    for text in episodes.iter().rev().take(40).rev() {
        if used.saturating_add(text.len()) > CHAT_MEMORY_BUDGET_CHARS {
            break;
        }
        used += text.len();
        block.push_str("\n- ");
        block.push_str(text);
    }
    Some(block)
}

/// Same, paired with each episode's ISO date (oldest first) for the fact extractor.
pub(crate) fn episodes_dated_by_handles(
    facade: &MemoryFacade,
    user: &MemoryUserId,
    handles: &[String],
) -> Vec<(String, String)> {
    if handles.is_empty() {
        return Vec::new();
    }
    let threads = MemoryWorkspaceId::new(THREADS_WORKSPACE);
    let set: HashSet<&str> = handles.iter().map(|s| s.as_str()).collect();
    let mut out: Vec<(String, String)> = facade
        .list_memories_for_ui(user, &threads)
        .unwrap_or_default()
        .into_iter()
        // A deleted episode must not be re-mined into facts on profile refresh.
        .filter(|m| !matches!(m.status, MemoryStatus::Deleted | MemoryStatus::Rejected))
        .filter(|m| {
            m.metadata
                .get("thread_id")
                .and_then(|v| v.as_str())
                .map(|t| set.contains(t))
                .unwrap_or(false)
        })
        .map(|m| (parse_memory_date(&m.created_at).unwrap_or_default(), m.text))
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Episode (date, ref) by handles for provenance: linking a distilled fact to
/// the source messages of the same day via `memory_evidence`.
pub(crate) fn episode_refs_by_date(
    facade: &MemoryFacade,
    user: &MemoryUserId,
    handles: &[String],
) -> Vec<(String, MemoryRef)> {
    if handles.is_empty() {
        return Vec::new();
    }
    let threads = MemoryWorkspaceId::new(THREADS_WORKSPACE);
    let set: HashSet<&str> = handles.iter().map(|s| s.as_str()).collect();
    facade
        .list_memories_for_ui(user, &threads)
        .unwrap_or_default()
        .into_iter()
        .filter(|m| !matches!(m.status, MemoryStatus::Deleted | MemoryStatus::Rejected))
        .filter(|m| {
            m.metadata
                .get("thread_id")
                .and_then(|v| v.as_str())
                .map(|t| set.contains(t))
                .unwrap_or(false)
        })
        .map(|m| {
            (
                parse_memory_date(&m.created_at).unwrap_or_default(),
                m.reference,
            )
        })
        .collect()
}

pub(crate) fn contact_view_from_stored(
    store: &ChatStore,
    c: &chat_store::StoredContact,
    memory_count: usize,
) -> ContactView {
    ContactView {
        reference: format!("contact_{}", c.id),
        name: c.name.clone(),
        contact_type: if c.contact_type.is_empty() {
            "unknown".to_string()
        } else {
            c.contact_type.clone()
        },
        is_self: c.is_self,
        channels: c
            .identities
            .iter()
            .map(|i| ContactChannel {
                channel: i.channel.clone(),
                address: i.identifier.clone(),
            })
            .collect(),
        notes: c.notes.clone(),
        soul_md: String::new(), // legacy field kept for the API shape; persona has its own fields
        memory_count,
        response_mode: c.response_mode.clone(),
        tone_of_voice: c.tone_of_voice.clone(),
        persona_instructions: c.persona_instructions.clone(),
        profile_id: c.profile_id,
        birthday: c.birthday.clone(),
        channel_profiles: store
            .channel_profile_overrides(c.id)
            .unwrap_or_default()
            .into_iter()
            .map(|(channel, profile_id)| ChannelProfileView {
                channel,
                profile_id,
            })
            .collect(),
    }
}

pub(crate) async fn contacts_list(
    State(state): State<AppState>,
) -> Result<Json<Vec<ContactView>>, GatewayError> {
    // Curated rubrica: the source of truth is the contacts table, not every
    // `person` memory entity, which prevents chat-mentioned people from leaking in.
    let contacts = {
        let store = lock_store(&state)?;
        store.list_contacts().map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "contacts_list",
            message: error.to_string(),
        })?
    };
    let user = gateway_memory_user_id();
    let counts: HashMap<String, usize> = {
        let facade = memory_facade(&state);
        let threads = MemoryWorkspaceId::new(THREADS_WORKSPACE);
        let mut map: HashMap<String, usize> = HashMap::new();
        for mem in facade
            .list_memories_for_ui(&user, &threads)
            .unwrap_or_default()
        {
            if let Some(t) = mem.metadata.get("thread_id").and_then(|v| v.as_str()) {
                *map.entry(t.to_string()).or_insert(0) += 1;
            }
        }
        map
    };
    let store = lock_store(&state)?;
    let out = contacts
        .iter()
        .map(|c| {
            let count: usize = c
                .identities
                .iter()
                .map(|i| {
                    counts
                        .get(&format!("{}:{}", i.channel, i.identifier))
                        .copied()
                        .unwrap_or(0)
                })
                .sum();
            contact_view_from_stored(&store, c, count)
        })
        .collect();
    Ok(Json(out))
}

#[derive(Deserialize)]
pub(crate) struct ContactRefRequest {
    pub(crate) reference: String,
}

/// Handles ("channel:identifier") of a contact referenced as "contact_{id}".
fn contact_handles_by_ref(state: &AppState, reference: &str) -> Result<Vec<String>, GatewayError> {
    let id = parse_contact_ref(reference).ok_or_else(|| GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "contact_not_found",
        message: "contact not found".to_string(),
    })?;
    let store = lock_store(state)?;
    store.contact_handles(id).map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "contact_handles",
        message: error.to_string(),
    })
}

pub(crate) async fn contact_memories(
    State(state): State<AppState>,
    Json(request): Json<ContactRefRequest>,
) -> Result<Json<Vec<String>>, GatewayError> {
    let handles = contact_handles_by_ref(&state, &request.reference)?;
    let facade = memory_facade(&state);
    let user = gateway_memory_user_id();
    Ok(Json(episode_texts_by_handles(facade, &user, &handles)))
}

#[derive(Deserialize)]
pub(crate) struct ContactUpdateRequest {
    reference: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    contact_type: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    notes: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    soul_md: Option<String>,
    #[serde(default)]
    tone_of_voice: Option<String>,
    #[serde(default)]
    persona_instructions: Option<String>,
    #[serde(default)]
    response_mode: Option<String>,
    /// "" clears the birthday; absent leaves it unchanged.
    #[serde(default)]
    birthday: Option<String>,
}

pub(crate) async fn contact_update(
    State(state): State<AppState>,
    Json(request): Json<ContactUpdateRequest>,
) -> Result<Json<ContactView>, GatewayError> {
    let id = parse_contact_ref(&request.reference).ok_or_else(|| GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "contact_not_found",
        message: "contact not found".to_string(),
    })?;
    let store = lock_store(&state)?;
    store
        .update_contact(
            id,
            request.name.as_deref().filter(|s| !s.trim().is_empty()),
            None,
            request.notes.as_deref(),
            request.contact_type.as_deref(),
        )
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "contact_update",
            message: error.to_string(),
        })?;
    store
        .update_contact_persona(
            id,
            request.tone_of_voice.as_deref(),
            request.persona_instructions.as_deref(),
            request.response_mode.as_deref(),
        )
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "contact_update",
            message: error.to_string(),
        })?;
    if let Some(birthday) = request.birthday.as_deref() {
        let value = birthday.trim();
        store
            .set_contact_birthday(id, if value.is_empty() { None } else { Some(value) })
            .map_err(|error| GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "contact_update",
                message: error.to_string(),
            })?;
    }
    // soul_md (legacy) is ignored because persona lives in tone/instructions now.
    let contact = store
        .contact_by_id(id)
        .ok()
        .flatten()
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "contact_not_found",
            message: "contact not found".to_string(),
        })?;
    Ok(Json(contact_view_from_stored(&store, &contact, 0)))
}

#[derive(Deserialize)]
pub(crate) struct ContactMergeRequest {
    /// The contact to absorb (will be tombstoned).
    from: String,
    /// The surviving contact (gains the other's handles).
    into: String,
}

pub(crate) async fn contacts_merge(
    State(state): State<AppState>,
    Json(request): Json<ContactMergeRequest>,
) -> Result<Json<ContactView>, GatewayError> {
    if request.from == request.into {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "contact_merge_self",
            message: "cannot merge a contact with itself".to_string(),
        });
    }
    let not_found = || GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "contact_not_found",
        message: "contact not found".to_string(),
    };
    let from_id = parse_contact_ref(&request.from).ok_or_else(not_found)?;
    let into_id = parse_contact_ref(&request.into).ok_or_else(not_found)?;

    let (survivor, absorbed_entity_ref) = {
        let store = lock_store(&state)?;
        let from = store
            .contact_by_id(from_id)
            .ok()
            .flatten()
            .ok_or_else(not_found)?;
        let into = store
            .contact_by_id(into_id)
            .ok()
            .flatten()
            .ok_or_else(not_found)?;
        let (survivor_id, absorbed) = if from.is_self {
            (from.id, into)
        } else {
            (into.id, from)
        };
        let absorbed_entity_ref = absorbed.entity_ref.clone();
        store
            .merge_contacts(survivor_id, absorbed.id)
            .map_err(|error| GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "contact_merge",
                message: error.to_string(),
            })?;
        let survivor = store
            .contact_by_id(survivor_id)
            .ok()
            .flatten()
            .ok_or_else(not_found)?;
        (survivor, absorbed_entity_ref)
    };

    // Best-effort: keep the canonical graph consistent with the contact merge.
    if let Some(eref) = absorbed_entity_ref {
        {
            let facade = memory_facade(&state);
            let user = gateway_memory_user_id();
            let workspace = MemoryWorkspaceId::new(PERSONAL_WORKSPACE);
            let survivor_ref = survivor
                .entity_ref
                .as_deref()
                .and_then(|reference| MemoryRef::from_str(reference).ok());
            let absorbed_ref = MemoryRef::from_str(&eref).ok();
            match (survivor_ref, absorbed_ref) {
                (Some(survivor_ref), Some(absorbed_ref)) => {
                    let _ = facade.merge_entities(
                        &survivor_ref,
                        &absorbed_ref,
                        &user,
                        &workspace,
                        "merged via contacts",
                    );
                }
                _ => {
                    if let Ok(entities) = facade.list_entities_for_ui(&user, &workspace)
                        && let Some(entity) = entities
                            .into_iter()
                            .find(|e| e.reference.to_string() == eref)
                    {
                        let _ = facade.tombstone_entity(
                            &entity.reference,
                            &user,
                            &workspace,
                            "merged into contact",
                        );
                    }
                }
            }
        }
    }
    reconcile_memory_scope(&state, &MemoryWorkspaceId::new(PERSONAL_WORKSPACE));
    let store = lock_store(&state)?;
    Ok(Json(contact_view_from_stored(&store, &survivor, 0)))
}

#[derive(Deserialize)]
pub(crate) struct ContactCreateRequest {
    name: String,
    #[serde(default)]
    contact_type: Option<String>,
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    identifier: Option<String>,
}

/// Add a contact by hand (the curated path that is not a channel identity).
pub(crate) async fn contact_create(
    State(state): State<AppState>,
    Json(request): Json<ContactCreateRequest>,
) -> Result<Json<ContactView>, GatewayError> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "contact_name_required",
            message: "name required".to_string(),
        });
    }
    let store = lock_store(&state)?;
    let id = store
        .create_contact(
            name,
            request.contact_type.as_deref().unwrap_or("unknown"),
            false,
            "",
            None,
        )
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "contact_create",
            message: error.to_string(),
        })?;
    if let (Some(ch), Some(ident)) = (request.channel.as_deref(), request.identifier.as_deref())
        && !ch.trim().is_empty()
        && !ident.trim().is_empty()
    {
        let _ = store.add_identity(id, ch.trim(), ident.trim(), None);
    }
    let contact = store
        .contact_by_id(id)
        .ok()
        .flatten()
        .ok_or_else(|| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "contact_create",
            message: "contact not created".to_string(),
        })?;
    Ok(Json(contact_view_from_stored(&store, &contact, 0)))
}

#[derive(Deserialize)]
pub(crate) struct ContactIdentityRequest {
    reference: String,
    channel: String,
    identifier: String,
    #[serde(default)]
    label: Option<String>,
}

fn contact_after_identity_change(
    state: &AppState,
    reference: &str,
    apply: impl FnOnce(&chat_store::ChatStore, i64) -> rusqlite::Result<()>,
) -> Result<Json<ContactView>, GatewayError> {
    let id = parse_contact_ref(reference).ok_or_else(|| GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "contact_not_found",
        message: "contact not found".to_string(),
    })?;
    let store = lock_store(state)?;
    apply(&store, id).map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "contact_identity",
        message: error.to_string(),
    })?;
    let contact = store
        .contact_by_id(id)
        .ok()
        .flatten()
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "contact_not_found",
            message: "contact not found".to_string(),
        })?;
    Ok(Json(contact_view_from_stored(&store, &contact, 0)))
}

pub(crate) async fn contact_identity_add(
    State(state): State<AppState>,
    Json(request): Json<ContactIdentityRequest>,
) -> Result<Json<ContactView>, GatewayError> {
    contact_after_identity_change(&state, &request.reference, |store, id| {
        store.add_identity(
            id,
            request.channel.trim(),
            request.identifier.trim(),
            request.label.as_deref(),
        )
    })
}

pub(crate) async fn contact_identity_remove(
    State(state): State<AppState>,
    Json(request): Json<ContactIdentityRequest>,
) -> Result<Json<ContactView>, GatewayError> {
    contact_after_identity_change(&state, &request.reference, |store, _id| {
        store.remove_identity(request.channel.trim(), request.identifier.trim())
    })
}

/// Remove a contact from the rubrica (its memory episodes/entity are not deleted).
pub(crate) async fn contact_delete(
    State(state): State<AppState>,
    Json(request): Json<ContactRefRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let id = parse_contact_ref(&request.reference).ok_or_else(|| GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "contact_not_found",
        message: "contact not found".to_string(),
    })?;
    let store = lock_store(&state)?;
    store.delete_contact(id).map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "contact_delete",
        message: error.to_string(),
    })?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Epoch seconds -> "YYYY-MM-DD" (civil calendar, dependency-free).
pub(crate) fn epoch_to_iso_date(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}-{m:02}-{d:02}")
}

/// Parse the store's "unix:<secs>.<frac>" timestamp into an ISO date.
pub(crate) fn parse_memory_date(stamp: &str) -> Option<String> {
    let s = stamp.strip_prefix("unix:").unwrap_or(stamp);
    let secs: i64 = s.split('.').next()?.parse().ok()?;
    Some(epoch_to_iso_date(secs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_contacts_parse_ref_requires_contact_prefix() {
        assert_eq!(parse_contact_ref("contact_42"), Some(42));
        assert_eq!(parse_contact_ref("person_42"), None);
        assert_eq!(parse_contact_ref("contact_"), None);
    }

    #[test]
    fn gateway_contacts_contact_handles_include_legacy_canonical_handle() {
        let entity = MemoryEntity {
            reference: MemoryRef::new(
                MemoryRefKind::Entity,
                MemoryUserId::new("test-user"),
                MemoryWorkspaceId::new(PERSONAL_WORKSPACE),
                "ent-1",
            ),
            user_id: MemoryUserId::new("test-user"),
            workspace_id: MemoryWorkspaceId::new(PERSONAL_WORKSPACE),
            entity_type: "person".to_string(),
            name: "Ada".to_string(),
            canonical_key: "person:telegram:123".to_string(),
            aliases: vec!["whatsapp:456".to_string()],
            privacy_domain: PrivacyDomain::new("personal"),
            sensitivity: MemoryDataSensitivity::Private,
            metadata: serde_json::json!({}),
        };

        assert_eq!(
            contact_handles(&entity),
            vec!["whatsapp:456".to_string(), "telegram:123".to_string()]
        );
    }

    #[test]
    fn gateway_contacts_owns_contact_history_prompt_block() {
        assert!(contact_history_prompt_block(&[]).is_none());

        let episodes = vec![
            "old turn".to_string(),
            "recent decision".to_string(),
            "latest follow-up".to_string(),
        ];
        let block = contact_history_prompt_block(&episodes).expect("history block");

        assert!(block.starts_with("HISTORY WITH THIS CONTACT"));
        assert!(block.contains("the only memory available"));
        assert!(block.contains("\n- old turn\n- recent decision\n- latest follow-up"));
    }

    #[test]
    fn gateway_contacts_parse_memory_date_accepts_unix_prefix_and_fraction() {
        assert_eq!(
            parse_memory_date("unix:1724371200.123").as_deref(),
            Some("2024-08-23")
        );
    }
}
