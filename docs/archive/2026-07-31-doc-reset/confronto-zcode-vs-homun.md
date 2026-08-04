# Confronto strutturale: Homun vs ZCode vs Codex (chat · agenti · tool · memoria)

> Analisi di **reverse-engineering**, non di prodotto. Scopo: capire, assegnamento per
> assegnamento, come tre coding/personal agent gestiscono chat, agenti, tool e memoria, e
> **dove si differenziano strutturalmente**. Punto di partenza dichiarato: la memoria di
> Homun "non è fluida" — qui ne verifichiamo le cause nel codice.
>
> **Data di verifica: 2026-07-01.**
> Sorgenti analizzate:
> - **ZCode** = bundle distribuito `/Users/fabio/Projects/zcode/Contents` (app.asar
>   estratto; codice *minificato* ma stringhe/percorsi/nomi-modulo leggibili). Versione
>   3.2.1, build `3d011a8c` del 2026-06-30.
> - **Codex** = bundle distribuito `/Users/fabio/Projects/codex/Contents` (app.asar
>   estratto + binari nativi `codex` 249MB Rust, `codex_chronicle`, `cua_node`). Versione
>   26.623.81905.
> - **Homun** = sorgente reale `/Users/fabio/Projects/Homun/app` (workspace Rust).
>
> ⚠️ **Limiti del confronto.** Di ZCode e Codex vedo architettura, dipendenze e stringhe
> API ma *non* la logica fine (nomi minificati; Codex ha anche un binario Rust). Di Homun
> vedo tutto. La logica algoritmica dettagliata dei loop non è confrontabile;
> l'architettura e i flussi sì.

---

## TL;DR — il punto fondamentale

| | ZCode | Codex | Homun |
|---|---|---|---|
| **Chi fa girare l'agente?** | Un **processo separato** (CLI `zcode.cjs`, JSON-RPC su stdio). Il desktop è solo *host*. | Un **binario Rust nativo** `codex` (249MB), JSON-RPC su **Unix socket**. Il desktop è host + worker JS intermedio. | **Tutto in un processo** Rust (`desktop-gateway`, un `main.rs` da ~56k righe). |
| **Chi possiede il loop LLM→tool→LLM?** | Il CLI esterno. L'host *non ha logica di loop*. | Il binario Rust esterno (loop turn-based su OpenAI **Responses API**). | Il gateway, inline in `stream_chat_via_openai`. |
| **Chi possiede i tool?** | Il CLI. | Il binario Rust (built-in: shell, apply_patch, web_search, view_image, update_plan, unified_exec) **+ MCP** come sorgente tool. | Il gateway, in un grande `match name`. |
| **Chi gestisce la memoria?** | **Nessuno** durante il turno: file markdown + SQLite *indice*. Nessun RAG per-turno. | `codex_chronicle` (daemon **separato** che registra lo schermo → memory markdown); `state_5.sqlite` per lo stato thread. | Il gateway, con **RAG ibrido (FTS+vector) su ogni singolo turno**. |

**Tre architetture, tre filosofie.**
- **ZCode** separa e delega: l'host è quasi vuoto, la complessità è nel CLI esterno.
- **Codex** separa e delega *di più*: host + worker JS + **binario Rust nativo** + due
  daemon satellite (chronicle per la memoria, cua_node per il browser). Il multicore più
  strutturato dei tre.
- **Homun** possiede e centralizza: tutto in un processo monolitico, sul percorso caldo.

**Conseguenza decisiva per la fluidità.** ZCode e Codex hanno entrambi spostato il loop
e la memoria **fuori dal processo della UI** — quindi il loro percorso "prompt utente →
LLM" è *diretto*, l'host è postino. Homun *ogni turno* attraversa un orchestratore
monolitico che, prima del modello, fa lavoro sincrono (ricerca memoria, embedding,
assemblaggio prompt). **Lì sta la non-fluidità — ed è la lezione che due sistemi
indipendenti (ZCode e Codex) confermano con la stessa scelta architetturale.**

**In una frase:** ZCode/Codex sono *lean e fluidi perché hanno spostato il motore e la
memoria fuori dal percorso del messaggio*; Homun è *ricco ma lento perché intelligente
sulla memoria inline*. Homun ha costruito il sistema più ambizioso e paga il costo del
turno sull'hot path — esattamente dove gli altri due non lo pagano.

