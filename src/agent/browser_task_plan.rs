//! Browser task plan — unified guard for browser automation.
//!
//! Single point of control for all browser action decisions:
//! allowlist, mode switching, rate limiting, loop detection, retry budget.
//!
//! Initialized from `CognitionResult` via `from_cognition()`.

use std::collections::VecDeque;
use std::time::Instant;

use crate::agent::cognition::CognitionResult;
use crate::provider::ChatMessage;

/// Sliding window size for loop detection.
/// Must be >= LOOP_THRESHOLD * 3 to detect escalation through all levels.
const RECENT_ACTION_WINDOW: usize = 20;

/// Consecutive identical actions (same action + same output hash) before escalating.
/// Set high enough to allow legitimate repetition (calendar navigation,
/// pagination, scrolling) while still catching real stuck loops.
const LOOP_THRESHOLD: usize = 6;

/// High-level classification of what the browser task involves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserTaskClass {
    StaticLookup,
    InteractiveWeb,
    FormBooking,
    MultiSourceCompare,
}

/// Decision returned by the browser guard.
#[derive(Debug, Clone)]
pub enum BrowserActionDecision {
    /// Action is allowed. If `mode_switch` is set, the agent loop must
    /// switch the browser to the given mode BEFORE executing the action.
    Allow {
        mode_switch: Option<String>,
    },
    /// Action is blocked. The reason is sent back to the LLM as a tool error.
    Blocked {
        reason: String,
    },
    /// The agent is stuck in an unrecoverable loop. Tell the user.
    GiveUp,
}

/// Runtime state for an active browser automation session.
#[derive(Debug, Clone)]
pub struct BrowserTaskPlanState {
    /// Truncated user prompt for context.
    objective: String,
    /// Whether the browser tool was requested by cognition.
    browser_required: bool,
    /// Task classification (booking, comparison, etc.).
    task_class: BrowserTaskClass,
    /// Cognition understanding string (used in runtime_message).
    understanding: String,

    // ── Allowlist (single source of truth) ──────────────────────
    /// Domain → mode (`"headless"`, `"visible"`, `"auto"`).
    allowed_sites: std::collections::HashMap<String, String>,
    /// Whether the allowlist was loaded from the DB.
    allowlist_loaded: bool,

    // ── Current state ──────────────────────────────────────────
    /// Domain of the site currently being browsed.
    current_domain: Option<String>,
    /// Rendering mode of the current site.
    current_mode: Option<String>,
    /// Whether the browser is currently in visible mode.
    is_visible: bool,

    // ── Loop detection ─────────────────────────────────────────
    /// Sliding window of `"action:target"` strings.
    recent_actions: VecDeque<String>,
    /// Escalation level: 0=ok, 1=needs screenshot, 2=switch to visible, 3=give up.
    stuck_level: u8,
    /// Hash of the last browser output. Used to distinguish legitimate repeated
    /// actions (calendar next-month where the page changes) from real stuck
    /// loops (same click, same output = page didn't change).
    last_output_hash: u64,
    /// Set when a screenshot/snapshot satisfies the stuck veto. Allows the
    /// next interactive action to proceed without re-blocking, but the
    /// stuck_level stays elevated so further identical actions will escalate.
    veto_satisfied: bool,

    // ── Rate limiting ──────────────────────────────────────────
    /// Block actions until this time.
    rate_limited_until: Option<Instant>,
    /// Consecutive rate limit detections (for exponential backoff).
    rate_limit_count: u32,

    // ── Retry budget ───────────────────────────────────────────
    /// ref → failure count. Veto clicks after 2 failures.
    failed_refs: std::collections::HashMap<String, u8>,

    // ── Tracking ───────────────────────────────────────────────
    /// Whether a results/listing page has been seen.
    seen_results: bool,
    /// Active profile's brain directory for USER.md lookup.
    profile_brain_dir: Option<std::path::PathBuf>,
}

