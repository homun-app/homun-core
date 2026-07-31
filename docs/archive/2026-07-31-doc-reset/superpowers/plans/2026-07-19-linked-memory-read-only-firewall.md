# Linked Memory Read-Only Firewall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Impedire che una risposta informata da memorie collegate venga copiata nella memoria consumer o riutilizzata dopo la revoca, mantenendo il transcript visibile, l'apprendimento dell'input utente e il recall autorizzato a grafo.

**Architecture:** Gli hit autorizzati producono un read set strutturato che attraversa stream, agent loop e outcome. Il gateway lo converte in un envelope persistito atomicamente con la risposta. Il learner riceve materiale già filtrato dalla write policy; la cronologia inviata al modello passa da un context firewall server-side che rivalida grant, policy, ref e revisione. Compattazione, pubblicazione e repair usano lo stesso confine fail-closed.

**Tech Stack:** Rust 2024, SQLite/rusqlite + FTS5, Axum, serde/serde_json, sha2, React/TypeScript, test Rust e Node.

---

## Vincoli di esecuzione

- Lavorare nel worktree `/Users/fabio/Projects/Homun/app/.worktrees/fabio/graph-recall` sul branch `fabio/graph-recall`.
- La specifica autoritativa è `docs/superpowers/specs/2026-07-19-linked-memory-read-only-firewall-design.md`.
- Applicare TDD a ogni task: test rosso, modifica minima, test verde, commit dedicato.
- Non aggiungere trailer `Co-Authored-By`.
- Non usare il testo per riconoscere dati derivati: tutte le decisioni dipendono da provenance strutturata.
- Non modificare la memoria source né cancellare il transcript.
- Un errore o una provenance ambigua produce `BlockedUnknown`, mai `Normal`.
- Eseguire il repair legacy solo dopo che write e context firewall sono attivi.
- Le prove sui database reali usano copie consistenti; l'apply sui file reali resta un checkpoint esplicito.

## Baseline da acquisire prima delle modifiche

- [ ] Eseguire:

```bash
cargo test -p local-first-engine
cargo test -p local-first-memory --test multi_source_recall -- --test-threads=1
cargo test -p local-first-desktop-gateway chat_store -- --test-threads=1
npm --prefix apps/desktop run typecheck
```

Expected: annotare separatamente eventuali failure preesistenti; non descrivere come verde una suite esclusa o interrotta.

## Mappa delle responsabilità

### Tipi e loop

- `crates/engine/src/events.rs` — provenance serializzabile di un hit e read set del turno.
- `crates/engine/src/contract.rs` — `ToolEffects.memory_reads` per riportare al loop le letture del tool.
- `crates/engine/src/loop_state.rs` — accumulatore deduplicato del turno.
- `crates/engine/src/outcome.rs` — trasferimento del read set al post-turn tail.
- `crates/engine/src/agent_loop.rs` — applicazione degli effetti e consegna dell'outcome.

### Recall e write policy

- `crates/memory/src/service.rs` — `MemoryWritePolicy`, `MemoryReuseEnvelope`, `Exchange` e filtro del materiale apprendibile.
- `crates/memory/src/recall.rs` — revisione stabile del record e popolamento della provenance.
- `crates/memory/src/facade.rs` — rivalidazione fail-closed di una lettura collegata.
- `crates/memory/src/learn.rs` — extractor, episodio, grafo e backfill ricevono solo materiale consentito.
- `crates/memory/tests/linked_memory_firewall.rs` — contratto unitario del write firewall.

### Gateway, repair e desktop

- `crates/desktop-gateway/src/lib.rs` — DTO del messaggio con envelope pubblico.
- `crates/desktop-gateway/src/chat_store.rs` — colonna, migrazione, finalizzazione atomica e lettura legacy.
- `crates/desktop-gateway/src/main.rs` — collector, tail di learning, filtro contesto, episodi e compattazione.
- `crates/desktop-gateway/src/linked_memory_repair.rs` — preview/apply della bonifica legacy.
- `crates/desktop-gateway/src/integrity_api.rs` — report metadata-only del repair.
- `apps/desktop/src/lib/coreBridge.ts` — `source_revision` ed envelope TypeScript.
- `apps/desktop/src/components/MemoryUsagePopover.tsx` — nessuna pubblicazione per hit collegati.
- `apps/desktop/src/lib/contextBudget.ts` e `apps/desktop/src/lib/chatApi.ts` — il client non è autorità per il contesto riusabile.

