# Residui triage + Fluidità UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chiudere i residui aperti del triage 2026-07-23 (safety/correttezza) e poi portare la UI desktop da "poco fluida" a fluida quanto i competitor Electron (Codex/ChatGPT), rimuovendo le cause misurate di jank.

**Architecture:** Due parti sequenziali su un unico branch. **Parte A** (Task A1–A5) chiude i residui verificati nel codice — non tutto il triage, solo ciò che è ancora aperto. **Parte B** (Task B1–B9) attacca la fluidità in ordine di rapporto impatto/rischio: prima i fix a costo quasi zero e alto impatto percettivo (scroll, throttling, startup, polling), poi il costo per-frame dello streaming (markdown, memo), poi la virtualizzazione del transcript, infine bundle e convergenza dei trasporti. Ogni task è indipendentemente testabile e committabile.

**Tech Stack:** Rust (workspace Cargo), React 19 + Vite + TypeScript, Electron, `node --test` per il desktop, `vitest` per `runtimes/browser-automation`, `cargo test` per i crate.

## Stato verificato al 2026-07-24 (perché questo piano NON copre tutto il triage)

Verificato leggendo il codice, non i doc. **Già CHIUSO, nessun task previsto:**

| Item triage | Prova nel codice |
| --- | --- |
| CRITICAL A (grafie di Enter) | `browser_safety.rs:49` `ENTER_KEY_SPELLINGS` include `numpadenter`/`\n`/`\r`; `is_enter_spelling` gestisce i chord `Control+Enter`; `type_or_fill_submits` copre `submit`/text con newline finale/`commit` |
| CRITICAL B (`scroll` con ref cliccava) | `actions.ts:397-405` ora fa solo `scrollIntoViewIfNeeded`, commento cita "Critical B" |
| IMPORTANT C (OOPIF focus fail-open) | `payment_floor.test.ts:197-224` test cross-origin OOPIF reale (due host) |
| IMPORTANT D (focus context globale) | `main.rs:27113` sostituito il bool globale con mappa per-target |
| IMPORTANT E (`selector` fuori schema) | `main.rs:18417` `browser_action_execution_fields_are_schema_legal` rifiuta `selector` |
| IMPORTANT 3 (browse multi-linea troncata) | `browse.rs:291-324` serializzazione/parsing JSON |
| IMPORTANT 4 (`structuralDelta` naive) | `snapshot.ts:793-823` diff LCS sequence-aware + fallback ref-churn |
| IMPORTANT 5 (coordinator steering) | Build 2 (`c2304235`, `64047cf7`) |
| IMPORTANT 6 (status probe) | `turnStreamRecovery.mjs:61-79` retry con backoff |
| MINOR 8 (stale-ref budget) | `agent_loop.rs:856` + test `stale_ref_recovery_churn_still_trips_the_no_progress_budget` |
| MINOR 10 (falso negativo no-answer) | `browse.rs:25` `is_canonical_no_answer` |
| I2 sliver | `store.rs:2401-2415` park rilascia le righe `claimed` legate al run abortito |

**Residuo cosciente NON in piano** (decisione già presa, documentata): `press`/`press_key` con `Space` su un controllo di submit già focalizzato — gatare tutti gli Space sovra-gaterebbe la digitazione ordinaria.

## Global Constraints

- **Commenti in inglese, docs in italiano.** Ogni funzione non banale porta un commento sul **perché** (vincolo/invariante/gotcha), non sul cosa. API pubbliche dei crate con `///`.
- **Nessun trailer `Co-Authored-By`** nei commit. Nessun `git push` (solo commit locali).
- **Branch di lavoro:** `ui-fluidity-and-triage-residuals`, creato da `main`. Merge in `main` solo nel Task finale.
- **Converge, non duplicare:** mai una terza implementazione; si cabla la canonica e si ritira la parallela.
- **Limiti di file:** soft ~1500 righe, hard ~2500. `ChatView.tsx` (9.4k) e `main.rs` (60k) sono over-limit noti: ogni task che li tocca deve estrarre, mai accrescere.
- **TDD:** ogni task scrive prima il test che fallisce, poi l'implementazione minima.
- **Gate obbligatori prima del merge finale:** `cargo test -p local-first-desktop-gateway`, `cargo test -p local-first-engine`, `npm run test:ui-contract`, `npm run test:electron`, `npm run build`, `python3 scripts/pre_release_gate.py`.
- **Comandi:** i comandi Rust si eseguono da `app/`; quelli npm da `app/apps/desktop`; vitest da `app/runtimes/browser-automation`.

---

## Task 0: Branch di lavoro

**Files:** nessuno (solo git).

- [ ] **Step 1: Creare il branch**

```bash
cd /Users/fabio/Projects/Homun/app && git checkout -b ui-fluidity-and-triage-residuals
```

- [ ] **Step 2: Verificare di essere sul branch pulito**

Run: `git status --short --branch`
Expected: `## ui-fluidity-and-triage-residuals` e nessun file modificato.

---

# PARTE A — Residui del triage

## Task A1: `parked` è uno stato d'attesa, non un errore di recovery

**Contesto.** Build 2 ha introdotto lo stato durabile `parked` (turno in attesa che il modello torni). `recoverTurnStream` non lo conosce: `parked` non è in `DURABLE_TERMINAL` né in `DURABLE_HANDOFF`, quindi cade nel ramo `else` che incrementa `activeReconnects`. Con `maxActiveReconnects = 900` e i delay che saturano a 2000ms, un park di oltre ~30 minuti esaurisce il budget e solleva un `turn_stream_recovery_exhausted` **spurio**: il gateway sta ancora riprendendo il turno correttamente, ma il client mostra un errore. Il fix è insegnare al loop che `parked` è uno stato d'attesa a bassa frequenza, che non consuma il budget di progresso.

**Files:**
- Modify: `apps/desktop/src/lib/turnStreamRecovery.mjs`
- Test: `apps/desktop/src/lib/turnStreamRecovery.test.mjs` (creare se assente; se esiste, aggiungere i test in coda)

**Interfaces:**
- Consumes: `recoverTurnStream({turnId, connect, getStatus, onEvent, sleep, maxReconnects, maxActiveReconnects, reconnectDelays, initialState})`
- Produces: stesso export; nuovo comportamento — uno status `parked` non incrementa `activeReconnects` e usa il delay di attesa lungo `PARKED_DELAY_MS = 5000`.

- [ ] **Step 1: Scrivere il test che fallisce**

