# Handoff — A2: motore supervisore proattivo (primo addon)

> Documento di passaggio per aprire A2 in una chat nuova e focalizzata.
> A2 è il pezzo più delicato dell'arco proattività: merita una run a mente fresca.

## Contesto in una frase

**Homun** è un assistente personale **local-first**: gateway Rust (`crates/desktop-gateway`,
axum, 127.0.0.1:18765) + frontend Electron/React (`apps/desktop`). Stiamo costruendo la
**dashboard proattiva** come **PRIMO addon** del prodotto (la fatturazione sarà il secondo).
Decisione di prodotto e architettura in [ADR 0011](decisions/0011-agnostic-core-addon-ecosystem.md),
§6–10 (Addendum 2026-06-13).

## Dove siamo nell'arco A

Percorso **A (moduli interni dietro un registry, ORA) → B (esterni/sandboxed/marketplace+pagamento, DOPO)**.
Ordine dei pezzi di A, deciso insieme:

- **A1 — store suggerimenti** ✅ FATTO (commit `4e8eef3`). La spina-dati delle card.
- **A2 — motore supervisore** ⬅️ QUESTO. Il turno LLM read-only che emette card ancorate.
- **A3 — dashboard panel** (frontend zen-but-expandable: ultima/più rilevante per progetto + "+N" + filtri; accetta/scarta/►apri-chat-nel-workspace).
- **A4 — registro plugin + manifesto** che avvolge {nav + pannello + motore + capability}: qui il contratto cristallizza (nella forma di B). *Il contratto si estrae da un addon reale, non si specifica prima.*
- **A5 — feedback → memoria** (liked/disliked condiziona i prossimi suggerimenti).

## Cosa c'è già (A1) — la base su cui A2 scrive

Tabella `suggestions` + struct + metodi store + endpoint. **Additivo** (la coda `curiosities`
di Homun resta per ora; A2 NON la rimuove).

- **Schema** `suggestions` in [chat_store.rs:1383](../crates/desktop-gateway/src/chat_store.rs):
  `id, scope, kind, title, body, rationale, proposed_action?, status('pending'|'accepted'|'dismissed'|'snoozed'),
  feedback('liked'|'disliked')?, feedback_note?, dedup_key, created_at, updated_at`.
  Indici: `(scope,status)`, `(scope,dedup_key)`.
  - `scope` = un workspace id **oppure** `__personal__`.
  - `kind` = **libero**, scelto dal modello — **niente catalogo di regole**.
- **Struct** `SuggestionInput` ([chat_store.rs:52](../crates/desktop-gateway/src/chat_store.rs)) e
  `SuggestionRow` (~:66); mapper `map_suggestion` (~:167).
- **Metodi store** (~:1696–1800):
  - `suggestion_dedup_exists(scope, dedup_key) -> bool` — **no-repeat DUREVOLE**: true anche se la card è già stata `dismissed`.
  - `insert_suggestion(&SuggestionInput) -> i64`
  - `pending_suggestions(scope: Option<&str>, limit) -> Vec<SuggestionRow>`
  - `pending_suggestion_counts() -> Vec<(scope, count)>` — per il badge zen "+N".
  - `set_suggestion_status(id, status, feedback?, feedback_note?)`
- **Endpoint**: `GET /api/suggestions?scope=&limit=` ([main.rs:11933](../crates/desktop-gateway/src/main.rs)) ·
  `POST /api/suggestions/{id}/act` (~:11983); route registrate a [main.rs:525-526](../crates/desktop-gateway/src/main.rs).
- **Test**: `suggestions_dedup_list_and_act` ([chat_store.rs:2143](../crates/desktop-gateway/src/chat_store.rs)).

## A2 — cosa costruire

Un **motore supervisore**: un turno LLM **read-only** che, per uno **scope** (un workspace o
`__personal__`), **assembla il contesto reale** e decide se c'è qualcosa che vale la pena
segnalare → emette **al massimo UNA card ancorata** nello store `suggestions` (con dedup).
Più un **endpoint di trigger manuale** per testarlo end-to-end subito (analogo a
`POST /api/homun/checkin-now`).

### Principi VINCOLANTI (parole dell'utente — non negoziabili)

1. **Adattivo, NON un catalogo di regole.** Niente observer hardcoded (staleness/scadenze/pattern
   erano *esempi*, non regole). Il modello capisce dall'uso e dal progetto cosa può servire.
   «Creare regole statiche va contro la forza di un LLM. Vanno bene i guardrail, il resto deve
   essere semplice: prendiamo già le info sul progetto, va solo analizzato e capito cosa serve.»
2. **Guardrail sì, regole no.** I guardrail sono: **read-only** per osservare+proporre; **gated**
   per agire (qualunque azione passa dal gate di approvazione esistente); ogni card **grounded**
   nel contesto reale (no speculazione); **no-repeat durevole**.
3. **Una card per volta** (zen). Non scommini la coda; emetti la cosa più rilevante.
4. **Supervisore, non chatbot.** Esempio dell'utente: «collego Trello o Mattermost e analizzando
   i messaggi mi dici: ci sono queste cose da fare, sono già andato a vedere il progetto e forse
   la problematica è questa.»
