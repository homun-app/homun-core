//! Structured stream events the engine emits for a turn (ADR 0024, inc 5a). Moved out of the
//! heavy `subagents` crate so the engine (leaf, serde-only) OWNS its output-event vocabulary;
//! the gateway/broker map these onto the transport (NDJSON body + unified WS). `subagents`
//! re-exports them for back-compat, so existing `local_first_subagents::*` paths still resolve.

use serde::{Deserialize, Serialize};

/// ADR 0022 (Piano UI) — un singolo hit richiamato dalla memoria.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecallStreamHit {
    /// Riferimento stabile del record memoria.
    pub r#ref: String,
    /// Testo/summary del record.
    pub text: String,
    /// Score di rilevanza (0.0-1.0, ibrido RRF).
    pub score: f32,
    /// `memory_type` del record (decision/fact/goal/…).
    #[serde(rename = "type")]
    pub kind: String,
}

/// ADR 0022 (Piano UI A2/A3) — payload dell'evento `Recall` stream. Shape identica
/// al frontend `RecallEventPayload`: `scope` rispetta l'invariant Personale↔Progetto.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecallStreamPayload {
    /// La query usata per la recall.
    pub query: String,
    /// Gli hits richiamati (vuoto se nessun match).
    pub hits: Vec<RecallStreamHit>,
    /// Scope della recall ("personal" | "project").
    pub scope: String,
}

/// Piano UI D3: payload di una modifica di codice proposta (diff inline).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiffStreamPayload {
    /// Path del file modificato.
    pub path: String,
    /// Etichetta opzionale (es. "Edit file X").
    pub label: Option<String>,
    /// Contenuto precedente (None se file nuovo).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old: Option<String>,
    /// Contenuto nuovo.
    pub new: String,
    /// Linguaggio per l'evidenziazione (es. "rust", "ts").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TokenMetrics {
    pub prompt_tokens: u32,
    pub generation_tokens: u32,
    pub prompt_tps: f64,
    pub generation_tps: f64,
    pub peak_memory_gb: f64,
    pub elapsed_seconds: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GenerateStreamEvent {
    Delta {
        text: String,
    },
    Reasoning {
        text: String,
    },
    Activity {
        text: String,
    },
    PlanUpdate {
        markdown: String,
    },
    ChoicePrompt {
        payload: serde_json::Value,
    },
    VaultPropose {
        payload: serde_json::Value,
    },
    VaultReveal {
        payload: serde_json::Value,
    },
    PaymentApproval {
        payload: serde_json::Value,
    },
    ToolResult {
        payload: serde_json::Value,
    },
    /// Piano UI D3: una modifica di codice proposta dal modello (path + contenuto
    /// prima/dopo), renderizzata inline come diff. Il modello emette il marker
    /// `‹‹DIFF››{json}‹‹/DIFF››` nel text; il gateway lo espande in questo evento.
    Diff {
        payload: DiffStreamPayload,
    },
    /// ADR 0022 (Piano UI A2/A3): risultato di una recall RAG episodica — ciò che
    /// l'agente ha richiamato dalla memoria per questo turno. Shape identica al
    /// frontend `RecallEventPayload` (A1), così il parse è trasparente.
    Recall {
        payload: RecallStreamPayload,
    },
    Done {
        text: String,
        metrics: TokenMetrics,
        #[serde(skip_serializing_if = "Option::is_none")]
        redacted_user_text: Option<String>,
    },
    Error {
        code: String,
        message: String,
    },
}

impl TokenMetrics {
    pub fn zero() -> Self {
        Self {
            prompt_tokens: 0,
            generation_tokens: 0,
            prompt_tps: 0.0,
            generation_tps: 0.0,
            peak_memory_gb: 0.0,
            elapsed_seconds: 0.0,
        }
    }
}
