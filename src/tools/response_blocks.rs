//! Rich response blocks for native UI rendering on capable clients.
//!
//! Tools can return `ResponseBlock` items alongside their text output.
//! Capable clients (Flutter, Web UI) render them as interactive cards;
//! other channels fall back to the markdown in the tool's text output.

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ─── Block Types ────────────────────────────────────────────────

/// A rich response block produced by a tool.
/// Tagged by `block_type` for JSON (de)serialization.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "block_type", rename_all = "snake_case")]
pub enum ResponseBlock {
    /// Pick one from N options (trains, flights, restaurants…).
    Choice(ChoiceBlock),
    /// Approve or reject an action (booking, payment…).
    Approval(ApprovalBlock),
    /// Progress or state display (order tracking, task status).
    Status(StatusBlock),
    /// Structured result display (boarding pass, receipt).
    Result(ResultBlock),
    /// Message from an external system (email preview, notification).
    ExternalMessage(ExternalMessageBlock),
}

// ─── Choice ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChoiceBlock {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    pub options: Vec<BlockOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BlockOption {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

// ─── Approval ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ApprovalBlock {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub approve_label: String,
    pub deny_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

// ─── Status ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StatusBlock {
    pub id: String,
    pub title: String,
    pub status: BlockStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<KeyValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BlockStatus {
    Pending,
    Active,
    Completed,
    Failed,
}

// ─── Result ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResultBlock {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<KeyValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

// ─── External Message ───────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExternalMessageBlock {
    pub id: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    pub preview: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

// ─── Shared ─────────────────────────────────────────────────────

/// A key-value pair for structured display fields.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KeyValue {
    pub label: String,
    pub value: String,
}

// ─── Inbound Block Response ─────────────────────────────────────

/// Sent by the client when a user interacts with a block (taps an option, approves, etc.).
/// Travels as `block_response` alongside the regular message `content`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BlockResponse {
    pub block_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

// ─── Tests ──────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn choice_block_roundtrip() {
        let block = ResponseBlock::Choice(ChoiceBlock {
            id: "blk_1".into(),
            title: "Treni Roma → Milano".into(),
            subtitle: None,
            options: vec![BlockOption {
                id: "opt1".into(),
                label: "14:30 → 17:45".into(),
                subtitle: Some("€49.90".into()),
                icon: None,
                metadata: Some(serde_json::json!({"provider": "trenitalia", "train_id": "TR123"})),
            }],
        });

        let json = serde_json::to_string(&block).unwrap();
        assert!(json.contains("\"block_type\":\"choice\""));
        assert!(json.contains("\"train_id\":\"TR123\""));

        let deserialized: ResponseBlock = serde_json::from_str(&json).unwrap();
        assert_eq!(block, deserialized);
    }

    #[test]
    fn approval_block_roundtrip() {
        let block = ResponseBlock::Approval(ApprovalBlock {
            id: "blk_approve_1".into(),
            title: "Conferma prenotazione".into(),
            description: Some("Frecciarossa 14:30, 1a classe, €49.90".into()),
            approve_label: "Prenota".into(),
            deny_label: "Annulla".into(),
            metadata: None,
        });

        let json = serde_json::to_string(&block).unwrap();
        let deserialized: ResponseBlock = serde_json::from_str(&json).unwrap();
        assert_eq!(block, deserialized);
    }

    #[test]
    fn status_block_roundtrip() {
        let block = ResponseBlock::Status(StatusBlock {
            id: "blk_status_1".into(),
            title: "Prenotazione TR123".into(),
            status: BlockStatus::Active,
            fields: vec![KeyValue {
                label: "Partenza".into(),
                value: "Roma Termini 14:30".into(),
            }],
        });

        let json = serde_json::to_string(&block).unwrap();
        assert!(json.contains("\"status\":\"active\""));
        let deserialized: ResponseBlock = serde_json::from_str(&json).unwrap();
        assert_eq!(block, deserialized);
    }

    #[test]
    fn block_response_roundtrip() {
        let resp = BlockResponse {
            block_id: "blk_1".into(),
            option_id: Some("opt1".into()),
            action: None,
            metadata: Some(serde_json::json!({"train_id": "TR123"})),
        };

        let json = serde_json::to_string(&resp).unwrap();
        let deserialized: BlockResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(resp, deserialized);
    }
}