## Task 1: Aggiungere revisione stabile e read set tipizzato

**Files:**
- Modify: `crates/memory/src/service.rs`
- Modify: `crates/memory/src/recall.rs`
- Modify: `crates/memory/src/facade.rs`
- Modify: `crates/engine/src/events.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `apps/desktop/src/lib/coreBridge.ts`
- Test: `crates/memory/tests/multi_source_recall.rs`

- [ ] **Step 1: Scrivere i test rossi della revisione e della serializzazione**

Nel test multi-source verificare che un hit collegato abbia una revisione non vuota e che una modifica del record la cambi. Nel test di `events.rs` verificare compatibilità legacy e round-trip:

```rust
#[test]
fn linked_recall_hit_round_trips_its_source_revision() {
    let hit = RecallStreamHit {
        r#ref: "memory://local-user/source/fact-1".into(),
        text: "redacted in audit".into(),
        score: 0.9,
        kind: "fact".into(),
        source_workspace_id: "source".into(),
        source_label: "Source".into(),
        collection: "knowledge".into(),
        grant_id: Some("grant-1".into()),
        policy_version: Some(7),
        source_revision: Some("sha256:abc".into()),
        conflict: false,
        graph_path: vec![],
    };
    let value = serde_json::to_value(&hit).unwrap();
    assert_eq!(value["source_revision"], "sha256:abc");
    let decoded: RecallStreamHit = serde_json::from_value(value).unwrap();
    assert_eq!(decoded.source_revision.as_deref(), Some("sha256:abc"));
}
```

- [ ] **Step 2: Verificare RED**

```bash
cargo test -p local-first-engine linked_recall_hit_round_trips_its_source_revision -- --exact
cargo test -p local-first-memory --test multi_source_recall linked_hit_revision_changes_with_the_source -- --exact
```

Expected: FAIL perché `source_revision` e l'helper non esistono.

- [ ] **Step 3: Implementare una revisione canonica**

In `service.rs`:

```rust
pub fn memory_record_revision(record: &MemoryRecord) -> String {
    let encoded = serde_json::to_vec(record).expect("MemoryRecord is serializable");
    format!("sha256:{:x}", Sha256::digest(encoded))
}
```

Aggiungere `source_revision: String` a `RecallHit`; valorizzarlo in `recall_hit_from_record` con il record già autorizzato. Non derivarlo da testo formattato, query o solo timestamp.

- [ ] **Step 4: Estendere il contratto engine**

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, PartialOrd, Ord)]
pub struct LinkedMemoryRead {
    pub source_workspace_id: String,
    pub grant_id: String,
    pub policy_version: u64,
    pub memory_ref: String,
    pub source_revision: String,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnMemoryReadSet {
    pub linked: Vec<LinkedMemoryRead>,
}
```

Aggiungere `#[serde(default)] pub source_revision: Option<String>` a `RecallStreamHit`. `TurnMemoryReadSet::extend_payload` accetta solo tuple complete, ordinate e deduplicate. Gli hit locali non entrano nel set.

- [ ] **Step 5: Mappare la revisione fino al desktop**

Aggiornare `recall_stream_payload_from_pack` e tutti i costruttori manuali. Nel frontend:

```ts
export interface RecallHitPayload {
  ref: string;
  source_workspace_id: string;
  grant_id: string | null;
  policy_version?: number | null;
  source_revision?: string | null;
}
```

- [ ] **Step 6: Verificare GREEN e commit**

```bash
cargo test -p local-first-engine
cargo test -p local-first-memory --test multi_source_recall -- --test-threads=1
npm --prefix apps/desktop run typecheck
git add crates/engine/src/events.rs crates/memory/src/service.rs crates/memory/src/recall.rs crates/memory/src/facade.rs crates/desktop-gateway/src/main.rs apps/desktop/src/lib/coreBridge.ts crates/memory/tests/multi_source_recall.rs
git commit -m "feat(memory): version linked recall reads"
```

