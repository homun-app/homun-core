//! Memory source grant HTTP routes.
//!
//! Owns linked-memory source grant list/upsert/revoke/candidates routes,
//! request DTOs, grant policy validation, and API-facing projections. Workspace
//! registry persistence and MemoryFacade storage semantics remain separate.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::env;
use std::fs;

use axum::{
    Json,
    extract::{Path, Query, RawQuery, Request, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};

use local_first_memory::{
    DataSensitivity as MemoryDataSensitivity, MEMORY_SOURCE_CANDIDATE_PAGE_MAX,
    MemoryCollectionKey, MemoryError, MemoryFacade, MemoryGrantOverrideEffect, MemoryRef,
    MemoryRefKind, MemorySourceCandidateProjection, MemorySourceGrant, MemoryStatus,
    PERSONAL_WORKSPACE, UserId as MemoryUserId, WorkspaceId as MemoryWorkspaceId, contains_secret,
    redact_text as redact_memory_text,
};

use crate::{
    AppState, ContactMemoryPerimeter, GatewayError, THREADS_WORKSPACE, WorkspaceRecord,
    WorkspacesFile, canonical_memory_workspace_id, gateway_memory_user_id, gateway_workspaces_path,
    load_workspaces_file, memory_facade, now_epoch_secs, truncate_chars,
};

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct MemorySourceOverrideInput {
    pub(crate) memory_ref: String,
    pub(crate) effect: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct MemorySourceUpsertRequest {
    pub(crate) source_workspace_id: String,
    pub(crate) collections: Vec<String>,
    pub(crate) max_sensitivity: String,
    pub(crate) expires_at: Option<i64>,
    pub(crate) overrides: Vec<MemorySourceOverrideInput>,
}

#[derive(Debug, Clone)]
pub(crate) struct ValidatedMemorySourceInput {
    pub(crate) source_workspace_id: MemoryWorkspaceId,
    pub(crate) collections: BTreeSet<MemoryCollectionKey>,
    pub(crate) max_sensitivity: MemoryDataSensitivity,
    pub(crate) expires_at: Option<i64>,
    pub(crate) overrides: Vec<(MemoryRef, MemoryGrantOverrideEffect)>,
}

#[derive(Debug, Clone)]
pub(crate) struct MemorySourceWorkspaceContext {
    pub(crate) consumer: WorkspaceRecord,
    pub(crate) source_workspace_id: MemoryWorkspaceId,
    pub(crate) source_available: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct MemorySourceGrantView {
    pub(crate) id: Option<String>,
    pub(crate) source_workspace_id: String,
    pub(crate) source_label: String,
    pub(crate) source_available: bool,
    pub(crate) local: bool,
    pub(crate) read_only: bool,
    pub(crate) collections: Vec<MemoryCollectionKey>,
    pub(crate) max_sensitivity: MemoryDataSensitivity,
    pub(crate) expires_at: Option<i64>,
    pub(crate) revoked_at: Option<i64>,
    pub(crate) policy_version: u64,
    pub(crate) last_used_at: Option<i64>,
    pub(crate) overrides: Vec<MemorySourceGrantOverrideView>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct MemorySourceGrantOverrideView {
    pub(crate) memory_ref: String,
    pub(crate) effect: MemoryGrantOverrideEffect,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct MemorySourceCandidateView {
    #[serde(rename = "ref")]
    pub(crate) reference: String,
    pub(crate) summary: String,
    #[serde(rename = "type")]
    pub(crate) memory_type: String,
    pub(crate) collection: MemoryCollectionKey,
    pub(crate) sensitivity: MemoryDataSensitivity,
}

#[derive(Debug, Deserialize)]
pub(crate) struct MemorySourceCandidatesQuery {
    pub(crate) source_workspace_id: String,
    #[serde(default)]
    pub(crate) offset: Option<usize>,
    #[serde(default)]
    pub(crate) limit: Option<usize>,
}

pub(crate) fn memory_sources_flag(value: Option<&str>) -> bool {
    !matches!(
        value.map(|value| value.trim().to_ascii_lowercase()),
        Some(value) if value == "0" || value == "off"
    )
}

pub(crate) fn memory_sources_enabled() -> bool {
    memory_sources_flag(env::var("HOMUN_MEMORY_SOURCES").ok().as_deref())
}

pub(crate) fn memory_perimeter_allows_recall(
    contact_memory_perimeter: &ContactMemoryPerimeter,
    in_project: bool,
) -> bool {
    !contact_memory_perimeter.contact_only
        && contact_memory_perimeter.can_see_contacts
        && (!in_project || contact_memory_perimeter.can_use_project_memory)
}

fn parse_memory_collection(value: &str) -> Result<MemoryCollectionKey, &'static str> {
    match value {
        "preferences" => Ok(MemoryCollectionKey::Preferences),
        "profile" => Ok(MemoryCollectionKey::Profile),
        "knowledge" => Ok(MemoryCollectionKey::Knowledge),
        "decisions" => Ok(MemoryCollectionKey::Decisions),
        "goals" => Ok(MemoryCollectionKey::Goals),
        "artifacts" => Ok(MemoryCollectionKey::Artifacts),
        "episodes" => Ok(MemoryCollectionKey::Episodes),
        _ => Err("collection_not_allowed"),
    }
}

fn parse_grant_sensitivity(value: &str) -> Result<MemoryDataSensitivity, &'static str> {
    match value {
        "public" => Ok(MemoryDataSensitivity::Public),
        "internal" => Ok(MemoryDataSensitivity::Internal),
        "private" => Ok(MemoryDataSensitivity::Private),
        "confidential" => Ok(MemoryDataSensitivity::Confidential),
        _ => Err("sensitivity_not_allowed"),
    }
}

pub(crate) fn validate_memory_source_input(
    consumer_workspace_id: &str,
    request: &MemorySourceUpsertRequest,
) -> Result<ValidatedMemorySourceInput, &'static str> {
    let consumer_workspace_id = canonical_memory_workspace_id(consumer_workspace_id);
    if consumer_workspace_id.as_str().is_empty() {
        return Err("empty_consumer_workspace");
    }
    if matches!(
        consumer_workspace_id.as_str(),
        PERSONAL_WORKSPACE | THREADS_WORKSPACE
    ) {
        return Err("reserved_consumer_scope");
    }

    let source_workspace_id = canonical_memory_workspace_id(&request.source_workspace_id);
    if source_workspace_id.as_str().is_empty() {
        return Err("empty_source_workspace");
    }
    if source_workspace_id.as_str() == THREADS_WORKSPACE {
        return Err("reserved_source_scope");
    }
    if source_workspace_id == consumer_workspace_id {
        return Err("source_equals_consumer");
    }
    if request.collections.is_empty() && request.overrides.is_empty() {
        return Err("empty_source_policy");
    }

    let mut collections = BTreeSet::new();
    for collection in &request.collections {
        let collection = parse_memory_collection(collection)?;
        if !collections.insert(collection) {
            return Err("duplicate_collection");
        }
    }
    let max_sensitivity = parse_grant_sensitivity(&request.max_sensitivity)?;

    let mut seen_overrides = HashSet::new();
    let mut overrides = Vec::with_capacity(request.overrides.len());
    for override_input in &request.overrides {
        let raw_reference = override_input.memory_ref.as_str();
        if raw_reference.trim() != raw_reference {
            return Err("noncanonical_memory_ref");
        }
        let reference = raw_reference
            .parse::<MemoryRef>()
            .map_err(|_| "invalid_memory_ref")?;
        if reference.to_string() != raw_reference
            || reference.scope != "local"
            || reference.user_id.as_str().trim().is_empty()
            || reference.workspace_id.as_str().trim().is_empty()
            || reference.key.trim().is_empty()
        {
            return Err("noncanonical_memory_ref");
        }
        if reference.kind != MemoryRefKind::Memory {
            return Err("invalid_override_kind");
        }
        if reference.workspace_id != source_workspace_id {
            return Err("override_outside_source");
        }
        if !seen_overrides.insert(reference.to_string()) {
            return Err("duplicate_override_ref");
        }
        let effect = match override_input.effect.as_str() {
            "allow" => MemoryGrantOverrideEffect::Allow,
            "deny" => MemoryGrantOverrideEffect::Deny,
            _ => return Err("override_effect_not_allowed"),
        };
        overrides.push((reference, effect));
    }

    Ok(ValidatedMemorySourceInput {
        source_workspace_id,
        collections,
        max_sensitivity,
        expires_at: request.expires_at,
        overrides,
    })
}

pub(crate) fn validate_memory_source_workspaces(
    snapshot: &WorkspacesFile,
    consumer_workspace_id: &str,
    source_workspace_id: &str,
) -> Result<MemorySourceWorkspaceContext, &'static str> {
    let raw_consumer_workspace_id = consumer_workspace_id.trim();
    let consumer_memory_workspace_id = canonical_memory_workspace_id(raw_consumer_workspace_id);
    if consumer_memory_workspace_id.as_str().is_empty() {
        return Err("empty_consumer_workspace");
    }
    if matches!(
        consumer_memory_workspace_id.as_str(),
        PERSONAL_WORKSPACE | THREADS_WORKSPACE
    ) {
        return Err("reserved_consumer_scope");
    }
    let consumer = snapshot
        .workspaces
        .iter()
        .find(|workspace| workspace.id == raw_consumer_workspace_id)
        .cloned()
        .ok_or("consumer_workspace_not_found")?;

    let source_workspace_id = canonical_memory_workspace_id(source_workspace_id);
    if source_workspace_id.as_str().is_empty() {
        return Err("empty_source_workspace");
    }
    if source_workspace_id.as_str() == THREADS_WORKSPACE {
        return Err("reserved_source_scope");
    }
    if source_workspace_id == consumer_memory_workspace_id {
        return Err("source_equals_consumer");
    }
    if source_workspace_id.as_str() == PERSONAL_WORKSPACE {
        return Ok(MemorySourceWorkspaceContext {
            consumer,
            source_workspace_id,
            source_available: true,
        });
    }
    if !snapshot
        .workspaces
        .iter()
        .any(|workspace| workspace.id == source_workspace_id.as_str())
    {
        return Err("source_workspace_not_found");
    }
    Ok(MemorySourceWorkspaceContext {
        consumer,
        source_workspace_id,
        source_available: true,
    })
}

fn validate_memory_source_consumer(
    snapshot: &WorkspacesFile,
    consumer_workspace_id: &str,
) -> Result<WorkspaceRecord, &'static str> {
    let raw_consumer_workspace_id = consumer_workspace_id.trim();
    let consumer_memory_workspace_id = canonical_memory_workspace_id(raw_consumer_workspace_id);
    if consumer_memory_workspace_id.as_str().is_empty() {
        return Err("empty_consumer_workspace");
    }
    if matches!(
        consumer_memory_workspace_id.as_str(),
        PERSONAL_WORKSPACE | THREADS_WORKSPACE
    ) {
        return Err("reserved_consumer_scope");
    }
    snapshot
        .workspaces
        .iter()
        .find(|workspace| workspace.id == raw_consumer_workspace_id)
        .cloned()
        .ok_or("consumer_workspace_not_found")
}

