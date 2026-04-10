//! Unified browser automation tool.
//!
//! Wraps ~40 individual Playwright MCP tools behind a single `browser` tool
//! with an `action` enum. This drastically reduces cognitive load on weaker
//! LLM models which struggle to orchestrate many tools — they just send
//! `{action: "click", ref: "e42"}` and Rust handles the rest.
//!
//! Orchestration intelligence lives here:
//! - Auto-snapshot after `type` to detect autocomplete suggestions
//! - Ref normalization (strips common model mistakes)
//! - Form plan injection (FORM PLAN prompt for form fields)
//! - Consecutive snapshot guard

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};

use crate::utils::text::truncate_utf8_in_place;
use tokio::sync::RwLock;

use super::mcp::McpPeer;
use super::registry::{Tool, ToolContext, ToolResult};

/// Read browser idle timeout from config (default 300s = 5 minutes).
pub fn browser_idle_timeout_secs() -> u64 {
    crate::config::Config::load()
        .map(|c| c.browser.idle_timeout_secs)
        .unwrap_or(300)
}

/// Shared browser session state, readable by the agent loop.
///
/// Wraps [`TabSessionManager`] to provide per-conversation tab isolation.
/// The agent loop uses this to:
/// 1. Inject a per-session continuation hint ("browser is still on X")
/// 2. Close idle tabs after timeout
/// 3. Clean up a conversation's tab when its agent run completes
pub struct BrowserSession {
    pub(crate) tab_manager: Arc<crate::browser::TabSessionManager>,
    /// Swappable peer reference — updated by show()/hide() when the MCP process restarts.
    peer: Arc<tokio::sync::RwLock<Arc<McpPeer>>>,
    operation_mutex: Arc<tokio::sync::Mutex<()>>,
    /// Set by the agent loop when a results page has been seen,
    /// enabling richer page stage detection in subsequent snapshots.
    pub(crate) seen_results: Arc<AtomicBool>,
    /// Pending mode switch requested by the browser guard.
    /// The BrowserTool reads and clears this before navigate.
    pending_mode_switch: Arc<tokio::sync::RwLock<Option<String>>>,
}

impl BrowserSession {
    fn new(
        peer: Arc<McpPeer>,
        tab_manager: Arc<crate::browser::TabSessionManager>,
        operation_mutex: Arc<tokio::sync::Mutex<()>>,
    ) -> Self {
        Self {
            tab_manager,
            peer: Arc::new(tokio::sync::RwLock::new(peer)),
            operation_mutex,
            seen_results: Arc::new(AtomicBool::new(false)),
            pending_mode_switch: Arc::new(tokio::sync::RwLock::new(None)),
        }
    }

    /// Get the current peer (may change after show/hide).
    async fn current_peer(&self) -> Arc<McpPeer> {
        self.peer.read().await.clone()
    }

    /// Swap the peer reference (called after show/hide restarts the MCP process).
    pub(crate) async fn swap_peer(&self, new_peer: Arc<McpPeer>) {
        *self.peer.write().await = new_peer;
    }

    /// Queue a mode switch to be consumed by the BrowserTool before next navigate.
    pub async fn set_pending_mode_switch(&self, mode: String) {
        *self.pending_mode_switch.write().await = Some(mode);
    }

    /// Take the pending mode switch (consumed on read).
    pub(crate) async fn take_pending_mode_switch(&self) -> Option<String> {
        self.pending_mode_switch.write().await.take()
    }

    /// Returns a continuation hint for a specific conversation session.
    pub async fn continuation_hint_for(&self, session_key: &str) -> Option<String> {
        self.tab_manager.continuation_hint_for(session_key).await
    }

    /// Close idle browser tabs across all sessions.
    pub async fn close_idle_tabs(&self, timeout_secs: u64) {
        let _guard = self.operation_mutex.lock().await;
        let peer = self.current_peer().await;
        self.tab_manager
            .close_idle_tabs(std::time::Duration::from_secs(timeout_secs), &peer)
            .await;
    }

    /// Check if any session has an active browser tab.
    pub async fn has_any_active(&self) -> bool {
        self.tab_manager.has_any_active().await
    }

    /// Update the `seen_results` flag (called by the agent loop after results are detected).
    pub fn set_seen_results(&self, seen: bool) {
        self.seen_results.store(seen, Ordering::Relaxed);
    }
}

/// Minimum interactive elements from the ARIA snapshot before we bother looking
/// for cursor-interactive elements. If the page already has ≥ this many refs,
/// cursor detection is skipped (the page has good ARIA coverage).
const CURSOR_DETECT_MAX_REFS: usize = 5;

/// JS snippet injected via `browser_run_code` to find DOM elements that are
/// visually interactive (cursor:pointer, onclick, tabindex) but lack ARIA roles.
///
/// Returns JSON array: `[{text, tag, hints}]`
const CURSOR_INTERACTIVE_JS: &str = r#"async (page) => {
    return await page.evaluate(() => {
        const INTERACTIVE_ROLES = new Set([
            'button','link','textbox','checkbox','radio','combobox','listbox',
            'menuitem','menuitemcheckbox','menuitemradio','option','searchbox',
            'slider','spinbutton','switch','tab','treeitem'
        ]);
        const INTERACTIVE_TAGS = new Set([
            'a','button','input','select','textarea','details','summary'
        ]);
        const results = [];
        for (const el of document.body.querySelectorAll('*')) {
            const tag = el.tagName.toLowerCase();
            if (INTERACTIVE_TAGS.has(tag)) continue;
            const role = el.getAttribute('role');
            if (role && INTERACTIVE_ROLES.has(role.toLowerCase())) continue;
            const cs = getComputedStyle(el);
            const pointer = cs.cursor === 'pointer';
            const onclick = el.hasAttribute('onclick') || el.onclick !== null;
            const ti = el.getAttribute('tabindex');
            const tabidx = ti !== null && ti !== '-1';
            if (!pointer && !onclick && !tabidx) continue;
            if (pointer && !onclick && !tabidx) {
                const p = el.parentElement;
                if (p && getComputedStyle(p).cursor === 'pointer') continue;
            }
            const text = (el.textContent || '').trim().slice(0, 80);
            if (!text) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const hints = [];
            if (pointer) hints.push('cursor:pointer');
            if (onclick) hints.push('onclick');
            if (tabidx) hints.push('tabindex');
            results.push({text, tag, hints: hints.join(', ')});
            if (results.length >= 15) break;
        }
        return JSON.stringify(results);
    });
}"#;

/// Single unified browser tool that wraps Playwright MCP actions.
///
/// Each conversation gets its own browser tab via [`TabSessionManager`].
/// A lightweight [`Mutex`] protects the atomic `tab_select → action` pair,
/// allowing concurrent browser use across conversations.
pub struct BrowserTool {
    /// Multi-profile pool for lazy-starting MCP peers per profile.
    pool: Option<Arc<crate::browser::BrowserPool>>,
    /// Whether anti-detection scripts have been injected (global, covers all tabs).
    stealth_injected: AtomicBool,
    /// Shared session state, also held by the agent loop.
    /// Contains the swappable peer reference (updated by show/hide).
    session: Arc<BrowserSession>,
    /// Per-conversation tab management.
    tab_manager: Arc<crate::browser::TabSessionManager>,
    /// Protects tab_select + action pairs for atomicity.
    /// Held briefly per MCP call, NOT for the entire execute().
    operation_mutex: Arc<tokio::sync::Mutex<()>>,
}

impl BrowserTool {
    /// Create a new browser tool with an optional multi-profile pool.
    ///
    /// `pool` enables runtime profile switching via the `profile` parameter.
    /// Pass `None` for single-session mode (CLI chat).
    pub fn new(peer: Arc<McpPeer>, pool: Option<Arc<crate::browser::BrowserPool>>) -> Self {
        let tab_manager = Arc::new(crate::browser::TabSessionManager::new());
        let operation_mutex = Arc::new(tokio::sync::Mutex::new(()));
        let session = Arc::new(BrowserSession::new(
            Arc::clone(&peer),
            Arc::clone(&tab_manager),
            Arc::clone(&operation_mutex),
        ));
        Self {
            pool,
            stealth_injected: AtomicBool::new(false),
            session,
            tab_manager,
            operation_mutex,
        }
    }

    /// Get a clone of the shared session state for the agent loop.
    pub fn session(&self) -> Arc<BrowserSession> {
        Arc::clone(&self.session)
    }

    /// Auto visual check: take a screenshot and describe it briefly.
    ///
    /// Called automatically after interactive actions (click, type, fill)
    /// to give the model a human-like view of the page state. Returns
    /// `None` if no vision model is configured or the screenshot fails.
    ///
    /// Uses a concise prompt to keep the description short (~50-100 tokens).
    async fn auto_visual_check(
        &self,
        _tab: &crate::browser::tab_session::TabSession,
    ) -> Option<String> {
        use crate::config::Config;
        use crate::provider::one_shot::{llm_one_shot, ImageInput, OneShotRequest};

        // Check if vision model is configured.
        // If the user set a vision_model, trust it — no capability check needed.
        let config = Config::load().ok()?;
        let vision_model = config.agent.vision_model.trim().to_string();
        if vision_model.is_empty() {
            return None;
        }

        // Take screenshot
        let peer = self.peer().await;
        let (_text, images) = peer
            .call_tool_with_images("browser_take_screenshot", json!({"type": "png"}))
            .await
            .ok()?;
        let img = images.first()?;

        // Save to temp file
        let tmp_path = std::env::temp_dir().join(format!(
            "homun_autoscreen_{}.png",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ));
        std::fs::write(&tmp_path, &img.data).ok()?;

        // Describe briefly — focused on what's visible and actionable
        let result = llm_one_shot(
            &config,
            OneShotRequest {
                system_prompt: "Describe what you see on this browser page in 1-2 sentences. \
                    Focus on: what page/section is visible, any forms/calendars showing which month, \
                    any errors or popups. Be very concise."
                    .to_string(),
                user_message: "What is shown?".to_string(),
                images: vec![ImageInput {
                    path: tmp_path.display().to_string(),
                    media_type: img.mime_type.clone(),
                }],
                model: Some(vision_model.clone()),
                max_tokens: 150,
                ..Default::default()
            },
        )
        .await;

        let _ = std::fs::remove_file(&tmp_path);

        match result {
            Ok(resp) => {
                let desc = resp.content.trim().to_string();
                if desc.is_empty() {
                    None
                } else {
                    Some(desc)
                }
            }
            Err(_) => None,
        }
    }

    /// Apply a pending mode switch from the browser guard.
    ///
    /// The guard (BrowserTaskPlanState) sets a pending mode switch via
    /// BrowserSession when it determines the site needs a different rendering
    /// mode. This method consumes the flag and restarts Playwright if needed.
    async fn apply_pending_mode_switch(&self) {
        let target_mode = match self.session.take_pending_mode_switch().await {
            Some(m) => m,
            None => return,
        };

        let pool = match self.pool.as_ref() {
            Some(p) => p,
            None => return,
        };

        let config = match crate::config::Config::load() {
            Ok(c) => c,
            Err(_) => return,
        };
        let profile = &config.browser.default_profile;
        let is_visible = pool.is_visible(profile).await;

        let needs_switch =
            (target_mode == "visible" && !is_visible) || (target_mode == "headless" && is_visible);

        if !needs_switch {
            return;
        }

        tracing::info!(target = %target_mode, "Applying mode switch from browser guard");
        let result = if target_mode == "visible" {
            pool.restart_visible(profile).await
        } else {
            pool.restart_headless(profile).await
        };

        if let Ok(new_peer) = result {
            self.session.swap_peer(new_peer).await;
            self.stealth_injected
                .store(false, std::sync::atomic::Ordering::Relaxed);
        }
    }

    /// Get the current MCP peer (may change after show/hide).
    async fn peer(&self) -> Arc<McpPeer> {
        self.session.current_peer().await
    }

    /// Whether a results page has been seen (for stage-aware snapshot hints).
    fn seen_results(&self) -> bool {
        self.session.seen_results.load(Ordering::Relaxed)
    }

    /// Get element bounding box via Playwright's `browser_evaluate` with ref.
    ///
    /// Uses Playwright MCP's internal ref→element mapping to get the bounding box.
    /// Returns (center_x, center_y) or `None` if the element can't be resolved.
    async fn get_element_center(
        &self,
        tab: &crate::browser::tab_session::TabSession,
        ref_val: &str,
    ) -> Option<(f64, f64)> {
        // Use Playwright's evaluate with ref — this leverages the internal ref mapping
        let js = "(element) => { \
            const r = element.getBoundingClientRect(); \
            return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); \
        }";
        let result = self
            .call_mcp_on_tab(
                tab,
                "browser_evaluate",
                json!({"function": js, "ref": ref_val}),
            )
            .await
            .ok()?;

        // Parse {"x": 123.4, "y": 456.7} from the result
        let json_str = if let Some(start) = result.find('{') {
            if let Some(end) = result.rfind('}') {
                &result[start..=end]
            } else {
                return None;
            }
        } else {
            &result
        };

        let parsed: Value = serde_json::from_str(json_str).ok()?;
        let x = parsed.get("x").and_then(|v| v.as_f64())?;
        let y = parsed.get("y").and_then(|v| v.as_f64())?;
        Some((x, y))
    }

