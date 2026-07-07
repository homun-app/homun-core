# Estrazione `ModelClient` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spostare la chiamata al modello di un round ReAct dal loop inline `stream_chat_via_openai` a un'impl concreta di `engine::ModelClient`, behavior-preserving.

**Architecture:** Approccio A dello spec — l'impl del gateway possiede HTTP/retry/fallback/stream-collect (lift verbatim) e RESTITUISCE il provider effettivo (`ProviderBinding`) + un errore tipizzato (`ModelCallError`) che preserva la semantica di `last_model_error`. Il loop aggiorna le proprie variabili dall'output. Nessuna logica d'engine (parsing tool-call, avanzamento piano) si sposta: la giuntura è esattamente l'assemblaggio di `choices[0].message`.

**Tech Stack:** Rust (Cargo workspace), `crates/engine` (dep-light: solo `serde_json`), `crates/desktop-gateway` (reqwest/tokio), `tokio::test`.

**Spec:** [docs/superpowers/specs/2026-07-07-extract-modelclient-design.md](../specs/2026-07-07-extract-modelclient-design.md)

**⚠️ Convenzioni progetto:** commit diretti su `main`, **nessun trailer `Co-Authored-By`**, **niente push** (solo commit locali). Commenti in inglese, docs in italiano.

---

## File map

- **Modify** `crates/engine/src/contract.rs` — aggiungere `ProviderBinding`, `ModelRoundOutput`, `ModelCallError`; cambiare il ritorno di `ModelClient::generate`; aggiornare `EchoModel` + test.
- **Modify** `crates/engine/src/lib.rs` — ri-esportare i tre nuovi tipi.
- **Create** `crates/desktop-gateway/src/model_client.rs` — `GatewayModelClient<'a>` + impl `ModelClient` (lift verbatim del round).
- **Modify** `crates/desktop-gateway/src/main.rs` — (a) `mod model_client;`; (b) promuovere ~10 helper a `pub(crate)`; (c) collassare il blocco inline (~24254–24562) nella chiamata a `generate`.

---

## Task 1: Contratto engine — tipi di ritorno + errore tipizzato

**Files:**
- Modify: `crates/engine/src/contract.rs`
- Modify: `crates/engine/src/lib.rs`

- [ ] **Step 1: Aggiornare il test esistente perché fallisca (TDD)**

In `crates/engine/src/contract.rs`, dentro `mod tests`, sostituire il corpo di `EchoModel::generate` e le asserzioni del test per la nuova shape. Rimpiazzare l'impl di test e il test:

```rust
    struct EchoModel;
    impl ModelClient for EchoModel {
        async fn generate(
            &self,
            call: &ModelCall<'_>,
            on_delta: &dyn Fn(&str),
        ) -> Result<ModelRoundOutput, ModelCallError> {
            on_delta("hi");
            Ok(ModelRoundOutput {
                message: serde_json::json!({ "role": "assistant", "content": call.model }),
                provider: ProviderBinding {
                    model: call.model.to_string(),
                    base_url: call.base_url.to_string(),
                    api_key: call.api_key.map(str::to_string),
                },
            })
        }
    }
```

E nel test `seams_are_usable_with_a_mock`, sostituire il blocco di asserzioni sul modello:

```rust
        let out = m
            .generate(
                &ModelCall {
                    base_url: "http://x",
                    model: "test-model",
                    api_key: None,
                    messages: &[],
                    tools: &[],
                    temperature: 0.0,
                    is_final_round: false,
                },
                &|d| streamed.borrow_mut().push_str(d),
            )
            .await
            .unwrap();
        assert_eq!(out.message["content"], "test-model");
        assert_eq!(out.provider.model, "test-model");
        assert_eq!(out.provider.base_url, "http://x");
        assert_eq!(*streamed.borrow(), "hi", "on_delta streamed the live token");
```

- [ ] **Step 2: Verificare che NON compili**

Run: `cargo test -p engine --no-run`
Expected: FAIL — `cannot find type ModelRoundOutput` / `ProviderBinding` / `ModelCallError`, e mismatch sul tipo di ritorno di `generate`.

- [ ] **Step 3: Aggiungere i tipi e cambiare il trait**

In `crates/engine/src/contract.rs`, sopra `pub trait ModelClient`, aggiungere:

```rust
/// The provider binding a round ran against. Returned so a mid-turn fallback (401/timeout/
/// tool-400 swap) inside the impl propagates back to the loop, which reuses it next round.
pub struct ProviderBinding {
    pub model: String,
    pub base_url: String,
    pub api_key: Option<String>,
}

/// One round's output: the assembled assistant message plus the provider the impl ended on.
pub struct ModelRoundOutput {
    pub message: Value,
    pub provider: ProviderBinding,
}

/// Typed failure. Preserves parity: only an UPSTREAM status error should surface as the
/// turn's committed final answer (the gateway's `last_model_error`); a transport/stream
/// failure already streamed a generic live notice and must NOT overwrite that fallback.
pub enum ModelCallError {
    Upstream(String),
    Transport(String),
}
```

E cambiare la firma del trait:

```rust
pub trait ModelClient {
    fn generate(
        &self,
        call: &ModelCall<'_>,
        on_delta: &dyn Fn(&str),
    ) -> impl Future<Output = Result<ModelRoundOutput, ModelCallError>>;
}
```

- [ ] **Step 4: Ri-esportare dal crate**

In `crates/engine/src/lib.rs`, estendere la riga di re-export:

```rust
pub use contract::{
    CapabilityExecutor, ModelCall, ModelCallError, ModelClient, ModelRoundOutput, ProviderBinding,
};
```

- [ ] **Step 5: Verificare che il test passi**

Run: `cargo test -p engine`
Expected: PASS (incluso `seams_are_usable_with_a_mock`).

- [ ] **Step 6: Commit**

```bash
git add crates/engine/src/contract.rs crates/engine/src/lib.rs
git commit -m "feat(engine): ModelClient returns ModelRoundOutput + typed ModelCallError"
```

---

## Task 2: Promuovere gli helper del gateway a `pub(crate)`

L'impl vivrà in un modulo separato e deve vedere gli helper oggi privati in `main.rs`. Solo cambio di visibilità — nessuna logica si sposta.

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Aggiungere `pub(crate)` alle firme**

Per ciascuna di queste funzioni in `main.rs`, anteporre `pub(crate)` (es. `async fn collect_openai_stream` → `pub(crate) async fn collect_openai_stream`). Non cambiare i corpi:

- `build_chat_payload` (`fn build_chat_payload`)
- `collect_openai_stream` (`async fn`)
- `collect_ollama_native_stream` (`async fn`)
- `chat_endpoint`
- `is_ollama_base`
- `auth_fallback_config`
- `should_try_tool_compatibility_fallback`
- `tool_compatibility_fallback_config`
- `model_request_timeout_secs`
- `model_first_token_timeout_secs`
- `model_idle_timeout_secs`
- `emit_stream_event` (`async fn emit_stream_event`)

Rendere inoltre visibili al modulo i tipi usati dalla firma dell'impl: sul `struct StreamSink` (main.rs) anteporre `pub(crate)` (e ai suoi campi `mpsc`/`entry` NON serve — l'impl non li costruisce, li usa solo via `&StreamSink`). `GenerateStreamEvent` è già pubblico (crate `subagents`).

- [ ] **Step 2: Verificare che compili ancora**

Run: `cargo check -p local-first-desktop-gateway`
Expected: PASS, nessun nuovo warning (le funzioni erano già usate → niente `dead_code`).

- [ ] **Step 3: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "refactor(gateway): expose model-round helpers as pub(crate) for extraction"
```

---

## Task 3: `GatewayModelClient` — lift verbatim del round

**Files:**
- Create: `crates/desktop-gateway/src/model_client.rs`
- Modify: `crates/desktop-gateway/src/main.rs` (aggiungere `mod model_client;`)

- [ ] **Step 1: Registrare il modulo**

In `main.rs`, accanto agli altri `mod …;` in cima al file, aggiungere:

```rust
mod model_client;
```

- [ ] **Step 2: Creare lo scaffold del modulo**

Creare `crates/desktop-gateway/src/model_client.rs` con questo contenuto FISSO (le parti nuove sono complete; il corpo del round si riempie allo Step 3):

```rust
//! The concrete `engine::ModelClient` for the gateway (ADR 0024). Owns everything transport-
//! shaped the engine must not: HTTP, per-round retry/backoff, provider fallback (the mid-turn
//! model/url/key swap), and the OpenAI-vs-Ollama stream collectors. Lifted VERBATIM from the
//! inline round that used to live in `stream_chat_via_openai`; behavior is unchanged.

