//! The single guarded ReAct loop — motore #1 (ADR 0021), extracted into the engine (ADR 0024,
//! increment 5, Point 5 / 5.D1c.10).
//!
//! This is the canonical agent turn: a bounded round loop that calls the model, dispatches its tool
//! calls through the seams, tracks plan progress, and synthesizes a final answer. It is GENERIC over
//! its collaborators (the `contract` seams) so the engine stays decoupled from the gateway's concrete
//! `AppState`/transport — the gateway builds the impls and injects them.
//!
//! Landing note: this fn is a COPY of the gateway's inline `run_agent_rounds`, wired behind
//! `HOMUN_ENGINE_CRATE` (default OFF). While the flag is OFF the gateway runs its proven inline loop;
//! ON runs this one. The two are kept in parity via the `trace` oracle until 5.D2 flips the default and
//! deletes the inline copy — at which point this becomes the ONE loop (no flag, per "converge, don't
//! duplicate"). ADR 0025 (browse-as-recursion) then invokes this same loop recursively for the browser.

use crate::browser::{is_browser_granular_tool, prune_browser_history, resolve_browser_chat_tool_name};
use crate::contract::{
    BrowserExecutor, CapabilityExecutor, ContextCompactor, EventSink, ModelClient, PlanProgress,
    TurnCompletionJudge, TurnPolicy,
};
use crate::events::{GenerateStreamEvent, TokenMetrics};
use crate::markers::{
    append_vault_reveal_marker_if_missing, extract_vault_reveal_marker,
    should_force_synthesis_for_empty_visible_answer,
};
use crate::model_normalize;
use crate::plan::{
    advance_plan_frontier, answer_concludes_plan, build_plan_markdown, collapse_plan_markers,
    plan_next_open, plan_step_status, plan_step_title, plan_value_steps, replace_latest_plan_marker,
};
use crate::text::{extract_source_urls, fonti_section, is_low_value_source_url};
use crate::tools::{connected_capability_execution_trace_line, summarize_tool_action};
use crate::{LoopState, TurnConfig};

/// Max harness "you're not done — plan the rest" nudges per turn before giving up (F1 anti-loop).
const MAX_PLAN_NUDGES: u32 = 8;

/// Harness-driven plan progress from VERIFIED evidence. Called after each work tool result: if the
/// plan has a frontier `doing` step and enough new evidence has accrued, ask the F2 judge whether that
/// step is genuinely complete; if so, mark it done, advance the frontier, and emit the ‹‹PLAN›› card +
/// persist — the same canonical live+durable update the model's own `step_advance` produces. This is
/// the ONLY way progress rises during a browsing turn, where the driver is the weak browser model that
/// never calls `step_advance`. Verified-only, so thrashing on a hard-to-find market never fakes
/// progress. Stride-gated so the (cheap `memory`-role) judge runs at most once per few tool results.
///
/// Expressed over the seams (`PlanProgress` for verify/record/persist + the steps→Value bridge,
/// `EventSink` for the card, `TurnConfig` for the flags) — no `AppState`/transport/`ExecutionPlan`.
pub async fn try_advance_frontier_from_evidence(
    ls: &mut LoopState,
    plan_progress: &impl PlanProgress,
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
        let (ok, _reason) =
            plan_progress.verify_step_complete(&title, &criterion, &batch_evidence).await;
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
        event_sink.emit(GenerateStreamEvent::Delta { text: plan_mark }).await;
        plan_progress.persist_plan(thread_id, &plan_steps).await;
        // This evidence window was consumed by the advance — reset it + the stride anchor.
        ls.step_evidence.clear();
        ls.progress_verify_anchor = 0;
    }
}

