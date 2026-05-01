use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{AppendHeaders, Json};
use axum::routing::{get, post};
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::app_factory::blueprint::AppBlueprint;
use crate::app_factory::{
    bridge::BridgePolicy,
    db as app_db, external_auth,
    permissions::{self, RecordScope},
    runtime, validation,
};
use crate::contacts::Contact;
use crate::web::auth::verify_password;
use crate::web::server::AppState;

type ApiErr = (StatusCode, Json<Value>);

#[derive(Debug, Deserialize)]
struct LoginRequest {
    email: String,
    password: String,
}

#[derive(Debug, Serialize)]
struct AppMeResponse {
    id: i64,
    email: String,
    display_name: String,
    role: String,
}

#[derive(Debug, Deserialize)]
struct RecordsQuery {
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct CreateRecordRequest {
    data: Value,
}

#[derive(Debug, Serialize)]
struct ExternalRecordView {
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
    record: ExternalRecordView,
    event_type: String,
}

#[derive(Debug, Serialize)]
struct ExternalContactView {
    id: i64,
    name: String,
    nickname: Option<String>,
    bio: String,
    preferred_channel: Option<String>,
    tags: Vec<String>,
}

pub(super) fn public_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/a/{slug}/login", post(login))
        .route("/api/a/{slug}/logout", post(logout))
        .route("/api/a/{slug}/me", get(me))
        .route("/api/a/{slug}/meta", get(meta))
        .route("/api/a/{slug}/contacts", get(list_allowed_contacts))
        .route(
            "/api/a/{slug}/entities/{entity}/records",
            get(list_records).post(create_record),
        )
        .route(
            "/api/a/{slug}/entities/{entity}/records/{record_id}/actions/{action}",
            post(run_action),
        )
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

fn forbidden<E: std::fmt::Display>(e: E) -> ApiErr {
    (StatusCode::FORBIDDEN, Json(json!({"error": e.to_string()})))
}

fn unauthorized<E: std::fmt::Display>(e: E) -> ApiErr {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({"error": e.to_string()})),
    )
}

