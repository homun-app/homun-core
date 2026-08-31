//! Chat, browser, and delegated tool execution owner.
//!
//! Owns the gateway-side tool contexts, effect receipt lifecycle, browser tool
//! execution, chat tool dispatch, capability/browser/browse/computer executor
//! seams, and browse sub-agent isolation. The agent loop remains in `main.rs`
//! until its own owner boundary is extracted.

use super::*;
use base64::Engine as _;

#[test]
fn tool_execution_owner_smoke() {
    assert_eq!(
        browser_action_effect_class(
            &serde_json::json!({"kind": "click", "ref": "e1", "action_class": "ordinary"}),
            &std::collections::HashSet::new(),
            false,
        ),
        local_first_execution_protocol::EffectClass::Read,
    );
    assert_eq!(
        browser_effect_class("browser_rehydrate"),
        Some(local_first_execution_protocol::EffectClass::ExternalWrite)
    );
}

#[test]
fn browse_subagent_prompt_documents_autocomplete_semantic_default() {
    let prompt = browse_subagent_system_prompt(true);
    assert!(
        prompt.contains("auto_complete is"),
        "prompt must explain auto_complete behavior"
    );
    assert!(
        prompt.contains("uses DOM semantics"),
        "prompt must say autocomplete follows DOM semantics"
    );
    assert!(
        !prompt.contains("forced to false"),
        "prompt must not force a gateway policy over the sidecar"
    );
}

#[test]
fn chat_objective_execution_context_prunes_connected_catalog_and_projects_memory_defaults() {
    let state = AppState::for_tests();
    let composio_writes = std::collections::BTreeSet::new();
    let context = prepare_chat_objective_execution_context(ChatObjectiveExecutionContextInput {
        state: &state,
        thread_id: None,
        catalog_index: vec![
            (
                "read_file".to_string(),
                "Read file".to_string(),
                serde_json::json!({}),
            ),
            (
                "write_file".to_string(),
                "Write file".to_string(),
                serde_json::json!({}),
            ),
        ],
        composio_writes: &composio_writes,
    });

    let names = context
        .catalog_index
        .iter()
        .map(|(name, _, _)| name.as_str())
        .collect::<Vec<_>>();

    assert_eq!(names, vec!["read_file"]);
    assert!(
        context
            .objective_effect_policy
            .allows(semantic_decision::EffectClass::Read)
    );
    assert!(
        !context
            .objective_effect_policy
            .allows(semantic_decision::EffectClass::FilesystemWrite)
    );
    assert!(context.memory_intent.use_current_thread);
    assert!(!memory_intent_allows_recall(&context.memory_intent));
    assert!(context.memory_injection.include_current_thread);
}

#[test]
fn browse_timeout_preserves_grounded_snapshot_as_partial_result() {
    let snapshot = format!(
        "{}\n{}",
        "Trenitalia risultati Milano Centrale Roma Termini".repeat(12),
        "FR 9512 09:05 12:10 prezzo EUR 49.90".repeat(12)
    );

    let result = browse_subturn_timeout_result(
        &snapshot,
        vec!["https://www.trenitalia.com/".to_string()],
        None,
    );

    assert!(result.found, "snapshot evidence should survive: {result:?}");
    assert_eq!(
        result.status,
        local_first_engine::browse::BrowserDoneStatus::Partial
    );
    assert!(result.answer.contains("FR 9512"), "got: {}", result.answer);
    assert_eq!(result.sources, vec!["https://www.trenitalia.com/"]);
}

#[test]
fn browse_timeout_with_unsatisfied_contract_is_not_found() {
    let snapshot = format!(
        "{}\n{}",
        "Trenitalia homepage Milano Roma search form ".repeat(16),
        "Partenza Milano Centrale Arrivo Roma Termini Data 25/08/2026 Ora 08:00 ".repeat(16)
    );
    let contract = local_first_engine::browse::BrowseResultContract {
        kind: local_first_engine::browse::BrowseResultKind::List,
        minimum_items: Some(3),
        fields: vec![
            local_first_engine::browse::BrowseResultField {
                name: "departure".into(),
                required: true,
            },
            local_first_engine::browse::BrowseResultField {
                name: "arrival".into(),
                required: true,
            },
            local_first_engine::browse::BrowseResultField {
                name: "duration".into(),
                required: true,
            },
        ],
        boundary: Some("read results only".into()),
    };

    let result = browse_subturn_timeout_result(
        &snapshot,
        vec!["https://www.trenitalia.com/".to_string()],
        Some(&contract),
    );

    assert!(
        !result.found,
        "a long form/homepage snapshot without contract items must not become a found result: {result:?}"
    );
    assert_eq!(
        result.status,
        local_first_engine::browse::BrowserDoneStatus::Timeout
    );
    assert!(result.answer.contains("Milano Centrale"));
    assert!(result.fields_missing.contains(&"minimum_items".to_string()));
    assert!(result.fields_missing.contains(&"departure".to_string()));
}

#[test]
fn browser_navigate_result_records_visited_source_for_timeout_fallback() {
    let mut sources = Vec::new();

    record_browser_navigate_source(
        &mut sources,
        "Page opened (https://www.trenitalia.com/search). Snapshot:\nRisultati Milano Roma",
    );

    assert_eq!(sources, vec!["https://www.trenitalia.com/search"]);
}

pub(crate) fn record_browser_navigate_source(sources: &mut Vec<String>, result: &str) {
    if let Some(url) = local_first_engine::text::extract_source_urls(result)
        .into_iter()
        .next()
        && !local_first_engine::text::is_low_value_source_url(&url)
        && !sources.contains(&url)
    {
        sources.push(url);
    }
}

pub(crate) fn load_turn_effect_contract(
    state: &AppState,
    execution_id: Option<&str>,
) -> Option<local_first_execution_protocol::ValidatedExecutionContract> {
    let execution_id = execution_id?;
    state
        .task_store
        .lock()
        .ok()?
        .execution(execution_id)
        .ok()
        .flatten()
        .map(|record| record.contract)
}

/// The browser branch's tool context (ADR 0026 / inc 5, 5.D1b slice 3). SPLIT out of `ChatToolCtx`
/// because `execute_browser_tool` and `execute_chat_tool` have DISJOINT read-sets: the browser
/// tool reads the browser cluster + provider + a few read-only fields, and nothing execute_chat_tool
/// reads. Keeping them separate lets each seam build ONLY the fields its tool touches (the browser
/// branch stays the temporary seam ADR 0025 replaces with a recursive `browse`). `browser_session`
/// is threaded separately (its Cell/RefCell would make this non-`Sync`).
pub(crate) struct BrowserToolCtx<'a> {
    pub(crate) browser_used: &'a mut bool,
    pub(crate) last_snapshot: &'a mut String,
    pub(crate) last_snapshot_semantic_fingerprint: &'a mut String,
    // Machine-derived payment floor refs (never label text), keyed by `target_id`
    // (Build1 Fix 3 — mirrors `payment_context_by_target` below; a single global
    // set let observing tab A clobber tab B's floor). Raises (never lowers) the
    // effective action class; see `browser_safety::effective_action_class`.
    pub(crate) payment_floor_refs:
        &'a mut std::collections::HashMap<String, std::collections::HashSet<String>>,
    // Per-target_id payment context (focus flag + robust last-acted-floored flag;
    // fixes IMPORTANT D — a single global flag let a snapshot of tab A clear tab B's
    // payment context). Floors a ref-less committing action (Enter/Return) the same
    // way `payment_floor_refs` floors a ref-bearing one — see
    // `browser_safety::is_refless_committing` and `BrowserPaymentContext`.
    pub(crate) payment_context_by_target:
        &'a mut std::collections::HashMap<String, BrowserPaymentContext>,
    pub(crate) pending_browser_image: &'a mut Option<String>,
    pub(crate) browser_tool_call_ids: &'a mut std::collections::BTreeSet<String>,
    pub(crate) current_target: &'a mut String,
    pub(crate) opened_targets: &'a mut Vec<String>,
    pub(crate) nav_failures: &'a mut std::collections::HashMap<String, u32>,
    // ADR 0025 4b: the provider fields (base_url/model/api_key) were removed with the mid-turn
    // model-switch — the browser branch no longer touches the driver provider (the sub-loop is seeded
    // on the browser model at construction).
    pub(crate) state: &'a AppState,
    pub(crate) tx: &'a StreamSink,
    pub(crate) thread_id: Option<&'a str>,
    pub(crate) prompt: &'a str,
    pub(crate) read_only: bool,
    #[allow(dead_code)]
    pub(crate) channel_owner: bool,
    // Durable sink for redacted browser-protocol boundary metrics (C2). Borrowed from the owning
    // `GatewayBrowserExecutor` so every boundary this ctx crosses persists the same handle — a real
    // `GatewayJournal::Durable` when the enclosing run is registered, else the silent `Disabled` arm.
    pub(crate) journal: &'a agent_journal::GatewayJournal,
    pub(crate) execution_contract:
        Option<&'a local_first_execution_protocol::ValidatedExecutionContract>,
    pub(crate) effect_run_id: Option<&'a str>,
    pub(crate) suspend_effect_receipt:
        &'a mut Option<local_first_execution_protocol::EffectReceiptRef>,
    // Out-parameter (D1/D2): the machine progress classification of the action just executed,
    // written where the sidecar's signals live (committed suggestion, page change, error) and
    // read back by `GatewayBrowserExecutor::execute_browser`. `None` on the neutral read-only
    // tools (snapshot/tabs/dialog/screenshot) → the caller defaults them to `Success`. Never
    // derived from the result prose — that is exactly the misclassification this replaces.
    pub(crate) outcome_hint: &'a mut Option<local_first_engine::contract::ToolOutcomeHint>,
    // Whether the current model supports vision/image input. Used to decide whether to inject
    // screenshot images into the conversation (P0 fix for non-vision models like minimax-m2.7,
    // deepseek-v4-pro that fail with "this model does not support image input").
    pub(crate) model_supports_vision: bool,
}

pub(crate) fn browser_effect_class(
    name: &str,
) -> Option<local_first_execution_protocol::EffectClass> {
    matches!(name, "browser_rehydrate")
        .then_some(local_first_execution_protocol::EffectClass::ExternalWrite)
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(crate) enum BrowserEffectRisk {
    Low,
    High,
}

pub(crate) fn browser_action_effect_risk(
    action: &serde_json::Value,
    payment_floor_refs: &std::collections::HashSet<String>,
    focus_payment_context: bool,
) -> BrowserEffectRisk {
    match browser_safety::effective_action_class(action, payment_floor_refs, focus_payment_context)
    {
        Ok(browser_safety::ActionClass::Ordinary) => BrowserEffectRisk::Low,
        Ok(
            browser_safety::ActionClass::Account
            | browser_safety::ActionClass::Booking
            | browser_safety::ActionClass::PaymentCommit,
        )
        | Err(_) => BrowserEffectRisk::High,
    }
}

pub(crate) fn browser_action_effect_class(
    action: &serde_json::Value,
    payment_floor_refs: &std::collections::HashSet<String>,
    focus_payment_context: bool,
) -> local_first_execution_protocol::EffectClass {
    match browser_action_effect_risk(action, payment_floor_refs, focus_payment_context) {
        BrowserEffectRisk::Low => local_first_execution_protocol::EffectClass::Read,
        BrowserEffectRisk::High => local_first_execution_protocol::EffectClass::ExternalWrite,
    }
}

pub(crate) fn browser_act_uncertain_failure_requires_user_resolution(
    risk: BrowserEffectRisk,
    failure_kind: BrowserActFailureKind,
) -> bool {
    risk == BrowserEffectRisk::High && failure_kind == BrowserActFailureKind::UnknownRemoteOutcome
}

pub(crate) fn begin_browser_action_effect<'a>(
    ctx: &BrowserToolCtx<'a>,
    call_id: &str,
    action: serde_json::Value,
    payment_floor_refs: &std::collections::HashSet<String>,
    focus_payment_context: bool,
) -> Result<crate::effect_host::EffectDecision<'a>, String> {
    let contract = ctx.execution_contract.ok_or_else(|| {
        "Browser mutation blocked: no durable execution scope is available.".to_string()
    })?;
    let effect_class =
        browser_action_effect_class(&action, payment_floor_refs, focus_payment_context);
    crate::effect_host::EffectHost::new(ctx.state.task_store.as_ref(), contract, ctx.effect_run_id)
        .begin(crate::effect_host::EffectRequest::capability(
            "browser_act",
            call_id,
            effect_class,
            action,
        ))
}

pub(crate) fn authorize_browser_action_effect(
    ctx: &BrowserToolCtx<'_>,
    call_id: &str,
    action: serde_json::Value,
    payment_floor_refs: &std::collections::HashSet<String>,
    focus_payment_context: bool,
) -> Result<(), String> {
    let contract = ctx.execution_contract.ok_or_else(|| {
        "Browser mutation blocked: no durable execution scope is available.".to_string()
    })?;
    let effect_class =
        browser_action_effect_class(&action, payment_floor_refs, focus_payment_context);
    let request =
        crate::effect_host::EffectRequest::capability("browser_act", call_id, effect_class, action);
    crate::effect_host::EffectHost::new(ctx.state.task_store.as_ref(), contract, ctx.effect_run_id)
        .authorize_request(&request)
}

pub(crate) fn begin_browser_effect<'a>(
    ctx: &BrowserToolCtx<'a>,
    operation: &str,
    call_id: &str,
    arguments: serde_json::Value,
) -> Result<crate::effect_host::EffectDecision<'a>, String> {
    let contract = ctx.execution_contract.ok_or_else(|| {
        "Browser mutation blocked: no durable execution scope is available.".to_string()
    })?;
    let effect_class = browser_effect_class(operation)
        .ok_or_else(|| format!("browser operation {operation} is not effectful"))?;
    crate::effect_host::EffectHost::new(ctx.state.task_store.as_ref(), contract, ctx.effect_run_id)
        .begin(crate::effect_host::EffectRequest::capability(
            operation,
            call_id,
            effect_class,
            arguments,
        ))
}

pub(crate) fn complete_browser_effect(
    ctx: &mut BrowserToolCtx<'_>,
    lease: &crate::effect_host::EffectLease<'_>,
    result: serde_json::Value,
    effects: serde_json::Value,
) -> Result<(), String> {
    let contract = ctx
        .execution_contract
        .ok_or_else(|| "browser effect contract disappeared".to_string())?;
    let host = crate::effect_host::EffectHost::new(
        ctx.state.task_store.as_ref(),
        contract,
        ctx.effect_run_id,
    );
    match host.complete(lease, &result, &effects) {
        Ok(_) => Ok(()),
        Err(error) => {
            *ctx.suspend_effect_receipt = Some(lease.receipt_ref().clone());
            let _ = host.mark_uncertain(lease);
            Err(error)
        }
    }
}

pub(crate) fn mark_browser_effect_uncertain(
    ctx: &mut BrowserToolCtx<'_>,
    lease: &crate::effect_host::EffectLease<'_>,
) -> Result<local_first_task_runtime::ExecutionEffectReceipt, String> {
    let contract = ctx
        .execution_contract
        .ok_or_else(|| "browser effect contract disappeared".to_string())?;
    *ctx.suspend_effect_receipt = Some(lease.receipt_ref().clone());
    crate::effect_host::EffectHost::new(ctx.state.task_store.as_ref(), contract, ctx.effect_run_id)
        .mark_uncertain(lease)
}

/// Verified not-applied settlement for a browser effect whose dispatch failed at
/// the transport level BEFORE the sidecar accepted the Act request (mirrors the
/// channel's `ConnectFailedBeforeDispatch → release_not_applied` pattern). The
/// receipt returns to `prepared` and `suspend_effect_receipt` is deliberately NOT
/// set: nothing ran on the page, there is no double-execution risk, so no user
/// verification card is shown and the engine stays free to retry the action.
pub(crate) fn release_browser_effect_not_applied(
    ctx: &BrowserToolCtx<'_>,
    lease: &crate::effect_host::EffectLease<'_>,
    code: &str,
    detail: &str,
) -> Result<local_first_task_runtime::ExecutionEffectReceipt, String> {
    let contract = ctx
        .execution_contract
        .ok_or_else(|| "browser effect contract disappeared".to_string())?;
    crate::effect_host::EffectHost::new(ctx.state.task_store.as_ref(), contract, ctx.effect_run_id)
        .release_not_applied(lease, code, detail)
}

pub(crate) fn replayed_browser_effect_text(
    receipt: local_first_task_runtime::ExecutionEffectReceipt,
) -> String {
    receipt
        .result_json
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "Previously completed browser effect replayed.".to_string())
}

pub(crate) fn uncertain_browser_effect_text(
    receipt: &local_first_task_runtime::ExecutionEffectReceipt,
) -> String {
    format!(
        "BROWSER EFFECT UNCERTAIN (receipt {}): the action may already have run before an interruption. It was not repeated. Inspect the current page state before any new action.",
        receipt.receipt_ref.as_ref()
    )
}

/// The NON-browser tool context (ADR 0026 / inc 5): the read-set of `execute_chat_tool` only —
/// LoopState reads (plan/step_evidence/tool_trace) + provider + the turn-constant read-only fields.
/// The `CapabilityExecutor` seam builds this per-call from `&mut LoopState` + its held read-only.
pub(crate) struct ChatToolCtx<'a> {
    // Carried as an opaque `Value` (the serialized `ExecutionPlan`) so it lives in `LoopState`
    // (engine-owned, can't reference the gateway's typed plan); `plan_value_from`/`plan_value_steps`
    // bridge to the ExecutionPlan-only helpers. See ADR 0024 inc 5 (P5).
    pub(crate) plan: &'a mut serde_json::Value,
    pub(crate) step_evidence: &'a mut Vec<String>,
    pub(crate) tool_trace: &'a mut Vec<String>,
    pub(crate) base_url: &'a mut String,
    pub(crate) model: &'a mut String,
    pub(crate) api_key: &'a mut Option<String>,
    // `&` / by-value — read-only inside the dispatch loop.
    pub(crate) state: &'a AppState,
    pub(crate) tx: &'a StreamSink,
    pub(crate) thread_id: Option<&'a str>,
    pub(crate) turn_policy: &'a ChatTurnPolicy,
    pub(crate) contact_memory_perimeter: &'a ContactMemoryPerimeter,
    pub(crate) memory_intent: &'a semantic_decision::MemoryIntent,
    pub(crate) composio_writes: &'a std::collections::BTreeSet<String>,
    pub(crate) catalog_index: &'a [(String, String, serde_json::Value)],
    pub(crate) capability_corpus: &'a [CapabilityEntry],
    pub(crate) automation_user_id: &'a UserId,
    pub(crate) automation_workspace_id: &'a WorkspaceId,
    // Readable per-turn observability sink (ported). Used by the `update_plan`/`step_advance` arm to
    // record the Plan event; no-op when disabled. See `engine::turn_trace`.
    pub(crate) turn_trace: &'a local_first_engine::turn_trace::TurnTrace,
    /// ADR 0023 Step 5 (Fase 0.3): sensitive domains armed by a `use_skill` earlier this turn,
    /// re-hydrated per call from the engine's `LoopState::active_sensitive` tokens. Non-empty →
    /// effectful actions force a confirm regardless of approval policy (`skill_policy_forces_confirm`).
    /// Owned (not `&mut`) because arming now flows through `ToolEffects::arm_sensitive`, and the ctx is
    /// built shared per call; this side only READS it at the effectful approval gates.
    pub(crate) active_sensitive: Vec<crate::skills::SensitiveCategory>,
}

/// Emit an approval confirmation card and return the model-facing "AWAITING" string.
/// Verbatim unification of the MCP and Composio confirmation blocks — the only
/// per-family differences are the marker delimiters and the human label. The `card`
/// text is byte-identical to what both inline blocks produced before (same prefix,
/// same marker JSON, trailing `\n`), so the resume flow that parses the marker is
/// unaffected. Side-effects (push to `accumulated`, stream the delta, set
/// `pending_confirm`) are preserved in the same order.
pub(crate) async fn emit_approval_card(
    // `&ctx` (shared): the body only READS `ctx`; the card append and confirm flag go to `effects`.
    // `Send`-safe now that `ChatToolCtx` is `Sync` (5e.1).
    ctx: &ChatToolCtx<'_>,
    effects: &mut local_first_engine::ToolEffects,
    marker_open: &str,
    marker_close: &str,
    name: &str,
    label: &str,
    args_val: &serde_json::Value,
) -> String {
    let approval = create_pending_approval(ctx.state, name, args_val, label, ctx.thread_id, true);
    let marker = match approval.as_ref() {
        Some(approval) => serde_json::json!({
            "approval_id": approval.approval_id,
            "tool": name,
            "arguments": args_val,
        }),
        None => serde_json::json!({ "tool": name, "arguments": args_val }),
    }
    .to_string();
    let card = format!(
        "\n\nI need your confirmation for the action below.\n{marker_open}{marker}{marker_close}\n"
    );
    effects.append_output.push(card.clone());
    let _ = emit_stream_event(ctx.tx, GenerateStreamEvent::Delta { text: card }).await;
    effects.request_confirm = true;
    effects
        .blocked_capabilities
        .push(local_first_engine::BlockedCapability {
            key: name.to_string(),
            reason: "approval_required".to_string(),
        });
    "AWAITING USER CONFIRMATION: the action was proposed via a \
confirmation card in the interface. Do NOT say it was executed."
        .to_string()
}

// ============================================================================
// ADR 0023 — single resolution of the two policy axes (caposaldo #5: ONE policy,
// ONE resolution, ONE chokepoint). Precedence is:
// env-override > persisted RuntimeSettings > default.
//
// ⭐ RECONCILIATION INVARIANT (this line ≠ Codex/source): the OS process fence
// (seatbelt/landlock) is UNCONDITIONAL here — every subprocess is fenced whatever
// the mode (validated by `tests/linux_sandbox.rs`). The `SandboxMode` axis governs
// ONLY the APP-LEVEL policy consumed by `assess_tool_safety` and the in-process
// file-tool chokepoint. **No mode disables/weakens the kernel fence.** `danger`
// here means "no approval cards / app-level auto-allow", NOT "unsandboxed
// subprocess": Homun never fully unsandboxes subprocesses (local-first
// deny-by-default caposaldo), unlike Codex's danger-full-access.
// ============================================================================

/// The resolved sandbox MODE (rootless) for a thread: env `HOMUN_SANDBOX_MODE` >
/// per-workspace override (the thread's `WorkspaceRecord.sandbox_mode`, Fase 1) >
/// persisted global `RuntimeSettings.sandbox_mode` > default. **Default = workspace-write**
/// (behavior-preserving: HEAD already jails every file write to the project root and
/// fences subprocesses, so workspace-write is what it effectively enforces — defaulting
/// to `danger` would REGRESS the app-level policy). Kept a fn (not LazyLock) so tests
/// toggle env per case. No per-workspace mode disables the OS kernel fence (unconditional).
pub(crate) fn resolved_sandbox_mode(
    state: &AppState,
    thread_id: Option<&str>,
) -> crate::tool_safety::SandboxMode {
    let env = std::env::var("HOMUN_SANDBOX_MODE").ok();
    let ws = workspace_record_for_thread(state, thread_id).and_then(|w| w.sandbox_mode);
    resolve_sandbox_mode_core(
        env.as_deref(),
        ws.as_deref(),
        &load_runtime_settings().sandbox_mode,
    )
}

/// The `WorkspaceRecord` for a thread's workspace — mirrors `project_root_for_thread`'s
/// lookup (`store.workspace_for_thread` → the record in workspaces.json). `None` when the
/// thread maps to no known workspace → the caller inherits the global default. Fase 1.
pub(crate) fn workspace_record_for_thread(
    state: &AppState,
    thread_id: Option<&str>,
) -> Option<WorkspaceRecord> {
    let workspace_id = thread_id
        .and_then(|tid| {
            lock_store(state)
                .ok()
                .and_then(|s| s.workspace_for_thread(tid).ok())
        })
        .unwrap_or_else(active_workspace_id);
    load_workspaces_file()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
}

/// Pure precedence core (unit-testable, no AppState/IO): env > per-workspace override >
/// global default > built-in. Each input is a raw user-facing token; blank/absent falls
/// through to the next tier. Extracted so the precedence is DRY and testable without
/// wiring an `AppState` + on-disk files.
pub(crate) fn resolve_sandbox_mode_core(
    env: Option<&str>,
    ws: Option<&str>,
    global: &str,
) -> crate::tool_safety::SandboxMode {
    use crate::tool_safety::SandboxMode;
    if let Some(m) = env.map(str::trim).filter(|s| !s.is_empty()) {
        return SandboxMode::parse(m);
    }
    if let Some(m) = ws.map(str::trim).filter(|s| !s.is_empty()) {
        return SandboxMode::parse(m);
    }
    SandboxMode::parse(global)
}

/// The resolved APP-LEVEL [`SandboxPolicy`] for this thread: the resolved mode bound to
/// the thread's project root (`project_root_for_thread`). Feeds `assess_tool_safety` and
/// the shadow log. This is the app-level policy ONLY — the OS kernel fence is resolved
/// separately and is unconditional (see the invariant above).
pub(crate) fn resolved_sandbox_policy(state: &AppState, thread_id: Option<&str>) -> SandboxPolicy {
    let root = project_root_for_thread(state, thread_id);
    resolved_sandbox_mode(state, thread_id).resolve(root.as_deref())
}

/// Pure precedence core for Phase-2 extra writable roots: a per-workspace override REPLACES
/// the global default (a project that declares its own list OWNS it — we do NOT merge, so a
/// project can deliberately shrink the global set), and `None` inherits the global default.
/// Returns the raw string list; existence/absoluteness filtering happens in
/// [`resolved_writable_roots`] so this stays IO-free + unit-testable.
pub(crate) fn resolve_extra_roots(ws: Option<&[String]>, global: &[String]) -> Vec<String> {
    match ws {
        Some(list) => list.to_vec(),
        None => global.to_vec(),
    }
}

/// The resolved writable roots for the exec fence on this thread: the project root FIRST
/// (ALWAYS writable — the fence never removes it) plus the home build-cache dirs
/// (`~/.npm`, `~/.cargo`, `~/.cache`, …) that npm/git/cargo need — i.e. exactly what
/// `run_in_project` fenced before Phase 2, via `workspace_write_roots` — and THEN the
/// per-project extra roots (per-workspace override if `Some`, else the global
/// `RuntimeSettings.writable_roots`). Extra entries are jailed to EXISTING ABSOLUTE
/// directories (relative / non-existent entries are dropped so a typo never breaks or
/// silently widens the fence) and de-duplicated. Feeds `build_sandbox_command`.
///
/// Reconciliation invariant: Phase 2 only ADDS the extra folders on top of the
/// behavior-preserving base — it can never remove the project root or disable the OS fence.
pub(crate) fn resolved_writable_roots(
    state: &AppState,
    thread_id: Option<&str>,
) -> Vec<std::path::PathBuf> {
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    if let Some(root) = project_root_for_thread(state, thread_id) {
        // Behavior-preserving base = project root + home build caches (the pre-Phase-2 fence).
        roots.extend(workspace_write_roots(
            &root,
            std::env::var("HOME").ok().as_deref(),
        ));
    }
    let ws = workspace_record_for_thread(state, thread_id).and_then(|w| w.writable_roots);
    let extra = resolve_extra_roots(ws.as_deref(), &load_runtime_settings().writable_roots);
    for entry in extra {
        let path = std::path::PathBuf::from(entry.trim());
        // Only absolute, currently-existing directories may widen the fence — anything else
        // is dropped (a typo neither fails the run nor silently opens an unintended path).
        if path.is_absolute() && path.is_dir() && !roots.contains(&path) {
            roots.push(path);
        }
    }
    roots
}

/// Pure precedence core for Phase-3 per-project skill confirmations: a per-workspace override
/// REPLACES the global default (`None` inherits it), then each token is parsed to a
/// [`crate::skills::SensitiveCategory`] via the forgiving `parse` (unknown tokens dropped so a
/// typo never widens/breaks the gate), de-duplicated. IO-free + unit-testable.
pub(crate) fn resolve_skill_confirmations_core(
    ws: Option<&[String]>,
    global: &[String],
) -> Vec<crate::skills::SensitiveCategory> {
    let tokens: &[String] = match ws {
        Some(list) => list,
        None => global,
    };
    let mut out: Vec<crate::skills::SensitiveCategory> = Vec::new();
    for token in tokens {
        if let Some(cat) = crate::skills::SensitiveCategory::parse(token)
            && !out.contains(&cat)
        {
            out.push(cat);
        }
    }
    out
}

/// The resolved set of sensitive categories that must ALWAYS force a confirmation in this
/// thread's workspace, regardless of the active skill (Phase 3). Precedence: per-workspace
/// override if `Some`, else the global `RuntimeSettings.skill_confirmations`, else empty (no
/// env axis for this policy). Seeds the turn's `active_sensitive` set so
/// `skill_policy_forces_confirm` fires on effectful actions even with NO sensitive skill loaded.
/// Fail-safe: it only ever ADDS confirmations.
pub(crate) fn resolved_skill_confirmations(
    state: &AppState,
    thread_id: Option<&str>,
) -> Vec<crate::skills::SensitiveCategory> {
    let ws = workspace_record_for_thread(state, thread_id).and_then(|w| w.skill_confirmations);
    resolve_skill_confirmations_core(ws.as_deref(), &load_runtime_settings().skill_confirmations)
}

/// The approval axis: env `HOMUN_APPROVAL_POLICY` > per-workspace override > persisted
/// global `RuntimeSettings.approval_policy` > default `on-request`. Behavior-preserving
/// when no workspace override is set: the non-autonomous case keeps asking on effectful
/// writes exactly as today (the wiring still forces `Never` for autonomous runs via
/// `effective_approval`).
pub(crate) fn resolved_approval_policy(
    state: &AppState,
    thread_id: Option<&str>,
) -> crate::tool_safety::AskForApproval {
    let env = std::env::var("HOMUN_APPROVAL_POLICY").ok();
    let ws = workspace_record_for_thread(state, thread_id).and_then(|w| w.approval_policy);
    resolve_approval_policy_core(
        env.as_deref(),
        ws.as_deref(),
        &load_runtime_settings().approval_policy,
    )
}

/// Pure precedence core for the approval axis (mirrors [`resolve_sandbox_mode_core`]):
/// env > per-workspace override > global default > built-in.
pub(crate) fn resolve_approval_policy_core(
    env: Option<&str>,
    ws: Option<&str>,
    global: &str,
) -> crate::tool_safety::AskForApproval {
    use crate::tool_safety::AskForApproval;
    if let Some(p) = env.map(str::trim).filter(|s| !s.is_empty()) {
        return AskForApproval::parse(p);
    }
    if let Some(p) = ws.map(str::trim).filter(|s| !s.is_empty()) {
        return AskForApproval::parse(p);
    }
    AskForApproval::parse(global)
}

/// Pure: the effective approval for a single turn. Autonomous runs NEVER prompt
/// (`Never`), whatever the resolved policy; otherwise the resolved policy applies.
/// Extracted so the autonomous-preservation is unit-testable without a ChatToolCtx.
/// With the default `on-request`: non-autonomous → `OnRequest` (unchanged), autonomous →
/// `Never` (unchanged) — identical to today.
pub(crate) fn effective_approval(
    autonomous: bool,
    resolved: crate::tool_safety::AskForApproval,
) -> crate::tool_safety::AskForApproval {
    if autonomous {
        crate::tool_safety::AskForApproval::Never
    } else {
        resolved
    }
}

/// ADR 0023 Step 5 (Fase 0.3): a skill that declares a sensitive domain
/// (`sensitive:` frontmatter) forces a confirmation on its EFFECTFUL actions —
/// even under a permissive approval policy (`never`/`on-request`) — without
/// trusting the model. Pure and policy-independent so it OR-composes with the
/// existing `assess_tool_safety` verdict at each effectful gate: reads are never
/// gated, and nothing fires unless a sensitive skill is active this turn.
pub(crate) fn skill_policy_forces_confirm(
    active_sensitive: &[crate::skills::SensitiveCategory],
    is_effectful: bool,
) -> bool {
    is_effectful && !active_sensitive.is_empty()
}

/// Phase 3 compose: the dedup UNION of the skill-armed sensitive categories and the
/// per-project ones. The project's categories force a confirm even with NO sensitive skill
/// active (they seed the turn's `active_sensitive`); a category present in both is not
/// duplicated. Pure so the compose is unit-testable and order-stable (skill first).
pub(crate) fn merged_sensitive(
    skill: &[crate::skills::SensitiveCategory],
    project: &[crate::skills::SensitiveCategory],
) -> Vec<crate::skills::SensitiveCategory> {
    let mut out = skill.to_vec();
    for cat in project {
        if !out.contains(cat) {
            out.push(*cat);
        }
    }
    out
}

/// Machine-keyable prefix a file-write tool returns (INSTEAD of writing any bytes) when
/// the resolved sandbox mode is `read-only`. A later UI task keys on this token to render
/// an escalation card ("approve → re-run the write"); for now it is the structured error
/// the model + UI see. Distinct token (not prose) so the UI detects the read-only block
/// deterministically. Reconciliation note: on this line the OS fence is unconditional;
/// `read-only` is purely the APP-LEVEL policy forbidding the in-process file tools from
/// mutating the workspace.
pub(crate) const READ_ONLY_BLOCKED_MARKER: &str = "SANDBOX_READ_ONLY_BLOCKED";

/// The structured, model-/UI-facing error a file-write tool returns under `read-only`.
/// Begins with [`READ_ONLY_BLOCKED_MARKER`]; NO bytes are written. Tells the model not to
/// claim success and how to unblock (switch the sandbox mode).
pub(crate) fn read_only_write_blocked_msg(target: &str) -> String {
    format!(
        "{READ_ONLY_BLOCKED_MARKER}: the write to '{target}' was blocked by the read-only \
sandbox — nothing was written. Do NOT claim it was written. Switch the sandbox mode to \
workspace-write in Settings to allow project writes."
    )
}

/// Pure card-builder for the read-only informational card (ADR 0023). Given a tool result,
/// returns the text-marker card
/// (`\n\n‹‹SANDBOX_READONLY››{"target":"…"}‹‹/SANDBOX_READONLY››\n`) when the result is a
/// read-only block, else `None`. Extracted from [`emit_read_only_block_if_needed`] so the
/// persistence-critical shaping (marker + target) is unit-testable without a full
/// `ChatToolCtx`. The target is parsed from the block message (`the write to '…'`); empty
/// when absent. WHY a text marker in the assistant output (not a `tool_result` event): the
/// event channel is NOT persisted into `event_parts_json`, so on commit/reload the card had
/// no data source and never rendered — converged onto the same proven channel as the bash
/// escalation card.
pub(crate) fn read_only_card_marker(result: &str) -> Option<String> {
    if !result.starts_with(READ_ONLY_BLOCKED_MARKER) {
        return None;
    }
    // Plain string parse (no regex dep in this crate) of `the write to '<target>'`.
    let target = result
        .split_once("the write to '")
        .and_then(|(_, rest)| rest.split_once('\''))
        .map(|(t, _)| t)
        .unwrap_or("");
    Some(format!(
        "\n\n{SANDBOX_READONLY_OPEN}{}{SANDBOX_READONLY_CLOSE}\n",
        serde_json::json!({ "target": target })
    ))
}

/// ADR 0023: surface a read-only-blocked write to the desktop UI as an informational card
/// appended to the assistant's PERSISTED output. The write tools return the block as a
/// plain-prefix string (`READ_ONLY_BLOCKED_MARKER`) fed back to the model; this appends the
/// `‹‹SANDBOX_READONLY››` text-marker card to `effects.append_output` (so it survives
/// commit/reload) and streams it as a `Delta`. No `request_confirm` / pending approval —
/// this is informational, not a confirm gate. No-op for any non-blocked result.
pub(crate) async fn emit_read_only_block_if_needed(
    ctx: &ChatToolCtx<'_>,
    effects: &mut local_first_engine::ToolEffects,
    result: &str,
) {
    if let Some(card) = read_only_card_marker(result) {
        effects.append_output.push(card.clone());
        let _ = emit_stream_event(ctx.tx, GenerateStreamEvent::Delta { text: card }).await;
    }
}

/// ADR 0023 sandbox axis: classify a tool call's filesystem footprint and log what the
/// resolved fence would decide — observability alongside the (unconditional) OS fence.
/// Observe-only; no dispatch behavior changes.
pub(crate) fn shadow_log_sandbox(
    state: &AppState,
    thread_id: Option<&str>,
    name: &str,
    args_raw: &str,
) {
    use crate::tool_safety::{
        ShadowVerdict, ToolFootprint, sandbox_shadow_verdict, tool_footprint,
    };
    let args: serde_json::Value =
        serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
    let footprint = tool_footprint(name, &args);
    // Only the write/exec footprints are interesting; skip the noisy Allow-always cases.
    if matches!(
        footprint,
        ToolFootprint::ReadOnly | ToolFootprint::NonFilesystem | ToolFootprint::Contained
    ) {
        return;
    }
    // The policy we shadow against is the SINGLE resolved app-level policy (env >
    // persisted Settings > default workspace-write), jailed to the thread's project root
    // — not a hardcoded root-based guess. So the log reflects the user's actual mode
    // (read-only → WouldFence, danger → Allow). `root` is still needed for the
    // under-writable-root check below.
    let root = project_root_for_thread(state, thread_id);
    let policy = resolved_sandbox_policy(state, thread_id);
    // For a Write footprint, resolve whether the target lands under the root.
    // `jail_in_root(&Path, &str) -> Result<PathBuf, String>` returns Ok iff the
    // relative path stays inside the root (rejects abs / `..` / symlink escapes).
    let is_under_writable_root = match (&footprint, &root) {
        (ToolFootprint::Write { path }, Some(r)) => jail_in_root(r, path.as_str()).is_ok(),
        _ => false,
    };
    let verdict = sandbox_shadow_verdict(&footprint, &policy, is_under_writable_root);
    // Log to the gateway log (captured to ~/.homun/logs/gateway.log by the P0 stdio
    // capture). `eprintln!` is the existing pattern. Log the classification + verdict
    // for every write/exec call so the shadow data is visible.
    let policy_label = match &policy {
        SandboxPolicy::WorkspaceWrite { .. } => "workspace-write",
        SandboxPolicy::ReadOnly => "read-only",
        SandboxPolicy::DangerFullAccess => "danger-full-access",
    };
    match verdict {
        ShadowVerdict::WouldFence { reason } => eprintln!(
            "SANDBOX-SHADOW tool={name} footprint={footprint:?} policy={policy_label} verdict=WOULD_FENCE reason=\"{reason}\""
        ),
        ShadowVerdict::Allow => eprintln!(
            "SANDBOX-SHADOW tool={name} footprint={footprint:?} policy={policy_label} verdict=allow"
        ),
    }
}

