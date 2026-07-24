# Browser Observe-Actions-Extract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current one-action browser sub-agent loop with a bounded observe-actions-extract protocol that can fill forms, submit searches, and return structured evidence inside one delegated `browse` call.

**Architecture:** Keep semantic interpretation in the model, but make the browser runtime contract typed and bounded. The manager emits one `browse` request with optional hints and a result contract; the browser sub-turn receives compact observations, can execute up to four validated actions per decision, and terminates through a structured `browser_done` result instead of routine forced synthesis.

**Tech Stack:** Rust engine/gateway (`crates/engine`, `crates/desktop-gateway`), TypeScript browser sidecar with Playwright (`runtimes/browser-automation`), Rust unit tests, Vitest sidecar tests, installed macOS app live validation.

---

## File Structure

- Modify `crates/engine/src/browse.rs`: add result-contract types, `browser_done` payload validation, structured manager rendering, and tests.
- Modify `crates/engine/src/browser.rs`: register `browser_done` as a browser sub-turn granular tool.
- Modify `crates/engine/src/agent_loop.rs`: let `browser_done` terminate the sub-turn without forced synthesis and add tests around terminal browser delivery.
- Modify `crates/desktop-gateway/src/main.rs`: extend `browse` schema, parse one semantic browser request, pre-navigate trusted hints, expose `browser_done`, validate action bundles and payment boundaries, keep `browse` core-loaded, disable blind second browse, and add gateway unit tests.
- Modify `runtimes/browser-automation/src/browser/snapshot.ts`: add `interact`, `delta`, and `extract` observation modes with explicit size ceilings.
- Modify `runtimes/browser-automation/src/browser/session_manager.ts`: track page generation, snapshot fingerprints, previous snapshots, and pass requested observation options after actions.
- Modify `runtimes/browser-automation/src/browser/actions.ts`: enforce chat-bundle limits when requested and surface partial bundle execution state.
- Modify `runtimes/browser-automation/src/contracts.js` only if request/response types require a shared exported error code; keep protocol JSON-line compatible.
- Modify `runtimes/browser-automation/tests/fixtures/train.html`: extend the train fixture to cover delayed three-result extraction with prices.
- Modify `runtimes/browser-automation/tests/browser_fixture.test.ts`: add observation, bundle, stale-generation, and train fixture tests.
- Modify `crates/browser-automation/tests/policy.rs`: add nested bundle payment-policy tests.
- Modify `docs/architecture/browser.md`: record the new protocol and live gate.

## Task 1: Structured Browse Result Contract

**Files:**
- Modify: `crates/engine/src/browse.rs`

- [ ] **Step 1: Write failing result-contract tests**

Add these tests inside `#[cfg(test)] mod tests` in `crates/engine/src/browse.rs`:

```rust
#[test]
fn browser_done_completed_is_downgraded_when_minimum_items_missing() {
    let contract = BrowseResultContract {
        kind: BrowseResultKind::List,
        minimum_items: Some(3),
        fields: vec![
            BrowseResultField { name: "departure".into(), required: true },
            BrowseResultField { name: "arrival".into(), required: true },
            BrowseResultField { name: "duration".into(), required: true },
            BrowseResultField { name: "price".into(), required: false },
        ],
        boundary: Some("Stop before booking or payment".into()),
    };
    let payload = BrowserDonePayload {
        status: BrowserDoneStatus::Completed,
        answer: "One visible option".into(),
        items: vec![serde_json::json!({
            "departure": "09:05",
            "arrival": "13:40",
            "duration": "4h 35m"
        })],
        fields_missing: vec![],
        sources: vec!["https://www.trenitalia.com/".into()],
        evidence: vec!["Visible result card with times".into()],
    };

    let result = validate_browser_done_payload(payload, Some(&contract));

    assert_eq!(result.status, BrowserDoneStatus::Partial);
    assert!(result.found);
    assert_eq!(result.items.len(), 1);
    assert!(result.fields_missing.contains(&"minimum_items".to_string()));
}

#[test]
fn browser_done_completed_keeps_optional_missing_price() {
    let contract = BrowseResultContract {
        kind: BrowseResultKind::List,
        minimum_items: Some(1),
        fields: vec![
            BrowseResultField { name: "departure".into(), required: true },
            BrowseResultField { name: "arrival".into(), required: true },
            BrowseResultField { name: "duration".into(), required: true },
            BrowseResultField { name: "price".into(), required: false },
        ],
        boundary: Some("Stop before booking or payment".into()),
    };
    let payload = BrowserDonePayload {
        status: BrowserDoneStatus::Completed,
        answer: "One visible option".into(),
        items: vec![serde_json::json!({
            "departure": "09:05",
            "arrival": "13:40",
            "duration": "4h 35m",
            "price": null
        })],
        fields_missing: vec!["price".into()],
        sources: vec!["https://www.trenitalia.com/".into()],
        evidence: vec!["Price was not visible in the result card".into()],
    };

    let result = validate_browser_done_payload(payload, Some(&contract));

    assert_eq!(result.status, BrowserDoneStatus::Completed);
    assert!(result.fields_missing.contains(&"price".to_string()));
}
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
cargo test -p local-first-engine browser_done_completed_is_downgraded_when_minimum_items_missing
cargo test -p local-first-engine browser_done_completed_keeps_optional_missing_price
```

Expected: compile failure because `BrowseResultContract`, `BrowserDonePayload`, `BrowserDoneStatus`, `BrowseResultKind`, `BrowseResultField`, and `validate_browser_done_payload` do not exist.

- [ ] **Step 3: Add structured types and validation**

In `crates/engine/src/browse.rs`, add these public types above `BrowseResult`:

```rust
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowserDoneStatus {
    Completed,
    #[default]
    Partial,
    Blocked,
    Unavailable,
    Timeout,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowseResultKind {
    #[default]
    List,
    Fact,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowseResultField {
    pub name: String,
    pub required: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowseResultContract {
    pub kind: BrowseResultKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimum_items: Option<usize>,
    #[serde(default)]
    pub fields: Vec<BrowseResultField>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boundary: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BrowserDonePayload {
    pub status: BrowserDoneStatus,
    pub answer: String,
    #[serde(default)]
    pub items: Vec<Value>,
    #[serde(default)]
    pub fields_missing: Vec<String>,
    #[serde(default)]
    pub sources: Vec<String>,
    #[serde(default)]
    pub evidence: Vec<String>,
}
```

Extend `BrowseResult` with skip-default structured fields while keeping the old `found/answer/sources/confidence/note` fields:

```rust
#[serde(default)]
pub status: BrowserDoneStatus,
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub items: Vec<Value>,
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub fields_missing: Vec<String>,
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub evidence: Vec<String>,
```

Add validation:

```rust
pub fn validate_browser_done_payload(
    payload: BrowserDonePayload,
    contract: Option<&BrowseResultContract>,
) -> BrowseResult {
    let mut status = payload.status;
    let mut missing = payload.fields_missing.clone();
    if let Some(contract) = contract {
        if let Some(minimum_items) = contract.minimum_items {
            if payload.items.len() < minimum_items && status == BrowserDoneStatus::Completed {
                status = BrowserDoneStatus::Partial;
                push_unique(&mut missing, "minimum_items");
            }
        }
        for field in contract.fields.iter().filter(|field| field.required) {
            let has_field = payload.items.iter().any(|item| {
                item.get(&field.name)
                    .map(|value| !value.is_null() && value.as_str().map(str::trim) != Some(""))
                    .unwrap_or(false)
            });
            if !has_field && status == BrowserDoneStatus::Completed {
                status = BrowserDoneStatus::Partial;
                push_unique(&mut missing, &field.name);
            }
        }
    }
    let found = matches!(status, BrowserDoneStatus::Completed | BrowserDoneStatus::Partial)
        && (!payload.answer.trim().is_empty() || !payload.items.is_empty());
    BrowseResult {
        found,
        answer: payload.answer.trim().to_string(),
        sources: payload.sources,
        confidence: if found { Confidence::High } else { Confidence::Low },
        note: (!found).then(|| format!("{status:?}")),
        status,
        items: payload.items,
        fields_missing: missing,
        evidence: payload.evidence,
    }
}

fn push_unique(values: &mut Vec<String>, value: &str) {
    if !values.iter().any(|existing| existing == value) {
        values.push(value.to_string());
    }
}
```

Update existing `BrowseResult` constructors/tests to set `status: BrowserDoneStatus::Completed` for found legacy results and `BrowserDoneStatus::Unavailable` for `not_found`.

- [ ] **Step 4: Render structured results for the manager**

Extend `browse_result_for_manager` so structured fields are visible:

```rust
out.push_str(&format!("\nstatus: {:?}", result.status).to_lowercase());
if !result.items.is_empty() {
    out.push_str("\nitems:");
    for item in &result.items {
        out.push_str(&format!("\n- {}", serde_json::to_string(item).unwrap_or_default()));
    }
}
if !result.fields_missing.is_empty() {
    out.push_str("\nfields_missing:");
    for field in &result.fields_missing {
        out.push_str(&format!("\n- {field}"));
    }
}
if !result.evidence.is_empty() {
    out.push_str("\nevidence:");
    for evidence in &result.evidence {
        out.push_str(&format!("\n- {evidence}"));
    }
}
```

- [ ] **Step 5: Run the engine tests and verify GREEN**

Run:

```bash
cargo test -p local-first-engine browse::tests
```

Expected: all `browse::tests` pass.

- [ ] **Step 6: Commit**

```bash
git add crates/engine/src/browse.rs
git commit -m "feat(browser): add structured browse result contract"
```

## Task 2: Browser Terminal Tool in the Engine

**Files:**
- Modify: `crates/engine/src/browser.rs`
- Modify: `crates/engine/src/agent_loop.rs`

- [ ] **Step 1: Write failing engine loop test**

In `crates/engine/src/agent_loop.rs`, add a test near existing browser executor tests:

```rust
#[tokio::test]
async fn browser_done_tool_terminates_without_forced_synthesis() {
    let model = ModelScript::new(vec![ModelRoundOutput {
        message: serde_json::json!({
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "id": "call_done",
                "type": "function",
                "function": {
                    "name": "browser_done",
                    "arguments": r#"{"status":"completed","answer":"done","items":[{"departure":"09:05"}],"sources":["https://example.test"],"evidence":["visible"]}"#
                }
            }]
        }),
        finish_reason: Some("tool_calls".to_string()),
        metrics: TokenMetrics::zero(),
    }]);
    let mut ls = LoopState::new();
    ls.tool_schemas = vec![serde_json::json!({
        "type":"function",
        "function":{"name":"browser_done","parameters":{"type":"object","properties":{}}}
    })];
    let mut browser = DoneBrowser::default();
    let sink = VecEventSink::default();
    let mut cfg = test_turn_cfg();
    cfg.hard_round_ceiling = 5;

    let outcome = run_turn(
        ls,
        cfg,
        &test_usage_context("browser_done_terminal"),
        &model,
        &NoCapability,
        &mut browser,
        &NoPlan,
        &DoneJudge,
        &NoCompactor,
        &OpenPolicy,
        &NoopExecutionJournal,
        &sink,
        0.2,
        None,
        &std::collections::BTreeSet::new(),
        &[],
        String::new(),
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

    assert_eq!(outcome.delivery, TurnDelivery::Delivered);
    assert_eq!(outcome.memory_answer, "done");
    assert_eq!(model.calls(), 1, "browser_done must not trigger forced synthesis");
}
```

Use the existing mock model, browser executor, no-op capability executor, plan, policy, compactor, and event sink types already defined in the `agent_loop.rs` test module. When a helper constructor is missing, add a local helper in that same test module:

```rust
fn test_usage_context(call_id: &str) -> local_first_inference_usage::UsageContext {
    local_first_inference_usage::UsageContext::new(
        call_id.to_string(),
        local_first_inference_usage::InferencePurpose::Chat,
        "test",
    )
}
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cargo test -p local-first-engine browser_done_tool_terminates_without_forced_synthesis
```

Expected: failure because `browser_done` is not registered as a browser granular tool and the loop has no terminal handling for it.

- [ ] **Step 3: Register `browser_done` as a browser granular tool**

In `crates/engine/src/browser.rs`, extend the browser tool name matcher:

```rust
pub fn is_browser_granular_tool(name: &str) -> bool {
    matches!(
        resolve_browser_chat_tool_name(name),
        Some(
            "browser_navigate"
                | "browser_snapshot"
                | "browser_act"
                | "browser_screenshot"
                | "browser_tabs"
                | "browser_dialog"
                | "browser_done"
        )
    )
}
```

Update the existing browser-tool unit test to assert:

```rust
assert!(is_browser_granular_tool("browser_done"));
```

- [ ] **Step 4: Add terminal effect from browser executor result**

For the browser seam, keep the trait return as `String`; detect `browser_done` in the dispatch branch:

```rust
if name == "browser_done" && !result.trim().is_empty() {
    memory_answer = result.trim().to_string();
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
```

Keep this branch inside the existing tool-call handling after the tool result is recorded so traces remain coherent.

