# Model-Owned Semantic Decisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace deterministic natural-language intent and workflow routing with one model-produced, strictly validated semantic decision that governs objective persistence, tool exposure, steering, and authorized memory intent.

**Architecture:** Add a focused `semantic_decision` module containing the versioned schema, pure validator, safe fallback, and prompt construction. The gateway orchestrator role produces the decision once at turn start; the TaskStore persists it inside the existing Objective Contract JSON fields. Later routing, prompt construction, memory injection, and steering consume that persisted decision, while deterministic code continues to enforce permissions, effects, cancellation, and schemas.

**Tech Stack:** Rust, serde/serde_json, `local-first-inference` structured generation, SQLite TaskStore, Axum gateway, existing engine model client, Cargo tests, desktop browser E2E.

---

### Task 1: Add the canonical semantic decision types and validator

**Files:**
- Create: `crates/desktop-gateway/src/semantic_decision.rs`
- Modify: `crates/desktop-gateway/src/main.rs:1-40`
- Test: `crates/desktop-gateway/src/semantic_decision.rs`

- [ ] **Step 1: Write failing validator tests**

Add tests covering a valid read-only agent-loop decision, rejection of `read_only_analysis` plus
`make_document`, rejection of unknown capabilities, and fallback behavior without a model result.

```rust
#[test]
fn read_only_decision_rejects_effectful_workflow() {
    let decision = SemanticDecision::fixture_read_only()
        .with_route(ExecutionShape::Workflow, Some("make_document"));
    let registry = fixture_registry();
    assert_eq!(
        validate_decision(decision, &registry, None).unwrap_err().code,
        "effect_conflict"
    );
}

#[test]
fn new_turn_fallback_is_read_only_agent_loop() {
    let decision = safe_fallback(None, "model_unavailable");
    assert_eq!(decision.mode, ObjectiveMode::ReadOnlyAnalysis);
    assert_eq!(decision.execution_shape, ExecutionShape::AgentLoop);
    assert_eq!(decision.deliverable.kind, DeliverableKind::ChatReport);
}
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
cargo test -p local-first-desktop-gateway semantic_decision -- --nocapture
```

Expected: compilation failure because `semantic_decision` does not exist.

- [ ] **Step 3: Implement the schema and pure validator**

Define `SemanticDecision`, `ObjectiveRelationship`, `ExecutionShape`, `DeliverableKind`,
`DeliverableDecision`, `MemoryIntent`, `CapabilitySemanticEntry`, `ValidatedSemanticDecision`, and
`SemanticDecisionError`. Derive serde snake-case enums. Implement:

```rust
pub(crate) fn semantic_decision_schema() -> serde_json::Value;
pub(crate) fn parse_and_validate_decision(
    value: serde_json::Value,
    registry: &[CapabilitySemanticEntry],
    active: Option<&ObjectiveContractRecord>,
) -> Result<ValidatedSemanticDecision, SemanticDecisionError>;
pub(crate) fn safe_fallback(
    active: Option<&ObjectiveContractRecord>,
    reason: &str,
) -> ValidatedSemanticDecision;
```

Validation checks only schema facts, registered capability/effect compatibility, active scope
compatibility, and contradictions. It never inspects the original prompt.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Task 1 command. Expected: all `semantic_decision` tests pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add crates/desktop-gateway/src/semantic_decision.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(runtime): validate model-owned semantic decisions"
```

### Task 2: Generate the decision through the orchestrator model

**Files:**
- Modify: `crates/desktop-gateway/src/semantic_decision.rs`
- Modify: `crates/desktop-gateway/src/main.rs:44359-46220`
- Test: `crates/desktop-gateway/src/semantic_decision.rs`

- [ ] **Step 1: Write failing model-seam tests**

Introduce an injectable closure/trait whose test implementation returns structured JSON. Verify
that the request contains the latest message, active objective, bounded context, explicit routing
binding, and capabilities with effect classes. Verify malformed and contradictory outputs use the
safe fallback without any keyword classifier.

- [ ] **Step 2: Run focused tests and verify RED**

Run the Task 1 test command. Expected: missing resolver/model-seam APIs.

- [ ] **Step 3: Implement request construction and gateway resolution**

Add:

```rust
pub(crate) fn semantic_decision_prompt(input: &SemanticDecisionInput) -> String;
pub(crate) fn resolve_semantic_decision(
    state: &AppState,
    prompt: &str,
    active: Option<&ObjectiveContractRecord>,
    binding: Option<&RoutingBinding>,
) -> ValidatedSemanticDecision;
```

Use `router_for_role("orchestrator")`, `GenerateJsonRequest`, strict JSON Schema, temperature `0`,
bounded timeout, `InferencePurpose::IntentRouting`, and `repair: true`. Persist model/provider,
latency, fallback reason, and schema version in decision metadata. Do not retain unrestricted raw
prompt/model output in long-lived logs.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Task 1 test command. Expected: all pass.

- [ ] **Step 5: Commit Task 2**

```bash
git add crates/desktop-gateway/src/semantic_decision.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(runtime): resolve turn semantics with the model"
```

### Task 3: Persist the model decision as the Objective Contract

**Files:**
- Modify: `crates/desktop-gateway/src/turn_executor.rs:250-335`
- Modify: `crates/desktop-gateway/src/semantic_decision.rs`
- Test: `crates/desktop-gateway/src/turn_executor.rs` or `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Write failing objective persistence tests**

