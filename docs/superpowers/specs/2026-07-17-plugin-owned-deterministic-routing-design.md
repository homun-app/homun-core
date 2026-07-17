# Plugin-owned deterministic routing (S2) — design

Data: 2026-07-17 · Stato: **Approvata (design) da Fabio** (2 fork: minimo generalizzabile · router pota + tool_choice forzato)

## Problema (osservato live)

"Use template" su un pack documento (CV) non rispetta il template. Diagnosi dal DB
(`~/.homun/homun.sqlite`, thread `user selected template from Presentations`,
`chat_messages.event_parts_json`): il router ha scelto `make_document` **correttamente**, ma il
modello **debole** (deepseek-v4-pro) non ha chiamato il tool — ha invocato le skill
«Create Documents» + «Create Presentations» e scritto il file a mano con `cat > cv-fabio-cantone.md`
(heredoc shell), bypassando il path templated. Output generico, template ignorato. È il pattern
ADR 0016/0018 (modello debole vaga verso skill+shell quando lasciato libero).

Perché il fix di prompt (`2a6ec2cc`) non basta: irrobustisce il testo ma resta un lever debole; e
il pruning attuale (`workflow_route_blocked_tool_message`) è **advisory** (un messaggio "blocked"
che il modello ignora e ritenta). Serve determinismo per costruzione.

## Intuizione di Fabio (riframing SOTA)

Il routing NON deve essere un caso speciale hardcoded nel gateway per "Use template". Presentations
è un **plugin**: deve essere il plugin a **possedere le proprie routing** (dichiararle, priorità,
enable/disable) e a spedirle. Il substrato esiste già:
- Router: `route_capability(prompt)` / `route_workflow_or_agent` (BM25 su `route_text`) +
  `prune_tools_for_workflow_route` + `workflow_route_blocked_tool_message` (main.rs ~8007-8193).
- Contratto plugin: `PluginCapabilityDeclaration { kind: Workflow, … }`, registry
  `skill_plugin.rs` con `plugin_manifests`/`plugin_installs` **con `enabled`**, policy
  `CapabilityPolicy::tool_access → {model_visible, executable}`.

Oggi però le route sono un elenco **hardcoded** (`native_workflow_capabilities()`), il pruning è
advisory, e non c'è binding deterministico né toolset-policy per-route. Questa slice chiude il cerchio.

## Decisioni prese (fork)

1. **Minimo generalizzabile**: le route diventano **dati** (una `WorkflowRouting` con priorità /
   toolset-policy / deterministic), lette da un registry che il gateway consulta; Presentations è il
   primo consumatore. Progettato per generalizzare a plugin esterni (via `plugin_installs`), ma
   spedisco solo ciò che serve ora. YAGNI: niente UI utente per priorità/enable per-route, niente
   manifest esterni/hot-reload in questa slice.
2. **Router pota + tool_choice forzato**: la route deterministica (a) **pota davvero** il toolset
   (skill/shell/altro-make_* rimossi dalla lista offerta, non un messaggio "blocked"), e (b) inietta
   **tool_choice forzato** sul tool giusto, con `template_ref` già **bound** (il modello non può
   perderlo).

## Architettura

### 1. Dato: `WorkflowRouting` (in `crates/capabilities`)

Nuovo tipo dichiarativo (accanto a `PluginCapabilityDeclaration`):

```rust
pub struct WorkflowRouting {
    pub route_id: String,          // es. "presentations.template_document"
    pub plugin_id: String,         // "presentations"
    pub tool_name: String,         // "make_document" | "make_deck"
    pub route_text: String,        // BM25 discovery (come oggi)
    pub priority: i32,             // alta = vince; deterministic ⇒ priorità alta
    pub deterministic: bool,       // se true + binding esplicito: forza + pota duro
    pub deny_tools: Vec<String>,   // glob semplici: ["skill:*","shell","make_deck"]
    pub forcing: Forcing,          // None | Required | Specific(tool_name)
}
pub enum Forcing { None, Required, Specific }
```

La **forma** vive nel registry (statica); gli **argomenti concreti** (`template_ref`) arrivano
all'invocazione via il binding (§3). Un `WorkflowRoutingRegistry` in-process espone
`routings_for_enabled_plugins(enabled: &EnabledPlugins) -> Vec<&WorkflowRouting>`. Per MVP contiene
le route **di sistema** (Presentations: `template_document`, `template_deck`) registrate in-code allo
startup come "plugin di sistema" **sempre abilitato** — così il seam esiste e generalizza, ma non
serve ancora un manifest esterno. L'interfaccia è già sagomata per **fondere** in futuro le route dei
plugin esterni da `plugin_installs.enabled` (il filtro enable/disable è un no-op per il plugin di
sistema oggi, reale per i plugin esterni domani). Nessun ramo hardcoded nel router: legge dal registry.

### 2. Router alimentato dai plugin (non più solo hardcoded)

`route_capability` / la costruzione della lista route diventa: **native (default, priorità normale)
∪ WorkflowRouting dei plugin abilitati**. Con un **binding esplicito** (§3) su un `route_id`
deterministico, quella route **vince** senza passare dal BM25 (il BM25 resta per la discovery
libera). `native_workflow_capabilities` resta come route di default (converge, non duplica: le
route native sono "il plugin di sistema").

