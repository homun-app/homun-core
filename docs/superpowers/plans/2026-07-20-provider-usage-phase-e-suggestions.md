# Provider Usage Phase E: Confirmed Model Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce explainable model suggestions that respect hard privacy/capability constraints and require explicit confirmation before any routing change.

**Architecture:** A pure Rust suggestion engine consumes provider capabilities, user policy and Phase A/B aggregate facts. It filters ineligible candidates before scoring, emits provenance-rich suggestions only above materiality/confidence thresholds, and stores metadata-only dismiss/apply actions. The UI confirms the exact scope, then uses existing model-selection or role-binding paths.

**Tech Stack:** Rust, serde, rusqlite, existing model registry/router, Axum, React 19, TypeScript, i18next, Node tests.

---

**Dependency:** Complete and verify [Phase D](./2026-07-20-provider-usage-phase-d-new-chat.md) first.

## File map

- Create `crates/desktop-gateway/src/usage_suggestions.rs`: eligibility, scoring, confidence, materiality and explanation facts.
- Modify `crates/desktop-gateway/src/usage_store.rs`: metadata-only suggestion actions and dismiss window.
- Modify `crates/desktop-gateway/src/main.rs`: suggestion and action endpoints.
- Modify `crates/desktop-gateway/src/lib.rs`: export suggestion domain for tests.
- Create `crates/desktop-gateway/tests/usage_suggestions.rs`: integration coverage.
- Modify `apps/desktop/src/lib/coreBridge.ts`: suggestion contracts/actions.
- Create `apps/desktop/src/components/UsageSuggestion.tsx`: compact card and confirmation dialog.
- Modify `apps/desktop/src/components/ChatUsageOverview.tsx`: render at most one suggestion.
- Modify `apps/desktop/src/components/ChatView.tsx`: apply one-turn model override.
- Modify `apps/desktop/src/components/UsageSettingsPane.tsx`: render full suggestions and preference action.
- Modify `apps/desktop/src/lib/usageViewModel.ts`, `.mjs`, `.test.mjs`: explanation/provenance formatting.
- Modify `apps/desktop/src/styles.css`: minimal suggestion and confirmation styling.
- Modify `apps/desktop/src/i18n/locales/{en,it,es,fr,de}.json`: suggestion copy.
- Modify `apps/desktop/scripts/check-ui-contract.mjs`: confirmation regressions.

### Task 1: Implement pure eligibility and scoring

**Files:**
- Create: `crates/desktop-gateway/src/usage_suggestions.rs`
- Modify: `crates/desktop-gateway/src/lib.rs`
- Test: `crates/desktop-gateway/src/usage_suggestions.rs`

- [ ] **Step 1: Write failing hard-constraint tests**

```rust
#[test]
fn cloud_candidate_cannot_compensate_for_local_only_policy() {
    let input = fixture().local_only().with_candidate(cloud_candidate().very_cheap());
    assert!(suggest(&input).is_none());
}

#[test]
fn missing_required_tools_vision_reasoning_or_context_excludes_candidate() {
    for candidate in [without_tools(), without_vision(), without_reasoning(), short_context()] {
        assert!(suggest(&fixture().requiring_all().with_candidate(candidate)).is_none());
    }
}

#[test]
fn material_cost_gain_with_equal_capability_produces_explained_suggestion() {
    let result = suggest(&fixture().with_current(costly()).with_candidate(equivalent().cost_ratio(0.60))).unwrap();
    assert_eq!(result.target_model, "candidate");
    assert!(result.facts.iter().any(|fact| fact.kind == SuggestionFactKind::Cost && fact.delta_percent == Some(-40)));
    assert_ne!(result.confidence, SuggestionConfidence::Low);
}
```

Define the fluent fixture builders in this test module with explicit defaults: local cloud policy allowed, all capabilities false until requested, a 32k context window, enabled candidates, known cost provenance and at least 20 successful samples. Each modifier changes only the field named by the test so eligibility failures stay attributable.

- [ ] **Step 2: Run suggestion tests for RED**

Run: `cargo test -p local-first-desktop-gateway usage_suggestions::tests --lib`

Expected: FAIL because the suggestion engine does not exist.

- [ ] **Step 3: Define closed input/output contracts**