fn memory_source_bad_request(code: &'static str) -> GatewayError {
    GatewayError {
        status: StatusCode::BAD_REQUEST,
        code,
        message: code.to_string(),
    }
}

fn memory_source_disabled_error() -> GatewayError {
    GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "memory_sources_disabled",
        message: "memory_sources_disabled".to_string(),
    }
}

pub(crate) fn memory_source_facade_error(error: MemoryError) -> GatewayError {
    match error {
        MemoryError::NotFound(_) => GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "memory_source_grant_not_found",
            message: "memory_source_grant_not_found".to_string(),
        },
        MemoryError::Policy(_) => GatewayError {
            status: StatusCode::CONFLICT,
            code: "memory_source_conflict",
            message: "memory_source_conflict".to_string(),
        },
        MemoryError::Validation(_) => GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "memory_source_invalid",
            message: "memory_source_invalid".to_string(),
        },
        MemoryError::Store(_) => GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "memory_source_store_error",
            message: "memory_source_store_error".to_string(),
        },
    }
}

fn all_memory_collections() -> Vec<MemoryCollectionKey> {
    vec![
        MemoryCollectionKey::Preferences,
        MemoryCollectionKey::Profile,
        MemoryCollectionKey::Knowledge,
        MemoryCollectionKey::Decisions,
        MemoryCollectionKey::Goals,
        MemoryCollectionKey::Artifacts,
        MemoryCollectionKey::Episodes,
    ]
}

