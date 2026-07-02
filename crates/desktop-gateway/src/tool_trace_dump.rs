#![allow(dead_code)]
//! Observation harness for the per-tool-call dispatch loop in
//! `stream_chat_via_openai`.
//!
//! Purpose: before we extract the ~3200-line tool-dispatch if/else block into a
//! standalone function, we need to PROVE the extraction is behavior-preserving.
//! This module records, per tool call, a *normalized* fingerprint of what
//! happened — captured at the loop boundary so it observes the same thing
//! whether the dispatch body is inline or extracted.
//!
//! The dump is gated behind `HOMUN_TRACE_DUMP=1` and, when off, costs nothing
//! beyond two `len()` snapshots at the call site. On ANY IO error the append is
//! a silent no-op: the harness must NEVER crash or interrupt a chat turn.
//!
//! No new crate dependencies: normalization is hand-rolled scanning, and the
//! hash is `DefaultHasher` (fixed keys → deterministic across processes), not
//! sha2/blake3.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

/// One line of the `tool-trace.jsonl` dump: a normalized fingerprint of a single
/// tool-call iteration, taken at the loop boundary.
#[derive(serde::Serialize)]
pub struct ToolTraceRecord {
    pub round: usize,
    /// 0-based index of the call within the round.
    pub idx: usize,
    pub name: String,
    /// hex of DefaultHasher over normalize(args_raw)
    pub args_hash: String,
    /// hex of DefaultHasher over normalize(result)
    pub result_hash: String,
    /// result.chars().count()
    pub result_len: usize,
    /// normalize(result), truncated to 120 chars (char-safe)
    pub result_head: String,
    /// accumulated.len() after - before (byte len)
    pub acc_delta_len: usize,
    /// marker tokens that appeared in accumulated during this call
    pub acc_markers: Vec<String>,
    pub pending_confirm: bool,
    /// messages.len() after - before (byte len is n/a; this is element count)
    pub msgs_pushed: usize,
}

/// Normalize text so fingerprints are stable across runs/machines: strip the
/// user's home dir, ISO-8601 timestamps, and UUIDs.
///
/// - Home dir absolute path → `~` (skipped if `HOME` is unset).
/// - `YYYY-MM-DDTHH:MM:SS` → `<TS>`.
/// - `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` (hex UUID) → `<UUID>`.
///
/// Timestamp/UUID replacement is hand-written scanning because `regex` is not a
/// dependency of this crate.
pub fn normalize(s: &str) -> String {
    normalize_with_home(s, std::env::var("HOME").ok().as_deref())
}

/// Core of [`normalize`] with the home dir injected, so tests exercise the
/// home-strip WITHOUT mutating the global `HOME` env var (which would race with
/// sibling tests in the same process).
fn normalize_with_home(s: &str, home: Option<&str>) -> String {
    // Home dir → `~`. Plain string replace; longest-match-first is unnecessary
    // since there is a single home value.
    let home_stripped = match home {
        Some(home) if !home.is_empty() => s.replace(home, "~"),
        _ => s.to_string(),
    };
    let ts_stripped = replace_timestamps(&home_stripped);
    replace_uuids(&ts_stripped)
}

