//! Browser runtime and live activity owner.
//!
//! Owns bounded sidecar calls, browser checkpoint lifecycle, warm per-thread
//! sessions, contained-computer/browser reapers, and the live browser/sandbox
//! activity state exposed to the desktop UI.

use super::*;

#[test]
fn browser_runtime_owner_smoke() {
    assert!(thread_browser_session_is_live(std::time::Instant::now()));
    assert!(browser_contract_fingerprint(&None).is_none());
}

#[derive(Debug, Serialize)]
pub(crate) struct ComputerArtifactPreviewResponse {
    artifact_id: String,
    title_redacted: String,
    kind: String,
    size_bytes: u64,
    data_url: String,
}

pub(crate) async fn local_computer_session(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<Json<Option<local_first_local_computer_session::ComputerSessionSnapshot>>, GatewayError>
{
    let store = lock_computer_store(&state)?;
    let snapshot = LocalComputerReadModel::new(&store)
        .snapshot(
            &session_id,
            gateway_user_id().as_str(),
            gateway_workspace_id().as_str(),
        )
        .map_err(GatewayError::local_computer)?;
    Ok(Json(snapshot))
}

pub(crate) async fn local_computer_artifact_preview(
    State(state): State<AppState>,
    Path((session_id, artifact_id)): Path<(String, String)>,
) -> Result<Json<Option<ComputerArtifactPreviewResponse>>, GatewayError> {
    let store = lock_computer_store(&state)?;
    Ok(Json(local_computer_artifact_preview_response(
        &store,
        &session_id,
        &artifact_id,
    )?))
}

fn local_computer_artifact_preview_response(
    store: &LocalComputerSessionStore,
    session_id: &str,
    artifact_id: &str,
) -> Result<Option<ComputerArtifactPreviewResponse>, GatewayError> {
    let artifacts = store
        .artifacts_for_session(
            session_id,
            gateway_user_id().as_str(),
            gateway_workspace_id().as_str(),
        )
        .map_err(GatewayError::local_computer)?;
    let Some(artifact) = artifacts
        .into_iter()
        .find(|artifact| artifact.artifact_id == artifact_id)
    else {
        return Ok(None);
    };
    let path = PathBuf::from(&artifact.path_ref);
    let bytes = fs::read(&path).map_err(|error| GatewayError {
        status: StatusCode::BAD_GATEWAY,
        code: "artifact_preview_unavailable",
        message: error.to_string(),
    })?;
    let mime = match path.extension().and_then(|extension| extension.to_str()) {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        _ => "application/octet-stream",
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(Some(ComputerArtifactPreviewResponse {
        artifact_id: artifact.artifact_id,
        title_redacted: redact_sensitive_text(&artifact.title),
        kind: artifact.kind,
        size_bytes: artifact.size_bytes,
        data_url: format!("data:{mime};base64,{encoded}"),
    }))
}

#[test]
fn owner_projects_local_computer_artifact_preview() {
    let store = LocalComputerSessionStore::open_in_memory().expect("computer store");
    let path = std::env::temp_dir().join(format!(
        "homun-local-computer-preview-{}.png",
        uuid::Uuid::new_v4().simple()
    ));
    fs::write(&path, [0x89, b'P', b'N', b'G']).expect("preview image");
    store
        .upsert_artifact(&ArtifactRecord {
            artifact_id: "artifact_1".to_string(),
            session_id: "session_1".to_string(),
            user_id: gateway_user_id().as_str().to_string(),
            workspace_id: gateway_workspace_id().as_str().to_string(),
            title: "Preview with token sk-proj-secret".to_string(),
            kind: "image".to_string(),
            path_ref: path.to_string_lossy().to_string(),
            size_bytes: 4,
            preview_ref: None,
            created_at: OffsetDateTime::now_utc(),
        })
        .expect("upsert artifact");

    let preview = local_computer_artifact_preview_response(&store, "session_1", "artifact_1")
        .expect("preview response")
        .expect("artifact present");

    assert_eq!(preview.artifact_id, "artifact_1");
    assert_eq!(preview.kind, "image");
    assert_eq!(preview.size_bytes, 4);
    assert!(preview.data_url.starts_with("data:image/png;base64,"));
    assert!(!preview.title_redacted.contains("sk-proj-secret"));

    let _ = fs::remove_file(path);
}

/// Global lock serializing `browse_web` runs: the contained browser is a single
/// shared instance, so only one observe-act loop may drive it at a time.
pub(crate) fn browse_web_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Per-call gateway deadline for a sidecar RPC. Bounds a wedged CDP call that
/// the sub-turn's between-rounds budget would otherwise miss until the 300s
/// manager deadline. All within the 90s sub-turn ceiling.
pub(crate) fn browser_call_deadline(
    method: local_first_browser_automation::BrowserMethod,
) -> std::time::Duration {
    use local_first_browser_automation::BrowserMethod::*;
    match method {
        // `Open` creates the managed tab AND does the first navigation (a superset
        // of `Navigate`'s work, typically the slowest step of a session on a cold
        // tab), so it gets at least `Navigate`'s budget — never the 10s catch-all.
        Navigate | Open => std::time::Duration::from_secs(25),
        Act => std::time::Duration::from_secs(15),
        _ => std::time::Duration::from_secs(10),
    }
}

/// Runs ONE blocking `client.call` off the async runtime, moving the client in
/// and handing it back out (so the turn keeps ownership of the warm session —
/// mirrors `BrowserLoopRunner::into_client`). The global `browse_web_lock` MUST be
/// held by the caller around this so the single shared browser is driven by one
/// turn at a time. Returns the client plus the call result.
pub(crate) async fn chat_browser_call(
    client: BrowserAutomationClient<BrowserSidecarSession>,
    method: BrowserMethod,
    params: serde_json::Value,
) -> (
    Option<BrowserAutomationClient<BrowserSidecarSession>>,
    Result<serde_json::Value, String>,
) {
    let join = tokio::task::spawn_blocking(move || {
        let result = client
            .call(method, params)
            .map_err(|error| error.to_string());
        (client, result)
    })
    .await;
    match join {
        Ok((client, result)) => (Some(client), result),
        // The closure does no panicking work, so this is effectively unreachable;
        // if it ever fires, the client is gone (we cannot recover a moved value
        // after a panic), so report None and let the next call spawn a fresh one.
        Err(error) => (None, Err(format!("browser call task failed: {error}"))),
    }
}

/// Typed error surfaced when a sidecar RPC blows its per-call deadline
/// (`browser_call_deadline`). The `BROWSER_SIDECAR_TIMEOUT` prefix is the
/// contract the browse sub-loop keys on to map this into a bundle stop
/// reason / error observation the same way it handles any other browser
/// failure string.
pub(crate) const BROWSER_SIDECAR_TIMEOUT_ERROR: &str =
    "BROWSER_SIDECAR_TIMEOUT: the browser call exceeded its deadline";

/// Every `chat_browser_call` site in `execute_browser_tool` goes through this
/// wrapper instead, so each sidecar RPC is bounded by `browser_call_deadline`.
/// A wedged CDP call would otherwise stall the browse sub-turn until the far
/// outer 300s manager deadline, since the sub-turn budget is only checked
/// BETWEEN rounds. On timeout the `spawn_blocking` inside `chat_browser_call`
/// keeps running in the background (there is no way to cancel a blocking CDP
/// call) — the moved client is unrecoverable — so this returns `None` (the
/// next call spawns a fresh client/session) and the typed timeout error, with
/// NO automatic retry: the calling loop decides against its own budget.
pub(crate) async fn chat_browser_call_bounded(
    client: BrowserAutomationClient<BrowserSidecarSession>,
    method: BrowserMethod,
    params: serde_json::Value,
) -> (
    Option<BrowserAutomationClient<BrowserSidecarSession>>,
    Result<serde_json::Value, String>,
) {
    match tokio::time::timeout(
        browser_call_deadline(method),
        chat_browser_call(client, method, params),
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(_elapsed) => (None, Err(BROWSER_SIDECAR_TIMEOUT_ERROR.to_string())),
    }
}

pub(crate) fn browser_thread_workspace_id(state: &AppState, thread_id: &str) -> Option<String> {
    state
        .chat_store
        .lock()
        .ok()?
        .workspace_for_thread(thread_id)
        .ok()
}

/// Conservative classification of a failed effectful browser sidecar call,
/// mirroring the channel's `ChannelSendFailureKind` pattern. ONLY failures that
/// are provably PRE-dispatch — the Act request never reached the sidecar, or the
/// sidecar verified it never touched the page — qualify as
/// `ConnectFailedBeforeDispatch` (receipt can return to `prepared`, no user
/// verification, retry is safe). Anything after the sidecar could have accepted
/// the Act request stays `UnknownRemoteOutcome` → `mark_uncertain`, because an
/// ExternalWrite may already be applied and a blind retry risks double-execution.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BrowserActFailureKind {
    ConnectFailedBeforeDispatch,
    UnknownRemoteOutcome,
}

impl BrowserActFailureKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::ConnectFailedBeforeDispatch => "connect_failed_before_dispatch",
            Self::UnknownRemoteOutcome => "unknown_remote_outcome",
        }
    }
}