- [ ] **Step 5: Run targeted engine tests**

Run:

```bash
cargo test -p local-first-engine browser_done_tool_terminates_without_forced_synthesis
cargo test -p local-first-engine agent_loop::tests::forced_tool_applies_only_to_round_zero_then_terminates_on_model_text
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add crates/engine/src/browser.rs crates/engine/src/agent_loop.rs
git commit -m "feat(browser): terminate subturn with browser_done"
```

## Task 3: Observation Modes in the Browser Sidecar

**Files:**
- Modify: `runtimes/browser-automation/src/browser/snapshot.ts`
- Modify: `runtimes/browser-automation/src/browser/session_manager.ts`
- Modify: `runtimes/browser-automation/tests/browser_fixture.test.ts`

- [ ] **Step 1: Write failing observation-mode tests**

Add to `runtimes/browser-automation/tests/browser_fixture.test.ts`:

```ts
it("returns bounded interact, delta and extract observations", async () => {
  await manager.start();
  await manager.open({ url: `${baseUrl}/train`, label: "train" });

  const interact = await manager.snapshot({
    targetId: "train",
    observationMode: "interact",
  } as never);
  expect(interact.observationMode).toBe("interact");
  expect(interact.stats.chars).toBeLessThanOrEqual(6_200);
  expect(interact.snapshot).toContain("textbox \"Da\"");

  const from = interact.refs.find((ref) => ref.name === "Da");
  const typed = await manager.act({
    targetId: "train",
    kind: "type",
    ref: from!.ref,
    text: "Nap",
    observationMode: "delta",
    generation: interact.generation,
  } as never);
  expect(typed.observationMode).toBe("delta");
  expect(typed.stats!.chars).toBeLessThanOrEqual(8_200);
  expect(JSON.stringify(typed)).toContain("Napoli Centrale");

  const extract = await manager.snapshot({
    targetId: "train",
    observationMode: "extract",
    maxChars: 16_000,
  } as never);
  expect(extract.observationMode).toBe("extract");
  expect(extract.stats.chars).toBeLessThanOrEqual(16_200);
});
```

- [ ] **Step 2: Run the sidecar test and verify RED**

Run:

```bash
npm --prefix runtimes/browser-automation test -- browser_fixture.test.ts -t "bounded interact, delta and extract"
```

Expected: failure because `observationMode` and `generation` are not returned or accepted.

- [ ] **Step 3: Add observation mode types and ceilings**

In `snapshot.ts`, add:

```ts
export type BrowserObservationMode = "interact" | "delta" | "extract";

const OBSERVATION_LIMITS: Record<BrowserObservationMode, number> = {
  interact: 6_000,
  delta: 8_000,
  extract: 16_000,
};
```

Extend `BrowserSnapshot`:

```ts
generation: number;
fingerprint: string;
observationMode: BrowserObservationMode;
```

Extend `BrowserSnapshotOptions`:

```ts
observationMode?: BrowserObservationMode;
previousSnapshot?: string;
generation?: number;
```

Add helpers:

```ts
function observationMode(options?: BrowserSnapshotOptions): BrowserObservationMode {
  const mode = options?.observationMode;
  return mode === "delta" || mode === "extract" || mode === "interact" ? mode : "interact";
}

function limitForObservation(mode: BrowserObservationMode, maxChars?: number): number {
  const cap = OBSERVATION_LIMITS[mode];
  if (typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars > 0) {
    return Math.min(Math.floor(maxChars), cap);
  }
  return cap;
}

function fingerprintSnapshot(snapshot: string): string {
  let hash = 5381;
  for (let i = 0; i < snapshot.length; i += 1) {
    hash = ((hash << 5) + hash) ^ snapshot.charCodeAt(i);
  }
  return `snap_${(hash >>> 0).toString(16)}`;
}

function structuralDelta(previous: string | undefined, current: string): string {
  if (!previous) return current;
  const oldLines = new Set(previous.split("\n").map((line) => line.trim()).filter(Boolean));
  const added = current
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !oldLines.has(line));
  return added.length ? added.join("\n") : "[no structural changes detected]";
}
```

Apply `observationMode`, `limitForObservation`, and `structuralDelta` in `createAiSnapshot` after `rawSnapshot` is built. Keep legacy snapshot fallback compatible by returning `generation: 0`, `fingerprint`, and `observationMode`.

- [ ] **Step 4: Track page generation and previous snapshot**

In `session_manager.ts`, extend page state:

```ts
generation: number;
lastSnapshot?: string;
lastSnapshotFingerprint?: string;
```

Initialize those fields when creating page state. In `snapshot`, pass `previousSnapshot: state.lastSnapshot` to `createSnapshot`, then increment and store:

```ts
state.generation += 1;
const snapshot = await createSnapshot(state.page, params.targetId, {
  ...params,
  previousSnapshot: state.lastSnapshot,
  generation: state.generation,
});
state.refs = snapshot.refLocators;
state.lastSnapshot = snapshot.snapshot;
state.lastSnapshotFingerprint = snapshot.fingerprint;
```

Return `generation`, `fingerprint`, and `observationMode`.

- [ ] **Step 5: Pass observation options after actions**

In `BrowserActionResult`, add:

```ts
generation?: number;
fingerprint?: string;
observationMode?: BrowserObservationMode;
```

In `act`, when `shouldSnapshotAfterAction(action)` is true, call:

```ts
state.generation += 1;
const snapshot = await createSnapshot(state.page, action.targetId, {
  ...(action as Record<string, unknown>),
  previousSnapshot: state.lastSnapshot,
  generation: state.generation,
});
state.lastSnapshot = snapshot.snapshot;
state.lastSnapshotFingerprint = snapshot.fingerprint;
```

- [ ] **Step 6: Run sidecar tests**

Run:

```bash
npm --prefix runtimes/browser-automation test -- browser_fixture.test.ts -t "bounded interact, delta and extract"
npm --prefix runtimes/browser-automation test -- browser_fixture.test.ts -t "drives a complete train-search fixture"
npm --prefix runtimes/browser-automation typecheck
```

Expected: targeted observation and train fixture tests pass; typecheck passes.

- [ ] **Step 7: Commit**

```bash
git add runtimes/browser-automation/src/browser/snapshot.ts runtimes/browser-automation/src/browser/session_manager.ts runtimes/browser-automation/tests/browser_fixture.test.ts
git commit -m "feat(browser): add bounded observation modes"
```

## Task 4: Bounded Action Bundles

**Files:**
- Modify: `runtimes/browser-automation/src/browser/actions.ts`
- Modify: `runtimes/browser-automation/src/browser/session_manager.ts`
- Modify: `runtimes/browser-automation/tests/browser_fixture.test.ts`

