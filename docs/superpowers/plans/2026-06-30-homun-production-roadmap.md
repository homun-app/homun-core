# Homun Production Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Portare Homun da prototipo avanzato a prodotto local-first utilizzabile in produzione, preservando il lavoro gia' fatto su memoria, loop unico, capability, Vault e browser.

**Architecture:** La roadmap conferma ADR 0021: un solo loop guardato, piano come tool, niente terzo motore. La strategia non e' buttare l'architettura corrente, ma togliere costo e fragilita' dal percorso caldo: memoria tiered e misurata, eventi chat strutturati compatibili coi marker, tool/Vault/browser con contratti stretti, readiness di rilascio verificabile.

**Tech Stack:** Rust workspace (`desktop-gateway`, `memory`, `vault`, `browser-automation`, `capabilities`), SQLite local-first, Ollama embeddings, Electron/React, NDJSON streaming, tests `cargo`, UI contract tests, smoke live gateway/Electron.

---

## Principi Di Roadmap

Questa roadmap parte da tre vincoli:

- **Non buttare mesi di lavoro.** Memoria, grafo, Vault, capability registry, browser OpenClaw-like e loop ReAct restano asset. Si ottimizza e si isola, non si riscrive.
- **Produzione significa comportamento prevedibile.** Ogni fase deve chiudere con test automatici, smoke live e aggiornamento `docs/architecture/`.
- **Il percorso caldo deve dimagrire.** Tutto cio' che accade prima della prima risposta del modello deve essere misurato, limitato e degradabile.

Non-obiettivi immediati:

- Non creare un terzo motore agentico.
- Non spostare il turno chat sul drive/orchestrator.
- Non sostituire il database memoria con un vector DB esterno.
- Non introdurre cloud obbligatorio per privacy, memoria o classificazione sensibile.

---

## Roadmap Sintetica

| Fase | Nome | Obiettivo | Durata stimata | Gate di uscita |
|---|---|---|---|---|
| 0 | Baseline produzione | Congelare cio' che deve funzionare sempre | 2-3 giorni | smoke suite ripetibile + metriche base |
| 1 | Memory hot-path | Rendere la memoria misurabile e non bloccante | 1 settimana | p95 recall sotto budget locale |
| 2 | Retrieval indicizzato | Togliere lo scan vettoriale O(N) | 1-2 settimane | vector recall indicizzata + fallback FTS |
| 3 | Structured chat events | Ridurre fragilita' marker senza big-bang | 1-2 settimane | eventi tipizzati per activity/plan/vault/choices |
| 4 | Browser/action reliability | Chiudere regressioni di navigazione, form e panel | 1 settimana | suite live browser + UI panel stabile |
| 5 | Vault/payment production slice | Rendere sicuri reveal, fill e pagamenti approvati | 1-2 settimane | checkout fixture approvato PIN/CVV, audit |
| 6 | Production readiness | Packaging, crash recovery, observability, reset | 1 settimana | beta installabile con checklist verde |
| 7 | Modularizzazione mirata | Estrarre moduli dal gateway solo dove gia' stabilizzati | continuo | file piu' piccoli, nessuna nuova impl parallela |

---

## Fase 0: Baseline Produzione

**Scopo:** prima di ottimizzare, fissare cosa deve rimanere vero a ogni commit.

**Files:**
- Modify: `scripts/` o `apps/desktop/scripts/` per smoke runner locale.
- Modify: `docs/STATO.md`.
- Modify: `docs/architecture/system-map.md`.
- Modify: `docs/architecture/agent-loop.md`.

- [x] **Step 1: Definire smoke suite minima**

Creare una checklist eseguibile o semi-eseguibile con questi scenari:

```text
S1 chat semplice senza tool
S2 domanda memoria personale
S3 domanda Vault -> VAULT_REVEAL -> PIN card, nessun segreto nel transcript
S4 salvataggio dato sensibile -> VAULT_PROPOSE, raw solo pending sidecar
S5 browse news -> fonti reali, nessuna invenzione
S6 form fill reale -> nessun kind=fill error
S7 piano con URL morto -> step blocked dopo cap, niente loop infinito
S8 payment approval fixture -> riepilogo + PIN/CVV one-shot + click finale approvato
```

- [ ] **Step 2: Aggiungere budget di prodotto**