## Task 2: Accumulare recall automatico ed esplicito nello stesso outcome

**Files:**
- Modify: `crates/engine/src/contract.rs`
- Modify: `crates/engine/src/loop_state.rs`
- Modify: `crates/engine/src/outcome.rs`
- Modify: `crates/engine/src/agent_loop.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Scrivere i test rossi del collector**

Verificare che `LoopState::apply_effects` unisca due letture, deduplichi la stessa tupla e mantenga grant diverse. Aggiungere un test del loop in cui `recall_memory` restituisce `ToolEffects.memory_reads` e l'outcome le contiene:

```rust
let mut effects = ToolEffects::default();
effects.memory_reads.linked = vec![linked_read("grant-a", 2, "ref-a", "rev-a")];
state.apply_effects(&mut pending, 1, effects.clone());
state.apply_effects(&mut pending, 2, effects);
assert_eq!(state.memory_reads.linked.len(), 1);
```

- [ ] **Step 2: Verificare RED**

```bash
cargo test -p local-first-engine loop_state_collects_linked_memory_reads -- --exact
cargo test -p local-first-engine recall_tool_reads_reach_turn_outcome -- --exact
```

- [ ] **Step 3: Collegare effetti, stato e outcome**

Aggiungere `memory_reads: TurnMemoryReadSet` a `ToolEffects`, `LoopState` e `TurnOutcome`. `apply_effects` usa un solo merge; `agent_loop` trasferisce `ls.memory_reads` su ogni exit, incluse rejection e fallback.

- [ ] **Step 4: Precaricare il recall automatico**

Subito prima di `run_agent_rounds`:

```rust
if let Some(payload) = automatic_recall_payload.as_ref() {
    ls.memory_reads.extend_payload(payload);
}
```

Non ricostruire il set dal blocco testuale.

- [ ] **Step 5: Riportare il payload del tool negli effetti**

Nel ramo `recall_memory`:

```rust
let payload = recall_stream_payload_from_outcome(&outcome, &query);
effects.memory_reads.extend_payload(&payload);
emit_stream_event(ctx.tx, GenerateStreamEvent::Recall { payload }).await;
```

- [ ] **Step 6: Verificare GREEN e commit**

```bash
cargo test -p local-first-engine
cargo test -p local-first-desktop-gateway recall_ -- --test-threads=1
git add crates/engine/src/contract.rs crates/engine/src/loop_state.rs crates/engine/src/outcome.rs crates/engine/src/agent_loop.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(agent): retain linked memory read sets"
```

## Task 3: Persistire l'envelope atomicamente con la risposta

**Files:**
- Modify: `crates/memory/src/service.rs`
- Modify: `crates/desktop-gateway/src/lib.rs`
- Modify: `crates/desktop-gateway/src/chat_store.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Definire write policy ed envelope**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryWritePolicy { Normal, UserInputOnly, BlockedUnknown }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryReuseEnvelope {
    pub write_policy: MemoryWritePolicy,
    pub linked_reads: Vec<LinkedMemoryReadRef>,
}
```

`LinkedMemoryReadRef` replica i soli identificativi del tipo engine; il gateway esegue la conversione e un test di parità impedisce drift senza creare dipendenze circolari.

- [ ] **Step 2: Scrivere i test rossi dello store**

Provare atomicità di testo/event parts/envelope, placeholder `BlockedUnknown`, failure senza fallback permissivo, legacy locale `Normal`, legacy con recall completo `UserInputOnly`, recall corrotto `BlockedUnknown`.

```rust
let saved = store.finalize_assistant_message(
    &thread.thread_id,
    &assistant.id,
    "answer",
    &[recall_part],
    &MemoryReuseEnvelope::user_input_only(vec![read]),
).unwrap();
assert_eq!(saved.memory_reuse.unwrap().write_policy, MemoryWritePolicy::UserInputOnly);
```

- [ ] **Step 3: Verificare RED**

```bash
cargo test -p local-first-desktop-gateway finalize_assistant_message_is_atomic -- --exact
cargo test -p local-first-desktop-gateway linked_legacy_event_fails_closed -- --exact
```

- [ ] **Step 4: Migrare `chat_messages`**

Aggiungere `memory_reuse_json text` a create/migration/insert/update/select. Esporre:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub memory_reuse: Option<MemoryReuseEnvelope>,
```

