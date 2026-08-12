//! Pure browser-support helpers for the loop (ADR 0024, increment 5, Point 5 / 5.D1c.2).
//!
//! Relocated verbatim from the gateway monolith so the loop body — headed into this crate — calls
//! them locally instead of gateway free-fns. All pure (tool-name string reasoning + serde-`Value`
//! message hygiene, no `AppState`/HTTP/IO), so they belong in the leaf engine. The gateway keeps
//! calling them via `use local_first_engine::browser::…`, so its other call sites resolve unchanged.
//! ADR 0025 (browse-as-recursion) will fold much of this away, but the pruning + name-canonicalization
//! stay useful for any tool history.

use serde_json::Value;

/// The canonical native browser tool names (the granular set the chat agent drives).
const NATIVE_BROWSER_TOOLS: [&str; 8] = [
    "browser_navigate",
    "browser_snapshot",
    "browser_rehydrate",
    "browser_act",
    "browser_screenshot",
    "browser_tabs",
    "browser_dialog",
    "browser_done",
];

/// The stub that replaces an OLDER browser snapshot's content once a newer one exists (context
/// hygiene: only the latest snapshot is kept in full; older ones would overflow the window). `pub`
/// so the gateway's pruning tests can assert against the canonical value.
pub const PRUNED_SNAPSHOT_STUB: &str =
    "[previous snapshot removed — call browser_snapshot again if needed]";

/// Fixed prefix of the gateway's stale-ref auto-recovery message (`main.rs`'s
/// `stale_ref_recovery_message`): a `[ref=eN]` the model targeted no longer exists because the page
/// changed, so the gateway takes a fresh snapshot and hands it back inside the SAME `Ok(...)` tool
/// result instead of erroring. That `Ok` looks like an ordinary successful `browser_act` to
/// `classify_tool_result` (it's plain text, not the `{"status":"blocked"}` shape), so left alone it
/// resets `browser_no_progress` to 0 (MINOR 8) — a ref-churning SPA can then loop
/// act→stale→snapshot→act forever, since fresh refs keep going stale before the model can use them.
/// A stale-ref recovery is a real observation but NOT progress toward the goal, so the loop must
/// count it like any other stall. `pub` (not private to the gateway) so BOTH sides share one
/// literal: the gateway builds its message off this constant and the loop recognizes it via
/// [`is_stale_ref_recovery_result`] — a single source of truth instead of two crates independently
/// guessing at the same string.
pub const STALE_REF_RECOVERY_MARKER: &str = "⚠ The reference had expired (the page changed).";

/// True when a browser tool result is the gateway's stale-ref auto-recovery message (see
/// [`STALE_REF_RECOVERY_MARKER`]) rather than an ordinary tool result. The loop uses this to keep
/// `browser_no_progress` advancing on repeated stale-ref churn instead of resetting on every
/// recovery.
pub fn is_stale_ref_recovery_result(result: &str) -> bool {
    result.starts_with(STALE_REF_RECOVERY_MARKER)
}

/// True for the granular browser tools that must route through the browser seam (the mid-turn
/// `&mut` browser branch), NOT the pure capability chokepoint. ADR 0025 folds this into `browse`.
pub fn is_browser_granular_tool(name: &str) -> bool {
    matches!(
        name,
        "browser_navigate"
            | "browser_snapshot"
            | "browser_rehydrate"
            | "browser_act"
            | "browser_screenshot"
            | "browser_tabs"
            | "browser_dialog"
            | "browser_done"
    )
}

