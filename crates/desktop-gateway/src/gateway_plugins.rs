//! Built-in plugin enablement endpoints.
//!
//! The frontend owns plugin manifests and placement. The gateway owns the
//! persisted enabled flag that gates both UI visibility and engine behavior.

use crate::*;

/// Internal plugins (ADR 0011 section 10-A). The id gates the plugin's UI
/// (nav and panel, from the frontend registry) and its engine.
const KNOWN_PLUGINS: &[&str] = &["proattivita", "presentations"];

fn known_plugin(id: &str) -> bool {
    KNOWN_PLUGINS.contains(&id)
}

/// GET /api/plugins -- the addon registry's enabled-state.
pub(crate) async fn plugins_list(State(state): State<AppState>) -> Json<serde_json::Value> {
    let plugins: Vec<serde_json::Value> = KNOWN_PLUGINS
        .iter()
        .map(|id| {
            let enabled = lock_store(&state)
                .map(|s| s.plugin_enabled(id))
                .unwrap_or(true);
            serde_json::json!({ "id": id, "enabled": enabled })
        })
        .collect();
    Json(serde_json::json!({ "plugins": plugins }))
}

/// POST /api/plugins/{id}/toggle -- flip a plugin on/off. Detaching it makes
/// its nav entry, panel and engine all vanish.
pub(crate) async fn plugin_toggle(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Json<serde_json::Value> {
    if !known_plugin(&id) {
        return Json(serde_json::json!({ "ok": false, "error": "unknown_plugin" }));
    }
    let next = lock_store(&state).ok().and_then(|s| {
        let next = !s.plugin_enabled(&id);
        s.set_plugin_enabled(&id, next).ok()?;
        Some(next)
    });
    match next {
        Some(enabled) => Json(serde_json::json!({ "id": id, "enabled": enabled })),
        None => Json(serde_json::json!({ "ok": false })),
    }
}

#[cfg(test)]
mod tests {
    use super::known_plugin;

    #[test]
    fn gateway_plugins_accept_only_builtin_plugin_ids() {
        assert!(known_plugin("proattivita"));
        assert!(known_plugin("presentations"));
        assert!(!known_plugin("unknown"));
        assert!(!known_plugin(""));
    }
}