    /// Annotate a snapshot with visual form field order when form fields are present.
    ///
    /// Runs a single JS call that finds all visible input/select/textarea elements,
    /// reads their bounding boxes, sorts by visual position (top→bottom, left→right),
    /// and returns a numbered list with label + ref. Prepended to the snapshot so
    /// the LLM fills fields in visual order, not DOM order.
    async fn annotate_form_order(
        &self,
        tab: &crate::browser::tab_session::TabSession,
        snapshot: &str,
    ) -> String {
        // Only annotate if form fields are detected
        if !has_form_fields(snapshot) {
            return snapshot.to_string();
        }

        // JS: find all visible form fields, get label + bounding box, sort visually
        let js = r#"() => {
            const fields = document.querySelectorAll(
                'input:not([type=hidden]):not([type=submit]):not([type=button]),' +
                'select,textarea,[role=combobox],[role=searchbox],[role=spinbutton],[contenteditable=true]'
            );
            const result = [];
            for (const el of fields) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const label = el.getAttribute('aria-label')
                    || el.getAttribute('placeholder')
                    || el.getAttribute('name')
                    || el.closest('label')?.textContent?.trim()
                    || (el.id && document.querySelector('label[for="'+el.id+'"]')?.textContent?.trim())
                    || el.getAttribute('title')
                    || '';
                if (!label) continue;
                result.push({
                    label: label.substring(0, 40),
                    y: Math.round(r.top),
                    x: Math.round(r.left),
                    tag: el.tagName.toLowerCase(),
                    type: el.type || el.getAttribute('role') || ''
                });
            }
            result.sort((a, b) => {
                const rowA = Math.floor(a.y / 40);
                const rowB = Math.floor(b.y / 40);
                if (rowA !== rowB) return rowA - rowB;
                return a.x - b.x;
            });
            return JSON.stringify(result);
        }"#;

        let fields = match self
            .call_mcp_on_tab(tab, "browser_evaluate", json!({"function": js}))
            .await
        {
            Ok(raw) => raw,
            Err(_) => return snapshot.to_string(),
        };

        // Parse the JSON array from the evaluate result
        let json_str = if let Some(start) = fields.find('[') {
            if let Some(end) = fields.rfind(']') {
                &fields[start..=end]
            } else {
                return snapshot.to_string();
            }
        } else {
            return snapshot.to_string();
        };

        let items: Vec<Value> = match serde_json::from_str(json_str) {
            Ok(v) => v,
            Err(_) => return snapshot.to_string(),
        };

        if items.len() < 2 {
            // Single field or no fields — no reordering needed
            return snapshot.to_string();
        }

        let mut order_hint = String::from("\n** VISUAL FORM ORDER (fill in this sequence): **\n");
        for (i, item) in items.iter().enumerate() {
            let label = item.get("label").and_then(|v| v.as_str()).unwrap_or("?");
            let field_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let type_hint = if field_type.is_empty() {
                String::new()
            } else {
                format!(" ({field_type})")
            };
            order_hint.push_str(&format!("  {}. {}{}\n", i + 1, label, type_hint));
        }
        order_hint.push('\n');

        // Prepend the visual order before the tree
        let mut result = String::new();
        let mut inserted = false;
        for line in snapshot.lines() {
            // Insert before the accessibility tree starts
            if !inserted && line.trim_start().starts_with("- ") {
                result.push_str(&order_hint);
                inserted = true;
            }
            result.push_str(line);
            result.push('\n');
        }
        if !inserted {
            result.push_str(&order_hint);
        }
        result
    }

    /// Call an individual Playwright MCP tool through the persistent peer.
    /// Used for global operations that don't target a specific tab
    /// (stealth injection, close, resource blocking).
    async fn call_mcp(&self, tool_name: &str, args: Value) -> Result<String> {
        self.peer().await.call_tool(tool_name, args).await
    }

    /// Call an MCP tool on a specific conversation's tab.
    ///
    /// Acquires the operation mutex, selects the tab, executes the action.
    /// This ensures no other conversation can switch tabs between our
    /// select and our action.
    async fn call_mcp_on_tab(
        &self,
        tab: &crate::browser::tab_session::TabSession,
        tool_name: &str,
        args: Value,
    ) -> Result<String> {
        let _guard = self.operation_mutex.lock().await;
        let peer = self.peer().await;

        // Select the correct tab before executing the action
        if let Some(index) = *tab.tab_index.read().await {
            // Only select if there might be other tabs
            if self.tab_manager.has_any_active().await {
                let _ = peer
                    .call_tool("browser_tabs", json!({"action": "select", "index": index}))
                    .await;
            }
        }

        peer.call_tool(tool_name, args).await
    }

    /// Compact a snapshot and return diff if the page changed minimally.
    ///
    /// If a previous snapshot exists and < 40% changed → return compact diff.
    /// Otherwise → return full compact snapshot.
    /// Always stores the new compact snapshot for the next diff.
    /// Uses the per-conversation `TabSession` for snapshot state.
    /// Find DOM elements that are visually interactive but lack ARIA roles.
    ///
    /// Modern SPAs often use `<div onClick>` or `cursor:pointer` without proper
    /// ARIA roles, making them invisible in the accessibility snapshot. This
    /// injects a JS snippet to discover them and returns a formatted section
    /// to append to the snapshot output.
    ///
    /// Only runs when the snapshot has few interactive refs (< CURSOR_DETECT_MAX_REFS),
    /// meaning the ARIA tree is sparse and likely missing clickable elements.
    async fn find_cursor_interactive(&self, snapshot: &str) -> Option<String> {
        let ref_count = snapshot.matches("[ref=").count();
        if ref_count >= CURSOR_DETECT_MAX_REFS {
            return None;
        }

        let js_result = match self
            .call_mcp("browser_run_code", json!({"code": CURSOR_INTERACTIVE_JS}))
            .await
        {
            Ok(output) => output,
            Err(e) => {
                tracing::debug!("Cursor-interactive detection failed: {e}");
                return None;
            }
        };

        // The JS returns a JSON string inside MCP output — extract it
        let json_str = js_result
            .lines()
            .find(|l| l.trim_start().starts_with('['))
            .unwrap_or(&js_result);

        let lines = parse_cursor_elements(json_str, snapshot);
        if lines.is_empty() {
            return None;
        }

        tracing::debug!(
            found = lines.len(),
            "Found cursor-interactive elements not in ARIA tree"
        );

        Some(format_cursor_section(&lines))
    }

    /// Normalize a ref value from model output.
    ///
    /// Models often send malformed refs:
    /// - `"ref=e42"` → `"e42"`
    /// - `"42"` → `"e42"`
    /// - `"e42"` → `"e42"` (already correct)
    fn normalize_ref(args: &Value) -> Result<String> {
        let raw = args
            .get("ref")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("'ref' parameter is required for this action"))?;

        let clean = raw
            .trim()
            .trim_start_matches("ref=")
            .trim_start_matches("ref:");

        if clean.starts_with('e') {
            Ok(clean.to_string())
        } else if clean.chars().all(|c| c.is_ascii_digit()) {
            Ok(format!("e{clean}"))
        } else {
            Ok(clean.to_string())
        }
    }

    /// Inject anti-detection (stealth) scripts into the browser context.
    ///
    /// Uses Playwright's `addInitScript` to patch browser properties that
    /// anti-bot systems check (navigator.webdriver, plugins, chrome runtime).
    /// These patches are equivalent to `playwright-extra-plugin-stealth` but
    /// injected through the MCP `browser_run_code` tool.
    ///
    /// Must be called BEFORE the first navigation — `addInitScript` only
    /// applies to subsequent page loads.
    async fn inject_stealth(&self) {
        if self.stealth_injected.load(Ordering::Relaxed) {
            return;
        }

        let stealth_enabled = crate::config::Config::load()
            .map(|c| c.browser.stealth)
            .unwrap_or(true);
        if !stealth_enabled {
            tracing::debug!("Browser stealth injection disabled (config: browser.stealth = false)");
            self.stealth_injected.store(true, Ordering::Relaxed);
            return;
        }

        // Comprehensive stealth patches — goes beyond basic playwright-stealth:
        // 1. navigator.webdriver = false (primary bot detection flag)
        // 2. window.chrome runtime (Chrome identity check)
        // 3. navigator.plugins (realistic plugin list)
        // 4. navigator.permissions.query (notification permission leak)
        // 5. navigator.languages consistency
        // 6. navigator.hardwareConcurrency + deviceMemory (realistic values)
        // 7. navigator.maxTouchPoints (0 for desktop)
        // 8. window.outerWidth/outerHeight (viewport consistency)
        // 9. Cross-frame window.chrome patching
        // 10. Canvas fingerprint consistency (deterministic subtle modification)
        let stealth_code = r#"async (page) => {
            await page.addInitScript(() => {
                // 1. Primary bot detection flag
                Object.defineProperty(navigator, 'webdriver', { get: () => false });

                // 2. Chrome runtime presence
                if (!window.chrome) {
                    window.chrome = {
                        runtime: { onConnect: { addListener: function(){} }, onMessage: { addListener: function(){} } },
                        loadTimes: function(){ return {}; },
                        csi: function(){ return {}; }
                    };
                }

                // 3. Realistic plugin list (3 plugins = normal Chrome)
                Object.defineProperty(navigator, 'plugins', {
                    get: () => {
                        const p = [
                            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
                        ];
                        p.length = 3;
                        p.item = (i) => p[i] || null;
                        p.namedItem = (n) => p.find(x => x.name === n) || null;
                        p.refresh = () => {};
                        return p;
                    }
                });

                // 4. Permission query consistency
                const origQuery = navigator.permissions.query.bind(navigator.permissions);
                navigator.permissions.query = (params) => {
                    if (params.name === 'notifications') {
                        return Promise.resolve({ state: Notification.permission });
                    }
                    return origQuery(params);
                };

                // 5. Languages consistency
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['en-US', 'en', 'it']
                });

                // 6. Hardware realism (4-core, 8GB = common laptop)
                Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 });
                if (navigator.deviceMemory !== undefined) {
                    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
                }

                // 7. Desktop = no touch (0 touch points)
                Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });

                // 8. Viewport consistency — outerWidth/Height match inner
                Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
                Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85 });

                // 9. Cross-frame chrome patching
                const origGetOwnProp = Object.getOwnPropertyDescriptor;
                const origCreateEl = document.createElement.bind(document);
                document.createElement = function(tag) {
                    const el = origCreateEl(tag);
                    if (tag === 'iframe') {
                        const origAppend = el.appendChild;
                        const origContentWindow = origGetOwnProp(HTMLIFrameElement.prototype, 'contentWindow');
                        Object.defineProperty(el, 'contentWindow', {
                            get: function() {
                                const w = origContentWindow.get.call(this);
                                if (w && !w.chrome) {
                                    w.chrome = window.chrome;
                                }
                                return w;
                            }
                        });
                    }
                    return el;
                };

                // 10. Canvas fingerprint — deterministic subtle shift (not random noise)
                // Uses a consistent seed so the same session always returns the same fingerprint
                const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
                HTMLCanvasElement.prototype.toDataURL = function(type) {
                    const ctx = this.getContext('2d');
                    if (ctx && this.width > 0 && this.height > 0) {
                        try {
                            const imgData = ctx.getImageData(0, 0, 1, 1);
                            imgData.data[0] = (imgData.data[0] + 1) % 256;
                            ctx.putImageData(imgData, 0, 0);
                        } catch(e) { /* cross-origin canvas, skip */ }
                    }
                    return origToDataURL.apply(this, arguments);
                };
            });
        }"#;

        match self
            .call_mcp("browser_run_code", json!({"code": stealth_code}))
            .await
        {
            Ok(_) => {
                tracing::info!("Browser stealth scripts injected (10 anti-detection patches)");
                self.stealth_injected.store(true, Ordering::Relaxed);
            }
            Err(e) => {
                tracing::warn!("Failed to inject stealth scripts: {e} — bot detection may trigger");
            }
        }
    }

    /// Execute the `navigate` action.
    ///
    /// After navigation, automatically waits for the page to stabilize and
    /// returns a compacted snapshot. This prevents the model from seeing an
    /// empty/loading page and reflexively reloading.
    async fn action_navigate(
        &self,
        args: &Value,
        tab: &crate::browser::tab_session::TabSession,
    ) -> Result<ToolResult> {
        let url = args
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("'url' parameter is required for navigate"))?;

        // Consume pending mode switch from the browser guard.
        // The guard (BrowserTaskPlanState) determines the correct mode;
        // the tool just executes the switch.
        self.apply_pending_mode_switch().await;

        // Inject stealth scripts before the first navigation so addInitScript
        // runs BEFORE any page JavaScript (anti-bot detection countermeasure).
        self.inject_stealth().await;

        if let Err(e) = self
            .call_mcp_on_tab(tab, "browser_navigate", json!({"url": url}))
            .await
        {
            return Ok(browser_error_result("Navigate", &e));
        }

        // Track per-tab session state
        tab.note_action(Some(url)).await;

        // Wait for the page to stabilize, then auto-snapshot.
        let mut snapshot = self.wait_for_stable_snapshot(tab).await;
        tab.last_was_snapshot.store(true, Ordering::Relaxed);

        // Annotate visual form field order when form detected
        snapshot = self.annotate_form_order(tab, &snapshot).await;

        // Detect hidden interactive elements on pages with sparse ARIA coverage
        if let Some(cursor_section) = self.find_cursor_interactive(&snapshot).await {
            snapshot.push_str(&cursor_section);
        }

        // Detect error pages (404, 403, etc.) and append recovery hint
        if let Some(error_hint) = detect_error_page(&snapshot) {
            snapshot.push_str(&error_hint);
        }

        // Detect CAPTCHA/verification on sparse pages (<15 elements)
        if let Some(captcha_hint) = detect_captcha_sparse_page(&snapshot) {
            snapshot.push_str(&captcha_hint);
        }

        let mut result = format!("Navigated to {url}\n\n");
        result.push_str(&snapshot);

        // Auto visual check after navigation
        if let Some(visual) = self.auto_visual_check(tab).await {
            result.push_str(&format!("\n\nVisual check: {visual}"));
        }

        Ok(ToolResult::success(result))
    }

    /// Wait for the page to have meaningful interactive content.
    ///
    /// Heavy SPAs (Trenitalia, Italo) load in phases: skeleton → hydration →
    /// API data. We retry with increasing delays and also check for stability
    /// (element count stopped growing = page finished loading).
    async fn wait_for_stable_snapshot(
        &self,
        tab: &crate::browser::tab_session::TabSession,
    ) -> String {
        const MIN_INTERACTIVE: usize = 5;
        const DELAYS_MS: [u64; 4] = [800, 1000, 1200, 1500];

        // Brief initial delay for page to start rendering
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;

        let mut prev_count: usize = 0;

        for (attempt, delay) in DELAYS_MS.iter().enumerate() {
            match self
                .call_mcp_on_tab(tab, "browser_snapshot", json!({}))
                .await
            {
                Ok(output) => {
                    let compacted = compact_browser_snapshot_staged(&output, self.seen_results());
                    let interactive_count = compacted.matches("[ref=").count();

                    let is_stable =
                        interactive_count >= MIN_INTERACTIVE && interactive_count == prev_count;
                    let is_last = attempt == DELAYS_MS.len() - 1;

                    if is_stable || is_last {
                        tracing::debug!(
                            "Page stable after attempt {} ({} interactive elements, stable={})",
                            attempt + 1,
                            interactive_count,
                            is_stable
                        );
                        return compacted;
                    }

                    tracing::debug!(
                        "Page loading (attempt {}, {} → {} elements), waiting {}ms",
                        attempt + 1,
                        prev_count,
                        interactive_count,
                        delay
                    );
                    prev_count = interactive_count;
                    tokio::time::sleep(std::time::Duration::from_millis(*delay)).await;
                }
                Err(e) => {
                    tracing::warn!("Snapshot attempt {} failed: {e}", attempt + 1);
                    tokio::time::sleep(std::time::Duration::from_millis(*delay)).await;
                }
            }
        }

        // All retries exhausted — return error message
        "Page may still be loading. Call snapshot() to check again.".to_string()
    }

    /// Execute the `snapshot` action with compaction.
    async fn action_snapshot(
        &self,
        tab: &crate::browser::tab_session::TabSession,
    ) -> Result<ToolResult> {
        // Consecutive snapshot guard (per-tab)
        if tab.last_was_snapshot.load(Ordering::Relaxed) {
            return Ok(ToolResult::error(
                "Page has not changed since last snapshot. \
                 Use the refs from the previous snapshot result. \
                 Do NOT call snapshot again — perform an action first (click, type, navigate)."
                    .to_string(),
            ));
        }

        match self
            .call_mcp_on_tab(tab, "browser_snapshot", json!({}))
            .await
        {
            Ok(output) => {
                tab.last_was_snapshot.store(true, Ordering::Relaxed);
                let mut compact = compact_browser_snapshot_staged(&output, self.seen_results());
                // Annotate visual form field order when form detected
                compact = self.annotate_form_order(tab, &compact).await;
                // Detect hidden interactive elements on sparse pages
                if let Some(cursor_section) = self.find_cursor_interactive(&compact).await {
                    compact.push_str(&cursor_section);
                }
                // Detect CAPTCHA/verification on sparse pages
                if let Some(captcha_hint) = detect_captcha_sparse_page(&compact) {
                    compact.push_str(&captcha_hint);
                }
                Ok(ToolResult::success(compact))
            }
            Err(e) => Ok(browser_error_result("Snapshot", &e)),
        }
    }

    /// Execute the `click` action.
    ///
    /// After clicking, auto-snapshots to give the model fresh refs.
    /// This prevents the stale-ref problem where DOM changes after click
    /// (e.g. autocomplete dropdown closing) invalidate previously seen refs.
    async fn action_click(
        &self,
        args: &Value,
        tab: &crate::browser::tab_session::TabSession,
    ) -> Result<ToolResult> {
        let ref_val = Self::normalize_ref(args)?;
        let base_output = match self
            .call_mcp_on_tab(tab, "browser_click", json!({"ref": ref_val}))
            .await
        {
            Ok(output) => compact_action_short(&output, "Clicked."),
            Err(e) => {
                // On timeout, auto-snapshot to show what's blocking the element.
                // The snapshot reveals overlays/modals/banners covering the target.
                let error_msg = e.to_string();
                let is_timeout = error_msg.to_lowercase().contains("timeout");
                if is_timeout {
                    tab.last_was_snapshot.store(false, Ordering::Relaxed);
                    if let Ok(snap_output) = self
                        .call_mcp_on_tab(tab, "browser_snapshot", json!({}))
                        .await
                    {
                        let compact =
                            compact_browser_snapshot_staged(&snap_output, self.seen_results());
                        tab.last_was_snapshot.store(true, Ordering::Relaxed);
                        let hint = classify_browser_error(&error_msg);
                        return Ok(ToolResult::error(format!(
                            "Click on {ref_val} timed out — the element exists but is not \
                             clickable. An overlay, popup, or modal is likely covering it.\n\
                             {hint}\n\n\
                             Current page state:\n{compact}"
                        )));
                    }
                }
                return Ok(browser_error_result("Click", &e));
            }
        };

        // Brief wait for DOM to settle, then auto-snapshot for fresh refs
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        // Remember the URL before snapshot — detect unexpected navigation
        let url_before = tab.last_url.read().await.clone();

        match self
            .call_mcp_on_tab(tab, "browser_snapshot", json!({}))
            .await
        {
            Ok(snap_output) => {
                let compact = compact_browser_snapshot_staged(&snap_output, self.seen_results());
                tab.last_was_snapshot.store(true, Ordering::Relaxed);

                // Update tracked URL from snapshot (catches redirects after click)
                if let Some(new_url) = extract_url_from_snapshot(&snap_output) {
                    *tab.last_url.write().await = Some(new_url);
                }

                // Detect unexpected navigation (blank page redirect, page reload to home)
                let nav_warning = detect_unexpected_navigation(&snap_output, url_before.as_deref());
                let mut result_text = if let Some(warning) = nav_warning {
                    format!("{base_output}\n\n⚠️ {warning}\n\n{compact}")
                } else {
                    format!("{base_output}\n\n{compact}")
                };

                // Auto-screenshot: visual verification after click.
                // Gives the model a human-like view of what happened.
                if let Some(visual) = self.auto_visual_check(tab).await {
                    result_text.push_str(&format!("\n\nVisual check: {visual}"));
                }

                Ok(ToolResult::success(result_text))
            }
            Err(_) => {
                // Snapshot failed — reset guard so agent can try snapshot() manually
                tab.last_was_snapshot.store(false, Ordering::Relaxed);
                Ok(ToolResult::success(base_output))
            }
        }
    }

    /// Execute the `type` action with auto-snapshot for autocomplete detection.
    async fn action_type(
        &self,
        args: &Value,
        tab: &crate::browser::tab_session::TabSession,
    ) -> Result<ToolResult> {
        let ref_val = Self::normalize_ref(args)?;
        let text = args
            .get("text")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("'text' parameter is required for type"))?;

        // Click + select-all to clear any existing content before typing.
        let _ = self
            .call_mcp_on_tab(tab, "browser_click", json!({"ref": ref_val}))
            .await;
        let _ = self
            .call_mcp_on_tab(tab, "browser_press_key", json!({"key": "ControlOrMeta+a"}))
            .await;

        let type_result = self
            .call_mcp_on_tab(
                tab,
                "browser_type",
                json!({"ref": ref_val, "text": text, "slowly": true}),
            )
            .await;

        let base_output = match type_result {
            Ok(output) => compact_action_short(&output, &format!("Typed \"{text}\".")),
            Err(e) => return Ok(browser_error_result("Type", &e)),
        };

        // Auto-snapshot to detect autocomplete suggestions
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if let Ok(snap_output) = self
            .call_mcp_on_tab(tab, "browser_snapshot", json!({}))
            .await
        {
            if let Some(suggestions) = extract_autocomplete_suggestions(&snap_output) {
                tracing::info!("Auto-snapshot after type: autocomplete suggestions found");
                tab.last_was_snapshot.store(true, Ordering::Relaxed);
                return Ok(ToolResult::success(format!("{base_output}{suggestions}")));
            }
        }

        Ok(ToolResult::success(base_output))
    }

    /// Execute the `fill` action (clear + type, no autocomplete).
    ///
    /// Uses `browser_fill_form` (single MCP call) instead of separate
    /// click + select-all + type (3 calls). Playwright's `fill()` handles
    /// focus, clearing existing text, typing, and dispatching events.
    async fn action_fill(
        &self,
        args: &Value,
        tab: &crate::browser::tab_session::TabSession,
    ) -> Result<ToolResult> {
        let ref_val = Self::normalize_ref(args)?;
        let text = args
            .get("text")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("'text' parameter is required for fill"))?;

        // Single MCP call: browser_fill_form clears + fills + dispatches events.
        let fill_result = self
            .call_mcp_on_tab(
                tab,
                "browser_fill_form",
                json!({
                    "fields": [{
                        "name": "field",
                        "type": "textbox",
                        "ref": ref_val,
                        "value": text
                    }]
                }),
            )
            .await;

        let base_output = match fill_result {
            Ok(output) => compact_action_short(&output, &format!("Filled with \"{text}\".")),
            Err(e) => {
                tracing::warn!("browser_fill_form failed, falling back to click+type: {e}");
                // Fallback: click + select-all + type (3 calls)
                let _ = self
                    .call_mcp_on_tab(tab, "browser_click", json!({"ref": ref_val}))
                    .await;
                let _ = self
                    .call_mcp_on_tab(tab, "browser_press_key", json!({"key": "ControlOrMeta+a"}))
                    .await;
                match self
                    .call_mcp_on_tab(tab, "browser_type", json!({"ref": ref_val, "text": text}))
                    .await
                {
                    Ok(output) => {
                        compact_action_short(&output, &format!("Filled with \"{text}\"."))
                    }
                    Err(e2) => return Ok(browser_error_result("Fill", &e2)),
                }
            }
        };

        // Auto-snapshot after fill so the model can verify the value was set.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        if let Ok(snap_output) = self
            .call_mcp_on_tab(tab, "browser_snapshot", json!({}))
            .await
        {
            let compact = compact_browser_snapshot_staged(&snap_output, self.seen_results());
            tab.last_was_snapshot.store(true, Ordering::Relaxed);
            return Ok(ToolResult::success(format!(
                "{base_output}\n\n--- Page after fill ---\n{compact}"
            )));
        }

        Ok(ToolResult::success(base_output))
    }

    /// Fill multiple form fields in a single tool call.
    ///
    /// Accepts an array of `{ref, value}` pairs and fills them all via
    /// Playwright's `browser_fill_form` (one MCP call for all fields).
    /// This is dramatically faster than individual fill() calls because
    /// it eliminates N-1 LLM round-trips for an N-field form.
    async fn action_fill_form(
        &self,
        args: &Value,
        tab: &crate::browser::tab_session::TabSession,
    ) -> Result<ToolResult> {
        let fields = args
            .get("fields")
            .and_then(|v| v.as_array())
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "'fields' array is required for fill_form. \
                     Format: [{{\"ref\": \"e1\", \"value\": \"text\"}}, ...]"
                )
            })?;

        if fields.is_empty() {
            return Ok(ToolResult::error(
                "fields array is empty — nothing to fill.".to_string(),
            ));
        }

        // Build the Playwright fill_form payload
        let pw_fields: Vec<Value> = fields
            .iter()
            .filter_map(|f| {
                let ref_val = f
                    .get("ref")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim_start_matches("ref=").to_string())?;
                let value = f.get("value").and_then(|v| v.as_str())?;
                Some(json!({
                    "name": format!("field_{ref_val}"),
                    "type": "textbox",
                    "ref": ref_val,
                    "value": value
                }))
            })
            .collect();

        if pw_fields.is_empty() {
            return Ok(ToolResult::error(
                "No valid fields found. Each field needs 'ref' and 'value'.".to_string(),
            ));
        }

        let count = pw_fields.len();
        let fill_result = self
            .call_mcp_on_tab(tab, "browser_fill_form", json!({"fields": pw_fields}))
            .await;

        let base_output = match fill_result {
            Ok(_) => format!("Filled {count} form fields."),
            Err(e) => return Ok(browser_error_result("Fill form", &e)),
        };

        // Auto-snapshot after filling to show updated form state
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        match self
            .call_mcp_on_tab(tab, "browser_snapshot", json!({}))
            .await
        {
            Ok(snap_output) => {
                let compact = compact_browser_snapshot_staged(&snap_output, self.seen_results());
                tab.last_was_snapshot.store(true, Ordering::Relaxed);
                Ok(ToolResult::success(format!("{base_output}\n\n{compact}")))
            }
            Err(_) => Ok(ToolResult::success(base_output)),
        }
    }

    /// Execute the `select_option` action.
    async fn action_select_option(
        &self,
        args: &Value,
        tab: &crate::browser::tab_session::TabSession,
    ) -> Result<ToolResult> {
        let ref_val = Self::normalize_ref(args)?;
        let value = args
            .get("value")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("'value' parameter is required for select_option"))?;

        match self
            .call_mcp_on_tab(
                tab,
                "browser_select_option",
                json!({"ref": ref_val, "values": [value]}),
            )
            .await
        {
            Ok(output) => Ok(ToolResult::success(compact_action_short(
                &output,
                &format!("Selected \"{value}\"."),
            ))),
            Err(e) => Ok(browser_error_result("Select", &e)),
        }
    }

    /// Execute the `press_key` action.
    async fn action_press_key(
        &self,
        args: &Value,
        tab: &crate::browser::tab_session::TabSession,
    ) -> Result<ToolResult> {
        let key = args.get("text").and_then(|v| v.as_str()).ok_or_else(|| {
            anyhow::anyhow!("'text' parameter is required for press_key (e.g. \"Enter\", \"Tab\")")
        })?;

        match self
            .call_mcp_on_tab(tab, "browser_press_key", json!({"key": key}))
            .await
        {
            Ok(output) => Ok(ToolResult::success(compact_action_short(
                &output,
                &format!("Pressed {key}."),
            ))),
            Err(e) => Ok(browser_error_result("Press key", &e)),
        }
    }

    /// Execute the `hover` action.
    async fn action_hover(
        &self,
        args: &Value,
        tab: &crate::browser::tab_session::TabSession,
    ) -> Result<ToolResult> {
        let ref_val = Self::normalize_ref(args)?;
        match self
            .call_mcp_on_tab(tab, "browser_hover", json!({"ref": ref_val}))
            .await
        {
            Ok(output) => Ok(ToolResult::success(compact_action_short(
                &output, "Hovered.",
            ))),
            Err(e) => Ok(browser_error_result("Hover", &e)),
        }
    }

    /// Execute the `scroll` action.
    async fn action_scroll(
        &self,
        args: &Value,
        tab: &crate::browser::tab_session::TabSession,
    ) -> Result<ToolResult> {
        let direction = args
            .get("direction")
            .and_then(|v| v.as_str())
            .unwrap_or("down");

        let amount = args.get("amount").and_then(|v| v.as_i64()).unwrap_or(3);

        // Use browser_press_key for scrolling — reliable across Playwright versions.
        // Page Up/Down for large scrolls, arrow keys for smaller ones.
        let key = match direction {
            "up" => {
                if amount >= 3 {
                    "PageUp"
                } else {
                    "ArrowUp"
                }
            }
            "down" => {
                if amount >= 3 {
                    "PageDown"
                } else {
                    "ArrowDown"
                }
            }
            "left" => "ArrowLeft",
            "right" => "ArrowRight",
            _ => "PageDown",
        };

        // If a ref is provided, click it first to focus the scrollable container
        if let Ok(ref_val) = Self::normalize_ref(args) {
            let _ = self
                .call_mcp_on_tab(tab, "browser_click", json!({"ref": ref_val}))
                .await;
        }

        let repeat = amount.unsigned_abs().max(1);
        for _ in 0..repeat {
            let _ = self
                .call_mcp_on_tab(tab, "browser_press_key", json!({"key": key}))
                .await;
        }

        // Auto-snapshot after scroll for fresh content
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        match self
            .call_mcp_on_tab(tab, "browser_snapshot", json!({}))
            .await
        {
            Ok(snap) => {
                let compact = compact_browser_snapshot_staged(&snap, self.seen_results());
                tab.last_was_snapshot.store(true, Ordering::Relaxed);
                Ok(ToolResult::success(format!(
                    "Scrolled {direction}.\n\n{compact}"
                )))
            }
            Err(_) => Ok(ToolResult::success(format!("Scrolled {direction}."))),
        }
    }

    /// Execute the `drag` action.
    async fn action_drag(
        &self,
        args: &Value,
        tab: &crate::browser::tab_session::TabSession,
    ) -> Result<ToolResult> {
        let start_ref = Self::normalize_ref(args)?;
        let end_ref = args
            .get("end_ref")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("'end_ref' parameter is required for drag"))?;

        match self
            .call_mcp_on_tab(
                tab,
                "browser_drag",
                json!({
                    "startRef": start_ref,
                    "endRef": end_ref,
                    "startElement": "drag source",
                    "endElement": "drag target"
                }),
            )
            .await
        {
            Ok(output) => Ok(ToolResult::success(compact_action_short(
                &output, "Dragged.",
            ))),
            Err(e) => Ok(browser_error_result("Drag", &e)),
        }
    }

    /// Execute tab management actions.
    async fn action_tabs(&self, action: &str, args: &Value) -> Result<ToolResult> {
        let mcp_action = match action {
            "tab_list" => "list",
            "tab_new" => "new",
            "tab_select" => "select",
            "tab_close" => "close",
            _ => return Ok(ToolResult::error(format!("Unknown tab action: {action}"))),
        };

        let mut params = json!({"action": mcp_action});
        if let Some(idx) = args.get("index").and_then(|v| v.as_i64()) {
            params["index"] = json!(idx);
        }

        match self.call_mcp("browser_tabs", params).await {
            Ok(output) => Ok(ToolResult::success(output)),
            Err(e) => Ok(browser_error_result(&format!("Tab {action}"), &e)),
        }
    }

    /// Execute the `evaluate` action (run JavaScript).
    ///
    /// Blocks DOM-manipulating patterns (click, focus, scrollTo, remove,
    /// innerHTML, etc.) — these break SPA frameworks. The model should use
    /// click/type/scroll actions instead.
    async fn action_evaluate(
        &self,
        args: &Value,
        tab: &crate::browser::tab_session::TabSession,
    ) -> Result<ToolResult> {
        let expression = args
            .get("expression")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("'expression' parameter is required for evaluate"))?;

        // Block DOM manipulation — models use it as a crutch and it breaks SPAs
        let expr_lower = expression.to_lowercase();
        let blocked_patterns = [
            ".click()",
            ".focus()",
            ".blur()",
            ".remove()",
            ".innerhtml",
            ".textcontent =",
            ".innertext =",
            "scrollto(",
            "scrollby(",
            "setattribute(",
            "removeattribute(",
            "classlist.",
            "style.",
            "dispatchevent(",
            "appendchild(",
            "removechild(",
            "replacechild(",
        ];
        if blocked_patterns.iter().any(|p| expr_lower.contains(p)) {
            return Ok(ToolResult::error(
                "evaluate() is for READING page state only. \
                 Do NOT use it to click, focus, scroll, or modify the DOM — \
                 use the dedicated actions instead: click(ref), type(ref, text), scroll(direction)."
                    .to_string(),
            ));
        }

        match self
            .call_mcp_on_tab(tab, "browser_evaluate", json!({"function": expression}))
            .await
        {
            Ok(output) => {
                let truncated = if output.len() > 2_000 {
                    let mut s = output;
                    truncate_utf8_in_place(&mut s, 2_000);
                    s.push_str("...[truncated]");
                    s
                } else {
                    output
                };
                Ok(ToolResult::success(truncated))
            }
            Err(e) => Ok(browser_error_result("Evaluate", &e)),
        }
    }

    /// Execute the `wait` action.
    async fn action_wait(&self, args: &Value) -> Result<ToolResult> {
        let seconds = args
            .get("seconds")
            .and_then(|v| v.as_f64())
            .unwrap_or(1.0)
            .min(30.0); // cap at 30 seconds

        tokio::time::sleep(std::time::Duration::from_secs_f64(seconds)).await;
        Ok(ToolResult::success(format!("Waited {seconds}s.")))
    }

    /// Take a screenshot and describe it using the configured vision model.
    async fn action_screenshot(
        &self,
        tab: &crate::browser::tab_session::TabSession,
    ) -> Result<ToolResult> {
        // Select the correct tab before taking the screenshot
        let peer = self.peer().await;
        {
            let _guard = self.operation_mutex.lock().await;
            if let Some(index) = *tab.tab_index.read().await {
                let _ = peer
                    .call_tool("browser_tabs", json!({"action": "select", "index": index}))
                    .await;
            }
        }

        let (_text, images) = peer
            .call_tool_with_images("browser_take_screenshot", json!({"type": "png"}))
            .await
            .map_err(|e| anyhow::anyhow!("Screenshot failed: {e}"))?;

        let img = match images.first() {
            Some(img) => img,
            None => {
                return Ok(ToolResult::error(
                    "Screenshot returned no image data.".to_string(),
                ))
            }
        };

        // Save to temp file (providers read image from disk path)
        let tmp_path = std::env::temp_dir().join(format!(
            "homun_screenshot_{}.png",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ));
        std::fs::write(&tmp_path, &img.data)
            .map_err(|e| anyhow::anyhow!("Failed to write screenshot: {e}"))?;

        let description = match self.describe_screenshot(&tmp_path, &img.mime_type).await {
            Ok(desc) => desc,
            Err(e) => {
                let _ = std::fs::remove_file(&tmp_path);
                return Ok(browser_error_result("Vision analysis", &e));
            }
        };

        let _ = std::fs::remove_file(&tmp_path);
        Ok(ToolResult::success(format!(
            "Screenshot visual description:\n{description}"
        )))
    }

    /// Send a screenshot to the vision model and get a textual description.
    async fn describe_screenshot(
        &self,
        image_path: &std::path::Path,
        media_type: &str,
    ) -> Result<String> {
        use crate::config::Config;
        use crate::provider::one_shot::{llm_one_shot, ImageInput, OneShotRequest};

        let config = Config::load().map_err(|e| anyhow::anyhow!("Config load failed: {e}"))?;

        // Resolve vision model: if configured, trust it (no capability check).
        let vision_model = config.agent.vision_model.trim().to_string();
        let model = if !vision_model.is_empty() {
            vision_model
        } else {
            let main_model = config.agent.model.trim().to_string();
            let provider = config
                .resolve_provider(&main_model)
                .map(|(name, _)| name)
                .unwrap_or("unknown");
            let caps = config
                .agent
                .effective_model_capabilities(provider, &main_model);
            if caps.image_input {
                main_model
            } else {
                anyhow::bail!(
                    "No vision model configured and main model '{}' does not support images. \
                     Set agent.vision_model in config.",
                    main_model
                );
            }
        };

        tracing::info!(model = %model, "Describing browser screenshot via vision model");

        let resp = llm_one_shot(
            &config,
            OneShotRequest {
                system_prompt: "Describe this browser screenshot concisely. \
                    Focus on: page type, visible content, and actionable elements.\n\
                    IMPORTANT — If the page shows any kind of bot verification or CAPTCHA, \
                    identify it clearly and state the type:\n\
                    - CAPTCHA_HOLD: a 'press and hold' or 'hold to verify' button → \
                      say: \"CAPTCHA: hold-to-verify button visible at approximately (center_x, center_y). \
                      Use hold_click action with x and y coordinates (the button is usually not in the accessibility tree).\"\n\
                    - CAPTCHA_CHALLENGE: a Cloudflare/Turnstile 'checking your browser' page → \
                      say: \"CAPTCHA: Cloudflare challenge. Wait 5 seconds and retry.\"\n\
                    - CAPTCHA_VISUAL: image selection, text recognition, puzzle → \
                      say: \"CAPTCHA: visual challenge. Requires manual user intervention.\"\n\
                    - BLOCKED: 'access denied', 'too many requests', rate limit page → \
                      say: \"BLOCKED: site is rate-limiting. Wait and retry later.\"\n\
                    If the page is a normal website with no verification, do NOT mention CAPTCHA."
                    .to_string(),
                user_message: "What is shown in this screenshot?".to_string(),
                images: vec![ImageInput {
                    path: image_path.display().to_string(),
                    media_type: media_type.to_string(),
                }],
                model: Some(model),
                max_tokens: 1024,
                timeout_secs: 45,
                ..Default::default()
            },
        )
        .await?;

        Ok(resp.content)
    }

    /// Switch browser from headless to visible mode.
    ///
    /// Restarts the MCP Playwright process without `--headless`. The browser
    /// becomes visible on screen, allowing manual CAPTCHA solving or visual
    /// debugging. Navigates back to the last URL to restore context.
    async fn action_show(
        &self,
        tab: &crate::browser::tab_session::TabSession,
    ) -> Result<ToolResult> {
        let pool = self.pool.as_ref().ok_or_else(|| {
            anyhow::anyhow!(
                "Browser visibility switching requires gateway mode (pool not available)"
            )
        })?;

        let config = crate::config::Config::load()
            .map_err(|e| anyhow::anyhow!("Config load failed: {e}"))?;
        let profile = &config.browser.default_profile;

        // Already visible?
        if pool.is_visible(profile).await {
            return Ok(ToolResult::success(
                "Browser is already in visible mode.".to_string(),
            ));
        }

        let last_url = tab.last_url.read().await.clone();

        // Restart with visible mode — this kills the current process
        let new_peer = pool
            .restart_visible(profile)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to switch to visible mode: {e}"))?;

        // Swap the peer reference so all subsequent calls use the new process
        self.session.swap_peer(new_peer.clone()).await;

        // Re-inject stealth on the new process
        self.stealth_injected
            .store(false, std::sync::atomic::Ordering::Relaxed);

        let mut result =
            "Browser switched to VISIBLE mode. The browser window is now showing on screen.\n"
                .to_string();

        // Re-navigate to the last URL to restore context
        if let Some(url) = &last_url {
            result.push_str(&format!("Re-navigating to {url}...\n"));
            let _ = new_peer
                .call_tool("browser_navigate", json!({"url": url}))
                .await;
            tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
            if let Ok(snap) = new_peer.call_tool("browser_snapshot", json!({})).await {
                let compact = compact_browser_snapshot_staged(&snap, self.seen_results());
                result.push('\n');
                result.push_str(&compact);
            }
        }

        Ok(ToolResult::success(result))
    }

    /// Switch browser from visible back to headless mode.
    ///
    /// Restarts the MCP process with `--headless`. Useful after resolving
    /// a CAPTCHA in visible mode — the browser goes back to background
    /// operation without taking over the user's screen.
    async fn action_hide(
        &self,
        tab: &crate::browser::tab_session::TabSession,
    ) -> Result<ToolResult> {
        let pool = self.pool.as_ref().ok_or_else(|| {
            anyhow::anyhow!(
                "Browser visibility switching requires gateway mode (pool not available)"
            )
        })?;

        let config = crate::config::Config::load()
            .map_err(|e| anyhow::anyhow!("Config load failed: {e}"))?;
        let profile = &config.browser.default_profile;

        if !pool.is_visible(profile).await {
            return Ok(ToolResult::success(
                "Browser is already in headless mode.".to_string(),
            ));
        }

        let last_url = tab.last_url.read().await.clone();

        let new_peer = pool
            .restart_headless(profile)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to switch to headless mode: {e}"))?;

        // Swap the peer reference so all subsequent calls use the new process
        self.session.swap_peer(new_peer.clone()).await;

        self.stealth_injected
            .store(false, std::sync::atomic::Ordering::Relaxed);

        let mut result =
            "Browser switched back to HEADLESS mode (running in background).\n".to_string();

        if let Some(url) = &last_url {
            result.push_str(&format!("Re-navigating to {url}...\n"));
            let _ = new_peer
                .call_tool("browser_navigate", json!({"url": url}))
                .await;
            tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
            if let Ok(snap) = new_peer.call_tool("browser_snapshot", json!({})).await {
                let compact = compact_browser_snapshot_staged(&snap, self.seen_results());
                result.push('\n');
                result.push_str(&compact);
            }
        }

        Ok(ToolResult::success(result))
    }

    /// Execute the `close` action.
    async fn action_close(&self, session_key: &str) -> Result<ToolResult> {
        // Close only this conversation's tab (not the entire browser)
        let _guard = self.operation_mutex.lock().await;
        let peer = self.peer().await;
        self.tab_manager.close_session(session_key, &peer).await;
        Ok(ToolResult::success("Browser tab closed.".to_string()))
    }

    /// Click at pixel coordinates (for canvas, SVG, maps, or elements without refs).
    ///
    /// Uses `page.mouse.click(x, y)` via `browser_run_code`. After clicking,
    /// auto-snapshots to give the model fresh refs (same pattern as `action_click`).
    /// Auto-detect the CAPTCHA "hold to verify" button position via JS.
    ///
    /// PerimeterX/HUMAN Security buttons are custom widgets not in the
    /// accessibility tree. This searches the DOM for the characteristic
    /// elements and returns their center coordinates.
    async fn find_captcha_button(
        &self,
        tab: &crate::browser::tab_session::TabSession,
    ) -> Option<(f64, f64)> {
        // Search for PerimeterX hold button by multiple strategies
        let js = r#"() => {
            // Strategy 1: find by ID (PerimeterX uses #px-captcha)
            let el = document.getElementById('px-captcha');
            if (!el) {
                // Strategy 2: find by PerimeterX class patterns
                el = document.querySelector('[id*="px-captcha"], [class*="px-captcha"], [data-testid*="captcha"]');
            }
            if (!el) {
                // Strategy 3: find large clickable div in the center area of the page
                const vw = window.innerWidth;
                const vh = window.innerHeight;
                const candidates = document.querySelectorAll('div, button, a');
                for (const c of candidates) {
                    const r = c.getBoundingClientRect();
                    const isCentered = Math.abs(r.x + r.width/2 - vw/2) < vw * 0.25;
                    const isLarge = r.width > 150 && r.height > 50;
                    const inMiddle = r.y > vh * 0.3 && r.y < vh * 0.8;
                    if (isCentered && isLarge && inMiddle) {
                        const style = window.getComputedStyle(c);
                        const hasPointer = style.cursor === 'pointer';
                        const hasBorder = style.borderWidth !== '0px' && style.borderStyle !== 'none';
                        if (hasPointer || hasBorder) {
                            el = c;
                            break;
                        }
                    }
                }
            }
            if (el) {
                const r = el.getBoundingClientRect();
                return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)});
            }
            return null;
        }"#;

        let result = self
            .call_mcp_on_tab(tab, "browser_evaluate", json!({"function": js}))
            .await
            .ok()?;

        if result.contains("null") || !result.contains('{') {
            return None;
        }

        let json_str = &result[result.find('{')?..=result.rfind('}')?];
        let parsed: Value = serde_json::from_str(json_str).ok()?;
        let x = parsed.get("x").and_then(|v| v.as_f64())?;
        let y = parsed.get("y").and_then(|v| v.as_f64())?;
        Some((x, y))
    }

    /// Execute a press-and-hold click for "hold to verify" CAPTCHAs.
    ///
    /// Uses `page.mouse.down()` + sleep + `page.mouse.up()` to simulate
    /// a human pressing and holding a button. Supports PerimeterX and
    /// Cloudflare "hold here to verify" challenges.
    async fn action_hold_click(
        &self,
        args: &Value,
        tab: &crate::browser::tab_session::TabSession,
    ) -> Result<ToolResult> {
        let duration_ms = args
            .get("duration_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(15000)
            .min(30000); // cap at 30s — PerimeterX needs 10-20s hold

        // Accept ref, x/y coordinates, or auto-detect CAPTCHA button.
        // Priority: ref → auto-detect → x/y fallback.
        let (cx, cy) = if let Some(ref_val) = args.get("ref").and_then(|v| v.as_str()) {
            match self.get_element_center(tab, ref_val).await {
                Some(pos) => pos,
                None => {
                    return Ok(ToolResult::error(
                        "Could not find element position for hold_click. \
                         Take a fresh snapshot and verify the ref, or use x/y coordinates instead."
                            .to_string(),
                    ));
                }
            }
        } else {
            // Try auto-detecting the CAPTCHA button via JS before falling back to coordinates
            let auto_pos = self.find_captcha_button(tab).await;
            if let Some(pos) = auto_pos {
                tracing::info!(
                    "Auto-detected CAPTCHA button at ({:.0}, {:.0})",
                    pos.0,
                    pos.1
                );
                pos
            } else if let (Some(x), Some(y)) = (
                args.get("x").and_then(|v| v.as_f64()),
                args.get("y").and_then(|v| v.as_f64()),
            ) {
                (x, y)
            } else {
                // Last resort: center of viewport (CAPTCHA buttons are usually centered)
                (640.0, 450.0)
            }
        };

        // Press and hold: move → mousedown → wait → mouseup.
        // Uses page.waitForTimeout() instead of setTimeout (not available in MCP context).
        let hold_code = format!(
            r#"async (page) => {{
                await page.mouse.move({cx:.0}, {cy:.0});
                await page.mouse.down();
                await page.waitForTimeout({duration_ms});
                await page.mouse.up();
            }}"#
        );

        match self
            .call_mcp_on_tab(tab, "browser_run_code", json!({"code": hold_code}))
            .await
        {
            Ok(_) => {
                // Wait for redirect after CAPTCHA — the page needs time to transition.
                // PerimeterX redirects take 2-5 seconds after successful hold.
                tokio::time::sleep(std::time::Duration::from_millis(3000)).await;
                match self
                    .call_mcp_on_tab(tab, "browser_snapshot", json!({}))
                    .await
                {
                    Ok(snap) => {
                        let compact = compact_browser_snapshot_staged(&snap, self.seen_results());
                        let ref_count = compact.matches("[ref=").count();
                        tab.last_was_snapshot.store(true, Ordering::Relaxed);

                        // If still very few elements, the redirect may not have completed
                        let post_hint = if ref_count < 10 {
                            "\n\n→ Page still looks sparse after hold_click. The redirect may \
                             still be in progress. Try: wait(seconds=5) then snapshot() to check \
                             if the page has loaded. Do NOT give up yet."
                        } else {
                            "" // Page loaded — CAPTCHA likely passed
                        };

                        Ok(ToolResult::success(format!(
                            "Held click for {duration_ms}ms at ({cx:.0}, {cy:.0}).\n\n{compact}{post_hint}"
                        )))
                    }
                    Err(_) => Ok(ToolResult::success(format!(
                        "Held click for {duration_ms}ms. \
                         The page may be redirecting. Try: wait(seconds=5) then snapshot()."
                    ))),
                }
            }
            Err(e) => Ok(browser_error_result("Hold click", &e)),
        }
    }

    async fn action_click_coordinates(
        &self,
        args: &Value,
        tab: &crate::browser::tab_session::TabSession,
    ) -> Result<ToolResult> {
        let x = args
            .get("x")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| anyhow::anyhow!("'x' parameter required for click_coordinates"))?;
        let y = args
            .get("y")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| anyhow::anyhow!("'y' parameter required for click_coordinates"))?;

        let code = format!(r#"async (page) => {{ await page.mouse.click({x}, {y}); }}"#);

        match self
            .call_mcp_on_tab(tab, "browser_run_code", json!({"code": code}))
            .await
        {
            Ok(_) => {
                // Auto-snapshot after click for fresh refs
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                match self
                    .call_mcp_on_tab(tab, "browser_snapshot", json!({}))
                    .await
                {
                    Ok(snap) => {
                        let compact = compact_browser_snapshot_staged(&snap, self.seen_results());
                        tab.last_was_snapshot.store(true, Ordering::Relaxed);
                        Ok(ToolResult::success(format!(
                            "Clicked at ({x}, {y}).\n\n{compact}"
                        )))
                    }
                    Err(_) => Ok(ToolResult::success(format!("Clicked at ({x}, {y})."))),
                }
            }
            Err(e) => Ok(browser_error_result("Click coordinates", &e)),
        }
    }

    /// Block images, fonts, media, and stylesheets to speed up page loads.
    ///
    /// Uses `page.route()` via `browser_run_code` to abort non-essential
    /// resource types. Call before navigating to heavy sites. Reversible
    /// with `unblock_resources`.
    async fn action_block_resources(&self) -> Result<ToolResult> {
        let code = r#"async (page) => {
            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
                    route.abort();
                } else {
                    route.continue();
                }
            });
        }"#;

        match self
            .call_mcp("browser_run_code", json!({"code": code}))
            .await
        {
            Ok(_) => Ok(ToolResult::success(
                "Resource blocking enabled (images, fonts, media, stylesheets). \
                 Pages will load faster but won't display images."
                    .to_string(),
            )),
            Err(e) => Ok(browser_error_result("Block resources", &e)),
        }
    }

    /// Remove resource blocking and restore normal page loading.
    async fn action_unblock_resources(&self) -> Result<ToolResult> {
        let code = r#"async (page) => {
            await page.unroute('**/*');
        }"#;

        match self
            .call_mcp("browser_run_code", json!({"code": code}))
            .await
        {
            Ok(_) => Ok(ToolResult::success(
                "Resource blocking disabled. Pages will load normally.".to_string(),
            )),
            Err(e) => Ok(browser_error_result("Unblock resources", &e)),
        }
    }
}