Aggiungere in `apps/desktop/src/lib/turnStreamRecovery.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { recoverTurnStream } from "./turnStreamRecovery.mjs";

test("a long park never exhausts the progress budget", async () => {
  let statusCalls = 0;
  const slept = [];
  const result = await recoverTurnStream({
    turnId: "turn-parked",
    maxActiveReconnects: 3,
    sleep: async (ms) => {
      slept.push(ms);
    },
    connect: async () => {},
    getStatus: async () => {
      statusCalls += 1;
      // Stay parked well past maxActiveReconnects, then deliver.
      return statusCalls > 10 ? { status: "completed" } : { status: "parked" };
    },
  });
  assert.equal(result.status, "completed");
  assert.ok(
    slept.some((ms) => ms >= 5000),
    `a parked turn must wait on the long delay, got ${JSON.stringify(slept)}`,
  );
});
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

Run (da `apps/desktop`): `node --test src/lib/turnStreamRecovery.test.mjs`
Expected: FAIL — `TurnStreamRecoveryError: Turn turn-parked made no stream progress while still parked after 3 reconnects.`

- [ ] **Step 3: Implementazione minima**

In `apps/desktop/src/lib/turnStreamRecovery.mjs`, dopo la riga `const DEFAULT_DELAYS = [100, 250, 500, 1000, 2000];` aggiungere:

```javascript
// A turn parked by the steering coordinator waits for the model to come back —
// minutes, sometimes longer. It is a low-frequency WAIT state, not a stalled
// stream: counting its empty reconnects against the progress budget surfaced a
// spurious recovery error while the gateway was still resuming correctly.
const DURABLE_WAITING = new Set(["parked"]);
const PARKED_DELAY_MS = 5_000;
```

Sostituire il blocco `} else {` (che azzera `terminalRecoveryAttempts` e gestisce `activeReconnects`) con:

```javascript
    } else if (DURABLE_WAITING.has(durableStatus.status)) {
      // Neither terminal nor stalled: poll slowly and leave both budgets alone.
      terminalRecoveryAttempts = 0;
      activeReconnects = 0;
      await sleep(PARKED_DELAY_MS);
      continue;
    } else {
```

- [ ] **Step 4: Eseguire i test**

Run (da `apps/desktop`): `node --test src/lib/turnStreamRecovery.test.mjs`
Expected: PASS, tutti i test del file (i preesistenti inclusi).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/turnStreamRecovery.mjs apps/desktop/src/lib/turnStreamRecovery.test.mjs && git commit -m "fix(desktop): a parked turn is a wait state, not a recovery failure"
```

---

## Task A2: timeout reale sul provider locale mistral.rs

**Contesto.** `GenerateJsonRequest` porta `request_timeout_seconds` e `wait_if_busy`, ma `MistralRsProvider::generate_json` (`crates/inference/src/mistralrs_provider.rs:90-110`) ignora entrambi: chiama `self.runtime.block_on(self.model.send_chat_request(...))` senza wrapper. Il bound dei 45s della decisione di steering non è quindi applicato sul percorso locale: una generazione locale bloccata blocca il worker dell'interprete a tempo indefinito. Il fix minimo e corretto è avvolgere la chiamata in `tokio::time::timeout` quando il campo è valorizzato.

**Files:**
- Modify: `crates/inference/src/mistralrs_provider.rs`
- Test: stesso file, modulo `#[cfg(test)]` in coda

**Interfaces:**
- Consumes: `GenerateJsonRequest.request_timeout_seconds: Option<f64>` (`crates/subagents/src/types.rs:274`)
- Produces: `fn timeout_duration(seconds: Option<f64>) -> Option<std::time::Duration>` — `None` se assente/non finito/<= 0; usato dal solo `generate_json`.

- [ ] **Step 1: Scrivere il test che fallisce**

In coda a `crates/inference/src/mistralrs_provider.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::timeout_duration;
    use std::time::Duration;

    #[test]
    fn timeout_duration_maps_only_positive_finite_seconds() {
        assert_eq!(timeout_duration(Some(45.0)), Some(Duration::from_secs(45)));
        assert_eq!(timeout_duration(Some(0.5)), Some(Duration::from_millis(500)));
        // No bound configured, or a nonsense bound, must never become a 0s timeout
        // that fails every request instantly — it means "no timeout".
        assert_eq!(timeout_duration(None), None);
        assert_eq!(timeout_duration(Some(0.0)), None);
        assert_eq!(timeout_duration(Some(-1.0)), None);
        assert_eq!(timeout_duration(Some(f64::NAN)), None);
        assert_eq!(timeout_duration(Some(f64::INFINITY)), None);
    }
}
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

Run: `cargo test -p local-first-inference timeout_duration -- --nocapture`
Expected: FAIL in compilazione — `cannot find function timeout_duration in this scope`.

- [ ] **Step 3: Implementazione minima**

In `crates/inference/src/mistralrs_provider.rs`, prima di `impl InferenceProvider for MistralRsProvider`:

```rust
/// The caller's timeout bound (e.g. the steering decision's 45s) as a `Duration`.
/// A missing, non-finite or non-positive value means "no bound" — never a zero
/// timeout, which would fail every request instantly.
fn timeout_duration(seconds: Option<f64>) -> Option<std::time::Duration> {
    seconds
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(std::time::Duration::from_secs_f64)
}
```

Sostituire il `block_on` in `generate_json` con:

```rust
        let request_future = self.model.send_chat_request(messages);
        let outcome = match timeout_duration(request.request_timeout_seconds) {
            // Without this the caller's bound was advisory only: a hung local
            // generation held the interpreter worker forever (triage MINOR 7).
            Some(bound) => self
                .runtime
                .block_on(async { tokio::time::timeout(bound, request_future).await })
                .unwrap_or_else(|_| {
                    Err(anyhow::anyhow!("local generation exceeded {bound:?}"))
                }),
            None => self.runtime.block_on(request_future),
        };
        let response = match outcome {
```

Mantenere invariato il blocco `Ok(response) => response, Err(error) => {...}` che segue.

- [ ] **Step 4: Eseguire i test**

Run: `cargo test -p local-first-inference -- --nocapture`
Expected: PASS. Se il tipo d'errore di `send_chat_request` non è `anyhow::Error`, sostituire `anyhow::anyhow!` con il costruttore d'errore corretto letto dal ramo `Err(error)` esistente e ripetere.

- [ ] **Step 5: Commit**

```bash
git add crates/inference/src/mistralrs_provider.rs && git commit -m "fix(inference): enforce the caller's timeout on the local mistral.rs provider"
```

---

## Task A3: guardia su delta + role-filter (rif parsati da un delta)

**Contesto.** In `snapshot.ts:418-424`, con `observedMode === "delta"` la snapshot osservata diventa un diff con righe prefissate `+ `/`- `. Alla riga 424, se `roleOptions` è attivo, i ref vengono riparsati **dalla snapshot osservata** (`refsFromAiSnapshot(snapshot)`), la cui regex si ancora su `^\s*-`: su un delta questo produce zero ref (o peggio, ref presi da righe **rimosse**). Oggi lo schema non espone le due opzioni insieme, quindi è latente — ma è esattamente il tipo di combinazione che un refactor futuro abilita in silenzio. La guardia: quando la modalità è delta, i ref vengono sempre da `builtSnapshot.refs` (costruiti sulla snapshot piena), mai riparsati dal testo del delta.

**Files:**
- Modify: `runtimes/browser-automation/src/browser/snapshot.ts:424`
- Test: `runtimes/browser-automation/tests/snapshot_delta_refs.test.ts` (creare)

**Interfaces:**
- Consumes: `structuralDelta(previous, current)`, `refsFromAiSnapshot(snapshot)`, `buildRoleSnapshotFromAiSnapshot(...)` (interni al modulo)
- Produces: nessuna nuova API pubblica; solo l'invariante "in modalità delta i ref non vengono mai parsati dal testo del delta".

- [ ] **Step 1: Scrivere il test che fallisce**

Creare `runtimes/browser-automation/tests/snapshot_delta_refs.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { structuralDelta } from "../src/browser/snapshot";

describe("delta observation never yields parseable refs", () => {
  it("prefixes every delta line so the ref regex cannot match it", () => {
    const previous = `- button "Pay" [ref=e1]`;
    const current = `- button "Pay" [ref=e1]\n- button "Cancel" [ref=e2]`;
    const delta = structuralDelta(previous, current);
    // The ref regex anchors on `^\s*-`; a delta line starts with `+ ` or `- `
    // followed by the original `- `. Any line that still looks like a raw
    // snapshot line would be silently parsed as a live ref.
    for (const line of delta.split("\n").filter(Boolean)) {
      expect(line.startsWith("+ ") || line.startsWith("- ")).toBe(true);
    }
    expect(delta).toContain("Cancel");
  });
});
```

- [ ] **Step 2: Eseguire il test e verificare lo stato**

Run (da `runtimes/browser-automation`): `npx vitest run tests/snapshot_delta_refs.test.ts`
Expected: PASS se `structuralDelta` è già esportata; FAIL con errore di import se non lo è — in quel caso aggiungere `export` alla dichiarazione di `structuralDelta` (è già `export function` alla riga 793: il test passa e documenta l'invariante di formato).

- [ ] **Step 3: Aggiungere la guardia**

In `snapshot.ts`, sostituire la riga 424:

```typescript
  const refs = roleOptions ? refsFromAiSnapshot(snapshot) : builtSnapshot.refs;
```

con:

```typescript
  // A delta is `+`/`-`-prefixed diff text, not a snapshot: re-parsing refs out of
  // it yields zero refs (the ref regex anchors on `^\s*-`) or, worse, refs taken
  // from REMOVED lines. Refs always come from the full built snapshot in that
  // mode. Unreachable via today's schema (delta and role-filter are never
  // combined) — this is the guard that keeps it unreachable.
  const refs =
    roleOptions && observedMode !== "delta" ? refsFromAiSnapshot(snapshot) : builtSnapshot.refs;
```

- [ ] **Step 4: Eseguire la suite**

Run (da `runtimes/browser-automation`): `npx vitest run`
Expected: PASS, nessuna regressione.

- [ ] **Step 5: Commit**

```bash
git add runtimes/browser-automation/src/browser/snapshot.ts runtimes/browser-automation/tests/snapshot_delta_refs.test.ts && git commit -m "fix(browser): never parse refs out of a delta observation"
```

---

## Task A4: `NeedsClarification` non sintetizza una risposta

**Contesto.** `agent_loop.rs` gestisce `TurnControlDisposition::NeedsClarification` esattamente come `FinalizeWithCurrentEvidence`: `break 'rounds` con `final_done = false` (righe 265, 450, 999). Il risultato è che il turno esce dal loop e finisce nella **sintesi forzata**, che produce una risposta normale — mentre la disposizione dice il contrario: il modello ha bisogno di una domanda di chiarimento all'utente. Il fix minimo e onesto: portare la disposizione fino al `TurnOutcome` così che il chiamante possa distinguerla, invece di appiattirla su "finalizza".

**Files:**
- Modify: `crates/engine/src/agent_loop.rs` (i tre `match` sulle disposizioni + la costruzione di `TurnOutcome`)
- Modify: `crates/engine/src/contract.rs` (campo su `TurnOutcome`)
- Test: `crates/engine/src/agent_loop.rs`, modulo `tests`

**Interfaces:**
- Consumes: `TurnControlDisposition::NeedsClarification`
- Produces: `TurnOutcome.needs_clarification: bool` — `true` quando il turno è uscito perché una steering chiedeva chiarimento. Default `false` (`#[serde(default)]`), quindi ogni costruttore esistente resta valido.

- [ ] **Step 1: Scrivere il test che fallisce**

Nel modulo `tests` di `crates/engine/src/agent_loop.rs`:

```rust
    #[test]
    fn needs_clarification_disposition_is_visible_on_the_outcome() {
        // The loop must not flatten "ask the user" into "finalize with what you
        // have": the caller cannot tell a real answer from a swallowed question.
        let outcome = TurnOutcome { needs_clarification: true, ..TurnOutcome::default() };
        assert!(outcome.needs_clarification);
    }
```

- [ ] **Step 2: Eseguire e verificare il fallimento**

Run: `cargo test -p local-first-engine needs_clarification_disposition -- --nocapture`
Expected: FAIL in compilazione — `struct TurnOutcome has no field named needs_clarification`.

- [ ] **Step 3: Aggiungere il campo e valorizzarlo**

In `crates/engine/src/contract.rs`, dentro `pub struct TurnOutcome`, aggiungere:

```rust
    /// True when the turn stopped because a steering decision asked to CLARIFY with
    /// the user, not because it had a deliverable answer. The loop must not flatten
    /// this into an ordinary finalize: the caller decides whether to park with the
    /// question instead of synthesizing prose (triage MINOR 9).
    #[serde(default)]
    pub needs_clarification: bool,
```

In `crates/engine/src/agent_loop.rs`, dichiarare accanto a `let mut final_done`:

```rust
    let mut needs_clarification = false;
```

Nei tre `match` sulle disposizioni, separare il ramo:

```rust
                TurnControlDisposition::FinalizeWithCurrentEvidence => break 'rounds,
                TurnControlDisposition::NeedsClarification => {
                    needs_clarification = true;
                    break 'rounds;
                }
```

Nella costruzione del `TurnOutcome` finale, aggiungere `needs_clarification,` ai campi.

- [ ] **Step 4: Eseguire i test**

Run: `cargo test -p local-first-engine -- --nocapture`
Expected: PASS. Se un costruttore letterale di `TurnOutcome` fuori dai `..Default::default()` fallisce, aggiungere `needs_clarification: false` a quel letterale.

- [ ] **Step 5: Verificare che il gateway compili**

Run: `cargo build -p local-first-desktop-gateway`
Expected: OK.

- [ ] **Step 6: Commit**

```bash
git add crates/engine/src/agent_loop.rs crates/engine/src/contract.rs && git commit -m "fix(engine): needs-clarification is visible on the turn outcome, not flattened into finalize"
```

---

## Task A5: allineare STATO.md al codice

**Contesto.** `docs/STATO.md` è fermo al 2026-07-22: non riflette Build 2 (park+resume), Build 3 (progresso da segnali macchina), il CHANGELOG come sorgente unica, il gate fail-closed sull'executor durevole, né lo stato reale del triage. Il contratto di metodologia (§6) impone che sia il documento vivo da cui si riparte.

**Files:**
- Modify: `docs/STATO.md` (inserire il nuovo checkpoint sopra quello del 2026-07-22, aggiornare la riga "Ultimo aggiornamento")

- [ ] **Step 1: Aggiornare l'intestazione**

Sostituire `> **Ultimo aggiornamento: 2026-07-22.**` con `> **Ultimo aggiornamento: 2026-07-24.**`.

- [ ] **Step 2: Inserire il checkpoint**

Subito prima della riga `## ⭐ CHECKPOINT 2026-07-22 — Interfaccia task stabile, gate app installata`, inserire:

```markdown
## ⭐ CHECKPOINT 2026-07-24 — Browser Build 1/2/3, steering park+resume, changelog

Tre archi mergiati in `main` (`af76ce01`). **Steering park+resume:** un turno che perde il modello
viene parcheggiato (stato `Parked`, bolla assistant aperta, risorse e lease rilasciati) e ripreso dal
coordinator alla ripresa del modello; la cancellazione di un turno parcheggiato finalizza la bolla.
Chiusi i due CRITICAL steering del triage: soglia di confidence rimossa dal percorso steering,
fallback di autenticazione esteso oltre il solo 401. **Browser Build 3:** il progresso si classifica
da segnali macchina, non dalla prosa del risultato; il wall-clock è una finestra di stallo che si
resetta sul progresso più un cap assoluto; selezione dagli autocomplete non-ARIA. **Release:**
`CHANGELOG.md` è la sorgente unica delle release notes, versione `0.1.1079`. **Gate pagamenti:**
l'executor browser durevole (`capability.browser.*`) è fail-closed, chiudendo il buco per cui le
automazioni bypassavano l'intero gate.

**Residui triage chiusi in questa sessione:** `parked` come stato d'attesa nella recovery desktop;
timeout applicato sul provider locale mistral.rs; guardia sui ref in modalità delta;
`needs_clarification` visibile sul `TurnOutcome`.

**Residuo cosciente (non un difetto):** `press`/`press_key` con `Space` su un controllo di submit già
focalizzato non è classificato committing — gatare tutti gli `Space` sovra-gaterebbe la digitazione.
```

- [ ] **Step 3: Commit**

```bash
git add docs/STATO.md && git commit -m "docs: STATO allineato a Build 1/2/3, park+resume e residui triage"
```

---

# PARTE B — Fluidità UI

## Task B1: lo scroll di streaming non è animato

**Contesto — la causa n°1 percepita.** `.thread-scroll` dichiara `scroll-behavior: smooth` (`styles.css:3897`) e `scrollConversationToBottom` chiama `node.scrollTo({top, behavior})` con `behavior: "auto"` (`ChatView.tsx:1044`, chiamato da `afterStreamingFramePaint` a `ChatView.tsx:1075`). Per la spec CSSOM-View `behavior: "auto"` **eredita il valore calcolato di `scroll-behavior`**, cioè `smooth`: ogni flush rAF avvia una nuova animazione di scroll che il frame successivo (~16ms dopo) interrompe e riavvia. La viewport insegue perennemente il testo con effetto elastico. Il salto esplicito col bottone (`ChatView.tsx:3179`) deve invece restare `smooth`.

**Files:**
- Modify: `apps/desktop/src/components/ChatView.tsx:1074-1076`
- Modify: `apps/desktop/src/styles.css:3897`
- Test: `apps/desktop/tests/streaming-scroll.test.mjs` (creare)

**Interfaces:**
- Consumes: `scrollConversationToBottomIfPinned(behavior: ScrollBehavior)`
- Produces: nessuna nuova API. Invariante: durante lo streaming il behavior è `"instant"`; il salto manuale resta `"smooth"`.

- [ ] **Step 1: Scrivere il test che fallisce**

Creare `apps/desktop/tests/streaming-scroll.test.mjs` (test di contratto sul sorgente, stesso stile di `gateway-startup-order.test.mjs`):

```javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const chatView = readFileSync(join(here, "..", "src", "components", "ChatView.tsx"), "utf8");
const styles = readFileSync(join(here, "..", "src", "styles.css"), "utf8");

test("the streaming auto-scroll is instant, never animated", () => {
  // `behavior: "auto"` RESOLVES to the element's computed scroll-behavior. With
  // `smooth` on .thread-scroll, every rAF flush restarted a scroll animation the
  // next frame cancelled — the viewport permanently trailed the text.
  assert.match(
    chatView,
    /function afterStreamingFramePaint\(\)\s*\{\s*scrollConversationToBottomIfPinned\("instant"\);/,
    "afterStreamingFramePaint must scroll with instant",
  );
});

test("the thread scroller does not declare smooth scroll-behavior", () => {
  const block = styles.slice(styles.indexOf(".thread-scroll {"));
  const firstRule = block.slice(0, block.indexOf("}"));
  assert.doesNotMatch(firstRule, /scroll-behavior:\s*smooth/, ".thread-scroll must not be smooth");
});

test("the explicit jump-to-bottom button stays smooth", () => {
  assert.match(chatView, /scrollConversationToBottom\("smooth"\)/, "the manual jump stays animated");
});
```

- [ ] **Step 2: Eseguire e verificare il fallimento**

Run (da `apps/desktop`): `node --test tests/streaming-scroll.test.mjs`
Expected: FAIL sui primi due test.

- [ ] **Step 3: Implementazione**

In `ChatView.tsx` sostituire:

```typescript
  function afterStreamingFramePaint() {
    scrollConversationToBottomIfPinned("auto");
  }
```

con:

```typescript
  function afterStreamingFramePaint() {
    // "instant", never "auto": per CSSOM-View, "auto" resolves to the element's
    // computed scroll-behavior, so with a smooth scroller every rAF flush started
    // an animation the next frame cancelled — the viewport trailed the text and
    // rubber-banded for the whole answer.
    scrollConversationToBottomIfPinned("instant");
  }
```

In `styles.css`, dentro `.thread-scroll`, rimuovere la riga `scroll-behavior: smooth;`.

Verificare che gli altri usi di `scrollConversationToBottomIfPinned("auto")`/`scrollConversationToBottom("auto")` nel file diventino `"instant"` **solo** quando sono su percorso di streaming o di primo caricamento del thread; il salto del bottone (`ChatView.tsx:3179`) resta `"smooth"`.

Run per elencarli: `grep -n 'scrollConversationToBottom' apps/desktop/src/components/ChatView.tsx`

- [ ] **Step 4: Eseguire i test**

Run (da `apps/desktop`): `node --test tests/streaming-scroll.test.mjs && npm run test:ui-contract && npm run build`
Expected: PASS su tutti.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/ChatView.tsx apps/desktop/src/styles.css apps/desktop/tests/streaming-scroll.test.mjs && git commit -m "fix(desktop): the streaming auto-scroll is instant, not an animation restarted every frame"
```

---

## Task B2: la finestra non si congela in background, e non lampeggia all'avvio

**Contesto.** Tutto il rendering dello streaming è appeso a `requestAnimationFrame`. Electron applica il `backgroundThrottling` di default: con la finestra occlusa o non a fuoco, rAF scende a ~1Hz, quindi lo streaming si congela e poi "scatta" al ritorno. Codex disabilita esplicitamente il throttling. Inoltre `createWindow` (`main.cjs:483`) apre subito la finestra con `backgroundColor: "#ffffff"` fisso: chi usa il tema scuro vede un flash bianco. Il pattern corretto è `show: false` + `ready-to-show`.

**Files:**
- Modify: `apps/desktop/electron/main.cjs:483-525`
- Test: `apps/desktop/tests/window-fluidity.test.mjs` (creare)

**Interfaces:**
- Consumes: `createWindow()`
- Produces: nessuna nuova API. Invarianti: `webPreferences.backgroundThrottling === false`; la finestra nasce `show: false` e viene mostrata su `ready-to-show`.

- [ ] **Step 1: Scrivere il test che fallisce**

Creare `apps/desktop/tests/window-fluidity.test.mjs`:

```javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, "..", "electron", "main.cjs"), "utf8");