/// Classifies the error string returned by `chat_browser_call_checkpointed`
/// (the typed `BrowserAutomationError` is flattened to its `Display` text by
/// `chat_browser_call`). Deliberately conservative:
///
/// PRE-dispatch (release_not_applied):
/// - `sidecar stdin closed` / `broken pipe` — the stdin write of the Act request
///   failed, so the request line never reached the sidecar's read loop;
/// - `BROWSER_NOT_STARTED` — the sidecar answered with `requireContext`
///   rejecting the call before any page interaction (no session at all);
/// - `BROWSER_TAB_NOT_FOUND` — the sidecar answered with `resolvePage`
///   rejecting the call before any action runs (target tab does not exist).
///
/// Everything else (sidecar timeouts, `sidecar closed unexpectedly`,
/// `sidecar unresponsive`, page/Playwright errors, sidecar error codes thrown
/// mid-action) is `UnknownRemoteOutcome`: the sidecar may already have started
/// executing the action, so the receipt must stay uncertain.
pub(crate) fn browser_act_failure_kind(error: &str) -> BrowserActFailureKind {
    let error = error.to_lowercase();
    if error.contains("sidecar stdin closed")
        || error.contains("broken pipe")
        || error.contains("browser_not_started")
        || error.contains("browser_tab_not_found")
    {
        BrowserActFailureKind::ConnectFailedBeforeDispatch
    } else {
        BrowserActFailureKind::UnknownRemoteOutcome
    }
}

#[derive(Clone, Copy)]
pub(crate) struct BrowserCheckpointTelemetry<'a> {
    pub(crate) journal: &'a agent_journal::GatewayJournal,
    pub(crate) call_id: &'a str,
}

pub(crate) async fn persist_browser_checkpoint(
    state: &AppState,
    thread_id: Option<&str>,
    target_id: &str,
    client: BrowserAutomationClient<BrowserSidecarSession>,
    telemetry: BrowserCheckpointTelemetry<'_>,
) -> Option<BrowserAutomationClient<BrowserSidecarSession>> {
    let Some(thread_id) = thread_id else {
        return Some(client);
    };
    let Some(workspace_id) = browser_thread_workspace_id(state, thread_id) else {
        return Some(client);
    };
    let (client_back, result) = chat_browser_call_bounded(
        client,
        BrowserMethod::Checkpoint,
        serde_json::json!({"target_id": target_id}),
    )
    .await;
    let Ok(value) = result else {
        return client_back;
    };
    let Ok(checkpoint) = serde_json::from_value::<BrowserCheckpoint>(value) else {
        return client_back;
    };
    if checkpoint.schema_version != 1 || checkpoint.target_id != target_id {
        return client_back;
    }
    let (objective_revision, previous_secret_ref) = {
        let Ok(store) = state.task_store.lock() else {
            return client_back;
        };
        let Ok(Some(objective)) =
            store.load_objective_contract(gateway_user_id().as_str(), &workspace_id, thread_id)
        else {
            return client_back;
        };
        if objective.status != "active" {
            return client_back;
        }
        let previous = store
            .load_active_browser_checkpoint(
                gateway_user_id().as_str(),
                &workspace_id,
                thread_id,
                target_id,
            )
            .ok()
            .flatten()
            .and_then(|record| record.draft_secret_ref);
        (objective.revision, previous)
    };
    let checkpoint_id = uuid::Uuid::new_v4().simple().to_string();
    let draft_secret_ref = if checkpoint.controls.is_empty() {
        None
    } else {
        let payload = local_first_desktop_gateway::browser_checkpoint::BrowserDraftSecret {
            schema_version: 1,
            objective_revision,
            target_id: target_id.to_string(),
            origin: checkpoint.origin.clone(),
            generation: checkpoint.generation,
            controls: checkpoint.controls.clone(),
        };
        state
            .browser_checkpoint_secret_store
            .put(
                gateway_user_id().as_str(),
                &workspace_id,
                &checkpoint_id,
                &payload,
            )
            .ok()
    };
    let record = NewBrowserCheckpoint {
        checkpoint_id,
        user_id: gateway_user_id().as_str().to_string(),
        workspace_id,
        thread_id: thread_id.to_string(),
        target_id: target_id.to_string(),
        objective_revision,
        schema_version: checkpoint.schema_version as u32,
        url: checkpoint.url,
        origin: checkpoint.origin,
        browser_epoch: checkpoint.browser_epoch,
        cdp_target_id: checkpoint.cdp_target_id,
        generation: checkpoint.generation,
        draft_secret_ref: draft_secret_ref.clone(),
        draft_control_count: checkpoint.controls.len() as u32,
        omitted_sensitive_count: checkpoint.omitted_sensitive_count as u32,
        omitted_bounded_count: checkpoint.omitted_bounded_count as u32,
        expires_at: (OffsetDateTime::now_utc() + Duration::minutes(30)).unix_timestamp(),
    };
    let stored = state
        .task_store
        .lock()
        .ok()
        .and_then(|store| store.upsert_browser_checkpoint(&record).ok())
        .unwrap_or(false);
    if stored {
        telemetry.journal.record(browser_protocol_journal_event(
            telemetry.call_id,
            "browser_checkpoint_saved",
            &serde_json::json!({
                "schema_version": record.schema_version,
                "generation": record.generation,
                "draft_control_count": record.draft_control_count,
                "omitted_sensitive_count": record.omitted_sensitive_count,
                "omitted_bounded_count": record.omitted_bounded_count,
            }),
        ));
        if let Some(previous) = previous_secret_ref
            .filter(|previous| draft_secret_ref.as_deref() != Some(previous.as_str()))
        {
            let _ = state.browser_checkpoint_secret_store.delete(&previous);
        }
    } else if let Some(reference) = draft_secret_ref {
        let _ = state.browser_checkpoint_secret_store.delete(&reference);
    }
    client_back
}