#[async_trait]
impl Tool for BrowserTool {
    fn name(&self) -> &str {
        "browser"
    }

    fn description(&self) -> &str {
        "Browser automation. Actions:\n\
         - navigate(url): Go to URL (auto-returns page snapshot)\n\
         - snapshot(): Get page accessibility tree with interactive elements [ref=eN]\n\
         - click(ref): Click element (auto-returns updated snapshot)\n\
         - type(ref, text): Type text into field (triggers autocomplete check)\n\
         - fill(ref, text): Clear field + type (for overwriting, single field)\n\
         - fill_form(fields): Fill MULTIPLE fields at once — fields: [{ref, value}, ...]. MUCH faster than individual fill() calls. Use this for forms with 2+ fields!\n\
         - select_option(ref, value): Select dropdown option\n\
         - press_key(text): Press key (e.g. \"Enter\", \"Tab\")\n\
         - hover(ref): Hover over element\n\
         - scroll(direction, ref?): Scroll page or element up/down\n\
         - drag(ref, end_ref): Drag from ref to end_ref\n\
         - screenshot(): Take screenshot and describe via vision model\n\
         - click_coordinates(x, y): Click at pixel coordinates (for canvas/SVG/maps)\n\
         - hold_click(ref OR x+y, duration_ms?): Press and hold (for 'hold to verify' CAPTCHAs). Use ref for ARIA elements, x+y coordinates for non-ARIA buttons\n\
         - show(): Switch to visible mode (browser window appears on screen — for CAPTCHA or debugging)\n\
         - hide(): Switch back to headless mode (browser goes to background)\n\
         - block_resources(): Block images/fonts/media for faster navigation\n\
         - unblock_resources(): Restore normal resource loading\n\
         - evaluate(expression): Read page state via JS (READ-ONLY, no DOM changes)\n\
         - wait(seconds): Wait N seconds\n\
         - close(): Close browser tab\n\n\
         RULES:\n\
         1. navigate() already returns the page — do NOT call snapshot() right after\n\
         2. Use refs from the LATEST snapshot only (e.g. ref=\"e42\")\n\
         3. click() already returns a snapshot — no need to call snapshot() after\n\
         4. For forms: prefer fill_form() with ALL fields in one call instead of filling one by one\n\
         5. For autocomplete fields: type partial text → look at suggestions → click match\n\
         6. If page seems empty/broken, call snapshot() BEFORE reloading — it may still be loading\n\
         7. For 'hold to verify' CAPTCHAs: use screenshot() to see the button, then hold_click with x+y coordinates (CAPTCHA buttons usually aren't in the accessibility tree)"
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "required": ["action"],
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "navigate", "snapshot", "screenshot", "click", "type",
                        "fill", "fill_form", "select_option", "press_key",
                        "hover", "scroll", "drag", "click_coordinates",
                        "hold_click", "show", "hide",
                        "block_resources", "unblock_resources", "evaluate", "close", "wait"
                    ],
                    "description": "Browser action to perform"
                },
                "url": {
                    "type": "string",
                    "description": "URL for navigate"
                },
                "ref": {
                    "type": "string",
                    "description": "Element ref from snapshot (e.g. \"e42\")"
                },
                "text": {
                    "type": "string",
                    "description": "Text for type/fill, or key for press_key (e.g. \"Enter\")"
                },
                "value": {
                    "type": "string",
                    "description": "Value for select_option"
                },
                "direction": {
                    "type": "string",
                    "enum": ["up", "down"],
                    "description": "Scroll direction"
                },
                "expression": {
                    "type": "string",
                    "description": "JavaScript for evaluate"
                },
                "end_ref": {
                    "type": "string",
                    "description": "Target ref for drag"
                },
                "seconds": {
                    "type": "number",
                    "description": "Seconds for wait (max 30)"
                },
                "x": {
                    "type": "integer",
                    "description": "X pixel coordinate for click_coordinates or hold_click"
                },
                "y": {
                    "type": "integer",
                    "description": "Y pixel coordinate for click_coordinates or hold_click"
                },
                "duration_ms": {
                    "type": "integer",
                    "description": "Hold duration in ms for hold_click (default 15000, max 30000). PerimeterX CAPTCHAs need 10-20s"
                },
                "fields": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "ref": { "type": "string" },
                            "value": { "type": "string" }
                        },
                        "required": ["ref", "value"]
                    },
                    "description": "Array of fields for fill_form: [{ref, value}, ...]"
                },
                "profile": {
                    "type": "string",
                    "description": "Browser profile name for isolated cookies/sessions (uses default if omitted)"
                },
            }
        })
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult> {
        let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("");
        let profile_name = args.get("profile").and_then(|v| v.as_str());

        // Non-default profile → dispatch to dedicated peer (each profile has its own
        // MCP process, so no tab session management needed).
        if let Some(profile) = profile_name {
            if let Some(pool) = &self.pool {
                let peer = pool
                    .get_or_start(profile)
                    .await
                    .map_err(|e| anyhow::anyhow!("Profile '{}': {}", profile, e))?;
                return self.execute_on_profile_peer(&peer, action, &args).await;
            } else {
                return Ok(ToolResult::error(
                    "Profile switching not available in CLI mode".to_string(),
                ));
            }
        }

        let session_key = format!("{}:{}", ctx.channel, ctx.chat_id);
        tracing::debug!(action = %action, session_key = %session_key, "Browser tool action");

        // Get or create this conversation's tab session.
        // The operation_mutex is acquired inside get_or_create / call_mcp_on_tab.
        let tab = {
            let _guard = self.operation_mutex.lock().await;
            let peer = self.peer().await;
            self.tab_manager.get_or_create(&session_key, &peer).await?
        };

        // Reset consecutive snapshot flag for non-snapshot actions (per-tab)
        if action != "snapshot" {
            tab.last_was_snapshot.store(false, Ordering::Relaxed);
        }

        let result = match action {
            "navigate" => self.action_navigate(&args, &tab).await?,
            "snapshot" => self.action_snapshot(&tab).await?,
            "screenshot" => self.action_screenshot(&tab).await?,
            "click" => self.action_click(&args, &tab).await?,
            "type" => self.action_type(&args, &tab).await?,
            "fill" => self.action_fill(&args, &tab).await?,
            "fill_form" => self.action_fill_form(&args, &tab).await?,
            "select_option" => self.action_select_option(&args, &tab).await?,
            "press_key" => self.action_press_key(&args, &tab).await?,
            "hover" => self.action_hover(&args, &tab).await?,
            "scroll" => self.action_scroll(&args, &tab).await?,
            "drag" => self.action_drag(&args, &tab).await?,
            "click_coordinates" => self.action_click_coordinates(&args, &tab).await?,
            "block_resources" => self.action_block_resources().await?,
            "unblock_resources" => self.action_unblock_resources().await?,
            "evaluate" => self.action_evaluate(&args, &tab).await?,
            "wait" => self.action_wait(&args).await?,
            "hold_click" => self.action_hold_click(&args, &tab).await?,
            "show" => self.action_show(&tab).await?,
            "hide" => self.action_hide(&tab).await?,
            "close" => self.action_close(&session_key).await?,
            "" => ToolResult::error(
                "Missing 'action' parameter. Available actions: \
                 navigate, snapshot, screenshot, click, type, fill, \
                 select_option, press_key, hover, scroll, drag, \
                 click_coordinates, hold_click, show, hide, \
                 block_resources, unblock_resources, evaluate, wait, close"
                    .to_string(),
            ),
            unknown => ToolResult::error(format!(
                "Unknown action \"{unknown}\". Available actions: \
                 navigate, snapshot, screenshot, click, type, fill, \
                 select_option, press_key, hover, scroll, drag, \
                 click_coordinates, hold_click, show, hide, \
                 block_resources, unblock_resources, evaluate, wait, close"
            )),
        };

        // Track per-tab timestamp for all non-close actions
        if action != "close" && !action.is_empty() {
            tab.note_action(None).await;
        }

        Ok(result)
    }
}

