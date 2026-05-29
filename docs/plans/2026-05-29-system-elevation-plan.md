# Piano di elevazione del sistema

Data: 2026-05-29
Basato su un'analisi a ventaglio dei sottosistemi (inference/gateway/chat,
browser automation, task-runtime/capability/brain/subagenti, memory/skill/
secrets/process, desktop UI). Tutte le voci citano file:riga reali.

## Diagnosi di fondo (il filo che unisce tutto)

Il progetto è un insieme di **librerie ben costruite e ben testate**, ma il
**gateway in produzione è una seconda implementazione parallela** che le
bypassa: routing a keyword e piano hardcoded sui treni, run loop dei task
re-implementato a mano, memoria usata solo in lettura, chat accoppiata a MLX
via HTTP fuori dal router. Quasi tutto il valore architetturale (Brain,
TaskRuntime facade, executor-trait, Memory Core, ModelRouter) è **esercitato
solo dai test, non da ciò che gira**.

> La leva numero uno NON è scrivere nuove feature, ma **chiudere la distanza tra
> ciò che è testato e ciò che è in esecuzione.**

A questo si aggiungono alcuni **buchi di sicurezza concreti** nel path attivo e
gap di **fiducia/UX** che minano il Product Loop.

---

## Tema 0 — Sicurezza (URGENTE, prima di tutto: basso sforzo, alto guadagno)

> STATO 2026-05-29: S1, S2, S3 FATTI; S4 fatto come slice "key da file 0600",
> resta S4-full (integrazione `local-first-secrets` con secret_ref). Vedi
> work-memory 2026-05-29 "M0 Sicurezza".

- **S1 — Auth gateway obbligatoria di default.** Oggi se il token env è vuoto,
  `require_gateway_token` disabilita del tutto l'auth (`desktop-gateway/src/main.rs:700`,
  `:7213`). Il gateway pilota browser e computer locale → un processo locale
  qualsiasi può comandarlo. Generare/persistere un token se assente; non partire
  mai "auth off".
- **S2 — Applicare i gate di policy nel loop browser attivo.** `BrowserPolicy::classify_tool_call`
  (`crates/browser-automation/src/policy.rs:55`) esiste ma è invocato solo dal
  vecchio executor; il loop reale chiama `Act` senza classificazione
  (`crates/browser-automation/src/browser_loop.rs:206`). Login/invio/acquisto
  sono fermati solo da regole testuali nel prompt di un LLM debole. Inserire il
  gate prima dell'azione, con `Blocked`/approval che risale al gateway.
- **S3 — Gate o rimozione di `evaluate` (JS arbitrario).** Esposto al planner
  (`browser_loop_controller.rs` NEXT_ALLOWED_TOOLS) ed eseguito via eval
  (`runtimes/browser-automation/src/browser/actions.ts`), senza approvazione +
  snapshot untrusted = catena prompt-injection→esecuzione. Classificare come
  `NeedsApproval` o toglierlo dal set di default.
- **S4 — API key cloud fuori dall'env.** ✅ FATTO (slice file-0600):
  `resolve_inference_api_key()` preferisce `LOCAL_FIRST_INFERENCE_API_KEY_FILE`
  (0600, non ereditato dai processi figli, non in `ps`/`/proc/environ`); env
  resta come fallback con warning.

### S4-full — Secret store at-rest cifrato (DIFFERITO, da fare dopo)

Lo slice di M0 riduce l'esposizione ma **la chiave resta in chiaro su disco** e
vive come `String` in memoria. S4-full completa il requisito ADR 0007 "API keys
in `local-first-secrets` (secret_ref only)". Scope:

- Risolvere la chiave da un `SecretRef` tramite `local-first-secrets`
  (`crates/secrets`), non da file/env in chiaro.
- Master key ancorata fuori dal disco in chiaro: `SystemKeychainSecretStore`
  (macOS oggi; aggiungere DPAPI/libsecret per Win/Linux) oppure passphrase
  utente; altrimenti `EncryptedFileSecretStore` è security theater.
- `zeroize` della chiave in `AnthropicProvider`/`OpenAiCompatProvider`
  (`String` -> `Zeroizing<String>`).
- Far passare il router builder (`build_browser_inference_router`) e, dopo A4,
  la chat dal secret store invece che da env/file.

Sforzo: MEDIO (la gestione corretta della master key è il vero costo).
Prerequisito utile: keychain cross-platform (vedi anche memory/secrets gap G8).

## Tema 1 — Chiudere il gap "testato vs in esecuzione" (cuore architetturale)

- **A1 — Promuovere l'OrchestratorBrain nel gateway, eliminare il routing a
  keyword.** Il Brain (`crates/orchestrator/`) è completo (tool search FTS,
  planner JSON, validazione DAG, anti-hallucination) ma instanziato **solo nei
  test**. Il gateway usa `operational_plan_for_goal`/`train_operational_plan_steps`
  e match su "treno/napoli/milano/frecciarossa" (`main.rs:3809`, `:4322`,
  `:5276`), violando PROJECT.md:1282. Instanziare il Brain in `AppState`,
  far passare il prompt da `brain.run()`, ritirare il keyword-matching.
  *Sforzo alto* (il Brain produce `ExecutionPlan`, il gateway parla
  `OperationalPlan`: serve un adapter; fare incrementale: prima `direct_answer`/
  `capability_call`, poi browser).