impl BrowserTaskPlanState {
    /// Initialize from a CognitionResult.
    pub fn from_cognition(
        result: &CognitionResult,
        user_prompt: &str,
        profile_brain_dir: Option<std::path::PathBuf>,
    ) -> Self {
        let browser_required = result.tools.iter().any(|t| t.name == "browser");

        let task_class = if browser_required {
            let lower = result.understanding.to_lowercase();
            if result.constraints.iter().any(|c| {
                let l = c.to_lowercase();
                l.contains("compar") || l.contains("confront")
            }) {
                BrowserTaskClass::MultiSourceCompare
            } else if lower.contains("book")
                || lower.contains("prenot")
                || lower.contains("ticket")
                || lower.contains("bigliett")
            {
                BrowserTaskClass::FormBooking
            } else {
                BrowserTaskClass::InteractiveWeb
            }
        } else {
            BrowserTaskClass::StaticLookup
        };

        Self {
            objective: crate::utils::text::truncate_str(user_prompt.trim(), 220, ""),
            browser_required,
            task_class,
            understanding: result.understanding.clone(),
            allowed_sites: std::collections::HashMap::new(),
            allowlist_loaded: false,
            current_domain: None,
            current_mode: None,
            is_visible: false,
            recent_actions: VecDeque::with_capacity(RECENT_ACTION_WINDOW + 1),
            stuck_level: 0,
            last_output_hash: 0,
            veto_satisfied: false,
            rate_limited_until: None,
            rate_limit_count: 0,
            failed_refs: std::collections::HashMap::new(),
            seen_results: false,
            profile_brain_dir,
        }
    }

    // ── Allowlist ──────────────────────────────────────────────

    /// Populate the allowlist cache (called by agent loop after DB load).
    pub fn set_allowed_sites(&mut self, sites: std::collections::HashMap<String, String>) {
        self.allowlist_loaded = true;
        self.allowed_sites = sites;
    }

    /// Update cache after a site is approved mid-run.
    pub fn note_site_approved(&mut self, domain: &str, mode: &str) {
        self.allowed_sites
            .insert(domain.to_string(), mode.to_string());
    }

    /// Get a reference to the allowlist (for the browser tool to read).
    pub fn allowed_sites(&self) -> &std::collections::HashMap<String, String> {
        &self.allowed_sites
    }

    /// Whether a results page has been seen during this browser task.
    pub fn has_seen_results(&self) -> bool {
        self.seen_results
    }

    /// Whether the browser tool was requested by cognition.
    pub fn browser_required(&self) -> bool {
        self.browser_required
    }

    /// Current stuck level for trace diagnostics.
    pub fn stuck_level(&self) -> u8 {
        self.stuck_level
    }

    // ── The Guard: single entry point for action decisions ─────