impl BrowserTool {
    /// Execute a browser action on a non-default profile's dedicated MCP peer.
    ///
    /// Each profile runs its own `@playwright/mcp` process with isolated cookies
    /// and sessions. No tab session management is needed (single-user per peer).
    async fn execute_on_profile_peer(
        &self,
        peer: &McpPeer,
        action: &str,
        args: &Value,
    ) -> Result<ToolResult> {
        let mcp_result = match action {
            "navigate" => {
                let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
                if url.is_empty() {
                    return Ok(ToolResult::error("Missing 'url' for navigate".to_string()));
                }
                let _nav = peer
                    .call_tool("browser_navigate", json!({"url": url}))
                    .await?;
                // Auto-snapshot after navigate
                let snap = peer.call_tool("browser_snapshot", json!({})).await?;
                let compact = compact_browser_snapshot(&snap);
                format!("Navigated to {url}\n\n{compact}")
            }
            "snapshot" => {
                let raw = peer.call_tool("browser_snapshot", json!({})).await?;
                compact_browser_snapshot(&raw)
            }
            "screenshot" => peer.call_tool("browser_take_screenshot", json!({})).await?,
            "click" => {
                let ref_val = args.get("ref").and_then(|v| v.as_str()).unwrap_or("");
                peer.call_tool("browser_click", json!({"ref": ref_val}))
                    .await?;
                let snap = peer.call_tool("browser_snapshot", json!({})).await?;
                compact_browser_snapshot(&snap)
            }
            "type" => {
                let ref_val = args.get("ref").and_then(|v| v.as_str()).unwrap_or("");
                let text = args.get("text").and_then(|v| v.as_str()).unwrap_or("");
                peer.call_tool(
                    "browser_type",
                    json!({"ref": ref_val, "text": text, "slowly": true}),
                )
                .await?;
                let snap = peer.call_tool("browser_snapshot", json!({})).await?;
                compact_browser_snapshot(&snap)
            }
            "fill" => {
                let ref_val = args.get("ref").and_then(|v| v.as_str()).unwrap_or("");
                let value = args
                    .get("value")
                    .and_then(|v| v.as_str())
                    .or_else(|| args.get("text").and_then(|v| v.as_str()))
                    .unwrap_or("");
                peer.call_tool("browser_type", json!({"ref": ref_val, "text": value}))
                    .await?;
                let snap = peer.call_tool("browser_snapshot", json!({})).await?;
                compact_browser_snapshot(&snap)
            }
            "select_option" => {
                let ref_val = args.get("ref").and_then(|v| v.as_str()).unwrap_or("");
                let values = args
                    .get("value")
                    .and_then(|v| v.as_str())
                    .map(|v| vec![v.to_string()])
                    .unwrap_or_default();
                peer.call_tool(
                    "browser_select_option",
                    json!({"ref": ref_val, "values": values}),
                )
                .await?
            }
            "press_key" => {
                let key = args.get("text").and_then(|v| v.as_str()).unwrap_or("Enter");
                peer.call_tool("browser_press_key", json!({"key": key}))
                    .await?
            }
            "hover" => {
                let ref_val = args.get("ref").and_then(|v| v.as_str()).unwrap_or("");
                peer.call_tool("browser_hover", json!({"ref": ref_val}))
                    .await?
            }
            "scroll" => {
                let direction = args
                    .get("direction")
                    .and_then(|v| v.as_str())
                    .unwrap_or("down");
                let amount = if direction == "up" { -3 } else { 3 };
                peer.call_tool(
                    "browser_press_key",
                    json!({"key": if amount < 0 { "PageUp" } else { "PageDown" }}),
                )
                .await?
            }
            "evaluate" => {
                let expr = args
                    .get("expression")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                peer.call_tool("browser_evaluate", json!({"function": expr}))
                    .await?
            }
            "wait" => {
                let secs = args
                    .get("seconds")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(2.0)
                    .min(30.0);
                tokio::time::sleep(std::time::Duration::from_secs_f64(secs)).await;
                format!("Waited {secs}s")
            }
            "close" => {
                peer.call_tool("browser_close", json!({})).await?;
                "Browser closed".to_string()
            }
            "" => return Ok(ToolResult::error("Missing 'action' parameter".to_string())),
            unknown => return Ok(ToolResult::error(format!("Unknown action: {unknown}"))),
        };

        Ok(ToolResult::success(mcp_result))
    }
}

