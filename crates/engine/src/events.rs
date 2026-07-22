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
    /// Workspace canonico della fonte realmente consultata.
    pub source_workspace_id: String,
    /// Etichetta della fonte risolta dal gateway al momento del turno.
    pub source_label: String,
    /// Raccolta di sistema che ha autorizzato/classificato il record.
    pub collection: String,
    /// Grant che ha autorizzato una fonte collegata; `null` denotes the local
    /// source. Keeping the null explicit lets UI authorization fail closed for
    /// legacy events that did not carry provenance.
    pub grant_id: Option<String>,
    /// Policy version used by a linked grant. Legacy/local hits deserialize as
    /// `None`, so consumers can distinguish unversioned provenance explicitly.
    #[serde(default)]
    pub policy_version: Option<u64>,
    /// Fingerprint della revisione esatta del record autorizzato. Legacy e hit
    /// locali possono non averlo; una lettura collegata senza revisione non è
    /// riusabile in modo sicuro.
    #[serde(default)]
    pub source_revision: Option<String>,
    /// Il coordinatore ha rilevato un conflitto semantico con un altro hit.
    pub conflict: bool,
    /// Relazioni canoniche percorse dal seed della query fino a questo hit.
    /// Vuoto per una corrispondenza diretta e per gli eventi storici.
    #[serde(default)]
    pub graph_path: Vec<String>,
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
    /// Stato operativo della memoria. `empty` e `unavailable` sono distinti:
    /// nessun match non deve essere scambiato per una connessione guasta.
    #[serde(default = "default_recall_status")]
    pub status: String,
}

fn default_recall_status() -> String {
    "ready".to_string()
}

/// Una lettura collegata realmente iniettata nel modello. Contiene solo
/// identificativi e versioni: il testo della source non viene duplicato.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct LinkedMemoryRead {
    pub source_workspace_id: String,
    pub grant_id: String,
    pub policy_version: u64,
    pub memory_ref: String,
    pub source_revision: String,
}

/// Provenance cumulativa delle memorie collegate usate durante un turno.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnMemoryReadSet {
    pub linked: Vec<LinkedMemoryRead>,
    /// È stata osservata provenance che sembrava collegata ma non era completa.
    /// Il gateway deve convertirla in una policy fail-closed.
    pub blocked_unknown: bool,
}

impl TurnMemoryReadSet {
    /// Unisce gli hit completi del payload. Gli hit locali e la provenance
    /// legacy/incompleta non possono diventare autorizzazione implicita.
    pub fn extend_payload(&mut self, payload: &RecallStreamPayload) {
        for hit in &payload.hits {
            let Some(grant_id) = hit.grant_id.as_ref().map(|value| value.trim()) else {
                if hit.policy_version.is_some() || hit.source_revision.is_some() {
                    self.blocked_unknown = true;
                }
                continue;
            };
            let Some(policy_version) = hit.policy_version else {
                self.blocked_unknown = true;
                continue;
            };
            let Some(source_revision) = hit.source_revision.as_ref().map(|value| value.trim()) else {
                self.blocked_unknown = true;
                continue;
            };
            let source_workspace_id = hit.source_workspace_id.trim();
            let memory_ref = hit.r#ref.trim();
            if grant_id.is_empty()
                || policy_version == 0
                || source_revision.is_empty()
                || source_workspace_id.is_empty()
                || memory_ref.is_empty()
            {
                self.blocked_unknown = true;
                continue;
            }
            self.linked.push(LinkedMemoryRead {
                source_workspace_id: source_workspace_id.to_string(),
                grant_id: grant_id.to_string(),
                policy_version,
                memory_ref: memory_ref.to_string(),
                source_revision: source_revision.to_string(),
            });
        }
        self.linked.sort();
        self.linked.dedup();
    }

    pub fn extend(&mut self, other: Self) {
        self.blocked_unknown |= other.blocked_unknown;
        self.linked.extend(other.linked);
        self.linked.sort();
        self.linked.dedup();
    }

    pub fn has_linked_reads(&self) -> bool {
        !self.linked.is_empty()
    }

    pub fn is_blocked_unknown(&self) -> bool {
        self.blocked_unknown
    }
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
        #[serde(default)]
        retryable: bool,
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

#[cfg(test)]
mod tests {
    use super::{RecallStreamHit, RecallStreamPayload, TurnMemoryReadSet};

