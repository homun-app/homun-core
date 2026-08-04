# Browser Observe–Actions–Extract Design

**Status:** Approved design, pending implementation plan  
**Date:** 2026-07-23  
**Scope:** Browser latency, generic form interaction, and structured result extraction on the existing Homun Chromium runtime

## Problem

The current delegated browser loop uses an OpenClaw-style observe/act cycle in which the browser model normally performs one micro-action per inference. Every action auto-generates another broad accessibility snapshot, and the browser sub-agent returns free-form text that may require a forced synthesis. The manager can then launch another `browse` call when the first result is incomplete.

The installed-app Trenitalia run used to define this work took 326 seconds. It made 15 browser-model inference calls plus a forced browser synthesis. Browser inference consumed about 204 seconds; repeated snapshots grew browser-model inputs to roughly 8,000–15,000 tokens per round. The first `browse` occupied about 196 seconds and the manager then issued a second `browse` that consumed another 88 seconds. The run filled and submitted the form, but returned only one visible solution and no reliable prices.

The defect is therefore not primarily Playwright execution. It is the protocol above Playwright: too many model boundaries, oversized repeated observations, an ambiguous terminal contract, and a blind manager retry.

## Goals

1. Keep semantic interpretation in the models. Do not route user intent, fields, results, or steering through keyword matching.
2. Let one model decision produce up to four bounded browser actions.
3. Avoid resending the full page after every action.
4. Return a structured terminal browser result without a routine forced-synthesis call.
5. Complete one browser goal within one delegated `browse` session.
6. Preserve login and booking capabilities while requiring explicit one-use approval for the final payment action only.
7. Make latency, token growth, action progress, and stop reasons measurable.

## Acceptance Criteria

The live release gate is five consecutive searches on Trenitalia for Napoli Centrale to Milano Centrale on 12 August 2026, one-way, one adult, stopping before booking or payment.

Every run must:

- fill and submit the real form;
- return at least three visible solutions;
- include departure, arrival, duration, and price when the site displays that field;
- use one delegated `browse` call;
- avoid booking and payment;
- end with one terminal chat event.

Across the five runs:

- median prompt-to-final latency must be below 60 seconds;
- no run may exceed 90 seconds;
- no run may invent a missing field or claim an unobserved result.

## Non-Goals

- CloakBrowser, proxy routing, fingerprint management, or changes to the contained-computer image.
- Site-specific selectors, train-specific state machines, or Trenitalia keyword rules.
- Arbitrary JavaScript supplied by the model.
- Parallel browser sessions.
- A change to the approved payment-authorization boundary.

## Architecture

### 1. One semantic browser request

The manager calls `browse` once with a concrete goal, optional navigation hints, and a result contract derived semantically from the user request.

Conceptual request shape:

```json
{
  "goal": "Search the requested journey and report visible options",
  "hints": { "url": "https://www.trenitalia.com/it.html" },
  "result_contract": {
    "kind": "list",
    "minimum_items": 3,
    "fields": [
      { "name": "departure", "required": true },
      { "name": "arrival", "required": true },
      { "name": "duration", "required": true },
      { "name": "price", "required": false }
    ],
    "boundary": "Stop before booking or payment"
  }
}
```

The model constructs this contract from the request. The gateway validates shape and bounds but does not infer the contract from prose.

When a trusted `hints.url` is present, the gateway pre-navigates before the first browser-model inference. Because `browse` is already a built-in capability, the manager must not invoke capability discovery merely to find it.

### 2. Bounded observations

The browser returns typed observations with a page generation, URL, references, mode, and size statistics.

Three observation modes are used:

- `interact`: form controls, actionable elements, nearby labels, headings, and concise state; target approximately 6,000 characters.
- `delta`: newly added or materially changed accessible content plus current actionable references; target approximately 8,000 characters.
- `extract`: readable content for a selected subtree or the current results page; maximum approximately 16,000 characters.

Navigation returns an `interact` observation. Action bundles return a `delta` observation plus fresh references. The model explicitly requests `extract` when it is ready to collect the result contract. A full page is not automatically returned after every action.

The delta is structural, based on accessibility-snapshot changes and page generation. It is not selected through site or user keywords. If a useful delta cannot be produced, the response contains a bounded interaction observation and tells the model that an explicit extraction snapshot is available.

### 3. Bounded action bundles

The browser model may send one to four actions selected from the existing safe action vocabulary. Bundles are flat; nested batches are rejected.

Each bundle carries the observation generation from which its references were selected. The executor processes actions sequentially and validates every action immediately before execution. It stops the remaining bundle when:

- an action fails;
- the URL navigates unexpectedly;
- a modal dialog blocks progress;
- a reference becomes stale;
- a payment-related action is encountered;
- the page is no longer in the generation the remaining actions expect.

The result identifies completed and unexecuted actions, the stop reason, and a fresh observation. Ordinary controlled DOM changes caused by typing do not automatically abort a bundle; stale reference validation remains authoritative.

Autocomplete remains harness-owned: a semantic `type` action may confirm a combobox selection using the existing generic autocomplete behavior. Multi-field `fill_form` and the existing sidecar batch executor are reused behind the new bounded contract rather than introducing a parallel execution path.

### 4. Explicit terminal result

The browser sub-agent receives a `browser_done` tool. It must use this tool when the result contract is satisfied or when the goal must terminate with partial or failed evidence.

Conceptual result shape:

```json
{
  "status": "completed",
  "answer": "Three visible journey options were found",
  "items": [
    {
      "departure": "14:10",
      "arrival": "20:25",
      "duration": "6h 15m",
      "price": null
    }
  ],
  "fields_missing": ["price"],
  "sources": ["https://www.trenitalia.com/..."],
  "evidence": ["Visible result card containing the reported times"]
}
```

Allowed statuses are `completed`, `partial`, `blocked`, `unavailable`, and `timeout`. The gateway validates the declared result against the requested minimum item count and required fields. A structurally incomplete `completed` result is downgraded to `partial` before it reaches the manager.

`browser_done` terminates the recursive loop immediately. Routine completion does not run a browser-sub-agent forced synthesis. If the model becomes unavailable, the gateway returns the best structured state and last grounded observation to the manager as `partial` or `timeout`; the manager writes the user-facing response.

The manager receives one terminal result. It reports missing evidence honestly and does not issue a second automatic `browse`. A later retry requires a new user request or an explicit manager recovery decision backed by a typed retryable failure; the acceptance flow permits no such second call.

## Budgets and Recovery

- Maximum browser-model decision steps: 5.
- Maximum actions in one bundle: 4.
- Maximum consecutive no-progress bundles: 2.
- Browser sub-agent wall-clock budget: 55 seconds.
- Individual browser-model inference timeout: 15 seconds.
- One fallback inference is allowed after a browser-model timeout, using the configured fallback binding and the same bounded state.
- Navigation, Playwright action, and snapshot timings remain separately bounded and recorded.

A bundle failure does not discard completed actions or page evidence. Stale references return fresh references without restarting the browser session. Blocked navigation, site unavailability, timeout, and partial extraction remain distinct terminal reasons.

## Safety

Safety evaluation runs for every nested action, not only for the outer bundle.

- Login, form entry, search submission, and booking steps requested by the user are permitted.
- The final action that transfers money requires a matching, unconsumed Payment Approval Card.
- A payment action is never permitted inside a multi-action bundle; it must be a standalone action after approval.
- Payment credentials and vault values never enter model-visible action arguments.
- Arbitrary `evaluate` or model-supplied Playwright code remains unavailable.
- Existing navigation and private-network guards remain fail-closed.

## Observability

Each delegated browser run records a child run identifier and one redacted event per boundary:

- manager `browse` request and result contract fingerprint;
- pre-navigation time;
- model latency, token counts, timeout, and fallback use per decision;
- observation mode, character count, reference count, and snapshot fingerprint;
- action count, action kinds, completed count, Playwright duration, and stop reason;
- extraction item count and missing-field names;
- terminal status and total elapsed time.

Logs persist hashes, metrics, action kinds, and redacted summaries. Raw page text, typed secrets, credentials, payment details, and vault material are not persisted.

## Verification Strategy

### Automated tests

1. A dynamic browser fixture with two autocompletes, a date, passenger controls, submission, delayed results, and at least three result cards.
2. Red/green tests proving one observation can drive a bounded action bundle.
3. Bundle tests for partial completion, stale references, navigation, dialog interruption, and no-progress counting.
4. Snapshot tests for `interact`, structural `delta`, targeted `extract`, and size ceilings.
5. Result-contract tests that downgrade incomplete `completed` results to `partial`.
6. Loop tests proving `browser_done` terminates once without forced synthesis.
7. Safety tests proving nested actions are evaluated individually and payment cannot be batched.
8. Manager tests proving a built-in `browse` does not require capability discovery and no blind second `browse` is emitted.

### Live gates

1. Run the five consecutive Trenitalia searches defined in Acceptance Criteria.
2. Preserve per-run trace and aggregate latency/token metrics.
3. Inspect the real installed application transcript and Computer panel, not only test output.
4. Reject the release if any required result is missing, any run exceeds 90 seconds, the median exceeds 60 seconds, a second `browse` appears, or the app crosses the booking/payment boundary.

## Rollout

Implementation proceeds behind a temporary internal protocol flag while old and new paths can be benchmarked in the isolated development worktree. The flag is not a permanent user setting. The new path becomes the only path only after automated tests and all five live acceptance runs pass. The old one-action protocol is then removed rather than retained as a hidden fallback.

## Risks and Mitigations

- **A weak model emits unsafe or stale bundles.** Bound bundle size, require observation generation, validate every nested action, and return partial execution state.
- **A compact observation hides necessary data.** Keep interaction and extraction modes separate; allow targeted extraction rather than increasing every action response.
- **A slow provider consumes the full SLA.** Bound each inference, permit one configured fallback, and record provider latency explicitly.
- **The result tool contains unsupported claims.** Validate counts and required fields structurally, retain grounded evidence and sources, and downgrade incomplete completion.
- **The temporary dual path becomes permanent.** Gate rollout on the fixed acceptance test and delete the retired path after success.

## Deferred Work

CloakBrowser, proxy profiles, geographic alignment, and fingerprint management are deliberately deferred. If revisited, CloakBrowser must be introduced only as a `BrowserBackend` implementation behind the same protocol and safety policy, after separate license and distribution review. It must not be used to compensate for agent-loop latency or extraction defects.

## External References

- [Browser Use agent parameters](https://docs.browser-use.com/open-source/customize/agent/all-parameters): bounded multi-action steps and fast mode.
- [Stagehand speed optimization](https://docs.stagehand.dev/v3/best-practices/speed-optimization): observe once, execute multiple actions without repeated inference.
- [Stagehand structured extraction](https://docs.stagehand.dev/v3/basics/extract): schema-oriented page extraction.
- [OpenClaw browser documentation](https://docs.openclaw.ai/it/tools/browser): the snapshot/reference contract used by the current Homun path.