    /// Check whether a browser action should proceed.
    ///
    /// This is the **sole authority** for browser action control.
    /// Returns a decision that the agent loop must follow:
    /// - `Allow` → execute (with optional mode switch first)
    /// - `Blocked` → return error message to LLM (includes site not authorized)
    /// - `GiveUp` → inform user, stop trying
    pub fn check_action(
        &mut self,
        action: &str,
        arguments: &serde_json::Value,
    ) -> BrowserActionDecision {
        // Read-only actions always pass (snapshot, screenshot, wait, close)
        if matches!(action, "snapshot" | "screenshot" | "wait" | "close") {
            return BrowserActionDecision::Allow { mode_switch: None };
        }

        // 1. Rate limit backoff
        if let Some(until) = self.rate_limited_until {
            if Instant::now() < until {
                let remaining = until.duration_since(Instant::now());
                let domain = self.current_domain.as_deref().unwrap_or("current site");
                return BrowserActionDecision::Blocked {
                    reason: format!(
                        "Rate-limited on {domain}. Wait {:.0}s then use snapshot() to check.",
                        remaining.as_secs_f64()
                    ),
                };
            }
        }

        // 2. Allowlist check (navigate only)
        if action == "navigate" {
            if let Some(decision) = self.check_navigate(arguments) {
                return decision;
            }
        }

        // 3. Retry budget (click only)
        if action == "click" {
            if let Some(ref_val) = arguments.get("ref").and_then(|v| v.as_str()) {
                if self.failed_refs.get(ref_val).copied().unwrap_or(0) >= 2 {
                    return BrowserActionDecision::Blocked {
                        reason: format!(
                            "Element {ref_val} has failed 2 times. \
                             Use screenshot() to see the visual state, \
                             or try a different element."
                        ),
                    };
                }
            }
        }

        // 4. Loop detection / stuck escalation
        if self.stuck_level >= 3 {
            return BrowserActionDecision::GiveUp;
        }
        // Levels 1-2 block interactive actions until screenshot is taken.
        // Once screenshot satisfies the veto, the NEXT action passes but
        // the level stays elevated so further identical actions escalate.
        if (self.stuck_level == 1 || self.stuck_level == 2) && is_interactive(action) {
            if self.veto_satisfied {
                // Screenshot was taken — allow this action, clear the flag
                self.veto_satisfied = false;
            } else {
                let msg = if self.stuck_level == 2 {
                    "Switched to visible mode due to repeated failures. \
                     Use screenshot() to see the current page state before continuing."
                } else {
                    "Repeated action detected with no progress. \
                     Use screenshot() to visually check what's happening \
                     before retrying."
                };
                return BrowserActionDecision::Blocked {
                    reason: msg.to_string(),
                };
            }
        }

        BrowserActionDecision::Allow { mode_switch: None }
    }

    /// Check navigate action against allowlist and determine mode switching.
    fn check_navigate(
        &mut self,
        arguments: &serde_json::Value,
    ) -> Option<BrowserActionDecision> {
        let url = arguments.get("url").and_then(|v| v.as_str())?;

        // Internal URLs always allowed
        if url.starts_with("about:") || url.starts_with("chrome://") {
            return None; // Allow
        }

        // Skip allowlist check if not loaded (fail-open during startup)
        if !self.allowlist_loaded {
            return None;
        }

        let mode = crate::browser::action_policy::find_site_mode(url, &self.allowed_sites);

        match mode {
            Some(site_mode) => {
                // Site is allowed — track domain and determine mode switch
                self.current_domain = crate::browser::action_policy::extract_domain(url);
                self.current_mode = Some(site_mode.to_string());
                // Reset stuck level on new navigation
                self.stuck_level = 0;

                // Determine if mode switch is needed
                let need_switch = match site_mode {
                    "visible" if !self.is_visible => Some("visible".to_string()),
                    "headless" if self.is_visible => Some("headless".to_string()),
                    _ => None, // "auto" starts headless, no switch needed
                };

                if need_switch.is_some() {
                    Some(BrowserActionDecision::Allow {
                        mode_switch: need_switch,
                    })
                } else {
                    None // Allow without switch
                }
            }
            None => {
                // Site not in allowlist — block and tell the model to ask
                // the user for permission, then use add_allowed_site action.
                let domain = crate::browser::action_policy::extract_domain(url)
                    .unwrap_or_else(|| url.to_string());
                Some(BrowserActionDecision::Blocked {
                    reason: format!(
                        "Site \"{domain}\" is not in the allowed list. \
                         Ask the user for permission using send_message. \
                         If the user approves, call browser(action=\"add_allowed_site\", \
                         domain=\"{domain}\") to add it, then retry the navigation."
                    ),
                })
            }
        }
    }

    // ── Result tracking ────────────────────────────────────────

