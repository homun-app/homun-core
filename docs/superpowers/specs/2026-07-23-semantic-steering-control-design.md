# Semantic Steering Control Design

**Date:** 2026-07-23

**Status:** Approved in conversation; awaiting written-spec review

## Purpose

Make an in-flight steering message change the active turn according to its meaning, not according to keywords. Homun must distinguish a normal refinement from a request to replan, conclude with current evidence, cancel, or ask for clarification. Once the semantic layer makes that decision, the runtime must enforce it and report its real lifecycle accurately.

This closes the failure observed in the train-search turn: the steering message was marked `applied` after being appended to a model round, but the model continued opening tools for another nine minutes. The status described prompt delivery, not behavioral application.

## Principles

1. Natural-language interpretation belongs exclusively to the model-backed semantic decision layer.
2. The steering path must not contain keyword lists, regular expressions, phrase tables, or lexical fallbacks for deciding control intent.
3. Runtime enforcement is deterministic only after a validated structured semantic decision exists.
4. Model unavailability must leave the steering message durable and pending; it must not trigger guessed behavior.
5. A manual Stop remains authoritative, but does not discard an uninterpreted steering message.
6. `applied` means the runtime accepted the decision and changed execution, not merely that text entered a prompt.

## Considered approaches

### Extend the existing semantic decision layer — chosen

Add a steering disposition to the existing validated semantic contract. This layer already receives the latest message, active objective, bounded recent context, explicit routing binding, and capability registry, and its prompt already forbids keyword matching as the final decision.

This keeps one source of semantic truth and lets the runtime enforce a small structured vocabulary.

### Add a separate steering judge — rejected

A dedicated judge would isolate steering classification, but duplicate context assembly, provider selection, validation, provenance, and failure handling. Two semantic authorities could disagree about the same active objective.

### Rely on the main agent prompt — rejected

Appending a steering message as another user message is advisory. The observed run proved that a model can receive it and still emit more tool calls. Prompt emphasis cannot provide the runtime guarantee required here.

## Semantic contract

The validated semantic decision gains a required `steering_disposition` field:

- `continue_current_work`: incorporate the message without interrupting the current tool or plan.
- `replan_current_work`: retain the objective and verified progress, but revise the remaining plan and constraints.
- `finalize_with_current_evidence`: stop ongoing work, prohibit new tools, and synthesize a final response from durable evidence already collected.
- `cancel_current_work`: stop ongoing work and close the objective without attempting more work.
- `needs_clarification`: do not mutate execution; ask the user to clarify the intended change.

For a new turn with no active objective, the field is `continue_current_work`. For steering, the semantic model decides the value from the full bounded context. The validator checks that the value is structurally valid and compatible with the objective relationship, mode, scope, effects, and confirmation requirements.

A steering control decision is usable only when it came from valid model output. If provenance contains a semantic fallback reason, structural validation fails, confidence is non-finite or outside `0..=1`, or the provider is unavailable, the steering message remains pending. There is no additional numeric confidence threshold: an uncertain model must choose `needs_clarification`. The ordinary new-turn routing fallback may continue to exist, but it cannot decide steering control.

## Steering lifecycle

The durable lifecycle is:

1. `pending`: saved and awaiting semantic interpretation.
2. `claimed`: an interpreter owns the current attempt.
3. `interpreted`: a validated model decision and provenance are persisted.
4. `applied`: the live runtime or a recovery executor acknowledges the decision and changes execution.
5. `completed`: the requested control outcome reaches its terminal state.

Existing `held`, `cancelled`, and `promoted` states remain for concurrency and finalization races. Existing stored `applied` rows remain readable, but new rows can reach `applied` only after runtime acknowledgement.

The steering record stores the validated semantic decision, schema version, model/provider provenance, interpretation timestamps, retry metadata, runtime acknowledgement, and completion timestamp. It does not store secrets or unredacted model payloads.

User-facing labels map to actual state:

- `pending` or `claimed`: **Waiting for the model**;
- `interpreted`: **Understood**;
- `applied`: **Applying**;
- `completed`: **Completed**;
- `interpreted` with disposition `needs_clarification`: **Needs clarification**.

## Interpretation coordinator

Enqueue remains fast: the gateway persists the steering message and returns `202` before semantic inference finishes. A durable coordinator claims pending steering records and invokes the existing semantic decision layer with:

- the steering message;
- the active objective contract and revision;
- bounded recent conversation context;
- the current plan and task status;
- a bounded, redacted summary of durable turn evidence and current activity.

The coordinator persists only validated structured output. If the semantic model is unavailable or returns unusable output, the record returns to `pending` with bounded retry metadata. It is retried when the model becomes available, at later round boundaries, after application restart, and when a stopped turn is recovered. There is no lexical fallback.

Retries use bounded backoff and release worker capacity while waiting. They do not create repeated chat messages or repeated steering bubbles.

## Runtime control

Each live turn exposes a control channel separate from hard cancellation. Once a steering decision is `interpreted`, the coordinator publishes the structured disposition to that channel.

### Continue and replan

`continue_current_work` is injected once at the next safe model boundary. `replan_current_work` invalidates only the unverified remainder of the plan, preserves completed steps and evidence, and injects the structured revision before the next model call.

