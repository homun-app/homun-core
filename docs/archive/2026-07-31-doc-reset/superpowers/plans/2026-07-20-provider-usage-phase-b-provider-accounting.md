# Provider Usage Phase B: Pricing, Snapshots and Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add trustworthy cost provenance, standard-key provider-account snapshots and clearly labeled manual budgets/prices.

**Architecture:** Provider-reported cost remains authoritative. Otherwise a versioned model price captured from a provider catalog or a user override enriches the terminal usage event before append; immutable event prices never change later. Account snapshots are fetched through capability-specific adapters using the already configured standard key and stay separate from Homun-measured usage.

**Tech Stack:** Rust, serde, rusqlite, reqwest, existing provider registry and encrypted secret store.

---

**Dependency:** Complete and verify [Phase A](./2026-07-20-provider-usage-phase-a-ledger.md) first.

## File map

- Modify `crates/desktop-gateway/src/usage_store.rs`: policy and snapshot tables/queries.
- Create `crates/desktop-gateway/src/usage_pricing.rs`: integer-microusd estimation and provenance.
- Create `crates/desktop-gateway/src/provider_usage.rs`: provider capability adapters and normalized snapshots.
- Modify `crates/desktop-gateway/src/model_registry.rs`: optional provider-catalog price metadata per model.
- Modify `crates/desktop-gateway/src/main.rs`: refresh/policy endpoints and recorder enrichment.
- Modify `crates/desktop-gateway/src/lib.rs`: export focused modules for tests.
- Create `crates/desktop-gateway/tests/usage_accounting.rs`: integration tests.

### Task 1: Persist budgets, price overrides and provider snapshots

**Files:**
- Modify: `crates/desktop-gateway/src/usage_store.rs`
- Test: `crates/desktop-gateway/src/usage_store.rs`

- [ ] **Step 1: Write failing policy/snapshot tests**

```rust
#[test]
fn manual_budget_round_trips_without_becoming_provider_quota() {
    let store = UsageStore::open_in_memory().unwrap();
    let policy = ProviderUsagePolicy {
        user_id: "local".into(), provider_id: "anthropic".into(),
        monthly_budget_microusd: Some(20_000_000), currency: "USD".into(),
        reset_day: Some(1), timezone: Some("Europe/Rome".into()),
        alert_threshold_percent: Some(80), pricing_overrides: vec![],
    };
    store.upsert_provider_policy(&policy, 100).unwrap();
    let loaded = store.provider_policy("local", "anthropic").unwrap().unwrap();
    assert_eq!(loaded.monthly_budget_microusd, Some(20_000_000));
    assert_eq!(loaded.limit_source(), LimitSource::ManualBudget);
}

#[test]
fn latest_snapshot_is_provider_scoped_and_append_only() {
    let store = UsageStore::open_in_memory().unwrap();
    store.append_provider_snapshot(&snapshot("first", "openrouter", 100)).unwrap();
    store.append_provider_snapshot(&snapshot("second", "openrouter", 200)).unwrap();
    assert_eq!(store.latest_provider_snapshots("local", "openrouter").unwrap()[0].snapshot_id, "second");
    assert_eq!(store.provider_snapshot_count("local", "openrouter").unwrap(), 2);
}
```

- [ ] **Step 2: Run store tests for RED**

Run: `cargo test -p local-first-desktop-gateway usage_store::tests --lib`

Expected: FAIL because policy/snapshot schemas and APIs do not exist.

- [ ] **Step 3: Add idempotent migrations**

Create `provider_usage_snapshots` and `provider_usage_policies` exactly as specified in the design. Validate on write:

- budget and price integers are non-negative;
- currency is `USD` in v1;
- reset day is 1–28;
- threshold is 1–100;
- timezone is non-empty and at most 80 characters;
- pricing override model ID is non-empty and at most 240 characters;
- duplicate model overrides are rejected.

Implement:

```rust
pub fn upsert_provider_policy(&self, policy: &ProviderUsagePolicy, now: i64) -> Result<(), UsageStoreError>;
pub fn provider_policy(&self, user_id: &str, provider_id: &str) -> Result<Option<ProviderUsagePolicy>, UsageStoreError>;
pub fn append_provider_snapshot(&self, snapshot: &ProviderUsageSnapshot) -> Result<AppendOutcome, UsageStoreError>;
pub fn latest_provider_snapshots(&self, user_id: &str, provider_id: &str) -> Result<Vec<ProviderUsageSnapshot>, UsageStoreError>;
```