/// Replace every `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}` occurrence with `<TS>`.
/// Byte-oriented scan over ASCII digits/`-`/`T`/`:`; safe because all matched
/// bytes are ASCII (single-byte in UTF-8) and we copy the rest verbatim.
fn replace_timestamps(s: &str) -> String {
    let bytes = s.as_bytes();
    let n = bytes.len();
    let mut out = String::with_capacity(n);
    let mut i = 0;
    while i < n {
        if matches_timestamp(bytes, i) {
            out.push_str("<TS>");
            i += TIMESTAMP_LEN;
        } else {
            // Copy this byte. Since we only ever advance `i` past a full ASCII
            // match or by 1 on a raw byte, and multi-byte UTF-8 leading/cont
            // bytes are all >= 0x80 (never matched by the digit patterns), this
            // preserves UTF-8 boundaries.
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}

const TIMESTAMP_LEN: usize = 19; // 2026-07-02T13:45:00

fn matches_timestamp(b: &[u8], i: usize) -> bool {
    // Pattern positions: dddd-dd-ddTdd:dd:dd
    if i + TIMESTAMP_LEN > b.len() {
        return false;
    }
    let is_d = |k: usize| b[i + k].is_ascii_digit();
    is_d(0)
        && is_d(1)
        && is_d(2)
        && is_d(3)
        && b[i + 4] == b'-'
        && is_d(5)
        && is_d(6)
        && b[i + 7] == b'-'
        && is_d(8)
        && is_d(9)
        && b[i + 10] == b'T'
        && is_d(11)
        && is_d(12)
        && b[i + 13] == b':'
        && is_d(14)
        && is_d(15)
        && b[i + 16] == b':'
        && is_d(17)
        && is_d(18)
}

/// Replace every canonical hyphenated hex UUID
/// (`8-4-4-4-12` hex digits) with `<UUID>`. Hand-written byte scan.
fn replace_uuids(s: &str) -> String {
    let bytes = s.as_bytes();
    let n = bytes.len();
    let mut out = String::with_capacity(n);
    let mut i = 0;
    while i < n {
        if matches_uuid(bytes, i) {
            out.push_str("<UUID>");
            i += UUID_LEN;
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}

const UUID_LEN: usize = 36; // 8 + 1 + 4 + 1 + 4 + 1 + 4 + 1 + 12

fn matches_uuid(b: &[u8], i: usize) -> bool {
    if i + UUID_LEN > b.len() {
        return false;
    }
    // Hyphen positions within the 36-char window: 8, 13, 18, 23.
    const HYPHENS: [usize; 4] = [8, 13, 18, 23];
    for k in 0..UUID_LEN {
        if HYPHENS.contains(&k) {
            if b[i + k] != b'-' {
                return false;
            }
        } else if !b[i + k].is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

/// Return every opening marker token of the form `‹‹NAME››`
/// (opening = two U+2039 `‹‹`, closing = two U+203A `››`, NAME = uppercase
/// letters / `_`) that appears in `&accumulated[prev_len..]`, in order.
///
/// Closing markers (`‹‹/NAME››`) are intentionally NOT matched: the `/` right
/// after `‹‹` fails the uppercase-name rule.
///
/// `prev_len` is a byte offset. If it is >= accumulated.len(), or does not land
/// on a char boundary, returns an empty vec (safe).
pub fn extract_markers(prev_len: usize, accumulated: &str) -> Vec<String> {
    if prev_len >= accumulated.len() || !accumulated.is_char_boundary(prev_len) {
        return Vec::new();
    }
    let delta = &accumulated[prev_len..];
    const OPEN: &str = "\u{2039}\u{2039}"; // ‹‹
    const CLOSE: &str = "\u{203a}\u{203a}"; // ››
    let mut out = Vec::new();
    let mut search = delta;
    while let Some(open_at) = search.find(OPEN) {
        let after_open = &search[open_at + OPEN.len()..];
        if let Some(close_at) = after_open.find(CLOSE) {
            let name = &after_open[..close_at];
            if !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c == '_')
            {
                out.push(format!("{OPEN}{name}{CLOSE}"));
            }
            // Advance past this closing delimiter so we don't rescan it.
            let consumed = open_at + OPEN.len() + close_at + CLOSE.len();
            search = &search[consumed..];
        } else {
            // Unterminated opener: nothing more can match.
            break;
        }
    }
    out
}

/// Hex of a `DefaultHasher` over `s`. `DefaultHasher::new()` uses fixed keys, so
/// the digest is deterministic across processes — good enough for a parity
/// fingerprint, and it avoids pulling in a crypto-hash dependency.
pub fn hash_hex(s: &str) -> String {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Whether the dump is armed (`HOMUN_TRACE_DUMP=1`).
pub fn dump_enabled() -> bool {
    std::env::var("HOMUN_TRACE_DUMP").as_deref() == Ok("1")
}

/// Append one JSON line for `record` to `<dir>/tool-trace.jsonl`.
///
/// No-op when the dump is disarmed. On ANY error (serialization or IO) this
/// silently does nothing: the harness must never crash or interrupt a turn, so
/// there is no `unwrap`, no `?` that escapes, and no panic.
pub fn append(dir: &std::path::Path, record: &ToolTraceRecord) {
    if !dump_enabled() {
        return;
    }
    let Ok(mut line) = serde_json::to_string(record) else {
        return;
    };
    line.push('\n');
    let path = dir.join("tool-trace.jsonl");
    // Open-for-append; swallow every error path.
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

    // NOTE: the home-strip tests use `normalize_with_home` (home injected) rather
    // than `normalize` + `set_var("HOME", …)`. Mutating the global `HOME` env var
    // would race with sibling tests running concurrently in the same process
    // (e.g. any test that resolves a data dir from `HOME`), so we keep these
    // hermetic and parallelism-safe.

    #[test]
    fn normalize_strips_home() {
        let input = "opened /Users/tester/.homun/logs/x and /Users/tester/file";
        let got = normalize_with_home(input, Some("/Users/tester"));
        assert_eq!(got, "opened ~/.homun/logs/x and ~/file");
    }

    #[test]
    fn normalize_strips_timestamp() {
        // No home dependency in the string, so `normalize` itself is safe here.
        let input = "started at 2026-07-02T13:45:00 then done";
        let got = normalize(input);
        assert_eq!(got, "started at <TS> then done");
    }

    #[test]
    fn normalize_strips_uuid() {
        let input = "id=550e8400-e29b-41d4-a716-446655440000 done";
        let got = normalize(input);
        assert_eq!(got, "id=<UUID> done");
    }

    #[test]
    fn normalize_strips_all_three_together() {
        let input =
            "/Users/tester/x at 2026-01-02T03:04:05 uuid 00000000-1111-2222-3333-444444444444";
        let got = normalize_with_home(input, Some("/Users/tester"));
        assert_eq!(got, "~/x at <TS> uuid <UUID>");
    }

    #[test]
    fn normalize_with_no_home_leaves_paths() {
        let input = "/Users/tester/x untouched";
        assert_eq!(normalize_with_home(input, None), input);
    }

    #[test]
    fn normalize_leaves_non_matches_intact() {
        // A near-miss timestamp (only 3 leading digits) and a short hex run must
        // survive unchanged. Uses `normalize_with_home(None)` to avoid depending
        // on the ambient HOME.
        let input = "202-07-02T13:45:00 and deadbeef and 1234-56-78";
        let got = normalize_with_home(input, None);
        assert_eq!(got, input);
    }

    #[test]
    fn extract_markers_finds_all_in_delta() {
        let acc = "prefix‹‹PLAN››middle‹‹ARTIFACT››tail";
        // prev_len at start of "middle" region? Use 0 to scan whole thing.
        let got = extract_markers(0, acc);
        assert_eq!(got, vec!["‹‹PLAN››".to_string(), "‹‹ARTIFACT››".to_string()]);
    }

    #[test]
    fn extract_markers_ignores_before_prev_len() {
        let before = "‹‹PLAN››";
        let after = "‹‹ARTIFACT››rest";
        let acc = format!("{before}{after}");
        let prev_len = before.len(); // byte offset just past the first marker
        let got = extract_markers(prev_len, &acc);
        assert_eq!(got, vec!["‹‹ARTIFACT››".to_string()]);
    }

    #[test]
    fn extract_markers_ignores_closing_markers() {
        // Closing markers ‹‹/ARTIFACT›› must NOT be captured (leading '/').
        let acc = "‹‹ARTIFACT››body‹‹/ARTIFACT››";
        let got = extract_markers(0, acc);
        assert_eq!(got, vec!["‹‹ARTIFACT››".to_string()]);
    }

    #[test]
    fn extract_markers_handles_prev_len_ge_len() {
        let acc = "‹‹PLAN››";
        // prev_len == len → empty.
        assert!(extract_markers(acc.len(), acc).is_empty());
        // prev_len > len → empty (no panic).
        assert!(extract_markers(acc.len() + 100, acc).is_empty());
    }

    #[test]
    fn extract_markers_empty_on_no_markers() {
        assert!(extract_markers(0, "no markers here").is_empty());
    }

    #[test]
    fn hash_hex_stable_for_equal_input() {
        assert_eq!(hash_hex("hello world"), hash_hex("hello world"));
        // 16 hex chars.
        assert_eq!(hash_hex("hello world").len(), 16);
    }

    #[test]
    fn hash_hex_differs_for_different_input() {
        assert_ne!(hash_hex("hello"), hash_hex("world"));
    }

    #[test]
    fn append_never_panics() {
        // `append` must never crash the turn: whether the dump is armed or not,
        // and even against a non-existent directory, it swallows all errors.
        // We deliberately do NOT mutate `HOMUN_TRACE_DUMP` here — that global env
        // var is shared across concurrent tests, so toggling it would race.
        let rec = ToolTraceRecord {
            round: 0,
            idx: 0,
            name: "noop".to_string(),
            args_hash: "0".to_string(),
            result_hash: "0".to_string(),
            result_len: 0,
            result_head: String::new(),
            acc_delta_len: 0,
            acc_markers: vec![],
            pending_confirm: false,
            msgs_pushed: 0,
        };
        // Non-existent dir → OpenOptions fails → silent no-op, no panic.
        let missing = std::path::Path::new("/nonexistent-homun-trace-dir-xyz");
        append(missing, &rec);
    }
}