Budget iniziali, da misurare e poi correggere:

```text
time_to_first_delta chat no-tool: <= 2.0s locale caldo
memory_recall p95: <= 250ms senza embedding query, <= 800ms con embedding query
vault proposal/reveal: <= 300ms escluso modello
browse first action: <= 8s con browser sidecar gia' caldo
```

- [x] **Step 3: Scrivere gate pre-release locale**

Comando target:

```bash
python3 scripts/pre_release_gate.py
npm run test:ui-contract
npm run build
cargo test --workspace
```

Se `cargo test --workspace` e' troppo pesante, documentare il subset obbligatorio per beta:

```bash
cargo test -p local-first-desktop-gateway vault_
cargo test -p local-first-desktop-gateway memory
cargo test -p local-first-desktop-gateway browser
cargo test -p local-first-memory
```

- [ ] **Step 4: Commit**

```bash
git add scripts docs/STATO.md docs/architecture/system-map.md docs/architecture/agent-loop.md
git commit -m "docs: define production baseline gates"
```

---

## Fase 1: Memory Hot-Path

**Scopo:** capire e ridurre il costo per-turno senza cambiare semantica della memoria.

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` initially, then extract to focused module if touched code grows.
- Modify/Create: `crates/desktop-gateway/src/memory_runtime.rs`.
- Modify: `crates/memory/src/facade.rs`.
- Modify: `docs/architecture/memory.md`.

- [x] **Step 1: Aggiungere trace temporale della recall**

Metriche da produrre nel `tool_trace` o debug telemetry:

```rust
#[derive(Debug, Clone, Serialize)]
struct MemoryRecallTiming {
    lock_wait_ms: u64,
    profile_ms: u64,
    open_loops_ms: u64,
    fts_ms: u64,
    query_embedding_ms: Option<u64>,
    query_embedding_cache_hit: bool,
    query_embedding_timed_out: bool,
    vector_scan_ms: Option<u64>,
    graph_context_ms: u64,
    total_ms: u64,
    vector_candidates: usize,
    fts_candidates: usize,
    degraded: bool,
}
```

- [x] **Step 2: Testare che la telemetria non cambi il risultato**

Test target:

```bash
cargo test -p local-first-desktop-gateway memory_recall_timing_preserves_recall_output
```

Comportamento atteso:

```text
La stessa query su fixture memoria produce le stesse righe prima/dopo il wrapper timing.
```

Evidenza live iniziale:

```text
S1 Simple no-tool chat: PASS 6.7s; memory recall query_embedding_ms=1477, lock/FTS/vector ~0
S3 Vault reveal card: PASS 61.0s; VAULT_REVEAL presente, plaintext vietato assente; recall query_embedding_ms=224, fts_ms=2, lock 0
```

- [x] **Step 3: Cache query embedding**

Implementare cache piccola in memoria, keyed su:

```text
embed_model + normalized_query + workspace_scope
```

Policy:

```text
max entries: 512
ttl: 24h
eviction: LRU o VecDeque semplice se il codebase non ha LRU
```

Implementato in `relevant_memory_for_prompt` tramite cache in-process LRU/TTL:

```text
HOMUN_MEMORY_QUERY_EMBED_CACHE_MAX=512
HOMUN_MEMORY_QUERY_EMBED_CACHE_TTL_SECS=86400
key = embed_base + embed_model + workspace_scope + normalized_query
```

- [x] **Step 4: Budget e fallback**

Se embedding query supera budget o fallisce:

```text
procedi con FTS + briefing sempre-attivo
marca MemoryRecallTiming.degraded=true
non bloccare il turno
```

Implementato con `HOMUN_MEMORY_QUERY_EMBED_TIMEOUT_MS` (default 700 ms): timeout o errore
impostano `query_embedding_timed_out`/`degraded` e lasciano vivo il percorso FTS + briefing.

Evidenza slice cache/budget:

```text
cargo test -p local-first-desktop-gateway memory_recall
cargo test -p local-first-desktop-gateway memory_query_embedding_cache
cargo test -p local-first-desktop-gateway vault_
python3 -m unittest scripts.test_pre_release_gate scripts.test_production_smoke -v
npm run test:ui-contract (da apps/desktop)
cargo build -p local-first-desktop-gateway --bin local-first-desktop-gateway

