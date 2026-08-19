use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use local_first_engine::markers::{VAULT_REVEAL_CLOSE, VAULT_REVEAL_OPEN};
use local_first_secrets::{SecretMaterial, SecretRef};
use local_first_vault::{
    LocalPinVerifier, PaymentApprovalSnapshot, SQLiteVaultStore, VaultCategory, VaultRecord,
    VaultRecordId, VaultStore,
};
use serde::{Deserialize, Serialize};

use crate::{
    AppState, ChatStore, GatewayError, PaymentApprovalGrant, active_workspace_id,
    confirm_marker_value, gateway_user_id, lock_payment_approvals, lock_store, lock_vault_store,
    privacy_guard,
};

pub(crate) const PAYMENT_APPROVAL_OPEN: &str = "‹‹PAYMENT_APPROVAL››";
pub(crate) const PAYMENT_APPROVAL_CLOSE: &str = "‹‹/PAYMENT_APPROVAL››";
pub(crate) const PAYMENT_APPROVAL_TTL_SECONDS: u64 = 300;

#[cfg(test)]
pub(crate) fn payment_approval_marker(snapshot: &PaymentApprovalSnapshot) -> String {
    let marker = serde_json::json!({ "snapshot": snapshot });
    format!("{PAYMENT_APPROVAL_OPEN}{marker}{PAYMENT_APPROVAL_CLOSE}")
}

#[derive(Debug, Deserialize)]
pub(crate) struct VaultProposalActionRequest {
    pub(crate) category: String,
    pub(crate) label: String,
    pub(crate) redacted_preview: String,
    #[serde(default)]
    pub(crate) secret_value: Option<String>,
    #[serde(default)]
    pub(crate) pending_id: Option<String>,
    #[serde(default)]
    pub(crate) pin: Option<String>,
    #[serde(default)]
    pub(crate) thread_id: Option<String>,
    #[serde(default)]
    pub(crate) message_id: Option<String>,
    /// How to resolve a dedup conflict surfaced by a prior accept:
    /// "add" (create anyway), "update" (overwrite `record_id`), "ignore" (discard).
    /// Absent on the first attempt → the server runs dedup and may return a conflict.
    #[serde(default)]
    pub(crate) resolution: Option<String>,
    /// The existing record targeted by an "update"/"ignore" resolution.
    #[serde(default)]
    pub(crate) record_id: Option<String>,
}

/// Outcome of an accept. `status` drives the frontend:
/// - "created": a new record was stored (or overwritten via "update").
/// - "ignored": an identical (key+value) record already existed; nothing created.
/// - "conflict": a partial match needs the user to choose add/update/ignore.
#[derive(Debug, Serialize)]
pub(crate) struct VaultProposalAcceptResponse {
    pub(crate) ok: bool,
    pub(crate) status: String,
    pub(crate) record_id: String,
    pub(crate) category: String,
    pub(crate) label: String,
    pub(crate) redacted_preview: String,
    /// Set only when `status == "conflict"`: "key" (same category+field, different
    /// value) or "value" (same value, different key).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) match_type: Option<String>,
    /// The pre-existing record involved in an "ignored"/"conflict" outcome.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) existing: Option<VaultRecordSummary>,
}

