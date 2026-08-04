//! Lexical memory deduplication and forgotten-memory suppression.
//!
//! This owner provides the cheap, deterministic pre-filter shared by memory
//! ingestion, graph projection, contact profile refresh, and proactivity. True
//! cross-language semantic dedup remains in the embeddings layer; this module
//! only owns language-agnostic token overlap contracts.

use std::collections::HashSet;

use local_first_memory::{MemoryFacade, UserId as MemoryUserId, WorkspaceId as MemoryWorkspaceId};

use crate::{PERSONAL_WORKSPACE, THREADS_WORKSPACE};

/// Normalize text for exact-duplicate comparison in tests and write paths.
#[cfg(test)]
pub(crate) fn normalize_for_dedup(text: &str) -> String {
    text.trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Content tokens of a memory for similarity. LANGUAGE-AGNOSTIC by design (the system
/// is multilingual): lowercase + alphanumeric tokens of >=3 chars, NO per-language
/// stopword list. Most function words are <=2 chars (drop) or wash out equally across
/// pairs; the threshold compensates for the rest. True cross-language / semantic
/// dedup is the embeddings layer, not this lexical pre-filter.
pub(crate) fn dedup_tokens(text: &str) -> HashSet<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|token| token.chars().count() >= 3)
        .map(str::to_string)
        .collect()
}

/// Jaccard overlap of two token sets (0..1). Used to fold near-duplicate memories
/// when the extractor re-phrases the same decision across turns.
pub(crate) fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f32 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let intersection = a.intersection(b).count() as f32;
    let union = a.union(b).count() as f32;
    intersection / union
}

pub(crate) fn cosine(a: &[f32], b: &[f32]) -> f32 {
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

/// Threshold above which two same-type memories are considered the same thing.
/// Slightly higher than 0.5 to compensate for not removing function words.
pub(crate) const DEDUP_JACCARD: f32 = 0.55;

/// Cosine above which two memories are the same thing (semantic dedup / collapse).
/// Tuned on real nomic-embed-v2-moe vectors: clear paraphrases of one decision sit at
/// 0.85-0.96, while genuinely distinct decisions on the same topic stay below ~0.80.
pub(crate) const DEDUP_COSINE: f32 = 0.85;

/// True if two anchors are near-duplicates: Jaccard over the threshold, OR the
/// smaller token set is fully contained in the larger. Containment requires >=2
/// shared tokens so a single common word never collapses distinct cards.
fn anchors_are_similar(a: &HashSet<String>, b: &HashSet<String>) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if jaccard(a, b) >= DEDUP_JACCARD {
        return true;
    }
    let shared = a.intersection(b).count();
    shared >= 2 && shared == a.len().min(b.len())
}

/// True if the freshly emitted card is a semantic near-duplicate of one already
/// surfaced. Exact dedup keys miss paraphrases, so compare both the machine key
/// and the human title.
pub(crate) fn is_semantic_duplicate(
    new_key: &str,
    new_title: &str,
    existing: &[(String, String)],
) -> bool {
    let nk = dedup_tokens(new_key);
    let nt = dedup_tokens(new_title);
    existing.iter().any(|(key, title)| {
        anchors_are_similar(&nk, &dedup_tokens(key))
            || anchors_are_similar(&nt, &dedup_tokens(title))
    })
}

/// Texts of DELETED/REJECTED memories in always-on scopes are the suppression
/// list. Anything the user forgot must not resurface even if raw source messages
/// remain.
pub(crate) fn forgotten_token_sets(
    facade: &MemoryFacade,
    user: &MemoryUserId,
) -> Vec<HashSet<String>> {
    let mut out = Vec::new();
    for ws in [PERSONAL_WORKSPACE, THREADS_WORKSPACE] {
        if let Ok(texts) = facade.list_forgotten_texts(user, &MemoryWorkspaceId::new(ws)) {
            for text in texts {
                let tokens = dedup_tokens(&text);
                if !tokens.is_empty() {
                    out.push(tokens);
                }
            }
        }
    }
    out
}

/// True when `text` substantially overlaps any forgotten text.
pub(crate) fn is_suppressed(text: &str, forgotten: &[HashSet<String>]) -> bool {
    if forgotten.is_empty() {
        return false;
    }
    let tokens = dedup_tokens(text);
    forgotten
        .iter()
        .any(|f| jaccard(&tokens, f) >= DEDUP_JACCARD)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_for_exact_duplicate_comparison() {
        assert_eq!(
            normalize_for_dedup("  Preferisce   risposte  BREVI "),
            "preferisce risposte brevi"
        );
    }

    #[test]
    fn dedup_folds_paraphrased_decisions() {
        let a = dedup_tokens("Scelto JSON come formato di salvataggio per taskline");
        let b = dedup_tokens("taskline usa JSON come formato di salvataggio");
        assert!(
            jaccard(&a, &b) >= DEDUP_JACCARD,
            "paraphrase: {}",
            jaccard(&a, &b)
        );

        let c = dedup_tokens("Aggiunto supporto CLI con argparse e gestione errori");
        assert!(
            jaccard(&a, &c) < DEDUP_JACCARD,
            "distinct: {}",
            jaccard(&a, &c)
        );
    }

    #[test]
    fn cosine_scores_matching_vectors_and_rejects_invalid_shapes() {
        assert_eq!(cosine(&[], &[]), 0.0);
        assert_eq!(cosine(&[1.0, 0.0], &[1.0]), 0.0);
        assert_eq!(cosine(&[0.0, 0.0], &[1.0, 1.0]), 0.0);
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 0.0001);
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]) < DEDUP_COSINE);
    }

    #[test]
    fn semantic_duplicate_blocks_paraphrased_anchors() {
        let existing = vec![
            (
                "curiosita:tappo-moto".to_string(),
                "Che tappo cerchi per la moto?".to_string(),
            ),
            (
                "scadenza:contratto-acme".to_string(),
                "Contratto Acme in scadenza".to_string(),
            ),
        ];

        assert!(is_semantic_duplicate(
            "curiosita:tappo-della-moto",
            "Quale tappo per la moto?",
            &existing
        ));
        assert!(!is_semantic_duplicate(
            "curiosita:vacanze-estive",
            "Dove vai in vacanza?",
            &existing
        ));
        assert!(!is_semantic_duplicate(
            "progetto-fermo:idra",
            "Idra e fermo",
            &existing
        ));
        assert!(!is_semantic_duplicate("curiosita:tappo-moto", "x", &[]));
    }

    #[test]
    fn suppressed_text_matches_forgotten_overlap() {
        let forgotten = vec![dedup_tokens("Fabio vuole dimenticare il progetto Berlino")];
        assert!(is_suppressed(
            "Fabio vuole dimenticare progetto Berlino",
            &forgotten
        ));
        assert!(!is_suppressed("Preferisce risposte concise", &forgotten));
    }
}
