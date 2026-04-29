use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::Json;
use axum::routing::{get, post};
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::app_factory::blueprint::AppBlueprint;
use crate::app_factory::{db as app_db, runtime, validation};
use crate::config::Config;
use crate::storage::Database;
use crate::web::auth::{require_write, AuthUser};
use crate::web::server::AppState;

type ApiErr = (StatusCode, Json<Value>);

#[derive(Debug, Deserialize)]
struct AppQuery {
    profile: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RecordsQuery {
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct CreateAppRequest {
    blueprint: AppBlueprint,
    profile: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CreateRecordRequest {
    data: Value,
}

#[derive(Debug, Serialize)]
struct AppView {
    id: i64,
    user_id: String,
    profile_id: Option<i64>,
    slug: String,
    name: String,
    description: Option<String>,
    blueprint: AppBlueprint,
    schema_version: i64,
    storage_mode: String,
    status: String,
    created_at: String,
    updated_at: Option<String>,
}

#[derive(Debug, Serialize)]
struct RecordView {
    id: i64,
    entity_name: String,
    data: Value,
    status: Option<String>,
    created_by_user_id: Option<String>,
    created_at: String,
    updated_at: Option<String>,
}

#[derive(Debug, Serialize)]
struct ActionResponse {
    record: RecordView,
    event_type: String,
}

pub(super) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/v1/apps", get(list_apps).post(create_app))
        .route("/v1/apps/{slug}", get(get_app))
        .route(
            "/v1/apps/{slug}/entities/{entity}/records",
            get(list_records).post(create_record),
        )
        .route(
            "/v1/apps/{slug}/entities/{entity}/records/{record_id}/actions/{action}",
            post(run_action),
        )
}

fn require_db(state: &AppState) -> Result<&Database, ApiErr> {
    state.db.as_ref().ok_or_else(|| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "Database not available"})),
        )
    })
}

fn internal<E: std::fmt::Display>(e: E) -> ApiErr {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error": e.to_string()})),
    )
}

fn bad_request<E: std::fmt::Display>(e: E) -> ApiErr {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error": e.to_string()})),
    )
}

async fn resolve_profile_id(
    db: &Database,
    profile: Option<&str>,
    auth: &AuthUser,
) -> Result<Option<i64>, ApiErr> {
    let Some(slug) = profile.map(str::trim).filter(|slug| !slug.is_empty()) else {
        return Ok(None);
    };

    crate::profiles::db::load_profile_by_slug_for_user(db.pool(), slug, &auth.user_id)
        .await
        .map_err(internal)?
        .map(|profile| Some(profile.id))
        .ok_or_else(|| {
            (
                StatusCode::FORBIDDEN,
                Json(json!({"error": "Profile is not available for this user"})),
            )
        })
}

fn app_view(row: app_db::InternalAppRow) -> Result<AppView, ApiErr> {
    let blueprint = serde_json::from_str::<AppBlueprint>(&row.blueprint_json).map_err(internal)?;
    Ok(AppView {
        id: row.id,
        user_id: row.user_id,
        profile_id: row.profile_id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        blueprint,
        schema_version: row.schema_version,
        storage_mode: row.storage_mode,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

fn record_view(row: app_db::AppRecordRow) -> Result<RecordView, ApiErr> {
    let data = serde_json::from_str::<Value>(&row.data_json).map_err(internal)?;
    Ok(RecordView {
        id: row.id,
        entity_name: row.entity_name,
        data,
        status: row.status,
        created_by_user_id: row.created_by_user_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

async fn load_owned_app(
    db: &Database,
    auth: &AuthUser,
    slug: &str,
) -> Result<(app_db::InternalAppRow, AppBlueprint), ApiErr> {
    let row = app_db::load_app_for_user(db.pool(), &auth.user_id, slug)
        .await
        .map_err(internal)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(json!({"error": "App not found"})),
            )
        })?;
    let blueprint = serde_json::from_str::<AppBlueprint>(&row.blueprint_json).map_err(internal)?;
    validation::validate_blueprint(&blueprint).map_err(|report| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "Stored blueprint is invalid", "details": report.errors})),
        )
    })?;
    Ok((row, blueprint))
}

fn record_status(blueprint: &AppBlueprint, entity_name: &str, data: &Value) -> Option<String> {
    let workflow = blueprint
        .workflows
        .iter()
        .find(|workflow| workflow.entity == entity_name)?;
    data.get(&workflow.state_field)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

async fn list_apps(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Query(query): Query<AppQuery>,
) -> Result<Json<Vec<AppView>>, ApiErr> {
    let db = require_db(&state)?;
    let profile_id = resolve_profile_id(db, query.profile.as_deref(), &auth).await?;
    let rows = app_db::list_apps_for_user(db.pool(), &auth.user_id, profile_id)
        .await
        .map_err(internal)?;
    let apps = rows
        .into_iter()
        .map(app_view)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(apps))
}