    #[test]
    fn recall_stream_hit_serializes_source_provenance() {
        let hit = RecallStreamHit {
            r#ref: "memory:owner:project-a:1".to_string(),
            text: "Launch in September".to_string(),
            score: 0.91,
            kind: "decision".to_string(),
            source_workspace_id: "project-a".to_string(),
            source_label: "Homun roadmap".to_string(),
            collection: "decisions".to_string(),
            grant_id: Some("grant-a".to_string()),
            policy_version: Some(7),
            source_revision: Some("sha256:revision-a".to_string()),
            conflict: false,
            graph_path: vec!["mentions".to_string(), "mentions".to_string()],
        };
        let mut value = serde_json::to_value(hit).expect("serialize recall hit");
        assert_eq!(value["source_workspace_id"], "project-a");
        assert_eq!(value["collection"], "decisions");
        assert_eq!(value["grant_id"], "grant-a");
        assert_eq!(value["policy_version"], 7);
        assert_eq!(value["source_revision"], "sha256:revision-a");
        assert_eq!(
            value["graph_path"],
            serde_json::json!(["mentions", "mentions"])
        );
        value.as_object_mut().unwrap().remove("policy_version");
        value.as_object_mut().unwrap().remove("source_revision");
        value.as_object_mut().unwrap().remove("graph_path");
        let legacy: RecallStreamHit = serde_json::from_value(value).expect("legacy recall hit");
        assert_eq!(legacy.policy_version, None);
        assert_eq!(legacy.source_revision, None);
        assert!(legacy.graph_path.is_empty());
    }

    #[test]
    fn linked_recall_hit_round_trips_its_source_revision() {
        let hit = RecallStreamHit {
            r#ref: "memory:owner:source:fact-1".to_string(),
            text: "A linked fact".to_string(),
            score: 0.9,
            kind: "fact".to_string(),
            source_workspace_id: "source".to_string(),
            source_label: "Source".to_string(),
            collection: "knowledge".to_string(),
            grant_id: Some("grant-1".to_string()),
            policy_version: Some(7),
            source_revision: Some("sha256:abc".to_string()),
            conflict: false,
            graph_path: Vec::new(),
        };
        let mut value = serde_json::to_value(hit).expect("serialize recall hit");
        assert_eq!(value["source_revision"], "sha256:abc");
        let decoded: RecallStreamHit =
            serde_json::from_value(value.clone()).expect("round-trip recall hit");
        assert_eq!(decoded.source_revision.as_deref(), Some("sha256:abc"));
        value.as_object_mut().unwrap().remove("source_revision");
        let legacy: RecallStreamHit = serde_json::from_value(value).expect("legacy recall hit");
        assert_eq!(legacy.source_revision, None);
    }

    #[test]
    fn turn_read_set_keeps_only_complete_linked_reads_and_deduplicates() {
        let linked = RecallStreamHit {
            r#ref: "memory:owner:source:fact-1".to_string(),
            text: "A linked fact".to_string(),
            score: 0.9,
            kind: "fact".to_string(),
            source_workspace_id: "source".to_string(),
            source_label: "Source".to_string(),
            collection: "knowledge".to_string(),
            grant_id: Some("grant-1".to_string()),
            policy_version: Some(7),
            source_revision: Some("sha256:abc".to_string()),
            conflict: false,
            graph_path: Vec::new(),
        };
        let mut local = linked.clone();
        local.grant_id = None;
        local.policy_version = None;
        local.source_revision = None;
        let mut incomplete = linked.clone();
        incomplete.source_revision = None;
        let payload = RecallStreamPayload {
            query: "fact".to_string(),
            hits: vec![linked.clone(), local, incomplete, linked],
            scope: "project".to_string(),
            status: "ready".to_string(),
        };
        let mut reads = TurnMemoryReadSet::default();
        reads.extend_payload(&payload);
        assert_eq!(reads.linked.len(), 1);
        assert!(reads.blocked_unknown);
        assert_eq!(reads.linked[0].grant_id, "grant-1");
        assert_eq!(reads.linked[0].policy_version, 7);
        assert_eq!(reads.linked[0].memory_ref, "memory:owner:source:fact-1");
        assert_eq!(reads.linked[0].source_revision, "sha256:abc");
    }
}
