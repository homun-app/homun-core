# Stato — Homun (documento vivo)

> Aggiornato a OGNI sessione (vedi [METHODOLOGY.md](METHODOLOGY.md) §6). Resta **conciso**: è
> uno *stato*, non un changelog (lo storico va in `archive/`). Da qui si riparte dopo una
> compattazione o a inizio sessione.
> **Ultimo aggiornamento: 2026-06-28.**

## Dove siamo

- **Linea attiva:** *convergenza dalle fondamenta* →
  [plans/2026-06-27-foundations-up-convergence.md](plans/2026-06-27-foundations-up-convergence.md).
- **Scoperta che guida tutto:** ogni sottosistema ha **due implementazioni**, la canonica è
  **dormiente** (caposaldo #5 violato system-wide). È la causa dell'instabilità (piano che
  parte o no, stesso prompt esiti diversi). Le mappe accurate sono in [architecture/](architecture/).
- **F0 COMPLETO (L0 — normalizzazione modello) — punto fermo, coda esaurita:**
  - ✅ **inc.1** `assistant_response` — builder canonico risposta + reasoning-fallback, cablato
    nei due collector (inline cancellato, `model_normalize` ora WIRED, 3 test).
  - ✅ **inc.1b** Ollama `message.thinking` — `process_ollama_line` accumula il reasoning trace
    (Ollama LO espone separato dal content) → fallback uniforme anche su Ollama.
  - ✅ **inc.1c** `ollama_tool_call` — normalizzazione tool-call Ollama (id sintetico + args
    oggetto→stringa) canonica + **testata** (2 test); inline cancellato. **Verificato vs fonte
    Ollama ufficiale + context7**: tool_calls completi per-chunk, accumulo `extend`, args oggetto,
    niente id — la nostra impl combacia.
  - ✅ **inc.2** `split_reasoning_from_content` — estrae `<think>…</think>` da content→reasoning
    nel builder. Verifica ha scoperto: `message.thinking` Ollama si popola solo con `think:true`
    (non lo mandiamo) → i reasoning model emettono `<think>` inline che `sanitize` cancellava
    (risposta vuota se tutto nel think). Ora estratti+preservati per il fallback. 2 test.
  - ✅ **inc.3a/3b** Profilo capacità Ollama — `warm_ollama_capabilities` (`/api/show`, cache
    per-modello) estrae `OllamaCapabilities { thinking, tools, vision, context_length }`. 2 test.
  - ✅ **inc.3c** CONSUMATO il profilo (tutti fail-safe, None/cloud → invariato): `think:true` solo
    ai thinking; `tools` (non offre tool a chi non li fa); `vision` (screenshot solo ai vision-model,
    altrimenti nota testo).
  - ✅ **inc.3d** CONVERGENZA su `model_registry::ModelEntry` (catalogo utente = fonte unica,
    caposaldo #5): il profilo si legge dal catalogo (`registry_model_capabilities`); `/api/show`
    arricchisce E **auto-compila** l'entry (`autofill_model_entry_capabilities` → aggiorna
    vision/tools/reasoning/context_window + salva). Niente più store parallelo `OllamaCapabilities`
    (ora è solo cache runtime sorgentata dal registry). Risolve la duplicazione che avevo introdotto.
    `context_length`: letto per l'auto-fill; usarlo per BUDGET prompt = follow-up validato.
  - ✅ **inc.4** `sanitize_model_text` (+ `strip_tag_blocks`/`strip_fullwidth_bar_tokens`) spostato
    in `model_normalize` → **tutta la normalizzazione testo nel modulo canonico**. 1 test. Call site
    aggiornati a `model_normalize::sanitize_model_text`.
  - ✅ **inc.5** `parse_text_tool_calls` + `synthesize_tool_calls` (+ helper `xml_attr_value`,
    `parse_xml_parameters`) spostati in `model_normalize` → **anche il tool-as-text** (Hermes/Qwen
    `<tool_call>`, Claude/MiniMax `<invoke>`) è ora canonico. Il "blocco" annotato era illusorio:
    `xml_attr_value` è condiviso solo *dentro* il cluster → tutto migra insieme. La rimozione cura
    anche un doc orfano lasciato da inc.4 (riattacca il doc di `prune_browser_history`). 4 test.
    Commit `8d9aad72`. **La frontiera canonica (ADR 0019) possiede ora OGNI forma di tool-call**
    (strutturata o trapelata-come-testo) → caposaldo #6/#11.

  - ✅ **inc.6** schema-downgrade floor (F0.6) — la costruzione del `response_format` (strict
    `json_schema` → degrade `json_object`) era hand-rolled in 3 punti (`build_request_body`
    inference, `generate_deck_content` + `orchestration_judge_response_format` gateway). Convergiuta
    in `local_first_inference::structured_response_format(name, schema)`; i 3 siti la chiamano.
    Behavior-preserving (test giudice + provider come guardia). Resta per-sito solo il control-flow
    di trasporto. Commit `b29fa4a3`. Caposaldo #5/ADR 0016.
  - ✅ **inc.7** `context_length` nel budget prompt (F0.7) — `chat_context_budget_chars` ora budgeta
    sulla finestra REALE del modello (catalogo `ModelEntry.context_window`, auto-filled F0.3d) via
    `registry_model_capabilities`, non più un flat 32k. Precedenza env-override > catalogo > 32k;
    policy pura `resolve_context_budget_chars` (1 test, 6 casi). Commit `7cd44e22`. Caposaldo #6.

