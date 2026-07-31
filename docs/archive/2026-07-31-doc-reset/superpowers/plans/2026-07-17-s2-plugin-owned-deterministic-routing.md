# S2 — Plugin-owned deterministic routing: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** "Use template" instrada in modo **deterministico** al tool giusto (`make_document`/`make_deck`) con `template_ref` bound, per costruzione — via una `WorkflowRouting` **posseduta dal plugin** (registry), un binding **thread-scoped** sul turno, prune duro del toolset e `tool_choice` forzato. Il modello debole non può più vagare verso skill/shell.

**Architecture:** Le route diventano dati in un `WorkflowRoutingRegistry` (Presentations = plugin di sistema, generalizzabile a `plugin_installs.enabled`). Un `routing_binding` thread-scoped, letto a ogni turno, **forza la Workflow route** (bypassando il BM25 per-turno che oggi perde il contesto durante l'intake) → il prune esistente (`prune_tools_for_workflow_route`, ritiene solo il tool) gira su ogni turno; il dispatch **fonde** `template_ref`; `build_chat_payload` inietta `tool_choice` specifico dopo l'intake. Fail-open: senza binding, tutto identico a oggi.

**Tech Stack:** Rust (crates/capabilities + desktop-gateway main.rs + lib.rs + inference), React/TS (App.tsx + chatApi.ts).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-17-plugin-owned-deterministic-routing-design.md` (approvata, euristica intake OK).
- **Causa radice (verificata dal DB):** il route è per-turno via BM25; i turni d'intake ("mio", "1 Senior developer…") non matchano → route diventa AgentLoop → niente prune → il modello usa skill+shell. Il binding thread-scoped è la cura.
- **Fail-open**: senza `routing_binding` attivo, comportamento byte-identico a oggi (native + BM25 + relax). Ogni task deve preservarlo (il full crate suite è la guardia).
- ⚠️ `relax_route_for_tier` (ADR 0018 adaptive floor) rilassa una Workflow route ad AgentLoop per modelli capaci → il binding deve **bypassare** relax (deterministico vince sul floor).
- Commenti in inglese (il perché); commit su `main`, NIENTE Co-Authored-By, NIENTE push; TDD.
- ⚠️ Numeri di riga = anchor che invecchiano: ri-greppa il simbolo.
- Gate: `cargo test -p local-first-capabilities`, `cargo test -p local-first-desktop-gateway`, `npm run build`+`test:ui-contract`+`test:electron`, `pre_release_gate.py`.
- Route id fissati: `presentations.template_document` (make_document), `presentations.template_deck` (make_deck). plugin_id di sistema: `"presentations"`.

---

### Task 1: `crates/capabilities` — `WorkflowRouting` + registry

**Files:**
- Create: `crates/capabilities/src/workflow_routing.rs` (+ `pub mod workflow_routing;` in `lib.rs`)
- Test: nel modulo

**Interfaces:**
- Produces:
  - `pub struct WorkflowRouting { pub route_id: String, pub plugin_id: String, pub tool_name: String, pub route_text: String, pub priority: i32, pub deterministic: bool, pub deny_tools: Vec<String>, pub forcing: Forcing }`
  - `pub enum Forcing { None, Required, Specific }` (serde snake_case)
  - `pub struct WorkflowRoutingRegistry { … }` con `pub fn system() -> Self` (semina le 2 route Presentations) e `pub fn routings(&self, enabled: &dyn Fn(&str) -> bool) -> Vec<&WorkflowRouting>` (filtra per plugin_id abilitato; per il plugin di sistema `"presentations"` l'enabled-fn ritorna true oggi).
  - `pub fn tool_matches_deny(deny_tools: &[String], tool_name: &str) -> bool` (glob semplice: `"skill:*"` prefix, esatto altrimenti) — riusato dal prune.

- [ ] **Step 1: Test fallenti**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn system_registry_has_the_two_presentation_routings() {
        let reg = WorkflowRoutingRegistry::system();
        let all = reg.routings(&|_| true);
        let ids: Vec<&str> = all.iter().map(|r| r.route_id.as_str()).collect();
        assert!(ids.contains(&"presentations.template_document"));
        assert!(ids.contains(&"presentations.template_deck"));
        let doc = all.iter().find(|r| r.route_id == "presentations.template_document").unwrap();
        assert_eq!(doc.tool_name, "make_document");
        assert!(doc.deterministic);
        assert!(matches!(doc.forcing, Forcing::Specific));
        assert!(doc.deny_tools.iter().any(|d| d == "skill:*"));
    }
    #[test]
    fn disabled_plugin_routings_are_filtered_out() {
        let reg = WorkflowRoutingRegistry::system();
        assert!(reg.routings(&|_| false).is_empty());
    }
    #[test]
    fn deny_glob_matches_skill_prefix_and_exact() {
        let deny = vec!["skill:*".to_string(), "run_command".to_string()];
        assert!(tool_matches_deny(&deny, "skill:create_documents"));
        assert!(tool_matches_deny(&deny, "run_command"));
        assert!(!tool_matches_deny(&deny, "make_document"));
    }
}
```

- [ ] **Step 2: Run — FAIL** (`cargo test -p local-first-capabilities workflow_routing`)
- [ ] **Step 3: Implementazione** — il modulo con i tipi sopra; `system()` semina:
  - template_document: tool `make_document`, route_text (riusa il route_text di make_document native), priority 100, deterministic true, deny `["skill:*","run_command","shell","make_deck"]`, forcing Specific.
  - template_deck: idem con `make_deck` e deny `["skill:*","run_command","shell","make_document"]`.
- [ ] **Step 4: Run — verde**; `cargo test -p local-first-capabilities` intero verde.
- [ ] **Step 5: Commit**

```bash
git add crates/capabilities/src/workflow_routing.rs crates/capabilities/src/lib.rs
git commit -m "feat(capabilities): WorkflowRouting type + system routing registry (plugin-owned routing seam)"
```

---

### Task 2: `RoutingBinding` sul turno + persistenza thread-scoped

**Files:**
- Modify: `crates/desktop-gateway/src/lib.rs` (`EnqueueTurnRequest` ~l.110)
- Modify: `crates/desktop-gateway/src/main.rs` (nuova tabella + read/write/clear helpers; wire nell'enqueue)
- Test: mod tests di main.rs

**Interfaces:**
- Produces:
  - In `lib.rs`: `#[derive(...Serialize,Deserialize)] pub struct RoutingBinding { pub plugin_id: String, pub route_id: String, #[serde(default)] pub args: serde_json::Value }` + campo `#[serde(default)] pub routing_binding: Option<RoutingBinding>` su `EnqueueTurnRequest`.
  - In `main.rs`: `fn set_thread_routing_binding(thread_id, &RoutingBinding)`, `fn thread_routing_binding(thread_id) -> Option<RoutingBinding>`, `fn clear_thread_routing_binding(thread_id)`. Storage: tabella minimale `thread_routing_bindings(thread_id TEXT PRIMARY KEY, binding_json TEXT NOT NULL, created_at INTEGER)` nel DB gateway (grep dove sono create le tabelle chat, es. `CREATE TABLE IF NOT EXISTS chat_threads`, e aggiungi la migration accanto).

- [ ] **Step 1: Test fallente** (round-trip persistenza)

```rust
#[test]
fn thread_routing_binding_round_trips_and_clears() {
    let dir = isolated_gateway_test_dir("routing-binding");
    // usa lo stesso setup DB dei test esistenti (grep un test che apre il gateway store);
    // se il binding-store è dietro AppState, testa i tre helper su uno store in-memory.
    let b = super::RoutingBinding { plugin_id: "presentations".into(),
        route_id: "presentations.template_document".into(),
        args: serde_json::json!({"template_ref":"homun/cv-professional-01"}) };
    super::set_thread_routing_binding("t1", &b);
    assert_eq!(super::thread_routing_binding("t1").unwrap().route_id, b.route_id);
    super::clear_thread_routing_binding("t1");
    assert!(super::thread_routing_binding("t1").is_none());
}
```
(⚠️ Adatta al pattern reale di accesso al DB del gateway — grep come i test esistenti aprono lo store; se serve un handle/AppState, passa quello. L'importante è testare round-trip + clear.)

- [ ] **Step 2: Run — FAIL**, **Step 3: Implementazione** — migration tabella + i 3 helper + in `enqueue_chat_turn_core`/`enqueue_turn` (grep, ~32876/32970): se `req.routing_binding.is_some()`, `set_thread_routing_binding(thread_id, binding)` PRIMA di avviare il turno. (Il binding sopravvive ai turni d'intake successivi che NON lo re-inviano.)
- [ ] **Step 4: Run — verde** (full crate). **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/lib.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(gateway): thread-scoped routing binding — persisted on enqueue, read every turn"
```

---

### Task 3: Router override — il binding forza la Workflow route (bypassa BM25 + relax)

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` — il route call-site nel turn setup (grep `let routed = route_capability(&request.prompt);`, ~25045-25048)
- Test: mod tests

**Interfaces:**
- Consumes: Task 1 (`WorkflowRoutingRegistry`), Task 2 (`thread_routing_binding`).
- Produces: `fn route_capability_with_binding(prompt: &str, binding: Option<&RoutingBinding>) -> CapabilityRouteDecision` — se `binding` risolve a una `WorkflowRouting` deterministica nel registry, ritorna DIRETTAMENTE `CapabilityRouteDecision::Workflow { workflow_id, tool_name, scaffolding_tier, reason: "deterministic plugin routing", alternatives: [] }` **senza BM25**; altrimenti delega a `route_capability(prompt)`. Il call-site usa questa e, quando il binding è presente, **salta `relax_route_for_tier`** (deterministico vince sul floor).

- [ ] **Step 1: Test fallente**

```rust
#[test]
fn active_binding_forces_workflow_route_bypassing_bm25_and_relax() {
    let binding = super::RoutingBinding { plugin_id:"presentations".into(),
        route_id:"presentations.template_document".into(),
        args: serde_json::json!({"template_ref":"homun/cv-professional-01"}) };
    // prompt che da solo NON instraderebbe a make_document (mima un turno d'intake)
    let routed = super::route_capability_with_binding("mio", Some(&binding));
    match routed {
        super::CapabilityRouteDecision::Workflow { tool_name, .. } => assert_eq!(tool_name, "make_document"),
        other => panic!("expected forced Workflow route, got {other:?}"),
    }
    // senza binding, "mio" NON è una workflow route
    assert!(!matches!(super::route_capability_with_binding("mio", None),
        super::CapabilityRouteDecision::Workflow { .. }));
}
```

- [ ] **Step 2: Run — FAIL**, **Step 3: Implementazione** — `route_capability_with_binding` + al call-site: leggi `thread_routing_binding(thread_id)`, passa il binding; se presente NON applicare `relax_route_for_tier` (o applica una variante che no-op quando c'è un binding deterministico). Emetti un trace line "deterministic plugin routing: {route_id}".
- [ ] **Step 4: Run — verde** (full crate; verifica che i turni SENZA binding restino invariati — i test router esistenti devono passare). **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(gateway): active routing binding forces the workflow route (bypasses per-turn BM25 + adaptive-floor relax)"
```

---

### Task 4: template_ref bound sul dispatch + prune per deny_tools + clear on delivery

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` — branch dispatch `"make_document"`/`"make_deck"` (grep), `prune_tools_for_workflow_route` (~8179), il punto di successo delivery
- Test: mod tests

**Interfaces:**
- Consumes: Task 1-3.
- Produces: (a) prima della risoluzione di `document_generation_options`/`deliverable_template_ref` nel branch make_document/make_deck, se c'è un binding attivo sul thread **fondi** `binding.args.template_ref` negli `arguments` del tool call quando assente (il modello non può perderlo). (b) `prune_tools_for_workflow_route` esteso: oltre a ritenere il tool della route, RIMUOVI esplicitamente i tool che matchano i `deny_tools` della routing risolta (`tool_matches_deny`) — così skill/shell/altro-make spariscono anche se qualcosa li reintroduce. (c) al successo del deliverable (dopo `emit_rendered_deck_artifacts`/emit document), `clear_thread_routing_binding(thread_id)` → i turni successivi tornano liberi.

- [ ] **Step 1: Test fallenti** — (i) `merge_bound_template_ref(args, binding)` pura: se args manca `template_ref`, lo aggiunge dal binding; se presente, lo lascia (esplicito del modello vince? NO — deterministico: il binding vince SEMPRE per il template selezionato → decidi: **binding vince** se il modello mette un ref diverso da quello selezionato; testa che il ref del binding sia quello finale). (ii) `prune_tools_for_workflow_route` con una deny list rimuove uno schema `skill:*` presente.

```rust
#[test]
fn bound_template_ref_is_injected_when_model_omits_it() {
    let mut args = serde_json::json!({"brief":"x"});
    super::merge_bound_template_ref(&mut args, "homun/cv-professional-01");
    assert_eq!(args["template_ref"], "homun/cv-professional-01");
}
#[test]
fn prune_removes_denied_tools_not_just_retains_route_tool() {
    let mut tools = vec![
        serde_json::json!({"function":{"name":"make_document"}}),
        serde_json::json!({"function":{"name":"skill:create_documents"}}),
        serde_json::json!({"function":{"name":"run_command"}}),
    ];
    super::prune_tools_for_route_and_deny(&mut tools, "make_document", &["skill:*".into(),"run_command".into()]);
    let names: Vec<&str> = tools.iter().filter_map(|t| t.pointer("/function/name").and_then(|v|v.as_str())).collect();
    assert_eq!(names, vec!["make_document"]);
}
```

- [ ] **Step 2: Run — FAIL**, **Step 3: Implementazione** — le 3 parti; mantieni `prune_tools_for_workflow_route` come wrapper behavior-preserving (senza deny = retain-only-tool, come oggi) e aggiungi `prune_tools_for_route_and_deny` usato quando c'è una routing con deny.
- [ ] **Step 4: Run — verde** (full crate). **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(gateway): bind template_ref deterministically, hard-prune denied tools, clear binding on delivery"
```

---

### Task 5: `tool_choice` forzato in `build_chat_payload` (dopo l'intake) + fallback provider-400

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` — `build_chat_payload` (~15783-15844) + il chiamante che sa il turn-index e la routing attiva
- Test: mod tests

**Interfaces:**
- Consumes: la routing risolta (Forcing) + il turn-index (n° risposte utente nel thread).
- Produces: `build_chat_payload` guadagna un parametro `forced_tool: Option<&str>`; quando `Some(name)`, imposta `payload["tool_choice"] = {"type":"function","function":{"name":name}}` invece di `"auto"`. Il chiamante passa `Some(tool_name)` **solo** se: binding attivo + `forcing==Specific` + **non è il primo turno del template-workflow** (turn-index ≥ 1, cioè l'utente ha già risposto all'intake — euristica approvata). Sul primo turno resta `"auto"` (il modello chiede le domande). Fallback: se la richiesta modello torna 400 con tool_choice function, ritenta senza forcing (specchia il two-attempt di `generate_deck_content`; il toolset potato + il bind reggono comunque).

- [ ] **Step 1: Test fallente** (pura, sul payload)

```rust
#[test]
fn build_chat_payload_forces_tool_choice_when_requested() {
    let tools = vec![serde_json::json!({"function":{"name":"make_document"}})];
    let p = super::build_chat_payload(/*…existing args…*/, /*forced_tool=*/ Some("make_document"));
    assert_eq!(p["tool_choice"]["type"], "function");
    assert_eq!(p["tool_choice"]["function"]["name"], "make_document");
    let p2 = super::build_chat_payload(/*…*/, None);
    assert_eq!(p2["tool_choice"], "auto");
}
```
(⚠️ Adatta la firma reale di build_chat_payload — grep i suoi parametri; aggiungi `forced_tool` come ULTIMO param opzionale e aggiorna i call-site esistenti a `None` — behavior-preserving.)

- [ ] **Step 2: Run — FAIL**, **Step 3: Implementazione** — param + logica payload; il call-site nel loop calcola `forced_tool` da (binding, forcing, turn_index) e passa; il retry-senza-forcing sul 400 (riusa il pattern di fallback esistente per ImageUnsupported/json_schema — grep `400`/fallback nel giro modello).
- [ ] **Step 4: Run — verde** (full crate). **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(gateway): force tool_choice on the generation turn for a deterministic routing (auto during intake), 400-fallback"
```

---

### Task 6: UI — allega `routing_binding`, togli la supplica dal prompt

**Files:**
- Modify: `apps/desktop/src/lib/chatApi.ts` (`enqueueTurn` options), `apps/desktop/src/lib/coreBridge.ts` se la firma passa di lì, `apps/desktop/src/App.tsx` (`handleStartTemplateWorkflow` + il consumo di `pendingTemplateAutoSubmit`)
- Test: `check-ui-contract.mjs`

**Interfaces:**
- Consumes: il campo backend `routing_binding` (Task 2). Produces: il turno di "Use template" invia `routing_binding: { plugin_id:"presentations", route_id: isDocument ? "presentations.template_document":"presentations.template_deck", args:{ template_ref: id } }`.

- [ ] **Step 1:** in `enqueueTurn` (chatApi.ts) aggiungi `routing_binding` alle options → body POST. In `handleStartTemplateWorkflow` (App.tsx): costruisci il binding; **rimuovi** dal `operativePrompt` il blocco di supplica (`IMPORTANT: the ONLY correct way…` + `When the user confirms, your very next action MUST…`) — ora è deterministico via binding; il prompt resta brief + intake. Fai in modo che il consumo di `pendingTemplateAutoSubmit` (dove chiama enqueue) passi il `routing_binding`.
- [ ] **Step 2:** lock ui-contract: `assertContains("src/App.tsx", "routing_binding", "Use template must attach a deterministic routing binding")`. Bit-test.
- [ ] **Step 3:** gate `cd apps/desktop && npm run build && npm run test:ui-contract && npm run test:electron` verdi.
- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(presentations): Use template attaches a deterministic routing binding instead of pleading in the prompt"
```

---

### Task 7: gate completi + STATO

**Files:** Modify `docs/STATO.md`

- [ ] **Step 1: gate** — `cargo test -p local-first-capabilities` · `cargo test -p local-first-desktop-gateway` · `npm run build`+`test:ui-contract`+`test:electron` · `pre_release_gate.py` → ALL GREEN.
- [ ] **Step 2: STATO** — checkpoint S2 (IT, conciso, data): plugin-owned deterministic routing — `WorkflowRouting` registry (Presentations = plugin di sistema), binding thread-scoped, router-override (bypassa BM25 per-turno + relax), prune duro deny_tools, template_ref bound, tool_choice forzato post-intake; causa radice (route per-turno perdeva il contesto durante l'intake) risolta; fail-open senza binding; validazione live a schermo (Fabio) = "Use template" sul CV deve produrre il documento templated (make_document, non skill+shell). Cosa resta: eyebrow/hero_art al generato (slice a sé), S3 font picker.
- [ ] **Step 3: Commit** — `docs: STATO checkpoint — S2 plugin-owned deterministic routing shipped`

## Note di coerenza

- **Caposaldo**: state/control-flow nel codice (binding, prune, tool_choice), il modello riempie solo il brief.
- **Converge, non duplica**: un router, un prune esteso, le route native = "plugin di sistema" nello stesso registry.
- **Fail-open**: senza binding, byte-identico a oggi (il full crate suite lo prova a ogni task).
- **Validazione live**: il determinismo si prova a schermo (Fabio) — "Use template" sul CV → make_document(template_ref), niente skill/shell.
