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

// ──────────────────────────────────────────────────────────────────────────
// Orchestrazione del recall (Step 1) — core senza graph-context
// ──────────────────────────────────────────────────────────────────────────

use crate::{
    AuthorizedMemorySearchRequest, AuthorizedMemorySource, DataSensitivity, MemoryAccessRequest,
    MemoryCollectionKey, MemoryFacade, MemoryRecord, MemoryResult, MemoryScope,
    MemorySearchRequest, MemoryStatus, PERSONAL_WORKSPACE, PrivacyDomain, RecallHit, RecallPack,
    UserId, WorkspaceId,
};

/// Soglia minima di lunghezza della query perché il recall parta (il gateway
/// salta query < 8 char). Spostato fedelmente (`main.rs:13576`).
const RECALL_MIN_QUERY_CHARS: usize = 8;

/// Soglia di score denso sotto la quale un hit vettoriale è scartato (paraphrase
/// troppo debole). Spostato fedelmente (`main.rs:13656`).
const RECALL_DENSE_MIN_SCORE: f32 = 0.5;

/// Recall RAG episodico — fase 1: embed della query, **OFF the lock**. Spostato
/// fedelmente dal gateway (`main.rs:13581`). Questa è l'unica parte async; il
/// chiamante la esegue PRIMA di prendere il lock della facade, così il
/// `MutexGuard` non attraversa un await (che romperebbe `Send`).
pub async fn embed_query(embedding: &dyn EmbeddingClient, query: &str) -> Vec<f32> {
    embedding.embed(query.trim()).await
}

/// Recall di una sola fonte già risolta/autorizzata. FTS e ricerca densa
/// restano nello scope esatto della source; la policy della grant restringe
/// ulteriormente i candidati senza allargare il `MemoryPolicyEngine`.
pub fn recall_source_on_facade(
    facade: &MemoryFacade,
    source: &AuthorizedMemorySource,
    query: &str,
    query_vec: &[f32],
    _graph_context: Option<
        &(dyn Fn(&MemoryFacade, &UserId, &WorkspaceId, &str) -> Option<String> + Sync),
    >,
) -> MemoryResult<RecallPack> {
    let query = query.trim();
    let scope = if source.source_workspace_id.as_str() == PERSONAL_WORKSPACE {
        MemoryScope::Personal
    } else {
        MemoryScope::Project(source.source_workspace_id.clone())
    };
    if query.chars().count() < RECALL_MIN_QUERY_CHARS {
        return Ok(RecallPack::from_hits(query.to_string(), scope, Vec::new()));
    }

    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    let access = MemoryAccessRequest {
        actor_id: "chat_rag".to_string(),
        user_id: source.source_user_id.clone(),
        workspace_id: source.source_workspace_id.clone(),
        purpose: "chat_context".to_string(),
        allowed_domains: vec![
            PrivacyDomain::new("personal"),
            PrivacyDomain::new("work"),
            PrivacyDomain::new("general"),
        ],
        max_sensitivity: source
            .policy
            .as_ref()
            .map(|policy| policy.max_sensitivity)
            .unwrap_or(DataSensitivity::Private),
        allow_raw_payload: false,
        allow_export: true,
        broad_query: false,
    };

    let mut fts_rank = std::collections::HashMap::<String, usize>::new();
    let lexical = facade.search_authorized_memories(AuthorizedMemorySearchRequest {
        access,
        source_policy: source.policy.clone(),
        query: query.to_string(),
        statuses: vec![MemoryStatus::Confirmed, MemoryStatus::Candidate],
        memory_types: Vec::new(),
        limit: 8,
        offset: 0,
    })?;
    for item in lexical.items {
        fts_rank
            .entry(item.reference.to_string())
            .or_insert(item.rank);
    }

    let mut dense_rank = std::collections::HashMap::<String, usize>::new();
    if !query_vec.is_empty() {
        for (index, hit) in facade
            .search_authorized_embeddings(source, query_vec, 32)?
            .into_iter()
            .filter(|hit| hit.score >= RECALL_DENSE_MIN_SCORE)
            .take(8)
            .enumerate()
        {
            dense_rank
                .entry(hit.memory_ref.to_string())
                .or_insert(index + 1);
        }
    }

    let mut references = std::collections::HashSet::<String>::new();
    references.extend(fts_rank.keys().cloned());
    references.extend(dense_rank.keys().cloned());
    let mut hits = Vec::<RecallHit>::new();
    for reference in references {
        let Ok(memory_ref) = reference.parse() else {
            continue;
        };
        let Some(record) = facade.get_authorized_memory_for_source(source, &memory_ref)? else {
            continue;
        };
        let Some(collection) = collection_for_record(&record) else {
            continue;
        };
        let importance = record
            .metadata
            .get("importance")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.5) as f32;
        let candidate = MemoryCandidate {
            reference: reference.clone(),
            fts_rank: fts_rank.get(&reference).copied(),
            dense_rank: dense_rank.get(&reference).copied(),
            importance,
            age_days: memory_age_days(&record.created_at, now_secs),
        };
        hits.push(RecallHit {
            memory_ref: reference,
            text: format_recall_entry(&record.text, &record.metadata),
            score: hybrid_memory_score(&candidate),
            kind: record.memory_type,
            source_user_id: source.source_user_id.clone(),
            source_workspace_id: source.source_workspace_id.clone(),
            source_label: source.source_label.clone(),
            collection,
            grant_id: source.grant_id.clone(),
            sensitivity: record.sensitivity,
            status: record.status,
            updated_at: record.updated_at,
            subject_key: explicit_subject_key(&record.metadata),
            conflict: false,
        });
    }
    hits.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.memory_ref.cmp(&right.memory_ref))
    });
    hits.truncate(10);

    Ok(RecallPack::from_hits(query.to_string(), scope, hits))
}