async fn create_app(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Json(body): Json<CreateAppRequest>,
) -> Result<(StatusCode, Json<AppView>), ApiErr> {
    require_write(&auth)?;
    validation::validate_blueprint(&body.blueprint).map_err(|report| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Invalid blueprint", "details": report.errors})),
        )
    })?;

    let db = require_db(&state)?;
    let profile_id = resolve_profile_id(db, body.profile.as_deref(), &auth).await?;
    let app_id = app_db::insert_app(
        db.pool(),
        &Config::data_dir(),
        &auth.user_id,
        profile_id,
        &body.blueprint,
    )
    .await
    .map_err(internal)?;
    let row = app_db::load_app_for_user(db.pool(), &auth.user_id, &body.blueprint.app.slug)
        .await
        .map_err(internal)?
        .ok_or_else(|| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": format!("Created app {app_id} was not found")})),
            )
        })?;

    Ok((StatusCode::CREATED, Json(app_view(row)?)))
}

async fn get_app(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path(slug): Path<String>,
) -> Result<Json<AppView>, ApiErr> {
    let db = require_db(&state)?;
    let (row, _) = load_owned_app(db, &auth, &slug).await?;
    Ok(Json(app_view(row)?))
}

async fn list_records(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path((slug, entity_name)): Path<(String, String)>,
    Query(query): Query<RecordsQuery>,
) -> Result<Json<Vec<RecordView>>, ApiErr> {
    let db = require_db(&state)?;
    let (app, blueprint) = load_owned_app(db, &auth, &slug).await?;
    runtime::entity(&blueprint, &entity_name).map_err(bad_request)?;
    let limit = query.limit.unwrap_or(100).clamp(1, 500);
    let app_pool = app_db::open_app_pool(std::path::Path::new(&app.db_path))
        .await
        .map_err(internal)?;
    let rows = app_db::list_records(&app_pool, &entity_name, limit)
        .await
        .map_err(internal)?;
    app_pool.close().await;
    let records = rows
        .into_iter()
        .map(record_view)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(records))
}

async fn create_record(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path((slug, entity_name)): Path<(String, String)>,
    Json(body): Json<CreateRecordRequest>,
) -> Result<(StatusCode, Json<RecordView>), ApiErr> {
    require_write(&auth)?;
    let db = require_db(&state)?;
    let (app, blueprint) = load_owned_app(db, &auth, &slug).await?;
    let data =
        runtime::validate_record_data(&blueprint, &entity_name, &body.data).map_err(bad_request)?;
    let status = record_status(&blueprint, &entity_name, &data);
    let app_pool = app_db::open_app_pool(std::path::Path::new(&app.db_path))
        .await
        .map_err(internal)?;
    let record_id = app_db::insert_record(
        &app_pool,
        &entity_name,
        &data,
        status.as_deref(),
        Some(&auth.user_id),
    )
    .await
    .map_err(internal)?;
    let payload = json!({"entity": entity_name, "record_id": record_id});
    app_db::insert_app_event(
        &app_pool,
        Some(record_id),
        "record.created",
        &payload,
        Some(&auth.user_id),
    )
    .await
    .map_err(internal)?;
    app_db::insert_internal_app_event(
        db.pool(),
        app.id,
        Some(record_id),
        "record.created",
        &payload,
        Some(&auth.user_id),
    )
    .await
    .map_err(internal)?;
    let row = app_db::load_record(&app_pool, record_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "Created record was not found"})),
            )
        })?;
    app_pool.close().await;
    Ok((StatusCode::CREATED, Json(record_view(row)?)))
}

async fn run_action(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path((slug, entity_name, record_id, action)): Path<(String, String, i64, String)>,
) -> Result<Json<ActionResponse>, ApiErr> {
    require_write(&auth)?;
    let db = require_db(&state)?;
    let (app, blueprint) = load_owned_app(db, &auth, &slug).await?;
    runtime::entity(&blueprint, &entity_name).map_err(bad_request)?;
    let app_pool = app_db::open_app_pool(std::path::Path::new(&app.db_path))
        .await
        .map_err(internal)?;
    let row = app_db::load_record(&app_pool, record_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(json!({"error": "Record not found"})),
            )
        })?;
    if row.entity_name != entity_name {
        app_pool.close().await;
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({"error": "Record not found"})),
        ));
    }
    let mut data = serde_json::from_str::<Value>(&row.data_json).map_err(internal)?;
    let event_type = runtime::apply_transition(&blueprint, &entity_name, &mut data, &action)
        .map_err(bad_request)?;
    let status = record_status(&blueprint, &entity_name, &data);
    app_db::update_record_data(&app_pool, record_id, &data, status.as_deref())
        .await
        .map_err(internal)?;
    let payload = json!({"entity": entity_name, "record_id": record_id, "action": action});
    app_db::insert_app_event(
        &app_pool,
        Some(record_id),
        &event_type,
        &payload,
        Some(&auth.user_id),
    )
    .await
    .map_err(internal)?;
    app_db::insert_internal_app_event(
        db.pool(),
        app.id,
        Some(record_id),
        &event_type,
        &payload,
        Some(&auth.user_id),
    )
    .await
    .map_err(internal)?;
    let updated = app_db::load_record(&app_pool, record_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(json!({"error": "Record not found"})),
            )
        })?;
    app_pool.close().await;

    Ok(Json(ActionResponse {
        record: record_view(updated)?,
        event_type,
    }))
}