test("the renderer is never background-throttled", () => {
  // The whole streaming render is gated on requestAnimationFrame; the default
  // throttling drops it to ~1Hz when the window is occluded, so the answer
  // freezes and then bursts on refocus.
  assert.match(main, /backgroundThrottling:\s*false/);
});

test("the window is revealed only once it can paint", () => {
  assert.match(main, /show:\s*false/, "the window must not be shown before first paint");
  assert.match(main, /once\(["']ready-to-show["']/, "reveal on ready-to-show");
});
```

- [ ] **Step 2: Eseguire e verificare il fallimento**

Run (da `apps/desktop`): `node --test tests/window-fluidity.test.mjs`
Expected: FAIL su entrambi.

- [ ] **Step 3: Implementazione**

In `main.cjs`, dentro `new BrowserWindow({...})`:
- sostituire `backgroundColor: "#ffffff",` con `backgroundColor: startupBackgroundColor(),`
- aggiungere `show: false,` subito dopo `title: "Homun",`
- dentro `webPreferences`, aggiungere come prima proprietà:

```javascript
      // The renderer paints streamed tokens from a requestAnimationFrame loop.
      // Electron's default throttling drops rAF to ~1Hz for an occluded window,
      // which freezes the answer mid-stream and bursts it on refocus.
      backgroundThrottling: false,
```

Subito dopo `mainWindows.add(window);` aggiungere:

```javascript
  // Reveal only once the renderer can actually paint: showing an empty window
  // first produced a white flash before the themed UI arrived.
  window.once("ready-to-show", () => {
    window.show();
  });
```

Prima di `function createWindow()` aggiungere:

```javascript
/// The window's pre-paint fill. Matching the persisted theme keeps the reveal
/// from flashing white for dark-theme users; light is the app default.
function startupBackgroundColor() {
  try {
    return nativeTheme.shouldUseDarkColors ? "#101114" : "#fcfcfd";
  } catch {
    return "#fcfcfd";
  }
}
```

Verificare che `nativeTheme` sia importato da `electron` in cima al file; se non lo è, aggiungerlo alla destrutturazione esistente.

- [ ] **Step 4: Eseguire i test**

Run (da `apps/desktop`): `node --test tests/window-fluidity.test.mjs && npm run test:electron`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main.cjs apps/desktop/tests/window-fluidity.test.mjs && git commit -m "feat(desktop): no background throttling, and reveal the window only when it can paint"
```

---

## Task B3: il polling operativo non ricrea l'intero elenco chat ogni 2,5 s

**Contesto.** `refreshChatReadModels` (`App.tsx:1414-1417`) chiama `setChatThreads(mappedThreads)` **incondizionatamente**: un array nuovo di oggetti nuovi ogni 2,5 secondi, anche quando nulla è cambiato. I messaggi hanno già una riconciliazione identity-preserving (`uiSnapshot.ts:39-48`), i thread no. Il risultato: `activeThread` memo produce un oggetto nuovo → App + Sidebar (2032 righe) + Shell + ChatView si ri-renderizzano — **anche durante lo streaming**, iniettando un singhiozzo periodico sopra il loop rAF.

**Files:**
- Modify: `apps/desktop/src/lib/uiSnapshot.ts` (aggiungere il riconciliatore dei thread accanto a quelli esistenti)
- Modify: `apps/desktop/src/App.tsx:1414-1417`
- Test: `apps/desktop/src/lib/uiSnapshot.test.mjs` (creare se assente; altrimenti aggiungere in coda)

**Interfaces:**
- Consumes: `mapCoreChatThread` (App.tsx), il tipo `ChatThread` già usato da `setChatThreads`
- Produces: `reconcileChatThreads(previous, next)` — ritorna **`previous` per identità** quando ogni thread è profondamente uguale; altrimenti un array nuovo che riusa gli oggetti thread invariati.

- [ ] **Step 1: Scrivere il test che fallisce**

In `apps/desktop/src/lib/uiSnapshot.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { reconcileChatThreads } from "./uiSnapshot.ts";

test("an unchanged poll keeps the previous array identity", () => {
  const previous = [{ threadId: "a", title: "One" }, { threadId: "b", title: "Two" }];
  const next = [{ threadId: "a", title: "One" }, { threadId: "b", title: "Two" }];
  // Identity matters, not equality: a fresh array re-renders App, Sidebar, Shell
  // and ChatView every 2.5s, mid-stream.
  assert.strictEqual(reconcileChatThreads(previous, next), previous);
});

test("a changed thread yields a new array but reuses the untouched objects", () => {
  const previous = [{ threadId: "a", title: "One" }, { threadId: "b", title: "Two" }];
  const next = [{ threadId: "a", title: "One" }, { threadId: "b", title: "Renamed" }];
  const result = reconcileChatThreads(previous, next);
  assert.notStrictEqual(result, previous);
  assert.strictEqual(result[0], previous[0], "the untouched thread keeps its identity");
  assert.equal(result[1].title, "Renamed");
});
```

Se il file di test non può importare un `.ts`, replicare il pattern del test esistente più vicino in `apps/desktop/src/lib/` (verificare con `ls apps/desktop/src/lib/*.test.mjs`); se i test lì testano moduli `.mjs`, spostare la funzione in `apps/desktop/src/lib/uiSnapshot.reconcile.mjs` e importarla sia dal test sia da `uiSnapshot.ts`.

- [ ] **Step 2: Eseguire e verificare il fallimento**

Run (da `apps/desktop`): `node --test src/lib/uiSnapshot.test.mjs`
Expected: FAIL — `reconcileChatThreads is not a function`.

- [ ] **Step 3: Implementazione**

Aggiungere in `apps/desktop/src/lib/uiSnapshot.ts` (accanto ai riconciliatori esistenti, stesso stile):

```typescript
/// Identity-preserving reconciliation for the thread list, mirroring what
/// `reconcileMessages` already does for messages. The operational poll runs every
/// 2.5s: without this, each tick handed React a brand-new array of brand-new
/// objects, re-rendering App/Sidebar/Shell/ChatView even mid-stream.
export function reconcileChatThreads<T extends { threadId: string }>(
  previous: T[],
  next: T[],
): T[] {
  if (previous.length !== next.length) return next;
  const byId = new Map(previous.map((thread) => [thread.threadId, thread]));
  let changed = false;
  const merged = next.map((thread) => {
    const existing = byId.get(thread.threadId);
    if (existing && JSON.stringify(existing) === JSON.stringify(thread)) {
      return existing;
    }
    changed = true;
    return thread;
  });
  return changed ? merged : previous;
}
```

In `App.tsx`, importare `reconcileChatThreads` dal modulo e sostituire:

```typescript
    setChatThreads(mappedThreads.length ? mappedThreads : [defaultChatThread]);
```

con:

```typescript
    const desired = mappedThreads.length ? mappedThreads : [defaultChatThread];
    setChatThreads((current) => reconcileChatThreads(current, desired));
```

- [ ] **Step 4: Eseguire i test**

Run (da `apps/desktop`): `node --test src/lib/uiSnapshot.test.mjs && npm run build && npm run test:ui-contract`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/uiSnapshot.ts apps/desktop/src/lib/uiSnapshot.test.mjs apps/desktop/src/App.tsx && git commit -m "perf(desktop): the operational poll no longer re-creates the thread list every tick"
```

---

## Task B4: il markdown non si ri-parsa da capo a ogni frame

**Contesto.** `RichMessageRenderer` (`RichMessageRenderer.tsx:86-95`) esegue l'intera pipeline unified sul **testo accumulato completo** ogni volta che `text` cambia — cioè a ogni flush rAF, ~60 volte al secondo. Costo O(len) per frame → **O(len²) sul messaggio**. Due aggravanti immediate e a costo zero: `rehypePlugins={[rehypeSanitize]}` e `remarkPlugins={[remarkGfm]}` sono **letterali freschi a ogni render** (annullano il caching interno del processore), e `CodeBlock` rievidenzia l'intero blocco in crescita a ogni frame perché la chiave del memo è `[code, language]`.

Questo task chiude gli aggravanti e introduce il **rendering per-blocco**: il markdown viene spezzato in blocchi di primo livello; i blocchi già chiusi vengono memoizzati e non ri-renderizzati, solo l'ultimo (quello in crescita) viene ri-parsato.

**Files:**
- Create: `apps/desktop/src/lib/markdownBlocks.mjs`
- Modify: `apps/desktop/src/components/RichMessageRenderer.tsx`
- Test: `apps/desktop/src/lib/markdownBlocks.test.mjs`

**Interfaces:**
- Produces: `splitMarkdownBlocks(text: string): {key: string, text: string, closed: boolean}[]` — spezza su righe vuote di primo livello **senza** mai spezzare dentro un fence ```` ``` ````. L'ultimo blocco ha `closed: false` (può ancora crescere); tutti gli altri `closed: true`. `key` è `b<indice>`.

- [ ] **Step 1: Scrivere il test che fallisce**

Creare `apps/desktop/src/lib/markdownBlocks.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { splitMarkdownBlocks } from "./markdownBlocks.mjs";

test("splits on blank lines and marks every block but the last as closed", () => {
  const blocks = splitMarkdownBlocks("First para.\n\nSecond para.\n\nThird");
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks.map((b) => b.closed), [true, true, false]);
  assert.equal(blocks[0].text, "First para.");
  assert.equal(blocks[2].text, "Third");
});

test("never splits inside a fenced code block", () => {
  const text = "Intro\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nOutro";
  const blocks = splitMarkdownBlocks(text);
  assert.equal(blocks.length, 3);
  assert.ok(blocks[1].text.includes("const a = 1;"));
  assert.ok(blocks[1].text.includes("const b = 2;"), "the blank line inside the fence is kept");
});

test("an unterminated fence keeps everything after it in one growing block", () => {
  // Mid-stream the fence is still open: splitting it would render broken markup
  // for a frame and then re-flow, which reads as flicker.
  const blocks = splitMarkdownBlocks("Intro\n\n```js\nconst a = 1;\n\nconst b = 2;");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].closed, false);
});

test("stable keys let already-closed blocks keep their identity as text grows", () => {
  const first = splitMarkdownBlocks("A\n\nB");
  const later = splitMarkdownBlocks("A\n\nB\n\nC");
  assert.equal(first[0].key, later[0].key);
  assert.equal(first[0].text, later[0].text);
});
```

- [ ] **Step 2: Eseguire e verificare il fallimento**

Run (da `apps/desktop`): `node --test src/lib/markdownBlocks.test.mjs`
Expected: FAIL — modulo inesistente.

- [ ] **Step 3: Implementazione**

Creare `apps/desktop/src/lib/markdownBlocks.mjs`:

```javascript
/**
 * Split markdown into top-level blocks so a streaming message can re-render ONLY
 * its growing tail. The full unified pipeline used to run over the whole
 * accumulated text on every rAF flush — O(len) per frame, O(len²) per message.
 *
 * Blank lines are the split points, EXCEPT inside a fenced code block: a blank
 * line there is part of the code, and splitting on it would render broken markup
 * for a frame. An unterminated fence (the normal mid-stream state) therefore
 * swallows everything after it into the single growing tail block.
 */
export function splitMarkdownBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  let current = [];
  let inFence = false;

  const push = () => {
    const joined = current.join("\n").trim();
    if (joined.length > 0) blocks.push(joined);
    current = [];
  };

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      current.push(line);
      continue;
    }
    if (!inFence && line.trim() === "") {
      push();
      continue;
    }
    current.push(line);
  }
  push();

  return blocks.map((blockText, index) => ({
    key: `b${index}`,
    text: blockText,
    closed: index < blocks.length - 1,
  }));
}
```

In `RichMessageRenderer.tsx`:

Aggiungere in cima al file, fuori dal componente (istanze stabili — un letterale fresco a ogni render annulla il caching del processore):

```typescript
// Module-level, NOT inline literals: fresh arrays on every render defeat the
// unified processor's own caching and force a full re-parse each frame.
const REHYPE_PLUGINS = [rehypeSanitize];
const REMARK_PLUGINS = [remarkGfm];
```

Sostituire il corpo del `return` di `RichMessageRenderer` con:

```typescript
  const blocks = useMemo(() => splitMarkdownBlocks(normalizedText), [normalizedText]);

  return (
    <div className="rich-message">
      {blocks.map((block) => (
        <MarkdownBlock key={block.key} text={block.text} />
      ))}
    </div>
  );
}