async fn load_public_app(
    state: &AppState,
    slug: &str,
) -> Result<(app_db::InternalAppRow, AppBlueprint), ApiErr> {
    let db = state
        .db
        .as_ref()
        .ok_or_else(|| internal("Database not available"))?;
    let row = app_db::load_app_by_slug(db.pool(), slug)
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

fn app_session_cookie(headers: &HeaderMap, slug: &str) -> Option<String> {
    let name = external_auth::cookie_name(slug);
    let cookie = headers.get(header::COOKIE)?.to_str().ok()?;
    cookie.split(';').map(str::trim).find_map(|part| {
        let (key, value) = part.split_once('=')?;
        (key == name).then(|| value.to_string())
    })
}

async fn require_app_user(
    state: &AppState,
    slug: &str,
    headers: &HeaderMap,
) -> Result<
    (
        app_db::InternalAppRow,
        AppBlueprint,
        sqlx::SqlitePool,
        external_auth::AppAuthUser,
    ),
    ApiErr,
> {
    let (app, blueprint) = load_public_app(state, slug).await?;
    let session_id =
        app_session_cookie(headers, slug).ok_or_else(|| unauthorized("Not signed in"))?;
    let app_pool = app_db::open_app_pool(std::path::Path::new(&app.db_path))
        .await
        .map_err(internal)?;
    let session = app_db::load_app_session(&app_pool, &session_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| unauthorized("Session expired"))?;
    let user = app_db::load_app_user(&app_pool, session.app_user_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| unauthorized("User not found"))?;

    Ok((
        app,
        blueprint,
        app_pool,
        external_auth::AppAuthUser::from((slug, user)),
    ))
}

async fn load_bridge_policy_or_deny_all(state: &AppState, app_id: i64) -> BridgePolicy {
    let Some(db) = state.db.as_ref() else {
        return BridgePolicy::deny_all();
    };
    match app_db::load_bridge_policy(db.pool(), app_id).await {
        Ok(Some(row)) => {
            serde_json::from_str(&row.policy_json).unwrap_or_else(|_| BridgePolicy::deny_all())
        }
        _ => BridgePolicy::deny_all(),
    }
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

fn external_record_view(row: app_db::AppRecordRow) -> Result<ExternalRecordView, ApiErr> {
    let data = serde_json::from_str::<Value>(&row.data_json).map_err(internal)?;
    Ok(ExternalRecordView {
        id: row.id,
        entity_name: row.entity_name,
        data,
        status: row.status,
        created_by_user_id: row.created_by_user_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

fn contact_tags(contact: &Contact) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(&contact.tags).unwrap_or_else(|_| {
        contact
            .tags
            .split(',')
            .map(str::trim)
            .filter(|tag| !tag.is_empty())
            .map(ToOwned::to_owned)
            .collect()
    })
}

fn policy_allows_contact(policy: &BridgePolicy, contact: &Contact) -> bool {
    if policy.allows_contact_ref("*")
        || policy.allows_contact_ref(&contact.id.to_string())
        || policy.allows_contact_ref(&contact.name)
    {
        return true;
    }
    if let Some(nickname) = contact.nickname.as_deref() {
        if policy.allows_contact_ref(nickname) {
            return true;
        }
    }
    contact_tags(contact)
        .iter()
        .any(|tag| policy.allows_contact_ref(tag))
}

fn external_contact_view(contact: Contact) -> ExternalContactView {
    let tags = contact_tags(&contact);
    ExternalContactView {
        id: contact.id,
        name: contact.name,
        nickname: contact.nickname,
        bio: contact.bio,
        preferred_channel: contact.preferred_channel,
        tags,
    }
}

async fn login(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Json(body): Json<LoginRequest>,
) -> Result<
    (
        AppendHeaders<[(header::HeaderName, String); 1]>,
        Json<AppMeResponse>,
    ),
    ApiErr,
> {
    let (app, _) = load_public_app(&state, &slug).await?;
    let app_pool = app_db::open_app_pool(std::path::Path::new(&app.db_path))
        .await
        .map_err(internal)?;
    let user = app_db::load_app_user_by_email(&app_pool, &body.email)
        .await
        .map_err(internal)?
        .ok_or_else(|| unauthorized("Invalid credentials"))?;
    if user.status != "active" || !verify_password(&body.password, &user.password_hash) {
        app_pool.close().await;
        return Err(unauthorized("Invalid credentials"));
    }

    let session_id = external_auth::generate_session_id().map_err(internal)?;
    app_db::insert_app_session(&app_pool, &session_id, user.id, "2099-01-01 00:00:00")
        .await
        .map_err(internal)?;
    app_pool.close().await;

    let cookie = format!(
        "{}={}; Path=/; HttpOnly; SameSite=Lax; Secure",
        external_auth::cookie_name(&slug),
        session_id
    );
    Ok((
        AppendHeaders([(header::SET_COOKIE, cookie)]),
        Json(AppMeResponse {
            id: user.id,
            email: user.email,
            display_name: user.display_name,
            role: user.role,
        }),
    ))
}

async fn logout(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    headers: HeaderMap,
) -> Result<AppendHeaders<[(header::HeaderName, String); 1]>, ApiErr> {
    if let Some(session_id) = app_session_cookie(&headers, &slug) {
        let (app, _) = load_public_app(&state, &slug).await?;
        let app_pool = app_db::open_app_pool(std::path::Path::new(&app.db_path))
            .await
            .map_err(internal)?;
        let _ = app_db::delete_app_session(&app_pool, &session_id).await;
        app_pool.close().await;
    }
    let cookie = format!(
        "{}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
        external_auth::cookie_name(&slug)
    );
    Ok(AppendHeaders([(header::SET_COOKIE, cookie)]))
}

async fn me(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    headers: HeaderMap,
) -> Result<Json<AppMeResponse>, ApiErr> {
    let (_, _, app_pool, user) = require_app_user(&state, &slug, &headers).await?;
    app_pool.close().await;
    Ok(Json(AppMeResponse {
        id: user.app_user_id,
        email: user.email,
        display_name: user.display_name,
        role: user.role,
    }))
}

async fn meta(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiErr> {
    let (app, blueprint, app_pool, user) = require_app_user(&state, &slug, &headers).await?;
    app_pool.close().await;
    Ok(Json(json!({
        "slug": app.slug,
        "name": app.name,
        "description": app.description,
        "blueprint": blueprint,
        "user": {
            "id": user.app_user_id,
            "email": user.email,
            "display_name": user.display_name,
            "role": user.role
        }
    })))
}

async fn list_records(
    State(state): State<Arc<AppState>>,
    Path((slug, entity_name)): Path<(String, String)>,
    Query(query): Query<RecordsQuery>,
    headers: HeaderMap,
) -> Result<Json<Vec<ExternalRecordView>>, ApiErr> {
    let (_, blueprint, app_pool, user) = require_app_user(&state, &slug, &headers).await?;
    runtime::entity(&blueprint, &entity_name).map_err(bad_request)?;
    let limit = query.limit.unwrap_or(100).clamp(1, 500);
    let rows = app_db::list_records(&app_pool, &entity_name, limit)
        .await
        .map_err(internal)?;

    let rows = match permissions::read_scope(&blueprint, &user.role, &entity_name) {
        RecordScope::All => rows,
        RecordScope::Own => {
            let app_user_id = user.app_user_id.to_string();
            rows.into_iter()
                .filter(|row| row.created_by_user_id.as_deref() == Some(app_user_id.as_str()))
                .collect()
        }
        RecordScope::None => {
            app_pool.close().await;
            return Err(forbidden("This role cannot read records"));
        }
    };
    app_pool.close().await;

    Ok(Json(
        rows.into_iter()
            .map(external_record_view)
            .collect::<Result<Vec<_>, _>>()?,
    ))
}

async fn list_allowed_contacts(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<ExternalContactView>>, ApiErr> {
    let db = state
        .db
        .as_ref()
        .ok_or_else(|| internal("Database not available"))?;
    let (app, _, app_pool, _) = require_app_user(&state, &slug, &headers).await?;
    app_pool.close().await;
    let policy = load_bridge_policy_or_deny_all(&state, app.id).await;
    if policy.contacts.read.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let contacts = db
        .list_contacts_for_user(None, app.profile_id, &app.user_id)
        .await
        .map_err(internal)?
        .into_iter()
        .filter(|contact| policy_allows_contact(&policy, contact))
        .map(external_contact_view)
        .collect();

    Ok(Json(contacts))
}

async fn create_record(
    State(state): State<Arc<AppState>>,
    Path((slug, entity_name)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<CreateRecordRequest>,
) -> Result<(StatusCode, Json<ExternalRecordView>), ApiErr> {
    let db = state
        .db
        .as_ref()
        .ok_or_else(|| internal("Database not available"))?;
    let (app, blueprint, app_pool, user) = require_app_user(&state, &slug, &headers).await?;
    let _bridge_policy = load_bridge_policy_or_deny_all(&state, app.id).await;
    external_auth::ensure_role(
        permissions::can_create(&blueprint, &user.role, &entity_name),
        "This role cannot create records",
    )
    .map_err(forbidden)?;
    let sanitized =
        permissions::sanitize_create_input(&blueprint, &user.role, &entity_name, &body.data)
            .map_err(bad_request)?;
    let data =
        runtime::validate_record_data(&blueprint, &entity_name, &sanitized).map_err(bad_request)?;
    let status = record_status(&blueprint, &entity_name, &data);
    let actor_user_id = user.app_user_id.to_string();
    let record_id = app_db::insert_record(
        &app_pool,
        &entity_name,
        &data,
        status.as_deref(),
        Some(actor_user_id.as_str()),
    )
    .await
    .map_err(internal)?;
    let payload = json!({"entity": entity_name, "record_id": record_id});
    app_db::insert_app_event(
        &app_pool,
        Some(record_id),
        "record.created",
        &payload,
        Some(actor_user_id.as_str()),
    )
    .await
    .map_err(internal)?;
    app_db::insert_internal_app_event(
        db.pool(),
        app.id,
        Some(record_id),
        "record.created",
        &payload,
        Some(actor_user_id.as_str()),
    )
    .await
    .map_err(internal)?;
    let row = app_db::load_record(&app_pool, record_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| internal("Created record was not found"))?;
    app_pool.close().await;

    Ok((StatusCode::CREATED, Json(external_record_view(row)?)))
}

async fn run_action(
    State(state): State<Arc<AppState>>,
    Path((slug, entity_name, record_id, action)): Path<(String, String, i64, String)>,
    headers: HeaderMap,
) -> Result<Json<ActionResponse>, ApiErr> {
    let db = state
        .db
        .as_ref()
        .ok_or_else(|| internal("Database not available"))?;
    let (app, blueprint, app_pool, user) = require_app_user(&state, &slug, &headers).await?;
    let _bridge_policy = load_bridge_policy_or_deny_all(&state, app.id).await;
    external_auth::ensure_role(
        permissions::can_transition(&blueprint, &user.role, &entity_name, &action),
        "This role cannot run this action",
    )
    .map_err(forbidden)?;
    runtime::entity(&blueprint, &entity_name).map_err(bad_request)?;
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
    let actor_user_id = user.app_user_id.to_string();
    let payload = json!({"entity": entity_name, "record_id": record_id, "action": action});
    app_db::insert_app_event(
        &app_pool,
        Some(record_id),
        &event_type,
        &payload,
        Some(actor_user_id.as_str()),
    )
    .await
    .map_err(internal)?;
    app_db::insert_internal_app_event(
        db.pool(),
        app.id,
        Some(record_id),
        &event_type,
        &payload,
        Some(actor_user_id.as_str()),
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
        record: external_record_view(updated)?,
        event_type,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_session_cookie_reads_slug_scoped_cookie() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            "other=1; homun_app_session_ferie_permessi=session-1"
                .parse()
                .unwrap(),
        );

        assert_eq!(
            app_session_cookie(&headers, "ferie-permessi"),
            Some("session-1".to_string())
        );
        assert_eq!(app_session_cookie(&headers, "crm"), None);
    }

    #[test]
    fn contact_policy_allows_star_id_name_nickname_and_tags() {
        let contact = Contact {
            id: 42,
            name: "Mario Rossi".to_string(),
            nickname: Some("mario".to_string()),
            bio: String::new(),
            notes: String::new(),
            birthday: None,
            nameday: None,
            preferred_channel: Some("email".to_string()),
            response_mode: "automatic".to_string(),
            tone_of_voice: String::new(),
            tags: "[\"hr-team\",\"manager\"]".to_string(),
            avatar_url: None,
            created_at: String::new(),
            updated_at: String::new(),
            persona_override: None,
            persona_instructions: String::new(),
            agent_override: None,
            profile_id: None,
            user_id: Some("owner".to_string()),
        };

        for allowed_ref in ["*", "42", "Mario Rossi", "mario", "hr-team"] {
            let policy = BridgePolicy {
                contacts: crate::app_factory::bridge::ContactAccess {
                    read: vec![allowed_ref.to_string()],
                    link_app_users: false,
                },
                ..BridgePolicy::deny_all()
            };
            assert!(policy_allows_contact(&policy, &contact));
        }
    }
}