- [ ] **Step 4: Extend purge behavior**

Workspace purge removes workspace-owned inference events and rollups but keeps user-level provider budgets/snapshots. Factory reset already deletes the whole `~/.homun` directory and therefore removes all three. Add a test proving workspace deletion does not erase the user's provider policy.

- [ ] **Step 5: Run store tests for GREEN**

Run: `cargo test -p local-first-desktop-gateway usage_store::tests --lib`

Expected: all policy, snapshot and existing ledger tests PASS.

- [ ] **Step 6: Commit accounting storage**

```bash
git add crates/desktop-gateway/src/usage_store.rs
git commit -m "feat(usage): persist provider budgets and snapshots"
```

### Task 2: Capture provider-catalog pricing without a stale global price list

**Files:**
- Modify: `crates/desktop-gateway/src/model_registry.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Test: `crates/desktop-gateway/src/model_registry.rs`

- [ ] **Step 1: Write failing provider price parsing tests**

```rust
#[test]
fn openrouter_catalog_price_converts_per_token_strings_to_microusd_per_million() {
    let model = parse_model_entry(ProviderKind::OpenaiCompat, &serde_json::json!({
        "id": "vendor/model",
        "pricing": {"prompt": "0.00000015", "completion": "0.00000060"}
    }), Some("openrouter"));
    let price = model.price.unwrap();
    assert_eq!(price.input_microusd_per_million, Some(150_000));
    assert_eq!(price.output_microusd_per_million, Some(600_000));
    assert_eq!(price.source, "provider_catalog");
}

#[test]
fn generic_catalog_without_price_keeps_cost_unknown() {
    let model = parse_model_entry(ProviderKind::OpenaiCompat, &serde_json::json!({"id":"custom/model"}), Some("custom"));
    assert!(model.price.is_none());
}
```

- [ ] **Step 2: Run registry tests for RED**

Run: `cargo test -p local-first-desktop-gateway model_registry::tests --lib`

Expected: FAIL because `ModelEntry` has no price metadata and catalog parsing only returns IDs.

- [ ] **Step 3: Add a versioned `ModelPrice` to the registry**

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelPrice {
    pub input_microusd_per_million: Option<u64>,
    pub output_microusd_per_million: Option<u64>,
    pub reasoning_microusd_per_million: Option<u64>,
    pub cache_read_microusd_per_million: Option<u64>,
    pub cache_write_microusd_per_million: Option<u64>,
    pub source: String,
    pub version: String,
    pub effective_at: i64,
}
```

Add `#[serde(default)] pub price: Option<ModelPrice>` to `ModelEntry`. Preserve user profile and price metadata across catalog refresh when the response omits price. When OpenRouter's model response includes `pricing`, parse decimal strings with integer decimal arithmetic; do not use `f64` for money. Other provider catalogs remain unknown unless they supply an equivalent explicit field.

- [ ] **Step 4: Return price provenance in provider views**

Extend `ProviderModelView` with nullable price fields and provenance. Do not expose the API key or a raw provider catalog object.

- [ ] **Step 5: Run registry and provider endpoint tests for GREEN**

Run:

```bash
cargo test -p local-first-desktop-gateway model_registry::tests --lib
cargo test -p local-first-desktop-gateway provider --lib
```

Expected: price parsing and existing capability/profile tests PASS.

- [ ] **Step 6: Commit provider catalog pricing**

```bash
git add crates/desktop-gateway/src/model_registry.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(usage): capture provider catalog pricing"
```

### Task 3: Estimate cost with immutable provenance

**Files:**
- Create: `crates/desktop-gateway/src/usage_pricing.rs`
- Modify: `crates/desktop-gateway/src/lib.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/usage_store.rs`
- Test: `crates/desktop-gateway/src/usage_pricing.rs`

- [ ] **Step 1: Write failing precedence and integer-math tests**