fn collection_for_record(record: &MemoryRecord) -> Option<MemoryCollectionKey> {
    [
        MemoryCollectionKey::Preferences,
        MemoryCollectionKey::Profile,
        MemoryCollectionKey::Knowledge,
        MemoryCollectionKey::Decisions,
        MemoryCollectionKey::Goals,
        MemoryCollectionKey::Artifacts,
        MemoryCollectionKey::Episodes,
    ]
    .into_iter()
    .find(|collection| collection.matches(record))
}

fn explicit_subject_key(metadata: &serde_json::Value) -> Option<String> {
    ["subject_key", "canonical_key"]
        .into_iter()
        .find_map(|key| metadata.get(key).and_then(serde_json::Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Recall RAG episodico — fase 2: FTS + vector search + fusione RRF + formatting,
/// **sotto lock** (sync). Prende la `query_vec` già embedded (da [`embed_query`])
/// e la facade già lockata dal chiamante. Spostato fedelmente dal corpo di
/// `relevant_memory_for_prompt` (`main.rs:13591-13726`).
///
/// Lo scope è **argomento esplicito** (`user`, `workspace`) — isolation by
/// construction (chiude il debito Tappa 1). Il graph-context enrichment è un
/// callback opzionale `+ Sync` che il gateway inietta.
pub fn recall_search_on_facade(
    facade: &MemoryFacade,
    user: &UserId,
    workspace: &WorkspaceId,
    query: &str,
    query_vec: &[f32],
    graph_context: Option<&(dyn Fn(&MemoryFacade, &UserId, &WorkspaceId, &str) -> Option<String> + Sync)>,
) -> Option<String> {
    let query = query.trim();
    if query.chars().count() < RECALL_MIN_QUERY_CHARS {
        return None;
    }
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    // All memories in scope, keyed by ref.
    let records: std::collections::HashMap<String, MemoryRecord> = facade
        .list_memories_for_ui(user, workspace)
        .map(|ms| ms.into_iter().map(|m| (m.reference.to_string(), m)).collect())
        .unwrap_or_default();

    // Lexical pass (FTS/bm25) → rank per reference.
    let mut fts_rank: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let access = MemoryAccessRequest {
        actor_id: "chat_rag".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "chat_context".to_string(),
        allowed_domains: vec![
            PrivacyDomain::new("personal"),
            PrivacyDomain::new("work"),
            PrivacyDomain::new("general"),
        ],
        max_sensitivity: DataSensitivity::Private,
        allow_raw_payload: false,
        allow_export: true,
        broad_query: false,
    };
    if let Ok(page) = facade.search_memories(MemorySearchRequest {
        access,
        query: query.to_string(),
        statuses: vec![MemoryStatus::Confirmed, MemoryStatus::Candidate],
        memory_types: vec![
            "open_loop".to_string(),
            "goal".to_string(),
            "decision".to_string(),
            "fact".to_string(),
            "preference".to_string(),
        ],
        limit: 8,
        offset: 0,
    }) {
        for item in page.items {
            fts_rank
                .entry(item.reference.to_string())
                .or_insert(item.rank);
        }
    }

    // Semantic pass (dense) → rank per reference.
    let mut dense_rank: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    if !query_vec.is_empty() {
        if let Ok(hits) = facade.search_embeddings(user, workspace, query_vec, 32) {
            for (i, hit) in hits
                .into_iter()
                .filter(|hit| hit.score >= RECALL_DENSE_MIN_SCORE)
                .take(8)
                .enumerate()
            {
                dense_rank
                    .entry(hit.memory_ref.to_string())
                    .or_insert(i + 1);
            }
        }
    }

    // Fuse: union → RRF + importance + recency.
    let mut refs: std::collections::HashSet<String> = std::collections::HashSet::new();
    refs.extend(fts_rank.keys().cloned());
    refs.extend(dense_rank.keys().cloned());
    let mut candidates: Vec<(MemoryCandidate, String)> = Vec::new();
    for reference in refs {
        let Some(record) = records.get(&reference) else {
            continue;
        };
        let importance = record
            .metadata
            .get("importance")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.5) as f32;
        let candidate = MemoryCandidate {
            fts_rank: fts_rank.get(&reference).copied(),
            dense_rank: dense_rank.get(&reference).copied(),
            importance,
            age_days: memory_age_days(&record.created_at, now_secs),
            reference: reference.clone(),
        };
        let line = format!("- {}", format_recall_entry(&record.text, &record.metadata));
        candidates.push((candidate, line));
    }
    candidates.sort_by(|a, b| {
        hybrid_memory_score(&b.0)
            .partial_cmp(&hybrid_memory_score(&a.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut lines: Vec<String> = Vec::new();
    for (_, line) in candidates {
        if !lines.contains(&line) {
            lines.push(line);
        }
    }

    // Graph-context enrichment (opzionale, iniettato dal gateway).
    if let Some(enrich) = graph_context {
        if let Some(extra) = enrich(facade, user, workspace, query) {
            lines.insert(0, extra);
        }
    }
    lines.truncate(10);
    if lines.is_empty() {
        return None;
    }
    Some(format!(
        "MEMORY RELEVANT TO THE REQUEST (this is what you/the user have ALREADY established — \
treat it as established fact; do NOT say \"I have no decision in memory\" if it's below here):\n{}",
        lines.join("\n")
    ))
}

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

    /// ADR 0022 (Tappa 4) — il recall è ora testabile IN ISOLAMENTO (no HTTP).
    /// Questo è il test "0 profilazione → ora possibile" dell'ADR: una facade
    /// in-memory + un mock embedding deterministico → recall trova la decisione.
    #[test]
    fn recall_search_finds_decision_via_fts_in_isolation() {
        use crate::{MemoryFacade, MemoryRefKind, SQLiteMemoryStore};
        let store = SQLiteMemoryStore::open_in_memory().unwrap();
        let facade = MemoryFacade::new(store);
        let user = UserId::new("iso-user");
        let ws = WorkspaceId::new("proj-iso");
        // Una decisione confirmed nello scope.
        let now = crate::current_timestamp();
        let record = MemoryRecord {
            reference: crate::MemoryRef::generated(MemoryRefKind::Memory, user.clone(), ws.clone()),
            user_id: user.clone(),
            workspace_id: ws.clone(),
            memory_type: "decision".to_string(),
            text: "Scelto Postgres per il DB relazionale del progetto".to_string(),
            aliases: vec![],
            language_hints: vec![],
            confidence: 0.9,
            status: crate::MemoryStatus::Confirmed,
            privacy_domain: PrivacyDomain::new("work"),
            sensitivity: DataSensitivity::Public,
            metadata: serde_json::json!({}),
            created_at: now.clone(),
            updated_at: now,
            last_seen_at: None,
            supersedes: vec![],
            superseded_by: None,
            correction_of: None,
        };
        facade.upsert_memory(&record).unwrap();

        // query_vec vuoto: il recall cade sul solo passaggio FTS (deterministico).
        let block = recall_search_on_facade(
            &facade,
            &user,
            &ws,
            "quale database abbiamo scelto per il progetto?",
            &[],
            None,
        )
        .expect("recall deve trovare la decisione via FTS");
        assert!(
            block.contains("Postgres"),
            "il recall deve citare la decisione: {block}"
        );
        assert!(
            block.starts_with("MEMORY RELEVANT"),
            "il recall deve produrre il blocco canonico"
        );
    }

    #[test]
    fn recall_search_returns_none_for_short_query() {
        use crate::SQLiteMemoryStore;
        let store = SQLiteMemoryStore::open_in_memory().unwrap();
        let facade = MemoryFacade::new(store);
        let user = UserId::new("short-user");
        let ws = WorkspaceId::new("proj-short");
        // Query < 8 char → None (come nel gateway).
        assert_eq!(
            recall_search_on_facade(&facade, &user, &ws, "ok", &[], None),
            None
        );
    }
}