La derivazione legacy esamina gli event parts, mai il testo.

- [ ] **Step 5: Aggiungere la finalizzazione atomica**

Usare una sola transazione:

```sql
update chat_messages
set text = ?1, event_parts_json = ?2, memory_reuse_json = ?3
where thread_id = ?4 and id = ?5 and role = 'assistant'
```

Il placeholder nasce `BlockedUnknown`. I drain raccolgono event parts e finalizzano una volta su `done`; l'append live non può rendere permissivo il placeholder.

- [ ] **Step 6: Verificare GREEN e commit**

```bash
cargo test -p local-first-desktop-gateway chat_store -- --test-threads=1
git add crates/memory/src/service.rs crates/desktop-gateway/src/lib.rs crates/desktop-gateway/src/chat_store.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(chat): persist memory reuse envelopes atomically"
```

## Task 4: Rendere il gateway l'unica autorità del contesto modello

**Files:**
- Modify: `crates/memory/src/facade.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `apps/desktop/src/lib/chatApi.ts`
- Modify: `apps/desktop/src/lib/contextBudget.ts`

- [ ] **Step 1: Scrivere i test rossi di rivalidazione**

Coprire grant attiva/revocata/scaduta, versione diversa, ref rimossa, revisione diversa, deny override e source indisponibile:

```rust
pub fn validate_linked_memory_read(
    &self,
    consumer_user: &UserId,
    consumer_workspace: &WorkspaceId,
    read: &LinkedMemoryReadRef,
    now_unix: i64,
) -> MemoryResult<bool>;
```

La funzione risolve di nuovo le source dirette, trova la grant esatta, carica il record via `get_authorized_memory_for_source`, verifica currentness e revisione. Ogni errore vale `false`.

- [ ] **Step 2: Scrivere i test rossi del filtro**

```rust
#[test]
fn revoked_linked_answer_stays_visible_but_is_not_model_context() {
    let visible = store.messages("thread-a").unwrap();
    assert!(visible.messages.iter().any(|m| m.text.contains("NEBULA-7429")));
    let context = agent_turn_context(&state, "thread-a", &[]).unwrap();
    assert!(!context.iter().any(|m| m.text.contains("NEBULA-7429")));
}
```

Aggiungere il caso multi-grant: una sola lettura invalida esclude l'intero messaggio.

- [ ] **Step 3: Verificare RED**

```bash
cargo test -p local-first-memory validate_linked_memory_read -- --nocapture
cargo test -p local-first-desktop-gateway revoked_linked_answer_stays_visible_but_is_not_model_context -- --exact
```

- [ ] **Step 4: Implementare `context_message_for_model`**

```rust
fn context_message_for_model(
    facade: &MemoryFacade,
    consumer: (&MemoryUserId, &MemoryWorkspaceId),
    message: &ChatMessage,
    now_unix: i64,
) -> Option<ChatContextMessage>
```

`Normal` mantiene il testo. `UserInputOnly` lo mantiene solo se tutte le letture rivalidano. `BlockedUnknown`, JSON corrotto o una lettura invalida produce una nota neutra priva di dati source. I messaggi utente restano.

- [ ] **Step 5: Ignorare la cronologia client per thread persistiti**

Prima di `build_chat_runtime_prompt`, costruire `effective_context` dal `ChatStore` filtrato. Usare lo stesso helper per broker, automazioni e canali. `request.context` resta fallback solo senza thread e non attesta provenance collegata. Il desktop non implementa logica grant-side.

- [ ] **Step 6: Verificare GREEN e commit**

```bash
cargo test -p local-first-memory validate_linked_memory_read -- --nocapture
cargo test -p local-first-desktop-gateway context_ -- --test-threads=1
npm --prefix apps/desktop run test:electron
git add crates/memory/src/facade.rs crates/desktop-gateway/src/main.rs apps/desktop/src/lib/chatApi.ts apps/desktop/src/lib/contextBudget.ts apps/desktop/tests
git commit -m "feat(memory): filter revoked answers from model context"
```

## Task 5: Applicare il write firewall al learner

**Files:**
- Modify: `crates/memory/src/service.rs`
- Modify: `crates/memory/src/learn.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Create: `crates/memory/tests/linked_memory_firewall.rs`

