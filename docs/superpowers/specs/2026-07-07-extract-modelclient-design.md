# Estrazione di `ModelClient` — design (ADR 0024)

- **Data:** 2026-07-07
- **ADR di riferimento:** [0024](../../decisions/0024-engine-extraction-gateway-as-postman.md)
  (estrazione motore, gateway = postino). Questo spec realizza **la giuntura `ModelClient`**:
  il trait è già definito (increment 2) ma ha solo l'impl di test `EchoModel`. Qui si costruisce
  l'impl concreta del gateway e si ricabla il loop per usarla.
- **Relazioni:** prerequisito diretto dell'inc 5 (spostamento del corpo del loop nell'engine) e
  di [ADR 0025](../../decisions/0025-browser-as-delegated-subagent.md) (browse ricorsivo, richiede
  un motore richiamabile). Si compone con [0021](../../decisions/0021-single-guarded-loop-planning-as-tool.md)
  (loop unico guardato = il motore che stiamo ricollocando, non riprogettando).
- **Stato:** approvato (design). Implementazione tramite piano separato (writing-plans).

## Obiettivo

Spostare la **chiamata al modello di un singolo round ReAct** fuori dal loop inline
`stream_chat_via_openai` (`crates/desktop-gateway/src/main.rs`, blocco ~24254–24562) dentro
un'impl concreta di `engine::ModelClient`. **Behavior-preserving:** non cambia *cosa* fa il loop,
cambia solo *chi possiede* il round HTTP. Effetto collaterale voluto: ~300 righe tolte al monolite.

## Contesto (codice, non docs)

- Il trait vive in `crates/engine/src/contract.rs:36`; oggi ha **solo** `EchoModel` (test).
- La logica reale è inline nel loop: `build_chat_payload` → POST con retry/backoff → i due
  fallback (auth 401, tool-400) → `collect_openai_stream` / `collect_ollama_native_stream` →
  estrazione di `choices[0].message`.
- Lo streaming avviene tramite `StreamSink` (`emit_stream_event(&StreamSink, GenerateStreamEvent)`),
  `GenerateStreamEvent` importato dal crate `subagents`. Sia i token grezzi sia gli eventi
  strutturati (`‹‹REASONING››`, marker `‹‹ACT››`) sono emessi **dentro** i collector / il codice
  di fallback via questo sink.
- Il fallback provider **muta** `model`/`base_url`/`endpoint`/`api_key` e questi **persistono nei
  round successivi** (commento in codice: "Reflect the provider actually used").

## La tensione di design (e la scelta)

Il round inline fa due cose che il trait attuale non sa esprimere:

1. **Lo swap di provider deve persistere oltre il round.** Il trait prende i parametri per `&` in
   `ModelCall` e restituisce solo `Value` → uno swap interno a `generate` non risalirebbe al loop.
2. **I marker di stato condividono lo stream utente.** Gli avvisi di retry/fallback (`‹‹ACT››⏳ …`)
   vanno a `tx` come `GenerateStreamEvent::Delta`, canale diverso dal `on_delta` (solo token) del trait.

**Scelta (Approccio A, approvata):** l'impl **possiede** il fallback (lift verbatim) e **restituisce
il provider effettivo** su cui è finita. Il loop aggiorna le proprie variabili dall'output. È la
mossa SOTA: rende lo swap un **output esplicito** del round anziché un effetto collaterale nascosto —
precondizione perché il futuro loop-nell'engine (inc 5) sia funzione pura di (input, output-modello).

Approccio B scartato *per ora* (l'impl fa un solo tentativo, il loop possiede il fallback via errore
tipizzato): separazione più pulita a lungo termine, ma sposta **subito** la policy di fallback in
territorio engine e allarga la superficie di comportamento toccata in un solo passo — contro la
regola "un incremento sottile, behavior-preserving". Sarà eventualmente giusto dopo l'inc 5.

## Design

### 1. Contratto (crate `engine`)

In `crates/engine/src/contract.rs`, allargare l'output di `generate`:

```rust
pub struct ProviderBinding {
    pub model: String,
    pub base_url: String,
    pub api_key: Option<String>,
}
pub struct ModelRoundOutput {
    pub message: Value,          // choices[0].message assemblato ({ content, tool_calls })
    pub provider: ProviderBinding, // il provider su cui l'impl è FINITA (dopo eventuali swap)
}

pub trait ModelClient {
    fn generate(&self, call: &ModelCall<'_>, on_delta: &dyn Fn(&str))
        -> impl Future<Output = Result<ModelRoundOutput, String>>;
}
```

Attraversano il confine solo stringhe + `serde_json::Value`: il crate resta leggero (nessuna
dipendenza reqwest/tokio/subagents che entra). `EchoModel` (test) aggiornato per restituire
`ModelRoundOutput` — la giuntura resta mockabile.

### 2. Impl concreta (crate gateway, nuovo file `src/model_client.rs`)