fn memory_source_workspace_label(workspace: &WorkspaceRecord) -> String {
    let name = workspace.name.trim();
    if name.is_empty() {
        workspace.id.clone()
    } else {
        name.to_string()
    }
}

pub(crate) fn memory_source_grant_views<F>(
    consumer: &WorkspaceRecord,
    workspaces: &[WorkspaceRecord],
    grants: Vec<MemorySourceGrant>,
    last_access_at: F,
) -> Vec<MemorySourceGrantView>
where
    F: Fn(&MemorySourceGrant) -> Option<i64>,
{
    let mut linked = grants
        .into_iter()
        .map(|grant| {
            // The grant list is already owner+consumer scoped. Audit lookup remains
            // non-authoritative: unavailable/corrupt audit data never blocks listing.
            let last_used_at = last_access_at(&grant);
            let (source_label, source_available) =
                if grant.source_workspace_id.as_str() == PERSONAL_WORKSPACE {
                    ("Personal".to_string(), true)
                } else if let Some(workspace) = workspaces
                    .iter()
                    .find(|workspace| workspace.id == grant.source_workspace_id.as_str())
                {
                    (memory_source_workspace_label(workspace), true)
                } else {
                    (grant.source_workspace_id.as_str().to_string(), false)
                };
            MemorySourceGrantView {
                id: Some(grant.id),
                source_workspace_id: grant.source_workspace_id.as_str().to_string(),
                source_label,
                source_available,
                local: false,
                read_only: true,
                collections: grant.collections.into_iter().collect(),
                max_sensitivity: grant
                    .max_sensitivity
                    .min(MemoryDataSensitivity::Confidential),
                expires_at: grant.expires_at,
                revoked_at: grant.revoked_at,
                policy_version: grant.policy_version,
                last_used_at,
                overrides: {
                    let mut overrides = grant
                        .overrides
                        .into_iter()
                        .map(|(memory_ref, effect)| MemorySourceGrantOverrideView {
                            memory_ref: memory_ref.to_string(),
                            effect,
                        })
                        .collect::<Vec<_>>();
                    overrides.sort_by(|left, right| left.memory_ref.cmp(&right.memory_ref));
                    overrides
                },
            }
        })
        .collect::<Vec<_>>();
    linked.sort_by(|left, right| {
        left.revoked_at
            .is_some()
            .cmp(&right.revoked_at.is_some())
            .then_with(|| left.source_label.cmp(&right.source_label))
            .then_with(|| left.source_workspace_id.cmp(&right.source_workspace_id))
            .then_with(|| left.id.cmp(&right.id))
    });

    let mut views = Vec::with_capacity(linked.len() + 1);
    views.push(MemorySourceGrantView {
        id: None,
        source_workspace_id: consumer.id.clone(),
        source_label: memory_source_workspace_label(consumer),
        source_available: true,
        local: true,
        read_only: false,
        collections: all_memory_collections(),
        max_sensitivity: MemoryDataSensitivity::Confidential,
        expires_at: None,
        revoked_at: None,
        policy_version: 0,
        last_used_at: None,
        overrides: Vec::new(),
    });
    views.extend(linked);
    views
}

