use std::sync::MutexGuard;

use local_first_vault::PaymentApprovalSnapshot;

use crate::{
    AppState, BROWSER_UNSUPPORTED_COMMITTING_ACTION_ERROR, GatewayError,
    browser_action_execution_fields_are_schema_legal, browser_safety,
};

#[derive(Debug, Clone)]
pub(crate) struct PaymentApprovalGrant {
    pub(crate) snapshot: PaymentApprovalSnapshot,
    pub(crate) cvv_one_shot: Option<String>,
    pub(crate) thread_id: String,
    pub(crate) consumed: bool,
    pub(crate) expires_at: std::time::Instant,
}

pub(crate) fn apply_payment_approval_secret_for_action(
    state: &AppState,
    action: &mut serde_json::Value,
) -> Result<bool, String> {
    let secret = action
        .get("vault_secret")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if secret.is_empty() {
        return Ok(false);
    }
    if secret != "cvv_one_shot" {
        return Err(format!("unsupported vault_secret: {secret}"));
    }
    let mut approvals = lock_payment_approvals(state).map_err(|error| error.message)?;
    apply_payment_approval_secret_from_map(&mut approvals, action)
}

pub(crate) fn apply_payment_approval_secret_from_map(
    approvals: &mut std::collections::HashMap<String, PaymentApprovalGrant>,
    action: &mut serde_json::Value,
) -> Result<bool, String> {
    let kind = action
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if !matches!(kind, "type" | "fill") {
        return Err("vault_secret can only be used with type/fill actions".to_string());
    }
    let approval_id = action
        .get("payment_approval_id")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "vault_secret requires a payment_approval_id".to_string())?
        .to_string();
    prune_expired_payment_approvals(approvals);
    let grant = approvals
        .get_mut(&approval_id)
        .ok_or_else(|| "payment approval is missing or expired".to_string())?;
    let cvv = grant
        .cvv_one_shot
        .take()
        .ok_or_else(|| "CVV/CV2 one-shot was already used".to_string())?;
    let Some(obj) = action.as_object_mut() else {
        return Err("browser action must be an object".to_string());
    };
    obj.insert("text".to_string(), serde_json::Value::String(cvv));
    obj.remove("vault_secret");
    Ok(true)
}

/// Whether a single (non-bundled) `browser_act` request must be rejected as
/// `BROWSER_UNSUPPORTED_COMMITTING_ACTION` BEFORE any payment-approval side
/// effect runs (vault-secret substitution, one-shot grant claim). The
/// `execute_browser_tool` single-action branch checks this FIRST — ahead of
/// `apply_payment_approval_secret_for_action` and `should_claim_payment_approval`
/// / `claim_payment_approval_for_action` below — because a hallucinated
/// `clickCoords` action (or any other non-schema kind, or a `selector`-bearing
/// action) can still carry a declared `action_class:"payment_commit"` plus a
/// valid, unconsumed `payment_approval_id`: `effective_action_class` resolves
/// purely from the DECLARED class (`kind` never enters that decision), so it
/// resolves to a genuine `Ok(PaymentCommit)` and, left unchecked until after
/// claiming, would burn the one-shot Payment Approval Card for an action that
/// gets rejected anyway (Task 1 review finding, commit eb9d877d; generalized
/// from clickCoords-only to the full schema-legality check in design 1.3).
/// Mirrors the bundle path's reject-first check in
/// `normalize_browser_action_bundle`, which runs the identical
/// `browser_action_execution_fields_are_schema_legal` check as the very first
/// thing in its loop, before any claim.
pub(crate) fn single_action_rejects_unsupported_execution_before_payment_claim(
    action: &serde_json::Value,
) -> Option<&'static str> {
    // A bundle ("actions" present) was already validated per-item inside
    // `normalize_browser_action_bundle`, which runs BEFORE this check (see the call
    // site) and, once every item passes, rewrites the top-level `kind` to the
    // gateway's own "batch" marker. That marker is legitimate here — it is not a
    // schema kind and must not be re-rejected as unsupported.
    if action.get("actions").is_some() {
        return None;
    }
    if browser_action_execution_fields_are_schema_legal(action) {
        None
    } else {
        Some(BROWSER_UNSUPPORTED_COMMITTING_ACTION_ERROR)
    }
}