// ============================================================================
// Snapshot compaction helpers (moved from agent_loop.rs)
// ============================================================================

/// Compact a `browser_snapshot` output for the model context window.
///
/// Uses agent-browser's approach: keep lines with `[ref=]`, content roles
/// (heading, cell, listitem), or value text (`": "`), plus all ancestor lines
/// for tree hierarchy. This preserves context (a button inside a dialog,
/// results inside a list) while filtering out noise.
pub fn compact_browser_snapshot(output: &str) -> String {
    compact_browser_snapshot_staged(output, false)
}

/// Compact a `browser_snapshot` output with stage-aware hints.
///
/// `seen_results` indicates the agent has previously seen a results page,
/// enabling better classification (e.g. a form after results → data entry step).
pub fn compact_browser_snapshot_staged(output: &str, seen_results: bool) -> String {
    // Raw snapshots are larger — allow up to 80K by default
    let max_chars: usize = std::env::var("HOMUN_BROWSER_MAX_OUTPUT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(80_000);

    let (header_lines, tree_lines) = split_browser_output(output);

    let mut result = String::new();

    // Header (URL, title)
    for line in &header_lines {
        result.push_str(line);
        result.push('\n');
    }

    if tree_lines.is_empty() {
        result.push_str(
            "\n⚠️ BLANK PAGE — no content detected. The page may be loading, \
             redirecting, or crashed. Try: wait(seconds=3) then snapshot().\n",
        );
        return result;
    }

    // Compact tree: keep only lines with refs, content values, or ancestor context.
    // Inspired by agent-browser (Vercel Labs) compact_tree algorithm.
    let compact_tree = compact_tree_lines(&tree_lines);

    // Summary
    let ref_count = compact_tree.matches("[ref=").count();
    let total_refs = tree_lines.iter().filter(|l| l.contains("[ref=")).count();
    if ref_count < total_refs {
        result.push_str(&format!(
            "({ref_count} relevant elements shown, {total_refs} total on page) Use ref=\"eN\" exactly as shown.\n\n",
        ));
    } else {
        result.push_str(&format!(
            "({ref_count} interactive elements) Use ref=\"eN\" exactly as shown.\n\n",
        ));
    }

    // Blank-ish page — very few elements and short content
    if ref_count < 3 && compact_tree.len() < 200 {
        result.push_str(
            "\n⚠️ NEAR-BLANK PAGE — very few elements. The page may have redirected \
             or reloaded. Verify you're still on the expected page before continuing.\n",
        );
    }

    result.push_str(&compact_tree);

    // CAPTCHA and stage detection need the full tree (signals may be in non-ref elements)
    let full_tree: String = tree_lines.join("\n");

    // CAPTCHA detection — only on sparse pages (<15 interactive elements)
    // to avoid false positives on full pages like Italo/Trenitalia.
    if ref_count < 15 {
        if let Some(captcha_hint) = detect_captcha_in_sparse_page(&full_tree) {
            result.push_str(&captcha_hint);
        }
    }

    // Stage-aware hints based on page structure
    if let Some(hint) = page_stage_hint(&full_tree, seen_results) {
        result.push_str(&hint);
    }

    // Hard truncation (UTF-8 safe)
    if result.len() > max_chars {
        truncate_utf8_in_place(&mut result, max_chars);
        result.push_str("\n...[snapshot truncated]");
    }

    result
}

/// Compact tree lines using agent-browser's algorithm.
///
/// Keeps lines containing `[ref=` (interactive elements), `": "` (values),
/// or content role markers (heading, listitem, cell), plus all ancestor lines
/// for structural context. Strips decorative/navigation noise.
fn compact_tree_lines(lines: &[&str]) -> String {
    if lines.is_empty() {
        return String::new();
    }

    let mut keep = vec![false; lines.len()];

    for (i, line) in lines.iter().enumerate() {
        // Keep lines with refs (interactive elements)
        let has_ref = line.contains("[ref=");
        // Keep lines with content values (e.g. `textbox: "hello"`)
        let has_value = line.contains("\": \"") || line.contains(": \"");
        // Keep content role markers that provide context
        let trimmed = line.trim().trim_start_matches("- ");
        let is_content_role = trimmed.starts_with("heading ")
            || trimmed.starts_with("listitem ")
            || trimmed.starts_with("cell ")
            || trimmed.starts_with("gridcell ")
            || trimmed.starts_with("columnheader ")
            || trimmed.starts_with("rowheader ")
            || trimmed.starts_with("option ");

        if has_ref || has_value || is_content_role {
            keep[i] = true;
            // Mark ancestors — walk backwards to preserve tree hierarchy
            let my_indent = tree_indent(line);
            for j in (0..i).rev() {
                let ancestor_indent = tree_indent(lines[j]);
                if ancestor_indent < my_indent {
                    keep[j] = true;
                    if ancestor_indent == 0 {
                        break;
                    }
                }
            }
        }
    }

    lines
        .iter()
        .enumerate()
        .filter(|(i, _)| keep[*i])
        .map(|(_, line)| *line)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Count indent level of a tree line (2 spaces per level).
fn tree_indent(line: &str) -> usize {
    let trimmed = line.trim_start();
    (line.len() - trimmed.len()) / 2
}

/// Compact a simple browser action output — keep just the confirmation.
fn compact_action_short(output: &str, prefix: &str) -> String {
    let (header_lines, _) = split_browser_output(output);
    if header_lines.is_empty() {
        return prefix.to_string();
    }
    let mut s = String::from(prefix);
    s.push(' ');
    for line in &header_lines {
        s.push_str(line);
        s.push(' ');
    }
    s.trim().to_string()
}

/// Extract autocomplete/dropdown suggestions from a snapshot.
///
/// Looks for `option "..." [ref=eN]` lines in the accessibility tree.
pub fn extract_autocomplete_suggestions(snapshot_output: &str) -> Option<String> {
    let mut suggestions = Vec::new();
    for line in snapshot_output.lines() {
        let trimmed = line.trim().trim_start_matches("- ");
        if trimmed.starts_with("option ") && trimmed.contains("[ref=") {
            suggestions.push(trimmed.to_string());
        }
    }
    if suggestions.is_empty() {
        return None;
    }
    let mut result = format!(
        "\n\nAutocomplete dropdown appeared with {} suggestion(s):\n",
        suggestions.len()
    );
    for s in suggestions.iter().take(10) {
        result.push_str("  - ");
        result.push_str(s);
        result.push('\n');
    }
    result.push_str(
        "→ Click the matching option to select it: browser({action: \"click\", ref: \"eN\"})",
    );
    Some(result)
}

/// Split browser tool output into header lines and accessibility tree lines.
fn split_browser_output(output: &str) -> (Vec<&str>, Vec<&str>) {
    let mut header_lines: Vec<&str> = Vec::new();
    let mut tree_lines: Vec<&str> = Vec::new();
    let mut in_tree = false;

    for raw_line in output.lines() {
        let line = raw_line.trim_end();
        if line.starts_with("[image:") {
            continue;
        }
        if !in_tree && line.trim_start().starts_with("- ") {
            in_tree = true;
        }
        if in_tree {
            tree_lines.push(line);
        } else {
            header_lines.push(line);
        }
    }

    (header_lines, tree_lines)
}

/// Check if the tree contains form fields (combobox, textbox, etc.).
fn has_form_fields(tree: &str) -> bool {
    tree.lines().any(|line| {
        let t = line.trim_start().trim_start_matches("- ");
        is_form_field_role(t)
    })
}

// ============================================================================
// Page stage detection (language-independent)
// ============================================================================

/// Language-independent page stage, detected from accessibility tree structure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageStage {
    /// Multiple form fields, few repeated interactive groups (search/booking form).
    SearchForm,
    /// Multiple sibling groups each with interactive descendants (results listing).
    ResultsListing,
    /// Few form fields, content-heavy, 1-3 action buttons (proceed/confirm step).
    ActionRequired,
    /// No clear pattern detected.
    Unknown,
}

/// Detect the page stage from the accessibility tree structure.
///
/// Purely structural — does NOT match on any text content (language-independent).
/// `seen_results` hints that we've previously seen a results page, so a form
/// is likely a continuation step rather than the initial search.
pub fn detect_page_stage(tree: &str, _seen_results: bool) -> PageStage {
    let mut form_field_count: usize = 0;
    let mut button_ref_count: usize = 0;
    let mut total_interactive: usize = 0;
    // Track sibling groups: consecutive container roles at the same indent
    // that each have at least one interactive descendant.
    let mut current_group_indent: Option<usize> = None;
    let mut current_group_count: usize = 0;
    let mut max_group_run: usize = 0;

    let lines: Vec<&str> = tree.lines().collect();

    for (i, raw_line) in lines.iter().enumerate() {
        let stripped = raw_line.trim_end();
        let indent = stripped.len() - stripped.trim_start().len();
        let trimmed = stripped.trim_start().trim_start_matches("- ");

        // Count form fields
        if is_form_field_role(trimmed) {
            form_field_count += 1;
        }

        // Count interactive elements
        if stripped.contains("[ref=") {
            total_interactive += 1;
            if trimmed.starts_with("button ") {
                button_ref_count += 1;
            }
        }

        // Detect container roles for repeated group analysis
        let is_container = trimmed.starts_with("listitem")
            || trimmed == "row"
            || trimmed.starts_with("row ")
            || trimmed.starts_with("row\"")
            || trimmed == "group"
            || trimmed.starts_with("group ")
            || trimmed.starts_with("group\"")
            || trimmed.starts_with("article");

        if is_container {
            // Check if this container has any interactive descendants
            // (look ahead until next sibling at same or shallower indent)
            let has_interactive = lines[i + 1..]
                .iter()
                .take_while(|next_line| {
                    let next_stripped = next_line.trim_end();
                    let next_indent = next_stripped.len() - next_stripped.trim_start().len();
                    next_indent > indent
                })
                .any(|next_line| next_line.contains("[ref="));

            if Some(indent) == current_group_indent {
                // Same sibling level
                if has_interactive {
                    current_group_count += 1;
                } else {
                    // Non-interactive sibling breaks the run
                    max_group_run = max_group_run.max(current_group_count);
                    current_group_count = 0;
                }
            } else {
                // New indent level — finalize previous group
                max_group_run = max_group_run.max(current_group_count);
                current_group_indent = Some(indent);
                current_group_count = if has_interactive { 1 } else { 0 };
            }
        }
    }
    // Finalize last group
    let repeated_interactive_groups = max_group_run.max(current_group_count);

    // Classification (order matters — most specific first)
    if repeated_interactive_groups >= 3 {
        return PageStage::ResultsListing;
    }
    if form_field_count >= 2 && repeated_interactive_groups < 2 {
        return PageStage::SearchForm;
    }
    if (1..=3).contains(&button_ref_count) && form_field_count < 3 && total_interactive < 15 {
        return PageStage::ActionRequired;
    }
    PageStage::Unknown
}

/// Return a stage-appropriate hint to append to the snapshot, or `None`.
fn page_stage_hint(tree: &str, seen_results: bool) -> Option<String> {
    let stage = detect_page_stage(tree, seen_results);
    match stage {
        PageStage::SearchForm => Some(
            "\n\n** FORM PLAN — do this before filling **\n\
             1. READ all fields and labels FIRST — the tree order may differ from \
             the visual layout (e.g. 2-column forms). Identify each field by its label.\n\
             2. MAP fields to values from the user's request: field label → value.\n\
             3. FILL in logical order (e.g. for travel: origin → destination → date → passengers), \
             NOT the order they appear in the tree.\n\
             4. IGNORE pre-filled / default values unless the user asked to change them.\n\
             5. Convert: \"mattina\"→06:00-12:00, \"pomeriggio\"→12:00-18:00, \
             \"sera\"→18:00-23:00, \"domani\"→tomorrow's date.\n\
             6. Autocomplete fields (combobox): type partial text → snapshot → click match.\n\
             7. If a required value is missing, ask the user.\n"
                .to_string(),
        ),
        PageStage::ResultsListing => Some(
            "\n\n** RESULTS PAGE — selectable items detected **\n\
             This page lists multiple options. Pick the best match for the user's\n\
             request criteria, then click its selection element (button/link/radio).\n\
             After selecting, take a snapshot to see the next step.\n"
                .to_string(),
        ),
        PageStage::ActionRequired => Some(
            "\n\n** ACTION STEP — review and proceed **\n\
             This page shows content with limited actions. Review it, then click\n\
             the appropriate button to advance. Do NOT navigate away.\n"
                .to_string(),
        ),
        PageStage::Unknown => {
            // Fallback: if form fields detected but stage is Unknown, still show FORM PLAN
            if has_form_fields(tree) {
                Some(
                    "\n\n** FORM PLAN — do this before filling **\n\
                     1. READ all fields and labels FIRST — the tree order may differ from \
                     the visual layout. Identify each field by its label.\n\
                     2. MAP fields to values from the user's request: field label → value.\n\
                     3. FILL in logical order based on labels, NOT tree order.\n\
                     4. Autocomplete fields (combobox): type partial text → snapshot → click match.\n\
                     5. If a required value is missing, ask the user.\n"
                        .to_string(),
                )
            } else {
                None
            }
        }
    }
}

/// Check if a trimmed ARIA role is a form field.
fn is_form_field_role(trimmed: &str) -> bool {
    trimmed.starts_with("combobox ")
        || trimmed.starts_with("textbox ")
        || trimmed.starts_with("checkbox ")
        || trimmed.starts_with("radio ")
        || trimmed.starts_with("searchbox ")
        || trimmed.starts_with("slider ")
        || trimmed.starts_with("spinbutton ")
}

/// Extract the `action` field from browser tool arguments.
///
/// Used by `agent_loop.rs` to determine what browser action was performed
/// without knowing the internal structure of BrowserTool.
pub fn browser_action_from_args(args: &Value) -> Option<&str> {
    args.get("action").and_then(|v| v.as_str())
}

/// Format cursor-interactive elements into a section for the snapshot.
fn format_cursor_section(lines: &[String]) -> String {
    format!(
        "\n# Hidden interactive elements (no ARIA role):\n{}",
        lines.join("\n")
    )
}

/// Parse cursor-interactive JS output and dedup against existing snapshot text.
///
/// Exposed for testing. Returns formatted lines for elements not already in the snapshot.
fn parse_cursor_elements(json_str: &str, snapshot: &str) -> Vec<String> {
    let elements: Vec<Value> = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let existing_texts: std::collections::HashSet<String> = snapshot
        .lines()
        .filter_map(|l| {
            let start = l.find('"')?;
            let end = l[start + 1..].find('"')?;
            Some(l[start + 1..start + 1 + end].to_lowercase())
        })
        .collect();

    let mut lines = Vec::new();
    for el in &elements {
        let text = el.get("text").and_then(|v| v.as_str()).unwrap_or("");
        if text.is_empty() || existing_texts.contains(&text.to_lowercase()) {
            continue;
        }
        let tag = el.get("tag").and_then(|v| v.as_str()).unwrap_or("div");
        let hints = el.get("hints").and_then(|v| v.as_str()).unwrap_or("");
        lines.push(format!("- clickable <{tag}> \"{text}\" [{hints}]"));
    }
    lines
}

/// Detect if a page snapshot looks like an error page (404, 403, 500, etc.).
///
/// Scans the header (first 500 chars) and heading lines for error signals.
/// Returns a recovery hint string to append to the snapshot, or `None`.
///
/// Guards against false positives: "404 results found" is not an error page.
/// Detect CAPTCHA challenges on sparse pages (< 15 interactive elements).
///
/// This is safe from false positives because we only check pages with very few
/// elements — a real website form (Italo: 50+ elements) will never match.
/// PerimeterX "hold to verify" buttons typically don't appear in the accessibility
/// tree, so we detect via page text and suggest hold_click at center coordinates.
fn detect_captcha_in_sparse_page(tree: &str) -> Option<String> {
    let lower = tree.to_ascii_lowercase();

    // Hold-to-verify patterns (PerimeterX, HUMAN Security)
    let is_hold_captcha = lower.contains("tieni premuto")
        || lower.contains("press and hold")
        || lower.contains("hold to verify")
        || lower.contains("premi e tieni");

    // General bot check patterns
    let is_bot_check = lower.contains("persona o un robot")
        || lower.contains("are you a robot")
        || lower.contains("are you human")
        || lower.contains("human verification")
        || lower.contains("bot detection")
        || lower.contains("verifica di sicurezza");

    if is_hold_captcha {
        return Some(
            "\n\n** CAPTCHA DETECTED: Hold-to-Verify **\n\
             This is a PerimeterX/HUMAN Security challenge. The 'hold' button is NOT in \
             the accessibility tree — it's a custom widget.\n\
             → Use: browser({action: \"hold_click\"})\n\
             The button will be auto-detected via JS. No coordinates needed.\n\
             After release, take a snapshot to verify if the challenge was passed.\n\
             If hold_click fails in headless, use browser({action: \"show\"}) to switch \
             to visible mode, then retry. After passing, use browser({action: \"hide\"}).\n"
                .to_string(),
        );
    }

    if is_bot_check {
        return Some(
            "\n\n** CAPTCHA DETECTED: Bot Verification Page **\n\
             The site is showing a bot verification challenge. Try:\n\
             1. Use hold_click (auto-detects button position): browser({action: \"hold_click\"})\n\
             2. If it's a Cloudflare check: wait(seconds=5) then snapshot()\n\
             3. If it's a visual CAPTCHA (image selection): inform the user it requires manual intervention\n"
                .to_string(),
        );
    }

    None
}

/// Detect unexpected navigation — the page URL changed after a click that
/// shouldn't have navigated (e.g. blank page redirect, page reload to home).
///
/// This catches the Italo scenario: click on date field → SPA redirect →
/// home page, but agent doesn't notice and keeps using stale refs.
/// Extract the page URL from a browser snapshot output.
fn extract_url_from_snapshot(snapshot: &str) -> Option<String> {
    snapshot
        .lines()
        .find(|line| line.contains("Page URL:"))
        .and_then(|line| line.split("Page URL:").nth(1))
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
}

/// Detect unexpected navigation — the page URL changed after a click that
/// shouldn't have navigated (e.g. blank page redirect, page reload to home).
fn detect_unexpected_navigation(snapshot: &str, previous_url: Option<&str>) -> Option<String> {
    let previous = previous_url?;
    if previous.is_empty() {
        return None;
    }

    // Extract current URL from snapshot
    let current_url = snapshot
        .lines()
        .find(|line| line.starts_with("Page URL:") || line.starts_with("- Page URL:"))
        .and_then(|line| line.split("Page URL:").nth(1))
        .map(|u| u.trim())?;

    if current_url.is_empty() || current_url == previous {
        return None;
    }

    // Check if we went from a deep URL to the site root (home page redirect)
    let prev_path = previous.split("//").nth(1).unwrap_or(previous);
    let curr_path = current_url.split("//").nth(1).unwrap_or(current_url);
    let prev_depth = prev_path.split('/').filter(|s| !s.is_empty()).count();
    let curr_depth = curr_path.split('/').filter(|s| !s.is_empty()).count();

    // Same domain, went from deep page to root → likely a redirect/reset
    let prev_host = prev_path.split('/').next().unwrap_or("");
    let curr_host = curr_path.split('/').next().unwrap_or("");

    if prev_host == curr_host && prev_depth > curr_depth + 1 {
        return Some(format!(
            "NAVIGATION CHANGED: The page redirected from a deep URL to the home page. \
             Previous: {previous} → Current: {current_url}. \
             The form state may have been lost. Take a fresh snapshot and verify \
             the form fields are still filled before continuing."
        ));
    }

    // Completely different domain
    if prev_host != curr_host {
        return Some(format!(
            "NAVIGATION CHANGED: The page navigated to a different domain. \
             Previous: {previous} → Current: {current_url}. \
             This was unexpected — verify the page state before continuing."
        ));
    }

    // URL changed but same domain and similar depth — might be normal (form submission → results)
    // Don't warn for these as they're expected behavior
    None
}

fn detect_error_page(snapshot: &str) -> Option<String> {
    let header = &snapshot[..snapshot.len().min(500)];
    let header_lower = header.to_ascii_lowercase();

    // Check page title / header for error codes
    let title_error = header_lower.contains("404")
        || header_lower.contains("page not found")
        || header_lower.contains("pagina non trovata")
        || header_lower.contains("not found")
        || header_lower.contains("403")
        || header_lower.contains("forbidden")
        || header_lower.contains("access denied")
        || header_lower.contains("accesso negato")
        || header_lower.contains("500")
        || header_lower.contains("internal server error")
        || header_lower.contains("temporarily unavailable")
        || header_lower.contains("under maintenance")
        || header_lower.contains("manutenzione");

    // Check heading lines deeper in the snapshot
    let heading_error = snapshot.lines().any(|line| {
        let trimmed = line.trim_start().trim_start_matches("- ");
        if !trimmed.starts_with("heading ") {
            return false;
        }
        let lower = trimmed.to_ascii_lowercase();
        lower.contains("404")
            || lower.contains("not found")
            || lower.contains("error")
            || lower.contains("errore")
            || lower.contains("page not found")
            || lower.contains("forbidden")
    });

    if !title_error && !heading_error {
        return None;
    }

    // False positive guard: "404 results found" or "found 404 items"
    if header_lower.contains("404 result")
        || header_lower.contains("found 404")
        || header_lower.contains("404 item")
    {
        return None;
    }

    Some(
        "\n\n⚠ This appears to be an error page (404 / Page not found).\n\
         The URL may be wrong or the page was removed.\n\
         Try: navigate to the site's homepage and search/browse from there."
            .to_string(),
    )
}

/// Detect CAPTCHA/verification pages by checking for sparse interactive elements
/// combined with CAPTCHA keywords. Only fires on pages with <15 interactive elements
/// to avoid false positives on complex pages (booking forms, search results).
fn detect_captcha_sparse_page(snapshot: &str) -> Option<String> {
    let interactive_count = snapshot.matches("[ref=").count();
    if interactive_count >= 15 {
        return None; // complex page — not a CAPTCHA
    }

    let lower = snapshot.to_ascii_lowercase();
    let is_captcha = lower.contains("persona o un robot")
        || lower.contains("are you a robot")
        || lower.contains("are you human")
        || lower.contains("verify you are human")
        || lower.contains("tieni premuto")
        || lower.contains("press and hold")
        || lower.contains("hold to verify")
        || lower.contains("human verification")
        || lower.contains("bot detection")
        || lower.contains("security check")
        || lower.contains("captcha")
        || lower.contains("challenge-platform")
        || lower.contains("cf-turnstile");

    if !is_captcha {
        return None;
    }

    tracing::info!(
        interactive_count,
        "CAPTCHA/verification page detected (sparse page)"
    );

    Some(format!(
        "\n\n⚠ CAPTCHA DETECTED — This page has a bot verification challenge ({interactive_count} elements).\n\
         Try these steps in order:\n\
         1. Use hold_click at the center of the page (try ref of the verify button, duration_ms=15000)\n\
         2. After hold_click, wait 3-5 seconds and take a snapshot to check\n\
         3. If still blocked, use show() to switch to visible browser mode, then retry\n\
         4. After passing the CAPTCHA, use hide() to switch back to headless"
    ))
}

// ============================================================================
// Error classification
// ============================================================================

/// Classify a Playwright error and return a contextual recovery hint.
///
/// Returns empty string if the error doesn't match any known pattern.
/// The hint is appended to the error message — pure context, no commands.
fn classify_browser_error(raw: &str) -> &'static str {
    let lower = raw.to_lowercase();

    // Stale element references (DOM changed since last snapshot)
    if lower.contains("not attached to the dom")
        || lower.contains("element handle")
        || lower.contains("execution context was destroyed")
        || lower.contains("frame was detached")
    {
        return "\n\nContext: Element refs are stale — the page DOM has changed \
                since the last snapshot. Take a new snapshot to get fresh refs.";
    }

    // Target/browser closed
    if lower.contains("target closed")
        || lower.contains("target page, context or browser has been closed")
        || lower.contains("browser has been closed")
    {
        return "\n\nContext: The browser session ended. Navigate to a URL \
                to start a new session.";
    }

    // Element not found (bad ref)
    if lower.contains("no element matches")
        || lower.contains("element not found")
        || lower.contains("unable to find")
        || lower.contains("ref") && lower.contains("not found")
    {
        return "\n\nContext: The referenced element no longer exists on the page. \
                The page may have changed (navigation, AJAX update, modal closed). \
                Take a new snapshot() to get current refs. Do NOT retry with the same ref.";
    }

    // HTTP/2 protocol error — site-level bot blocking (TLS fingerprint rejection)
    if lower.contains("err_http2_protocol_error") || lower.contains("err_http2_") {
        return "\n\nContext: The site is blocking the browser at the TLS/HTTP2 level \
                (bot detection via TLS fingerprint). Try these steps in order:\n\
                1. Use show() to switch to VISIBLE browser mode — visible Chrome has \
                   a different TLS fingerprint that many sites accept\n\
                2. After show(), retry navigate to the same URL\n\
                3. If still blocked, navigate to Google, search for the site, and \
                   click through from search results\n\
                4. After completing the task, use hide() to return to headless mode";
    }

    // Network errors
    if lower.contains("net::err_")
        || lower.contains("ns_error_")
        || lower.contains("err_connection")
        || lower.contains("err_name_not_resolved")
        || lower.contains("err_cert_")
    {
        return "\n\nContext: Network error — the URL may be unreachable, \
                have a DNS issue, or the site may be blocking automated access. \
                Try navigating via Google search results instead of direct URL.";
    }

    // Timeout on click — likely an overlay/popup covering the element
    if lower.contains("timeout") || lower.contains("waiting for") {
        return "\n\nContext: The click timed out — this usually means a popup, \
                overlay, cookie banner, or modal is covering the element. \
                Do NOT retry the same click. Instead: \
                1) Take a snapshot() to see the current page state \
                2) Look for overlays/modals to dismiss first \
                3) If no overlay is visible, the element may have moved — use fresh refs \
                4) If it keeps failing, try screenshot() to see the visual state";
    }

    // Blocked by security policy
    if lower.contains("not allowed") || lower.contains("blocked by") {
        return "\n\nContext: The action was blocked by the page's security \
                policy or content security settings.";
    }

    "" // Unknown error — no hint
}