- [ ] **Step 1: Scrivere i test rossi del materiale apprendibile**

```rust
#[test]
fn linked_turn_exposes_only_direct_user_input_to_the_extractor() {
    let exchange = Exchange {
        user_message: "Il mio colore locale è verde".into(),
        assistant_message: "Il codice collegato è NEBULA-7429".into(),
        actions: "recall_memory returned NEBULA-7429".into(),
        reuse_envelope: MemoryReuseEnvelope::user_input_only(vec![read()]),
        ..Exchange::default()
    };
    let material = exchange.learn_material().unwrap();
    assert_eq!(material.user_message, "Il mio colore locale è verde");
    assert!(material.assistant_message.is_empty());
    assert!(material.actions.is_empty());
    assert!(material.prev_assistant.is_none());
}
```

Il test di persistenza dimostra che il fatto utente viene salvato, mentre sentinel, episodio, entità e relazione della risposta non compaiono.

- [ ] **Step 2: Verificare RED**

```bash
cargo test -p local-first-memory --test linked_memory_firewall -- --nocapture
```

- [ ] **Step 3: Rendere la policy obbligatoria su `Exchange`**

```rust
pub struct LearnMaterial {
    pub user_message: String,
    pub assistant_message: String,
    pub actions: String,
    pub prev_assistant: Option<String>,
}
```

`Normal` copia i campi, `UserInputOnly` conserva solo `user_message`, `BlockedUnknown` restituisce `None`.

- [ ] **Step 4: Filtrare prima dell'extractor**

`MemoryRecallService::learn`, `learn_via_service_or_inline` e `prepare_learn_prompt` ricevono `Exchange` e chiamano `learn_material` prima di comporre il prompt. Il payload vietato deve essere assente, non accompagnato da un'istruzione “non copiare”.

- [ ] **Step 5: Governare hook e writer futuri**

`persist_learn_extraction` riceve la write policy attestata. Con `UserInputOnly`, episode/grafo/backfill lavorano solo sull'estrazione del solo input utente. Con `BlockedUnknown` non vengono chiamati. Eliminare entrypoint pubblici privi di policy.

- [ ] **Step 6: Collegare il tail**

Convertire `outcome.memory_reads` nell'envelope una sola volta e usarlo sia per finalizzare il messaggio sia per `Exchange.reuse_envelope`. Una revoca concorrente non trasforma mai il tail in `Normal`.

- [ ] **Step 7: Verificare GREEN e commit**

```bash
cargo test -p local-first-memory --test linked_memory_firewall -- --test-threads=1
cargo test -p local-first-memory --test memory_evolution -- --test-threads=1
cargo test -p local-first-desktop-gateway learn_ -- --test-threads=1
git add crates/memory/src/service.rs crates/memory/src/learn.rs crates/memory/tests/linked_memory_firewall.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(memory): block derived writes from linked recall"
```