- [ ] **Step 1: Write failing bundle contract tests**

Add to `browser_fixture.test.ts`:

```ts
it("executes a chat bundle of four actions and rejects nested or oversized bundles", async () => {
  await manager.start();
  await manager.open({ url: `${baseUrl}/train`, label: "train" });
  const snapshot = await manager.snapshot({ targetId: "train", observationMode: "interact" } as never);
  const accept = snapshot.refs.find((ref) => ref.name === "Accetta tutto");
  const from = snapshot.refs.find((ref) => ref.name === "Da");

  const accepted = accept
    ? await manager.act({
        targetId: "train",
        kind: "batch",
        chatBundle: true,
        generation: snapshot.generation,
        actions: [{ targetId: "train", kind: "click", ref: accept.ref }],
        observationMode: "delta",
      } as never)
    : snapshot;
  expect(accepted).toMatchObject({ ok: true });

  const afterAccept = await manager.snapshot({ targetId: "train", observationMode: "interact" } as never);
  const fromRef = afterAccept.refs.find((ref) => ref.name === "Da") ?? from;
  const bundle = await manager.act({
    targetId: "train",
    kind: "batch",
    chatBundle: true,
    generation: afterAccept.generation,
    actions: [
      { targetId: "train", kind: "type", ref: fromRef!.ref, text: "Nap" },
      { targetId: "train", kind: "wait", text: "Napoli Centrale", timeoutMs: 2_000 },
    ],
    observationMode: "delta",
  } as never);
  expect(bundle.batchResults).toHaveLength(2);
  expect(bundle.completedActions).toBe(2);
  expect(JSON.stringify(bundle)).toContain("Napoli Centrale");

  await expect(
    manager.act({
      targetId: "train",
      kind: "batch",
      chatBundle: true,
      generation: bundle.generation,
      actions: [
        { targetId: "train", kind: "wait", text: "x" },
        { targetId: "train", kind: "wait", text: "x" },
        { targetId: "train", kind: "wait", text: "x" },
        { targetId: "train", kind: "wait", text: "x" },
        { targetId: "train", kind: "wait", text: "x" },
      ],
    } as never),
  ).rejects.toMatchObject({ code: "BROWSER_CHAT_BUNDLE_TOO_LARGE" });

  await expect(
    manager.act({
      targetId: "train",
      kind: "batch",
      chatBundle: true,
      generation: bundle.generation,
      actions: [{ targetId: "train", kind: "batch", actions: [] }],
    } as never),
  ).rejects.toMatchObject({ code: "BROWSER_NESTED_BATCH_REJECTED" });
});

it("rejects a chat bundle from a stale observation generation", async () => {
  await manager.start();
  await manager.open({ url: baseUrl, label: "booking" });
  const first = await manager.snapshot({ targetId: "booking", observationMode: "interact" } as never);
  await manager.snapshot({ targetId: "booking", observationMode: "interact" } as never);
  const name = first.refs.find((ref) => ref.name === "Name");

  await expect(
    manager.act({
      targetId: "booking",
      kind: "batch",
      chatBundle: true,
      generation: first.generation,
      actions: [{ targetId: "booking", kind: "type", ref: name!.ref, text: "Ada" }],
    } as never),
  ).rejects.toMatchObject({ code: "BROWSER_STALE_GENERATION" });
});
```

- [ ] **Step 2: Run bundle tests and verify RED**

Run:

```bash
npm --prefix runtimes/browser-automation test -- browser_fixture.test.ts -t "chat bundle"
npm --prefix runtimes/browser-automation test -- browser_fixture.test.ts -t "stale observation generation"
```

Expected: failure because `chatBundle`, `generation`, `completedActions`, and the new error codes are not implemented.

- [ ] **Step 3: Enforce chat bundle validation**

In `actions.ts`, add:

```ts
const MAX_CHAT_BUNDLE_ACTIONS = 4;

function isChatBundle(action: BrowserActRequest): boolean {
  return Boolean((action as Record<string, unknown>).chatBundle ?? (action as Record<string, unknown>).chat_bundle);
}

function assertChatBundle(action: BrowserActRequest): void {
  if (action.kind !== "batch" || !isChatBundle(action)) return;
  if (action.actions.length > MAX_CHAT_BUNDLE_ACTIONS) {
    throw new BrowserAutomationError({
      code: "BROWSER_CHAT_BUNDLE_TOO_LARGE",
      message: "chat browser bundles may contain at most 4 actions",
      retryable: false,
    });
  }
  if (action.actions.some((nested) => nested.kind === "batch")) {
    throw new BrowserAutomationError({
      code: "BROWSER_NESTED_BATCH_REJECTED",
      message: "chat browser bundles must be flat",
      retryable: false,
    });
  }
}
```

Call `assertChatBundle(action)` at the start of `executeActionUnchecked`.

- [ ] **Step 4: Return partial bundle metadata**

In the existing `case "batch"` branch, add `completedActions` and `unexecutedActions`:

```ts
let completedActions = 0;
const unexecutedActions: BrowserActRequest[] = [];
for (const [index, nested] of action.actions.entries()) {
  try {
    const nestedResult = await executeActionUnchecked(page, refs, { ...nested, targetId: nested.targetId ?? action.targetId }, depth + 1);
    batchResults.push(nestedResult);
    completedActions += 1;
  } catch (error) {
    batchResults.push({ ok: false, error: errorMessage(error) });
    unexecutedActions.push(...action.actions.slice(index + 1));
    if (action.stopOnError ?? true) break;
  }
}
return { ok: true, url: page.url(), batchResults, completedActions, unexecutedActions };
```

Extend `BrowserActionResult` with:

```ts
completedActions?: number;
unexecutedActions?: BrowserActRequest[];
```

- [ ] **Step 5: Validate generation in `session_manager.ts`**

Before `executeAction`, add:

```ts
const requestedGeneration = Number((action as Record<string, unknown>).generation);
if (Number.isFinite(requestedGeneration) && requestedGeneration > 0 && requestedGeneration !== state.generation) {
  throw new BrowserAutomationError({
    code: "BROWSER_STALE_GENERATION",
    message: `action generation ${requestedGeneration} does not match current page generation ${state.generation}`,
    retryable: true,
  });
}
```

- [ ] **Step 6: Run sidecar bundle tests**

Run:

```bash
npm --prefix runtimes/browser-automation test -- browser_fixture.test.ts -t "chat bundle"
npm --prefix runtimes/browser-automation test -- browser_fixture.test.ts -t "stale observation generation"
npm --prefix runtimes/browser-automation typecheck
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add runtimes/browser-automation/src/browser/actions.ts runtimes/browser-automation/src/browser/session_manager.ts runtimes/browser-automation/tests/browser_fixture.test.ts
git commit -m "feat(browser): enforce bounded chat action bundles"
```

## Task 5: Gateway Browser Request, Schemas, and Safety

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/browser-automation/tests/policy.rs`

- [ ] **Step 1: Write failing gateway schema tests**

Add to the gateway test module in `crates/desktop-gateway/src/main.rs`:

```rust
#[test]
fn browse_schema_accepts_result_contract_and_hints() {
    let schema = super::browse_tool_schema();
    let params = schema.pointer("/function/parameters/properties").unwrap();
    assert!(params.get("goal").is_some());
    assert!(params.get("hints").is_some());
    assert!(params.get("result_contract").is_some());
}

#[test]
fn browser_act_schema_accepts_flat_action_bundles() {
    let schema = super::browser_act_tool_schema();
    let props = schema.pointer("/function/parameters/properties").unwrap();
    assert!(props.get("actions").is_some());
    assert!(schema.to_string().contains("at most four"));
}

#[test]
fn browser_done_schema_is_structured_terminal() {
    let schema = super::browser_done_tool_schema();
    assert_eq!(
        schema.pointer("/function/name").and_then(serde_json::Value::as_str),
        Some("browser_done")
    );
    assert!(schema.to_string().contains("completed"));
    assert!(schema.to_string().contains("fields_missing"));
}
```

- [ ] **Step 2: Write failing payment bundle policy test**

Add to `crates/browser-automation/tests/policy.rs`:

```rust
#[test]
fn policy_checks_nested_payment_actions_inside_batch() {
    let snapshot = "- button \"Paga ora\" [ref=e9]\n- button \"Continua\" [ref=e2]";
    let action = serde_json::json!({
        "kind": "batch",
        "actions": [
            {"kind": "click", "ref": "e2"},
            {"kind": "click", "ref": "e9"}
        ]
    });

    let reason = local_first_browser_automation::BrowserPolicy::default()
        .classify_tool_call(BrowserMethod::Act, &action);

    assert!(matches!(reason, BrowserActionDecision::NeedsApproval { .. }));
    assert!(local_first_browser_automation::policy::contains_final_payment_action(&action, snapshot));
}
```

If `contains_final_payment_action` is not public, add it as a public helper in the policy module and keep the existing `classify_tool_call` behavior unchanged.

- [ ] **Step 3: Run tests and verify RED**

Run:

```bash
cargo test -p desktop-gateway browse_schema_accepts_result_contract_and_hints
cargo test -p desktop-gateway browser_act_schema_accepts_flat_action_bundles
cargo test -p desktop-gateway browser_done_schema_is_structured_terminal
cargo test -p local-first-browser-automation policy_checks_nested_payment_actions_inside_batch
```

Expected: schema tests fail because new schema fields do not exist; policy test fails until nested payment detection is public and complete.

- [ ] **Step 4: Extend `browse_tool_schema`**

In `crates/desktop-gateway/src/main.rs`, add `result_contract` to the `browse` parameters:

```rust
"result_contract": {
    "type": "object",
    "description": "Structured result requirements derived semantically from the user's request. The model chooses these fields; the gateway validates shape and bounds only.",
    "properties": {
        "kind": { "type": "string", "enum": ["list", "fact"] },
        "minimum_items": { "type": "integer", "minimum": 1, "maximum": 10 },
        "fields": {
            "type": "array",
            "maxItems": 12,
            "items": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "maxLength": 80 },
                    "required": { "type": "boolean" }
                },
                "required": ["name", "required"]
            }
        },
        "boundary": { "type": "string", "maxLength": 400 }
    }
}
```

Update the description so it says one delegated `browse` call should be enough for a concrete goal and a failed result must be reported rather than blindly retried.

- [ ] **Step 5: Add `browser_done_tool_schema`**

Add:

```rust
fn browser_done_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "browser_done",
            "description": "Terminate the browser sub-turn with grounded structured evidence. Use this as soon as the result contract is satisfied, partial, blocked, unavailable, or timed out. Do not write a normal prose answer instead.",
            "parameters": {
                "type": "object",
                "properties": {
                    "status": { "type": "string", "enum": ["completed","partial","blocked","unavailable","timeout"] },
                    "answer": { "type": "string" },
                    "items": { "type": "array", "items": { "type": "object" } },
                    "fields_missing": { "type": "array", "items": { "type": "string" } },
                    "sources": { "type": "array", "items": { "type": "string" } },
                    "evidence": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["status", "answer"]
            }
        }
    })
}
```

Add it to `GatewayBrowseExecutor::browse` sub-turn tools:

```rust
browser_done_tool_schema(),
```

- [ ] **Step 6: Extend `browser_act_tool_schema` for flat bundles**

Keep the existing flat single-action fields and add:

```rust
"generation": { "type": "integer", "description": "Observation generation used to choose refs." },
"observationMode": { "type": "string", "enum": ["interact","delta","extract"], "description": "Observation mode to return after the action. Use delta after action bundles and extract when collecting final results." },
"actions": {
    "type": "array",
    "maxItems": 4,
    "description": "Flat bundle of at most four safe actions selected from the current observation. No nested batch. Payment actions are not allowed here.",
    "items": { "type": "object" }
}
```

Update the description to say the model may perform one action or a flat bundle of at most four actions from the current observation generation.

- [ ] **Step 7: Add parse helpers for browse request**

Near `build_browse_goal`, add:

```rust
#[derive(Debug, Clone)]
struct ParsedBrowseRequest {
    goal: String,
    hint_url: Option<String>,
    contract: Option<local_first_engine::browse::BrowseResultContract>,
}