    /// Update state after a browser tool result.
    pub fn note_result(
        &mut self,
        action: &str,
        output: &str,
        arguments: &serde_json::Value,
    ) {
        // When a site is added via add_allowed_site, update the in-memory cache
        // so the next navigate check passes without needing a DB reload.
        if action == "add_allowed_site" && !output.contains("Failed") {
            if let Some(domain) = arguments.get("domain").and_then(|v| v.as_str()) {
                let mode = arguments
                    .get("mode")
                    .and_then(|v| v.as_str())
                    .unwrap_or("auto");
                self.allowed_sites
                    .insert(domain.to_lowercase(), mode.to_string());
                tracing::debug!(domain = %domain, mode = %mode, "Updated allowlist cache from add_allowed_site");
            }
            return; // No loop tracking needed for admin actions
        }

        // Track action for loop detection
        let target = extract_action_target(action, Some(arguments), output);
        let action_key = format!("{action}:{target}");
        self.recent_actions.push_back(action_key.clone());
        if self.recent_actions.len() > RECENT_ACTION_WINDOW {
            self.recent_actions.pop_front();
        }

        // Loop detection: count consecutive identical actions AND verify
        // the output is also identical (same hash). This distinguishes:
        // - Real loops: same action + same output = page didn't change → escalate
        // - Legitimate repetition: same action + different output = page changed → allow
        //   (e.g., clicking "next month" in a calendar changes the month each time)
        if is_interactive(action) {
            let output_hash = hash_output_sample(output);
            let same_output = output_hash == self.last_output_hash;
            self.last_output_hash = output_hash;

            if same_output {
                let consecutive = self
                    .recent_actions
                    .iter()
                    .rev()
                    .take_while(|a| **a == action_key)
                    .count();

                if consecutive >= LOOP_THRESHOLD && consecutive % LOOP_THRESHOLD == 0 {
                    self.escalate();
                }
            }
            // If output changed, no escalation — the action is making progress
        }

        // Reset stuck level on navigation (new page = fresh start).
        if action == "navigate" {
            self.stuck_level = 0;
            self.veto_satisfied = false;
        }
        // Screenshot/snapshot satisfy the veto (allow next interactive action)
        // but do NOT reset the stuck level — the counter keeps building so
        // persistent loops eventually escalate to visible mode.
        if matches!(action, "screenshot" | "snapshot") && self.stuck_level > 0 {
            self.veto_satisfied = true;
        }

        // Track domain from output
        let lower = output.to_ascii_lowercase();
        for line in output.lines() {
            if let Some(url) = line.trim().strip_prefix("Page URL: ") {
                self.current_domain = crate::browser::action_policy::extract_domain(url);
                break;
            }
        }

        // Detect results page
        if output.contains("Visible result hints:") || output.contains("RESULTS PAGE") {
            self.seen_results = true;
        }

        // Track failed click refs
        if action == "click" {
            if lower.contains("timed out")
                || lower.contains("timeout")
                || lower.contains("not found")
                || lower.contains("failed")
            {
                if let Some(ref_str) = extract_ref_from_output(output) {
                    *self.failed_refs.entry(ref_str).or_insert(0) += 1;
                }
            } else if let Some(ref_str) = extract_ref_from_output(output) {
                self.failed_refs.remove(&ref_str);
            }
        }

        // Rate limit detection
        let is_rate_limited = lower.contains("too many requests")
            || lower.contains("rate limit")
            || lower.contains("http 429")
            || lower.contains("status 429")
            || lower.contains("error 429");
        if is_rate_limited {
            self.rate_limit_count += 1;
            let backoff = (30u64 * (1 << self.rate_limit_count.min(3))).min(240);
            self.rate_limited_until =
                Some(Instant::now() + std::time::Duration::from_secs(backoff));
            tracing::warn!(
                domain = ?self.current_domain,
                backoff_secs = backoff,
                "Rate limit detected"
            );
        }
    }

    /// Note that the browser visibility state changed.
    pub fn note_visibility_changed(&mut self, is_visible: bool) {
        self.is_visible = is_visible;
    }