**L0 (model-io) — PUNTO FERMO COMPLETO.** Normalizzazione risposta (builder canonico +
reasoning-fallback, `<think>`, tool-call Ollama + tool-as-text, sanitize, profilo capacità) tutta in
`model_normalize`; floor structured-output in una sola `structured_response_format`; budget prompt
sulla finestra reale. Testato e verificato sulla fonte. **Coda L0 esaurita.**

**F1 — capability unica (IN CORSO).** Vedi [piano](plans/2026-06-27-foundations-up-convergence.md):
- ✅ **(b) skill** (F1.b) — ritirato il `SkillCapabilityProvider` tipato dormiente (errore di
  categoria: skill = prosa, non tool chiamabile); path filesystem = canonica. Metadati skill/plugin
  tenuti (fondazione WS9). Commit `7b1fcecb`.
- ✅ **(c) Composio** (F1.c) — convergiuto sul path **v3** unico; ritirato il provider crate pre-v3
  (`composio.rs` cancellato). Era anche un **bug latente** (list_tools pre-v3 vs API v3 → run autonome
  rotte). Gate deny-by-default preservato in `authorize_managed_capability_tool` (riusa
  `CapabilityPolicy::tool_access`), 1 unit-test. Commit `4bb88afb`. **Non validato live** (no account Composio).
- ⏳ **(a) motore di ricerca unico** — convergere `bm25_rank` (chat) vs `ToolSearchIndexStore` FTS5
  (orchestrator). Il più grosso, intrecciato con F3 (quale engine sopravvive). Non ancora iniziato.
- ⏳ **(d) browser dentro il registry** — **(a) e (d) sono ACCOPPIATI**, scoperto questa sessione.
  Il registry GIÀ semina tool browser (`seed_default_capabilities`, `main.rs:43394`) ma come
  `browser.health/.tabs/.snapshot/.navigate/.act/.screenshot` (dot-named, **schema placeholder**
  `{"type":"object"}`, `WriteWithConfirmation`), mentre il loop di chat usa `browser_navigate/_act/…`
  (underscore, **schema reali** via `browser_*_tool_schema`). Il planner quindi vede un **set ombra che
  non combacia** con i tool eseguibili → torna 0 step. Fix corretto (NON cerotto): riconciliare gli entry
  registry browser coi nomi/schema reali **e** far costruire il `ToolSearchIndexStore` dell'orchestrator
  da quegli entry — cioè è la stessa convergenza di (a). **Fare (a) e (d) insieme, in una sessione a
  contesto fresco**, non uno slice superficiale ora.

Mappe: [registry](architecture/capability-registry.md), [skills](architecture/skills.md),
[connectors](architecture/connectors-composio.md), [browser](architecture/browser.md), [mcp](architecture/mcp.md).
NB live-validation: setup attuale = deepseek-v4-pro:cloud (Z.ai), non Ollama; Composio non configurato.

## Cosa è stato fatto (rolling, conciso)

**Sessione 2026-06-28 — chiusura L0 (F0.5–F0.7) + avvio F1 (b, c):**
- **F0.5** tool-as-text (`parse_text_tool_calls`/`synthesize_tool_calls` + helper) → `model_normalize`;
  doc orfano curato; 4 test. Commit `8d9aad72`.
- **F0.6** floor structured-output convergiuto in `structured_response_format` (1 def, 3 call-site);
  behavior-preserving. Commit `b29fa4a3`.
- **F0.7** budget prompt sulla finestra reale del modello (catalogo); policy pura testata. Commit `7cd44e22`.
- **L0 = punto fermo completo; coda esaurita.**
- **F1.b** ritirato `SkillCapabilityProvider` dormiente (skill = prosa, non tool). Commit `7b1fcecb`.
- **F1.c** Composio convergiuto su v3, provider crate pre-v3 cancellato (era anche un bug latente);
  gate preservato + testato. Commit `4bb88afb`. **Restano F1 (a) search-engine e (d) browser-in-registry.**

**Sessione 2026-06-27 — diagnosi + fix sintomo + analisi strutturale + metodologia:**
- **Fix agentic-loop validati e pushati** (default flag-off, migliorano il model-loop):
  anti-churn `‹‹PLAN››`, compaction data-preserving, grounding calibrato, snapshot browser
  content-preserving + attesa, fonti pulite, wander-cap, sintesi-finale, **resume-from-store**
  (risolve "il piano riparta"), recovery `browser_act` malformato. Commit `bccf7706`, `ddeeb633`,
  `0f4c686d`.