/// One top-level markdown block. Memoized on its text alone, so every block that
/// has stopped growing is skipped entirely while the tail streams.
const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return (
    <ReactMarkdown
      components={markdownComponents}
      rehypePlugins={REHYPE_PLUGINS}
      remarkPlugins={REMARK_PLUGINS}
    >
      {text}
    </ReactMarkdown>
  );
});
```

Aggiungere l'import `import { splitMarkdownBlocks } from "../lib/markdownBlocks.mjs";` e assicurarsi che `memo` sia importato da `react`.

- [ ] **Step 4: Eseguire i test**

Run (da `apps/desktop`): `node --test src/lib/markdownBlocks.test.mjs && npm run build && npm run test:ui-contract && npm run test:electron`
Expected: PASS su tutti. Ispezionare visivamente che liste ed elementi multi-paragrafo restino corretti: una lista con righe vuote interne viene ora resa come blocchi separati — se il gate `test:ui-contract` o la resa evidenziano una regressione su liste "loose", estendere `splitMarkdownBlocks` per non spezzare tra righe che iniziano con `-`/`*`/`digit.` e aggiungere il test corrispondente.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/markdownBlocks.mjs apps/desktop/src/lib/markdownBlocks.test.mjs apps/desktop/src/components/RichMessageRenderer.tsx && git commit -m "perf(desktop): render markdown per block so streaming re-parses only the tail"
```

