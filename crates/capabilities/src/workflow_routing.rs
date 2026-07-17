//! Plugin-owned deterministic routing (S2): the data seam that lets a plugin (e.g.
//! Presentations) declare "when the user picks this, force this tool" without the
//! gateway hardcoding plugin-specific intent detection. Kept as a pure data type +
//! in-memory registry here; the gateway (later S2 tasks) reads `routings()` and
//! applies `deny_tools`/`forcing` to the turn's tool-access plan.
use serde::{Deserialize, Serialize};

/// How hard a routing should steer the model toward `tool_name`.
///
/// `None` is informational only (route_text feeds retrieval/ranking but nothing is
/// forced); `Required` nudges the model but still allows other tools; `Specific`
/// pins the turn to exactly this tool (paired with `deny_tools` to starve the rest).
/// Serialized snake_case because routing config is expected to round-trip through
/// plugin manifests (JSON/TOML) authored by humans.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Forcing {
    None,
    Required,
    Specific,
}

/// One deterministic routing rule: "when route_text matches the user's intent,
/// steer to `tool_name`". `route_id` is globally unique and namespaced by
/// `plugin_id` (e.g. `presentations.template_document`) so plugins can't collide.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowRouting {
    pub route_id: String,
    pub plugin_id: String,
    pub tool_name: String,
    pub route_text: String,
    pub priority: i32,
    pub deterministic: bool,
    pub deny_tools: Vec<String>,
    pub forcing: Forcing,
}

/// In-memory registry of known routings. `system()` seeds the built-in (non-user-
/// installed) plugin routings; a future task will merge in user-installed plugin
/// routings from the plugin manifest store, still filtered through `routings()`.
pub struct WorkflowRoutingRegistry {
    routings: Vec<WorkflowRouting>,
}

impl WorkflowRoutingRegistry {
    /// Seeds the routings owned by system (built-in, always-available) plugins.
    /// Today that's just Presentations' "Use template" deterministic routes; the
    /// route_text values are copied verbatim from the native DeckWorkflow/
    /// DocumentWorkflow route_text in the gateway so ranking behavior matches.
    pub fn system() -> Self {
        Self {
            routings: vec![
                WorkflowRouting {
                    route_id: "presentations.template_document".to_string(),
                    plugin_id: "presentations".to_string(),
                    tool_name: "make_document".to_string(),
                    route_text: "make_document DocumentWorkflow document documento docx markdown report relazione memo verbale meeting minutes rapporto whitepaper brief".to_string(),
                    priority: 100,
                    deterministic: true,
                    deny_tools: vec![
                        "skill:*".to_string(),
                        "run_command".to_string(),
                        "shell".to_string(),
                        "make_deck".to_string(),
                    ],
                    forcing: Forcing::Specific,
                },
                WorkflowRouting {
                    route_id: "presentations.template_deck".to_string(),
                    plugin_id: "presentations".to_string(),
                    tool_name: "make_deck".to_string(),
                    route_text: "make_deck DeckWorkflow presentation presentazione deck slide slides slideshow ppt pptx keynote pitch investor deck sales deck".to_string(),
                    priority: 100,
                    deterministic: true,
                    deny_tools: vec![
                        "skill:*".to_string(),
                        "run_command".to_string(),
                        "shell".to_string(),
                        "make_document".to_string(),
                    ],
                    forcing: Forcing::Specific,
                },
            ],
        }
    }

    /// Returns routings whose owning plugin is currently enabled, per `enabled`.
    /// Plugin enablement is a runtime/user setting the registry itself doesn't
    /// know about, so the caller supplies it rather than the registry owning a
    /// plugin-state dependency.
    pub fn routings(&self, enabled: &dyn Fn(&str) -> bool) -> Vec<&WorkflowRouting> {
        self.routings
            .iter()
            .filter(|r| enabled(&r.plugin_id))
            .collect()
    }
}

/// Simple glob used for `deny_tools` entries: `"prefix:*"` matches any tool name
/// starting with `prefix:`; anything else must match exactly. Kept intentionally
/// minimal (no general globbing) since deny lists are short and hand-authored.
pub fn tool_matches_deny(deny_tools: &[String], tool_name: &str) -> bool {
    deny_tools.iter().any(|pattern| {
        if let Some(prefix) = pattern.strip_suffix('*') {
            tool_name.starts_with(prefix)
        } else {
            pattern == tool_name
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_registry_has_the_two_presentation_routings() {
        let reg = WorkflowRoutingRegistry::system();
        let all = reg.routings(&|_| true);
        let ids: Vec<&str> = all.iter().map(|r| r.route_id.as_str()).collect();
        assert!(ids.contains(&"presentations.template_document"));
        assert!(ids.contains(&"presentations.template_deck"));
        let doc = all
            .iter()
            .find(|r| r.route_id == "presentations.template_document")
            .unwrap();
        assert_eq!(doc.tool_name, "make_document");
        assert!(doc.deterministic);
        assert!(matches!(doc.forcing, Forcing::Specific));
        assert!(doc.deny_tools.iter().any(|d| d == "skill:*"));
    }

    #[test]
    fn disabled_plugin_routings_are_filtered_out() {
        let reg = WorkflowRoutingRegistry::system();
        assert!(reg.routings(&|_| false).is_empty());
    }

    #[test]
    fn deny_glob_matches_skill_prefix_and_exact() {
        let deny = vec!["skill:*".to_string(), "run_command".to_string()];
        assert!(tool_matches_deny(&deny, "skill:create_documents"));
        assert!(tool_matches_deny(&deny, "run_command"));
        assert!(!tool_matches_deny(&deny, "make_document"));
    }
}
