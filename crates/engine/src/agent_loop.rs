//! The single guarded ReAct loop — motore #1 (ADR 0021), extracted into the engine (ADR 0024,
//! increment 5, Point 5 / 5.D1c.10).
//!
//! This is the canonical agent turn: a bounded round loop that calls the model, dispatches its tool
//! calls through the seams, tracks plan progress, and synthesizes a final answer. It is GENERIC over
//! its collaborators (the `contract` seams) so the engine stays decoupled from the gateway's concrete
//! `AppState`/transport — the gateway builds the impls and injects them.
//!
//! Convergence (ADR 0024, 5.D2, `50ed7ec6`): this IS the one loop. The gateway's inline copy and the
//! `HOMUN_ENGINE_CRATE` flag are deleted — `run_agent_rounds` builds the seams and calls `run_turn`
//! unconditionally (per "converge, don't duplicate"). ADR 0025 (browse-as-recursion) invokes this same
//! loop recursively for the browser sub-agent.

use crate::browser::{
    is_browser_granular_tool, is_stale_ref_recovery_result, prune_browser_history,
    resolve_browser_chat_tool_name,
};
use crate::contract::{
    BrowserExecutor, CapabilityExecutor, ContextCompactor, EventSink, ExecutionJournal,
    ModelClient, PlanProgress, TurnCompletionJudge, TurnControlDecision, TurnControlDisposition,
    TurnPolicy,
};
use crate::events::{GenerateStreamEvent, TokenMetrics};
use crate::execution_journal::{
    AgentExecutionEvent, classify_tool_result, tool_family, tool_result_fingerprint,
};
use crate::markers::{
    append_vault_reveal_marker_if_missing, extract_vault_reveal_marker,
    preserved_display_marker_blocks, visible_answer,
};
use crate::model_normalize;
use crate::plan::{
    advance_plan_frontier, answer_concludes_plan, build_plan_markdown, collapse_plan_markers,
    plan_next_open, plan_step_status, plan_step_title, plan_value_steps,
    replace_latest_plan_marker,
};
use crate::text::{extract_source_urls, fonti_section, is_low_value_source_url};
use crate::tools::{connected_capability_execution_trace_line, summarize_tool_action};
use crate::{LoopState, TurnConfig, TurnDelivery};
use std::time::Instant;

/// Max harness "you're not done — plan the rest" nudges per turn before giving up (F1 anti-loop).
const MAX_PLAN_NUDGES: u32 = 8;

/// Bounded wait, in 50ms wall-clock ticks, for an uninterpreted steering row at the finalization
/// fence before parking (≈ 40 × 50ms ≈ 2s). Deliberately wall-clock, not event-driven: the row may
/// never become interpretable (the semantic model can be down indefinitely), so the budget must
/// elapse on its own — replaces the old infinite spin, which parks instead of hanging.
const PARK_WAIT_CYCLES: u32 = 40;

async fn wait_for_interrupting_control<M: ModelClient>(
    model_client: &M,
) -> TurnControlDecision {
    loop {
        if let Some(control) = model_client.current_turn_control()
            && control.disposition != TurnControlDisposition::ContinueCurrentWork
        {
            return control;
        }
        let control = model_client.wait_for_turn_control().await;
        if control.disposition != TurnControlDisposition::ContinueCurrentWork {
            return control;
        }
    }
}

fn apply_turn_control<M: ModelClient>(
    model_client: &M,
    messages: &mut Vec<serde_json::Value>,
    control: &TurnControlDecision,
) {
    messages.push(serde_json::json!({
        "role": "user",
        "content": format!(
            "[VALIDATED USER STEERING]\n{}\n\nApply the structured runtime disposition {:?} now.",
            control.instruction,
            control.disposition,
        ),
    }));
    model_client.acknowledge_turn_control_applied(control.steering_id);
}

/// Harness-driven plan progress from VERIFIED evidence. Called after each work tool result: if the
/// plan has a frontier `doing` step and enough new evidence has accrued, ask the F2 judge whether that
/// step is genuinely complete; if so, mark it done, advance the frontier, and emit the ‹‹PLAN›› card +
/// persist — the same canonical live+durable update the model's own `step_advance` produces.
///
/// KEPT past ADR 0025 (which retired the browser model-switch) because it is NOT a browser band-aid: it
/// is the general weak-model safety net. A capable manager calls `step_advance` itself, but Homun also
/// runs on weak LOCAL models as the driver (ADR 0016/0018), which don't reliably self-advance — this is
/// how their multi-step plans progress. Verified-only, so a stuck step never fakes progress; stride-gated
/// so the (cheap `memory`-role) judge runs at most once per few tool results. Gated off entirely for the
/// browse sub-loop (its `TurnConfig` disables autoadvance) — the manager owns plan control-flow now.
///
/// Expressed over the seams (`PlanProgress` for verify/record/persist + the steps→Value bridge,
/// `EventSink` for the card, `TurnConfig` for the flags) — no `AppState`/transport/`ExecutionPlan`.
pub async fn try_advance_frontier_from_evidence(
    ls: &mut LoopState,
    plan_progress: &impl PlanProgress,
    execution_journal: &impl ExecutionJournal,
    event_sink: &impl EventSink,
    cfg: &TurnConfig,
    thread_id: Option<&str>,
    round: usize,
) {
    if !cfg.autoadvance_from_evidence || !cfg.step_verification {
        return;
    }
    // Evidence stride: only re-check after a few new tool outcomes since the last attempt.
    const EVIDENCE_STRIDE: usize = 3;
    if ls.step_evidence.len() < ls.progress_verify_anchor.saturating_add(EVIDENCE_STRIDE) {
        return;
    }
    ls.progress_verify_anchor = ls.step_evidence.len();
    let batch_evidence = ls.step_evidence.join("\n");
    if batch_evidence.is_empty() {
        return;
    }
    // Advance as many consecutive frontier steps as this evidence window confirms — bounded so a
    // single evidence window can never sweep the whole plan to done (that's the delivery reconcile's
    // job, not a mid-turn judge call).
    for _ in 0..2u8 {
        let plan_steps = plan_value_steps(&ls.plan);
        let Some(idx) = plan_steps
            .iter()
            .position(|s| plan_step_status(s) == "doing")
        else {
            return; // nothing in progress (plan complete or not started)
        };
        let title = plan_step_title(&plan_steps[idx]).to_string();
        let criterion = plan_steps[idx]
            .get("done_criterion")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let (ok, _reason) = plan_progress
            .verify_step_complete(&title, &criterion, &batch_evidence)
            .await;
        if !ok {
            return; // frontier step not proven done yet → leave it doing
        }
        let mut plan_steps = plan_steps;
        advance_plan_frontier(&mut plan_steps);
        let verified_step = plan_steps[idx].clone();
        // record_step_outcome clones the evidence internally (its impl offloads to spawn_blocking),
        // so pass the current window by ref — the same evidence the old inline clone captured pre-clear.
        plan_progress
            .record_step_outcome(thread_id, &verified_step, &ls.step_evidence)
            .await;
        ls.plan = plan_progress.plan_value_from_steps(&plan_steps);
        ls.progress_anchor_round = round; // F1: real progress → reset the stall guard
        event_sink
            .emit(GenerateStreamEvent::Delta {
                text: format!(
                    "‹‹ACT››✓ Step verified: {}‹‹/ACT››",
                    title.chars().take(60).collect::<String>()
                ),
            })
            .await;
        // The canonical live plan card (→ plan_update event) + durable runtime plan, exactly like
        // the model's own step_advance path.
        let plan_mark = format!("‹‹PLAN››{}‹‹/PLAN››", build_plan_markdown(&plan_steps));
        event_sink
            .emit(GenerateStreamEvent::Delta { text: plan_mark })
            .await;
        plan_progress.persist_plan(thread_id, &plan_steps).await;
        execution_journal.record(AgentExecutionEvent::PlanUpdated {
            round,
            source: "verified_evidence".to_string(),
        });
        // This evidence window was consumed by the advance — reset it + the stride anchor.
        ls.step_evidence.clear();
        ls.progress_verify_anchor = 0;
    }
}