- **A2 — Convergere il run loop del gateway su `TaskRuntime`.** `run_next_task_once`
  (`main.rs:1326`) ricostruisce a mano governor+lease+scheduler invece di usare
  `TaskRuntime::run_ready_once` (`crates/task-runtime/src/facade.rs:52`).
  Un solo `TaskExecutor` dispatcher per `task.kind`, eliminando la duplicazione
  di scheduling/retry/checkpoint.
- **A3 — Worker di background per l'avanzamento autonomo dei task.** L'unico
  trigger è `POST /api/tasks/run_next` (`main.rs:658`): i task lunghi non
  avanzano da soli. Aggiungere un loop `tokio::spawn` periodico (post-A2) con
  backpressure sui limiti risorsa. Prerequisito di ogni automazione reale.
- **A4 — Far passare la chat dal `ModelRouter` (streaming).** La chat è
  hard-coupled a MLX HTTP (`generate_stream`, `main.rs:926`) e bypassa il
  router; il trait `InferenceProvider` ha solo `generate_json`. Aggiungere
  `generate_stream` (callback) al trait + router + provider, poi instradare
  l'handler chat dal router tenuto in `AppState`. **Fatto il mattone**: parser
  streaming OpenAI/SSE `crates/inference/src/streaming.rs` (tested).
- **A5 — Cablare la Memoria nel loop chat vivo.** Il Memory Core è il crate più
  maturo ma il gateway lo usa **solo in lettura** (`main.rs:4435`): non chiama
  mai `record_event`, l'estrazione candidate, né inietta `context_pack` nel
  prompt. `MemoryAgentImporter::import_result` non ha caller di produzione.
  Senza questo "l'assistant non impara". Cablare: dopo ogni turno record_event
  + MemoryAgent→importer; prima del prompt search/context_pack→context-compression.

## Tema 2 — Far completare i task all'agente locale (qualità browser)

- **B1 — Conferma combobox deterministica.** Su siti reali la listbox dei
  suggerimenti non è un ref `option`: il modello debole ri-digita all'infinito.
  Aggiungere in `actions.ts` un'azione/opzione che dopo `type` faccia
  `ArrowDown`+`Enter`, e un fixture rappresentativo (l'attuale espone i
  suggerimenti come ref cliccabili → falsa confidenza). È il blocker #1 per i
  modelli locali.
- **B2 — Stato del piano esplicito nel loop.** Tracciare lo step corrente e
  passarlo al prompt invece di farlo inferire dallo storico (con molte
  iterazioni i modelli deboli ricompilano campi pieni e oscillano).
- **B3 — De-hardcodare il piano browser** (confluisce in A1): generarlo dal
  Brain, ritirare `train_search_draft_for_goal` e le keyword italiane.
- **B4 — Fallback vision opzionale** quando l'aria-snapshot è povero
  (refs bassi / N no-progress), se il provider ha `supports_vision`. Calendari/
  combobox custom sono i casi dove la vision sblocca.

## Tema 3 — Product loop / fiducia UI

- **U1 — Stato globale "gateway offline" + stop al mock visibile.** Oggi i
  fallimenti sono `console.warn` silenziosi e l'app mostra dati finti (184
  memorie, "Acme") prima del polling (`App.tsx:505`). Banner offline + empty
  state sobri.
- **U2 — Non rileggere/sovrascrivere i messaggi durante lo streaming.** Il
  polling 2.5s fa setState dei messaggi anche durante lo stream (`App.tsx:948`):
  flicker e race con `optimisticMessages`. Sospendere durante streaming.
- **U3 — Cablare viste Memoria/Audit a read model reali e azionabili** (lettura/
  correzione/cancellazione memorie; audit + export/delete). Rimuovere il
  trasporto WebSocket morto in `chatApi.ts` e centralizzare il client gateway.
- **U4 — Accessibilità**: focus trap + Escape + click-outside su modali/menu;
  disabilitare i bottoni senza handler (Mic, Crea, I miei plugin).
- **U5 — LearningView onesta o nascosta** finché non è reale (oggi bottoni
  Conferma/Correggi/Ignora senza handler, stat inventate).

## Tema 4 — Ciclo di vita dei dati & resilienza

- **D1 — Export/erasure globale** dei dati utente (memorie, eventi, entità,
  relazioni, wiki su disco, secret refs) in transazione. Requisito esplicito
  PROJECT.md (Sicurezza + Fase 10); oggi `delete_memory` è solo tombstone.
- **D2 — Auto-restart/backoff nel Process Manager.** `RestartPolicy::Bounded`
  è definito ma nessun loop lo onora; un crash di Gemma non si auto-recupera.