pub(crate) async fn chat_browser_call_checkpointed(
    state: &AppState,
    thread_id: Option<&str>,
    target_id: &str,
    client: BrowserAutomationClient<BrowserSidecarSession>,
    method: BrowserMethod,
    params: serde_json::Value,
    telemetry: BrowserCheckpointTelemetry<'_>,
) -> (
    Option<BrowserAutomationClient<BrowserSidecarSession>>,
    Result<serde_json::Value, String>,
) {
    let (mut client_back, result) = chat_browser_call_bounded(client, method, params).await;
    if result.is_ok()
        && matches!(method, BrowserMethod::Snapshot | BrowserMethod::Act)
        && let Some(client) = client_back.take()
    {
        client_back =
            persist_browser_checkpoint(state, thread_id, target_id, client, telemetry).await;
    }
    (client_back, result)
}

pub(crate) async fn restore_browser_checkpoint(
    state: &AppState,
    thread_id: &str,
    target_id: &str,
    client: BrowserAutomationClient<BrowserSidecarSession>,
    telemetry: BrowserCheckpointTelemetry<'_>,
) -> (
    Option<BrowserAutomationClient<BrowserSidecarSession>>,
    Option<String>,
) {
    let Some(workspace_id) = browser_thread_workspace_id(state, thread_id) else {
        return (Some(client), None);
    };
    let checkpoint = state.task_store.lock().ok().and_then(|store| {
        store
            .load_active_browser_checkpoint(
                gateway_user_id().as_str(),
                &workspace_id,
                thread_id,
                target_id,
            )
            .ok()
            .flatten()
    });
    let Some(checkpoint) = checkpoint else {
        return (Some(client), None);
    };
    let draft_payload = checkpoint
        .draft_secret_ref
        .as_deref()
        .and_then(|reference| {
            state
                .browser_checkpoint_secret_store
                .get(reference, gateway_user_id().as_str(), &workspace_id)
                .ok()
                .flatten()
        })
        .filter(|payload| {
            payload.objective_revision == checkpoint.objective_revision
                && payload.target_id == checkpoint.target_id
                && payload.origin == checkpoint.origin
        });
    let (client_back, restored) = chat_browser_call_bounded(
        client,
        BrowserMethod::Restore,
        serde_json::json!({
            "target_id": checkpoint.target_id,
            "url": checkpoint.url,
            "origin": checkpoint.origin,
            "browser_epoch": checkpoint.browser_epoch,
            "cdp_target_id": checkpoint.cdp_target_id,
            "generation": checkpoint.generation,
        }),
    )
    .await;
    let Some(client) = client_back else {
        telemetry.journal.record(browser_protocol_journal_event(
            telemetry.call_id,
            "browser_restore_degraded",
            &serde_json::json!({"reason": "restore_timeout"}),
        ));
        return (
            None,
            Some("Browser recovery timed out. No pending browser action was executed; retry after the session respawns.".into()),
        );
    };
    let restore_value = match restored {
        Ok(value) => value,
        Err(error) => {
            telemetry.journal.record(browser_protocol_journal_event(
                telemetry.call_id,
                "browser_restore_degraded",
                &serde_json::json!({"reason": "restore_error"}),
            ));
            return (
                Some(client),
                Some(format!(
                    "Browser recovery failed: {error}. No pending browser action was executed."
                )),
            );
        }
    };
    let tier = restore_value
        .get("tier")
        .and_then(Value::as_str)
        .unwrap_or("degraded_url_only");
    let (client_back, snapshot) = chat_browser_call_bounded(
        client,
        BrowserMethod::Snapshot,
        browser_chat_act_snapshot_params(target_id),
    )
    .await;
    let (snapshot, snapshot_generation) = match snapshot {
        Ok(value) => (
            browser_snapshot_text(&value),
            value.get("generation").and_then(Value::as_u64),
        ),
        Err(error) => {
            telemetry.journal.record(browser_protocol_journal_event(
                telemetry.call_id,
                "browser_restore_degraded",
                &serde_json::json!({
                    "reason": "mandatory_snapshot_failed",
                    "recovery_tier": tier,
                }),
            ));
            return (
                client_back,
                Some(format!(
                    "Browser target restored ({tier}) but the mandatory fresh snapshot failed: {error}. No pending browser action was executed."
                )),
            );
        }
    };
    let draft_available = draft_payload.is_some() && tier != "adopted_live_page";
    let draft_notice = if let Some(payload) = draft_payload.filter(|_| tier != "adopted_live_page")
    {
        format!(
            " A safe form draft is available as draft_ref `{}`. Rehydrate only explicitly selected empty fields with browser_rehydrate. Available draft controls: {}.",
            checkpoint.checkpoint_id,
            browser_draft_manifest(&payload),
        )
    } else {
        String::new()
    };
    let boundary = if tier == "adopted_live_page" {
        "browser_restore_adopted"
    } else if draft_available {
        "browser_restore_draft_available"
    } else {
        "browser_restore_degraded"
    };
    telemetry.journal.record(browser_protocol_journal_event(
        telemetry.call_id,
        boundary,
        &serde_json::json!({
            "schema_version": checkpoint.schema_version,
            "generation": snapshot_generation,
            "target_count": 1,
            "draft_control_count": checkpoint.draft_control_count,
            "recovery_tier": tier,
            "reason": if tier == "adopted_live_page" { "exact_target_adopted" } else if draft_available { "live_target_missing_draft_available" } else { "url_only" },
        }),
    ));
    (
        client_back,
        Some(format!(
            "Browser session recovered ({tier}). The pending operation was NOT replayed.{draft_notice}\nFresh snapshot:\n{snapshot}"
        )),
    )
}