Live dopo restart gateway:
S1 primo giro PASS 7.8s; query_embedding_ms=163 cache_hit=false timed_out=false
S1 secondo giro PASS 3.2s; query_embedding_ms=0 cache_hit=true timed_out=false
```

- [ ] **Step 5: Commit**

```bash
git add crates/desktop-gateway/src crates/memory/src docs/architecture/memory.md docs/STATO.md
git commit -m "perf: instrument and bound memory recall hot path"
```

---

## Fase 2: Retrieval Vettoriale Indicizzato

**Scopo:** rimuovere il brute-force cosine O(N) preservando SQLite local-first e RRF ibrido.

**Files:**
- Modify: `crates/memory/Cargo.toml`.
- Modify/Create: `crates/memory/src/vector_index.rs`.
- Modify: `crates/memory/src/store.rs`.
- Modify: `crates/memory/src/facade.rs`.
- Test: `crates/memory/src/vector_index.rs` unit tests or integration tests.
- Modify: `docs/architecture/memory.md`.

- [ ] **Step 1: Decisione tecnica breve**

Valutare in un mini spike:

```text
sqlite-vec:
  pro: resta dentro SQLite, coerente local-first
  contro: dipendenza estensione/compilazione da validare su mac app bundle

usearch:
  pro: ANN maturo embedded
  contro: indice sidecar da mantenere coerente col DB
```

Decisione raccomandata iniziale:

```text
sqlite-vec se build/install packaging resta semplice; usearch solo se sqlite-vec complica bundle/notarization.
```

- [ ] **Step 2: Aggiungere adapter dietro trait**

Contratto:

```rust
pub trait MemoryVectorIndex {
    fn upsert(&self, memory_ref: &MemoryRef, embedding: &[f32]) -> Result<(), MemoryError>;
    fn delete(&self, memory_ref: &MemoryRef) -> Result<(), MemoryError>;
    fn search(&self, query: &[f32], limit: usize) -> Result<Vec<VectorHit>, MemoryError>;
}

pub struct VectorHit {
    pub memory_ref: MemoryRef,
    pub score: f32,
}
```

- [ ] **Step 3: Backfill idempotente**

Backfill deve:

```text
leggere memory_embeddings esistenti
upsertare nell'indice
essere ripetibile senza duplicati
non bloccare recall
```

- [ ] **Step 4: Fallback sicuro**

Se indice non disponibile:

```text
usa scan corrente come fallback temporaneo solo dietro flag/debug
oppure FTS-only se il dataset e' grande
logga degraded=true
```

- [ ] **Step 5: Test parita' ranking**

Fixture:

```text
3 memorie simili
1 memoria lessicalmente esatta
1 memoria non pertinente
```

Expected:

```text
RRF finale conserva match lessicale e include match semantico indicizzato.
```

- [ ] **Step 6: Commit**

```bash
git add crates/memory docs/architecture/memory.md docs/STATO.md
git commit -m "perf: add indexed vector recall for memory"
```

---

## Fase 3: Structured Chat Events Compatibili

**Scopo:** smettere progressivamente di usare marker inline come protocollo primario, senza rompere transcript esistenti.

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`.
- Modify/Create: `crates/desktop-gateway/src/chat_events.rs`.
- Modify: `apps/desktop/src/lib/chatApi.ts`.
- Modify: `apps/desktop/src/components/ChatView.tsx`.
- Modify: `apps/desktop/src/components/RichMessage.tsx`.
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`.
- Modify: `docs/architecture/agent-loop.md`.

- [ ] **Step 1: Definire evento tipizzato v1**

Schema NDJSON compatibile:

```ts
type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "activity"; icon?: string; label: string; status: "running" | "done" | "error" }
  | { type: "plan_update"; plan: RuntimePlanView }
  | { type: "choice_prompt"; prompt: ChoicePrompt }
  | { type: "vault_reveal"; proposal: VaultRevealProposal }
  | { type: "payment_approval"; proposal: PaymentApprovalProposal }
  | { type: "done"; text: string; metrics: TokenMetrics; redacted_user_text?: string };