/// Canonicalize a possibly-typo'd native browser tool name. The model occasionally hallucinates a
/// near-miss (observed: `browser_tavigate` for `browser_navigate`); accept an exact match, else the
/// closest `browser_`-prefixed name within edit-distance 2 (and only if unambiguous).
pub fn resolve_browser_chat_tool_name(name: &str) -> Option<&'static str> {
    if let Some(exact) = NATIVE_BROWSER_TOOLS
        .iter()
        .copied()
        .find(|candidate| *candidate == name)
    {
        return Some(exact);
    }
    if !name.starts_with("browser_") {
        return None;
    }
    let mut best: Option<(&'static str, usize)> = None;
    let mut tied = false;
    for candidate in NATIVE_BROWSER_TOOLS {
        let distance = levenshtein(name, candidate);
        match best {
            None => best = Some((candidate, distance)),
            Some((_, current)) if distance < current => {
                best = Some((candidate, distance));
                tied = false;
            }
            Some((_, current)) if distance == current => tied = true,
            _ => {}
        }
    }
    match best {
        Some((candidate, distance)) if distance <= 2 && !tied => Some(candidate),
        _ => None,
    }
}

/// Classic edit distance (two-row DP). Private: only the near-miss canonicalizer needs it.
fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = if ca == cb { 0 } else { 1 };
            cur[j + 1] = (prev[j + 1] + 1).min(cur[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// How many of the most-recent browser tool-result observations to keep in full when pruning
/// history. Older observations are replaced with [`PRUNED_SNAPSHOT_STUB`]. Controlled by the
/// `HOMUN_BROWSER_HISTORY_DEPTH` environment variable (default: 1 = keep only the latest,
/// preserving the pre-existing behaviour). Image pruning is unaffected — only the latest
/// screenshot is ever retained regardless of this value.
fn browser_history_depth() -> usize {
    std::env::var("HOMUN_BROWSER_HISTORY_DEPTH")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .map(|n| n.max(1))
        .unwrap_or(1)
}

/// Context hygiene across rounds: keep only the latest N browser tool-result observations
/// (controlled by `HOMUN_BROWSER_HISTORY_DEPTH`, default 1 — stub older ones) and only the
/// LATEST image message (strip older `image_url` parts). At up to 32 rounds the accumulated
/// snapshots/images would overflow the window and silently truncate the page.
pub fn prune_browser_history(
    messages: &mut [Value],
    browser_tool_call_ids: &std::collections::BTreeSet<String>,
) {
    prune_browser_history_depth(messages, browser_tool_call_ids, browser_history_depth());
}

/// Depth-parameterized core of [`prune_browser_history`]. `depth` is the number of most-recent
/// browser observations to retain (clamped to ≥ 1). Image pruning always keeps only the latest.
/// Exposed for deterministic unit testing without env-var side-effects.
fn prune_browser_history_depth(
    messages: &mut [Value],
    browser_tool_call_ids: &std::collections::BTreeSet<String>,
    depth: usize,
) {
    if browser_tool_call_ids.is_empty() {
        // No browser tool ran yet: only image pruning could apply, and that is
        // driven by browser screenshots too, so nothing to do.
        return;
    }
    let depth = depth.max(1);
    // 1) Snapshots: keep the latest `depth` browser tool-results; stub older ones.
    let browser_indices: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, message)| {
            message.get("role").and_then(|r| r.as_str()) == Some("tool")
                && message
                    .get("tool_call_id")
                    .and_then(|c| c.as_str())
                    .map(|id| browser_tool_call_ids.contains(id))
                    .unwrap_or(false)
        })
        .map(|(idx, _)| idx)
        .collect();
    if browser_indices.is_empty() {
        // No browser observations present; only image pruning applies below.
    } else {
        // The last `depth` indices are kept; everything before them is stubbed.
        let keep_from = browser_indices.len().saturating_sub(depth);
        let keep_set: std::collections::HashSet<usize> =
            browser_indices[keep_from..].iter().copied().collect();
        for (idx, message) in messages.iter_mut().enumerate() {
            if keep_set.contains(&idx) {
                continue;
            }
            let is_browser_tool = message.get("role").and_then(|r| r.as_str()) == Some("tool")
                && message
                    .get("tool_call_id")
                    .and_then(|c| c.as_str())
                    .map(|id| browser_tool_call_ids.contains(id))
                    .unwrap_or(false);
            if is_browser_tool && let Some(obj) = message.as_object_mut() {
                obj.insert(
                    "content".to_string(),
                    Value::String(PRUNED_SNAPSHOT_STUB.to_string()),
                );
            }
        }
    }
    // 2) Images: keep only the LATEST user message that has an image_url part;
    //    strip image parts from older ones (down to a text stub).
    let mut latest_image_msg: Option<usize> = None;
    for (idx, message) in messages.iter().enumerate() {
        if message_has_image_url(message) {
            latest_image_msg = Some(idx);
        }
    }
    if let Some(keep) = latest_image_msg {
        for (idx, message) in messages.iter_mut().enumerate() {
            if idx == keep {
                continue;
            }
            if message_has_image_url(message) {
                strip_image_url_parts(message);
            }
        }
    }
}