#[derive(Debug, Serialize)]
pub(crate) struct VaultProposalDismissResponse {
    ok: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct VaultRecordSummary {
    pub(crate) id: String,
    pub(crate) category: String,
    pub(crate) label: String,
    pub(crate) redacted_preview: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct VaultRecordsListResponse {
    records: Vec<VaultRecordSummary>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct VaultRecordUpdateRequest {
    pub(crate) category: String,
    pub(crate) label: String,
    #[serde(default)]
    pub(crate) secret_value: Option<String>,
    #[serde(default)]
    pub(crate) pin: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct VaultRecordUpdateResponse {
    pub(crate) ok: bool,
    pub(crate) record: VaultRecordSummary,
}

#[derive(Debug, Deserialize)]
pub(crate) struct VaultRecordRevealRequest {
    pub(crate) pin: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct VaultRecordRevealResponse {
    pub(crate) ok: bool,
    pub(crate) record: VaultRecordSummary,
    pub(crate) secret_value: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct VaultRecordDeleteResponse {
    ok: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct VaultPinStatusResponse {
    configured: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct VaultPinSetupRequest {
    pub(crate) pin: String,
    #[serde(default)]
    pub(crate) current_pin: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct VaultPinSetupResponse {
    configured: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct VaultPinVerifyRequest {
    pin: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct VaultPinVerifyResponse {
    ok: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct VaultPaymentApprovalRequest {
    pub(crate) snapshot: PaymentApprovalSnapshot,
    pub(crate) pin: String,
    pub(crate) cvv: String,
    #[serde(default)]
    pub(crate) thread_id: Option<String>,
    #[serde(default)]
    pub(crate) message_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct VaultPaymentApprovalResponse {
    pub(crate) ok: bool,
    pub(crate) payment_approval_id: String,
    pub(crate) expires_in_seconds: u64,
}

pub(crate) async fn vault_proposal_accept(
    State(state): State<AppState>,
    Json(request): Json<VaultProposalActionRequest>,
) -> Result<Json<VaultProposalAcceptResponse>, GatewayError> {
    let wrap_key = *state.vault_wrap_key;
    let vault_store = lock_vault_store(&state)?;
    accept_vault_proposal(
        &vault_store,
        Some(&state.pending_vault_proposals),
        &wrap_key,
        &request,
    )
    .map(Json)
}

pub(crate) async fn vault_proposal_dismiss(
    Json(_request): Json<VaultProposalActionRequest>,
) -> Result<Json<VaultProposalDismissResponse>, GatewayError> {
    Ok(Json(VaultProposalDismissResponse { ok: true }))
}

pub(crate) async fn vault_records_list(
    State(state): State<AppState>,
) -> Result<Json<VaultRecordsListResponse>, GatewayError> {
    let vault_store = lock_vault_store(&state)?;
    let records = vault_store
        .list()
        .map_err(vault_store_error)?
        .into_iter()
        .map(vault_record_summary)
        .collect();
    Ok(Json(VaultRecordsListResponse { records }))
}

pub(crate) async fn vault_record_delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<VaultRecordDeleteResponse>, GatewayError> {
    let record_id = VaultRecordId::new(id).map_err(invalid_vault_proposal)?;
    let vault_store = lock_vault_store(&state)?;
    vault_store.delete(&record_id).map_err(vault_store_error)?;
    Ok(Json(VaultRecordDeleteResponse { ok: true }))
}

pub(crate) async fn vault_record_update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(request): Json<VaultRecordUpdateRequest>,
) -> Result<Json<VaultRecordUpdateResponse>, GatewayError> {
    let record_id = VaultRecordId::new(id).map_err(invalid_vault_proposal)?;
    let wrap_key = *state.vault_wrap_key;
    let vault_store = lock_vault_store(&state)?;
    update_vault_record(&vault_store, &wrap_key, &record_id, &request).map(Json)
}

pub(crate) async fn vault_record_reveal(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(request): Json<VaultRecordRevealRequest>,
) -> Result<Json<VaultRecordRevealResponse>, GatewayError> {
    let record_id = VaultRecordId::new(id).map_err(invalid_vault_proposal)?;
    let wrap_key = *state.vault_wrap_key;
    let vault_store = lock_vault_store(&state)?;
    reveal_vault_record_secret(
        &vault_store,
        Some(&state.pending_vault_proposals),
        &wrap_key,
        &record_id,
        &request,
    )
    .map(Json)
}

pub(crate) async fn vault_pin_status(
    State(state): State<AppState>,
) -> Result<Json<VaultPinStatusResponse>, GatewayError> {
    let configured = lock_vault_store(&state)?
        .local_pin_verifier()
        .map_err(vault_store_error)?
        .is_some();
    Ok(Json(VaultPinStatusResponse { configured }))
}

pub(crate) async fn vault_pin_setup(
    State(state): State<AppState>,
    Json(request): Json<VaultPinSetupRequest>,
) -> Result<Json<VaultPinSetupResponse>, GatewayError> {
    let wrap_key = *state.vault_wrap_key;
    let vault_store = lock_vault_store(&state)?;
    apply_vault_pin_setup(&vault_store, &wrap_key, &request)?;
    Ok(Json(VaultPinSetupResponse { configured: true }))
}

pub(crate) fn apply_vault_pin_setup(
    vault_store: &SQLiteVaultStore,
    wrap_key: &[u8; 32],
    request: &VaultPinSetupRequest,
) -> Result<(), GatewayError> {
    let existing = vault_store
        .local_pin_verifier()
        .map_err(vault_store_error)?;
    let new_verifier =
        local_pin_setup_verifier(existing.as_ref(), request).map_err(invalid_vault_pin)?;
    // New security model: the master key is wrapped by the system key, NOT the
    // PIN. The PIN verifier is a reveal-only human-authorization gate stored
    // separately. So setting/changing the PIN never re-wraps the master key; it
    // only (a) ensures a syskey-wrapped master key exists, and (b) migrates a
    // legacy PIN-wrapped key once, using the CURRENT PIN we just verified.
    match vault_store.keyring_algorithm().map_err(vault_store_error)? {
        None => {
            vault_store
                .ensure_local_master_key_system(wrap_key)
                .map_err(vault_store_error)?;
        }
        Some(algorithm) if algorithm == "xchacha20poly1305-syskey-v1" => {
            // Already system-wrapped and independent of the PIN — nothing to do.
        }
        Some(_legacy_pin_wrapped) => {
            // Migrate the wrapping (pin -> syskey) using the current PIN. On a
            // PIN change `existing`/`current_pin` are present and verified above;
            // if somehow absent we cannot unwrap, so surface a clear error.
            let existing = existing.as_ref().ok_or_else(|| {
                invalid_vault_pin("Current Vault PIN is required to migrate the vault".to_string())
            })?;
            let current_pin = request.current_pin.as_deref().ok_or_else(|| {
                invalid_vault_pin("Current Vault PIN is required to migrate the vault".to_string())
            })?;
            vault_store
                .migrate_pin_wrapped_master_key_to_system(existing, current_pin, wrap_key)
                .map_err(vault_store_error)?;
        }
    }
    vault_store
        .set_local_pin_verifier(new_verifier)
        .map_err(vault_store_error)?;
    Ok(())
}

pub(crate) async fn vault_pin_verify(
    State(state): State<AppState>,
    Json(request): Json<VaultPinVerifyRequest>,
) -> Result<Json<VaultPinVerifyResponse>, GatewayError> {
    let verifier = lock_vault_store(&state)?
        .local_pin_verifier()
        .map_err(vault_store_error)?;
    Ok(Json(VaultPinVerifyResponse {
        ok: local_pin_verify_result(verifier.as_ref(), &request.pin),
    }))
}

pub(crate) async fn vault_payment_approval_approve(
    State(state): State<AppState>,
    Json(request): Json<VaultPaymentApprovalRequest>,
) -> Result<Json<VaultPaymentApprovalResponse>, GatewayError> {
    let vault_store = lock_vault_store(&state)?;
    let chat_store = lock_store(&state)?;
    let mut approvals = lock_payment_approvals(&state)?;
    approve_payment_checkout_request(&vault_store, &chat_store, &mut approvals, request).map(Json)
}

pub(crate) fn vault_record_from_proposal(
    request: &VaultProposalActionRequest,
) -> Result<VaultRecord, String> {
    let category = vault_category_from_marker(&request.category)?;
    let record_id = VaultRecordId::new(format!("vault_{}", uuid::Uuid::new_v4().simple()))?;
    let user = gateway_user_id();
    let workspace = active_workspace_id();
    let secret_ref = SecretRef::new(
        user.as_str(),
        workspace.as_str(),
        "vault",
        record_id.as_str(),
    )
    .map_err(|error| error.to_string())?;
    let metadata = serde_json::json!({
        "redacted_preview": request.redacted_preview,
        "pending_id": request.pending_id,
        "source": "vault_propose",
        "thread_id": request.thread_id,
        "message_id": request.message_id,
    });
    VaultRecord::new(
        record_id,
        category,
        request.label.trim(),
        secret_ref,
        metadata,
    )
}

pub(crate) fn vault_record_summary(record: VaultRecord) -> VaultRecordSummary {
    let redacted_preview = record
        .metadata
        .get("redacted_preview")
        .and_then(|value| value.as_str())
        .unwrap_or("[VAULT:redacted]")
        .to_string();
    VaultRecordSummary {
        id: record.id.to_string(),
        category: vault_category_key(record.category).to_string(),
        label: record.label,
        redacted_preview,
    }
}

pub(crate) fn search_vault_records(
    vault_store: &SQLiteVaultStore,
    query: &str,
    limit: usize,
) -> Result<Vec<VaultRecordSummary>, GatewayError> {
    let terms = vault_metadata_terms(query);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let mut scored = vault_store
        .list()
        .map_err(vault_store_error)?
        .into_iter()
        .filter_map(|record| {
            let summary = vault_record_summary(record);
            let haystack = vault_metadata_haystack(&summary);
            let score = terms
                .iter()
                .filter(|term| {
                    haystack
                        .iter()
                        .any(|candidate| candidate.contains(term.as_str()))
                })
                .count();
            (score > 0).then_some((score, summary))
        })
        .collect::<Vec<_>>();
    scored.sort_by(|(left_score, left), (right_score, right)| {
        right_score
            .cmp(left_score)
            .then_with(|| left.label.cmp(&right.label))
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(scored
        .into_iter()
        .take(limit.max(1))
        .map(|(_, summary)| summary)
        .collect())
}

pub(crate) fn recall_memory_response_with_vault_fallback(
    vault_store: &SQLiteVaultStore,
    query: &str,
    lines: Vec<String>,
    in_project: bool,
    vault_value_requested: bool,
) -> String {
    let memory_block = if lines.is_empty() {
        format!("No memories relevant to «{query}».")
    } else if in_project {
        format!("Memories relevant to THIS project:\n{}", lines.join("\n"))
    } else {
        format!("Relevant memories from memory:\n{}", lines.join("\n"))
    };
    let should_check_vault = lines.is_empty()
        || vault_value_requested
        || (query_has_sensitive_vault_term(query) && memory_lines_mention_vault(&lines));
    if !should_check_vault {
        return memory_block;
    }
    let vault_matches = match search_vault_records(vault_store, query, 5) {
        Ok(records) => records,
        Err(_) => return memory_block,
    };
    if vault_matches.is_empty() {
        return memory_block;
    }
    let vault_lines = vault_matches
        .into_iter()
        .map(|record| {
            let metadata = format!(
                "- [{}] {} — {} ({})",
                record.category, record.label, record.redacted_preview, record.id
            );
            if vault_value_requested {
                format!(
                    "{metadata}\n  reveal_card: {}",
                    vault_reveal_marker(&record)
                )
            } else {
                metadata
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "{memory_block}\n\nVault records matching the request (redacted metadata only; do NOT reveal or guess the secret value). If the user asked to see the value, you MUST copy the reveal_card marker exactly on its own line in your final answer so the UI can ask for the local PIN and reveal it locally:\n{vault_lines}"
    )
}

fn query_has_sensitive_vault_term(query: &str) -> bool {
    vault_metadata_terms(query)
        .iter()
        .any(|term| vault_term_is_sensitive(term))
}

fn vault_term_is_sensitive(term: &str) -> bool {
    matches!(
        term,
        "codice"
            | "fiscale"
            | "fiscal"
            | "identity"
            | "targa"
            | "plate"
            | "license"
            | "vehicles"
            | "passaporto"
            | "passport"
            | "documento"
            | "carta"
            | "card"
            | "password"
            | "token"
            | "salute"
            | "health"
    )
}

fn memory_lines_mention_vault(lines: &[String]) -> bool {
    lines
        .iter()
        .any(|line| line.to_ascii_lowercase().contains("vault"))
}

fn vault_reveal_marker(record: &VaultRecordSummary) -> String {
    let payload = serde_json::json!({
        "record_id": record.id,
        "category": record.category,
        "label": record.label,
        "redacted_preview": record.redacted_preview,
    });
    format!("{VAULT_REVEAL_OPEN}{payload}{VAULT_REVEAL_CLOSE}")
}

fn vault_metadata_haystack(summary: &VaultRecordSummary) -> Vec<String> {
    [
        summary.id.as_str(),
        summary.category.as_str(),
        summary.label.as_str(),
        summary.redacted_preview.as_str(),
    ]
    .iter()
    .flat_map(|value| vault_metadata_terms(value))
    .collect()
}

pub(crate) fn vault_metadata_terms(text: &str) -> Vec<String> {
    let mut terms = text
        .split(|c: char| !c.is_alphanumeric())
        .map(|part| part.trim().to_ascii_lowercase())
        .filter(|part| part.len() >= 3)
        .collect::<Vec<_>>();
    if terms
        .iter()
        .any(|term| term == "codice" || term == "fiscale")
    {
        terms.push("fiscal".to_string());
        terms.push("identity".to_string());
    }
    if terms
        .iter()
        .any(|term| term == "targa" || term == "plate" || term == "auto")
    {
        terms.push("vehicles".to_string());
        terms.push("license".to_string());
    }
    terms.sort();
    terms.dedup();
    terms
}

fn load_vault_record(
    vault_store: &SQLiteVaultStore,
    record_id: &VaultRecordId,
) -> Result<VaultRecord, GatewayError> {
    vault_store
        .get(record_id)
        .map_err(vault_store_error)?
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "vault_record_not_found",
            message: "Vault record not found".to_string(),
        })
}

/// Obtain the vault master key via the system wrap key, with NO PIN — the path
/// the system uses to inject and dedup values autonomously. Handles the three
/// keyring states: fresh (create a syskey-wrapped key), already system-wrapped
/// (unlock), or legacy PIN-wrapped (migrate inline if a valid PIN rides along,
/// otherwise error asking the user to migrate via a reveal / PIN entry).
fn obtain_system_master_key(
    vault_store: &SQLiteVaultStore,
    wrap_key: &[u8; 32],
    pin: Option<&str>,
) -> Result<[u8; 32], GatewayError> {
    match vault_store.keyring_algorithm().map_err(vault_store_error)? {
        None => vault_store
            .ensure_local_master_key_system(wrap_key)
            .map_err(vault_store_error),
        Some(algorithm) if algorithm == "xchacha20poly1305-syskey-v1" => vault_store
            .unlock_local_master_key_system(wrap_key)
            .map_err(vault_store_error),
        Some(_legacy_pin_wrapped) => {
            let pin = pin
                .map(str::trim)
                .filter(|pin| !pin.is_empty())
                .ok_or_else(|| {
                    invalid_vault_pin(
                        "Vault must be migrated before autonomous use: reveal a record or \
                         re-enter your PIN once to enable it."
                            .to_string(),
                    )
                })?;
            let verifier = vault_store
                .local_pin_verifier()
                .map_err(vault_store_error)?
                .ok_or_else(|| invalid_vault_pin("Vault PIN is not configured".to_string()))?;
            if !verifier.verify(pin) {
                return Err(invalid_vault_pin("Invalid Vault PIN".to_string()));
            }
            vault_store
                .migrate_pin_wrapped_master_key_to_system(&verifier, pin, wrap_key)
                .map_err(vault_store_error)
        }
    }
}

/// Reveal-path master-key acquisition: the PIN has already been verified as human
/// authorization, so this just maps keyring state to the master key (creating a
/// fresh key or migrating a legacy PIN-wrapped one as needed) using that PIN.
fn obtain_or_migrate_master_key_with_pin(
    vault_store: &SQLiteVaultStore,
    wrap_key: &[u8; 32],
    verifier: &LocalPinVerifier,
    pin: &str,
) -> Result<[u8; 32], GatewayError> {
    match vault_store.keyring_algorithm().map_err(vault_store_error)? {
        None => vault_store
            .ensure_local_master_key_system(wrap_key)
            .map_err(vault_store_error),
        Some(algorithm) if algorithm == "xchacha20poly1305-syskey-v1" => vault_store
            .unlock_local_master_key_system(wrap_key)
            .map_err(vault_store_error),
        Some(_legacy_pin_wrapped) => vault_store
            .migrate_pin_wrapped_master_key_to_system(verifier, pin, wrap_key)
            .map_err(vault_store_error),
    }
}

pub(crate) fn reveal_vault_record_secret(
    vault_store: &SQLiteVaultStore,
    pending_store: Option<&privacy_guard::PendingVaultProposalStore>,
    wrap_key: &[u8; 32],
    record_id: &VaultRecordId,
    request: &VaultRecordRevealRequest,
) -> Result<VaultRecordRevealResponse, GatewayError> {
    let record = load_vault_record(vault_store, record_id)?;
    // The PIN is now a HUMAN-AUTHORIZATION gate for showing plaintext on screen —
    // it no longer cryptographically gates machine use. Verify it, then obtain the
    // master key via the system key (migrating a legacy PIN-wrapped vault now that
    // we hold a verified PIN).
    let verifier = vault_store
        .local_pin_verifier()
        .map_err(vault_store_error)?
        .ok_or_else(|| invalid_vault_pin("Vault PIN is not configured".to_string()))?;
    if !verifier.verify(&request.pin) {
        return Err(invalid_vault_pin("Invalid Vault PIN".to_string()));
    }
    let master_key =
        obtain_or_migrate_master_key_with_pin(vault_store, wrap_key, &verifier, &request.pin)?;
    let secret = match vault_store
        .get_secret_material(record_id, &master_key)
        .map_err(vault_store_error)?
    {
        Some(secret) => secret,
        None => materialize_pending_vault_secret(vault_store, pending_store, &record, &master_key)?,
    };
    let secret_value = secret
        .expose_utf8()
        .map_err(|error| vault_store_error(error.to_string()))?;
    Ok(VaultRecordRevealResponse {
        ok: true,
        record: vault_record_summary(record),
        secret_value,
    })
}

fn materialize_pending_vault_secret(
    vault_store: &SQLiteVaultStore,
    pending_store: Option<&privacy_guard::PendingVaultProposalStore>,
    record: &VaultRecord,
    master_key: &[u8; 32],
) -> Result<SecretMaterial, GatewayError> {
    let pending_id = record
        .metadata
        .get("pending_id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "vault_secret_not_found",
            message: "Vault secret material not found".to_string(),
        })?;
    let pending_store = pending_store.ok_or_else(|| GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "vault_pending_unavailable",
        message: "Pending Vault secret is no longer available".to_string(),
    })?;
    let pending = pending_store.get(pending_id).ok_or_else(|| GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "vault_pending_expired",
        message: "Pending Vault secret expired".to_string(),
    })?;
    // Same class of trap as resolve_incoming_vault_value: match on (category, label)
    // only. `redacted_preview` is cosmetic + model-generated, so a drift between the
    // record's stored marker and the pending's must not block materializing the
    // secret on reveal.
    if pending.category != vault_category_key(record.category) || pending.label != record.label {
        return Err(invalid_vault_proposal(
            "Pending Vault proposal does not match this record".to_string(),
        ));
    }
    let material = SecretMaterial::from_string(pending.secret_value.clone());
    vault_store
        .put_secret_material(&record.id, master_key, material.clone())
        .map_err(vault_store_error)?;
    let _ = pending_store.take(pending_id);
    Ok(material)
}

pub(crate) fn update_vault_record(
    vault_store: &SQLiteVaultStore,
    wrap_key: &[u8; 32],
    record_id: &VaultRecordId,
    request: &VaultRecordUpdateRequest,
) -> Result<VaultRecordUpdateResponse, GatewayError> {
    let existing = load_vault_record(vault_store, record_id)?;
    let label = request.label.trim();
    if label.is_empty() {
        return Err(invalid_vault_proposal(
            "Vault record label is required".to_string(),
        ));
    }
    let category = vault_category_from_marker(&request.category).map_err(invalid_vault_proposal)?;
    let updated = VaultRecord::new(
        existing.id,
        category,
        label,
        existing.secret_ref,
        existing.metadata,
    )
    .map_err(invalid_vault_proposal)?;
    let summary = vault_record_summary(updated.clone());
    vault_store.put(updated).map_err(vault_store_error)?;
    if let Some(secret_value) = request
        .secret_value
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        // Writing a value is a machine operation: obtain the master key via the
        // system key (no PIN). A legacy PIN-wrapped vault migrates inline using
        // the PIN the edit flow already collected to unlock the value.
        let master_key = obtain_system_master_key(vault_store, wrap_key, request.pin.as_deref())?;
        vault_store
            .put_secret_material(
                record_id,
                &master_key,
                SecretMaterial::from_string(secret_value.to_string()),
            )
            .map_err(vault_store_error)?;
    }
    Ok(VaultRecordUpdateResponse {
        ok: true,
        record: summary,
    })
}

/// Stable dedup identity for a record's label: trim, lowercase, and collapse
/// internal whitespace runs to a single space. The dedup key is `(category,
/// normalized_label)` — NEVER the `redacted_preview`. The preview is a
/// model-generated marker (`[VAULT:category:field…]`), so the SAME logical secret
/// proposed with a slightly different marker used to hash to a different key and
/// dodge dedup, creating a duplicate record. The label is the human-facing,
/// user-editable identity of the secret and is the correct dedup basis.
fn normalize_vault_label(label: &str) -> String {
    label
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

/// Dedup outcome for a save, comparing the incoming (category, field, value)
/// against every existing record.
enum VaultDedupOutcome {
    Create,
    /// Same key AND same value already stored → ignore (no new record).
    Ignore(VaultRecord),
    /// Partial match ("key" = same category+field, different value; "value" =
    /// same value under a different key) → the user must choose add/update/ignore.
    Conflict {
        match_type: &'static str,
        existing: VaultRecord,
    },
}

/// Compare an incoming save against existing records now that vault values are
/// system-readable. Value comparison decrypts each candidate's material with the
/// system master key. A key+value duplicate short-circuits to Ignore; otherwise
/// key-only wins over value-only for the surfaced conflict.
fn classify_vault_dedup(
    vault_store: &SQLiteVaultStore,
    master_key: &[u8; 32],
    category_key: &str,
    normalized_label: &str,
    incoming_value: Option<&str>,
) -> Result<VaultDedupOutcome, GatewayError> {
    let mut key_only: Option<VaultRecord> = None;
    let mut value_only: Option<VaultRecord> = None;
    for record in vault_store.list().map_err(vault_store_error)? {
        let record_category = vault_category_key(record.category);
        // Dedup identity is (category, normalized label) — stable and independent of
        // the model-generated preview marker (see `normalize_vault_label`).
        let record_label = normalize_vault_label(&record.label);
        let key_match = record_category == category_key && record_label == normalized_label;
        let value_match = match incoming_value {
            // A record we cannot decrypt (e.g. poisoned/foreign ciphertext) must
            // not block saves: treat it as "no value match" rather than erroring.
            Some(value) => {
                vault_store
                    .get_secret_material(&record.id, master_key)
                    .ok()
                    .flatten()
                    .and_then(|material| material.expose_utf8().ok())
                    .as_deref()
                    == Some(value)
            }
            None => false,
        };
        if key_match && value_match {
            return Ok(VaultDedupOutcome::Ignore(record));
        }
        if key_match && key_only.is_none() {
            key_only = Some(record.clone());
        }
        if value_match && value_only.is_none() {
            value_only = Some(record);
        }
    }
    if let Some(existing) = key_only {
        return Ok(VaultDedupOutcome::Conflict {
            match_type: "key",
            existing,
        });
    }
    if let Some(existing) = value_only {
        return Ok(VaultDedupOutcome::Conflict {
            match_type: "value",
            existing,
        });
    }
    Ok(VaultDedupOutcome::Create)
}

/// Resolve the plaintext value a save should store, plus (if it came from a
/// pending proposal) the pending id to consume once the save completes. A pending
/// proposal is validated against the card it claims to fulfil.
fn resolve_incoming_vault_value(
    pending_store: Option<&privacy_guard::PendingVaultProposalStore>,
    request: &VaultProposalActionRequest,
) -> Result<(Option<String>, Option<String>), GatewayError> {
    if let Some(value) = request
        .secret_value
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        return Ok((Some(value.to_string()), None));
    }
    let Some(pending_id) = request.pending_id.as_deref().filter(|id| !id.is_empty()) else {
        return Ok((None, None));
    };
    let pending_store = pending_store.ok_or_else(|| {
        invalid_vault_proposal("Pending Vault proposal store is unavailable".to_string())
    })?;
    let pending = pending_store.get(pending_id).ok_or_else(|| {
        invalid_vault_proposal("Pending Vault proposal expired or was already used".to_string())
    })?;
    // Match on (category, label) ONLY. `redacted_preview` is a cosmetic,
    // model-generated marker: a harmless drift between the pending's stored preview
    // and the request's must NOT block the save (it used to hard-error here).
    if pending.category != request.category || pending.label != request.label {
        return Err(invalid_vault_proposal(
            "Pending Vault proposal does not match this card".to_string(),
        ));
    }
    Ok((Some(pending.secret_value), Some(pending_id.to_string())))
}

fn vault_accept_response(
    status: &str,
    record_id: String,
    category: String,
    label: String,
    redacted_preview: String,
    match_type: Option<&str>,
    existing: Option<VaultRecordSummary>,
) -> VaultProposalAcceptResponse {
    VaultProposalAcceptResponse {
        ok: true,
        status: status.to_string(),
        record_id,
        category,
        label,
        redacted_preview,
        match_type: match_type.map(str::to_string),
        existing,
    }
}

fn ignored_accept_response(existing: VaultRecord) -> VaultProposalAcceptResponse {
    let summary = vault_record_summary(existing);
    vault_accept_response(
        "ignored",
        summary.id.clone(),
        summary.category.clone(),
        summary.label.clone(),
        summary.redacted_preview.clone(),
        None,
        Some(summary),
    )
}

/// Accept/save a vault proposal. Now that values are system-readable, this
/// obtains the master key via the system key (NO PIN), resolves any pending
/// value, dedups against existing records, and creates/ignores/conflicts or
/// applies an explicit add/update/ignore resolution. The pending proposal is
/// consumed on every terminal outcome (create/ignore/update) — closing the
/// idempotency gap that let the same proposal create identical duplicates — but
/// NOT on an unresolved conflict, whose resolving re-submit needs it again.
pub(crate) fn accept_vault_proposal(
    vault_store: &SQLiteVaultStore,
    pending_store: Option<&privacy_guard::PendingVaultProposalStore>,
    wrap_key: &[u8; 32],
    request: &VaultProposalActionRequest,
) -> Result<VaultProposalAcceptResponse, GatewayError> {
    let (incoming_value, pending_to_consume) =
        resolve_incoming_vault_value(pending_store, request)?;
    let master_key = obtain_system_master_key(vault_store, wrap_key, request.pin.as_deref())?;

    let consume_pending = |pending_to_consume: &Option<String>| {
        if let (Some(store), Some(pending_id)) = (pending_store, pending_to_consume.as_deref()) {
            let _ = store.take(pending_id);
        }
    };

    match request.resolution.as_deref().map(str::trim) {
        Some("update") => {
            let target = request
                .record_id
                .as_deref()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| {
                    invalid_vault_proposal(
                        "Update resolution requires the target record_id".to_string(),
                    )
                })?;
            let target_id = VaultRecordId::new(target).map_err(invalid_vault_proposal)?;
            let existing = load_vault_record(vault_store, &target_id)?;
            let value = incoming_value.as_deref().ok_or_else(|| {
                invalid_vault_proposal("Cannot update: no secret value provided".to_string())
            })?;
            vault_store
                .put_secret_material(
                    &existing.id,
                    &master_key,
                    SecretMaterial::from_string(value.to_string()),
                )
                .map_err(vault_store_error)?;
            consume_pending(&pending_to_consume);
            let summary = vault_record_summary(existing);
            return Ok(vault_accept_response(
                "created",
                summary.id.clone(),
                summary.category.clone(),
                summary.label.clone(),
                summary.redacted_preview.clone(),
                None,
                Some(summary),
            ));
        }
        Some("ignore") => {
            consume_pending(&pending_to_consume);
            let existing = match request.record_id.as_deref().filter(|id| !id.is_empty()) {
                Some(id) => {
                    let record_id = VaultRecordId::new(id).map_err(invalid_vault_proposal)?;
                    vault_store.get(&record_id).map_err(vault_store_error)?
                }
                None => None,
            };
            return Ok(match existing {
                Some(record) => ignored_accept_response(record),
                None => vault_accept_response(
                    "ignored",
                    request.record_id.clone().unwrap_or_default(),
                    request.category.clone(),
                    request.label.clone(),
                    request.redacted_preview.clone(),
                    None,
                    None,
                ),
            });
        }
        Some("add") => {
            // Force-create below, skipping dedup.
        }
        _ => {
            let category =
                vault_category_from_marker(&request.category).map_err(invalid_vault_proposal)?;
            let category_key = vault_category_key(category);
            let normalized_label = normalize_vault_label(&request.label);
            match classify_vault_dedup(
                vault_store,
                &master_key,
                category_key,
                &normalized_label,
                incoming_value.as_deref(),
            )? {
                VaultDedupOutcome::Ignore(existing) => {
                    consume_pending(&pending_to_consume);
                    return Ok(ignored_accept_response(existing));
                }
                VaultDedupOutcome::Conflict {
                    match_type,
                    existing,
                } => {
                    // Leave the pending intact: the user still has to resolve, and
                    // the resolving re-submit needs the pending value again.
                    let summary = vault_record_summary(existing);
                    return Ok(vault_accept_response(
                        "conflict",
                        summary.id.clone(),
                        summary.category.clone(),
                        summary.label.clone(),
                        summary.redacted_preview.clone(),
                        Some(match_type),
                        Some(summary),
                    ));
                }
                VaultDedupOutcome::Create => {}
            }
        }
    }

    let record = vault_record_from_proposal(request).map_err(invalid_vault_proposal)?;
    let response = vault_accept_response(
        "created",
        record.id.to_string(),
        request.category.clone(),
        request.label.clone(),
        request.redacted_preview.clone(),
        None,
        None,
    );
    // Atomic save: metadata + secret material in ONE transaction (both-or-neither),
    // replacing the prior non-atomic put_secret_material + put sequence that could
    // orphan secret material on a mid-save failure. Consume the pending only AFTER
    // the commit succeeds.
    let secret = incoming_value
        .as_deref()
        .map(|value| SecretMaterial::from_string(value.to_string()));
    vault_store
        .put_record_with_secret(&record, &master_key, secret)
        .map_err(vault_store_error)?;
    consume_pending(&pending_to_consume);
    Ok(response)
}

pub(crate) fn local_pin_verifier_from_request(
    request: &VaultPinSetupRequest,
) -> Result<LocalPinVerifier, String> {
    LocalPinVerifier::create(&request.pin)
}

pub(crate) fn local_pin_setup_verifier(
    existing: Option<&LocalPinVerifier>,
    request: &VaultPinSetupRequest,
) -> Result<LocalPinVerifier, String> {
    if let Some(existing) = existing {
        let Some(current_pin) = request.current_pin.as_deref() else {
            return Err("Current Vault PIN is required to change the PIN".to_string());
        };
        if !existing.verify(current_pin) {
            return Err("Invalid current Vault PIN".to_string());
        }
    }
    local_pin_verifier_from_request(request)
}

pub(crate) fn local_pin_verify_result(verifier: Option<&LocalPinVerifier>, pin: &str) -> bool {
    verifier.is_some_and(|verifier| verifier.verify(pin))
}

pub(crate) fn payment_approval_grant_from_request(
    request: &VaultPaymentApprovalRequest,
    verifier: &LocalPinVerifier,
) -> Result<PaymentApprovalGrant, GatewayError> {
    if !verifier.verify(&request.pin) {
        return Err(invalid_vault_pin("Invalid Vault PIN".to_string()));
    }
    validate_one_shot_cvv(&request.cvv).map_err(invalid_vault_pin)?;
    Ok(PaymentApprovalGrant {
        snapshot: request.snapshot.clone(),
        cvv_one_shot: Some(request.cvv.trim().to_string()),
        thread_id: request.thread_id.clone().unwrap_or_default(),
        consumed: false,
        expires_at: std::time::Instant::now()
            + std::time::Duration::from_secs(PAYMENT_APPROVAL_TTL_SECONDS),
    })
}

pub(crate) fn approve_payment_checkout_request(
    vault_store: &SQLiteVaultStore,
    chat_store: &ChatStore,
    approvals: &mut std::collections::HashMap<String, PaymentApprovalGrant>,
    request: VaultPaymentApprovalRequest,
) -> Result<VaultPaymentApprovalResponse, GatewayError> {
    let verifier = vault_store
        .local_pin_verifier()
        .map_err(vault_store_error)?
        .ok_or_else(|| invalid_vault_pin("Vault PIN is not configured".to_string()))?;
    let grant = payment_approval_grant_from_request(&request, &verifier)?;
    let approval_id = grant.snapshot.approval_id.clone();
    approvals.insert(approval_id.clone(), grant);
    if let (Some(thread_id), Some(message_id)) = (&request.thread_id, &request.message_id)
        && let Ok(Some(message)) = chat_store.message(thread_id, message_id)
        && payment_approval_marker_matches(&message.text, &request.snapshot)
    {
        let rewritten = rewrite_payment_approval_to_done(
            &message.text,
            &approval_id,
            PAYMENT_APPROVAL_TTL_SECONDS,
        );
        let _ = chat_store.set_message_text(thread_id, message_id, &rewritten);
    }
    Ok(VaultPaymentApprovalResponse {
        ok: true,
        payment_approval_id: approval_id,
        expires_in_seconds: PAYMENT_APPROVAL_TTL_SECONDS,
    })
}

pub(crate) fn validate_one_shot_cvv(cvv: &str) -> Result<(), String> {
    let cvv = cvv.trim();
    if (3..=4).contains(&cvv.len()) && cvv.chars().all(|char| char.is_ascii_digit()) {
        Ok(())
    } else {
        Err("CVV/CV2 must be 3-4 digits and is one-shot only".to_string())
    }
}

pub(crate) fn payment_approval_marker_matches(
    text: &str,
    snapshot: &PaymentApprovalSnapshot,
) -> bool {
    let Some(marker) = confirm_marker_value(text, PAYMENT_APPROVAL_OPEN, PAYMENT_APPROVAL_CLOSE)
    else {
        return false;
    };
    marker
        .get("snapshot")
        .and_then(|value| serde_json::from_value::<PaymentApprovalSnapshot>(value.clone()).ok())
        .is_some_and(|stored| stored == *snapshot)
}

pub(crate) fn rewrite_payment_approval_to_done(
    text: &str,
    payment_approval_id: &str,
    ttl_seconds: u64,
) -> String {
    let Some(open) = text.find(PAYMENT_APPROVAL_OPEN) else {
        return text.to_string();
    };
    let Some(close_rel) = text[open..].find(PAYMENT_APPROVAL_CLOSE) else {
        return text.to_string();
    };
    let close = open + close_rel + PAYMENT_APPROVAL_CLOSE.len();
    let mut out = text[..open].trim_end().to_string();
    let tail = text[close..].trim();
    if !tail.is_empty() {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(tail);
    }
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(&format!(
        "Pagamento autorizzato localmente. Per il click finale di pagamento usa payment_approval_id: {payment_approval_id}. L'autorizzazione scade tra {ttl_seconds}s. Il CVV e' one-shot e non e' stato salvato nel transcript."
    ));
    out
}

pub(crate) fn vault_category_from_marker(category: &str) -> Result<VaultCategory, String> {
    match category.trim().to_ascii_lowercase().as_str() {
        "payments" | "payment" => Ok(VaultCategory::Payments),
        "identity" => Ok(VaultCategory::Identity),
        "health" => Ok(VaultCategory::Health),
        "vehicles" | "vehicle" => Ok(VaultCategory::Vehicles),
        "credentials" | "credential" => Ok(VaultCategory::Credentials),
        "private_notes" | "private-notes" | "private notes" => Ok(VaultCategory::PrivateNotes),
        other => Err(format!("unknown vault category: {other}")),
    }
}

pub(crate) fn vault_category_key(category: VaultCategory) -> &'static str {
    match category {
        VaultCategory::Payments => "payments",
        VaultCategory::Identity => "identity",
        VaultCategory::Health => "health",
        VaultCategory::Vehicles => "vehicles",
        VaultCategory::Credentials => "credentials",
        VaultCategory::PrivateNotes => "private_notes",
    }
}

fn invalid_vault_proposal(message: String) -> GatewayError {
    GatewayError {
        status: StatusCode::BAD_REQUEST,
        code: "invalid_vault_proposal",
        message,
    }
}

fn invalid_vault_pin(message: String) -> GatewayError {
    GatewayError {
        status: StatusCode::BAD_REQUEST,
        code: "invalid_vault_pin",
        message,
    }
}

fn vault_store_error(message: String) -> GatewayError {
    GatewayError {
        status: StatusCode::BAD_GATEWAY,
        code: "vault_store_error",
        message,
    }
}
