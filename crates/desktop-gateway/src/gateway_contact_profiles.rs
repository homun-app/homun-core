// Named contact profile routes and per-contact/channel assignment.
use axum::{Json, extract::State};
use serde::{Deserialize, Serialize};

use crate::*;

#[derive(Serialize)]
pub(crate) struct ProfileView {
    id: i64,
    name: String,
    tone_of_voice: String,
    instructions: String,
}

fn profile_view(p: chat_store::StoredProfile) -> ProfileView {
    ProfileView {
        id: p.id,
        name: p.name,
        tone_of_voice: p.tone_of_voice,
        instructions: p.instructions,
    }
}

pub(crate) async fn profiles_list(
    State(state): State<AppState>,
) -> Result<Json<Vec<ProfileView>>, GatewayError> {
    let store = lock_store(&state)?;
    let profiles = store.list_profiles().map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "profiles_list",
        message: error.to_string(),
    })?;
    Ok(Json(profiles.into_iter().map(profile_view).collect()))
}

#[derive(Deserialize)]
pub(crate) struct ProfileCreateRequest {
    name: String,
    #[serde(default)]
    tone_of_voice: String,
    #[serde(default)]
    instructions: String,
}

pub(crate) async fn profile_create(
    State(state): State<AppState>,
    Json(request): Json<ProfileCreateRequest>,
) -> Result<Json<ProfileView>, GatewayError> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "profile_name_required",
            message: "name required".to_string(),
        });
    }
    let store = lock_store(&state)?;
    let id = store
        .create_profile(
            name,
            request.tone_of_voice.trim(),
            request.instructions.trim(),
        )
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "profile_create",
            message: error.to_string(),
        })?;
    let profile = store
        .profile_by_id(id)
        .ok()
        .flatten()
        .ok_or_else(|| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "profile_create",
            message: "profile not created".to_string(),
        })?;
    Ok(Json(profile_view(profile)))
}

#[derive(Deserialize)]
pub(crate) struct ProfileUpdateRequest {
    id: i64,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    tone_of_voice: Option<String>,
    #[serde(default)]
    instructions: Option<String>,
}

pub(crate) async fn profile_update(
    State(state): State<AppState>,
    Json(request): Json<ProfileUpdateRequest>,
) -> Result<Json<ProfileView>, GatewayError> {
    let store = lock_store(&state)?;
    store
        .update_profile(
            request.id,
            request.name.as_deref().filter(|s| !s.trim().is_empty()),
            request.tone_of_voice.as_deref(),
            request.instructions.as_deref(),
        )
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "profile_update",
            message: error.to_string(),
        })?;
    let profile = store
        .profile_by_id(request.id)
        .ok()
        .flatten()
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "profile_not_found",
            message: "profile not found".to_string(),
        })?;
    Ok(Json(profile_view(profile)))
}

#[derive(Deserialize)]
pub(crate) struct ProfileDeleteRequest {
    id: i64,
}

pub(crate) async fn profile_delete(
    State(state): State<AppState>,
    Json(request): Json<ProfileDeleteRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let store = lock_store(&state)?;
    store
        .delete_profile(request.id)
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "profile_delete",
            message: error.to_string(),
        })?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub(crate) struct ContactAssignProfileRequest {
    reference: String,
    /// Absent/null = clear (back to inline persona). For the channel variant the
    /// override is removed instead.
    #[serde(default)]
    profile_id: Option<i64>,
    /// When set, binds the profile for THIS channel only (override).
    #[serde(default)]
    channel: Option<String>,
}

pub(crate) async fn contact_assign_profile(
    State(state): State<AppState>,
    Json(request): Json<ContactAssignProfileRequest>,
) -> Result<Json<ContactView>, GatewayError> {
    let id = parse_contact_ref(&request.reference).ok_or_else(|| GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "contact_not_found",
        message: "contact not found".to_string(),
    })?;
    let store = lock_store(&state)?;
    let result = match request.channel.as_deref().filter(|c| !c.trim().is_empty()) {
        Some(channel) => store.set_channel_profile(id, channel.trim(), request.profile_id),
        None => store.set_contact_profile(id, request.profile_id),
    };
    result.map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "contact_assign_profile",
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contact_profile_view_preserves_named_persona_fields() {
        let view = profile_view(chat_store::StoredProfile {
            id: 7,
            name: "Work".to_string(),
            tone_of_voice: "concise".to_string(),
            instructions: "Prefer operational details".to_string(),
        });

        assert_eq!(view.id, 7);
        assert_eq!(view.name, "Work");
        assert_eq!(view.tone_of_voice, "concise");
        assert_eq!(view.instructions, "Prefer operational details");
    }
}
