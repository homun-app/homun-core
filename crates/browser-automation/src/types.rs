use crate::{BrowserAutomationError, BrowserResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BrowserMethod {
    #[serde(rename = "browser.health")]
    Health,
    #[serde(rename = "browser.profiles")]
    Profiles,
    #[serde(rename = "browser.start")]
    Start,
    #[serde(rename = "browser.stop")]
    Stop,
    #[serde(rename = "browser.tabs")]
    Tabs,
    #[serde(rename = "browser.open")]
    Open,
    #[serde(rename = "browser.focus")]
    Focus,
    #[serde(rename = "browser.close_tab")]
    CloseTab,
    #[serde(rename = "browser.navigate")]
    Navigate,
    #[serde(rename = "browser.snapshot")]
    Snapshot,
    #[serde(rename = "browser.checkpoint")]
    Checkpoint,
    #[serde(rename = "browser.restore")]
    Restore,
    #[serde(rename = "browser.rehydrate")]
    Rehydrate,
    #[serde(rename = "browser.screenshot")]
    Screenshot,
    #[serde(rename = "browser.act")]
    Act,
    #[serde(rename = "browser.arm_file_chooser")]
    ArmFileChooser,
    #[serde(rename = "browser.respond_dialog")]
    RespondDialog,
    #[serde(rename = "browser.wait_download")]
    WaitDownload,
    #[serde(rename = "browser.console")]
    Console,
    #[serde(rename = "browser.pdf")]
    Pdf,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct BrowserRequest {
    pub id: String,
    pub method: BrowserMethod,
    pub params: Value,
}

impl BrowserRequest {
    pub fn new(id: impl Into<String>, method: BrowserMethod, params: Value) -> Self {
        Self {
            id: id.into(),
            method,
            params,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserSidecarError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub manual_action_required: bool,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum BrowserResponse {
    Success {
        id: String,
        ok: bool,
        result: Value,
    },
    Error {
        id: String,
        ok: bool,
        error: BrowserSidecarError,
    },
}

impl BrowserResponse {
    pub fn id(&self) -> &str {
        match self {
            Self::Success { id, .. } | Self::Error { id, .. } => id,
        }
    }

    pub fn result(&self) -> BrowserResult<&Value> {
        match self {
            Self::Success {
                ok: true, result, ..
            } => Ok(result),
            Self::Success { .. } => Err(BrowserAutomationError::InvalidResponse(
                "success response has ok=false".to_string(),
            )),
            Self::Error { error, .. } => Err(BrowserAutomationError::Sidecar(format!(
                "{}:{}",
                error.code, error.message
            ))),
        }
    }

    pub fn error(&self) -> Option<&BrowserSidecarError> {
        match self {
            Self::Error { error, .. } => Some(error),
            Self::Success { .. } => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserActKind {
    Click,
    ClickCoords,
    Type,
    FillForm,
    PressKey,
    Press,
    Hover,
    Drag,
    SelectOption,
    Select,
    Fill,
    Scroll,
    Resize,
    Wait,
    Evaluate,
    Close,
}

pub const MAX_BROWSER_DRAFT_CONTROLS: usize = 32;
pub const MAX_BROWSER_DRAFT_VALUE_CHARS: usize = 2_000;
pub const MAX_BROWSER_DRAFT_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDraftControl {
    pub draft_ref: String,
    pub tag: String,
    #[serde(rename = "type")]
    pub control_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autocomplete: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub form_id: Option<String>,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCheckpoint {
    pub schema_version: u8,
    pub target_id: String,
    pub url: String,
    pub origin: String,
    pub browser_epoch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cdp_target_id: Option<String>,
    pub generation: u64,
    pub controls: Vec<BrowserDraftControl>,
    pub omitted_sensitive_count: u64,
    pub omitted_bounded_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRestoreRequest {
    pub target_id: String,
    pub url: String,
    pub origin: String,
    pub browser_epoch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cdp_target_id: Option<String>,
    pub generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserRestoreTier {
    AdoptedLivePage,
    DraftAvailable,
    DegradedUrlOnly,
}

impl BrowserRestoreTier {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AdoptedLivePage => "adopted_live_page",
            Self::DraftAvailable => "draft_available",
            Self::DegradedUrlOnly => "degraded_url_only",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRestoreResult {
    pub tier: BrowserRestoreTier,
    pub target_id: String,
    pub generation: u64,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRehydrateResult {
    pub rehydrated: u64,
    pub skipped: u64,
    pub generation: u64,
}