/// Run ONE agent turn: the bounded guarded ReAct loop + forced synthesis. GENERIC over the seams so
/// the engine stays decoupled from the gateway's `AppState`/transport — the gateway builds the impls
/// (constructed per turn) and injects them. Returns the [`crate::TurnOutcome`] the gateway's post-turn
/// tail (memory learn + code-graph refresh) consumes. Behind `HOMUN_ENGINE_CRATE` (default OFF) until
/// 5.D2; kept in parity with the gateway's inline copy via the `trace` oracle.
#[allow(clippy::too_many_arguments)] // the turn's seams + engine-safe data; grouped further post-5.D2.
pub async fn run_turn<M, C, B, P, J, K, Pol, E>(
    mut ls: LoopState,
    cfg: TurnConfig,
    model_client: &M,
    capability_executor: &C,
    browser_executor: &mut B,
    plan_progress: &P,
    completion_judge: &J,
    compactor: &K,
    turn_policy: &Pol,
    event_sink: &E,
    temperature: f64,
    // by-ref: these are also borrowed by the gateway-constructed executors (dispatch shares one
    // construction), so the loop borrows them too rather than moving them out from under the executors.
    thread_id: Option<&str>,
    composio_writes: &std::collections::BTreeSet<String>,
    catalog_index: &[(String, String, serde_json::Value)],
    memory_user_message: String,
    mut memory_answer: String,
    mut last_model_error: Option<String>,
    mut final_done: bool,
    mut plan_nudges: u32,
    mut turn_used_tools: bool,
    mut browse_sources: Vec<String>,
    trace_dir: Option<std::path::PathBuf>,
) -> crate::TurnOutcome
where
    M: ModelClient,
    C: CapabilityExecutor,
    B: BrowserExecutor,
    P: PlanProgress,
    J: TurnCompletionJudge,
    K: ContextCompactor,
    Pol: TurnPolicy,
    E: EventSink,
{
    for round in 0..cfg.hard_round_ceiling {
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
            let step_navs = ls.step_evidence
                .iter()
                .filter(|e| e.starts_with("browser_navigate"))
                .count();
            if step_navs >= cfg.browser_nav_cap {
                let _ = event_sink.emit(
                    GenerateStreamEvent::Delta {
                        text: "‹‹ACT››⏹️ Enough sources visited — synthesizing from what I \
gathered‹‹/ACT››"
                            .to_string(),
                    },
                )
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
            compactor.compact(&mut ls.messages, &mut ls.step_messages_start).await;
        }
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
        let out = model_client
            .generate(
                &crate::ModelCall {
                    base_url: &ls.provider.base_url,
                    model: &ls.provider.model,
                    api_key: ls.provider.api_key.as_deref(),
                    messages: &ls.messages,
                    tools: &ls.tool_schemas,
                    temperature,
                    is_final_round,
                },
                &|_tok| {},
            )
            .await;
        let (message, round_finish_reason) = match out {
            Ok(o) => {
                // Adopt any mid-turn fallback swap for the remaining rounds.
                ls.provider = o.provider;
                (o.message, o.finish_reason)
            }
            // Parity: only an upstream status error becomes the committed final answer.
            Err(crate::ModelCallError::Upstream(reason)) => {
                last_model_error = Some(reason);
                break;
            }
            Err(crate::ModelCallError::Transport(_)) => break,
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
                let known: Vec<String> = ls.tool_schemas
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
                    let _ = event_sink.emit(GenerateStreamEvent::Delta {
                        text: "‹‹ACT››⏹️ Same actions repeated: stopping and summarizing‹‹/ACT››".to_string(),
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
                            crate::trace::hash_hex(
                                &crate::trace::normalize(args_raw),
                            ),
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
                        ls.tool_trace.push(format!("capability execution connector:{name}"));
                    }
                }

                let (result, tool_effects) = if is_browser_granular_tool(name) {
                    // Browser: through the BrowserExecutor seam (ADR 0026 / ADR 0025). The executor owns
                    // the browser subsystem's private state (session, snapshots, tab/nav bookkeeping)
                    // and mutates the loop-visible browser fields + provider via `&mut ls`. Produces no
                    // ToolEffects (it mutates directly). Folds into a recursive `browse` at ADR 0025.
                    let r = browser_executor
                        .execute_browser(name, args_raw, &call_id, &mut ls)
                        .await;
                    (r, crate::ToolEffects::default())
                } else {
                    // Non-browser: through the CapabilityExecutor seam (ADR 0026). The executor builds
                    // the per-call ChatToolCtx from `&mut ls` + its held read-only context. `args_raw`
                    // (the model's exact JSON string) is passed through unchanged — no round-trip.
                    match capability_executor
                        .execute_tool(name, args_raw, &call_id, &mut ls)
                        .await
                    {
                        Ok(o) => (o.result, o.effects),
                        Err(e) => (e, crate::ToolEffects::default()),
                    }
                };
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
                    ls.pending_vault_reveal_marker =
                        extract_vault_reveal_marker(&result).or(ls.pending_vault_reveal_marker.take());
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
                    try_advance_frontier_from_evidence(&mut ls, plan_progress, event_sink, &cfg, thread_id.as_deref(), round).await;
                }
                // Parity harness: compute the result-derived fingerprint fields
                // from `&result` BEFORE the push moves `result` into the message.
                // Gated on `dump_enabled()` so there is no cost when disarmed.
                let trace_fields = if crate::trace::dump_enabled() {
                    let normalized = crate::trace::normalize(&result);
                    Some((
                        crate::trace::hash_hex(
                            &crate::trace::normalize(args_raw),
                        ),
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
                        acc_markers: crate::trace::extract_markers(
                            acc_before,
                            &ls.accumulated,
                        ),
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
                let _ = event_sink.emit(
                    GenerateStreamEvent::Done {
                        text: final_text.clone(),
                        metrics: TokenMetrics::zero(),
                        redacted_user_text: None,
                    },
                )
                .await;
                memory_answer = final_text;
                final_done = true;
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
                    if !content.trim().is_empty() {
                        ls.messages.push(
                            serde_json::json!({ "role": "assistant", "content": content }),
                        );
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
                    let _ = event_sink.emit(
                        GenerateStreamEvent::Delta {
                            text: format!(
                                "‹‹ACT››▶ Proseguo: {}‹‹/ACT››",
                                step.chars().take(50).collect::<String>()
                            ),
                        },
                    )
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
                        plan_steps[open_index]["status"] = serde_json::json!("done");
                        content = replace_latest_plan_marker(&content, &plan_steps);
                        plan_progress.persist_plan(thread_id.as_deref(), &plan_steps).await;
                        if std::env::var("HOMUN_DEBUG").is_ok() {
                            eprintln!(
                                "[plan] reconciled last open step to done on delivery: «{step}»"
                            );
                        }
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
                let _ = event_sink.emit(
                    GenerateStreamEvent::Delta {
                        text: "‹‹ACT››▶ Pianifico il lavoro rimanente‹‹/ACT››".to_string(),
                    },
                )
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
        // if it too comes back empty, its own fallback chain ends the turn cleanly.
        if should_force_synthesis_for_empty_visible_answer(&ls.accumulated, &content) {
            if cfg.verbose {
                let fr = round_finish_reason.as_deref().unwrap_or("");
                eprintln!("[answer] empty answer body (finish_reason={fr}) → forced synthesis");
            }
            // Keep the reasoning trace in context so the synthesis builds on it.
            if !content.trim().is_empty() {
                ls.messages.push(serde_json::json!({ "role": "assistant", "content": content }));
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
            let _ = event_sink.emit(GenerateStreamEvent::Delta { text: fonti }).await;
        }
        // Anti-churn: the live stream carried one ‹‹PLAN›› block per plan tool call;
        // the PERSISTED answer keeps the plan card exactly once (latest state).
        // Reconcile the plan ONE last time on delivery — mark every still-open step done
        // (see plan_steps_reconciled_on_delivery) — and PERSIST it, so the runtime plan is
        // settled → the next turn won't falsely resume a plan this answer already finished.
        let delivered = collapse_plan_markers(&ls.accumulated);
        let delivered = match plan_progress.reconcile_on_delivery(&ls.plan, &delivered) {
            Some(reconciled) => {
                plan_progress.persist_plan(thread_id.as_deref(), &reconciled).await;
                replace_latest_plan_marker(&delivered, &reconciled)
            }
            None => delivered,
        };
        let final_answer =
            append_vault_reveal_marker_if_missing(delivered, ls.pending_vault_reveal_marker.as_deref());
        memory_answer = final_answer.clone();
        let _ = event_sink.emit(
            GenerateStreamEvent::Done {
                text: final_answer,
                metrics: TokenMetrics::zero(),
                redacted_user_text: None,
            },
        )
        .await;
        final_done = true;
        break;
    }

    // Turn end (ALL exit paths converge here: normal answer, pending_confirm, round-budget break,
    // natural exhaustion). The browser executor parks its session warm for the thread's next turn (or
    // stops it for an anonymous chat) and hides the "● LIVE" activity — see `close_session`.
    browser_executor.close_session(ls.browser_used).await;

    if !final_done {
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
        // A provider swap here is moot (the turn ends right after), and any error →
        // empty synth, falling through to the accumulated / last_model_error / canned
        // chain below (same fallback shape as before).
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
        // synth_text was already streamed live by the collector; the committed text
        // is the authoritative Done payload below.
        let mut final_text = if !synth_text.trim().is_empty() {
            synth_text
        } else if !ls.accumulated.trim().is_empty() {
            ls.accumulated.clone()
        } else if let Some(err) = last_model_error.clone() {
            // The model failed every call this turn (e.g. retired / unauthorized).
            // Surface the real reason instead of a generic "no answer".
            err
        } else {
            "I completed the steps but couldn't produce a final answer. \
Tell me if you want me to retry or rephrase."
                .to_string()
        };
        if let Some(fonti) = fonti_section(&browse_sources, &final_text) {
            final_text.push_str(&fonti);
        }
        // Anti-churn safety net for the `ls.accumulated` fallback (synth_text never
        // carries plan blocks, so this is a no-op when synthesis succeeded). Reconcile +
        // persist the plan on this exit path too, so a synthesis delivery also settles it.
        let delivered = collapse_plan_markers(&final_text);
        let delivered = match plan_progress.reconcile_on_delivery(&ls.plan, &delivered) {
            Some(reconciled) => {
                plan_progress.persist_plan(thread_id.as_deref(), &reconciled).await;
                replace_latest_plan_marker(&delivered, &reconciled)
            }
            None => delivered,
        };
        let final_text =
            append_vault_reveal_marker_if_missing(delivered, ls.pending_vault_reveal_marker.as_deref());
        memory_answer = final_text.clone();
        let _ = event_sink.emit(
            GenerateStreamEvent::Done {
                text: final_text,
                metrics: TokenMetrics::zero(),
                redacted_user_text: None,
            },
        )
        .await;
    }
    // 5.D1c.8: the post-turn tail (memory learn + code-graph refresh) is a GATEWAY concern (AppState /
    // stores / spawn), so it runs in the caller after this returns — driven by the outcome below. The
    // engine's turn ends here.
    crate::TurnOutcome {
        memory_answer,
        tool_actions: ls.tool_trace.join("\n"),
        browse_sources,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::{
        ModelCall, ModelCallError, ModelRoundOutput, ProviderBinding, ToolEffects, ToolOutcome,
    };
    use serde_json::{json, Value};
    use std::sync::Mutex;

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
            Ok(ToolOutcome { result: format!("ran {name}"), effects: ToolEffects::default() })
        }
    }
    struct NoBrowser;
    impl BrowserExecutor for NoBrowser {
        async fn execute_browser(&mut self, _n: &str, _a: &str, _c: &str, _s: &mut LoopState) -> String {
            String::new()
        }
        async fn close_session(&mut self, _b: bool) {}
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

    fn cfg() -> TurnConfig {
        TurnConfig {
            hard_round_ceiling: 3,
            max_rounds: 2,
            browser_max_rounds: 8,
            browser_nav_cap: 6,
            reconcile_on_delivery: true,
            autoadvance_from_evidence: true,
            step_verification: true,
            verbose: false,
        }
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
        let mut browser = NoBrowser;
        let composio_writes = std::collections::BTreeSet::new();
        let catalog_index: Vec<(String, String, Value)> = Vec::new();

        let outcome = run_turn(
            ls,
            cfg(),
            &AnswerModel,
            &NoTools,
            &mut browser,
            &NoPlan,
            &DoneJudge,
            &NoCompact,
            &OpenPolicy,
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
        )
        .await;

        // The model answered immediately → the turn commits that answer and ends.
        assert!(
            outcome.memory_answer.contains("Final answer"),
            "expected the model answer, got: {:?}",
            outcome.memory_answer
        );
        // A terminal Done event was emitted.
        assert!(
            sink.0.lock().unwrap().iter().any(|e| matches!(e, GenerateStreamEvent::Done { .. })),
            "expected a Done event"
        );
    }
}