## Task 6: Chiudere il bypass episodi e rendere la compattazione provenance-aware

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/engine/src/contract.rs`
- Modify: `crates/engine/src/agent_loop.rs`

- [ ] **Step 1: Scrivere il test rosso `__threads__`**

Inserire un episodio con metadata del consumer e verificare che `recall_memory` non lo sintetizzi come hit locale:

```rust
let outcome = recall_memory(&state, "NEBULA");
assert!(!outcome.payload.hits.iter().any(|hit| {
    hit.kind == "conversation" && hit.grant_id.is_none() && hit.r#ref.is_empty()
}));
```

- [ ] **Step 2: Rimuovere il secondo percorso di recall**

Eliminare la lettura diretta `list_memories_for_ui(__threads__)` e gli hit con ref vuota/source consumer. La cronologia arriva dal transcript filtrato; episodi durevoli entrano solo come record canonici attraverso il coordinatore.

- [ ] **Step 3: Scrivere i test rossi di compattazione**

Coprire: read set vuoto con checkpoint; read set collegato senza learner/checkpoint; cronologia filtrata dopo revoca senza sentinel nel summarizer; transcript invariato.

- [ ] **Step 4: Passare il read set al compactor**

```rust
fn compact_for_budget(
    &self,
    messages: &mut Vec<Value>,
    context_window: Option<usize>,
    memory_reads: &TurnMemoryReadSet,
) -> impl Future<Output = ()> + Send;
```

`agent_loop` passa `&ls.memory_reads`. Con letture collegate `GatewayContextCompactor` non invoca il learner. La sintesi effimera del turno può proseguire ma non viene persistita.

- [ ] **Step 5: Verificare GREEN e commit**

```bash
cargo test -p local-first-engine compaction -- --nocapture
cargo test -p local-first-desktop-gateway compact_ -- --test-threads=1
cargo test -p local-first-desktop-gateway recall_memory_does_not_relabel_thread_episodes -- --exact
git add crates/engine/src/contract.rs crates/engine/src/agent_loop.rs crates/desktop-gateway/src/main.rs
git commit -m "fix(memory): close episode and compaction bypasses"
```

## Task 7: Vietare la pubblicazione collegata anche lato server

**Files:**
- Modify: `crates/memory/src/store.rs`
- Modify: `crates/memory/src/facade.rs`
- Test: `crates/memory/tests/publication.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `apps/desktop/src/components/MemoryUsagePopover.tsx`
- Modify: `apps/desktop/src/i18n/locales/{en,it,es,fr,de}.json`

- [ ] **Step 1: Scrivere i test rossi server/UI**

Aggiungere una query strutturale che riconosce se la coppia source→consumer è stata autorizzata da una grant, compresa una grant ora revocata o scaduta:

```rust
pub fn has_memory_source_grant_link(
    &self,
    consumer_user: &UserId,
    consumer_workspace: &WorkspaceId,
    source_workspace: &WorkspaceId,
) -> MemoryResult<bool>;
```

Creare una grant source→consumer, richiamare la route di pubblicazione senza alcun hint client e attendere `409 linked_memory_read_only`. Ripetere dopo revoca e scadenza: la route deve ancora rifiutare, perché scollegare la source non autorizza una copia. Un test memory separato prova che una pubblicazione tra workspace mai collegati conserva il comportamento preesistente. Il contratto UI verifica che un hit con grant non esponga pubblicazione.

- [ ] **Step 2: Verificare RED**

```bash
cargo test -p local-first-desktop-gateway publication_rejects_linked_recall_hit -- --exact
npm --prefix apps/desktop run test:ui-contract
```

- [ ] **Step 3: Applicare il blocco server-side prima di caricare la source**

`memory_publication_create` interroga il ledger delle grant usando `destination_workspace_id` come consumer e `source_workspace_id` come source. Se esiste una grant storica per quella direzione, rifiuta e non crea proposal. Il client non può bypassare il controllo omettendo provenance. Conservare la pubblicazione di record locali tra scope che non sono mai stati collegati in quella direzione. Non aggiungere azioni alternative di copia. Aggiungere il reason code `linked_memory_read_only` a tutti e cinque i cataloghi UI.

- [ ] **Step 4: Verificare GREEN e commit**

```bash
cargo test -p local-first-desktop-gateway publication_ -- --test-threads=1
cargo test -p local-first-memory --test publication -- --test-threads=1
npm --prefix apps/desktop run test:ui-contract
npm --prefix apps/desktop run typecheck
git add crates/memory/src/store.rs crates/memory/src/facade.rs crates/memory/tests/publication.rs crates/desktop-gateway/src/main.rs apps/desktop/src/components/MemoryUsagePopover.tsx apps/desktop/src/i18n/locales
git commit -m "fix(memory): reject publication of linked recall hits"
```

## Task 8: Bonifica legacy con preview, backup e apply idempotente