---

## Task B5: l'evidenziazione del codice non rielabora il blocco in crescita a ogni frame

**Contesto.** `CodeBlock` (`RichMessageRenderer.tsx:215-229`) memoizza su `[code, language]`, ma `code` cambia a ogni frame mentre il fence streamma: `lowlight.highlight` gira quindi sull'intero blocco in crescita ~60 volte al secondo. Un fence aperto va evidenziato solo quando smette di crescere.

**Files:**
- Modify: `apps/desktop/src/components/RichMessageRenderer.tsx` (componente `CodeBlock`)
- Test: `apps/desktop/src/lib/settledText.test.mjs`
- Create: `apps/desktop/src/lib/settledText.mjs`

**Interfaces:**
- Produces: `useSettledText(text: string, quietMs: number): string` — hook che ritorna il testo solo dopo che è rimasto invariato per `quietMs`; il primo valore è restituito subito.

- [ ] **Step 1: Scrivere il test che fallisce**

Creare `apps/desktop/src/lib/settledText.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { nextSettledValue } from "./settledText.mjs";

test("a value that keeps changing is never settled early", () => {
  // Highlighting a growing fence on every frame is the cost we are removing:
  // only a quiet block is worth syntax-highlighting.
  assert.equal(nextSettledValue({ current: "abc", settled: "", elapsedMs: 40, quietMs: 120 }), "");
});

test("a value quiet for long enough settles", () => {
  assert.equal(nextSettledValue({ current: "abc", settled: "", elapsedMs: 200, quietMs: 120 }), "abc");
});

test("the very first value settles immediately", () => {
  assert.equal(
    nextSettledValue({ current: "abc", settled: undefined, elapsedMs: 0, quietMs: 120 }),
    "abc",
  );
});
```

- [ ] **Step 2: Eseguire e verificare il fallimento**

Run (da `apps/desktop`): `node --test src/lib/settledText.test.mjs`
Expected: FAIL — modulo inesistente.

- [ ] **Step 3: Implementazione**

Creare `apps/desktop/src/lib/settledText.mjs`:

```javascript
/**
 * Pure decision behind `useSettledText`: what the settled value becomes given the
 * current text, the previously settled text, and how long the current text has
 * been quiet. Kept pure so the timing policy is testable without a DOM.
 *
 * `settled === undefined` means "nothing settled yet" — the first value is
 * accepted immediately so a finished message never waits to render.
 */
export function nextSettledValue({ current, settled, elapsedMs, quietMs }) {
  if (settled === undefined) return current;
  if (current === settled) return settled;
  return elapsedMs >= quietMs ? current : settled;
}
```

In `RichMessageRenderer.tsx`, dentro `CodeBlock`, sostituire la dipendenza del memo. Aggiungere prima del `useMemo`:

```typescript
  // A fence that is still streaming grows every frame; highlighting it each time
  // re-tokenizes the whole block ~60×/s. Highlight only once it goes quiet.
  const settledCode = useSettledCode(code);
```

e cambiare `const highlighted = useMemo(... , [code, language])` in modo che usi `settledCode` sia nel corpo sia nelle dipendenze (`[settledCode, language]`), lasciando invariato il fallback `return null`.

Aggiungere in fondo al file:

```typescript
/// `code` debounced to its quiet value (see `nextSettledValue`). Returns the very
/// first value immediately, so a settled message never waits a frame to paint.
function useSettledCode(code: string) {
  const [settled, setSettled] = useState(code);
  useEffect(() => {
    if (code === settled) return;
    const timer = window.setTimeout(() => setSettled(code), 120);
    return () => window.clearTimeout(timer);
  }, [code, settled]);
  return settled;
}
```

Il testo grezzo continua a essere mostrato dal ramo di fallback finché l'evidenziazione non arriva — nessun blocco resta vuoto.

- [ ] **Step 4: Eseguire i test**

Run (da `apps/desktop`): `node --test src/lib/settledText.test.mjs && npm run build && npm run test:ui-contract`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/settledText.mjs apps/desktop/src/lib/settledText.test.mjs apps/desktop/src/components/RichMessageRenderer.tsx && git commit -m "perf(desktop): highlight a code fence once it stops growing, not every frame"
```

---

## Task B6: il chrome dei messaggi non si ri-renderizza a ogni frame

**Contesto.** `ChatView.tsx:2859` mappa l'intero transcript a ogni flush. Per **ogni** messaggio, a ogni frame, si ricostruiscono `MessageActionBar` (~10 bottoni, stato e `useTranslation` propri, ~15 lambda inline create al volo) e `MessageActivity`. Peggio: `findPreviousUserMessage(threadMessages, …)` (`ChatView.tsx:2985`, definita a `3785`) scandisce la lista **per ogni messaggio**, rendendo il render O(N²), e `branches.find(...)` (`ChatView.tsx:3034`) aggiunge O(N·B).

Questo task elimina il costo algoritmico (una mappa precalcolata al posto delle scansioni per-riga) e memoizza la barra azioni.

**Files:**
- Create: `apps/desktop/src/lib/messageIndex.mjs`
- Modify: `apps/desktop/src/components/ChatView.tsx`
- Test: `apps/desktop/src/lib/messageIndex.test.mjs`

**Interfaces:**
- Produces:
  - `buildPreviousUserMessageIndex(messages: {id: string, role: string}[]): Map<string, string|null>` — per ogni id di messaggio, l'id dell'ultimo messaggio `user` che lo precede (o `null`).
  - `buildBranchIndex(branches: {node_id: string}[]): Map<string, object>` — indicizza le branch per `node_id`.

- [ ] **Step 1: Scrivere il test che fallisce**

Creare `apps/desktop/src/lib/messageIndex.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { buildBranchIndex, buildPreviousUserMessageIndex } from "./messageIndex.mjs";

test("maps every message to the user message before it in one pass", () => {
  const messages = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant" },
    { id: "a2", role: "assistant" },
    { id: "u2", role: "user" },
    { id: "a3", role: "assistant" },
  ];
  const index = buildPreviousUserMessageIndex(messages);
  assert.equal(index.get("a1"), "u1");
  assert.equal(index.get("a2"), "u1");
  assert.equal(index.get("a3"), "u2");
});

test("a message with no preceding user message maps to null", () => {
  const index = buildPreviousUserMessageIndex([{ id: "a0", role: "assistant" }]);
  assert.equal(index.get("a0"), null);
});

test("branches are indexed by node id", () => {
  const branches = [{ node_id: "n1", label: "A" }, { node_id: "n2", label: "B" }];
  const index = buildBranchIndex(branches);
  assert.equal(index.get("n2").label, "B");
  assert.equal(index.get("nope"), undefined);
});
```

- [ ] **Step 2: Eseguire e verificare il fallimento**

Run (da `apps/desktop`): `node --test src/lib/messageIndex.test.mjs`
Expected: FAIL — modulo inesistente.

- [ ] **Step 3: Implementazione**

Creare `apps/desktop/src/lib/messageIndex.mjs`:

```javascript
/**
 * Per-render indexes for the transcript. Both replace a per-row scan that made
 * rendering superlinear: `findPreviousUserMessage` walked the whole list for
 * EVERY message (O(N²)) and the branch lookup was an O(B) `find` per row — paid
 * on every streaming frame, not just on thread load.
 */
export function buildPreviousUserMessageIndex(messages) {
  const index = new Map();
  let lastUserId = null;
  for (const message of messages) {
    index.set(message.id, lastUserId);
    if (message.role === "user") lastUserId = message.id;
  }
  return index;
}

export function buildBranchIndex(branches) {
  return new Map((branches ?? []).map((branch) => [branch.node_id, branch]));
}
```

In `ChatView.tsx`, prima del `.map()` del transcript, aggiungere i due memo:

```typescript
  const previousUserMessageIndex = useMemo(
    () => buildPreviousUserMessageIndex(threadMessages),
    [threadMessages],
  );
  const branchIndex = useMemo(() => buildBranchIndex(branches), [branches]);
```

Sostituire nella riga di render la chiamata `findPreviousUserMessage(threadMessages, message.id)` con una lookup sull'indice (`previousUserMessageIndex.get(message.id)`, risolvendo l'id in messaggio con la mappa già disponibile o un secondo memo `messagesById`), e `branches.find((b) => b.node_id === …)` con `branchIndex.get(…)`. Rimuovere `findPreviousUserMessage` se non ha più chiamanti (`grep -n findPreviousUserMessage apps/desktop/src/components/ChatView.tsx`); se ne restano, lasciarla e non duplicare la logica.

Aggiungere l'import `import { buildBranchIndex, buildPreviousUserMessageIndex } from "../lib/messageIndex.mjs";`.

- [ ] **Step 4: Eseguire i test**

Run (da `apps/desktop`): `node --test src/lib/messageIndex.test.mjs && npm run build && npm run test:ui-contract && npm run test:electron`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/messageIndex.mjs apps/desktop/src/lib/messageIndex.test.mjs apps/desktop/src/components/ChatView.tsx && git commit -m "perf(desktop): index the transcript once per render instead of scanning it per row"
```

---

## Task B7: virtualizzazione del transcript, ancorata al fondo

**Contesto.** Il transcript non è virtualizzato: `.thread-message-list` è una colonna flex con **tutti** i messaggi nel DOM (`styles.css:3928`), e la lista intera viene riconciliata a ogni frame. Un thread da 100 messaggi sono 6–12k nodi vivi. La soluzione adottata dai competitor (verificata nel bundle Codex, chunk `thread-virtualizer`) è un virtualizzatore **custom e minuscolo** in coordinate **ancorate al fondo**: `distanceFromBottomPx` invece di `scrollTop`, così lo stick-to-bottom è stabile per costruzione anche mentre le altezze cambiano sotto. Le funzioni restano pure e testabili — coerente con il caposaldo "stato e control-flow nel codice".

Questo task consegna **solo la logica pura, testata**. Il cablaggio in `ChatView` è il Task B8, così un fallimento di integrazione non trascina con sé anche la logica.

**Files:**
- Create: `apps/desktop/src/lib/threadVirtualizer.mjs`
- Test: `apps/desktop/src/lib/threadVirtualizer.test.mjs`

**Interfaces:**
- Produces:
  - `buildLayout({entries, gapPx, measuredHeightsByKey})` → `{turnKeys, heightsPx, topOffsetsPx, bottomOffsetsPx, totalHeightPx, turnIndexByKey}`. `entries` è `[{turnKey: string, estimatedHeightPx?: number}]`; l'altezza usata è `measuredHeightsByKey[turnKey] ?? estimatedHeightPx ?? DEFAULT_ESTIMATED_HEIGHT_PX` (280).
  - `visibleRange({distanceFromBottomPx, layout, overscanCount, viewportHeightPx})` → `{startIndex, endIndex}` (endIndex esclusivo).
  - `DEFAULT_ESTIMATED_HEIGHT_PX` = 280.

- [ ] **Step 1: Scrivere i test che falliscono**