5. **La card è la superficie, NON la chat.** Il motore tagga lo `scope`; l'apertura della chat nel
   workspace giusto avviene in A3 (engage → chat). Questo **dissolve** il problema di scoping dei
   task proattivi: il motore gira centralmente, le card sono scope-tagged, la chat pesante si
   materializza on-demand nel posto giusto.

### Slice consigliata (bounded, testabile, committabile come A1)

1. **Assemblaggio contesto per scope** (read-only): grafo di progetto + memoria/decisioni + fonti
   connesse. Riusa i tool già esistenti invece di reinventare:
   - `recall_memory` (memoria/decisioni dello scope) — [main.rs:3620](../crates/desktop-gateway/src/main.rs).
   - `query_code_graph` (grafo del codice del progetto) — [main.rs:3991](../crates/desktop-gateway/src/main.rs).
   - fonti connesse via Composio/MCP (es. Trello/Mattermost) — lettura, dentro il perimetro.
2. **Review turn**: chiama `run_agent_turn(state, thread_id, prompt, tool_policy)`
   ([main.rs:14363](../crates/desktop-gateway/src/main.rs)) con `tool_policy` **read-only** (vedi i set
   read-only a [main.rs:3269](../crates/desktop-gateway/src/main.rs) e ~:8071). Output **strutturato**:
   `{ emit: bool, kind, title, body, rationale, proposed_action?, dedup_key }`.
3. **Emit ancorato + dedup**: se `emit` e `!suggestion_dedup_exists(scope, dedup_key)` →
   `insert_suggestion`. Una sola card per run.
4. **Endpoint force/test**: `POST /api/proactivity/review-now { scope }` (gemello di
   `homun_checkin_now`, [main.rs:1457](../crates/desktop-gateway/src/main.rs)) → esegue una review
   sincrona e ritorna la card emessa (o `null`). Serve a verificare il path end-to-end senza
   aspettare un trigger.
5. **Trigger** (in seguito / o subito minimale): idle reale + nuova attività connettore
   (Auto-G2 ConnectorPoll). NON polling costante. Helpers: `now_local()` ([main.rs:11672](../crates/desktop-gateway/src/main.rs)),
   `seconds_since_user_activity()` (~:12596), `homun_idle_threshold_secs()` (~:12604).

### Scelte di design da rendere TRASPARENTI (incidono sul contratto A4)

Decidile esplicitamente con l'utente prima di scolpire codice — plasmano il manifesto/capability di A4:

- **Come si calcola `dedup_key`** (stabile e semantico: es. `kind + entità/oggetto coinvolto`,
  non l'hash del testo che cambia a ogni parafrasi).
- **Quale contesto si assembla per scope** e con che budget (token/round): è il "capability set"
  che A4 esporrà ai plugin.
- **Struttura del review prompt** (cosa rende una segnalazione "degna" e grounded; come evitare
  il rumore): è il cuore della precisione/fiducia.

## Vincoli operativi (dev)

- **Build gateway**: `cargo build -p local-first-desktop-gateway`.
- **Test**: `cargo test -p local-first-desktop-gateway` (atteso verde: lib + main; A1 lasciava
  "114 passed; 1 ignored" su main).
- **Restart dev** (per endpoint live): killare l'albero `scripts/electron-dev.mjs` + `npm run electron:dev`
  (background). Token gateway: `~/.local-first-personal-assistant/desktop-gateway-token`.
- **Stile**: additivo, riusa i pezzi esistenti (run_agent_turn, recall_memory, query_code_graph,
  dedup di A1). Commit incrementale + test, come A1.

## Vincoli di SICUREZZA (perimetro — non regredire)

Vedi memoria `sicurezza-canali-perimetro.md`. Invarianti:
- Il motore è **read-only per osservare+proporre**; **qualunque azione passa dal gate di
  approvazione** (mai azione diretta).
- Perimetro anti-esfiltrazione: `contact_only` blocca recall_memory + connettori al dispatch;
  `can_see_contacts`/`can_see_calendar` sono **fail-closed** anche al dispatch. Le card di uno
  scope non devono far trapelare contesto fuori dal perimetro.
- **NON** hard-delete di dati/segreti dell'utente: si indirizza l'utente a farlo da sé.

## Documenti e memoria da leggere prima

- [docs/decisions/0011-agnostic-core-addon-ecosystem.md](decisions/0011-agnostic-core-addon-ecosystem.md) — §6–10: addon=pannello+motore; card=superficie; supervisore adattivo; dashboard=primo addon; A→B + analisi B.
- [docs/state-of-project-2026-06-13.md](state-of-project-2026-06-13.md) — visione d'insieme aggiornata.
- Memoria (`~/.claude/projects/-Users-fabio-Projects-local-first-personal-assistant/memory/`):
  - `homun-apprendista.md` — proattività risolta + coda curiosità (il no-repeat di Homun) + follow-up scoping.
  - `sicurezza-canali-perimetro.md` — invarianti del perimetro.
  - `automations-model.md` — Automation vs TaskRecord; trigger→azione agentica.
  - `capability-router.md` — core piccolo + tool deferred (rilevante per "capability set" di A4).
