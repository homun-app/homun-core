//! Memory publication HTTP routes.
//!
//! Owns the gateway-facing proposal create/get/edit/approve/reject surface for
//! publishing local project memory into another owned scope. Memory source grant
//! management remains in the gateway root until its own owner slice.

use axum::{
    Json,
    extract::{Path, Request, State},
    http::StatusCode,
};
use serde::Deserialize;

use local_first_memory::{
    MemoryError, MemoryPublicationDestination, MemoryPublicationEditInput,
    MemoryPublicationProposal, MemoryPublicationResolution, MemoryPublicationResult, MemoryRef,
    MemoryRefKind, PERSONAL_WORKSPACE, UserId as MemoryUserId, WorkspaceId as MemoryWorkspaceId,
};

use crate::{
    AppState, GatewayError, THREADS_WORKSPACE, WorkspacesFile, canonical_memory_workspace_id,
    gateway_memory_user_id, load_workspaces_file, memory_facade,
};

const MEMORY_PUBLICATION_BODY_MAX: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
pub(crate) struct MemoryPublicationCreateRequest {
    source_ref: String,
    source_workspace_id: String,
    destination_workspace_id: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct MemoryPublicationApproveRequest {
    expected_version: u64,
    resolution: MemoryPublicationResolution,
}

#[derive(Debug, Deserialize)]
pub(crate) struct MemoryPublicationEditRequest {
    expected_version: u64,
    edit: MemoryPublicationEditInput,
}

#[derive(Debug, Deserialize)]
pub(crate) struct MemoryPublicationRejectRequest {
    expected_version: u64,
}

fn memory_publication_error(status: StatusCode, code: &'static str) -> GatewayError {
    GatewayError {
        status,
        code,
        message: code.to_string(),
    }
}

fn memory_publication_facade_error(error: MemoryError) -> GatewayError {
    let (status, code) = match error {
        MemoryError::NotFound(message) => match message.as_str() {
            "publication_not_found" => (StatusCode::NOT_FOUND, "publication_not_found"),
            "publication_source_not_found" => {
                (StatusCode::NOT_FOUND, "publication_source_not_found")
            }
            _ => (StatusCode::NOT_FOUND, "memory_publication_not_found"),
        },
        MemoryError::Policy(message) => match message.as_str() {
            "secret_never_shareable" => (StatusCode::CONFLICT, "secret_never_shareable"),
            "vault_payload_never_shareable" => {
                (StatusCode::CONFLICT, "vault_payload_never_shareable")
            }
            "publication_actor_mismatch" => (StatusCode::CONFLICT, "publication_actor_mismatch"),
            "publication_decision_required" => {
                (StatusCode::CONFLICT, "publication_decision_required")
            }
            "publication_source_changed" => (StatusCode::CONFLICT, "publication_source_changed"),
            "publication_preview_stale" => (StatusCode::CONFLICT, "publication_preview_stale"),
            "linked_memory_read_only" => (StatusCode::CONFLICT, "linked_memory_read_only"),
            "publication_conflict"
            | "publication_already_pending"
            | "publication_not_pending"
            | "publication_already_published"
            | "publication_source_inactive"
            | "publication_sensitivity_not_allowed" => {
                (StatusCode::CONFLICT, "publication_conflict")
            }
            _ => (StatusCode::CONFLICT, "publication_conflict"),
        },
        MemoryError::Validation(message) => match message.as_str() {
            "publication_text_invalid"
            | "publication_memory_type_invalid"
            | "publication_privacy_domain_invalid"
            | "publication_collection_unknown" => {
                (StatusCode::BAD_REQUEST, "publication_edit_invalid")
            }
            _ => (StatusCode::BAD_REQUEST, "memory_publication_invalid"),
        },
        MemoryError::Store(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "memory_publication_store_error",
        ),
    };
    memory_publication_error(status, code)
}

fn publication_workspace_from_snapshot(
    snapshot: &WorkspacesFile,
    raw_workspace_id: &str,
    allow_personal: bool,
) -> Result<MemoryWorkspaceId, &'static str> {
    let raw_workspace_id = raw_workspace_id.trim();
    let workspace_id = canonical_memory_workspace_id(raw_workspace_id);
    if workspace_id.as_str().is_empty() {
        return Err("publication_workspace_invalid");
    }
    if workspace_id.as_str() == THREADS_WORKSPACE {
        return Err("publication_workspace_invalid");
    }
    if workspace_id.as_str() == PERSONAL_WORKSPACE {
        return allow_personal
            .then_some(workspace_id)
            .ok_or("publication_source_not_local");
    }
    snapshot
        .workspaces
        .iter()
        .any(|workspace| workspace.id == raw_workspace_id)
        .then_some(workspace_id)
        .ok_or("publication_workspace_not_found")
}

