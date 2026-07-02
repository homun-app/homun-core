//! ADR 0022 (Tappa 4) — backfill incrementale degli embedding, spostato dal
//! gateway monolite nel crate memoria.
//!
//! Per ogni memoria senza embedding, calcola il vettore via `EmbeddingClient`
//! (off-lock) e lo persiste; con semantic-dedup on-write (cosine) contro gli
//! embedding già presenti. Background, bounded per batch.

use crate::{
    cosine, EmbeddingClient, MemoryFacade, MemoryLifecycleRequest, MemoryRef, UserId, WorkspaceId,
};

/// Soglia cosine sopra la quale due memorie same-type sono considerate duplicati
/// semantici (sul write). Spostata fedelmente dal gateway (`main.rs:2838`).
pub const DEDUP_COSINE: f32 = 0.85;

/// Predicato: quali `memory_type` partecipano al semantic-dedup. Gli artifact sono
/// esclusi (due deliverable possono avere descrizioni simili ma lifecycle diverso).
/// Spostato fedelmente dal gateway (`main.rs:3095`).
pub fn memory_type_participates_in_semantic_dedup(memory_type: &str) -> bool {
    !matches!(memory_type, "artifact")
}

/// Nome del modello di embedding usato per i metadati. Il gateway risolve il model
/// dal suo env (`embed_model`); il crate lo riceve come argomento così resta puro.
/// Spostato fedelmente dal corpo di `backfill_embeddings` (usava `embed_model()`).

/// Backfill incrementale: calcola e persiste gli embedding per le memorie che ne
/// mancano (batch bounded), con semantic-dedup on-write. Spostato fedelmente dal
/// corpo di `backfill_embeddings` (`main.rs:3015-3093`).
///
/// **Split in 3 fasi Send-safe** (come recall/learn): il `MutexGuard` della facade
/// NON attraversa l'await dell'embed. Il chiamante (gateway) orchesta:
/// (1) [`backfill_collect_pending`] sync sotto lock → (2) loop embed off-lock →
/// (3) [`backfill_persist_one`] sync sotto lock re-acquisito per ciascuno.

/// Fase 1 (sync, lock): carica pending (refs senza embedding) + seen (embedding
/// esistenti, seed per il semantic dedup). Ritorna `None` se non c'è nulla da fare.
pub fn backfill_collect_pending(
    facade: &MemoryFacade,
    user: &UserId,
    workspace: &WorkspaceId,
    limit: usize,
) -> Option<(
    Vec<(MemoryRef, String, String)>,
    Vec<(String, String, Vec<f32>)>,
)> {
    let refs = facade.refs_without_embeddings(user, workspace, limit).ok()?;
    if refs.is_empty() {
        return None;
    }
    let meta: std::collections::HashMap<String, (String, String)> = facade
        .list_memories_for_ui(user, workspace)
        .map(|mems| {
            mems.into_iter()
                .map(|m| (m.reference.to_string(), (m.text, m.memory_type)))
                .collect()
        })
        .unwrap_or_default();
    let mut seen: Vec<(String, String, Vec<f32>)> = Vec::new();
    if let Ok(embeddings) = facade.list_embeddings(user, workspace) {
        for (reference, vector) in embeddings {
            let rs = reference.to_string();
            if let Some((_text, mtype)) = meta.get(&rs) {
                seen.push((rs, mtype.clone(), vector));
            }
        }
    }
    let pending = refs
        .into_iter()
        .filter_map(|r| {
            meta.get(&r.to_string())
                .map(|(text, mtype)| (r, text.clone(), mtype.clone()))
        })
        .collect();
    Some((pending, seen))
}

/// Fase 3 (sync, lock re-acquisito): persiste un embedding (o deduplica se è un
/// duplicato semantico). Aggiorna `seen` (così i dedup successivi vedono il nuovo).
/// Ritorna `true` se la memoria era un duplicato (cancellata), `false` se persistita.
pub fn backfill_persist_one(
    facade: &MemoryFacade,
    user: &UserId,
    workspace: &WorkspaceId,
    reference: &MemoryRef,
    mtype: &str,
    vector: &[f32],
    model: &str,
    seen: &mut Vec<(String, String, Vec<f32>)>,
) -> bool {
    let is_dup = memory_type_participates_in_semantic_dedup(mtype)
        && seen.iter().any(|(rs, ty, v)| {
            ty == mtype && rs != &reference.to_string() && cosine(vector, v) >= DEDUP_COSINE
        });
    if is_dup {
        let lifecycle = MemoryLifecycleRequest {
            actor_id: "memory-dedup".to_string(),
            user_id: user.clone(),
            workspace_id: workspace.clone(),
            purpose: "semantic_dedup".to_string(),
        };
        let _ = facade.delete_memory(&lifecycle, reference, "duplicato semantico");
        return true;
    }
    let _ = facade.upsert_embedding(reference, user, workspace, model, vector);
    seen.push((reference.to_string(), mtype.to_string(), vector.to_vec()));
    false
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semantic_dedup_excludes_artifacts() {
        assert!(memory_type_participates_in_semantic_dedup("fact"));
        assert!(memory_type_participates_in_semantic_dedup("decision"));
        assert!(!memory_type_participates_in_semantic_dedup("artifact"));
    }

    #[test]
    fn dedup_cosine_threshold_is_high() {
        // 0.85: solo parafrasi molto vicine sono duplicati.
        assert!(DEDUP_COSINE >= 0.8);
    }
}