```rust
pub struct SuggestionRequirements {
    pub cloud_allowed: bool,
    pub tools: bool,
    pub vision: bool,
    pub reasoning: bool,
    pub min_context_window: u32,
    pub minimum_tier: ModelTier,
}

pub struct CandidateFacts {
    pub provider_id: String,
    pub model_id: String,
    pub locality: Locality,
    pub enabled: bool,
    pub tools: bool,
    pub vision: bool,
    pub reasoning: bool,
    pub context_window: u32,
    pub tier: ModelTier,
    pub predicted_cost_microusd: Option<u64>,
    pub headroom_percent: Option<u8>,
    pub median_latency_ms: Option<u64>,
    pub success_rate_basis_points: Option<u16>,
    pub successful_sample_count: u64,
    pub cost_provenance: CostProvenance,
}

pub struct ModelSuggestion {
    pub suggestion_key: String,
    pub current_provider: String,
    pub current_model: String,
    pub target_provider: String,
    pub target_model: String,
    pub role: String,
    pub confidence: SuggestionConfidence,
    pub facts: Vec<SuggestionFact>,
    pub action_scopes: Vec<SuggestionActionScope>,
}
```

The stable `suggestion_key` hashes only user-safe metadata: current/target provider+model, role, window and scoring policy version.

- [ ] **Step 4: Implement eligibility before scoring**

Reject disabled providers/models, forbidden cloud locality, missing tool/vision/reasoning, insufficient context and tier below `minimum_tier`. This function returns `EligibilityFailure` for diagnostics but rejected candidates never reach the ranking vector.

- [ ] **Step 5: Implement versioned balanced scoring**

Normalize each known dimension to 0–100 and use integer basis points:

```rust
const COST_WEIGHT: u32 = 3_000;
const HEADROOM_WEIGHT: u32 = 2_500;
const QUALITY_WEIGHT: u32 = 2_000;
const LATENCY_WEIGHT: u32 = 1_500;
const RELIABILITY_WEIGHT: u32 = 1_000;
```

Missing dimensions are removed from the denominator and lower confidence; they are not scored as zero. Quality is the declared/curated tier after the hard minimum-tier gate, not an LLM judgment over user content.

- [ ] **Step 6: Implement materiality/confidence gates**

Emit only when at least one condition holds:

- predicted cost improves by 20% or more;
- median latency improves by 25% or more with at least 10 successful calls for both models;
- current budget/quota usage is at least 80% and candidate headroom improves by 20 percentage points or more.

Reliability/latency claims require 10 successful recent calls. Provider price/quota claims may stand without observed samples when provenance is provider-reported or provider-catalog. Low confidence returns no suggestion.

- [ ] **Step 7: Run pure tests for GREEN**

Run: `cargo test -p local-first-desktop-gateway usage_suggestions::tests --lib`

Expected: hard gates, weights, missing-data behavior, materiality and confidence tests PASS.

- [ ] **Step 8: Commit the pure engine**

```bash
git add crates/desktop-gateway/src/usage_suggestions.rs crates/desktop-gateway/src/lib.rs
git commit -m "feat(usage): add constrained model suggestion engine"
```

### Task 2: Persist dismiss/apply actions and expose suggestion APIs

**Files:**
- Modify: `crates/desktop-gateway/src/usage_store.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Create: `crates/desktop-gateway/tests/usage_suggestions.rs`

- [ ] **Step 1: Write failing store/API integration tests**

```rust
#[test]
fn dismissed_equivalent_suggestion_is_suppressed_for_thirty_days() {
    let store = UsageStore::open_in_memory().unwrap();
    store.append_suggestion_action(&action("key-1", "dismissed", 100)).unwrap();
    assert!(store.is_suggestion_suppressed("local", "key-1", 100 + 29 * 86_400).unwrap());
    assert!(!store.is_suggestion_suppressed("local", "key-1", 100 + 31 * 86_400).unwrap());
}