    /// Escalate the stuck level.
    ///
    /// Level 0 → 1: "use screenshot to diagnose"
    /// Level 1 → 2: auto-switch to visible mode (the agent loop does the switch)
    /// Level 2 → 3: give up
    fn escalate(&mut self) {
        let prev = self.stuck_level;
        // Only escalate for "auto" mode sites (or when no mode set = default behavior)
        let can_switch_visible = self.current_mode.as_deref() == Some("auto")
            || self.current_mode.is_none();

        self.stuck_level = match prev {
            0 => 1,
            1 => {
                if can_switch_visible && !self.is_visible {
                    2 // Will trigger auto-switch to visible
                } else {
                    3 // Already visible or not auto mode → give up
                }
            }
            2 => 3,
            _ => 3,
        };

        tracing::info!(
            prev_level = prev,
            new_level = self.stuck_level,
            domain = ?self.current_domain,
            mode = ?self.current_mode,
            "Browser stuck level escalated"
        );
    }

    /// Whether the guard has requested a switch to visible mode.
    ///
    /// The agent loop should check this after `note_result()` and perform
    /// the switch if true. After switching, call `note_visibility_changed(true)`.
    pub fn needs_visible_switch(&self) -> bool {
        self.stuck_level == 2 && !self.is_visible
    }

    // ── Runtime context ────────────────────────────────────────

    /// Build a runtime message with browser task context for the LLM.
    pub fn runtime_message(&self, browser_available: bool) -> Option<ChatMessage> {
        if self.browser_required && !browser_available {
            return Some(ChatMessage::user(
                "Note: this task requires the browser but it's currently unavailable.",
            ));
        }

        if self.objective.is_empty() || !self.browser_required {
            return None;
        }

        let mut lines = vec![format!("Browser task: {}", self.objective)];

        // Compact user profile for form-filling
        if let Some(hint) = self.compact_user_profile() {
            lines.push(hint);
        }

        if let Some(ref domain) = self.current_domain {
            lines.push(format!("Currently on: {domain}"));
        }

        Some(ChatMessage::user(&lines.join("\n")))
    }

    /// Merge browser state into an execution plan snapshot.
    pub fn merged_snapshot(
        &self,
        mut snapshot: crate::agent::execution_plan::ExecutionPlanSnapshot,
    ) -> crate::agent::execution_plan::ExecutionPlanSnapshot {
        snapshot.current_source = self.current_domain.clone();
        snapshot
    }

    /// Extract a compact user profile from USER.md.
    fn compact_user_profile(&self) -> Option<String> {
        let default_brain = crate::config::Config::brain_dir();
        let dir = self
            .profile_brain_dir
            .as_deref()
            .unwrap_or(&default_brain);
        let user_md = dir.join("USER.md");
        let content = std::fs::read_to_string(&user_md)
            .or_else(|_| std::fs::read_to_string(crate::config::Config::brain_dir().join("USER.md")))
            .ok()?;

        let mut identity_lines = Vec::new();
        let mut in_section = false;
        for line in content.lines() {
            if line.starts_with("## ") {
                in_section = line.contains("Identity") || line.contains("Contacts");
                continue;
            }
            if in_section && line.starts_with("- ") {
                identity_lines.push(line.to_string());
            }
        }

        if identity_lines.is_empty() {
            None
        } else {
            Some(format!(
                "User profile (for form filling):\n{}",
                identity_lines.join("\n")
            ))
        }
    }
}

/// Compute a fast hash of browser output for loop detection.
///
/// Hashes the full output to distinguish real stuck loops (identical output)
/// from legitimate repeated actions (output changes each time, e.g. calendar
/// next-month where the snapshot shows a different month).
fn hash_output_sample(output: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    output.hash(&mut hasher);
    hasher.finish()
}

/// Whether an action is interactive (modifies the page).
fn is_interactive(action: &str) -> bool {
    matches!(
        action,
        "click"
            | "type"
            | "fill"
            | "fill_form"
            | "select_option"
            | "press_key"
            | "hover"
            | "scroll"
            | "drag"
            | "click_coordinates"
            | "hold_click"
    )
}

