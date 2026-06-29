# Decision 0021: Un solo loop agentico guardato + piano-come-tool — non due motori

Date: 2026-06-29

## Status

**Accepted.** **Inverte la direzione** della [0020](0020-converge-chat-loop-onto-orchestrator.md)
(che era *Proposed*: "convergere il loop chat SULL'OrchestratorBrain"): si converge sul **loop di
chat unico** (`stream_chat_via_openai`, "motore #1"), non sull'orchestrator come secondo motore di
esecuzione. **Emenda** la [0016](0016-harness-owned-task-engine-cross-model.md): ne conferma
l'**obiettivo** (l'harness possiede il control flow; deve reggere sul tier locale/debole) ma ne
corregge il **meccanismo** (niente motore plan-execute separato né slot-filling JSON sull'intero
turno). Si appoggia alla [0018](0018-adaptive-harness-subagents-triggers.md) (le manopole/pavimento
restano, ma come guardrail *dentro* il loop unico) e alla
[0006](0006-openclaw-browser-runtime-reference.md)/[0010](0010-contained-computer-real-browser.md)
(motore #1 È il port fedele di OpenClaw).

## Perché questa decisione esiste

La 0020 aveva diagnosticato correttamente il problema (**due motori**, control flow del modello) ma
aveva scelto la **direzione di convergenza sbagliata**: spostare il turno chat sul motore #2
(OrchestratorBrain: piano DAG tipizzato → esecutore che cammina gli step, con i subagenti come
slot-filler `generate_json`). Provata sul campo (2026-06-29), quella direzione **regredisce**:

- **Prova empirica (drive ON, `HOMUN_DRIVE_CHAT`).** Sul browse il loop agentico del drive
  (`run_agentic_step`, `crates/orchestrator/src/agentic.rs`) è nettamente peggiore di motore #1:
  ~16 round × **2 chiamate modello** ciascuno (~5 min), **vaga** (scroll su scroll, `action=None`),
  e ritorna una **risposta VUOTA**. Riproducibile (infobox Wikipedia, notizie tech). Ogni patch
  (troncamento snapshot → wandering → sintesi vuota) scopriva un altro pezzo che motore #1 ha già:
  stavamo **duplicando motore #1, peggio** (caposaldo #5).

- **Evidenza dallo stato dell'arte (3 cluster di ricerca citati, 2026-06-29).** Il campo nel 2025 ha
  convergito su **UN loop agentico guidato dal modello** con il **piano come *tool*** dentro il loop,
  **non** un planner+executor separato:
  - **ReAct** (Yao et al., 2022, [arxiv.org/abs/2210.03629](https://arxiv.org/abs/2210.03629)):
    ragionamento e azione si interlacciano in un loop solo; il piano si rivede contro l'osservazione
    a ogni passo. I failure-mode documentati del Plan-and-Execute (piano scritto alla cieca →
    stantio, plan drift, **executor che diverge dal planner**, doppio loop di reasoning) sono
    **esattamente** i nostri.
  - **Anthropic, "Building Effective Agents"**
    ([anthropic.com/research/building-effective-agents](https://www.anthropic.com/research/building-effective-agents)):
    *workflow* = "percorsi di codice predefiniti" (= il nostro motore #2, DAG precalcolato) vs
    *agent* = "il modello dirige dinamicamente" (= motore #1). Persino l'orchestrator-workers è *un
    LLM in un loop che decide*, non un DAG dato a un esecutore stupido. Principio: "aggiungi
    complessità solo quando migliora dimostrabilmente i risultati".
  - **Claude Code** = un master loop singolo; il piano è un **tool** (`TodoWrite`); "l'harness
    possiede il control flow" = ~98% di infrastruttura **deterministica** *attorno a un loop solo*.
    **Cognition/Devin** ("Don't Build Multi-Agents"): contesti frammentati tra motori = fragilità.
    **Manus**: piano = `todo.md` recitato nel contesto. **OpenAI Agents SDK**: sub-agenti **come
    tool** di un agente che tiene un solo thread di controllo.
  - **Browser-agent** (browser-use, Playwright-MCP, Skyvern): loop singolo + rappresentazione
    strutturata della pagina con **elementi indicizzati (ref/index, non pixel)** + **done-tool**
    esplicito + progress/todo + verifica di completamento. **browser-use ha RIMOSSO** il suo planner
    LLM separato. Motore #1 è già in questa famiglia (aria-snapshot + ref, come Playwright-MCP).
  - **Modelli deboli** (la tesi della 0016): "i modelli piccoli falliscono i loop aperti" = **vero**
    (→ servono guardrail). "Quindi forzali in slot JSON" = **contraddetto**: forzare l'output
    strutturato **danneggia il ragionamento** (*"Let Me Speak Freely?"*, EMNLP 2024,
    [arxiv 2408.02442](https://arxiv.org/abs/2408.02442); *"The Format Tax"*, 2025 — «il degrado
    entra dal **prompt**, non dal decoder»). La leva per i modelli deboli è **semplificare e
    scoporre** (meno tool ma migliori, scope stretto, *code-as-action*, slot-filler fine-tuned),
    non irrigidire con un orchestratore.

Conclusione: motore #1 (loop ReAct singolo, native tool-calling, aria+ref) **è** il design SOTA ed è
corretto; il **drive** (motore #2 come secondo motore di esecuzione) è l'errore architetturale. Il suo
unico vantaggio teorico — delegare sotto-step a un modello **più economico** — **non esiste** per un
target locale/debole.

## La decisione

1. **Un solo loop agentico guardato.** Il loop di chat (`stream_chat_via_openai`) è IL motore. Non si
   instrada il turno su un secondo motore di esecuzione. La 0020 (convergere sull'orchestrator) è
   superata: si converge **sul loop di chat**.
2. **Il piano è un *tool* dentro il loop**, non un motore separato. Le invarianti utili del piano
   tipizzato (monotonìa, limitatezza, **identità = id del runtime, non dal testo** — caposaldo #6)
   restano, ma vivono come **guardrail deterministici** attorno al loop unico e come stato di un
   eventuale tool di pianificazione (stile `TodoWrite`: lista task in JSON vincolato, ri-iniettata/
   recitata nel contesto), non come un `merge_plan` per-titolo né un DAG precalcolato a esecutore.
3. **"L'harness possiede il control flow" si realizza con guardrail attorno al loop**, non con un
   secondo LLM: cap sugli step, no-progress/wander detection, verifica (gate F2), routing/permessi,
   conferme di scrittura, fail-open. (Obiettivo della 0016 confermato; meccanismo corretto.)
4. **Constrained decoding sì, ma sull'estrazione finale, non sull'intero turno.** "Model fills a
   slot" resta come **vincolo di decoding sugli argomenti del tool** (native tool-calling provider-
   enforced, o schema sull'ultimo step), non come forzatura JSON che sopprime il ragionamento.
5. **Modelli deboli: semplificare e scoporre**, non scaffoldare di più. Meno tool ma migliori, scope
   stretti, eventualmente code-as-action / slot-filler fine-tuned per i sotto-task ripetitivi.
6. **Già fatto (commit `8c427e18`):** i piani solo-browse del drive tornano a motore #1
   (`plan_is_browse_only` → `Ok(None)` → fallback). Validato live (app Electron): browse e chiamata
   MCP funzionano.

## Conseguenze

- **Si tiene motore #1** come motore unico (default già così, flag OFF).
- **Il drive (`HOMUN_DRIVE_CHAT`) non è più il target di convergenza.** Resta default-off; il browse
  è già delegato. Non si investe oltre nel drive come *motore di esecuzione*. Il valore di
  pianificazione, se serve, si riesprime come **piano-come-tool dentro motore #1** (lavoro futuro,
  incrementale). `crates/orchestrator` non va cablato come driver del turno chat.
- **F0** (normalizzazione modello) e **F1** (registry capability, ranker unico) **restano**: sono
  fondamenta vere che servono a motore #1, non lavoro buttato.
- **Sottosistema browser** (sidecar OpenClaw-fedele, aria+ref) **invariato**; semmai si adottano da
  esso le tecniche del lineage che funziona (done-tool esplicito, no-progress, todo) *dentro motore
  #1*, dove già in parte ci sono.
- **0016**: obiettivo confermato, meccanismo emendato (vedi banner nella 0016).
- **0020**: superata da questo ADR (vedi banner nella 0020).
- **0018**: resta valida — pavimento/manopole sono guardrail nel loop unico.

## Cosa NON cambia

- L'harness possiede il control flow (è il punto, solo con la forma giusta).
- La verifica deterministica dove possibile (caposaldo #11).
- Local-first, privacy, registry unico delle capability, memoria come layer condiviso.

## Fonti

ReAct [arxiv 2210.03629](https://arxiv.org/abs/2210.03629) · Anthropic "Building Effective Agents"
[link](https://www.anthropic.com/research/building-effective-agents) · LangChain "Plan-and-Execute"
[link](https://www.langchain.com/blog/planning-agents) · Cognition "Don't Build Multi-Agents"
[link](https://cognition.com/blog/dont-build-multi-agents) · Manus context engineering
[link](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) ·
browser-use, Playwright-MCP, Skyvern (repos/docs) · "Let Me Speak Freely?"
[arxiv 2408.02442](https://arxiv.org/abs/2408.02442) · "The Format Tax" (RANLP 2025) · NVIDIA "SLMs
are the Future of Agentic AI" [arxiv 2506.02153](https://arxiv.org/abs/2506.02153). Sintesi completa
in memoria: nota `homun-single-loop-evidence-verdict`.
