//! Project access grants and effective contact-policy resolution.
//!
//! This owner keeps project-scoped contact authorization in one place. Channel
//! intake and automation routes consume the resolver here instead of carrying
//! their own grant interpretation.

use std::fs;

use axum::{Json, extract::Path, http::StatusCode};
use serde::{Deserialize, Serialize};

use crate::{GatewayError, chat_store, gateway_paths::gateway_project_access_path, now_epoch_secs};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct ProjectAccessGrant {
    pub(crate) workspace_id: String,
    pub(crate) contact_reference: String,
    #[serde(default)]
    pub(crate) contact_name: String,
    pub(crate) channel: String,
    #[serde(default)]
    pub(crate) can_trigger_automations: bool,
    #[serde(default)]
    pub(crate) can_use_project_memory: bool,
    #[serde(default)]
    pub(crate) can_receive_replies: bool,
    #[serde(default)]
    pub(crate) can_receive_artifacts: bool,
    #[serde(default)]
    pub(crate) capability_denies: Vec<String>,
    #[serde(default)]
    pub(crate) updated_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct ProjectAccessFile {
    #[serde(default)]
    pub(crate) grants: Vec<ProjectAccessGrant>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EffectiveProjectContactPolicy {
    pub(crate) authorized: bool,
    pub(crate) can_trigger_automations: bool,
    pub(crate) can_use_project_memory: bool,
    pub(crate) can_receive_replies: bool,
    pub(crate) can_receive_artifacts: bool,
    pub(crate) tools_denied: Vec<String>,
    pub(crate) denied_reason: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ProjectAccessUpsertRequest {
    contact_reference: String,
    #[serde(default)]
    contact_name: String,
    channel: String,
    #[serde(default)]
    can_trigger_automations: bool,
    #[serde(default)]
    can_use_project_memory: bool,
    #[serde(default)]
    can_receive_replies: bool,
    #[serde(default)]
    can_receive_artifacts: bool,
    #[serde(default)]
    capability_denies: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ProjectAccessRemoveRequest {
    contact_reference: String,
    channel: String,
}

pub(crate) fn normalize_project_access_grant(mut grant: ProjectAccessGrant) -> ProjectAccessGrant {
    grant.workspace_id = grant.workspace_id.trim().to_string();
    grant.contact_reference = grant.contact_reference.trim().to_string();
    grant.contact_name = grant.contact_name.trim().to_string();
    grant.channel = grant.channel.trim().to_ascii_lowercase();
    grant.capability_denies = grant
        .capability_denies
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect();
    grant.capability_denies.sort();
    grant.capability_denies.dedup();
    grant
}

pub(crate) fn load_project_access_file() -> ProjectAccessFile {
    gateway_project_access_path()
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<ProjectAccessFile>(&raw).ok())
        .unwrap_or_default()
}

fn save_project_access_file(file: &ProjectAccessFile) -> Result<(), std::io::Error> {
    let path = gateway_project_access_path()?;
    let body = serde_json::to_string_pretty(file).unwrap_or_else(|_| "{\"grants\":[]}".to_string());
    fs::write(path, body)
}

pub(crate) fn list_project_access(workspace_id: &str) -> Vec<ProjectAccessGrant> {
    let workspace_id = workspace_id.trim();
    load_project_access_file()
        .grants
        .into_iter()
        .filter(|grant| grant.workspace_id == workspace_id)
        .collect()
}

pub(crate) fn upsert_project_access(grant: ProjectAccessGrant) -> Result<(), std::io::Error> {
    let grant = normalize_project_access_grant(grant);
    let mut file = load_project_access_file();
    file.grants.retain(|existing| {
        !(existing.workspace_id == grant.workspace_id
            && existing.contact_reference == grant.contact_reference
            && existing.channel == grant.channel)
    });
    file.grants.push(grant);
    file.grants.sort_by(|a, b| {
        a.workspace_id
            .cmp(&b.workspace_id)
            .then(a.contact_name.cmp(&b.contact_name))
            .then(a.contact_reference.cmp(&b.contact_reference))
            .then(a.channel.cmp(&b.channel))
    });
    save_project_access_file(&file)
}

pub(crate) fn remove_project_access(
    workspace_id: &str,
    contact_reference: &str,
    channel: &str,
) -> Result<(), std::io::Error> {
    let workspace_id = workspace_id.trim();
    let contact_reference = contact_reference.trim();
    let channel = channel.trim().to_ascii_lowercase();
    let mut file = load_project_access_file();
    file.grants.retain(|existing| {
        !(existing.workspace_id == workspace_id
            && existing.contact_reference == contact_reference
            && existing.channel == channel)
    });
    save_project_access_file(&file)
}

pub(crate) fn resolve_project_contact_policy(
    workspace_id: &str,
    contact_reference: &str,
    channel: &str,
    perimeter: &chat_store::StoredPerimeter,
    is_self_contact: bool,
) -> EffectiveProjectContactPolicy {
    if is_self_contact {
        return EffectiveProjectContactPolicy {
            authorized: true,
            can_trigger_automations: true,
            can_use_project_memory: true,
            can_receive_replies: true,
            can_receive_artifacts: true,
            tools_denied: Vec::new(),
            denied_reason: String::new(),
        };
    }

    let contact_reference = contact_reference.trim();
    let channel = channel.trim().to_ascii_lowercase();
    let grant = list_project_access(workspace_id)
        .into_iter()
        .find(|grant| grant.contact_reference == contact_reference && grant.channel == channel);
    let Some(grant) = grant else {
        return EffectiveProjectContactPolicy {
            authorized: false,
            can_trigger_automations: false,
            can_use_project_memory: false,
            can_receive_replies: false,
            can_receive_artifacts: false,
            tools_denied: perimeter.tools_denied.clone(),
            denied_reason: "contact/channel is not authorized for this project".to_string(),
        };
    };
    let mut tools_denied = perimeter.tools_denied.clone();
    tools_denied.extend(grant.capability_denies.clone());
    tools_denied.sort();
    tools_denied.dedup();
    EffectiveProjectContactPolicy {
        authorized: true,
        can_trigger_automations: grant.can_trigger_automations,
        can_use_project_memory: grant.can_use_project_memory,
        can_receive_replies: grant.can_receive_replies,
        can_receive_artifacts: grant.can_receive_artifacts,
        tools_denied,
        denied_reason: String::new(),
    }
}

pub(crate) async fn project_access_list(
    Path(workspace_id): Path<String>,
) -> Result<Json<Vec<ProjectAccessGrant>>, GatewayError> {
    Ok(Json(list_project_access(&workspace_id)))
}

pub(crate) async fn project_access_upsert(
    Path(workspace_id): Path<String>,
    Json(request): Json<ProjectAccessUpsertRequest>,
) -> Result<Json<Vec<ProjectAccessGrant>>, GatewayError> {
    if request.contact_reference.trim().is_empty() || request.channel.trim().is_empty() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "project_access_invalid",
            message: "contact_reference and channel are required".to_string(),
        });
    }
    upsert_project_access(ProjectAccessGrant {
        workspace_id: workspace_id.clone(),
        contact_reference: request.contact_reference,
        contact_name: request.contact_name,
        channel: request.channel,
        can_trigger_automations: request.can_trigger_automations,
        can_use_project_memory: request.can_use_project_memory,
        can_receive_replies: request.can_receive_replies,
        can_receive_artifacts: request.can_receive_artifacts,
        capability_denies: request.capability_denies,
        updated_at: now_epoch_secs() as i64,
    })
    .map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "project_access_write_failed",
        message: error.to_string(),
    })?;
    Ok(Json(list_project_access(&workspace_id)))
}