Test that a negated-write analysis decision persists `ReadOnlyAnalysis`, `chat_report`, forbidden
write effects, and semantic metadata. Test that `same_objective` preserves the active objective and
that `replacement` increments the contract revision.

- [ ] **Step 2: Run tests and verify RED**

```bash
cargo test -p local-first-desktop-gateway objective_contract_uses_semantic_decision -- --nocapture
```

Expected: persisted fields still come from `classify_objective_mode` and raw prompt defaults.

- [ ] **Step 3: Replace turn-start classification**

Load the existing Objective Contract and routing binding, resolve one semantic decision, and derive
the upsert arguments exclusively from it. Store the complete decision under
`scope_json.semantic_decision` and the deliverable under `completion_json.deliverable`. Preserve an
active contract for `same_objective`/`compatible_extension`; supersede for `new_objective` or
`replacement`; reject unconfirmed `scope_expansion`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Task 3 command and the TaskStore objective-contract tests.

- [ ] **Step 5: Commit Task 3**

```bash
git add crates/desktop-gateway/src/turn_executor.rs crates/desktop-gateway/src/semantic_decision.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(runtime): persist model-owned objective contracts"
```

### Task 4: Make routing consume the persisted semantic decision

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs:9060-9660`
- Modify: `crates/desktop-gateway/src/main.rs:27090-27210`
- Modify: `crates/desktop-gateway/src/semantic_decision.rs`
- Test: `crates/desktop-gateway/src/main.rs:61780-61900`

- [ ] **Step 1: Keep and extend the two failing regression tests**

Replace direct prompt classification assertions with fixture model decisions. Add tests proving
retrieval rank cannot choose a route, read-only analysis retains directory/read tools, explicit
`make_document` selects that workflow, and an exact user routing binding remains authoritative.

- [ ] **Step 2: Run tests and verify RED**

```bash
cargo test -p local-first-desktop-gateway 'tests::read_only_' -- --nocapture
```

Expected: current BM25 path selects `make_document` and fails.

- [ ] **Step 3: Replace prompt routing authority**

Implement `route_capability_from_semantic`. Delete `route_capability(prompt)`,
`atomic_pdf_operation_reason`, `is_plan_continuation_message`,
`prompt_requests_planning_or_research`, `prompt_forces_plan_precedence`, and semantic
plan-precedence demotion. Keep candidate search only for discovery. Route from the persisted
decision and validate tool pruning cannot remove required read/authorization tools. Preserve exact
user-selected bindings as structured state.

- [ ] **Step 4: Run routing and workflow tests and verify GREEN**

```bash
cargo test -p local-first-desktop-gateway route -- --nocapture
cargo test -p local-first-desktop-gateway read_only -- --nocapture
```

Expected: relevant tests pass; no test asserts BM25 as final route authority.

- [ ] **Step 5: Commit Task 4**

```bash
git add crates/desktop-gateway/src/main.rs crates/desktop-gateway/src/semantic_decision.rs
git commit -m "feat(agent): route from validated model semantics"
```

### Task 5: Replace steering heuristics with model comparison

**Files:**
- Modify: `crates/desktop-gateway/src/model_client.rs:40-110`
- Modify: `crates/desktop-gateway/src/semantic_decision.rs`
- Modify: `crates/desktop-gateway/src/main.rs:25680-25730`
- Test: `crates/desktop-gateway/src/main.rs:61840-61940`

- [ ] **Step 1: Write failing steering tests**

Test `same_objective`, `compatible_extension`, `replacement`, and `scope_expansion` decisions. Verify
new effects require confirmation and a strategy-only correction applies immediately.

- [ ] **Step 2: Run tests and verify RED**

```bash
cargo test -p local-first-desktop-gateway steering -- --nocapture
```

Expected: steering still calls the deleted keyword classifier or misclassifies negated mutations.

- [ ] **Step 3: Resolve steering semantically at round boundaries**

For each consumed steering record, call the semantic resolver with the active Objective Contract.
Convert the validated `relationship_to_active_objective` and effect delta to an apply/replace/confirm
control message. Persist accepted contract revisions atomically before the next model call. Remove
`classify_steering` and `SteeringDisposition`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Task 5 command. Expected: all steering tests pass and consumption remains exactly once.

- [ ] **Step 5: Commit Task 5**

```bash
git add crates/desktop-gateway/src/model_client.rs crates/desktop-gateway/src/semantic_decision.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(agent): interpret steering with the model"
```

### Task 6: Consume model-owned memory, confirmation, choice, and Vault intent

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs:3330-3705`
- Modify: `crates/desktop-gateway/src/main.rs:5900-6030`
- Modify: `crates/desktop-gateway/src/main.rs:14580-14665`
- Modify: `crates/desktop-gateway/src/main.rs:26880-27010`
- Modify: `crates/desktop-gateway/src/semantic_decision.rs`
- Test: `crates/desktop-gateway/src/main.rs:70235-70320`

