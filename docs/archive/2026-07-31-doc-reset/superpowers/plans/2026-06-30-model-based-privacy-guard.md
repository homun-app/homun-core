# Model-Based Privacy Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pre-turn Privacy Guard that detects sensitive user input before the main chat model, returns a Vault proposal, and prevents raw secrets from entering normal memory/chat flow.

**Architecture:** The desktop gateway owns a small `PrivacyGuard` component. The first implementation provides the full typed decision model, deterministic fallback, sidecar-backed proposal storage, and a pre-main-loop intercept; the model-backed classifier is wired behind a role seam so it can be enabled without changing the chat contract. The guard is not a second execution loop: it only classifies and either returns a `VAULT_PROPOSE` assistant message or lets the existing ADR 0021 loop continue.

**Tech Stack:** Rust (`local-first-desktop-gateway`, `local-first-vault`), Axum streaming JSON-line protocol, SQLite stores already present in gateway, existing React marker renderer.

---

## Files

- Create: `crates/desktop-gateway/src/privacy_guard.rs`
  - Owns `PrivacyGuardDecision`, deterministic fallback, redaction, sidecar proposal store, and stream intercept helpers.
- Modify: `crates/desktop-gateway/src/main.rs`
  - Imports module, adds `pending_vault_proposals` state, calls guard at the top of `generate_stream`, and passes proposal ids through `/api/vault/proposals/accept`.
- Modify: `crates/desktop-gateway/src/lib.rs`
  - No required contract change unless tests need reusable `ChatMessage` helpers.
- Modify: `docs/architecture/vault.md`
  - Documents Privacy Guard as primary classifier and deterministic classifier as fallback.
- Modify: `docs/architecture/agent-loop.md`
  - Shows pre-turn privacy gate before the single loop.
- Modify: `docs/STATO.md`
  - Records implementation status and validation notes.

## Task 1: Privacy Guard Types And Deterministic Decision

**Files:**
- Create: `crates/desktop-gateway/src/privacy_guard.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Write failing tests**

Add tests in `privacy_guard.rs`:

```rust
#[test]
fn deterministic_guard_detects_vehicle_plate_and_redacts_text() {
    let decision = classify_sensitive_input_deterministic(
        "ricordati che la targa della mia auto e' FM470BN e' un'audi q2",
    );

    assert!(decision.has_sensitive_data);
    assert_eq!(decision.items.len(), 1);
    assert_eq!(decision.items[0].category, "vehicles");
    assert_eq!(decision.items[0].kind, "plate");
    assert_eq!(decision.items[0].secret_value, "FM470BN");
    assert!(decision.redacted_text.contains("[VAULT:vehicles:plate]"));
    assert!(!decision.redacted_text.contains("FM470BN"));
}

#[test]
fn deterministic_guard_ignores_non_sensitive_preference() {
    let decision = classify_sensitive_input_deterministic(
        "ricordati che preferisco partire da Napoli al mattino",
    );

    assert!(!decision.has_sensitive_data);
    assert!(decision.items.is_empty());
}
```

- [ ] **Step 2: Run red**

Run:

```bash
cargo test -p local-first-desktop-gateway privacy_guard
```

Expected: compile failure because `privacy_guard` module/functions do not exist.

- [ ] **Step 3: Implement minimal module**

Create:

```rust
use local_first_vault::VaultCategory;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PrivacyGuardDecision {
    pub(crate) has_sensitive_data: bool,
    pub(crate) items: Vec<PrivacyGuardItem>,
    pub(crate) redacted_text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PrivacyGuardItem {
    pub(crate) category: String,
    pub(crate) kind: String,
    pub(crate) label: String,
    pub(crate) secret_value: String,
    pub(crate) redacted_preview: String,
    pub(crate) confidence: f32,
}

pub(crate) fn classify_sensitive_input_deterministic(text: &str) -> PrivacyGuardDecision {
    let classification = local_first_vault::classify_sensitive_text(text);
    let items = classification
        .detections
        .iter()
        .map(|detection| PrivacyGuardItem {
            category: category_key(detection.category).to_string(),
            kind: detection.kind.clone(),
            label: label_for_detection(detection.kind.as_str()).to_string(),
            secret_value: text[detection.start..detection.end].to_string(),
            redacted_preview: detection.placeholder.clone(),
            confidence: 0.95,
        })
        .collect::<Vec<_>>();
    PrivacyGuardDecision {
        has_sensitive_data: !items.is_empty(),
        items,
        redacted_text: if classification.has_critical {
            classification.redacted_text
        } else {
            text.to_string()
        },
    }
}

fn category_key(category: VaultCategory) -> &'static str {
    match category {
        VaultCategory::Payments => "payments",
        VaultCategory::Identity => "identity",
        VaultCategory::Health => "health",
        VaultCategory::Vehicles => "vehicles",
        VaultCategory::Credentials => "credentials",
        VaultCategory::PrivateNotes => "private_notes",
    }
}