Creare `apps/desktop/src/lib/threadVirtualizer.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ESTIMATED_HEIGHT_PX,
  buildLayout,
  visibleRange,
} from "./threadVirtualizer.mjs";

const entries = [
  { turnKey: "t1" },
  { turnKey: "t2", estimatedHeightPx: 100 },
  { turnKey: "t3" },
];

test("layout stacks heights with gaps and exposes bottom-anchored offsets", () => {
  const layout = buildLayout({ entries, gapPx: 10, measuredHeightsByKey: { t3: 50 } });
  assert.deepEqual(layout.heightsPx, [DEFAULT_ESTIMATED_HEIGHT_PX, 100, 50]);
  // 280 + 10 + 100 + 10 + 50
  assert.equal(layout.totalHeightPx, 450);
  assert.deepEqual(layout.topOffsetsPx, [0, 290, 400]);
  // Distance from the BOTTOM of the content to the bottom of each entry: this is
  // the coordinate stick-to-bottom is expressed in, so growth at the tail does
  // not shift the anchor of everything above it.
  assert.deepEqual(layout.bottomOffsetsPx, [170, 60, 0]);
  assert.equal(layout.turnIndexByKey.get("t2"), 1);
});

test("a measured height wins over the estimate", () => {
  const layout = buildLayout({ entries, gapPx: 0, measuredHeightsByKey: { t1: 7 } });
  assert.equal(layout.heightsPx[0], 7);
});

test("at the bottom only the tail entries are visible, plus overscan", () => {
  const layout = buildLayout({ entries, gapPx: 0, measuredHeightsByKey: {} });
  const range = visibleRange({
    distanceFromBottomPx: 0,
    layout,
    overscanCount: 0,
    viewportHeightPx: 280,
  });
  assert.equal(range.endIndex, 3);
  assert.equal(range.startIndex, 2);
});

test("overscan widens the range without escaping the bounds", () => {
  const layout = buildLayout({ entries, gapPx: 0, measuredHeightsByKey: {} });
  const range = visibleRange({
    distanceFromBottomPx: 0,
    layout,
    overscanCount: 5,
    viewportHeightPx: 280,
  });
  assert.equal(range.startIndex, 0);
  assert.equal(range.endIndex, 3);
});

test("an empty transcript yields an empty range instead of throwing", () => {
  const layout = buildLayout({ entries: [], gapPx: 10, measuredHeightsByKey: {} });
  assert.equal(layout.totalHeightPx, 0);
  assert.deepEqual(visibleRange({
    distanceFromBottomPx: 0,
    layout,
    overscanCount: 3,
    viewportHeightPx: 500,
  }), { startIndex: 0, endIndex: 0 });
});
```

- [ ] **Step 2: Eseguire e verificare il fallimento**

Run (da `apps/desktop`): `node --test src/lib/threadVirtualizer.test.mjs`
Expected: FAIL — modulo inesistente.

- [ ] **Step 3: Implementazione**

Creare `apps/desktop/src/lib/threadVirtualizer.mjs`:

```javascript
/**
 * Pure geometry for a bottom-anchored virtualized transcript.
 *
 * Why bottom-anchored: a chat sticks to the BOTTOM while it streams, and the
 * entry that grows is the last one. Expressed in scrollTop, every measurement
 * that lands shifts the anchor and the viewport jumps; expressed as a distance
 * from the bottom, the tail can grow without moving anything the reader is
 * looking at. Kept as pure functions (no DOM) so the geometry is testable and
 * the control flow stays in code.
 */
export const DEFAULT_ESTIMATED_HEIGHT_PX = 280;

export function buildLayout({ entries, gapPx, measuredHeightsByKey }) {
  const heightsPx = [];
  const topOffsetsPx = [];
  const turnIndexByKey = new Map();
  const turnKeys = [];
  let cursor = 0;

  entries.forEach((entry, index) => {
    const key = entry.turnKey;
    const height =
      measuredHeightsByKey[key] ?? entry.estimatedHeightPx ?? DEFAULT_ESTIMATED_HEIGHT_PX;
    turnIndexByKey.set(key, index);
    turnKeys.push(key);
    topOffsetsPx.push(cursor);
    heightsPx.push(height);
    cursor += height;
    if (index < entries.length - 1) cursor += gapPx;
  });

  const totalHeightPx = cursor;
  const bottomOffsetsPx = topOffsetsPx.map(
    (top, index) => totalHeightPx - top - (heightsPx[index] ?? 0),
  );

  return { bottomOffsetsPx, heightsPx, topOffsetsPx, totalHeightPx, turnIndexByKey, turnKeys };
}

export function visibleRange({ distanceFromBottomPx, layout, overscanCount, viewportHeightPx }) {
  if (layout.turnKeys.length === 0) return { startIndex: 0, endIndex: 0 };
  const low = Math.min(Math.max(0, distanceFromBottomPx), layout.totalHeightPx);
  const high = Math.min(low + Math.max(0, viewportHeightPx), layout.totalHeightPx);
  const lastVisible = firstIndexBelow(layout.bottomOffsetsPx, high);
  const firstVisible = firstIndexFullyAbove(layout.bottomOffsetsPx, layout.heightsPx, low);
  return {
    startIndex: Math.max(0, lastVisible - overscanCount),
    endIndex: Math.min(layout.turnKeys.length, Math.max(firstVisible, lastVisible + 1) + overscanCount),
  };
}

/// Entries are ordered by DECREASING bottom offset, so a binary search finds the
/// first one whose bottom offset is under `value`.
function firstIndexBelow(bottomOffsetsPx, value) {
  let low = 0;
  let high = bottomOffsetsPx.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((bottomOffsetsPx[mid] ?? 0) < value) high = mid;
    else low = mid + 1;
  }
  return low;
}

function firstIndexFullyAbove(bottomOffsetsPx, heightsPx, value) {
  let low = 0;
  let high = bottomOffsetsPx.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((bottomOffsetsPx[mid] ?? 0) + (heightsPx[mid] ?? 0) <= value) high = mid;
    else low = mid + 1;
  }
  return low;
}
```

- [ ] **Step 4: Eseguire i test**

Run (da `apps/desktop`): `node --test src/lib/threadVirtualizer.test.mjs`
Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/threadVirtualizer.mjs apps/desktop/src/lib/threadVirtualizer.test.mjs && git commit -m "feat(desktop): bottom-anchored transcript virtualizer geometry"
```

---

## Task B8: `content-visibility` sui messaggi fuori vista

**Contesto.** Cablare il virtualizzatore del Task B7 dentro `ChatView.tsx` significa toccare un componente da 9.4k righe con quattro percorsi di streaming: rischio alto in una sessione autonoma. Esiste una leva che ottiene **gran parte** del beneficio senza toccare il control-flow del render: `content-visibility: auto` con `contain-intrinsic-size`. Il browser salta interamente layout, paint e stile per gli elementi fuori dal viewport, mantenendo però lo scroll corretto grazie alla dimensione intrinseca dichiarata. È la stessa geometria del Task B7 (altezza stimata 280px), applicata dal compositor invece che da React.

Il cablaggio pieno del virtualizzatore resta il passo successivo, ma va fatto a mente fresca su un `ChatView` già alleggerito: questo task consegna il guadagno subito e in sicurezza.

**Files:**
- Modify: `apps/desktop/src/styles.css` (regola `.thread-message-list > *` o la classe `.message`)
- Test: `apps/desktop/tests/streaming-scroll.test.mjs` (aggiungere un caso)

- [ ] **Step 1: Scrivere il test che fallisce**

Aggiungere in `apps/desktop/tests/streaming-scroll.test.mjs`:

```javascript
test("off-screen messages are skipped by the renderer", () => {
  // content-visibility lets the compositor skip layout/paint/style for rows
  // outside the viewport; contain-intrinsic-size keeps the scrollbar honest.
  assert.match(styles, /content-visibility:\s*auto/);
  assert.match(styles, /contain-intrinsic-size:/);
});
```

- [ ] **Step 2: Eseguire e verificare il fallimento**

Run (da `apps/desktop`): `node --test tests/streaming-scroll.test.mjs`
Expected: FAIL sul nuovo caso.

- [ ] **Step 3: Implementazione**

In `styles.css`, subito dopo il blocco `.thread-message-list { ... }`, aggiungere:

```css
/* Skip layout/paint/style entirely for messages outside the viewport. The whole
   transcript lives in the DOM (it is not virtualized), so on a long thread every
   streaming frame re-laid-out thousands of nodes nobody was looking at.
   contain-intrinsic-size gives the skipped rows a placeholder height, so the
   scrollbar and scroll position stay correct; `auto` lets a row that scrolls
   into view render normally. */
.thread-message-list > .message {
  content-visibility: auto;
  contain-intrinsic-size: auto 280px;
}
/* The last message is the one streaming: never let the renderer skip it, and
   never let a placeholder height fight its real, growing one. */
.thread-message-list > .message:last-child {
  content-visibility: visible;
  contain-intrinsic-size: none;
}
```

Verificare con `grep -n '"message"' apps/desktop/src/components/ChatView.tsx` che la classe applicata alle righe sia effettivamente `message`; se il selettore reale differisce, usare quello e aggiornare il commento.

- [ ] **Step 4: Eseguire i test**

Run (da `apps/desktop`): `node --test tests/streaming-scroll.test.mjs && npm run build && npm run test:ui-contract`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/styles.css apps/desktop/tests/streaming-scroll.test.mjs && git commit -m "perf(desktop): skip layout and paint for off-screen transcript rows"
```

---

## Task B9: viste pesanti fuori dal chunk iniziale