```rust
#[test]
fn provider_reported_cost_wins_unchanged() {
    let result = resolve_cost(Some(1_234), &usage(1_000, 500), Some(&catalog_price()), Some(&manual_price()));
    assert_eq!(result.cost_microusd, Some(1_234));
    assert_eq!(result.provenance, CostProvenance::ProviderReported);
}

#[test]
fn manual_override_wins_over_catalog_for_estimates() {
    let result = resolve_cost(None, &usage(1_000_000, 500_000), Some(&catalog_price()), Some(&manual_price()));
    assert_eq!(result.cost_microusd, Some(2_000_000));
    assert_eq!(result.provenance, CostProvenance::ManualEstimated);
}

#[test]
fn missing_token_component_does_not_become_zero_cost() {
    let mut u = usage(1_000, 500);
    u.output_tokens = None;
    assert_eq!(resolve_cost(None, &u, Some(&catalog_price()), None).cost_microusd, None);
}
```

Define `usage`, `catalog_price` and `manual_price` in the test module with fixed integer micro-USD rates. In particular, choose the manual fixture so 1,000,000 input plus 500,000 output tokens resolves to exactly 2,000,000 micro-USD as asserted above.

- [ ] **Step 2: Run pricing tests for RED**

Run: `cargo test -p local-first-desktop-gateway usage_pricing::tests --lib`

Expected: FAIL because the resolver does not exist.

- [ ] **Step 3: Implement integer-only cost resolution**

Create `CostResolution` with cost, provenance, pricing source and version. Use checked `u128` multiplication and division by one million, then checked conversion to `u64`. Resolution order is:

1. provider-reported terminal cost;
2. manual override + provider tokens;
3. provider catalog + provider tokens;
4. manual/catalog + Homun-estimated tokens;
5. `not_billed` for local runtime;
6. unavailable.

If any token class with a non-zero configured price is unknown, return unavailable instead of a partial total.

- [ ] **Step 4: Enrich before append, never during reads**

Wrap the buffered recorder with a `CostEnrichingUsageRecorder`. It reads an atomically replaceable in-memory pricing snapshot built from the model registry and usage policies, enriches terminal events once, then forwards them. Policy/provider refresh rebuilds that snapshot. Aggregation only sums stored `cost_microusd`; it never applies today's price to history.

- [ ] **Step 5: Run pricing and ledger tests for GREEN**

Run:

```bash
cargo test -p local-first-desktop-gateway usage_pricing::tests --lib
cargo test -p local-first-desktop-gateway usage_store::tests --lib
```

Expected: precedence, overflow, unknown data and history-freezing tests PASS.

- [ ] **Step 6: Commit cost enrichment**

```bash
git add crates/desktop-gateway/src/usage_pricing.rs crates/desktop-gateway/src/usage_store.rs \
  crates/desktop-gateway/src/lib.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(usage): resolve cost with immutable provenance"
```

### Task 4: Fetch provider-account state with the standard key only

**Files:**
- Create: `crates/desktop-gateway/src/provider_usage.rs`
- Modify: `crates/desktop-gateway/src/lib.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Test: `crates/desktop-gateway/src/provider_usage.rs`

- [ ] **Step 1: Write failing capability and parser tests**

```rust
#[test]
fn openrouter_key_response_becomes_a_credit_snapshot() {
    let rows = parse_openrouter_key_state("local", "openrouter", 100, &serde_json::json!({
        "data": {"limit": 50.0, "usage": 12.5, "limit_remaining": 37.5, "is_free_tier": false}
    })).unwrap();
    assert_eq!(rows[0].source, "provider_standard_key");
    assert_eq!(rows[0].used_value, Some(12_500_000));
    assert_eq!(rows[0].remaining_value, Some(37_500_000));
    assert_eq!(rows[0].unit.as_deref(), Some("microusd"));
}