pub(crate) fn browser_draft_manifest(
    payload: &local_first_desktop_gateway::browser_checkpoint::BrowserDraftSecret,
) -> String {
    payload
        .controls
        .iter()
        .map(|control| {
            format!(
                "{} ({} {}, name={}, label={})",
                control.draft_ref,
                control.tag,
                control.control_type,
                control.name.as_deref().unwrap_or("-"),
                control.label.as_deref().unwrap_or("-"),
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

pub(crate) fn build_browser_rehydrate_fields(
    payload: &local_first_desktop_gateway::browser_checkpoint::BrowserDraftSecret,
    args: &Value,
) -> Result<Vec<Value>, String> {
    let mappings = args
        .get("fields")
        .and_then(Value::as_array)
        .filter(|fields| !fields.is_empty() && fields.len() <= 32)
        .ok_or_else(|| "rehydration requires 1..32 field mappings".to_string())?;
    let mut seen_refs = HashSet::new();
    let mut fields = Vec::with_capacity(mappings.len());
    for mapping in mappings {
        let current_ref = mapping
            .get("ref")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "rehydration mapping is missing current ref".to_string())?;
        let draft_control_ref = mapping
            .get("draft_control_ref")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "rehydration mapping is missing draft control ref".to_string())?;
        if !seen_refs.insert(current_ref) {
            return Err("rehydration mapping contains duplicate current refs".into());
        }
        let control = payload
            .controls
            .iter()
            .find(|control| control.draft_ref == draft_control_ref)
            .ok_or_else(|| "rehydration mapping references an unknown draft control".to_string())?;
        fields.push(serde_json::json!({
            "ref": current_ref,
            "value": control.value,
            "descriptor": {
                "tag": control.tag,
                "type": control.control_type,
                "name": control.name,
                "id": control.id,
                "autocomplete": control.autocomplete,
                "label": control.label,
                "formId": control.form_id,
            }
        }));
    }
    Ok(fields)
}

#[cfg(test)]
mod browser_rehydrate_contract_tests {
    use super::*;
    use local_first_browser_automation::BrowserDraftControl;

    fn payload() -> local_first_desktop_gateway::browser_checkpoint::BrowserDraftSecret {
        local_first_desktop_gateway::browser_checkpoint::BrowserDraftSecret {
            schema_version: 1,
            objective_revision: 4,
            target_id: "chat_0".into(),
            origin: "https://rail.example".into(),
            generation: 8,
            controls: vec![BrowserDraftControl {
                draft_ref: "draft_1".into(),
                tag: "input".into(),
                control_type: "email".into(),
                name: Some("email".into()),
                id: None,
                autocomplete: Some("email".into()),
                label: Some("Email".into()),
                form_id: None,
                value: serde_json::json!("ada.private@example.test"),
            }],
        }
    }

    #[test]
    fn explicit_rehydrate_maps_only_requested_opaque_control_refs() {
        let fields = build_browser_rehydrate_fields(
            &payload(),
            &serde_json::json!({
                "fields": [{"ref": "e12", "draft_control_ref": "draft_1"}]
            }),
        )
        .unwrap();

        assert_eq!(fields.len(), 1);
        assert_eq!(fields[0]["ref"], "e12");
        assert_eq!(fields[0]["descriptor"]["name"], "email");
        assert_eq!(fields[0]["value"], "ada.private@example.test");
    }

    #[test]
    fn invalid_rehydrate_mapping_never_echoes_private_value_in_error() {
        let error = build_browser_rehydrate_fields(
            &payload(),
            &serde_json::json!({
                "fields": [{"ref": "e12", "draft_control_ref": "unknown"}]
            }),
        )
        .unwrap_err();

        assert!(!error.contains("ada.private@example.test"));
    }

    #[test]
    fn draft_manifest_exposes_descriptors_but_never_values() {
        let manifest = browser_draft_manifest(&payload());
        assert!(manifest.contains("draft_1"));
        assert!(manifest.contains("email"));
        assert!(!manifest.contains("ada.private@example.test"));
    }

    #[test]
    fn browser_rehydrate_is_an_external_write() {
        assert_eq!(
            tool_effect_class("browser_rehydrate", &std::collections::BTreeSet::new()),
            semantic_decision::EffectClass::ExternalWrite,
        );
    }

    #[test]
    fn only_mutating_browser_tools_require_effect_receipts() {
        assert_eq!(
            browser_effect_class("browser_rehydrate"),
            Some(local_first_execution_protocol::EffectClass::ExternalWrite),
            "browser_rehydrate must cross the effect host as an external write"
        );
        assert_eq!(
            browser_effect_class("browser_act"),
            None,
            "browser_act effect class is action-dependent and owned by gateway_tool_execution"
        );
        for name in [
            "browser_navigate",
            "browser_snapshot",
            "browser_screenshot",
            "browser_tabs",
            "browser_dialog",
            "browser_done",
        ] {
            assert_eq!(
                browser_effect_class(name),
                None,
                "{name} must remain receipt-free"
            );
        }
    }

    #[test]
    fn unknown_remote_dispatch_requires_receipt_resolution() {
        assert_eq!(
            effect_receipt_finish_action(EffectDispatchStatus::UnknownRemoteOutcome),
            EffectReceiptFinishAction::MarkUncertainAndSuspend
        );
        assert_eq!(
            effect_receipt_finish_action(EffectDispatchStatus::Verified),
            EffectReceiptFinishAction::Complete
        );
    }

    #[test]
    fn telegram_rebind_is_forbidden_after_unknown_first_send() {
        assert!(!telegram_send_may_rebind(
            ChannelSendFailureKind::UnknownRemoteOutcome
        ));
        assert!(!telegram_send_may_rebind(
            ChannelSendFailureKind::VerifiedRejection
        ));
        assert!(telegram_send_may_rebind(
            ChannelSendFailureKind::ConnectFailedBeforeDispatch
        ));
    }
}

/// Canonical Snapshot params for the chat-driven browser.
///
/// CONTENT-PRESERVING (not `interactive`-only): the old `mode:"efficient" +
/// interactive:true` snapshot filtered the aria tree down to CLICKABLE roles only
/// (button/link/textbox…) and dropped every table/row/cell/heading/text line — so a
/// Wikipedia standings table came back as navbar+cookie-buttons+links and the model
/// NEVER saw the data it had to report (it then fell back to curl and presented stale/
/// fabricated figures). Dropping `mode`/`interactive` (keeping `compact:true`) makes the
/// builder keep CONTENT rows AND still parse interactive refs, so the agent can both READ
/// the page and CLICK. Larger `max_chars` so a full standings/results table isn't cut
/// mid-data; a longer snapshot timeout so JS-heavy pages finish their aria tree.
pub(crate) fn browser_chat_snapshot_params(target_id: &str) -> serde_json::Value {
    serde_json::json!({
        "target_id": target_id,
        "snapshot_format": "ai",
        "refs_mode": "aria",
        "compact": true,
        "depth": 12,
        // Must match the sidecar's `extract` budget: this value is applied as min(max_chars, cap), so
        // leaving it at 20k would silently re-truncate a results table the larger cap was raised to fit.
        "max_chars": 40_000,
        "timeout_ms": 8_000,
        // No `urls:true`: the content snapshot already carries the page's links inline.
        // The appended flat url-dump made `extract_source_urls` scrape EVERY link (a
        // Wikipedia page's donate / edit / history / action= chrome) into `browse_sources`,
        // which then polluted the "Sources" footer with non-source UI links.
    })
}

/// ACTING observation: interactive-only (interact mode, ~6k cap). After an action — especially
/// `type` into an autocomplete field — the model needs to see what it can CLICK next (suggestion
/// options, buttons, inputs), not the entire page. A 40k `extract` dump drowns weak models:
/// they lose the suggestion refs in noise and never click the dropdown. Interact mode shows only
/// interactive roles (button, link, option, textbox, …), which includes autocomplete suggestions
/// (role=option) with their refs. When the model needs to READ full page content (e.g. search
/// results), it calls the explicit `browser_snapshot` tool with mode=extract.
/// Used after navigate, after a stale-ref recovery, and for `browser_snapshot` with default
/// interact mode; the post-`act` observation gets the same treatment sidecar-side (session_manager
/// `act` sets `observationMode: "interact"`).
pub(crate) fn browser_chat_act_snapshot_params(target_id: &str) -> serde_json::Value {
    serde_json::json!({
        "target_id": target_id,
        "snapshot_format": "ai",
        "refs_mode": "aria",
        "compact": true,
        "depth": 12,
        "max_chars": 9_000,
        "timeout_ms": 8_000,
        "observation_mode": "interact",
    })
}

/// Extracts the `.snapshot` (and `.url`) text from a sidecar Snapshot/Act result.
pub(crate) fn browser_snapshot_text(value: &serde_json::Value) -> String {
    value
        .get("snapshot")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string()
}

/// Machine-derived payment floor refs the sidecar attached to an observation.
/// Absent field → empty set. These raise (never lower) the effective action class.
pub(crate) fn browser_floor_refs(value: &serde_json::Value) -> std::collections::HashSet<String> {
    value
        .get("paymentFloorRefs")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// This target's machine-derived payment floor refs (Build1 Fix 3, per-`target_id`
/// floor set, mirroring `payment_context_by_target`). Absent target (never
/// observed yet) → empty set, matching the old single-set default. Returns an
/// owned clone (the sets are small — a handful of ref ids per observation) so
/// callers can hold it across the mutable borrow the post-act refresh needs.
pub(crate) fn browser_floor_refs_for_target(
    floor_by_target: &std::collections::HashMap<String, std::collections::HashSet<String>>,
    target: &str,
) -> std::collections::HashSet<String> {
    floor_by_target.get(target).cloned().unwrap_or_default()
}

/// Replaces ONLY `target`'s floor-ref entry with a fresh observation's refs — the
/// fix for the cross-tab fail-open: a single global `HashSet` let observing tab A
/// overwrite tab B's floor out from under it (interleaving two tabs without
/// re-observing the acted-on one would silently clear its floor). Every call site
/// that used to do `*payment_floor_refs = browser_floor_refs(&value)` now goes
/// through here, keyed by the target the observation actually came from.
pub(crate) fn browser_set_target_floor(
    floor_by_target: &mut std::collections::HashMap<String, std::collections::HashSet<String>>,
    target: &str,
    floor: std::collections::HashSet<String>,
) {
    floor_by_target.insert(target.to_string(), floor);
}

/// Machine focus-in-payment-context flag the sidecar attached to an observation
/// (Task 2). Absent → false. Raises (never lowers) a ref-less committing action's
/// class — see `browser_safety::is_refless_committing`.
pub(crate) fn browser_focus_payment_context(value: &serde_json::Value) -> bool {
    value
        .get("focusPaymentContext")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

/// Per-`target_id` payment-context signal (design 1.2, fixes IMPORTANT D/C). A
/// single global flag let a snapshot of tab A clear tab B's payment context out
/// from under it — every tab now gets its own entry, keyed by `target_id`.
///
/// - `focus` mirrors the sidecar's best-effort `focusPaymentContext`
///   (`document.hasFocus()`-based): correct for a same-process/main-frame cc-form,
///   but it fails OPEN for a real cross-origin PSP OOPIF whenever the app is not
///   OS-frontmost (IMPORTANT C) — so it is kept only as a SECONDARY signal now.
/// - `last_acted_floored` is the robust, OS-focus-independent signal: it is
///   frame-aware "for free" because the per-ref floor
///   (`computePaymentFloorRefs`/`locator.evaluate` in the sidecar) already floors a
///   card input inside a cross-origin OOPIF correctly — so acting on that ref sets
///   this flag regardless of window focus.
///
/// The gate ORs both (see `browser_payment_context_for`); it only ever raises
/// (never lowers) the ref-less committing floor, matching the payment-floor's own
/// raise-only discipline.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct BrowserPaymentContext {
    focus: bool,
    last_acted_floored: bool,
}

impl BrowserPaymentContext {
    /// The single bool the gate consumes: either signal is enough to floor.
    fn combined(self) -> bool {
        self.focus || self.last_acted_floored
    }
}

/// Combined per-target payment-context signal fed to
/// `browser_safety::effective_action_class`'s `focus_payment_context` parameter.
/// Absent entry (target never observed yet) → false, matching the old default.
pub(crate) fn browser_payment_context_for(
    payment_context_by_target: &std::collections::HashMap<String, BrowserPaymentContext>,
    target: &str,
) -> bool {
    payment_context_by_target
        .get(target)
        .is_some_and(|context| context.combined())
}

/// Updates a target's best-effort focus flag from a fresh observation. Called at
/// every site that refreshes `payment_floor_refs` for a target (navigate, snapshot,
/// act success, stale-ref recovery) — mirrors that field's own update discipline.
pub(crate) fn browser_set_target_focus(
    payment_context_by_target: &mut std::collections::HashMap<String, BrowserPaymentContext>,
    target: &str,
    focus: bool,
) {
    payment_context_by_target
        .entry(target.to_string())
        .or_default()
        .focus = focus;
}

/// Marks a target's robust payment signal after an `act` that targeted a ref the
/// PRE-act observation had already floored (IMPORTANT C). Only ever raises the
/// flag; cleared exclusively by `browser_clear_target_acted_floored`, never here.
pub(crate) fn browser_mark_target_acted_floored(
    payment_context_by_target: &mut std::collections::HashMap<String, BrowserPaymentContext>,
    target: &str,
) {
    payment_context_by_target
        .entry(target.to_string())
        .or_default()
        .last_acted_floored = true;
}

/// Clears a target's last-acted-floored flag on an explicit `browser_navigate` /
/// `browser_snapshot` (or stale-ref-recovery) re-observation of that SAME target.
/// Deliberately NEVER called from `browser_act`'s own post-action success refresh:
/// that refresh is the direct continuation of the very action that may have just
/// SET this flag (e.g. typing a CVV into a floored ref), so clearing it there would
/// erase the signal the very next ref-less Enter needs to see. Per-target, so
/// re-observing a DIFFERENT tab never touches this target's flag (fixes
/// IMPORTANT D).
pub(crate) fn browser_clear_target_acted_floored(
    payment_context_by_target: &mut std::collections::HashMap<String, BrowserPaymentContext>,
    target: &str,
) {
    if let Some(context) = payment_context_by_target.get_mut(target) {
        context.last_acted_floored = false;
    }
}

/// True when `action` (a single action, or any item of its flat bundle) targets a
/// ref that was in the PRE-act `payment_floor_refs` — the trigger for
/// `browser_mark_target_acted_floored`. Bundle items already carry `target_id`
/// equal to the bundle's `current_target` (see `normalize_browser_action_bundle`),
/// so checking every item's `ref` against the SAME floor set is correct for a
/// single-target bundle.
///
/// Checks BOTH the top-level `ref` AND any `fields[].ref` (mirrors
/// `browser_safety::any_ref_in_floor`): a `kind:"fill"` action using the
/// sidecar's canonical multi-field contract (`fields:[{ref,value}]` — see
/// `resolveFillFields` in `runtimes/browser-automation/src/browser/actions.ts`)
/// carries no top-level `ref` at all, so a ref-only check never set
/// `last_acted_floored` for it — leaving a following ref-less Enter/Return
/// ungated even though the fill just targeted a floored card field (Build1
/// fill-fields fail-open).
pub(crate) fn browser_action_targeted_a_floored_ref(
    action: &serde_json::Value,
    payment_floor_refs: &std::collections::HashSet<String>,
) -> bool {
    let ref_is_floored = |value: &serde_json::Value| {
        value
            .get("ref")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|r| payment_floor_refs.contains(r))
            || value
                .get("fields")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|fields| {
                    fields.iter().any(|field| {
                        field
                            .get("ref")
                            .and_then(serde_json::Value::as_str)
                            .is_some_and(|r| payment_floor_refs.contains(r))
                    })
                })
    };
    ref_is_floored(action)
        || action
            .get("actions")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|items| items.iter().any(ref_is_floored))
}

