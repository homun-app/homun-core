//! Readable per-turn trace (`<logs_dir>/turn-trace.jsonl`).
//!
//! WHY: the P0 `gateway.log` has the raw `[plan]`/`[answer]` eprintlns and `tool_trace_dump` is a
//! HASHED parity oracle (ADR 0024) — neither lets a human read "what happened in this turn". This
//! writes ONE readable JSON line per event, turn-scoped, so a bad turn (e.g. delivered no table and
//! claimed it did) can be understood by tailing one file. Local-only, content truncated, best-effort.
//! Kept SEPARATE from `tool_trace_dump` (one responsibility per unit — caposaldo #5).

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;

/// Fingerprint of the final answer (content truncated elsewhere; only signals kept here).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AnswerSignals {
    pub has_table: bool,
    pub sources_count: usize,
    pub artifact_count: usize,
}

/// Derived red-flags — the high-value part of the trace.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DerivedFlags {
    /// Steps in the final plan that are not `done`.
    pub incomplete_steps: usize,
    /// A plan step implies an artifact (a table / file / deck / …) but that artifact is ABSENT from
    /// the delivered answer — i.e. the turn concluded (claimed done) without the deliverable. This is
    /// the flag that pinpoints the 2026-07-03 "no table but claimed a table" failure.
    pub claimed_done_without_artifact: bool,
}

/// One trace line. `kind` + a flat payload keeps it greppable and easy to read.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TurnEvent {
    TurnStart {
        prompt_head: String,
        prompt_len: usize,
        mode: String,
        model: String,
        tier: String,
    },
    Round {
        round: usize,
        finish_reason: String,
        tool_calls: Vec<String>,
        content_delta_len: usize,
    },
    Plan {
        op: String,
        sent: Vec<String>,
        canonical: Vec<String>,
    },
    Nudge {
        reason: String,
        next_step: String,
    },
    ForcedSynthesis {
        finish_reason: String,
    },
    Reconcile {
        fired: bool,
        step: String,
        open_steps: usize,
        delivered_chars: usize,
        threshold: usize,
    },
    TurnEnd {
        final_len: usize,
        plan_final: Vec<String>,
        signals: AnswerSignals,
        derived: DerivedFlags,
    },
}

/// A markdown table = at least two CONSECUTIVE lines that look like table rows (a leading pipe with
/// content). Cheap, no regex dependency. Catches header+separator or two data rows.
pub fn has_markdown_table(text: &str) -> bool {
    let mut prev_row = false;
    for line in text.lines() {
        let l = line.trim();
        let is_row = l.starts_with('|') && l.matches('|').count() >= 2;
        if is_row && prev_row {
            return true;
        }
        prev_row = is_row;
    }
    false
}

/// Count http(s) URLs as a proxy for cited sources.
pub fn count_sources(text: &str) -> usize {
    text.matches("http://").count() + text.matches("https://").count()
}

pub fn answer_signals(text: &str, artifact_count: usize) -> AnswerSignals {
    AnswerSignals {
        has_table: has_markdown_table(text),
        sources_count: count_sources(text),
        artifact_count,
    }
}

/// `plan_final` = final status per step; `plan_titles` = step titles (for the artifact-keyword match).
pub fn derive_flags(
    plan_final: &[String],
    plan_titles: &[String],
    signals: &AnswerSignals,
) -> DerivedFlags {
    let incomplete_steps = plan_final.iter().filter(|s| s.as_str() != "done").count();
    let claimed_done_without_artifact = plan_titles.iter().any(|title| {
        let t = title.to_lowercase();
        let wants_table = t.contains("tabella") || t.contains("table");
        let wants_file = ["file", "deck", "presentazione", "documento", "report", "grafico", "chart"]
            .iter()
            .any(|k| t.contains(k));
        (wants_table && !signals.has_table) || (wants_file && signals.artifact_count == 0)
    });
    DerivedFlags {
        incomplete_steps,
        claimed_done_without_artifact,
    }
}

struct Inner {
    turn_id: String,
    dir: std::path::PathBuf,
    start: Instant,
    seq: AtomicUsize,
    max_bytes: u64,
}

/// Cheap `Arc`-cloneable handle. `None` = disabled/no-logs-dir → every `record` is a silent no-op, so
/// it can live on `ChatToolCtx` and in the loop without threading a writer or guarding call sites.
#[derive(Clone)]
pub struct TurnTrace(Option<Arc<Inner>>);

impl TurnTrace {
    /// Disabled handle (opt-out `HOMUN_TURN_TRACE=0/off`, or no resolvable logs dir).
    pub fn disabled() -> Self {
        TurnTrace(None)
    }

