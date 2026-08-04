//! Persisted runtime settings owner.
//!
//! Owns the runtime settings DTO, defaults, partial patch merge semantics, and
//! get/set routes used by the desktop Settings runtime controls.

use super::*;

#[test]
fn runtime_settings_owner_smoke() {
    let current = RuntimeSettings::default();
    let merged = merge_runtime_settings(&current, &serde_json::json!({"approval_policy": "never"}));
    assert_eq!(merged.approval_policy, "never");
    assert_eq!(merged.sandbox_mode, current.sandbox_mode);
}

/// User-editable runtime/behaviour settings persisted in the data dir. One small
/// JSON, separate from the channel settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RuntimeSettings {
    /// The persisted source for `resolved_sandbox_mode` (ADR 0023): `read-only` |
    /// `workspace-write` (default) | `danger`. `#[serde(default)]` means older
    /// settings files without the field deserialize to the default (workspace-write)
    /// on upgrade — no behavior change. Exposed in Settings by a later UI task.
    #[serde(default = "default_sandbox_mode")]
    pub(crate) sandbox_mode: String,

    /// The persisted source for `resolved_approval_policy` (ADR 0023): `untrusted` |
    /// `on-failure` | `on-request` (default) | `never`. Same upgrade semantics as
    /// `sandbox_mode`. Exposed in Settings by a later UI task.
    #[serde(default = "default_approval_policy")]
    pub(crate) approval_policy: String,

    /// Phase 2 (per-project sandbox policy): the GLOBAL default set of extra writable
    /// folders granted to the exec fence, beyond the always-writable project root. Empty
    /// (default) = just the project root. Absolute paths; non-existent/relative entries are
    /// dropped at resolve time. A per-workspace `WorkspaceRecord.writable_roots` override
    /// REPLACES this list for that project. `#[serde(default)]` = legacy files upgrade clean.
    #[serde(default)]
    pub(crate) writable_roots: Vec<String>,

    /// Phase 3 (per-project skill confirmations): the GLOBAL default set of sensitive
    /// categories (`delete|financial|medical|sensitive-data`) that must ALWAYS force a
    /// confirmation, whatever skill is active. Empty (default) = none forced globally. A
    /// per-workspace `WorkspaceRecord.skill_confirmations` override REPLACES this list.
    #[serde(default)]
    pub(crate) skill_confirmations: Vec<String>,

    /// Auto-start the local computer (the contained Docker sandbox) at app launch, OPENING
    /// Docker if it's closed. Default ON: the sandbox powers skills + the browser, so warming
    /// it at boot avoids a cold start (Docker Desktop takes 1-2 min) on first use. Users who
    /// don't want Docker spun up every launch can turn it off — then boot stays non-intrusive
    /// (warm up only if Docker is already running). `#[serde(default = …)]` = legacy files → ON.
    #[serde(default = "default_local_computer_autostart")]
    pub(crate) local_computer_autostart: bool,

    /// Optional Apple Silicon Mac Apps beta. Legacy settings files omit this field,
    /// which must remain equivalent to an explicit opt-out.
    #[serde(default)]
    pub(crate) mac_apps_beta_enabled: bool,
}

/// Default persisted sandbox mode = `workspace-write` (see `resolved_sandbox_mode`:
/// behavior-preserving on this line; NOT `danger`).
pub(crate) fn default_sandbox_mode() -> String {
    crate::tool_safety::SandboxMode::WorkspaceWrite
        .as_str()
        .to_string()
}

/// Default persisted approval policy = `on-request` (behavior-preserving).
pub(crate) fn default_approval_policy() -> String {
    crate::tool_safety::AskForApproval::OnRequest
        .as_str()
        .to_string()
}

/// Default = ON: warm up the local computer at boot (opening Docker if needed).
pub(crate) fn default_local_computer_autostart() -> bool {
    true
}

impl Default for RuntimeSettings {
    fn default() -> Self {
        Self {
            sandbox_mode: default_sandbox_mode(),
            approval_policy: default_approval_policy(),
            writable_roots: Vec::new(),
            skill_confirmations: Vec::new(),
            local_computer_autostart: default_local_computer_autostart(),
            mac_apps_beta_enabled: false,
        }
    }
}

pub(crate) fn runtime_settings_path() -> Option<PathBuf> {
    gateway_data_dir()
        .ok()
        .map(|dir| dir.join("runtime-settings.json"))
}

pub(crate) fn load_runtime_settings() -> RuntimeSettings {
    runtime_settings_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub(crate) fn mac_apps_beta_enabled() -> bool {
    load_runtime_settings().mac_apps_beta_enabled
}

pub(crate) fn save_runtime_settings(settings: &RuntimeSettings) -> Result<(), String> {
    let path = runtime_settings_path().ok_or_else(|| "data dir unavailable".to_string())?;
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

/// Overlay a PARTIAL settings patch (top-level keys only) onto `current`, then normalize
/// every axis. Pure so the merge is unit-testable. Any key ABSENT from `patch` is
/// preserved from `current`: each Settings control (sandbox / approval)
/// posts only its own field, so a naive whole-struct deserialize would let one control
/// silently reset the others to their serde defaults (a real clobber once >1 control
/// exists). Extra/unknown keys in the patch are dropped by the RuntimeSettings decode.
pub(crate) fn merge_runtime_settings(
    current: &RuntimeSettings,
    patch: &serde_json::Value,
) -> RuntimeSettings {
    let mut base = serde_json::to_value(current).unwrap_or_else(|_| serde_json::json!({}));
    if let (Some(base_obj), Some(patch_obj)) = (base.as_object_mut(), patch.as_object()) {
        for (key, value) in patch_obj {
            base_obj.insert(key.clone(), value.clone());
        }
    }
    let mut merged: RuntimeSettings =
        serde_json::from_value(base).unwrap_or_else(|_| current.clone());
    // Normalize each axis to a token the resolvers accept (unknown → safe default).
    merged.sandbox_mode = crate::tool_safety::SandboxMode::parse(&merged.sandbox_mode)
        .as_str()
        .to_string();
    merged.approval_policy = crate::tool_safety::AskForApproval::parse(&merged.approval_policy)
        .as_str()
        .to_string();
    merged
}

pub(crate) async fn get_runtime_settings() -> Json<RuntimeSettings> {
    Json(load_runtime_settings())
}

pub(crate) async fn set_runtime_settings(
    Json(patch): Json<serde_json::Value>,
) -> Result<Json<RuntimeSettings>, GatewayError> {
    // PATCH semantics: merge the caller's partial patch onto the persisted settings so one
    // Settings control never clobbers another (see `merge_runtime_settings`). The full,
    // normalized object is persisted and returned.
    let current = load_runtime_settings();
    let merged = merge_runtime_settings(&current, &patch);
    save_runtime_settings(&merged).map_err(|message| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "runtime_settings_save",
        message,
    })?;
    if current.mac_apps_beta_enabled && !merged.mac_apps_beta_enabled {
        host_computer_gateway::disable().await;
    }
    Ok(Json(merged))
}