/// Build a classified error `ToolResult` for browser actions.
///
/// Appends a contextual recovery hint when the error matches a known
/// Playwright error pattern. Unknown errors pass through unchanged.
fn browser_error_result(action: &str, error: &anyhow::Error) -> ToolResult {
    let raw = error.to_string();
    let hint = classify_browser_error(&raw);
    ToolResult::error(format!("{action} failed: {raw}{hint}"))
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_ref_correct() {
        let args = json!({"ref": "e42"});
        assert_eq!(BrowserTool::normalize_ref(&args).unwrap(), "e42");
    }

    #[test]
    fn test_normalize_ref_numeric() {
        let args = json!({"ref": "42"});
        assert_eq!(BrowserTool::normalize_ref(&args).unwrap(), "e42");
    }

    #[test]
    fn test_normalize_ref_with_prefix() {
        let args = json!({"ref": "ref=e42"});
        assert_eq!(BrowserTool::normalize_ref(&args).unwrap(), "e42");
    }

    #[test]
    fn test_normalize_ref_missing() {
        let args = json!({"action": "click"});
        assert!(BrowserTool::normalize_ref(&args).is_err());
    }

    #[test]
    fn test_compact_browser_snapshot_filters_noise() {
        let output = "Page URL: https://example.com\nPage Title: Example\n- navigation\n  - heading \"Welcome\"\n  - textbox \"Email\" [ref=e5]\n  - textbox \"Password\" [ref=e6]\n  - button \"Login\" [ref=e7]\n- paragraph \"Footer text\"\n";
        let result = compact_browser_snapshot(output);
        // Interactive elements and their ancestors preserved
        assert!(result.contains("Email"));
        assert!(result.contains("[ref=e5]"));
        assert!(result.contains("3 interactive elements"));
        assert!(result.contains("heading \"Welcome\""));
        assert!(result.contains("navigation"));
        // Non-ref paragraph gets filtered out (noise reduction)
        assert!(!result.contains("Footer text"));
        // Form planning instruction present
        assert!(result.contains("FORM PLAN"));
    }

    #[test]
    fn test_compact_preserves_refs_and_content_roles() {
        let output = "- main\n  - section\n    - heading \"Results\"\n    - list\n      - listitem \"Train ICE 1234\"\n      - button \"Buy\" [ref=e10]\n  - footer\n    - paragraph \"Copyright\"\n";
        let result = compact_browser_snapshot(output);
        // Ref elements and content roles preserved with ancestors
        assert!(result.contains("button \"Buy\" [ref=e10]"));
        assert!(result.contains("list"));
        assert!(result.contains("section"));
        assert!(result.contains("main"));
        assert!(result.contains("heading \"Results\""));
        assert!(result.contains("listitem \"Train ICE 1234\""));
        // Non-ref, non-content elements filtered
        assert!(!result.contains("Copyright"));
        assert!(!result.contains("footer"));
    }

    #[test]
    fn test_compact_tree_lines_reduces_noise() {
        // Simulates a noisy page with 20+ elements but only a few relevant ones
        let lines = vec![
            "- banner",
            "  - navigation \"Main\"",
            "    - link \"Home\" [ref=e1]",
            "    - link \"Offers\" [ref=e2]",
            "    - link \"Info\" [ref=e3]",
            "    - link \"Help\" [ref=e4]",
            "  - img \"Logo\"",
            "- main",
            "  - heading \"Book your trip\" [level=1]",
            "  - group \"Search form\"",
            "    - combobox \"Departure\" [ref=e10]",
            "    - combobox \"Arrival\" [ref=e11]",
            "    - combobox \"Date\" [ref=e12]",
            "    - button \"Search\" [ref=e13]",
            "  - section \"Promotions\"",
            "    - paragraph \"Summer deals\"",
            "    - link \"Learn more\" [ref=e20]",
            "- contentinfo",
            "  - navigation \"Footer\"",
            "    - link \"Privacy\" [ref=e30]",
            "    - link \"Terms\" [ref=e31]",
            "    - link \"Cookies\" [ref=e32]",
            "    - link \"Contact\" [ref=e33]",
            "  - paragraph \"© 2026 Trenitalia\"",
        ];
        let result = compact_tree_lines(&lines);

        // Interactive elements preserved
        assert!(result.contains("[ref=e10]"));
        assert!(result.contains("[ref=e13]"));
        assert!(result.contains("heading \"Book your trip\""));

        // Ancestors preserved for context
        assert!(result.contains("main"));
        assert!(result.contains("Search form"));

        // Noise removed: decorative elements without refs
        assert!(!result.contains("img \"Logo\""));
        assert!(!result.contains("© 2026 Trenitalia"));

        // Key metric: output is significantly shorter than input
        let input_len = lines.join("\n").len();
        let output_len = result.len();
        assert!(
            output_len < input_len,
            "Compact should reduce size: input={input_len} output={output_len}"
        );
    }

    #[test]
    fn test_extract_autocomplete_suggestions() {
        let output = "- combobox \"From\" [ref=e10]\n  - listbox\n    - option \"Roma Termini\" [ref=e11]\n    - option \"Roma Tiburtina\" [ref=e12]\n";
        let suggestions = extract_autocomplete_suggestions(output).unwrap();
        assert!(suggestions.contains("Roma Termini"));
        assert!(suggestions.contains("2 suggestion(s)"));
        assert!(suggestions.contains("click"));
    }

    #[test]
    fn test_no_autocomplete_suggestions() {
        let output = "- textbox \"Search\" [ref=e1]\n- button \"Go\" [ref=e2]\n";
        assert!(extract_autocomplete_suggestions(output).is_none());
    }

    #[test]
    fn test_browser_action_from_args() {
        assert_eq!(
            browser_action_from_args(&json!({"action": "click", "ref": "e42"})),
            Some("click")
        );
        assert_eq!(browser_action_from_args(&json!({})), None);
    }

    #[test]
    fn test_parse_cursor_elements_basic() {
        let json = r#"[{"text":"Sign In","tag":"div","hints":"cursor:pointer"},{"text":"Add to Cart","tag":"span","hints":"onclick"}]"#;
        let snapshot = "- button \"Other\" [ref=e1]";
        let lines = parse_cursor_elements(json, snapshot);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("clickable <div> \"Sign In\""));
        assert!(lines[1].contains("onclick"));
    }

    #[test]
    fn test_parse_cursor_elements_dedup() {
        let json = r#"[{"text":"Login","tag":"div","hints":"cursor:pointer"},{"text":"New","tag":"span","hints":"tabindex"}]"#;
        // "Login" already appears in the snapshot — should be deduped
        let snapshot = "- button \"Login\" [ref=e1]\n- heading \"Welcome\"";
        let lines = parse_cursor_elements(json, snapshot);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("\"New\""));
    }

    #[test]
    fn test_parse_cursor_elements_empty() {
        let lines = parse_cursor_elements("[]", "");
        assert!(lines.is_empty());
    }

    #[test]
    fn test_parse_cursor_elements_bad_json() {
        let lines = parse_cursor_elements("not json", "");
        assert!(lines.is_empty());
    }

    #[test]
    fn test_format_cursor_section() {
        let lines = vec!["- clickable <div> \"Sign In\" [cursor:pointer]".to_string()];
        let section = format_cursor_section(&lines);
        assert!(section.contains("# Hidden interactive elements"));
        assert!(section.contains("Sign In"));
    }

    #[test]
    fn test_detect_error_page_404_in_title() {
        let snapshot = "Page URL: https://prada.com/it/scarpe.html\nPage title: 404 - Pagina non trovata\n(2 interactive elements)\n- navigation\n  - link \"Home\" [ref=e1]\n";
        assert!(detect_error_page(snapshot).is_some());
    }

    #[test]
    fn test_detect_error_page_heading() {
        let snapshot = "(5 interactive elements)\n- main\n  - heading \"Page Not Found\"\n  - button \"Go Home\" [ref=e1]\n";
        assert!(detect_error_page(snapshot).is_some());
    }

    #[test]
    fn test_detect_error_page_normal_page() {
        let snapshot = "Page URL: https://prada.com/shoes\nPage title: Shoes | Prada\n(12 interactive elements)\n- heading \"Men's Shoes\"\n- button \"Buy\" [ref=e1]\n";
        assert!(detect_error_page(snapshot).is_none());
    }

    #[test]
    fn test_detect_error_page_false_positive_guard() {
        // "404 results found" should NOT be flagged
        let snapshot = "Page title: Search Results - 404 results found\n(20 interactive elements)\n- heading \"Search Results\"\n";
        assert!(detect_error_page(snapshot).is_none());
    }

    // ---- Error classification tests ----

    #[test]
    fn test_classify_stale_ref() {
        let hint = classify_browser_error("Element is not attached to the DOM");
        assert!(hint.contains("stale"));
        assert!(hint.contains("fresh refs"));

        let hint2 = classify_browser_error("Execution context was destroyed");
        assert!(hint2.contains("stale"));

        let hint3 = classify_browser_error("Frame was detached");
        assert!(hint3.contains("stale"));
    }

    #[test]
    fn test_classify_target_closed() {
        let hint = classify_browser_error("Target closed");
        assert!(hint.contains("session ended"));

        let hint2 = classify_browser_error("Target page, context or browser has been closed");
        assert!(hint2.contains("session ended"));
    }

    #[test]
    fn test_classify_element_not_found() {
        let hint = classify_browser_error("No element matches selector: e99");
        assert!(hint.contains("no longer exists"));
        assert!(hint.contains("new snapshot"));
    }

    #[test]
    fn test_classify_network_error() {
        let hint = classify_browser_error("net::ERR_NAME_NOT_RESOLVED");
        assert!(hint.contains("Network error"));

        let hint2 = classify_browser_error("net::ERR_CONNECTION_REFUSED");
        assert!(hint2.contains("Network error"));

        let hint3 = classify_browser_error("net::ERR_CERT_AUTHORITY_INVALID");
        assert!(hint3.contains("Network error"));
    }

    #[test]
    fn test_classify_timeout() {
        let hint = classify_browser_error("Timeout 30000ms exceeded");
        assert!(hint.contains("timed out"));

        let hint2 = classify_browser_error("waiting for selector .btn");
        assert!(hint2.contains("timed out"));
    }

    #[test]
    fn test_classify_blocked() {
        let hint = classify_browser_error("Navigation is not allowed");
        assert!(hint.contains("blocked"));
    }

    #[test]
    fn test_classify_unknown_error() {
        let hint = classify_browser_error("some random playwright error xyz");
        assert!(hint.is_empty());
    }

    #[test]
    fn test_browser_error_result_format() {
        let err = anyhow::anyhow!("Element is not attached to the DOM");
        let result = browser_error_result("Click", &err);
        assert!(result.is_error);
        // Contains original error
        assert!(result.output.contains("Click failed:"));
        assert!(result.output.contains("not attached to the DOM"));
        // Contains recovery hint
        assert!(result.output.contains("Context:"));
        assert!(result.output.contains("fresh refs"));
    }

    #[test]
    fn test_browser_error_result_unknown() {
        let err = anyhow::anyhow!("bizarre unknown error");
        let result = browser_error_result("Hover", &err);
        // Contains original error but no hint
        assert!(result
            .output
            .contains("Hover failed: bizarre unknown error"));
        assert!(!result.output.contains("Context:"));
    }

    // ---- Description tests for new actions ----

    #[test]
    fn test_description_lists_new_actions() {
        // Verify that the description() string mentions the new actions.
        // We can't instantiate BrowserTool without a live McpPeer, but
        // the description is a static string, so we check it directly.
        let desc = "Browser automation. Actions:\n\
         - navigate(url): Go to URL (auto-returns page snapshot)\n\
         - snapshot(): Get page accessibility tree with interactive elements [ref=eN]\n\
         - click(ref): Click element (auto-returns updated snapshot)\n\
         - type(ref, text): Type text into field (triggers autocomplete check)\n\
         - fill(ref, text): Clear field + type (for overwriting)\n\
         - select_option(ref, value): Select dropdown option\n\
         - press_key(text): Press key (e.g. \"Enter\", \"Tab\")\n\
         - hover(ref): Hover over element\n\
         - scroll(direction, ref?): Scroll page or element up/down\n\
         - drag(ref, end_ref): Drag from ref to end_ref\n\
         - screenshot(): Take screenshot and describe via vision model\n\
         - click_coordinates(x, y): Click at pixel coordinates (for canvas/SVG/maps)\n\
         - block_resources(): Block images/fonts/media for faster navigation\n\
         - unblock_resources(): Restore normal resource loading\n\
         - evaluate(expression): Read page state via JS (READ-ONLY, no DOM changes)\n\
         - wait(seconds): Wait N seconds\n\
         - close(): Close browser tab";
        assert!(desc.contains("click_coordinates(x, y)"));
        assert!(desc.contains("block_resources()"));
        assert!(desc.contains("unblock_resources()"));
    }

    // ---- Page stage detection tests ----

    #[test]
    fn test_detect_results_listing() {
        // 4 listitems each with a button → ResultsListing
        let tree = "\
- main
  - list
    - listitem \"Train 1\"
      - text \"08:30\"
      - button \"Select\" [ref=e1]
    - listitem \"Train 2\"
      - text \"09:30\"
      - button \"Select\" [ref=e2]
    - listitem \"Train 3\"
      - text \"10:30\"
      - button \"Select\" [ref=e3]
    - listitem \"Train 4\"
      - text \"11:30\"
      - button \"Select\" [ref=e4]";
        assert_eq!(detect_page_stage(tree, false), PageStage::ResultsListing);
    }

    #[test]
    fn test_detect_search_form() {
        // 3 form fields, no repeated interactive groups → SearchForm
        let tree = "\
- main
  - combobox \"From\" [ref=e1]
  - combobox \"To\" [ref=e2]
  - textbox \"Date\" [ref=e3]
  - button \"Search\" [ref=e4]";
        assert_eq!(detect_page_stage(tree, false), PageStage::SearchForm);
    }

    #[test]
    fn test_detect_action_required() {
        // Summary content with 2 buttons, few interactive elements → ActionRequired
        let tree = "\
- main
  - heading \"Booking Summary\"
  - text \"Roma → Milano, 12:30\"
  - text \"1 passenger, Economy\"
  - button \"Back\" [ref=e1]
  - button \"Confirm\" [ref=e2]";
        assert_eq!(detect_page_stage(tree, false), PageStage::ActionRequired);
    }

    #[test]
    fn test_detect_unknown_page() {
        // Just a heading and lots of links — unknown
        let tree = "\
- navigation
  - link \"Home\" [ref=e1]
  - link \"About\" [ref=e2]
  - link \"Contact\" [ref=e3]
  - link \"FAQ\" [ref=e4]
  - link \"Help\" [ref=e5]
  - link \"Terms\" [ref=e6]
  - link \"Privacy\" [ref=e7]
  - link \"Blog\" [ref=e8]
  - link \"Careers\" [ref=e9]
  - link \"Press\" [ref=e10]
  - link \"Partners\" [ref=e11]
  - link \"Support\" [ref=e12]
  - link \"Status\" [ref=e13]
  - link \"API\" [ref=e14]
  - link \"Docs\" [ref=e15]
  - link \"Community\" [ref=e16]";
        assert_eq!(detect_page_stage(tree, false), PageStage::Unknown);
    }

    #[test]
    fn test_results_listing_with_rows() {
        // Table-based results (rows with buttons)
        let tree = "\
- table
  - row
    - cell \"Flight 101\"
    - cell \"$299\"
    - button \"Book\" [ref=e1]
  - row
    - cell \"Flight 202\"
    - cell \"$349\"
    - button \"Book\" [ref=e2]
  - row
    - cell \"Flight 303\"
    - cell \"$199\"
    - button \"Book\" [ref=e3]";
        assert_eq!(detect_page_stage(tree, false), PageStage::ResultsListing);
    }

    #[test]
    fn test_results_listing_with_groups() {
        // Card-based results (groups with buttons)
        let tree = "\
- main
  - group \"Product A\"
    - heading \"Shoes Model A\"
    - text \"$89.00\"
    - button \"Add to Cart\" [ref=e1]
  - group \"Product B\"
    - heading \"Shoes Model B\"
    - text \"$120.00\"
    - button \"Add to Cart\" [ref=e2]
  - group \"Product C\"
    - heading \"Shoes Model C\"
    - text \"$65.00\"
    - button \"Add to Cart\" [ref=e3]";
        assert_eq!(detect_page_stage(tree, false), PageStage::ResultsListing);
    }

    #[test]
    fn test_stage_hint_in_compact_snapshot() {
        // Results page snapshot should contain the RESULTS PAGE hint
        let output = "Page URL: https://trenitalia.com/results\n- main\n  - list\n    - listitem \"Train 1\"\n      - button \"Select\" [ref=e1]\n    - listitem \"Train 2\"\n      - button \"Select\" [ref=e2]\n    - listitem \"Train 3\"\n      - button \"Select\" [ref=e3]\n";
        let result = compact_browser_snapshot_staged(output, false);
        assert!(
            result.contains("RESULTS PAGE"),
            "should contain results hint"
        );
        assert!(result.contains("selectable items"));
    }

    #[test]
    fn test_form_plan_still_works_in_staged() {
        let output = "Page URL: https://example.com\n\
- main\n\
  - textbox \"Email\" [ref=e1]\n\
  - textbox \"Password\" [ref=e2]\n\
  - button \"Login\" [ref=e3]\n";
        let result = compact_browser_snapshot_staged(output, false);
        assert!(
            result.contains("FORM PLAN"),
            "form pages should still get FORM PLAN"
        );
    }
}