**Files:**
- Create: `crates/desktop-gateway/src/linked_memory_repair.rs`
- Modify: `crates/desktop-gateway/src/lib.rs`
- Modify: `crates/desktop-gateway/src/integrity_api.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/memory/src/store.rs`
- Modify: `crates/memory/src/operations.rs`

- [ ] **Step 1: Scrivere una fixture strutturalmente contaminata**

Includere event part con grant/version/ref/revision, episodio `__threads__`, memoria automatica consumer con `metadata.thread_id`, embedding, entità/relazione e Wiki derivati. Preservare un record manuale e un grafo codice `source=graphify`. Il report non deve contenere testo o sentinel.

- [ ] **Step 2: Scrivere test rossi di checksum, backup e rollback**

```rust
let preview = preview_linked_memory_repair(&fixture.paths()).unwrap();
assert!(!serde_json::to_string(&preview).unwrap().contains("NEBULA-7429"));
let stale = apply_linked_memory_repair(&fixture.paths(), preview.with_wrong_checksum());
assert!(matches!(stale, Err(LinkedRepairError::StalePreview)));
```

Aggiungere failure injection dopo la prima mutazione e verificare il ripristino di entrambi i database.

- [ ] **Step 3: Verificare RED**

```bash
cargo test -p local-first-desktop-gateway linked_memory_repair -- --test-threads=1
```

- [ ] **Step 4: Implementare l'individuazione strutturale**

```rust
pub struct LinkedMemoryRepairPreview {
    pub audit_checksum: String,
    pub approval_token: String,
    pub contaminated_threads: u64,
    pub assistant_envelopes_to_backfill: u64,
    pub memories_to_remove: u64,
    pub episodes_to_remove: u64,
    pub derived_rows_to_rebuild: u64,
}
```

Leggere `event_parts_json`, selezionare recall con grant e ricavare record automatici tramite `metadata.thread_id`. Il checksum copre ID ordinati e revisioni dei due database, non il testo nel report.

- [ ] **Step 5: Implementare apply conservativo**

Sotto lock: rivalidare checksum/token; creare backup nuovi di `homun.sqlite` e `memory.sqlite`; backfillare envelope; eliminare/quarantenare solo record automatici; rimuovere derived orfani; ricostruire FTS con `rebuild_memory_search_index_on(&transaction)`; ricostruire grafo-memory, Wiki e briefing senza `source=graphify`; eseguire `quick_check`; a ogni errore ripristinare entrambi i backup. Non eliminare grant, access event, source o transcript.

- [ ] **Step 6: Provare idempotenza**

Dopo apply, seconda preview a zero; due rebuild producono stesse ref e stesso numero di relazioni.

- [ ] **Step 7: Verificare GREEN e commit**

```bash
cargo test -p local-first-memory integrity_repair -- --test-threads=1
cargo test -p local-first-desktop-gateway linked_memory_repair -- --test-threads=1
git add crates/desktop-gateway/src/linked_memory_repair.rs crates/desktop-gateway/src/lib.rs crates/desktop-gateway/src/integrity_api.rs crates/desktop-gateway/src/main.rs crates/memory/src/store.rs crates/memory/src/operations.rs
git commit -m "feat(memory): repair legacy linked-memory derivatives"
```

## Task 9: Coprire scenario completo e regressioni

**Files:**
- Create: `crates/desktop-gateway/tests/linked_memory_read_only.rs`
- Modify: `crates/memory/tests/multi_source_recall.rs`
- Modify: `crates/memory/tests/memory_evolution.rs`
- Modify: `apps/desktop/src/lib/coreBridge.ts`

- [ ] **Step 1: Costruire un harness SQLite temporaneo**

Eseguire: source personale con sentinel e grant; recall automatico e tool; finalizzazione/riapertura; provenance e `UserInputOnly`; assenza sentinel in consumer, `__threads__`, FTS, embedding, entità, relazioni, Wiki e briefing; fatto locale utente salvato; revoca; transcript visibile/context filtrato; nuova chat; secondo progetto; riavvio.

- [ ] **Step 2: Aggiungere casi fail-closed**