```

- [ ] **Step 2: Dual emit**

Durante transizione:

```text
gateway emette evento tipizzato
continua a includere marker nel done per retrocompatibilita'
frontend preferisce evento tipizzato quando presente
parser marker resta fallback
```

- [ ] **Step 3: Test contratto UI**

Aggiungere check:

```text
ChatView handles vault_reveal event
ChatView handles payment_approval event
ChatView handles choice_prompt event
RichMessage still strips legacy markers
```

- [ ] **Step 4: Smoke**

Scenari:

```text
Vault reveal: evento vault_reveal renderizza card PIN
Choice prompt: evento choice_prompt renderizza scelte
Plan update: evento plan_update aggiorna pannello senza duplicare testo
```

- [ ] **Step 5: Commit**

```bash
git add crates/desktop-gateway/src apps/desktop/src apps/desktop/scripts docs/architecture/agent-loop.md docs/STATO.md
git commit -m "feat: add structured chat stream events"
```

---

## Fase 4: Browser E Action Reliability

**Scopo:** portare il browser da "funziona spesso" a "debuggabile e affidabile".

**Files:**
- Modify: `docs/architecture/browser.md`.
- Modify: `crates/desktop-gateway/src/main.rs` or extracted browser module.
- Modify: `apps/desktop/src/components/WorkspaceIsland.tsx` / current browser panel component.
- Modify: browser sidecar TypeScript files.

- [ ] **Step 1: Panel grande stabile**

Requisito:

```text
expanded panel resta nel content area, non va sotto sidebar, usa icona corretta, browser preview grande.
```

- [ ] **Step 2: Browser smoke fixtures**

Fixture minime:

```text
navigate valid URL
navigate DNS failure
fill simple form
click button
recover CDP wedge
expanded panel visual check
```

- [ ] **Step 3: Search/discovery policy**

Regola:

```text
prompt italiano + browser locale italiano -> Google/Google News hl=it gl=IT quando serve discovery
non andare direttamente su una fonte singola salvo richiesta esplicita
```

- [ ] **Step 4: Commit**

```bash
git add crates/desktop-gateway/src apps/desktop/src docs/architecture/browser.md docs/STATO.md
git commit -m "fix: harden browser action and panel reliability"
```

---

## Fase 5: Vault E Payment Production Slice

**Scopo:** rendere il Vault usabile in task agentici reali senza esporre segreti.

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` or extracted `vault_runtime.rs`.
- Modify: `crates/vault/`.
- Modify: `apps/desktop/src/components/ChatView.tsx`.
- Modify: `docs/architecture/vault.md`.

- [ ] **Step 1: Reveal/fill policy**

Regola:

```text
visualizzare valore -> PIN card locale
riempire campo browser -> tool minimizzato PIN-gated, valore non passa al modello
pagamento -> riepilogo + PIN + CVV one-shot + final click approval
Telegram autorizzativo -> riepilogo/approval, non raw secret
```

- [ ] **Step 2: Tool minimizzati**

Contratti futuri:

```rust
vault_get_field(record_id, purpose, pin) -> redacted or local-only reveal event
vault_fill_browser_field(record_id, browser_ref, field_ref, purpose, pin) -> filled/not filled
```

Il valore non deve entrare in:

```text
model prompt
tool result testuale
chat transcript
logs non redatti
```

- [ ] **Step 3: Checkout fixture**

Scenario:

```text
utente chiede acquisto/prenotazione
Homun compila dati non sensibili
per pagamento mostra riepilogo
utente approva con PIN + CVV one-shot
solo il click finale viene sbloccato
```

- [ ] **Step 4: Commit**

```bash
git add crates/desktop-gateway/src crates/vault apps/desktop/src docs/architecture/vault.md docs/STATO.md
git commit -m "feat: add pin-gated vault fill for approved actions"
```

---

## Fase 6: Production Readiness

**Scopo:** beta installabile e recuperabile, non solo dev server funzionante.

**Files:**
- Modify: `docs/STATO.md`.
- Modify/Create: `docs/production-readiness.md`.
- Modify: release scripts / GitHub Actions as needed.

- [ ] **Step 1: Crash/restart policy**

Checklist:

```text
gateway crash -> UI mostra stato e retry
sidecar browser crash -> restart isolato
provider unavailable -> messaggio chiaro, no risposta vuota
Vault locked -> card PIN, no fallback inventato
```

- [ ] **Step 2: Installer smoke**

