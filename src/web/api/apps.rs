use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::Json;
use axum::routing::{get, patch, post};
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::app_factory::blueprint::AppBlueprint;
use crate::app_factory::{bridge::BridgePolicy, db as app_db, runtime, validation};
use crate::config::Config;
use crate::storage::Database;
use crate::web::auth::{hash_password, require_write, AuthUser};
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
struct UpdateBlueprintRequest {
    blueprint: AppBlueprint,
    change_note: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CreateRecordRequest {
    data: Value,
}

#[derive(Debug, Deserialize)]
struct UpdateRecordRequest {
    data: Value,
}

#[derive(Debug, Deserialize)]
struct CreateAppUserRequest {
    email: String,
    display_name: String,
    password: String,
    role: String,
    contact_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct UpdateAppUserRequest {
    email: String,
    display_name: String,
    password: Option<String>,
    role: String,
    status: String,
    contact_id: Option<i64>,
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
struct AppBlueprintView {
    app_id: i64,
    slug: String,
    schema_version: i64,
    blueprint: AppBlueprint,
}

#[derive(Debug, Serialize)]
struct AppVersionView {
    id: i64,
    app_id: i64,
    version_number: i64,
    blueprint: AppBlueprint,
    change_note: Option<String>,
    created_by_user_id: Option<String>,
    created_at: String,
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
struct AppUserView {
    id: i64,
    email: String,
    display_name: String,
    role: String,
    status: String,
    contact_id: Option<i64>,
    created_at: String,
}

#[derive(Debug, Serialize)]
struct ActionResponse {
    record: RecordView,
    event_type: String,
}

#[derive(Debug, Serialize)]
struct DeleteAppResponse {
    slug: String,
    removed_db_file: bool,
}

pub(super) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/v1/apps", get(list_apps).post(create_app))
        .route("/v1/apps/{slug}", get(get_app).delete(delete_app))
        .route(
            "/v1/apps/{slug}/users",
            get(list_app_users).post(create_app_user),
        )
        .route(
            "/v1/apps/{slug}/users/{app_user_id}",
            patch(update_app_user).delete(delete_app_user),
        )
        .route(
            "/v1/apps/{slug}/bridge-policy",
            get(get_bridge_policy).put(update_bridge_policy),
        )
        .route(
            "/v1/apps/{slug}/blueprint",
            get(get_blueprint).put(update_blueprint),
        )
        .route("/v1/apps/{slug}/versions", get(list_app_versions))
        .route(
            "/v1/apps/{slug}/entities/{entity}/records",
            get(list_records).post(create_record),
        )
        .route(
            "/v1/apps/{slug}/entities/{entity}/records/{record_id}",
            patch(update_record).delete(delete_record),
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

fn app_blueprint_view(row: &app_db::InternalAppRow) -> Result<AppBlueprintView, ApiErr> {
    let blueprint = serde_json::from_str::<AppBlueprint>(&row.blueprint_json).map_err(internal)?;
    Ok(AppBlueprintView {
        app_id: row.id,
        slug: row.slug.clone(),
        schema_version: row.schema_version,
        blueprint,
    })
}

fn app_version_view(row: app_db::InternalAppVersionRow) -> Result<AppVersionView, ApiErr> {
    let blueprint = serde_json::from_str::<AppBlueprint>(&row.blueprint_json).map_err(internal)?;
    Ok(AppVersionView {
        id: row.id,
        app_id: row.app_id,
        version_number: row.version_number,
        blueprint,
        change_note: row.change_note,
        created_by_user_id: row.created_by_user_id,
        created_at: row.created_at,
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

fn app_user_view(row: app_db::AppUserRow) -> AppUserView {
    AppUserView {
        id: row.id,
        email: row.email,
        display_name: row.display_name,
        role: row.role,
        status: row.status,
        contact_id: row.contact_id,
        created_at: row.created_at,
    }
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

async fn delete_app(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path(slug): Path<String>,
) -> Result<Json<DeleteAppResponse>, ApiErr> {
    require_write(&auth)?;
    let db = require_db(&state)?;
    let (app, _) = load_owned_app(db, &auth, &slug).await?;
    let db_path = removable_app_database_path(&Config::data_dir(), &app.db_path)?;

    app_db::delete_app(db.pool(), app.id)
        .await
        .map_err(internal)?;
    let removed_db_file = match remove_app_database_file(&db_path) {
        Ok(removed) => removed,
        Err(error) => {
            tracing::warn!(
                app_slug = %slug,
                db_path = %db_path.display(),
                %error,
                "Deleted internal app metadata but failed to remove app database file"
            );
            false
        }
    };

    Ok(Json(DeleteAppResponse {
        slug,
        removed_db_file,
    }))
}

async fn get_blueprint(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path(slug): Path<String>,
) -> Result<Json<AppBlueprintView>, ApiErr> {
    let db = require_db(&state)?;
    let (row, _) = load_owned_app(db, &auth, &slug).await?;

    Ok(Json(app_blueprint_view(&row)?))
}

async fn update_blueprint(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path(slug): Path<String>,
    Json(body): Json<UpdateBlueprintRequest>,
) -> Result<Json<AppBlueprintView>, ApiErr> {
    require_write(&auth)?;
    if body.blueprint.app.slug != slug {
        return Err(bad_request(
            "Changing an app slug is not supported by the blueprint editor yet",
        ));
    }
    validation::validate_blueprint(&body.blueprint).map_err(|report| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Invalid blueprint", "details": report.errors})),
        )
    })?;

    let db = require_db(&state)?;
    let (app, _) = load_owned_app(db, &auth, &slug).await?;
    app_db::update_app_blueprint(
        db.pool(),
        app.id,
        &body.blueprint,
        body.change_note.as_deref(),
        Some(&auth.user_id),
    )
    .await
    .map_err(internal)?;
    let updated = app_db::load_app_for_user(db.pool(), &auth.user_id, &slug)
        .await
        .map_err(internal)?
        .ok_or_else(|| internal("Updated app was not found"))?;

    Ok(Json(app_blueprint_view(&updated)?))
}

async fn list_app_versions(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path(slug): Path<String>,
) -> Result<Json<Vec<AppVersionView>>, ApiErr> {
    let db = require_db(&state)?;
    let (app, _) = load_owned_app(db, &auth, &slug).await?;
    let versions = app_db::list_app_versions(db.pool(), app.id)
        .await
        .map_err(internal)?
        .into_iter()
        .map(app_version_view)
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Json(versions))
}

async fn list_app_users(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path(slug): Path<String>,
) -> Result<Json<Vec<AppUserView>>, ApiErr> {
    let db = require_db(&state)?;
    let (app, _) = load_owned_app(db, &auth, &slug).await?;
    let app_pool = app_db::open_app_pool(std::path::Path::new(&app.db_path))
        .await
        .map_err(internal)?;
    let users = app_db::list_app_users(&app_pool)
        .await
        .map_err(internal)?
        .into_iter()
        .map(app_user_view)
        .collect();
    app_pool.close().await;

    Ok(Json(users))
}

async fn create_app_user(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path(slug): Path<String>,
    Json(body): Json<CreateAppUserRequest>,
) -> Result<(StatusCode, Json<AppUserView>), ApiErr> {
    require_write(&auth)?;
    if !matches!(
        body.role.as_str(),
        "admin" | "approver" | "employee" | "viewer"
    ) {
        return Err(bad_request("Unsupported app role"));
    }
    if body.password.len() < 8 {
        return Err(bad_request("Password must be at least 8 characters"));
    }

    let db = require_db(&state)?;
    let (app, _) = load_owned_app(db, &auth, &slug).await?;
    let password_hash = hash_password(&body.password).map_err(internal)?;
    let app_pool = app_db::open_app_pool(std::path::Path::new(&app.db_path))
        .await
        .map_err(internal)?;
    let user_id = app_db::insert_app_user(
        &app_pool,
        &body.email,
        &body.display_name,
        &password_hash,
        &body.role,
        body.contact_id,
    )
    .await
    .map_err(internal)?;
    let user = app_db::load_app_user(&app_pool, user_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| internal("Created app user was not found"))?;
    app_pool.close().await;

    Ok((StatusCode::CREATED, Json(app_user_view(user))))
}

async fn update_app_user(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path((slug, app_user_id)): Path<(String, i64)>,
    Json(body): Json<UpdateAppUserRequest>,
) -> Result<Json<AppUserView>, ApiErr> {
    require_write(&auth)?;
    if !matches!(
        body.role.as_str(),
        "admin" | "approver" | "employee" | "viewer"
    ) {
        return Err(bad_request("Unsupported app role"));
    }
    if !matches!(body.status.as_str(), "active" | "disabled") {
        return Err(bad_request("Unsupported app user status"));
    }
    if let Some(password) = body.password.as_deref() {
        if !password.is_empty() && password.len() < 8 {
            return Err(bad_request("Password must be at least 8 characters"));
        }
    }

    let db = require_db(&state)?;
    let (app, _) = load_owned_app(db, &auth, &slug).await?;
    let password_hash = match body.password.as_deref().filter(|value| !value.is_empty()) {
        Some(password) => Some(hash_password(password).map_err(internal)?),
        None => None,
    };
    let app_pool = app_db::open_app_pool(std::path::Path::new(&app.db_path))
        .await
        .map_err(internal)?;
    app_db::update_app_user(
        &app_pool,
        app_user_id,
        &body.email,
        &body.display_name,
        &body.role,
        &body.status,
        body.contact_id,
        password_hash.as_deref(),
    )
    .await
    .map_err(internal)?;
    let user = app_db::load_app_user(&app_pool, app_user_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(json!({"error": "App user not found"})),
            )
        })?;
    app_pool.close().await;

    Ok(Json(app_user_view(user)))
}

async fn delete_app_user(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path((slug, app_user_id)): Path<(String, i64)>,
) -> Result<Json<Value>, ApiErr> {
    require_write(&auth)?;
    let db = require_db(&state)?;
    let (app, _) = load_owned_app(db, &auth, &slug).await?;
    let app_pool = app_db::open_app_pool(std::path::Path::new(&app.db_path))
        .await
        .map_err(internal)?;
    let deleted = app_db::delete_app_user(&app_pool, app_user_id)
        .await
        .map_err(internal)?;
    app_pool.close().await;
    if !deleted {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({"error": "App user not found"})),
        ));
    }

