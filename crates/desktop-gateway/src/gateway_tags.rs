//! Tag HTTP route owner.
//!
//! Owns the cross-project colored labels API for projects and conversations.
//! The durable source of truth remains `chat_store`.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::Deserialize;

use crate::{
    AppState, GatewayError,
    chat_store::{Tag, TagEntity},
    lock_store, now_epoch_secs,
};

#[derive(Deserialize)]
pub(crate) struct CreateTagRequest {
    name: String,
    color: String,
}

#[derive(Deserialize)]
pub(crate) struct RenameTagRequest {
    name: String,
}

#[derive(Deserialize)]
pub(crate) struct SetTagColorRequest {
    color: String,
}

#[derive(Deserialize)]
pub(crate) struct TagAssignRequest {
    entity_type: String,
    entity_id: String,
}

fn parse_tag_entity(value: &str) -> Result<TagEntity, GatewayError> {
    TagEntity::parse(value).ok_or_else(|| GatewayError {
        status: StatusCode::BAD_REQUEST,
        code: "tag_entity_invalid",
        message: "entity_type must be 'project' or 'thread'".to_string(),
    })
}

pub(crate) async fn tags_list(
    State(state): State<AppState>,
) -> Result<Json<Vec<Tag>>, GatewayError> {
    let tags = lock_store(&state)?
        .list_tags()
        .map_err(GatewayError::store)?;
    Ok(Json(tags))
}

pub(crate) async fn tags_create(
    State(state): State<AppState>,
    Json(request): Json<CreateTagRequest>,
) -> Result<Json<Tag>, GatewayError> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "tag_name_required",
            message: "tag name must not be empty".to_string(),
        });
    }
    let id = format!("tag_{}_{}", now_epoch_secs(), uuid::Uuid::new_v4().simple());
    let tag = lock_store(&state)?
        .create_tag(&id, name, request.color.trim())
        .map_err(GatewayError::store)?;
    Ok(Json(tag))
}

pub(crate) async fn tags_rename(
    State(state): State<AppState>,
    Path(tag_id): Path<String>,
    Json(request): Json<RenameTagRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    lock_store(&state)?
        .rename_tag(&tag_id, request.name.trim())
        .map_err(GatewayError::store)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) async fn tags_set_color(
    State(state): State<AppState>,
    Path(tag_id): Path<String>,
    Json(request): Json<SetTagColorRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    lock_store(&state)?
        .set_tag_color(&tag_id, request.color.trim())
        .map_err(GatewayError::store)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) async fn tags_delete(
    State(state): State<AppState>,
    Path(tag_id): Path<String>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    lock_store(&state)?
        .delete_tag(&tag_id)
        .map_err(GatewayError::store)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) async fn tags_assign(
    State(state): State<AppState>,
    Path(tag_id): Path<String>,
    Json(request): Json<TagAssignRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let entity = parse_tag_entity(&request.entity_type)?;
    lock_store(&state)?
        .assign_tag(&tag_id, entity, &request.entity_id)
        .map_err(GatewayError::store)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) async fn tags_unassign(
    State(state): State<AppState>,
    Path(tag_id): Path<String>,
    Json(request): Json<TagAssignRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let entity = parse_tag_entity(&request.entity_type)?;
    lock_store(&state)?
        .unassign_tag(&tag_id, entity, &request.entity_id)
        .map_err(GatewayError::store)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) async fn tags_entities(
    State(state): State<AppState>,
    Path(tag_id): Path<String>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let entities = lock_store(&state)?
        .entities_for_tag(&tag_id)
        .map_err(GatewayError::store)?;
    let list: Vec<serde_json::Value> = entities
        .into_iter()
        .map(|(entity_type, entity_id)| {
            serde_json::json!({ "entity_type": entity_type, "entity_id": entity_id })
        })
        .collect();
    Ok(Json(serde_json::json!({ "entities": list })))
}

pub(crate) async fn tags_for_entity_handler(
    State(state): State<AppState>,
    Path((entity_type, entity_id)): Path<(String, String)>,
) -> Result<Json<Vec<Tag>>, GatewayError> {
    let entity = parse_tag_entity(&entity_type)?;
    let tags = lock_store(&state)?
        .tags_for_entity(entity, &entity_id)
        .map_err(GatewayError::store)?;
    Ok(Json(tags))
}

pub(crate) async fn tags_all_assignments(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let rows = lock_store(&state)?
        .all_tag_assignments()
        .map_err(GatewayError::store)?;
    let list: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(entity_type, entity_id, tag)| {
            serde_json::json!({ "entity_type": entity_type, "entity_id": entity_id, "tag": tag })
        })
        .collect();
    Ok(Json(serde_json::json!({ "assignments": list })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_tags_owner_smoke() {
        assert!(matches!(
            parse_tag_entity("project"),
            Ok(TagEntity::Project)
        ));
        assert!(matches!(parse_tag_entity("thread"), Ok(TagEntity::Thread)));
        let error = parse_tag_entity("browser").unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert_eq!(error.code, "tag_entity_invalid");
    }
}