/// Run ONE agent turn: the bounded guarded ReAct loop + forced synthesis. GENERIC over the seams so
/// the engine stays decoupled from the gateway's `AppState`/transport — the gateway builds the impls
/// (constructed per turn) and injects them. Returns the [`crate::TurnOutcome`] the gateway's post-turn
/// tail (memory learn + code-graph refresh) consumes. Called unconditionally by `run_agent_rounds`
/// (ADR 0024 5.D2) — no flag, no inline copy.
#[allow(clippy::too_many_arguments)] // the turn's seams + engine-safe data; grouped further post-5.D2.
pub async fn run_turn<M, C, B, P, J, K, Pol, X, E>(
    mut ls: LoopState,
    cfg: TurnConfig,
    usage_context: &local_first_inference_usage::UsageContext,
    model_client: &M,
    capability_executor: &C,
    browser_executor: &mut B,
    plan_progress: &P,
    completion_judge: &J,
    compactor: &K,
    turn_policy: &Pol,
    execution_journal: &X,
    event_sink: &E,
    temperature: f64,
    // by-ref: these are also borrowed by the gateway-constructed executors (dispatch shares one
    // construction), so the loop borrows them too rather than moving them out from under the executors.
    thread_id: Option<&str>,
    composio_writes: &std::collections::BTreeSet<String>,
    catalog_index: &[(String, String, serde_json::Value)],
    memory_user_message: String,
    mut memory_answer: String,
    _last_model_error: Option<String>,
    mut final_done: bool,
    mut plan_nudges: u32,
    mut turn_used_tools: bool,
    mut browse_sources: Vec<String>,
    trace_dir: Option<std::path::PathBuf>,
    // Readable per-turn observability sink (ported). A pure recorder: every `record` only appends a
    // JSON line (or no-ops when disabled), NEVER gates a decision — behavior-preserving by construction.
    // Sub-turns (the `browse` recursion) pass `TurnTrace::disabled()` so they don't spam the trace.
    turn_trace: &crate::turn_trace::TurnTrace,
) -> crate::TurnOutcome
where
    M: ModelClient,
    C: CapabilityExecutor,
    B: BrowserExecutor,
    P: PlanProgress,
    J: TurnCompletionJudge,
    K: ContextCompactor,
    Pol: TurnPolicy,
    X: ExecutionJournal,
    E: EventSink,
{
    let mut delivery = TurnDelivery::NoVisibleAnswer;
    let turn_started_at = Instant::now();
    let mut steering_to_complete = Vec::new();
    // Tracks the last round the loop actually ran, captured in outer scope because the `for`
    // loop's `round` binding does not survive past the loop (exhaustion or `break`) — the
    // post-loop finalization fence below needs it to checkpoint at the right round on park.
    let mut last_round: usize = 0;
    'rounds: for round in 0..cfg.hard_round_ceiling {
        last_round = round;
        if let Some(control) = model_client.current_turn_control() {
            apply_turn_control(model_client, &mut ls.messages, &control);
            steering_to_complete.push(control.steering_id);
            match control.disposition {
                TurnControlDisposition::FinalizeWithCurrentEvidence
                | TurnControlDisposition::NeedsClarification => break 'rounds,
                TurnControlDisposition::CancelCurrentWork => {
                    final_done = true;
                    break 'rounds;
                }
                TurnControlDisposition::ContinueCurrentWork
                | TurnControlDisposition::ReplanCurrentWork => {}
            }
        }
        if ls.browser_used {
            let elapsed_ms = u64::try_from(turn_started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
            if let Some(reason) = cfg.browser_budget.stop_reason(
                elapsed_ms,
                ls.browser_failed_navigations,
                ls.browser_no_progress,
            ) {
                execution_journal.record(AgentExecutionEvent::BrowserBudgetExceeded {
                    round,
                    reason: reason.as_str().to_string(),
                    elapsed_ms,
                    failed_navigations: ls.browser_failed_navigations,
                    no_progress: ls.browser_no_progress,
                });
                let _ = event_sink
                    .emit(GenerateStreamEvent::Activity {
                        text: format!("browser_budget_exceeded:{}", reason.as_str()),
                    })
                    .await;
                break;
            }
        }
        let max_rounds = if ls.browser_used {
            cfg.browser_max_rounds
        } else {
            cfg.max_rounds
        };
        // Hard stop once the effective budget is reached (the forced-synthesis
        // fallback below still runs because `final_done` is false). The budget is
        // measured from the last completed plan step (F1): `rounds_since_progress`
        // resets whenever a step closes, so a long plan-driven task isn't capped
        // by total rounds — only by getting STUCK on a single step.
        let rounds_since_progress = round.saturating_sub(ls.progress_anchor_round);
        if rounds_since_progress >= max_rounds {
            break;
        }
        // Wander-cap: the model has navigated to many sources for the CURRENT step
        // without closing it → it's hopping across walled/SPA pages that won't read.
        // Stop browsing and synthesize from what we already gathered (the forced-
        // synthesis below runs because `final_done` is false; #3a compaction kept the
        // data). `ls.step_evidence` is cleared on every step close, so this counts
        // navigations for the CURRENT step only. Restores 64f08e4d's budget control
        // for the distinct-URL case (cold-context consent walls → wander → burn).
        if ls.browser_used {
            let step_navs = ls
                .step_evidence
                .iter()
                .filter(|e| e.starts_with("browser_navigate"))
                .count();
            if step_navs >= cfg.browser_nav_cap {
                let _ = event_sink
                    .emit(GenerateStreamEvent::Delta {
                        text: "‹‹ACT››⏹️ Enough sources visited — synthesizing from what I \
gathered‹‹/ACT››"
                            .to_string(),
                    })
                    .await;
                break;
            }
        }
        // Context hygiene: at up to 32 rounds the ls.accumulated snapshots/images
        // would overflow the window and silently truncate the page. Stub all
        // but the latest browser snapshot + the latest screenshot image.
        prune_browser_history(&mut ls.messages, &ls.browser_tool_call_ids);
        // F3: a step was verified last round → collapse its ls.messages into a summary
        // now (safe boundary: all prior tool results are flushed). Keeps a long
        // multi-step turn from overflowing the context window.
        if ls.pending_compaction {
            ls.pending_compaction = false;
            execution_journal.record(AgentExecutionEvent::ContextCompacted {
                round,
                reason: "verified_step_boundary".to_string(),
            });
            compactor
                .compact(&mut ls.messages, &mut ls.step_messages_start)
                .await;
        }
        // Fase 1.1: token-budget auto-compaction (the memory-checkpoint path) — independent of
        // plan steps. Fires when the conversation approaches the model's context window, flushing
        // the older span to the memory engine and collapsing it in-context. Same safe round
        // boundary as the step compaction; fail-open (unknown window → no-op) so a turn without a
        // known window keeps exactly today's round-based hygiene.
        compactor
            .compact_for_budget(&mut ls.messages, cfg.context_window, &ls.memory_reads)
            .await;
        execution_journal.checkpoint(crate::LoopCheckpoint::from_state(round, &ls));
        // On the LAST allowed round, forbid tools so the model MUST synthesize
        // a final answer from what it already gathered — otherwise it can burn
        // every round on tool calls and end with no answer ("limite di passi").
        // On the LAST allowed round, OMIT tools entirely (do not rely on
        // tool_choice:"none" — minimax-via-Ollama ignores it and keeps calling
        // tools, so the loop never synthesizes and ends with "limite di passi").
        // Omitting the tools field forces a text answer.
        // Measure the "final round" from the LAST PROGRESS (per-step budget), NOT the
        // total round count — same basis as the `break` above. Using total `round` here
        // was a bug: a long but STEADILY PROGRESSING plan (e.g. a 5-step browse) hit
        // is_final_round at round 32 and got force-synthesized MID-PLAN, ending the turn
        // incomplete so the user had to keep typing "continua". Now the turn only forces a
        // final answer when a SINGLE step stalls for the whole budget (or the 600-round
        // hard ceiling) — so the harness drives the task end-to-end on its own.
        let is_final_round = rounds_since_progress + 1 >= max_rounds;
        // Final round: tools are omitted so the model MUST answer in text. Without an
        // explicit directive a model that was mid-browse writes a TRANSITION note
        // ("now I'll compose the briefing", "I'll update the plan") instead of the
        // deliverable, and that narration becomes the final answer (observed on Mondiali:
        // ~15 pages browsed, budget spent, ended on "compongo il briefing" with 0/4 steps).
        // Tell it to OUTPUT the finished deliverable from what it already gathered. The
        // separate forced-synthesis (`!final_done` path below) covers the case where the
        // model instead keeps calling tools until the budget breaks the loop.
        if is_final_round && turn_used_tools {
            ls.messages.push(serde_json::json!({
                "role": "user",
                "content": "This is your FINAL step — no more tools or browsing are \
available. Write the COMPLETE deliverable NOW from everything you already gathered: the full \
answer with the ACTUAL data (real rows/values/tables, every option), in the user's language. Do \
NOT narrate what you are about to do (no \"now I'll compose…\", no \"I'll update the plan…\") and \
do NOT promise further work — output the finished result itself. If some data is genuinely \
missing, give what you have and note the gap in one short line.",
            }));
        }
        // The per-round model call now lives in the engine::ModelClient impl (ADR 0024):
        // HTTP, retry/backoff, provider fallback, and the OpenAI/Ollama stream collectors are
        // owned there. A mid-round provider swap comes back via ProviderBinding so the next
        // rounds use the effective provider.
        execution_journal.record(AgentExecutionEvent::PromptSnapshot {
            round,
            snapshot: crate::execution_journal::build_prompt_snapshot_with_packets(
                &ls.provider.model,
                &ls.provider.base_url,
                &ls.messages,
                &ls.tool_schemas,
                is_final_round,
                if round == 0 {
                    cfg.forced_tool.as_deref()
                } else {
                    None
                },
                &ls.prompt_packets,
            ),
        });
        let mut round_usage = usage_context.clone();
        round_usage.call_id = format!("{}:round:{round}", usage_context.call_id);
        round_usage.round = u32::try_from(round).ok();
        let round_call = crate::ModelCall {
            base_url: &ls.provider.base_url,
            model: &ls.provider.model,
            api_key: ls.provider.api_key.as_deref(),
            messages: &ls.messages,
            tools: &ls.tool_schemas,
            temperature,
            is_final_round,
            forced_tool: if round == 0 {
                cfg.forced_tool.as_deref()
            } else {
                None
            },
            usage: &round_usage,
        };
        let mut control_during_model = None;
        let out = tokio::select! {
            out = model_client.generate(&round_call, &|_tok| {}) => Some(out),
            control = wait_for_interrupting_control(model_client) => {
                apply_turn_control(model_client, &mut ls.messages, &control);
                steering_to_complete.push(control.steering_id);
                execution_journal.checkpoint(crate::LoopCheckpoint::from_state(round, &ls));
                control_during_model = Some(control);
                None
            }
        };
        if let Some(control) = control_during_model {
            match control.disposition {
                TurnControlDisposition::ReplanCurrentWork => continue 'rounds,
                TurnControlDisposition::FinalizeWithCurrentEvidence
                | TurnControlDisposition::NeedsClarification => break 'rounds,
                TurnControlDisposition::CancelCurrentWork => {
                    final_done = true;
                    break 'rounds;
                }
                TurnControlDisposition::ContinueCurrentWork => continue 'rounds,
            }
        }
        let Some(out) = out else {
            continue 'rounds;
        };
        let (message, round_finish_reason) = match out {
            Ok(o) => {
                // Adopt any mid-turn fallback swap for the remaining rounds.
                ls.provider = o.provider;
                (o.message, o.finish_reason)
            }
            // Upstream and transport failures end the loop; a visible final answer may still be
            // recovered by the post-loop synthesis from accumulated turn prose.
            Err(crate::ModelCallError::Upstream(_)) => break,
            Err(crate::ModelCallError::Transport(_)) => break,
            // The model can't see the images it was sent. This is recoverable — but ONLY as a replay of
            // the whole turn from a re-seeded conversation, so it is recoverable only while the turn is
            // still inert. Once a tool has run, replaying would run it twice; at that point the
            // rejection is just a fatal upstream error like any other.
            Err(crate::ModelCallError::ImageUnsupported(reason)) => {
                if turn_used_tools {
                    break;
                }
                // Return with NOTHING emitted and nothing committed: no Done, no answer, no memory. The
                // gateway replaces the images with a vision model's description and calls us again, and
                // the user never sees that this attempt happened.
                return crate::TurnOutcome {
                    image_rejection: Some(reason),
                    ..Default::default()
                };
            }
        };
        let raw_content = message
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        let tool_calls = message
            .get("tool_calls")
            .and_then(|value| value.as_array())
            .filter(|calls| !calls.is_empty())
            .cloned()
            .or_else(|| {
                // Fallback: some models (e.g. minimax via Ollama) emit tool calls
                // as TEXT in their native template instead of the structured
                // tool_calls field. Parse those so the loop still progresses — but
                // NOT on the final round, which must synthesize a text answer.
                if is_final_round {
                    return None;
                }
                let known: Vec<String> = ls
                    .tool_schemas
                    .iter()
                    .filter_map(|t| {
                        t.get("function")
                            .and_then(|f| f.get("name"))
                            .and_then(|n| n.as_str())
                            .map(String::from)
                    })
                    .collect();
                let parsed = model_normalize::parse_text_tool_calls(&raw_content, &known);
                if parsed.is_empty() {
                    None
                } else {
                    Some(model_normalize::synthesize_tool_calls(round, parsed))
                }
            });

        execution_journal.record(AgentExecutionEvent::ModelResponse {
            round,
            finish_reason: round_finish_reason.clone(),
            content_chars: raw_content.chars().count(),
            tool_calls: tool_calls.as_ref().map_or(0, Vec::len),
        });

        // Turn trace: record this round's outcome (finish_reason + tools chosen) before `tool_calls` is
        // consumed below. Observability only — reads state, never alters it.
        turn_trace.record(crate::turn_trace::TurnEvent::Round {
            round,
            finish_reason: round_finish_reason.clone().unwrap_or_default(),
            tool_calls: tool_calls
                .as_ref()
                .map(|calls| {
                    calls
                        .iter()
                        .filter_map(|c| {
                            c.get("function")
                                .and_then(|f| f.get("name"))
                                .and_then(|n| n.as_str())
                                .map(String::from)
                        })
                        .collect()
                })
                .unwrap_or_default(),
            content_delta_len: raw_content.chars().count(),
        });

        if let Some(calls) = tool_calls {
            plan_nudges = 0; // the model is acting again → reset the stop-nudge cap
            turn_used_tools = true; // slice 2.5: acted → eligible for plan-bootstrap on a premature stop
            // No-progress guard: if this round's tool calls are IDENTICAL to the
            // previous round's, the agent is stuck repeating itself → stop after a
            // couple of repeats and let the forced synthesis answer.
            let round_sig = calls
                .iter()
                .map(|c| {
                    let f = c.get("function");
                    let name = f
                        .and_then(|f| f.get("name"))
                        .and_then(|n| n.as_str())
                        .unwrap_or("");
                    let args = f
                        .and_then(|f| f.get("arguments"))
                        .and_then(|a| a.as_str())
                        .unwrap_or("");
                    format!("{name}:{args}")
                })
                .collect::<Vec<_>>()
                .join("|");
            if !round_sig.is_empty() && round_sig == ls.last_round_sig {
                ls.repeat_count += 1;
                if ls.repeat_count >= 2 {
                    let _ = event_sink
                        .emit(GenerateStreamEvent::Delta {
                            text:
                                "‹‹ACT››⏹️ Same actions repeated: stopping and summarizing‹‹/ACT››"
                                    .to_string(),
                        })
                        .await;
                    break;
                }
            } else {
                ls.repeat_count = 0;
                ls.last_round_sig = round_sig;
            }
            // Echo the assistant's tool-call turn, then append each tool result.
            // Content is sanitized so a leaked text tool-call doesn't pollute the
            // conversation history.
            ls.messages.push(serde_json::json!({
                "role": "assistant",
                "content": model_normalize::sanitize_model_text(&raw_content),
                "tool_calls": calls,
            }));
            // Set when a write tool needs confirmation: we stop the loop and let
            // the user run it from the card instead of looping/hallucinating.
            let mut pending_confirm = false;
            let mut stop_for_no_progress = false;
            let mut nudge_no_progress = false;
            let mut control_after_tools = None;
            // Bundle the turn-level state the dispatch loop touches into `ctx` so
            // the loop body addresses it via `ctx.<field>` (the seam a later refactor
            // extracts into a function). Built once per round; its block ends right
            // after the dispatch loop so the borrows release before the post-loop
            // reads (screenshot push, `if pending_confirm`) touch the raw locals.
            {
                for (idx, call) in calls.iter().enumerate() {
                    // Parity-harness snapshots (see `tool_trace_dump`): capture the
                    // pre-dispatch state so the record built after the tool push can
                    // measure the deltas. Zero cost beyond three cheap reads when the
                    // dump is disarmed; the record itself is fully gated below.
                    // `pc_before` lets us attribute `pending_confirm` to the call that
                    // RAISED it (the flag lives outside the loop and is never reset).
                    let acc_before = ls.accumulated.len();
                    let msgs_before = ls.messages.len();
                    let pc_before = pending_confirm;
                    let name = call
                        .get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(|n| n.as_str())
                        .unwrap_or("");
                    let args_raw = call
                        .get("function")
                        .and_then(|f| f.get("arguments"))
                        .and_then(|a| a.as_str())
                        .unwrap_or("{}");
                    let call_id = call
                        .get("id")
                        .and_then(|i| i.as_str())
                        .unwrap_or("")
                        .to_string();
                    // Recover a typo'd native browser tool name (e.g. "browser_tavigate")
                    // BEFORE dispatch, so it matches the native browser arm instead of
                    // falling through to the Composio catch-all (404 → model loops). The
                    // `browser_` namespace is reserved for native tools. No-op for any
                    // non-browser tool name.
                    let name = match resolve_browser_chat_tool_name(name) {
                        Some(canonical) => canonical,
                        None => name,
                    };

                    if let Some(blocked) = turn_policy.route_blocked(name) {
                        // Parity harness: the blocked arm pushes a tool message then
                        // `continue`s, jumping over the normal record block below. The
                        // upcoming extraction handles this arm specially, so it MUST be
                        // visible to the oracle — emit a record here with `blocked:true`.
                        // Compute the `blocked`-derived fingerprint fields BEFORE the
                        // push moves `blocked` into the message. Fully gated → no cost
                        // when disarmed.
                        let blocked_trace = if crate::trace::dump_enabled() {
                            let normalized = crate::trace::normalize(&blocked);
                            Some((
                                crate::trace::hash_hex(&crate::trace::normalize(args_raw)),
                                crate::trace::hash_hex(&normalized),
                                blocked.chars().count(),
                                normalized.chars().take(120).collect::<String>(),
                            ))
                        } else {
                            None
                        };
                        ls.messages.push(serde_json::json!({
                            "role": "tool",
                            "tool_call_id": call_id,
                            "content": blocked,
                        }));
                        if let Some((args_hash, result_hash, result_len, result_head)) =
                            blocked_trace
                        {
                            let rec = crate::trace::ToolTraceRecord {
                                round: round,
                                idx,
                                name: name.to_string(),
                                args_hash,
                                result_hash,
                                result_len,
                                result_head,
                                acc_delta_len: ls.accumulated.len().saturating_sub(acc_before),
                                acc_markers: crate::trace::extract_markers(
                                    acc_before,
                                    &ls.accumulated,
                                ),
                                pending_confirm_raised: pending_confirm && !pc_before,
                                msgs_pushed: ls.messages.len().saturating_sub(msgs_before),
                                blocked: true,
                                browser_image_set: ls.pending_browser_image.is_some(),
                            };
                            if let Some(dir) = trace_dir.as_deref() {
                                crate::trace::append(dir, &rec);
                            }
                        }
                        continue;
                    }

                    // Record consequential actions (any domain) for decision memory.
                    if ls.tool_trace.len() < 20 {
                        if let Some(line) = summarize_tool_action(name, args_raw) {
                            ls.tool_trace.push(line);
                        } else if let Some(line) =
                            connected_capability_execution_trace_line(name, &catalog_index)
                        {
                            ls.tool_trace.push(line);
                        } else if composio_writes.contains(name) {
                            // A write on a connected service (Composio/MCP).
                            ls.tool_trace
                                .push(format!("capability execution connector:{name}"));
                        }
                    }

                    execution_journal.record(AgentExecutionEvent::ToolCallStarted {
                        round,
                        call_id: call_id.clone(),
                        name: name.to_string(),
                    });
                    let (result, tool_effects, interrupted) = if is_browser_granular_tool(name) {
                        // Browser: through the BrowserExecutor seam (ADR 0026 / ADR 0025). The executor owns
                        // the browser subsystem's private state (session, snapshots, tab/nav bookkeeping)
                        // and mutates the loop-visible browser fields + provider via `&mut ls`. Produces no
                        // ToolEffects (it mutates directly). Folds into a recursive `browse` at ADR 0025.
                        tokio::select! {
                            r = browser_executor.execute_browser(name, args_raw, &call_id, &mut ls) => {
                                (r, crate::ToolEffects::default(), None)
                            }
                            control = wait_for_interrupting_control(model_client) => {
                                (
                                    "Tool execution interrupted by validated user steering.".to_string(),
                                    crate::ToolEffects::default(),
                                    Some(control),
                                )
                            }
                        }
                    } else {
                        // Non-browser: through the CapabilityExecutor seam (ADR 0026). The executor builds
                        // the per-call ChatToolCtx from `&mut ls` + its held read-only context. `args_raw`
                        // (the model's exact JSON string) is passed through unchanged — no round-trip.
                        let delegated_browse = name == "browse";
                        let elapsed_ms = u64::try_from(turn_started_at.elapsed().as_millis())
                            .unwrap_or(u64::MAX);
                        let remaining_browser_ms = cfg
                            .browser_budget
                            .max_elapsed_ms
                            .saturating_sub(elapsed_ms);
                        let browser_deadline = tokio::time::sleep(std::time::Duration::from_millis(
                            remaining_browser_ms,
                        ));
                        tokio::pin!(browser_deadline);
                        tokio::select! {
                            biased;
                            control = wait_for_interrupting_control(model_client) => {
                                (
                                    "Tool execution interrupted by validated user steering.".to_string(),
                                    crate::ToolEffects::default(),
                                    Some(control),
                                )
                            }
                            _ = &mut browser_deadline, if delegated_browse => {
                                (
                                    "found: false\nnote: browse stopped because the turn's browser time budget was exhausted; synthesize from earlier evidence".to_string(),
                                    crate::ToolEffects {
                                        browser_activity_observed: true,
                                        outcome_hint: Some(crate::ToolOutcomeHint::NoProgress),
                                        ..crate::ToolEffects::default()
                                    },
                                    None,
                                )
                            }
                            outcome = capability_executor.execute_tool(name, args_raw, &call_id, &mut ls) => {
                                match outcome {
                                    Ok(o) => (o.result, o.effects, None),
                                    Err(e) => (e, crate::ToolEffects::default(), None),
                                }
                            }
                        }
                    };
                    if let Some(control) = interrupted {
                        if is_browser_granular_tool(name) {
                            browser_executor.interrupt().await;
                        }
                        execution_journal.record(AgentExecutionEvent::ToolCallCompleted {
                            round,
                            call_id: call_id.clone(),
                            name: name.to_string(),
                            result_chars: result.chars().count(),
                            outcome: "steering_interrupted".to_string(),
                            result_fingerprint: tool_result_fingerprint(&result),
                        });
                        ls.messages.push(serde_json::json!({
                            "role": "tool",
                            "tool_call_id": call_id,
                            "content": result,
                        }));
                        for skipped in calls.iter().skip(idx + 1) {
                            ls.messages.push(serde_json::json!({
                                "role": "tool",
                                "tool_call_id": skipped.get("id").and_then(|id| id.as_str()).unwrap_or(""),
                                "content": "Tool call skipped because validated user steering changed the active run.",
                            }));
                        }
                        apply_turn_control(model_client, &mut ls.messages, &control);
                        steering_to_complete.push(control.steering_id);
                        execution_journal.checkpoint(crate::LoopCheckpoint::from_state(round, &ls));
                        control_after_tools = Some(control);
                        break;
                    }
                    let outcome = tool_effects
                        .outcome_hint
                        .map(crate::ToolOutcomeHint::as_str)
                        .unwrap_or_else(|| classify_tool_result(&result));
                    let result_fingerprint = tool_result_fingerprint(&result);
                    execution_journal.record(AgentExecutionEvent::ToolCallCompleted {
                        round,
                        call_id: call_id.clone(),
                        name: name.to_string(),
                        result_chars: result.chars().count(),
                        outcome: outcome.to_string(),
                        result_fingerprint,
                    });
                    // Scoped to the browse sub-turn (E2): `browser_done` is that sub-turn's own
                    // completion signal, not a general-purpose terminal. Outside it (`cfg.browser_subturn
                    // == false`) the name is reachable only via hallucination — no non-subturn turn
                    // offers it as a real tool — so it must fall through to normal handling instead of
                    // silently ending the turn on whatever the model made up.
                    if cfg.browser_subturn && name == "browser_done" && !result.trim().is_empty() {
                        memory_answer = result.trim().to_string();
                        ls.messages.push(serde_json::json!({
                            "role": "tool",
                            "tool_call_id": call_id,
                            "content": result,
                        }));
                        let _ = event_sink
                            .emit(GenerateStreamEvent::Done {
                                text: memory_answer.clone(),
                                metrics: TokenMetrics::zero(),
                                redacted_user_text: None,
                            })
                            .await;
                        delivery = TurnDelivery::Delivered;
                        final_done = true;
                        break 'rounds;
                    }
                    if is_browser_granular_tool(name) {
                        // MINOR 8: a stale-ref auto-recovery (main.rs) is a real page observation but
                        // NOT progress toward the goal — it comes back as an ordinary `Ok(...)` plain-text
                        // result, which `classify_tool_result` reads as "success" (it isn't the
                        // `{"status":...}` shape), so left unchecked it would reset the counter below and
                        // let a ref-churning SPA loop act→stale→snapshot→act forever. Fold it into the
                        // same stalled bucket as empty/error/blocked so repeated churn still trips
                        // `max_no_progress`.
                        let stalled = is_stale_ref_recovery_result(&result)
                            || matches!(outcome, "empty" | "error" | "blocked" | "no_progress");
                        if stalled {
                            ls.browser_no_progress = ls.browser_no_progress.saturating_add(1);
                            if name == "browser_navigate" {
                                ls.browser_failed_navigations =
                                    ls.browser_failed_navigations.saturating_add(1);
                            }
                        } else {
                            ls.browser_no_progress = 0;
                        }
                    } else {
                        let no_progress_count =
                            ls.observe_tool_outcome(&tool_family(name), outcome);
                        if no_progress_count > 0 {
                            if no_progress_count == 2 {
                                nudge_no_progress = true;
                            } else if no_progress_count >= 3 {
                                stop_for_no_progress = true;
                            }
                        }
                    }
                    if matches!(name, "update_plan" | "step_advance") {
                        execution_journal.record(AgentExecutionEvent::PlanUpdated {
                            round,
                            source: name.to_string(),
                        });
                    }
                    // ADR 0024 inc 5d.1b: apply the tool's loop-state effects immediately, before the
                    // loop reads any field they populate (plan, ls.accumulated, …) — net state as inline.
                    ls.apply_effects(&mut pending_confirm, round, tool_effects);

                    // Collect source URLs from browser results so the final
                    // answer can carry a deterministic "Fonti" section. The
                    // granular browser_navigate result embeds the visited page URL.
                    if name == "browser_navigate" {
                        // Capture ONLY the VISITED page URL (the first URL in the result,
                        // from "Page opened (URL). Snapshot: …"), not every link scraped
                        // from the page body — otherwise the content snapshot's footer
                        // chrome (Wikipedia donate/edit/history, wikimedia/mediawiki footer
                        // links) lands in the "Sources" footer. The page visited IS the
                        // source. `is_low_value_source_url` stays as a defensive net.
                        if let Some(url) = extract_source_urls(&result).into_iter().next() {
                            if !is_low_value_source_url(&url) && !browse_sources.contains(&url) {
                                browse_sources.push(url);
                            }
                        }
                    }
                    if name == "recall_memory" {
                        ls.pending_vault_reveal_marker = extract_vault_reveal_marker(&result)
                            .or(ls.pending_vault_reveal_marker.take());
                    }
                    // F2: record this tool's outcome as evidence for the current plan
                    // step (the verifier's input). Skip the plan tool itself so the
                    // evidence reflects the actual WORK, not the bookkeeping. Bounded.
                    if name != "update_plan" {
                        let snippet: String = result.chars().take(400).collect();
                        ls.step_evidence.push(format!("{name} → {snippet}"));
                        if ls.step_evidence.len() > 60 {
                            ls.step_evidence.remove(0);
                        }
                        // Harness-derived progress: advance the plan frontier when the gathered
                        // evidence VERIFIES the current step (the weak browser model never does).
                        try_advance_frontier_from_evidence(
                            &mut ls,
                            plan_progress,
                            execution_journal,
                            event_sink,
                            &cfg,
                            thread_id.as_deref(),
                            round,
                        )
                        .await;
                    }
                    // Parity harness: compute the result-derived fingerprint fields
                    // from `&result` BEFORE the push moves `result` into the message.
                    // Gated on `dump_enabled()` so there is no cost when disarmed.
                    let trace_fields = if crate::trace::dump_enabled() {
                        let normalized = crate::trace::normalize(&result);
                        Some((
                            crate::trace::hash_hex(&crate::trace::normalize(args_raw)),
                            crate::trace::hash_hex(&normalized),
                            result.chars().count(),
                            normalized.chars().take(120).collect::<String>(),
                        ))
                    } else {
                        None
                    };
                    ls.messages.push(serde_json::json!({
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": result,
                    }));
                    // Build + append the record AFTER the tool push so `msgs_pushed`
                    // counts this push. A browser screenshot pushes a SECOND message
                    // later (outside this loop), which `msgs_pushed` cannot see; that
                    // side effect is instead fingerprinted by `browser_image_set`
                    // below.
                    if let Some((args_hash, result_hash, result_len, result_head)) = trace_fields {
                        let rec = crate::trace::ToolTraceRecord {
                            round: round,
                            idx,
                            name: name.to_string(),
                            args_hash,
                            result_hash,
                            result_len,
                            result_head,
                            acc_delta_len: ls.accumulated.len().saturating_sub(acc_before),
                            acc_markers: crate::trace::extract_markers(acc_before, &ls.accumulated),
                            pending_confirm_raised: pending_confirm && !pc_before,
                            msgs_pushed: ls.messages.len().saturating_sub(msgs_before),
                            blocked: false,
                            // Set by the browser_screenshot arm (if it ran) to queue a
                            // SECOND message pushed AFTER this loop — invisible to
                            // `msgs_pushed`, so we fingerprint the side effect here.
                            browser_image_set: ls.pending_browser_image.is_some(),
                        };
                        if let Some(dir) = trace_dir.as_deref() {
                            crate::trace::append(dir, &rec);
                        }
                    }
                }
            } // end ctx scope → borrows freed before the post-loop reads below
            if let Some(control) = control_after_tools {
                match control.disposition {
                    TurnControlDisposition::ReplanCurrentWork => continue 'rounds,
                    TurnControlDisposition::FinalizeWithCurrentEvidence
                    | TurnControlDisposition::NeedsClarification => break 'rounds,
                    TurnControlDisposition::CancelCurrentWork => {
                        final_done = true;
                        break 'rounds;
                    }
                    TurnControlDisposition::ContinueCurrentWork => continue 'rounds,
                }
            }
            if nudge_no_progress {
                ls.messages.push(serde_json::json!({
                    "role": "system",
                    "content": "Two consecutive tools in the same family produced no usable progress. Change strategy and do not repeat that tool family unless new evidence makes it necessary."
                }));
            }
            // A browser screenshot this round → feed the image to the (vision)
            // model as a SEPARATE user message. It MUST come AFTER every tool
            // result of this round (OpenAI-compat requires each assistant
            // tool_call to be immediately followed by its tool message; the
            // image cannot sit between them).
            if let Some(dataurl) = ls.pending_browser_image.take() {
                // Send the image ONLY to a vision-capable model. Skip ONLY when /api/show
                // confidently reports no `vision` capability (undetected/cloud → send, as
                // today); a non-vision model would otherwise error on the image part — feed
                // it a text note so it falls back to the page's text snapshot.
                let vision_capable =
                    turn_policy.supports_vision(&ls.provider.base_url, &ls.provider.model);
                if vision_capable {
                    ls.messages.push(serde_json::json!({
                        "role": "user",
                        "content": [
                            { "type": "text", "text": "Screenshot of the current page:" },
                            { "type": "image_url", "image_url": { "url": dataurl } }
                        ],
                    }));
                } else {
                    ls.messages.push(serde_json::json!({
                        "role": "user",
                        "content": "(A screenshot was captured, but this model cannot see images — rely on the page's TEXT snapshot instead.)",
                    }));
                }
            }
            if pending_confirm {
                // A write is awaiting the user's confirmation card — end the turn
                // here (no synthesis, no further tool rounds).
                let final_text = append_vault_reveal_marker_if_missing(
                    collapse_plan_markers(&ls.accumulated),
                    ls.pending_vault_reveal_marker.as_deref(),
                );
                if visible_answer(&final_text).is_some() {
                    let _ = event_sink
                        .emit(GenerateStreamEvent::Done {
                            text: final_text.clone(),
                            metrics: TokenMetrics::zero(),
                            redacted_user_text: None,
                        })
                        .await;
                    memory_answer = final_text;
                    delivery = TurnDelivery::Delivered;
                    final_done = true;
                }
                break;
            }
            if stop_for_no_progress {
                let _ = event_sink
                    .emit(GenerateStreamEvent::Delta {
                        text: "‹‹ACT››⏹️ Nessun progresso dopo più tentativi: cambio strategia e sintetizzo‹‹/ACT››"
                            .to_string(),
                    })
                    .await;
                execution_journal.record(AgentExecutionEvent::ForcedSynthesis {
                    round: Some(round),
                    reason: "structured_no_progress".to_string(),
                });
                break;
            }
            continue;
        }

        // No tool call → normally the final answer. Sanitize any leaked model
        // control tokens (e.g. minimax `]<]minimax[>[` / `<tool_call>` text) so
        // the user never sees raw template markup.
        let mut content = model_normalize::sanitize_model_text(
            message
                .get("content")
                .and_then(|c| c.as_str())
                .unwrap_or(""),
        );
        // Plan-completion enforcement: some models stop after one step (kimi/others),
        // leaving a half-built deliverable. If the plan still has open steps and we
        // have budget, nudge the model to keep going instead of ending the turn.
        // Bounded by MAX_PLAN_NUDGES (reset on progress) AND the per-step round budget.
        if !is_final_round && plan_nudges < MAX_PLAN_NUDGES {
            let mut plan_steps = plan_value_steps(&ls.plan);
            if let Some(step) = plan_next_open(&plan_steps) {
                // F5 over-running guard: when only the LAST step is still open AND the
                // model already wrote a substantial answer, it almost certainly FINISHED
                // the work and merely forgot to mark that step done. The "continue, no
                // summary yet" nudge then drags it PAST a good answer into a degraded or
                // self-contradictory one (the long-horizon regression). Accept the answer
                // instead. When SEVERAL steps remain open the model genuinely stopped
                // early → keep nudging. Failure-safe: when in doubt (short answer or many
                // open steps), we nudge — never a premature stop.
                let open_left = plan_steps
                    .iter()
                    .filter(|s| plan_step_status(s) != "done")
                    .count();
                if !answer_concludes_plan(open_left, content.trim().chars().count()) {
                    plan_nudges += 1;
                    // Turn trace: the harness nudged the model to keep going on the still-open plan.
                    turn_trace.record(crate::turn_trace::TurnEvent::Nudge {
                        reason: "answer_did_not_conclude_plan".into(),
                        next_step: step.clone(),
                    });
                    if !content.trim().is_empty() {
                        ls.messages
                            .push(serde_json::json!({ "role": "assistant", "content": content }));
                    }
                    // DIRECTIVE nudge: name the exact next step and forbid redoing work —
                    // weak-agentic models otherwise re-run the skill / regenerate images
                    // on a vague "continue" instead of advancing to the next step.
                    ls.messages.push(serde_json::json!({
                        "role": "user",
                        "content": format!(
                            "Do NOT stop and do NOT re-run the skill. Your next unfinished plan \
                             step is: «{step}». Do ONLY that step now, reusing the files you \
                             already created (do not regenerate existing images). Mark it done \
                             with update_plan, then continue to the next step until the plan is \
                             complete. No confirmation, no summary yet."
                        ),
                    }));
                    let _ = event_sink
                        .emit(GenerateStreamEvent::Delta {
                            text: format!(
                                "‹‹ACT››▶ Proseguo: {}‹‹/ACT››",
                                step.chars().take(50).collect::<String>()
                            ),
                        })
                        .await;
                    continue;
                }
                // The answer is substantial and the plan is all-but-closed → finalize with
                // `content` instead of nudging. F2.2 (default-on): reconcile the one still-open
                // step to `done` + persist, so the runtime plan matches the delivered work
                // and the NEXT turn doesn't falsely resume it. Reuses the canonical
                // mark-done→persist path.
                if cfg.reconcile_on_delivery {
                    if let Some(open_index) = plan_steps
                        .iter()
                        .position(|s| plan_step_status(s) != "done")
                    {
                        // Turn trace: count open steps at DECISION time (before this reconcile closes
                        // one) and the delivered size — the inputs the reconcile fired on.
                        let reconcile_open_before = plan_steps
                            .iter()
                            .filter(|s| plan_step_status(s) != "done")
                            .count();
                        let reconcile_delivered = content.trim().chars().count();
                        plan_steps[open_index]["status"] = serde_json::json!("done");
                        content = replace_latest_plan_marker(&content, &plan_steps);
                        plan_progress
                            .persist_plan(thread_id.as_deref(), &plan_steps)
                            .await;
                        if std::env::var("HOMUN_DEBUG").is_ok() {
                            eprintln!(
                                "[plan] reconciled last open step to done on delivery: «{step}»"
                            );
                        }
                        turn_trace.record(crate::turn_trace::TurnEvent::Reconcile {
                            fired: true,
                            step: step.clone(),
                            open_steps: reconcile_open_before,
                            delivered_chars: reconcile_delivered,
                            threshold: crate::plan::MIN_DELIVERED_CHARS_TO_CONCLUDE,
                        });
                    }
                }
            } else if plan_steps.is_empty()
                && turn_used_tools
                && completion_judge
                    .task_appears_incomplete(&memory_user_message, &content)
                    .await
            {
                // Slice 2.5: the model ACTED but stopped WITHOUT ever creating a plan, and the
                // cheap judge says the request is not finished. Bootstrap a plan so F1–F5 take
                // over — the whole long-horizon machinery is gated on a NON-EMPTY plan, so an
                // empty plan silently bypasses it (the gap behind a generic multi-step task
                // stopping early). `make_deck` is exempt: one-call, never enters this loop.
                plan_nudges += 1;
                // Turn trace: the model acted but never planned → the harness bootstraps a plan. No
                // named next step here (the plan is empty by definition on this path).
                turn_trace.record(crate::turn_trace::TurnEvent::Nudge {
                    reason: "stopped_without_plan".into(),
                    next_step: String::new(),
                });
                if !content.trim().is_empty() {
                    ls.messages
                        .push(serde_json::json!({ "role": "assistant", "content": content }));
                }
                ls.messages.push(serde_json::json!({
                    "role": "user",
                    "content": "You stopped, but the request is NOT finished and you never made \
                        a plan. Call update_plan NOW with the COMPLETE list of steps needed to \
                        fully satisfy the request, then do the FIRST unfinished step — reuse \
                        anything you already produced, do not redo work. Mark steps done with \
                        update_plan/step_advance as you go. No summary yet.",
                }));
                let _ = event_sink
                    .emit(GenerateStreamEvent::Delta {
                        text: "‹‹ACT››▶ Pianifico il lavoro rimanente‹‹/ACT››".to_string(),
                    })
                    .await;
                continue;
            }
        }
        // F3-deep: the model is about to finalize but produced NO answer body this round
        // — typically a reasoning model that burned its whole token budget thinking
        // (`finish_reason:length`, empty content) so only a ‹‹REASONING›› trace remains.
        // Committing it would Done an empty / reasoning-only bubble (the "non produce la
        // risposta" report). Recover by breaking WITHOUT `final_done`: the guaranteed
        // forced-synthesis (`!final_done` below) then writes a real answer with a FRESH
        // token budget and an explicit "write the FINAL ANSWER now" directive. `break`
        // leaves the round loop, so the synthesis runs exactly once — no spin, no counter;
        // if it too comes back empty, the turn reports `NoVisibleAnswer` without emitting Done.
        let mut candidate = String::with_capacity(ls.accumulated.len() + content.len());
        candidate.push_str(&ls.accumulated);
        candidate.push_str(&content);
        if visible_answer(&candidate).is_none() {
            if cfg.verbose {
                let fr = round_finish_reason.as_deref().unwrap_or("");
                eprintln!("[answer] empty answer body (finish_reason={fr}) → forced synthesis");
            }
            turn_trace.record(crate::turn_trace::TurnEvent::ForcedSynthesis {
                finish_reason: round_finish_reason.clone().unwrap_or_default(),
            });
            execution_journal.record(AgentExecutionEvent::ForcedSynthesis {
                round: Some(round),
                reason: "empty_visible_answer".to_string(),
            });
            // Keep the reasoning trace in context so the synthesis builds on it.
            if !content.trim().is_empty() {
                ls.messages
                    .push(serde_json::json!({ "role": "assistant", "content": content }));
            }
            break;
        }
        // The content already streamed LIVE (raw) via collect_openai_stream; here we
        // only accumulate the SANITIZED version, which becomes the authoritative
        // `Done` payload that the frontend uses as the final text (replacing the
        // raw live preview). No second content Delta — that would double it.
        ls.accumulated.push_str(&content);
        if let Some(fonti) = fonti_section(&browse_sources, &ls.accumulated) {
            ls.accumulated.push_str(&fonti);
            let _ = event_sink
                .emit(GenerateStreamEvent::Delta { text: fonti })
                .await;
        }
        // Anti-churn: the live stream carried one ‹‹PLAN›› block per plan tool call;
        // the PERSISTED answer keeps the plan card exactly once (latest state).
        // Reconcile the plan ONE last time on delivery — mark every still-open step done
        // (see plan_steps_reconciled_on_delivery) — and PERSIST it, so the runtime plan is
        // settled → the next turn won't falsely resume a plan this answer already finished.
        let delivered = collapse_plan_markers(&ls.accumulated);
        if visible_answer(&delivered).is_none() {
            break;
        }
        // Turn trace: open-step count BEFORE the final reconcile (its input), captured so the trace
        // shows how many steps the delivery reconcile swept closed.
        let final_open_before = plan_value_steps(&ls.plan)
            .iter()
            .filter(|s| plan_step_status(s) != "done")
            .count();
        let final_delivered_chars = delivered.trim().chars().count();
        let delivered = match plan_progress.reconcile_on_delivery(&ls.plan, &delivered) {
            Some(reconciled) => {
                plan_progress
                    .persist_plan(thread_id.as_deref(), &reconciled)
                    .await;
                turn_trace.record(crate::turn_trace::TurnEvent::Reconcile {
                    fired: true,
                    step: String::new(), // the whole plan is reconciled here, not a single named step
                    open_steps: final_open_before,
                    delivered_chars: final_delivered_chars,
                    threshold: crate::plan::MIN_DELIVERED_CHARS_TO_CONCLUDE,
                });
                replace_latest_plan_marker(&delivered, &reconciled)
            }
            None => delivered,
        };
        let final_answer = append_vault_reveal_marker_if_missing(
            delivered,
            ls.pending_vault_reveal_marker.as_deref(),
        );
        if visible_answer(&final_answer).is_some() {
            if model_client.finalization_fence() == crate::FinalizationFence::PendingInput {
                ls.messages.push(serde_json::json!({
                    "role": "assistant",
                    "content": final_answer,
                }));
                ls.accumulated.clear();
                continue;
            }
            memory_answer = final_answer.clone();
            let _ = event_sink
                .emit(GenerateStreamEvent::Done {
                    text: final_answer,
                    metrics: TokenMetrics::zero(),
                    redacted_user_text: None,
                })
                .await;
            delivery = TurnDelivery::Delivered;
            final_done = true;
        }
        break;
    }

    // Turn end (ALL exit paths converge here: normal answer, pending_confirm, round-budget break,
    // natural exhaustion). The browser executor parks its session warm for the thread's next turn (or
    // stops it for an anonymous chat) and hides the "● LIVE" activity — see `close_session`.
    browser_executor.close_session(ls.browser_used).await;

    // Exhaustion is still a finalization path. Fence it exactly like the
    // in-loop delivery path so a steering instruction that was queued,
    // claimed, or interpreted while the last tool was running cannot be
    // overtaken by the forced no-tools synthesis.
    //
    // Drain interpreted controls (including `continue`) so a steering queued/claimed
    // while the last tool ran is honored before finalization. If the fence stays
    // PendingInput with nothing interpreted (rows pending/claimed the coordinator
    // cannot resolve — e.g. the semantic model is unavailable), park instead of
    // spinning: exit with a non-delivering Parked outcome for coordinator resume.
    let mut park_wait: u32 = 0;
    while !final_done
        && model_client.finalization_fence() == crate::FinalizationFence::PendingInput
    {
        if let Some(control) = model_client.current_turn_control() {
            apply_turn_control(model_client, &mut ls.messages, &control);
            steering_to_complete.push(control.steering_id);
            if control.disposition == TurnControlDisposition::CancelCurrentWork {
                final_done = true;
            }
            park_wait = 0;
            continue;
        }
        if park_wait >= PARK_WAIT_CYCLES {
            // Park: capture a resumable checkpoint at the boundary and return without
            // delivering. Do NOT force synthesis, do NOT emit Done.
            execution_journal.checkpoint(crate::LoopCheckpoint::from_state(last_round, &ls));
            return crate::TurnOutcome {
                delivery: TurnDelivery::Parked,
                memory_answer: String::new(),
                image_rejection: None,
                ..Default::default()
            };
        }
        park_wait += 1;
        // A plain wall-clock tick, deliberately NOT `wait_for_turn_control()`: that seam is
        // specified to return only once a non-`continue` interpreted control appears (the real
        // gateway impl loops internally, sleeping, and never returns on its own otherwise) — if
        // the semantic model is down and the row never gets interpreted, awaiting it here would
        // block this tick forever and `park_wait` would never reach the budget, defeating the
        // park. Ticking on a bounded sleep instead means the budget elapses on wall-clock time
        // regardless of whether interpretation ever happens.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    if !final_done {
        // Turn trace: the loop exited without a committed answer → the guaranteed post-loop synthesis
        // fires. No per-round finish_reason applies on this exhaustion path (the loop broke on the
        // round/nav budget or a transport error); a synthetic marker keeps the event greppable.
        turn_trace.record(crate::turn_trace::TurnEvent::ForcedSynthesis {
            finish_reason: "post_loop_exhausted".into(),
        });
        execution_journal.record(AgentExecutionEvent::ForcedSynthesis {
            round: None,
            reason: "post_loop_exhausted".to_string(),
        });
        // Guaranteed synthesis: the model exhausted the tool rounds without a
        // text answer (it kept calling tools). Force one final NO-TOOLS call so it
        // synthesizes from what it did, instead of dead-ending on "limite di passi".
        // GENERIC across domains (coding, documents, web), not travel-specific.
        ls.messages.push(serde_json::json!({
            "role": "user",
            "content": "No more tools are available. Write the FINAL ANSWER NOW for \
        the user, synthesizing what you did and found in the previous steps: for a coding task \
        say what you created/modified and how it's used/run; for a search report the results with \
        details. Be complete and concrete. If something failed, say so clearly and propose how \
        to proceed."
        }));
        // ADR 0024 inc 5 (P2b): the forced synthesis now goes through the SAME
        // engine::ModelClient seam as the per-round call — `is_final_round: true` (no
        // tools, fresh answer budget) — so it inherits retry/backoff, the mid-turn
        // provider fallback and the OpenAI/Ollama-native collectors instead of the old
        // single inline POST (which could dead-end on one transient failure). The impl
        // streams the answer live via its captured StreamSink, exactly like the loop.
        // A provider swap here is moot (the turn ends right after), and any error leaves
        // the turn without a delivery unless already-accumulated text is visibly answer prose.
        execution_journal.record(AgentExecutionEvent::PromptSnapshot {
            round: cfg.hard_round_ceiling,
            snapshot: crate::execution_journal::build_prompt_snapshot_with_packets(
                &ls.provider.model,
                &ls.provider.base_url,
                &ls.messages,
                &[],
                true,
                None,
                &ls.prompt_packets,
            ),
        });
        let mut synthesis_usage = usage_context.clone();
        synthesis_usage.call_id = format!("{}:forced_synthesis", usage_context.call_id);
        synthesis_usage.purpose_detail = Some("forced_synthesis".to_string());
        synthesis_usage.round = u32::try_from(cfg.hard_round_ceiling).ok();
        let synth_out = model_client
            .generate(
                &crate::ModelCall {
                    base_url: &ls.provider.base_url,
                    model: &ls.provider.model,
                    api_key: ls.provider.api_key.as_deref(),
                    messages: &ls.messages,
                    tools: &[],
                    temperature,
                    is_final_round: true,
                    // No tools offered on the forced-synthesis call, so forcing is moot — kept
                    // `None` for consistency with every other non-main-round call site.
                    forced_tool: None,
                    usage: &synthesis_usage,
                },
                &|_tok| {},
            )
            .await;
        let synth_text = model_normalize::sanitize_model_text(
            synth_out
                .as_ref()
                .ok()
                .and_then(|o| o.message.get("content"))
                .and_then(|c| c.as_str())
                .unwrap_or(""),
        );
        if let Ok(output) = &synth_out {
            execution_journal.record(AgentExecutionEvent::ModelResponse {
                round: cfg.hard_round_ceiling,
                finish_reason: output.finish_reason.clone(),
                content_chars: synth_text.chars().count(),
                tool_calls: 0,
            });
        }
        // synth_text was already streamed live by the collector; commit it only when it contains
        // visible prose. If it does not, the accumulated turn text gets the same validation.
        let candidate = if visible_answer(&synth_text).is_some() {
            let synthesis_blocks = preserved_display_marker_blocks(&synth_text);
            let accumulated_prefix = preserved_display_marker_blocks(&ls.accumulated)
                .into_iter()
                .filter(|block| !synthesis_blocks.iter().any(|synthesis| synthesis == block))
                .collect::<Vec<_>>()
                .join("\n");
            Some(if accumulated_prefix.is_empty() {
                synth_text
            } else {
                format!("{accumulated_prefix}\n{synth_text}")
            })
        } else if visible_answer(&ls.accumulated).is_some() {
            Some(ls.accumulated.clone())
        } else {
            None
        };
        if let Some(mut final_text) = candidate {
            if let Some(fonti) = fonti_section(&browse_sources, &final_text) {
                final_text.push_str(&fonti);
            }
            // Anti-churn safety net for the accumulated fallback (synthesis normally has no plan
            // blocks). Reconcile + persist only after a visible delivery candidate exists.
            let delivered = collapse_plan_markers(&final_text);
            let delivered = match plan_progress.reconcile_on_delivery(&ls.plan, &delivered) {
                Some(reconciled) => {
                    plan_progress
                        .persist_plan(thread_id.as_deref(), &reconciled)
                        .await;
                    replace_latest_plan_marker(&delivered, &reconciled)
                }
                None => delivered,
            };
            let final_text = append_vault_reveal_marker_if_missing(
                delivered,
                ls.pending_vault_reveal_marker.as_deref(),
            );
            if visible_answer(&final_text).is_some() {
                memory_answer = final_text.clone();
                let _ = event_sink
                    .emit(GenerateStreamEvent::Done {
                        text: final_text,
                        metrics: TokenMetrics::zero(),
                        redacted_user_text: None,
                    })
                    .await;
                delivery = TurnDelivery::Delivered;
            }
        }
    }
    if final_done || delivery == TurnDelivery::Delivered {
        steering_to_complete.sort_unstable();
        steering_to_complete.dedup();
        for steering_id in steering_to_complete {
            model_client.acknowledge_turn_control_completed(steering_id);
        }
    }
    // 5.D1c.8: the post-turn tail (memory learn + code-graph refresh) is a GATEWAY concern (AppState /
    // stores / spawn), so it runs in the caller after this returns — driven by the outcome below. The
    // engine's turn ends here.
    crate::TurnOutcome {
        delivery,
        memory_answer,
        tool_actions: ls.tool_trace.join("\n"),
        memory_reads: ls.memory_reads,
        browse_sources,
        // Carry the final runtime plan out for the gateway's turn_trace TurnEnd (observability only).
        final_plan: ls.plan,
        // Reaching here means the turn ran to completion: any image rejection was either recovered by
        // the caller before this attempt, or downgraded to a fatal error above.
        image_rejection: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::{
        ModelCall, ModelCallError, ModelRoundOutput, ProviderBinding, ToolEffects, ToolOutcome,
    };
    use crate::events::{LinkedMemoryRead, TurnMemoryReadSet};
    use serde_json::{Value, json};
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    // Minimal seam mocks: the model answers immediately (no tool calls); everything else is a no-op.
    struct AnswerModel;
    impl ModelClient for AnswerModel {
        async fn generate(
            &self,
            call: &ModelCall<'_>,
            on_delta: &(dyn Fn(&str) + Send + Sync),
        ) -> Result<ModelRoundOutput, ModelCallError> {
            on_delta("Final answer.");
            Ok(ModelRoundOutput {
                message: json!({ "role": "assistant", "content": "Final answer." }),
                provider: ProviderBinding {
                    model: call.model.to_string(),
                    base_url: call.base_url.to_string(),
                    api_key: None,
                },
                finish_reason: Some("stop".to_string()),
                usage: Default::default(),
                latency_ms: None,
                time_to_first_token_ms: None,
            })
        }
    }

    struct StructuredAnswerModel;

    impl ModelClient for StructuredAnswerModel {
        async fn generate(
            &self,
            call: &ModelCall<'_>,
            on_delta: &(dyn Fn(&str) + Send + Sync),
        ) -> Result<ModelRoundOutput, ModelCallError> {
            let content = "‹‹PLAN››- [x] Deliver result‹‹/PLAN››\n‹‹ARTIFACT››report.md‹‹/ARTIFACT››\nFinal answer.";
            on_delta(content);
            Ok(ModelRoundOutput {
                message: json!({ "role": "assistant", "content": content }),
                provider: ProviderBinding {
                    model: call.model.to_string(),
                    base_url: call.base_url.to_string(),
                    api_key: None,
                },
                finish_reason: Some("stop".to_string()),
                usage: Default::default(),
                latency_ms: None,
                time_to_first_token_ms: None,
            })
        }
    }

    #[derive(Default)]
    struct ToolThenForcedSynthesisModel {
        calls: std::sync::atomic::AtomicUsize,
    }

    impl ModelClient for ToolThenForcedSynthesisModel {
        async fn generate(
            &self,
            call: &ModelCall<'_>,
            on_delta: &(dyn Fn(&str) + Send + Sync),
        ) -> Result<ModelRoundOutput, ModelCallError> {
            let call_index = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let provider = ProviderBinding {
                model: call.model.to_string(),
                base_url: call.base_url.to_string(),
                api_key: None,
            };
            if call_index < 2 {
                return Ok(ModelRoundOutput {
                    message: json!({
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [{
                            "id": format!("tool_{call_index}"),
                            "type": "function",
                            "function": { "name": "make_document", "arguments": "{}" },
                        }],
                    }),
                    provider,
                    finish_reason: Some("tool_calls".to_string()),
                    usage: Default::default(),
                    latency_ms: None,
                    time_to_first_token_ms: None,
                });
            }
            let content = "‹‹ARTIFACT››report.md‹‹/ARTIFACT››\n‹‹CHOICES››choose a format‹‹/CHOICES››\n‹‹REASONING››synthesis reasoning‹‹/REASONING››\nForced synthesis answer.";
            on_delta(content);
            Ok(ModelRoundOutput {
                message: json!({ "role": "assistant", "content": content }),
                provider,
                finish_reason: Some("stop".to_string()),
                usage: Default::default(),
                latency_ms: None,
                time_to_first_token_ms: None,
            })
        }
    }

    #[derive(Default)]
    struct StructuredOutputTool {
        calls: std::sync::atomic::AtomicUsize,
    }

    impl CapabilityExecutor for StructuredOutputTool {
        async fn execute_tool(
            &self,
            _name: &str,
            _args: &str,
            _call_id: &str,
            _state: &mut LoopState,
        ) -> Result<ToolOutcome, String> {
            let first = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0;
            Ok(ToolOutcome {
                result: "document created".to_string(),
                effects: ToolEffects {
                    append_output: first.then(|| {
                        "‹‹PLAN››- [x] Deliver result‹‹/PLAN››\n‹‹ARTIFACT››report.md‹‹/ARTIFACT››\n"
                            .to_string()
                    }).into_iter().collect(),
                    ..ToolEffects::default()
                },
            })
        }
    }

    #[derive(Default)]
    struct ReasoningOnlyModel {
        calls: std::sync::atomic::AtomicUsize,
    }

    impl ModelClient for ReasoningOnlyModel {
        async fn generate(
            &self,
            call: &ModelCall<'_>,
            on_delta: &(dyn Fn(&str) + Send + Sync),
        ) -> Result<ModelRoundOutput, ModelCallError> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let content = "‹‹REASONING››hidden‹‹/REASONING››";
            on_delta(content);
            Ok(ModelRoundOutput {
                message: json!({ "role": "assistant", "content": content }),
                provider: ProviderBinding {
                    model: call.model.to_string(),
                    base_url: call.base_url.to_string(),
                    api_key: None,
                },
                finish_reason: Some("stop".to_string()),
                usage: Default::default(),
                latency_ms: None,
                time_to_first_token_ms: None,
            })
        }
    }
    struct NoTools;
    impl CapabilityExecutor for NoTools {
        async fn execute_tool(
            &self,
            name: &str,
            _a: &str,
            _c: &str,
            _s: &mut LoopState,
        ) -> Result<ToolOutcome, String> {
            Ok(ToolOutcome {
                result: format!("ran {name}"),
                effects: ToolEffects::default(),
            })
        }
    }
    struct NoBrowser;
    impl BrowserExecutor for NoBrowser {
        async fn execute_browser(
            &mut self,
            _n: &str,
            _a: &str,
            _c: &str,
            _s: &mut LoopState,
        ) -> String {
            String::new()
        }
        async fn close_session(&mut self, _b: bool) {}
    }

    #[derive(Default)]
    struct BrowserDoneModel {
        calls: AtomicUsize,
    }

    impl ModelClient for BrowserDoneModel {
        async fn generate(
            &self,
            call: &ModelCall<'_>,
            on_delta: &(dyn Fn(&str) + Send + Sync),
        ) -> Result<ModelRoundOutput, ModelCallError> {
            let index = self.calls.fetch_add(1, Ordering::SeqCst);
            let provider = ProviderBinding {
                model: call.model.to_string(),
                base_url: call.base_url.to_string(),
                api_key: None,
            };
            if index == 0 {
                return Ok(ModelRoundOutput {
                    message: json!({
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [{
                            "id": "call_done",
                            "type": "function",
                            "function": {
                                "name": "browser_done",
                                "arguments": "{\"status\":\"completed\",\"answer\":\"done\",\"items\":[{\"departure\":\"09:05\"}],\"sources\":[\"https://example.test\"],\"evidence\":[\"visible\"]}"
                            }
                        }]
                    }),
                    provider,
                    finish_reason: Some("tool_calls".to_string()),
                    usage: Default::default(),
                    latency_ms: None,
                    time_to_first_token_ms: None,
                });
            }
            on_delta("forced synthesis should not run");
            Ok(ModelRoundOutput {
                message: json!({"role": "assistant", "content": "forced synthesis should not run"}),
                provider,
                finish_reason: Some("stop".to_string()),
                usage: Default::default(),
                latency_ms: None,
                time_to_first_token_ms: None,
            })
        }
    }

    struct DoneBrowser;

    impl BrowserExecutor for DoneBrowser {
        async fn execute_browser(
            &mut self,
            name: &str,
            _args: &str,
            _call_id: &str,
            state: &mut LoopState,
        ) -> String {
            assert_eq!(name, "browser_done");
            state.browser_used = true;
            "done".to_string()
        }

        async fn close_session(&mut self, _browser_used: bool) {}
    }

    #[tokio::test(flavor = "current_thread")]
    async fn browser_done_tool_terminates_without_forced_synthesis() {
        let mut ls = LoopState::new();
        ls.messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "browse" }),
        ];
        ls.step_messages_start = ls.messages.len();
        ls.tool_schemas = vec![json!({
            "type": "function",
            "function": {
                "name": "browser_done",
                "parameters": { "type": "object", "properties": {} }
            }
        })];
        let model = BrowserDoneModel::default();
        let sink = Collect::default();
        let journal = CollectJournal::default();
        let mut browser = DoneBrowser;

        let outcome = run_turn(
            ls,
            cfg(),
            &usage_context(),
            &model,
            &NoTools,
            &mut browser,
            &NoPlan,
            &DoneJudge,
            &NoCompact,
            &OpenPolicy,
            &journal,
            &sink,
            0.0,
            None,
            &std::collections::BTreeSet::new(),
            &[],
            "browse".to_string(),
            String::new(),
            None,
            false,
            0,
            false,
            Vec::new(),
            None,
            &crate::turn_trace::TurnTrace::disabled(),
        )
        .await;

        assert_eq!(outcome.delivery, crate::TurnDelivery::Delivered);
        assert_eq!(outcome.memory_answer, "done");
        assert_eq!(
            model.calls.load(Ordering::SeqCst),
            1,
            "browser_done must not trigger forced synthesis"
        );
        assert_eq!(
            sink.0
                .lock()
                .unwrap()
                .iter()
                .filter(|event| matches!(event, GenerateStreamEvent::Done { .. }))
                .count(),
            1
        );
    }

    /// E2: `browser_done` is the browse SUB-turn's own completion signal. Outside that sub-turn
    /// (`browser_subturn = false`) the same tool name — reached only via hallucination, since
    /// non-subturn turns never offer it as a real capability — must NOT terminate the turn. The
    /// turn instead keeps rolling and reaches its normal (forced-synthesis) completion.
    #[tokio::test(flavor = "current_thread")]
    async fn browser_done_does_not_terminate_a_non_browser_subturn() {
        let mut ls = LoopState::new();
        ls.messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "browse" }),
        ];
        ls.step_messages_start = ls.messages.len();
        ls.tool_schemas = vec![json!({
            "type": "function",
            "function": {
                "name": "browser_done",
                "parameters": { "type": "object", "properties": {} }
            }
        })];
        let model = BrowserDoneModel::default();
        let sink = Collect::default();
        let journal = CollectJournal::default();
        let mut browser = DoneBrowser;
        let mut config = cfg();
        config.browser_subturn = false;

        let outcome = run_turn(
            ls,
            config,
            &usage_context(),
            &model,
            &NoTools,
            &mut browser,
            &NoPlan,
            &DoneJudge,
            &NoCompact,
            &OpenPolicy,
            &journal,
            &sink,
            0.0,
            None,
            &std::collections::BTreeSet::new(),
            &[],
            "browse".to_string(),
            String::new(),
            None,
            false,
            0,
            false,
            Vec::new(),
            None,
            &crate::turn_trace::TurnTrace::disabled(),
        )
        .await;

        // The browser_done terminal did NOT fire: `memory_answer` is NOT the raw tool result
        // ("done") and the model was called a SECOND time (forced synthesis actually ran),
        // unlike the subturn case above where exactly one model call happens.
        assert_eq!(outcome.delivery, crate::TurnDelivery::Delivered);
        assert_ne!(outcome.memory_answer, "done");
        assert_eq!(outcome.memory_answer, "forced synthesis should not run");
        assert_eq!(
            model.calls.load(Ordering::SeqCst),
            2,
            "outside the browser sub-turn, browser_done must NOT short-circuit the loop — the turn \
             continues into a normal second round"
        );
    }

    #[derive(Default)]
    struct BlockedBrowserModel {
        calls: std::sync::atomic::AtomicUsize,
    }

    impl ModelClient for BlockedBrowserModel {
        async fn generate(
            &self,
            call: &ModelCall<'_>,
            on_delta: &(dyn Fn(&str) + Send + Sync),
        ) -> Result<ModelRoundOutput, ModelCallError> {
            let call_index = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let provider = ProviderBinding {
                model: call.model.to_string(),
                base_url: call.base_url.to_string(),
                api_key: None,
            };
            if call.is_final_round {
                let content = "Non sono riuscito ad accedere alle pagine richieste. Puoi riprovare.";
                on_delta(content);
                return Ok(ModelRoundOutput {
                    message: json!({ "role": "assistant", "content": content }),
                    provider,
                    finish_reason: Some("stop".to_string()),
                    usage: Default::default(),
                    latency_ms: None,
                    time_to_first_token_ms: None,
                });
            }

            Ok(ModelRoundOutput {
                message: json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "id": format!("browser_{call_index}"),
                        "type": "function",
                        "function": {
                            "name": "browser_navigate",
                            "arguments": format!("{{\"url\":\"https://example.com/{call_index}\"}}")
                        },
                    }],
                }),
                provider,
                finish_reason: Some("tool_calls".to_string()),
                usage: Default::default(),
                latency_ms: None,
                time_to_first_token_ms: None,
            })
        }
    }

    struct BlockedBrowser;

    impl BrowserExecutor for BlockedBrowser {
        async fn execute_browser(
            &mut self,
            _name: &str,
            _args: &str,
            _call_id: &str,
            state: &mut LoopState,
        ) -> String {
            state.browser_used = true;
            json!({ "status": "blocked" }).to_string()
        }

        async fn close_session(&mut self, _browser_used: bool) {}
    }
    #[derive(Default)]
    struct StaleRefChurnModel {
        calls: std::sync::atomic::AtomicUsize,
    }

    impl ModelClient for StaleRefChurnModel {
        async fn generate(
            &self,
            call: &ModelCall<'_>,
            on_delta: &(dyn Fn(&str) + Send + Sync),
        ) -> Result<ModelRoundOutput, ModelCallError> {
            let call_index = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let provider = ProviderBinding {
                model: call.model.to_string(),
                base_url: call.base_url.to_string(),
                api_key: None,
            };
            if call.is_final_round {
                let content = "Non sono riuscito ad accedere alla pagina richiesta. Puoi riprovare.";
                on_delta(content);
                return Ok(ModelRoundOutput {
                    message: json!({ "role": "assistant", "content": content }),
                    provider,
                    finish_reason: Some("stop".to_string()),
                    usage: Default::default(),
                    latency_ms: None,
                    time_to_first_token_ms: None,
                });
            }
            // The model keeps targeting a ref that just went stale — exactly the SPA churn MINOR 8
            // guards against: the page keeps re-rendering the same control under a NEW [ref=eN].
            Ok(ModelRoundOutput {
                message: json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "id": format!("act_{call_index}"),
                        "type": "function",
                        "function": {
                            "name": "browser_act",
                            "arguments": "{\"kind\":\"click\",\"ref\":\"e1\"}"
                        },
                    }],
                }),
                provider,
                finish_reason: Some("tool_calls".to_string()),
                usage: Default::default(),
                latency_ms: None,
                time_to_first_token_ms: None,
            })
        }
    }

    /// Every `browser_act` comes back as the gateway's stale-ref auto-recovery text (MINOR 8): a
    /// real `Ok(...)` result (plain prose, not `{"status":...}`) that pre-fix would have looked
    /// like ordinary success to `classify_tool_result` and reset `browser_no_progress` on every
    /// call — letting the churn above loop forever instead of tripping the budget.
    struct StaleRefRecoveryBrowser;

    impl BrowserExecutor for StaleRefRecoveryBrowser {
        async fn execute_browser(
            &mut self,
            name: &str,
            _args: &str,
            _call_id: &str,
            state: &mut LoopState,
        ) -> String {
            assert_eq!(name, "browser_act");
            state.browser_used = true;
            format!(
                "{} I took a fresh snapshot. Do NOT retry e1; choose a NEW [ref=...] \
from this snapshot:\n[ref=e2] Same control, re-rendered",
                crate::browser::STALE_REF_RECOVERY_MARKER
            )
        }

        async fn close_session(&mut self, _browser_used: bool) {}
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stale_ref_recovery_churn_still_trips_the_no_progress_budget() {
        // MINOR 8 regression: N consecutive stale-ref recoveries must NOT reset
        // `browser_no_progress` to 0 on every round (that would let a ref-churning SPA loop
        // act→stale→snapshot→act forever) — they must count as stalls like empty/error/blocked.
        let mut ls = LoopState::new();
        ls.messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "browse" }),
        ];
        ls.step_messages_start = ls.messages.len();
        let sink = Collect::default();
        let journal = CollectJournal::default();
        let mut browser = StaleRefRecoveryBrowser;
        let composio_writes = std::collections::BTreeSet::new();
        let catalog_index: Vec<(String, String, Value)> = Vec::new();
        let mut turn_cfg = cfg();
        turn_cfg.hard_round_ceiling = 12;
        turn_cfg.browser_max_rounds = 12;
        turn_cfg.browser_nav_cap = 12;
        turn_cfg.browser_budget.max_no_progress = 2;

        let outcome = run_turn(
            ls,
            turn_cfg,
            &usage_context(),
            &StaleRefChurnModel::default(),
            &NoTools,
            &mut browser,
            &NoPlan,
            &DoneJudge,
            &NoCompact,
            &OpenPolicy,
            &journal,
            &sink,
            0.0,
            None,
            &composio_writes,
            &catalog_index,
            "browse".to_string(),
            String::new(),
            None,
            false,
            0,
            false,
            Vec::new(),
            None,
            &crate::turn_trace::TurnTrace::disabled(),
        )
        .await;

        let journal_events = journal.0.lock().unwrap();
        assert_eq!(
            journal_events
                .iter()
                .filter(|kind| kind.as_str() == "browser_budget_exceeded")
                .count(),
            1,
            "the budget must trip after max_no_progress consecutive stale-ref recoveries, not loop \
             until hard_round_ceiling"
        );
        drop(journal_events);
        assert_eq!(outcome.delivery, crate::TurnDelivery::Delivered);
    }

    struct NoPlan;
    impl PlanProgress for NoPlan {
        async fn persist_plan(&self, _t: Option<&str>, _s: &[Value]) {}
        async fn record_step_outcome(&self, _t: Option<&str>, _s: &Value, _e: &[String]) {}
        async fn verify_step_complete(&self, _t: &str, _c: &str, _e: &str) -> (bool, String) {
            (false, String::new())
        }
        fn reconcile_on_delivery(&self, _p: &Value, _d: &str) -> Option<Vec<Value>> {
            None
        }
        fn plan_value_from_steps(&self, _s: &[Value]) -> Value {
            Value::Null
        }
    }
    struct DoneJudge;
    impl TurnCompletionJudge for DoneJudge {
        async fn task_appears_incomplete(&self, _r: &str, _w: &str) -> bool {
            false
        }
    }
    struct NoCompact;
    impl ContextCompactor for NoCompact {
        async fn compact(&self, _m: &mut Vec<Value>, _s: &mut usize) {}
    }
    #[derive(Default)]
    struct ReadRecordingCompactor(Mutex<Vec<TurnMemoryReadSet>>);
    impl ContextCompactor for ReadRecordingCompactor {
        async fn compact(&self, _m: &mut Vec<Value>, _s: &mut usize) {}

        async fn compact_for_budget(
            &self,
            _messages: &mut Vec<Value>,
            _context_window: Option<usize>,
            memory_reads: &TurnMemoryReadSet,
        ) {
            self.0.lock().unwrap().push(memory_reads.clone());
        }
    }
    struct OpenPolicy;
    impl TurnPolicy for OpenPolicy {
        fn route_blocked(&self, _t: &str) -> Option<String> {
            None
        }
        fn supports_vision(&self, _b: &str, _m: &str) -> bool {
            true
        }
    }
    #[derive(Default)]
    struct Collect(Mutex<Vec<GenerateStreamEvent>>);
    impl EventSink for Collect {
        async fn emit(&self, e: GenerateStreamEvent) {
            self.0.lock().unwrap().push(e);
        }
    }
    #[derive(Default)]
    struct CollectJournal(Mutex<Vec<String>>);
    impl crate::ExecutionJournal for CollectJournal {
        fn record(&self, event: crate::AgentExecutionEvent) {
            self.0
                .lock()
                .unwrap()
                .push(event.into_parts().0.to_string());
        }
    }

    fn cfg() -> TurnConfig {
        TurnConfig {
            hard_round_ceiling: 3,
            max_rounds: 2,
            browser_max_rounds: 8,
            browser_nav_cap: 6,
            browser_budget: crate::BrowserBudget {
                max_elapsed_ms: 300_000,
                max_failed_navigations: 8,
                max_no_progress: 5,
            },
            context_window: None,
            reconcile_on_delivery: true,
            autoadvance_from_evidence: true,
            step_verification: true,
            verbose: false,
            forced_tool: None,
            // Default true: most existing browser_done tests in this module drive the browse
            // sub-turn shape and expect the terminal to fire. Tests that need the OFF behavior
            // (non-subturn) override this field explicitly.
            browser_subturn: true,
        }
    }

    fn usage_context() -> local_first_inference_usage::UsageContext {
        local_first_inference_usage::UsageContext::new(
            "test-turn",
            local_first_inference_usage::InferencePurpose::ChatResponse,
            "test-user",
        )
    }

    // ⭐ The FIRST actual execution of `run_turn` (everything else is compile-time): drive a full turn
    // with mock seams and no network. Proves the extracted loop runs the happy path (model answers with
    // no tool calls) to completion — no panic, no hang (bounded by hard_round_ceiling), correct outcome.
    #[tokio::test(flavor = "current_thread")]
    async fn run_turn_happy_path_finishes_with_the_model_answer() {
        let mut ls = LoopState::new();
        ls.messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "hi" }),
        ];
        ls.step_messages_start = ls.messages.len();
        let sink = Collect::default();
        let journal = CollectJournal::default();
        let mut browser = NoBrowser;
        let composio_writes = std::collections::BTreeSet::new();
        let catalog_index: Vec<(String, String, Value)> = Vec::new();

        let outcome = run_turn(
            ls,
            cfg(),
            &usage_context(),
            &AnswerModel,
            &NoTools,
            &mut browser,
            &NoPlan,
            &DoneJudge,
            &NoCompact,
            &OpenPolicy,
            &journal,
            &sink,
            0.0,
            None,
            &composio_writes,
            &catalog_index,
            "hi".to_string(),
            String::new(),
            None,
            false,
            0,
            false,
            Vec::new(),
            None,
            &crate::turn_trace::TurnTrace::disabled(),
        )
        .await;

        assert_eq!(
            journal.0.lock().unwrap().as_slice(),
            ["prompt_snapshot", "model_response"]
        );

        // The model answered immediately → the turn commits that answer and ends.
        assert!(
            outcome.memory_answer.contains("Final answer"),
            "expected the model answer, got: {:?}",
            outcome.memory_answer
        );
        assert!(!outcome.memory_reads.has_linked_reads());
        assert_eq!(outcome.delivery, crate::TurnDelivery::Delivered);
        // A terminal Done event was emitted.
        assert!(
            sink.0
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, GenerateStreamEvent::Done { .. })),
            "expected a Done event"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn reasoning_only_completion_never_emits_done_or_claims_delivery() {
        let mut ls = LoopState::new();
        ls.messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "hi" }),
        ];
        ls.step_messages_start = ls.messages.len();
        let sink = Collect::default();
        let journal = CollectJournal::default();
        let mut browser = NoBrowser;
        let model = ReasoningOnlyModel::default();
        let composio_writes = std::collections::BTreeSet::new();
        let catalog_index: Vec<(String, String, Value)> = Vec::new();

        let outcome = run_turn(
            ls,
            cfg(),
            &usage_context(),
            &model,
            &NoTools,
            &mut browser,
            &NoPlan,
            &DoneJudge,
            &NoCompact,
            &OpenPolicy,
            &journal,
            &sink,
            0.0,
            None,
            &composio_writes,
            &catalog_index,
            "hi".to_string(),
            String::new(),
            None,
            false,
            0,
            false,
            Vec::new(),
            None,
            &crate::turn_trace::TurnTrace::disabled(),
        )
        .await;

        assert_eq!(
            outcome.delivery,
            crate::TurnDelivery::NoVisibleAnswer,
            "display-only text must not be delivered"
        );
        assert!(outcome.memory_answer.is_empty());
        assert_eq!(
            model.calls.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "the post-loop synthesis gets one chance to produce visible prose"
        );
        assert!(
            !sink
                .0
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, GenerateStreamEvent::Done { .. })),
            "display-only text must not emit Done"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn visible_answer_validation_preserves_structured_markers_in_done() {
        let mut ls = LoopState::new();
        ls.messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "hi" }),
        ];
        ls.step_messages_start = ls.messages.len();
        let sink = Collect::default();
        let journal = CollectJournal::default();
        let mut browser = NoBrowser;
        let composio_writes = std::collections::BTreeSet::new();
        let catalog_index: Vec<(String, String, Value)> = Vec::new();

        let outcome = run_turn(
            ls,
            cfg(),
            &usage_context(),
            &StructuredAnswerModel,
            &NoTools,
            &mut browser,
            &NoPlan,
            &DoneJudge,
            &NoCompact,
            &OpenPolicy,
            &journal,
            &sink,
            0.0,
            None,
            &composio_writes,
            &catalog_index,
            "hi".to_string(),
            String::new(),
            None,
            false,
            0,
            false,
            Vec::new(),
            None,
            &crate::turn_trace::TurnTrace::disabled(),
        )
        .await;

        assert_eq!(outcome.delivery, crate::TurnDelivery::Delivered);
        assert!(outcome.memory_answer.contains("‹‹PLAN››"));
        assert!(outcome.memory_answer.contains("‹‹ARTIFACT››"));
        let done_text = sink
            .0
            .lock()
            .unwrap()
            .iter()
            .find_map(|event| match event {
                GenerateStreamEvent::Done { text, .. } => Some(text.to_string()),
                _ => None,
            })
            .expect("visible answer must emit Done");
        assert!(done_text.contains("‹‹PLAN››"));
        assert!(done_text.contains("‹‹ARTIFACT››"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn forced_synthesis_keeps_prior_structured_output() {
        let mut ls = LoopState::new();
        ls.messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "make a document" }),
        ];
        ls.step_messages_start = ls.messages.len();
        let sink = Collect::default();
        let journal = CollectJournal::default();
        let mut browser = NoBrowser;
        let model = ToolThenForcedSynthesisModel::default();
        let tool = StructuredOutputTool::default();
        let composio_writes = std::collections::BTreeSet::new();
        let catalog_index: Vec<(String, String, Value)> = Vec::new();

        let outcome = run_turn(
            ls,
            cfg(),
            &usage_context(),
            &model,
            &tool,
            &mut browser,
            &NoPlan,
            &DoneJudge,
            &NoCompact,
            &OpenPolicy,
            &journal,
            &sink,
            0.0,
            None,
            &composio_writes,
            &catalog_index,
            "make a document".to_string(),
            String::new(),
            None,
            false,
            0,
            false,
            Vec::new(),
            None,
            &crate::turn_trace::TurnTrace::disabled(),
        )
        .await;

        assert_eq!(outcome.delivery, crate::TurnDelivery::Delivered,);
        let expected = "‹‹PLAN››- [x] Deliver result‹‹/PLAN››\n‹‹ARTIFACT››report.md‹‹/ARTIFACT››\n‹‹CHOICES››choose a format‹‹/CHOICES››\n‹‹REASONING››synthesis reasoning‹‹/REASONING››\nForced synthesis answer.";
        assert_eq!(outcome.memory_answer, expected);
        assert_eq!(outcome.memory_answer.matches("‹‹PLAN››").count(), 1,);
        assert_eq!(outcome.memory_answer.matches("‹‹ARTIFACT››").count(), 1,);
        assert_eq!(outcome.memory_answer.matches("‹‹CHOICES››").count(), 1,);
        let done_text = sink
            .0
            .lock()
            .unwrap()
            .iter()
            .find_map(|event| match event {
                GenerateStreamEvent::Done { text, .. } => Some(text.to_string()),
                _ => None,
            })
            .expect("forced synthesis must emit Done");
        assert_eq!(done_text, expected);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn browser_circuit_breaker_synthesizes_once() {
        let mut ls = LoopState::new();
        ls.messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "browse" }),
        ];
        ls.step_messages_start = ls.messages.len();
        let sink = Collect::default();
        let journal = CollectJournal::default();
        let mut browser = BlockedBrowser;
        let composio_writes = std::collections::BTreeSet::new();
        let catalog_index: Vec<(String, String, Value)> = Vec::new();
        let mut turn_cfg = cfg();
        turn_cfg.hard_round_ceiling = 12;
        turn_cfg.browser_max_rounds = 12;
        turn_cfg.browser_nav_cap = 12;
        turn_cfg.browser_budget.max_no_progress = 2;

        let outcome = run_turn(
            ls,
            turn_cfg,
            &usage_context(),
            &BlockedBrowserModel::default(),
            &NoTools,
            &mut browser,
            &NoPlan,
            &DoneJudge,
            &NoCompact,
            &OpenPolicy,
            &journal,
            &sink,
            0.0,
            None,
            &composio_writes,
            &catalog_index,
            "browse".to_string(),
            String::new(),
            None,
            false,
            0,
            false,
            Vec::new(),
            None,
            &crate::turn_trace::TurnTrace::disabled(),
        )
        .await;

        let journal_events = journal.0.lock().unwrap();
        assert_eq!(
            journal_events
                .iter()
                .filter(|kind| kind.as_str() == "browser_budget_exceeded")
                .count(),
            1
        );
        assert_eq!(
            journal_events
                .iter()
                .filter(|kind| kind.as_str() == "forced_synthesis")
                .count(),
            1
        );
        drop(journal_events);
        assert_eq!(
            sink.0
                .lock()
                .unwrap()
                .iter()
                .filter(|event| matches!(event, GenerateStreamEvent::Done { .. }))
                .count(),
            1
        );
        assert_eq!(outcome.delivery, crate::TurnDelivery::Delivered);
        assert!(outcome.memory_answer.contains("Non sono riuscito"));
    }

    #[derive(Default)]
    struct RecallThenAnswerModel {
        calls: std::sync::atomic::AtomicUsize,
    }

    impl ModelClient for RecallThenAnswerModel {
        async fn generate(
            &self,
            call: &ModelCall<'_>,
            on_delta: &(dyn Fn(&str) + Send + Sync),
        ) -> Result<ModelRoundOutput, ModelCallError> {
            let provider = ProviderBinding {
                model: call.model.to_string(),
                base_url: call.base_url.to_string(),
                api_key: None,
            };
            if self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                Ok(ModelRoundOutput {
                    message: json!({
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [{
                            "id": "recall_1",
                            "type": "function",
                            "function": { "name": "recall_memory", "arguments": "{}" },
                        }],
                    }),
                    provider,
                    finish_reason: Some("tool_calls".to_string()),
                    usage: Default::default(),
                    latency_ms: None,
                    time_to_first_token_ms: None,
                })
            } else {
                on_delta("Answer from linked memory.");
                Ok(ModelRoundOutput {
                    message: json!({
                        "role": "assistant",
                        "content": "Answer from linked memory."
                    }),
                    provider,
                    finish_reason: Some("stop".to_string()),
                    usage: Default::default(),
                    latency_ms: None,
                    time_to_first_token_ms: None,
                })
            }
        }
    }

    struct LinkedRecallTool;

    impl CapabilityExecutor for LinkedRecallTool {
        async fn execute_tool(
            &self,
            name: &str,
            _args: &str,
            _call_id: &str,
            _state: &mut LoopState,
        ) -> Result<ToolOutcome, String> {
            assert_eq!(name, "recall_memory");
            Ok(ToolOutcome {
                result: "linked fact".to_string(),
                effects: ToolEffects {
                    memory_reads: TurnMemoryReadSet {
                        linked: vec![LinkedMemoryRead {
                            source_workspace_id: "source-a".to_string(),
                            grant_id: "grant-a".to_string(),
                            policy_version: 3,
                            memory_ref: "memory:owner:source-a:fact-a".to_string(),
                            source_revision: "sha256:rev-a".to_string(),
                        }],
                        blocked_unknown: false,
                    },
                    ..ToolEffects::default()
                },
            })
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn recall_tool_reads_reach_turn_outcome() {
        let mut ls = LoopState::new();
        ls.messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "recall" }),
        ];
        ls.step_messages_start = ls.messages.len();
        let sink = Collect::default();
        let journal = CollectJournal::default();
        let mut browser = NoBrowser;
        let composio_writes = std::collections::BTreeSet::new();
        let catalog_index: Vec<(String, String, Value)> = Vec::new();
        let compactor = ReadRecordingCompactor::default();

        let outcome = run_turn(
            ls,
            cfg(),
            &usage_context(),
            &RecallThenAnswerModel::default(),
            &LinkedRecallTool,
            &mut browser,
            &NoPlan,
            &DoneJudge,
            &compactor,
            &OpenPolicy,
            &journal,
            &sink,
            0.0,
            None,
            &composio_writes,
            &catalog_index,
            "recall".to_string(),
            String::new(),
            None,
            false,
            0,
            false,
            Vec::new(),
            None,
            &crate::turn_trace::TurnTrace::disabled(),
        )
        .await;

        assert_eq!(outcome.memory_reads.linked.len(), 1);
        assert_eq!(outcome.memory_reads.linked[0].grant_id, "grant-a");
        assert!(
            compactor
                .0
                .lock()
                .unwrap()
                .iter()
                .any(TurnMemoryReadSet::has_linked_reads)
        );
    }

    // Round-0-only mock: returns a `make_document` tool call on the FIRST `generate` invocation,
    // then plain text (no tool_calls) on every subsequent one. Records the `forced_tool` it was
    // called with on each round so the test can assert forcing was applied ONCE, not every round.
    #[derive(Default)]
    struct ToolThenAnswerModel {
        calls: std::sync::atomic::AtomicUsize,
        forced_tool_seen: Mutex<Vec<Option<String>>>,
    }
    impl ModelClient for ToolThenAnswerModel {
        async fn generate(
            &self,
            call: &ModelCall<'_>,
            on_delta: &(dyn Fn(&str) + Send + Sync),
        ) -> Result<ModelRoundOutput, ModelCallError> {
            self.forced_tool_seen
                .lock()
                .unwrap()
                .push(call.forced_tool.map(str::to_string));
            let provider = ProviderBinding {
                model: call.model.to_string(),
                base_url: call.base_url.to_string(),
                api_key: None,
            };
            let n = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if n == 0 {
                // Round 0: the provider-forced call — MUST return a tool call (that's the
                // contract of a forced tool_choice).
                Ok(ModelRoundOutput {
                    message: json!({
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [{
                            "id": "call_1",
                            "type": "function",
                            "function": { "name": "make_document", "arguments": "{}" },
                        }],
                    }),
                    provider,
                    finish_reason: Some("tool_calls".to_string()),
                    usage: Default::default(),
                    latency_ms: None,
                    time_to_first_token_ms: None,
                })
            } else {
                // Round ≥1: the delivery already happened — a real model, back on "auto",
                // summarizes and stops. If forcing were still active here (the C1 bug), this
                // branch would never be reached: the provider would be compelled to emit
                // another tool call instead of text.
                on_delta("Document delivered.");
                Ok(ModelRoundOutput {
                    message: json!({ "role": "assistant", "content": "Document delivered." }),
                    provider,
                    finish_reason: Some("stop".to_string()),
                    usage: Default::default(),
                    latency_ms: None,
                    time_to_first_token_ms: None,
                })
            }
        }
    }

    // Counts how many times each tool name was dispatched, so the test can assert the forced
    // tool ran exactly once (not once per round, which was the C1 bug: force-looping the same
    // tool_choice every round meant a successful delivery was immediately followed by a SECOND,
    // now-unbound/generic call to the same tool).
    #[derive(Default)]
    struct CountingTool {
        make_document_calls: std::sync::atomic::AtomicUsize,
    }
    impl CapabilityExecutor for CountingTool {
        async fn execute_tool(
            &self,
            name: &str,
            _a: &str,
            _c: &str,
            _s: &mut LoopState,
        ) -> Result<ToolOutcome, String> {
            if name == "make_document" {
                self.make_document_calls
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            Ok(ToolOutcome {
                result: format!("ran {name}"),
                effects: ToolEffects::default(),
            })
        }
    }

    // ⭐ Final-review fix C1 (CRITICAL): forcing `tool_choice` must be ONE-SHOT within the turn.
    // Before the fix, `cfg.forced_tool` was passed on EVERY round's model call — since a forced
    // tool_choice contractually MUST come back with a tool call, the loop could never terminate
    // after a successful delivery: round 1 would force `make_document` AGAIN (a duplicate render,
    // by then unbound/generic since the routing binding had already cleared). This test drives a
    // turn with `forced_tool = Some("make_document")` and a mock model that returns the tool call
    // on round 0 and plain text on round 1+, and asserts the tool executed exactly ONCE and the
    // turn ends with the model's own text summary — not a second forced tool call.
    #[tokio::test(flavor = "current_thread")]
    async fn forced_tool_applies_only_to_round_zero_then_terminates_on_model_text() {
        let mut ls = LoopState::new();
        ls.messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "make me the quarterly report" }),
        ];
        ls.step_messages_start = ls.messages.len();
        let sink = Collect::default();
        let journal = CollectJournal::default();
        let mut browser = NoBrowser;
        let composio_writes = std::collections::BTreeSet::new();
        let catalog_index: Vec<(String, String, Value)> = Vec::new();

        let model = ToolThenAnswerModel::default();
        let tool = CountingTool::default();

        let mut turn_cfg = cfg();
        turn_cfg.forced_tool = Some("make_document".to_string());
        // Give the loop enough round budget to reach round 1 (the post-delivery round) so the
        // fix's "later rounds fall back to auto" behavior is actually exercised.
        turn_cfg.hard_round_ceiling = 4;
        turn_cfg.max_rounds = 4;

        let outcome = run_turn(
            ls,
            turn_cfg,
            &usage_context(),
            &model,
            &tool,
            &mut browser,
            &NoPlan,
            &DoneJudge,
            &NoCompact,
            &OpenPolicy,
            &journal,
            &sink,
            0.0,
            None,
            &composio_writes,
            &catalog_index,
            "make me the quarterly report".to_string(),
            String::new(),
            None,
            false,
            0,
            false,
            Vec::new(),
            None,
            &crate::turn_trace::TurnTrace::disabled(),
        )
        .await;

        // The tool ran exactly once — no duplicate render on round 1.
        assert_eq!(
            tool.make_document_calls
                .load(std::sync::atomic::Ordering::SeqCst),
            1,
            "make_document must execute exactly once, not once per round"
        );
        // Forcing was applied on round 0 only; round 1 (and any later round) saw `None` (auto).
        let seen = model.forced_tool_seen.lock().unwrap().clone();
        assert_eq!(
            seen.first().and_then(|f| f.as_deref()),
            Some("make_document"),
            "round 0 must be forced: {seen:?}"
        );
        assert!(
            seen.iter().skip(1).all(|f| f.is_none()),
            "every round after the first must be auto (None), got: {seen:?}"
        );
        // The turn ended with the model's own text summary, not a second forced tool call.
        assert!(
            outcome.memory_answer.contains("Document delivered"),
            "expected the model's post-delivery text summary, got: {:?}",
            outcome.memory_answer
        );
        // Exactly one Done event — the loop terminated cleanly instead of force-looping.
        let done_count = sink
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, GenerateStreamEvent::Done { .. }))
            .count();
        assert_eq!(
            done_count, 1,
            "expected exactly one Done event (clean termination)"
        );
    }

    #[derive(Default)]
    struct SteeringFinalizeModel {
        calls: AtomicUsize,
        control_ready: AtomicBool,
        applied: AtomicBool,
        completed: AtomicBool,
    }

    impl ModelClient for SteeringFinalizeModel {
        fn current_turn_control(&self) -> Option<crate::TurnControlDecision> {
            (self.control_ready.load(Ordering::SeqCst)
                && !self.applied.load(Ordering::SeqCst))
            .then(|| crate::TurnControlDecision {
                steering_id: 7,
                disposition: crate::TurnControlDisposition::FinalizeWithCurrentEvidence,
                instruction: "Answer now from the evidence already collected".to_string(),
            })
        }

        fn acknowledge_turn_control_applied(&self, steering_id: i64) {
            assert_eq!(steering_id, 7);
            self.applied.store(true, Ordering::SeqCst);
        }

        async fn wait_for_turn_control(&self) -> crate::TurnControlDecision {
            std::future::poll_fn(|context| {
                if let Some(control) = self.current_turn_control() {
                    std::task::Poll::Ready(control)
                } else {
                    context.waker().wake_by_ref();
                    std::task::Poll::Pending
                }
            })
            .await
        }

        fn acknowledge_turn_control_completed(&self, steering_id: i64) {
            assert_eq!(steering_id, 7);
            self.completed.store(true, Ordering::SeqCst);
        }

        async fn generate(
            &self,
            call: &ModelCall<'_>,
            _on_delta: &(dyn Fn(&str) + Send + Sync),
        ) -> Result<ModelRoundOutput, ModelCallError> {
            let index = self.calls.fetch_add(1, Ordering::SeqCst);
            let message = if index == 0 {
                json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "id": "tool_wait",
                        "type": "function",
                        "function": { "name": "wait_forever", "arguments": "{}" }
                    }]
                })
            } else {
                assert!(call.tools.is_empty());
                assert!(call.messages.iter().any(|message| {
                    message["content"]
                        .as_str()
                        .is_some_and(|content| content.contains("evidence already collected"))
                }));
                json!({"role": "assistant", "content": "Final answer from current evidence."})
            };
            Ok(ModelRoundOutput {
                message,
                provider: ProviderBinding {
                    model: call.model.to_string(),
                    base_url: call.base_url.to_string(),
                    api_key: None,
                },
                finish_reason: Some(if index == 0 { "tool_calls" } else { "stop" }.to_string()),
                usage: Default::default(),
                latency_ms: None,
                time_to_first_token_ms: None,
            })
        }
    }

    struct PendingSteeringTool<'a>(&'a SteeringFinalizeModel);

    impl CapabilityExecutor for PendingSteeringTool<'_> {
        async fn execute_tool(
            &self,
            _name: &str,
            _args: &str,
            _call_id: &str,
            _state: &mut LoopState,
        ) -> Result<ToolOutcome, String> {
            self.0.control_ready.store(true, Ordering::SeqCst);
            std::future::pending().await
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn steering_control_interrupts_active_tool_and_forces_one_terminal_synthesis() {
        let mut ls = LoopState::new();
        ls.messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "investigate" }),
        ];
        ls.step_messages_start = ls.messages.len();
        let model = SteeringFinalizeModel::default();
        let tool = PendingSteeringTool(&model);
        let sink = Collect::default();
        let journal = CollectJournal::default();
        let mut browser = NoBrowser;

        let outcome = run_turn(
            ls,
            cfg(),
            &usage_context(),
            &model,
            &tool,
            &mut browser,
            &NoPlan,
            &DoneJudge,
            &NoCompact,
            &OpenPolicy,
            &journal,
            &sink,
            0.0,
            None,
            &std::collections::BTreeSet::new(),
            &[],
            "investigate".to_string(),
            String::new(),
            None,
            false,
            0,
            false,
            Vec::new(),
            None,
            &crate::turn_trace::TurnTrace::disabled(),
        )
        .await;

        assert_eq!(outcome.delivery, crate::TurnDelivery::Delivered);
        assert_eq!(model.calls.load(Ordering::SeqCst), 2);
        assert!(model.applied.load(Ordering::SeqCst));
        assert!(model.completed.load(Ordering::SeqCst));
        assert_eq!(
            sink.0
                .lock()
                .unwrap()
                .iter()
                .filter(|event| matches!(event, GenerateStreamEvent::Done { .. }))
                .count(),
            1
        );
    }

    #[derive(Default)]
    struct ExhaustedTurnSteeringModel {
        calls: AtomicUsize,
        control_ready: AtomicBool,
        applied: AtomicBool,
        completed: AtomicBool,
    }

    impl ModelClient for ExhaustedTurnSteeringModel {
        fn finalization_fence(&self) -> crate::FinalizationFence {
            if self.control_ready.load(Ordering::SeqCst)
                && !self.applied.load(Ordering::SeqCst)
            {
                crate::FinalizationFence::PendingInput
            } else {
                crate::FinalizationFence::Ready
            }
        }

        fn current_turn_control(&self) -> Option<crate::TurnControlDecision> {
            (self.control_ready.load(Ordering::SeqCst)
                && !self.applied.load(Ordering::SeqCst))
            .then(|| crate::TurnControlDecision {
                steering_id: 9,
                disposition: crate::TurnControlDisposition::FinalizeWithCurrentEvidence,
                instruction: "Stop browsing and answer from current evidence".to_string(),
            })
        }

        async fn wait_for_turn_control(&self) -> crate::TurnControlDecision {
            loop {
                if let Some(control) = self.current_turn_control() {
                    return control;
                }
                tokio::task::yield_now().await;
            }
        }

        fn acknowledge_turn_control_applied(&self, steering_id: i64) {
            assert_eq!(steering_id, 9);
            self.applied.store(true, Ordering::SeqCst);
        }

        fn acknowledge_turn_control_completed(&self, steering_id: i64) {
            assert_eq!(steering_id, 9);
            self.completed.store(true, Ordering::SeqCst);
        }

        async fn generate(
            &self,
            call: &ModelCall<'_>,
            _on_delta: &(dyn Fn(&str) + Send + Sync),
        ) -> Result<ModelRoundOutput, ModelCallError> {
            let index = self.calls.fetch_add(1, Ordering::SeqCst);
            let message = if index == 0 {
                json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "id": "browse_once",
                        "type": "function",
                        "function": { "name": "browse", "arguments": "{}" }
                    }]
                })
            } else {
                assert!(call.is_final_round);
                assert!(self.applied.load(Ordering::SeqCst));
                assert!(call.messages.iter().any(|message| {
                    message["content"]
                        .as_str()
                        .is_some_and(|content| content.contains("Stop browsing"))
                }));
                json!({"role": "assistant", "content": "Answer after the steering instruction."})
            };
            Ok(ModelRoundOutput {
                message,
                provider: ProviderBinding {
                    model: call.model.to_string(),
                    base_url: call.base_url.to_string(),
                    api_key: None,
                },
                finish_reason: Some(if index == 0 { "tool_calls" } else { "stop" }.to_string()),
                usage: Default::default(),
                latency_ms: None,
                time_to_first_token_ms: None,
            })
        }
    }

    struct ExhaustingBrowseTool<'a>(&'a ExhaustedTurnSteeringModel);

    impl CapabilityExecutor for ExhaustingBrowseTool<'_> {
        async fn execute_tool(
            &self,
            _name: &str,
            _args: &str,
            _call_id: &str,
            _state: &mut LoopState,
        ) -> Result<ToolOutcome, String> {
            self.0.control_ready.store(true, Ordering::SeqCst);
            Ok(ToolOutcome {
                result: "found: false".to_string(),
                effects: ToolEffects::default(),
            })
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn post_loop_synthesis_cannot_overtake_interpreted_steering() {
        let mut ls = LoopState::new();
        ls.messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "research" }),
        ];
        ls.step_messages_start = ls.messages.len();
        let model = ExhaustedTurnSteeringModel::default();
        let tool = ExhaustingBrowseTool(&model);
        let sink = Collect::default();
        let journal = CollectJournal::default();
        let mut browser = NoBrowser;
        let mut turn_cfg = cfg();
        turn_cfg.hard_round_ceiling = 1;
        turn_cfg.max_rounds = 1;

        let outcome = run_turn(
            ls,
            turn_cfg,
            &usage_context(),
            &model,
            &tool,
            &mut browser,
            &NoPlan,
            &DoneJudge,
            &NoCompact,
            &OpenPolicy,
            &journal,
            &sink,
            0.0,
            None,
            &std::collections::BTreeSet::new(),
            &[],
            "research".to_string(),
            String::new(),
            None,
            false,
            0,
            false,
            Vec::new(),
            None,
            &crate::turn_trace::TurnTrace::disabled(),
        )
        .await;

        assert_eq!(outcome.delivery, crate::TurnDelivery::Delivered);
        assert!(model.applied.load(Ordering::SeqCst));
        assert!(model.completed.load(Ordering::SeqCst));
        assert_eq!(model.calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            sink.0
                .lock()
                .unwrap()
                .iter()
                .filter(|event| matches!(event, GenerateStreamEvent::Done { .. }))
                .count(),
            1
        );
    }

    #[derive(Default)]
    struct BrowserDeadlineModel {
        calls: AtomicUsize,
    }

    impl ModelClient for BrowserDeadlineModel {
        async fn generate(
            &self,
            call: &ModelCall<'_>,
            _on_delta: &(dyn Fn(&str) + Send + Sync),
        ) -> Result<ModelRoundOutput, ModelCallError> {
            let index = self.calls.fetch_add(1, Ordering::SeqCst);
            let message = if index == 0 {
                json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "id": "slow_browse",
                        "type": "function",
                        "function": { "name": "browse", "arguments": "{\"goal\":\"test\"}" }
                    }]
                })
            } else {
                assert!(call.is_final_round);
                json!({"role": "assistant", "content": "Final answer from the available evidence."})
            };
            Ok(ModelRoundOutput {
                message,
                provider: ProviderBinding {
                    model: call.model.to_string(),
                    base_url: call.base_url.to_string(),
                    api_key: None,
                },
                finish_reason: Some(if index == 0 { "tool_calls" } else { "stop" }.to_string()),
                usage: Default::default(),
                latency_ms: None,
                time_to_first_token_ms: None,
            })
        }
    }

    struct SlowDelegatedBrowse;

    impl CapabilityExecutor for SlowDelegatedBrowse {
        async fn execute_tool(
            &self,
            _name: &str,
            _args: &str,
            _call_id: &str,
            _state: &mut LoopState,
        ) -> Result<ToolOutcome, String> {
            tokio::time::sleep(std::time::Duration::from_millis(120)).await;
            Ok(ToolOutcome {
                result: "found: false".to_string(),
                effects: ToolEffects {
                    browser_activity_observed: true,
                    outcome_hint: Some(crate::ToolOutcomeHint::NoProgress),
                    ..ToolEffects::default()
                },
            })
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn delegated_browse_is_interrupted_at_the_turns_remaining_browser_deadline() {
        let mut ls = LoopState::new();
        ls.messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "browse" }),
        ];
        ls.step_messages_start = ls.messages.len();
        let model = BrowserDeadlineModel::default();
        let sink = Collect::default();
        let journal = CollectJournal::default();
        let mut browser = NoBrowser;
        let mut turn_cfg = cfg();
        turn_cfg.browser_budget.max_elapsed_ms = 20;
        let started = Instant::now();

        let outcome = run_turn(
            ls,
            turn_cfg,
            &usage_context(),
            &model,
            &SlowDelegatedBrowse,
            &mut browser,
            &NoPlan,
            &DoneJudge,
            &NoCompact,
            &OpenPolicy,
            &journal,
            &sink,
            0.0,
            None,
            &std::collections::BTreeSet::new(),
            &[],
            "browse".to_string(),
            String::new(),
            None,
            false,
            0,
            false,
            Vec::new(),
            None,
            &crate::turn_trace::TurnTrace::disabled(),
        )
        .await;

        assert!(started.elapsed() < std::time::Duration::from_millis(100));
        assert_eq!(outcome.delivery, crate::TurnDelivery::Delivered);
        assert_eq!(model.calls.load(Ordering::SeqCst), 2);
    }

    // --- Finalization fence rework: drain / bounded-wait / park (steering-park-resume, Task 1) ---

    /// A tool ran while a steering row became interpreted as a plain `continue` — the disposition
    /// `wait_for_interrupting_control` (used mid-round/mid-tool) deliberately ignores, so it never
    /// surfaces there. The fence's drain step must pick it up via `current_turn_control()` directly
    /// (which returns ANY interpreted row, continue included) instead of spinning on it forever.
    #[derive(Default)]
    struct TrailingContinueAtFenceModel {
        calls: AtomicUsize,
        control_ready: AtomicBool,
        applied: AtomicBool,
        completed: AtomicBool,
    }

    impl ModelClient for TrailingContinueAtFenceModel {
        fn finalization_fence(&self) -> crate::FinalizationFence {
            if self.control_ready.load(Ordering::SeqCst) && !self.applied.load(Ordering::SeqCst) {
                crate::FinalizationFence::PendingInput
            } else {
                crate::FinalizationFence::Ready
            }
        }

        fn current_turn_control(&self) -> Option<crate::TurnControlDecision> {
            (self.control_ready.load(Ordering::SeqCst) && !self.applied.load(Ordering::SeqCst)).then(
                || crate::TurnControlDecision {
                    steering_id: 11,
                    disposition: crate::TurnControlDisposition::ContinueCurrentWork,
                    instruction: "Keep going with the current step".to_string(),
                },
            )
        }

        async fn wait_for_turn_control(&self) -> crate::TurnControlDecision {
            loop {
                if let Some(control) = self.current_turn_control() {
                    return control;
                }
                tokio::task::yield_now().await;
            }
        }

        fn acknowledge_turn_control_applied(&self, steering_id: i64) {
            assert_eq!(steering_id, 11);
            self.applied.store(true, Ordering::SeqCst);
        }

        fn acknowledge_turn_control_completed(&self, steering_id: i64) {
            assert_eq!(steering_id, 11);
            self.completed.store(true, Ordering::SeqCst);
        }

        async fn generate(
            &self,
            call: &ModelCall<'_>,
            _on_delta: &(dyn Fn(&str) + Send + Sync),
        ) -> Result<ModelRoundOutput, ModelCallError> {
            let index = self.calls.fetch_add(1, Ordering::SeqCst);
            let message = if index == 0 {
                json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "id": "browse_once",
                        "type": "function",
                        "function": { "name": "browse", "arguments": "{}" }
                    }]
                })
            } else {
                assert!(call.is_final_round);
                assert!(self.applied.load(Ordering::SeqCst));
                assert!(call.messages.iter().any(|message| {
                    message["content"].as_str().is_some_and(|content| {
                        content.contains("Keep going with the current step")
                    })
                }));
                json!({"role": "assistant", "content": "Answer after the drained continue."})
            };
            Ok(ModelRoundOutput {
                message,
                provider: ProviderBinding {
                    model: call.model.to_string(),
                    base_url: call.base_url.to_string(),
                    api_key: None,
                },
                finish_reason: Some(if index == 0 { "tool_calls" } else { "stop" }.to_string()),
                usage: Default::default(),
                latency_ms: None,
                time_to_first_token_ms: None,
            })
        }
    }

    struct ContinueSettingBrowseTool<'a>(&'a TrailingContinueAtFenceModel);

    impl CapabilityExecutor for ContinueSettingBrowseTool<'_> {
        async fn execute_tool(
            &self,
            _name: &str,
            _args: &str,
            _call_id: &str,
            _state: &mut LoopState,
        ) -> Result<ToolOutcome, String> {
            self.0.control_ready.store(true, Ordering::SeqCst);
            Ok(ToolOutcome {
                result: "found: false".to_string(),
                effects: ToolEffects::default(),
            })
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn trailing_continue_at_the_fence_is_drained_and_finalizes() {
        let mut ls = LoopState::new();
        ls.messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "research" }),
        ];
        ls.step_messages_start = ls.messages.len();
        let model = TrailingContinueAtFenceModel::default();
        let tool = ContinueSettingBrowseTool(&model);
        let sink = Collect::default();
        let journal = CollectJournal::default();
        let mut browser = NoBrowser;
        let mut turn_cfg = cfg();
        turn_cfg.hard_round_ceiling = 1;
        turn_cfg.max_rounds = 1;

        let outcome = run_turn(
            ls,
            turn_cfg,
            &usage_context(),
            &model,
            &tool,
            &mut browser,
            &NoPlan,
            &DoneJudge,
            &NoCompact,
            &OpenPolicy,
            &journal,
            &sink,
            0.0,
            None,
            &std::collections::BTreeSet::new(),
            &[],
            "research".to_string(),
            String::new(),
            None,
            false,
            0,
            false,
            Vec::new(),
            None,
            &crate::turn_trace::TurnTrace::disabled(),
        )
        .await;

        // The trailing `continue` sitting at the fence is drained (applied) rather than parked —
        // the turn finalizes via forced synthesis instead of hanging on the old spin.
        assert_eq!(outcome.delivery, crate::TurnDelivery::Delivered);
        assert!(model.applied.load(Ordering::SeqCst));
        assert!(model.completed.load(Ordering::SeqCst));
        assert_eq!(
            sink.0
                .lock()
                .unwrap()
                .iter()
                .filter(|event| matches!(event, GenerateStreamEvent::Done { .. }))
                .count(),
            1
        );
    }

    /// The fence stays `PendingInput` forever and `current_turn_control()` never returns an
    /// interpreted row (the steering stays `pending`/`claimed` — e.g. the semantic model is
    /// unavailable to interpret it). `wait_for_turn_control()` models the REAL production
    /// behavior (`GatewayModelClient::wait_for_turn_control`): it returns ONLY once a non-
    /// `continue` interpreted control appears, else it never resolves on its own — so with
    /// `current_turn_control()` permanently `None`, awaiting it directly would block forever.
    /// The reworked park loop must tick on a plain wall-clock sleep instead of this seam, so it
    /// parks within its bounded budget regardless. If a regression makes the loop await this
    /// future directly, the test hangs and the `tokio::time::timeout` guard below catches it.
    #[derive(Default)]
    struct NeverInterpretedSteeringModel {
        calls: AtomicUsize,
        wait_calls: AtomicUsize,
    }

    impl ModelClient for NeverInterpretedSteeringModel {
        fn finalization_fence(&self) -> crate::FinalizationFence {
            crate::FinalizationFence::PendingInput
        }

        fn current_turn_control(&self) -> Option<crate::TurnControlDecision> {
            None
        }

        async fn wait_for_turn_control(&self) -> crate::TurnControlDecision {
            self.wait_calls.fetch_add(1, Ordering::SeqCst);
            // Never resolves — mirrors production when the row never gets interpreted. The
            // fixed park loop must not depend on this future completing.
            std::future::pending().await
        }

        async fn generate(
            &self,
            call: &ModelCall<'_>,
            _on_delta: &(dyn Fn(&str) + Send + Sync),
        ) -> Result<ModelRoundOutput, ModelCallError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(ModelRoundOutput {
                message: json!({
                    "role": "assistant",
                    "content": "Draft answer while steering is still pending.",
                }),
                provider: ProviderBinding {
                    model: call.model.to_string(),
                    base_url: call.base_url.to_string(),
                    api_key: None,
                },
                finish_reason: Some("stop".to_string()),
                usage: Default::default(),
                latency_ms: None,
                time_to_first_token_ms: None,
            })
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn uninterpreted_pending_steering_at_the_fence_parks_within_budget() {
        let mut ls = LoopState::new();
        ls.messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "investigate" }),
        ];
        ls.step_messages_start = ls.messages.len();
        let model = NeverInterpretedSteeringModel::default();
        let sink = Collect::default();
        let journal = CollectJournal::default();
        let mut browser = NoBrowser;
        let mut turn_cfg = cfg();
        turn_cfg.hard_round_ceiling = 1;
        turn_cfg.max_rounds = 1;

        // Guard against a regression to the old infinite spin (or to a park loop that awaits
        // the blocking `wait_for_turn_control()` seam): fail fast with a clear panic instead of
        // hanging the whole test binary.
        let started = std::time::Instant::now();
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            run_turn(
                ls,
                turn_cfg,
                &usage_context(),
                &model,
                &NoTools,
                &mut browser,
                &NoPlan,
                &DoneJudge,
                &NoCompact,
                &OpenPolicy,
                &journal,
                &sink,
                0.0,
                None,
                &std::collections::BTreeSet::new(),
                &[],
                "investigate".to_string(),
                String::new(),
                None,
                false,
                0,
                false,
                Vec::new(),
                None,
                &crate::turn_trace::TurnTrace::disabled(),
            ),
        )
        .await
        .expect("run_turn must park within its bounded wait budget, not hang");
        let elapsed = started.elapsed();

        assert_eq!(outcome.delivery, crate::TurnDelivery::Parked);
        assert!(outcome.memory_answer.is_empty());
        // Proves the budget is wall-clock-ticked (PARK_WAIT_CYCLES=40 * 50ms ~= 2s), not an
        // instant return and not a hang: real time actually elapsed, comfortably under the
        // 5s timeout above.
        assert!(
            elapsed >= std::time::Duration::from_millis(1_500),
            "expected the bounded wait to actually tick ~2s of wall-clock time, elapsed={elapsed:?}"
        );
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "park must complete within its own budget, well before the outer timeout, elapsed={elapsed:?}"
        );
        // `wait_for_turn_control()` never resolves in this double (`std::future::pending()`), so
        // the ONLY way this line is reached at all is if the park loop's tick never awaited it
        // to completion — a direct await here would have hung and been caught by the timeout
        // above instead. The lone round-0 model call races the loop's OTHER (unrelated)
        // `wait_for_interrupting_control` select arm against `generate()`, which may poll (but
        // never complete) this same seam once — hence `<= 1`, not a strict `== 0`.
        assert!(
            model.wait_calls.load(Ordering::SeqCst) <= 1,
            "wait_for_turn_control should be polled at most once (the unrelated round-call race), \
             never awaited to completion by the park loop's tick"
        );
        assert_eq!(
            sink.0
                .lock()
                .unwrap()
                .iter()
                .filter(|event| matches!(event, GenerateStreamEvent::Done { .. }))
                .count(),
            0,
            "a parked turn must never emit a terminal Done"
        );
    }
}