#[tokio::test]
async fn apply_requires_explicit_confirmation() {
    let error = apply_usage_suggestion(unconfirmed_request()).await.unwrap_err();
    assert_eq!(error.code, "usage_suggestion_confirmation_required");
}
```

- [ ] **Step 2: Run integration tests for RED**

Run: `cargo test -p local-first-desktop-gateway --test usage_suggestions`

Expected: FAIL because action storage and APIs do not exist.

- [ ] **Step 3: Add append-only action storage**

Create `usage_suggestion_actions` with action ID, suggestion key, user/workspace/thread, current and target provider/model, role, action (`dismissed`, `used_for_task`, `preference_changed`), scoring policy version and created timestamp. It contains no prompt, task text or explanation prose. Add scoped indexes and factory-reset coverage through the unified database wipe.

- [ ] **Step 4: Build suggestions from canonical facts**

Register:

```text
GET  /api/usage/suggestions?window=7d|30d|all&scope=home|settings
POST /api/usage/suggestions/{suggestion_key}/apply
POST /api/usage/suggestions/{suggestion_key}/dismiss
```

The GET handler loads model capabilities from `ProviderRegistry`, aggregate facts from `UsageStore`, budgets/snapshots from Phase B, and existing role requirements. It does not receive prompt content. `scope=home` returns at most one suggestion; `settings` returns at most five.

- [ ] **Step 5: Make apply validation explicit**

The apply body is:

```rust
pub struct ApplyUsageSuggestionRequest {
    pub confirmed: bool,
    pub action: SuggestionActionScope,
    pub thread_id: Option<String>,
}
```

Reject `confirmed=false`, stale suggestion keys, unavailable targets and scope mismatches. Return an `ApplyInstruction`:

- `UseForTask { provider_id, model_id, thread_id }` for client-side one-turn selection;
- `ChangeRolePreference { role, provider_id, model_id }` for the existing role-binding API.

The endpoint records the action only after all validation. It does not silently mutate routing.

- [ ] **Step 6: Run integration tests for GREEN**

Run: `cargo test -p local-first-desktop-gateway --test usage_suggestions`

Expected: confirmation, stale-key, suppression, scope and metadata-only tests PASS.

- [ ] **Step 7: Commit APIs and action history**

```bash
git add crates/desktop-gateway/src/usage_store.rs crates/desktop-gateway/src/main.rs \
  crates/desktop-gateway/tests/usage_suggestions.rs
git commit -m "feat(usage): expose confirmed model suggestions"
```

### Task 3: Add typed suggestion UI and confirmation

**Files:**
- Modify: `apps/desktop/src/lib/coreBridge.ts`
- Modify: `apps/desktop/src/lib/usageViewModel.ts`
- Modify: `apps/desktop/src/lib/usageViewModel.mjs`
- Modify: `apps/desktop/src/lib/usageViewModel.test.mjs`
- Create: `apps/desktop/src/components/UsageSuggestion.tsx`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Write failing explanation/confirmation tests**

Add pure tests proving that a cost fact says whether it is provider-reported or estimated, missing evidence is disclosed, and no action is labeled as already applied before confirmation.

- [ ] **Step 2: Add failing structural assertions**

```javascript
assertContains("src/components/UsageSuggestion.tsx", "usage-suggestion-confirm", "Suggestion changes must use an explicit confirmation surface");
assertContains("src/components/UsageSuggestion.tsx", "confirmed: true", "Apply request must be explicitly confirmed");
assertContains("src/components/UsageSuggestion.tsx", "onDismiss", "Suggestions must be dismissible");
assertNotContains("src/components/UsageSuggestion.tsx", "useEffect(() => onApply", "Mounting must never apply a suggestion");
```

- [ ] **Step 3: Run UI tests for RED**

Run:

```bash
cd apps/desktop
npm run test:usage-ui
npm run test:ui-contract
```

Expected: FAIL because suggestion UI/contracts do not exist.

- [ ] **Step 4: Add typed bridge methods**

Define `ModelUsageSuggestion`, `SuggestionFact`, `SuggestionActionScope` and `ApplyInstruction`. Add:

```ts
usageSuggestions(window: UsageWindow, scope: "home" | "settings")
applyUsageSuggestion(key: string, body: { confirmed: true; action: SuggestionActionScope; thread_id?: string })
dismissUsageSuggestion(key: string)
```

- [ ] **Step 5: Implement `UsageSuggestion`**

The compact state shows target model, up to two material facts, confidence and provenance. Clicking an action opens one confirmation surface that names current model, target model and scope. Only the confirm button calls `applyUsageSuggestion`. Escape/cancel closes without a request. Dismiss is immediate but undoable for five seconds in local UI before the API call is finalized.

- [ ] **Step 6: Run UI tests and typecheck for GREEN**

Run:

```bash
cd apps/desktop
npm run test:usage-ui
npm run test:ui-contract
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit typed suggestion UI**

```bash
git add apps/desktop/src/lib/coreBridge.ts apps/desktop/src/lib/usageViewModel.ts \
  apps/desktop/src/lib/usageViewModel.mjs apps/desktop/src/lib/usageViewModel.test.mjs \
  apps/desktop/src/components/UsageSuggestion.tsx apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(usage-ui): add confirmed suggestion component"
```

