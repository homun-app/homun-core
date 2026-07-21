use crate::grants::GrantLevel;
use serde::{Deserialize, Serialize};

pub const PROTECTED_BUNDLE_IDS: &[&str] = &[
    "com.apple.loginwindow",
    "com.apple.SecurityAgent",
    "com.apple.LocalAuthentication.UIAgent",
    "com.1password.1password",
    "com.agilebits.onepassword7",
    "com.bitwarden.desktop",
    "com.lastpass.LastPass",
    "com.dashlane.Dashlane",
];

pub const TERMINAL_BUNDLE_IDS: &[&str] = &[
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "dev.warp.Warp-Stable",
    "dev.warp.Warp",
];

pub fn is_protected_bundle_id(bundle_id: &str) -> bool {
    let normalized = bundle_id.to_ascii_lowercase();
    PROTECTED_BUNDLE_IDS.contains(&bundle_id)
        || ["1password", "bitwarden", "lastpass", "dashlane"]
            .iter()
            .any(|marker| normalized.contains(marker))
}

pub fn is_terminal_bundle_id(bundle_id: &str) -> bool {
    TERMINAL_BUNDLE_IDS.contains(&bundle_id)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionCategory {
    Observe,
    Reversible,
    TextEntry,
    FileWrite,
    ExternalCommunication,
    Purchase,
    SystemSettings,
    Destructive,
    CredentialInput,
    TerminalInput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HardDeny {
    CredentialInput,
    TerminalInput,
    ProtectedTarget,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyDecision {
    Allowed,
    GrantRequired(GrantLevel),
    ApprovalRequired(ActionCategory),
    Denied(HardDeny),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyRequest {
    pub category: ActionCategory,
    pub protected_target: bool,
    pub low_risk_typing_enabled: bool,
    pub approval_matches: bool,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct HostActionPolicy;

impl HostActionPolicy {
    pub fn decide(&self, grant: Option<GrantLevel>, request: &PolicyRequest) -> PolicyDecision {
        if request.protected_target {
            return PolicyDecision::Denied(HardDeny::ProtectedTarget);
        }
        match request.category {
            ActionCategory::CredentialInput => {
                return PolicyDecision::Denied(HardDeny::CredentialInput);
            }
            ActionCategory::TerminalInput => {
                return PolicyDecision::Denied(HardDeny::TerminalInput);
            }
            _ => {}
        }
        let required = if request.category == ActionCategory::Observe {
            GrantLevel::Observe
        } else {
            GrantLevel::Control
        };
        let sufficient = matches!(
            (grant, required),
            (Some(GrantLevel::Control), _) | (Some(GrantLevel::Observe), GrantLevel::Observe)
        );
        if !sufficient {
            return PolicyDecision::GrantRequired(required);
        }
        let approval_required = match request.category {
            ActionCategory::Observe | ActionCategory::Reversible => false,
            ActionCategory::TextEntry => !request.low_risk_typing_enabled,
            ActionCategory::FileWrite
            | ActionCategory::ExternalCommunication
            | ActionCategory::Purchase
            | ActionCategory::SystemSettings
            | ActionCategory::Destructive => true,
            ActionCategory::CredentialInput | ActionCategory::TerminalInput => unreachable!(),
        };
        if approval_required && !request.approval_matches {
            PolicyDecision::ApprovalRequired(request.category)
        } else {
            PolicyDecision::Allowed
        }
    }
}
