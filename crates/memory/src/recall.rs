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

use serde::Deserialize;
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
    MemoryCollectionKey, MemoryFacade, MemoryRecord, MemoryRef, MemoryResult, MemoryScope,
    MemorySearchRequest, MemoryStatus, PERSONAL_WORKSPACE, PrivacyDomain, RecallHit, RecallPack,
    UserId, WorkspaceId, memory_is_current_at,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemorySourceAccessOutcome {
    Allow,
    Deny,
    Degraded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemorySourceAccessEvent {
    pub id: String,
    pub consumer_user_id: UserId,
    pub consumer_workspace_id: WorkspaceId,
    pub source_workspace_id: WorkspaceId,
    pub grant_id: Option<String>,
    pub policy_version: u64,
    pub turn_id: Option<String>,
    pub outcome: MemorySourceAccessOutcome,
    pub reason: String,
    pub candidate_count: usize,
    pub injected_refs: Vec<String>,
    pub created_at: i64,
}

fn normalized_recall_text(text: &str) -> String {
    text.to_lowercase()
        .split(|character: char| !character.is_alphanumeric())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn semantic_rank(hit: &RecallHit, consumer_workspace: &WorkspaceId) -> u8 {
    let is_local = hit.source_workspace_id == *consumer_workspace && hit.grant_id.is_none();
    let is_personal = hit.source_workspace_id.as_str() == PERSONAL_WORKSPACE;
    match (hit.kind.as_str(), is_local, is_personal) {
        ("decision", true, _) => 0,
        ("preference", _, true) => 1,
        _ if is_personal && hit.collection == MemoryCollectionKey::Profile => 1,
        ("preference", true, _) => 2,
        ("decision", false, _) => 3,
        _ => 4,
    }
}

fn recall_hit_order(
    left: &RecallHit,
    right: &RecallHit,
    consumer_workspace: &WorkspaceId,
) -> std::cmp::Ordering {
    semantic_rank(left, consumer_workspace)
        .cmp(&semantic_rank(right, consumer_workspace))
        .then_with(|| right.graph_path.is_empty().cmp(&left.graph_path.is_empty()))
        .then_with(|| {
            let left_confirmed = left.status == MemoryStatus::Confirmed;
            let right_confirmed = right.status == MemoryStatus::Confirmed;
            right_confirmed.cmp(&left_confirmed)
        })
        .then_with(|| right.updated_at.cmp(&left.updated_at))
        .then_with(|| right.score.total_cmp(&left.score))
        .then_with(|| left.memory_ref.cmp(&right.memory_ref))
}

/// Merge deterministic across already-authorized source-local recall results.
pub fn merge_recall_hits(
    consumer_workspace: WorkspaceId,
    mut hits: Vec<RecallHit>,
    limit: usize,
) -> Vec<RecallHit> {
    if limit == 0 {
        return Vec::new();
    }
    hits.sort_by(|left, right| recall_hit_order(left, right, &consumer_workspace));

    let mut refs = HashSet::new();
    let mut texts = HashSet::new();
    let mut publication_links = HashSet::new();
    hits.retain(|hit| {
        let normalized_text = normalized_recall_text(&hit.text);
        if !refs.insert(hit.memory_ref.clone()) || !texts.insert(normalized_text) {
            return false;
        }
        match hit.publication_link.as_ref() {
            Some(link) if !publication_links.insert(link.clone()) => false,
            _ => true,
        }
    });

    let selected = if hits.len() <= limit {
        hits
    } else {
        let local_indexes = hits
            .iter()
            .enumerate()
            .filter_map(|(index, hit)| {
                (hit.source_workspace_id == consumer_workspace && hit.grant_id.is_none())
                    .then_some(index)
            })
            .take(limit.min(4))
            .collect::<HashSet<_>>();
        let mut selected_indexes = local_indexes;
        for index in 0..hits.len() {
            if selected_indexes.len() == limit {
                break;
            }
            selected_indexes.insert(index);
        }
        hits.into_iter()
            .enumerate()
            .filter_map(|(index, hit)| selected_indexes.contains(&index).then_some(hit))
            .collect()
    };

    let mut merged = selected;
    for index in 0..merged.len() {
        let Some(subject) = merged[index].subject_key.as_deref() else {
            continue;
        };
        let normalized = normalized_recall_text(&merged[index].text);
        if merged.iter().enumerate().any(|(other_index, other)| {
            other_index != index
                && other.kind == merged[index].kind
                && other.subject_key.as_deref() == Some(subject)
                && (other.source_user_id != merged[index].source_user_id
                    || other.source_workspace_id != merged[index].source_workspace_id)
                && normalized_recall_text(&other.text) != normalized
        }) {
            merged[index].conflict = true;
        }
    }
    merged
}

/// Re-resolve effective grants at the last boundary before prompt formatting.
/// A mismatch never tries to salvage linked hits: all of them are discarded and
/// the local subset is merged again under its implicit policy.
pub fn revalidate_recall_hits_before_injection(
    facade: &MemoryFacade,
    user: &UserId,
    consumer_workspace: &WorkspaceId,
    initial_sources: &[AuthorizedMemorySource],
    hits: Vec<RecallHit>,
    now_unix: i64,
    limit: usize,
) -> MemoryResult<(Vec<RecallHit>, Vec<(WorkspaceId, String)>)> {
    revalidate_recall_hits_before_injection_with_source_filter(
        facade,
        user,
        consumer_workspace,
        initial_sources,
        hits,
        now_unix,
        limit,
        &|sources| vec![true; sources.len()],
    )
}

fn resolve_recall_sources_with_filter(
    facade: &MemoryFacade,
    user: &UserId,
    consumer_workspace: &WorkspaceId,
    now_unix: i64,
    source_allowed: &(dyn Fn(&[AuthorizedMemorySource]) -> Vec<bool> + Sync),
) -> MemoryResult<(Vec<AuthorizedMemorySource>, Vec<(WorkspaceId, String)>)> {
    let sources = facade.resolve_memory_sources(user, consumer_workspace, now_unix)?;
    let allowed_by_source = source_allowed(&sources);
    let mut unavailable = Vec::new();
    let mut allowed = Vec::new();
    for (index, source) in sources.into_iter().enumerate() {
        if allowed_by_source.get(index).copied().unwrap_or(false) {
            allowed.push(source);
        } else if source.grant_id.is_some() {
            unavailable.push((
                source.source_workspace_id.clone(),
                "source_unavailable".to_string(),
            ));
        }
    }
    Ok((allowed, unavailable))
}

fn revalidate_recall_hits_before_injection_with_source_filter(
    facade: &MemoryFacade,
    user: &UserId,
    consumer_workspace: &WorkspaceId,
    initial_sources: &[AuthorizedMemorySource],
    hits: Vec<RecallHit>,
    now_unix: i64,
    limit: usize,
    source_allowed: &(dyn Fn(&[AuthorizedMemorySource]) -> Vec<bool> + Sync),
) -> MemoryResult<(Vec<RecallHit>, Vec<(WorkspaceId, String)>)> {
    let initial_fingerprint = crate::memory_source_policy_fingerprint(initial_sources);
    let current_sources = resolve_recall_sources_with_filter(
        facade,
        user,
        consumer_workspace,
        now_unix,
        source_allowed,
    );
    let policy_unchanged = current_sources
        .as_ref()
        .map(|(sources, _)| crate::memory_source_policy_fingerprint(sources) == initial_fingerprint)
        .unwrap_or(false);
    if policy_unchanged {
        return Ok((
            merge_recall_hits(consumer_workspace.clone(), hits, limit),
            Vec::new(),
        ));
    }

    let local_hits = hits
        .into_iter()
        .filter(|hit| {
            hit.grant_id.is_none()
                && hit.source_user_id == *user
                && hit.source_workspace_id == *consumer_workspace
        })
        .collect();
    let unavailable = current_sources
        .as_ref()
        .map(|(_, unavailable)| unavailable)
        .ok();
    let reason = if current_sources.is_ok() {
        "policy_changed"
    } else {
        "policy_revalidation_failed"
    };
    let degraded = initial_sources
        .iter()
        .filter(|source| source.grant_id.is_some())
        .map(|source| {
            let reason = unavailable
                .is_some_and(|unavailable| {
                    unavailable
                        .iter()
                        .any(|(workspace, _)| workspace == &source.source_workspace_id)
                })
                .then_some("source_unavailable")
                .unwrap_or(reason);
            (source.source_workspace_id.clone(), reason.to_string())
        })
        .collect();
    Ok((
        merge_recall_hits(consumer_workspace.clone(), local_hits, limit),
        degraded,
    ))
}

pub fn recall_authorized_sources_on_facade(
    facade: &MemoryFacade,
    user: &UserId,
    consumer_workspace: &WorkspaceId,
    query: &str,
    query_vec: &[f32],
    now_unix: i64,
    graph_context: Option<
        &(dyn Fn(&MemoryFacade, &UserId, &WorkspaceId, &str) -> Option<String> + Sync),
    >,
) -> MemoryResult<RecallPack> {
    recall_authorized_sources_on_facade_with_source_filter(
        facade,
        user,
        consumer_workspace,
        query,
        query_vec,
        now_unix,
        graph_context,
        &|sources| vec![true; sources.len()],
    )
}

/// Coordinates recall only across sources the caller currently authorizes.
/// The memory crate does not own project lifecycle; callers can therefore
/// provide a fail-closed predicate while the compatibility API remains
/// allow-all for existing integrations.
pub fn recall_authorized_sources_on_facade_with_source_filter(
    facade: &MemoryFacade,
    user: &UserId,
    consumer_workspace: &WorkspaceId,
    query: &str,
    query_vec: &[f32],
    now_unix: i64,
    graph_context: Option<
        &(dyn Fn(&MemoryFacade, &UserId, &WorkspaceId, &str) -> Option<String> + Sync),
    >,
    source_allowed: &(dyn Fn(&[AuthorizedMemorySource]) -> Vec<bool> + Sync),
) -> MemoryResult<RecallPack> {
    let (sources, initially_unavailable) = resolve_recall_sources_with_filter(
        facade,
        user,
        consumer_workspace,
        now_unix,
        source_allowed,
    )?;
    let mut hits = Vec::new();
    let mut degraded_sources = initially_unavailable;
    let mut source_audits = Vec::new();
    for source in &sources {
        match recall_source_on_facade(facade, source, query, query_vec, graph_context) {
            Ok(pack) => {
                let candidate_count = pack.hits.len();
                hits.extend(pack.hits);
                source_audits.push((
                    source.clone(),
                    MemorySourceAccessOutcome::Allow,
                    "allowed".to_string(),
                    candidate_count,
                ));
            }
            Err(_) if source.grant_id.is_some() => {
                degraded_sources.push((
                    source.source_workspace_id.clone(),
                    "source_unavailable".to_string(),
                ));
                source_audits.push((
                    source.clone(),
                    MemorySourceAccessOutcome::Degraded,
                    "source_unavailable".to_string(),
                    0,
                ));
            }
            Err(error) => return Err(error),
        }
    }
    let (hits, policy_degraded) = revalidate_recall_hits_before_injection_with_source_filter(
        facade,
        user,
        consumer_workspace,
        &sources,
        hits,
        now_unix,
        10,
        source_allowed,
    )?;
    for (workspace, reason) in &policy_degraded {
        if let Some((_, outcome, audit_reason, _)) = source_audits
            .iter_mut()
            .find(|(source, _, _, _)| source.source_workspace_id == *workspace)
        {
            *outcome = MemorySourceAccessOutcome::Degraded;
            *audit_reason = reason.clone();
        }
    }
    let policy_was_already_changed = !policy_degraded.is_empty();
    degraded_sources.extend(policy_degraded);
    for (source, outcome, reason, candidate_count) in &source_audits {
        let injected_refs = hits
            .iter()
            .filter(|hit| {
                hit.source_user_id == source.source_user_id
                    && hit.source_workspace_id == source.source_workspace_id
                    && hit.grant_id == source.grant_id
            })
            .map(|hit| hit.memory_ref.clone())
            .collect();
        let event = MemorySourceAccessEvent {
            id: uuid::Uuid::new_v4().to_string(),
            consumer_user_id: user.clone(),
            consumer_workspace_id: consumer_workspace.clone(),
            source_workspace_id: source.source_workspace_id.clone(),
            grant_id: source.grant_id.clone(),
            policy_version: source.policy_version,
            turn_id: None,
            outcome: *outcome,
            reason: reason.clone(),
            candidate_count: *candidate_count,
            injected_refs,
            created_at: now_unix,
        };
        if facade.record_memory_source_access(&event).is_err() && source.grant_id.is_some() {
            degraded_sources.push((
                source.source_workspace_id.clone(),
                "audit_unavailable".to_string(),
            ));
        }
    }
    // Audit is deliberately non-authoritative. Re-resolve once more after its
    // I/O so a revoke concurrent with audit cannot leave linked text in the
    // prompt assembled immediately below.
    let (hits, final_policy_degraded) = revalidate_recall_hits_before_injection_with_source_filter(
        facade,
        user,
        consumer_workspace,
        &sources,
        hits,
        now_unix,
        10,
        source_allowed,
    )?;
    if !policy_was_already_changed && !final_policy_degraded.is_empty() {
        for (workspace, reason) in &final_policy_degraded {
            let Some((source, _, _, candidate_count)) = source_audits
                .iter()
                .find(|(source, _, _, _)| source.source_workspace_id == *workspace)
            else {
                continue;
            };
            let corrective = MemorySourceAccessEvent {
                id: uuid::Uuid::new_v4().to_string(),
                consumer_user_id: user.clone(),
                consumer_workspace_id: consumer_workspace.clone(),
                source_workspace_id: source.source_workspace_id.clone(),
                grant_id: source.grant_id.clone(),
                policy_version: source.policy_version,
                turn_id: None,
                outcome: MemorySourceAccessOutcome::Degraded,
                reason: reason.clone(),
                candidate_count: *candidate_count,
                injected_refs: Vec::new(),
                created_at: now_unix,
            };
            if facade.record_memory_source_access(&corrective).is_err() {
                degraded_sources.push((
                    source.source_workspace_id.clone(),
                    "audit_unavailable".to_string(),
                ));
            }
        }
    }
    degraded_sources.extend(final_policy_degraded);
    degraded_sources.sort_by(|left, right| {
        (left.0.as_str(), left.1.as_str()).cmp(&(right.0.as_str(), right.1.as_str()))
    });
    degraded_sources.dedup();
    let scope = if consumer_workspace.as_str() == PERSONAL_WORKSPACE {
        MemoryScope::Personal
    } else {
        MemoryScope::Project(consumer_workspace.clone())
    };
    Ok(RecallPack::from_hits_and_degraded(
        query.to_string(),
        scope,
        hits,
        degraded_sources,
    ))
}

/// Soglia minima di lunghezza della query perché il recall parta (il gateway
/// salta query < 8 char). Spostato fedelmente (`main.rs:13576`).
const RECALL_MIN_QUERY_CHARS: usize = 8;
const GRAPH_RECALL_MAX_HOPS: usize = 2;
const GRAPH_RECALL_EXPANSION_LIMIT: usize = 4;
const GRAPH_RECALL_SCORE_DECAY: f32 = 0.75;

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
        if let Some(hit) = recall_hit_for_record(
            facade,
            source,
            record,
            hybrid_memory_score(&candidate),
            Vec::new(),
        )? {
            hits.push(hit);
        }
    }
    hits.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.memory_ref.cmp(&right.memory_ref))
    });

    let direct_scores = hits
        .iter()
        .map(|hit| (hit.memory_ref.clone(), hit.score))
        .collect::<std::collections::HashMap<_, _>>();
    let seed_refs = hits
        .iter()
        .filter_map(|hit| hit.memory_ref.parse::<MemoryRef>().ok())
        .collect::<Vec<_>>();
    let mut seen_refs = direct_scores.keys().cloned().collect::<HashSet<_>>();
    for related in facade.related_authorized_memories_for_source(
        source,
        &seed_refs,
        GRAPH_RECALL_MAX_HOPS,
        GRAPH_RECALL_EXPANSION_LIMIT,
    )? {
        let reference = related.record.reference.to_string();
        if !seen_refs.insert(reference) {
            continue;
        }
        let Some(seed_score) = direct_scores.get(&related.seed_ref.to_string()) else {
            continue;
        };
        let score = *seed_score
            * GRAPH_RECALL_SCORE_DECAY
                .powi(i32::try_from(related.relation_path.len()).unwrap_or(2));
        if let Some(hit) =
            recall_hit_for_record(facade, source, related.record, score, related.relation_path)?
        {
            hits.push(hit);
        }
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
        .find_map(|key| {
            metadata
                .get(key)
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .map(str::to_string)
}

fn recall_hit_for_record(
    facade: &MemoryFacade,
    source: &AuthorizedMemorySource,
    record: MemoryRecord,
    score: f32,
    graph_path: Vec<String>,
) -> MemoryResult<Option<RecallHit>> {
    let Some(collection) = collection_for_record(&record) else {
        return Ok(None);
    };
    let subject_key = match explicit_subject_key(&record.metadata) {
        Some(subject_key) => Some(subject_key),
        None => facade.canonical_subject_key_for_memory(source, &record.reference)?,
    };
    let publication_link = record
        .metadata
        .get("publication_link")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            record
                .metadata
                .get("publication_source_ref")
                .cloned()
                .and_then(|value| serde_json::from_value::<MemoryRef>(value).ok())
                .and_then(|reference| serde_json::to_string(&reference).ok())
        });
    Ok(Some(RecallHit {
        memory_ref: record.reference.to_string(),
        text: format_recall_entry(&record.text, &record.metadata),
        score,
        kind: record.memory_type,
        source_user_id: source.source_user_id.clone(),
        source_workspace_id: source.source_workspace_id.clone(),
        source_label: source.source_label.clone(),
        collection,
        grant_id: source.grant_id.clone(),
        policy_version: source.grant_id.as_ref().map(|_| source.policy_version),
        sensitivity: record.sensitivity,
        status: record.status,
        updated_at: record.updated_at,
        subject_key,
        conflict: false,
        publication_link,
        graph_path,
    }))
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
    graph_context: Option<
        &(dyn Fn(&MemoryFacade, &UserId, &WorkspaceId, &str) -> Option<String> + Sync),
    >,
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
        .map(|ms| {
            ms.into_iter()
                .filter(|memory| memory_is_current_at(memory, now_secs, true))
                .map(|m| (m.reference.to_string(), m))
                .collect()
        })
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
        assert!(
            (age - 10.0).abs() < 0.01,
            "age should be ~10 days, got {age}"
        );
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

    #[test]
    fn semantic_recall_uses_only_current_temporal_records() {
        use crate::{
            MemoryEvolutionKind, MemoryEvolutionMetadata, MemoryRefKind, SQLiteMemoryStore,
            write_memory_evolution_metadata,
        };
        let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
        let user = UserId::new("current-user");
        let ws = WorkspaceId::new("current-project");
        let make_record = |text: &str| MemoryRecord {
            reference: crate::MemoryRef::generated(
                MemoryRefKind::Memory,
                user.clone(),
                ws.clone(),
            ),
            user_id: user.clone(),
            workspace_id: ws.clone(),
            memory_type: "decision".to_string(),
            text: text.to_string(),
            aliases: vec![],
            language_hints: vec![],
            confidence: 0.9,
            status: MemoryStatus::Confirmed,
            privacy_domain: PrivacyDomain::new("work"),
            sensitivity: DataSensitivity::Public,
            metadata: serde_json::json!({}),
            created_at: "unix:100".to_string(),
            updated_at: "unix:100".to_string(),
            last_seen_at: None,
            supersedes: vec![],
            superseded_by: None,
            correction_of: None,
        };
        let current = make_record("Current temporal launch is Monday");
        let mut old = make_record("Current temporal launch was Friday");
        old.superseded_by = Some(current.reference.clone());
        let mut expired = make_record("Current temporal launch was Tuesday");
        write_memory_evolution_metadata(
            &mut expired.metadata,
            &MemoryEvolutionMetadata {
                kind: MemoryEvolutionKind::Independent,
                target_refs: vec![],
                valid_from: None,
                valid_until: Some(1),
                last_confirmed_at: None,
                reinforcement_count: 1,
                classifier: "test".to_string(),
                classifier_confidence: 1.0,
            },
        )
        .unwrap();
        for record in [&current, &old, &expired] {
            facade.upsert_memory(record).unwrap();
        }

        let block = recall_search_on_facade(
            &facade,
            &user,
            &ws,
            "current temporal launch schedule",
            &[],
            None,
        )
        .unwrap();

        assert!(block.contains("Monday"));
        assert!(!block.contains("Friday"));
        assert!(!block.contains("Tuesday"));
    }
}