/// How long a per-thread browser session may sit idle before it is reaped.
pub(crate) const THREAD_BROWSER_SESSION_IDLE: std::time::Duration =
    std::time::Duration::from_secs(300);

/// The single idle rule for a warm browser session: past `THREAD_BROWSER_SESSION_IDLE` it is
/// stale and must be treated as gone (the reaper is about to close it anyway). Shared by the
/// consuming take and the read-only probe so the two can never disagree.
pub(crate) fn thread_browser_session_is_live(last_used: std::time::Instant) -> bool {
    last_used.elapsed() <= THREAD_BROWSER_SESSION_IDLE
}

/// Read-only probe: does this thread currently hold a LIVE warm browser session?
///
/// This is the MACHINE SIGNAL behind `tool_stays_live_this_turn`: mid web task the manager must
/// keep seeing `browse`, and "mid web task" is exactly "the thread still has an open session".
/// Deliberately NON-consuming — unlike `take_thread_browser_session` it must not remove, park,
/// close or refresh anything: probing a session is not using it, so it may not extend its idle
/// window either.
pub(crate) fn thread_has_live_browser_session(state: &AppState, thread_id: &str) -> bool {
    let Ok(map) = state.browser_thread_sessions.lock() else {
        return false;
    };
    map.get(thread_id)
        .is_some_and(|session| thread_browser_session_is_live(session.last_used))
}