pub(crate) fn memory_source_candidates_from_records(
    records: &[MemorySourceCandidateProjection],
) -> Vec<MemorySourceCandidateView> {
    records
        .iter()
        .filter(|record| {
            record.sensitivity != MemoryDataSensitivity::Secret
                && !contains_secret(&serde_json::json!({
                    "text": &record.text,
                    "metadata": &record.metadata,
                }))
        })
        .filter_map(|record| {
            let collection = all_memory_collections().into_iter().find(|collection| {
                collection.matches_candidate(&record.memory_type, &record.metadata)
            })?;
            let normalized = redact_memory_text(&record.text)
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            Some(MemorySourceCandidateView {
                reference: record.reference.to_string(),
                summary: truncate_chars(&normalized, 180),
                memory_type: record.memory_type.clone(),
                collection,
                sensitivity: record.sensitivity,
            })
        })
        .collect()
}

pub(crate) fn build_memory_source_grant(
    owner: &MemoryUserId,
    consumer_workspace: &MemoryWorkspaceId,
    validated: ValidatedMemorySourceInput,
    overrides: HashMap<MemoryRef, MemoryGrantOverrideEffect>,
    existing: Option<MemorySourceGrant>,
    now: i64,
) -> Result<MemorySourceGrant, &'static str> {
    let timestamp = format!("unix:{now}.000000000");
    if let Some(existing) = existing {
        return Ok(MemorySourceGrant {
            id: existing.id,
            consumer_user_id: existing.consumer_user_id,
            consumer_workspace_id: existing.consumer_workspace_id,
            source_user_id: existing.source_user_id,
            source_workspace_id: existing.source_workspace_id,
            collections: validated.collections,
            max_sensitivity: validated.max_sensitivity,
            overrides,
            expires_at: validated.expires_at,
            revoked_at: None,
            policy_version: existing
                .policy_version
                .checked_add(1)
                .ok_or("policy_version_overflow")?,
            created_by: existing.created_by,
            created_at: existing.created_at,
            updated_at: timestamp,
        });
    }
    Ok(MemorySourceGrant {
        id: uuid::Uuid::new_v4().to_string(),
        consumer_user_id: owner.clone(),
        consumer_workspace_id: consumer_workspace.clone(),
        source_user_id: owner.clone(),
        source_workspace_id: validated.source_workspace_id,
        collections: validated.collections,
        max_sensitivity: validated.max_sensitivity,
        overrides,
        expires_at: validated.expires_at,
        revoked_at: None,
        policy_version: 1,
        created_by: owner.as_str().to_string(),
        created_at: timestamp.clone(),
        updated_at: timestamp,
    })
}