fn label_for_detection(kind: &str) -> &'static str {
    match kind {
        "plate" => "Targa auto",
        "codice_fiscale" => "Codice fiscale",
        "card_number" => "Carta di pagamento",
        "cvv_one_shot" => "CVV one-shot",
        "health_note" => "Dato sanitario",
        "secret" => "Credenziale",
        _ => "Dato sensibile",
    }
}
```

Add `mod privacy_guard;` in `main.rs`.

- [ ] **Step 4: Run green**

Run:

```bash
cargo test -p local-first-desktop-gateway privacy_guard
```

Expected: tests pass.

## Task 2: Pending Proposal Sidecar

**Files:**
- Modify: `crates/desktop-gateway/src/privacy_guard.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Write failing tests**

Add tests:

```rust
#[test]
fn pending_proposal_store_consumes_secret_once() {
    let store = PendingVaultProposalStore::default();
    let id = store.insert(PendingVaultProposal {
        category: "vehicles".to_string(),
        label: "Targa auto".to_string(),
        redacted_preview: "[VAULT:vehicles:plate]".to_string(),
        secret_value: "FM470BN".to_string(),
    });

    let first = store.take(&id).expect("first take");
    assert_eq!(first.secret_value, "FM470BN");
    assert!(store.take(&id).is_none());
}
```

- [ ] **Step 2: Run red**

Run:

```bash
cargo test -p local-first-desktop-gateway pending_proposal_store_consumes_secret_once
```

Expected: compile failure for missing types.

- [ ] **Step 3: Implement store**

Add:

```rust
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug, Clone)]
pub(crate) struct PendingVaultProposal {
    pub(crate) category: String,
    pub(crate) label: String,
    pub(crate) redacted_preview: String,
    pub(crate) secret_value: String,
}

#[derive(Default)]
pub(crate) struct PendingVaultProposalStore {
    inner: Mutex<HashMap<String, PendingVaultProposal>>,
}

impl PendingVaultProposalStore {
    pub(crate) fn insert(&self, proposal: PendingVaultProposal) -> String {
        let id = format!("vault_pending_{}", uuid::Uuid::new_v4().simple());
        if let Ok(mut inner) = self.inner.lock() {
            inner.insert(id.clone(), proposal);
        }
        id
    }

    pub(crate) fn take(&self, id: &str) -> Option<PendingVaultProposal> {
        self.inner.lock().ok()?.remove(id)
    }
}
```

Add to `AppState`:

```rust
pending_vault_proposals: Arc<privacy_guard::PendingVaultProposalStore>,
```

Initialize it beside `vault_store`.

- [ ] **Step 4: Run green**

Run:

```bash
cargo test -p local-first-desktop-gateway pending_proposal_store_consumes_secret_once
```

Expected: pass.

## Task 3: Pre-Turn Stream Intercept

**Files:**
- Modify: `crates/desktop-gateway/src/privacy_guard.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Write failing tests**

Add tests:

```rust
#[test]
fn sensitive_turn_builds_redacted_user_and_vault_proposal_answer() {
    let store = PendingVaultProposalStore::default();
    let decision = classify_sensitive_input_deterministic(
        "ricordati che la targa della mia auto e' FM470BN e' un'audi q2",
    );

    let intercept = build_privacy_guard_intercept(&store, "req_1", &decision)
        .expect("intercept");

    assert!(!intercept.user_text.contains("FM470BN"));
    assert!(intercept.user_text.contains("[VAULT:vehicles:plate]"));
    assert!(intercept.assistant_text.contains("VAULT_PROPOSE"));
    assert!(intercept.assistant_text.contains("\"pending_id\""));
    assert!(!intercept.assistant_text.contains("FM470BN"));
}
```

- [ ] **Step 2: Run red**

Run:

```bash
cargo test -p local-first-desktop-gateway sensitive_turn_builds_redacted_user_and_vault_proposal_answer
```

Expected: compile failure for missing intercept builder.

- [ ] **Step 3: Implement intercept builder**

Add:

```rust
pub(crate) struct PrivacyGuardIntercept {
    pub(crate) user_text: String,
    pub(crate) assistant_text: String,
}

