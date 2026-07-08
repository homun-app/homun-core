#![allow(dead_code)]
//! Parity oracle for the agent loop's per-tool-call dispatch (ADR 0024 inc 5).
//!
//! Purpose: PROVE the loop's move into this crate (5.D1c.10) is behavior-preserving. This module
//! records, per tool call, a *normalized* fingerprint of what happened — captured at the loop boundary
//! so it observes the same thing whether the loop runs inline in the gateway or here in the engine.
//! Relocated verbatim from the gateway (5.D1c.9) so the moved loop calls it locally; `append` takes an
//! explicit dir (the gateway resolves `~/.homun/logs` and injects it), and the two `std::env` reads
//! (`HOME` for path-stripping, `HOMUN_TRACE_DUMP` for the arm switch) are a deliberate debug-only
//! exception to the crate's no-env rule.
//!
//! The dump is gated behind `HOMUN_TRACE_DUMP=1` and, when off, costs nothing
//! beyond two `len()` snapshots at the call site. On ANY IO error the append is
//! a silent no-op: the harness must NEVER crash or interrupt a chat turn.
//!
//! No new crate dependencies: normalization is hand-rolled scanning, and the
//! hash is a fully-specified FNV-1a (64-bit) over the UTF-8 bytes. FNV-1a is
//! deterministic AND toolchain-stable — unlike `DefaultHasher`, whose algorithm
//! is unspecified and may change on a compiler upgrade, which would silently rot
//! committed goldens. No sha2/blake3 dependency needed.