pub(crate) fn validate_memory_source_overrides(
    facade: &MemoryFacade,
    owner: &MemoryUserId,
    validated: &ValidatedMemorySourceInput,
) -> Result<HashMap<MemoryRef, MemoryGrantOverrideEffect>, GatewayError> {
    let mut overrides = HashMap::with_capacity(validated.overrides.len());
    for (reference, effect) in &validated.overrides {
        if reference.user_id != *owner
            || reference.workspace_id != validated.source_workspace_id
            || reference.kind != MemoryRefKind::Memory
        {
            return Err(memory_source_bad_request("override_outside_source"));
        }
        let record = facade
            .get_memory_for_ui(reference, owner, &validated.source_workspace_id)
            .map_err(|_| GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "memory_source_store_error",
                message: "memory_source_store_error".to_string(),
            })?
            .ok_or_else(|| memory_source_bad_request("override_memory_not_found"))?;
        if matches!(
            record.status,
            MemoryStatus::Rejected | MemoryStatus::Deleted
        ) {
            return Err(memory_source_bad_request("override_memory_not_found"));
        }
        if record.sensitivity == MemoryDataSensitivity::Secret
            || contains_secret(&serde_json::json!({
                "text": &record.text,
                "metadata": &record.metadata,
            }))
        {
            return Err(memory_source_bad_request("override_memory_not_shareable"));
        }
        if *effect == MemoryGrantOverrideEffect::Allow
            && record.sensitivity > validated.max_sensitivity
        {
            return Err(memory_source_bad_request("override_above_max_sensitivity"));
        }
        if overrides.insert(reference.clone(), *effect).is_some() {
            return Err(memory_source_bad_request("duplicate_override_ref"));
        }
    }
    Ok(overrides)
}