> Le differenze **di motore** (runtime, non feature) sono raccolte in [§6.1](#61-differenze-di-motore-a-prescindere-dalle-feature),
> e **in cosa si traducono** (causa radice → sintomi) in [§6.2](#62-in-cosa-si-traduce--causa-radice--sintomi--conseguenze).
> Il pattern che le riassume: **ZCode separa e delega; Homun possiede e centralizza.**

---

## 0. Mappa di alto livello dei due sistemi

### ZCode — stack
- **Electron 26.8 + React 19** (monorepo `@zcode/desktop` con pacchetti workspace
  `@zcode/client|server|rpc|services|shared|ui`). Editor **Monaco**, terminale **xterm
  + node-pty**, markdown via `marked`+`katex`+`shiki`+`mermaid`.
- **3 processi** visibili in `out/`: `main/` (Electron main), `host/` (backend bridge:
  pty, MCP, ripgrep, agent host), `preload/` (contesto isolato), `renderer/` (UI React).
- **Backend AI = famiglia GLM** (Zhipu/z.ai) + provider terzi (Kimi, MiniMax, DeepSeek,
  Qwen, Xiaomi MiMo). Catalogo in `Resources/model-providers/`.
- **Agente = processo CLI separato** (`apps/zcode-cli/.../zcode.cjs`, `app-server --stdio`)
  parlante **ACP** (`@agentclientprotocol`) + un JSON-RPC custom "ZCode Protocol".
- Build `electron-builder`, auto-update via CDN `cdn-zcode.z.ai`.
- Interopera con Claude Code: c'è `ClaudeAgentsFileMigrationStatus`,
  `ClaudeAgentsFileToZcodeAgentsFile`, e `settings-sync` che rispecchia
  skills/commands/plugins/config-MCP in ~15 agent-CLI nativi (claude, codex, gemini,
  opencode, qwen, windsurf, kiro, roo, …).
- **Stack UI** (verificato nel renderer): Tailwind CSS v4 + Radix UI (15 primitive
  headless) + cmdk + react-resizable-panels. **Niente shadcn/ui** (zero `data-slot`,
  zero `cva`/`tailwind-merge`): styling hand-rolled. Markdown via pipeline unified
  custom (remark CJK + rehype + micromark → hast→React renderer custom) con **Shiki**
  (715 grammatiche), **rehype-katex**, **Mermaid**.

### Codex — stack
- **Electron 42 + Vite** (`.vite/build/`), ma con un'architettura a **3 strati**:
  `bootstrap.js` (main) → `worker.js` (app-server JS intermedio) → **binario Rust nativo
  `codex`** (249MB, tokio + serde + hyper + sqlx + clap + **starlark** per config/plugin).
- **Editor: CodeMirror 6** (NON Monaco come ZCode); UI in **Preact + `@preact/signals`**
  (NON React); markdown via mdast/remark; syntax **Shiki** + Prism; diff unified.
- **Model API**: OpenAI **Responses API** (`/v1/responses`) con chaining via
  `previous_response`, modelli `gpt-5.2-codex` / `gpt-5.1-codex-max`. Parametri
  `reasoning_effort`, `parallel_tool`, `tool_choice`.
- **Trasporto a doppio protocollo** (verificato): il binario Rust parla **JSON-RPC 2.0**
  (`thread/*`, `turn/*`) su **Unix socket** (`unix://`, anche `--listen stdio` e `ws://`);
  tra main e worker JS c'è un secondo strato **capnweb** (Cap'n Proto RPC, framing a
  segmenti, messaggi Bootstrap/Resolve/Finish). Più strutturato di ZCode (un solo hop).
- **3 processi satellite**: il binario `codex` (motore), **`codex_chronicle`** (daemon
  Rust che **registra lo schermo** → distilla in "Chronicle memories" markdown in chunk
  da 10min/6ore, con `privacy_filter` sulle finestre private — **memoria osservativa
  sempre-on, separata dal loop**), e **`cua_node`** (runtime Node v24 + **Playwright/CDP**
  per il computer-use/browser automation, lanciato via `spawnComputerUseService`).
- **Tool**: built-in nel binario Rust (`shell`, `apply_patch`, `update_plan`,
  `web_search`, `view_image`, `unified_exec`, `custom_tool`) **+ MCP come sorgente tool**
  (GitHub MCP, OpenAI Dev Docs MCP; SDK `@modelcontextprotocol/sdk` 1.29 bundle lato JS).
- **Skills**: convenzione `SKILL.md` (come Claude/ZCode) in `skills/skills/.curated/`
  (es. `hatch-pet/`, `onboard-new-user/`), con `agents/openai.yaml` + script. Gated da
  flag `skill_approval`. Store remoto via `marketplace/add`/`remove`.
- **Update via Sparkle** (nativo macOS, non electron-updater), Sentry per telemetria.
- **`external-agent-migration`** workspace package: importa config da Claude Code etc.

### Homun — stack
- **Frontend Electron + React** → `fetch` HTTP verso un **gateway Rust** (`desktop-gateway`).
- Workspace di **15 crate** Rust con nomi parlanti: `memory`, `orchestrator`,
  `context-compression`, `task-runtime`, `capabilities`, `skill-runtime`, `subagents`,
  `inference`, `desktop-gateway`, `vault`, `browser-automation`, `process-manager`,
  `local-computer-session`, `secrets`, `process-skill`.
- LLM provider via **OpenAI-compat** o **Ollama nativo** (routing inline nel gateway);
  `crates/inference` è solo per JSON strutturato (Brain/subagent/judge).
- **Memoria** = SQLite local-first (`~/.homun/memory.sqlite`) + FTS5 + embedding
  (`nomic-embed-text-v2-moe` via Ollama) + grafo associativo (Graphify) + wiki markdown.

---

## 1. CHAT / SESSIONI

| | ZCode | Codex | Homun |
|---|---|---|---|
| Unità conversazione | Il **"Task"** = una sessione ACP. | Il **"Thread"** di **turn** (item tipizzati: `user-message`, `agent-message`, `reasoning`, `proposed-plan`, `turn-diff`, `permission-request`… ~30 tipi). | Il **Thread** (`ChatThread`), **ad albero** con branching/edit. |
| Modello messaggi | `snapshot.messages[]` con `tool_calls` strutturati, ID threaded (`messageId`, `turnId`, `toolCallId`). | **Item tipizzati** con `type` discriminator + flag `completed` (stile OpenAI Responses API "raw_response_item"). Il più strutturato dei tre. | `ChatMessage` flat `{role, text}` + **marker inline** (`‹‹PLAN››`, `‹‹ACT››`, `‹‹ARTIFACT››`) resi a card. |
| Persistenza | File JSON per sessione + SQLite *indice* (`tasks-index.sqlite`), sync in background (`task-index-syncer`). | `state_5.sqlite` (sqlx nel binario Rust) + `thread-metadata`/`thread-orders` lato UI. | SQLite (`desktop-gateway.sqlite`), ma **il renderer fa il commit** finale (`commit_prompt_result`). |
| Streaming UI | Eventi ACP (`agent_message_chunk`/`tool_call_update`) → MessagePort. | **Eventi `codex/event/*` tipizzati** (`agent_message_content_delta`, `reasoning_content_delta`, `plan_delta`, `exec_command_output_delta`) su JSON-RPC. ~60 tipi evento. | **NDJSON su HTTP** (`POST /api/chat/generate_stream`) + resume registry (riattacco a stream vivo). |
| Approvazioni / scelte multiple | Evento `elicitation_request` con schema JSON → dialog custom. | **Item `permission-request`/`mcp-server-elicitation`/`proposed-plan`** che bloccano il turn, risposti via **RPC dedicati** (`thread-follower-*-approval-decision`, `-submit-mcp-server-elicitation-response`). Profili: read-only/auto/granular/guardian/full. | (gestito via `pending_confirm` / marker, non come evento tipizzato separato). |
| Isolamento | Per workspace. | Per thread/workspace + `writable-roots`. | Per workspace + **domini privacy** (le chat di progetto non vedono i fatti personali). |

**Differenza chiave (modello messaggi).** Homun ha un modello **più ricco lato UI**
(branching, resume stream) ma **più povero lato dato persistito** (text flat). ZCode fa
l'opposto: dato strutturato persistente. Il branching di Homun è un punto di forza che
ZCode non ha.

### 1.1 Rendering chat: parts strutturate vs marker inline (verificato in entrambi) ⚠️

Questa è una **differenza architetturale importante** tra i due, oltre al modello dati.

| | ZCode | Homun |
|---|---|---|
| **Rappresentazione contenuto** | Array di `parts` **tipizzate** (`type:"content"`, `type:"thought"`, `type:"tool-call"` con `toolId`) — l'host emette eventi strutturati e il renderer fa uno switch per tipo. | Testo flat + **marker inline** (`‹‹REASONING››…‹‹/REASONING››`, `‹‹PLAN››`, `‹‹ACT››`, `‹‹ARTIFACT››`) **parsati a runtime** dal frontend con regex. |
| **Come il frontend "sa" cosa è cosa** | Lo *sa* fin dall'origine: l'evento è già tipizzato. | Lo *indovina* parsando il testo (`extractReasoning`, `REASONING_MARKER_RE`, `THINK_RE`). |
| **Scelte multiple / AskUserQuestion** | Evento `elicitation_request` con **schema JSON** (`{requestId, header, options[], multiSelect, schema}`) → dialog custom (niente RadioGroup libreria). | (gestito via `pending_confirm` / marker, non come evento tipizzato separato). |
| **Rendering rich (markdown/codice/diagrammi)** | Pipeline unified custom (remark CJK + rehype + micromark) → **hast→React renderer custom**; **Shiki** (715 grammatiche), **rehype-katex**, **Mermaid**. | `react-markdown` + remark + rehype (+ `marked` in qualche path). |
| **Componenti UI custom** | `ToolCallBlock`, `DiffViewer`, `Reasoning` — custom su Tailwind v4 + Radix UI (15 primitive) + cmdk. Niente shadcn/ui (zero `data-slot`/`cva`). | `RichMessage`/`RichMessageRenderer` custom su parsing marker. |
| **Streaming** | Reducer custom che fonde `agent_message_chunk`/`tool_call_update` nelle `parts` + `parseIncompleteMarkdown` (riparse del markdown troncato in volo). | Eventi NDJSON `delta`/`done`; parsing marker che deve gestire anche il caso *streaming aperto* (`THINK_OPEN_RE`). |

**Trade-off.** L'approccio di ZCode (**parts strutturate**) è **più robusto**: il frontend
non deve dedurre la semantica dal testo — il dato è tipizzato alla sorgente, niente parsing
di token che possono rompersi, colare nel contesto del modello, o essere malformati durante
lo streaming. L'approccio di Homun (**marker inline**) è **più semplice da emettere** (il
gateway scrive testo) ma **più fragile**: richiede regex, gestione dei casi parziali
(marker aperto durante lo stream, leakage del modello tipo `<think>` dei reasoning-model,
frammenti `‹/REASONING››` spuri), e **crea un vincolo implicito**: il gateway deve
sempre produrre marker ben formati per non corrompere la UI.