fn validate_publication_owner_scope(
    proposal: &MemoryPublicationProposal,
    owner: &MemoryUserId,
    snapshot: &WorkspacesFile,
) -> Result<(), GatewayError> {
    if proposal.proposed_by != owner.as_str()
        || proposal.source_user_id != *owner
        || proposal.destination_user_id != *owner
    {
        return Err(memory_publication_error(
            StatusCode::CONFLICT,
            "publication_actor_mismatch",
        ));
    }
    publication_workspace_from_snapshot(snapshot, proposal.source_workspace_id.as_str(), false)
        .map_err(|code| memory_publication_error(StatusCode::NOT_FOUND, code))?;
    publication_workspace_from_snapshot(snapshot, proposal.destination_workspace_id.as_str(), true)
        .map_err(|code| memory_publication_error(StatusCode::NOT_FOUND, code))?;
    Ok(())
}

fn parse_publication_reference(
    raw_reference: &str,
    owner: &MemoryUserId,
    source_workspace_id: &MemoryWorkspaceId,
) -> Result<MemoryRef, GatewayError> {
    if raw_reference.trim() != raw_reference {
        return Err(memory_publication_error(
            StatusCode::BAD_REQUEST,
            "memory_publication_invalid",
        ));
    }
    let reference = raw_reference.parse::<MemoryRef>().map_err(|_| {
        memory_publication_error(StatusCode::BAD_REQUEST, "memory_publication_invalid")
    })?;
    if reference.to_string() != raw_reference
        || reference.kind != MemoryRefKind::Memory
        || reference.scope != "local"
        || reference.user_id != *owner
        || reference.workspace_id != *source_workspace_id
    {
        return Err(memory_publication_error(
            StatusCode::BAD_REQUEST,
            "memory_publication_invalid",
        ));
    }
    Ok(reference)
}

pub(crate) async fn memory_publication_create(
    State(state): State<AppState>,
    request: Request,
) -> Result<Json<MemoryPublicationProposal>, GatewayError> {
    let body = axum::body::to_bytes(request.into_body(), MEMORY_PUBLICATION_BODY_MAX)
        .await
        .map_err(|_| {
            memory_publication_error(StatusCode::BAD_REQUEST, "memory_publication_invalid")
        })?;
    let request =
        serde_json::from_slice::<MemoryPublicationCreateRequest>(&body).map_err(|_| {
            memory_publication_error(StatusCode::BAD_REQUEST, "memory_publication_invalid")
        })?;
    let snapshot = load_workspaces_file();
    let source_workspace_id =
        publication_workspace_from_snapshot(&snapshot, &request.source_workspace_id, false)
            .map_err(|code| memory_publication_error(StatusCode::BAD_REQUEST, code))?;
    let destination_workspace_id =
        publication_workspace_from_snapshot(&snapshot, &request.destination_workspace_id, true)
            .map_err(|code| memory_publication_error(StatusCode::BAD_REQUEST, code))?;
    let owner = gateway_memory_user_id();
    let reference = parse_publication_reference(&request.source_ref, &owner, &source_workspace_id)?;
    let facade = memory_facade(&state);
    if facade
        .has_memory_source_grant_link(&owner, &destination_workspace_id, &source_workspace_id)
        .map_err(|_| {
            memory_publication_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "memory_publication_store_error",
            )
        })?
    {
        return Err(memory_publication_error(
            StatusCode::CONFLICT,
            "linked_memory_read_only",
        ));
    }
    let source = facade
        .get_memory_for_ui(&reference, &owner, &source_workspace_id)
        .map_err(|_| {
            memory_publication_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "memory_publication_store_error",
            )
        })?
        .ok_or_else(|| {
            memory_publication_error(StatusCode::NOT_FOUND, "publication_source_not_found")
        })?;
    let proposal = facade
        .create_publication_proposal(
            &source,
            &MemoryPublicationDestination::new(owner.clone(), destination_workspace_id),
            owner.as_str(),
        )
        .map_err(memory_publication_facade_error)?;
    Ok(Json(proposal))
}

pub(crate) async fn memory_publication_get(
    State(state): State<AppState>,
    Path(proposal_id): Path<String>,
) -> Result<Json<MemoryPublicationProposal>, GatewayError> {
    let owner = gateway_memory_user_id();
    let proposal = memory_facade(&state)
        .get_publication_proposal(&proposal_id)
        .map_err(memory_publication_facade_error)?
        .ok_or_else(|| memory_publication_error(StatusCode::NOT_FOUND, "publication_not_found"))?;
    validate_publication_owner_scope(&proposal, &owner, &load_workspaces_file())?;
    Ok(Json(proposal))
}