**Contesto.** Il chunk eager è **3,4 MB** (`dist/assets/index-*.js`). `App.tsx:4-14` importa staticamente ogni vista, incluse `SettingsView` (7287 righe), `ContactsView`, `AutomationsView`, `TasksView`, `ContainedComputerView` — nessuna delle quali serve al primo paint della chat. `vite.config.ts:11-27` splitta solo markdown e katex. Portare queste viste su `React.lazy` accorcia il tempo fino alla prima interazione senza toccare la logica.

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/vite.config.ts`
- Test: `apps/desktop/tests/bundle-budget.test.mjs` (creare)

**Interfaces:**
- Produces: nessuna nuova API. Invariante: il chunk d'ingresso resta sotto i **2,6 MB**; le viste secondarie sono chunk a sé.

- [ ] **Step 1: Scrivere il test che fallisce**

Creare `apps/desktop/tests/bundle-budget.test.mjs`:

```javascript
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "..", "dist", "assets");

test("the eager entry chunk stays within budget", (t) => {
  let files;
  try {
    files = readdirSync(assets);
  } catch {
    t.skip("run `npm run build` first");
    return;
  }
  const entry = files.filter((name) => /^index-.*\.js$/.test(name));
  assert.equal(entry.length, 1, `expected exactly one entry chunk, got ${entry.join(", ")}`);
  const bytes = statSync(join(assets, entry[0])).size;
  // Was 3,567,383 B with every view statically imported. The budget is a ratchet:
  // lower it when a task legitimately shrinks the entry further.
  assert.ok(bytes < 2_600_000, `entry chunk is ${bytes} B, budget is 2,600,000 B`);
});
```

- [ ] **Step 2: Buildare ed eseguire il test**

Run (da `apps/desktop`): `npm run build && node --test tests/bundle-budget.test.mjs`
Expected: FAIL — il chunk supera il budget.

- [ ] **Step 3: Implementazione**

In `App.tsx`, sostituire gli import statici delle viste secondarie con `lazy`:

```typescript
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";

// Secondary views are not on the path to the first chat paint; keeping them in
// the eager chunk cost ~1MB of parse before anything was interactive.
const AutomationsView = lazy(() =>
  import("./components/AutomationsView").then((m) => ({ default: m.AutomationsView })),
);
const ContainedComputerView = lazy(() =>
  import("./components/ContainedComputerView").then((m) => ({ default: m.ContainedComputerView })),
);
const SettingsView = lazy(() =>
  import("./components/SettingsView").then((m) => ({ default: m.SettingsView })),
);
const TasksView = lazy(() =>
  import("./components/TasksView").then((m) => ({ default: m.TasksView })),
);
const LearningView = lazy(() =>
  import("./components/LearningView").then((m) => ({ default: m.LearningView })),
);
```

Avvolgere il punto in cui le viste vengono renderizzate (lo switch su `activeView`) in un `<Suspense fallback={null}>`. Verificare con `grep -n 'activeView ===' apps/desktop/src/App.tsx` dove si trova lo switch. `ChatView` e `Shell` **restano** import statici: sono il primo paint.

In `vite.config.ts`, dentro `manualChunks`, prima del `return undefined` finale:

```typescript
          if (id.includes("lowlight") || id.includes("highlight.js")) {
            return "vendor-highlight";
          }
          if (id.includes("react-force-graph") || id.includes("three")) {
            return "vendor-graph";
          }
```

- [ ] **Step 4: Buildare ed eseguire i test**

Run (da `apps/desktop`): `npm run build && node --test tests/bundle-budget.test.mjs && npm run test:ui-contract && npm run test:electron`
Expected: PASS. Se il budget non è ancora rispettato, controllare con `ls -laS dist/assets/*.js | head` cosa domina e portare fuori anche quello, aggiornando `manualChunks`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/App.tsx apps/desktop/vite.config.ts apps/desktop/tests/bundle-budget.test.mjs && git commit -m "perf(desktop): lazy-load secondary views and split the heavy vendors out of the entry chunk"
```

---

## Task B10: un solo trasporto eventi

**Contesto.** `wsSubscription.ts:7` dichiara di sostituire `subscribeAppEvents` (NDJSON `/api/events`), ma il trasporto legacy è ancora vivo: `ChatView.tsx:5134` lo usa per gli eventi del project-graph. Due connessioni, due loop di riconnessione, doppio dispatch degli handler. È esattamente il caso della regola madre "converge, non duplicare": si cabla il canonico e si ritira il parallelo.

**Files:**
- Modify: `apps/desktop/src/components/ChatView.tsx:5134` (usare il WS)
- Modify: `apps/desktop/src/lib/coreBridge.ts:912` (rimuovere `subscribeAppEvents` se resta senza chiamanti)
- Test: `apps/desktop/tests/single-event-transport.test.mjs` (creare)

**Interfaces:**
- Consumes: `wsSubscription` (`apps/desktop/src/lib/wsSubscription.ts:170`) — verificarne l'API di sottoscrizione con `grep -n "subscribe\|on(" apps/desktop/src/lib/wsSubscription.ts` e usare quella già impiegata da `App.tsx:921`.

- [ ] **Step 1: Scrivere il test che fallisce**

Creare `apps/desktop/tests/single-event-transport.test.mjs`:

```javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");

test("no component opens the legacy NDJSON event stream", () => {
  // Two live transports meant two connections, two reconnect loops and a double
  // dispatch of every handler. The WebSocket is the canonical one.
  const chatView = readFileSync(join(src, "components", "ChatView.tsx"), "utf8");
  assert.doesNotMatch(chatView, /subscribeAppEvents\(/, "ChatView must use the WebSocket");
});
```

- [ ] **Step 2: Eseguire e verificare il fallimento**

Run (da `apps/desktop`): `node --test tests/single-event-transport.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implementazione**

Leggere come `App.tsx` (intorno alla riga 921) si sottoscrive al WS e replicare **esattamente quel pattern** in `ChatView.tsx:5134`, mantenendo identico il corpo dell'handler (i tre rami `project_graph.ready` / `project_graph.too_large` / default) e la funzione di cleanup restituita dall'effetto.

Rimuovere l'import `subscribeAppEvents` da `ChatView.tsx:83`. Poi:

Run: `grep -rn "subscribeAppEvents" apps/desktop/src`

Se restano solo la definizione in `coreBridge.ts:912` e l'import inutilizzato in `App.tsx:30`, rimuovere entrambi e la funzione. Se qualche altro chiamante esiste, **fermarsi**: convertire anche quello prima di rimuovere.

- [ ] **Step 4: Eseguire i test**

Run (da `apps/desktop`): `node --test tests/single-event-transport.test.mjs && npm run build && npm run test:ui-contract && npm run test:electron`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/ChatView.tsx apps/desktop/src/lib/coreBridge.ts apps/desktop/src/App.tsx apps/desktop/tests/single-event-transport.test.mjs && git commit -m "refactor(desktop): one event transport — retire the legacy NDJSON stream"
```

---

## Task B11: gate finale e merge

**Files:** `docs/STATO.md`, `CHANGELOG.md`

- [ ] **Step 1: Eseguire tutti i gate, in ordine**

```bash
cd /Users/fabio/Projects/Homun/app && cargo test -p local-first-engine && cargo test -p local-first-inference && cargo test -p local-first-desktop-gateway
```

Expected: 0 failed su tutti e tre.

```bash
cd /Users/fabio/Projects/Homun/app/apps/desktop && npm run build && npm run test:ui-contract && npm run test:electron
```

Expected: build OK, ui-contract OK, electron tutti passati.

```bash
cd /Users/fabio/Projects/Homun/app && python3 scripts/pre_release_gate.py
```

Expected: `ALL GREEN`.

- [ ] **Step 2: Registrare l'esito in STATO.md**

Aggiungere al checkpoint 2026-07-24 (creato nel Task A5) una sezione "Fluidità UI" che elenchi in italiano gli interventi (scroll istantaneo, niente background throttling, reveal su ready-to-show, poll identity-preserving, markdown per-blocco, highlight su blocco quieto, indici del transcript, geometria del virtualizzatore, `content-visibility`, viste lazy, trasporto unico) e la tabella dei gate con l'esito reale osservato allo Step 1.

- [ ] **Step 3: Aggiungere la voce al CHANGELOG**

Aggiungere in cima alla sezione non rilasciata di `CHANGELOG.md` una riga per la fluidità UI e una per i residui di sicurezza, nello stile delle voci esistenti (verificare il formato con `head -30 CHANGELOG.md`).

- [ ] **Step 4: Commit e merge**

```bash
git add docs/STATO.md CHANGELOG.md && git commit -m "docs: gate finali fluidità UI + residui triage"
git checkout main && git merge --no-ff ui-fluidity-and-triage-residuals -m "merge: residui triage + fluidità UI desktop"
```

- [ ] **Step 5: Verificare lo stato finale**

Run: `git log --oneline -5 && git status --short`
Expected: il merge in cima, working tree pulito. **Nessun push** (il push si fa solo su richiesta esplicita).

---

## Note di validazione umana

Due cose in questo piano **non sono verificabili da un computer** e vanno guardate a schermo da Fabio sul binario ricostruito:

1. **La fluidità percepita** durante una risposta lunga in streaming: il criterio è che il testo scorra senza rimbalzo elastico e senza scatti periodici.
2. **La resa del markdown per-blocco** (Task B4) su liste "loose", tabelle e blocchi di codice: la suddivisione in blocchi cambia il modo in cui react-markdown vede il documento, e i test coprono la funzione di split, non l'estetica del risultato.