Su app installata:

```text
new chat
memory recall
Vault reveal
browse
form fill
approval card
auto-update check
```

- [ ] **Step 3: Release gate**

```bash
python3 scripts/pre_release_gate.py
npm run build
cargo test --workspace
```

- [ ] **Step 4: Commit**

```bash
git add docs scripts .github
git commit -m "docs: add production readiness checklist"
```

---

## Fase 7: Modularizzazione Mirata Del Gateway

**Scopo:** ridurre `main.rs` senza creare nuove implementazioni parallele.

Ordine raccomandato:

1. `vault_runtime.rs` perché il confine sicurezza e' gia' chiaro.
2. `memory_runtime.rs` dopo Fase 1, perché avremo metriche e interfaccia.
3. `chat_events.rs` dopo Fase 3.
4. `browser_runtime.rs` dopo Fase 4.
5. `payment_approval.rs` dopo Fase 5.

Regola:

```text
estrarre codice gia' stabilizzato
nessun cambio comportamentale nella stessa PR/commit di estrazione
test prima e dopo identici
```

Commit pattern:

```bash
git commit -m "refactor: extract vault runtime module"
git commit -m "refactor: extract memory runtime module"
git commit -m "refactor: extract chat stream events"
```

---

## Ordine Consigliato Da Domani

1. Fase 0, per avere una baseline che impedisce regressioni.
2. Fase 1, per misurare davvero la memoria.
3. Fase 4 piccolo fix UI/browser panel se continua a bloccare i test live.
4. Fase 2, solo dopo numeri reali.
5. Fase 3, per chiudere la fragilita' marker che continua a riapparire.
6. Fase 5, per rendere agentico il Vault in azioni reali.
7. Fase 6, per beta.
8. Fase 7, in parallelo solo quando una zona e' gia' coperta da test.

---

## Metriche Di Produzione

Da rendere visibili in debug panel o log strutturato:

```text
chat.time_to_first_delta_ms
chat.total_turn_ms
memory.recall_total_ms
memory.lock_wait_ms
memory.query_embedding_ms
memory.vector_search_ms
memory.degraded
browser.action_count
browser.action_error_kind
vault.proposal_count
vault.reveal_count
approval.pending_count
approval.completed_count
```

Queste metriche devono poter essere lette senza aprire DevTools:

```text
log file gateway
SQLite trace table o tool_trace
debug export chat
```

---

## Rischi E Contromisure

| Rischio | Contromisura |
|---|---|
| Refactor troppo grande | Fasi piccole, commit atomici, nessun terzo motore |
| Perdita ricchezza memoria | RRF/FTS/grafo restano, si ottimizza solo retrieval |
| Marker legacy ancora necessari | Dual emit: eventi tipizzati nuovi + parser marker fallback |
| Vault troppo esposto | Nessun raw secret in prompt/tool result/transcript/log |
| Produzione senza evidenza | Smoke live obbligatoria per ogni slice user-facing |
| Main.rs resta enorme | Estrazioni solo dopo test e stabilizzazione del confine |

---

## Definizione Di "Production-Ready" Per La Prima Beta

Homun puo' essere considerato beta-production quando:

- una chat semplice risponde stabilmente;
- la memoria non blocca il turno oltre budget e degrada in modo esplicito;
- Vault intercetta, salva e rivela via PIN senza leak;
- browser naviga, cerca, compila form e mostra pannello leggibile;
- scritture e pagamenti hanno conferma esplicita;
- Telegram puo' autorizzare riepiloghi/azioni configurate senza ricevere segreti grezzi;
- crash/provider failure producono stato recuperabile;
- installer firmato/notarizzato passa smoke su macchina pulita;
- `docs/STATO.md` e `docs/architecture/*` descrivono la realta' corrente.

---

## Self-Review

- **Spec coverage:** copre preservazione del lavoro esistente, memoria/vettorializzazione, structured chat, browser, Vault/payment, produzione e modularizzazione.
- **ADR 0021:** rispettata: niente drive come motore, niente terza implementazione.
- **Capisaldi:** memoria resta unico layer condiviso; Vault resta separato per segreti; local-first preservato.
- **Gaps intenzionali:** non sceglie ancora `sqlite-vec` vs `usearch`; quella decisione richiede spike di build/package.
