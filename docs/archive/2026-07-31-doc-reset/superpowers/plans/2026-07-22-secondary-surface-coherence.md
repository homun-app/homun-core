# Secondary Surface Coherence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conservare identità publisher nelle skill e mostrare provenienza/freschezza reale nelle card proattive.

**Architecture:** Le skill usano sempre `owner_handle + slug`; la preview rende la stessa identità usata per installare. Le suggestion persistono source e scadenza e il client filtra con una funzione pura.

**Tech Stack:** Rust, SQLite, React 19, TypeScript, Node test runner.

---

## File structure

- Modify `apps/desktop/src/components/SettingsView.tsx` and `lib/skillCatalogState.*`.
- Modify `crates/desktop-gateway/src/{chat_store.rs,main.rs}`: suggestion provenance.
- Create `apps/desktop/src/lib/proactivityFreshness.{mjs,ts}` and test.
- Modify `apps/desktop/src/{lib/coreBridge.ts,components/ProattivitaView.tsx}` and i18n.

### Task 1: Mostrare il publisher nella preview skill

**Files:**
- Modify: `apps/desktop/src/lib/skillCatalogState.mjs`
- Modify: `apps/desktop/src/lib/skillCatalogState.test.mjs`
- Modify: `apps/desktop/src/components/SettingsView.tsx`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Write RED identity test**

```js
import { catalogDisplayIdentity } from "./skillCatalogState.mjs";
test("preview identity keeps publisher", () => {
  assert.equal(catalogDisplayIdentity({ slug: "weather", owner_handle: "steipete" }), "@steipete/weather");
});
```

- [ ] **Step 2: Run RED**

Run: `cd apps/desktop && node --test src/lib/skillCatalogState.test.mjs`

- [ ] **Step 3: Implement and render**

```js
export const catalogDisplayIdentity = (skill) => skill.owner_handle ? `@${skill.owner_handle}/${skill.slug}` : skill.slug;
```

Render this value in `CatalogPreviewModal` header and use `preview.owner_handle ?? target.owner_handle` so loading/error states do not lose it. Add a UI contract assertion for `catalogDisplayIdentity(target)`.

- [ ] **Step 4: Verify and commit**

```bash
cd apps/desktop
node --test src/lib/skillCatalogState.test.mjs
npm run test:ui-contract
npm run build
git add src/lib/skillCatalogState.mjs src/lib/skillCatalogState.test.mjs src/components/SettingsView.tsx scripts/check-ui-contract.mjs
git commit -m "fix(skills): keep publisher visible in preview"
```

### Task 2: Persistire source e scadenza delle suggestion

**Files:**
- Modify: `crates/desktop-gateway/src/chat_store.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Write RED round-trip test**

```rust
#[test]
fn suggestion_roundtrip_keeps_source_and_expiry() {
    let store = ChatStore::in_memory().unwrap();
    let id = store.insert_suggestion(&SuggestionInput {
        scope: "workspace_test".into(),
        kind: "info".into(),
        title: "Fresh signal".into(),
        body: "A bounded suggestion".into(),
        rationale: "Recent task evidence".into(),
        proposed_action: None,
        choices: None,
        dedup_key: "fresh-signal".into(),
        relevant_until: Some(2_000_000_000),
        source_ref: "supervisor:daily".into(),
    }).unwrap();
    let row = store.suggestion(id).unwrap().unwrap();
    assert_eq!(row.source_ref, "supervisor:daily");
    assert_eq!(row.relevant_until, Some(2_000_000_000));
}
```

- [ ] **Step 2: Run RED**

Run: `cargo test -p local-first-desktop-gateway suggestion_roundtrip_keeps_source -- --nocapture`

- [ ] **Step 3: Add fields to schema and every SELECT**

Add `source_ref TEXT NOT NULL DEFAULT 'supervisor'`, retain existing `relevant_until`, extend `SuggestionInput`, `SuggestionRow`, `map_suggestion`, insert/list/detail queries and every constructor. The API serializes `generated_at=created_at`, `source_ref`, `relevant_until`.

- [ ] **Step 4: Run GREEN and commit**

```bash
cargo test -p local-first-desktop-gateway suggestion_ -- --nocapture
cargo test -p local-first-desktop-gateway proactive_ -- --nocapture
git add crates/desktop-gateway/src/chat_store.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(proactivity): expose suggestion provenance and expiry"
```

### Task 3: Filtrare e spiegare la freschezza nel client

**Files:**
- Create: `apps/desktop/src/lib/proactivityFreshness.mjs`
- Create: `apps/desktop/src/lib/proactivityFreshness.ts`
- Create: `apps/desktop/src/lib/proactivityFreshness.test.mjs`
- Modify: `apps/desktop/src/lib/coreBridge.ts`
- Modify: `apps/desktop/src/components/ProattivitaView.tsx`
- Modify: `apps/desktop/src/i18n/locales/{it,en,fr,de,es}.json`

- [ ] **Step 1: Write RED tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { freshness } from "./proactivityFreshness.mjs";
test("expired cards are hidden and old cards are labelled", () => {
  assert.equal(freshness({ generated_at: 100, relevant_until: 150 }, 151), "expired");
  assert.equal(freshness({ generated_at: 100, relevant_until: null }, 100 + 8 * 86400), "stale");
});
```

- [ ] **Step 2: Run RED and implement**

```js
export function freshness(card, now) {
  if (card.relevant_until != null && card.relevant_until < now) return "expired";
  return now - card.generated_at > 7 * 86400 ? "stale" : "fresh";
}
```

- [ ] **Step 3: Wire UI and verify**

Filter `expired`, label `stale` as non-current, and show localized source + relative generated time on every card.

```bash
cd apps/desktop
node --test src/lib/proactivityFreshness.test.mjs
npm run build
git add src/lib/proactivityFreshness.mjs src/lib/proactivityFreshness.ts src/lib/proactivityFreshness.test.mjs src/lib/coreBridge.ts src/components/ProattivitaView.tsx src/i18n/locales
git commit -m "fix(proactivity): hide expired and label stale suggestions"
```
