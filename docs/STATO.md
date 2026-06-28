# Stato — Homun (documento vivo)

> Aggiornato a OGNI sessione (vedi [METHODOLOGY.md](METHODOLOGY.md) §6). Resta **conciso**: è
> uno *stato*, non un changelog (lo storico va in `archive/`). Da qui si riparte dopo una
> compattazione o a inizio sessione.
> **Ultimo aggiornamento: 2026-06-27.**

## Dove siamo

- **Linea attiva:** *convergenza dalle fondamenta* →
  [plans/2026-06-27-foundations-up-convergence.md](plans/2026-06-27-foundations-up-convergence.md).
- **Scoperta che guida tutto:** ogni sottosistema ha **due implementazioni**, la canonica è
  **dormiente** (caposaldo #5 violato system-wide). È la causa dell'instabilità (piano che
  parte o no, stesso prompt esiti diversi). Le mappe accurate sono in [architecture/](architecture/).
- **F0 in corso (L0 — normalizzazione modello):**
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
  - ✅ **inc.3a** `think:true` capability-gated — `warm_ollama_thinking` (`/api/show` capabilities,
    cache per-modello) → `build_chat_payload` manda `think:true` SOLO ai modelli thinking
    (clean `message.thinking`, niente 400 sui non-thinking). Default fail-safe → fallback a
    estrazione `<think>` (inc.2). 2 test. (Realizza l'idea utente in modo sicuro.)
  - **Prossimo (inc.3b)**: convergere il resto di `sanitize_model_text` (tool_call/minimax tokens)
    nel normalizzatore; poi `parse_text_tool_calls` (tool-as-text); poi schema-downgrade duplicato;
    poi fixture per-provider. Poi L0 = punto fermo → F1.
    NB live-validation: il setup attuale usa deepseek-v4-pro:cloud (OpenAI-compat via Z.ai), non
    Ollama native → il path think si attiva solo con un modello reasoning su Ollama locale.

## Cosa è stato fatto (rolling, conciso)

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

**WIP non committata (intenzionale):** `crates/desktop-gateway/src/model_normalize.rs` +
`mod model_normalize;` in `main.rs` — fondamento ADR 0019, non cablato. È il punto di partenza di F0.

## Vincoli (NON violare)

- Commit diretti su `main`; **no** trailer `Co-Authored-By`. Release = commit + tag `vX.Y.Z` → CI
  builda draft (NON pubblicata). **NON pubblicare** finché l'agentic loop non è a posto.
- Per modifiche a `main.rs`: c'è la riga `mod model_normalize;` che referenzia un file untracked
  (WIP ADR 0019). Per committare solo i propri fix senza la WIP: rimuovere temporaneamente la riga
  `mod`, committare, ripristinarla (pattern già usato).
- `find_italian.py` non è in CI (gate locale); italiano per input-parsing è intenzionale.

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

PROSSIMO PASSO: <leggi "Dove siamo / Prossimo passo" in docs/STATO.md>.

A fine sessione aggiorna docs/STATO.md.
```