pub(crate) fn build_privacy_guard_intercept(
    store: &PendingVaultProposalStore,
    _request_id: &str,
    decision: &PrivacyGuardDecision,
) -> Option<PrivacyGuardIntercept> {
    if !decision.has_sensitive_data {
        return None;
    }
    let mut markers = Vec::new();
    for item in &decision.items {
        let pending_id = store.insert(PendingVaultProposal {
            category: item.category.clone(),
            label: item.label.clone(),
            redacted_preview: item.redacted_preview.clone(),
            secret_value: item.secret_value.clone(),
        });
        let marker = serde_json::json!({
            "category": item.category,
            "label": item.label,
            "redacted_preview": item.redacted_preview,
            "pending_id": pending_id,
        });
        markers.push(format!("‹‹VAULT_PROPOSE››{marker}‹‹/VAULT_PROPOSE››"));
    }
    Some(PrivacyGuardIntercept {
        user_text: decision.redacted_text.clone(),
        assistant_text: markers.join("\n"),
    })
}
```

- [ ] **Step 4: Run green**

Run:

```bash
cargo test -p local-first-desktop-gateway sensitive_turn_builds_redacted_user_and_vault_proposal_answer
```

Expected: pass.

## Task 4: Accept Pending Proposal With PIN

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `apps/desktop/src/lib/coreBridge.ts`
- Modify: `apps/desktop/src/components/ChatView.tsx`

- [ ] **Step 1: Write failing backend test**

Extend `VaultProposalActionRequest` with `pending_id: Option<String>` and add a test:

```rust
#[test]
fn vault_proposal_accept_uses_pending_sidecar_secret() {
    let vault = local_first_vault::SQLiteVaultStore::open_in_memory().unwrap();
    super::apply_vault_pin_setup(
        &vault,
        &super::VaultPinSetupRequest {
            pin: "123456".to_string(),
            current_pin: None,
        },
    )
    .expect("pin");
    let pending = privacy_guard::PendingVaultProposalStore::default();
    let pending_id = pending.insert(privacy_guard::PendingVaultProposal {
        category: "vehicles".to_string(),
        label: "Targa auto".to_string(),
        redacted_preview: "[VAULT:vehicles:plate]".to_string(),
        secret_value: "FM470BN".to_string(),
    });
    let request = super::VaultProposalActionRequest {
        category: "vehicles".to_string(),
        label: "Targa auto".to_string(),
        redacted_preview: "[VAULT:vehicles:plate]".to_string(),
        secret_value: None,
        pending_id: Some(pending_id.clone()),
        pin: Some("123456".to_string()),
        thread_id: None,
        message_id: None,
    };

    let response = super::accept_vault_proposal_with_pending(&vault, Some(&pending), &request)
        .expect("accept");

    let record_id = response.record_id.parse().unwrap();
    let revealed = super::reveal_vault_record_secret(
        &vault,
        &record_id,
        &super::VaultRecordRevealRequest {
            pin: "123456".to_string(),
        },
    )
    .expect("reveal");
    assert_eq!(revealed.secret_value, "FM470BN");
    assert!(pending.take(&pending_id).is_none());
}
```

- [ ] **Step 2: Run red**

Run:

```bash
cargo test -p local-first-desktop-gateway vault_proposal_accept_uses_pending_sidecar_secret
```

Expected: compile failure for missing pending fields/helper.

- [ ] **Step 3: Implement backend pending accept**

Add `pending_id` to request. In the HTTP handler call a new helper:

```rust
accept_vault_proposal_with_pending(
    &vault_store,
    Some(&state.pending_vault_proposals),
    &request,
)
```

The helper clones the request, fills `secret_value` from `pending.take(id)` when
`secret_value` is absent, validates category/label/preview match the sidecar, and
then delegates to `accept_vault_proposal`.

- [ ] **Step 4: Update frontend payload**

Add `pending_id?: string` to `VaultProposalActionInput` and `VaultProposal`. Include
it in `VaultProposalCard` payload. If `pending_id` is present, show the local PIN
field before calling `vaultProposalAccept`.

- [ ] **Step 5: Run green**

Run:

```bash
cargo test -p local-first-desktop-gateway vault_proposal_accept_uses_pending_sidecar_secret
npm run test:ui-contract
```

Expected: backend test and UI contract pass.

## Task 5: Wire Guard Into `generate_stream`

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Write failing test for intercept stream shape**

Add a pure test around a helper:

```rust
#[test]
fn privacy_guard_stream_result_uses_redacted_prompt_and_vault_marker() {
    let store = privacy_guard::PendingVaultProposalStore::default();
    let result = super::privacy_guard_prompt_result(
        &store,
        "req_1",
        "thread_1",
        "ricordati targa FM470BN",
    )
    .expect("guard result");

    assert_eq!(result.user_message.role, "user");
    assert!(!result.user_message.text.contains("FM470BN"));
    assert!(result.assistant_message.text.contains("VAULT_PROPOSE"));
    assert!(!result.assistant_message.text.contains("FM470BN"));
}
```

- [ ] **Step 2: Run red**

Run:

```bash
cargo test -p local-first-desktop-gateway privacy_guard_stream_result_uses_redacted_prompt_and_vault_marker
```

Expected: compile failure for missing helper.

- [ ] **Step 3: Implement helper and early return**

Implement `privacy_guard_prompt_result(...) -> Option<PromptSubmissionResult>` using
`channel_chat_message("user", redacted)` and `channel_chat_message("assistant", marker)`.
At the top of `generate_stream`, before provider routing, call deterministic guard and
return a stream that emits:

```rust
GenerateStreamEvent::Delta { text: assistant_text.clone() }
GenerateStreamEvent::Done { text: assistant_text, metrics: TokenMetrics::zero() }
```

The frontend already commits the returned user and assistant messages from the Done
result.

- [ ] **Step 4: Run green**

Run:

```bash
cargo test -p local-first-desktop-gateway privacy_guard_stream_result_uses_redacted_prompt_and_vault_marker
```

Expected: pass.

## Task 6: Docs, Build, Live Smoke

**Files:**
- Modify: `docs/architecture/vault.md`
- Modify: `docs/architecture/agent-loop.md`
- Modify: `docs/STATO.md`

- [ ] **Step 1: Update docs**

Document implemented behavior and remaining model-role work.

- [ ] **Step 2: Run verification**

Run:

```bash
cargo test -p local-first-desktop-gateway privacy_guard vault_proposal_accept_uses_pending_sidecar_secret
cargo test -p local-first-vault
npm run test:ui-contract
npm run typecheck
cargo build -p local-first-desktop-gateway --bin local-first-desktop-gateway
```

Expected: all pass.

- [ ] **Step 3: Restart app**

Run:

```bash
screen -S homun-electron-f4 -X quit >/dev/null 2>&1 || true
pkill -f scripts/electron-dev.mjs >/dev/null 2>&1 || true
pkill -f electron/dist/Electron >/dev/null 2>&1 || true
pkill -f target/debug/local-first-desktop-gateway >/dev/null 2>&1 || true
mkdir -p /tmp/homun-logs
screen -dmS homun-electron-f4 bash -lc 'cd /Users/fabio/Projects/Homun/app/apps/desktop && HOMUN_DEBUG=1 HOMUN_PLAN_STALL_ABORT=1 npm run electron:dev > /tmp/homun-logs/electron-dev-f4.log 2>&1'
sleep 8
curl -fsS http://127.0.0.1:18765/api/health
```

Expected: health OK.

- [ ] **Step 4: Commit**

```bash
git add crates/desktop-gateway/src/privacy_guard.rs crates/desktop-gateway/src/main.rs apps/desktop/src/lib/coreBridge.ts apps/desktop/src/components/ChatView.tsx docs/architecture/vault.md docs/architecture/agent-loop.md docs/STATO.md
git commit -m "feat: add pre-turn privacy guard for vault"
```

