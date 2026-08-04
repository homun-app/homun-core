# Vault Purchase Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the MVP foundation for a separate encrypted personal Vault, sensitive-data redaction before memory, and guarded purchase approvals with local PIN plus one-shot CVV.

**Architecture:** Add a dedicated `local-first-vault` crate for Vault domain types, sensitive classification, redaction, and later policy. Integrate it into the memory pipeline before persistence so critical values are replaced by redacted placeholders or `vault_ref`s. Payment execution stays inside the existing single guarded chat/browser loop from ADR 0021, with a payment approval gate before any final purchase click.

**Tech Stack:** Rust workspace crates, `serde`, `rusqlite`, existing `local-first-secrets`, existing `local-first-memory`, existing desktop gateway marker/card rendering, existing browser safety gates.

---

## File Structure

- Create `crates/vault/Cargo.toml`: standalone Vault crate with serde only for the first slice.
- Create `crates/vault/src/lib.rs`: public exports.
- Create `crates/vault/src/sensitive.rs`: deterministic MVP classifier and redactor for payments, identity, health, vehicles, credentials, and private notes.
- Modify `Cargo.toml`: add `crates/vault` to the workspace.
- Later modify `crates/memory/src/redaction.rs`: call the Vault classifier before storing memory text.
- Later modify `crates/desktop-gateway/src/main.rs`: emit Vault proposal cards and payment approval cards.
- Later modify `apps/desktop/src/*`: render Vault proposals, Vault section, PIN/CVV dialog, and payment approval card.
- Later modify docs architecture: add Vault map and update memory/browser/payment boundaries.

## Task 1: Vault Classifier And Redactor

**Files:**
- Create: `crates/vault/Cargo.toml`
- Create: `crates/vault/src/lib.rs`
- Create: `crates/vault/src/sensitive.rs`
- Modify: `Cargo.toml`
- Test: `crates/vault/src/sensitive.rs`

- [ ] **Step 1: Write failing classifier tests**

Add tests in `crates/vault/src/sensitive.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_and_redacts_payment_card_without_cvv_storage() {
        let out = classify_sensitive_text("La mia carta e' 4111 1111 1111 1111 e cvv 123");

        assert!(out.has_critical);
        assert!(out.redacted_text.contains("[VAULT:payments:card:last4=1111]"));
        assert!(out.redacted_text.contains("[VAULT:payments:cvv:one_shot]"));
        assert!(!out.redacted_text.contains("4111 1111 1111 1111"));
        assert!(!out.redacted_text.contains("123"));
        assert!(out.detections.iter().any(|d| d.category == VaultCategory::Payments && d.kind == "card_number"));
        assert!(out.detections.iter().any(|d| d.category == VaultCategory::Payments && d.kind == "cvv_one_shot"));
    }

    #[test]
    fn detects_identity_health_vehicle_and_credentials() {
        let out = classify_sensitive_text(
            "Codice fiscale RSSMRA80A01H501U. Targa AB123CD. Sono allergico alla penicillina. password hunter2",
        );

        assert!(out.has_critical);
        assert!(out.redacted_text.contains("[VAULT:identity:codice_fiscale]"));
        assert!(out.redacted_text.contains("[VAULT:vehicles:plate]"));
        assert!(out.redacted_text.contains("[VAULT:health:health_note]"));
        assert!(out.redacted_text.contains("[VAULT:credentials:secret]"));
        assert!(!out.redacted_text.contains("RSSMRA80A01H501U"));
        assert!(!out.redacted_text.contains("AB123CD"));
        assert!(!out.redacted_text.contains("hunter2"));
    }

    #[test]
    fn leaves_normal_preferences_unredacted() {
        let out = classify_sensitive_text("Preferisco partire da Napoli e viaggiare al mattino");

        assert!(!out.has_critical);
        assert!(out.detections.is_empty());
        assert_eq!(out.redacted_text, "Preferisco partire da Napoli e viaggiare al mattino");
    }
}
```