#[test]
fn anthropic_standard_key_is_explicitly_unsupported_for_org_usage() {
    assert_eq!(adapter_capability("anthropic", ProviderKind::Anthropic), AccountUsageCapability::UnsupportedWithStandardKey);
}
```

- [ ] **Step 2: Run adapter tests for RED**

Run: `cargo test -p local-first-desktop-gateway provider_usage::tests --lib`

Expected: FAIL because provider account adapters do not exist.

- [ ] **Step 3: Implement the capability matrix**

V1 behavior:

| Provider | Standard-key account endpoint | Result |
|---|---|---|
| OpenRouter preset/base URL | `GET /api/v1/key` with existing bearer key | parse credit/limit state |
| Anthropic | none without Admin API key | `unsupported` |
| Ollama local/cloud | no supported account API in Homun v1 | `unsupported` |
| generic OpenAI-compatible | none unless a future explicit adapter is added | `unsupported` |

Do not probe guessed paths. Map HTTP 401/403 to `unauthorized`, 404 to `unsupported`, transport/5xx to `error`, and preserve the last successful snapshot as stale in reads.

- [ ] **Step 4: Add refresh and policy endpoints**

Register:

```text
POST /api/usage/providers/{provider_id}/refresh
GET  /api/usage/providers/{provider_id}/policy
PUT  /api/usage/providers/{provider_id}/policy
```

The refresh handler loads the provider and its existing key, calls only the declared adapter, appends normalized snapshot rows, and returns the scoped provider read model. The PUT handler validates the policy server-side and rebuilds the pricing snapshot.

- [ ] **Step 5: Run adapter/API tests for GREEN**

Run:

```bash
cargo test -p local-first-desktop-gateway provider_usage::tests --lib
cargo test -p local-first-desktop-gateway usage_provider_api --lib
```

Expected: OpenRouter parse, unsupported providers, auth/error states and policy validation PASS.

- [ ] **Step 6: Commit standard-key adapters**

```bash
git add crates/desktop-gateway/src/provider_usage.rs crates/desktop-gateway/src/lib.rs \
  crates/desktop-gateway/src/main.rs
git commit -m "feat(usage): add standard-key provider snapshots"
```

### Task 5: Expose provenance-rich provider accounting read models

**Files:**
- Modify: `crates/desktop-gateway/src/usage_store.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Create: `crates/desktop-gateway/tests/usage_accounting.rs`

- [ ] **Step 1: Write failing mixed-provenance integration test**

Seed four attempts: reported cost, catalog estimate, manual estimate and unknown. Assert the provider response returns four separate counts and totals, plus a separate manual budget object and provider snapshot object.

- [ ] **Step 2: Run integration test for RED**

Run: `cargo test -p local-first-desktop-gateway --test usage_accounting`

Expected: FAIL because the provider read model does not expose the accounting split.

- [ ] **Step 3: Extend summary/provider read models**

Return these explicit fields:

```rust
pub struct UsageCostBreakdown {
    pub provider_reported_microusd: u64,
    pub catalog_estimated_microusd: u64,
    pub manual_estimated_microusd: u64,
    pub not_billed_attempts: u64,
    pub unknown_cost_attempts: u64,
    pub cost_coverage_percent: u8,
}
```

Provider rows contain `homun_usage`, `account_snapshot` and `manual_policy` as sibling objects. Never merge `monthly_budget_microusd` into `account_snapshot.limit_value`.

- [ ] **Step 4: Run integration tests for GREEN**

Run: `cargo test -p local-first-desktop-gateway --test usage_accounting`

Expected: all provenance and separation assertions PASS.

- [ ] **Step 5: Commit accounting read models**

```bash
git add crates/desktop-gateway/src/usage_store.rs crates/desktop-gateway/src/main.rs \
  crates/desktop-gateway/tests/usage_accounting.rs
git commit -m "feat(usage): expose provider accounting provenance"
```

### Task 6: Phase B verification gate

**Files:**
- Verify only; no expected source edits.

- [ ] **Step 1: Run formatting and focused tests**

Run:

```bash
cargo fmt --all -- --check
git diff --check
cargo test -p local-first-desktop-gateway usage_pricing
cargo test -p local-first-desktop-gateway provider_usage
cargo test -p local-first-desktop-gateway --test usage_accounting
```

Expected: all commands exit 0.

- [ ] **Step 2: Run complete Rust regression**

Run: `cargo test --workspace`

Expected: all suites PASS; any ignored tests are listed explicitly.

- [ ] **Step 3: Verify database semantics directly**

Using the file-backed test DB, query one event from each cost provenance and the latest provider snapshots. Confirm historical event cost does not change after updating a model price or manual override.

- [ ] **Step 4: Record corrections only if required**

If verification changed source:

```bash
git add crates/desktop-gateway
git commit -m "fix(usage): close phase B accounting gaps"
```
