//! ADR 0022 (Tappa 4) — orchestrazione del recall RAG episodico, spostata dal
//! gateway monolite nel crate memoria.
//!
//! Questo modulo contiene i **building block puri** del recall (scoring, dedup,
//! formatting, tipi) — senza dipendenze HTTP/LLM. L'embedding e l'LLM sono
//! astratti dai capability trait [`EmbeddingClient`] / [`LlmClient`]: il crate
//! resta puro (niente reqwest/tokio), il gateway impl i trait. Pattern =
//! `MemoryVectorIndex`.
//!
//! La funzione di orchestrazione `recall_on_facade` (Step 1) vive qui.

use std::collections::HashSet;

use serde::Serialize;

use crate::BoxFuture;

// ──────────────────────────────────────────────────────────────────────────
// Capability trait — embedding + LLM astratti (impl nel gateway)
// ──────────────────────────────────────────────────────────────────────────

/// Capability: produce l'embedding di un testo. Impl nel gateway (HTTP verso
/// il modello di embedding, con cache LRU+TTL). Nel crate, i test usano una
/// impl mock deterministica.
pub trait EmbeddingClient: Send + Sync {
    /// Embed di `text` → vettore denso. Restituisce vuoto se degradato (recall
    /// cade sul solo passaggio lessicale/FTS, come già fa il gateway).
    fn embed<'a>(&'a self, text: &'a str) -> BoxFuture<'a, Vec<f32>>;
}

/// Capability: chiamata LLM one-shot (system + user → risposta testuale, di
/// solito JSON). Usato dall'estrattore (`learn`) e dal curatore (`consolidate`).
/// Impl nel gateway (HTTP `/chat/completions` + provider registry). Nei test,
/// impl mock che ritorna JSON fissi.
pub trait LlmClient: Send + Sync {
    fn chat<'a>(&'a self, system: &'a str, user: &'a str) -> BoxFuture<'a, Option<String>>;
}

// ──────────────────────────────────────────────────────────────────────────
// Tipi puri del recall
// ──────────────────────────────────────────────────────────────────────────

/// Candidato recall con i due rank (FTS lessicale + denso vettoriale) e gli
/// attributi per il refinement (importanza + recency). Spostato fedelmente dal
/// gateway (`main.rs:13345`).
#[derive(Debug, Clone)]
pub struct MemoryCandidate {
    pub reference: String,
    pub fts_rank: Option<usize>,
    pub dense_rank: Option<usize>,
    pub importance: f32,
    pub age_days: f32,
}

/// Timing/profiling del recall (per trace diagnostica). Spostato fedelmente dal
/// gateway (`main.rs:13354`).
#[derive(Debug, Clone, Serialize, Default)]
pub struct MemoryRecallTiming {
    pub lock_wait_ms: u64,
    pub profile_ms: u64,
    pub open_loops_ms: u64,
    pub fts_ms: u64,
    pub query_embedding_ms: Option<u64>,
    pub query_embedding_cache_hit: bool,
    pub query_embedding_timed_out: bool,
    pub vector_scan_ms: Option<u64>,
    pub graph_context_ms: u64,
    pub total_ms: u64,
    pub vector_candidates: usize,
    pub fts_candidates: usize,
    pub degraded: bool,
}

// ──────────────────────────────────────────────────────────────────────────
// Scoring + helper puri (spostati fedelmente dal gateway)
// ──────────────────────────────────────────────────────────────────────────

/// Score ibrido RRF (Reciprocal Rank Fusion) dei due rank + boost MILD per
/// importanza e recency. Spostato fedelmente dal gateway (`main.rs:13552`).
pub fn hybrid_memory_score(c: &MemoryCandidate) -> f32 {
    const K: f32 = 60.0;
    let rrf = c.fts_rank.map(|r| 1.0 / (K + r as f32)).unwrap_or(0.0)
        + c.dense_rank.map(|r| 1.0 / (K + r as f32)).unwrap_or(0.0);
    let importance_boost = 0.012 * c.importance.clamp(0.0, 1.0);
    let recency_boost = 0.008 * (-(c.age_days.max(0.0) / 30.0)).exp();
    rrf + importance_boost + recency_boost
}

/// Età di una memoria in giorni dal `created_at` (`unix:<secs>` o `<secs>`).
/// Spostato fedelmente dal gateway (`main.rs:13562`).
pub fn memory_age_days(created_at: &str, now_secs: i64) -> f32 {
    let s = created_at.strip_prefix("unix:").unwrap_or(created_at);
    let secs: i64 = s
        .split('.')
        .next()
        .and_then(|p| p.parse().ok())
        .unwrap_or(now_secs);
    ((now_secs - secs).max(0) as f32) / 86_400.0
}