/// True if a multimodal message carries at least one `image_url` content part. Generic (any
/// vision message), homed here because `prune_browser_history` is its primary user.
pub fn message_has_image_url(message: &Value) -> bool {
    message
        .get("content")
        .and_then(|c| c.as_array())
        .map(|parts| {
            parts
                .iter()
                .any(|p| p.get("type").and_then(|t| t.as_str()) == Some("image_url"))
        })
        .unwrap_or(false)
}

/// Replaces the `image_url` parts of a multimodal message with a short text stub, keeping any
/// existing text parts intact.
pub fn strip_image_url_parts(message: &mut Value) {
    let Some(parts) = message.get_mut("content").and_then(|c| c.as_array_mut()) else {
        return;
    };
    let mut had_image = false;
    parts.retain(|p| {
        if p.get("type").and_then(|t| t.as_str()) == Some("image_url") {
            had_image = true;
            false
        } else {
            true
        }
    });
    if had_image {
        parts.push(serde_json::json!({
            "type": "text",
            "text": "[previous image removed — capture a new screenshot if needed]"
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_exact_and_near_miss_browser_names() {
        assert_eq!(
            resolve_browser_chat_tool_name("browser_navigate"),
            Some("browser_navigate")
        );
        // one-char typo within distance 2, unambiguous
        assert_eq!(
            resolve_browser_chat_tool_name("browser_tavigate"),
            Some("browser_navigate")
        );
        assert_eq!(resolve_browser_chat_tool_name("write_file"), None);
        assert!(is_browser_granular_tool("browser_act") && !is_browser_granular_tool("write_file"));
        assert!(is_browser_granular_tool("browser_done"));
    }

    #[test]
    fn recognizes_stale_ref_recovery_messages_by_fixed_prefix() {
        let recovered = format!(
            "{STALE_REF_RECOVERY_MARKER} I took a fresh snapshot. Do NOT retry e12; \
choose a NEW [ref=...] from this snapshot:\n[ref=e40] Button"
        );
        assert!(is_stale_ref_recovery_result(&recovered));
        assert!(!is_stale_ref_recovery_result(
            "Page opened (https://example.com). Snapshot: ..."
        ));
        assert!(!is_stale_ref_recovery_result(
            "A page that merely quotes: ⚠ The reference had expired (the page changed) mid-sentence"
        ));
    }

    /// Helper: build a browser tool-result message.
    fn tool_msg(id: &str, content: &str) -> Value {
        serde_json::json!({"role": "tool", "tool_call_id": id, "content": content})
    }

    /// Helper: build a user message carrying an image_url part.
    fn image_msg(label: &str) -> Value {
        serde_json::json!({
            "role": "user",
            "content": [
                {"type": "text", "text": label},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
            ]
        })
    }

    /// Helper: count how many messages still carry a real (non-stub) browser snapshot.
    fn live_snapshot_count(msgs: &[Value], ids: &std::collections::BTreeSet<String>) -> usize {
        msgs.iter()
            .filter(|m| {
                m.get("role").and_then(|r| r.as_str()) == Some("tool")
                    && m.get("tool_call_id")
                        .and_then(|c| c.as_str())
                        .map(|id| ids.contains(id))
                        .unwrap_or(false)
                    && m.get("content").and_then(|c| c.as_str()) != Some(PRUNED_SNAPSHOT_STUB)
            })
            .count()
    }

    /// Helper: count messages that still carry an image_url part.
    fn live_image_count(msgs: &[Value]) -> usize {
        msgs.iter().filter(|m| message_has_image_url(m)).count()
    }

    #[test]
    fn prune_stubs_older_snapshots_and_images() {
        // depth=1 (default): only the latest browser observation survives.
        let ids: std::collections::BTreeSet<String> =
            ["c1", "c2"].iter().map(|s| s.to_string()).collect();
        let mut msgs = vec![
            tool_msg("c1", "OLD SNAPSHOT"),
            tool_msg("c2", "NEW SNAPSHOT"),
        ];
        prune_browser_history_depth(&mut msgs, &ids, 1);
        assert_eq!(
            msgs[0]["content"], PRUNED_SNAPSHOT_STUB,
            "older snapshot stubbed"
        );
        assert_eq!(msgs[1]["content"], "NEW SNAPSHOT", "latest snapshot kept");
    }

    #[test]
    fn prune_depth_3_keeps_last_three_observations() {
        // With depth=3 the last 3 browser observations survive; the 2 oldest are stubbed.
        let ids: std::collections::BTreeSet<String> = ["c1", "c2", "c3", "c4", "c5"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let mut msgs = vec![
            tool_msg("c1", "SNAP 1"),
            tool_msg("c2", "SNAP 2"),
            tool_msg("c3", "SNAP 3"),
            tool_msg("c4", "SNAP 4"),
            tool_msg("c5", "SNAP 5"),
        ];
        prune_browser_history_depth(&mut msgs, &ids, 3);
        assert_eq!(
            live_snapshot_count(&msgs, &ids),
            3,
            "exactly 3 observations survive"
        );
        // The two oldest are stubbed.
        assert_eq!(msgs[0]["content"], PRUNED_SNAPSHOT_STUB);
        assert_eq!(msgs[1]["content"], PRUNED_SNAPSHOT_STUB);
        // The three newest are intact.
        assert_eq!(msgs[2]["content"], "SNAP 3");
        assert_eq!(msgs[4]["content"], "SNAP 5");
    }

    #[test]
    fn prune_images_always_keep_only_latest_regardless_of_depth() {
        // Even with depth=3, only the LATEST image message keeps its image_url part.
        let ids: std::collections::BTreeSet<String> =
            ["c1", "c2", "c3"].iter().map(|s| s.to_string()).collect();
        let mut msgs = vec![
            image_msg("first screenshot"),
            tool_msg("c1", "SNAP 1"),
            image_msg("second screenshot"),
            tool_msg("c2", "SNAP 2"),
            tool_msg("c3", "SNAP 3"),
        ];
        prune_browser_history_depth(&mut msgs, &ids, 3);
        assert_eq!(
            live_image_count(&msgs),
            1,
            "only the latest image survives regardless of depth"
        );
        // All 3 browser observations are intact (depth=3).
        assert_eq!(live_snapshot_count(&msgs, &ids), 3);
    }

    #[test]
    fn prune_depth_clamps_to_at_least_one() {
        // depth=0 is clamped to 1 (never zero-keep).
        let ids: std::collections::BTreeSet<String> =
            ["c1", "c2"].iter().map(|s| s.to_string()).collect();
        let mut msgs = vec![tool_msg("c1", "OLD"), tool_msg("c2", "NEW")];
        prune_browser_history_depth(&mut msgs, &ids, 0);
        assert_eq!(live_snapshot_count(&msgs, &ids), 1, "clamped to 1");
        assert_eq!(msgs[0]["content"], PRUNED_SNAPSHOT_STUB);
        assert_eq!(msgs[1]["content"], "NEW");
    }
}