/// Read-only general continuation signal. A durable active checkpoint keeps `browse` reachable
/// after sidecar loss; exact scope/revision/expiry is revalidated again by restore-before-use.
pub(crate) fn thread_has_browser_continuation(state: &AppState, thread_id: &str) -> bool {
    if thread_has_live_browser_session(state, thread_id) {
        return true;
    }
    let Some(workspace_id) = browser_thread_workspace_id(state, thread_id) else {
        return false;
    };
    state
        .task_store
        .lock()
        .ok()
        .and_then(|store| {
            store
                .load_active_browser_checkpoint_for_thread(
                    gateway_user_id().as_str(),
                    &workspace_id,
                    thread_id,
                )
                .ok()
                .flatten()
        })
        .is_some()
}

/// Take (remove) a thread's warm browser session for reuse. Returns `None` if
/// absent or stale (a stale one is gracefully closed here so it doesn't leak).
pub(crate) fn take_thread_browser_session(
    state: &AppState,
    thread_id: &str,
) -> Option<BrowserAutomationClient<BrowserSidecarSession>> {
    let session = {
        let mut map = state.browser_thread_sessions.lock().ok()?;
        map.remove(thread_id)?
    };
    if !thread_browser_session_is_live(session.last_used) {
        let _ = session
            .client
            .call(BrowserMethod::Stop, serde_json::json!({}));
        return None;
    }
    Some(session.client)
}

/// Park a thread's browser session back in the registry, warm for the next call.
pub(crate) fn store_thread_browser_session(
    state: &AppState,
    thread_id: &str,
    client: BrowserAutomationClient<BrowserSidecarSession>,
) {
    if let Ok(mut map) = state.browser_thread_sessions.lock() {
        map.insert(
            thread_id.to_string(),
            ThreadBrowserSession {
                client,
                last_used: std::time::Instant::now(),
            },
        );
    } else {
        // Poisoned lock: don't leak the sidecar — close it.
        let _ = client.call(BrowserMethod::Stop, serde_json::json!({}));
    }
}

/// Close and forget a thread's browser session (graceful browser.stop + drop).
/// Called when a thread is archived/closed/deleted.
pub(crate) fn close_thread_browser_session(state: &AppState, thread_id: &str, workspace_id: &str) {
    let session = state
        .browser_thread_sessions
        .lock()
        .ok()
        .and_then(|mut map| map.remove(thread_id));
    if let Some(session) = session {
        let _ = session
            .client
            .call(BrowserMethod::Stop, serde_json::json!({}));
    }
    let secret_refs = state
        .task_store
        .lock()
        .ok()
        .and_then(|store| {
            store
                .delete_browser_checkpoints_for_thread(
                    gateway_user_id().as_str(),
                    workspace_id,
                    thread_id,
                )
                .ok()
        })
        .unwrap_or_default();
    let cleared_secret_count = secret_refs.len();
    for reference in secret_refs {
        let _ = state.browser_checkpoint_secret_store.delete(&reference);
    }
    tracing::info!(
        target: "browser::checkpoint",
        event = "browser_checkpoint_cleared",
        reason = "thread_closed",
        cleared_secret_count,
        "browser checkpoint lifecycle cleanup"
    );
}

/// Startup cleanup plus a 60s reaper for expired checkpoints and idle browser sessions.
pub(crate) fn spawn_thread_browser_session_reaper(state: AppState) {
    tokio::spawn(async move {
        loop {
            let stale: Vec<ThreadBrowserSession> = {
                if let Ok(mut map) = state.browser_thread_sessions.lock() {
                    let expired: Vec<String> = map
                        .iter()
                        .filter(|(_, session)| {
                            session.last_used.elapsed() > THREAD_BROWSER_SESSION_IDLE
                        })
                        .map(|(thread, _)| thread.clone())
                        .collect();
                    expired
                        .into_iter()
                        .filter_map(|thread| map.remove(&thread))
                        .collect()
                } else {
                    Vec::new()
                }
            };
            let expired_secret_refs = state
                .task_store
                .lock()
                .ok()
                .and_then(|store| {
                    store
                        .take_expired_browser_checkpoint_secret_refs(
                            OffsetDateTime::now_utc().unix_timestamp(),
                        )
                        .ok()
                })
                .unwrap_or_default();
            let cleared_secret_count = expired_secret_refs.len();
            for reference in expired_secret_refs {
                let _ = state.browser_checkpoint_secret_store.delete(&reference);
            }
            if cleared_secret_count > 0 {
                tracing::info!(
                    target: "browser::checkpoint",
                    event = "browser_checkpoint_cleared",
                    reason = "expired",
                    cleared_secret_count,
                    "browser checkpoint lifecycle cleanup"
                );
            }
            if !stale.is_empty() {
                // Closing talks to the sidecar over a blocking pipe — do it off the
                // async runtime.
                let _ = tokio::task::spawn_blocking(move || {
                    for session in stale {
                        let _ = session
                            .client
                            .call(BrowserMethod::Stop, serde_json::json!({}));
                    }
                })
                .await;
            }
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    });
}

/// Tracks the last time the contained computer did anything (skill exec or live
/// browser activity), feeding the idle-recycle reaper below.
pub(crate) fn cc_last_activity_cell() -> &'static std::sync::Mutex<std::time::Instant> {
    static CELL: std::sync::OnceLock<std::sync::Mutex<std::time::Instant>> =
        std::sync::OnceLock::new();
    CELL.get_or_init(|| std::sync::Mutex::new(std::time::Instant::now()))
}

/// Marks the contained computer as just-used, resetting its idle clock.
pub(crate) fn touch_cc_activity() {
    if let Ok(mut guard) = cc_last_activity_cell().lock() {
        *guard = std::time::Instant::now();
    }
}

pub(crate) fn cc_idle_for() -> std::time::Duration {
    cc_last_activity_cell()
        .lock()
        .map(|g| g.elapsed())
        .unwrap_or_default()
}

