//! MemoryBench HTTP adapter.
//!
//! Owns the opt-in `/api/memory/bench/*` endpoints, benchmark workspace
//! materialization, governed session ingest, status checks, and search result
//! projection. General memory dashboard/export routes and workspace registry
//! semantics remain outside this owner.

use std::fs;

use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use local_first_memory::{
    DataSensitivity as MemoryDataSensitivity, MemoryAccessRequest, MemoryEvolutionKind,
    MemoryEvolutionMetadata, MemoryEvolutionProposal, MemoryRecord, MemoryRef, MemoryRefKind,
    MemorySearchRequest, MemoryStatus, PrivacyDomain, WorkspaceId as MemoryWorkspaceId,
    contains_secret,
};

use crate::{
    AppState, GatewayError, WorkspaceRecord, gateway_memory_user_id,
    gateway_paths::gateway_data_dir, load_workspaces_file, memory_facade, save_workspaces_file,
};

const MEMORYBENCH_MAX_SESSIONS: usize = 2_000;
const MEMORYBENCH_MAX_MESSAGES: usize = 10_000;
const MEMORYBENCH_MAX_CONTENT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub(crate) struct MemoryBenchMessage {
    pub(crate) role: String,
    pub(crate) content: String,
    #[serde(default)]
    pub(crate) timestamp: Option<String>,
    #[serde(default)]
    pub(crate) speaker: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryBenchSession {
    pub(crate) session_id: String,
    pub(crate) messages: Vec<MemoryBenchMessage>,
    #[serde(default)]
    pub(crate) metadata: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub(crate) struct MemoryBenchIngestRequest {
    pub(crate) container_tag: String,
    pub(crate) sessions: Vec<MemoryBenchSession>,
    #[serde(default)]
    pub(crate) metadata: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub(crate) struct MemoryBenchIngestResponse {
    pub(crate) workspace_id: String,
    pub(crate) document_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct MemoryBenchStatusRequest {
    pub(crate) container_tag: String,
    pub(crate) document_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct MemoryBenchStatusResponse {
    pub(crate) completed_ids: Vec<String>,
    pub(crate) failed_ids: Vec<String>,
    pub(crate) total: usize,
    pub(crate) pending: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct MemoryBenchSearchRequest {
    pub(crate) container_tag: String,
    pub(crate) workspace_id: String,
    pub(crate) query: String,
    #[serde(default = "memorybench_default_limit")]
    pub(crate) limit: usize,
    #[serde(default)]
    pub(crate) threshold: f64,
}

#[derive(Debug, Serialize)]
struct MemoryBenchSearchResult {
    reference: String,
    summary: String,
    score: f64,
    source_user_id: String,
    source_workspace_id: String,
    source_label: String,
    status: String,
    memory_type: String,
}

fn memorybench_default_limit() -> usize {
    30
}

fn memorybench_enabled() -> bool {
    std::env::var("HOMUN_MEMORYBENCH_ENABLED")
        .map(|value| matches!(value.trim(), "1" | "true" | "on" | "yes"))
        .unwrap_or(false)
}

fn memorybench_error(
    status: StatusCode,
    code: &'static str,
    message: impl Into<String>,
) -> GatewayError {
    GatewayError {
        status,
        code,
        message: message.into(),
    }
}

fn validate_memorybench_container_tag(value: &str) -> Result<&str, GatewayError> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    valid.then_some(value).ok_or_else(|| {
        memorybench_error(
            StatusCode::BAD_REQUEST,
            "memorybench_container_invalid",
            "invalid MemoryBench container tag",
        )
    })
}

pub(crate) fn memorybench_workspace_id(container_tag: &str) -> String {
    let digest = Sha256::digest(container_tag.as_bytes());
    format!("memorybench_{:x}", digest)[..44].to_string()
}

fn require_memorybench_enabled() -> Result<(), GatewayError> {
    memorybench_enabled().then_some(()).ok_or_else(|| {
        memorybench_error(
            StatusCode::NOT_FOUND,
            "memorybench_disabled",
            "MemoryBench endpoints are disabled",
        )
    })
}

fn ensure_memorybench_workspace(container_tag: &str) -> Result<String, GatewayError> {
    let workspace_id = memorybench_workspace_id(container_tag);
    let mut file = load_workspaces_file();
    if file
        .workspaces
        .iter()
        .any(|workspace| workspace.id == workspace_id)
    {
        return Ok(workspace_id);
    }
    let folder = gateway_data_dir()
        .map_err(|error| {
            memorybench_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "memorybench_workspace_failed",
                error.to_string(),
            )
        })?
        .join("memorybench")
        .join(&workspace_id);
    fs::create_dir_all(&folder).map_err(|error| {
        memorybench_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "memorybench_workspace_failed",
            error.to_string(),
        )
    })?;
    file.workspaces.push(WorkspaceRecord {
        id: workspace_id.clone(),
        name: format!("MemoryBench {container_tag}"),
        folder: Some(folder.to_string_lossy().to_string()),
        sandbox_mode: None,
        approval_policy: None,
        writable_roots: None,
        skill_confirmations: None,
    });
    save_workspaces_file(&file).map_err(|error| {
        memorybench_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "memorybench_workspace_failed",
            error.to_string(),
        )
    })?;
    Ok(workspace_id)
}

fn memorybench_session_text(session: &MemoryBenchSession) -> Result<String, GatewayError> {
    if session.messages.is_empty() {
        return Err(memorybench_error(
            StatusCode::BAD_REQUEST,
            "memorybench_session_invalid",
            "sessions require at least one message",
        ));
    }
    let mut lines = Vec::with_capacity(session.messages.len() + 1);
    if let Some(date) = session
        .metadata
        .get("formattedDate")
        .and_then(|value| value.as_str())
    {
        lines.push(format!("Session date: {date}"));
    }
    for message in &session.messages {
        if !matches!(message.role.as_str(), "user" | "assistant")
            || message.content.trim().is_empty()
        {
            return Err(memorybench_error(
                StatusCode::BAD_REQUEST,
                "memorybench_session_invalid",
                "sessions require non-empty user or assistant messages",
            ));
        }
        let timestamp = message
            .timestamp
            .as_deref()
            .map(|value| format!("[{value}] "))
            .unwrap_or_default();
        let speaker = message
            .speaker
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!(" ({value})"))
            .unwrap_or_default();
        lines.push(format!(
            "{timestamp}{}{speaker}: {}",
            message.role,
            message.content.trim()
        ));
    }
    Ok(lines.join("\n"))
}

pub(crate) async fn memory_bench_ingest(
    State(state): State<AppState>,
    Json(request): Json<MemoryBenchIngestRequest>,
) -> Result<Json<MemoryBenchIngestResponse>, GatewayError> {
    require_memorybench_enabled()?;
    let container_tag = validate_memorybench_container_tag(&request.container_tag)?;
    let message_count = request
        .sessions
        .iter()
        .map(|session| session.messages.len())
        .sum::<usize>();
    let content_bytes = request
        .sessions
        .iter()
        .flat_map(|session| session.messages.iter())
        .map(|message| message.content.len())
        .sum::<usize>();
    if request.sessions.len() > MEMORYBENCH_MAX_SESSIONS
        || message_count > MEMORYBENCH_MAX_MESSAGES
        || content_bytes > MEMORYBENCH_MAX_CONTENT_BYTES
    {
        return Err(memorybench_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "memorybench_payload_too_large",
            "MemoryBench ingest payload exceeds the local safety limit",
        ));
    }
    let mut prepared = Vec::with_capacity(request.sessions.len());
    for session in &request.sessions {
        if session.session_id.trim().is_empty() || session.session_id.len() > 256 {
            return Err(memorybench_error(
                StatusCode::BAD_REQUEST,
                "memorybench_session_invalid",
                "session id is required",
            ));
        }
        let text = memorybench_session_text(session)?;
        let identity = serde_json::json!({
            "container_tag": container_tag,
            "session_id": session.session_id,
            "messages": session.messages.iter().map(|message| serde_json::json!({
                "role": message.role,
                "content": message.content,
                "timestamp": message.timestamp,
                "speaker": message.speaker,
            })).collect::<Vec<_>>(),
            "session_metadata": session.metadata,
            "ingest_metadata": request.metadata,
        });
        if contains_secret(&serde_json::json!({ "text": text, "metadata": identity })) {
            return Err(memorybench_error(
                StatusCode::BAD_REQUEST,
                "memorybench_ingest_rejected",
                "secret-bearing benchmark content is not accepted by Memory",
            ));
        }
        let digest = Sha256::digest(
            serde_json::to_vec(&identity)
                .map_err(|error| {
                    memorybench_error(
                        StatusCode::BAD_REQUEST,
                        "memorybench_session_invalid",
                        error.to_string(),
                    )
                })?
                .as_slice(),
        );
        let digest = format!("{digest:x}");
        prepared.push((
            session.session_id.clone(),
            text,
            session.metadata.clone(),
            digest,
        ));
    }
    let workspace_id = ensure_memorybench_workspace(container_tag)?;
    let user = gateway_memory_user_id();
    let workspace = MemoryWorkspaceId::new(workspace_id.clone());
    let facade = memory_facade(&state);
    let mut document_ids = Vec::with_capacity(prepared.len());
    for (session_id, text, session_metadata, digest) in prepared {
        let reference = MemoryRef::new(
            MemoryRefKind::Memory,
            user.clone(),
            workspace.clone(),
            format!("session_{}", &digest[..32]),
        );
        let record = MemoryRecord {
            reference: reference.clone(),
            user_id: user.clone(),
            workspace_id: workspace.clone(),
            memory_type: "episode".to_string(),
            text,
            aliases: vec![session_id.clone()],
            language_hints: Vec::new(),
            confidence: 1.0,
            status: MemoryStatus::Confirmed,
            privacy_domain: PrivacyDomain::new("work"),
            sensitivity: MemoryDataSensitivity::Internal,
            metadata: serde_json::json!({
                "source": "memorybench",
                "container_tag": container_tag,
                "session_id": session_id,
                "session_metadata": session_metadata,
                "ingest_metadata": request.metadata,
            }),
            created_at: format!("memorybench:{}", &digest[..16]),
            updated_at: format!("memorybench:{}", &digest[..16]),
            last_seen_at: None,
            supersedes: Vec::new(),
            superseded_by: None,
            correction_of: None,
        };
        let result = facade
            .evolve_memory(MemoryEvolutionProposal {
                request_id: format!("memorybench-{digest}"),
                record,
                evolution: MemoryEvolutionMetadata {
                    kind: MemoryEvolutionKind::Independent,
                    target_refs: Vec::new(),
                    valid_from: None,
                    valid_until: None,
                    last_confirmed_at: None,
                    reinforcement_count: 1,
                    classifier: "memorybench-adapter".to_string(),
                    classifier_confidence: 1.0,
                },
            })
            .map_err(|error| {
                memorybench_error(
                    StatusCode::BAD_REQUEST,
                    "memorybench_ingest_rejected",
                    error.to_string(),
                )
            })?;
        document_ids.push(result.record.reference.to_string());
    }
    Ok(Json(MemoryBenchIngestResponse {
        workspace_id,
        document_ids,
    }))
}