- **Analisi strutturale (4 assi)** → il control-flow è del **modello**, non dell'harness; due
  motori. **ADR 0020** (convergenza) + **Fase 1 increment 1a** (planner deterministico dietro
  `HOMUN_ORCHESTRATED_CHAT`, flag-off): `ec28d5c4`, `cf817896`. *Gap trovato:* il planner
  orchestrator non vede i tool chat (browser) → torna 0 step per la ricerca → serve planner
  **chat-tool-aware** (F3).
- **Reverse-engineering completo dei sottosistemi** → 9 mappe accurate con Mermaid in
  `architecture/` (agent-loop, model-io, browser, mcp, skills, connectors-composio,
  contacts-channels, capability-registry, memory) + **il piano foundations-up** + hub aggiornato.
  Commit `941664ac`.
- **Metodologia + stato** (questo file + METHODOLOGY.md) istituiti per la continuità.

**Nota storica:** `crates/desktop-gateway/src/model_normalize.rs` è ora **tracciato e cablato**
(F0.1–F0.5). Il vecchio workaround sul `mod model_normalize;` untracked non serve più.

## Vincoli (NON violare)

- Commit diretti su `main`; **no** trailer `Co-Authored-By`. Release = commit + tag `vX.Y.Z` → CI
  builda draft (NON pubblicata). **NON pubblicare** finché l'agentic loop non è a posto.
- `model_normalize.rs` è tracciato (niente più workaround sul `mod` untracked).
- `find_italian.py` non è in CI (gate locale); italiano per input-parsing è intenzionale.
- Gate locale: `cargo test -p local-first-desktop-gateway` ha 1 fallimento ambientale atteso
  (`import_pptx_template_pack…` richiede `soffice`/LibreOffice assente in dev) — non è una regressione.

## Ambiente di debug

- Dev: `cd apps/desktop && HOMUN_DEBUG=1 [HOMUN_ORCHESTRATED_CHAT=1] npm run electron:dev` sul
  `~/.homun` reale. Gateway `cargo run` su `:18765` con log **visibili** (l'app pacchettizzata ha
  `stdio:ignore` → niente log). Diagnostica `[plan]`/`[browser_act]` gated su `HOMUN_DEBUG`.
- Thread/risposte: `~/.homun/desktop-gateway.sqlite` (`chat_threads`, `chat_messages`).
- `~/.homun/runtime-settings.json` → `adaptive_floor: "off"` (tenere off finché F2 non lo realizza).
- Build gateway: `cargo build -p local-first-desktop-gateway --bin local-first-desktop-gateway`.

## Prompt di ripartenza (copia questo per una sessione nuova)

```
Continuo Homun (assistente agentic local-first). Repo: /Users/fabio/Projects/Homun/app, branch main.

PRIMA leggi, in ordine: docs/CAPISALDI.md (principi), docs/METHODOLOGY.md (come si lavora),
docs/STATO.md (dove siamo), docs/plans/2026-06-27-foundations-up-convergence.md (il piano),
e le mappe in docs/architecture/ del sottosistema su cui lavoriamo.

CONTESTO: il sistema ha due implementazioni per ogni sottosistema, la canonica dormiente
(caposaldo #5 violato) → instabilità. Stiamo CONVERGENDO dalle fondamenta (bottom-up):
F0 normalizzazione modello → F1 capability unica → F2 loop tier-adattivo (ADR 0018) →
F3 un motore (ADR 0016/0020). Niente cerotti, niente terza implementazione: si cabla la
canonica e si ritira il parallelo; si rimuove il codice morto toccato; si splittano i file
grossi; si commenta il perché; ogni modifica aggiorna la pagina architecture/ + cita il
caposaldo + porta un test.

PROSSIMO PASSO: F1 (a)+(d) INSIEME (sono accoppiati). Leggi le mappe
docs/architecture/capability-registry.md + browser.md + mcp.md, poi:
- (a) convergi i due motori di capability-search: bm25_rank (chat, main.rs:17719) e
  ToolSearchIndexStore FTS5 (orchestrator, crates/orchestrator/src/tool_index.rs) → UN solo
  componente di ricerca condiviso.
- (d) nello stesso movimento, riconcilia gli entry browser del registry
  (seed_default_capabilities main.rs:43394 — oggi dot-named `browser.navigate` con schema
  placeholder) coi tool REALI del loop (`browser_navigate` ecc., schema veri via
  browser_*_tool_schema), e fa' costruire il ToolSearchIndexStore dell'orchestrator da quegli
  entry → il planner vede il browser → sblocca ADR 0020/F3. È coupled con F3: valuta se serve
  toccare l'orchestrator (load_initial_tools, brain.rs:233).
Fatto F0 (L0 completo) + F1 (b) skill + (c) Composio. Vedi "Dove siamo" in STATO per i dettagli.

A fine sessione aggiorna docs/STATO.md.
```