use engine::{ModelCall, ModelCallError, ModelClient, ModelRoundOutput, ProviderBinding};
use serde_json::Value;

use crate::{
    auth_fallback_config, build_chat_payload, chat_endpoint, collect_ollama_native_stream,
    collect_openai_stream, emit_stream_event, is_ollama_base, model_first_token_timeout_secs,
    model_idle_timeout_secs, model_request_timeout_secs, should_try_tool_compatibility_fallback,
    tool_compatibility_fallback_config, StreamSink,
};
use local_first_subagents::GenerateStreamEvent; // crate that owns GenerateStreamEvent

/// Borrows the turn's reqwest client and stream sink; created once before the ReAct loop.
pub(crate) struct GatewayModelClient<'a> {
    pub http: &'a reqwest::Client,
    pub tx: &'a StreamSink,
}

impl ModelClient for GatewayModelClient<'_> {
    async fn generate(
        &self,
        call: &ModelCall<'_>,
        _on_delta: &dyn Fn(&str),
    ) -> Result<ModelRoundOutput, ModelCallError> {
        // Local, mutable copies of the provider: a fallback may swap them mid-round; the final
        // values are returned in ProviderBinding so the loop reuses them next round.
        let mut model = call.model.to_string();
        let mut base_url = call.base_url.to_string();
        let mut api_key = call.api_key.map(str::to_string);
        let mut endpoint = chat_endpoint(&base_url);
        let mut tool_compatibility_fallback_tried = false;
        let mut fallback_tried = false;
        let payload_has_tools = !call.is_final_round && !call.tools.is_empty();
        let mut payload = build_chat_payload(
            &model,
            &base_url,
            call.messages,
            call.tools,
            call.temperature,
            call.is_final_round,
        );

        // <<<< ROUND BODY GOES HERE (Step 3) >>>>

        // Assemble the non-streaming body shape → choices[0].message.
        let message = body
            .get("choices")
            .and_then(|choices| choices.get(0))
            .and_then(|choice| choice.get("message"))
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        Ok(ModelRoundOutput {
            message,
            provider: ProviderBinding { model, base_url, api_key },
        })
    }
}
```

> NOTE: the exact import path/name for `GenerateStreamEvent`'s crate must match how `main.rs`
> imports it (see `main.rs:128`, `use <crate>::{… GenerateStreamEvent …}`). Use the SAME crate
> path. If `local_first_subagents` is wrong, copy the path from that `use` line.

- [ ] **Step 3: Trasferire il corpo del round VERBATIM (relocation, non riscrittura)**

Il corpo del round esiste già in `main.rs`. **Tagliare** da `main.rs` le righe che oggi vanno
dal `let request_timeout = …` (subito dopo `build_chat_payload`) fino alla riga che assembla
`let body: serde_json::Value = match collected { … };` INCLUSA — cioè il blocco:
1. `let request_timeout = std::time::Duration::from_secs(model_request_timeout_secs());`
2. `let resp = { let mut attempt … loop { … } };` (retry/backoff + i due fallback)
3. le tre `let first_token/idle/ollama = …;`
4. `let collected = if ollama { collect_ollama_native_stream(…) } else { collect_openai_stream(…) };`
5. `let body: serde_json::Value = match collected { Ok(v) => v, Err(e) => { … } };`

**Incollarlo** al posto del marcatore `// <<<< ROUND BODY GOES HERE >>>>`, applicando ESATTAMENTE
queste sostituzioni (nessun'altra modifica logica):

- `http.post(&endpoint)` → `self.http.post(&endpoint)` (due occorrenze: attempt loop).
- ogni `emit_stream_event(&tx, …)` → `emit_stream_event(self.tx, …)`.
- Nel loop di retry, `break Some(value)` → `break value;` e cancellare la `let Some(resp) = resp else { break; };` che seguiva il blocco (ora `resp` è sempre presente). Cioè: la chiusura del retry loop diventa `let resp = { … loop { … break value; … } };`.
- I DUE punti terminali di errore upstream che oggi fanno `last_model_error = Some(message.clone()); … emit_stream_event(...); break None;` → **rimuovere** la riga `last_model_error = Some(message.clone());`, tenere l'`emit_stream_event(self.tx, GenerateStreamEvent::Delta { text: message.clone() })`, e sostituire `break None;` con `return Err(ModelCallError::Upstream(message));`.
  (È il ramo `Ok(value)` non-success dopo aver costruito `let message = format!("{reason}{tail}");`.)
- Il ramo network finale (`Err(error) =>` dopo i retry, testo "The model didn't respond (timeout/network). Try again shortly.") : dopo l'`emit_stream_event(self.tx, …)`, sostituire `break None;` con `return Err(ModelCallError::Transport("The model didn't respond (timeout/network). Try again shortly.".to_string()));`.
- Lo stream-collect error (`Err(error) => { emit_stream_event(self.tx, … "interrupted the response …"); break; }`) → sostituire `break;` con `return Err(ModelCallError::Transport(format!("The model interrupted the response ({error}). Try again shortly.")));`.
- Nella diagnostica `eprintln!("[model-error] … round={round} …")`: rimuovere il segmento `round={round} ` (il contatore `round` non attraversa il contratto — parità accettata su una riga di debug). Lasciare invariato il resto (`tools=`, `tool_count=`, `body=`, e la riga `[model-error] shapes:`).

Tutti i riferimenti a `model`, `base_url`, `endpoint`, `api_key`, `payload`, `payload_has_tools`,
`tool_schemas` → ora `call.tools` dove il codice leggeva `tool_schemas` per il conteggio
(`tool_schemas.len()` → `call.tools.len()`), e `messages`→`call.messages` dentro le ricostruzioni
`build_chat_payload(&model, &base_url, call.messages, call.tools, call.temperature, call.is_final_round)`
nei due rami di fallback. Le variabili `model/base_url/endpoint/api_key/payload/*_tried` sono già
dichiarate `mut` nello scaffold (Step 2).

- [ ] **Step 4: Verificare che il modulo compili**

Run: `cargo check -p local-first-desktop-gateway`
Expected: PASS. Errori attesi & come risolverli:
- "cannot find `body`" → hai dimenticato di includere la riga `let body … = match collected …` (punto 5): deve restare PRIMA dell'assemblaggio `message`.
- import path di `GenerateStreamEvent` errato → allinealo a `main.rs:128`.
- `tool_schemas`/`messages` non trovati → sostituiti con `call.tools`/`call.messages` (Step 3).

(A questo punto `main.rs` non compila ancora: il call site vecchio è stato tagliato. Task 4 lo ricabla. Se preferisci un checkpoint verde, esegui Task 4 prima di committare — vedi nota sotto.)

- [ ] **Step 5: Commit (dopo Task 4 verde)**

Questo task e il Task 4 formano un unico checkpoint compilabile. Committa insieme al termine del Task 4.

---

## Task 4: Ricablare il call site nel loop

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` (loop `stream_chat_via_openai`)

- [ ] **Step 1: Costruire il client una volta, prima del loop**

Subito prima dell'inizio del `loop {` del round (dove oggi vivono `let mut last_model_error`,
`fallback_tried`, ecc.), aggiungere:

```rust
let model_client = crate::model_client::GatewayModelClient { http: &http, tx: &tx };
```

Rimuovere dal loop le variabili ora possedute dall'impl: `fallback_tried` e
`tool_compatibility_fallback_tried` (erano dichiarate `let mut …` prima del loop e usate SOLO nel
blocco del round appena spostato). `last_model_error` RESTA nel loop (lo popola il match sotto).

- [ ] **Step 2: Sostituire il blocco tagliato con la chiamata**

Al posto del blocco rimosso in Task 3 (subito dopo il push del messaggio "FINAL step" e la
`let payload_has_tools`/`build_chat_payload` — NB: queste due righe ora vivono DENTRO `generate`,
quindi vanno rimosse anche dal loop) inserire:

```rust
let out = model_client
    .generate(
        &ModelCall {
            base_url: &base_url,
            model: &model,
            api_key: api_key.as_deref(),
            messages: &messages,
            tools: &tool_schemas,
            temperature,
            is_final_round,
        },
        &|_tok| {},
    )
    .await;
let message = match out {
    Ok(o) => {
        // Mid-turn fallback may have switched provider: adopt it for the next rounds.
        model = o.provider.model;
        base_url = o.provider.base_url;
        api_key = o.provider.api_key;
        endpoint = chat_endpoint(&base_url);
        o.message
    }
    // Parity: only an upstream status error becomes the committed final answer.
    Err(engine::ModelCallError::Upstream(reason)) => {
        last_model_error = Some(reason);
        break;
    }
    Err(engine::ModelCallError::Transport(_)) => break,
};
```

Verificare che subito DOPO questo blocco il codice esistente prosegua con
`let raw_content = message.get("content")…;` e `let tool_calls = message.get("tool_calls")…;`
(quel codice resta INVARIATO nel loop — è logica d'engine, non si sposta).

Assicurarsi che `message` non sia più dichiarato altrove nel round (prima era il risultato
dell'assemblaggio `choices[0].message`): ora è il `let message = match out { … }` qui sopra.

- [ ] **Step 3: Verificare compilazione + test del gateway**

Run: `cargo check -p local-first-desktop-gateway`
Expected: PASS. Se compare "unused variable `endpoint`"/"`payload`" → residui del blocco tagliato non rimossi; rimuoverli.

Run: `cargo test -p local-first-desktop-gateway`
Expected: PASS (copertura esistente invariata — è un lift behavior-preserving).

- [ ] **Step 4: Verificare l'intero workspace**

Run: `cargo check --workspace`
Expected: PASS, nessun nuovo warning.

- [ ] **Step 5: Commit (Task 3 + Task 4 insieme)**

```bash
git add crates/desktop-gateway/src/model_client.rs crates/desktop-gateway/src/main.rs
git commit -m "refactor(gateway): extract per-round model call into GatewayModelClient (ADR 0024)"
```

---

## Task 5: Smoke a runtime + aggiornamento STATO

**Files:**
- Modify: `docs/STATO.md`

- [ ] **Step 1: Build di debug**

Run: `cargo build -p local-first-desktop-gateway`
Expected: PASS.

- [ ] **Step 2: Smoke — turno reale**

Avviare il gateway in dev e fare un turno di chat semplice (una domanda che NON usa tool) e uno
che usa un tool (es. una ricerca/browse), verificando che la risposta arrivi in streaming come
prima. (Vedi `apps/desktop`: `npm run dev` + `npm run electron:dev`, oppure la modalità di smoke
già in uso nel progetto.)
Expected: risposta streammata, nessuna regressione visibile; `‹‹ACT››` di retry/fallback ancora
emessi se capita un errore transitorio.

- [ ] **Step 3: Smoke — parità del fallback provider (il punto critico)**

Forzare un 401: configurare un modello con chiave non valida come driver e verificare che il turno
NON muoia — deve emettere `‹‹ACT››↩ … falling back to …` e proseguire i round col provider di
fallback (esattamente come prima dell'estrazione). Questo prova che lo swap risale via
`ProviderBinding`.
Expected: il turno si auto-ripara sul provider di fallback e completa.

- [ ] **Step 4: Aggiornare STATO.md**

Aggiungere una voce concisa in `docs/STATO.md` sotto "Dove siamo": estrazione `ModelClient`
completata (ADR 0024), l'impl concreta `GatewayModelClient` possiede HTTP/retry/fallback/stream,
ritorna `ProviderBinding` + `ModelCallError`, ~300 righe tolte a `main.rs`; prossimo passo = inc 5
(spostamento del corpo del loop nell'engine), con decisioni aperte (sink di output/`GenerateStreamEvent`,
attivazione reale di `on_delta`, bound `Send`/`Sync`).

- [ ] **Step 5: Commit**

```bash
git add docs/STATO.md
git commit -m "docs: STATO — ModelClient extracted (ADR 0024), next is loop move (inc 5)"
```

---

## Self-review (fatto in fase di stesura)

- **Spec coverage:** §1 contratto → Task 1; §2 impl + promozione helper → Task 2+3; §3 ricablaggio loop → Task 4; §criteri d'accettazione → Task 1/4 (gate cargo) + Task 5 (smoke, incl. 401). Nota `on_delta` onorato-ma-inutilizzato → riflessa (parametro `_on_delta`, `&|_tok| {}` al call site). ✅
- **Placeholder scan:** nessun TBD/TODO. Il "ROUND BODY GOES HERE" è una **relocation esplicita** di codice esistente con lista di sostituzioni puntuali, non un placeholder da inventare. ✅
- **Type consistency:** `ModelRoundOutput{message, provider}`, `ProviderBinding{model, base_url, api_key}`, `ModelCallError::{Upstream, Transport}` usati in modo identico in Task 1/3/4. `GatewayModelClient{http, tx}` coerente tra scaffold (Task 3) e costruzione (Task 4). ✅