pub(crate) fn should_claim_payment_approval(
    action: &serde_json::Value,
    payment_floor_refs: &std::collections::HashSet<String>,
    focus_payment_context: bool,
) -> bool {
    // Filling a card field is not the act of paying. The documented flow tells the model to fill the
    // CVV with `vault_secret` + the approval id, but that field sits in paymentFloorRefs, so the FILL
    // classified as PaymentCommit and burned the one-shot grant — and the real payment click that
    // followed was then always refused with "payment approval was already used". The happy path could
    // never complete. A non-committing fill that carries `vault_secret` is therefore exempt from
    // claiming: it still passes the gate (its class is unchanged, the approval id is still required
    // and validated), it just does not CONSUME the grant. Anything that actually commits — a click, a
    // submit, `type` with submit=true, Enter — is still a claim, so the money-moving action remains
    // one-shot and fail-closed.
    let is_vault_field_fill =
        action.get("vault_secret").is_some() && !browser_safety::is_committing_action(action);
    if is_vault_field_fill {
        return false;
    }
    matches!(
        browser_safety::effective_action_class(action, payment_floor_refs, focus_payment_context),
        Ok(browser_safety::ActionClass::PaymentCommit)
    )
}

pub(crate) fn claim_payment_approval_for_action(
    state: &AppState,
    action: &serde_json::Value,
    payment_floor_refs: &std::collections::HashSet<String>,
    focus_payment_context: bool,
    thread_id: Option<&str>,
) -> Result<String, String> {
    let mut approvals = lock_payment_approvals(state).map_err(|error| error.message)?;
    claim_payment_approval_from_map(
        &mut approvals,
        action,
        payment_floor_refs,
        focus_payment_context,
        thread_id,
    )
}

pub(crate) fn validate_payment_approval_for_action(
    state: &AppState,
    action: &serde_json::Value,
    payment_floor_refs: &std::collections::HashSet<String>,
    focus_payment_context: bool,
    thread_id: Option<&str>,
) -> Result<String, String> {
    let mut approvals = lock_payment_approvals(state).map_err(|error| error.message)?;
    prune_expired_payment_approvals(&mut approvals);
    validated_payment_approval_id(
        &approvals,
        action,
        payment_floor_refs,
        focus_payment_context,
        thread_id,
    )
}

pub(crate) fn validated_payment_approval_id(
    approvals: &std::collections::HashMap<String, PaymentApprovalGrant>,
    action: &serde_json::Value,
    payment_floor_refs: &std::collections::HashSet<String>,
    focus_payment_context: bool,
    thread_id: Option<&str>,
) -> Result<String, String> {
    if !browser_safety::action_is_payment_commit(action, payment_floor_refs, focus_payment_context)
    {
        return Err("payment approval can only be used on the final payment control".to_string());
    }
    let approval_id = action
        .get("payment_approval_id")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "final payment requires a Payment Approval Card".to_string())?;
    let grant = approvals
        .get(approval_id)
        .ok_or_else(|| "payment approval is missing or expired".to_string())?;
    if grant.thread_id != thread_id.unwrap_or_default() {
        return Err("payment approval belongs to a different conversation".to_string());
    }
    if grant.consumed {
        return Err("payment approval was already used".to_string());
    }
    Ok(approval_id.to_string())
}

pub(crate) fn claim_payment_approval_from_map(
    approvals: &mut std::collections::HashMap<String, PaymentApprovalGrant>,
    action: &serde_json::Value,
    payment_floor_refs: &std::collections::HashSet<String>,
    focus_payment_context: bool,
    thread_id: Option<&str>,
) -> Result<String, String> {
    prune_expired_payment_approvals(approvals);
    let approval_id = validated_payment_approval_id(
        approvals,
        action,
        payment_floor_refs,
        focus_payment_context,
        thread_id,
    )?;
    let grant = approvals
        .get_mut(approval_id.as_str())
        .ok_or_else(|| "payment approval is missing or expired".to_string())?;
    grant.consumed = true;
    Ok(approval_id)
}

pub(crate) fn prune_expired_payment_approvals(
    approvals: &mut std::collections::HashMap<String, PaymentApprovalGrant>,
) {
    let expired: Vec<String> = approvals
        .iter()
        .filter(|(_, grant)| std::time::Instant::now() > grant.expires_at)
        .map(|(id, _)| id.clone())
        .collect();
    for id in expired {
        approvals.remove(&id);
    }
}

pub(crate) fn lock_payment_approvals(
    state: &AppState,
) -> Result<MutexGuard<'_, std::collections::HashMap<String, PaymentApprovalGrant>>, GatewayError> {
    state
        .payment_approvals
        .lock()
        .map_err(|error| GatewayError {
            status: axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            code: "payment_approval_lock_error",
            message: error.to_string(),
        })
}