**Implicazione per Homun.** Se la chat di Homun a volte "non convince" in coerenza o
fluidità di rendering, una causa strutturale plausibile è proprio il **marker-inline
approach**: ogni nuovo tipo di contenuto (un tool, una domanda, un artefatto) richiede
un nuovo marker + una nuova regex + gestione del caso streaming, invece di un nuovo
`type` di part. Il commento nel codice Homun stesso lo ammette (`RichMessage.tsx`:
"Streaming/provider leakage can leave empty or malformed fragments"). Migrare verso un
modello a **parts strutturate** (il gateway emette eventi tipizzati, il renderer fa switch)
ridurrebbe la fragilità e semplificherebbe l'aggiunta di nuovi tipi di contenuto.

**Riferimenti Homun:** `apps/desktop/src/components/RichMessage.tsx`
(`REASONING_MARKER_RE`, `THINK_RE`, `extractReasoning`), `src/lib/chatApi.ts`
(eventi `delta`/`done`).

---

## 2. AGENTI / LOOP

| | ZCode | Codex | Homun |
|---|---|---|---|
| Chi guida act-vs-answer? | Il CLI (logica nascosta nel bundle). | Il **binario Rust** (turn-based loop su Responses API; `parallel_tool`/`tool_choice`). | **Il modello** decide, nel loop di engine #1 (`main.rs:20046`). L'harness possiede solo guardrail. |
| Definizione "agente" | Provider di modelli + il CLI. | Thread + turn su **vocabolario RPC custom** (`thread/*`, `turn/*`); `update_plan` come tool first-class. | **3 nozioni coesistenti**: (a) il loop stesso con prompt hardcoded; (b) ruoli-modello in `providers.json`; (c) subagent archetypes **hardcoded in Rust**. |
| Subagent / parallelismo | `Subagent`/`BackgroundTask` proiettati dal CLI. | **`parallel_tool`** (tool calls paralleli nativi via Responses API); `multi-agent-action` item. | DAG tipizzato (`subagents`), ma **esecuzione sequenziale** (niente `tokio::join` reale); regola "due write mai in parallelo". |
| Modo | `normal`/`auto`/`plan` (plan = `ExitPlanMode` tool). | Profili approval `read-only`/`auto`/`granular`/`guardian`/`full` + `proposed-plan`→`plan-implementation`. | `agent`/`plan`/`ask`/`debug` come **direttive nel prompt di sistema**. |
| Human-in-the-loop | `permission_request`/`elicitation_request` mediati dall'host. | **Item blocking** (`permission-request` con `completed=false`) + RPC dedicati di risposta. | `pending_confirm` **termina il turno** e lo riprende dopo approvazione; + gate durevole per task in background. |

**Differenza chiave.** ZCode e Codex nascondono la complessità del loop in un processo
esterno (CLI JS / binario Rust). Homun espone **due motori** (engine #1 in produzione =
ReAct guardato con planning-as-tool; engine #2 = `OrchestratorBrain`/DAG in fase di
abbandono, ADR 0021). Questa transizione è una fonte di attrito concettuale, ma la
decisione di convergere su engine #1 è giusta. **Netto vantaggio Codex: parallelismo
nativo** (`parallel_tool`) — né ZCode né Homun lo hanno realmente.

**Riferimenti Homun:** loop `crates/desktop-gateway/src/main.rs:18514`
(`stream_chat_via_openai`), round loop `:20046`, fork act/answer `:20450`, modi `:19225`;
ruoli modello `model_registry.rs:387` (`ProviderRegistry`), `:411` (`RoleBinding`),
`:427` (`ROLES`); engine #2 `crates/orchestrator/src/brain.rs`, `driver.rs`, `agentic.rs`;
subagent `crates/subagents/src/{runner.rs, orchestrator.rs, agents.rs, types.rs}`.

---

## 3. TOOL / CAPABILITY

| | ZCode | Codex | Homun |
|---|---|---|---|
| Dove sono definiti i tool? | Nel CLI (Read/Edit/Bash/Grep…) — **non nell'host**. | **Nel binario Rust** (built-in: `shell`, `apply_patch`, `update_plan`, `web_search`, `view_image`, `unified_exec`, `custom_tool`) **+ MCP** come sorgente tool (GitHub MCP, OpenAI Dev Docs MCP). | Inline in `main.rs` come schemi JSON (`base_tools`) **+** registro tipizzato `CapabilityFacade`. |
| Capability vs Tool | Solo "tool" (passati al CLI in `session/create` come `mcpServers`). | Tool built-in (Rust) + tool MCP (discovered); MCP **non è il protocollo host**, solo una sorgente. | **Distinzione esplicita**: Tool = ciò che chiama il LLM; Capability = abilità di sistema con policy (`model_visible` ≠ `executable`). |
| Discovery | Passa `mcpServers` + allow/disallow list per sessione. | MCP `tools/list` (RuntimeChanged/ToolListChanged notifications); store remoto via `marketplace/add`. | **`find_capability` con retrieval BM25** + progressive disclosure (CORE sempre caricati, resto deferred). |
| Esecuzione | Nel CLI. | Nel binario Rust (shell/apply_patch/web_search); browser via `cua_node` (Node+Playwright/CDP) separato. | Browser via sidecar Node/CDP, shell via Docker `homun-cc`, fs jailata, MCP via stdio JSON-RPC. |
| Governance | Allow/disallow list per sessione. | Profili approval + per-feature flags (`sandbox_approval`, `mcp_elicitations`, `skill_approval`). | **Privacy domains + autonomy levels** (`Read`=0, `Write`=2), fail-closed. |

**Differenza chiave.** La distinzione Homun capability/tool **è più evoluta** di ZCode/Codex
(che sono piatti). Ma ZCode/Codex sono più *coerenti* perché esternalizzano i tool in un
motore separato (CLI / binario Rust). Homun ha i tool inline nel `main.rs` **+** un
registro parallelo tipizzato che *non è ancora la sola fonte* (work "F3" non finito):
doppia via che paga in flessibilità ma costa in coerenza. **Codex è il modello più pulito:
tool built-in nel motore Rust + MCP come unica sorgente esterna.**