// ADR 0025 seam: the granular-browser-tools arm of `execute_chat_tool`, lifted VERBATIM into its
// own fn (behavior-preserving responsibility split). Isolates the browser branch — the ~850 lines +
// the mid-turn model-switch that hijack a chat turn — behind ONE boundary: the exact seam ADR 0025
// will swap for a recursive `browse(goal)` sub-agent (the manager keeps its model). Body kept at its
// original indentation (faithful move; the file isn't rustfmt-clean, so nothing is reformatted).
pub(crate) async fn execute_browser_tool(
    ctx: &mut BrowserToolCtx<'_>,
    // 5e.1: browser_session lives OUTSIDE ChatToolCtx (its Cell/RefCell made the ctx non-Sync,
    // blocking a shared-&ctx CapabilityExecutor). The loop owns it and threads it to this seam.
    browser_session: &mut Option<BrowserAutomationClient<BrowserSidecarSession>>,
    name: &str,
    args_raw: &str,
    call_id: &str,
) -> String {
    // Granular browser tools: driven one micro-action at a time inside
    // the isolated browse(goal) sub-agent (ADR 0025) — never by the
    // manager — against a per-turn session.
    let args: serde_json::Value =
        serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
    let mut spawned_fresh = false;
    // First browser tool this turn: mark used (raises round
    // budget), publish live activity, acquire the session
    // (reuse the thread's warm one, else spawn a chat sidecar).
    if !*ctx.browser_used {
        *ctx.browser_used = true;
        begin_browser_activity(ctx.prompt.to_string(), ctx.thread_id.map(|s| s.to_string()));
        // ADR 0025 slice 4b — the mid-turn driver model-switch was RETIRED here. It swapped the
        // whole turn to the weak browser model on the first browser tool (the root cause of the
        // context pollution ADR 0025 cures). `execute_browser_tool` is now called ONLY from the
        // isolated browse sub-loop, which is ALREADY seeded on the browser model/provider — so the
        // switch is redundant. The manager stays on its own model for the whole turn and delegates
        // browsing via `browse(goal)`. (The browser role is applied by the sub-loop's seam, not here.)
    }
    if browser_session.is_none() {
        let reused = match ctx.thread_id {
            Some(t) => {
                let st = ctx.state.clone();
                let t = t.to_string();
                tokio::task::spawn_blocking(move || take_thread_browser_session(&st, &t))
                    .await
                    .ok()
                    .flatten()
            }
            None => None,
        };
        // A reused session already has the "chat_0" tab open;
        // mark it opened so navigate reuses it (Navigate, not
        // Open). A fresh session has no tabs yet.
        if reused.is_some() && !ctx.opened_targets.iter().any(|t| t == "chat_0") {
            ctx.opened_targets.push("chat_0".to_string());
        }
        match reused {
            Some(existing) => *browser_session = Some(existing),
            None => {
                // Isolation policy: PREFER the sandbox browser. If its CDP isn't up, try to
                // START the contained computer and wait; only fall back to the on-host browser
                // after a real attempt + timeout (surfaced, never silent). This closes the
                // sandbox escape where a mis-detected "container down" launched a host Chromium
                // immediately. On success `contained_computer_cdp_endpoint()` now resolves, so
                // the sidecar spawned below attaches via connectOverCDP instead of launching.
                ensure_contained_browser_or_host_fallback(ctx.state, ctx.tx).await;
                for attempt in 0u8..2 {
                    let st = ctx.state.clone();
                    let spawned =
                        tokio::task::spawn_blocking(move || spawn_browser_sidecar_for_chat(&st))
                            .await;
                    match spawned {
                        Ok(Ok(session)) => {
                            *browser_session = Some(BrowserAutomationClient::new(session));
                            spawned_fresh = true;
                            break;
                        }
                        // First failure → recycle the container + retry.
                        _ if attempt == 0 => {
                            let _ = emit_stream_event(
                                    ctx.tx,
                                    GenerateStreamEvent::Delta {
                                        text: "‹‹ACT››🔧 Browser unreachable: restarting and retrying…‹‹/ACT››".to_string(),
                                    },
                                )
                                .await;
                            ensure_browser_cdp_healthy(ctx.state).await;
                        }
                        // Second failure → give up; reported below.
                        _ => {}
                    }
                }
            }
        }
    }
    let recovery_notice = if spawned_fresh {
        match (ctx.thread_id, browser_session.take()) {
            (Some(thread_id), Some(client)) => {
                let guard = browse_web_lock().lock().await;
                let (client_back, notice) = restore_browser_checkpoint(
                    ctx.state,
                    thread_id,
                    ctx.current_target.as_str(),
                    client,
                    BrowserCheckpointTelemetry {
                        journal: ctx.journal,
                        call_id,
                    },
                )
                .await;
                drop(guard);
                *browser_session = client_back;
                if notice.is_some()
                    && !ctx
                        .opened_targets
                        .iter()
                        .any(|target| target == ctx.current_target)
                {
                    ctx.opened_targets.push(ctx.current_target.clone());
                }
                notice
            }
            (_, restored) => {
                *browser_session = restored;
                None
            }
        }
    } else {
        None
    };
    // Mark this tool result as carrying a (potentially large)
    // snapshot so the pruner stubs older ones.
    ctx.browser_tool_call_ids.insert(call_id.to_string());
    // We hold the session for the duration of this branch; the
    // GLOBAL lock is acquired only around each single call.
    let outcome: Result<String, String> = if let Some(notice) = recovery_notice {
        // Recovery re-establishes an observation boundary but deliberately does not replay the
        // interrupted operation. Keep the loop's progress accounting honest so the model must
        // inspect the fresh snapshot and issue a new, explicit next action.
        *ctx.outcome_hint = Some(local_first_engine::contract::ToolOutcomeHint::NoProgress);
        Ok(notice)
    } else {
        match browser_session.take() {
            None => {
                push_browser_step("browser: session unavailable".to_string(), "error");
                Err(
                    "Browser unavailable: the contained-computer browser (a headless \
Chromium in a Docker container, driven over CDP — there is NO local browser binary) did not start. \
Usually transient, or the contained computer isn't running yet. Do NOT look for a local \
chromium/firefox install and do NOT conclude Chromium is missing or that it's a known bug. Retry, \
or tell the user to start the contained computer (Settings → Local computer)."
                        .to_string(),
                )
            }
            Some(client) => match name {
                "browser_navigate" => {
                    // Multi-tab: an explicit `target` switches the current
                    // tab; `new_tab` allocates a fresh chat_N id (so the
                    // logic below treats it as not-yet-opened → Open).
                    if let Some(t) = args.get("target").and_then(|v| v.as_str())
                        && !t.trim().is_empty()
                    {
                        *ctx.current_target = t.to_string();
                    }
                    if args
                        .get("new_tab")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                    {
                        *ctx.current_target = format!("chat_{}", ctx.opened_targets.len());
                    }
                    let url = args
                        .get("url")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    if url.trim().is_empty() {
                        *browser_session = Some(client);
                        Err("Missing URL for browser_navigate.".to_string())
                    } else {
                        let _ = emit_stream_event(
                            ctx.tx,
                            GenerateStreamEvent::Delta {
                                text: format!("‹‹ACT››🌐 Opening {url}‹‹/ACT››"),
                            },
                        )
                        .await;
                        let guard = browse_web_lock().lock().await;
                        // Open the current tab the first time, then Navigate.
                        let already_open = ctx
                            .opened_targets
                            .iter()
                            .any(|t| t.as_str() == ctx.current_target.as_str());
                        let (open_method, open_params) = if already_open {
                            (
                                BrowserMethod::Navigate,
                                serde_json::json!({
                                    "target_id": ctx.current_target.as_str(),
                                    "url": url,
                                }),
                            )
                        } else {
                            (
                                BrowserMethod::Open,
                                serde_json::json!({
                                    "url": url,
                                    "label": ctx.current_target.as_str(),
                                }),
                            )
                        };
                        let (client_back, nav_res) =
                            chat_browser_call_bounded(client, open_method, open_params).await;
                        let nav_err = nav_res.err();
                        // Navigate/Open return no snapshot → snapshot now. ACTING view (small,
                        // interactive-only): the model has just landed and needs the controls to act
                        // on, not the whole page — reading content is a later explicit browser_snapshot.
                        let mut client_now = client_back;
                        let snap_result = if nav_err.is_none() {
                            if let Some(c) = client_now.take() {
                                let (c2, snap) = chat_browser_call_checkpointed(
                                    ctx.state,
                                    ctx.thread_id,
                                    ctx.current_target.as_str(),
                                    c,
                                    BrowserMethod::Snapshot,
                                    browser_chat_act_snapshot_params(ctx.current_target.as_str()),
                                    BrowserCheckpointTelemetry {
                                        journal: ctx.journal,
                                        call_id,
                                    },
                                )
                                .await;
                                client_now = c2;
                                snap
                            } else {
                                Err("session lost after navigation".to_string())
                            }
                        } else {
                            Err(nav_err.clone().unwrap_or_default())
                        };
                        drop(guard);
                        *browser_session = client_now;
                        // Mark this tab opened once the Open/Navigate succeeds.
                        if nav_err.is_none()
                            && !ctx
                                .opened_targets
                                .iter()
                                .any(|t| t.as_str() == ctx.current_target.as_str())
                        {
                            ctx.opened_targets.push(ctx.current_target.clone());
                        }
                        match (nav_err, snap_result) {
                            (Some(error), _) => {
                                if verbose_debug() {
                                    eprintln!("[browser] navigate {url} FAILED: {error}");
                                }
                                push_browser_step(format!("navigate {url}"), "error");
                                // CDP wedge (connectOverCDP timeout despite an
                                // HTTP-OK /json/version): recycle the contained
                                // computer once per window and DROP the session so
                                // the next call respawns against fresh CDP. motore
                                // #1's pre-spawn `browser_cdp_ok` can't see this
                                // ws-level wedge, so heal it on the failure (same
                                // self-heal the drive's shared path already has).
                                if browser_navigation_should_recycle_after_error(&error) {
                                    let _ = emit_stream_event(
                                        ctx.tx,
                                        GenerateStreamEvent::Delta {
                                            text: "‹‹ACT››🔧 Browser bloccato: riavvio il computer…‹‹/ACT››".to_string(),
                                        },
                                    )
                                    .await;
                                    let healed = force_recycle_contained_computer(ctx.state).await;
                                    *browser_session = None;
                                    ctx.opened_targets.clear();
                                    if healed {
                                        Err("The browser was wedged; I recycled the contained computer. Retry the SAME navigation now.".to_string())
                                    } else {
                                        Err("The browser is unavailable (the contained computer did not recover). Tell the user to check Settings → Local computer.".to_string())
                                    }
                                } else {
                                    let fails = {
                                        let entry =
                                            ctx.nav_failures.entry(url.to_string()).or_insert(0);
                                        *entry += 1;
                                        *entry
                                    };
                                    Err(format!(
                                        "Navigation failed: {error}{}",
                                        browser_navigate_failure_hint(&url, fails)
                                    ))
                                }
                            }
                            (None, Ok(value)) => {
                                let snap = browser_snapshot_text(&value);
                                if !snap.is_empty() {
                                    *ctx.last_snapshot_semantic_fingerprint =
                                        browser_snapshot_semantic_fingerprint(&snap);
                                    *ctx.last_snapshot = snap.clone();
                                    browser_set_target_floor(
                                        ctx.payment_floor_refs,
                                        ctx.current_target.as_str(),
                                        browser_floor_refs(&value),
                                    );
                                    // A navigate is an explicit fresh observation of THIS target's
                                    // page: update the best-effort focus flag AND clear the robust
                                    // last-acted-floored flag (the page just changed under us).
                                    browser_set_target_focus(
                                        ctx.payment_context_by_target,
                                        ctx.current_target.as_str(),
                                        browser_focus_payment_context(&value),
                                    );
                                    browser_clear_target_acted_floored(
                                        ctx.payment_context_by_target,
                                        ctx.current_target.as_str(),
                                    );
                                }
                                push_browser_step(format!("navigate {url}"), "done");
                                let metrics = browser_observation_metrics(
                                    &value,
                                    vec!["navigate".to_string()],
                                    "completed",
                                );
                                ctx.journal.record(browser_protocol_journal_event(
                                    call_id,
                                    "navigation_observation",
                                    &metrics,
                                ));
                                push_browser_step(
                                    browser_protocol_event_summary(
                                        call_id,
                                        "navigation_observation",
                                        metrics,
                                    ),
                                    "done",
                                );
                                let page_url = value
                                    .get("url")
                                    .and_then(|u| u.as_str())
                                    .unwrap_or(url.as_str());
                                Ok(format!("Page opened ({page_url}). Snapshot:\n{snap}"))
                            }
                            (None, Err(error)) => {
                                push_browser_step(format!("navigate {url}"), "error");
                                browser_cached_snapshot_fallback(
                                    "Page opened but fresh snapshot",
                                    &error,
                                    ctx.last_snapshot,
                                )
                                .ok_or_else(|| format!("Page opened but snapshot failed: {error}"))
                            }
                        }
                    }
                }
                "browser_snapshot" => {
                    if let Some(t) = args.get("target").and_then(|v| v.as_str())
                        && !t.trim().is_empty()
                    {
                        *ctx.current_target = t.to_string();
                    }
                    // P1 fix: default to 'interact' mode (9k chars) instead of 'extract' (40k chars).
                    // The sub-agent typically needs to see interactive elements (buttons, suggestions)
                    // to click, not the full page content. Extract mode can still be requested
                    // explicitly for data collection.
                    let mode = args
                        .get("mode")
                        .and_then(|v| v.as_str())
                        .unwrap_or("interact");
                    let snapshot_params = if mode == "extract" {
                        browser_chat_snapshot_params(ctx.current_target.as_str())
                    } else {
                        browser_chat_act_snapshot_params(ctx.current_target.as_str())
                    };
                    let _ = emit_stream_event(
                        ctx.tx,
                        GenerateStreamEvent::Delta {
                            text: "‹‹ACT››👁️ Re-reading the page‹‹/ACT››".to_string(),
                        },
                    )
                    .await;
                    let guard = browse_web_lock().lock().await;
                    let (client_back, snap) = chat_browser_call_checkpointed(
                        ctx.state,
                        ctx.thread_id,
                        ctx.current_target.as_str(),
                        client,
                        BrowserMethod::Snapshot,
                        snapshot_params,
                        BrowserCheckpointTelemetry {
                            journal: ctx.journal,
                            call_id,
                        },
                    )
                    .await;
                    drop(guard);
                    *browser_session = client_back;
                    match snap {
                        Ok(value) => {
                            let snap = browser_snapshot_text(&value);
                            if !snap.is_empty() {
                                *ctx.last_snapshot_semantic_fingerprint =
                                    browser_snapshot_semantic_fingerprint(&snap);
                                *ctx.last_snapshot = snap.clone();
                                browser_set_target_floor(
                                    ctx.payment_floor_refs,
                                    ctx.current_target.as_str(),
                                    browser_floor_refs(&value),
                                );
                                // Explicit re-observation of THIS target: refresh the focus flag
                                // and clear the robust flag (a model-requested snapshot is the
                                // canonical "re-orient on this page" moment).
                                browser_set_target_focus(
                                    ctx.payment_context_by_target,
                                    ctx.current_target.as_str(),
                                    browser_focus_payment_context(&value),
                                );
                                browser_clear_target_acted_floored(
                                    ctx.payment_context_by_target,
                                    ctx.current_target.as_str(),
                                );
                            }
                            push_browser_step("snapshot".to_string(), "done");
                            let metrics = browser_observation_metrics(
                                &value,
                                vec!["snapshot".to_string()],
                                "completed",
                            );
                            ctx.journal.record(browser_protocol_journal_event(
                                call_id,
                                "observation",
                                &metrics,
                            ));
                            push_browser_step(
                                browser_protocol_event_summary(call_id, "observation", metrics),
                                "done",
                            );
                            Ok(format!("Page snapshot:\n{snap}"))
                        }
                        Err(error) => {
                            push_browser_step("snapshot".to_string(), "error");
                            browser_cached_snapshot_fallback("Snapshot", &error, ctx.last_snapshot)
                                .ok_or_else(|| format!("Snapshot failed: {error}"))
                        }
                    }
                }
                "browser_rehydrate" => {
                    if ctx.read_only {
                        *browser_session = Some(client);
                        Err("Draft rehydration is an external write and is unavailable in a read-only objective.".into())
                    } else {
                        if let Some(target) = args.get("target").and_then(Value::as_str)
                            && !target.trim().is_empty()
                        {
                            *ctx.current_target = target.to_string();
                        }
                        let draft_ref = args
                            .get("draft_ref")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let generation = args
                            .get("generation")
                            .and_then(Value::as_u64)
                            .unwrap_or(u64::MAX);
                        let workspace_id = ctx.thread_id.and_then(|thread_id| {
                            browser_thread_workspace_id(ctx.state, thread_id)
                        });
                        let checkpoint = ctx.thread_id.and_then(|thread_id| {
                            workspace_id.as_deref().and_then(|workspace_id| {
                                ctx.state.task_store.lock().ok().and_then(|store| {
                                    store
                                        .load_active_browser_checkpoint(
                                            gateway_user_id().as_str(),
                                            workspace_id,
                                            thread_id,
                                            ctx.current_target.as_str(),
                                        )
                                        .ok()
                                        .flatten()
                                })
                            })
                        });
                        let payload = checkpoint.as_ref().and_then(|checkpoint| {
                            if checkpoint.checkpoint_id != draft_ref {
                                return None;
                            }
                            checkpoint
                                .draft_secret_ref
                                .as_deref()
                                .and_then(|reference| {
                                    ctx.state
                                        .browser_checkpoint_secret_store
                                        .get(
                                            reference,
                                            gateway_user_id().as_str(),
                                            workspace_id.as_deref()?,
                                        )
                                        .ok()
                                        .flatten()
                                })
                        });
                        let fields = payload.as_ref().and_then(|payload| {
                            checkpoint.as_ref().and_then(|checkpoint| {
                                if payload.objective_revision != checkpoint.objective_revision
                                    || payload.target_id != checkpoint.target_id
                                    || payload.origin != checkpoint.origin
                                {
                                    None
                                } else {
                                    build_browser_rehydrate_fields(payload, &args).ok()
                                }
                            })
                        });
                        let Some(fields) = fields else {
                            *browser_session = Some(client);
                            *ctx.outcome_hint =
                                Some(local_first_engine::contract::ToolOutcomeHint::NoProgress);
                            return "Draft reference, scope, or field mapping is invalid. Nothing was written.".into();
                        };
                        let effect_lease = match begin_browser_effect(
                            ctx,
                            "browser_rehydrate",
                            call_id,
                            serde_json::json!({
                                "target_id": ctx.current_target.as_str(),
                                "generation": generation,
                                "fields": fields.clone(),
                            }),
                        ) {
                            Ok(crate::effect_host::EffectDecision::Execute(lease)) => lease,
                            Ok(crate::effect_host::EffectDecision::Replay(receipt)) => {
                                *browser_session = Some(client);
                                return replayed_browser_effect_text(receipt);
                            }
                            Ok(crate::effect_host::EffectDecision::Resolve(receipt)) => {
                                *ctx.suspend_effect_receipt = Some(receipt.receipt_ref.clone());
                                *browser_session = Some(client);
                                *ctx.outcome_hint =
                                    Some(local_first_engine::contract::ToolOutcomeHint::NoProgress);
                                return uncertain_browser_effect_text(&receipt);
                            }
                            Err(error) => {
                                *browser_session = Some(client);
                                *ctx.outcome_hint =
                                    Some(local_first_engine::contract::ToolOutcomeHint::NoProgress);
                                return error;
                            }
                        };
                        let guard = browse_web_lock().lock().await;
                        let (client_back, rehydrated) = chat_browser_call_bounded(
                            client,
                            BrowserMethod::Rehydrate,
                            serde_json::json!({
                                "target_id": ctx.current_target.as_str(),
                                "generation": generation,
                                "fields": fields,
                            }),
                        )
                        .await;
                        let mut client_now = client_back;
                        let snapshot = if rehydrated.is_ok() {
                            if let Some(client) = client_now.take() {
                                let (back, snapshot) = chat_browser_call_checkpointed(
                                    ctx.state,
                                    ctx.thread_id,
                                    ctx.current_target.as_str(),
                                    client,
                                    BrowserMethod::Snapshot,
                                    browser_chat_act_snapshot_params(ctx.current_target.as_str()),
                                    BrowserCheckpointTelemetry {
                                        journal: ctx.journal,
                                        call_id,
                                    },
                                )
                                .await;
                                client_now = back;
                                snapshot
                            } else {
                                Err("session lost after draft rehydration".into())
                            }
                        } else {
                            Err(rehydrated.as_ref().err().cloned().unwrap_or_default())
                        };
                        drop(guard);
                        *browser_session = client_now;
                        match (rehydrated, snapshot) {
                            (Ok(result), Ok(snapshot)) => {
                                let count = result
                                    .get("rehydrated")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(0);
                                let skipped =
                                    result.get("skipped").and_then(Value::as_u64).unwrap_or(0);
                                ctx.journal.record(browser_protocol_journal_event(
                                call_id,
                                "browser_draft_rehydrated",
                                &serde_json::json!({
                                    "generation": result.get("generation").and_then(Value::as_u64),
                                    "restored_count": count,
                                    "skipped_count": skipped,
                                    "reason": "explicit_selected_fields",
                                }),
                            ));
                                let output = format!(
                                    "Draft rehydration completed: {count} filled, {skipped} skipped. No form was submitted and no other action was replayed.\nFresh snapshot:\n{}",
                                    browser_snapshot_text(&snapshot)
                                );
                                if let Err(error) = complete_browser_effect(
                                    ctx,
                                    &effect_lease,
                                    serde_json::Value::String(format!(
                                        "Previously completed draft rehydration was not repeated: {count} filled, {skipped} skipped. Inspect the page with browser_snapshot."
                                    )),
                                    serde_json::json!({
                                        "rehydrated": count,
                                        "skipped": skipped,
                                        "snapshot": "completed",
                                    }),
                                ) {
                                    Err(format!(
                                        "Draft rehydration was applied, but its receipt could not be completed: {error}. Do not repeat it."
                                    ))
                                } else {
                                    Ok(output)
                                }
                            }
                            (Ok(result), Err(snapshot_error)) => {
                                let count = result
                                    .get("rehydrated")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(0);
                                let skipped =
                                    result.get("skipped").and_then(Value::as_u64).unwrap_or(0);
                                let output = format!(
                                    "Draft rehydration completed: {count} filled, {skipped} skipped, but the fresh snapshot failed: {snapshot_error}. Do not repeat the rehydration; inspect the page with browser_snapshot."
                                );
                                if let Err(error) = complete_browser_effect(
                                    ctx,
                                    &effect_lease,
                                    serde_json::Value::String(format!(
                                        "Previously completed draft rehydration was not repeated: {count} filled, {skipped} skipped. Inspect the page with browser_snapshot."
                                    )),
                                    serde_json::json!({
                                        "rehydrated": count,
                                        "skipped": skipped,
                                        "snapshot": "failed",
                                    }),
                                ) {
                                    Err(format!(
                                        "Draft rehydration was applied, but its receipt could not be completed: {error}. Do not repeat it."
                                    ))
                                } else {
                                    Ok(output)
                                }
                            }
                            (Err(error), _) => {
                                *ctx.outcome_hint =
                                    Some(local_first_engine::contract::ToolOutcomeHint::NoProgress);
                                match mark_browser_effect_uncertain(ctx, &effect_lease) {
                                    Ok(receipt) => Err(format!(
                                        "{} Sidecar error: {}",
                                        uncertain_browser_effect_text(&receipt),
                                        redact_sensitive_text(&error)
                                    )),
                                    Err(receipt_error) => Err(format!(
                                        "Browser draft outcome is unknown and its receipt could not be marked uncertain: {receipt_error}. Do not repeat it. Sidecar error: {}",
                                        redact_sensitive_text(&error)
                                    )),
                                }
                            }
                        }
                    }
                }
                "browser_act" => {
                    // Build the action the sidecar runs (and the safety gate
                    // inspects), coercing a common model mistake that otherwise
                    // dead-ends in a retry loop: an element ref (e83) passed as
                    // `target` — which is a TAB id, so the sidecar errors "tab
                    // not found: e83". Re-route a ref-shaped target into `ref`
                    // (when none was given) instead of switching to a missing tab.
                    let mut action = args.clone();
                    let target_arg = args
                        .get("target")
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                    let has_ref = action
                        .get("ref")
                        .and_then(|v| v.as_str())
                        .is_some_and(|r| !r.trim().is_empty());
                    let target_is_ref = target_arg.as_deref().is_some_and(|t| {
                        t.len() >= 2
                            && t.starts_with('e')
                            && t[1..].chars().all(|c| c.is_ascii_digit())
                    });
                    if let Some(obj) = action.as_object_mut() {
                        if target_is_ref && !has_ref {
                            if let Some(t) = target_arg.clone() {
                                obj.insert("ref".to_string(), serde_json::Value::String(t));
                            }
                            obj.remove("target");
                        } else if let Some(t) = target_arg.as_deref()
                            && !t.trim().is_empty()
                        {
                            *ctx.current_target = t.to_string();
                        }
                        obj.insert(
                            "target_id".to_string(),
                            serde_json::Value::String(ctx.current_target.clone()),
                        );
                    }
                    // Single-action payment context for the CURRENT target: the best-effort
                    // focus flag OR'd with the robust last-acted-floored flag (IMPORTANT C —
                    // a cross-origin PSP OOPIF fails the focus check whenever the app isn't
                    // OS-frontmost, but `last_acted_floored` is frame-aware for free via the
                    // per-ref floor). No "prior nested item" concept outside a bundle.
                    let focus_ctx = browser_payment_context_for(
                        ctx.payment_context_by_target,
                        ctx.current_target.as_str(),
                    );
                    // Build1 Fix 3: resolve THIS target's floor set once, up front — every
                    // read below in this arm is against the PRE-act observation of the SAME
                    // target the action is about to run on, so a single owned snapshot is
                    // correct (and sidesteps holding an immutable borrow of the map across
                    // the later mutable `browser_set_target_floor` post-act refresh).
                    let current_floor_refs = browser_floor_refs_for_target(
                        ctx.payment_floor_refs,
                        ctx.current_target.as_str(),
                    );
                    if let Some(error) = normalize_browser_action_bundle(
                        &mut action,
                        ctx.current_target.as_str(),
                        &current_floor_refs,
                        focus_ctx,
                    ) {
                        *browser_session = Some(client);
                        // Log WHY (same gap as the act-error line): "bundle blocked" alone cannot
                        // distinguish a payment gate from a schema-illegal item or a missing
                        // action_class, and the browse sub-turn keeps no other record.
                        push_browser_step(
                            format!("browser action bundle blocked: {}", clip_chars(&error, 200)),
                            "error",
                        );
                        *ctx.outcome_hint =
                            Some(local_first_engine::contract::ToolOutcomeHint::NoProgress);
                        Err(error)
                    } else {
                        // A non-schema action (clickCoords, any other unrecognized kind, or a
                        // selector-bearing action) must be rejected before ANY payment-approval
                        // side effect: none of it is ref-based (the ref floor can't cover a
                        // selector or an unrecognized kind) and none of it is Enter/Return (the
                        // page floor above doesn't apply either), so no machine signal can ever
                        // classify it — fail closed regardless of declared action_class. Checked
                        // here, FIRST, before `apply_payment_approval_secret_for_action` and
                        // before `should_claim_payment_approval`/`claim_payment_approval_for_action`
                        // below, because a hallucinated non-schema action can still carry a
                        // declared action_class:"payment_commit" plus a valid
                        // payment_approval_id — which resolves to a genuine PaymentCommit
                        // on the declared class alone — so checking this only as part of
                        // the gate (after claiming) would let it burn a one-shot
                        // Payment Approval Card grant for an action that gets rejected
                        // anyway. Defense-in-depth: verified no production path emits these
                        // and the schema doesn't expose them, but a model could still
                        // hallucinate one.
                        let blocked_before_claim =
                            single_action_rejects_unsupported_execution_before_payment_claim(
                                &action,
                            );
                        let mut preflight_error = if blocked_before_claim.is_some() {
                            None
                        } else {
                            authorize_browser_action_effect(
                                ctx,
                                call_id,
                                action.clone(),
                                &current_floor_refs,
                                focus_ctx,
                            )
                            .err()
                        };
                        // SAFETY GATE: arbitrary page script remains forbidden and
                        // the final action that transfers money requires a matching
                        // Payment Approval Card. Search, login and booking actions
                        // are ordinary user-directed browser interactions; objective
                        // read-only mode must not be reused as an origin-trust gate.
                        // The decision is on the EFFECTIVE action class (declared ⊔
                        // machine floor), never on control label text.
                        //
                        // Claiming (consuming) the one-shot grant is gated on
                        // `should_claim_payment_approval`, which is intentionally
                        // NARROWER than `action_is_payment_commit`: the latter also
                        // treats a class error (missing/conflicting action_class) as
                        // "payment" so the gate below re-rejects it fail-closed —
                        // right for the gate, wrong for claiming. Claiming on a class
                        // error would burn the grant on an under-declared action and
                        // then still reject it for the class error, forcing full
                        // re-approval on the corrected retry even though nothing
                        // unauthorized executed. Claim only when the effective class
                        // GENUINELY resolves to payment; on a class error, leave the
                        // grant unconsumed so the re-declared retry can use it.
                        let approved_payment_id = if blocked_before_claim.is_some() {
                            None
                        } else if browser_safety::action_is_payment_commit(
                            &action,
                            &current_floor_refs,
                            focus_ctx,
                        ) {
                            match validate_payment_approval_for_action(
                                ctx.state,
                                &action,
                                &current_floor_refs,
                                focus_ctx,
                                ctx.thread_id,
                            ) {
                                Ok(id) => Some(id),
                                Err(error) if action.get("payment_approval_id").is_some() => {
                                    preflight_error = Some(error);
                                    None
                                }
                                Err(_) => None,
                            }
                        } else {
                            None
                        };
                        let blocked = blocked_before_claim.map(str::to_string).or_else(|| {
                            browser_safety::evaluate_browser_action(
                                &action,
                                &current_floor_refs,
                                focus_ctx,
                                approved_payment_id.as_deref(),
                            )
                        });
                        if let Some(error) = preflight_error {
                            *browser_session = Some(client);
                            *ctx.outcome_hint =
                                Some(local_first_engine::contract::ToolOutcomeHint::NoProgress);
                            Err(error)
                        } else if let Some(reason) = blocked {
                            eprintln!("browser-gate: BLOCKED ({reason})");
                            *browser_session = Some(client);
                            *ctx.outcome_hint =
                                Some(local_first_engine::contract::ToolOutcomeHint::NoProgress);
                            // Log the REASON, not just the kind (the bundle path already does): without
                            // it a gate refusal is indistinguishable from a stale ref in a post-mortem.
                            push_browser_step(
                                format!(
                                    "action blocked: {} — {}",
                                    args.get("kind").and_then(|k| k.as_str()).unwrap_or("?"),
                                    clip_chars(&reason, 200)
                                ),
                                "error",
                            );
                            // Branch the guidance on WHAT was wrong. The old single message told the
                            // model "user confirmation needed … propose to the user and wait — do NOT
                            // retry" for EVERY refusal, including a plain missing argument. In the browse
                            // sub-turn there is no user to propose to (its stream is drained) and the only
                            // correct recovery for a missing//conflicting `action_class` IS to re-send the
                            // same action with the field — so the message forbade the fix and pushed the
                            // model to wander to another site instead. Argument-shaped errors now say
                            // "fix and retry the same ref"; only a real payment/hazard refusal keeps the
                            // stop-and-ask wording, and for that one the sub-agent is told to report
                            // `blocked` (it cannot obtain a Payment Approval Card itself).
                            let model_fixable = reason.contains("BROWSER_ACTION_CLASS_MISSING")
                                || reason.contains("BROWSER_ACTION_CLASS_CONFLICT")
                                || reason.contains("BROWSER_UNSUPPORTED_COMMITTING_ACTION");
                            if model_fixable {
                                Err(format!(
                                    "🚫 action rejected, nothing was executed: {reason}.{} \
Fix THIS action and re-send it on the SAME ref — for example \
{{\"kind\":\"click\",\"ref\":\"e42\",\"action_class\":\"ordinary\"}}. \
Do NOT navigate to another site because of this error.",
                                    browser_act_error_hint(&reason)
                                ))
                            } else {
                                Err(format!(
                                    "🚫 action blocked, user confirmation needed: {reason}.{} \
I did nothing. You cannot approve this yourself: stop here and report what is blocked \
(browser_done with the evidence you already have) — do NOT retry the same action and do NOT \
navigate elsewhere to work around it.",
                                    browser_act_error_hint(&reason)
                                ))
                            }
                        } else {
                            let effect_risk =
                                browser_action_effect_risk(&action, &current_floor_refs, focus_ctx);
                            let effect_lease = match begin_browser_action_effect(
                                ctx,
                                call_id,
                                action.clone(),
                                &current_floor_refs,
                                focus_ctx,
                            ) {
                                Ok(crate::effect_host::EffectDecision::Execute(lease)) => lease,
                                Ok(crate::effect_host::EffectDecision::Replay(receipt)) => {
                                    *browser_session = Some(client);
                                    return replayed_browser_effect_text(receipt);
                                }
                                Ok(crate::effect_host::EffectDecision::Resolve(receipt)) => {
                                    *ctx.suspend_effect_receipt = Some(receipt.receipt_ref.clone());
                                    *browser_session = Some(client);
                                    *ctx.outcome_hint = Some(
                                        local_first_engine::contract::ToolOutcomeHint::NoProgress,
                                    );
                                    return uncertain_browser_effect_text(&receipt);
                                }
                                Err(error) => {
                                    *browser_session = Some(client);
                                    *ctx.outcome_hint = Some(
                                        local_first_engine::contract::ToolOutcomeHint::NoProgress,
                                    );
                                    return error;
                                }
                            };
                            let vault_secret_used = match apply_payment_approval_secret_for_action(
                                ctx.state,
                                &mut action,
                            ) {
                                Ok(used) => used,
                                Err(error) => {
                                    let output = format!(
                                        "Payment vault secret unavailable: {error}. Ask the user to approve the Payment Approval Card again."
                                    );
                                    let _ = complete_browser_effect(
                                        ctx,
                                        &effect_lease,
                                        serde_json::Value::String(output.clone()),
                                        serde_json::json!({"applied": false}),
                                    );
                                    *browser_session = Some(client);
                                    *ctx.outcome_hint = Some(
                                        local_first_engine::contract::ToolOutcomeHint::NoProgress,
                                    );
                                    return output;
                                }
                            };
                            if should_claim_payment_approval(
                                &action,
                                &current_floor_refs,
                                focus_ctx,
                            ) && let Err(error) = claim_payment_approval_for_action(
                                ctx.state,
                                &action,
                                &current_floor_refs,
                                focus_ctx,
                                ctx.thread_id,
                            ) {
                                let _ = complete_browser_effect(
                                    ctx,
                                    &effect_lease,
                                    serde_json::Value::String(error.clone()),
                                    serde_json::json!({"applied": false}),
                                );
                                *browser_session = Some(client);
                                *ctx.outcome_hint =
                                    Some(local_first_engine::contract::ToolOutcomeHint::NoProgress);
                                return error;
                            }
                            let kind = args
                                .get("kind")
                                .and_then(|k| k.as_str())
                                .unwrap_or("action")
                                .to_string();
                            let _ = emit_stream_event(
                                ctx.tx,
                                GenerateStreamEvent::Delta {
                                    text: format!("‹‹ACT››✋ {kind} on the page‹‹/ACT››"),
                                },
                            )
                            .await;
                            let action_kinds = browser_action_kinds(&action);
                            // Captured BEFORE `action` is moved into the sidecar call below, against
                            // the PRE-act `payment_floor_refs` — the robust IMPORTANT-C signal (design
                            // 1.2): acting on a ref the floor already marked is proof positive of a
                            // payment interaction regardless of OS window focus.
                            let targeted_floored_ref =
                                browser_action_targeted_a_floored_ref(&action, &current_floor_refs);
                            let guard = browse_web_lock().lock().await;
                            let (client_back, act_res) = chat_browser_call_checkpointed(
                                ctx.state,
                                ctx.thread_id,
                                ctx.current_target.as_str(),
                                client,
                                BrowserMethod::Act,
                                action,
                                BrowserCheckpointTelemetry {
                                    journal: ctx.journal,
                                    call_id,
                                },
                            )
                            .await;
                            drop(guard);
                            *browser_session = client_back;
                            match act_res {
                                Ok(value) => {
                                    let snap = browser_snapshot_text(&value);
                                    // No-progress detection: if the action left
                                    // the page semantically identical, nudge the model to try a
                                    // different element/approach instead of treating SPA ref churn as
                                    // real progress.
                                    let snap_semantic_fingerprint =
                                        browser_snapshot_semantic_fingerprint(&snap);
                                    let no_change = !snap.is_empty()
                                        && !ctx.last_snapshot_semantic_fingerprint.is_empty()
                                        && snap_semantic_fingerprint
                                            == *ctx.last_snapshot_semantic_fingerprint;
                                    if targeted_floored_ref {
                                        browser_mark_target_acted_floored(
                                            ctx.payment_context_by_target,
                                            ctx.current_target.as_str(),
                                        );
                                    }
                                    if !snap.is_empty() {
                                        *ctx.last_snapshot_semantic_fingerprint =
                                            snap_semantic_fingerprint;
                                        *ctx.last_snapshot = snap.clone();
                                        browser_set_target_floor(
                                            ctx.payment_floor_refs,
                                            ctx.current_target.as_str(),
                                            browser_floor_refs(&value),
                                        );
                                        browser_set_target_focus(
                                            ctx.payment_context_by_target,
                                            ctx.current_target.as_str(),
                                            browser_focus_payment_context(&value),
                                        );
                                        // Deliberately NOT clearing last_acted_floored here: this is the
                                        // act's OWN post-action refresh, not an independent
                                        // re-observation. Clearing here would erase the flag just set
                                        // above for THIS SAME action, breaking "type CVV into a floored
                                        // ref, then press Enter" across the next call. See
                                        // `browser_clear_target_acted_floored`'s doc comment.
                                    }
                                    push_browser_step(kind.to_string(), "done");
                                    let boundary = if action_kinds.len() > 1 {
                                        "action_bundle"
                                    } else {
                                        "browser_act"
                                    };
                                    let metrics = browser_observation_metrics(
                                        &value,
                                        action_kinds.clone(),
                                        "completed",
                                    );
                                    ctx.journal.record(browser_protocol_journal_event(
                                        call_id, boundary, &metrics,
                                    ));
                                    push_browser_step(
                                        browser_protocol_event_summary(call_id, boundary, metrics),
                                        "done",
                                    );
                                    let mut out = if snap.is_empty() {
                                        "Action performed.".to_string()
                                    } else {
                                        format!("Action performed. Updated snapshot:\n{snap}")
                                    };
                                    if no_change {
                                        out.push_str(
                                            "\n[note: the page did NOT change from before — \
don't repeat the same action/ref. On a results list, labeled CTAs next to a solution \
(e.g. \"Vedi i dettagli…\") are often screen-reader duplicates: click instead the \
unnamed button/card or price control that CONTAINS that solution's times/train number. \
\"Continua\"/\"Avanti\" usually appears only after the solution is opened and a fare is \
chosen. Otherwise try a different element, scroll, or wait (kind=wait).]",
                                        );
                                    }
                                    if let Some(committed) = value.get("committedOption") {
                                        // P1 fix: make committed selection message more explicit
                                        out.push_str(&format!(
                                            "\n[AUTOCOMPLETE SELECTION COMMITTED: {committed} — field is filled, proceed to next field or action]"
                                        ));
                                    }
                                    if let Some(sugg) = value.get("suggestions") {
                                        // P1 fix: make suggestion message more explicit and directive.
                                        // The snapshot above (in interact mode) shows clickable option elements
                                        // with their refs (e.g. [ref=e123] option "Rome Termini"). List the
                                        // visible suggestion texts so the model can match them to refs in the snapshot.
                                        let suggestions_hint = sugg
                                            .as_array()
                                            .map(|items| {
                                                let texts: Vec<&str> = items
                                                    .iter()
                                                    .filter_map(|item| {
                                                        // Suggestions are text strings from the sidecar
                                                        item.as_str()
                                                    })
                                                    .take(5) // Limit to first 5 suggestions
                                                    .collect();
                                                if texts.is_empty() {
                                                    String::new()
                                                } else {
                                                    format!(
                                                        " Visible suggestions: {}",
                                                        texts.join(", ")
                                                    )
                                                }
                                            })
                                            .unwrap_or_default();
                                        out.push_str(&format!(
                                            "\n[AUTOCOMPLETE SUGGESTIONS VISIBLE — click one NOW using browser_act kind=click with the ref of a matching option element in the snapshot above.{suggestions_hint} Example: {{\"kind\":\"click\",\"ref\":\"e123\",\"action_class\":\"ordinary\"}}]"
                                        ));
                                    }
                                    // Guardrail (advisory, Layer C.3): if the model just
                                    // typed/filled a date that is in the PAST, nudge it to
                                    // re-resolve via resolve_datetime instead of submitting.
                                    // Advisory (not a hard block) because some past dates are
                                    // legitimate (birthdays, historical lookups).
                                    if matches!(
                                        args.get("kind").and_then(|k| k.as_str()),
                                        Some("type") | Some("fill")
                                    ) && let Some(typed) =
                                        args.get("text").and_then(|t| t.as_str())
                                        && let Some(hint) = past_date_hint(typed)
                                    {
                                        out.push_str(&hint);
                                    }
                                    // D2: machine progress classification for the guarded loop's stall
                                    // budget — from the sidecar's signals (committed suggestion, whether
                                    // a suggestion list appeared, page change), never re-derived from the
                                    // prose in `out` above.
                                    let committed_option = value
                                        .get("committedOption")
                                        .and_then(|v| v.as_str())
                                        .is_some_and(|s| !s.trim().is_empty());
                                    let suggestions_present = value
                                        .get("suggestions")
                                        .and_then(|v| v.as_array())
                                        .is_some_and(|a| !a.is_empty());
                                    *ctx.outcome_hint = Some(browser_action_outcome_hint(
                                        args.get("kind").and_then(|k| k.as_str()).unwrap_or(""),
                                        true,
                                        no_change,
                                        committed_option,
                                        suggestions_present,
                                        false,
                                    ));
                                    if let Err(error) = complete_browser_effect(
                                        ctx,
                                        &effect_lease,
                                        serde_json::Value::String(
                                            "Previously completed browser action was not repeated. Inspect the current page with browser_snapshot before deciding the next action."
                                                .to_string(),
                                        ),
                                        serde_json::json!({
                                            "action_kinds": action_kinds,
                                            "applied": true,
                                        }),
                                    ) {
                                        Err(format!(
                                            "The browser action was applied, but its receipt could not be completed: {error}. Do not repeat it."
                                        ))
                                    } else {
                                        Ok(out)
                                    }
                                }
                                Err(error) => {
                                    // Always log the REAL error text (not only under HOMUN_DEBUG): the
                                    // browse sub-turn has no persisted journal, so this terse line was the
                                    // only record — and without the message a session death (a hung anti-bot
                                    // page timing out every call) is indistinguishable from a stale ref. The
                                    // per-action detail below stays debug-gated; this one line is the record.
                                    push_browser_step(
                                        format!("{kind}: {}", clip_chars(&error.to_string(), 200)),
                                        "error",
                                    );
                                    *ctx.outcome_hint = Some(
                                        local_first_engine::contract::ToolOutcomeHint::NoProgress,
                                    );
                                    // DIAG (HOMUN_DEBUG): what the model tried + why it
                                    // failed, to root-cause the repeated browser_act loop.
                                    if verbose_debug() {
                                        eprintln!(
                                            "[browser_act] kind={kind} ref={:?} selector={:?} text={:?} → ERROR: {}",
                                            args.get("ref").and_then(|v| v.as_str()),
                                            args.get("selector").and_then(|v| v.as_str()),
                                            if vault_secret_used {
                                                Some("[vault-secret]")
                                            } else {
                                                args.get("text").and_then(|v| v.as_str())
                                            },
                                            error.chars().take(220).collect::<String>()
                                        );
                                    }
                                    // Stale-ref auto-recovery: the page changed under us
                                    // so the [ref=eN] is gone. Instead of just erroring
                                    // (forcing the model to spend a round re-snapshotting),
                                    // take a fresh snapshot NOW and hand it back so it
                                    // retries with new refs in the same round.
                                    let stale = is_stale_ref_error(&error);
                                    if stale {
                                        let recovery = match browser_session.take() {
                                            Some(c) => {
                                                let guard = browse_web_lock().lock().await;
                                                // Stale-ref recovery is an ACTING re-observation → small view.
                                                let (c_back, snap_res) =
                                                    chat_browser_call_checkpointed(
                                                        ctx.state,
                                                        ctx.thread_id,
                                                        ctx.current_target.as_str(),
                                                        c,
                                                        BrowserMethod::Snapshot,
                                                        browser_chat_act_snapshot_params(
                                                            ctx.current_target.as_str(),
                                                        ),
                                                        BrowserCheckpointTelemetry {
                                                            journal: ctx.journal,
                                                            call_id,
                                                        },
                                                    )
                                                    .await;
                                                drop(guard);
                                                *browser_session = c_back;
                                                let snap = snap_res
                                                    .as_ref()
                                                    .map(browser_snapshot_text)
                                                    .unwrap_or_default();
                                                if snap.is_empty() {
                                                    Err(format!(
                                                        "Action failed: {error}{}",
                                                        browser_act_error_hint(&error)
                                                    ))
                                                } else {
                                                    *ctx.last_snapshot_semantic_fingerprint =
                                                        browser_snapshot_semantic_fingerprint(
                                                            &snap,
                                                        );
                                                    *ctx.last_snapshot = snap.clone();
                                                    browser_set_target_floor(
                                                        ctx.payment_floor_refs,
                                                        ctx.current_target.as_str(),
                                                        browser_floor_refs(
                                                            snap_res.as_ref().unwrap(),
                                                        ),
                                                    );
                                                    // A stale ref means the page genuinely changed under us —
                                                    // this recovery snapshot is a real fresh observation of
                                                    // THIS target, so treat it like an explicit
                                                    // browser_snapshot: refresh focus AND clear the robust flag.
                                                    browser_set_target_focus(
                                                        ctx.payment_context_by_target,
                                                        ctx.current_target.as_str(),
                                                        browser_focus_payment_context(
                                                            snap_res.as_ref().unwrap(),
                                                        ),
                                                    );
                                                    browser_clear_target_acted_floored(
                                                        ctx.payment_context_by_target,
                                                        ctx.current_target.as_str(),
                                                    );
                                                    let metrics = browser_observation_metrics(
                                                        snap_res.as_ref().unwrap(),
                                                        vec!["snapshot".to_string()],
                                                        "stale_ref_recovered",
                                                    );
                                                    ctx.journal.record(
                                                        browser_protocol_journal_event(
                                                            call_id,
                                                            "stale_ref_recovery_observation",
                                                            &metrics,
                                                        ),
                                                    );
                                                    push_browser_step(
                                                        browser_protocol_event_summary(
                                                            call_id,
                                                            "stale_ref_recovery_observation",
                                                            metrics,
                                                        ),
                                                        "done",
                                                    );
                                                    Ok(stale_ref_recovery_message(
                                                        args.get("ref").and_then(|v| v.as_str()),
                                                        &snap,
                                                    ))
                                                }
                                            }
                                            None => Err(format!(
                                                "Action failed: {error}{}",
                                                browser_act_error_hint(&error)
                                            )),
                                        };
                                        let persisted = match &recovery {
                                            Ok(text) | Err(text) => text.clone(),
                                        };
                                        if let Err(receipt_error) = complete_browser_effect(
                                            ctx,
                                            &effect_lease,
                                            serde_json::Value::String(persisted),
                                            serde_json::json!({
                                                "applied": false,
                                                "reason": "stale_ref",
                                            }),
                                        ) {
                                            Err(format!(
                                                "The browser rejected a stale reference before applying it, but its receipt could not be completed: {receipt_error}."
                                            ))
                                        } else {
                                            recovery
                                        }
                                    } else {
                                        let failure_kind = browser_act_failure_kind(&error);
                                        if failure_kind
                                            == BrowserActFailureKind::ConnectFailedBeforeDispatch
                                        {
                                            // Transport failed BEFORE the sidecar accepted the Act
                                            // request: the action never ran, there is no
                                            // double-execution risk, so release the receipt back to
                                            // `prepared` (no verification card, retry stays legal)
                                            // exactly like the channel ConnectFailedBeforeDispatch
                                            // path instead of suspending the turn on a useless
                                            // outcome verification.
                                            match release_browser_effect_not_applied(
                                                ctx,
                                                &effect_lease,
                                                failure_kind.as_str(),
                                                &redact_sensitive_text(&error),
                                            ) {
                                                Ok(receipt) => Err(format!(
                                                    "BROWSER EFFECT NOT APPLIED (receipt {}): the browser transport failed before the action was dispatched, so nothing was executed on the page. It is safe to retry the action once the browser session is back. Transport error: {}",
                                                    receipt.receipt_ref.as_ref(),
                                                    redact_sensitive_text(&error)
                                                )),
                                                Err(receipt_error) => Err(format!(
                                                    "Browser action was never dispatched, but its receipt could not be released: {receipt_error}. Transport error: {}",
                                                    redact_sensitive_text(&error)
                                                )),
                                            }
                                        } else if !browser_act_uncertain_failure_requires_user_resolution(
                                            effect_risk,
                                            failure_kind,
                                        ) {
                                            match release_browser_effect_not_applied(
                                                ctx,
                                                &effect_lease,
                                                "low_risk_remote_outcome_unknown",
                                                &redact_sensitive_text(&error),
                                            ) {
                                                Ok(receipt) => Err(format!(
                                                    "BROWSER EFFECT LOW RISK UNKNOWN (receipt {}): the browser action was ordinary/search-flow interaction, so Homun will not ask the user to verify an external write outcome. Treat this as browser no-progress, inspect the current page, and continue or report partial results. Sidecar error: {}",
                                                    receipt.receipt_ref.as_ref(),
                                                    redact_sensitive_text(&error)
                                                )),
                                                Err(receipt_error) => Err(format!(
                                                    "Low-risk browser action outcome was unknown and its receipt could not be released: {receipt_error}. Sidecar error: {}",
                                                    redact_sensitive_text(&error)
                                                )),
                                            }
                                        } else {
                                            let receipt =
                                                mark_browser_effect_uncertain(ctx, &effect_lease);
                                            match receipt {
                                                Ok(receipt) => Err(format!(
                                                    "{} Sidecar error: {}",
                                                    uncertain_browser_effect_text(&receipt),
                                                    redact_sensitive_text(&error)
                                                )),
                                                Err(receipt_error) => Err(format!(
                                                    "Browser action outcome is unknown and its receipt could not be marked uncertain: {receipt_error}. Do not repeat it. Sidecar error: {}",
                                                    redact_sensitive_text(&error)
                                                )),
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                "browser_screenshot" => {
                    if let Some(t) = args.get("target").and_then(|v| v.as_str())
                        && !t.trim().is_empty()
                    {
                        *ctx.current_target = t.to_string();
                    }
                    let full_page = args
                        .get("full_page")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let marks = args.get("marks").and_then(|v| v.as_bool()).unwrap_or(false);
                    let _ = emit_stream_event(
                        ctx.tx,
                        GenerateStreamEvent::Delta {
                            text: "‹‹ACT››📸 Capturing a screenshot‹‹/ACT››".to_string(),
                        },
                    )
                    .await;
                    let file_name = format!("chat_shot_{}.png", uuid::Uuid::new_v4().simple());
                    let guard = browse_web_lock().lock().await;
                    let (client_back, shot_res) = chat_browser_call_bounded(
                        client,
                        BrowserMethod::Screenshot,
                        serde_json::json!({
                            "target_id": ctx.current_target.as_str(),
                            "file_name": file_name,
                            "full_page": full_page,
                            "labels": marks,
                        }),
                    )
                    .await;
                    drop(guard);
                    *browser_session = client_back;
                    match shot_res {
                        Ok(value) => {
                            let path = value
                                .get("path")
                                .and_then(|p| p.as_str())
                                .unwrap_or("")
                                .to_string();
                            // Set-of-marks legend: map each numbered badge
                            // in the image back to the element's ref so the
                            // model can act precisely (browser_act ref=eN).
                            let legend = value
                                .get("marks")
                                .and_then(|m| m.as_array())
                                .map(|entries| {
                                    let mut text = String::from(
                                        "\nNumbered elements in the screenshot \
(number = element):",
                                    );
                                    for entry in entries {
                                        let mark = entry
                                            .get("mark")
                                            .and_then(|v| v.as_i64())
                                            .unwrap_or_default();
                                        let role = entry
                                            .get("role")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        let name = entry
                                            .get("name")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        let ref_id =
                                            entry.get("ref").and_then(|v| v.as_str()).unwrap_or("");
                                        text.push_str(&format!(
                                            "\n{mark} = {role} \"{name}\" [ref={ref_id}]"
                                        ));
                                    }
                                    text
                                })
                                .unwrap_or_default();
                            // P0 fix: skip image injection for non-vision models (minimax-m2.7,
                            // deepseek-v4-pro, etc.) that would fail with "this model does not
                            // support image input" on subsequent API calls. Return a text-only
                            // message directing the model to use browser_snapshot instead.
                            if !ctx.model_supports_vision {
                                push_browser_step("screenshot".to_string(), "done");
                                Ok(format!(
                                    "Screenshot captured and stored for reference. The screenshot \
is not shown inline because this model does not support image input. Use browser_snapshot to read \
the page content.{legend}"
                                ))
                            } else {
                                // Read + base64 the PNG. Skip the image (text
                                // note only) if missing or too large (~1.5MB
                                // encoded ≈ 1.1MB raw).
                                match std::fs::read(&path) {
                                    Ok(bytes) if bytes.len() <= 1_100_000 => {
                                        let encoded = base64::engine::general_purpose::STANDARD
                                            .encode(&bytes);
                                        let dataurl = format!("data:image/png;base64,{encoded}");
                                        *ctx.pending_browser_image = Some(dataurl);
                                        push_browser_step("screenshot".to_string(), "done");
                                        Ok(format!(
                                            "Screenshot captured (see the image attached \
below).{legend}"
                                        ))
                                    }
                                    Ok(bytes) => {
                                        push_browser_step("screenshot".to_string(), "done");
                                        Ok(format!(
                                            "Screenshot captured but too large for \
the preview ({} bytes). Proceed with the text snapshot.",
                                            bytes.len()
                                        ))
                                    }
                                    Err(error) => {
                                        push_browser_step("screenshot".to_string(), "error");
                                        Ok(format!(
                                            "Screenshot not readable from disk: {error}. \
Use the text snapshot."
                                        ))
                                    }
                                }
                            }
                        }
                        Err(error) => {
                            push_browser_step("screenshot".to_string(), "error");
                            Err(format!("Screenshot failed: {error}"))
                        }
                    }
                }
                "browser_tabs" => {
                    let _ = emit_stream_event(
                        ctx.tx,
                        GenerateStreamEvent::Delta {
                            text: "‹‹ACT››🗂️ Listing tabs‹‹/ACT››".to_string(),
                        },
                    )
                    .await;
                    let guard = browse_web_lock().lock().await;
                    let (client_back, tabs_res) = chat_browser_call_bounded(
                        client,
                        BrowserMethod::Tabs,
                        serde_json::json!({}),
                    )
                    .await;
                    drop(guard);
                    *browser_session = client_back;
                    match tabs_res {
                        Ok(value) => {
                            // Sidecar shape: { tabs: [ { targetId, url,
                            // label?, title? } ] }. Parse defensively in
                            // case it's a bare array or uses target_id/id.
                            let list = value
                                .get("tabs")
                                .and_then(|t| t.as_array())
                                .or_else(|| value.as_array())
                                .cloned()
                                .unwrap_or_default();
                            let mut lines: Vec<String> = Vec::new();
                            for tab in &list {
                                let id = tab
                                    .get("targetId")
                                    .or_else(|| tab.get("target_id"))
                                    .or_else(|| tab.get("id"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("?");
                                let url = tab.get("url").and_then(|v| v.as_str()).unwrap_or("");
                                let title = tab
                                    .get("title")
                                    .or_else(|| tab.get("label"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                let mut line = format!("- {id}");
                                if !url.is_empty() {
                                    line.push_str(&format!(" | {url}"));
                                }
                                if !title.is_empty() {
                                    line.push_str(&format!(" | {title}"));
                                }
                                lines.push(line);
                            }
                            push_browser_step("tabs".to_string(), "done");
                            if lines.is_empty() {
                                Ok("No tabs open.".to_string())
                            } else {
                                Ok(format!("Open tabs:\n{}", lines.join("\n")))
                            }
                        }
                        Err(error) => {
                            push_browser_step("tabs".to_string(), "error");
                            Err(format!("Listing tabs failed: {error}"))
                        }
                    }
                }
                "browser_dialog" => {
                    // Native alert/confirm/prompt blocks the page until
                    // answered. In read-only (channel) turns we only allow
                    // DISMISS, never accept (an accept could confirm an
                    // action). The dialog message is returned so the model
                    // sees what it answered.
                    let accept = !ctx.read_only
                        && args
                            .get("accept")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                    let prompt_text = args
                        .get("prompt_text")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let _ = emit_stream_event(
                        ctx.tx,
                        GenerateStreamEvent::Delta {
                            text: format!(
                                "‹‹ACT››💬 Dialog: {}‹‹/ACT››",
                                if accept { "confirming" } else { "cancelling" }
                            ),
                        },
                    )
                    .await;
                    let guard = browse_web_lock().lock().await;
                    let (client_back, dialog_res) = chat_browser_call_bounded(
                        client,
                        BrowserMethod::RespondDialog,
                        serde_json::json!({
                            "target_id": ctx.current_target.as_str(),
                            "accept": accept,
                            "promptText": prompt_text,
                            "timeoutMs": 5_000,
                        }),
                    )
                    .await;
                    drop(guard);
                    *browser_session = client_back;
                    match dialog_res {
                        Ok(value) => {
                            let msg = value.get("message").and_then(|m| m.as_str()).unwrap_or("");
                            push_browser_step("dialog".to_string(), "done");
                            Ok(format!(
                                "Dialog {} (message: \"{msg}\"). Re-read the page with browser_snapshot.",
                                if accept { "confirmed" } else { "cancelled" }
                            ))
                        }
                        Err(error) => {
                            push_browser_step("dialog".to_string(), "error");
                            Err(format!("No dialog to handle or error: {error}"))
                        }
                    }
                }
                _ => Err(format!("Unknown browser tool: {name}")),
            },
        }
    };
    // D2 fallback for arms that set no explicit hint (navigate / snapshot / tabs / dialog /
    // screenshot): the `Result` VARIANT is itself a machine signal — an errored action is no
    // progress, an ok one is. The `browser_act` arm sets a nuanced hint above (a successful
    // `type` that selected no suggestion is `Ok` yet NoProgress), which takes precedence here.
    if ctx.outcome_hint.is_none() {
        *ctx.outcome_hint = Some(if outcome.is_err() {
            local_first_engine::contract::ToolOutcomeHint::NoProgress
        } else {
            local_first_engine::contract::ToolOutcomeHint::Success
        });
    }
    match outcome {
        Ok(text) => text,
        Err(text) => text,
    }
}

/// S2 T4 (retry-safety): did the templated render GENUINELY deliver? True ONLY on the exact
/// full-success condition `templated_document_outcome` uses for its "The document is DONE"
/// message — `qa_failure.is_none()` AND all three of {html, pdf, docx} landed. A QA failure,
/// a container-side render that dropped html/pdf, or a container-unreachable DOCX-only degrade
/// are all `false`: the outcome message tells the user to RETRY, so the thread's routing
/// binding must SURVIVE (a retry stays forced onto the same template instead of falling back
/// to BM25 — the very regression S2 closes). Mirrors the make_deck gate
/// (`produced has deck.pptx && rendered_deck_qa_failure.is_none()`). Pure seam so the
/// clear-on-delivery decision is unit-testable without a live sandbox, and shares ONE success
/// definition with `templated_document_outcome` (test `..._agrees_with_outcome_success` pins
/// the two together so they can't drift).
pub(crate) fn templated_document_delivered(
    produced: &[String],
    stem: &str,
    qa_failure: Option<&str>,
) -> bool {
    if qa_failure.is_some() {
        return false;
    }
    let html_name = format!("{stem}.html");
    let pdf_name = format!("{stem}.pdf");
    let docx_name = format!("{stem}.docx");
    produced.iter().any(|name| name == &html_name)
        && produced.iter().any(|name| name == &pdf_name)
        && produced.iter().any(|name| name == &docx_name)
}

/// Pure decision for `make_templated_document`'s post-render outcome
/// message, given which of {html, pdf, docx} actually landed on disk
/// (`produced`, already filtered to existing non-zero-byte files by
/// `emit_rendered_deck_artifacts`) plus the raw render output for
/// diagnostics. Extracted from the async fn so the degraded-vs-success
/// branch is unit-testable without a live sandbox.
///
/// GOTCHA this fixes: `sandbox::run_command` returning `Ok` only means the
/// container was reachable, NOT that it produced the designed render — and
/// the DOCX is written host-side BEFORE the container even runs, so
/// `produced` containing the docx is never proof the render succeeded. A
/// container-side render failure (missing html/pdf) must degrade honestly,
/// the same as the `Err` (container-unreachable) branch, instead of
/// reporting full success just because the pre-written DOCX exists.
pub(crate) fn templated_document_outcome(
    produced: &[String],
    stem: &str,
    workflow_id: &str,
    qa_failure: Option<&str>,
    render_out: &str,
) -> String {
    let html_name = format!("{stem}.html");
    let pdf_name = format!("{stem}.pdf");
    let docx_name = format!("{stem}.docx");
    let has_html = produced.iter().any(|name| name == &html_name);
    let has_pdf = produced.iter().any(|name| name == &pdf_name);
    let has_docx = produced.iter().any(|name| name == &docx_name);

    if let Some(error) = qa_failure {
        return format!(
            "Document created via workflow {workflow_id} with visual QA issues: {error}. Files available: {}. The DOCX is editable; .html/.pdf are previews.",
            if produced.is_empty() {
                "none".to_string()
            } else {
                produced.join(", ")
            },
        );
    }

    if !has_html || !has_pdf {
        // Container ran (the Ok branch) but didn't actually produce the
        // designed render — degrade exactly like the container-unreachable
        // path, plus a short diagnostic tail of the renderer's own output so
        // a silent render failure is debuggable instead of masked.
        let tail_chars = render_out.chars().count();
        let tail: String = if tail_chars > 300 {
            render_out.chars().skip(tail_chars - 300).collect()
        } else {
            render_out.to_string()
        };
        return format!(
            "Document created (DOCX). Designed HTML/PDF need the local computer (start it and retry for the full render). Render diagnostic: {tail}"
        );
    }

    if has_docx {
        format!(
            "Document created via workflow {workflow_id}: {}. The DOCX is editable; .html/.pdf are previews. The document is DONE — give the user a one-line summary.",
            produced.join(", "),
        )
    } else {
        format!(
            "Document render did NOT produce the expected files. Renderer output:\n{}",
            render_out.chars().take(800).collect::<String>()
        )
    }
}

/// F2-T8 templated path for `make_document`: mirrors `make_deck`'s
/// brand -> content -> render pipeline, but with a FIXED block skeleton (the
/// pack's `example.json`, never chosen/reordered by the model) and a
/// gateway-side DOCX instead of a pptx. Kept as its own async fn — rather
/// than inline in the `execute_chat_tool` dispatch match — so honest-failure
/// early returns don't force a pyramid of nested match/if-let in the
/// dispatch loop (the dispatch site just calls this and awaits).
/// Returns `(result, delivered)`: `delivered` is `true` ONLY on a genuine full delivery — the
/// designed render produced html+pdf+docx AND passed QA (`templated_document_delivered`, the
/// same condition the "The document is DONE" message uses). Every degraded/failed outcome —
/// content/write early-returns, container-unreachable DOCX-only, a container-side render that
/// dropped html/pdf, or a QA failure — is `false`, because each of those tells the user to
/// retry and the retry must stay forced onto the same template (S2 T4 uses `delivered` to
/// decide whether to clear the thread's routing binding; clearing on a failed render would
/// drop the binding and let the retry fall back to BM25 — the regression S2 closes). Chosen
/// over string-sniffing `result` (the message text is user-facing prose, not a status
/// contract).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn make_templated_document(
    ctx: &ChatToolCtx<'_>,
    append_output: &mut Vec<String>,
    thread_slug: &str,
    workflow_id: &str,
    document_options: &DocumentGenerationOptions,
    fname: &str,
    brief: &str,
    language: &str,
    entry: TemplateCatalogEntry,
) -> (String, bool) {
    let _ = emit_stream_event(
        ctx.tx,
        GenerateStreamEvent::Delta {
            text: "‹‹ACT››🧩 Building the document (brand · slots · render)‹‹/ACT››".to_string(),
        },
    )
    .await;
    // 1) brand into the output dir (same as make_deck — theme colours flow to
    // the container renderer via brand.json; doc_render.py merges it UNDER
    // the pack's own theme name, so the brand kit's colours win at render).
    let slug_b = thread_slug.to_string();
    let _ = tokio::task::spawn_blocking(move || materialize_brand_kit(&slug_b)).await;

    // 2) curated block skeleton from the pack's example.json — NEVER
    // inferred from the model (caposaldo: model fills slots, code owns
    // structure).
    let entry_for_load = entry.clone();
    let example =
        tokio::task::spawn_blocking(move || document_content::load_pack_example(&entry_for_load))
            .await
            .unwrap_or_else(|error| Err(format!("join error: {error}")));
    let example = match example {
        Ok(example) => example,
        Err(error) => {
            return (
                format!("Could not load template pack «{}»: {error}", entry.id),
                false,
            );
        }
    };
    let skeleton = document_content::document_block_skeleton(&example);
    let directives = document_generation_directives(document_options);
    let stem = std::path::Path::new(fname)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(fname)
        .to_string();

    // 3) schema-enforced slot content, with ONE corrective retry if the model
    // drops a slot — never synthesized, a second miss fails honestly.
    let mut doc = match generate_templated_document_json(
        &ctx.state.http,
        ctx.base_url,
        ctx.model,
        ctx.api_key.as_deref(),
        brief,
        language,
        &skeleton,
        &directives,
        &entry.name,
    )
    .await
    {
        Ok(doc) => doc,
        Err(error) => {
            return (
                format!("Could not generate document content: {error}"),
                false,
            );
        }
    };

    // 4) name the render theme from the RESOLVED design_theme (explicit arg
    // wins, else the pack's curated theme — the same value the content
    // directives used, so an explicit "high_contrast" never renders as the
    // pack default while the prose follows the override). doc_render.py then
    // merges brand.json UNDER it (brand colours win over the theme's own
    // defaults) — "il brand kit vince al render".
    if let Some(theme_name) = document_options.design_theme.as_deref() {
        doc["theme"] = serde_json::json!({ "name": theme_name });
    }

    // 5) write doc.json, then the editable DOCX gateway-side from the SAME
    // doc.json — single source of truth, dual projection (mirrors deck's
    // pptx/html split).
    let doc_bytes = serde_json::to_vec_pretty(&doc).unwrap_or_default();
    let json_name = format!("{stem}.json");
    let slug_w = thread_slug.to_string();
    let json_name_w = json_name.clone();
    let write_json = tokio::task::spawn_blocking(move || {
        write_artifact_bytes(&slug_w, &json_name_w, &doc_bytes)
    })
    .await
    .unwrap_or_else(|error| Err(format!("join error: {error}")));
    if let Err(error) = write_json {
        return (format!("Could not write {json_name}: {error}"), false);
    }

    let docx_name = format!("{stem}.docx");
    let slug_dw = thread_slug.to_string();
    let docx_name_w = docx_name.clone();
    let write_docx = tokio::task::spawn_blocking(move || {
        let bytes = doc_json_to_docx(&doc)?;
        write_artifact_bytes(&slug_dw, &docx_name_w, &bytes)
    })
    .await
    .unwrap_or_else(|error| Err(format!("join error: {error}")));
    if let Err(error) = write_docx {
        return (format!("Could not write {docx_name}: {error}"), false);
    }

    // 6) render in the sandbox (no model shell) — same command shape as
    // deck, QA-gated on the SAME `DECK_QA_JSON:` prefix so the existing
    // parser converges across deck and document.
    let html_name = format!("{stem}.html");
    let pdf_name = format!("{stem}.pdf");
    let names = [html_name.as_str(), pdf_name.as_str(), docx_name.as_str()];
    let container_out = sandbox::container_output_dir(thread_slug);
    let cmd = build_document_render_command(&container_out, &stem);
    sandbox_begin(cmd.clone(), ctx.thread_id.map(|s| s.to_string()));
    let render = tokio::task::spawn_blocking(move || sandbox::run_command(&cmd, None))
        .await
        .unwrap_or_else(|error| Err(format!("join error: {error}")));

    match render {
        // Container down/unreachable: NEVER fall back to the markdown path
        // (the template would be lost silently) — degrade honestly to the
        // DOCX we already wrote host-side.
        Err(error) => {
            sandbox_end(error.clone());
            let template_metadata = deck_template_metadata(Some(&entry));
            let mut doc_out = String::new();
            let _ = emit_rendered_deck_artifacts(
                ctx.state,
                ctx.tx,
                &mut doc_out,
                ctx.thread_id,
                thread_slug,
                "make_document",
                Some(&template_metadata),
                &names,
            )
            .await;
            append_output.push(doc_out);
            // Container unreachable → only the host-written DOCX exists, no designed render.
            // `delivered = false`: the message tells the user to start the local computer and
            // RETRY, so the routing binding must survive for that retry (retry-safety).
            (
                "Document created (DOCX). Designed HTML/PDF need the local computer (start it and retry for the full render).".to_string(),
                false,
            )
        }
        Ok(render_out) => {
            sandbox_end(render_out.clone());
            let qa_result = rendered_deck_qa_result(&render_out);
            let quality_metadata = deck_quality_metadata_from_qa_result(qa_result.as_ref());
            let mut artifact_metadata = deck_template_metadata(Some(&entry));
            merge_object_metadata(&mut artifact_metadata, quality_metadata.as_ref());
            let mut doc_out = String::new();
            let produced = emit_rendered_deck_artifacts(
                ctx.state,
                ctx.tx,
                &mut doc_out,
                ctx.thread_id,
                thread_slug,
                "make_document",
                Some(&artifact_metadata),
                &names,
            )
            .await;
            append_output.push(doc_out);
            // The container ran, but `Ok` ≠ success — QA may have failed or html/pdf may not
            // have landed (see `templated_document_outcome`'s degrade branches). Clear the
            // binding ONLY on a genuine full delivery, computed from the SAME condition the
            // outcome message uses, so a failed/incomplete render keeps the binding for retry.
            let qa_failure = rendered_deck_qa_failure(&render_out);
            let delivered = templated_document_delivered(&produced, &stem, qa_failure.as_deref());
            (
                templated_document_outcome(
                    &produced,
                    &stem,
                    workflow_id,
                    qa_failure.as_deref(),
                    &render_out,
                ),
                delivered,
            )
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum EffectDispatchStatus {
    Verified,
    UnknownRemoteOutcome,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum EffectReceiptFinishAction {
    Complete,
    MarkUncertainAndSuspend,
}

pub(crate) fn effect_receipt_finish_action(
    status: EffectDispatchStatus,
) -> EffectReceiptFinishAction {
    match status {
        EffectDispatchStatus::Verified => EffectReceiptFinishAction::Complete,
        EffectDispatchStatus::UnknownRemoteOutcome => {
            EffectReceiptFinishAction::MarkUncertainAndSuspend
        }
    }
}

pub(crate) struct GatewayToolDispatch {
    pub(crate) result: String,
    pub(crate) effects: local_first_engine::ToolEffects,
    pub(crate) effect_status: EffectDispatchStatus,
}

/// Pure per-tool-call dispatch for the chat loop: the single `if name == … else if …`
/// chain, extracted verbatim from `stream_chat_via_openai`'s dispatch loop (fase 1b).
/// Turn-state is read/mutated through `ctx.<field>` exactly as inline (disjoint field
/// borrows preserved); `name`/`args_raw`/`call_id` are the per-call parse results. The
/// caller keeps the harness snapshots, the blocked-guard, and the post-result push.
pub(crate) async fn execute_chat_tool(
    // `&ctx` (shared): the arms no longer MUTATE `ctx` (all changes flow through the returned
    // `ToolEffects`, 5d.1b), and `ChatToolCtx` is now `Sync` (browser_session left it, 5e.1) so a
    // shared-`&ctx` future is `Send` inside the loop's `tokio::spawn`. This is the pure
    // `name+args → (result, effects)` shape the `&self` CapabilityExecutor wraps at 5e.
    ctx: &ChatToolCtx<'_>,
    name: &str,
    args_raw: &str,
    // Unused since the browser dispatch (its only user) moved to the call site (5d.2); kept for the
    // `CapabilityExecutor::execute_tool(name, args, call_id)` signature this becomes at 5e.
    _call_id: &str,
) -> GatewayToolDispatch {
    // ADR 0023: observe-only sandbox classification/log alongside the (now unconditional)
    // OS fence. NEVER blocks or alters `result`; it only reads state and logs.
    shadow_log_sandbox(ctx.state, ctx.thread_id, name, args_raw);
    // ADR 0024 inc 5d.1b: tools no longer mutate `ctx` inline; the non-browser arms record their
    // loop-state changes here and the caller applies them (`apply_tool_effects`) right after the call
    // — behavior-preserving. (The browser arm still delegates to `execute_browser_tool`, the temporary
    // seam headed for ADR 0025, which keeps mutating `ctx` directly for now.)
    let mut effects = local_first_engine::ToolEffects::default();
    let mut effect_status = EffectDispatchStatus::Verified;
    let result = if ctx.turn_policy.read_only
        && matches!(
            name,
            "run_in_sandbox"
                | "create_artifact"
                | "generate_image"
                | "save_artifact"
                | "read_file"
                | "write_file"
                | "edit_file"
                | "apply_patch"
                | "list_files"
                | "run_in_project"
                | "schedule_task"
                | "cancel_scheduled_task"
                | "customize_addon"
                | "create_skill"
        ) {
        // Defensive: these aren't offered in read-only mode, but if the
        // model calls one anyway, refuse instead of executing.
        "Action not available from the channel: operations with effects \
require your confirmation in the app. Propose it and stop."
            .to_string()
    } else if name == "github_search" {
        // Fast, structured GitHub repo search via the API (no browser).
        let query = serde_json::from_str::<serde_json::Value>(args_raw)
            .ok()
            .and_then(|a| a.get("query").and_then(|v| v.as_str()).map(String::from))
            .unwrap_or_default();
        if query.trim().is_empty() {
            "Empty query.".to_string()
        } else {
            let _ = emit_stream_event(
                ctx.tx,
                GenerateStreamEvent::Delta {
                    text: format!("‹‹ACT››🔎 Searching GitHub: «{query}»‹‹/ACT››"),
                },
            )
            .await;
            github_search(ctx.state, &query).await
        }
    } else if name == "use_skill" {
        // Progressive disclosure L2: load the full SKILL.md so the
        // model can follow the skill's instructions.
        let id = serde_json::from_str::<serde_json::Value>(args_raw)
            .ok()
            .and_then(|a| a.get("id").and_then(|v| v.as_str()).map(String::from))
            .unwrap_or_default();
        // Narrate the skill use with its READABLE name (id → Title Case),
        // so the activity stream reads like reasoning: "Uso la skill Code
        // Review Discipline" (as Claude Code / Codex do).
        let readable = id
            .split('-')
            .filter(|w| !w.is_empty())
            .map(|w| {
                let mut chars = w.chars();
                match chars.next() {
                    Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
        let _ = emit_stream_event(
            ctx.tx,
            GenerateStreamEvent::Delta {
                text: format!("‹‹ACT››📖 Using the skill «{readable}»‹‹/ACT››"),
            },
        )
        .await;
        let id_for_load = id.clone();
        match tokio::task::spawn_blocking(move || load_skill_body_and_sensitive(&id_for_load)).await
        {
            Ok(Some((body, sensitive))) => {
                // ADR 0023 Step 5: arm the turn's force-confirm for a skill that declares a
                // sensitive domain. The loop dedups these tokens into `LoopState::active_sensitive`
                // so they persist across the turn's later rounds.
                for cat in sensitive {
                    effects.arm_sensitive.push(cat.as_token().to_string());
                }
                format!(
                    "Instructions for the skill «{id}» (SKILL.md) — FOLLOW THEM with the \
available tools (for data from the web use the browser: browser_navigate on the indicated URL):\n\n{}",
                    body.chars().take(8000).collect::<String>()
                )
            }
            _ => format!("Skill «{id}» not found or not readable."),
        }
    } else if name == "run_in_sandbox" {
        // Execute a skill command in the contained computer (auto-start
        // Docker + container). Blocked if the command trips the security scan.
        let parsed = serde_json::from_str::<serde_json::Value>(args_raw)
            .unwrap_or_else(|_| serde_json::json!({}));
        let command = parsed
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let skill_id = parsed
            .get("skill_id")
            .and_then(|v| v.as_str())
            .map(String::from);
        if command.trim().is_empty() {
            "Empty command.".to_string()
        } else {
            let scan = skill_security::scan_blobs(&[("command".to_string(), command.clone())]);
            if scan.blocked {
                let reasons = security_scan_block_reasons(&scan);
                tracing::warn!(target: "security::scan", risk = scan.risk_score, %reasons, "sandboxed command blocked");
                format!(
                    "Command NOT executed: blocked by the security scan \
(risk {}/100). {reasons} Reformulate it without dangerous operations.",
                    scan.risk_score
                )
            } else {
                let _ = emit_stream_event(
                    ctx.tx,
                    GenerateStreamEvent::Delta {
                        text: format!(
                            "‹‹ACT››🖥️ Running: {}‹‹/ACT››",
                            command.chars().take(160).collect::<String>()
                        ),
                    },
                )
                .await;
                // If Docker is down we auto-start Docker Desktop (cold
                // start ~1 min) before running — tell the user so the
                // wait doesn't look like a hang.
                let docker_up = tokio::task::spawn_blocking(sandbox::docker_running)
                    .await
                    .unwrap_or(false);
                if !docker_up {
                    let _ = emit_stream_event(
                        ctx.tx,
                        GenerateStreamEvent::Delta {
                            text: "‹‹ACT››🐳 Docker isn't running: starting Docker Desktop and waiting for it to be ready (~1 min)…‹‹/ACT››".to_string(),
                        },
                    )
                    .await;
                }
                // Publish the command to the computer terminal panel.
                sandbox_begin(command.clone(), ctx.thread_id.map(|s| s.to_string()));
                // Per-conversation output dir: skills save generated
                // files to $OUTPUT_DIR, bind-mounted to the host so
                // they become downloadable artifacts.
                let thread_slug = artifact_thread_slug(ctx.thread_id);
                let container_out = sandbox::container_output_dir(&thread_slug);
                let host_out = sandbox::artifacts_dir().join(&thread_slug);
                let run_started = std::time::SystemTime::now();
                let cmd = format!(
                    "export OUTPUT_DIR='{container_out}'; mkdir -p \"$OUTPUT_DIR\"; {command}"
                );
                // The model may omit skill_id; derive it from the
                // command's `/home/agent/skills/<id>/…` path so the
                // skill's files are always synced before running.
                let sid = skill_id.clone().or_else(|| skill_id_from_command(&command));
                let outcome = tokio::task::spawn_blocking(move || {
                    if let Some(id) = sid.as_deref()
                        && let Ok(dir) = skills_dir()
                    {
                        sandbox::sync_skill(&dir.join(id), id);
                    }
                    sandbox::run_command(&cmd, sid.as_deref())
                })
                .await;
                let (panel_output, mut model_output) = match outcome {
                    Ok(Ok(out)) => {
                        if out.trim().is_empty() {
                            ("(no output)".to_string(), "(no output)".to_string())
                        } else {
                            (out.clone(), format!("Command output:\n{out}"))
                        }
                    }
                    Ok(Err(error)) => {
                        let msg = format!("Sandbox unavailable: {error}");
                        (msg.clone(), msg)
                    }
                    Err(error) => {
                        let msg = format!("Execution error: {error}");
                        (msg.clone(), msg)
                    }
                };
                sandbox_end(panel_output);
                // Surface files the command produced as downloadable
                // artifacts (marker → card). If a PROJECT folder is
                // active, also copy them there — it's the project's
                // default folder for generated files.
                let project_folder = active_workspace_folder();
                for (file_name, size) in detect_new_artifacts(&host_out, run_started) {
                    let mut delivered_to: Option<String> = None;
                    if let Some(folder) = project_folder.as_ref() {
                        let dest = std::path::Path::new(folder).join(&file_name);
                        if std::fs::copy(host_out.join(&file_name), &dest).is_ok() {
                            delivered_to = Some(dest.to_string_lossy().to_string());
                        }
                    }
                    let marker = serde_json::json!({
                        "name": file_name,
                        "thread": thread_slug,
                        "size": size,
                    });
                    let artifact_mark = format!("‹‹ARTIFACT››{marker}‹‹/ARTIFACT››");
                    // Persist in the committed answer so the UI can
                    // render the download card + Artefatti panel (the
                    // Done payload is authoritative).
                    effects.append_output.push(artifact_mark.clone());
                    let _ = emit_stream_event(
                        ctx.tx,
                        GenerateStreamEvent::Delta {
                            text: artifact_mark,
                        },
                    )
                    .await;
                    register_artifact_memory(
                        ctx.state,
                        ctx.thread_id,
                        &thread_slug,
                        &file_name,
                        size,
                        false,
                        "run_in_sandbox",
                        delivered_to.as_deref(),
                    )
                    .await;
                    match delivered_to {
                        Some(path) => model_output
                            .push_str(&format!("\n[file generated and saved to {path}]")),
                        None => model_output
                            .push_str(&format!("\n[file generated: {file_name} in $OUTPUT_DIR]")),
                    }
                }
                model_output
            }
        }
    } else if name == "create_artifact" {
        // Model-authored document/code → file artifact (host-side).
        let parsed = serde_json::from_str::<serde_json::Value>(args_raw)
            .unwrap_or_else(|_| serde_json::json!({}));
        let fname = parsed
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let content = parsed
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let thread_slug = artifact_thread_slug(ctx.thread_id);
        let _ = emit_stream_event(
            ctx.tx,
            GenerateStreamEvent::Delta {
                text: format!("‹‹ACT››📝 Creating the file {fname}‹‹/ACT››"),
            },
        )
        .await;
        let fname_w = fname.clone();
        let slug_w = thread_slug.clone();
        // A `.pdf` artifact: the `content` is Markdown → render it to a
        // real paginated PDF (in-process, always works). Everything else
        // is written verbatim as text.
        let is_pdf = fname.to_ascii_lowercase().ends_with(".pdf");
        let result = tokio::task::spawn_blocking(move || {
            if is_pdf {
                let title = fname_w.trim_end_matches(".pdf").trim_end_matches(".PDF");
                let bytes = pdf_render::markdown_to_pdf(title, &content)
                    .map_err(|e| format!("PDF render failed: {e}"))?;
                write_artifact_bytes(&slug_w, &fname_w, &bytes)
            } else {
                write_text_artifact(&slug_w, &fname_w, &content)
            }
        })
        .await
        .unwrap_or_else(|e| Err(format!("Error: {e}")));
        match result {
            Ok((size, updated)) => {
                let marker = serde_json::json!({
                    "name": fname,
                    "thread": thread_slug,
                    "size": size,
                    "updated": updated,
                });
                let artifact_mark = format!("‹‹ARTIFACT››{marker}‹‹/ARTIFACT››");
                // Persist the marker in the committed answer (Done is
                // authoritative): the UI parses ‹‹ARTIFACT›› from the
                // saved message to render the download card + the
                // Artefatti panel. Without this the artifact vanishes.
                effects.append_output.push(artifact_mark.clone());
                let _ = emit_stream_event(
                    ctx.tx,
                    GenerateStreamEvent::Delta {
                        text: artifact_mark,
                    },
                )
                .await;
                register_artifact_memory(
                    ctx.state,
                    ctx.thread_id,
                    &thread_slug,
                    &fname,
                    size,
                    updated,
                    "create_artifact",
                    None,
                )
                .await;
                if updated {
                    format!("Artifact «{fname}» updated (new version).")
                } else {
                    format!("Artifact «{fname}» created.")
                }
            }
            Err(error) => error,
        }
    } else if name == "generate_image" {
        // Generate an image from a prompt (local Ollama or cloud provider)
        // and surface it as a PNG artifact, like create_artifact.
        let parsed = serde_json::from_str::<serde_json::Value>(args_raw)
            .unwrap_or_else(|_| serde_json::json!({}));
        let prompt = parsed
            .get("prompt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let size = parsed
            .get("size")
            .and_then(|v| v.as_str())
            .unwrap_or("1024x1024")
            .to_string();
        let base_name = parsed
            .get("name")
            .and_then(|v| v.as_str())
            .map(slugify_skill_name)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "image".to_string());
        let fname = format!("{base_name}.png");
        if prompt.is_empty() {
            "generate_image needs a prompt.".to_string()
        } else {
            let _ = emit_stream_event(
                ctx.tx,
                GenerateStreamEvent::Delta {
                    text: format!(
                        "‹‹ACT››🎨 Generating image: {}‹‹/ACT››",
                        prompt.chars().take(60).collect::<String>()
                    ),
                },
            )
            .await;
            match generate_image_png(&ctx.state.http, &prompt, &size).await {
                Ok(bytes) => {
                    let thread_slug = artifact_thread_slug(ctx.thread_id);
                    let slug_w = thread_slug.clone();
                    let fname_w = fname.clone();
                    let result = tokio::task::spawn_blocking(move || {
                        write_artifact_bytes(&slug_w, &fname_w, &bytes)
                    })
                    .await
                    .unwrap_or_else(|e| Err(format!("Error: {e}")));
                    match result {
                        Ok((size_b, updated)) => {
                            let marker = serde_json::json!({
                                "name": fname,
                                "thread": thread_slug,
                                "size": size_b,
                                "updated": updated,
                            });
                            let artifact_mark = format!("‹‹ARTIFACT››{marker}‹‹/ARTIFACT››");
                            effects.append_output.push(artifact_mark.clone());
                            let _ = emit_stream_event(
                                ctx.tx,
                                GenerateStreamEvent::Delta {
                                    text: artifact_mark,
                                },
                            )
                            .await;
                            register_artifact_memory(
                                ctx.state,
                                ctx.thread_id,
                                &thread_slug,
                                &fname,
                                size_b,
                                updated,
                                "generate_image",
                                None,
                            )
                            .await;
                            format!(
                                "Image «{fname}» generated and shown to the user \
                                 inline. Do NOT embed it as a markdown image link \
                                 (![]()); just refer to it in one short sentence."
                            )
                        }
                        Err(error) => error,
                    }
                }
                Err(error) => error,
            }
        }
    } else if name == "get_brand_kit" {
        // Materialize the brand into the thread's output dir (brand.json +
        // logo.png) so the renderer applies it and the model needn't embed
        // the logo data URL in deck.json. Return colours/fonts (for image
        // prompts) but REPLACE the big logo data URL with a note, so the
        // model can't paste a 13KB blob into a shell-written deck.json.
        let slug = artifact_thread_slug(ctx.thread_id);
        let slug2 = slug.clone();
        let _ = tokio::task::spawn_blocking(move || materialize_brand_kit(&slug2)).await;
        let mut kit =
            serde_json::to_value(load_brand_kit()).unwrap_or_else(|_| serde_json::json!({}));
        if let Some(obj) = kit.as_object_mut() {
            let has_logo = obj
                .get("logo_data_url")
                .and_then(|v| v.as_str())
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            obj.insert(
                "logo_data_url".into(),
                serde_json::json!(if has_logo {
                    "(applied automatically — written to logo.png in the output dir; do NOT embed in deck.json)"
                } else {
                    ""
                }),
            );
            obj.insert("note".into(), serde_json::json!(
                "Brand is applied automatically by deck-render via brand.json + logo.png already written to the output dir. In deck.json include ONLY slide content — OMIT `theme` and `logo` entirely."
            ));
        }
        serde_json::to_string(&kit).unwrap_or_else(|_| "{}".to_string())
    } else if name == "render_deck" {
        // Deterministic deck render: the model passes ONLY content; the
        // gateway writes deck.json + brand files and runs deck-render +
        // chromium in the sandbox. Removes ALL model filesystem juggling
        // (no shell, no find, no path/dir confusion → no regenerate loop).
        let parsed = serde_json::from_str::<serde_json::Value>(args_raw)
            .unwrap_or_else(|_| serde_json::json!({}));
        let deck = parsed.get("deck").cloned().unwrap_or(parsed);
        let has_slides = deck
            .get("slides")
            .and_then(|s| s.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false);
        if !has_slides {
            "render_deck needs a non-empty 'slides' array (content only).".to_string()
        } else {
            let thread_slug = artifact_thread_slug(ctx.thread_id);
            let _ = emit_stream_event(
                ctx.tx,
                GenerateStreamEvent::Delta {
                    text: "‹‹ACT››🎬 Rendering the deck (PPTX + preview)‹‹/ACT››".to_string(),
                },
            )
            .await;
            // 1) brand.json + logo.png + deck.json into the output dir
            //    (host side = bind-mounted into the sandbox).
            let slug_b = thread_slug.clone();
            let _ = tokio::task::spawn_blocking(move || materialize_brand_kit(&slug_b)).await;
            let deck_bytes = serde_json::to_vec_pretty(&deck).unwrap_or_default();
            let slug_w = thread_slug.clone();
            let write_res = tokio::task::spawn_blocking(move || {
                write_artifact_bytes(&slug_w, "deck.json", &deck_bytes)
            })
            .await
            .unwrap_or_else(|e| Err(format!("join error: {e}")));
            if let Err(e) = write_res {
                format!("Could not write deck.json: {e}")
            } else {
                // 2) render in the sandbox (no model shell).
                let container_out = sandbox::container_output_dir(&thread_slug);
                let cmd = format!(
                    "cd '{container_out}' && deck-render deck.json --prefix deck && \
                     chromium --headless --no-sandbox --disable-gpu --no-pdf-header-footer \
                     --print-to-pdf=deck.pdf deck.html >/dev/null 2>&1 && \
                     qa=$(deck-qa deck.html --json 2>&1); qa_code=$?; \
                     echo \"DECK_QA_JSON:$qa\"; \
                     if [ \"$qa_code\" -ne 0 ]; then exit \"$qa_code\"; fi; \
                     ls -la deck.pptx deck.html deck.pdf deck.json 2>&1"
                );
                sandbox_begin(cmd.clone(), ctx.thread_id.map(|s| s.to_string()));
                let render = tokio::task::spawn_blocking(move || sandbox::run_command(&cmd, None))
                    .await
                    .unwrap_or_else(|e| Err(format!("join error: {e}")));
                let render_out = match render {
                    Ok(o) => o,
                    Err(e) => e,
                };
                sandbox_end(render_out.clone());
                // 3) emit an artifact marker for each file produced, even when
                // QA flags issues: the files exist and the user needs access to
                // inspect/fix them.
                let qa_result = rendered_deck_qa_result(&render_out);
                let quality_metadata = deck_quality_metadata_from_qa_result(qa_result.as_ref());
                // 5d.1b: the helper appends artifact markers to a local buffer; flushed to `effects`
                // (→ ctx.accumulated) after the call, preserving the inline order.
                let mut deck_out = String::new();
                let produced = emit_rendered_deck_artifacts(
                    ctx.state,
                    ctx.tx,
                    &mut deck_out,
                    ctx.thread_id,
                    &thread_slug,
                    "render_deck",
                    quality_metadata.as_ref(),
                    DECK_ARTIFACT_NAMES,
                )
                .await;
                effects.append_output.push(deck_out);
                if let Some(error) = rendered_deck_qa_failure(&render_out) {
                    format!(
                        "Deck rendered with visual QA issues: {error}. Files available: {}. Renderer output:\n{}",
                        if produced.is_empty() {
                            "none".to_string()
                        } else {
                            produced.join(", ")
                        },
                        render_out.chars().take(1200).collect::<String>(),
                    )
                } else {
                    if produced.iter().any(|fname| fname == "deck.pptx") {
                        format!(
                            "Deck rendered: {}. The .pptx is editable; .html/.pdf are previews; .json is the source contract. The deck is DONE — mark the plan complete and give the user a one-line summary.",
                            produced.join(", ")
                        )
                    } else {
                        format!(
                            "Deck render did NOT produce a .pptx. Renderer output:\n{}",
                            render_out.chars().take(800).collect::<String>()
                        )
                    }
                }
            }
        }
    } else if name == "make_deck" {
        // ONE-call deck (max-scaffolding tier, ADR 0016): the model
        // passed only a brief; the ENGINE runs the entire pipeline
        // (brand → schema-enforced content → images → render). No
        // model-driven planning, file I/O or shell → nothing for a
        // weak model to get wrong beyond filling the brief slot.
        let mut parsed = serde_json::from_str::<serde_json::Value>(args_raw)
            .unwrap_or_else(|_| serde_json::json!({}));
        // S2 T4: the thread's deterministic routing binding (if any) OWNS `template_ref` —
        // merge it into the tool-call args before anything downstream reads them, so the
        // model can't lose or override the user's "Use template" choice.
        if let Some(binding) = active_routing_binding(ctx.state, ctx.thread_id)
            && let Some(template_ref) = binding.args.get("template_ref").and_then(|v| v.as_str())
        {
            merge_bound_template_ref(&mut parsed, template_ref);
        }
        let brief = parsed
            .get("brief")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let language = parsed
            .get("language")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let slides = parsed
            .get("slides")
            .and_then(|v| v.as_u64())
            .unwrap_or(6)
            .clamp(3, 12) as usize;
        let requested_template_ref = deliverable_template_ref(&parsed);
        let catalog_template = template_catalog_by_id(requested_template_ref.as_deref());
        let template_ref = catalog_template.as_ref().map(|entry| entry.id.clone());
        let design_template = deliverable_design_template(&parsed).or_else(|| {
            catalog_template
                .as_ref()
                .map(|entry| entry.design_template.clone())
        });
        let design_theme = deliverable_design_theme(&parsed).or_else(|| {
            catalog_template
                .as_ref()
                .and_then(|entry| entry.design_theme.clone())
        });
        let design_profile = deliverable_design_profile(&parsed)
            .or_else(|| {
                catalog_template
                    .as_ref()
                    .and_then(|entry| entry.design_profile.clone())
            })
            .or_else(|| {
                let (profile, _) = deliverable_template_defaults(design_template.as_deref());
                profile.map(String::from)
            });
        let design_components = resolved_deliverable_design_components_with_catalog(
            &parsed,
            design_template.as_deref(),
            catalog_template
                .as_ref()
                .map(|entry| entry.design_components.as_slice())
                .unwrap_or(&[]),
        );
        if brief.is_empty() {
            "make_deck needs a 'brief' describing the presentation.".to_string()
        } else {
            let workflow_plan = workflow_execution_plan(
                &make_deck_workflow_definition(),
                serde_json::json!({
                    "brief": brief.clone(),
                    "language": language.clone(),
                    "slides": slides,
                    "template_ref": template_ref.clone(),
                    "design_template": design_template.clone(),
                    "design_theme": design_theme.clone(),
                    "design_profile": design_profile.clone(),
                    "design_components": design_components.clone(),
                }),
            );
            let workflow_plan =
                match run_static_workflow_plan_through_brain_async(brief.clone(), workflow_plan)
                    .await
                {
                    Ok(plan) => plan,
                    Err(error) => {
                        eprintln!("make_deck: static workflow plan validation failed: {error}");
                        workflow_execution_plan(
                            &make_deck_workflow_definition(),
                            serde_json::json!({
                                "brief": brief.clone(),
                                "language": language.clone(),
                                "slides": slides,
                                "template_ref": template_ref.clone(),
                                "design_template": design_template.clone(),
                                "design_theme": design_theme.clone(),
                                "design_profile": design_profile.clone(),
                                "design_components": design_components.clone(),
                            }),
                        )
                    }
                };
            let thread_slug = artifact_thread_slug(ctx.thread_id);
            let _ = emit_stream_event(
                ctx.tx,
                GenerateStreamEvent::Delta {
                    text: "‹‹ACT››🎬 Building the deck (brand · content · images · render)‹‹/ACT››"
                        .to_string(),
                },
            )
            .await;
            // 1) brand into the output dir + load colours for prompts.
            let slug_b = thread_slug.clone();
            let _ = tokio::task::spawn_blocking(move || materialize_brand_kit(&slug_b)).await;
            let brand = tokio::task::spawn_blocking(load_brand_kit)
                .await
                .unwrap_or_default();
            // 2) slide content — schema-enforced model call (the floor).
            match generate_deck_content(
                &ctx.state.http,
                ctx.base_url,
                ctx.model,
                ctx.api_key.as_deref(),
                &brief,
                &brand,
                slides,
                &language,
                design_template.as_deref(),
                design_theme.as_deref(),
                design_profile.as_deref(),
                &design_components,
            )
            .await
            {
                Err(e) => make_deck_content_failure_message(
                    &e,
                    requested_template_ref.as_deref(),
                    template_ref.as_deref(),
                    ctx.base_url,
                    ctx.model,
                ),
                Ok(mut deck) => {
                    if let Err(error) = enforce_deck_slide_count(&mut deck, slides) {
                        return GatewayToolDispatch {
                            result: format!(
                                "MAKE_DECK_CONTENT_INVALID: {error}. No presentation was rendered; retry with a working content model."
                            ),
                            effects,
                            effect_status,
                        };
                    }
                    normalize_deck_model_content(&mut deck);
                    apply_deck_grounding_contract(&mut deck, &brief);
                    apply_deck_design_components(&mut deck, &design_components);
                    apply_deck_design_theme(&mut deck, design_theme.as_deref(), &brand);
                    // Carry only non-textual template chrome into generated content.
                    // Fail-open when the template is not a bundled presentation pack or
                    // its example.json is unreadable.
                    if let Some(pack) = deck_template_pack(catalog_template.as_ref())
                        && let Ok(example) = document_content::load_pack_example(pack)
                    {
                        apply_deck_template_chrome(&mut deck, &example);
                    }
                    let quality_issues = apply_deck_quality_guardrails(&mut deck);
                    if !quality_issues.is_empty() {
                        let _ = emit_stream_event(
                            ctx.tx,
                            GenerateStreamEvent::Delta {
                                text: format!(
                                    "‹‹ACT››🔎 Deck QA adjusted {} layout-risk items‹‹/ACT››",
                                    quality_issues.len()
                                ),
                            },
                        )
                        .await;
                    }
                    let semantic_errors = deck_semantic_quality_errors(&deck);
                    if !semantic_errors.is_empty() {
                        return GatewayToolDispatch {
                            result: format!(
                                "MAKE_DECK_CONTENT_INVALID: {}. No presentation was rendered; retry with a working content model.",
                                semantic_errors.join("; ")
                            ),
                            effects,
                            effect_status,
                        };
                    }
                    // 3) images for want_image slides (cap 3, cover first).
                    let accent = brand.accent_color.clone();
                    let mut made = 0usize;
                    if let Some(arr) = deck.get_mut("slides").and_then(|s| s.as_array_mut()) {
                        for (idx, slide) in arr.iter_mut().enumerate() {
                            if made >= 3 {
                                break;
                            }
                            if !slide
                                .get("want_image")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false)
                            {
                                continue;
                            }
                            let title = slide
                                .get("title")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let layout = slide
                                .get("layout")
                                .and_then(|v| v.as_str())
                                .unwrap_or("bullets")
                                .to_string();
                            let iname = if layout == "cover" {
                                "cover".to_string()
                            } else {
                                format!("s{idx}")
                            };
                            let prompt = deck_slide_image_prompt(&title, &accent);
                            let _ = emit_stream_event(
                                ctx.tx,
                                GenerateStreamEvent::Delta {
                                    text: format!(
                                        "‹‹ACT››🎨 Image: {}‹‹/ACT››",
                                        title.chars().take(40).collect::<String>()
                                    ),
                                },
                            )
                            .await;
                            if let Ok(bytes) =
                                generate_image_png(&ctx.state.http, &prompt, "1280x720").await
                            {
                                let fname = format!("{iname}.png");
                                let slug_w = thread_slug.clone();
                                let fname_w = fname.clone();
                                let w = tokio::task::spawn_blocking(move || {
                                    write_artifact_bytes(&slug_w, &fname_w, &bytes)
                                })
                                .await
                                .unwrap_or_else(|e| Err(format!("{e}")));
                                if w.is_ok() {
                                    slide["image"] = serde_json::json!(fname);
                                    if layout == "bullets" {
                                        slide["layout"] = serde_json::json!("image_right");
                                    }
                                    made += 1;
                                }
                            }
                        }
                    }
                    // 4) write deck.json.
                    let slide_count = deck
                        .get("slides")
                        .and_then(|s| s.as_array())
                        .map(|a| a.len())
                        .unwrap_or(0);
                    let deck_bytes = serde_json::to_vec_pretty(&deck).unwrap_or_default();
                    let slug_w = thread_slug.clone();
                    let write_res = tokio::task::spawn_blocking(move || {
                        write_artifact_bytes(&slug_w, "deck.json", &deck_bytes)
                    })
                    .await
                    .unwrap_or_else(|e| Err(format!("join error: {e}")));
                    if let Err(e) = write_res {
                        format!("Could not write deck.json: {e}")
                    } else {
                        let template_render_arg = match materialize_deck_template_source(
                            &thread_slug,
                            catalog_template.as_ref(),
                        ) {
                            Ok(Some(filename)) => {
                                let _ = emit_stream_event(
                                    ctx.tx,
                                    GenerateStreamEvent::Delta {
                                        text: "‹‹ACT››📐 Using imported PPTX template‹‹/ACT››"
                                            .to_string(),
                                    },
                                )
                                .await;
                                format!(" --template-pptx {filename}")
                            }
                            Ok(None) => String::new(),
                            Err(error) => {
                                let _ = emit_stream_event(
                                    ctx.tx,
                                    GenerateStreamEvent::Delta {
                                        text: format!(
                                            "‹‹ACT››⚠ Template source unavailable: {error}‹‹/ACT››"
                                        ),
                                    },
                                )
                                .await;
                                String::new()
                            }
                        };
                        // 5) render in the sandbox (no model shell).
                        let container_out = sandbox::container_output_dir(&thread_slug);
                        let cmd = format!(
                            "cd '{container_out}' && deck-render deck.json --prefix deck{template_render_arg} && \
                             chromium --headless --no-sandbox --disable-gpu --no-pdf-header-footer \
                             --print-to-pdf=deck.pdf deck.html >/dev/null 2>&1 && \
                             qa=$(deck-qa deck.html --json 2>&1); qa_code=$?; \
                             echo \"DECK_QA_JSON:$qa\"; \
                             if [ \"$qa_code\" -ne 0 ]; then exit \"$qa_code\"; fi; \
                             ls -la deck.pptx deck.html deck.pdf deck.json 2>&1"
                        );
                        sandbox_begin(cmd.clone(), ctx.thread_id.map(|s| s.to_string()));
                        let render =
                            tokio::task::spawn_blocking(move || sandbox::run_command(&cmd, None))
                                .await
                                .unwrap_or_else(|e| Err(format!("join error: {e}")));
                        let render_out = match render {
                            Ok(o) => o,
                            Err(e) => e,
                        };
                        sandbox_end(render_out.clone());
                        // 6) emit an artifact marker per produced file, even
                        // when QA flags issues: the generated files still need
                        // to be visible for review and iteration.
                        let qa_result = rendered_deck_qa_result(&render_out);
                        let quality_metadata =
                            deck_quality_metadata_from_qa_result(qa_result.as_ref());
                        let mut artifact_metadata =
                            deck_template_metadata(catalog_template.as_ref());
                        merge_object_metadata(&mut artifact_metadata, quality_metadata.as_ref());
                        let artifact_metadata_ref = artifact_metadata
                            .as_object()
                            .filter(|metadata| !metadata.is_empty())
                            .map(|_| &artifact_metadata);
                        // 5d.1b: append to a local buffer, flushed to `effects` after the call.
                        let mut deck_out = String::new();
                        let produced = emit_rendered_deck_artifacts(
                            ctx.state,
                            ctx.tx,
                            &mut deck_out,
                            ctx.thread_id,
                            &thread_slug,
                            "make_deck",
                            artifact_metadata_ref,
                            DECK_ARTIFACT_NAMES,
                        )
                        .await;
                        effects.append_output.push(deck_out);
                        if let Some(error) = rendered_deck_qa_failure(&render_out) {
                            format!(
                                "Deck created via workflow {} with visual QA issues: {error}. Files available: {}. The .pptx is editable; .html/.pdf are previews.",
                                workflow_plan
                                    .steps
                                    .first()
                                    .and_then(|step| step.arguments.get("workflow_id"))
                                    .and_then(|value| value.as_str())
                                    .unwrap_or("make_deck"),
                                if produced.is_empty() {
                                    "none".to_string()
                                } else {
                                    produced.join(", ")
                                },
                            )
                        } else {
                            if produced.iter().any(|fname| fname == "deck.pptx") {
                                // S2 T4: the deck was DELIVERED — clear the thread's
                                // routing binding so later turns aren't stuck forcing
                                // make_deck (the gateway executor clears the store).
                                effects.clear_routing_binding = true;
                                format!(
                                    "Deck created via workflow {}: {} ({slide_count} slides, {made} images). The .pptx is editable; .html/.pdf are previews; .json is the source contract. The deck is DONE — give the user a one-line summary.",
                                    workflow_plan
                                        .steps
                                        .first()
                                        .and_then(|step| step.arguments.get("workflow_id"))
                                        .and_then(|value| value.as_str())
                                        .unwrap_or("make_deck"),
                                    produced.join(", ")
                                )
                            } else {
                                format!(
                                    "Deck render did NOT produce a .pptx. Renderer output:\n{}",
                                    render_out.chars().take(800).collect::<String>()
                                )
                            }
                        }
                    }
                }
            }
        }
    } else if name == "make_document" {
        let mut parsed = serde_json::from_str::<serde_json::Value>(args_raw)
            .unwrap_or_else(|_| serde_json::json!({}));
        // S2 T4: same deterministic-binding merge as make_deck above — the bound
        // `template_ref` wins over whatever the model put (or omitted) in `args`, and
        // `document_generation_options` below reads it via `deliverable_template_ref`.
        if let Some(binding) = active_routing_binding(ctx.state, ctx.thread_id)
            && let Some(template_ref) = binding.args.get("template_ref").and_then(|v| v.as_str())
        {
            merge_bound_template_ref(&mut parsed, template_ref);
        }
        let brief = parsed
            .get("brief")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let language = parsed
            .get("language")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let fname = parsed
            .get("name")
            .and_then(|v| v.as_str())
            .filter(|value| !value.trim().is_empty())
            .map(|value| document_artifact_name(Some(value)))
            .or_else(|| document_artifact_name_from_brief(&brief))
            .unwrap_or_else(|| document_artifact_name(None));
        let formats = document_output_formats(&parsed, &fname, &brief);
        let document_options = document_generation_options(&parsed);
        if brief.is_empty() {
            "make_document needs a 'brief' describing the document.".to_string()
        } else {
            let workflow_args = serde_json::json!({
                "brief": brief.clone(),
                "language": language.clone(),
                "name": fname.clone(),
                "formats": formats.clone(),
                "template_ref": document_options.template_ref.clone(),
                "document_type": document_options.document_type.clone(),
                "audience": document_options.audience.clone(),
                "tone": document_options.tone.clone(),
                "layout_profile": document_options.layout_profile.clone(),
                "design_template": document_options.design_template.clone(),
                "design_theme": document_options.design_theme.clone(),
                "design_profile": document_options.design_profile.clone(),
                "design_components": document_options.design_components.clone(),
                "sections": document_options.sections.clone(),
            });
            let workflow_plan = workflow_execution_plan(
                &make_document_workflow_definition(),
                workflow_args.clone(),
            );
            let workflow_plan =
                match run_static_workflow_plan_through_brain_async(brief.clone(), workflow_plan)
                    .await
                {
                    Ok(plan) => plan,
                    Err(error) => {
                        eprintln!("make_document: static workflow plan validation failed: {error}");
                        workflow_execution_plan(&make_document_workflow_definition(), workflow_args)
                    }
                };
            let thread_slug = artifact_thread_slug(ctx.thread_id);
            // F2-T8: a template_ref resolving to a BUNDLED document pack gets the
            // templated pipeline (slot-filled doc.json -> container render ->
            // designed html/pdf/docx); everything else — no template, an imported
            // pack, or a presentation pack — keeps the Markdown path below
            // byte-identical to before this task.
            let catalog_template = template_catalog_by_id(document_options.template_ref.as_deref());
            match document_template_pack(catalog_template.as_ref()).cloned() {
                None => {
                    let _ = emit_stream_event(
                    ctx.tx,
                    GenerateStreamEvent::Delta {
                        text: "‹‹ACT››📝 Building the document (brief · draft · artifact · memory)‹‹/ACT››".to_string(),
                    },
                )
                .await;
                    match generate_document_markdown(
                        &ctx.state.http,
                        ctx.base_url,
                        ctx.model,
                        ctx.api_key.as_deref(),
                        &brief,
                        &language,
                        &document_options,
                    )
                    .await
                    {
                        Err(error) => {
                            format!("Could not generate document content: {error}")
                        }
                        Ok(markdown) => {
                            let markdown = apply_document_design_components(
                                &markdown,
                                &document_options.design_components,
                            );
                            let (markdown, repaired_issues) =
                                apply_document_quality_guardrails(&markdown);
                            let quality_issues = document_quality_issues(&markdown);
                            if !repaired_issues.is_empty() && quality_issues.is_empty() {
                                let _ = emit_stream_event(
                                ctx.tx,
                                GenerateStreamEvent::Delta {
                                    text: format!(
                                        "‹‹ACT››🔎 Document QA repaired {} table-layout items‹‹/ACT››",
                                        repaired_issues.len()
                                    ),
                                },
                            )
                            .await;
                            }
                            if !quality_issues.is_empty() {
                                let summary = quality_issues
                                    .iter()
                                    .take(5)
                                    .cloned()
                                    .collect::<Vec<_>>()
                                    .join("; ");
                                format!(
                                    "Could not generate document artifact: document QA failed: {summary}"
                                )
                            } else {
                                let mut produced = Vec::new();
                                let mut artifact_error: Option<String> = None;
                                for format in formats {
                                    let artifact_name = document_artifact_name_with_extension(
                                        Some(&fname),
                                        &format,
                                    );
                                    let slug_w = thread_slug.clone();
                                    let fname_w = artifact_name.clone();
                                    let markdown_w = markdown.clone();
                                    let result = tokio::task::spawn_blocking(move || {
                                        if format == "pdf" {
                                            let title = fname_w
                                                .trim_end_matches(".pdf")
                                                .trim_end_matches(".PDF");
                                            let bytes =
                                                pdf_render::markdown_to_pdf(title, &markdown_w)
                                                    .map_err(|e| {
                                                        format!("PDF render failed: {e}")
                                                    })?;
                                            write_artifact_bytes(&slug_w, &fname_w, &bytes)
                                        } else if format == "docx" {
                                            let title = fname_w
                                                .trim_end_matches(".docx")
                                                .trim_end_matches(".DOCX");
                                            let bytes = markdown_to_docx(title, &markdown_w)
                                                .map_err(|e| format!("DOCX render failed: {e}"))?;
                                            write_artifact_bytes(&slug_w, &fname_w, &bytes)
                                        } else {
                                            write_text_artifact(&slug_w, &fname_w, &markdown_w)
                                        }
                                    })
                                    .await
                                    .unwrap_or_else(|error| Err(format!("Error: {error}")));
                                    match result {
                                        Ok((size, updated)) => {
                                            let marker = serde_json::json!({
                                                "name": artifact_name,
                                                "thread": thread_slug,
                                                "size": size,
                                                "updated": updated,
                                                "source": "managed",
                                                "managed_path": sandbox::artifacts_dir()
                                                    .join(&thread_slug)
                                                    .join(&artifact_name)
                                                    .to_string_lossy()
                                                    .to_string(),
                                            });
                                            let artifact_mark =
                                                format!("‹‹ARTIFACT››{marker}‹‹/ARTIFACT››");
                                            effects.append_output.push(artifact_mark.clone());
                                            let _ = emit_stream_event(
                                                ctx.tx,
                                                GenerateStreamEvent::Delta {
                                                    text: artifact_mark,
                                                },
                                            )
                                            .await;
                                            let artifact_name = marker
                                                .get("name")
                                                .and_then(|value| value.as_str())
                                                .unwrap_or("document.md")
                                                .to_string();
                                            register_artifact_memory(
                                                ctx.state,
                                                ctx.thread_id,
                                                &thread_slug,
                                                &artifact_name,
                                                size,
                                                updated,
                                                "make_document",
                                                None,
                                            )
                                            .await;
                                            produced.push(artifact_name);
                                        }
                                        Err(error) => {
                                            artifact_error = Some(error);
                                            break;
                                        }
                                    }
                                }
                                if let Some(error) = artifact_error {
                                    error
                                } else {
                                    // S2 T4: the document was DELIVERED — clear the thread's
                                    // routing binding (mirrors the make_deck success arm).
                                    effects.clear_routing_binding = true;
                                    format!(
                                        "Document created via workflow {}: {}. The document is DONE — give the user a one-line summary.",
                                        workflow_plan
                                            .steps
                                            .first()
                                            .and_then(|step| step.arguments.get("workflow_id"))
                                            .and_then(|value| value.as_str())
                                            .unwrap_or("make_document"),
                                        produced.join(", "),
                                    )
                                }
                            }
                        }
                    }
                }
                Some(entry) => {
                    let workflow_id = workflow_plan
                        .steps
                        .first()
                        .and_then(|step| step.arguments.get("workflow_id"))
                        .and_then(|value| value.as_str())
                        .unwrap_or("make_document")
                        .to_string();
                    let (result, delivered) = make_templated_document(
                        ctx,
                        &mut effects.append_output,
                        &thread_slug,
                        &workflow_id,
                        &document_options,
                        &fname,
                        &brief,
                        &language,
                        entry,
                    )
                    .await;
                    // S2 T4: the templated document was DELIVERED — clear the thread's
                    // routing binding (mirrors the make_deck / markdown-path arms).
                    if delivered {
                        effects.clear_routing_binding = true;
                    }
                    result
                }
            }
        }
    } else if name == "save_artifact" {
        // Deliver a generated artifact to an authorized destination
        // (gateway performs the copy host-side, scoped to grants).
        let parsed = serde_json::from_str::<serde_json::Value>(args_raw)
            .unwrap_or_else(|_| serde_json::json!({}));
        let file = parsed
            .get("file")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let dest_name = parsed
            .get("destination")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let thread_slug = artifact_thread_slug(ctx.thread_id);
        let _ = emit_stream_event(
            ctx.tx,
            GenerateStreamEvent::Delta {
                text: format!("‹‹ACT››💾 Saving {file} to «{dest_name}»‹‹/ACT››"),
            },
        )
        .await;
        tokio::task::spawn_blocking(move || {
            save_artifact_to_destination(&thread_slug, &file, &dest_name)
        })
        .await
        .unwrap_or_else(|e| format!("Save error: {e}"))
    } else if name == "recall_memory" {
        // PERIMETER (anti-exfiltration): a `contact_only` turn (a non-self
        // contact on a channel) must NOT reach personal/Secret memory or the
        // relationship graph. recall_memory is perimeter-blind by design, so we
        // refuse it here — the contact's own conversation is already in context.
        // Also refused when can_see_contacts is off (even on a "personal"-scope
        // contact): recall traverses the relationship graph, which IS the address
        // book — perimeter-blind recall has no way to strip other people out, so
        // fail-closed is to block it entirely.
        let in_project = gateway_memory_workspace_id().as_str() != PERSONAL_WORKSPACE;
        if !memory_perimeter_allows_recall(ctx.contact_memory_perimeter, in_project) {
            "Personal memory not accessible in a conversation with this \
contact: use only the messages from this chat. Do NOT reveal personal data of the user or third parties."
                .to_string()
        } else {
            let query = serde_json::from_str::<serde_json::Value>(args_raw)
                .ok()
                .and_then(|a| a.get("query").and_then(|q| q.as_str()).map(String::from))
                .unwrap_or_default();
            // ADR 0022 (Piano UI A2/A3): emetti l'evento strutturato
            // `Recall` con i hits richiamati (visibile in UI: fase
            // recalling + badge). Sostituisce il delta `‹‹ACT››🧠`.
            let st = ctx.state.clone();
            let recall_query = query.clone();
            let vault_value_requested = ctx.memory_intent.vault_value_requested;
            let outcome = tokio::task::spawn_blocking(move || {
                recall_memory(&st, &recall_query, vault_value_requested)
            })
            .await
            .unwrap_or_else(|e| RecallOutcome {
                response: format!("Execution error: {e}"),
                payload: local_first_subagents::RecallStreamPayload {
                    query: "(query)".to_string(),
                    hits: Vec::new(),
                    scope: "personal".to_string(),
                    status: "unavailable".to_string(),
                },
            });
            let payload = recall_stream_payload_from_outcome(&outcome, &query);
            let recall_effects = memory_read_effects_from_recall_payload(&payload);
            effects.memory_reads.extend(recall_effects.memory_reads);
            let _ = emit_stream_event(ctx.tx, GenerateStreamEvent::Recall { payload }).await;
            outcome.response
        }
    } else if name == "query_code_graph" {
        let symbol = serde_json::from_str::<serde_json::Value>(args_raw)
            .ok()
            .and_then(|a| a.get("symbol").and_then(|s| s.as_str()).map(String::from))
            .unwrap_or_default();
        let _ = emit_stream_event(
            ctx.tx,
            GenerateStreamEvent::Delta {
                text: format!("‹‹ACT››🗺️ Exploring the code map: {symbol}‹‹/ACT››"),
            },
        )
        .await;
        let st = ctx.state.clone();
        tokio::task::spawn_blocking(move || query_code_graph(&st, &symbol))
            .await
            .unwrap_or_else(|e| format!("Execution error: {e}"))
    } else if name == "query_git_history" {
        let query = serde_json::from_str::<serde_json::Value>(args_raw)
            .ok()
            .and_then(|a| a.get("query").and_then(|s| s.as_str()).map(String::from))
            .unwrap_or_default();
        let _ = emit_stream_event(
            ctx.tx,
            GenerateStreamEvent::Delta {
                text: format!("‹‹ACT››🕰️ Checking git history: {query}‹‹/ACT››"),
            },
        )
        .await;
        tokio::task::spawn_blocking(move || query_git_history(&query))
            .await
            .unwrap_or_else(|e| format!("Execution error: {e}"))
    } else if name == "resolve_datetime" {
        // Layer C: the orchestrator passes a STRUCTURED intent it
        // distilled from the user's phrasing (any language); jiff
        // does the arithmetic from the tz-aware "now" and validates
        // future/range. Deterministic — no model date math.
        let args_val = serde_json::from_str::<serde_json::Value>(args_raw)
            .unwrap_or_else(|_| serde_json::json!({}));
        let must_be_future = args_val
            .get("must_be_future")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let anchor = now_local();
        match temporal::intent_from_json(&args_val).and_then(|intent| {
            temporal::resolve(&intent, &anchor, temporal::ResolveOpts { must_be_future })
        }) {
            Ok(res) => {
                let _ = emit_stream_event(
                    ctx.tx,
                    GenerateStreamEvent::Delta {
                        text: format!("‹‹ACT››🗓 Date resolved: {}‹‹/ACT››", res.human),
                    },
                )
                .await;
                let window = match &res.end {
                    Some(end) => format!(
                        " The time window runs until {:02}:{:02}.",
                        end.hour(),
                        end.minute()
                    ),
                    None => String::new(),
                };
                format!(
                    "Date/time resolved: {human}. Use EXACTLY «{iso}» as the value \
(e.g. to write in the form or pass to another tool): do NOT recompute it.{window} \
(Now {now}.)",
                    human = res.human,
                    iso = res.iso,
                    window = window,
                    now = now_block(),
                )
            }
            Err(e) => format!(
                "⚠️ I couldn't resolve the date: {e}. (Now {now}.) \
Fix the parameters (kind/offset_days/weekday/date/time) and try again; do not proceed with \
an uncertain date.",
                now = now_block(),
            ),
        }
    } else if name == "record_decision" {
        let args_val: serde_json::Value =
            serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
        let _ = emit_stream_event(
            ctx.tx,
            GenerateStreamEvent::Delta {
                text: "‹‹ACT››🧠 Recording the decision in memory‹‹/ACT››".to_string(),
            },
        )
        .await;
        let st = ctx.state.clone();
        tokio::task::spawn_blocking(move || record_decision(&st, &args_val))
            .await
            .unwrap_or_else(|e| format!("Execution error: {e}"))
    } else if name == "forget_memory" {
        let args_val: serde_json::Value =
            serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
        let _ = emit_stream_event(
            ctx.tx,
            GenerateStreamEvent::Delta {
                text: "‹‹ACT››🗑️ Forgetting from memory‹‹/ACT››".to_string(),
            },
        )
        .await;
        let st = ctx.state.clone();
        tokio::task::spawn_blocking(move || forget_memory(&st, &args_val))
            .await
            .unwrap_or_else(|e| format!("Execution error: {e}"))
    } else if name == "update_plan" || name == "step_advance" {
        // `step_advance` reports progress on a SINGLE step by id (no need to
        // re-send the whole plan → weak-model-proof, no ballooning). It maps to
        // a one-element `sent` and rides the exact same merge + F2-verify path.
        let (sent_goal, sent) = match plan_tool_sent(name, args_raw) {
            Ok(sent) => sent,
            Err(result) => {
                return GatewayToolDispatch {
                    result,
                    effects,
                    effect_status,
                };
            }
        };
        // The plan's `goal` rides the canonical plan Value: a sent goal (plan creation)
        // wins, else preserve whatever goal the canonical plan already carries.
        let plan_goal = resolve_plan_goal_for_turn(
            sent_goal,
            plan_value_goal(ctx.plan),
            objective_contract_for_execution(ctx.state, ctx.thread_id)
                .map(|record| record.objective),
        );
        // 5d.1b: work on a LOCAL copy of the plan (merge mutates in place, and the arm rereads it
        // below); the final plan is returned as an effect (`effects.plan`) and applied after the call.
        // P5: `ctx.plan` is now the opaque `Value`; convert to the typed plan the merge needs.
        let mut current_plan = plan_value_from(ctx.plan);
        // Status snapshot BEFORE the merge/F2 pass: diffed against the final canonical
        // statuses to emit one `step_advance` stream event per changed step.
        let pre_statuses: Vec<(String, String)> = execution_plan_steps(&current_plan)
            .iter()
            .map(|s| {
                (
                    plan_step_id(s)
                        .map(str::to_string)
                        .unwrap_or_else(|| plan_step_title(s).to_string()),
                    plan_step_status(s).to_string(),
                )
            })
            .collect();
        // MERGE the model's steps into the CANONICAL plan (never replace);
        // returns the canonical indices newly claimed done (held `doing`
        // until F2 verifies). See `merge_plan` for the anti-reset rule.
        let claims = merge_execution_plan(&mut current_plan, &sent);
        let mut plan_steps = execution_plan_steps(&current_plan);
        // DIAG (HOMUN_DEBUG): the plan lifecycle, to see if the model
        // re-proposes the whole plan (churn) or advances one step, and
        // whether a re-proposal RESETS statuses (the "il piano riparta"
        // symptom). One line per update_plan/step_advance call.
        if verbose_debug() {
            let sig = |s: &serde_json::Value| {
                format!(
                    "{}:{}",
                    s.get("id").and_then(|v| v.as_str()).unwrap_or("?"),
                    s.get("status").and_then(|v| v.as_str()).unwrap_or("?")
                )
            };
            let sent_sig: Vec<String> = sent.iter().map(&sig).collect();
            let plan_sig: Vec<String> = plan_steps.iter().map(&sig).collect();
            eprintln!(
                "[plan] {name}: sent[{}]=[{}] → canonical[{}]=[{}]",
                sent.len(),
                sent_sig.join(","),
                plan_steps.len(),
                plan_sig.join(",")
            );
        }
        if plan_steps.is_empty() {
            "Empty plan: provide at least one step with a title.".to_string()
        } else {
            // F2 gate: verify each newly-claimed-done step before it counts
            // (using the evidence gathered since the last completed step).
            let verify = step_verification_enabled();
            // Snapshot the step evidence ONCE for the whole batch of claims. Previously
            // the first verified step cleared `step_evidence` mid-loop, so the REST of a
            // batch saw "(no tool activity)" and the strict judge rejected them — leaving
            // steps the model actually finished stuck at "doing" (the real reason
            // "progress never advances" even on a strong model). And with NO evidence to
            // verify against, don't hold a step hostage: trust the claim (there is nothing
            // to check). This evidence-based rule is uniform for every model. NOTE: a
            // recorded external-action failure (`[external_action_failed]` marker from the
            // loop) IS evidence, so a claim shadowed by failed external actions never
            // reaches this blind-trust path — it hits the deterministic backstop + judge
            // inside `verify_step_complete` instead.
            let batch_evidence = ctx.step_evidence.join("\n");
            let has_evidence = !batch_evidence.is_empty();
            let mut any_verified = false;
            let mut rejection: Option<String> = None;
            for i in claims {
                let title = plan_step_title(&plan_steps[i]).to_string();
                let criterion = plan_steps[i]
                    .get("done_criterion")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let (ok, reason) = if verify && has_evidence {
                    verify_step_complete(&ctx.state.http, &title, &criterion, &batch_evidence).await
                } else {
                    // Verification off, or nothing to verify against → trust the claim.
                    (true, String::new())
                };
                if ok {
                    plan_steps[i]["status"] = serde_json::json!("done");
                    let verified_step = plan_steps[i].clone();
                    let verified_evidence = ctx.step_evidence.clone();
                    let st = ctx.state.clone();
                    let thread_for_memory = ctx.thread_id.map(|s| s.to_string());
                    let _ = tokio::task::spawn_blocking(move || {
                        record_runtime_plan_step_outcome_from_state(
                            &st,
                            thread_for_memory.as_deref(),
                            &verified_step,
                            &verified_evidence,
                        );
                    })
                    .await;
                    current_plan = runtime_execution_plan(&plan_steps);
                    any_verified = true;
                    // The stall-guard reset (F1), compaction request (F3), and evidence clear are
                    // idempotent per verified step → hoisted to one `if any_verified` below (effects).
                    if verify {
                        let _ = emit_stream_event(
                            ctx.tx,
                            GenerateStreamEvent::Delta {
                                text: format!(
                                    "‹‹ACT››✓ Step verified: {}‹‹/ACT››",
                                    title.chars().take(60).collect::<String>()
                                ),
                            },
                        )
                        .await;
                    }
                } else {
                    rejection = Some(format!(
                        "Step «{title}» is NOT verified complete: {}. Keep working on it — re-mark it done ONLY once its result actually exists.",
                        if reason.is_empty() {
                            "the evidence does not show it was finished"
                        } else {
                            &reason
                        }
                    ));
                    break;
                }
            }
            // The verified step(s) consumed this evidence window — clear it ONCE, after the whole
            // batch. On real progress also reset the stall guards (F1) and request compaction (F3):
            // all three were per-step-idempotent inline, hoisted here as effects.
            if any_verified {
                effects.clear_evidence = true;
                effects.reset_stall_guards = true;
                effects.request_compaction = true;
            }
            // Marker rendered from the CANONICAL plan — the single source of
            // truth (verified state), not the model's raw claim. This is what
            // the UI shows and what the next turn resumes from.
            plan_steps = execution_plan_steps(&current_plan);
            // step_advance stream events: diff canonical statuses before/after the merge + F2.
            // A status change to `done` here passed F2 (verified=true); a rejected claim keeps
            // its status but still surfaces as doing→doing with verified=false + reason.
            for step in &plan_steps {
                let step_id = plan_step_id(step)
                    .map(str::to_string)
                    .unwrap_or_else(|| plan_step_title(step).to_string());
                let after = plan_step_status(step).to_string();
                let before = pre_statuses
                    .iter()
                    .find(|(id, _)| *id == step_id)
                    .map(|(_, status)| status.clone());
                if before.as_deref() == Some(after.as_str()) {
                    continue;
                }
                emit_step_advance_event(
                    ctx.tx,
                    &step_id,
                    plan_step_title(step),
                    before.as_deref(),
                    &after,
                    if after == "done" { Some(true) } else { None },
                    None,
                )
                .await;
            }
            if let Some(reason) = rejection.as_deref()
                && let Some(step) = sent.first()
            {
                // Rejected claim: status stays `doing` — the event carries the rejection.
                let step_id = plan_step_id(step)
                    .map(str::to_string)
                    .unwrap_or_else(|| plan_step_title(step).to_string());
                emit_step_advance_event(
                    ctx.tx,
                    &step_id,
                    plan_step_title(step),
                    Some("doing"),
                    "doing",
                    Some(false),
                    Some(reason),
                )
                .await;
            }
            // The whole merged/verified plan is the effect the caller applies to `ctx.plan` — in the
            // CANONICAL shape, so the loop's own plan-driven controls can read the frontier back.
            effects.plan = Some(canonical_plan_value(plan_goal.as_deref(), &plan_steps));
            let plan_mark = format!(
                "‹‹PLAN››{}‹‹/PLAN››",
                build_plan_markdown(plan_goal.as_deref(), &plan_steps)
            );
            effects.append_output.push(plan_mark.clone());
            let _ = emit_stream_event(ctx.tx, GenerateStreamEvent::Delta { text: plan_mark }).await;
            upsert_runtime_plan_memory_from_state(
                ctx.state,
                ctx.thread_id,
                plan_goal.as_deref(),
                &plan_steps,
            );
            // Turn trace: record the plan op with the model's SENT step statuses vs the CANONICAL
            // (merged/verified) ones — observability only, never influences the merge.
            ctx.turn_trace
                .record(local_first_engine::turn_trace::TurnEvent::Plan {
                    op: name.to_string(),
                    sent: sent
                        .iter()
                        .map(|s| plan_step_status(s).to_string())
                        .collect(),
                    canonical: plan_steps
                        .iter()
                        .map(|s| plan_step_status(s).to_string())
                        .collect(),
                });
            let done = plan_done_count(&plan_steps);
            match rejection {
                Some(msg) => format!("⚠️ {msg} (done {done}/{})", plan_steps.len()),
                None => {
                    format!("Plan updated: {done}/{} steps done.", plan_steps.len())
                }
            }
        }
    } else if name == "create_automation" {
        let _ = emit_stream_event(
            ctx.tx,
            GenerateStreamEvent::Delta {
                text: "‹‹ACT››⚡ Creating an automation‹‹/ACT››".to_string(),
            },
        )
        .await;
        create_automation_from_chat(
            ctx.state,
            args_raw,
            ctx.automation_user_id,
            ctx.automation_workspace_id,
        )
    } else if name == "update_automation" {
        let _ = emit_stream_event(
            ctx.tx,
            GenerateStreamEvent::Delta {
                text: "‹‹ACT››⚡ Updating an automation‹‹/ACT››".to_string(),
            },
        )
        .await;
        update_automation_from_chat(
            ctx.state,
            args_raw,
            ctx.automation_user_id,
            ctx.automation_workspace_id,
        )
    } else if name == "find_capability" {
        // Tool Search: discover DEFERRED native tools by intent and activate
        // them (push into the live tool set) so the model calls them next
        // round — same mechanism as find_connected_tools, for built-in tools.
        let parsed = serde_json::from_str::<serde_json::Value>(args_raw).ok();
        let intent = parsed
            .as_ref()
            .and_then(|a| {
                a.get("intent")
                    .or_else(|| a.get("query"))
                    .and_then(|v| v.as_str())
                    .map(String::from)
            })
            .unwrap_or_default();
        let _ = emit_stream_event(
            ctx.tx,
            GenerateStreamEvent::Delta {
                text: format!(
                    "‹‹ACT››🧭 Searching for a capability: {}‹‹/ACT››",
                    if intent.is_empty() {
                        "(intent)"
                    } else {
                        intent.as_str()
                    }
                ),
            },
        )
        .await;
        let mut lines = Vec::new();
        let mut discovered_entries: Vec<CapabilityEntry> = Vec::new();
        // In-house tools + skills (BM25 over the unified corpus).
        for entry in bm25_rank(ctx.capability_corpus, &intent, 6) {
            if entry.is_skill {
                lines.push(format!(
                    "- skill «{}»: {} → load it with use_skill(\"{}\")",
                    entry.key, entry.desc, entry.key
                ));
                discovered_entries.push(entry.clone());
            } else if entry.source == CapabilitySource::TemplateCatalog {
                lines.push(format!(
                    "- template «{}»: {} → pass template_ref=\"{}\" to make_deck/make_document",
                    entry.key, entry.desc, entry.key
                ));
                discovered_entries.push(entry.clone());
            } else if let Some(schema) = &entry.schema {
                effects.load_tools.push(local_first_engine::LoadedTool {
                    key: entry.key.clone(),
                    schema: Some(schema.clone()),
                });
                let label = capability_source_label(entry.source);
                lines.push(format!("- {label} «{}»: {}", entry.key, entry.desc));
                discovered_entries.push(entry.clone());
            }
        }
        // Connected services (toolkit-aware): activate the matching toolkit's
        // tools so the model sees its full CRUD together. Channels: READ only.
        // contact_only turns: don't surface connected services at all (the
        // dispatch refuses them anyway — this just avoids a wasted round).
        // Capabilities that MATCHED the query but were withheld by this conversation's perimeter or by
        // read-only mode. Without this the empty result told the model to "rephrase" — but the filters
        // are on tool IDENTITY, not on the wording, so rephrasing could never work and the model kept
        // re-querying with synonyms.
        let contact_memory_perimeter = ctx.contact_memory_perimeter;
        let mut withheld = 0usize;
        if !ctx.catalog_index.is_empty() && !contact_memory_perimeter.contact_only {
            for entry in search_connector_capability_entries(
                ctx.catalog_index,
                &intent,
                COMPOSIO_DISCOVERY_RESULTS,
            ) {
                if ctx.turn_policy.read_only && !composio_tool_is_read(&entry.key) {
                    withheld += 1;
                    continue;
                }
                // PERIMETER: don't even surface calendar/contacts tools when the
                // matching axis is off (the dispatch refuses them anyway).
                if !contact_memory_perimeter.can_see_calendar && tool_touches_calendar(&entry.key) {
                    withheld += 1;
                    continue;
                }
                if !contact_memory_perimeter.can_see_contacts && tool_touches_contacts(&entry.key) {
                    withheld += 1;
                    continue;
                }
                effects.load_tools.push(local_first_engine::LoadedTool {
                    key: entry.key.clone(),
                    schema: entry.schema.clone(),
                });
                lines.push(format!("- connector «{}»: {}", entry.key, entry.desc));
                discovered_entries.push(entry);
            }
        }
        if ctx.tool_trace.len() < 20
            && let Some(trace_line) = capability_discovery_trace_line(&intent, &discovered_entries)
        {
            effects.trace.push(trace_line);
        }
        if lines.is_empty() {
            if withheld > 0 {
                format!(
                    "No capability is available here. {withheld} matched your query but are outside this \
conversation's permissions (read-only mode, or calendar/contacts access is off) — rephrasing will NOT \
change that. Continue with what you can do, and tell the user which access would be needed."
                )
            } else {
                "No capability matches. Rephrase with what you want to do (e.g. \
\"browse the web\", \"search GitHub\", \"read the user's files\", \"send an email\")."
                    .to_string()
            }
        } else {
            format!(
                "Capabilities found (the tools are now CALLABLE; skills are \
loaded with use_skill):\n{}",
                lines.join("\n")
            )
        }
    } else if name == "schedule_task" {
        let args_val: serde_json::Value =
            serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
        let goal = args_val
            .get("goal")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let every = args_val
            .get("every")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let timezone = args_val
            .get("timezone")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        if goal.is_empty() || every.is_empty() {
            "Scheduling requires 'goal' (what to do) and 'every' (how often: \
\"every 1d\", \"daily@08:00\", \"weekly@mon@09:30\")."
                .to_string()
        } else {
            let _ = emit_stream_event(
                ctx.tx,
                GenerateStreamEvent::Delta {
                    text: format!("‹‹ACT››⏰ Scheduling: {goal} ({every})‹‹/ACT››"),
                },
            )
            .await;
            // Route through the first-class Automation model so a chat-
            // scheduled task shows up in the Automazioni view (not a hidden run).
            let st = ctx.state.clone();
            let user_id = ctx.automation_user_id.clone();
            let workspace_id = ctx.automation_workspace_id.clone();
            let title: String = goal.chars().take(48).collect();
            let auto_args = serde_json::json!({
                "title": title,
                "prompt": goal,
                "trigger_type": "schedule",
                "recurrence": every,
                "timezone": timezone,
            })
            .to_string();
            tokio::task::spawn_blocking(move || {
                create_automation_from_chat(&st, &auto_args, &user_id, &workspace_id)
            })
            .await
            .unwrap_or_else(|e| format!("Scheduling error: {e}"))
        }
    } else if name == "read_file" {
        let args_val: serde_json::Value =
            serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
        let path = args_val
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let _ = emit_stream_event(
            ctx.tx,
            GenerateStreamEvent::Delta {
                text: format!("‹‹ACT››📄 Reading {path}‹‹/ACT››"),
            },
        )
        .await;
        let st = ctx.state.clone();
        let tid = ctx.thread_id.map(|s| s.to_string());
        let recall_path = path.clone();
        let mut out =
            tokio::task::spawn_blocking(move || read_project_file(&st, tid.as_deref(), &path))
                .await
                .unwrap_or_else(|e| format!("Error: {e}"));
        // Per-file recall: surface past DECISIONS about this file so the
        // agent remembers WHY it's like this instead of re-deriving it.
        let st2 = ctx.state.clone();
        if let Some(note) = tokio::task::spawn_blocking(move || {
            let facade = memory_facade(&st2);
            let user = gateway_memory_user_id();
            let workspace = gateway_memory_workspace_id();
            decisions_for_path(facade, &user, &workspace, &recall_path)
        })
        .await
        .ok()
        .flatten()
        {
            out.push_str("\n\n");
            out.push_str(&note);
        }
        out
    } else if name == "write_file" {
        let args_val: serde_json::Value =
            serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
        let path = args_val
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let content = args_val
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let _ = emit_stream_event(
            ctx.tx,
            GenerateStreamEvent::Delta {
                text: format!("‹‹ACT››✍️ Scrivo {path}‹‹/ACT››"),
            },
        )
        .await;
        let st = ctx.state.clone();
        let tid = ctx.thread_id.map(|s| s.to_string());
        let path_for_memory = path.clone();
        let content_len = content.len() as u64;
        let result = tokio::task::spawn_blocking(move || {
            write_project_file(&st, tid.as_deref(), &path, &content)
        })
        .await
        .unwrap_or_else(|e| format!("Error: {e}"));
        if result.starts_with("✅ Wrote ") {
            register_project_file_artifact_memory(
                ctx.state,
                ctx.thread_id,
                &path_for_memory,
                content_len,
                "write_file",
            )
            .await;
        }
        emit_read_only_block_if_needed(ctx, &mut effects, &result).await;
        result
    } else if name == "edit_file" {
        let args_val: serde_json::Value =
            serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
        let path = args_val
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let old = args_val
            .get("old_string")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let new = args_val
            .get("new_string")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let _ = emit_stream_event(
            ctx.tx,
            GenerateStreamEvent::Delta {
                text: format!("‹‹ACT››✏️ Modifico {path}‹‹/ACT››"),
            },
        )
        .await;
        let st = ctx.state.clone();
        let tid = ctx.thread_id.map(|s| s.to_string());
        let result = tokio::task::spawn_blocking(move || {
            edit_project_file(&st, tid.as_deref(), &path, &old, &new)
        })
        .await
        .unwrap_or_else(|e| format!("Error: {e}"));
        emit_read_only_block_if_needed(ctx, &mut effects, &result).await;
        result
    } else if name == "apply_patch" {
        let args_val: serde_json::Value =
            serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
        let input = args_val
            .get("input")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let _ = emit_stream_event(
            ctx.tx,
            GenerateStreamEvent::Delta {
                text: "‹‹ACT››🩹 Applying patch‹‹/ACT››".to_string(),
            },
        )
        .await;
        // Gating mirrors edit_file/write_file: the OS fence is unconditional, `ctx.turn_policy.read_only`
        // channel turns already refused this above (allowlist), and confinement to the project
        // root happens inside `apply_patch_in_project` via `jail_in_root` — no path escapes.
        // A missing project folder surfaces as the `Err(msg)` arm (no_project_folder_msg).
        let st = ctx.state.clone();
        let tid = ctx.thread_id.map(|s| s.to_string());
        let apply_result = tokio::task::spawn_blocking(move || {
            apply_patch_in_project(&st, tid.as_deref(), &input)
        })
        .await
        .unwrap_or_else(|e| Err(format!("Error: {e}")));
        let patch_result = match apply_result {
            Ok(files) => {
                // Emit a structured diff card per touched file (‹‹DIFF›› marker), and
                // register artifact memory for each written path (skip deletions).
                let mut names: Vec<String> = Vec::with_capacity(files.len());
                for file in &files {
                    names.push(file.path.clone());
                    if !file.deleted {
                        let payload = local_first_subagents::DiffStreamPayload {
                            path: file.path.clone(),
                            label: Some(format!("apply_patch: {}", file.path)),
                            old: file.old.clone(),
                            new: file.new.clone(),
                            language: None,
                        };
                        if let Ok(json) = serde_json::to_string(&payload) {
                            let _ = emit_stream_event(
                                ctx.tx,
                                GenerateStreamEvent::Delta {
                                    text: format!("‹‹DIFF››{json}‹‹/DIFF››"),
                                },
                            )
                            .await;
                        }
                        register_project_file_artifact_memory(
                            ctx.state,
                            ctx.thread_id,
                            &file.path,
                            file.new.len() as u64,
                            "apply_patch",
                        )
                        .await;
                    }
                }
                if names.is_empty() {
                    "Applied patch (no files changed).".to_string()
                } else {
                    format!("Applied patch. Updated: {}", names.join(", "))
                }
            }
            Err(msg) => msg,
        };
        emit_read_only_block_if_needed(ctx, &mut effects, &patch_result).await;
        patch_result
    } else if name == "list_files" {
        let _ = emit_stream_event(
            ctx.tx,
            GenerateStreamEvent::Delta {
                text: "‹‹ACT››📂 Exploring the project‹‹/ACT››".to_string(),
            },
        )
        .await;
        let st = ctx.state.clone();
        let tid = ctx.thread_id.map(|s| s.to_string());
        tokio::task::spawn_blocking(move || list_project_files(&st, tid.as_deref()))
            .await
            .unwrap_or_else(|e| format!("Error: {e}"))
    } else if name == "list_directory" || name == "read_text_file" {
        let is_read = name == "read_text_file";
        let args_val: serde_json::Value =
            serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
        let p = args_val
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let st = ctx.state.clone();
        let tid = ctx.thread_id.map(|s| s.to_string());
        let pr = p.clone();
        let resolved =
            tokio::task::spawn_blocking(move || fs_resolve_authorized(&st, tid.as_deref(), &pr))
                .await
                .unwrap_or_else(|_| Err(FsAuthIssue::Invalid("internal error".to_string())));
        match resolved {
            Ok(path) => {
                let icon = if is_read {
                    "📄 Reading"
                } else {
                    "📂 Listing"
                };
                let _ = emit_stream_event(
                    ctx.tx,
                    GenerateStreamEvent::Delta {
                        text: format!("‹‹ACT››{icon} {p}‹‹/ACT››"),
                    },
                )
                .await;
                tokio::task::spawn_blocking(move || {
                    if is_read {
                        fs_read_text(&path)
                    } else {
                        fs_list_dir_contents(&path)
                    }
                })
                .await
                .unwrap_or_else(|e| format!("Error: {e}"))
            }
            Err(FsAuthIssue::Invalid(msg)) => msg,
            Err(FsAuthIssue::NeedsAuth(path)) => {
                // In-chat authorize card: grant access WITHOUT going to Settings.
                let marker = serde_json::json!({
                    "path": path.display().to_string(),
                    "op": if is_read { "read" } else { "list" }
                })
                .to_string();
                let card = format!(
                    "\n\nTo access this folder I need your authorization.\n\
‹‹FS_AUTHORIZE››{marker}‹‹/FS_AUTHORIZE››\n"
                );
                effects.append_output.push(card.clone());
                let _ = emit_stream_event(ctx.tx, GenerateStreamEvent::Delta { text: card }).await;
                effects.request_confirm = true;
                "AWAITING AUTHORIZATION: I showed the user a card with the \
button to authorize access to the folder. Do NOT say you have read/listed it."
                    .to_string()
            }
        }
    } else if name == "run_in_project" {
        let args_val: serde_json::Value =
            serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
        let command = args_val
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let _ = emit_stream_event(
            ctx.tx,
            GenerateStreamEvent::Delta {
                text: format!(
                    "‹‹ACT››🛠️ Running in the project: {}‹‹/ACT››",
                    command.chars().take(120).collect::<String>()
                ),
            },
        )
        .await;
        match run_in_project(ctx.state, ctx.thread_id, &command).await {
            RunProjectOutcome::Completed(s) => s,
            RunProjectOutcome::NeedsEscalation { command, cwd } => {
                // ADR 0023 on-failure escalation: the fenced run hit a sandbox denial.
                // Surface an approval card; approving re-runs the exact command
                // unsandboxed via /api/capabilities/run/escalate.
                emit_approval_card(
                    ctx,
                    &mut effects,
                    SANDBOX_ESCALATE_OPEN,
                    SANDBOX_ESCALATE_CLOSE,
                    "run_in_project",
                    &command,
                    &serde_json::json!({ "command": command, "cwd": cwd }),
                )
                .await
            }
        }
    } else if name == "list_addons" {
        tokio::task::spawn_blocking(process_skills::addons_list_text)
            .await
            .unwrap_or_else(|e| format!("Error: {e}"))
    } else if name == "show_addon" {
        let args_val: serde_json::Value =
            serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
        let addon_id = args_val
            .get("addon_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        tokio::task::spawn_blocking(move || process_skills::addon_show_text(&addon_id))
            .await
            .unwrap_or_else(|e| format!("Error: {e}"))
    } else if name == "customize_addon" {
        let args_val: serde_json::Value =
            serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
        let addon_id = args_val
            .get("addon_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let changes = args_val
            .get("changes")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let _ = emit_stream_event(
            ctx.tx,
            GenerateStreamEvent::Delta {
                text: format!("‹‹ACT››🧩 Customizing addon {addon_id}‹‹/ACT››"),
            },
        )
        .await;
        tokio::task::spawn_blocking(move || {
            process_skills::addon_customize_text(&addon_id, &changes)
        })
        .await
        .unwrap_or_else(|e| format!("Error: {e}"))
    } else if name == "create_skill" {
        let args_val: serde_json::Value =
            serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
        let skill_name = args_val
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let skill_desc = args_val
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let skill_instr = args_val
            .get("instructions")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let _ = emit_stream_event(
            ctx.tx,
            GenerateStreamEvent::Delta {
                text: format!("‹‹ACT››🧩 Creating the skill {skill_name}‹‹/ACT››"),
            },
        )
        .await;
        tokio::task::spawn_blocking(move || create_skill(&skill_name, &skill_desc, &skill_instr))
            .await
            .unwrap_or_else(|e| format!("Error: {e}"))
    } else if name == "suggest_capabilities" {
        let args_val: serde_json::Value =
            serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
        let need = args_val
            .get("need")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let _ = emit_stream_event(
            ctx.tx,
            GenerateStreamEvent::Delta {
                text: format!("‹‹ACT››🧭 Searching connectors for: {need}‹‹/ACT››"),
            },
        )
        .await;
        let suggestions = suggest_capabilities(ctx.state, &need).await;
        match suggestions.card {
            Some(card) => {
                // In-chat connect-cards: render the suggestions as
                // clickable connect buttons (skill/MCP/Composio) so the
                // user acts from chat, no Settings trip. End the turn
                // here — the user must connect, then re-ask.
                let marker = card.to_string();
                let card_text = format!(
                    "\n\nHere's what I can connect for this. Choose below.\n\
‹‹CONNECT_SUGGEST››{marker}‹‹/CONNECT_SUGGEST››\n"
                );
                effects.append_output.push(card_text.clone());
                let _ =
                    emit_stream_event(ctx.tx, GenerateStreamEvent::Delta { text: card_text }).await;
                effects.request_confirm = true;
                effects.pending_capability = Some(need.clone());
                effects
                    .blocked_capabilities
                    .push(local_first_engine::BlockedCapability {
                        key: "suggest_capabilities".to_string(),
                        reason: "connect_required".to_string(),
                    });
                "AWAITING: I showed the user clickable cards to \
connect the suggested connectors (skill/MCP/Composio). Do NOT say you have already connected anything."
                    .to_string()
            }
            None => suggestions.model_text,
        }
    } else if name == "list_scheduled_tasks" {
        let st = ctx.state.clone();
        tokio::task::spawn_blocking(move || list_scheduled_tasks(&st))
            .await
            .unwrap_or_else(|e| format!("Error: {e}"))
    } else if name == "cancel_scheduled_task" {
        let args_val: serde_json::Value =
            serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
        let task_id = args_val
            .get("task_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let _ = emit_stream_event(
            ctx.tx,
            GenerateStreamEvent::Delta {
                text: "‹‹ACT››🗑️ Cancelling scheduled task‹‹/ACT››".to_string(),
            },
        )
        .await;
        let st = ctx.state.clone();
        tokio::task::spawn_blocking(move || cancel_scheduled_task(&st, &task_id))
            .await
            .unwrap_or_else(|e| format!("Error: {e}"))
    } else if !ctx.contact_memory_perimeter.can_see_calendar
        && !name.is_empty()
        && tool_touches_calendar(name)
    {
        // PERIMETER (anti-exfiltration): the can_see_calendar axis is enforced
        // HARD here, independent of memory_scope — a "personal"-scope contact that
        // is NOT contact_only still can't pull the user's calendar. All builtins
        // are matched in earlier arms, so this only catches calendar connectors.
        "The user's calendar is not accessible in this conversation. \
Do not reveal commitments, appointments or events."
            .to_string()
    } else if !ctx.contact_memory_perimeter.can_see_contacts
        && !name.is_empty()
        && tool_touches_contacts(name)
    {
        // PERIMETER (anti-exfiltration): the can_see_contacts axis, enforced HARD
        // here too — block the user's address book (Google Contacts / People etc.)
        // even on a non-contact_only turn.
        "The user's address book is not accessible in this conversation. \
Do not reveal other contacts, people or relationships of the user."
            .to_string()
    } else if ctx.contact_memory_perimeter.contact_only && !name.is_empty() {
        // PERIMETER (anti-exfiltration): a `contact_only` turn must not reach the
        // user's connected services. All builtins are matched in earlier arms, so
        // any tool reaching here is a connected Composio/MCP tool — refuse it so a
        // contact can't make the assistant read Gmail/Calendar/etc. and leak them.
        "Connected-service tools not available in a conversation with \
this contact. Answer only with what's in this chat; do not reveal personal data \
of the user or third parties."
            .to_string()
    } else if ctx.turn_policy.read_only && !name.is_empty() && ctx.composio_writes.contains(name) {
        // Channel (read-only) turn: never run a write tool, never even
        // surface a confirm card (no UI on the channel). Phase 2 routes
        // these to the in-app approval center.
        "Action not available from the channel: operations with effects \
require your confirmation in the app. Propose it and stop."
            .to_string()
    } else if let Some((mcp_provider, mcp_tool)) = parse_mcp_chat_name(name) {
        // Connected MCP server tool. Writes (per the cached ActionClass,
        // derived from the MCP readOnlyHint) need confirmation; reads run
        // with a timeout so a hung server can't freeze the turn. A
        // read_only channel + write was already rejected just above
        // (composio_writes now includes MCP writes). `autonomous` runs skip
        // the card and execute (explicit per-automation opt-in).
        let args_val: serde_json::Value =
            serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
        let workspace_scoped = workspace_scoped_mcp_write(
            ctx.state,
            ctx.thread_id,
            &mcp_provider,
            &mcp_tool,
            &args_val,
        );
        let is_write = ctx.composio_writes.contains(name);
        // ADR 0023 read-only chokepoint — parity with the native file tools: a workspace
        // filesystem write via an MCP provider (e.g. `mcp__filesystem__create`) is REFUSED
        // under read-only mode BEFORE executing, so a model cannot route around read-only
        // through MCP (the native `write_file`/`edit_file`/`apply_patch` already refuse).
        // Emits the same `SANDBOX_READ_ONLY_BLOCKED` marker → the escalation card fires.
        if workspace_scoped
            && resolved_sandbox_mode(ctx.state, ctx.thread_id)
                == crate::tool_safety::SandboxMode::ReadOnly
        {
            let blocked = read_only_write_blocked_msg(&mcp_tool);
            emit_read_only_block_if_needed(ctx, &mut effects, &blocked).await;
            effects
                .blocked_capabilities
                .push(local_first_engine::BlockedCapability {
                    key: name.to_string(),
                    reason: "read_only".to_string(),
                });
            blocked
        } else {
            // ADR 0023: route the decision through the pure policy fn. The approval axis is
            // now RESOLVED (env > persisted Settings > default `on-request`); autonomous still
            // forces `Never`, so at the default this yields the same verdict as before. The
            // sandbox arg is the resolved app-level policy (naming-only in `assess_tool_safety`
            // — it does not change the Ask/Auto verdict, but keeps the label honest).
            let approval = effective_approval(
                ctx.turn_policy.autonomous,
                resolved_approval_policy(ctx.state, ctx.thread_id),
            );
            let needs_confirm = matches!(
                assess_tool_safety(
                    approval,
                    &resolved_sandbox_policy(ctx.state, ctx.thread_id),
                    is_write,
                    workspace_scoped,
                ),
                SafetyDecision::AskUser
            );
            // ADR 0023 Step 5: an active sensitive skill forces a confirm on effectful
            // actions even when the policy alone wouldn't (e.g. under `never`).
            let needs_confirm = needs_confirm
                || skill_policy_forces_confirm(ctx.active_sensitive.as_slice(), is_write);
            if needs_confirm {
                emit_approval_card(
                    ctx,
                    &mut effects,
                    MCP_CONFIRM_OPEN,
                    MCP_CONFIRM_CLOSE,
                    name,
                    &mcp_tool,
                    &args_val,
                )
                .await
            } else {
                let _ = emit_stream_event(
                    ctx.tx,
                    GenerateStreamEvent::Delta {
                        text: format!("‹‹ACT››🔌 Using {mcp_tool}‹‹/ACT››"),
                    },
                )
                .await;
                let st = ctx.state.clone();
                let prov = mcp_provider.clone();
                let tool = mcp_tool.clone();
                let args_for_artifact = args_val.clone();
                let args = args_val;
                let mcp_started = std::time::Instant::now();
                let exec =
                    tokio::task::spawn_blocking(move || run_mcp_chat_tool(&st, &prov, &tool, args));
                let mut run_ok = false;
                let mut run_err: Option<&'static str> = None;
                let mcp_result = match tokio::time::timeout(mcp_call_timeout(), exec).await {
                    Ok(Ok(Ok(value))) => {
                        run_ok = true;
                        value
                            .to_string()
                            .chars()
                            .take(COMPOSIO_RESULT_CHARS)
                            .collect()
                    }
                    Ok(Ok(Err(error))) => {
                        if is_write {
                            effect_status = EffectDispatchStatus::UnknownRemoteOutcome;
                        }
                        // Classify the failure so a broken MCP server tells the user
                        // what to do (reconnect / wait) instead of a raw error.
                        run_err = classify_connector_error(&error.to_string())
                            .map(connector_error_kind_str)
                            .or(Some("other"));
                        let hint = mcp_error_hint(&error.to_string())
                            .map(|h| format!(" {h}"))
                            .unwrap_or_default();
                        format!("MCP tool error: {error}.{hint}")
                    }
                    Ok(Err(_join)) => {
                        effect_status = EffectDispatchStatus::UnknownRemoteOutcome;
                        run_err = Some("other");
                        "Error: MCP execution interrupted.".to_string()
                    }
                    Err(_elapsed) => {
                        effect_status = EffectDispatchStatus::UnknownRemoteOutcome;
                        run_err = Some("unavailable");
                        format!(
                            "The MCP tool didn't respond within {}s (timeout): the server \
may be stuck or offline. Tell the user to check/reconnect it from Settings → \
Connectors → MCP; do NOT claim it's done.",
                            mcp_call_timeout().as_secs()
                        )
                    }
                };
                record_connector_run(
                    ctx.state,
                    ctx.thread_id,
                    name,
                    "mcp",
                    run_ok,
                    run_err,
                    mcp_started.elapsed(),
                );
                if run_ok {
                    register_mcp_filesystem_artifact_memory(
                        ctx.state,
                        ctx.thread_id,
                        mcp_provider.as_str(),
                        &mcp_tool,
                        &args_for_artifact,
                    )
                    .await;
                }
                mcp_result
            }
        }
    } else if !name.is_empty() {
        // A connected-service (Composio) tool. Writes need explicit
        // confirmation unless the user marked this tool "always allow" OR the
        // run is an autonomous automation (explicit per-automation opt-in).
        let is_write = ctx.composio_writes.contains(name);
        let pre_authorized = composio_tool_allowed(name);
        // ADR 0023: same routing as the MCP branch. `pre_authorized` = the user's
        // always-allow list; the approval axis is RESOLVED, autonomous forced to `Never`.
        // At the default `on-request` this equals the legacy verdict.
        let approval = effective_approval(
            ctx.turn_policy.autonomous,
            resolved_approval_policy(ctx.state, ctx.thread_id),
        );
        let needs_confirm = matches!(
            assess_tool_safety(
                approval,
                &resolved_sandbox_policy(ctx.state, ctx.thread_id),
                is_write,
                pre_authorized,
            ),
            SafetyDecision::AskUser
        );
        // ADR 0023 Step 5: an active sensitive skill forces a confirm on effectful
        // actions even when the policy alone wouldn't (e.g. under `never`).
        let needs_confirm =
            needs_confirm || skill_policy_forces_confirm(ctx.active_sensitive.as_slice(), is_write);
        if needs_confirm {
            // Do NOT execute. Emit a confirmation card carrying the exact
            // action; the user runs it (once/always) via the card. The model
            // must never claim it's done — the real outcome comes from the card.
            let args_val: serde_json::Value =
                serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
            emit_approval_card(
                ctx,
                &mut effects,
                COMPOSIO_CONFIRM_OPEN,
                COMPOSIO_CONFIRM_CLOSE,
                name,
                &humanize_composio_tool(name),
                &args_val,
            )
            .await
        } else {
            let _ = emit_stream_event(
                ctx.tx,
                GenerateStreamEvent::Delta {
                    text: format!("‹‹ACT››🔧 Using {}‹‹/ACT››", humanize_composio_tool(name)),
                },
            )
            .await;
            let st = ctx.state.clone();
            let tool = name.to_string();
            let args: serde_json::Value =
                serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
            let composio_started = std::time::Instant::now();
            let outcome =
                tokio::task::spawn_blocking(move || composio_execute_tool(&st, &tool, &args)).await;
            let mut run_ok = false;
            let mut run_err: Option<&'static str> = None;
            let composio_result = match outcome {
                Ok(Ok(value))
                    if value
                        .get("unknown_remote_outcome")
                        .and_then(serde_json::Value::as_bool)
                        == Some(true) =>
                {
                    effect_status = EffectDispatchStatus::UnknownRemoteOutcome;
                    run_err = Some("unavailable");
                    let error = composio_execution_error(&value)
                        .unwrap_or_else(|| "remote outcome is unknown".to_string());
                    format!(
                        "The tool {name} may have performed the action, but its response was lost: {error}. Do not retry until the target state is verified."
                    )
                }
                Ok(Ok(value)) => match composio_execution_error(&value) {
                    // Composio returned 200 but the tool failed: tell the
                    // model so it reports the failure, not a false success.
                    Some(error) => {
                        run_err = classify_connector_error(&error)
                            .map(connector_error_kind_str)
                            .or(Some("other"));
                        let hint = connector_error_hint(&error)
                            .map(|h| format!(" {h}"))
                            .unwrap_or_default();
                        format!(
                            "The tool {name} did NOT perform the action: {error}.{hint} \
Tell the user clearly; do NOT claim it's done."
                        )
                    }
                    None => {
                        run_ok = true;
                        value
                            .to_string()
                            .chars()
                            .take(COMPOSIO_RESULT_CHARS)
                            .collect()
                    }
                },
                Ok(Err(error)) => {
                    if is_write {
                        effect_status = EffectDispatchStatus::UnknownRemoteOutcome;
                    }
                    run_err = classify_connector_error(&error.message)
                        .map(connector_error_kind_str)
                        .or(Some("other"));
                    let hint = connector_error_hint(&error.message)
                        .map(|h| format!(" {h}"))
                        .unwrap_or_default();
                    format!("Error from the tool {name}: {}.{hint}", error.message)
                }
                Err(error) => {
                    effect_status = EffectDispatchStatus::UnknownRemoteOutcome;
                    run_err = Some("other");
                    format!("Tool execution error: {error}")
                }
            };
            record_connector_run(
                ctx.state,
                ctx.thread_id,
                name,
                "composio",
                run_ok,
                run_err,
                composio_started.elapsed(),
            );
            composio_result
        }
    } else {
        format!("Tool not available: {name}")
    };
    GatewayToolDispatch {
        result,
        effects,
        effect_status,
    }
}

pub(crate) struct GatewayCapabilityExecutorInput<'a> {
    pub(crate) state: &'a AppState,
    pub(crate) tx: &'a StreamSink,
    pub(crate) thread_id: Option<&'a str>,
    pub(crate) turn_policy: &'a ChatTurnPolicy,
    pub(crate) contact_memory_perimeter: ContactMemoryPerimeter,
    pub(crate) memory_intent: semantic_decision::MemoryIntent,
    pub(crate) composio_writes: &'a std::collections::BTreeSet<String>,
    pub(crate) catalog_index: &'a [(String, String, serde_json::Value)],
    pub(crate) capability_corpus: &'a [CapabilityEntry],
    pub(crate) automation_user_id: &'a UserId,
    pub(crate) automation_workspace_id: &'a WorkspaceId,
    // ADR 0025: the extra turn-constants a recursive `browse(goal)` sub-turn needs (the granular browser
    // executor's ctx wants them). Held here so the manager's `browse` interception can build a
    // `GatewayBrowseExecutor` without threading them through the whole ChatToolCtx.
    pub(crate) prompt: &'a str,
    pub(crate) chat_channel: ChatChannelContext,
    // Readable per-turn observability sink (ported); passed into each per-call ChatToolCtx so the plan
    // arm can record the Plan event. No-op when disabled. See `engine::turn_trace`.
    pub(crate) turn_trace: &'a local_first_engine::turn_trace::TurnTrace,
    pub(crate) turn_id: Option<&'a str>,
    pub(crate) run_id: Option<&'a str>,
    pub(crate) execution_contract:
        Option<&'a local_first_execution_protocol::ValidatedExecutionContract>,
}

/// The gateway's `CapabilityExecutor` (ADR 0026): holds ONLY the turn-constant read-only context
/// execute_chat_tool needs; per call it builds a `ChatToolCtx` from the passed `&mut LoopState`
/// (plan/step_evidence/tool_trace + provider) + that held context, and delegates. Passing `ls` per
/// call (not capturing it) is what lets the engine loop keep `&mut ls` without a double borrow.
pub(crate) struct GatewayCapabilityExecutor<'a> {
    state: &'a AppState,
    tx: &'a StreamSink,
    thread_id: Option<&'a str>,
    turn_policy: &'a ChatTurnPolicy,
    contact_memory_perimeter: ContactMemoryPerimeter,
    memory_intent: semantic_decision::MemoryIntent,
    composio_writes: &'a std::collections::BTreeSet<String>,
    catalog_index: &'a [(String, String, serde_json::Value)],
    capability_corpus: &'a [CapabilityEntry],
    automation_user_id: &'a UserId,
    automation_workspace_id: &'a WorkspaceId,
    prompt: &'a str,
    chat_channel: ChatChannelContext,
    turn_trace: &'a local_first_engine::turn_trace::TurnTrace,
    turn_id: Option<&'a str>,
    run_id: Option<&'a str>,
    execution_contract: Option<&'a local_first_execution_protocol::ValidatedExecutionContract>,
}

pub(crate) fn gateway_capability_executor<'a>(
    input: GatewayCapabilityExecutorInput<'a>,
) -> GatewayCapabilityExecutor<'a> {
    GatewayCapabilityExecutor {
        state: input.state,
        tx: input.tx,
        thread_id: input.thread_id,
        turn_policy: input.turn_policy,
        contact_memory_perimeter: input.contact_memory_perimeter,
        memory_intent: input.memory_intent,
        composio_writes: input.composio_writes,
        catalog_index: input.catalog_index,
        capability_corpus: input.capability_corpus,
        automation_user_id: input.automation_user_id,
        automation_workspace_id: input.automation_workspace_id,
        prompt: input.prompt,
        chat_channel: input.chat_channel,
        turn_trace: input.turn_trace,
        turn_id: input.turn_id,
        run_id: input.run_id,
        execution_contract: input.execution_contract,
    }
}

/// Does this tool name look effectful? `composio_writes` is the authoritative set for connector tools;
/// the token list below is the fallback for everything else.
///
/// Matched on whole NAME SEGMENTS, not as substrings. A bare `contains` fired on read-only tools whose
/// names merely embed a verb — `SLACK_LIST_ALL_SAVED_ITEMS` contains "save", `list_bookings` contains
/// "book", `LIST_REPOSITORY_UPDATES` contains "update" — and since a missing objective contract defaults
/// to read-only analysis, those listings were refused with a message naming no way to proceed.
/// The loop's own control tools. They are not capabilities a contact perimeter is meant to scope, so an
/// allowlist must not remove them — without `update_plan`/`step_advance` the turn cannot plan, without
/// `find_capability` it cannot discover what it may use, and without `recall_memory` it answers blind.
pub(crate) const HARNESS_CONTROL_TOOLS: &[&str] = &[
    "update_plan",
    "step_advance",
    "find_capability",
    "recall_memory",
];

pub(crate) fn effectful_tool_name(
    name: &str,
    composio_writes: &std::collections::BTreeSet<String>,
) -> bool {
    if composio_writes.contains(name) {
        return true;
    }
    let lower = name.to_ascii_lowercase();
    let segments: Vec<&str> = lower.split(|c: char| !c.is_ascii_alphanumeric()).collect();
    [
        "write",
        "edit",
        "apply",
        "create",
        "update",
        "delete",
        "remove",
        "send",
        "save",
        "make_",
        "book",
        "purchase",
        "forget",
        "cancel",
        "record_decision",
    ]
    .iter()
    .any(|token| {
        // Multi-segment tokens ("make_", "record_decision") are matched against the whole name; the
        // single-word ones must BE a segment, so "saved"/"bookings"/"updates" no longer count.
        if token.contains('_') {
            lower.starts_with(token) || lower.contains(token)
        } else {
            segments.contains(token)
        }
    })
}

pub(crate) fn tool_effect_class(
    name: &str,
    composio_writes: &std::collections::BTreeSet<String>,
) -> semantic_decision::EffectClass {
    use semantic_decision::EffectClass;

    if HARNESS_CONTROL_TOOLS.contains(&name) {
        EffectClass::Read
    } else if composio_writes.contains(name)
        || matches!(
            name,
            "schedule_task"
                | "create_automation"
                | "update_automation"
                | "cancel_scheduled_task"
                | "send_message"
                | "use_computer"
                | "browser_rehydrate"
        )
    {
        EffectClass::ExternalWrite
    } else if matches!(
        name,
        "create_artifact"
            | "generate_image"
            | "render_deck"
            | "make_deck"
            | "make_document"
            | "save_artifact"
    ) {
        EffectClass::ArtifactCreation
    } else if matches!(
        name,
        "write_file"
            | "edit_file"
            | "apply_patch"
            | "run_in_project"
            | "run_in_sandbox"
            | "customize_addon"
            | "create_skill"
            | "record_decision"
            | "forget_memory"
    ) {
        EffectClass::FilesystemWrite
    } else if effectful_tool_name(name, composio_writes) {
        EffectClass::ExternalWrite
    } else {
        EffectClass::Read
    }
}

pub(crate) fn protocol_effect_class(
    name: &str,
    composio_writes: &std::collections::BTreeSet<String>,
) -> local_first_execution_protocol::EffectClass {
    match tool_effect_class(name, composio_writes) {
        semantic_decision::EffectClass::Read => local_first_execution_protocol::EffectClass::Read,
        semantic_decision::EffectClass::RequestAuthorization => {
            local_first_execution_protocol::EffectClass::RequestAuthorization
        }
        semantic_decision::EffectClass::FilesystemWrite => {
            local_first_execution_protocol::EffectClass::FilesystemWrite
        }
        semantic_decision::EffectClass::ArtifactCreation => {
            local_first_execution_protocol::EffectClass::ArtifactCreation
        }
        semantic_decision::EffectClass::ExternalWrite => {
            local_first_execution_protocol::EffectClass::ExternalWrite
        }
    }
}

pub(crate) fn objective_blocks_tool(
    policy: &semantic_decision::ObjectiveEffectPolicy,
    name: &str,
    composio_writes: &std::collections::BTreeSet<String>,
) -> bool {
    !policy.allows(tool_effect_class(name, composio_writes))
}

pub(crate) fn prune_tools_for_objective_policy(
    tools: &mut Vec<serde_json::Value>,
    policy: &semantic_decision::ObjectiveEffectPolicy,
    composio_writes: &std::collections::BTreeSet<String>,
) {
    tools.retain(|schema| {
        let name = schema
            .pointer("/function/name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        !objective_blocks_tool(policy, name, composio_writes)
    });
}

pub(crate) struct ChatObjectiveExecutionContextInput<'a> {
    pub(crate) state: &'a AppState,
    pub(crate) thread_id: Option<&'a str>,
    pub(crate) catalog_index: Vec<(String, String, serde_json::Value)>,
    pub(crate) composio_writes: &'a std::collections::BTreeSet<String>,
}

pub(crate) struct ChatObjectiveExecutionContext {
    pub(crate) active_objective_contract: Option<local_first_task_runtime::ObjectiveContractRecord>,
    pub(crate) semantic_contract: Option<semantic_decision::ValidatedSemanticDecision>,
    pub(crate) objective_effect_policy: semantic_decision::ObjectiveEffectPolicy,
    pub(crate) memory_intent: semantic_decision::MemoryIntent,
    pub(crate) memory_injection: MemoryInjectionPolicy,
    pub(crate) catalog_index: Vec<(String, String, serde_json::Value)>,
}

pub(crate) fn prepare_chat_objective_execution_context(
    input: ChatObjectiveExecutionContextInput<'_>,
) -> ChatObjectiveExecutionContext {
    let active_objective_contract = objective_contract_for_execution(input.state, input.thread_id);
    let semantic_contract = active_objective_contract
        .as_ref()
        .and_then(semantic_decision::semantic_decision_from_contract);
    let objective_effect_policy =
        semantic_decision::ObjectiveEffectPolicy::from_contract(active_objective_contract.as_ref());
    let mut catalog_index = input.catalog_index;
    catalog_index.retain(|(name, _, _)| {
        !objective_blocks_tool(&objective_effect_policy, name, input.composio_writes)
    });
    let memory_context = memory_intent_context_for_semantic_contract(semantic_contract.as_ref());

    ChatObjectiveExecutionContext {
        active_objective_contract,
        semantic_contract,
        objective_effect_policy,
        memory_intent: memory_context.memory_intent,
        memory_injection: memory_context.memory_injection,
        catalog_index,
    }
}

pub(crate) fn objective_effect_policy_for_execution(
    state: &AppState,
    thread_id: Option<&str>,
    _prompt: &str,
) -> semantic_decision::ObjectiveEffectPolicy {
    let contract = objective_contract_for_execution(state, thread_id);
    semantic_decision::ObjectiveEffectPolicy::from_contract(contract.as_ref())
}

pub(crate) fn objective_contract_for_execution(
    state: &AppState,
    thread_id: Option<&str>,
) -> Option<local_first_task_runtime::ObjectiveContractRecord> {
    thread_id
        .and_then(|thread_id| runtime_plan_control_scope(state, Some(thread_id)))
        .and_then(|(user_id, workspace_id, thread_id)| {
            state
                .task_store
                .lock()
                .ok()?
                .load_objective_contract(&user_id, &workspace_id, &thread_id)
                .ok()
                .flatten()
        })
}

pub(crate) fn resolve_plan_goal_for_turn(
    sent_goal: Option<String>,
    existing_plan_goal: Option<String>,
    objective_goal: Option<String>,
) -> Option<String> {
    let objective_goal = objective_goal
        .map(|goal| goal.trim().to_string())
        .filter(|goal| !goal.is_empty());
    let sent_goal = sent_goal
        .map(|goal| goal.trim().to_string())
        .filter(|goal| !goal.is_empty());

    match sent_goal {
        Some(goal) => {
            if objective_goal.as_ref().is_some_and(|objective| {
                semantic_decision::request_is_contextual_followup(&goal, objective)
            }) {
                objective_goal
            } else {
                Some(goal)
            }
        }
        None => existing_plan_goal
            .map(|goal| goal.trim().to_string())
            .filter(|goal| !goal.is_empty())
            .or(objective_goal),
    }
}

impl local_first_engine::CapabilityExecutor for GatewayCapabilityExecutor<'_> {
    async fn execute_tool(
        &self,
        name: &str,
        args_raw: &str,
        call_id: &str,
        ls: &mut local_first_engine::LoopState,
    ) -> Result<local_first_engine::ToolOutcome, String> {
        if self
            .turn_id
            .is_some_and(crate::turn_executor::turn_is_cancelled)
        {
            return Ok(local_first_engine::ToolOutcome {
                result: "TURN CANCELLED: no tool was executed.".to_string(),
                effects: Default::default(),
            });
        }
        if name == "recall_memory" && !memory_intent_allows_recall(&self.memory_intent) {
            return Ok(local_first_engine::ToolOutcome {
                result: "Long-term memory recall is not authorized for this objective. Use only current-thread context and current-turn tool evidence."
                    .to_string(),
                effects: Default::default(),
            });
        }
        let objective_policy =
            objective_effect_policy_for_execution(self.state, self.thread_id, self.prompt);
        if objective_blocks_tool(&objective_policy, name, self.composio_writes) {
            // Log the refusal: it used to be silent, so a task that quietly lost its effectful tools
            // looked like the model simply choosing not to act.
            tracing::warn!(
                target: "objective::contract",
                tool = name,
                effect_class = ?tool_effect_class(name, self.composio_writes),
                "objective contract blocked an effectful tool"
            );
            return Ok(local_first_engine::ToolOutcome {
                // The old text told the model to "ask the user to authorize expanding the objective",
                // naming no tool that does that — there is none — so it had no move to make. State what
                // IS possible: read-only work continues; anything with an effect needs the user to say
                // so in a new message.
                result: format!(
                    "OBJECTIVE CONTRACT BLOCKED `{name}`: the current objective does not authorize the {:?} effect class, so nothing was executed. Continue using the effects that are already allowed. If this effect is required, stop and tell the user exactly which action would need a new or expanded objective.",
                    tool_effect_class(name, self.composio_writes)
                ),
                effects: Default::default(),
            });
        }
        if name == "use_computer" {
            if !host_computer_gateway::manager_ready() {
                return Ok(local_first_engine::ToolOutcome {
                    result: serde_json::json!({
                        "found": false,
                        "error": "mac_apps_not_ready"
                    })
                    .to_string(),
                    effects: Default::default(),
                });
            }
            let value: serde_json::Value = serde_json::from_str(args_raw).unwrap_or_default();
            let goal = value
                .get("goal")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .trim();
            if goal.is_empty() {
                return Ok(local_first_engine::ToolOutcome {
                    result: "use_computer needs a non-empty goal.".into(),
                    effects: Default::default(),
                });
            }
            let app = value
                .get("app")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let delegated_goal = if app.is_empty() {
                goal.to_string()
            } else {
                format!("{goal}\nPreferred app: {app}")
            };
            let Some(contract) = self.execution_contract else {
                return Ok(local_first_engine::ToolOutcome {
                    result: "Computer action blocked: no durable execution scope is available."
                        .to_string(),
                    effects: Default::default(),
                });
            };
            let effect_host = crate::effect_host::EffectHost::new(
                self.state.task_store.as_ref(),
                contract,
                self.run_id,
            );
            let lease = match effect_host.begin(crate::effect_host::EffectRequest::capability(
                name,
                call_id,
                local_first_execution_protocol::EffectClass::ExternalWrite,
                value,
            ))? {
                crate::effect_host::EffectDecision::Execute(lease) => lease,
                crate::effect_host::EffectDecision::Replay(receipt) => {
                    let result = receipt
                        .result_json
                        .and_then(|value| value.as_str().map(str::to_string))
                        .unwrap_or_else(|| "Previously completed computer action replayed.".into());
                    return Ok(local_first_engine::ToolOutcome {
                        result,
                        effects: Default::default(),
                    });
                }
                crate::effect_host::EffectDecision::Resolve(receipt) => {
                    return Ok(local_first_engine::ToolOutcome {
                        result: "This computer action may already have run before an interruption. It was not repeated; inspect the target state before retrying.".to_string(),
                        effects: local_first_engine::ToolEffects {
                            suspend_effect_receipt: Some(receipt.receipt_ref),
                            ..Default::default()
                        },
                    });
                }
            };
            let outcome = GatewayComputerExecutor {
                state: self.state,
                http: &self.state.http,
                thread_id: self.thread_id,
            }
            .run(&delegated_goal)
            .await;
            let mut result = local_first_engine::browse::browse_result_for_manager(&outcome);
            let mut effects = local_first_engine::ToolEffects::default();
            if let Err(error) = effect_host.complete(
                &lease,
                &serde_json::Value::String(result.clone()),
                &serde_json::json!({"computer_action": true}),
            ) {
                let _ = effect_host.mark_uncertain(&lease);
                effects.suspend_effect_receipt = Some(lease.receipt_ref().clone());
                result = format!(
                    "{result}\nComputer effect receipt completion failed: {error}. The outcome requires verification."
                );
            }
            return Ok(local_first_engine::ToolOutcome { result, effects });
        }
        // ADR 0025 slice 2: `browse` is delegated, not a normal capability. Intercept it BEFORE the
        // ChatToolCtx path and route it to the isolated recursive sub-turn (GatewayBrowseExecutor). The
        // engine dispatch sees `browse` as a plain non-browser tool → it arrives here; the recursion runs
        // entirely gateway-side and returns a compact BrowseResult the manager reads.
        if name == "browse" {
            if earlier_browse_call_in_current_round(&ls.messages, call_id) {
                let deferred = local_first_engine::BrowseResult::not_found(
                    "browse deferred: another browse call already ran in this model round; inspect its result before deciding whether another source is needed",
                );
                return Ok(delegated_browse_tool_outcome(&deferred, None));
            }
            let request = parse_browse_request(args_raw);
            if request.goal.is_empty() {
                return Ok(local_first_engine::ToolOutcome {
                    result: "browse needs a non-empty `goal`.".to_string(),
                    effects: Default::default(),
                });
            }
            if browse_goal_was_already_requested(&ls.messages, call_id, &request.goal) {
                return Ok(local_first_engine::ToolOutcome {
                    result: "found: false\nnote: This exact browse goal already returned in this turn. Reuse its evidence or choose a materially different source goal.".to_string(),
                    effects: local_first_engine::ToolEffects {
                        outcome_hint: Some(local_first_engine::ToolOutcomeHint::NoProgress),
                        ..Default::default()
                    },
                });
            }
            if !browse_call_within_turn_cap(ls.browse_calls_completed) {
                return Ok(local_first_engine::ToolOutcome {
                    result: format!(
                        "found: false\nnote: The per-turn browse cap ({MAX_DISTINCT_BROWSE_CALLS_PER_TURN}) was reached. Synthesize from the collected evidence and leave any unverified plan steps open."
                    ),
                    effects: local_first_engine::ToolEffects {
                        outcome_hint: Some(local_first_engine::ToolOutcomeHint::NoProgress),
                        ..Default::default()
                    },
                });
            }
            let browse_executor = GatewayBrowseExecutor {
                state: self.state,
                http: &self.state.http,
                tx: self.tx,
                thread_id: self.thread_id,
                prompt: self.prompt,
                read_only: self.turn_policy.read_only
                    || !objective_policy.allows(semantic_decision::EffectClass::ExternalWrite),
                channel_owner: self.chat_channel.owner,
                agent_run_id: self.run_id.map(str::to_string),
                execution_contract: self.execution_contract.cloned(),
            };
            let outcome = browse_executor.browse(request).await;
            ls.browse_calls_completed = ls.browse_calls_completed.saturating_add(1);
            return Ok(delegated_browse_tool_outcome(
                &outcome.result,
                outcome.suspend_effect_receipt,
            ));
        }
        // ADR 0023 Step 5: re-hydrate the turn's armed sensitive domains (carried as tokens in the
        // engine-safe LoopState) into the gateway enum for the approval gates. Read before the `&mut`
        // field borrows below (disjoint fields, but this keeps it a clean owned snapshot).
        let active_sensitive: Vec<crate::skills::SensitiveCategory> = ls
            .active_sensitive
            .iter()
            .filter_map(|t| crate::skills::SensitiveCategory::parse(t))
            .collect();
        let effect_host = self.execution_contract.map(|contract| {
            crate::effect_host::EffectHost::new(
                self.state.task_store.as_ref(),
                contract,
                self.run_id,
            )
        });
        let receipt = if effectful_tool_name(name, self.composio_writes) {
            let Some(host) = effect_host.as_ref() else {
                return Ok(local_first_engine::ToolOutcome {
                    result: "Effectful tool blocked: no durable execution scope is available."
                        .to_string(),
                    effects: Default::default(),
                });
            };
            let arguments =
                serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
            match host.begin(crate::effect_host::EffectRequest::capability(
                name,
                call_id,
                protocol_effect_class(name, self.composio_writes),
                arguments,
            ))? {
                crate::effect_host::EffectDecision::Execute(lease) => Some(lease),
                crate::effect_host::EffectDecision::Replay(receipt) => {
                    let result = receipt
                        .result_json
                        .and_then(|value| value.as_str().map(str::to_string))
                        .unwrap_or_else(|| "Previously completed effect replayed.".to_string());
                    let effects = receipt
                        .effects_json
                        .and_then(|value| serde_json::from_value(value).ok())
                        .unwrap_or_default();
                    return Ok(local_first_engine::ToolOutcome { result, effects });
                }
                crate::effect_host::EffectDecision::Resolve(receipt) => {
                    return Ok(local_first_engine::ToolOutcome {
                        result: "This effect may already have run before an interruption. It was not repeated; inspect the target state before retrying.".to_string(),
                        effects: local_first_engine::ToolEffects {
                            suspend_effect_receipt: Some(receipt.receipt_ref),
                            ..Default::default()
                        },
                    });
                }
            }
        } else {
            None
        };

        let ctx = ChatToolCtx {
            plan: &mut ls.plan,
            step_evidence: &mut ls.step_evidence,
            tool_trace: &mut ls.tool_trace,
            base_url: &mut ls.provider.base_url,
            model: &mut ls.provider.model,
            api_key: &mut ls.provider.api_key,
            state: self.state,
            tx: self.tx,
            thread_id: self.thread_id,
            turn_policy: self.turn_policy,
            contact_memory_perimeter: &self.contact_memory_perimeter,
            memory_intent: &self.memory_intent,
            composio_writes: self.composio_writes,
            catalog_index: self.catalog_index,
            capability_corpus: self.capability_corpus,
            automation_user_id: self.automation_user_id,
            automation_workspace_id: self.automation_workspace_id,
            turn_trace: self.turn_trace,
            active_sensitive,
        };
        let GatewayToolDispatch {
            mut result,
            mut effects,
            effect_status,
        } = execute_chat_tool(&ctx, name, args_raw, call_id).await;
        // S2 T4: `effects.clear_routing_binding` is a gateway-side signal the engine-safe
        // `LoopState::apply_effects` can't act on (it has no `ChatStore` access) — this is
        // the gateway seam that DOES, right after the call that set it, before the flag
        // travels any further. Fail-open: no thread_id → nothing to clear.
        if effects.clear_routing_binding
            && let Some(thread_id) = self.thread_id
            && let Ok(store) = lock_store(self.state)
        {
            let _ = store.clear_thread_routing_binding(thread_id);
        }
        if let Some(lease) = receipt {
            let host = effect_host
                .as_ref()
                .expect("a lease is only returned by an effect host");
            match effect_receipt_finish_action(effect_status) {
                EffectReceiptFinishAction::Complete => {
                    let result_json = serde_json::Value::String(result.clone());
                    let effects_json =
                        serde_json::to_value(&effects).unwrap_or_else(|_| serde_json::json!({}));
                    if let Err(error) = host.complete(&lease, &result_json, &effects_json) {
                        let _ = host.mark_uncertain(&lease);
                        effects.suspend_effect_receipt = Some(lease.receipt_ref().clone());
                        result = format!(
                            "{result}\nEffect receipt completion failed: {error}. The outcome requires verification."
                        );
                    }
                }
                EffectReceiptFinishAction::MarkUncertainAndSuspend => {
                    let _ = host.mark_uncertain(&lease);
                    effects.suspend_effect_receipt = Some(lease.receipt_ref().clone());
                }
            }
        }
        Ok(local_first_engine::ToolOutcome { result, effects })
    }
}

/// Anti-loop nudge logic for browser sub-turns (task 69). Exposed as a free function so unit tests can
/// exercise the counter/injection without a full `GatewayBrowserExecutor` + live browser session.
///
/// Returns `(updated_count, Option<nudge_text>, hard_capped)`. When `tool_name` is
/// `browser_snapshot` the counter increments; for ANY other tool (click/fill/type/navigate/
/// browser_done/browser_screenshot …) it resets to 0.
///
/// The nudge is **appended to the tool result text** (not injected as a separate system message) so
/// it arrives in the correct chat-API position — sandwiching a system message between `tool_call`
/// and `tool_response` violates the contract and the model never sees it.
///
/// When the incremented count reaches `threshold` a **soft nudge** is returned. The counter is NOT
/// reset so the nudge repeats on every subsequent snapshot, giving the model a clear escalating
/// signal. After `threshold + 2` consecutive snapshots the **hard cap** fires: a terminating
/// nudge is returned with `hard_capped = true` so the caller can force a `NoProgress` outcome to
/// terminate the browse sub-turn. The counter still does NOT reset on the hard cap — subsequent
/// snapshots hit the hard cap immediately, rapidly incrementing `browser_no_progress` until the
/// budget trips. A `threshold` of 0 disables both nudge and hard cap entirely.
pub(crate) fn browser_anti_loop_nudge(
    consecutive_snapshot_count: u32,
    tool_name: &str,
    threshold: u32,
) -> (u32, Option<String>, bool) {
    let new_count = if tool_name == "browser_snapshot" {
        consecutive_snapshot_count.saturating_add(1)
    } else {
        0
    };
    let hard_cap = threshold.saturating_add(2);
    if threshold > 0 && new_count >= hard_cap {
        let nudge = format!(
            "⚠️ ANTI-LOOP: You have taken {} consecutive snapshot/observation actions without performing any meaningful interaction. \
The browser sub-turn has been TERMINATED due to a snapshot loop — no further snapshots will be processed. \
You MUST stop calling browser_snapshot and either perform a concrete action (browser_act, browser_navigate) or call browser_done with your findings.",
            new_count,
        );
        (new_count, Some(nudge), true)
    } else if threshold > 0 && new_count >= threshold {
        let nudge = format!(
            "⚠️ ANTI-LOOP: You have taken {} consecutive snapshot/observation actions without performing any meaningful interaction. \
You MUST now perform ONE of these actions: browser_act, browser_navigate, or browser_done with your findings. \
Do NOT call browser_snapshot again. Choose a concrete action now.",
            new_count,
        );
        (new_count, Some(nudge), false)
    } else {
        (new_count, None, false)
    }
}

fn browser_action_repeat_signature(args_raw: &str) -> String {
    fn field_signature(value: &serde_json::Value) -> String {
        const KEYS: &[&str] = &[
            "kind",
            "ref",
            "target",
            "target_id",
            "selector",
            "text",
            "value",
            "key",
        ];
        KEYS.iter()
            .filter_map(|key| {
                let raw = value.get(*key)?;
                let normalized = raw
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| raw.to_string());
                Some(format!("{key}={normalized}"))
            })
            .collect::<Vec<_>>()
            .join(";")
    }

    let value: serde_json::Value =
        serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({ "raw": args_raw }));
    if let Some(actions) = value.get("actions").and_then(|actions| actions.as_array()) {
        let action_sigs = actions
            .iter()
            .map(field_signature)
            .collect::<Vec<_>>()
            .join("|");
        if !action_sigs.is_empty() {
            return action_sigs;
        }
    }
    let signature = field_signature(&value);
    if signature.is_empty() {
        args_raw.split_whitespace().collect::<Vec<_>>().join(" ")
    } else {
        signature
    }
}

pub(crate) fn browser_snapshot_semantic_fingerprint(snapshot: &str) -> String {
    let mut normalized = String::new();
    let mut last_was_space = false;
    for raw_line in snapshot.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with("[page:") || line.starts_with("[page stats:") {
            continue;
        }
        let mut chars = line.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == '[' {
                let mut bracket = String::from("[");
                for next in chars.by_ref() {
                    bracket.push(next);
                    if next == ']' {
                        break;
                    }
                }
                let ref_token = bracket
                    .strip_prefix("[ref=e")
                    .and_then(|rest| rest.strip_suffix(']'));
                if ref_token.is_some_and(|rest| {
                    let rest = rest.strip_suffix('*').unwrap_or(rest);
                    !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit())
                }) {
                    continue;
                }
                for bracket_ch in bracket.chars() {
                    append_normalized_snapshot_char(
                        &mut normalized,
                        &mut last_was_space,
                        bracket_ch,
                    );
                }
                continue;
            }
            append_normalized_snapshot_char(&mut normalized, &mut last_was_space, ch);
        }
        append_normalized_snapshot_char(&mut normalized, &mut last_was_space, '\n');
    }

    let stable = normalized.trim();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    std::hash::Hash::hash(&stable, &mut hasher);
    format!("{:016x}", std::hash::Hasher::finish(&hasher))
}

pub(crate) fn browser_cached_snapshot_fallback(
    operation: &str,
    error: &str,
    last_snapshot: &str,
) -> Option<String> {
    let snapshot = last_snapshot.trim();
    if snapshot.is_empty() {
        return None;
    }
    Some(format!(
        "{operation} failed, but the last successful browser observation is still available. \
Use these [ref=...] values for the next browser_act; if an action reports a stale ref, take a fresh \
browser_snapshot before retrying.\nFresh observation error: {error}\n\nCached snapshot:\n{snapshot}"
    ))
}

pub(crate) fn browser_navigation_should_recycle_after_error(error: &str) -> bool {
    cdp_wedge_signature(error) || error.contains(BROWSER_SIDECAR_TIMEOUT_ERROR)
}

fn append_normalized_snapshot_char(target: &mut String, last_was_space: &mut bool, ch: char) {
    if ch.is_whitespace() {
        if !*last_was_space {
            target.push(' ');
            *last_was_space = true;
        }
    } else {
        target.push(ch);
        *last_was_space = false;
    }
}

pub(crate) fn repeated_browser_action_nudge(
    recent_action_signatures: &mut std::collections::VecDeque<String>,
    tool_name: &str,
    args_raw: &str,
    threshold: usize,
) -> (Option<String>, bool) {
    if tool_name != "browser_act" {
        return (None, false);
    }

    let signature = browser_action_repeat_signature(args_raw);
    if recent_action_signatures
        .back()
        .is_some_and(|last| last != &signature)
    {
        recent_action_signatures.clear();
    }
    recent_action_signatures.push_back(signature);
    while recent_action_signatures.len() > threshold.max(1) {
        recent_action_signatures.pop_front();
    }

    let repeated = recent_action_signatures
        .iter()
        .rev()
        .take_while(|sig| {
            recent_action_signatures
                .back()
                .is_some_and(|last| *sig == last)
        })
        .count();
    if threshold == 0 || repeated < 2 {
        return (None, false);
    }

    let hard_capped = repeated >= threshold;
    let nudge = if hard_capped {
        format!(
            "⚠️ ANTI-LOOP: The same browser action has been repeated {repeated} times without a different action strategy. \
The browser sub-turn has been TERMINATED due to a repeated action loop. Call browser_done with current findings or change site/source."
        )
    } else {
        format!(
            "⚠️ ANTI-LOOP: The same browser action has been repeated {repeated} times. \
Do not repeat it again; choose a different ref/action strategy or call browser_done with current findings."
        )
    };
    (Some(nudge), hard_capped)
}

fn browser_failed_action_family(args_raw: &str) -> String {
    let value: serde_json::Value =
        serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
    if let Some(actions) = value.get("actions").and_then(|actions| actions.as_array()) {
        let families = actions
            .iter()
            .filter_map(|action| action.get("kind").and_then(|kind| kind.as_str()))
            .map(str::trim)
            .filter(|kind| !kind.is_empty())
            .collect::<Vec<_>>();
        if !families.is_empty() {
            return families.join("+");
        }
    }
    value
        .get("kind")
        .and_then(|kind| kind.as_str())
        .map(str::trim)
        .filter(|kind| !kind.is_empty())
        .unwrap_or("browser_act")
        .to_string()
}

pub(crate) fn repeated_browser_failed_action_nudge(
    recent_failed_action_families: &mut std::collections::VecDeque<String>,
    tool_name: &str,
    args_raw: &str,
    failed: bool,
    threshold: usize,
) -> (Option<String>, bool) {
    if tool_name != "browser_act" || !failed || threshold == 0 {
        return (None, false);
    }

    let family = browser_failed_action_family(args_raw);
    if recent_failed_action_families
        .back()
        .is_some_and(|last| last != &family)
    {
        recent_failed_action_families.clear();
    }
    recent_failed_action_families.push_back(family.clone());
    while recent_failed_action_families.len() > threshold.max(1) {
        recent_failed_action_families.pop_front();
    }

    let repeated = recent_failed_action_families
        .iter()
        .rev()
        .take_while(|item| {
            recent_failed_action_families
                .back()
                .is_some_and(|last| *item == last)
        })
        .count();
    if repeated < 2 {
        return (None, false);
    }

    let hard_capped = repeated >= threshold;
    let nudge = if hard_capped {
        format!(
            "⚠️ ANTI-LOOP: browser action family `{family}` failed {repeated} times in this sub-turn. \
The browser sub-turn has been TERMINATED due to repeated failed actions. Call browser_done with current findings or change site/source."
        )
    } else {
        format!(
            "⚠️ ANTI-LOOP: browser action family `{family}` has already failed {repeated} times. \
Do not repeat it; change strategy, change source, or call browser_done with current findings."
        )
    };
    (Some(nudge), hard_capped)
}

/// The gateway's `BrowserExecutor` (ADR 0024 inc 5, 5.D1b slice 5b; ADR 0025 seam). OWNS the browser
/// subsystem's turn state — the live sidecar `browser_session` (a gateway type that can't live in the
/// engine-safe `LoopState`) plus the browser-private bookkeeping (last snapshot, current tab / opened
/// targets, per-URL nav failures) — because these are touched ONLY by the browser branch, never by the
/// loop body. `&mut self` (see the trait) lets it mutate that state per call; the loop keeps it in a
/// local separate from `&mut ls`, so there is no double borrow. Per call it rebuilds a `BrowserToolCtx`
/// from its owned state + `&mut LoopState` (the loop-visible browser fields + provider) + held
/// turn-constants, and delegates to `execute_browser_tool`. Constructed per turn by the loop-move
/// (ADR 0024 5.D2 / ADR 0025) — live since the crate move.
pub(crate) struct GatewayBrowserExecutor<'a> {
    pub(crate) browser_session: Option<BrowserAutomationClient<BrowserSidecarSession>>,
    pub(crate) last_snapshot: String,
    pub(crate) last_snapshot_semantic_fingerprint: String,
    pub(crate) browse_sources: Vec<String>,
    // Machine-derived payment floor refs for the last observation (act/navigate/
    // snapshot), keyed by `target_id` (Build1 Fix 3). Was a single global
    // `HashSet` — but interleaving two tabs without re-observing the acted-on one
    // (observe tab B, observe tab A, act on tab B's already-floored ref) let tab
    // A's observation silently overwrite tab B's floor, failing the ref/page floor
    // open on the next action. Per-target closes that; each entry is refreshed
    // ONLY by an observation on that same target — never derived from label text.
    // See `browser_safety::effective_action_class`, `browser_floor_refs_for_target`,
    // `browser_set_target_floor`.
    pub(crate) last_payment_floor_refs:
        std::collections::HashMap<String, std::collections::HashSet<String>>,
    // Per-`target_id` payment context (focus flag + robust last-acted-floored
    // flag). Replaces the single global `last_focus_payment_context: bool` (fixes
    // IMPORTANT D — a snapshot of tab A must not clear tab B's payment context).
    // Mirrors `last_payment_floor_refs` above, which is now ALSO per-target for
    // the same reason (Build1 Fix 3). See `BrowserPaymentContext`.
    pub(crate) payment_context_by_target: std::collections::HashMap<String, BrowserPaymentContext>,
    pub(crate) result_contract: Option<local_first_engine::browse::BrowseResultContract>,
    pub(crate) current_target: String,
    pub(crate) opened_targets: Vec<String>,
    pub(crate) nav_failures: std::collections::HashMap<String, u32>,
    pub(crate) state: &'a AppState,
    pub(crate) tx: &'a StreamSink,
    pub(crate) thread_id: Option<&'a str>,
    pub(crate) prompt: &'a str,
    pub(crate) read_only: bool,
    pub(crate) channel_owner: bool,
    // C2: durable sink for redacted browser-protocol metrics (never raw page text/snapshots — see
    // `browser_protocol_journal_event`). `Disabled` when the caller has no registered agent_run_id
    // (e.g. no journal for this run) — recording is then a silent no-op, never a fabricated id.
    pub(crate) journal: agent_journal::GatewayJournal,
    pub(crate) execution_contract:
        Option<local_first_execution_protocol::ValidatedExecutionContract>,
    pub(crate) effect_run_id: Option<String>,
    pub(crate) turn_id: Option<String>,
    // Phase 3.2: step memory ring buffer (max 5 entries of [tool_name, first_ref, ok_or_error]).
    // `None` when `HOMUN_BROWSER_STEP_MEMORY` is not enabled.
    pub(crate) step_memory: Option<std::collections::VecDeque<[String; 3]>>,
    // Phase 4.1: auto-screenshot after every successful browser_navigate / browser_act.
    pub(crate) auto_screenshot: bool,
    // Phase 4.2: capture a screenshot when browser_no_progress reaches 2.
    pub(crate) screenshot_on_stall: bool,
    // Anti-loop (task 69): consecutive explicit `browser_snapshot` calls without a
    // meaningful interaction. Auto-observations after browser_act/browser_navigate
    // do NOT count — only the model's own `browser_snapshot` tool calls.
    pub(crate) consecutive_snapshot_count: u32,
    pub(crate) recent_action_signatures: std::collections::VecDeque<String>,
    pub(crate) recent_failed_action_families: std::collections::VecDeque<String>,
}

impl Drop for GatewayBrowserExecutor<'_> {
    // Guarantee the "● LIVE" browser indicator clears on EVERY exit. `close_session` is the
    // normal cleanup (parks the session + clears the indicator), but it runs only on graceful
    // exit paths — a turn CANCEL/abort drops this executor's future before it, leaving the
    // frozen browser frame stuck LIVE forever. Clearing here on drop is idempotent (→ None)
    // and covers cancel, abort, and panic. (Session parking still happens in close_session.)
    fn drop(&mut self) {
        end_browser_activity();
    }
}

impl local_first_engine::BrowserExecutor for GatewayBrowserExecutor<'_> {
    async fn execute_browser(
        &mut self,
        name: &str,
        args_raw: &str,
        call_id: &str,
        ls: &mut local_first_engine::LoopState,
    ) -> local_first_engine::ToolOutcome {
        if self
            .turn_id
            .as_deref()
            .is_some_and(crate::turn_executor::turn_is_cancelled)
        {
            return local_first_engine::ToolOutcome {
                result: "TURN CANCELLED: no browser action was executed.".to_string(),
                effects: Default::default(),
            };
        }
        if name == "browser_done" {
            let payload = parse_browser_done_payload(args_raw).unwrap_or_else(|error| {
                tracing::warn!(target: "browser::contract", %error, "browser_done payload rejected");
                local_first_engine::browse::BrowserDonePayload {
                    status: local_first_engine::browse::BrowserDoneStatus::Blocked,
                    answer: "Browser stopped because its terminal result was structurally invalid."
                        .to_string(),
                    evidence: vec!["browser_done payload failed structural validation".to_string()],
                    ..Default::default()
                }
            });
            let stop_reason = serde_json::to_string(&payload.status)
                .unwrap_or_else(|_| "\"partial\"".to_string())
                .trim_matches('"')
                .to_string();
            let result = local_first_engine::browse::validate_browser_done_payload(
                payload,
                self.result_contract.as_ref(),
            );
            let metrics = serde_json::json!({
                "stop_reason": stop_reason,
                "action_kinds": ["browser_done"],
            });
            self.journal.record(browser_protocol_journal_event(
                call_id,
                "browser_done",
                &metrics,
            ));
            push_browser_step(
                browser_protocol_event_summary(call_id, "browser_done", metrics),
                "done",
            );
            return local_first_engine::ToolOutcome {
                result: local_first_engine::browse::browse_result_for_manager(&result),
                effects: local_first_engine::ToolEffects {
                    outcome_hint: Some(local_first_engine::contract::ToolOutcomeHint::Success),
                    ..Default::default()
                },
            };
        }
        // The browser branch mutates its ctx directly (disjoint read-set): browser-private state from
        // `&mut self`, loop-visible browser fields + provider from `&mut ls`. `browser_session` is
        // threaded separately (its Cell/RefCell would make the ctx non-`Sync`). ADR 0025 folds this
        // whole ctx into a recursive `browse(goal)` and the seam goes away.
        //
        let mut outcome_hint: Option<local_first_engine::contract::ToolOutcomeHint> = None;
        let mut suspend_effect_receipt = None;
        // Compute vision support through the single catalog gate used by the
        // browse sub-loop policy. Browser screenshots are automatic diagnostics,
        // so unknown vision support must fail closed here too.
        let model_supports_vision =
            model_supports_vision(&ls.provider.base_url, &ls.provider.model);
        let mut text = {
            let mut bctx = BrowserToolCtx {
                browser_used: &mut ls.browser_used,
                last_snapshot: &mut self.last_snapshot,
                last_snapshot_semantic_fingerprint: &mut self.last_snapshot_semantic_fingerprint,
                payment_floor_refs: &mut self.last_payment_floor_refs,
                payment_context_by_target: &mut self.payment_context_by_target,
                pending_browser_image: &mut ls.pending_browser_image,
                browser_tool_call_ids: &mut ls.browser_tool_call_ids,
                current_target: &mut self.current_target,
                opened_targets: &mut self.opened_targets,
                nav_failures: &mut self.nav_failures,
                state: self.state,
                tx: self.tx,
                thread_id: self.thread_id,
                prompt: self.prompt,
                read_only: self.read_only,
                channel_owner: self.channel_owner,
                journal: &self.journal,
                execution_contract: self.execution_contract.as_ref(),
                effect_run_id: self.effect_run_id.as_deref(),
                suspend_effect_receipt: &mut suspend_effect_receipt,
                outcome_hint: &mut outcome_hint,
                model_supports_vision,
            };
            execute_browser_tool(
                &mut bctx,
                &mut self.browser_session,
                name,
                args_raw,
                call_id,
            )
            .await
        };
        if name == "browser_navigate" {
            record_browser_navigate_source(&mut self.browse_sources, &text);
        }
        // Phase 3.2: record this tool's outcome in the step memory ring buffer.
        if let Some(step_mem) = self.step_memory.as_mut() {
            let status = match outcome_hint {
                Some(local_first_engine::contract::ToolOutcomeHint::NoProgress) => "nop",
                _ => "ok",
            };
            let first_ref = serde_json::from_str::<serde_json::Value>(args_raw)
                .ok()
                .and_then(|v| {
                    v.get("ref")
                        .and_then(|r| r.as_str())
                        .map(str::to_string)
                        .or_else(|| {
                            v.get("actions")
                                .and_then(|a| a.as_array())
                                .and_then(|arr| arr.first())
                                .and_then(|first| first.get("ref"))
                                .and_then(|r| r.as_str())
                                .map(str::to_string)
                        })
                })
                .unwrap_or_default();
            let short_ref: String = first_ref.chars().take(30).collect();
            if step_mem.len() >= 5 {
                step_mem.pop_front();
            }
            step_mem.push_back([name.to_string(), short_ref, status.to_string()]);
        }
        // Anti-loop nudge (task 69): count consecutive explicit `browser_snapshot` calls.
        // Only the model's own snapshot tool calls increment — auto-observations returned
        // after browser_act/browser_navigate are separate tool results, not `browser_snapshot`
        // actions, so they don't count. The nudge is appended to the tool RESULT text (not
        // injected as a separate system message) so it arrives in the correct chat-API
        // position — sandwiching a system message between tool_call and tool_response
        // violates the contract and the model never sees it. After `threshold + 2`
        // consecutive snapshots the hard cap fires: the tool result becomes a failure
        // message and the outcome is marked `NoProgress` so the agent loop terminates the
        // browse sub-turn.
        let anti_loop_threshold = std::env::var("HOMUN_BROWSER_ANTI_LOOP_THRESHOLD")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(3);
        let (new_snapshot_count, anti_loop_nudge, hard_capped) =
            browser_anti_loop_nudge(self.consecutive_snapshot_count, name, anti_loop_threshold);
        self.consecutive_snapshot_count = new_snapshot_count;
        if hard_capped {
            tracing::warn!(
                target: "browser_anti_loop",
                threshold = anti_loop_threshold,
                "anti-loop HARD CAP: {} consecutive snapshots — terminating browse sub-turn",
                anti_loop_threshold.saturating_add(2),
            );
            return local_first_engine::ToolOutcome {
                result: anti_loop_nudge.unwrap_or_else(|| {
                    "Browser sub-turn terminated due to a snapshot loop.".to_string()
                }),
                effects: local_first_engine::ToolEffects {
                    outcome_hint: Some(local_first_engine::contract::ToolOutcomeHint::NoProgress),
                    ..Default::default()
                },
            };
        }
        if let Some(nudge) = anti_loop_nudge {
            tracing::info!(
                target: "browser_anti_loop",
                threshold = anti_loop_threshold,
                "anti-loop nudge appended to tool result: {} consecutive snapshots without action",
                new_snapshot_count,
            );
            text.push_str("\n\n");
            text.push_str(&nudge);
        }
        let repeated_action_threshold = std::env::var("HOMUN_BROWSER_REPEATED_ACTION_THRESHOLD")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(3);
        let (repeat_nudge, repeat_hard_capped) = repeated_browser_action_nudge(
            &mut self.recent_action_signatures,
            name,
            args_raw,
            repeated_action_threshold,
        );
        if repeat_hard_capped {
            return local_first_engine::ToolOutcome {
                result: repeat_nudge
                    .map(|nudge| format!("{text}\n\n{nudge}"))
                    .unwrap_or(text),
                effects: local_first_engine::ToolEffects {
                    outcome_hint: Some(local_first_engine::contract::ToolOutcomeHint::NoProgress),
                    ..Default::default()
                },
            };
        }
        if let Some(nudge) = repeat_nudge {
            text.push_str("\n\n");
            text.push_str(&nudge);
            outcome_hint = Some(local_first_engine::contract::ToolOutcomeHint::NoProgress);
        }
        let failed_action_threshold = std::env::var("HOMUN_BROWSER_FAILED_ACTION_THRESHOLD")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(3);
        let (failed_action_nudge, failed_action_hard_capped) = repeated_browser_failed_action_nudge(
            &mut self.recent_failed_action_families,
            name,
            args_raw,
            matches!(
                outcome_hint,
                Some(local_first_engine::contract::ToolOutcomeHint::NoProgress)
            ),
            failed_action_threshold,
        );
        if failed_action_hard_capped {
            return local_first_engine::ToolOutcome {
                result: failed_action_nudge
                    .map(|nudge| format!("{text}\n\n{nudge}"))
                    .unwrap_or(text),
                effects: local_first_engine::ToolEffects {
                    outcome_hint: Some(local_first_engine::contract::ToolOutcomeHint::NoProgress),
                    ..Default::default()
                },
            };
        }
        if let Some(nudge) = failed_action_nudge {
            text.push_str("\n\n");
            text.push_str(&nudge);
            outcome_hint = Some(local_first_engine::contract::ToolOutcomeHint::NoProgress);
        }
        // Phase 4.1: auto-screenshot after successful navigate/act.
        // Phase 4.2: screenshot on stall when browser_no_progress >= 2.
        let wants_auto_screenshot = self.auto_screenshot
            && matches!(name, "browser_navigate" | "browser_act")
            && !matches!(
                outcome_hint,
                Some(local_first_engine::contract::ToolOutcomeHint::NoProgress)
            );
        let wants_stall_screenshot = self.screenshot_on_stall && ls.browser_no_progress >= 2;
        if (wants_auto_screenshot || wants_stall_screenshot) && ls.pending_browser_image.is_none() {
            let mut ss_hint: Option<local_first_engine::contract::ToolOutcomeHint> = None;
            let mut ss_receipt = None;
            let mut bctx = BrowserToolCtx {
                browser_used: &mut ls.browser_used,
                last_snapshot: &mut self.last_snapshot,
                last_snapshot_semantic_fingerprint: &mut self.last_snapshot_semantic_fingerprint,
                payment_floor_refs: &mut self.last_payment_floor_refs,
                payment_context_by_target: &mut self.payment_context_by_target,
                pending_browser_image: &mut ls.pending_browser_image,
                browser_tool_call_ids: &mut ls.browser_tool_call_ids,
                current_target: &mut self.current_target,
                opened_targets: &mut self.opened_targets,
                nav_failures: &mut self.nav_failures,
                state: self.state,
                tx: self.tx,
                thread_id: self.thread_id,
                prompt: self.prompt,
                read_only: self.read_only,
                channel_owner: self.channel_owner,
                journal: &self.journal,
                execution_contract: self.execution_contract.as_ref(),
                effect_run_id: self.effect_run_id.as_deref(),
                suspend_effect_receipt: &mut ss_receipt,
                outcome_hint: &mut ss_hint,
                model_supports_vision,
            };
            let _ = execute_browser_tool(
                &mut bctx,
                &mut self.browser_session,
                "browser_screenshot",
                "{}",
                "auto_ss",
            )
            .await;
            if ls.browser_no_progress >= 2 {
                ls.browser_no_progress = 0;
            }
        }
        local_first_engine::ToolOutcome {
            result: text,
            effects: local_first_engine::ToolEffects {
                suspend_effect_receipt,
                outcome_hint: Some(
                    outcome_hint.unwrap_or(local_first_engine::contract::ToolOutcomeHint::Success),
                ),
                ..Default::default()
            },
        }
    }

    async fn close_session(&mut self, browser_used: bool) {
        // Turn end (ALL exit paths converge here: normal answer, pending_confirm, round-budget break,
        // natural exhaustion). Park the browser session warm for the thread's next turn, or stop it for
        // an anonymous (thread-less) chat so the sidecar doesn't leak. Hide the "● LIVE" activity.
        if let Some(client) = self.browser_session.take() {
            end_browser_activity();
            match self.thread_id {
                Some(t) => {
                    let st = self.state.clone();
                    let t = t.to_string();
                    let _ = tokio::task::spawn_blocking(move || {
                        store_thread_browser_session(&st, &t, client);
                    })
                    .await;
                }
                None => {
                    let _ = tokio::task::spawn_blocking(move || {
                        let _ = client.call(BrowserMethod::Stop, serde_json::json!({}));
                    })
                    .await;
                }
            }
        } else if browser_used {
            // Session was lost mid-turn (spawn failed / call panicked): still clear
            // the live activity indicator.
            end_browser_activity();
        }
    }

    async fn interrupt(&mut self) {
        if let Some(client) = self.browser_session.take() {
            end_browser_activity();
            let _ = tokio::task::spawn_blocking(move || {
                let _ = client.call(BrowserMethod::Stop, serde_json::json!({}));
            })
            .await;
        }
    }
}

// ─── ADR 0025 — browse-as-recursion: the browser as a delegated sub-agent ────────────────────────
// The manager (the strong model, the one guarded loop) calls `browse(goal)`; that runs the SAME
// `engine::agent_loop::run_turn` RECURSIVELY with a browser-only toolset, the browser model, and an
// ISOLATED LoopState — so the sub-agent's snapshots/clicks/reasoning never pollute the manager's
// context or the user stream. Only the `BrowseResult` returns. The recursion terminates by TYPE: the
// sub-turn's CapabilityExecutor is `BrowseOnlyCapabilityExecutor` (no nested `browse`), a distinct
// monomorphization — so `run_turn` at the sub level is a different function instance, not an infinite
// call. Wired into the manager's toolset (ADR 0025 slice 2).

/// Focused system prompt for a `browse(goal)` sub-agent (ADR 0025). Deliberately SMALL and browser-only:
/// no orchestrator role, no plan/step machinery, no non-browser tools — the manager owns all of that. The
/// sub-agent's ONE job is to reach the goal in the real browser and OUTPUT the concrete value, then stop.
/// This tightness is the point: a clean, short context is what keeps the weak browser model from the
/// reasoning-floods / plan-JSON leaks it produces when handed the full orchestrator prompt.
pub(crate) fn browse_subagent_system_prompt(allow_rehydrate: bool) -> String {
    let available_tools = if allow_rehydrate {
        "browser_navigate, browser_snapshot, browser_act, browser_rehydrate, browser_screenshot, browser_tabs, browser_dialog, browser_done"
    } else {
        "browser_navigate, browser_snapshot, browser_act, browser_screenshot, browser_tabs, browser_dialog, browser_done"
    };
    format!(
        "You drive a REAL web browser to accomplish ONE information goal, then report the result. \
{now}. You have ONLY these tools: {available_tools}. There is no other tool and no plan to track — just \
browse and answer.\n\
\n\
METHOD:\n\
1. If the goal says \"start at <url>\", \"open <url>\", \"Apri <url>\", or includes a Starting page block, \
the gateway has ALREADY opened that page for you. First read the current snapshot and DO THE TASK RIGHT \
THERE. Do NOT search the web or navigate to Google/DDG for that goal. When the goal asks you to fill, \
click, select, or submit controls on that page, use browser_act on the opened page. Do NOT navigate to a \
different website or domain, and in particular do NOT switch to a brand's main portal (e.g. a company .com \
landing page) just because the goal mentions that brand: those portals are heavier and frequently BLOCK \
automation, so every action there hangs and times out. Stay on the page you were given and fill its form; \
only navigate elsewhere if the current page visibly cannot do the task at all (no relevant form/results \
after you actually read it). Otherwise, open a source with browser_navigate, then read the snapshot.\n\
2. FILLING A SEARCH/BOOKING FORM — one field at a time, and for each station/city/airport field you MUST \
select its suggestion before moving on:\n\
   a) kind='type' the name into the field (e.g. \"Napoli\").\n\
   b) After kind='type', inspect the returned observation. auto_complete is optional and by default \
uses DOM semantics: ARIA comboboxes may be committed by the browser sidecar, while plain/non-ARIA \
fields keep visible suggestions for you to inspect. If the action says AUTOCOMPLETE SELECTION \
COMMITTED, move to the next field. If suggestion option/list items are visible, CLICK the matching \
suggestion immediately from this observation. Do NOT type the next field until the current station \
is committed; otherwise the first field may clear and you'll be stuck re-typing it. If no suggestion \
list appears after one step, then you may press Enter.\n\
   IMPORTANT — every click (and every Enter/submit) MUST carry action_class, or it is REJECTED and nothing \
happens: use action_class=\"ordinary\" for normal interaction like picking a suggestion, opening a menu or \
pressing a search button; \"account\" for logging in; \"booking\" for reserving/selecting a seat or fare. \
Example: {{\"kind\":\"click\",\"ref\":\"e42\",\"action_class\":\"ordinary\"}}. This applies to EVERY click, \
including each item inside an `actions` bundle, and to kind='hold' (a press-and-hold verification is \
action_class=\"ordinary\"). If an action comes back rejected, FIX THAT ACTION and retry it on the SAME \
page — do not respond by navigating somewhere else. If instead an action is refused because the control \
is a PAYMENT control, do not try to work around it: stop and report what is blocked.\n\
   c) Only after the station is committed, move to the next field.\n\
For the DATE field use ONE kind='set_date' (date=YYYY-MM-DD); for the TIME field ONE kind='set_time' \
(time=HH:MM) — each drives the whole calendar/time widget in a single action, so NEVER click calendar days \
one by one. Resolve a relative/partial date against today's date shown above (e.g. \"18 agosto\" -> \
2026-08-18). When every field is set, click the search button. Do NOT bundle a station 'type' together \
with other actions — after typing a station you must stop and select its suggestion first. (You MAY bundle \
independent, non-autocomplete actions, e.g. set_date + set_time, in one browser_act `actions` array.)\n\
After every kind='type' into an autocomplete field, read the post-action snapshot and the action notes. If \n\
the field was auto-committed, continue. If a dropdown remains open, find the matching option element \n\
(role=option or similar) and click it. Example: {{\"kind\":\"click\",\"ref\":\"e123\",\"action_class\":\"ordinary\"}}.\n\
Use auto_complete=false only when you explicitly need to force manual dropdown inspection; use \n\
auto_complete=true only for a known-safe non-ARIA typeahead you want the sidecar to commit.\n\
2b. SELECTING A RESULT / CONTINUING A BOOKING — result pages (trains, flights, hotels) often expose BOTH \
a visible solution CARD and duplicate screen-reader buttons beside it (e.g. \"Vedi i dettagli…\", \
\"Torna alla pagina precedente\"). Prefer the control that CONTAINS the concrete option you want \
(train number, departure time, price): usually an unnamed `button [ref=…]` wrapping that row, or the \
price/buy control inside the same card. If a labeled CTA click comes back with \"page did NOT change\" \
(or the breadcrumb stays on the same step, e.g. still \"SCELTA VIAGGIO\"), do NOT repeat that ref — \
click the card/price control for that same solution instead. \"Continua\" / \"Avanti\" often appears ONLY \
AFTER you open the solution and pick a fare; if you do not see it yet, you are still on the results step.\n\
3. Prefer a login-free, text-rich source (Wikipedia, an official page) over login-walled or \
JavaScript-heavy SPAs. Keep 2-3 candidate sources; if one is blocked or has no data, try the next — \
do not repeat the same failing search.\n\
4. TO READ a long results table or article in full (all the train times, the whole standings table), \
call browser_snapshot — it returns the FULL page content. The observation you get back AFTER an action \
is kept compact so acting stays fast, so when you need to read a large block of data in full, take a \
browser_snapshot. EXTRACT AS YOU GO: the moment a page shows the value you need, copy the CONCRETE data \
(actual numbers, rows, names, dates) into your answer — page content is NOT retained once you navigate \
away.\n\
5. NEVER conclude \"no results\" from a partial view. After a search runs, the results often load a \
moment later and sit BELOW the visible part of the page. If the observation ends with a TRUNCATED \
marker, or you simply do not see rows yet: scroll down and read again (and if needed wait once), then \
take a browser_snapshot. Only report that nothing was found after you have actually read the results \
area and it is genuinely empty.\n\
6. STOP as soon as you have the answer by calling browser_done. Put every observed result-contract field \
in items: one object for a fact, one object per row for a list. The answer is display text only and does \
not satisfy required fields. If information is genuinely unavailable after trying your sources, report \
that status and the missing fields in browser_done. Do NOT invent values.",
        now = now_block(),
    )
}

pub(crate) fn browse_subagent_tool_schemas(
    read_only: bool,
    contract: Option<&local_first_engine::browse::BrowseResultContract>,
) -> Vec<serde_json::Value> {
    let mut schemas = vec![
        browser_navigate_tool_schema(),
        browser_snapshot_tool_schema(),
        browser_act_tool_schema(),
        browser_done_tool_schema(contract),
        browser_screenshot_tool_schema(),
        browser_tabs_tool_schema(),
        browser_dialog_tool_schema(),
    ];
    if !read_only {
        schemas.insert(2, browser_rehydrate_tool_schema());
    }
    schemas
}

/// A `StreamSink` whose events go NOWHERE (ADR 0025 isolation). The sub-agent's raw token/event stream
/// (its reasoning, tool narration, plan cards) must NOT reach the user — only the `BrowseResult` the
/// manager relays does. The sub `GatewayModelClient`/browser executor still need a concrete `StreamSink`
/// to stream into, so we hand them this drain: a detached task empties the mpsc receiver so the sub-loop's
/// `send`s never block, and the `StreamEntry` is unregistered (no resume, no WS mirror).
pub(crate) fn drain_stream_sink() -> StreamSink {
    let (mpsc_tx, mut rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(32);
    // Drain forever: keep the receiver alive and discard everything so the sub-loop never back-pressures.
    tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let (broadcast_tx, _) = tokio::sync::broadcast::channel::<String>(16);
    let entry = std::sync::Arc::new(StreamEntry {
        lines: std::sync::Mutex::new(Vec::new()),
        tx: broadcast_tx,
        finished: std::sync::atomic::AtomicBool::new(false),
        last_event_at: std::sync::atomic::AtomicU64::new(now_epoch_secs()),
        thread_id: None,
        assistant_message_id: std::sync::Mutex::new(None),
        outcome: std::sync::Mutex::new(None),
        outcome_ready: tokio::sync::Notify::new(),
    });
    StreamSink {
        mpsc: mpsc_tx,
        entry,
    }
}

/// Build the effective sub-turn goal from the manager's `browse` tool args (ADR 0025 slice 2). Parses
/// `{ goal, hints?: { url?, container? } }` and folds any hints INTO the goal text (the sub-agent's prompt
/// is browser-only and has no separate hint slot), so a preferred start URL / source steers it. Returns
/// "" when `goal` is missing/blank (the caller then refuses the call). Pure — unit-tested below.
#[derive(Debug, Clone)]
pub(crate) struct ParsedBrowseRequest {
    pub(crate) goal: String,
    pub(crate) hint_url: Option<String>,
    pub(crate) contract: Option<local_first_engine::browse::BrowseResultContract>,
}

pub(crate) fn parse_browse_request(args_raw: &str) -> ParsedBrowseRequest {
    let value: serde_json::Value =
        serde_json::from_str(args_raw).unwrap_or(serde_json::Value::Null);
    let goal = value
        .get("goal")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let hint_url = value
        .pointer("/hints/url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| v.starts_with("https://") || v.starts_with("http://"))
        .map(str::to_string)
        .or_else(|| direct_browse_start_url(&goal));
    let contract = value.get("result_contract").cloned().and_then(|v| {
        serde_json::from_value::<local_first_engine::browse::BrowseResultContract>(v).ok()
    });
    ParsedBrowseRequest {
        goal,
        hint_url,
        contract,
    }
}

pub(crate) fn direct_browse_start_url(goal: &str) -> Option<String> {
    let urls = goal
        .split_whitespace()
        .filter_map(|token| {
            let candidate = token.trim_matches(|c: char| {
                matches!(
                    c,
                    '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>' | ',' | ';' | '"' | '\'' | '.'
                )
            });
            (candidate.starts_with("https://") || candidate.starts_with("http://"))
                .then(|| candidate.to_string())
        })
        .collect::<Vec<_>>();
    if urls.len() != 1 {
        return None;
    }
    let normalized = goal.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = normalized.to_ascii_lowercase();
    let looks_like_open_goal = lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.contains("apri http://")
        || lower.contains("apri https://")
        || lower.contains("apri il link")
        || lower.contains("open http://")
        || lower.contains("open https://")
        || lower.contains("go to http://")
        || lower.contains("go to https://")
        || lower.contains("vai su http://")
        || lower.contains("vai su https://")
        || lower.contains("start at http://")
        || lower.contains("start at https://");
    looks_like_open_goal.then(|| urls[0].clone())
}

pub(crate) fn build_browse_user_goal(
    request: &ParsedBrowseRequest,
    hint_container: Option<&str>,
    initial_observation: Option<&str>,
) -> String {
    let goal = request.goal.trim();
    if goal.is_empty() {
        return String::new();
    }
    let mut out = goal.to_string();
    if let Some(url) = request.hint_url.as_deref() {
        out.push_str(&format!(
            "\n\nStarting page: {url}\n\
The gateway has already opened this URL in the browser before this sub-turn. Treat the current page as \
the source of truth. Do not search the web or navigate to Google/DDG for this goal. Read the current \
snapshot and, when the task asks to fill, click, select, or submit page controls, use browser_act on the \
opened page."
        ));
    }
    if let Some(container) = hint_container
        .map(str::trim)
        .filter(|container| !container.is_empty())
    {
        out.push_str(&format!("\n\nPreferred source/container: {container}"));
    }
    if let Some(observation) = initial_observation
        .map(str::trim)
        .filter(|observation| !observation.is_empty())
    {
        out.push_str(
            "\n\nInitial browser observation from the already-opened page. Use these [ref=...] \
values for browser_act before taking another snapshot:\n",
        );
        out.push_str(observation);
    }
    if let Some(contract) = &request.contract {
        out.push_str("\n\nResult contract:\n");
        out.push_str(&serde_json::to_string_pretty(contract).unwrap_or_default());
        out.push_str(&browse_result_contract_shape_hint(contract));
    }
    out
}

pub(crate) fn browse_result_contract_shape_hint(
    contract: &local_first_engine::browse::BrowseResultContract,
) -> String {
    let required = contract
        .fields
        .iter()
        .filter(|field| field.required)
        .map(|field| field.name.as_str())
        .collect::<Vec<_>>();
    if required.is_empty() {
        return String::new();
    }

    let mut example = serde_json::Map::new();
    for field in &contract.fields {
        example.insert(
            field.name.clone(),
            serde_json::Value::String(format!("<{}>", field.name)),
        );
    }
    let minimum_items = contract.minimum_items.unwrap_or(1).max(1);
    let kind = serde_json::to_string(&contract.kind).unwrap_or_else(|_| "\"list\"".to_string());
    let kind = kind.trim_matches('"');
    format!(
        "\n\nbrowser_done item shape:\n\
- Required item keys: {required_keys}\n\
- Put the data in `items`; the prose `answer` does not satisfy the contract.\n\
- For kind={kind}, return one object per result row. You need at least {minimum_items} item(s) unless \
the data is genuinely unavailable.\n\
- Example item object: {example}",
        required_keys = required.join(", "),
        kind = kind,
        example = serde_json::Value::Object(example)
    )
}

#[cfg(test)]
pub(crate) fn build_browse_goal(args_raw: &str) -> String {
    let parsed = parse_browse_request(args_raw);
    let v: serde_json::Value = serde_json::from_str(args_raw).unwrap_or(serde_json::Value::Null);
    let hint_container = v
        .get("hints")
        .and_then(|h| h.get("container"))
        .and_then(|c| c.as_str());
    build_browse_user_goal(&parsed, hint_container, None)
}

/// The manager can emit several `browse` calls in one response, but it cannot
/// have observed the first result while deciding the later calls. Execute only
/// the first browse in that model round; later calls are reconsidered after the
/// result is in context. This prevents blind multi-site wandering and keeps one
/// browser sub-agent in control of the shared contained browser at a time.
pub(crate) fn earlier_browse_call_in_current_round(
    messages: &[serde_json::Value],
    current_call_id: &str,
) -> bool {
    for message in messages.iter().rev() {
        let Some(calls) = message
            .get("tool_calls")
            .and_then(serde_json::Value::as_array)
        else {
            continue;
        };
        if !calls
            .iter()
            .any(|call| call.get("id").and_then(serde_json::Value::as_str) == Some(current_call_id))
        {
            continue;
        }
        for call in calls {
            if call.get("id").and_then(serde_json::Value::as_str) == Some(current_call_id) {
                return false;
            }
            if call
                .pointer("/function/name")
                .and_then(serde_json::Value::as_str)
                == Some("browse")
            {
                return true;
            }
        }
        return false;
    }
    false
}

pub(crate) const MAX_DISTINCT_BROWSE_CALLS_PER_TURN: usize = 2;

pub(crate) fn normalized_browse_goal(goal: &str) -> String {
    goal.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

pub(crate) fn browse_target_key(request: &ParsedBrowseRequest) -> String {
    let url = request.hint_url.as_deref().or_else(|| {
        request.goal.split_whitespace().find_map(|token| {
            let candidate = token.trim_matches(|c: char| {
                matches!(
                    c,
                    '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>' | ',' | ';' | '"' | '\''
                )
            });
            (candidate.starts_with("https://") || candidate.starts_with("http://"))
                .then_some(candidate)
        })
    });
    match url {
        Some(url) => format!("url:{}", url.trim_end_matches('/')),
        None => format!("goal:{}", normalized_browse_goal(&request.goal)),
    }
}

pub(crate) fn browse_goal_was_already_requested(
    messages: &[serde_json::Value],
    current_call_id: &str,
    goal: &str,
) -> bool {
    let wanted_request = ParsedBrowseRequest {
        goal: goal.to_string(),
        hint_url: None,
        contract: None,
    };
    let wanted = browse_target_key(&wanted_request);
    if wanted == "goal:" {
        return false;
    }
    let mut skipped_current_assistant = false;
    for message in messages.iter().rev() {
        let Some(calls) = message
            .get("tool_calls")
            .and_then(serde_json::Value::as_array)
        else {
            continue;
        };
        if !skipped_current_assistant
            && calls.iter().any(|call| {
                call.get("id").and_then(serde_json::Value::as_str) == Some(current_call_id)
            })
        {
            skipped_current_assistant = true;
            continue;
        }
        if calls.iter().any(|call| {
            if call
                .pointer("/function/name")
                .and_then(serde_json::Value::as_str)
                != Some("browse")
            {
                return false;
            }
            let args = call
                .pointer("/function/arguments")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("{}");
            browse_target_key(&parse_browse_request(args)) == wanted
        }) {
            return true;
        }
    }
    false
}

pub(crate) fn browse_call_within_turn_cap(completed: usize) -> bool {
    completed < MAX_DISTINCT_BROWSE_CALLS_PER_TURN
}

/// Preserve the readable `BrowseResult` contract for the manager while passing
/// progress and browser-usage facts to the guarded loop as typed metadata.
/// Nothing here interprets user prose or keywords.
pub(crate) fn delegated_browse_tool_outcome(
    result: &local_first_engine::BrowseResult,
    suspend_effect_receipt: Option<local_first_execution_protocol::EffectReceiptRef>,
) -> local_first_engine::ToolOutcome {
    let completed =
        result.found && result.status == local_first_engine::browse::BrowserDoneStatus::Completed;
    let terminal_negative_with_evidence = matches!(
        result.status,
        local_first_engine::browse::BrowserDoneStatus::Blocked
            | local_first_engine::browse::BrowserDoneStatus::Unavailable
    ) && (!result.answer.trim().is_empty()
        || !result.evidence.is_empty()
        || !result.sources.is_empty());
    local_first_engine::ToolOutcome {
        result: local_first_engine::browse::browse_result_for_manager(result),
        effects: local_first_engine::ToolEffects {
            browser_activity_observed: true,
            outcome_hint: Some(if completed || terminal_negative_with_evidence {
                local_first_engine::ToolOutcomeHint::Success
            } else {
                local_first_engine::ToolOutcomeHint::NoProgress
            }),
            suspend_effect_receipt,
            ..Default::default()
        },
    }
}

pub(crate) struct GatewayBrowseOutcome {
    pub(crate) result: local_first_engine::BrowseResult,
    pub(crate) suspend_effect_receipt: Option<local_first_execution_protocol::EffectReceiptRef>,
}

/// Round budget scaled from the declared result contract. Progress (the engine's
/// `max_no_progress`) is the primary limiter; this only sizes the ceiling so a
/// richer goal gets proportionally more rounds. Deterministic, no model input.
/// Absolute round backstop for one browse sub-turn. Must stay comfortably ABOVE the progress-relative
/// round budget: the latter resets on every successful browser action, so a healthy multi-field form
/// legitimately runs past it, and a hard ceiling equal to it silently truncated exactly those runs.
/// This bound only exists so a pathological loop cannot spin forever — the stall window (90s without
/// progress) and the absolute wall clock (300s) are what normally stop a stuck browse.
pub(crate) fn browse_hard_round_ceiling(rounds: usize) -> usize {
    rounds.saturating_add(8).max(24)
}

pub(crate) async fn await_browse_subturn_with_timeout<F>(
    future: F,
    timeout_ms: u64,
) -> Result<F::Output, tokio::time::error::Elapsed>
where
    F: std::future::Future,
{
    tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), future).await
}

pub(crate) fn browse_subturn_timeout_result(
    last_snapshot: &str,
    sources: Vec<String>,
    contract: Option<&local_first_engine::browse::BrowseResultContract>,
) -> local_first_engine::BrowseResult {
    browse_subturn_incomplete_result(
        last_snapshot,
        sources,
        contract,
        "Browser sub-turn exceeded its wall-clock budget.",
    )
}

pub(crate) fn browse_subturn_incomplete_result(
    last_snapshot: &str,
    sources: Vec<String>,
    contract: Option<&local_first_engine::browse::BrowseResultContract>,
    evidence: &str,
) -> local_first_engine::BrowseResult {
    let snapshot = last_snapshot.trim();
    let grounded_snapshot = !sources.is_empty() && snapshot.chars().count() >= 200;
    let structured_contract_unsatisfied = contract.is_some_and(|contract| {
        contract.minimum_items.unwrap_or(0) > 0
            || contract.fields.iter().any(|field| field.required)
    });
    let usable_grounded_snapshot = grounded_snapshot && !structured_contract_unsatisfied;
    let fallback_payload = local_first_engine::browse::BrowserDonePayload {
        status: if usable_grounded_snapshot {
            local_first_engine::browse::BrowserDoneStatus::Partial
        } else {
            local_first_engine::browse::BrowserDoneStatus::Timeout
        },
        answer: if usable_grounded_snapshot {
            format!(
                "The browser reached a grounded page but the browsing sub-agent did not finish its summary. Verify and extract the requested facts from this last page snapshot:\n{}",
                snapshot.chars().take(8_000).collect::<String>()
            )
        } else if grounded_snapshot {
            format!(
                "The browser timed out before satisfying the structured result contract. Last page snapshot for diagnostics only; do not treat it as completed results:\n{}",
                snapshot.chars().take(8_000).collect::<String>()
            )
        } else {
            snapshot.chars().take(2000).collect()
        },
        items: vec![],
        fields_missing: vec!["browser_done".into()],
        sources,
        evidence: vec![evidence.to_string()],
    };
    local_first_engine::browse::validate_browser_done_payload(fallback_payload, contract)
}

pub(crate) fn browse_round_budget(
    contract: &local_first_engine::browse::BrowseResultContract,
) -> usize {
    const BASE: usize = 12;
    const CAP: usize = 24;
    let required = contract.fields.iter().filter(|f| f.required).count();
    let items_bonus = if contract.minimum_items.unwrap_or(0) > 3 {
        1
    } else {
        0
    };
    (BASE + required.div_ceil(2) + items_bonus).clamp(BASE, CAP)
}

/// The recursive `browse(goal)` executor (ADR 0025). Holds the turn-constants the sub-seams need
/// (`AppState`, HTTP client, thread/prompt/request, perimeter flags); `browse` builds the browser-only
/// sub-seams + isolated `LoopState` and calls `engine::run_turn`. Constructed by the manager's `browse`
/// interception (slice 2) in `GatewayCapabilityExecutor::execute_tool`.
pub(crate) struct GatewayBrowseExecutor<'a> {
    pub(crate) state: &'a AppState,
    pub(crate) http: &'a reqwest::Client,
    // Activity relay (ADR 0025 encapsulation exception): the REAL sink of the enclosing manager
    // turn. The sub-turn's model tokens and engine events stay on the drain, but browser-action
    // ACT narration ("🌐 Opening…", "👁️ Re-reading…", "📸 Capturing…") must reach the island
    // Activity panel, so the sub browser executor is wired to this sink (see `sub_browser_executor`).
    pub(crate) tx: &'a StreamSink,
    pub(crate) thread_id: Option<&'a str>,
    pub(crate) prompt: &'a str,
    pub(crate) read_only: bool,
    pub(crate) channel_owner: bool,
    // C2: the enclosing manager turn's agent_run_id (owned — the executor outlives the borrow that
    // produced it), used to look up the SAME registered journal the manager's own turn writes to via
    // `agent_journal::for_run`. `None`/unregistered both resolve to `GatewayJournal::Disabled` (a
    // silent no-op), never a fabricated id.
    pub(crate) agent_run_id: Option<String>,
    pub(crate) execution_contract:
        Option<local_first_execution_protocol::ValidatedExecutionContract>,
}

impl GatewayBrowseExecutor<'_> {
    /// Build the browser-only sub-executor for one browse sub-turn. Its narration port (`tx`) is
    /// wired to the REAL enclosing turn sink (`self.tx`) so browser-action ACT events reach the
    /// island Activity panel; everything else the sub-turn produces (model tokens via the sub
    /// `GatewayModelClient`, engine plan/terminal events via `run_turn`'s sink) stays on the
    /// caller's drain (ADR 0025 encapsulation). The browser branch of `execute_browser_tool`
    /// emits ONLY `‹‹ACT››` narration deltas on `ctx.tx` — no terminal/delta of the sub-turn's
    /// model output ever crosses this port.
    pub(crate) fn sub_browser_executor(
        &self,
        journal: agent_journal::GatewayJournal,
        result_contract: Option<local_first_engine::browse::BrowseResultContract>,
        step_memory: Option<std::collections::VecDeque<[String; 3]>>,
        auto_screenshot: bool,
        screenshot_on_stall: bool,
    ) -> GatewayBrowserExecutor<'_> {
        GatewayBrowserExecutor {
            browser_session: None,
            last_snapshot: String::new(),
            last_snapshot_semantic_fingerprint: String::new(),
            browse_sources: Vec::new(),
            last_payment_floor_refs: std::collections::HashMap::new(),
            payment_context_by_target: std::collections::HashMap::new(),
            result_contract,
            current_target: "chat_0".to_string(),
            opened_targets: Vec::new(),
            nav_failures: std::collections::HashMap::new(),
            state: self.state,
            tx: self.tx,
            thread_id: self.thread_id,
            prompt: self.prompt,
            read_only: self.read_only,
            channel_owner: self.channel_owner,
            journal,
            execution_contract: self.execution_contract.clone(),
            effect_run_id: self.agent_run_id.clone(),
            turn_id: self
                .execution_contract
                .as_ref()
                .map(|contract| contract.as_ref().execution_id.clone()),
            step_memory,
            auto_screenshot,
            screenshot_on_stall,
            consecutive_snapshot_count: 0,
            recent_action_signatures: std::collections::VecDeque::new(),
            recent_failed_action_families: std::collections::VecDeque::new(),
        }
    }

    /// Run one browser sub-turn for `goal` and return its `BrowseResult`. The recursion (this calls
    /// `run_turn`, which dispatches browser tools back through the sub `GatewayBrowserExecutor`) stays
    /// finite: the sub CapabilityExecutor type has no `browse`, so there is no self-recursive tool.
    async fn browse(&self, request: ParsedBrowseRequest) -> GatewayBrowseOutcome {
        // Browser model (falls back to the chat model when the browser role is auto/unresolved), so the
        // sub-agent runs on the small/cheap browsing model without ever switching the manager's provider.
        let (base_url, model, api_key) = browser_openai_stream_config()
            .or_else(chat_openai_stream_config)
            .unwrap_or_default();

        let mut user_goal = build_browse_user_goal(&request, None, None);

        // Seed the ISOLATED sub-state: a clean 2-message context and only granular browser tools.
        // Read-only objectives omit rehydration. Nothing from the manager crosses this boundary.
        let mut ls = local_first_engine::LoopState::new();
        ls.tool_schemas = browse_subagent_tool_schemas(self.read_only, request.contract.as_ref());
        ls.provider = local_first_engine::ProviderBinding {
            model,
            base_url,
            api_key,
        };

        // The sub-agent's stream is encapsulated (see drain_stream_sink): the sub model client and
        // `run_turn`'s engine sink stay on the drain, so model tokens and plan/terminal events never
        // leak into the manager turn (ADR 0025). The ONLY crossing is the browser executor's ACT
        // narration port, wired to the REAL turn sink (`self.tx`) so the island Activity panel sees
        // browser actions while the browse runs.
        let drain = drain_stream_sink();
        let model_client = crate::model_client::GatewayModelClient {
            http: self.http,
            tx: &drain,
            usage: self.state.usage_recorder.as_ref(),
            steering: None,
        };
        let mut usage_context = local_first_inference_usage::UsageContext::new(
            uuid::Uuid::new_v4().to_string(),
            local_first_inference_usage::InferencePurpose::Subagent,
            "local",
        );
        usage_context.purpose_detail = Some("browse".to_string());
        usage_context.thread_id = self.thread_id.map(str::to_string);
        let contract_fp = browser_contract_fingerprint(&request.contract);
        // C2: one durable journal handle for the whole sub-turn — resolves to the SAME registered
        // journal the enclosing manager turn writes to (`agent_journal::for_run` is a registry lookup
        // by run_id), or the silent `Disabled` no-op when this run has none registered.
        let journal = agent_journal::for_run(self.agent_run_id.as_deref());
        let start_metrics = serde_json::json!({
            "stop_reason": "started",
            "action_kinds": ["browse"],
            "minimum_items": request.contract.as_ref().and_then(|contract| contract.minimum_items).unwrap_or(0),
            "contract_fields": request.contract.as_ref().map(|contract| contract.fields.len() as u64).unwrap_or(0),
            "contract_fp": contract_fp,
        });
        journal.record(browser_protocol_journal_event(
            usage_context.call_id.as_str(),
            "manager_browse_start",
            &start_metrics,
        ));
        push_browser_step(
            browser_protocol_event_summary(
                usage_context.call_id.as_str(),
                "manager_browse_start",
                start_metrics,
            ),
            "done",
        );
        // The tool chokepoint is browser-only: offered browser tools route through the fresh browser
        // executor below; any non-browser call is refused (defense — none are offered in tool_schemas).
        let capability_executor = BrowseOnlyCapabilityExecutor;
        // ACT narration exits the encapsulation here (`self.tx` = the real turn sink); everything
        // else the sub-turn emits stays on `drain` (see `sub_browser_executor`).
        // Phase 3.2: step memory ring buffer, enabled by HOMUN_BROWSER_STEP_MEMORY.
        let step_memory = match std::env::var("HOMUN_BROWSER_STEP_MEMORY").ok().as_deref() {
            Some("true" | "1") => Some(std::collections::VecDeque::with_capacity(5)),
            _ => None,
        };
        // Phase 4.1: auto-screenshot after navigate/act, enabled by HOMUN_BROWSER_AUTO_SCREENSHOT.
        let auto_screenshot = matches!(
            std::env::var("HOMUN_BROWSER_AUTO_SCREENSHOT")
                .ok()
                .as_deref(),
            Some("true" | "1")
        );
        // Phase 4.2: screenshot on stall (default ON), disabled by HOMUN_BROWSER_SCREENSHOT_ON_STALL=false/0.
        let screenshot_on_stall = !matches!(
            std::env::var("HOMUN_BROWSER_SCREENSHOT_ON_STALL")
                .ok()
                .as_deref(),
            Some("false" | "0")
        );
        let mut browser_executor = self.sub_browser_executor(
            journal.clone(),
            request.contract.clone(),
            step_memory,
            auto_screenshot,
            screenshot_on_stall,
        );
        if let Some(hint_url) = request.hint_url.as_deref() {
            let nav_args = serde_json::json!({
                "url": hint_url,
                "target": "chat_0"
            })
            .to_string();
            let pre_navigation =
                <GatewayBrowserExecutor as local_first_engine::BrowserExecutor>::execute_browser(
                    &mut browser_executor,
                    "browser_navigate",
                    &nav_args,
                    "pre_nav",
                    &mut ls,
                )
                .await;
            if let Some(receipt_ref) = pre_navigation.effects.suspend_effect_receipt {
                return GatewayBrowseOutcome {
                    result: local_first_engine::BrowseResult::not_found(
                        "Pre-navigation requires verification before browsing can continue.",
                    ),
                    suspend_effect_receipt: Some(receipt_ref),
                };
            }
            let pre_nav_success = !matches!(
                pre_navigation.effects.outcome_hint,
                Some(local_first_engine::contract::ToolOutcomeHint::NoProgress)
            );
            let pre_nav_metrics = serde_json::json!({
                "stop_reason": if pre_nav_success { "completed" } else { "no_progress" },
                "action_kinds": ["navigate"],
            });
            journal.record(browser_protocol_journal_event(
                usage_context.call_id.as_str(),
                "trusted_pre_navigation",
                &pre_nav_metrics,
            ));
            push_browser_step(
                browser_protocol_event_summary(
                    usage_context.call_id.as_str(),
                    "trusted_pre_navigation",
                    pre_nav_metrics,
                ),
                "done",
            );
            if pre_nav_success {
                user_goal =
                    build_browse_user_goal(&request, None, Some(pre_navigation.result.as_str()));
            }
        }
        ls.messages = local_first_engine::browse::seed_browse_messages(
            &browse_subagent_system_prompt(!self.read_only),
            &user_goal,
        );
        // The sub-turn does NO plan tracking / F3 compaction / route-blocking / completion-nudging — that
        // is the manager's job. All four ports are inert no-ops, and the cfg disables the plan machinery.
        let plan_progress = NoPlanProgress;
        let compactor = NoContextCompactor;
        let turn_policy = OpenTurnPolicy;
        let completion_judge = NeverIncompleteJudge;
        // `request.contract` is optional; `browse_round_budget` is defined over a declared
        // contract, so a missing one falls back to BASE (5) — the same default as the prior
        // hard-coded round count — rather than synthesizing a contract to feed it.
        let rounds = request
            .contract
            .as_ref()
            .map(browse_round_budget)
            .unwrap_or(12);
        let cfg = local_first_engine::TurnConfig {
            // NOT `rounds`: the soft budget below is progress-relative (it resets on every successful
            // browser action), but `hard_round_ceiling` is the raw `for round in 0..N` bound, so
            // setting both to the same number made the soft budget unreachable — a browse that
            // advanced a field every round was still cut off at exactly `rounds`, which is the
            // timeout users kept hitting on multi-field searches (8 rounds, ~47s, every action
            // successful). The hard ceiling must be a runaway backstop only; the real controls are
            // the progress-relative round budget plus the stall/wall-clock budgets below.
            hard_round_ceiling: browse_hard_round_ceiling(rounds),
            max_rounds: rounds,
            browser_max_rounds: rounds,
            browser_nav_cap: browse_subagent_nav_cap_for_contract(request.contract.as_ref()),
            browser_budget: local_first_engine::config::BrowserBudget {
                // `max_elapsed_ms` is now the ABSOLUTE backstop (never resets) — generous, so a
                // progressing browse is never choked by it. The PRIMARY control is `max_stall_ms`:
                // max wall-clock WITHOUT a success, reset on every real progress (a selected
                // suggestion, a page change, a navigation). This is what lets a slow model finish a
                // multi-field form the old 90s-from-start ceiling killed at ~2 rounds. The round
                // budget still sizes how far a progressing run may go.
                max_elapsed_ms: BROWSE_SUBTURN_MAX_ELAPSED_MS,
                max_stall_ms: 90_000,
                max_failed_navigations: 4,
                max_no_progress: 3,
            },
            // Browse sub-turn does NO token-budget compaction (NoContextCompactor); the browser
            // history hygiene it needs is `prune_browser_history`. Unknown window → fail-open anyway.
            context_window: None,
            reconcile_on_delivery: false,
            autoadvance_from_evidence: false,
            step_verification: false,
            verbose: verbose_debug(),
            // The browse sub-turn only ever offers its browser tools (BrowseOnlyCapabilityExecutor
            // above) — a deterministic plugin routing (S2) never targets one of those, so forcing is
            // never applicable here.
            forced_tool: None,
            // E2: THIS is the browse sub-turn — `browser_done` is its own completion signal, so the
            // engine's terminal must be armed here.
            browser_subturn: true,
            resolved_hitl: None,
        };

        let outcome = await_browse_subturn_with_timeout(
            local_first_engine::agent_loop::run_turn(
                ls,
                cfg,
                &usage_context,
                &model_client,
                &capability_executor,
                &mut browser_executor,
                &plan_progress,
                &completion_judge,
                &compactor,
                &turn_policy,
                // C2: a real journal handle (not a fabricated id) so engine-emitted events for this
                // sub-turn — including `BrowserBudgetExceeded` — persist alongside the protocol metrics
                // recorded above/below, when the enclosing run has one registered.
                &journal,
                &drain,
                0.2, // low temperature: deterministic extraction, not creative writing
                self.thread_id,
                &std::collections::BTreeSet::new(),
                &[],
                user_goal.clone(),
                String::new(),
                None,
                false,
                0,
                false,
                Vec::new(),
                None, // no trace-dump inside the sub-turn
                // Sub-turns don't spam the readable per-turn trace (ADR 0025): the manager's turn owns it.
                &local_first_engine::turn_trace::TurnTrace::disabled(),
            ),
            BROWSE_SUBTURN_MAX_ELAPSED_MS,
        )
        .await;
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(_elapsed) => {
                let timeout_metrics = serde_json::json!({
                    "observation_chars": browser_executor.last_snapshot.chars().count() as u64,
                    "stop_reason": "timeout",
                    "action_kinds": ["browser_done"],
                    "timeout_ms": BROWSE_SUBTURN_MAX_ELAPSED_MS,
                });
                journal.record(browser_protocol_journal_event(
                    usage_context.call_id.as_str(),
                    "hard_timeout",
                    &timeout_metrics,
                ));
                push_browser_step(
                    browser_protocol_event_summary(
                        usage_context.call_id.as_str(),
                        "hard_timeout",
                        timeout_metrics,
                    ),
                    "error",
                );
                return GatewayBrowseOutcome {
                    result: browse_subturn_timeout_result(
                        &browser_executor.last_snapshot,
                        browser_executor.browse_sources.clone(),
                        request.contract.as_ref(),
                    ),
                    suspend_effect_receipt: None,
                };
            }
        };

        let suspend_effect_receipt = match &outcome.stop {
            local_first_engine::TurnStop::SuspendedEffect { receipt_ref } => {
                Some(receipt_ref.clone())
            }
            _ => None,
        };

        if let Some(result) =
            local_first_engine::browse::browse_result_from_manager_text(&outcome.memory_answer)
        {
            let stop_reason = serde_json::to_string(&result.status)
                .unwrap_or_else(|_| "\"partial\"".to_string())
                .trim_matches('"')
                .to_string();
            let terminal_metrics = serde_json::json!({
                "stop_reason": stop_reason,
                "action_kinds": ["browser_done"],
            });
            journal.record(browser_protocol_journal_event(
                usage_context.call_id.as_str(),
                "terminal_result",
                &terminal_metrics,
            ));
            push_browser_step(
                browser_protocol_event_summary(
                    usage_context.call_id.as_str(),
                    "terminal_result",
                    terminal_metrics,
                ),
                "done",
            );
            return GatewayBrowseOutcome {
                result,
                suspend_effect_receipt,
            };
        }
        let timeout_metrics = serde_json::json!({
            "observation_chars": browser_executor.last_snapshot.chars().count() as u64,
            "stop_reason": "timeout",
            "action_kinds": ["browser_done"],
        });
        journal.record(browser_protocol_journal_event(
            usage_context.call_id.as_str(),
            "timeout_fallback",
            &timeout_metrics,
        ));
        push_browser_step(
            browser_protocol_event_summary(
                usage_context.call_id.as_str(),
                "timeout_fallback",
                timeout_metrics,
            ),
            "error",
        );
        let mut sources = outcome.browse_sources.clone();
        for source in &browser_executor.browse_sources {
            if !sources.contains(source) {
                sources.push(source.clone());
            }
        }

        GatewayBrowseOutcome {
            result: browse_subturn_incomplete_result(
                &browser_executor.last_snapshot,
                sources,
                request.contract.as_ref(),
                "Browser sub-turn ended before browser_done.",
            ),
            suspend_effect_receipt,
        }
    }
}

/// The sub-turn's tool chokepoint (ADR 0025): browser-only. The 6 granular browser tools route through
/// the `BrowserExecutor` seam, never here, so this only fires if the sub-model hallucinates a non-browser
/// call — which it can't legitimately do (none are offered). Refuse it with a corrective message rather
/// than executing anything, keeping the sub-agent inside its browser sandbox.
pub(crate) struct BrowseOnlyCapabilityExecutor;

pub(crate) struct GatewayComputerExecutor<'a> {
    pub(crate) state: &'a AppState,
    pub(crate) http: &'a reqwest::Client,
    pub(crate) thread_id: Option<&'a str>,
}

impl GatewayComputerExecutor<'_> {
    async fn run(&self, goal: &str) -> local_first_engine::BrowseResult {
        let session_id = uuid::Uuid::new_v4().to_string();
        if let Err(error) = host_computer_gateway::start_worker_session(&session_id, "Mac Apps") {
            return local_first_engine::BrowseResult::not_found(error);
        }
        let (base_url, model, api_key) = chat_openai_stream_config().unwrap_or_default();
        let system = format!(
            "You control explicitly approved Mac applications for ONE bounded goal. {now}\nUse only computer_list_apps, computer_get_state, and computer_action. Start by listing apps. Use only element indices from the latest snapshot; after every action fetch a fresh snapshot. Never guess a target. If a tool reports approval_required, paused_by_user, hard_denied, control_grant_required, session_terminated, or unavailable, stop and report it plainly — those are permissions or session states you cannot change by retrying, so never repeat the action; say what the user needs to grant or restart. Never attempt Terminal, password managers, secure fields, authorization UI, credentials, purchases, sends, deletion, or settings changes. Finish with a concise factual result.",
            now = now_block()
        );
        let mut ls = local_first_engine::LoopState::new();
        ls.messages = local_first_engine::browse::seed_browse_messages(&system, goal);
        ls.tool_schemas = vec![
            computer_list_apps_tool_schema(),
            computer_get_state_tool_schema(),
            computer_action_tool_schema(),
        ];
        ls.provider = local_first_engine::ProviderBinding {
            model,
            base_url,
            api_key,
        };
        let drain = drain_stream_sink();
        let model_client = crate::model_client::GatewayModelClient {
            http: self.http,
            tx: &drain,
            usage: self.state.usage_recorder.as_ref(),
            steering: None,
        };
        let mut usage_context = local_first_inference_usage::UsageContext::new(
            uuid::Uuid::new_v4().to_string(),
            local_first_inference_usage::InferencePurpose::Subagent,
            "local",
        );
        usage_context.purpose_detail = Some("host_computer".into());
        usage_context.thread_id = self.thread_id.map(str::to_string);
        let capability_executor = ComputerOnlyCapabilityExecutor {
            session_id: session_id.clone(),
        };
        let mut browser_executor = ComputerNoBrowserExecutor;
        let outcome = local_first_engine::agent_loop::run_turn(
            ls,
            local_first_engine::TurnConfig {
                hard_round_ceiling: 24,
                max_rounds: 16,
                browser_max_rounds: 0,
                browser_nav_cap: 0,
                browser_budget: chat_browser_budget(),
                context_window: None,
                reconcile_on_delivery: false,
                autoadvance_from_evidence: false,
                step_verification: false,
                verbose: verbose_debug(),
                forced_tool: None,
                // E2: this is the host-computer sub-turn, NOT the browse sub-turn — it never offers
                // `browser_done` as a real tool, so the terminal must stay disarmed here.
                browser_subturn: false,
                resolved_hitl: None,
            },
            &usage_context,
            &model_client,
            &capability_executor,
            &mut browser_executor,
            &NoPlanProgress,
            &NeverIncompleteJudge,
            &NoContextCompactor,
            &OpenTurnPolicy,
            &local_first_engine::NoopExecutionJournal,
            &drain,
            0.1,
            self.thread_id,
            &std::collections::BTreeSet::new(),
            &[],
            goal.to_string(),
            String::new(),
            None,
            false,
            0,
            false,
            Vec::new(),
            None,
            &local_first_engine::turn_trace::TurnTrace::disabled(),
        )
        .await;
        let result = local_first_engine::browse::browse_result_from_outcome(&outcome);
        host_computer_gateway::finish_worker_session(&session_id, result.found);
        result
    }
}

pub(crate) struct ComputerOnlyCapabilityExecutor {
    pub(crate) session_id: String,
}
impl local_first_engine::CapabilityExecutor for ComputerOnlyCapabilityExecutor {
    async fn execute_tool(
        &self,
        name: &str,
        args_raw: &str,
        _call_id: &str,
        _state: &mut local_first_engine::LoopState,
    ) -> Result<local_first_engine::ToolOutcome, String> {
        let result = match name {
            "computer_list_apps" => host_computer_gateway::worker_list_apps(&self.session_id).await,
            "computer_get_state" => {
                let value: serde_json::Value = serde_json::from_str(args_raw).unwrap_or_default();
                match value
                    .get("pid")
                    .and_then(|value| value.as_u64())
                    .and_then(|pid| u32::try_from(pid).ok())
                {
                    Some(pid) => {
                        host_computer_gateway::worker_get_state(&self.session_id, pid).await
                    }
                    None => Err("invalid_pid".into()),
                }
            }
            "computer_action" => match serde_json::from_str(args_raw) {
                Ok(request) => {
                    host_computer_gateway::worker_execute_action(&self.session_id, request).await
                }
                Err(error) => Err(format!("invalid_action:{error}")),
            },
            _ => Err(format!("tool_not_available:{name}")),
        };
        Ok(local_first_engine::ToolOutcome {
            result: match result {
                Ok(value) => value.to_string(),
                Err(error) => serde_json::json!({"error":error}).to_string(),
            },
            effects: Default::default(),
        })
    }
}

pub(crate) struct ComputerNoBrowserExecutor;
impl local_first_engine::BrowserExecutor for ComputerNoBrowserExecutor {
    async fn execute_browser(
        &mut self,
        name: &str,
        _args_raw: &str,
        _call_id: &str,
        _state: &mut local_first_engine::LoopState,
    ) -> local_first_engine::ToolOutcome {
        local_first_engine::ToolOutcome {
            result: format!("browser tool unavailable: {name}"),
            effects: local_first_engine::ToolEffects {
                outcome_hint: Some(local_first_engine::contract::ToolOutcomeHint::Success),
                ..Default::default()
            },
        }
    }
    async fn close_session(&mut self, _browser_used: bool) {}
}

impl local_first_engine::CapabilityExecutor for BrowseOnlyCapabilityExecutor {
    async fn execute_tool(
        &self,
        name: &str,
        _args_raw: &str,
        _call_id: &str,
        _state: &mut local_first_engine::LoopState,
    ) -> Result<local_first_engine::ToolOutcome, String> {
        Err(format!(
            "Tool '{name}' is not available while browsing. Use only the browser tools \
(browser_navigate / browser_snapshot / browser_act / browser_rehydrate / browser_screenshot / browser_tabs / \
browser_dialog), then write the final answer."
        ))
    }
}

/// Inert `PlanProgress` for the browse sub-turn (ADR 0025): the sub-agent tracks no plan (the manager
/// does), and the sub cfg disables every plan path, so all methods are no-ops / negative verdicts.
pub(crate) struct NoPlanProgress;

impl local_first_engine::PlanProgress for NoPlanProgress {
    async fn persist_plan(
        &self,
        _thread: Option<&str>,
        _goal: Option<&str>,
        _steps: &[serde_json::Value],
    ) {
    }
    async fn record_step_outcome(
        &self,
        _thread: Option<&str>,
        _step: &serde_json::Value,
        _evidence: &[String],
    ) {
    }
    async fn verify_step_complete(
        &self,
        _title: &str,
        _criterion: &str,
        _evidence: &str,
    ) -> (bool, String) {
        (false, String::new())
    }
    fn reconcile_on_delivery(
        &self,
        _plan: &serde_json::Value,
        _delivered: &str,
    ) -> Option<Vec<serde_json::Value>> {
        None
    }
    fn plan_value_from_steps(
        &self,
        _goal: Option<&str>,
        _steps: &[serde_json::Value],
    ) -> serde_json::Value {
        serde_json::Value::Null
    }
}

/// Inert `ContextCompactor` for the browse sub-turn (ADR 0025): no step compaction (there are no plan
/// steps to collapse); the browser history hygiene the sub-loop needs is `prune_browser_history`, not this.
pub(crate) struct NoContextCompactor;

impl local_first_engine::ContextCompactor for NoContextCompactor {
    async fn compact(&self, _messages: &mut Vec<serde_json::Value>, _start: &mut usize) -> bool {
        false
    }
}

/// Open `TurnPolicy` for the browse sub-turn (ADR 0025): nothing is route-blocked (the manager already
/// applied the turn's route to the `browse` call itself), and vision is resolved through the provider
/// catalog so a screenshot is injected only when the browser model can actually see it.
pub(crate) struct OpenTurnPolicy;

impl local_first_engine::TurnPolicy for OpenTurnPolicy {
    fn route_blocked(&self, _tool: &str) -> Option<String> {
        None
    }
    fn supports_vision(&self, base_url: &str, model: &str) -> bool {
        model_supports_vision(base_url, model)
    }
}

/// Inert `TurnCompletionJudge` for the browse sub-turn (ADR 0025): the no-plan completion nudge is a
/// manager concern; a browse sub-turn ends when the sub-model outputs its answer, never nudged to "keep
/// going". Always reports complete so the sub-loop delivers as soon as the model writes an answer.
pub(crate) struct NeverIncompleteJudge;

impl local_first_engine::TurnCompletionJudge for NeverIncompleteJudge {
    async fn task_appears_incomplete(&self, _request: &str, _work: &str) -> bool {
        false
    }
}