pub(crate) async fn project_access_remove(
    Path(workspace_id): Path<String>,
    Json(request): Json<ProjectAccessRemoveRequest>,
) -> Result<Json<Vec<ProjectAccessGrant>>, GatewayError> {
    remove_project_access(&workspace_id, &request.contact_reference, &request.channel).map_err(
        |error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "project_access_write_failed",
            message: error.to_string(),
        },
    )?;
    Ok(Json(list_project_access(&workspace_id)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_access_owner_normalizes_grant_keys() {
        let grant = normalize_project_access_grant(ProjectAccessGrant {
            workspace_id: " workspace ".to_string(),
            contact_reference: " contact ".to_string(),
            contact_name: " Contact Name ".to_string(),
            channel: " Email ".to_string(),
            can_trigger_automations: true,
            can_use_project_memory: true,
            can_receive_replies: true,
            can_receive_artifacts: true,
            capability_denies: vec![
                " browser ".to_string(),
                String::new(),
                "browser".to_string(),
                " shell ".to_string(),
            ],
            updated_at: 42,
        });

        assert_eq!(grant.workspace_id, "workspace");
        assert_eq!(grant.contact_reference, "contact");
        assert_eq!(grant.contact_name, "Contact Name");
        assert_eq!(grant.channel, "email");
        assert_eq!(grant.capability_denies, vec!["browser", "shell"]);
    }
}