Neither disposition interrupts an in-flight tool unless the model decision explicitly changes to finalization or cancellation.

### Finalize with current evidence

`finalize_with_current_evidence` performs these steps:

1. persist a redacted continuation checkpoint containing the assistant draft, plan state, safe tool results, and current evidence references;
2. cooperatively interrupt the active capability;
3. prevent every subsequent capability call for that turn;
4. run one forced synthesis round with tools removed;
5. emit exactly one durable terminal answer;
6. mark the steering record `completed` only after that terminal event is committed.

Browser interruption calls the browser sidecar's Stop operation. Other capabilities use their cancellation boundary and cleanup contract. If a capability cannot stop immediately, no new capability may start after it returns, and final synthesis follows immediately.

### Cancel current work

`cancel_current_work` interrupts the active capability, persists the stopped checkpoint, closes the active objective, and emits one concise terminal acknowledgement. It does not run more investigative or effectful tools.

### Needs clarification

`needs_clarification` leaves the current execution unchanged only until a safe boundary, then parks the turn and emits a clarification request. It does not silently reinterpret the message or expand scope.

## Model unavailability and turn boundaries

An uninterpreted steering message cannot be marked applied and cannot be discarded.

If the active work reaches its natural final boundary while steering is still pending, the executor checkpoints the turn and parks it in a waiting-for-model state instead of spinning additional model rounds. When semantic inference becomes available, the coordinator interprets the message and requeues the same logical turn.

If the user presses Stop first, the runtime cancels the active capability and persists the same bounded continuation checkpoint. The steering record remains pending. When the model becomes available, a recovery executor interprets all still-relevant pending steering in order against the stopped turn's objective, conversation, and checkpoint. It then either finalizes, cancels, requests clarification, or promotes a compatible continuation. No keyword logic is used during recovery.

## Stream and UI behavior

Steering state is delivered through durable events keyed by steering ID and revision. Reconnect and replay reuse the existing turn sequence deduplication, so every state change renders once.

The activity panel distinguishes live state from history:

- active work may show `Running`;
- a parked turn shows `Waiting for the model`;
- a stopped or terminal turn never shows a historical command as currently running;
- historical commands are labelled `Last activity` when retained.

The steering bubble shows the lifecycle label and remains associated with the active logical turn or its recovery continuation. A finalization steer produces one assistant response, not a second independent chat turn.

## Error handling

- Provider unavailable, timeout, invalid JSON, schema rejection, or fallback provenance: keep pending, persist a redacted diagnostic code, and retry.
- Objective revision changed before interpretation: re-read current context and reinterpret; do not apply the stale decision.
- Runtime disappeared after interpretation: leave `interpreted` durable for recovery; do not mark applied.
- Interruption cleanup failed: prohibit new tools, record the cleanup failure, and continue to forced synthesis when safe.
- Final synthesis model unavailable: park as waiting for model with the checkpoint intact.
- Duplicate coordinator or replay delivery: steering ID, revision, and transition guards make interpretation and application idempotent.

## Verification strategy

### Semantic contract tests

- Valid model output accepts every steering disposition.
- Invalid or contradictory dispositions are rejected.
- Semantic fallback provenance cannot produce an actionable steering decision.
- Provider failure leaves the record pending.
- There is no text-to-control keyword parser in the steering path.

### Store and coordinator tests

- State transitions follow `pending → claimed → interpreted → applied → completed`.
- Failed interpretation returns to pending with retry metadata.
- Concurrent interpreters cannot claim the same revision.
- Restart recovery resumes pending and interpreted records exactly once.
- A changed objective revision forces reinterpretation.

### Runtime tests

- A `continue_current_work` decision does not interrupt the active tool.
- A `replan_current_work` decision preserves verified progress.
- A `finalize_with_current_evidence` decision interrupts the active tool, rejects later tool calls, and produces one final answer.
- A `cancel_current_work` decision runs no further tools.
- A pending decision at natural completion parks without a retry loop.
- Manual Stop preserves pending steering and a recoverable checkpoint.
- Finalization and cancellation remain idempotent under replay.

Tests inject structured semantic decisions directly into the coordinator/runtime boundary. They verify enforcement without replacing semantic understanding with keyword fixtures.

### Installed-app checks

- Start a browser investigation, send a normally worded refinement, and verify work continues with the revised plan.
- During another investigation, send a natural request to stop further work and answer from current evidence. Verify the configured semantic model selects finalization, the live tool stops, no later tool starts, and one answer appears.
- Repeat with a paraphrase and with a negated instruction to confirm the actual model, rather than a phrase matcher, makes the distinction.
- Make the semantic provider unavailable, send steering, verify `Waiting for the model`, restore it, and verify automatic interpretation.
- Stop manually while interpretation is pending, restore the provider, and verify durable recovery.

## Non-goals and delivery boundary

- This design does not change payment authorization or browser action policy.
- It does not create a second semantic judge.
- It does not guarantee that every third-party capability can terminate instantaneously; it guarantees cooperative interruption, no subsequent tools, and eventual forced synthesis.
- It does not authorize a real purchase, payment, external write, deployment, push, pull request, or release publication.