**Riferimenti Homun:** `crates/capabilities/src/{types.rs:101 CapabilityTool,
provider.rs:8 trait, facade.rs:10, policy.rs:30, registry.rs:211 store, search.rs BM25}`;
routing `main.rs:8297` (`route_capability`); toolset live `:19266`; dispatch `:20577`;
browser `main.rs:25929` (`chat_browser_call`) + `crates/browser-automation/src/sidecar.rs`;
sandbox `main.rs:44866` (`CONTAINED_CONTAINER_NAME`), `:44632`
(`contained_computer_cdp_endpoint`); substrate `crates/process-manager`, `crates/local-computer-session`.

---

## 4. MEMORIA — il cuore del confronto ⭐

### 4.1 Tabella di sintesi

| | ZCode | Codex | Homun |
|---|---|---|---|
| Filosofia | **File-based**, zero RAG per-turno. La "memoria" = markdown. | **Memoria osservativa sempre-on, daemon separato** (`codex_chronicle` registra lo schermo → distilla in memory markdown). Zero RAG per-turno. | **RAG ibrido per ogni turno** (FTS5 bm25 + vector cosine) + grafo associativo + wiki + ciclo candidate→confirmed. |
| Storage | File `.md` + SQLite come *indice* (no vector DB). | `state_5.sqlite` (sqlx nel binario) per thread + **memory markdown** in chunk 10min/6h da chronicle. | SQLite (`memory.sqlite`) con embeddings come BLOB, FTS5, tabelle grafo. |
| Embeddings | **Nessuno.** | (non nel bundle; chronicle usa LLM per distillare, non embedding search). | `nomic-embed-text-v2-moe` via **Ollama locale** (HTTP `127.0.0.1:11434`). |
| Vector index | N/A | N/A | **NESSUNO** — brute-force cosine su tutti gli embedding (no ANN/HNSW). |
| Scrittura | Esplicita (editi i markdown) o via skill importati. | **Background, daemon separato**: chronicle osserva → distilla → scrive, **disaccoppiata dal loop**. | **Automatica post-turno**, asincrona, multi-stadio (extract → Candidate → embed → consolidate → Confirmed). |
| Lettura | Skill iniettati nel prompt come XML `<activated_skill>`. | L'agente legge le memory markdown **a bisogno**, non ogni turno. | **5+ full-scan per turno** dietro un singolo `Mutex` globale. |
| Compressione contesto | Delegata al CLI (c'è `session/compact`). | `thread/compact` nel binario Rust (`previous_response` chaining della Responses API). | **Solo euristica** (head/tail/keyword, stima token chars/4) — niente summarization LLM. |

**Verdetto strutturale.** La memoria di Homun è **drasticamente più ambiziosa** di ZCode/Codex
(grafo, FTS, vector, lifecycle, privacy domains, progetti isolati, wiki generata). ZCode
al confronto è "primitiva" — passa file markdown. Codex è "ricca ma disaccoppiata":
memoria osservativa potente, ma in un **daemon separato** fuori dal percorso del turno.
**Ma il design di ZCode/Codex è fluido perché costa ~zero per turno. Quello di Homun costa
tanto, e cresce con la dimensione della memoria.** Codex è la prova vivente che "memoria
ricca" e "fluidità" non sono in tensione: basta che la memoria non stia sul percorso.

### 4.2 I quattro meccanismi di memoria di ZCode (per completezza)

1. **File-based memory** (`AGENTS.md`, `CLAUDE.md`): `~/.claude/CLAUDE.md`,
   `~/.zcode/AGENTS.md` — contesto sempre-on, file-based.
2. **Skills system** (memoria procedurale primaria): `SKILL.md` scoperti da più root
   (`<ws>/.zcode/skills`, `~/.zcode/skills`, `<ws>/.agents/skills`, `~/.agents/skills`,
   + plugin manifest `.zcode-plugin`/`.claude-plugin`/`.codex-plugin`) e iniettati nel
   prompt come `<activated_skill name=… path=…>body</activated_skill>`.
3. **settings-sync** (mirroring cross-agent): tabelle `J_`/`X_`/`Y_`/`Q_` rispecchiano
   skills/commands/plugins/config-MCP di ZCode in ~15 agent-CLI nativi. ZCode si
   posiziona come **gestore unificato** che scrive memoria in qualsiasi CLI l'utente usi.
4. **Repo Wiki** (knowledge base per-workspace generata da LLM): `<dataroot>/v2/repo-wiki/<hash>`,
   `wiki.json` rigenerato solo se cambia `manifestHash`. Più **repo snapshot sidecar**
   (stato git catturato prima di ogni prompt).

### 4.3 I sette layer di memoria di Homun (per completezza)

Tutti in **una tabella logica** (`memories`) discriminata da `memory_type`:

| Kind | `memory_type` | Ruolo |
|---|---|---|
| Semantica (fatti/preferenze) | `fact`, `preference` | Atomi richiamabili. Preferenze = tier sempre-on. |
| Working / open loops | `open_loop` | Lavoro incompiuto + il *perché*, sopravvive a nuove chat. |
| Episodica / timeline | `episode` | Conversazioni passate, scoped per workspace. |
| Decisioni + causalità (il PERCHÉ) | `decision` | `metadata.decision.rationale` + alternative scartate. |
| Artefatti | `artifact` | Output con proprio lifecycle. |
| Obiettivi | `goal` | North-star del progetto. |
| Grafo associativo | `entities`+`relations` | Sinapsi + archi causali (`produced`, `derived_from`, `affects`, `supersedes`). |

**Riferimenti Homun:** `crates/memory/src/types.rs:95` (`MemoryRecord`), `:73`
(`MemoryStatus` Candidate/Confirmed/…), `:117`/`:131` (grafo), `:263` (`RoutineRecord`);
store `crates/memory/src/store.rs:46`; facade `facade.rs:295` (`apply_extraction`).

---

## 5. Diagnosi: perché la memoria di Homun "non è fluida"

Verificato nel codice. La non-fluidità **non è un'impressione**: ha cause strutturali
identificabili, in ordine di impatto.

### 🔴 (1) Brute-force cosine sul percorso caldo — `O(N)` per turno
`relevant_memory_for_prompt` (`main.rs:13112`) chiama `facade.list_embeddings(...)` che
**carica ogni BLOB embedding dello scope in `Vec<f32>` e fa cosine uno per uno**
(`facade.rs:276`, `store.rs:860`). Non c'è indice ANN/IVF/HNSW. **Ogni turno, più ricordi,
più la recall diventa lenta.** Problema più grave: latenza cresce linearmente con la
memoria accumulata.

### 🔴 (2) Un solo `Arc<Mutex<MemoryFacade>>` + una sola `Connection` SQLite
Tutta la memoria gira dietro **un mutex blocking + una connessione singola**
(`store.rs:15`). Recall, write, embedding catchup, consolidation, list UI — **tutto si
serializza**. Un `backfill_embeddings` in background che tiene il lock fa aspettare il
prossimo messaggio dell'utente. Genera stalli percepibili.

### 🟠 (3) Embedding del query fatta in rete, sul percorso, ogni turno
`embed_text(&state.http, query)` (`main.rs:13047`) fa una **chiamata HTTP a Ollama ad ogni
turno** per embeddare la query, prima del passaggio lessicale+semantico. Se Ollama è
freddo/lento, ogni turno paga quella latenza prima di chiamare il modello. (Degrada a
solo-lessicale se fallisce, ma il costo c'è.)

### 🟠 (4) 5+ round-trip/scansioni complete per turno
Una recall si ramifica in: `list_memories_for_ui` (carica *tutti* i fatti in `HashMap`),
search FTS, scan embeddings, e *separatamente* `workflow_status_context_for_query` +
`artifact_provenance_context_for_query` che **richiamano list_memories + list_relations +
list_entities di nuovo**. Dietro l'unico lock.

### 🟡 (5) Latenza di scrittura asincrona, consolidamento off di default
La memoria viene scritta come `Candidate` post-turno, embeddata in background, e
`consolidate_scope` (dedup + promozione a `Confirmed`) è **off di default**
(`HOMUN_AUTO_CONSOLIDATE_HOURS=0`). Un fatto imparato al turno N può non essere
confermato/embeddato per un po' → la memoria "sembra stantia" durante la conversazione.

### 🟡 (6) Compressione solo euristica
`context-compression` (`crates/context-compression/src/lib.rs`) non ha LLM: taglia
head/tail/keyword e stima token con chars/4. Una sessione lunga **non viene mai compattata
intelligentemente** — solo troncata. L'unica via di "oblio" è un clamp 6k su `ChatHistory`.

### ⚫ (7) Monolite orchestratore
Tutta l'orchestrazione memoria (recall, extraction, consolidation, embedding, lock,
prompt assembly) è **inline in un `main.rs` da ~56k righe**, non nel crate `memory`.
Difficile da profilare, testare isolatamente, ottimizzare. Tutti i costi sopra convergono
in un hot path unico.

---

## 6. Chi vince dove (a tre)

| Dimensione | Vince | Perché |
|---|---|---|
| **Fluidità percepita** | 🏆 ZCode = Codex | Entrambi hanno il percorso per-turno quasi vuoto (motore esterno). Homun paga sull'hot path. |
| **Ricchezza memoria** | 🏆 Homun (di molto) | Grafo, vector, FTS, lifecycle, privacy, wiki. ZCode/Codex hanno markdown (Codex arricchito da chronicle). |
| **Memoria + fluidità insieme** | 🏆 Codex | `chronicle` è memoria osservativa ricca MA in daemon separato → fluida. L'unico che ha entrambe. |
| **Modello chat/UI** | 🏆 Homun (modello dati) | Branching, resume stream. Codex ha item tipizzati (~30 tipi, il più strutturato). |
| **Robustezza rendering chat** | 🏆 Codex ≥ ZCode | Entrambi usano **item/parts strutturati** tipizzati. Homun usa marker inline parsati con regex (più fragile). |
| **Pulizia architetturale** | 🏆 Codex ≥ ZCode | Separazione netta host↔motore (Rust). Codex ha anche daemon satellite isolati. Homun è un monolite con due motori. |
| **Modello tool/capability** | 🏆 Homun (concettuale) | Distinzione capability/tool + governance privacy. Codex/ZCode più piatti ma più coerenti. |
| **Subagent/parallelismo** | 🏆 Codex | `parallel_tool` nativo (Responses API). ZCode/Homun deboli. |
| **Isolamento crash (blast radius)** | 🏆 Codex | Ogni capacità in processo separato (motore, chronicle, cua_node). Homun: tutto muore insieme. |

**Trade-off in una frase:** ZCode/Codex sono *fluidi perché hanno spostato motore e
memoria fuori dal percorso del messaggio*; Homun è *ricco ma lento perché intelligente
sulla memoria inline*. Codex dimostra che "ricco" e "fluido" non sono in conflitto —
basta il posizionamento giusto (chronicle come daemon separato).

---

## 6.1 Differenze di motore (a prescindere dalle feature)

Le differenze sopra sono per area funzionale. Qui raccogliamo le differenze di **runtime /
motore** — scelte architetturali profonde che condizionano *tutto* il resto, non legate a
una feature specifica. Sono le più rilevanti emerse dall'analisi.

### Il pattern che emerge

> **ZCode e Codex separano e delegano; Homun possiede e centralizza.**
> Codex spinge la separazione **oltre** ZCode (4 processi vs 2).

| Dimensione motore | ZCode | Codex | Homun |
|---|---|---|---|
| **Dove vive il loop** | Processo CLI **separato** (JSON-RPC su stdio); il desktop è "terminale intelligente". | **Binario Rust nativo** separato (JSON-RPC su Unix socket); host + worker JS intermedio. | Processo **unico monolitico** Rust (`desktop-gateway/main.rs`, ~56k righe). |
| **Chi decide act-vs-answer** | CLI (scatola nera). Forma dei messaggi (parts con `toolCallId` threaded) suggerisce **harness-controlled**. | Binario Rust; `parallel_tool`/`tool_choice` via Responses API. | **Il modello**, in engine #1 (`main.rs:20046`); l'harness ha solo guardrail. **Model-driven** (caposaldo #2). |
| **Sincronia del percorso per-turno** | Host quasi **vuoto**: fa da postino. | Host quasi **vuoto**: fa da postino (JSON-RPC al binario Rust). | Host **pieno**: recall RAG O(N) + RTT embedding via Ollama + 5+ scan DB dietro un mutex, **prima** di chiamare il modello. |
| **Dove stanno i tool** | Nel **CLI**. L'host fornisce binari (git, rg, pty) come *substrato*. | **Nel binario Rust** (built-in) + MCP come sorgente; `cua_node` separato per browser. | **Nel gateway**, `match name` inline + registro `CapabilityFacade`. Crash di un tool = stesso processo. |
| **Numero di motori** | **Uno** (il CLI). | **Uno** (binario Rust) + 2 daemon satellite (chronicle memoria, cua_node browser). | **Due**: engine #1 (ReAct, in produzione) + engine #2 (`OrchestratorBrain` DAG, in abbandono, flag `HOMUN_DRIVE_CHAT` off). Debito di motore fantasma. |
| **Parallelismo** | Host proietta sessioni ACP separate → **vera concorrenza** possibile. | **`parallel_tool` nativo** via Responses API (il migliore dei tre). | DAG tipizzato ma **esecuzione sequenziale** (niente `tokio::join`; regola "due write mai in parallelo"). |
| **Persistenza** | File JSON = **verità**; SQLite = **indice** derivato (tenuto in sync). | SQLite (`state_5.sqlite`) per thread; memory markdown da chronicle. | SQLite = **verità** unica (chat + memoria + grafo). |
| **Context window** | **Delegato** al CLI (`session/compact`). | **Delegato** al binario Rust (`thread/compact` + `previous_response` chaining). | **Posseduto** ma solo-euristica (`head/tail/keyword`, stima token chars/4) — niente summarization LLM. |

### Le 5 differenze di motore più rilevoli (in ordine di impatto)

**(a) Dove vive il loop — la differenza fondante.** ZCode ha separato fisicamente
"interfaccia" (Electron) dal "motore" (CLI). Conseguenze: il loop è **usabile headless**
(stdio, senza UI); l'host **proietta** loop multipli in parallelo senza duplicare logica;
l'host **non sa nulla** di come si pensa. Homun ha tutto in un processo: vantaggio =
coerenza e zero overhead IPC; svantaggio = ogni cambio al motore tocca il monolite, e non
c'è modo di far girare l'agente senza il gateway. **Se mai vorrai un'API/CLI programmatica
per Homun, la struttura attuale te lo rende difficile. ZCode lo ha gratis.**

**(b) Sincronia del percorso per-turno — la fonte della non-fluidità.** Non è una feature,
è una **proprietà emergente del design**. ZCode ha spostato tutta la complessità nel CLI;
Homun l'ha messa sul percorso di *ogni* messaggio. La non-fluidità percepita nasce qui:
ogni turno paga O(N) recall + RTT embedding + serializzazione su mutex, tutto inline nel
gateway prima di chiamare il modello.

**(c) Model-driven vs harness-controlled.** Homun è ReAct "model-driven": il modello sceglie
se agire o rispondere (più potente, più imprevedibile, a volte "vaga"). ZCode, dalla forma
dei messaggi, sembra più **harness-controlled** (l'host traccia ogni tool call come evento
di prima classe) → più deterministico. Il model-driven di Homun è dichiarato caposaldo #2
ma **violato** (ADR 0021); engine #2 tentava di spostare il controllo nell'harness ed è in
abbandono.

**(d) Esternalizzazione dei tool — accoppiamento.** In ZCode i tool sono nel CLI, quindi
**inoppugnabili dal frontend** e **isolati**: un crash del CLI non tira giù il desktop. In
Homun i tool sono nello stesso processo della UI → ✅ policy granulari / governance / audit
(la distinzione capability/tool è superiore), ma ❌ un tool che si blocca **blocca il
gateway intero**. Homun: tool più *ricchi* ma più *accoppiati*; ZCode: tool più *isolati*
ma più *piatti*.

**(e) Persistenza: indice vs verità.** Approcci opposti. ZCode: file = verità
(ispezionabili, portabili, editabili, git-friendly), DB = derivato. Homun: DB = verità
unica. Vantaggio ZCode per un "personal agent" multi-anno: tra 5 anni i JSON saranno ancora
leggibili; uno schema SQLite custom, meno garantito. Vantaggio Homun: **coerenza
transazionale** (un solo store, niente sync da mantenere).

### L'insegnamento di motore (il punto per Homun)

La fluidità di ZCode **non** nasce dall'essere "stupido" sulla memoria — nasce dall'avere
**spostato la complessità fuori dal percorso del messaggio**. La lezione per Homun non è
"diventa stupido", è **"isola la complessità"**:
- Il loop potrebbe vivere in un crate/servizio separato dal gateway HTTP (come il CLI di
  ZCode), con un'interfaccia stretta — così il percorso "messaggio → LLM" non porta il
  peso della memoria inline.
- I tool potrebbero girare in un processo separato (supervisor + sidecar) invece che nello
  stesso processo del gateway.
- La persistenza potrebbe tornare "file = verità, DB = indice" per la parte longevità.

Queste sono mosse di *struttura del motore*, non di feature — e sono ciò che separa un
sistema "ricco ma pesante" da uno "ricco e fluido".

---

## 6.2 In cosa si traduce — causa radice → sintomi → conseguenze

Le differenze di motore (§6.1) non sono "una tra tante": sono la **causa radice** di quasi
tutti i sintomi emersi nell'analisi. La non-fluidità della memoria, la fragilità del
rendering, il debito del dual-engine, i limiti di parallelismo — sono *manifestazioni* della
stessa scelta: **tutto in un processo, sul percorso caldo**.

### Mappa causa-effetto (la radice è una, i sintomi sono molti)

```
                    ┌─────────────────────────────────────────────┐
                    │  CAUSA RADICE (scelta architetturale)        │
                    │  "Loop + tool + memoria + UI nello stesso    │
                    │   processo, sul percorso di ogni messaggio"  │
                    └──────────────────────┬──────────────────────┘
                                           │
        ┌──────────────────┬───────────────┼───────────────┬──────────────────┐
        ▼                  ▼               ▼               ▼                  ▼
  ┌──────────┐      ┌────────────┐  ┌────────────┐  ┌────────────┐    ┌──────────────┐
  │ SINTOMA  │      │  SINTOMA   │  │  SINTOMA   │  │  SINTOMA   │    │   SINTOMA    │
  │ Latenza  │      │  Blast     │  │  Debito    │  │  Soffitto  │    │  Memoria     │
  │ che      │      │  radius    │  │  di motore │  │  strutt.   │    │  non fluida  │
  │ cresce   │      │  del crash │  │  fantasma  │  │  futuro    │    │  (§5)        │
  └────┬─────┘      └─────┬──────┘  └─────┬──────┘  └─────┬──────┘    └──────┬───────┘
       │                  │               │               │                  │
       ▼                  ▼               ▼               ▼                  ▼
  recall O(N)         tool panic     engine #2       niente CLI/         brute-force +
  sul percorso        = app morta     ancora nel      API/parall.        mutex su
  caldo; +1 mese      (stesso proc.)  codice dietro   gratis              ogni turno
  di uso = +lento                     flag off
```

### Traduzione su 5 piani concreti

**1. Per l'utente → latenza che *cresce con l'uso*.** ZCode ha un pavimento di latenza
~0 per turno (l'host fa il postino). Homun ha un pavimento che **cresce con la memoria
accumulata** (recall O(N) brute-force inline). La conseguenza percepibile è subdola:
**più usi Homun, più diventa lento.** È un degrado che ZCode *strutturalmente non può
avere*; l'utente non lo nota il primo giorno, lo nota al terzo mese — ed è esattamente il
tipo di cosa che fa dire "qualcosa non mi convince". Non è un bug, è l'architettura che si
paga a regime.

**2. Per l'affidabilità → *blast radius* del crash.** In ZCode se un tool panic, muore il
processo CLI: l'host sopravvive, l'utente vede "agente disconnesso", può riprendere. In
Homun **un panic = il gateway muore = l'app muore = tutte le conversazioni attive muoiono,
tutto lo stato in-flight perso.** Homun è un single point of failure unico (loop + tool +
UI + memoria + browser sidecar, stesso processo). Consequence: ogni tool che si scrive è
un rischio per l'intera app.

**3. Per la velocità di sviluppo → costo del refactor.** ZCode può cambiare il motore
(anche un agent engine completamente diverso) senza toccare l'host. Homun cambiare il loop
= **chirurgia su ~56k righe di `main.rs`**. **Per te "rifattorizzare il loop" costa
settimane; per loro costa ore.** Questo spiega anche *perché* engine #2 è ancora nel codice
(§6.1): non è trascuratezza, è che toglierlo/rifonderlo è costoso proprio perché tutto è
centralizzato. La centralizzazione genera debito che si auto-alimenta.

**4. Per il futuro del prodotto → *soffitto strutturale*.** Dalla struttura di ZCode, a
costo zero, vengono fuori cose che per Homun sono **riscritture future**:

| Capacità | ZCode | Homun |
|---|---|---|
| CLI headless (senza UI) | ✅ gratis (parla stdio) | ❌ rewrite |
| API programmatica | ✅ gratis | ❌ da costruire sul gateway |
| Più agenti veramente paralleli | ✅ sessioni separate | ❌ `tokio::join` da attivare |
| Runtime alternativo (cambio engine) | ✅ swappa il CLI | ❌ chirurgia |
| Multi-utente / multi-tenant | ✅ un processo a utente | ❌ gateway monoutente |

La differenza si traduce in un **soffitto**: ciò che Homun *può diventare* è limitato da
questa scelta, non dal codice o dagli sforzi.

**5. Per la memoria stessa → il cerchio si chiude.** La fluidità della memoria è un
**sintomo diretto** di questa differenza. ZCode non ha memoria "fluida perché stupida" —
ha memoria che **non sta sul percorso del messaggio**. È un fenomeno di *posizionamento*,
non di *intelligenza*. Quindi quando ci si chiede "perché la mia memoria non è fluida", la
risposta non è "perché fai RAG", è **"perché il RAG vive dentro il processo che deve anche
rispondere all'utente, sul percorso di ogni turno, dietro un mutex."** È lo stesso motivo
per cui un tool può tirare giù tutto: il posizionamento.

### Tre cose da tenere a mente per ogni decisione futura

1. **Quasi ogni fastidio che si prova è lo stesso difetto che si manifesta in punti
   diversi** — non sono problemi separati da risolvere uno a uno, è uno schema da rompere
   una volta sola.
2. **La metrica che decide tutto è: "questo codice sta sul percorso di un messaggio
   utente?"** Tutto ciò che sta lì deve costare ~zero e crescere con ~zero. Oggi la
   memoria di Homun lo viola.
3. **La mossa vincente non è "ottimizza la memoria", è "sposta la memoria fuori dal
   percorso"** — è quello che fa ZCode col CLI. È una mossa di *posizionamento* che
   risolve fluidità, robustezza, testabilità e futuro in un colpo solo.

> Sintesi brutale: **ZCode ha disegnato un sistema dove puoi cambiare tutto senza rompere
> l'utente. Homun ha disegnato un sistema dove ogni miglioramento richiede attenzione a
> tutto.** Quella è la traduzione reale — e il motivo per cui l'insegnamento finale è
> "isola, non ottimizzare".

---

## 6.3 Il terzo punto di paragone: cosa conferma (e complica) Codex

L'aggiunta di Codex non è decorativa: **conferma con un secondo esempio indipendente la
lezione architetturale** e contemporaneamente mostra che si può spingere la separazione
**ancora più in là** di ZCode.

### Architettura a confronto (3 sistemi)

| Dimensione motore | ZCode | Codex | Homun |
|---|---|---|---|
| **# processi coinvolti** | 2 (host + CLI) | **4** (host + worker JS + binario Rust + chronicle; + cua_node on-demand) | **1** (gateway monolitico) |
| **Motore (loop LLM)** | CLI JS esterno | **Binario Rust nativo** (249MB) | Gateway Rust inline |
| **Transport host↔motore** | JSON-RPC su **stdio** | JSON-RPC 2.0 su **Unix socket** (+ strato capnweb/Cap'n-Proto tra main e worker) | nessuno (stesso processo) |
| **Memoria long-term** | file markdown (inline nel prompt) | **daemon `chronicle` separato** → memory markdown | RAG ibrido **inline nel gateway**, su ogni turno |
| **Browser/computer-use** | (non nel bundle analizzato) | **`cua_node` separato** (Node + Playwright/CDP) | sidecar Node/CDP ma nello stesso processo gateway |
| **Update** | electron-updater | **Sparkle** (nativo) | (manuale/custom) |
| **Editor** | Monaco | **CodeMirror 6** | (markdown, non editor) |
| **UI framework** | React 19 | **Preact + signals** | React |

### Cosa Codex conferma (la lezione diventa legge)

**Due sistemi indipendenti (ZCode di z.ai, Codex di OpenAI) hanno fatto la stessa scelta:
motore in un processo separato, host come postino.** Questo non è un caso — è la risposta
convergente al problema della fluidità. Quando un problema ha due soluzioni identiche da
vendor diversi, è praticamente una **legge architetturale** per questa categoria di
sistema. Homun è l'eccezione, e l'eccezione paga il prezzo della non-fluidità.

In particolare Codex conferma:
1. **Il loop sta fuori dalla UI.** Anche con un motore *Rust* (potrebbe stare inline come
   Homun), OpenAI lo ha comunque **esternalizzato in un binario separato**. Il vantaggio
   non è linguistico, è di *isolamento*.
2. **La memoria sta fuori dal percorso del turno.** `codex_chronicle` è un *daemon
   separato* che osserva lo schermo e produce memory — il loop agente **non fa RAG
   inline**; legge memory quando serve. Esattamente il contrario di Homun.
3. **I tool stanno nel motore, non nell'host.** Come ZCode: l'host vede solo gli item
   streamati, non definisce i tool.

### Cosa Codex complica (oltre ZCode)

Codex spinge la separazione **oltre** ZCode su tre fronti — e qui diventa un modello
ancora più ambizioso per Homun:

- **Multicore di processi.** Non solo host+motore, ma host + worker JS intermedio +
  motore Rust + daemon memoria (chronicle) + runtime browser (cua_node). Ogni capacità è
  un processo con il suo ciclo di vita. Maggiore complessità operativa, ma **blast radius
  minimo**: chronicle che crasha non tira giù il motore; cua_node che si blocca non
  blocca la chat.
- **Protocollo a strati.** JSON-RPC sul wire motore, ma capnweb (Cap'n Proto, binario)
  tra main e worker per performance. Una scelta "enterprise" che Homun (NDJSON su HTTP)
  non ha — ma che dice: *il transport è una decisione di primo livello*.
- **Memoria osservativa sempre-on, completamente disaccoppiata.** `codex_chronicle` è
  concettualmente diverso da tutto ciò che fa Homun: **registra lo schermo in
  background**, lo distilla in memory markdown, e l'agente lo legge a bisogno. Non c'è
  RAG per-turno, non c'è embedding query inline, non c'è mutex. È la prova che **memoria
  ricca e fluidità non sono in tensione** — basta che la memoria non stia sul percorso
  del messaggio.

### Implicazione netta per Homun (rafforzata)

La tesi del documento — *"isola la complessità, non ottimizzarla"* — non era basata su un
solo esempio. Ora ha **due esempi indipendenti** che convergono. Per Homun la mossa
strutturale guadagna urgente concretezza:

1. **Stacca il loop dal gateway** in un crate/servizio separato (come il binario `codex`
   o il CLI di ZCode). Il gateway HTTP resta solo postino.
2. **Stacca la memoria dal percorso del turno.** Ispirandosi a `codex_chronicle`: un
   servizio memoria separato che scrive in background e che il loop consulta
   *esplicitamente* (non su ogni turno). Questo uccide la non-fluidità alla radice senza
   rinunciare alla ricchezza della memoria di Homun.
3. **Stacca il browser/computer-use** in un processo satellite (come `cua_node`), così un
   crash del browser non tira giù la chat.

> **Sintesi a tre:** ZCode e Codex dimostrano che "ricco" e "fluido" non sono in
> conflitto — la fluidità nasce dal *posizionamento* (fuori dal percorso), non dalla
> *semplicità*. Homun può tenere tutta la sua ambizione (grafo, RAG, lifecycle, privacy,
> wiki) e diventare fluido **spostando** quelle capacità fuori dal gateway monolitico, in
> servizi separati. È la stessa lezione, ora confermata due volte.

---

## 7. Cosa prendere in prestito — mosse strutturali (in ordine di ROI)

1. **Indice vettoriale vero** (anche solo `sqlite-vec` o `usearch` embedded) per togliere
   il brute-force — uccide il problema 🔴(1).
2. **Cache del query-embedding** (per turni simili) + embedding async/prefetch — problema 🟠(3).
3. **Una query composta** invece di 5 round-trip dietro il lock — problema 🟠(4).
4. **Pool di connessioni SQLite** (WAL + più reader) o separare read-path dal write-path —
   problema 🔴(2).
5. **Estrarre l'orchestrazione memoria dal `main.rs`** nel crate `memory` come *servizio*
   con interfaccia stretta — problema ⚫(7) e rende i punti sopra testabili.
6. **Compressione con LLM** opzionale per sessioni lunghe — problema 🟡(6).

> Questi interventi preservano la *ricchezza* della memoria di Homun (grafo, lifecycle,
> privacy) riducendo il costo per turno verso lo zero-costo strutturale di ZCode.

---

## 8. Domande aperte (possibili prosieguo)

- Il modello "zero RAG" di ZCode (file markdown passivi) può essere un'opzione anche per
  Homun in alcune modalità (es. `ask`/`debug` dove la recall non serve)?
- Vale la pena un **tiered memory**: recall veloce/cheap per il briefing sempre-on (come
  fa ZCode con skills) + recall RAG completo solo on-demand via tool `recall_memory`?
- L'estrazione del monolite (punto 5 sopra) è il pre-requisito per tutti gli altri
  interventi di profilazione/ottimizzazione — vale la pena prioritarlo?
- **Migrare il rendering chat da marker-inline a parts strutturate** (§1.1)? Il gateway
  emetterebbe eventi tipizzati (`{type:"thought"}`, `{type:"tool-call", toolId}`,
  `{type:"elicitation", schema}`) invece di marker nel testo, eliminando il parsing regex
  e la fragilità dello streaming. È un refactor di medio respiro ma semplifica ogni
  futuro tipo di contenuto.

---

## Fonti / riferimenti

**ZCode** (bundle estratto in `/tmp/zc_full/out/`):
- `package.json` (`@zcode/desktop`), `out/metadata/build-meta.json` (v3.2.1, `3d011a8c`).
- `host/index.js`: ACP client, `zcode-agent`/`session-service`/`task-service`,
  `AgentService`, MCP config, `settings-sync` (tabelle `J_`/`X_`/`Y_`/`Q_`), `repo-wiki`,
  SQLite `tasks-index.sqlite` via `node:sqlite`.
- `main/index.js`: finestre, IPC `zcode:*`, lifecycle, OAuth, update.
- `renderer/assets/`: React UI (Monaco/xterm), label feature (`AgentExperience`,
  `CodingPlanUsage`, `ClaudeAgentsFileMigrationStatus`, …).
- Catena di risoluzione agente: `findZCodeAgentRuntimeBinary`, `bundled-agents/<arch>/`,
  `app-server --stdio`.

**Codex** (bundle estratto in `/tmp/codex_full/` + binari nativi):
- `package.json` (`openai-codex-electron`, v26.623.81905; Electron 42 + Vite; deps
  `better-sqlite3`, `node-pty`, `capnweb`, `browser-api`, `objc-js`,
  `app-server-types`/`commands`/`protocol`/`shared-node` workspace).
- Binario motore: `Resources/codex` (249MB, Rust; tokio/serde/hyper/sqlx/clap/starlark;
  JSON-RPC 2.0 su Unix socket; vocabolario `thread/*`/`turn/*`/`config/*`; OpenAI Responses
  API `/v1/responses`, modelli gpt-5.2-codex; tool built-in shell/apply_patch/update_plan/
  web_search/view_image/unified_exec + MCP come sorgente).
- Daemon memoria: `Resources/codex_chronicle` (Rust; registra schermo → memory markdown
  in chunk 10min/6h, con `screen/privacy_filter.rs`).
- Computer-use: `Resources/cua_node/` (Node v24 + Playwright/CDP, `@oai/sky`).
- JS host: `/tmp/codex_full/.vite/build/{bootstrap.js,main-CNod9zFW.js,worker.js,
  src-CoIhwwHr.js,preload.js}` — app-server client/transport/spawn, capnweb (Cap'n Proto
  RPC, messaggi Bootstrap/Resolve/Finish), `thread-follower-*` RPC, `codex/event/*`.
- UI: `/tmp/codex_full/webview/` (Preact + signals, CodeMirror 6, Shiki, KaTeX; item
  tipizzati ~30 tipi; approval via `permission-request`/`mcp-server-elicitation`/`proposed-plan`).
- Skills: `/tmp/codex_full/skills/skills/.curated/` (SKILL.md, `agents/openai.yaml`).

**Homun** (`/Users/fabio/Projects/Homun/app`):
- Memoria: `crates/memory/src/{types.rs,facade.rs,store.rs,search.rs,graph.rs,wiki.rs,
  lifecycle.rs,policy.rs,redaction.rs}`, `crates/context-compression/src/lib.rs`,
  `crates/vault/`.
- Orchestratore monolitico: `crates/desktop-gateway/src/main.rs` (~56k righe) — recall
  `relevant_memory_for_prompt:13041`, `hybrid_memory_score:13021`, `gather_*`,
  `learn_from_exchange:5633`, `consolidate_scope:4808`, `backfill_embeddings:2940`,
  `lock_memory_facade:45755`, prompt assembly `19028-19094`.
- Chat: `crates/desktop-gateway/src/{lib.rs,chat_store.rs}`.
- Agenti: `crates/orchestrator/`, `crates/subagents/`, `crates/skill-runtime/`,
  `crates/inference/`, `crates/desktop-gateway/src/{model_registry.rs,scaffold.rs}`.
- Tool/capability: `crates/capabilities/`, `crates/browser-automation/`,
  `crates/process-manager/`, `crates/local-computer-session/`.
- **Frontend rendering chat**: `apps/desktop/src/components/RichMessage.tsx` (parsing
  marker inline: `REASONING_MARKER_RE`, `THINK_RE`, `extractReasoning`),
  `apps/desktop/src/lib/chatApi.ts` (eventi stream `delta`/`done`).
- Docs di riferimento: `docs/architecture/{memory.md,agent-loop.md,capability-registry.md,
  model-io.md,browser.md}`, `docs/{STATO.md,MEMORIA.md,memory-architecture.md,
  memory-vision.md}`.