/// Strict registry read used exclusively at the linked-memory authorization
/// boundary. Unlike the convenience loader above, this must never synthesize a
/// default workspace: absent, unreadable, malformed, or empty persistence
/// means no project source can be authorized for recall.
pub(crate) fn load_persisted_memory_source_workspace_ids() -> Option<HashSet<String>> {
    let path = gateway_workspaces_path().ok()?;
    let raw = fs::read_to_string(path).ok()?;
    let file = serde_json::from_str::<WorkspacesFile>(&raw).ok()?;
    (!file.workspaces.is_empty()).then(|| {
        file.workspaces
            .into_iter()
            .map(|workspace| workspace.id)
            .collect()
    })
}

pub(crate) async fn memory_sources_list(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<Vec<MemorySourceGrantView>>, GatewayError> {
    let snapshot = load_workspaces_file();
    let consumer = validate_memory_source_consumer(&snapshot, &workspace_id)
        .map_err(memory_source_bad_request)?;
    let grants = if memory_sources_enabled() {
        memory_facade(&state)
            .list_memory_source_grants(
                &gateway_memory_user_id(),
                &MemoryWorkspaceId::new(consumer.id.clone()),
            )
            .map_err(memory_source_facade_error)?
    } else {
        Vec::new()
    };
    let facade = memory_facade(&state);
    Ok(Json(memory_source_grant_views(
        &consumer,
        &snapshot.workspaces,
        grants,
        |grant| {
            facade
                .last_memory_source_access(&grant.id)
                .ok()
                .flatten()
                .map(|event| event.created_at)
        },
    )))
}

pub(crate) async fn memory_source_upsert(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    request: Request,
) -> Result<Json<Vec<MemorySourceGrantView>>, GatewayError> {
    if !memory_sources_enabled() {
        return Err(memory_source_disabled_error());
    }

    let body = axum::body::to_bytes(request.into_body(), 64 * 1024)
        .await
        .map_err(|_| memory_source_bad_request("memory_source_invalid_json"))?;
    let request = serde_json::from_slice::<MemorySourceUpsertRequest>(&body)
        .map_err(|_| memory_source_bad_request("memory_source_invalid_json"))?;

    let snapshot = load_workspaces_file();
    let validated =
        validate_memory_source_input(&workspace_id, &request).map_err(memory_source_bad_request)?;
    let source_context = validate_memory_source_workspaces(
        &snapshot,
        &workspace_id,
        validated.source_workspace_id.as_str(),
    )
    .map_err(memory_source_bad_request)?;
    if !source_context.source_available {
        return Err(memory_source_bad_request("source_workspace_not_found"));
    }
    let now = i64::try_from(now_epoch_secs()).unwrap_or(i64::MAX);
    if validated.expires_at.is_some_and(|expiry| expiry <= now) {
        return Err(memory_source_bad_request("expiry_not_future"));
    }

    let owner = gateway_memory_user_id();
    let consumer_workspace = MemoryWorkspaceId::new(source_context.consumer.id.clone());
    let facade = memory_facade(&state);
    let overrides = validate_memory_source_overrides(facade, &owner, &validated)?;

    let existing = facade
        .list_memory_source_grants(&owner, &consumer_workspace)
        .map_err(memory_source_facade_error)?
        .into_iter()
        .find(|grant| {
            grant.revoked_at.is_none()
                && grant.source_user_id == owner
                && grant.source_workspace_id == validated.source_workspace_id
        });
    let grant = build_memory_source_grant(
        &owner,
        &consumer_workspace,
        validated,
        overrides,
        existing,
        now,
    )
    .map_err(memory_source_bad_request)?;
    facade
        .upsert_memory_source_grant(&grant)
        .map_err(memory_source_facade_error)?;
    let grants = facade
        .list_memory_source_grants(&owner, &consumer_workspace)
        .map_err(memory_source_facade_error)?;
    Ok(Json(memory_source_grant_views(
        &source_context.consumer,
        &snapshot.workspaces,
        grants,
        |grant| {
            facade
                .last_memory_source_access(&grant.id)
                .ok()
                .flatten()
                .map(|event| event.created_at)
        },
    )))
}

pub(crate) async fn memory_source_revoke(
    State(state): State<AppState>,
    Path((workspace_id, grant_id)): Path<(String, String)>,
) -> Result<Json<Vec<MemorySourceGrantView>>, GatewayError> {
    if !memory_sources_enabled() {
        return Err(memory_source_disabled_error());
    }
    let snapshot = load_workspaces_file();
    let consumer = validate_memory_source_consumer(&snapshot, &workspace_id)
        .map_err(memory_source_bad_request)?;
    if grant_id.trim().is_empty() {
        return Err(memory_source_bad_request("empty_grant_id"));
    }
    let owner = gateway_memory_user_id();
    let consumer_workspace = MemoryWorkspaceId::new(consumer.id.clone());
    let facade = memory_facade(&state);
    facade
        .revoke_memory_source_grant(
            &owner,
            &consumer_workspace,
            &grant_id,
            i64::try_from(now_epoch_secs()).unwrap_or(i64::MAX),
        )
        .map_err(memory_source_facade_error)?;
    let grants = facade
        .list_memory_source_grants(&owner, &consumer_workspace)
        .map_err(memory_source_facade_error)?;
    Ok(Json(memory_source_grant_views(
        &consumer,
        &snapshot.workspaces,
        grants,
        |grant| {
            facade
                .last_memory_source_access(&grant.id)
                .ok()
                .flatten()
                .map(|event| event.created_at)
        },
    )))
}

pub(crate) async fn memory_source_candidates(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    RawQuery(raw_query): RawQuery,
) -> Result<Json<Vec<MemorySourceCandidateView>>, GatewayError> {
    if !memory_sources_enabled() {
        return Err(memory_source_disabled_error());
    }
    let raw_query =
        raw_query.ok_or_else(|| memory_source_bad_request("memory_source_query_invalid"))?;
    let uri = format!("/?{raw_query}")
        .parse::<axum::http::Uri>()
        .map_err(|_| memory_source_bad_request("memory_source_query_invalid"))?;
    let Query(query) = Query::<MemorySourceCandidatesQuery>::try_from_uri(&uri)
        .map_err(|_| memory_source_bad_request("memory_source_query_invalid"))?;
    let snapshot = load_workspaces_file();
    let source_context =
        validate_memory_source_workspaces(&snapshot, &workspace_id, &query.source_workspace_id)
            .map_err(memory_source_bad_request)?;
    let offset = query.offset.unwrap_or(0);
    let limit = query.limit.unwrap_or(50);
    if limit == 0 || limit > MEMORY_SOURCE_CANDIDATE_PAGE_MAX {
        return Err(memory_source_bad_request("memory_source_query_invalid"));
    }
    let owner = gateway_memory_user_id();
    let records = memory_facade(&state)
        .list_memory_source_candidates(&owner, &source_context.source_workspace_id, offset, limit)
        .map_err(|_| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "memory_source_store_error",
            message: "memory_source_store_error".to_string(),
        })?;
    Ok(Json(memory_source_candidates_from_records(&records)))
}
