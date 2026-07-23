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
const NATIVE_BROWSER_TOOLS: [&str; 7] = [
    "browser_navigate",
    "browser_snapshot",
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

/// True for the granular browser tools that must route through the browser seam (the mid-turn
/// `&mut` browser branch), NOT the pure capability chokepoint. ADR 0025 folds this into `browse`.
pub fn is_browser_granular_tool(name: &str) -> bool {
    matches!(
        name,
        "browser_navigate"
            | "browser_snapshot"
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

/// Context hygiene across rounds: keep only the LATEST browser tool-result snapshot (stub older
/// ones) and only the LATEST image message (strip older `image_url` parts). At up to 32 rounds the
/// accumulated snapshots/images would overflow the window and silently truncate the page.
pub fn prune_browser_history(
    messages: &mut [Value],
    browser_tool_call_ids: &std::collections::BTreeSet<String>,
) {
    if browser_tool_call_ids.is_empty() {
        // No browser tool ran yet: only image pruning could apply, and that is
        // driven by browser screenshots too, so nothing to do.
        return;
    }
    // 1) Snapshots: keep only the LATEST browser tool-result; stub older ones.
    let mut latest_browser_tool: Option<usize> = None;
    for (idx, message) in messages.iter().enumerate() {
        let is_browser_tool = message.get("role").and_then(|r| r.as_str()) == Some("tool")
            && message
                .get("tool_call_id")
                .and_then(|c| c.as_str())
                .map(|id| browser_tool_call_ids.contains(id))
                .unwrap_or(false);
        if is_browser_tool {
            latest_browser_tool = Some(idx);
        }
    }
    if let Some(keep) = latest_browser_tool {
        for (idx, message) in messages.iter_mut().enumerate() {
            if idx == keep {
                continue;
            }
            let is_browser_tool = message.get("role").and_then(|r| r.as_str()) == Some("tool")
                && message
                    .get("tool_call_id")
                    .and_then(|c| c.as_str())
                    .map(|id| browser_tool_call_ids.contains(id))
                    .unwrap_or(false);
            if is_browser_tool {
                if let Some(obj) = message.as_object_mut() {
                    obj.insert(
                        "content".to_string(),
                        Value::String(PRUNED_SNAPSHOT_STUB.to_string()),
                    );
                }
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
        assert_eq!(resolve_browser_chat_tool_name("browser_navigate"), Some("browser_navigate"));
        // one-char typo within distance 2, unambiguous
        assert_eq!(resolve_browser_chat_tool_name("browser_tavigate"), Some("browser_navigate"));
        assert_eq!(resolve_browser_chat_tool_name("write_file"), None);
        assert!(is_browser_granular_tool("browser_act") && !is_browser_granular_tool("write_file"));
        assert!(is_browser_granular_tool("browser_done"));
    }

    #[test]
    fn prune_stubs_older_snapshots_and_images() {
        let ids: std::collections::BTreeSet<String> = ["c1", "c2"].iter().map(|s| s.to_string()).collect();
        let mut msgs = vec![
            serde_json::json!({"role": "tool", "tool_call_id": "c1", "content": "OLD SNAPSHOT"}),
            serde_json::json!({"role": "tool", "tool_call_id": "c2", "content": "NEW SNAPSHOT"}),
        ];
        prune_browser_history(&mut msgs, &ids);
        assert_eq!(msgs[0]["content"], PRUNED_SNAPSHOT_STUB, "older snapshot stubbed");
        assert_eq!(msgs[1]["content"], "NEW SNAPSHOT", "latest snapshot kept");
    }
}