### Task 4: Integrate task and preference actions

**Files:**
- Modify: `apps/desktop/src/components/ChatUsageOverview.tsx`
- Modify: `apps/desktop/src/components/ChatView.tsx`
- Modify: `apps/desktop/src/components/UsageSettingsPane.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/it.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`
- Modify: `apps/desktop/src/i18n/locales/fr.json`
- Modify: `apps/desktop/src/i18n/locales/de.json`

- [ ] **Step 1: Add failing integration contract assertions**

Require home to slice suggestions to one, ChatView to receive `onUseForTask`, Settings to call `setRole` only after a confirmed `ChangeRolePreference`, and all three user actions to be present in localized copy.

- [ ] **Step 2: Run UI contracts for RED**

Run: `cd apps/desktop && npm run test:ui-contract`

Expected: FAIL on missing integrations.

- [ ] **Step 3: Integrate one-turn selection in ChatView**

Pass `onUseForTask(providerId, modelId)` from `ChatView` to `ChatUsageOverview`. After confirmed `UseForTask`, update the existing composer model selection state for the next submit only. Clear the override after enqueue succeeds or when the user manually selects another model. Do not persist a role binding.

- [ ] **Step 4: Integrate preference changes in Settings**

After confirmed `ChangeRolePreference`, call `coreBridge.setRole({ role, provider_id, model })`, reload suggestions and show a success status naming the role. A failed role update leaves the previous preference intact and keeps the suggestion actionable.

- [ ] **Step 5: Add minimal styling and copy**

The suggestion uses one accent line and no nested card border. Confirmation may use the existing Settings-contained modal primitives in Settings and the existing in-chat confirmation surface in ChatView. Add localized strings for rationale, confidence, provenance, use for task, change preference, ignore, confirmation, cancellation, success and failure.

- [ ] **Step 6: Run desktop checks for GREEN**

Run:

```bash
cd apps/desktop
npm run test:new-chat-usage
npm run test:usage-ui
npm run test:ui-contract
npm run test:electron
npm run typecheck
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit suggestion integrations**

```bash
git add apps/desktop/src/components/ChatUsageOverview.tsx apps/desktop/src/components/ChatView.tsx \
  apps/desktop/src/components/UsageSettingsPane.tsx apps/desktop/src/styles.css \
  apps/desktop/src/i18n/locales
git commit -m "feat(usage-ui): integrate confirmed model suggestions"
```

### Task 5: Phase E and release-candidate verification

**Files:**
- Verify only; no expected source edits.

- [ ] **Step 1: Run complete automated gates**

Run:

```bash
cargo fmt --all -- --check
cargo test --workspace
cd apps/desktop
npm run test:new-chat-usage
npm run test:usage-ui
npm run test:ui-contract
npm run test:electron
npm run typecheck
npm run build
cd ../..
git diff --check
```

Expected: all commands exit 0; ignored Rust tests are reported separately.

- [ ] **Step 2: Run real multi-provider QA**

Use a disposable profile with local Ollama and at least one cloud provider. Generate at least 10 comparable calls for two eligible models, then verify:

- forbidden cloud model is never suggested under local-only policy;
- tool/vision/context incompatibilities are never suggested;
- insufficient samples produce no latency/reliability claim;
- reported and estimated cost provenance is visible;
- home shows at most one suggestion;
- no action changes anything before confirmation;
- `Use for this task` affects one submit only;
- `Change preference` changes only the named role;
- dismiss suppresses the equivalent suggestion and not unrelated ones;
- disconnecting/offlining a provider invalidates stale suggestions.

- [ ] **Step 3: Inspect persisted action privacy**

Query `usage_suggestion_actions` and confirm it contains only IDs, provider/model/role, action, policy version and timestamps. Search the database for QA prompt sentinels and expect zero matches in usage tables.

- [ ] **Step 4: Record corrections only if required**

If QA required source changes:

```bash
git add crates apps/desktop
git commit -m "fix(usage): close suggestion release-gate gaps"
```

- [ ] **Step 5: Produce the implementation evidence summary**

Record exact automated test results, the providers/models used in QA, coverage percentages, cost-provenance examples, and any excluded/ignored test. Do not tag a release from this plan; merge/push/release follows the repository's normal finishing and release workflow after review.