/// Formatta una voce di recall: appende il "why" della decisione e le
/// alternative scartate se presenti nei metadata. Spostato fedelmente dal
/// gateway (`main.rs:12781`).
pub fn format_recall_entry(summary: &str, metadata: &serde_json::Value) -> String {
    let Some(decision) = metadata.get("decision") else {
        return summary.to_string();
    };
    let mut out = summary.to_string();
    if let Some(rationale) = decision.get("rationale").and_then(|r| r.as_str()) {
        if !rationale.is_empty() && !summary.contains(rationale) {
            out.push_str(&format!(" — why: {rationale}"));
        }
    }
    if let Some(alternatives) = decision.get("alternatives").and_then(|a| a.as_array()) {
        let rejected: Vec<String> = alternatives
            .iter()
            .filter_map(|alt| {
                let option = alt.get("option").and_then(|o| o.as_str())?;
                if option.is_empty() {
                    return None;
                }
                let why = alt
                    .get("rejected_because")
                    .and_then(|w| w.as_str())
                    .unwrap_or("");
                Some(if why.is_empty() {
                    option.to_string()
                } else {
                    format!("{option} (rejected: {why})")
                })
            })
            .collect();
        if !rejected.is_empty() {
            out.push_str(&format!(
                " [rejected alternatives: {}]",
                rejected.join("; ")
            ));
        }
    }
    out
}

/// Token set per dedup lessicale (Jaccard). Spostato fedelmente dal gateway
/// (`main.rs:2673`).
pub fn dedup_tokens(text: &str) -> HashSet<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|token| token.chars().count() >= 3)
        .map(str::to_string)
        .collect()
}

/// Jaccard overlap di due token set (0..1). Spostato fedelmente dal gateway
/// (`main.rs:2683`).
pub fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f32 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let intersection = a.intersection(b).count() as f32;
    let union = a.union(b).count() as f32;
    intersection / union
}

/// Cosine similarity di due vettori. Spostato fedelmente dal gateway
/// (`main.rs:2811`).
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0f32;
    let mut na = 0f32;
    let mut nb = 0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// Threshold Jaccard sopra il quale due memorie same-type sono considerate la
/// stessa cosa (dedup). Spostato fedelmente dal gateway (`main.rs:2692`).
pub const DEDUP_JACCARD: f32 = 0.55;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hybrid_score_rewards_presence_in_both_ranks() {
        // Una memoria presente sia in FTS (rank 1) che denso (rank 1) batte
        // una presente solo in uno dei due.
        let both = MemoryCandidate {
            reference: "both".into(),
            fts_rank: Some(1),
            dense_rank: Some(1),
            importance: 0.5,
            age_days: 0.0,
        };
        let fts_only = MemoryCandidate {
            reference: "fts".into(),
            fts_rank: Some(1),
            dense_rank: None,
            importance: 0.5,
            age_days: 0.0,
        };
        assert!(hybrid_memory_score(&both) > hybrid_memory_score(&fts_only));
    }

    #[test]
    fn memory_age_days_parses_unix_prefix_and_plain_secs() {
        let now = 1_800_000_000i64;
        // unix: prefix → giorni = (now - secs)/86400.
        let age = memory_age_days("unix:1799136000", now); // 864000s = 10 days before
        assert!((age - 10.0).abs() < 0.01, "age should be ~10 days, got {age}");
        // plain secs fallback.
        let age_plain = memory_age_days("1799136000", now);
        assert!((age_plain - 10.0).abs() < 0.01);
        // garbage → ora corrente (0 days).
        let age_garbage = memory_age_days("not-a-number", now);
        assert!((age_garbage - 0.0).abs() < 0.01);
    }

    #[test]
    fn jaccard_and_cosine_are_sound() {
        let a = dedup_tokens("Il preventivo Rossi è aperto");
        let b = dedup_tokens("preventivo rossi aperto");
        assert!(jaccard(&a, &b) > 0.5, "paraphrases overlap high");
        let c = dedup_tokens("completely different topic");
        assert!(jaccard(&a, &c) < 0.2);
        // cosine identici = 1, ortogonali = 0.
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-6);
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
    }

    #[test]
    fn format_recall_entry_appends_decision_why_and_alternatives() {
        let summary = "Scelto Postgres";
        let metadata = serde_json::json!({
            "decision": {
                "rationale": "serve un DB relazionale",
                "alternatives": [
                    {"option": "MongoDB", "rejected_because": "no join"}
                ]
            }
        });
        let out = format_recall_entry(summary, &metadata);
        assert!(out.contains("why: serve un DB relazionale"));
        assert!(out.contains("MongoDB (rejected: no join)"));
    }

    #[test]
    fn format_recall_entry_passes_through_without_decision_metadata() {
        let out = format_recall_entry("un fatto semplice", &serde_json::json!({}));
        assert_eq!(out, "un fatto semplice");
    }
}