/// One line of the `tool-trace.jsonl` dump: a normalized fingerprint of a single
/// tool-call iteration, taken at the loop boundary.
#[derive(serde::Serialize)]
pub struct ToolTraceRecord {
    pub round: usize,
    /// 0-based index of the call within the round.
    pub idx: usize,
    pub name: String,
    /// FNV-1a hex over normalize(args_raw)
    pub args_hash: String,
    /// FNV-1a hex over normalize(result)
    pub result_hash: String,
    /// result.chars().count()
    pub result_len: usize,
    /// normalize(result), truncated to 120 chars (char-safe)
    pub result_head: String,
    /// accumulated.len() after - before (byte len)
    pub acc_delta_len: usize,
    /// marker tokens that appeared in accumulated during this call
    pub acc_markers: Vec<String>,
    /// True only for the call that RAISED `pending_confirm` this iteration
    /// (`pending_confirm && !pc_before`). `pending_confirm` lives outside the
    /// loop and is never reset, so recording its raw value would misattribute
    /// the flag to every later call in the round.
    pub pending_confirm_raised: bool,
    /// messages.len() after - before (element count). On the normal recorded
    /// path this is invariantly 1 (the tool push); kept as cheap future-proofing
    /// and to catch a dispatch arm that pushes extra messages inside the loop.
    pub msgs_pushed: usize,
    /// True when this call hit the `workflow_route_blocked_tool_message` arm
    /// (pushes a tool message then `continue`s). The upcoming extraction handles
    /// this arm specially, so it must be visible to the oracle.
    pub blocked: bool,
    /// True when, after this arm ran, a browser image is pending
    /// (`pending_browser_image.is_some()`) — i.e. the browser_screenshot arm's
    /// side effect that pushes a SECOND message AFTER the loop. `msgs_pushed`
    /// cannot see that later push, so this flag fingerprints the side effect.
    pub browser_image_set: bool,
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

/// Replace every ISO-8601 timestamp with `<TS>`.
///
/// The core pattern is `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}` (19 chars),
/// optionally followed by a fractional part (`.` + 1+ digits) and/or a timezone
/// suffix (`Z`, or `+`/`-` then `dd:dd`) — see [`timestamp_match_end`].
///
/// UTF-8 safety: the byte scan is used ONLY to DETECT match spans (all matched
/// bytes are ASCII). Non-matched content is copied by slicing the ORIGINAL
/// `&str` (`&s[last..start]`), which always lands on char boundaries because a
/// match never starts/ends inside a multi-byte char. So accented text, the
/// `‹‹MARKER››` guillemets, and emoji survive intact.
fn replace_timestamps(s: &str) -> String {
    let bytes = s.as_bytes();
    let n = bytes.len();
    let mut out = String::with_capacity(n);
    let mut last = 0; // start of the not-yet-copied original slice
    let mut i = 0;
    while i < n {
        if let Some(end) = timestamp_match_end(bytes, i) {
            out.push_str(&s[last..i]);
            out.push_str("<TS>");
            last = end;
            i = end;
        } else {
            i += 1;
        }
    }
    out.push_str(&s[last..]);
    out
}

const TIMESTAMP_CORE_LEN: usize = 19; // 2026-07-02T13:45:00

/// If a timestamp starts at `i`, return the byte offset just past it (core plus
/// any optional fractional/timezone suffix); otherwise `None`. Bounded and
/// panic-safe: every index is checked against `b.len()`; all bytes are ASCII.
fn timestamp_match_end(b: &[u8], i: usize) -> Option<usize> {
    if i + TIMESTAMP_CORE_LEN > b.len() {
        return None;
    }
    let is_d = |k: usize| b[i + k].is_ascii_digit();
    let core_ok = is_d(0)
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
        && is_d(18);
    if !core_ok {
        return None;
    }
    let mut end = i + TIMESTAMP_CORE_LEN;
    // Optional fractional part: '.' then 1+ digits (greedy).
    if end < b.len() && b[end] == b'.' && end + 1 < b.len() && b[end + 1].is_ascii_digit() {
        end += 1; // consume '.'
        while end < b.len() && b[end].is_ascii_digit() {
            end += 1;
        }
    }
    // Optional timezone suffix: 'Z', or ('+'|'-') then dd:dd.
    if end < b.len() {
        if b[end] == b'Z' {
            end += 1;
        } else if (b[end] == b'+' || b[end] == b'-') && end + 5 < b.len() {
            let d = |k: usize| b[end + k].is_ascii_digit();
            if d(1) && d(2) && b[end + 3] == b':' && d(4) && d(5) {
                end += 6; // ±dd:dd
            }
        }
    }
    Some(end)
}

/// Replace every canonical hyphenated hex UUID (`8-4-4-4-12`) with `<UUID>`.
///
/// Same UTF-8-safe strategy as [`replace_timestamps`]: byte scan detects the
/// match span; non-matched content is copied via original-`&str` slices.
fn replace_uuids(s: &str) -> String {
    let bytes = s.as_bytes();
    let n = bytes.len();
    let mut out = String::with_capacity(n);
    let mut last = 0;
    let mut i = 0;
    while i < n {
        if matches_uuid(bytes, i) {
            out.push_str(&s[last..i]);
            out.push_str("<UUID>");
            last = i + UUID_LEN;
            i += UUID_LEN;
        } else {
            i += 1;
        }
    }
    out.push_str(&s[last..]);
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

/// 64-bit FNV-1a hex digest of `s`'s UTF-8 bytes.
///
/// Fully specified (offset basis `0xcbf29ce4_84222325`, prime `0x100000001b3`,
/// wrapping multiply), so the digest is identical across processes AND across
/// Rust toolchains. This is what keeps committed goldens valid over a compiler
/// upgrade — `DefaultHasher`'s algorithm is unspecified and could change. Not a
/// crypto hash and not meant to be one; it is a stable parity fingerprint.
pub fn hash_hex(s: &str) -> String {
    const OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut h = OFFSET_BASIS;
    for &byte in s.as_bytes() {
        h ^= byte as u64;
        h = h.wrapping_mul(PRIME);
    }
    format!("{h:016x}")
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
            pending_confirm_raised: false,
            msgs_pushed: 0,
            blocked: false,
            browser_image_set: false,
        };
        // Non-existent dir → OpenOptions fails → silent no-op, no panic.
        let missing = std::path::Path::new("/nonexistent-homun-trace-dir-xyz");
        append(missing, &rec);
    }

    #[test]
    fn normalize_preserves_multibyte_utf8() {
        // Accented Italian text, the marker guillemets, and emoji must all
        // survive normalization untouched (only TS/UUID/home get replaced).
        let input = "però ‹‹PLAN›› café 🚀 at 2026-07-02T13:45:00 done";
        let got = normalize_with_home(input, None);
        assert_eq!(got, "però ‹‹PLAN›› café 🚀 at <TS> done");
        // Explicit substring checks so a regression is unambiguous.
        assert!(got.contains("però"));
        assert!(got.contains("‹‹PLAN››"));
        assert!(got.contains("café"));
        assert!(got.contains("🚀"));
    }

    #[test]
    fn normalize_strips_timestamp_with_fraction_and_zulu() {
        let got = normalize_with_home("2026-07-02T13:45:00.123Z tail", None);
        assert_eq!(got, "<TS> tail");
    }

    #[test]
    fn normalize_strips_timestamp_with_offset_tz() {
        let got = normalize_with_home("2026-07-02T13:45:00+02:00 tail", None);
        assert_eq!(got, "<TS> tail");
    }

    #[test]
    fn hash_hex_is_fnv1a_known_vectors() {
        // FNV-1a/64 reference vectors (well-known): empty and "a".
        assert_eq!(hash_hex(""), "cbf29ce484222325");
        assert_eq!(hash_hex("a"), "af63dc4c8601ec8c");
    }
}