/// Extract a stable target identifier from a browser action for loop comparison.
fn extract_action_target(
    action: &str,
    arguments: Option<&serde_json::Value>,
    output: &str,
) -> String {
    let args = arguments.unwrap_or(&serde_json::Value::Null);

    if let Some(ref_val) = args
        .get("ref")
        .and_then(|v| v.as_str())
        .or_else(|| args.get("ref_id").and_then(|v| v.as_str()))
    {
        return ref_val.to_string();
    }
    if action == "navigate" {
        if let Some(url) = args.get("url").and_then(|v| v.as_str()) {
            return url.to_string();
        }
    }
    if let Some(text) = args.get("text").and_then(|v| v.as_str()) {
        return text.to_string();
    }
    extract_ref_from_output(output).unwrap_or_else(|| "unknown".to_string())
}

/// Extract a ref string (e.g. "e1177") from browser tool output.
fn extract_ref_from_output(output: &str) -> Option<String> {
    for prefix in &["Click on ", "click on ", "Ref ", "ref="] {
        if let Some(idx) = output.find(prefix) {
            let start = idx + prefix.len();
            let rest = output[start..].trim_start_matches('"');
            let ref_str: String = rest.chars().take_while(|c| c.is_alphanumeric()).collect();
            if ref_str.starts_with('e') && ref_str.len() > 1 {
                return Some(ref_str);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::cognition::{CognitionResult, Complexity, DiscoveredTool};

    fn make_cognition(understanding: &str, tools: &[&str]) -> CognitionResult {
        CognitionResult {
            understanding: understanding.to_string(),
            complexity: Complexity::Complex,
            answer_directly: false,
            direct_answer: None,
            tools: tools
                .iter()
                .map(|n| DiscoveredTool {
                    name: n.to_string(),
                    description: String::new(),
                    reason: String::new(),
                })
                .collect(),
            skills: Vec::new(),
            mcp_tools: Vec::new(),
            memory_context: None,
            rag_context: None,
            plan: Vec::new(),
            constraints: Vec::new(),
            autonomy_override: None,
            intent_type: None,
            success_criteria: None,
        }
    }

    #[test]
    fn classifies_booking() {
        let r = make_cognition("Book a train ticket", &["browser"]);
        let p = BrowserTaskPlanState::from_cognition(&r, "book", None);
        assert_eq!(p.task_class, BrowserTaskClass::FormBooking);
        assert!(p.browser_required);
    }

    #[test]
    fn classifies_interactive() {
        let r = make_cognition("Search headphones on Amazon", &["browser"]);
        let p = BrowserTaskPlanState::from_cognition(&r, "search", None);
        assert_eq!(p.task_class, BrowserTaskClass::InteractiveWeb);
    }

    #[test]
    fn classifies_static_without_browser() {
        let r = make_cognition("Check weather", &["web_search"]);
        let p = BrowserTaskPlanState::from_cognition(&r, "weather", None);
        assert_eq!(p.task_class, BrowserTaskClass::StaticLookup);
        assert!(!p.browser_required);
    }

    #[test]
    fn allowlist_blocks_unlisted_site() {
        let r = make_cognition("Browse", &["browser"]);
        let mut p = BrowserTaskPlanState::from_cognition(&r, "browse", None);
        p.set_allowed_sites(
            [("google.com".to_string(), "headless".to_string())]
                .into_iter()
                .collect(),
        );

        // google.com allowed
        let d = p.check_action("navigate", &serde_json::json!({"url": "https://google.com"}));
        assert!(matches!(d, BrowserActionDecision::Allow { .. }));

        // trenitalia.com not listed
        let d = p.check_action(
            "navigate",
            &serde_json::json!({"url": "https://trenitalia.com"}),
        );
        assert!(matches!(d, BrowserActionDecision::Blocked { .. }));
    }

    #[test]
    fn allowlist_internal_urls_always_pass() {
        let r = make_cognition("Browse", &["browser"]);
        let mut p = BrowserTaskPlanState::from_cognition(&r, "browse", None);
        p.set_allowed_sites(std::collections::HashMap::new());

        let d = p.check_action("navigate", &serde_json::json!({"url": "about:blank"}));
        assert!(matches!(d, BrowserActionDecision::Allow { .. }));
    }

    #[test]
    fn mode_switch_on_visible_site() {
        let r = make_cognition("Browse", &["browser"]);
        let mut p = BrowserTaskPlanState::from_cognition(&r, "browse", None);
        p.set_allowed_sites(
            [("trenitalia.com".to_string(), "visible".to_string())]
                .into_iter()
                .collect(),
        );

        let d = p.check_action(
            "navigate",
            &serde_json::json!({"url": "https://trenitalia.com"}),
        );
        match d {
            BrowserActionDecision::Allow { mode_switch } => {
                assert_eq!(mode_switch.as_deref(), Some("visible"));
            }
            other => panic!("Expected Allow with mode_switch, got {:?}", other),
        }
    }

    #[test]
    fn no_mode_switch_when_already_visible() {
        let r = make_cognition("Browse", &["browser"]);
        let mut p = BrowserTaskPlanState::from_cognition(&r, "browse", None);
        p.is_visible = true;
        p.set_allowed_sites(
            [("trenitalia.com".to_string(), "visible".to_string())]
                .into_iter()
                .collect(),
        );

        let d = p.check_action(
            "navigate",
            &serde_json::json!({"url": "https://trenitalia.com"}),
        );
        match d {
            BrowserActionDecision::Allow { mode_switch } => {
                assert!(mode_switch.is_none());
            }
            other => panic!("Expected Allow without switch, got {:?}", other),
        }
    }

    #[test]
    fn loop_detection_escalates() {
        let r = make_cognition("Browse", &["browser"]);
        let mut p = BrowserTaskPlanState::from_cognition(&r, "browse", None);
        p.current_mode = Some("auto".to_string());

        let click = serde_json::json!({"action": "click", "ref": "e42"});

        // 6 identical clicks (same output) → level 1
        for _ in 0..6 {
            p.note_result("click", "Clicked", &click);
        }
        assert_eq!(p.stuck_level, 1);

        // Screenshot satisfies the veto but does NOT reset level
        p.note_result("screenshot", "Screenshot taken", &serde_json::json!({}));
        assert_eq!(p.stuck_level, 1);
        assert!(p.veto_satisfied);

        // 6 more identical clicks → level 2 (escalates)
        for _ in 0..6 {
            p.note_result("click", "Clicked", &click);
        }
        assert_eq!(p.stuck_level, 2);
        assert!(p.needs_visible_switch());
    }

    #[test]
    fn loop_gives_up_after_level_3() {
        let r = make_cognition("Browse", &["browser"]);
        let mut p = BrowserTaskPlanState::from_cognition(&r, "browse", None);
        p.current_mode = Some("auto".to_string());

        let click = serde_json::json!({"action": "click", "ref": "e42"});

        // Escalate to level 3 (6+6+6 = 18 identical clicks)
        for _ in 0..18 {
            p.note_result("click", "Clicked", &click);
        }
        assert_eq!(p.stuck_level, 3);

        // Next action gets GiveUp
        let d = p.check_action("click", &click);
        assert!(matches!(d, BrowserActionDecision::GiveUp));
    }

    #[test]
    fn navigate_resets_stuck_level() {
        let r = make_cognition("Browse", &["browser"]);
        let mut p = BrowserTaskPlanState::from_cognition(&r, "browse", None);
        p.stuck_level = 2;

        p.note_result(
            "navigate",
            "Page URL: https://example.com\nNavigated.",
            &serde_json::json!({"url": "https://example.com"}),
        );
        assert_eq!(p.stuck_level, 0);
    }

    #[test]
    fn retry_budget_blocks_after_2_failures() {
        let r = make_cognition("Browse", &["browser"]);
        let mut p = BrowserTaskPlanState::from_cognition(&r, "browse", None);

        let click = serde_json::json!({"action": "click", "ref": "e10"});
        p.note_result("click", "Click on e10 timed out", &click);
        p.note_result("click", "Click on e10 timed out", &click);

        let d = p.check_action("click", &click);
        assert!(matches!(d, BrowserActionDecision::Blocked { .. }));
    }

    #[test]
    fn read_only_actions_always_pass() {
        let r = make_cognition("Browse", &["browser"]);
        let mut p = BrowserTaskPlanState::from_cognition(&r, "browse", None);
        p.stuck_level = 2; // Even when stuck

        let d = p.check_action("snapshot", &serde_json::json!({}));
        assert!(matches!(d, BrowserActionDecision::Allow { .. }));

        let d = p.check_action("screenshot", &serde_json::json!({}));
        assert!(matches!(d, BrowserActionDecision::Allow { .. }));
    }

    #[test]
    fn site_approved_mid_run() {
        let r = make_cognition("Browse", &["browser"]);
        let mut p = BrowserTaskPlanState::from_cognition(&r, "browse", None);
        p.set_allowed_sites(std::collections::HashMap::new());

        // Navigate to unlisted site → blocked
        let d = p.check_action(
            "navigate",
            &serde_json::json!({"url": "https://trenitalia.com"}),
        );
        assert!(matches!(d, BrowserActionDecision::Blocked { .. }));

        // Model calls add_allowed_site → note_result updates cache
        p.note_result(
            "add_allowed_site",
            "Site \"trenitalia.com\" added to the allowed list (mode: auto).",
            &serde_json::json!({"action": "add_allowed_site", "domain": "trenitalia.com"}),
        );

        // Now navigate passes
        let d = p.check_action(
            "navigate",
            &serde_json::json!({"url": "https://trenitalia.com"}),
        );
        assert!(matches!(d, BrowserActionDecision::Allow { .. }));
    }

    #[test]
    fn no_loop_when_output_changes() {
        // Simulates clicking "next month" in a calendar: same action,
        // but the page changes each time (different month displayed).
        let r = make_cognition("Browse", &["browser"]);
        let mut p = BrowserTaskPlanState::from_cognition(&r, "browse", None);
        p.current_mode = Some("auto".to_string());

        let click = serde_json::json!({"action": "click", "ref": "e553"});

        // Each click shows a different month → output hash changes → no loop
        p.note_result("click", "Clicked. Calendar shows April 2026 (472 elements)", &click);
        p.note_result("click", "Clicked. Calendar shows May 2026 (472 elements)", &click);
        p.note_result("click", "Clicked. Calendar shows June 2026 (472 elements)", &click);
        p.note_result("click", "Clicked. Calendar shows July 2026 (472 elements)", &click);
        p.note_result("click", "Clicked. Calendar shows August 2026 (472 elements)", &click);
        p.note_result("click", "Clicked. Calendar shows September 2026 (472 elements)", &click);

        // No escalation because the output changed each time
        assert_eq!(p.stuck_level, 0, "Should not escalate when output changes");
    }

    #[test]
    fn no_escalation_for_headless_mode() {
        let r = make_cognition("Browse", &["browser"]);
        let mut p = BrowserTaskPlanState::from_cognition(&r, "browse", None);
        p.current_mode = Some("headless".to_string());

        let click = serde_json::json!({"action": "click", "ref": "e1"});
        // 6 clicks → level 1, then 6 more → level 3 (skip level 2, no visible switch in headless)
        for _ in 0..12 {
            p.note_result("click", "Clicked", &click);
        }
        // Headless mode: skip level 2 (visible switch) → go straight to give up
        assert_eq!(p.stuck_level, 3);
        assert!(!p.needs_visible_switch());
    }
}