- **D3 — Onorare checkpoint + timeout/cancel reali negli executor.** Oggi
  `_checkpoint` è ignorato (resume riparte da zero) e il timeout subagente è
  solo un flag, non interrompe `generate_json`.
- **D4 — Unificare la redazione** in un modulo condiviso (oggi 3 liste
  divergenti: memory/context-compression/process-manager → copertura incoerente).
- **D5 — Sanitizzare la query FTS + paginazione SQL-side** (oggi la query utente
  grezza va al MATCH FTS5; paginazione O(n) in memoria).

## Tema 5 — Profondità (dopo i temi 0-1)

- **I1 — Embeddings locali** per tool retrieval semantico (oggi solo FTS prefix
  OR, fragile multilingua).
- **I2 — WASI minimale + SDK skill**, oppure esecuzione Graphify reale (oggi
  `graphify_query` ritorna solo gli argomenti CLI, non esegue).
- **I3 — Strategia modelli per-piattaforma** (MLX su Apple ~30 tok/s, mistral.rs
  cross-OS su Win/Linux ~11 tok/s Metal su E2B) + completare lo streaming
  mistral.rs. Vedi ADR 0007.
- **I4 — Desktop Observation MVP** (event collector) che alimenta A5: è la fonte
  degli eventi reali per l'auto-apprendimento.

---

## Stato (2026-05-29)

- ✅ FATTO: fix browser (tab hygiene, piano nel prompt, parser robusto,
  context-profile auto), inference router (ADR 0007: provider OpenAI-compat/
  Ollama/Anthropic/MLX/mistral.rs, streaming primitive, mistral.rs validato),
  M0 sicurezza (S1-S3 + S4-slice), M1 dispatcher+worker (A2/A3 gia' esistenti),
  A1 groundwork (plan_only, adattatore, CachedToolProvider, Brain-nel-piano
  opt-in, subagent de-stub, ADR 0008), M3 B1 (conferma combobox).
- DECISIONE STRATEGICA: modello piccolo locale = OPZIONALE (router + delega
  cloud). "Modello capace via router" e' il percorso. B2/B4 deprioritizzati;
  test live small-model rimandato alla fine.

## Sequenza A1-full (chiusura, ADR 0008) — da validare col sistema acceso

- **A1.1 — Brain materializza task durevoli** nel TaskStore CONDIVISO (handle
  sullo stesso DB del worker). Durable-only via `PolicyContext.allowed_actions`
  vuoto (tool visibili-ma-non-executable → `call_tool` mai chiamato → niente
  doppio sidecar). Path prompt ALTERNATIVO dietro flag, accanto all'esistente.
- **A1.2 — Linkage sessione/chat/read-model per N task** (il ripple #3): un
  prompt → piano Brain → N task → UNA Local Computer session aggregante →
  progress/risultati in chat.
- **A1.3 — Provider VIVI** dove serve `call_tool` reale; risolvere la proprieta'
  UNICA del sidecar (browser provider vs `execute_capability_browser_task`) →
  una sola superficie d'esecuzione.
- **A1.4 — Convergere il run loop** del gateway su `TaskRuntime::run_ready_once`
  + trait `TaskExecutor` (ritiro del modello parallelo `TaskExecutionOutcome`,
  A2-residual).
- **A1.5 — Ritiro keyword/train** (`should_create_operational_task`,
  `browser_targets_for_goal`, `train_search_draft_for_goal`,
  `operational_plan_for_goal`); `OperationalPlan` diventa read-model derivato
  dall'`ExecutionPlan` + stato task.
- **A1.6 — Flag Brain default ON + rimozione fallback** quando stabile.
- Trasversale: test e2e workflow durevole (M5 della vecchia numerazione) +
  validazione live (Gemma/Ollama + browser) a ogni step.

## Sequenza milestone (aggiornata)

1. ✅ **M0 — Sicurezza** (S1-S3 + S4-slice). S4-full differito (vedi Tema 0).
2. **A4 — Chat dal router** (ALTA priorita' dopo la decisione strategica): la
   chat e' la superficie principale ed e' ancora hard-coupled a MLX; portarla sul
   router le da' subito i modelli capaci. Streaming primitive gia' pronto.
3. **A1-full** — sequenza A1.1→A1.6 sopra. Orchestrazione browser/task tramite
   Brain+router. Grande, multi-superficie, validazione live.
4. **A5 — Memoria nel loop** (completa M2): record-event + iniezione contesto →
   l'assistant impara. Dipende da Desktop Observation (I4) per eventi reali.
5. **M4 — Fiducia UI:** U1, U2, U3, U5, U4.
6. **M5 — Dati & resilienza:** D1, D2, D3, D4, D5 + S4-full (secret store).
7. **M6 — Profondità:** I1, I2, I3, I4. (B2/B4 di M3 qui se mai servissero per i
   modelli piccoli.)

Regola trasversale: ogni milestone si chiude con test e con un check che il
**path in esecuzione** (non solo i test unitari) usi il componente nuovo.
