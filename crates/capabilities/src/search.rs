//! Shared lexical capability search.
//!
//! WHY this exists: until F1(a) there were TWO BM25 engines — the chat loop's pure-Rust
//! Okapi `bm25_rank` (over the live tool schemas) and the orchestrator's SQLite FTS5
//! `ToolSearchIndexStore` (over registry `CapabilityTool`s). Same intent, two
//! implementations with different ranking (Okapi IDF vs FTS5 `term*` prefix-OR), so "what
//! chat finds" could drift from "what the planner finds" (caposaldo #5 violated). This
//! module is the SINGLE ranker both call, so the drift is gone by construction.
//!
//! It is deliberately domain-agnostic: it ranks PRE-TOKENIZED documents and returns the
//! ranked INDICES, so each caller maps them back to its own type (the gateway's
//! schema-carrying `CapabilityEntry`, the orchestrator's typed `CapabilityTool`) without
//! this crate having to know either. BM25 over a few hundred tools is the state of the art
//! Anthropic's Tool Search uses at this scale — no embeddings, so it also works on the weak
//! local tier (caposaldo #2).

use std::collections::HashMap;

/// Tokenize text for lexical capability search: lowercase, split on every
/// non-alphanumeric boundary, keep tokens of at least two CHARACTERS (char count, not
/// bytes, so accented/multilingual terms aren't miscounted — caposaldo #13). This is the
/// one tokenizer both the query and the indexed documents must share, otherwise the same
/// word would tokenize differently on the two sides and never match.
pub fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| term.chars().count() >= 2)
        .map(str::to_string)
        .collect()
}

/// Okapi BM25 ranking over a corpus of PRE-TOKENIZED documents.
///
/// Returns the indices of the best `limit` documents, best first. Classic Okapi tuning
/// (`k1 = 1.5`, `b = 0.75`): IDF makes rare query terms weigh more, the `k1` term saturates
/// repeated matches, and `b` normalizes by document length so a long tool description can't
/// win on sheer size.
///
/// Edge behavior, intentionally split so each caller owns its own fallback policy:
/// - **Empty query** (no usable terms) or **empty corpus** → the first `limit` indices, a
///   sensible "here's a sample of what exists" browse.
/// - **Non-empty query with zero matches** → an EMPTY result (only documents with a
///   positive score are returned). A caller that prefers a sample over nothing should
///   fall back itself.
pub fn bm25_rank_indices(docs: &[Vec<String>], query: &str, limit: usize) -> Vec<usize> {
    let mut query_terms = tokenize(query);
    query_terms.sort();
    query_terms.dedup();
    if query_terms.is_empty() || docs.is_empty() {
        return (0..docs.len().min(limit)).collect();
    }

    let document_count = docs.len() as f64;
    let average_length =
        (docs.iter().map(|doc| doc.len()).sum::<usize>() as f64 / document_count).max(1.0);
    let (k1, b) = (1.5_f64, 0.75_f64);

    // Document frequency per query term: how many documents contain it at all.
    let document_frequency: HashMap<&str, f64> = query_terms
        .iter()
        .map(|term| {
            let containing = docs
                .iter()
                .filter(|doc| doc.iter().any(|word| word == term))
                .count() as f64;
            (term.as_str(), containing)
        })
        .collect();

    let mut scored: Vec<(f64, usize)> = docs
        .iter()
        .enumerate()
        .filter_map(|(index, doc)| {
            let length = doc.len() as f64;
            let mut score = 0.0;
            for term in &query_terms {
                let frequency = doc.iter().filter(|word| *word == term).count() as f64;
                if frequency == 0.0 {
                    continue;
                }
                let containing = *document_frequency.get(term.as_str()).unwrap_or(&0.0);
                let idf =
                    (((document_count - containing + 0.5) / (containing + 0.5)) + 1.0).ln();
                score += idf * (frequency * (k1 + 1.0))
                    / (frequency + k1 * (1.0 - b + b * length / average_length));
            }
            (score > 0.0).then_some((score, index))
        })
        .collect();
    scored.sort_by(|left, right| {
        right
            .0
            .partial_cmp(&left.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored
        .into_iter()
        .take(limit)
        .map(|(_, index)| index)
        .collect()
}

/// Convenience wrapper: rank a slice of raw document texts directly (tokenizes each with
/// [`tokenize`]). Equivalent to tokenizing yourself and calling [`bm25_rank_indices`].
pub fn bm25_rank_texts(texts: &[&str], query: &str, limit: usize) -> Vec<usize> {
    let docs: Vec<Vec<String>> = texts.iter().map(|text| tokenize(text)).collect();
    bm25_rank_indices(&docs, query, limit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenize_lowercases_splits_and_drops_single_chars() {
        assert_eq!(tokenize("Read a File!"), vec!["read", "file"]);
        // single-char tokens ("a") dropped; punctuation is a boundary.
        assert_eq!(tokenize("PDF-merge, now"), vec!["pdf", "merge", "now"]);
    }

    #[test]
    fn tokenize_counts_chars_not_bytes_for_multilingual_terms() {
        // "è" is one char (two bytes) — a byte-length filter would keep it; a char filter
        // drops it as a single-char token, like every other one-letter word.
        assert_eq!(tokenize("è una città"), vec!["una", "città"]);
    }

    #[test]
    fn empty_query_returns_a_capped_sample() {
        let docs: Vec<Vec<String>> = vec![tokenize("alpha"), tokenize("beta"), tokenize("gamma")];
        assert_eq!(bm25_rank_indices(&docs, "   ", 2), vec![0, 1]);
        assert_eq!(bm25_rank_indices(&docs, "", 10), vec![0, 1, 2]);
    }

    #[test]
    fn no_match_returns_empty_not_a_sample() {
        let docs: Vec<Vec<String>> = vec![tokenize("send an email"), tokenize("calendar event")];
        assert!(bm25_rank_indices(&docs, "quantum chromodynamics", 5).is_empty());
    }

    #[test]
    fn ranks_the_more_relevant_document_first() {
        let texts = [
            "send an email message to a contact",
            "create a calendar event with attendees",
            "navigate to a web page and read it",
        ];
        let ranked = bm25_rank_texts(&texts, "open a website and read the page", 3);
        assert_eq!(ranked.first(), Some(&2));
    }

    #[test]
    fn rarer_query_term_dominates_via_idf() {
        // "calendar" appears in only one doc, "the" in all → the calendar doc must win
        // even though "the" matches everywhere.
        let texts = [
            "the the the the the",
            "the calendar the the the",
            "the the the the the",
        ];
        let ranked = bm25_rank_texts(&texts, "the calendar", 1);
        assert_eq!(ranked, vec![1]);
    }
}