Coprire source indisponibile, grant scaduta, policy diversa, revisione cambiata, deny, envelope corrotto, più grant con una invalida e crash prima della finalizzazione.

- [ ] **Step 3: Eseguire suite mirate**

```bash
cargo test -p local-first-desktop-gateway --test linked_memory_read_only -- --test-threads=1
cargo test -p local-first-memory --test multi_source_recall -- --test-threads=1
cargo test -p local-first-memory --test memory_evolution -- --test-threads=1
cargo test -p local-first-memory --test source_grants -- --test-threads=1
npm --prefix apps/desktop run test:ui-contract
npm --prefix apps/desktop run test:electron
npm --prefix apps/desktop run typecheck
```

Expected: tutte verdi; nessuna keyword speciale per attivare la memoria.

- [ ] **Step 4: Commit**

```bash
git add crates/desktop-gateway/tests/linked_memory_read_only.rs crates/memory/tests/multi_source_recall.rs crates/memory/tests/memory_evolution.rs apps/desktop/src/lib/coreBridge.ts apps/desktop/tests
git commit -m "test(memory): prove linked reads remain read only"
```

## Task 10: Verifica finale, real-copy e build locale

**Files:**
- Modify: `docs/architecture/memory.md`
- Modify: `docs/MEMORIA.md`

- [ ] **Step 1: Aggiornare documentazione**

Documentare source canonica, envelope, transcript/contesto, revoca, write policy, repair e reason code. Rimuovere ogni suggerimento di pubblicare una memoria ottenuta via grant.

- [ ] **Step 2: Verifica Rust**

```bash
cargo fmt --all -- --check
cargo test -p local-first-engine
RUST_TEST_THREADS=1 cargo test -p local-first-memory -- --test-threads=1
RUST_TEST_THREADS=1 cargo test -p local-first-desktop-gateway -- --test-threads=1
```

Se una suite è esclusa o appesa, riportarlo e non dichiarare verde.

- [ ] **Step 3: Verifica desktop**

```bash
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop run test:ui-contract
npm --prefix apps/desktop run test:electron
npm --prefix apps/desktop run build
```

- [ ] **Step 4: Prova su copie reali**

Eseguire preview/apply su copie consistenti e verificare:

```sql
pragma quick_check;
select count(*) from memory_embeddings e left join memories m on m.ref=e.ref where m.ref is null;
select count(*) from relations r left join memories m on m.ref=r.source_ref where r.source_ref like 'memory:%' and m.ref is null;
```

Expected: `ok`, zero orfani, seconda preview no-op.

- [ ] **Step 5: Build ARM64 e scenario manuale**

Usare lo script di build locale del repository e una sentinel nuova: grant attiva con provenance; nessuna copia consumer; revoca; nuova chat senza sentinel; chat originale visibile ma non reiniettata; secondo progetto isolato; riavvio invariato.

- [ ] **Step 6: Self-review**

```bash
rg -n "list_memories_for_ui.*THREADS_WORKSPACE|conversation.*grant_id: None|learn_via_service_or_inline\\(|prepare_learn_prompt\\(|memory_reuse" crates/desktop-gateway/src crates/memory/src
rg -n "TODO|FIXME|placeholder|similar to|same as" crates/engine/src crates/memory/src crates/desktop-gateway/src apps/desktop/src
git diff --check
git status --short
```

Confrontare uno per uno i 25 casi della specifica. Verificare che ogni writer pubblico richieda policy, che i tipi engine/memory abbiano parità e che log/audit non serializzino testo richiamato.

- [ ] **Step 7: Commit documentazione**

```bash
git add docs/architecture/memory.md docs/MEMORIA.md
git commit -m "docs(memory): document linked read-only boundaries"
```

## Criterio di completamento

Il lavoro è completo solo con prove congiunte di: transcript visibile ma nessun dato derivato; fatto utente misto salvato; revoca/scadenza/policy/ref/revisione filtrate; nessun bypass episodi/compattazione; pubblicazione rifiutata; repair con backup/rollback/no-op; SQLite e proiezioni coerenti; suite e build realmente concluse; scenario Homun e secondo progetto superato dopo riavvio.