- [ ] **Step 1: Write failing intent-consumer tests**

Test that memory injection uses `MemoryIntent` fields rather than prompt wording, terse replies are
interpreted from semantic state, a choice-card-only request does not import unrelated global loops,
and Vault reveal cards require `vault_value_requested` plus deterministic local policy.

- [ ] **Step 2: Run tests and verify RED**

```bash
cargo test -p local-first-desktop-gateway memory_intent -- --nocapture
cargo test -p local-first-desktop-gateway vault_intent -- --nocapture
```

Expected: prompt keyword functions still own the decisions.

- [ ] **Step 3: Replace prompt-language gates**

Read `MemoryIntent` from the persisted semantic decision when building the briefing and automatic
recall. Remove `is_confirmation_reply`, `is_standalone_choice_card_request`,
`should_inject_cross_thread_memory_for_prompt`, and `query_should_offer_vault_reveal` as semantic
authorities. Let the memory extraction model inspect all non-empty completed exchanges; deterministic
budgeting may batch or rate-limit calls but not infer salience.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Task 6 commands plus memory and Vault test subsets.

- [ ] **Step 5: Commit Task 6**

```bash
git add crates/desktop-gateway/src/main.rs crates/desktop-gateway/src/semantic_decision.rs
git commit -m "feat(memory): consume model-owned conversational intent"
```

### Task 7: Add observability and remove dead deterministic semantic code

**Files:**
- Modify: `crates/desktop-gateway/src/agent_journal.rs`
- Modify: `crates/desktop-gateway/src/working_ledger.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Test: `crates/desktop-gateway/src/agent_journal.rs`
- Test: `crates/desktop-gateway/src/working_ledger.rs`

- [ ] **Step 1: Write failing journal and ledger tests**

Require schema version, model/provider, confidence, execution shape, capability, fallback reason,
and validator rejection code in bounded output. Verify prompts, secrets, and raw model output are not
persisted.

- [ ] **Step 2: Run tests and verify RED**

```bash
cargo test -p local-first-desktop-gateway semantic_decision_journal -- --nocapture
cargo test -p local-first-desktop-gateway semantic_decision_ledger -- --nocapture
```

- [ ] **Step 3: Implement bounded projections and audit the tree**

Record the structured decision as an activity/journal event and project its compact summary into the
Working Ledger. Run:

```bash
rg -n -i 'heuristic|keyword|bm25.*route|route.*bm25|classify.*prompt|prompt.*classif' crates apps packages
```

For every result, classify it as semantic authority, candidate retrieval, technical parsing, or
safety enforcement. Delete remaining semantic authorities and document legitimate deterministic
uses beside the code when ambiguity remains.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run Task 7 commands and `git diff --check`.

- [ ] **Step 5: Commit Task 7**

```bash
git add crates/desktop-gateway/src/agent_journal.rs crates/desktop-gateway/src/working_ledger.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(runtime): expose semantic decision provenance"
```

### Task 8: Verify the exact authorization and analysis chat end to end

**Files:**
- Modify if required: `apps/desktop/src/components/ChatView.tsx`
- Modify if required: `apps/desktop/scripts/check-ui-contract.mjs`
- Test: isolated runtime fixture and browser-driven desktop chat

- [ ] **Step 1: Run focused and contract gates**

```bash
cargo test -p local-first-desktop-gateway semantic_decision -- --nocapture
cargo test -p local-first-desktop-gateway objective_contract -- --nocapture
cargo test -p local-first-desktop-gateway steering -- --nocapture
npm --prefix apps/desktop run check:ui-contract
git diff --check
```

Expected: all commands exit `0`; existing unrelated warnings are reported but not called failures.

- [ ] **Step 2: Create an isolated fixture and baseline**

Create a temporary home containing `Projects/AnalisiAutorizzazione` with nested source/config files.
Capture SHA-256, byte size, and mtime for every file and assert an expected-document path is absent.

- [ ] **Step 3: Run a fresh real chat through the desktop UI**

Submit the exact Italian request that searches the unauthorized `Projects` folder, grants access,
requests analysis only, and forbids documents/Markdown and file changes. Verify the UI requests the
exact folder grant and resumes automatically after approval without `continua`.

- [ ] **Step 4: Verify the outcome and no-write proof**

Require a substantive analysis covering nested files. Compare the post-run manifest with the
baseline and verify no unexpected path exists. Inspect SQLite/journal for `read_only_analysis`,
`chat_report`, `agent_loop`, the semantic model provenance, authorization, automatic continuation,
and completion.

- [ ] **Step 5: Run the proportional full suite**

```bash
cargo test -p local-first-desktop-gateway
npm --prefix apps/desktop test -- --run
git diff --check
git status --short
```

If a suite hangs or cannot be interrogated, exclude it explicitly from the success claim and report
the focused evidence instead.

- [ ] **Step 6: Commit final E2E fixes**

```bash
git add crates/desktop-gateway apps/desktop docs/superpowers
git commit -m "test(runtime): verify model-owned analysis flow"
```