/// How long the contained computer may sit idle before the reaper recycles it.
/// Default 30 min — comfortably past the 5-min browser-session idle, so parked
/// sessions are already reaped by then. Overridable via `HOMUN_CC_IDLE_RECYCLE_SECS`.
pub(crate) fn cc_idle_recycle_after() -> std::time::Duration {
    let secs = std::env::var("HOMUN_CC_IDLE_RECYCLE_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|&v| v >= 60)
        .unwrap_or(1800);
    std::time::Duration::from_secs(secs)
}

/// Background reaper: every 60s, recycle the contained computer (`docker rm -f`)
/// once it has been idle past the threshold AND nothing is using it — no skill
/// command in-flight, no live browser run, no parked per-thread browser session.
/// The next skill/browser use re-creates it from the cached image (a clean
/// slate), so scratch (/tmp, runtime installs, synced skills) can't accumulate
/// across a long-running session.
pub(crate) fn spawn_contained_computer_idle_reaper(state: AppState) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            if cc_idle_for() < cc_idle_recycle_after() {
                continue;
            }
            // Never recycle while the container is in use.
            if current_sandbox_activity().iter().any(|entry| entry.running) {
                continue; // a skill command is executing
            }
            if current_browser_activity().is_some() {
                continue; // a live browser run is in progress
            }
            let has_browser_session = state
                .browser_thread_sessions
                .lock()
                .map(|map| !map.is_empty())
                .unwrap_or(true); // poisoned lock → be conservative, skip
            if has_browser_session {
                continue; // a parked session's CDP points at this container
            }
            // docker calls block — run off the async runtime.
            let _ = tokio::task::spawn_blocking(|| {
                if sandbox::container_up() && sandbox::recycle_container() {
                    eprintln!(
                        "contained-computer: idle past the threshold, recycled ({} removed, recreated on next use)",
                        sandbox::CONTAINER
                    );
                }
            })
            .await;
        }
    });
}

/// How long a browser task may sit parked waiting for a human to clear a manual
/// challenge (e.g. a captcha) before it gives up. Without a cap, a task launched
/// while the user is away from the screen would wait for the approval forever.
/// Default 180s; override with `HOMUN_BROWSER_HANDOFF_TIMEOUT_SECS` (min 30).
pub(crate) fn browser_handoff_timeout_secs() -> i64 {
    env::var("HOMUN_BROWSER_HANDOFF_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|&v| v >= 30)
        .unwrap_or(180)
}

/// Background reaper: every 60s, fail browser tasks parked in WaitingUserApproval
/// for a `browser.manual_action` (a captcha / "press and hold" / login wall the
/// agent couldn't auto-solve) longer than `browser_handoff_timeout_secs()`. The
/// interactive chat doesn't need this — its turn ends — but an autonomous task
/// ("do X" while the user is away) would otherwise hang on the approval forever.
pub(crate) fn spawn_browser_handoff_reaper(state: AppState) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            let cutoff =
                OffsetDateTime::now_utc() - Duration::seconds(browser_handoff_timeout_secs());
            let Ok(store) = lock_task_store(&state) else {
                continue;
            };
            let Ok(scopes) = store.task_owner_scopes() else {
                continue;
            };
            for (user, workspace) in &scopes {
                let Ok(tasks) = store.list_tasks(user, workspace) else {
                    continue;
                };
                for task in tasks {
                    let waiting_handoff = task.status == TaskStatus::WaitingUserApproval
                        && task
                            .blocked_reason
                            .as_deref()
                            .is_some_and(|reason| reason.contains("browser.manual_action"));
                    if waiting_handoff && task.updated_at < cutoff {
                        // Cancel (terminal, no retry — it would just hit the same
                        // challenge again) with a reason the task/session UI shows.
                        let _ = store.update_task_status(
                            &task.task_id,
                            user,
                            workspace,
                            TaskStatus::Cancelled,
                            Some(
                                "browser handoff timed out: nobody cleared the manual challenge (e.g. captcha) in time",
                            ),
                        );
                        eprintln!(
                            "browser-handoff: task {:?} gave up — no human cleared the manual challenge within {}s",
                            task.task_id,
                            browser_handoff_timeout_secs()
                        );
                    }
                }
            }
        }
    });
}

/// One step of the live activity checklist (Manus-style "Avanzamento attività").
#[derive(Debug, Clone, Serialize)]
pub(crate) struct BrowserStepView {
    pub(crate) label: String,
    pub(crate) status: String,
}

/// Live browser activity: the current goal + the steps executed so far. `Some`
/// while a `browse_web` is actually running, `None` when idle. Drives a truthful
/// "● LIVE" + the step checklist in the UI.
#[derive(Debug, Clone, Default)]
pub(crate) struct BrowserActivityState {
    pub(crate) thread_id: Option<String>,
    pub(crate) goal: String,
    pub(crate) steps: Vec<BrowserStepView>,
}

/// Last REAL user activity (epoch secs). Stamped only by turns that mean "the
/// user is at work": in-app chats and OWNER channel turns — never inbound
/// contact messages or Homun's own headless check-ins. In-memory: after a boot
/// no activity is recorded yet (= idle), the hour/random gates still protect.
pub(crate) fn user_activity_cell() -> &'static std::sync::RwLock<Option<i64>> {
    static CELL: std::sync::OnceLock<std::sync::RwLock<Option<i64>>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| std::sync::RwLock::new(None))
}

pub(crate) fn note_user_activity() {
    if let Ok(mut guard) = user_activity_cell().write() {
        *guard = Some(now_epoch_secs() as i64);
    }
}

/// None = nothing seen since boot (counts as idle).
pub(crate) fn seconds_since_user_activity() -> Option<i64> {
    user_activity_cell()
        .read()
        .ok()
        .and_then(|guard| guard.map(|t| (now_epoch_secs() as i64).saturating_sub(t)))
}

/// How long the user must be quiet before a Homun check-in may interrupt.
pub(crate) fn homun_idle_threshold_secs() -> i64 {
    env::var("HOMUN_IDLE_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(20 * 60)
}

pub(crate) fn browser_activity_cell() -> &'static std::sync::RwLock<Option<BrowserActivityState>> {
    static CELL: std::sync::OnceLock<std::sync::RwLock<Option<BrowserActivityState>>> =
        std::sync::OnceLock::new();
    CELL.get_or_init(|| std::sync::RwLock::new(None))
}

pub(crate) fn begin_browser_activity(goal: String, thread_id: Option<String>) {
    touch_cc_activity();
    if let Ok(mut guard) = browser_activity_cell().write() {
        *guard = Some(BrowserActivityState {
            thread_id,
            goal,
            steps: Vec::new(),
        });
    }
}

pub(crate) fn browser_protocol_event_summary(
    child_run_id: &str,
    boundary: &str,
    metrics: serde_json::Value,
) -> String {
    let observation_chars = metrics
        .get("observation_chars")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let refs = metrics
        .get("refs")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let stop_reason = metrics
        .get("stop_reason")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown");
    let action_kinds = metrics
        .get("action_kinds")
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();
    let mut out = format!(
        "browser_protocol child_run_id={child_run_id} boundary={boundary} observation_chars={observation_chars} refs={refs} action_kinds={action_kinds} stop_reason={stop_reason}"
    );
    for key in [
        "generation",
        "completed_actions",
        "unexecuted_actions",
        "minimum_items",
        "contract_fields",
    ] {
        if let Some(value) = metrics.get(key).and_then(serde_json::Value::as_u64) {
            out.push_str(&format!(" {key}={value}"));
        }
    }
    if let Some(value) = metrics
        .get("contract_fp")
        .and_then(serde_json::Value::as_str)
    {
        out.push_str(&format!(" contract_fp={value}"));
    }
    out
}