    /// Enabled handle writing under `dir`. `max_bytes` bounds the file (rotate at the threshold).
    pub fn new(turn_id: impl Into<String>, dir: std::path::PathBuf, max_bytes: u64) -> Self {
        TurnTrace(Some(Arc::new(Inner {
            turn_id: turn_id.into(),
            dir,
            start: Instant::now(),
            seq: AtomicUsize::new(0),
            max_bytes,
        })))
    }

    /// Record one event (best-effort; never panics; no-op when disabled).
    pub fn record(&self, event: TurnEvent) {
        let Some(inner) = &self.0 else {
            return;
        };
        let seq = inner.seq.fetch_add(1, Ordering::Relaxed);
        let t_ms = inner.start.elapsed().as_millis();
        append(&inner.dir, &inner.turn_id, seq, t_ms, &event, inner.max_bytes);
    }
}

/// Append one JSON line `{turn_id, seq, t_ms, ...event}` to `<dir>/turn-trace.jsonl`. Rotates the file
/// to `.1` when it would exceed `max_bytes`. Swallows every error — a trace failure must never crash or
/// interrupt a turn (mirror `tool_trace_dump::append`).
fn append(dir: &Path, turn_id: &str, seq: usize, t_ms: u128, event: &TurnEvent, max_bytes: u64) {
    // Merge the envelope with the event's tagged fields into one flat object.
    let Ok(mut value) = serde_json::to_value(event) else {
        return;
    };
    if let serde_json::Value::Object(map) = &mut value {
        map.insert("turn_id".into(), serde_json::json!(turn_id));
        map.insert("seq".into(), serde_json::json!(seq));
        map.insert("t_ms".into(), serde_json::json!(t_ms as u64));
    }
    let Ok(mut line) = serde_json::to_string(&value) else {
        return;
    };
    line.push('\n');
    let path = dir.join("turn-trace.jsonl");
    // Rotate if the existing file is already at/over the cap.
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() >= max_bytes {
            let _ = std::fs::rename(&path, dir.join("turn-trace.jsonl.1"));
        }
    }
    use std::io::Write as _;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = f.write_all(line.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_a_markdown_table_but_not_a_prose_source_list() {
        let table = "| Titolo | Fonte |\n| --- | --- |\n| A | B |";
        assert!(has_markdown_table(table));
        let prose = "Ecco il confronto...\n\n**Sources**\n- https://a.com\n- https://b.com";
        assert!(!has_markdown_table(prose));
    }

    #[test]
    fn counts_source_urls() {
        assert_eq!(count_sources("see https://a.com and http://b.com"), 2);
        assert_eq!(count_sources("no links here"), 0);
    }

    #[test]
    fn flags_a_table_step_delivered_without_a_table() {
        // The 2026-07-03 failure: step wants a table, answer has none.
        let signals = AnswerSignals {
            has_table: false,
            sources_count: 3,
            artifact_count: 0,
        };
        let flags = derive_flags(
            &["done".into(), "done".into(), "done".into(), "doing".into()],
            &[
                "Cercare".into(),
                "Selezionare".into(),
                "Leggere".into(),
                "Compilare tabella finale".into(),
            ],
            &signals,
        );
        assert!(flags.claimed_done_without_artifact);
        assert_eq!(flags.incomplete_steps, 1);
    }

    #[test]
    fn no_flag_when_the_table_is_present() {
        let signals = AnswerSignals {
            has_table: true,
            sources_count: 3,
            artifact_count: 0,
        };
        let flags = derive_flags(&["done".into()], &["Compilare tabella".into()], &signals);
        assert!(!flags.claimed_done_without_artifact);
    }

    #[test]
    fn no_artifact_flag_when_no_step_expects_one() {
        let signals = AnswerSignals {
            has_table: false,
            sources_count: 0,
            artifact_count: 0,
        };
        let flags = derive_flags(&["done".into()], &["Rispondere alla domanda".into()], &signals);
        assert!(!flags.claimed_done_without_artifact);
        assert_eq!(flags.incomplete_steps, 0);
    }

    #[test]
    fn append_never_panics_on_a_bad_dir() {
        // A path that can't be created/written must be swallowed silently.
        let t = TurnTrace::new(
            "tid",
            std::path::PathBuf::from("/nonexistent/xyz/deep"),
            5_000_000,
        );
        t.record(TurnEvent::ForcedSynthesis {
            finish_reason: "stop".into(),
        });
        // no panic == pass
    }

    #[test]
    fn disabled_handle_is_a_silent_noop() {
        TurnTrace::disabled().record(TurnEvent::Round {
            round: 0,
            finish_reason: "stop".into(),
            tool_calls: vec![],
            content_delta_len: 0,
        });
    }
}