    Ok(Json(json!({"ok": true, "id": app_user_id})))
}

async fn get_bridge_policy(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path(slug): Path<String>,
) -> Result<Json<BridgePolicy>, ApiErr> {
    let db = require_db(&state)?;
    let (app, _) = load_owned_app(db, &auth, &slug).await?;
    let policy = app_db::load_bridge_policy(db.pool(), app.id)
        .await
        .map_err(internal)?
        .and_then(|row| serde_json::from_str::<BridgePolicy>(&row.policy_json).ok())
        .unwrap_or_else(BridgePolicy::deny_all);

    Ok(Json(policy))
}

async fn update_bridge_policy(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path(slug): Path<String>,
    Json(policy): Json<BridgePolicy>,
) -> Result<Json<BridgePolicy>, ApiErr> {
    require_write(&auth)?;
    let db = require_db(&state)?;
    let (app, _) = load_owned_app(db, &auth, &slug).await?;
    let policy = policy.normalized();
    app_db::upsert_bridge_policy(db.pool(), app.id, &policy)
        .await
        .map_err(internal)?;

    Ok(Json(policy))
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

async fn update_record(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path((slug, entity_name, record_id)): Path<(String, String, i64)>,
    Json(body): Json<UpdateRecordRequest>,
) -> Result<Json<RecordView>, ApiErr> {
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

    let data = runtime::validate_existing_record_data(&blueprint, &entity_name, &body.data)
        .map_err(bad_request)?;
    let status = record_status(&blueprint, &entity_name, &data);
    app_db::update_record_data(&app_pool, record_id, &data, status.as_deref())
        .await
        .map_err(internal)?;
    let payload = json!({"entity": entity_name, "record_id": record_id});
    app_db::insert_app_event(
        &app_pool,
        Some(record_id),
        "record.updated",
        &payload,
        Some(&auth.user_id),
    )
    .await
    .map_err(internal)?;
    app_db::insert_internal_app_event(
        db.pool(),
        app.id,
        Some(record_id),
        "record.updated",
        &payload,
        Some(&auth.user_id),
    )
    .await
    .map_err(internal)?;
    let updated = app_db::load_record(&app_pool, record_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| internal("Updated record was not found"))?;
    app_pool.close().await;

    Ok(Json(record_view(updated)?))
}

async fn delete_record(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path((slug, entity_name, record_id)): Path<(String, String, i64)>,
) -> Result<Json<Value>, ApiErr> {
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

    app_db::delete_record(&app_pool, record_id)
        .await
        .map_err(internal)?;
    let payload = json!({"entity": entity_name, "record_id": record_id});
    app_db::insert_internal_app_event(
        db.pool(),
        app.id,
        Some(record_id),
        "record.deleted",
        &payload,
        Some(&auth.user_id),
    )
    .await
    .map_err(internal)?;
    app_pool.close().await;

    Ok(Json(json!({"ok": true, "id": record_id})))
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

fn removable_app_database_path(data_dir: &FsPath, db_path: &str) -> Result<PathBuf, ApiErr> {
    let path = PathBuf::from(db_path);
    if !path.is_absolute() {
        return Err(internal(
            "Refusing to delete app database with a relative path",
        ));
    }
    if path.file_name().and_then(|name| name.to_str()) != Some("app.db") {
        return Err(internal(
            "Refusing to delete app database with an unexpected file name",
        ));
    }

    let apps_root = data_dir.join("apps");
    let normalized_root = apps_root
        .canonicalize()
        .unwrap_or_else(|_| apps_root.clone());
    let parent = path
        .parent()
        .ok_or_else(|| internal("App database path has no parent directory"))?;
    let normalized_parent = parent
        .canonicalize()
        .unwrap_or_else(|_| parent.to_path_buf());
    if !normalized_parent.starts_with(&normalized_root) {
        return Err(internal(
            "Refusing to delete app database outside the apps directory",
        ));
    }

    Ok(path)
}

fn remove_app_database_file(path: &FsPath) -> std::io::Result<bool> {
    if !path.exists() {
        return Ok(false);
    }

    std::fs::remove_file(path)?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::remove_dir(parent);
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn removable_app_database_path_accepts_app_database_under_apps_root() {
        let dir = TempDir::new().unwrap();
        let path = dir
            .path()
            .join("apps")
            .join("user-1")
            .join("crm")
            .join("app.db");

        let result = removable_app_database_path(dir.path(), &path.to_string_lossy()).unwrap();

        assert_eq!(result, path);
    }

    #[test]
    fn removable_app_database_path_rejects_files_outside_apps_root() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("homun.db");

        let result = removable_app_database_path(dir.path(), &path.to_string_lossy());

        assert!(result.is_err());
    }

    #[test]
    fn removable_app_database_path_rejects_non_app_db_file_names() {
        let dir = TempDir::new().unwrap();
        let path = dir
            .path()
            .join("apps")
            .join("user-1")
            .join("crm")
            .join("notes.db");

        let result = removable_app_database_path(dir.path(), &path.to_string_lossy());

        assert!(result.is_err());
    }
}