### 3. Binding strutturato sul turno (thread-scoped, persistito)

Canale strutturato invece del testo nel prompt. `EnqueueTurnRequest`
(`crates/desktop-gateway/src/lib.rs:110`, campi già `#[serde(default)]`) guadagna:

```rust
    #[serde(default)]
    pub routing_binding: Option<RoutingBinding>,   // { plugin_id, route_id, args: { template_ref } }
```

Il binding è **thread-scoped e persistito** (non solo per-turno): "Use template" lo setta alla
creazione del thread; il gateway lo salva (tabella minimale `thread_routing_bindings(thread_id PK,
binding_json, created_at)` o metadata thread) e lo **legge a OGNI turno** di quel thread (l'intake
dura più turni). Si **cancella** quando il deliverable è prodotto con successo (o il thread è
archiviato) → i turni successivi tornano liberi. `handleStartTemplateWorkflow` (App.tsx) smette di
supplicare il modello nel prompt operativo e allega `routing_binding`; il prompt resta solo brief +
intake (niente più "IMPORTANT: use make_document…").

### 4. Enforcement (il punto che boxa il modello debole)

Al turn-start, se il thread ha un `routing_binding` attivo → risolvi la `WorkflowRouting`:

1. **Prune duro** — estendi `prune_tools_for_workflow_route` (main.rs:8179): i tool che matchano
   `deny_tools` (skill:*, shell/run_command, l'altro make_*) sono **rimossi dalla lista offerta** al
   modello (non più `workflow_route_blocked_tool_message`). Il modello *non può* chiamarli.
2. **Bind deterministico** — nel dispatch di make_document/make_deck (grep il branch
   `"make_document"`), **fondi `args.template_ref`** dal binding negli arguments PRIMA della
   risoluzione (`document_generation_options`/`deliverable_template_ref`) → anche se il modello lo
   omette, il gateway lo mette. Il modello non può perdere il template.
3. **tool_choice forzato** — dove si costruisce il payload chat del modello (grep `build_chat_payload`
   / il punto in cui `structured_response_format`/`tools` entrano nella richiesta), se
   `routing.forcing == Specific` inietta `tool_choice: {type:"function", function:{name: tool_name}}`.
   ⚠️ Durante l'**intake** il modello deve poter chiedere domande in testo: quindi il forcing
   `Specific` si applica **solo quando l'intake è concluso** (euristica robusta: il thread ha ≥1
   risposta utente dopo il seed del template-workflow, cioè non è il primo turno). Sul primo turno:
   toolset potato (solo il tool giusto + read/ask) ma `tool_choice:"auto"`, così il modello chiede.
   Dal secondo in poi con binding attivo: `tool_choice: Specific`. Questo boxa senza rompere l'intake.

### 5. Test + gate

- capabilities: `WorkflowRouting` (de)serializza; `WorkflowRoutingRegistry` ritorna solo route di
  plugin abilitati (`plugin_installs.enabled`).
- gateway: router preferisce la route deterministica bound su BM25; `prune_tools_for_workflow_route`
  **rimuove** (non "blocca") i deny_tools; il dispatch make_document **fonde** `template_ref` dal
  binding quando il modello lo omette; `tool_choice` iniettato quando `forcing==Specific` e non è il
  primo turno; binding cancellato dopo delivery.
- UI: `enqueueTurn` porta `routing_binding`; `handleStartTemplateWorkflow` allega il binding e
  rimuove il testo-supplica dal prompt (build + ui-contract + electron verdi).
- Gate finali: `cargo test -p local-first-desktop-gateway` (+ capabilities crate), `pre_release_gate.py`.

## Invarianti / coerenza

- **Caposaldo**: state/control-flow nel codice, il modello riempie slot vincolati — il template_ref
  è bound dalla harness, il toolset è potato dal codice; il modello riempie solo il brief.
- **Converge, non duplica**: un solo router, un solo prune esteso, le route native diventano il
  "plugin di sistema" nello stesso registry — niente secondo percorso.
- **Fail-open sicuro**: senza binding, comportamento identico a oggi (native + BM25). Il prompt-fix
  `2a6ec2cc` resta come cintura per i thread senza binding / modelli forti.
- **Generalizzabile**: il registry legge da `plugin_installs.enabled`; plugin esterni aggiungeranno
  route senza toccare il gateway.

## Esclusioni (YAGNI)

UI utente per priorità/enable-disable per-route; manifest plugin esterni + hot-reload; routing per
capability atomiche (solo workflow deliverable in questa slice); il forcing `Required` generico
(basta `Specific` per il caso template). Portare eyebrow/hero_art al generato = slice a sé (era in
coda a S2, la scorporo: è ortogonale al routing).

## Rischi

- **tool_choice su provider non-OpenAI-compat**: alcuni provider ignorano/rifiutano `tool_choice`
  function-forcing → fallback: se il provider 400, ritenta senza forcing (il toolset potato + bind
  reggono comunque). Specchia il pattern a due tentativi di `generate_deck_content`.
- **Persistenza binding**: se il thread-scoped store non si cancella, turni futuri restano potati →
  cancellazione esplicita on-delivery + on-archive, con test.