```rust
struct GatewayModelClient {
    http: reqwest::Client,
    tx: StreamSink,   // clone del sink del turno (o riferimento per-call — deciso nel piano)
}
```

Il suo `generate` è il **trasferimento verbatim** del blocco ~24254–24562: costruzione payload,
loop di retry/backoff sul POST, i due fallback (401 → `auth_fallback_config`, tool-400 →
`should_try_tool_compatibility_fallback` + `tool_compatibility_fallback_config`), scelta del
collector (`is_ollama_base` → native NDJSON vs OpenAI SSE), assemblaggio di `choices[0].message`.
Ritorna `ModelRoundOutput { message, provider }` con `provider` = binding finale.

Gli helper già in `main.rs` che l'impl richiama vengono promossi a `pub(crate)`:
`chat_endpoint`, `is_ollama_base`, `auth_fallback_config`, `should_try_tool_compatibility_fallback`,
`tool_compatibility_fallback_config`, `build_chat_payload`, `collect_openai_stream`,
`collect_ollama_native_stream`, `emit_stream_event`, i `model_request_timeout_secs` /
`model_first_token_timeout_secs` / `model_idle_timeout_secs`. (Spostarli fisicamente è fuori scope:
in questo incremento cambia solo la visibilità.)

### 3. Ricablaggio del loop (`main.rs`)

Il blocco inline collassa in:

```rust
let out = model_client.generate(
    &ModelCall {
        base_url: &base_url, model: &model, api_key: api_key.as_deref(),
        messages: &messages, tools: &tool_schemas, temperature, is_final_round,
    },
    &|_tok| {},   // vedi nota on_delta
).await;
match out {
    Ok(o) => {
        // lo swap risale qui: i round successivi usano il provider effettivo
        model = o.provider.model;
        base_url = o.provider.base_url;
        api_key = o.provider.api_key;
        endpoint = chat_endpoint(&base_url);
        message = o.message;
    }
    Err(_) => break,   // l'impl ha già emesso la ragione umana su tx (last_model_error incluso)
}
```

Da verificare nel lift: `last_model_error` (oggi settato nel ramo errore) deve restare coerente —
o resta settato dentro l'impl prima del `break`, o l'errore ritornato lo trasporta. Il piano lo fissa.

## Note di onestà (esplicite, non aggirate)

- **`on_delta` resta onorato-ma-inutilizzato in questo incremento.** Token grezzi *e* eventi
  strutturati sono emessi dentro `collect_*_stream` / fallback via `tx`, che l'impl cattura.
  `on_delta` diventa il vero canale token solo quando il **loop** si sposta nell'engine (inc 5) e
  `tx` diventa un sink dell'engine. Ricablare ora il vocabolario di eventi dei collector su
  `on_delta` sarebbe una seconda modifica **non** behavior-preserving → fuori scope. Tenerlo nella
  firma è "contratto-prima-dell'implementazione" deliberato (stessa disciplina del trait vuoto
  nell'inc 2): evita di cambiare firma e mock due volte.
- **Testing.** Essendo un lift verbatim, il gate è la copertura **esistente** + smoke, non un nuovo
  unit test: retry/fallback HTTP non sono testabili senza mock server, e inventarne uno qui
  testerebbe il mock, non l'estrazione. Se durante il lift emerge un'unità genuinamente pura
  (es. la costruzione di `ProviderBinding` dallo stato finale), quella sì avrà un test.

## Criteri di accettazione (gate)

1. `cargo check -p engine` e `cargo test -p engine` verdi (EchoModel aggiornato).
2. `cargo test -p local-first-desktop-gateway` verde (copertura esistente invariata).
3. `cargo check` sull'intero workspace verde.
4. Smoke a runtime: un turno reale completo funziona; un **401 forzato** conferma che lo swap di
   provider persiste ancora nei round successivi (parità col comportamento pre-estrazione).
5. `main.rs` più corto di ~300 righe; nessun nuovo warning.

## Fuori scope (ma sequenziato subito dopo) — Increment 5

Spostare il **corpo del loop** (`stream_chat_via_openai`, ~2700 righe) dentro il crate `engine`.
Si appoggia su questa giuntura, quindi parte **solo a inc 4 verde**. Decisioni aperte da risolvere
con un mini-design dedicato *prima* di scrivere codice:

- **Dove vive `GenerateStreamEvent`.** Oggi nel crate pesante `subagents`: direzione sbagliata per
  una dipendenza dell'engine. Va deciso il sink di output dell'engine.
- **Attivazione reale di `on_delta`.** I collector oggi emettono eventi strutturati su `StreamSink`;
  spostando il loop, `tx` → sink dell'engine e `on_delta` diventa il canale token reale.
- **Bound `Send`/`Sync`** sul trait, per eseguire il loop dentro `tokio::spawn`.

Questo sarà uno spec separato (`2026-…-move-agent-loop-into-engine-design.md`).