/// Build a durable journal event from the same redacted metrics used for the
/// stderr/activity summary. Only the metric keys are carried — never raw page
/// text, secrets, or snapshots.
pub(crate) fn browser_protocol_journal_event(
    call_id: &str,
    boundary: &str,
    metrics: &serde_json::Value,
) -> local_first_engine::execution_journal::AgentExecutionEvent {
    const ALLOWED: &[&str] = &[
        "observation_chars",
        "refs",
        "action_kinds",
        "stop_reason",
        "generation",
        "completed_actions",
        "unexecuted_actions",
        "minimum_items",
        "contract_fields",
        "contract_fp",
        "item_count",
        "fields_missing",
        "status",
        "elapsed_ms",
        "schema_version",
        "target_count",
        "recovery_tier",
        "restored_count",
        "skipped_count",
        "draft_control_count",
        "omitted_sensitive_count",
        "omitted_bounded_count",
        "reason",
    ];
    let mut redacted = serde_json::Map::new();
    redacted.insert(
        "child_run_id".to_string(),
        serde_json::Value::String(call_id.to_string()),
    );
    if let Some(obj) = metrics.as_object() {
        for key in ALLOWED {
            if let Some(v) = obj.get(*key) {
                redacted.insert((*key).to_string(), v.clone());
            }
        }
    }
    local_first_engine::execution_journal::AgentExecutionEvent::BrowserProtocol {
        round: 0,
        boundary: boundary.to_string(),
        payload: serde_json::Value::Object(redacted),
    }
}

pub(crate) fn browser_action_kinds(action: &serde_json::Value) -> Vec<String> {
    if let Some(actions) = action.get("actions").and_then(serde_json::Value::as_array) {
        return actions
            .iter()
            .filter_map(|action| action.get("kind").and_then(serde_json::Value::as_str))
            .map(str::to_string)
            .collect();
    }
    action
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .map(|kind| vec![kind.to_string()])
        .unwrap_or_default()
}

pub(crate) fn browser_observation_metrics(
    value: &serde_json::Value,
    action_kinds: Vec<String>,
    stop_reason: &str,
) -> serde_json::Value {
    let observation_chars = value
        .get("stats")
        .and_then(|stats| stats.get("chars"))
        .and_then(serde_json::Value::as_u64)
        .or_else(|| {
            value
                .get("snapshot")
                .and_then(serde_json::Value::as_str)
                .map(|snapshot| snapshot.chars().count() as u64)
        })
        .unwrap_or(0);
    let refs = value
        .get("stats")
        .and_then(|stats| stats.get("refs"))
        .and_then(serde_json::Value::as_u64)
        .or_else(|| {
            value
                .get("refs")
                .and_then(serde_json::Value::as_array)
                .map(|refs| refs.len() as u64)
        })
        .unwrap_or(0);
    serde_json::json!({
        "observation_chars": observation_chars,
        "refs": refs,
        "action_kinds": action_kinds,
        "stop_reason": stop_reason,
        "generation": value.get("generation").and_then(serde_json::Value::as_u64).unwrap_or(0),
        // `completedActions` is a BATCH field; a single action does not carry it, so it used to log as
        // 0 — indistinguishable from "nothing executed" while reading a post-mortem. Fall back to the
        // action's own ok flag so a successful single action reports 1.
        "completed_actions": value
            .get("completedActions")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_else(|| u64::from(value.get("ok").and_then(serde_json::Value::as_bool).unwrap_or(false))),
        "unexecuted_actions": value.get("unexecutedActions").and_then(serde_json::Value::as_array).map(|actions| actions.len() as u64).unwrap_or(0),
    })
}

pub(crate) fn browser_contract_fingerprint(
    contract: &Option<local_first_engine::browse::BrowseResultContract>,
) -> Option<String> {
    let contract = contract.as_ref()?;
    let encoded = serde_json::to_string(contract).ok()?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    std::hash::Hash::hash(&encoded, &mut hasher);
    Some(format!("{:016x}", std::hash::Hasher::finish(&hasher)))
}

pub(crate) fn push_browser_step(label: String, status: &str) {
    eprintln!("browser-step[{status}]: {label}");
    touch_cc_activity();
    if let Ok(mut guard) = browser_activity_cell().write()
        && let Some(state) = guard.as_mut()
    {
        // Cap the visible log so a long run can't grow unbounded.
        if state.steps.len() < 60 {
            state.steps.push(BrowserStepView {
                label,
                status: status.to_string(),
            });
        }
    }
}

pub(crate) fn end_browser_activity() {
    if let Ok(mut guard) = browser_activity_cell().write() {
        *guard = None;
    }
}

pub(crate) fn current_browser_activity() -> Option<BrowserActivityState> {
    browser_activity_cell()
        .read()
        .ok()
        .and_then(|guard| guard.clone())
}

/// One executed terminal command + its output, for the "computer terminal" panel
/// (the Manus-style view of CLI skill execution in the contained computer).
#[derive(Debug, Clone, Serialize)]
pub(crate) struct TerminalEntryView {
    pub(crate) thread_id: Option<String>,
    pub(crate) command: String,
    pub(crate) output: String,
    pub(crate) running: bool,
}

pub(crate) fn sandbox_owner_cell() -> &'static std::sync::RwLock<Option<String>> {
    static CELL: std::sync::OnceLock<std::sync::RwLock<Option<String>>> =
        std::sync::OnceLock::new();
    CELL.get_or_init(|| std::sync::RwLock::new(None))
}

pub(crate) fn sandbox_activity_cell() -> &'static std::sync::RwLock<Vec<TerminalEntryView>> {
    static CELL: std::sync::OnceLock<std::sync::RwLock<Vec<TerminalEntryView>>> =
        std::sync::OnceLock::new();
    CELL.get_or_init(|| std::sync::RwLock::new(Vec::new()))
}

/// Resets the terminal buffer — called when a new chat request starts so the
/// panel shows the CURRENT request's commands, then stays visible (with output)
/// until the next request replaces it.
pub(crate) fn sandbox_clear(thread_id: Option<String>) {
    if let Ok(mut owner) = sandbox_owner_cell().write() {
        *owner = thread_id;
    }
    if let Ok(mut guard) = sandbox_activity_cell().write() {
        guard.clear();
    }
}

/// Records a command about to run (output filled in by `sandbox_end`).
pub(crate) fn sandbox_begin(command: String, thread_id: Option<String>) {
    touch_cc_activity();
    if let Ok(mut owner) = sandbox_owner_cell().write() {
        *owner = thread_id.clone();
    }
    if let Ok(mut guard) = sandbox_activity_cell().write() {
        if guard.len() >= 20 {
            guard.remove(0);
        }
        guard.push(TerminalEntryView {
            thread_id,
            command,
            output: String::new(),
            running: true,
        });
    }
}

/// Attaches the output to the most recent running command and marks it done.
pub(crate) fn sandbox_end(output: String) {
    if let Ok(mut guard) = sandbox_activity_cell().write()
        && let Some(entry) = guard.iter_mut().rev().find(|entry| entry.running)
    {
        entry.output = output.chars().take(4000).collect();
        entry.running = false;
    }
}

pub(crate) fn current_sandbox_activity() -> Vec<TerminalEntryView> {
    sandbox_activity_cell()
        .read()
        .ok()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

pub(crate) fn current_sandbox_owner() -> Option<String> {
    sandbox_owner_cell()
        .read()
        .ok()
        .and_then(|guard| guard.clone())
}