pub(crate) async fn memory_publication_edit(
    State(state): State<AppState>,
    Path(proposal_id): Path<String>,
    request: Request,
) -> Result<Json<MemoryPublicationProposal>, GatewayError> {
    let body = axum::body::to_bytes(request.into_body(), MEMORY_PUBLICATION_BODY_MAX)
        .await
        .map_err(|_| {
            memory_publication_error(StatusCode::BAD_REQUEST, "memory_publication_invalid")
        })?;
    let request = serde_json::from_slice::<MemoryPublicationEditRequest>(&body).map_err(|_| {
        memory_publication_error(StatusCode::BAD_REQUEST, "memory_publication_invalid")
    })?;
    let owner = gateway_memory_user_id();
    let facade = memory_facade(&state);
    let proposal = facade
        .get_publication_proposal(&proposal_id)
        .map_err(memory_publication_facade_error)?
        .ok_or_else(|| memory_publication_error(StatusCode::NOT_FOUND, "publication_not_found"))?;
    validate_publication_owner_scope(&proposal, &owner, &load_workspaces_file())?;
    let updated = facade
        .update_publication_proposal_at_version(
            &proposal_id,
            owner.as_str(),
            request.expected_version,
            &request.edit,
        )
        .map_err(memory_publication_facade_error)?;
    Ok(Json(updated))
}

pub(crate) async fn memory_publication_approve(
    State(state): State<AppState>,
    Path(proposal_id): Path<String>,
    request: Request,
) -> Result<Json<MemoryPublicationResult>, GatewayError> {
    let body = axum::body::to_bytes(request.into_body(), MEMORY_PUBLICATION_BODY_MAX)
        .await
        .map_err(|_| {
            memory_publication_error(StatusCode::BAD_REQUEST, "memory_publication_invalid")
        })?;
    let request =
        serde_json::from_slice::<MemoryPublicationApproveRequest>(&body).map_err(|_| {
            memory_publication_error(StatusCode::BAD_REQUEST, "memory_publication_invalid")
        })?;
    let owner = gateway_memory_user_id();
    let facade = memory_facade(&state);
    let proposal = facade
        .get_publication_proposal(&proposal_id)
        .map_err(memory_publication_facade_error)?
        .ok_or_else(|| memory_publication_error(StatusCode::NOT_FOUND, "publication_not_found"))?;
    validate_publication_owner_scope(&proposal, &owner, &load_workspaces_file())?;
    let resolved = facade
        .set_publication_resolution_at_version(
            &proposal_id,
            owner.as_str(),
            request.expected_version,
            request.resolution,
        )
        .map_err(memory_publication_facade_error)?;
    let result = facade
        .approve_publication_at_version(&proposal_id, owner.as_str(), resolved.proposal_version)
        .map_err(memory_publication_facade_error)?;
    Ok(Json(result))
}

pub(crate) async fn memory_publication_reject(
    State(state): State<AppState>,
    Path(proposal_id): Path<String>,
    request: Request,
) -> Result<Json<MemoryPublicationProposal>, GatewayError> {
    let body = axum::body::to_bytes(request.into_body(), MEMORY_PUBLICATION_BODY_MAX)
        .await
        .map_err(|_| {
            memory_publication_error(StatusCode::BAD_REQUEST, "memory_publication_invalid")
        })?;
    let request =
        serde_json::from_slice::<MemoryPublicationRejectRequest>(&body).map_err(|_| {
            memory_publication_error(StatusCode::BAD_REQUEST, "memory_publication_invalid")
        })?;
    let owner = gateway_memory_user_id();
    let facade = memory_facade(&state);
    let proposal = facade
        .get_publication_proposal(&proposal_id)
        .map_err(memory_publication_facade_error)?
        .ok_or_else(|| memory_publication_error(StatusCode::NOT_FOUND, "publication_not_found"))?;
    validate_publication_owner_scope(&proposal, &owner, &load_workspaces_file())?;
    let rejected = facade
        .reject_publication_at_version(&proposal_id, owner.as_str(), request.expected_version)
        .map_err(memory_publication_facade_error)?;
    Ok(Json(rejected))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_publications_owner_rejects_invalid_publication_refs() {
        let owner = MemoryUserId::new("owner");
        let workspace = MemoryWorkspaceId::new("project-a");

        assert!(parse_publication_reference(" memory:bad ", &owner, &workspace).is_err());
        assert!(parse_publication_reference("not-a-ref", &owner, &workspace).is_err());
    }
}
