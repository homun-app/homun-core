// Contact isolation perimeter routes.
use axum::{Json, extract::State};
use serde::{Deserialize, Serialize};

use crate::*;

/// Wire shape of a contact's isolation perimeter (GET returns defaults when no row).
#[derive(Serialize, Deserialize)]
pub(crate) struct PerimeterView {
    memory_scope: String,
    #[serde(default)]
    knowledge_folders: Vec<String>,
    #[serde(default)]
    tools_allowed: Vec<String>,
    #[serde(default)]
    tools_denied: Vec<String>,
    can_see_contacts: bool,
    can_see_calendar: bool,
}

fn perimeter_view_from_stored(p: chat_store::StoredPerimeter) -> PerimeterView {
    PerimeterView {
        memory_scope: p.memory_scope,
        knowledge_folders: p.knowledge_folders,
        tools_allowed: p.tools_allowed,
        tools_denied: p.tools_denied,
        can_see_contacts: p.can_see_contacts,
        can_see_calendar: p.can_see_calendar,
    }
}

fn normalize_contact_memory_scope(scope: &str) -> &'static str {
    match scope {
        "personal" => "personal",
        _ => "contact_only",
    }
}

pub(crate) async fn contact_perimeter_get(
    State(state): State<AppState>,
    Json(request): Json<ContactRefRequest>,
) -> Result<Json<PerimeterView>, GatewayError> {
    let id = parse_contact_ref(&request.reference).ok_or_else(|| GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "contact_not_found",
        message: "contact not found".to_string(),
    })?;
    let store = lock_store(&state)?;
    Ok(Json(perimeter_view_from_stored(
        store.perimeter_or_default(id),
    )))
}

#[derive(Deserialize)]
pub(crate) struct PerimeterUpdateRequest {
    reference: String,
    #[serde(flatten)]
    perimeter: PerimeterView,
}

pub(crate) async fn contact_perimeter_set(
    State(state): State<AppState>,
    Json(request): Json<PerimeterUpdateRequest>,
) -> Result<Json<PerimeterView>, GatewayError> {
    let id = parse_contact_ref(&request.reference).ok_or_else(|| GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "contact_not_found",
        message: "contact not found".to_string(),
    })?;
    let stored = chat_store::StoredPerimeter {
        memory_scope: normalize_contact_memory_scope(&request.perimeter.memory_scope).to_string(),
        knowledge_folders: request.perimeter.knowledge_folders.clone(),
        tools_allowed: request.perimeter.tools_allowed.clone(),
        tools_denied: request.perimeter.tools_denied.clone(),
        can_see_contacts: request.perimeter.can_see_contacts,
        can_see_calendar: request.perimeter.can_see_calendar,
    };
    let store = lock_store(&state)?;
    store
        .set_perimeter(id, &stored)
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "contact_perimeter",
            message: error.to_string(),
        })?;
    Ok(Json(perimeter_view_from_stored(
        store.perimeter_or_default(id),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contact_perimeter_unknown_scope_fails_closed_to_contact_only() {
        assert_eq!(normalize_contact_memory_scope("personal"), "personal");
        assert_eq!(normalize_contact_memory_scope(""), "contact_only");
        assert_eq!(normalize_contact_memory_scope("workspace"), "contact_only");
    }

    #[test]
    fn contact_perimeter_view_preserves_privacy_flags() {
        let view = perimeter_view_from_stored(chat_store::StoredPerimeter {
            memory_scope: "contact_only".to_string(),
            knowledge_folders: vec!["docs".to_string()],
            tools_allowed: vec!["read_file".to_string()],
            tools_denied: vec!["send_email".to_string()],
            can_see_contacts: false,
            can_see_calendar: true,
        });

        assert_eq!(view.memory_scope, "contact_only");
        assert_eq!(view.knowledge_folders, vec!["docs"]);
        assert_eq!(view.tools_allowed, vec!["read_file"]);
        assert_eq!(view.tools_denied, vec!["send_email"]);
        assert!(!view.can_see_contacts);
        assert!(view.can_see_calendar);
    }
}