fn parse_browse_request(args_raw: &str) -> ParsedBrowseRequest {
    let value: serde_json::Value = serde_json::from_str(args_raw).unwrap_or(serde_json::Value::Null);
    let goal = value.get("goal").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let hint_url = value
        .pointer("/hints/url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| v.starts_with("https://") || v.starts_with("http://"))
        .map(str::to_string);
    let contract = value
        .get("result_contract")
        .cloned()
        .and_then(|v| serde_json::from_value::<local_first_engine::browse::BrowseResultContract>(v).ok());
    ParsedBrowseRequest { goal, hint_url, contract }
}
```

Keep `build_browse_goal` for legacy tests by making it call `parse_browse_request` and append readable hints.

- [ ] **Step 8: Normalize flat bundle args before sidecar call**

In the `browser_act` branch of `execute_browser_tool`, before safety checks, convert `actions` into sidecar `kind:"batch"`:

```rust
if action.get("actions").and_then(serde_json::Value::as_array).is_some() {
    if let Some(obj) = action.as_object_mut() {
        obj.insert("kind".to_string(), serde_json::Value::String("batch".to_string()));
        obj.insert("chatBundle".to_string(), serde_json::Value::Bool(true));
    }
}
```

For every nested action, inject `target_id`, reject nested `batch`, reject more than four actions, and call the existing payment safety helper for each nested action. If a nested action is a final payment action, return:

```rust
"Payment actions cannot run inside a browser action bundle. Ask for the Payment Approval Card and execute the final payment as a standalone approved action."
```

- [ ] **Step 9: Run gateway and policy tests**

Run:

```bash
cargo test -p desktop-gateway browse_schema_accepts_result_contract_and_hints
cargo test -p desktop-gateway browser_act_schema_accepts_flat_action_bundles
cargo test -p desktop-gateway browser_done_schema_is_structured_terminal
cargo test -p local-first-browser-automation policy_checks_nested_payment_actions_inside_batch
```

Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add crates/desktop-gateway/src/main.rs crates/browser-automation/tests/policy.rs crates/browser-automation/src/policy.rs
git commit -m "feat(browser): expose bounded browse schemas"
```

## Task 6: Gateway Browse Runtime Flow

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/engine/src/browse.rs`

- [ ] **Step 1: Write failing gateway flow tests**

Add pure tests in `crates/desktop-gateway/src/main.rs`:

```rust
#[test]
fn parse_browse_request_keeps_model_contract_without_keyword_inference() {
    let parsed = super::parse_browse_request(r#"{
        "goal":"Search the requested journey",
        "hints":{"url":"https://www.trenitalia.com/it.html"},
        "result_contract":{
            "kind":"list",
            "minimum_items":3,
            "fields":[
                {"name":"departure","required":true},
                {"name":"arrival","required":true},
                {"name":"duration","required":true},
                {"name":"price","required":false}
            ],
            "boundary":"Stop before booking or payment"
        }
    }"#);

    assert_eq!(parsed.goal, "Search the requested journey");
    assert_eq!(parsed.hint_url.as_deref(), Some("https://www.trenitalia.com/it.html"));
    let contract = parsed.contract.unwrap();
    assert_eq!(contract.minimum_items, Some(3));
    assert_eq!(contract.fields[0].name, "departure");
}

#[test]
fn built_in_browse_is_loaded_without_find_capability() {
    let base_tools = super::initial_manager_tool_schemas_for_test(false, false);
    let names = base_tools
        .iter()
        .filter_map(|schema| schema.pointer("/function/name").and_then(serde_json::Value::as_str))
        .collect::<Vec<_>>();

    assert!(names.contains(&"browse"));
    assert!(!names.iter().position(|name| *name == "browse").is_none());
}
```

Extract the base tool assembly currently around `base_tools = vec![browse_tool_schema()]` into this pure helper and use it in production and tests:

```rust
fn initial_manager_tool_schemas_for_test(read_only: bool, contact_only: bool) -> Vec<serde_json::Value> {
    let mut base_tools = vec![browse_tool_schema()];
    if !contact_only {
        base_tools.push(use_computer_tool_schema());
    }
    if !read_only {
        base_tools.push(update_plan_tool_schema());
    }
    base_tools
}
```

When wiring production, preserve the existing surrounding additions to `base_tools`; this helper exists to assert that `browse` starts loaded before `find_capability`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
cargo test -p desktop-gateway parse_browse_request_keeps_model_contract_without_keyword_inference
cargo test -p desktop-gateway built_in_browse_is_loaded_without_find_capability
```

Expected: first test passes if Task 5 helper exists; second fails until base tool assembly is extractable and testable.

- [ ] **Step 3: Pre-navigate trusted hint URL before first browser inference**

In `GatewayBrowseExecutor::browse`, replace the string-only `goal: &str` signature with:

```rust
async fn browse(&self, request: ParsedBrowseRequest) -> local_first_engine::BrowseResult
```

After constructing `browser_executor`, before `run_turn`, if `request.hint_url` exists:

```rust
let nav_args = serde_json::json!({
    "url": hint_url,
    "target": "chat_0"
})
.to_string();
let _ = browser_executor
    .execute_browser("browser_navigate", &nav_args, "pre_nav", &mut ls)
    .await;
```

Then seed messages with the semantic goal plus contract:

```rust
let user_goal = match &request.contract {
    Some(contract) => format!(
        "{}\n\nResult contract:\n{}",
        request.goal,
        serde_json::to_string_pretty(contract).unwrap_or_default()
    ),
    None => request.goal.clone(),
};
ls.messages = local_first_engine::browse::seed_browse_messages(
    &browse_subagent_system_prompt(),
    &user_goal,
);
```

- [ ] **Step 4: Parse and pass `browser_done` payload**

In `GatewayBrowserExecutor::execute_browser`, handle `name == "browser_done"` before spawning the sidecar:

```rust
if name == "browser_done" {
    let payload = serde_json::from_str::<local_first_engine::browse::BrowserDonePayload>(args_raw)
        .unwrap_or_else(|_| local_first_engine::browse::BrowserDonePayload {
            status: local_first_engine::browse::BrowserDoneStatus::Partial,
            answer: "Browser stopped with an invalid terminal payload.".to_string(),
            ..Default::default()
        });
    let result = local_first_engine::browse::validate_browser_done_payload(payload, self.result_contract.as_ref());
    return local_first_engine::browse::browse_result_for_manager(&result);
}
```

Add `result_contract: Option<BrowseResultContract>` to `GatewayBrowserExecutor`.

- [ ] **Step 5: Avoid routine forced synthesis for browser sub-turns**

When constructing the browser sub-turn `TurnConfig`, set:

```rust
hard_round_ceiling: 5,
max_rounds: 5,
browser_max_rounds: 5,
browser_budget: local_first_engine::config::BrowserBudget {
    max_elapsed_ms: 55_000,
    max_failed_navigations: 3,
    max_no_progress: 2,
},
```

If the sub-turn returns without `browser_done`, create a structured timeout/partial result using the last snapshot:

```rust
let fallback_payload = local_first_engine::browse::BrowserDonePayload {
    status: local_first_engine::browse::BrowserDoneStatus::Timeout,
    answer: browser_executor.last_snapshot.chars().take(2000).collect(),
    items: vec![],
    fields_missing: vec!["browser_done".into()],
    sources: outcome.browse_sources.clone(),
    evidence: vec!["Browser sub-turn ended before browser_done.".into()],
};
local_first_engine::browse::validate_browser_done_payload(
    fallback_payload,
    request.contract.as_ref(),
)
```

- [ ] **Step 6: Prevent blind second browse in one manager turn**

Reuse `earlier_browse_call_in_current_round` and add this field to `crates/engine/src/loop_state.rs`:

```rust
pub browse_calls_completed: usize,
```

Initialize it to `0` in `LoopState::new`. In `GatewayCapabilityExecutor::execute_tool`, increment `state.browse_calls_completed` after a delegated `browse` returns. When `name == "browse"` and `state.browse_calls_completed > 0`, return:

```rust
local_first_engine::ToolOutcome {
    result: "found: false\nnote: A browse result was already returned in this turn. Use that evidence; ask the user before retrying.".to_string(),
    effects: local_first_engine::ToolEffects {
        outcome_hint: Some(local_first_engine::ToolOutcomeHint::NoProgress),
        ..Default::default()
    },
}
```

Do not infer from user keywords; this is a structural per-turn retry guard.

- [ ] **Step 7: Run gateway flow tests**

Run:

```bash
cargo test -p desktop-gateway parse_browse_request_keeps_model_contract_without_keyword_inference
cargo test -p desktop-gateway built_in_browse_is_loaded_without_find_capability
cargo test -p local-first-engine browser_done_tool_terminates_without_forced_synthesis
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add crates/desktop-gateway/src/main.rs crates/engine/src/browse.rs crates/engine/src/config.rs crates/engine/src/loop_state.rs
git commit -m "feat(browser): run observe actions extract browse flow"
```

## Task 7: Train Fixture End-to-End Contract

**Files:**
- Modify: `runtimes/browser-automation/tests/fixtures/train.html`
- Modify: `runtimes/browser-automation/tests/browser_fixture.test.ts`

- [ ] **Step 1: Extend the train fixture to model the acceptance flow**

Update `train.html` so the submitted result area renders at least three cards after a delay:

```html
<article class="result-card" aria-label="FR 9512">
  <h2>FR 9512</h2>
  <p>Departure 09:05 Napoli Centrale</p>
  <p>Arrival 13:40 Milano Centrale</p>
  <p>Duration 4h 35m</p>
  <p>Price €49.90</p>
</article>
<article class="result-card" aria-label="Intercity 590">
  <h2>Intercity 590</h2>
  <p>Departure 09:31 Napoli Centrale</p>
  <p>Arrival 17:10 Milano Centrale</p>
  <p>Duration 7h 39m</p>
  <p>Price €39.90</p>
</article>
<article class="result-card" aria-label="Italo 9920">
  <h2>Italo 9920</h2>
  <p>Departure 10:30 Napoli Centrale</p>
  <p>Arrival 15:05 Milano Centrale</p>
  <p>Duration 4h 35m</p>
  <p>Price €54.90</p>
</article>
```

Keep the delay to prove `wait` and `extract` are required.

- [ ] **Step 2: Write failing single-bundle fixture test**

Add to `browser_fixture.test.ts`:

```ts
it("fills train search with bounded bundles and extracts three result cards", async () => {
  await manager.start();
  await manager.open({ url: `${baseUrl}/train`, label: "train" });
  const first = await manager.snapshot({ targetId: "train", observationMode: "interact" } as never);
  const accept = first.refs.find((ref) => ref.name === "Accetta tutto");
  if (accept) {
    await manager.act({
      targetId: "train",
      kind: "batch",
      chatBundle: true,
      generation: first.generation,
      actions: [{ targetId: "train", kind: "click", ref: accept.ref }],
      observationMode: "delta",
    } as never);
  }

  const form = await manager.snapshot({ targetId: "train", observationMode: "interact" } as never);
  const from = form.refs.find((ref) => ref.name === "Da");
  const to = form.refs.find((ref) => ref.name === "A");
  const typed = await manager.act({
    targetId: "train",
    kind: "batch",
    chatBundle: true,
    generation: form.generation,
    actions: [
      { targetId: "train", kind: "type", ref: from!.ref, text: "Nap" },
      { targetId: "train", kind: "type", ref: to!.ref, text: "Mil" },
    ],
    observationMode: "delta",
  } as never);
  expect(typed.completedActions).toBe(2);

  const ready = await manager.snapshot({ targetId: "train", observationMode: "interact" } as never);
  const date = ready.refs.find((ref) => ref.name === "Scegli data");
  const search = ready.refs.find((ref) => ref.name === "Cerca");
  await manager.act({
    targetId: "train",
    kind: "batch",
    chatBundle: true,
    generation: ready.generation,
    actions: [
      { targetId: "train", kind: "click", ref: date!.ref },
      { targetId: "train", kind: "wait", text: "10 giugno 2026", timeoutMs: 2_000 },
      { targetId: "train", kind: "click", ref: search!.ref },
      { targetId: "train", kind: "wait", text: "FR 9512", timeoutMs: 3_000 },
    ],
    observationMode: "extract",
  } as never);

  const extract = await manager.snapshot({ targetId: "train", observationMode: "extract" } as never);
  const text = extract.snapshot;
  expect(text).toContain("FR 9512");
  expect(text).toContain("Intercity 590");
  expect(text).toContain("Italo 9920");
  expect(text).toContain("€49.90");
  expect(text).toContain("€39.90");
  expect(text).toContain("€54.90");
});
```

- [ ] **Step 3: Run fixture test and verify RED or GREEN**

Run:

```bash
npm --prefix runtimes/browser-automation test -- browser_fixture.test.ts -t "bounded bundles and extracts three result cards"
```

Expected before fixture update: RED because the fixture lacks the exact three-card contract. After fixture and previous tasks: GREEN.

- [ ] **Step 4: Commit**

```bash
git add runtimes/browser-automation/tests/fixtures/train.html runtimes/browser-automation/tests/browser_fixture.test.ts
git commit -m "test(browser): cover bounded train search extraction"
```

## Task 8: Observability and Runtime Metrics

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/engine/src/execution_journal.rs` if event enum additions are cleaner there

- [ ] **Step 1: Write failing observability test**

Add a pure test in `crates/desktop-gateway/src/main.rs`:

```rust
#[test]
fn browser_event_summary_redacts_page_text_and_keeps_metrics() {
    let event = super::browser_protocol_event_summary(
        "child_123",
        "action_bundle",
        serde_json::json!({
            "observation_chars": 6120,
            "refs": 42,
            "action_kinds": ["type", "click"],
            "stop_reason": "completed",
            "raw_page_text": "Departure 09:05 secret@example.com"
        }),
    );

    assert!(event.contains("child_123"));
    assert!(event.contains("observation_chars=6120"));
    assert!(event.contains("action_kinds=type,click"));
    assert!(!event.contains("secret@example.com"));
    assert!(!event.contains("Departure 09:05"));
}
```

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
cargo test -p desktop-gateway browser_event_summary_redacts_page_text_and_keeps_metrics
```

Expected: failure because `browser_protocol_event_summary` does not exist.

- [ ] **Step 3: Add redacted browser protocol event summaries**

Add:

```rust
fn browser_protocol_event_summary(
    child_run_id: &str,
    boundary: &str,
    metrics: serde_json::Value,
) -> String {
    let observation_chars = metrics.get("observation_chars").and_then(serde_json::Value::as_u64).unwrap_or(0);
    let refs = metrics.get("refs").and_then(serde_json::Value::as_u64).unwrap_or(0);
    let stop_reason = metrics.get("stop_reason").and_then(serde_json::Value::as_str).unwrap_or("unknown");
    let action_kinds = metrics
        .get("action_kinds")
        .and_then(serde_json::Value::as_array)
        .map(|values| values.iter().filter_map(serde_json::Value::as_str).collect::<Vec<_>>().join(","))
        .unwrap_or_default();
    format!(
        "browser_protocol child_run_id={child_run_id} boundary={boundary} observation_chars={observation_chars} refs={refs} action_kinds={action_kinds} stop_reason={stop_reason}"
    )
}
```

Call this helper at these boundaries:

- manager `browse` request with contract fingerprint;
- trusted pre-navigation completion;
- each browser action/bundle completion;
- extraction completion;
- terminal `browser_done` or timeout fallback.

Use existing `execution_journal.record` or trace appenders; do not persist raw snapshot text or typed field values.

- [ ] **Step 4: Run observability test**

Run:

```bash
cargo test -p desktop-gateway browser_event_summary_redacts_page_text_and_keeps_metrics
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/main.rs crates/engine/src/execution_journal.rs
git commit -m "feat(browser): record bounded protocol metrics"
```

## Task 9: Full Automated Verification

**Files:**
- No new files unless failures expose missing targeted tests

- [ ] **Step 1: Run sidecar test suite**

Run:

```bash
npm --prefix runtimes/browser-automation test
npm --prefix runtimes/browser-automation typecheck
```

Expected: Vitest suite and TypeScript typecheck pass.

- [ ] **Step 2: Run Rust browser and engine suites**

Run:

```bash
cargo test -p local-first-engine browse::tests
cargo test -p local-first-engine agent_loop::tests
cargo test -p local-first-browser-automation
cargo test -p desktop-gateway browser_
```

Expected: all targeted browser/engine/gateway tests pass.

- [ ] **Step 3: Run formatting/checks**

Run:

```bash
cargo fmt --check
cargo clippy -p local-first-engine -p local-first-browser-automation -p desktop-gateway --tests -- -D warnings
git diff --check
```

Expected: no formatting, clippy, or whitespace failures.

- [ ] **Step 4: Commit verification fixes when files changed**

After Step 1-3, run `git status --short`. If files changed, commit them:

```bash
git add crates runtimes docs
git commit -m "test(browser): stabilize observe actions extract verification"
```

When `git status --short` prints nothing, do not create this commit.

## Task 10: Installed-App Live Gate

**Files:**
- Modify: `docs/architecture/browser.md`
- Add artifacts under `artifacts/qa/browser-observe-actions-extract/` only for redacted metrics and screenshots

- [ ] **Step 1: Document the live gate command and criteria**

In `docs/architecture/browser.md`, add:

```md
## Observe-Actions-Extract Live Gate

The browser protocol is accepted only after five consecutive installed-app Trenitalia searches:

- Napoli Centrale to Milano Centrale
- 12 August 2026
- one-way
- one adult
- stop before booking or payment

Every run must use one delegated browse call, return at least three visible options, include departure, arrival, duration, and visible price, emit one terminal chat event, and avoid booking or payment. Across five runs, median prompt-to-final latency must be below 60 seconds and no run may exceed 90 seconds.
```

- [ ] **Step 2: Build without replacing the user's installed app**

Run:

```bash
cd apps/desktop
npm run dist
```

Expected: a local build artifact exists and no installed app has been overwritten.

- [ ] **Step 3: Ask before installing over `/Applications/homun.app`**

Stop and request explicit approval before replacing the currently installed app. The user preference is that installed-runtime proof matters, but demo stability also matters; do not silently replace a working installed app.

- [ ] **Step 4: Run five installed-app live searches after approval**

For each run, record:

```text
run_id:
prompt_to_final_ms:
delegated_browse_calls:
terminal_chat_events:
result_count:
fields_present:
missing_fields:
booking_or_payment_crossed:
trace_path:
```

Expected per run:

```text
delegated_browse_calls=1
terminal_chat_events=1
result_count>=3
booking_or_payment_crossed=false
prompt_to_final_ms<=90000
```

- [ ] **Step 5: Aggregate live result**

Write a redacted summary to `artifacts/qa/browser-observe-actions-extract/live-gate-summary.md`:

```md
# Browser Observe-Actions-Extract Live Gate

Date: 2026-07-23
Installed app:
Branch:
Commit:

| Run | Latency ms | Browse calls | Terminal events | Results | Missing fields | Boundary |
| --- | ---: | ---: | ---: | ---: | --- | --- |
```

Acceptance requires median latency below 60,000 ms and maximum below 90,000 ms. If any run fails, record the exact failing criterion and do not claim the browser is fixed.

- [ ] **Step 6: Commit docs and redacted QA artifacts**

```bash
git add docs/architecture/browser.md artifacts/qa/browser-observe-actions-extract/live-gate-summary.md
git commit -m "docs(browser): record observe actions extract live gate"
```

## Self-Review

- Spec coverage: Tasks 1, 2, 5, and 6 cover the semantic `browse` request, result contract, `browser_done`, no routine forced synthesis, no blind second browse, and manager-visible structured result. Tasks 3, 4, and 7 cover bounded observations, flat bundles, generation validation, autocomplete-preserving action execution, and three-result extraction. Task 5 covers the payment boundary. Task 8 covers metrics and redaction. Task 10 covers installed-app acceptance.
- Placeholder scan: no task asks for unspecified error handling, unspecified tests, or future implementation without concrete code, commands, and expected results.
- Type consistency: `BrowserDoneStatus`, `BrowserDonePayload`, `BrowseResultContract`, `BrowseResultField`, `BrowserObservationMode`, `observationMode`, `generation`, and `chatBundle` are introduced before later tasks use them.