- [ ] **Step 2: Run tests and verify RED**

Run: `cargo test -p local-first-vault`

Expected: FAIL because `local-first-vault` and `classify_sensitive_text` do not exist yet.

- [ ] **Step 3: Implement minimal classifier**

Create the crate and implement:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VaultCategory {
    Payments,
    Identity,
    Health,
    Vehicles,
    Credentials,
    PrivateNotes,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SensitiveDetection {
    pub category: VaultCategory,
    pub kind: String,
    pub placeholder: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SensitiveClassification {
    pub has_critical: bool,
    pub redacted_text: String,
    pub detections: Vec<SensitiveDetection>,
}

pub fn classify_sensitive_text(text: &str) -> SensitiveClassification
```

Use deterministic MVP matching:

- Luhn-valid 13-19 digit card numbers with spaces or dashes.
- `cvv`, `cvc`, `cv2`, `cvv2` followed by 3-4 digits.
- Italian codice fiscale shape: 16 alphanumeric chars in the standard letter/digit layout.
- Italian plate shape: two letters, three digits, two letters.
- Health note sentence when it contains `allerg`, `diagnos`, `farmac`, `patolog`, `terapia`, or `sanitari`.
- Credentials phrase when it contains `password`, `api key`, `token`, `secret`, or `private key`.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `cargo test -p local-first-vault`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml crates/vault
git commit -m "feat: add vault sensitive classifier"
```

## Task 2: Memory Redaction Gate

**Files:**
- Modify: `crates/memory/Cargo.toml`
- Modify: `crates/memory/src/redaction.rs`
- Test: `crates/memory/tests/contracts.rs`

- [ ] **Step 1: Write failing memory redaction tests**

Add tests that assert `redact_text("La mia targa e' AB123CD")` does not return the plate, and
`contains_secret` returns true for JSON strings containing card numbers, codice fiscale, or health notes.

- [ ] **Step 2: Run tests and verify RED**

Run: `cargo test -p local-first-memory redacts_vault_sensitive_values_from_memory`

Expected: FAIL because memory redaction currently catches generic secrets only.

- [ ] **Step 3: Wire `local-first-vault` into memory redaction**

Add `local-first-vault = { path = "../vault" }` and call `classify_sensitive_text` from
`redact_text`. Return `classification.redacted_text` when `classification.has_critical`.

- [ ] **Step 4: Run memory tests**

Run: `cargo test -p local-first-memory redacts_vault_sensitive_values_from_memory`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/memory/Cargo.toml crates/memory/src/redaction.rs crates/memory/tests/contracts.rs
git commit -m "feat: redact vault-sensitive memory"
```

## Task 3: Vault Store Skeleton

**Files:**
- Modify: `crates/vault/Cargo.toml`
- Create: `crates/vault/src/types.rs`
- Create: `crates/vault/src/store.rs`
- Modify: `crates/vault/src/lib.rs`
- Test: `crates/vault/src/store.rs`

- [ ] **Step 1: Write failing store tests**

Test that a `VaultRecord` stores category, label, non-sensitive metadata, and a `SecretRef`, but does
not expose secret material or CVV.

- [ ] **Step 2: Run tests and verify RED**

Run: `cargo test -p local-first-vault vault_store_keeps_metadata_separate_from_secret_material`

Expected: FAIL due missing store/types.

- [ ] **Step 3: Implement in-memory store skeleton**

Implement `VaultRecord`, `VaultRecordId`, `VaultStore` trait, and `InMemoryVaultStore` with no SQLite yet.
Use `local-first-secrets::SecretRef` for secret pointers.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `cargo test -p local-first-vault`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/vault
git commit -m "feat: add vault metadata store skeleton"
```

## Task 4: Vault Proposal Marker

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `apps/desktop/src/types.ts`
- Modify: `apps/desktop/src/components/RichMessage.tsx`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Write failing backend and UI contract tests**

Add a backend test for a `VAULT_PROPOSE` marker formatter and a UI contract assertion that the renderer
knows `VAULT_PROPOSE`.

- [ ] **Step 2: Run tests and verify RED**

Run backend targeted test and `npm run test:ui-contract`.

- [ ] **Step 3: Implement marker formatter and renderer stub**

Use marker shape:

```text
‹‹VAULT_PROPOSE››{"category":"payments","label":"Carta personale","redacted_preview":"[VAULT:payments:card:last4=1111]"}‹‹/VAULT_PROPOSE››
```

Renderer may initially show a compact card with Accept / Dismiss disabled or wired to no-op endpoints.

- [ ] **Step 4: Run tests**

Run targeted backend test and `npm run test:ui-contract`.

- [ ] **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/main.rs apps/desktop/src apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat: render vault proposal cards"
```

## Task 5: Payment Approval Policy Skeleton

**Files:**
- Modify: `crates/vault/src/types.rs`
- Create: `crates/vault/src/payment.rs`
- Modify: `crates/vault/src/lib.rs`
- Test: `crates/vault/src/payment.rs`

- [ ] **Step 1: Write failing payment invalidation tests**

Test that an approval snapshot becomes invalid if merchant, domain, amount, currency, product summary,
payment method, or checkout fingerprint changes.

- [ ] **Step 2: Run tests and verify RED**

Run: `cargo test -p local-first-vault payment_approval_invalidates_on_checkout_change`

- [ ] **Step 3: Implement payment approval comparison**

Add `PaymentApprovalSnapshot`, `PaymentApprovalDecision`, and `validate_payment_approval`.

- [ ] **Step 4: Run tests**

Run: `cargo test -p local-first-vault`

- [ ] **Step 5: Commit**

```bash
git add crates/vault
git commit -m "feat: add payment approval policy"
```

## Task 6: Browser Final-Click Block

**Files:**
- Modify: `crates/desktop-gateway/src/browser_safety.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Test: existing backend tests near browser safety.

- [ ] **Step 1: Write failing final-payment-click tests**

Test that click actions with labels like `Paga`, `Pay`, `Compra`, `Purchase`, `Conferma acquisto`
are blocked unless a matching payment approval id is present.

- [ ] **Step 2: Run tests and verify RED**

Run targeted browser safety test.

- [ ] **Step 3: Implement conservative block**

Extend browser safety classification to flag final payment clicks and return a message that a
Payment Approval Card is required.

- [ ] **Step 4: Run tests**

Run targeted backend test and `cargo test -p local-first-desktop-gateway browser_safety`.

- [ ] **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/browser_safety.rs crates/desktop-gateway/src/main.rs
git commit -m "feat: gate final payment browser actions"
```

## Task 7: Docs And Architecture Sync

**Files:**
- Create: `docs/architecture/vault.md`
- Modify: `docs/architecture/memory.md`
- Modify: `docs/architecture/browser.md`
- Modify: `docs/STATO.md`

- [ ] **Step 1: Add architecture map**

Document Vault boundaries, memory redaction, approval flow, and non-goals.

- [ ] **Step 2: Run doc checks**

Run: `rg -n "Vault|VAULT_PROPOSE|Payment Approval" docs/architecture docs/STATO.md`

- [ ] **Step 3: Commit**

```bash
git add docs/architecture docs/STATO.md
git commit -m "docs: map vault and payment approval architecture"
```

## Self-Review

- Spec coverage: Tasks cover classifier/redaction, Vault separation, store skeleton, proposal UI,
  payment approval policy, final-click block, and docs.
- Deferred from MVP implementation plan: real Keychain persistence, full Vault settings UI, Telegram
  delivery, and real checkout e2e. These require the skeleton and policy gates first.
- Placeholder scan: no task depends on unspecified behavior; each task has a concrete failing test target.
- Type consistency: `VaultCategory`, `SensitiveClassification`, `VAULT_PROPOSE`, and
  `PaymentApprovalSnapshot` names are stable across tasks.