pub(crate) async fn memory_bench_status(
    State(state): State<AppState>,
    Json(request): Json<MemoryBenchStatusRequest>,
) -> Result<Json<MemoryBenchStatusResponse>, GatewayError> {
    require_memorybench_enabled()?;
    let container_tag = validate_memorybench_container_tag(&request.container_tag)?;
    let workspace = MemoryWorkspaceId::new(memorybench_workspace_id(container_tag));
    let user = gateway_memory_user_id();
    let facade = memory_facade(&state);
    let mut completed_ids = Vec::new();
    let mut failed_ids = Vec::new();
    for value in &request.document_ids {
        let reference = value.parse::<MemoryRef>();
        let completed = reference.as_ref().ok().is_some_and(|reference| {
            reference.user_id == user
                && reference.workspace_id == workspace
                && facade
                    .get_memory_for_ui(reference, &user, &workspace)
                    .ok()
                    .flatten()
                    .is_some()
        });
        if completed {
            completed_ids.push(value.clone());
        } else {
            failed_ids.push(value.clone());
        }
    }
    Ok(Json(MemoryBenchStatusResponse {
        completed_ids,
        failed_ids,
        total: request.document_ids.len(),
        pending: false,
    }))
}

pub(crate) async fn memory_bench_search(
    State(state): State<AppState>,
    Json(request): Json<MemoryBenchSearchRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    require_memorybench_enabled()?;
    let container_tag = validate_memorybench_container_tag(&request.container_tag)?;
    let expected_workspace = memorybench_workspace_id(container_tag);
    if request.workspace_id != expected_workspace
        || request.query.trim().is_empty()
        || request.limit == 0
        || request.limit > 100
        || !request.threshold.is_finite()
        || !(0.0..=1.0).contains(&request.threshold)
    {
        return Err(memorybench_error(
            StatusCode::BAD_REQUEST,
            "memorybench_search_invalid",
            "invalid MemoryBench search request",
        ));
    }
    let user = gateway_memory_user_id();
    let workspace = MemoryWorkspaceId::new(expected_workspace.clone());
    let page = memory_facade(&state)
        .search_memories(MemorySearchRequest {
            access: MemoryAccessRequest {
                actor_id: "memorybench".to_string(),
                user_id: user.clone(),
                workspace_id: workspace,
                purpose: "memorybench_search".to_string(),
                allowed_domains: vec![PrivacyDomain::new("work")],
                max_sensitivity: MemoryDataSensitivity::Private,
                allow_raw_payload: false,
                allow_export: false,
                broad_query: false,
            },
            query: request.query,
            statuses: vec![MemoryStatus::Confirmed, MemoryStatus::Candidate],
            memory_types: Vec::new(),
            limit: request.limit,
            offset: 0,
        })
        .map_err(|error| {
            memorybench_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "memorybench_search_failed",
                error.to_string(),
            )
        })?;
    let results = page
        .items
        .into_iter()
        .filter_map(|item| {
            let score = 1.0 / item.rank.max(1) as f64;
            (score >= request.threshold).then(|| MemoryBenchSearchResult {
                reference: item.reference.to_string(),
                summary: item.summary,
                score,
                source_user_id: user.as_str().to_string(),
                source_workspace_id: expected_workspace.clone(),
                source_label: format!("MemoryBench {container_tag}"),
                status: format!("{:?}", item.status).to_lowercase(),
                memory_type: item.memory_type,
            })
        })
        .collect::<Vec<_>>();
    Ok(Json(serde_json::json!({ "results": results })))
}
