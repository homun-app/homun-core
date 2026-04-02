# Agent Architecture v2 — Blueprint

> **Status**: Spec fondante. Ogni componente descritto qui diventa implementabile.
> **Autore**: Design session 2026-04-02
> **Input**: `AGENT-REDESIGN-CONTEXT.md`, `PROJECT.md`, feature docs, log reali di fallimento.
> **Principio guida**: Il sistema fornisce struttura, il modello fornisce intelligenza. Meno codice di controllo, piu contesto pulito. (Vedi §16 per la filosofia completa.)

---

## Indice

**Core Architecture (1-10):**
1. [Flusso End-to-End](#1-flusso-end-to-end)
2. [Cognition Prescrittiva](#2-cognition-prescrittiva)
3. [Tool Dispatch (System-Controlled)](#3-tool-dispatch-system-controlled)
4. [Data Accumulation](#4-data-accumulation)
5. [Browser Scope](#5-browser-scope)
6. [Micro-Task Execution](#6-micro-task-execution)
7. [Profili, Memoria, Contatti](#7-profili-memoria-contatti)
8. [MCP e Skills](#8-mcp-e-skills)
9. [Persistence e Crash Recovery](#9-persistence-e-crash-recovery)
10. [Comunicazione con l'Utente](#10-comunicazione-con-lutente)

**Real-World Scenarios (11-15):**
11. [Autonomy Modes e Plan Approval](#11-autonomy-modes-e-plan-approval)
12. [Task a Lunga Durata (Ore/Giorni)](#12-task-a-lunga-durata-oregiorni)
13. [Verifica del Completamento](#13-verifica-del-completamento)
14. [Pause/Resume Lifecycle](#14-pauseresume-lifecycle)
15. [Concorrenza e Messaggi Durante l'Esecuzione](#15-concorrenza-e-messaggi-durante-lesecuzione)

**Filosofia e Problemi Aperti:**
16. [Filosofia di Design e Problemi Aperti](#16-filosofia-di-design-e-problemi-aperti)
17. [Reality Check: Come Funzionano i Sistemi che Funzionano](#17-reality-check-come-funzionano-i-sistemi-che-funzionano)

**Appendici:**
- [A: Migrazione da v1 a v2](#appendice-a-migrazione-da-v1-a-v2)
- [B: Backward Compatibility](#appendice-b-backward-compatibility)
- [C: Metriche di Successo](#appendice-c-metriche-di-successo)
- [D: Sequenza di Implementazione](#appendice-d-sequenza-di-implementazione)
- [E: Scenari Edge Case Estremi](#appendice-e-scenari-edge-case-estremi)

---

## 1. Flusso End-to-End

### COSA

Un task utente attraversa 6 fasi sequenziali. Ogni fase ha un contratto di input/output esplicito. Non ci sono scorciatoie: anche un "ciao" attraversa tutte le fasi (la cognition puo rispondere direttamente, ma la pipeline e la stessa).

### PERCHE

Il sistema attuale (v1) ha un unico ReAct loop dove il modello decide tutto: quale tool usare, quando fermarsi, come accumulare dati. Questo produce:
- Tool selection errata (browser per Google search)
- Nessuna accumulazione dati (tutto nel contesto LLM)
- Loop infiniti (il modello clicca lo stesso elemento 6x)
- write_file con 10KB nei tool args (troncamento)

### COME

```
Messaggio Utente
       |
       v
┌─────────────────────────────────────────────┐
│  FASE 1: INGRESS                            │
│  - Debounce, allegati, selezione modello    │
│  - Risolvi contatto, profilo, canale        │
│  - Output: IngressContext                   │
└──────────────────┬──────────────────────────┘
                   v
┌─────────────────────────────────────────────┐
│  FASE 2: COGNITION (prescriptive planner)   │
│  - Analizza intent con mini LLM call        │
│  - Produce ExecutionPlan con step tipizzati  │
│  - Ogni step specifica: tool, parametri,    │
│    expected output, data_schema             │
│  - Output: TaskPlan                         │
│  - Fast-path: answer_directly               │
└──────────────────┬──────────────────────────┘
                   v
┌─────────────────────────────────────────────┐
│  FASE 3: TOOL DISPATCH (per step)           │
│  - Il SISTEMA seleziona il tool, non il LLM │
│  - Criteri deterministici: SearchPolicy,    │
│    FetchPolicy, BrowserPolicy               │
│  - Output: ToolAssignment per step          │
└──────────────────┬──────────────────────────┘
                   v
┌─────────────────────────────────────────────┐
│  FASE 4: MICRO-TASK EXECUTION (loop)        │
│  - Per ogni step del piano:                 │
│    1. Inietta SOLO il contesto dello step   │
│    2. Il modello esegue UN micro-task       │
│    3. Output → DataBuffer (non nel contesto)│
│    4. Sistema valuta completamento          │
│  - Output: dati accumulati nel DataBuffer   │
└──────────────────┬──────────────────────────┘
                   v
┌─────────────────────────────────────────────┐
│  FASE 5: SYNTHESIS                          │
│  - Assembla risposta finale dal DataBuffer  │
│  - Se richiesto file: scrive da buffer      │
│  - Se richiesto testo: LLM sintetizza       │
│  - Output: risposta utente + artefatti      │
└──────────────────┬──────────────────────────┘
                   v
┌─────────────────────────────────────────────┐
│  FASE 6: POST-PROCESSING                   │
│  - Consolidamento memoria                   │
│  - Token tracking                           │
│  - Cleanup checkpoint                       │
│  - Comunicazione risultato all'utente       │
└─────────────────────────────────────────────┘
```

### Strutture Dati

```rust
/// Contesto preparato dalla fase INGRESS
struct IngressContext {
    user_message: String,
    attachments: Vec<Attachment>,
    session_key: String,
    channel: String,
    chat_id: String,
    contact: Option<Contact>,
    profile: Option<ProfileSlug>,
    agent_id: String,
    model: String,
    history_tail: Vec<ChatMessage>,  // ultimi N messaggi
}

/// Piano prodotto dalla COGNITION
struct TaskPlan {
    id: Uuid,
    understanding: String,
    complexity: TaskComplexity,
    steps: Vec<PlanStep>,
    success_criteria: String,
    data_schema: Option<DataSchema>,  // schema dati da raccogliere
    intent_type: IntentType,
}

enum TaskComplexity {
    /// Risposta diretta senza tool
    Direct { answer: String },
    /// 1-2 step semplici (lookup, fetch)
    Simple,
    /// Multi-step con raccolta dati strutturata
    Complex,
}
```

---

## 2. Cognition Prescrittiva

### COSA

La cognition non suggerisce — **prescrive**. Produce un piano dove ogni step specifica:
- Quale **tipo di azione** (search, fetch, browse, compute, write)
- Quale **target** (URL, query, file path)
- Quale **dato** ci si aspetta in output
- Quale **schema** per i dati raccolti (se applicabile)

### PERCHE

La cognition v1 produce un piano suggestivo:
```json
{ "plan": ["Search for Diesel stores", "Extract addresses", "Create CSV"] }
```
Il modello interpreta "Search" come "apro Google nel browser" invece di usare `web_search`. Il piano non specifica COME cercare, CON QUALE TOOL, e DOVE mettere i risultati.

Il modello che clicca `e26` 6 volte su Google dimostra che un piano vago viene interpretato vagamente.

### COME

```rust
/// Uno step del piano prescrittivo
struct PlanStep {
    id: u16,
    /// Descrizione human-readable dello step
    description: String,
    /// Tipo di azione — determina il tool dispatch
    action: StepAction,
    /// Dato atteso in output (per validazione)
    expected_output: ExpectedOutput,
    /// Dipendenze da step precedenti
    depends_on: Vec<u16>,
    /// Status runtime
    status: StepStatus,
}

/// Azioni tipizzate — il sistema sa ESATTAMENTE cosa fare
enum StepAction {
    /// Ricerca web via API (Brave/Tavily) — MAI browser
    WebSearch {
        query: String,
        /// Quanti risultati servono
        max_results: u8,
    },
    /// Fetch di una pagina statica — estrai testo
    WebFetch {
        url: String,
        /// Cosa estrarre dalla pagina
        extract: ExtractionHint,
    },
    /// Browser SOLO per siti interattivi
    BrowseInteractive {
        url: String,
        /// Piano di interazione ad alto livello
        interaction_goal: String,
        /// Criterio di completamento
        done_when: String,
    },
    /// Computazione locale (shell, script, calcolo)
    Compute {
        description: String,
        tool: String,  // shell, skill, etc.
    },
    /// Scrivi file dal DataBuffer accumulato
    WriteOutput {
        path: String,
        format: OutputFormat,
    },
    /// Chiedi conferma all'utente
    AskUser {
        question: String,
        options: Vec<String>,
    },
    /// Invia messaggio a un contatto
    SendMessage {
        target: MessageTarget,
        content_from: ContentSource,
    },
    /// Usa un tool MCP specifico
    McpToolCall {
        server: String,
        tool: String,
        args_template: serde_json::Value,
    },
    /// Attiva una skill
    ActivateSkill {
        skill_name: String,
        query: String,
    },
}

enum ExtractionHint {
    /// Tutto il testo della pagina
    FullText,
    /// Elementi specifici (CSS selector o descrizione)
    Structured { description: String },
    /// Tabella (indice o descrizione)
    Table { description: String },
}

enum OutputFormat {
    Csv,
    Json,
    Markdown,
    PlainText,
}

enum ExpectedOutput {
    /// Lista di record strutturati
    DataRecords { min_count: Option<u32> },
    /// Testo libero
    Text,
    /// File scritto
    FileWritten { path: String },
    /// Conferma/risposta utente
    UserResponse,
    /// Nessun output (side-effect)
    None,
}

enum StepStatus {
    Pending,
    Running,
    Completed { records_collected: u32 },
    Failed { reason: String },
    Skipped { reason: String },
}
```

### Prompt Cognition v2

Il prompt di cognizione riceve:
1. Il messaggio utente
2. La lista di capacita disponibili (tool names + MCP + skills)
3. Il contesto contatto/profilo (per scoping)
4. Gli ultimi 10 messaggi di storia

E deve produrre un `TaskPlan` con step tipizzati. Esempio di output per "trova tutti i negozi Diesel in Italia e crea un CSV":

```json
{
  "understanding": "L'utente vuole una lista di negozi Diesel in Italia con indirizzi, in formato CSV",
  "complexity": "complex",
  "intent_type": "transactional",
  "success_criteria": "File CSV con almeno 20 negozi, colonne: nome, citta, indirizzo, telefono",
  "data_schema": {
    "columns": ["nome", "citta", "indirizzo", "cap", "telefono"],
    "entity": "negozio Diesel"
  },
  "steps": [
    {
      "id": 1,
      "description": "Cerca lo store locator ufficiale Diesel",
      "action": { "web_search": { "query": "Diesel store locator Italy site:diesel.com", "max_results": 5 } },
      "expected_output": { "text": null }
    },
    {
      "id": 2,
      "description": "Cerca negozi Diesel tramite directory",
      "action": { "web_search": { "query": "negozi Diesel Italia elenco indirizzi", "max_results": 10 } },
      "expected_output": { "data_records": { "min_count": 10 } }
    },
    {
      "id": 3,
      "description": "Naviga lo store locator Diesel (sito interattivo con mappa)",
      "action": { "browse_interactive": {
        "url": "https://www.diesel.com/store-locator",
        "interaction_goal": "Seleziona Italia, scorri tutte le citta, estrai nome e indirizzo di ogni negozio",
        "done_when": "Tutti i negozi visibili sono stati estratti"
      }},
      "expected_output": { "data_records": { "min_count": 20 } },
      "depends_on": [1]
    },
    {
      "id": 4,
      "description": "Scrivi il CSV con tutti i dati raccolti",
      "action": { "write_output": { "path": "negozi_diesel_italia.csv", "format": "csv" } },
      "expected_output": { "file_written": { "path": "negozi_diesel_italia.csv" } },
      "depends_on": [2, 3]
    }
  ]
}
```

### Fast-Path (Direct Answer)

Se la cognition determina che la risposta e diretta (saluto, domanda fattuale, chiacchierata), produce:

```json
{
  "complexity": { "direct": { "answer": "Ciao! Come posso aiutarti?" } },
  "steps": []
}
```

Il sistema bypassa tutte le fasi successive e restituisce direttamente.

---

## 3. Tool Dispatch (System-Controlled)

### COSA

Il sistema, non il modello, decide quale tool usare per ogni step. La decisione e **deterministica** basata sul tipo di `StepAction`. Il modello non vede mai la lista completa dei tool — vede solo il tool assegnato allo step corrente.

### PERCHE

Evidenza dai log: il modello sceglie `browser` per fare una ricerca Google (doveva usare `web_search`). Poi usa `evaluate()` su ogni sito (sempre fallisce). Poi riscrive l'intero CSV nei tool args (troncamento).

Il modello NON e in grado di fare scelte strategiche tra tool. E un text generator, non un planner.

### COME

```rust
/// Risoluzione deterministica: StepAction → Tool concreto
fn resolve_tool(action: &StepAction, available_tools: &ToolSet) -> ToolAssignment {
    match action {
        StepAction::WebSearch { .. } => {
            // Priorita: MCP brave-search > built-in web_search
            if available_tools.has_mcp("brave-search") {
                ToolAssignment::Mcp("brave-search", "brave_web_search")
            } else {
                ToolAssignment::BuiltIn("web_search")
            }
        }
        StepAction::WebFetch { url, .. } => {
            ToolAssignment::BuiltIn("web_fetch")
        }
        StepAction::BrowseInteractive { .. } => {
            // SOLO qui si usa il browser
            ToolAssignment::BuiltIn("browser")
        }
        StepAction::Compute { tool, .. } => {
            ToolAssignment::BuiltIn(tool)  // shell, read_file, etc.
        }
        StepAction::WriteOutput { .. } => {
            // Il sistema scrive direttamente dal DataBuffer
            // NON chiama il modello — assembla il file
            ToolAssignment::SystemDirect("data_buffer_write")
        }
        StepAction::McpToolCall { server, tool, .. } => {
            ToolAssignment::Mcp(server, tool)
        }
        StepAction::ActivateSkill { skill_name, .. } => {
            ToolAssignment::Skill(skill_name)
        }
        StepAction::AskUser { .. } => {
            ToolAssignment::BuiltIn("approval")
        }
        StepAction::SendMessage { .. } => {
            ToolAssignment::BuiltIn("send_message")
        }
    }
}

enum ToolAssignment {
    /// Tool built-in di Homun
    BuiltIn(&'static str),
    /// Tool da MCP server
    Mcp(String, String),
    /// Skill attivata
    Skill(String),
    /// Il sistema esegue direttamente (nessun LLM coinvolto)
    SystemDirect(&'static str),
}
```

### Regole di Dispatch (Decision Tree)

```
L'utente vuole CERCARE informazioni?
├── Si → web_search (API strutturata, 0 browser)
│        Output: lista risultati JSON
│
L'utente vuole LEGGERE una pagina web specifica?
├── Si → web_fetch (HTTP GET + extract testo)
│        Output: testo estratto
│
L'utente vuole INTERAGIRE con un sito (form, mappa, SPA)?
├── Si → browser (Playwright MCP)
│        Output: dati estratti da interazione
│
L'utente vuole SCRIVERE un file con dati raccolti?
├── Si → SystemDirect (il sistema scrive dal DataBuffer)
│        Output: file scritto, NESSUN LLM coinvolto
│
L'utente vuole USARE un servizio esterno?
├── Si → MCP tool call
│        Output: risposta dal servizio
│
L'utente vuole ESEGUIRE codice/comandi?
├── Si → shell / skill executor
│        Output: stdout/stderr
```

### Cosa Cambia Rispetto a v1

| Aspetto | v1 (attuale) | v2 (nuovo) |
|---------|-------------|------------|
| Chi sceglie il tool | Il modello (via function calling) | Il sistema (deterministico) |
| Quanti tool vede il modello | 7-20+ per iterazione | 1-2 per step |
| web_search vs browser | Il modello decide (male) | Il sistema decide (regole chiare) |
| write_file | Il modello genera il CSV nei tool args | Il sistema scrive dal DataBuffer |
| evaluate() | Il modello la prova ovunque (sempre fallisce) | Mai disponibile come tool per il modello |

---

## 4. Data Accumulation

### COSA

I dati raccolti durante l'esecuzione vengono accumulati in un **DataBuffer** strutturato che vive in memoria Rust, FUORI dal contesto LLM. Il modello non deve mai generare un CSV da 10KB nei tool args.

### PERCHE

Nel sistema v1:
- I dati raccolti (nomi negozi, indirizzi) esistono SOLO nella message history del LLM
- Quando il contesto viene compattato, i dati vengono persi
- `write_file` riceve l'intero CSV come argomento del tool call → troncamento a ~6KB
- Il modello RISCRIVE il file intero ad ogni iterazione (non appende)

I log mostrano:
```
Tool call arguments JSON parse failed — content truncated
  tool=write_file raw_len=6617
```

### COME

```rust
/// Buffer strutturato per accumulazione dati
struct DataBuffer {
    /// Identificatore del task
    task_id: Uuid,
    /// Schema dei dati (colonne/campi attesi)
    schema: Option<DataSchema>,
    /// Record accumulati (append-only)
    records: Vec<DataRecord>,
    /// Testi/note non strutturati
    notes: Vec<String>,
    /// File gia creati
    artifacts: Vec<Artifact>,
    /// Metadati di provenienza
    sources: Vec<DataSource>,
}

struct DataSchema {
    columns: Vec<String>,
    entity_name: String,
}

/// Un record strutturato (riga di dati)
struct DataRecord {
    /// Valori per colonna (ordine = schema.columns)
    values: HashMap<String, String>,
    /// Da dove proviene questo record
    source: DataSource,
    /// Timestamp di inserimento
    collected_at: chrono::DateTime<Utc>,
}

struct DataSource {
    step_id: u16,
    tool: String,
    url: Option<String>,
}

struct Artifact {
    path: String,
    format: OutputFormat,
    size_bytes: u64,
}
```

### Flusso di Accumulazione

```
Step 1: web_search "negozi Diesel Italia"
  │
  ├── Tool result: JSON con 10 risultati
  │
  ├── Sistema estrae record dal JSON:
  │   { "nome": "Diesel Torino", "citta": "Torino", "indirizzo": "Via Roma 1" }
  │   { "nome": "Diesel Milano", "citta": "Milano", "indirizzo": "Corso Buenos Aires 5" }
  │   ...
  │
  └── DataBuffer.records += 10 nuovi record
      DataBuffer.sources += { step: 1, tool: "web_search", url: null }

Step 2: browse_interactive "diesel.com/store-locator"
  │
  ├── Modello naviga lo store locator, estrae dati
  │
  ├── Output: strutturato (il modello restituisce solo i NUOVI dati trovati)
  │   "Trovati 15 negozi: Diesel Roma Via Condotti 12, Diesel Napoli Via Toledo 30, ..."
  │
  ├── Sistema parsa e aggiunge al buffer:
  │   DataBuffer.records += 15 nuovi record
  │   (deduplicazione automatica per nome+citta)
  │
  └── DataBuffer.sources += { step: 2, tool: "browser", url: "diesel.com/store-locator" }

Step 3: write_output "negozi_diesel.csv"
  │
  ├── Il SISTEMA (non il modello) assembla il CSV:
  │   1. Legge DataBuffer.schema.columns → header
  │   2. Itera DataBuffer.records → righe
  │   3. Scrive file direttamente (std::fs::write)
  │
  ├── NESSUNA chiamata LLM. NESSUN tool call con 10KB di args.
  │
  └── DataBuffer.artifacts += { path: "negozi_diesel.csv", format: Csv }
```

### Come il Modello Interagisce col Buffer

Il modello NON vede il DataBuffer completo. Vede solo:
1. **Summary**: "Buffer: 25 record raccolti (10 da web_search, 15 da browser). Schema: nome, citta, indirizzo, cap, telefono."
2. **Ultimi N record** (per continuita): gli ultimi 3-5 record aggiunti

Quando il modello trova nuovi dati, li restituisce in un formato strutturato che il sistema parsa e aggiunge al buffer:

```
Il modello restituisce (nel tool result del browser):
"EXTRACTED_DATA:
nome=Diesel Roma|citta=Roma|indirizzo=Via Condotti 12|cap=00187
nome=Diesel Napoli|citta=Napoli|indirizzo=Via Toledo 30|cap=80100"
```

Il sistema parsa queste righe e le aggiunge al DataBuffer. Il modello non deve mai ricostruire l'intero dataset.

### Operazioni sul Buffer

```rust
impl DataBuffer {
    /// Aggiunge record (con deduplicazione)
    fn append_records(&mut self, records: Vec<DataRecord>) -> u32;

    /// Deduplicazione per chiave primaria (primi 2 campi dello schema)
    fn deduplicate(&mut self);

    /// Genera summary per il contesto LLM (max ~200 token)
    fn summary(&self) -> String;

    /// Esporta in formato richiesto
    fn export(&self, format: OutputFormat) -> Vec<u8>;

    /// Merge buffer da subagent
    fn merge(&mut self, other: DataBuffer);

    /// Serializza per persistenza (crash recovery)
    fn to_checkpoint(&self) -> serde_json::Value;
    fn from_checkpoint(json: serde_json::Value) -> Self;
}
```

---

## 5. Browser Scope

### COSA

Il browser si usa SOLO quando un sito richiede interazione: form submission, mappa interattiva, SPA con rendering client-side, CAPTCHA. Mai per cercare su Google. Mai per leggere una pagina statica.

### PERCHE

I log mostrano il modello che:
1. Naviga su Google nel browser → clicca risultati → clicca lo stesso elemento 6x
2. Usa `evaluate()` su ogni sito → sempre fallisce ("not well-serializable")
3. Non distingue tra "cerco informazioni" e "interagisco con un sito"

Il costo di un'azione browser e ~2-5 secondi (MCP roundtrip + rendering). Il costo di `web_search` e ~200ms. Usare il browser per cercare e 10-25x piu lento e produce risultati peggiori.

### COME

#### Decision Matrix: Quale Tool per Quale Sito

```
                    ┌─────────────────────────┐
                    │   Ho bisogno di         │
                    │   CERCARE informazioni? │
                    └────────┬────────────────┘
                             │
                    Si ──────┼────── No
                    │                │
                    v                v
            ┌───────────┐    ┌──────────────────┐
            │ web_search │    │ Ho un URL        │
            │ (Brave API)│    │ specifico?       │
            └───────────┘    └───────┬──────────┘
                                     │
                            Si ──────┼────── No
                            │                │
                            v                v
                    ┌──────────────┐   (errore: step
                    │ Il sito      │    mal definito)
                    │ richiede     │
                    │ interazione? │
                    └──────┬──────┘
                           │
                  Si ──────┼────── No
                  │                │
                  v                v
          ┌──────────────┐  ┌──────────┐
          │  browser     │  │ web_fetch │
          │  (Playwright)│  │ (HTTP GET)│
          └──────────────┘  └──────────┘
```

#### Definizione di "Sito Interattivo"

Un sito e interattivo quando soddisfa almeno UNO di questi criteri:

| Criterio | Esempio | Tool |
|----------|---------|------|
| Form con input multipli | Login, registrazione, filtri | browser |
| Mappa con click/zoom | Store locator, Google Maps | browser |
| SPA con rendering JS | React/Angular app che non ha HTML statico | browser |
| CAPTCHA | Qualsiasi forma di verifica umana | browser |
| Autenticazione richiesta | Siti dietro login (cookie session) | browser |
| Paginazione AJAX | Liste che caricano al scroll/click | browser |
| Dropdown/autocomplete | Selettori dinamici con ricerca | browser |

Un sito NON e interattivo quando:
- Ha HTML statico leggibile (articoli, blog, wiki) → `web_fetch`
- E un motore di ricerca (Google, Bing, DuckDuckGo) → `web_search` API
- Ha una API pubblica → `web_fetch` o MCP

#### Browser: Restrizioni di Sicurezza

```rust
/// Azioni BLOCCATE quando il browser e su un motore di ricerca
const SEARCH_ENGINE_DOMAINS: &[&str] = &[
    "google.com", "google.it", "bing.com", "duckduckgo.com",
    "yahoo.com", "yandex.com", "baidu.com",
];

fn is_search_engine(url: &str) -> bool {
    SEARCH_ENGINE_DOMAINS.iter().any(|d| url.contains(d))
}

/// Il browser RIFIUTA la navigazione verso motori di ricerca
fn validate_browser_navigation(url: &str) -> Result<()> {
    if is_search_engine(url) {
        bail!("Non usare il browser per motori di ricerca. \
               Usa web_search per cercare informazioni.")
    }
    Ok(())
}
```

#### Browser: Tool Set Ridotto

Quando il modello entra in uno step `BrowseInteractive`, riceve SOLO:
- `browser` (con le 21 azioni)
- `send_message` (per comunicare all'utente)
- `approval` (per chiedere conferma)

NON riceve: `web_search`, `web_fetch`, `shell`, `write_file`, `read_file`.

Questo impedisce che il modello "evada" dal browser verso tool inappropriati durante l'interazione.

#### evaluate() — Rimozione

L'azione `evaluate()` viene **rimossa** dal set di azioni browser disponibili per il modello. I log mostrano che:
- Il modello la prova su ogni sito
- Fallisce sempre ("Passed function is not well-serializable")
- Non produce mai valore

Se serve eseguire JS per scraping, il sistema lo fa internamente (non via tool call del modello).

---

## 6. Micro-Task Execution

### COSA

Il modello non esegue un piano completo in un lungo ReAct loop. Esegue UN micro-task alla volta, ricevendo SOLO il contesto necessario per quello step. Tra uno step e l'altro, il sistema valuta il progresso e decide come procedere.

### PERCHE

Nel ReAct loop v1, il modello riceve:
- System prompt (~5K token)
- Storia conversazione (~10-50K token)
- Tutti i tool result precedenti (~20-80K token)
- Tutti i tool disponibili (7-20 definizioni)

Con 90K+ di contesto, il modello:
- Ignora le cycle hints ("stai ripetendo") perche sono rumore in un contesto enorme
- Non impara dalle iterazioni precedenti (non e un sistema con stato)
- Si confonde tra dati vecchi e nuovi

### COME

#### Loop di Esecuzione per Step

```rust
/// Esegue il TaskPlan step by step
async fn execute_plan(
    plan: &mut TaskPlan,
    data_buffer: &mut DataBuffer,
    ctx: &ExecutionContext,
) -> Result<ExecutionResult> {
    for step in plan.steps.iter_mut() {
        if step.status != StepStatus::Pending { continue; }
        // Check dipendenze soddisfatte
        if !dependencies_met(step, &plan.steps) { continue; }

        step.status = StepStatus::Running;
        emit_status(ctx, &step);  // "Step 2/4: Cercando negozi..."

        // 1. Risolvi tool per questo step
        let tool_assignment = resolve_tool(&step.action, &ctx.available_tools);

        // 2. Se e SystemDirect, il sistema esegue senza LLM
        if let ToolAssignment::SystemDirect(action) = &tool_assignment {
            execute_system_direct(action, data_buffer, step)?;
            step.status = StepStatus::Completed { records_collected: 0 };
            continue;
        }

        // 3. Altrimenti, prepara il micro-context per il modello
        let micro_context = build_micro_context(step, data_buffer, ctx);

        // 4. Esegui il micro-task con budget limitato
        let result = execute_micro_task(
            &micro_context,
            &tool_assignment,
            step,
            data_buffer,
            ctx,
        ).await?;

        // 5. Valuta risultato
        match result {
            MicroTaskResult::Success { new_records } => {
                data_buffer.append_records(new_records);
                step.status = StepStatus::Completed {
                    records_collected: new_records.len() as u32,
                };
            }
            MicroTaskResult::NeedsRetry { reason } => {
                // Retry con strategia diversa (max 2 retry)
                step.retry_count += 1;
                if step.retry_count > 2 {
                    step.status = StepStatus::Failed { reason };
                }
            }
            MicroTaskResult::Skip { reason } => {
                step.status = StepStatus::Skipped { reason };
            }
        }

        // 6. Persist checkpoint
        persist_checkpoint(plan, data_buffer, ctx).await?;
    }

    Ok(ExecutionResult { plan, data_buffer })
}
```

#### Micro-Context: Cosa Vede il Modello

Per ogni step, il modello riceve un contesto FRESCO e MINIMALE:

```rust
fn build_micro_context(
    step: &PlanStep,
    data_buffer: &DataBuffer,
    ctx: &ExecutionContext,
) -> MicroContext {
    MicroContext {
        // System prompt ridotto (identita + step corrente)
        system: format!(
            "{identity}\n\n\
             ## Current Task\n\
             {step_description}\n\n\
             ## Data Collected So Far\n\
             {buffer_summary}\n\n\
             ## Instructions\n\
             {step_instructions}",
            identity = ctx.identity_prompt,          // ~500 token
            step_description = step.description,     // ~50 token
            buffer_summary = data_buffer.summary(),  // ~200 token
            step_instructions = step_instructions(step), // ~200 token
        ),
        // SOLO il tool assegnato a questo step
        tools: vec![step.tool_definition.clone()],
        // Nessuna storia precedente (contesto pulito)
        history: vec![],
        // Budget micro: 3-8 iterazioni (non 20-110)
        max_iterations: micro_budget(step),
    }
}

fn micro_budget(step: &PlanStep) -> u8 {
    match &step.action {
        StepAction::WebSearch { .. } => 2,   // 1 search + 1 review
        StepAction::WebFetch { .. } => 2,    // 1 fetch + 1 extract
        StepAction::BrowseInteractive { .. } => 12, // navigazione complessa
        StepAction::Compute { .. } => 4,     // esecuzione + retry
        _ => 3,
    }
}
```

#### Confronto Contesto v1 vs v2

| Aspetto | v1 | v2 |
|---------|----|----|
| System prompt | ~5K token (tutto) | ~1K token (solo step corrente) |
| Storia | Tutta la conversazione | Nessuna (contesto fresco) |
| Tool result precedenti | Tutti (accumulati) | Solo buffer summary (~200 token) |
| Tool disponibili | 7-20 | 1-2 |
| Budget iterazioni | 20-110 | 2-12 per step |
| Contesto totale | 30-90K token | 2-5K token |

#### Quando il Micro-Task Fallisce

Se un micro-task fallisce (budget esaurito, errore tool, nessun dato trovato):

1. **Retry con strategia diversa** (max 2): il sistema riformula la query o cambia approccio
2. **Skip**: lo step viene marcato come `Skipped` e si passa al successivo
3. **Replan**: se piu di meta degli step falliscono, il sistema torna alla COGNITION per un nuovo piano

```rust
/// Strategia di retry per step falliti
fn retry_strategy(step: &PlanStep, attempt: u8) -> RetryAction {
    match (&step.action, attempt) {
        (StepAction::WebSearch { query, .. }, 1) => {
            // Riformula la query
            RetryAction::Rephrase(rephrase_query(query))
        }
        (StepAction::WebFetch { url, .. }, 1) => {
            // Prova con il browser (il sito potrebbe essere JS-only)
            RetryAction::EscalateToBrowser(url.clone())
        }
        (StepAction::BrowseInteractive { .. }, 1) => {
            // Semplifica il goal
            RetryAction::SimplifyGoal
        }
        (_, 2) => RetryAction::Skip,
        _ => RetryAction::Skip,
    }
}
```

---

## 7. Profili, Memoria, Contatti

### COSA

Il sistema v2 integra profili, contatti e memoria senza rotture rispetto ai contratti esistenti. Ogni fase del pipeline ha accesso ai dati necessari per lo scoping.

### PERCHE

I contratti esistenti (contatti con perimetro, profili con skill dedicate, memoria con scoping per contact_id e agent_id) sono maturi e funzionanti. Il redesign dell'agent loop non deve romperli — deve integrarli meglio.

### COME

#### Mappa di Integrazione

```
┌─────────────────────────────────────────────────────┐
│ IngressContext                                       │
│  ├── contact: Contact (da identity resolution)      │
│  │    ├── perimeter: ContactPerimeter               │
│  │    │    ├── allowed_namespaces                    │
│  │    │    ├── allowed_tools / denied_tools          │
│  │    │    └── memory_scope (contact_only/global)    │
│  │    ├── tone_of_voice                             │
│  │    └── preferred_channel                         │
│  ├── profile: ProfileSlug                           │
│  │    ├── profile_skills (scoped)                   │
│  │    └── profile_memory (scoped)                   │
│  └── agent_id: String (da registry routing)         │
└────────────────────┬────────────────────────────────┘
                     │
                     v
┌─────────────────────────────────────────────────────┐
│ COGNITION                                            │
│  Input:                                              │
│  - contact.perimeter → filtra tool/skill disponibili │
│  - profile → filtra skill per profilo                │
│  - agent_id → filtra tool per agent definition       │
│  Output:                                             │
│  - TaskPlan (rispetta filtri di perimetro)            │
│  - Solo tool/skill consentiti appaiono negli step    │
└────────────────────┬────────────────────────────────┘
                     │
                     v
┌─────────────────────────────────────────────────────┐
│ MICRO-TASK EXECUTION                                 │
│  Per ogni step:                                      │
│  - Memory search: search_scoped(contact_id, agent_id)│
│  - RAG search: filtrato per allowed_namespaces       │
│  - Tool context: include contact, profile, tone      │
│  - System prompt: include contact context injection   │
└────────────────────┬────────────────────────────────┘
                     │
                     v
┌─────────────────────────────────────────────────────┐
│ POST-PROCESSING                                      │
│  - Memory consolidation: con contact_id e agent_id   │
│  - Memory chunks: tagged con source step_id          │
│  - Importance scoring: 1-5 dal LLM                   │
└─────────────────────────────────────────────────────┘
```

#### Memory nel Micro-Context

Ogni micro-task riceve SOLO le memorie rilevanti per lo step corrente:

```rust
fn inject_memory_for_step(
    step: &PlanStep,
    contact_id: Option<i64>,
    agent_id: &str,
    memory_searcher: &MemorySearcher,
) -> String {
    // Query di ricerca = step.description (non il messaggio originale)
    let results = memory_searcher.search_scoped(
        &step.description,
        contact_id,
        Some(agent_id),
        5,  // max 5 memorie per step
    );
    format_memory_results(results)
}
```

#### Contact Perimeter Enforcement

Il perimetro viene applicato a **due livelli**:

1. **Cognition time**: il piano non puo includere step con tool negati
2. **Execution time**: safety check prima di ogni tool call

```rust
fn enforce_perimeter(
    step: &PlanStep,
    perimeter: &ContactPerimeter,
) -> Result<()> {
    let tool_name = step.tool_assignment.tool_name();

    // Check denied tools
    if perimeter.denied_tools.contains(&tool_name) {
        bail!("Tool '{}' negato dal perimetro del contatto", tool_name);
    }

    // Check allowed tools (se non vuoto, e una allowlist)
    if !perimeter.allowed_tools.is_empty()
        && !perimeter.allowed_tools.contains(&tool_name)
    {
        bail!("Tool '{}' non nella allowlist del contatto", tool_name);
    }

    // Check namespace per knowledge
    if let StepAction::Compute { tool, .. } = &step.action {
        if tool == "knowledge" {
            // Filtra namespaces consentiti
        }
    }

    Ok(())
}
```

---

## 8. MCP e Skills

### COSA

MCP server e skills si inseriscono nel sistema di tool dispatch come "provider di capacita". La cognition li conosce, il dispatch li risolve, l'esecuzione li chiama.

### PERCHE

MCP e skills sono estensioni fondamentali di Homun. Il redesign non puo trattarli come cittadini di seconda classe. Devono essere nativamente integrati nel flusso prescrittivo.

### COME

#### MCP nel Flusso

```
STARTUP
  │
  ├── McpManager.start() → connette tutti i server configurati
  ├── Per ogni server: enumera tool → registra nel ToolRegistry
  └── Tool names: "server__tool_name" (es. "github__search_repositories")

COGNITION
  │
  ├── Riceve lista tool (built-in + MCP + skills)
  ├── Se il piano richiede un MCP tool → StepAction::McpToolCall
  └── Esempio: step che usa github search
      { "action": { "mcp_tool_call": {
          "server": "github",
          "tool": "search_repositories",
          "args_template": { "query": "diesel store locator" }
      }}}

TOOL DISPATCH
  │
  ├── McpToolCall → ToolAssignment::Mcp("github", "search_repositories")
  └── Il sistema chiama direttamente il peer MCP

EXECUTION
  │
  ├── Micro-context include SOLO la definizione del tool MCP assegnato
  ├── Il modello vede: "Hai a disposizione: github__search_repositories"
  └── Output → DataBuffer (come qualsiasi altro step)
```

#### Skills nel Flusso

```
COGNITION
  │
  ├── Riceve lista skill (nomi + descrizioni)
  ├── Se il piano richiede una skill → StepAction::ActivateSkill
  └── Esempio: step che usa skill "market-monitor"
      { "action": { "activate_skill": {
          "skill_name": "market-monitor",
          "query": "crypto prices BTC ETH"
      }}}

TOOL DISPATCH
  │
  ├── ActivateSkill → ToolAssignment::Skill("market-monitor")
  └── Attivazione skill: load body, substitute variables, inject nel context

EXECUTION
  │
  ├── Micro-context include:
  │   - Tool "market-monitor" (la skill come pseudo-tool)
  │   - Il body della skill iniettato nel system prompt
  │   - Se la skill ha script: disponibili come tool aggiuntivi
  └── Output → DataBuffer
```

#### Skill con Script

Le skill con script eseguibili vengono trattate come tool compound:

```rust
/// Quando una skill ha scripts/, il sistema li espone come sub-tool
fn skill_tools_for_step(skill: &Skill) -> Vec<ToolDefinition> {
    let mut tools = vec![];
    for script in skill.list_scripts() {
        tools.push(ToolDefinition {
            name: format!("skill_{}_{}", skill.name, script.stem()),
            description: format!("Run {} script from skill {}", script.name, skill.name),
            parameters: json!({
                "type": "object",
                "properties": {
                    "args": { "type": "array", "items": { "type": "string" } }
                }
            }),
        });
    }
    tools
}
```

#### MCP Token Refresh

Il flusso di token refresh MCP rimane invariato — e un concern infrastrutturale ortogonale all'architettura dell'agent loop:

```
MCP tool call → 401 Unauthorized
  → McpTokenRefreshTool.execute()
  → Refresh token via OAuth
  → Retry tool call
```

---

## 9. Persistence e Crash Recovery

### COSA

Il sistema sopravvive a crash e restart senza perdere lavoro. Lo stato dell'esecuzione (piano, buffer, step corrente) viene persistito su DB a ogni checkpoint.

### PERCHE

Un task complesso (trova 100 negozi) puo richiedere 5-10 minuti. Se il processo crasha al minuto 8, i dati raccolti devono sopravvivere. Il sistema v1 ha `task_checkpoints` ma il resume e rudimentale (prompt testuale). Il sistema v2 persiste dati strutturati.

### COME

#### Schema di Persistenza

```sql
-- Migration: task_state (sostituisce task_checkpoints)
CREATE TABLE IF NOT EXISTS task_state (
    id          TEXT PRIMARY KEY,          -- UUID del task
    session_key TEXT NOT NULL,
    plan_json   TEXT NOT NULL,             -- TaskPlan serializzato
    buffer_json TEXT NOT NULL,             -- DataBuffer serializzato
    status      TEXT NOT NULL DEFAULT 'running',  -- running/paused/completed/failed
    current_step_id INTEGER,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
);

CREATE INDEX idx_task_state_session ON task_state(session_key);
CREATE INDEX idx_task_state_status ON task_state(status);
```

#### Checkpoint Flow

```rust
/// Persist dopo ogni step completato
async fn persist_checkpoint(
    plan: &TaskPlan,
    buffer: &DataBuffer,
    ctx: &ExecutionContext,
) -> Result<()> {
    let plan_json = serde_json::to_string(plan)?;
    let buffer_json = serde_json::to_string(&buffer.to_checkpoint())?;

    ctx.db.upsert_task_state(
        &plan.id.to_string(),
        &ctx.session_key,
        &plan_json,
        &buffer_json,
        "running",
        plan.current_step_id(),
    ).await?;

    Ok(())
}
```

#### Resume Flow

```
Al riavvio del gateway:
  │
  ├── Carica task_state con status = 'running' o 'paused'
  │
  ├── Per ogni task interrotto:
  │   ├── Deserializza TaskPlan e DataBuffer
  │   ├── Identifica lo step corrente
  │   └── Invia ChoiceBlock all'utente (via WebSocket o canale):
  │       "Ho trovato un task interrotto: '{understanding}'
  │        Progresso: {completed}/{total} step, {records} record raccolti
  │        [Riprendi] [Annulla] [Esporta parziale]"
  │
  └── Se l'utente sceglie "Riprendi":
      ├── Ricostruisci ExecutionContext
      ├── Ripristina DataBuffer dallo snapshot
      └── Riparti dallo step interrotto (non dall'inizio)
```

#### Cleanup

```rust
/// Cleanup al gateway startup
async fn cleanup_stale_tasks(db: &Database) -> Result<()> {
    // Task 'running' da piu di 24h → 'failed' (orfani da crash)
    db.expire_stale_tasks(Duration::hours(24)).await?;
    // Task 'completed' o 'failed' da piu di 7 giorni → delete
    db.delete_old_tasks(Duration::days(7)).await?;
    Ok(())
}
```

---

## 10. Comunicazione con l'Utente

### COSA

Il sistema comunica costantemente all'utente cosa sta facendo. Non solo il risultato finale, ma il progresso step-by-step in tempo reale.

### PERCHE

Nel sistema v1, l'utente invia un messaggio e aspetta. Per task complessi (5+ minuti), non sa se il sistema sta lavorando, e bloccato, o in loop. L'unico feedback e il risultato finale (o un timeout). Questo e inaccettabile per un assistant personale.

### COME

#### Stream Events

```rust
/// Eventi di comunicazione verso l'utente
enum UserEvent {
    /// Piano creato — mostra gli step all'utente
    PlanCreated {
        understanding: String,
        steps: Vec<StepSummary>,
        estimated_time: Option<Duration>,
    },
    /// Step iniziato
    StepStarted {
        step_id: u16,
        description: String,
        tool: String,
    },
    /// Progresso intermedio (es. "trovati 15 negozi")
    StepProgress {
        step_id: u16,
        message: String,
        records_so_far: u32,
    },
    /// Step completato
    StepCompleted {
        step_id: u16,
        records_collected: u32,
        duration: Duration,
    },
    /// Step fallito
    StepFailed {
        step_id: u16,
        reason: String,
        will_retry: bool,
    },
    /// Task completato
    TaskCompleted {
        total_records: u32,
        artifacts: Vec<ArtifactSummary>,
        duration: Duration,
    },
    /// Task richiede input utente
    NeedsInput {
        question: String,
        options: Vec<String>,
    },
    /// Testo streaming (per risposte dirette)
    TextDelta {
        content: String,
    },
}
```

#### Rendering per Canale

Ogni canale renderizza gli eventi in modo nativo:

```
Web UI (WebSocket):
  ┌─────────────────────────────────────────────┐
  │ [Cognition] Analisi completata              │
  │                                             │
  │ Piano: Trovare negozi Diesel in Italia      │
  │ ┌─ Step 1: Cerca store locator    ✓ (0.3s) │
  │ ├─ Step 2: Cerca via directory     ● (...)  │
  │ ├─ Step 3: Naviga store locator    ○        │
  │ └─ Step 4: Crea CSV               ○        │
  │                                             │
  │ Buffer: 10 record raccolti                  │
  └─────────────────────────────────────────────┘

Telegram (markdown):
  Sto lavorando al tuo task...

  Piano (4 step):
  ✅ 1. Cerca store locator (0.3s)
  🔄 2. Cerca via directory...
  ⏳ 3. Naviga store locator
  ⏳ 4. Crea CSV

  Raccolti: 10 record

CLI (testo):
  [plan] 4 steps | [step 1/4] ✓ web_search (0.3s)
  [step 2/4] ● web_search "negozi Diesel Italia"...
  [buffer] 10 records collected
```

#### Canali Non-Streaming (Email, WhatsApp)

Per canali che non supportano aggiornamenti in-place, il sistema:
1. Invia un messaggio iniziale: "Sto lavorando al tuo task (4 step stimati)"
2. Invia aggiornamenti solo a milestone significative (ogni 2+ step completati)
3. Invia il risultato finale completo

```rust
/// Decide se inviare un aggiornamento per canali non-streaming
fn should_notify(event: &UserEvent, channel: &str) -> bool {
    match event {
        UserEvent::PlanCreated { .. } => true,
        UserEvent::StepCompleted { step_id, .. } => {
            // Notifica ogni 2 step o all'ultimo
            step_id % 2 == 0 || is_last_step(step_id)
        }
        UserEvent::TaskCompleted { .. } => true,
        UserEvent::NeedsInput { .. } => true,
        UserEvent::StepFailed { will_retry: false, .. } => true,
        _ => false,
    }
}
```

#### Integrazione col Response Blocks System

Gli eventi di comunicazione usano il sistema `ResponseBlock` esistente per rendering rich:

```rust
/// Converte UserEvent in ResponseBlock
fn event_to_block(event: &UserEvent) -> Option<ResponseBlock> {
    match event {
        UserEvent::PlanCreated { steps, .. } => {
            Some(ResponseBlock::Status {
                title: "Piano di esecuzione".into(),
                steps: steps.iter().map(|s| StatusStep {
                    label: s.description.clone(),
                    status: "pending".into(),
                }).collect(),
            })
        }
        UserEvent::NeedsInput { question, options } => {
            Some(ResponseBlock::Choice {
                prompt: question.clone(),
                options: options.iter().map(|o| ChoiceOption {
                    id: slug(o),
                    label: o.clone(),
                }).collect(),
            })
        }
        _ => None,
    }
}
```

---

## 11. Autonomy Modes e Plan Approval

### COSA

L'utente sceglie COME vuole che l'agente lavori. Non tutti i task richiedono lo stesso livello di supervisione. Un "ciao" non ha bisogno di approvazione. Un "compra un biglietto aereo" si. Un "trova 500 ristoranti in Italia" deve poter correre per ore senza chiedere permesso ad ogni pagina web.

Il sistema offre **4 modalita di autonomia** — ispirate al pattern del selettore di autorizzazioni (come quello di Claude Code), ma estese per un assistant agentico:

### PERCHE

Il documento originale (sezioni 1-10) assume implicitamente una sola modalita: "il sistema fa tutto automaticamente". Ma nel mondo reale:

- **Scenario 1**: L'utente dice "cerca ristoranti vegani a Roma". Vuole che l'agente vada e faccia. Se deve chiedere conferma ad ogni ricerca, e inutile.
- **Scenario 2**: L'utente dice "prenota un volo Roma-Tokyo per il 15 aprile". Qui vuole VEDERE il piano, discuterlo, magari dire "no, non Ryanair", e poi approvare prima che l'agente spenda soldi.
- **Scenario 3**: L'utente dice "monitora i prezzi del BTC ogni ora e avvisami se scende sotto 60K". Questo e un task che dura giorni, completamente autonomo.
- **Scenario 4**: L'utente e un power user che vuole micromanagement: "mostrami ogni step prima di eseguirlo, voglio approvare tutto".

Un'unica modalita non copre tutti questi casi.

### COME

#### Le 4 Modalita

```rust
/// Livello di autonomia per l'esecuzione del task
enum AutonomyMode {
    /// YOLO mode: esegui tutto senza chiedere.
    /// Per task a basso rischio (ricerca, lettura, analisi).
    /// Il piano viene mostrato ma l'esecuzione parte subito.
    Auto,

    /// Mostra il piano, aspetta approvazione, poi esegui tutto.
    /// Per task a medio rischio (scraping, file creation).
    /// L'utente puo modificare il piano prima di approvare.
    PlanApproval,

    /// Approva ogni step individualmente.
    /// Per task ad alto rischio (acquisti, invio messaggi, modifiche account).
    /// L'utente vede il prossimo step e dice "vai" o "salta" o "modifica".
    StepByStep,

    /// L'utente gestisce interattivamente: puo intervenire,
    /// redirigere, aggiungere step, cambiare priorita in tempo reale.
    /// Per task esplorativi dove non si sa in anticipo cosa serve.
    Interactive,
}
```

#### Come l'Utente Sceglie la Modalita

**Opzione 1 — Inferenza automatica dalla cognition:**

La cognition analizza il task e SUGGERISCE una modalita basata su:
- `intent_type: transactional` (acquisto, prenotazione) → `PlanApproval` o `StepByStep`
- `intent_type: informational` (ricerca, analisi) → `Auto`
- Task con side-effect esterni (invio email, post social) → `StepByStep`
- Task di sola lettura (cerca, leggi, analizza) → `Auto`
- Task con costi reali ($, API a pagamento) → `PlanApproval`

```rust
fn suggest_autonomy(plan: &TaskPlan, contact: &Option<Contact>) -> AutonomyMode {
    // Contact override: se il contatto ha un livello di autonomia configurato
    if let Some(c) = contact {
        if let Some(mode) = c.autonomy_override {
            return mode;
        }
    }

    // Analisi del piano
    let has_side_effects = plan.steps.iter().any(|s| matches!(
        s.action,
        StepAction::SendMessage { .. }
        | StepAction::Compute { tool, .. } if tool == "shell"
    ));
    let has_purchases = plan.steps.iter().any(|s| {
        s.description.to_lowercase().contains("compra")
        || s.description.to_lowercase().contains("prenota")
        || s.description.to_lowercase().contains("acquista")
        || s.description.to_lowercase().contains("buy")
        || s.description.to_lowercase().contains("book")
        || s.description.to_lowercase().contains("purchase")
    });
    let is_browser_heavy = plan.steps.iter()
        .filter(|s| matches!(s.action, StepAction::BrowseInteractive { .. }))
        .count() >= 2;

    if has_purchases {
        AutonomyMode::StepByStep
    } else if has_side_effects || is_browser_heavy {
        AutonomyMode::PlanApproval
    } else {
        AutonomyMode::Auto
    }
}
```

**Opzione 2 — Selettore esplicito nella UI:**

L'utente puo cambiare la modalita in qualsiasi momento tramite un selettore (stile Claude Code):

```
┌──────────────────────────────────────┐
│ ⚡ Modalita esecuzione               │
│                                      │
│ ○ Auto — Esegui tutto               │
│   Per ricerche e analisi             │
│                                      │
│ ● Approva piano — (Raccomandato)    │
│   Mostra il piano, poi esegui        │
│                                      │
│ ○ Step-by-step — Approva ogni step  │
│   Controllo massimo                  │
│                                      │
│ ○ Interattivo — Guida l'esecuzione  │
│   Intervieni in tempo reale          │
└──────────────────────────────────────┘
```

**Opzione 3 — Per-contatto/per-canale:**

Nella configurazione dei contatti e dei canali, si puo settare un default:

```toml
# Config per canale
[channels.telegram]
default_autonomy = "auto"  # Su Telegram vai spedito

[channels.web]
default_autonomy = "plan_approval"  # Sul web mostra sempre il piano
```

```sql
-- Per contatto
ALTER TABLE contacts ADD COLUMN default_autonomy TEXT DEFAULT NULL;
-- NULL = usa il default del canale
```

#### Plan Approval: Il Flusso Completo

Quando `autonomy = PlanApproval`, dopo la cognition:

```
┌─────────────────────────────────────────────────────┐
│  COGNITION produce TaskPlan                          │
│                                                      │
│  Il sistema invia il piano all'utente come           │
│  ResponseBlock interattivo:                          │
│                                                      │
│  ┌─────────────────────────────────────────────────┐ │
│  │ 📋 Piano: Trovare negozi Diesel in Italia       │ │
│  │                                                 │ │
│  │ 1. 🔍 Cerca store locator Diesel   [Modifica]  │ │
│  │ 2. 🔍 Cerca via directory           [Modifica]  │ │
│  │ 3. 🌐 Naviga store locator (browser)[Modifica]  │ │
│  │ 4. 📄 Crea CSV finale              [Modifica]  │ │
│  │                                                 │ │
│  │ Tempo stimato: ~3-5 minuti                      │ │
│  │ Costo stimato: ~15K token (~$0.05)              │ │
│  │                                                 │ │
│  │ [✅ Approva] [✏️ Modifica] [❌ Annulla]          │ │
│  │ [⚡ Approva e vai in Auto]                       │ │
│  └─────────────────────────────────────────────────┘ │
│                                                      │
│  L'utente puo:                                       │
│  a) Approvare → esecuzione parte                     │
│  b) Modificare → ciclo di discussione                │
│  c) Annullare → task terminato                       │
│  d) Approvare+Auto → non chiedere piu per questo task│
└─────────────────────────────────────────────────────┘
```

#### Plan Modification: Ciclo di Discussione

Se l'utente clicca "Modifica" (o risponde con testo):

```
Utente: "Non usare il browser, il sito Diesel non funziona.
         Cerca solo su Pagine Gialle e Google Maps."

Sistema:
  1. Riceve il feedback come messaggio testuale
  2. Ri-invoca la cognition con:
     - Piano originale
     - Feedback utente
     - Vincolo: "non usare browser per diesel.com"
  3. La cognition produce un piano MODIFICATO
  4. Il piano modificato viene ripresentato all'utente

Piano modificato:
  1. 🔍 Cerca "negozi Diesel" su Pagine Gialle     [Modifica]
  2. 🔍 Cerca "Diesel store Italy" su Google Maps   [Modifica]
  3. 🌐 Naviga Pagine Gialle per dettagli (browser) [Modifica]
  4. 📄 Crea CSV finale                              [Modifica]

[✅ Approva] [✏️ Modifica ancora] [❌ Annulla]
```

Questo ciclo puo ripetersi N volte. Non c'e limite — l'utente raffina fino a quando e soddisfatto.

```rust
/// Stato della negoziazione del piano
struct PlanNegotiation {
    task_id: Uuid,
    original_request: String,
    current_plan: TaskPlan,
    revision_history: Vec<PlanRevision>,
    status: NegotiationStatus,
}

struct PlanRevision {
    revision: u8,
    user_feedback: String,
    plan_before: TaskPlan,
    plan_after: TaskPlan,
    timestamp: DateTime<Utc>,
}

enum NegotiationStatus {
    WaitingForApproval,
    UserModifying,
    Approved { autonomy_override: Option<AutonomyMode> },
    Cancelled,
}
```

#### Step-by-Step: Approvazione Granulare

Quando `autonomy = StepByStep`:

```
Step 1/4: Cercare "negozi Diesel" su web
Tool: web_search
Query: "negozi Diesel Italia elenco"

[▶️ Esegui] [⏭️ Salta] [✏️ Modifica query] [⏹️ Ferma tutto]

---

Utente clicca "Esegui"

Step 1/4: ✅ Completato (10 risultati trovati)

Step 2/4: Cercare su Google Maps
Tool: web_search
Query: "Diesel store Italy Google Maps"

[▶️ Esegui] [⏭️ Salta] [✏️ Modifica query] [⏹️ Ferma tutto]
[⚡ Approva tutti i rimanenti]  ← fast-track per uscire dallo step-by-step
```

#### Interactive Mode: L'Utente al Volante

Il mode Interactive e il piu complesso. L'utente puo intervenire in tempo reale:

```
Sistema: Step 2/4 in corso — cerco su Google Maps...
         Trovati 8 risultati finora.

Utente: "Aggiungi anche i risultati da Yelp"

Sistema:
  1. PAUSA l'esecuzione dello step corrente
  2. Aggiunge uno step al piano: "Cerca su Yelp"
  3. RIPRENDE lo step corrente (se non completato)
  4. Poi esegue lo step aggiunto

Utente: "Fammi vedere cosa hai trovato finora"

Sistema:
  1. Genera summary dal DataBuffer
  2. Mostra: "25 record finora: Roma (8), Milano (6), Torino (4)..."
  3. NON interrompe l'esecuzione

Utente: "Basta con la ricerca, crea il CSV con quello che hai"

Sistema:
  1. SKIP di tutti gli step di ricerca rimanenti
  2. Salta direttamente allo step WriteOutput
  3. Assembla CSV dal DataBuffer corrente
```

```rust
/// Comandi utente durante l'esecuzione interattiva
enum InteractiveCommand {
    /// Aggiungi uno step al piano
    AddStep { description: String, after_step: Option<u16> },
    /// Rimuovi uno step
    RemoveStep { step_id: u16 },
    /// Modifica uno step
    ModifyStep { step_id: u16, new_description: String },
    /// Salta al prossimo step
    SkipCurrent,
    /// Salta direttamente a uno step specifico
    JumpTo { step_id: u16 },
    /// Mostra lo stato attuale
    ShowStatus,
    /// Mostra il buffer dati
    ShowData { format: Option<OutputFormat> },
    /// Pausa l'esecuzione
    Pause,
    /// Riprendi l'esecuzione
    Resume,
    /// Ferma tutto, esporta quello che c'e
    StopAndExport,
    /// Ferma tutto, butta via tutto
    Abort,
}
```

#### Persistenza della Modalita

La modalita scelta viene persistita nel `task_state`:

```sql
ALTER TABLE task_state ADD COLUMN autonomy TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE task_state ADD COLUMN plan_approved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_state ADD COLUMN plan_revision INTEGER NOT NULL DEFAULT 0;
```

---

## 12. Task a Lunga Durata (Ore/Giorni)

### COSA

Alcuni task richiedono ore o addirittura giorni per essere completati. Esempi reali:
- "Trova TUTTI i ristoranti vegani in Italia con indirizzo e telefono" → 2000+ risultati, 2-4 ore
- "Monitora il prezzo del BTC ogni ora" → task infinito
- "Scarica tutte le fatture dal mio account Aruba degli ultimi 3 anni" → 200+ fatture, 1-2 ore
- "Analizza tutti i commit del repo negli ultimi 6 mesi" → 500+ commit
- "Scrivi un report di 20 pagine sul mercato immobiliare a Roma" → ricerca + scrittura, 1-3 ore

Il sistema deve gestire questi task senza:
- Esaurire il budget token in 10 minuti
- Perdere dati per timeout o crash
- Bloccare l'agente per altre richieste
- Costare $50 in API calls per un task che ne vale $5

### PERCHE

Il documento originale assume task di 3-8 minuti. Ma un assistant personale DEVE poter gestire task che durano ore. Se l'utente dice "trova tutti i ristoranti vegani in Italia", non puo rispondere "troppo complesso, fai da te".

I problemi concreti:
- **Rate limiting**: Brave API ha 1000 query/mese, Google Maps 200/giorno
- **Costo token**: un task da 4 ore con Claude Sonnet consuma ~2M token → ~$6
- **Stale data**: se raccogli dati per 3 ore, i primi risultati potrebbero essere gia obsoleti
- **Attenzione utente**: l'utente non sta davanti allo schermo per 3 ore
- **Crash**: la probabilita di crash cresce col tempo (OOM, network, restart)

### COME

#### Task Budget System

Ogni task ha un budget esplicito che l'utente puo vedere e controllare:

```rust
struct TaskBudget {
    /// Massimo token LLM consumabili per questo task
    max_tokens: u64,
    /// Token consumati finora
    tokens_used: u64,
    /// Massimo costo in USD (stima)
    max_cost_usd: f64,
    /// Costo stimato finora
    cost_used_usd: f64,
    /// Timeout globale del task
    max_duration: Duration,
    /// Tempo trascorso
    elapsed: Duration,
    /// Massimo numero di API call esterne (rate limit aware)
    max_api_calls: HashMap<String, u32>,  // "brave_search" → 50, "browser_navigate" → 100
    /// API call effettuate
    api_calls_used: HashMap<String, u32>,
}

impl TaskBudget {
    /// Verifica se possiamo continuare
    fn can_continue(&self) -> BudgetCheck {
        if self.tokens_used >= self.max_tokens {
            BudgetCheck::TokensExhausted
        } else if self.cost_used_usd >= self.max_cost_usd {
            BudgetCheck::CostExhausted
        } else if self.elapsed >= self.max_duration {
            BudgetCheck::TimeoutReached
        } else if self.any_api_limit_reached() {
            BudgetCheck::RateLimitReached { api: self.which_api_exhausted() }
        } else {
            BudgetCheck::Ok {
                tokens_remaining: self.max_tokens - self.tokens_used,
                cost_remaining_usd: self.max_cost_usd - self.cost_used_usd,
                time_remaining: self.max_duration - self.elapsed,
            }
        }
    }
}

enum BudgetCheck {
    Ok { tokens_remaining: u64, cost_remaining_usd: f64, time_remaining: Duration },
    TokensExhausted,
    CostExhausted,
    TimeoutReached,
    RateLimitReached { api: String },
}
```

#### Quando il Budget si Esaurisce

Il sistema NON termina silenziosamente. Presenta opzioni all'utente:

```
⚠️ Budget raggiunto per il task "Ristoranti vegani Italia"

Progresso: 847/~2000 ristoranti trovati (42%)
Token usati: 150K / 150K (limite raggiunto)
Costo: $0.45
Tempo: 47 minuti

Opzioni:
[➕ Aggiungi 100K token e continua]
[📄 Esporta i 847 risultati parziali]
[⏸️ Metti in pausa (riprendi domani)]
[❌ Annulla e cancella tutto]
```

#### Rate Limit Awareness

Il sistema conosce i limiti delle API e rallenta di conseguenza:

```rust
struct RateLimiter {
    limits: HashMap<String, ApiRateLimit>,
}

struct ApiRateLimit {
    /// Requests per minuto
    rpm: u32,
    /// Requests per giorno
    rpd: Option<u32>,
    /// Requests rimanenti (tracking runtime)
    remaining_minute: u32,
    remaining_day: Option<u32>,
    /// Quando resettare il contatore minuto
    minute_reset_at: Instant,
}

impl RateLimiter {
    /// Attendi se necessario prima di fare una richiesta
    async fn acquire(&self, api: &str) -> Result<()> {
        let limit = self.limits.get(api)
            .ok_or_else(|| anyhow!("Unknown API: {}", api))?;

        if limit.remaining_minute == 0 {
            let wait = limit.minute_reset_at - Instant::now();
            tracing::info!(api, ?wait, "Rate limit — waiting");
            tokio::time::sleep(wait).await;
        }

        if let Some(0) = limit.remaining_day {
            bail!("Daily rate limit reached for {api}. \
                   Task will be paused and resumed tomorrow.");
        }

        Ok(())
    }
}
```

#### Chunked Execution per Task Enormi

Per task con 1000+ risultati attesi, il sistema li spezza in chunk:

```
Task: "Trova tutti i ristoranti vegani in Italia"

Cognition analizza: ~2000 risultati stimati, 20 regioni

Piano chunked:
  Chunk 1: Regioni Nord-Ovest (Piemonte, Lombardia, Liguria, VdA)
    Step 1.1: web_search "ristoranti vegani Piemonte"
    Step 1.2: web_search "ristoranti vegani Lombardia"
    Step 1.3: web_search "ristoranti vegani Liguria"
    Step 1.4: Merge + dedup risultati chunk 1
    → Checkpoint dopo chunk 1

  Chunk 2: Regioni Nord-Est (Veneto, FVG, Trentino, Emilia-Romagna)
    Step 2.1-2.4: stesso pattern
    → Checkpoint dopo chunk 2

  ... (5 chunk totali)

  Chunk finale: Assembla CSV con tutti i risultati
```

Vantaggi del chunking:
- Checkpoint dopo ogni chunk → crash recovery granulare
- L'utente vede progresso reale ("Chunk 2/5: 340 risultati")
- Puo fermarsi a meta e avere un risultato parziale utile
- Il DataBuffer non cresce oltre limiti ragionevoli per chunk

```rust
struct ChunkedPlan {
    chunks: Vec<TaskPlan>,
    current_chunk: usize,
    /// Ogni chunk ha il suo mini-DataBuffer
    chunk_buffers: Vec<DataBuffer>,
    /// Buffer finale (merge di tutti i chunk)
    final_buffer: DataBuffer,
}
```

#### Stale Data Detection

Per task che durano ore, i dati iniziali potrebbero essere obsoleti:

```rust
struct DataRecord {
    // ... campi esistenti ...
    collected_at: DateTime<Utc>,
}

impl DataBuffer {
    /// Controlla se ci sono record piu vecchi di una soglia
    fn stale_records(&self, max_age: Duration) -> Vec<&DataRecord> {
        let cutoff = Utc::now() - max_age;
        self.records.iter()
            .filter(|r| r.collected_at < cutoff)
            .collect()
    }

    /// Per task time-sensitive (prezzi, disponibilita):
    /// segnala record stale all'utente
    fn staleness_report(&self) -> Option<String> {
        let stale = self.stale_records(Duration::hours(2));
        if stale.is_empty() { return None; }
        Some(format!(
            "{} record hanno piu di 2 ore. I dati potrebbero non essere aggiornati.",
            stale.len()
        ))
    }
}
```

#### Background Execution

Per task che durano ore, l'esecuzione va in background:

```rust
/// Il task gira come background task, non blocca il canale
async fn spawn_long_task(
    plan: TaskPlan,
    ctx: ExecutionContext,
) -> TaskHandle {
    let task_id = plan.id;
    let handle = tokio::spawn(async move {
        execute_plan_with_budget(&plan, &ctx).await
    });

    TaskHandle {
        task_id,
        handle,
        // L'utente puo continuare a chattare
        // I messaggi di progresso arrivano via bus
    }
}
```

L'utente puo continuare a usare l'agente per altre cose. I task in background inviano aggiornamenti periodici.

---

## 13. Verifica del Completamento

### COSA

Dopo che il sistema dichiara un task completato, deve DIMOSTRARE che e stato fatto. Non basta che il modello dica "fatto" — servono prove concrete.

### PERCHE

Scenari di fallimento silenzioso:
- Il modello dice "Ho trovato 50 negozi" ma il CSV ne contiene 12 (ha perso dati)
- Il modello dice "Email inviata" ma l'SMTP ha dato errore (non ha controllato)
- Il modello dice "File scaricato" ma il file e vuoto (download fallito)
- Il modello dice "Ho compilato il form" ma ha lasciato campi vuoti

L'utente NON dovrebbe dover verificare manualmente ogni output dell'agente.

### COME

#### Verification Layer

Dopo la fase SYNTHESIS (fase 5) e prima del POST-PROCESSING (fase 6), si aggiunge una fase **VERIFY**:

```
FASE 5: SYNTHESIS
       |
       v
┌─────────────────────────────────────────────┐
│  FASE 5.5: VERIFY                           │
│  - Controlla che ogni output sia valido     │
│  - File: esiste? dimensione > 0? formato ok?│
│  - Dati: conteggio corrisponde?             │
│  - Email: risposta SMTP positiva?           │
│  - Browser: pagina finale corretta?         │
│  - Se fallisce: segnala, non fingere        │
│  Output: VerificationReport                 │
└──────────────────┬──────────────────────────┘
       |
       v
FASE 6: POST-PROCESSING
```

#### Tipi di Verifica

```rust
enum Verification {
    /// File creato: controlla esistenza, dimensione, formato
    FileCreated {
        path: String,
        expected_format: OutputFormat,
        min_records: Option<u32>,
    },
    /// Dati raccolti: controlla completezza
    DataCollected {
        expected_min: u32,
        actual: u32,
        schema_valid: bool,
    },
    /// Messaggio inviato: controlla delivery
    MessageSent {
        target: String,
        delivered: bool,
        error: Option<String>,
    },
    /// Browser action: controlla stato pagina
    BrowserResult {
        expected_url: Option<String>,
        actual_url: String,
        success_indicator: Option<String>,  // testo che dovrebbe apparire
    },
    /// Shell command: controlla exit code
    CommandExecuted {
        exit_code: i32,
        stdout_contains: Option<String>,
    },
}

struct VerificationReport {
    task_id: Uuid,
    checks: Vec<VerificationCheck>,
    overall: VerificationStatus,
}

struct VerificationCheck {
    step_id: u16,
    description: String,
    verification: Verification,
    passed: bool,
    details: String,
}

enum VerificationStatus {
    /// Tutto ok, dati verificati
    AllPassed,
    /// Parzialmente riuscito (alcune verifiche fallite)
    PartiallyPassed {
        passed: u32,
        failed: u32,
        /// Descrizione human-readable dei problemi
        issues: Vec<String>,
    },
    /// Fallito: output non valido
    Failed { reason: String },
}
```

#### Verifica Concreta per Tipo di Output

**File CSV/JSON:**
```rust
fn verify_file_output(path: &str, format: OutputFormat, expected_min: u32) -> VerificationCheck {
    // 1. File esiste?
    if !Path::new(path).exists() {
        return VerificationCheck::failed("File non trovato");
    }
    // 2. Dimensione > 0?
    let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if size == 0 {
        return VerificationCheck::failed("File vuoto");
    }
    // 3. Formato valido?
    match format {
        OutputFormat::Csv => {
            let reader = csv::Reader::from_path(path);
            match reader {
                Ok(mut r) => {
                    let count = r.records().count() as u32;
                    if count < expected_min {
                        return VerificationCheck::partial(
                            format!("CSV ha {} righe, attese almeno {}", count, expected_min)
                        );
                    }
                    VerificationCheck::passed(format!("CSV valido: {} righe", count))
                }
                Err(e) => VerificationCheck::failed(format!("CSV malformato: {}", e)),
            }
        }
        OutputFormat::Json => {
            match fs::read_to_string(path).and_then(|s| Ok(serde_json::from_str::<Value>(&s)?)) {
                Ok(v) => {
                    let count = v.as_array().map(|a| a.len() as u32).unwrap_or(1);
                    VerificationCheck::passed(format!("JSON valido: {} elementi", count))
                }
                Err(e) => VerificationCheck::failed(format!("JSON invalido: {}", e)),
            }
        }
        _ => VerificationCheck::passed("File creato".into()),
    }
}
```

**Confronto DataBuffer vs File Scritto:**
```rust
fn verify_buffer_vs_file(buffer: &DataBuffer, file_path: &str) -> VerificationCheck {
    let expected = buffer.records.len();
    let actual = count_file_records(file_path);

    if actual == expected {
        VerificationCheck::passed(format!("{} record nel buffer, {} nel file — match", expected, actual))
    } else {
        VerificationCheck::failed(format!(
            "Mismatch: {} record nel buffer, {} nel file. {} record persi!",
            expected, actual, expected - actual
        ))
    }
}
```

**Verifica Semantica (LLM-based) per Risultati Qualitativi:**

Per task non numerici (es. "scrivi un report"), la verifica usa un LLM:

```rust
async fn verify_qualitative(
    task_description: &str,
    success_criteria: &str,
    output: &str,
) -> VerificationCheck {
    let prompt = format!(
        "Verifica se questo output soddisfa i criteri.\n\n\
         Task: {}\n\
         Criteri di successo: {}\n\
         Output (primi 2000 char): {}\n\n\
         Rispondi con JSON: {{\"passed\": bool, \"issues\": [\"...\"], \"score\": 1-10}}",
        task_description,
        success_criteria,
        &output[..output.len().min(2000)]
    );

    let result = llm_one_shot(&prompt, temperature=0.0, max_tokens=200).await;
    // Parse e restituisci
}
```

#### Il Report all'Utente

```
✅ Task completato: "Trova negozi Diesel in Italia"

Verifica risultati:
  ✅ CSV creato: negozi_diesel.csv (127 righe, 12KB)
  ✅ Buffer: 127 record → 127 righe nel CSV (match)
  ✅ Formato: CSV valido, 5 colonne (nome, citta, indirizzo, cap, telefono)
  ⚠️ Completezza: 127 trovati su ~150 stimati (85%)
     Motivo: store locator Diesel aveva problemi di caricamento
  ✅ Nessun duplicato

Durata: 4 minuti 23 secondi
Token: 42K ($0.13)

[📥 Scarica CSV] [🔍 Vedi anteprima] [🔄 Riprova step falliti]
```

---

## 14. Pause/Resume Lifecycle

### COSA

L'utente puo mettere in pausa un task, chiudere il laptop, andare a dormire, e riprendere il giorno dopo — anche da un dispositivo diverso. Il sistema mantiene lo stato completo.

### PERCHE

Scenari reali:
- Task dura 2 ore, l'utente deve uscire dopo 30 minuti
- Task in background su VPS, l'utente controlla da telefono via Telegram il giorno dopo
- Gateway viene riavviato (update, maintenance) durante un task
- L'utente vuole rivedere i risultati parziali prima di continuare
- L'utente inizia un task dal web, vuole continuare da Telegram

### COME

#### Lifecycle Completo di un Task

```
                         ┌──────────────────┐
                         │    CREATED        │
                         │ (piano generato)  │
                         └────────┬─────────┘
                                  │
                     ┌────────────┼────────────┐
                     │            │            │
                     v            v            v
              ┌──────────┐ ┌──────────┐ ┌──────────┐
              │ APPROVED │ │ REJECTED │ │NEGOTIATING│
              │          │ │ (fine)   │ │(modifica) │
              └────┬─────┘ └──────────┘ └─────┬────┘
                   │                          │
                   │    ┌─────────────────────┘
                   v    v
              ┌──────────┐
              │ RUNNING   │◄──────────────────┐
              │           │                   │
              └────┬──────┘                   │
                   │                          │
          ┌────────┼────────┐                 │
          │        │        │                 │
          v        v        v                 │
   ┌──────────┐┌────────┐┌────────┐          │
   │ PAUSED   ││SLEEPING││BLOCKED │          │
   │(utente)  ││(rate   ││(needs  │          │
   │          ││ limit) ││ input) │          │
   └────┬─────┘└───┬────┘└───┬────┘          │
        │          │         │               │
        └──────────┴─────────┘               │
                   │                          │
                   │    RESUME ───────────────┘
                   v
          ┌────────┼────────┐
          │        │        │
          v        v        v
   ┌──────────┐┌────────┐┌────────┐
   │COMPLETED ││ FAILED ││EXPORTED│
   │          ││        ││PARTIAL │
   └──────────┘└────────┘└────────┘
```

#### Stati Dettagliati

```rust
enum TaskStatus {
    /// Piano creato, in attesa di approvazione (se PlanApproval mode)
    Created,
    /// Piano in fase di negoziazione con l'utente
    Negotiating { revision: u8 },
    /// Approvato, in esecuzione
    Running {
        current_step: u16,
        started_at: DateTime<Utc>,
    },
    /// Pausato dall'utente (esplicitamente)
    Paused {
        reason: PauseReason,
        paused_at: DateTime<Utc>,
        /// Da quale step riprendere
        resume_from_step: u16,
    },
    /// Dormiente per rate limit — riprende automaticamente
    Sleeping {
        wake_at: DateTime<Utc>,
        reason: String,  // "Brave API daily limit reached"
    },
    /// Bloccato — attende input utente
    Blocked {
        question: String,
        options: Vec<String>,
        blocked_since: DateTime<Utc>,
    },
    /// Completato con successo
    Completed {
        completed_at: DateTime<Utc>,
        verification: VerificationReport,
    },
    /// Fallito
    Failed {
        failed_at: DateTime<Utc>,
        reason: String,
        /// Dati parziali disponibili per export
        partial_data_available: bool,
    },
    /// Risultato parziale esportato (utente ha scelto di fermarsi)
    ExportedPartial {
        exported_at: DateTime<Utc>,
        records_exported: u32,
        artifact_path: String,
    },
}

enum PauseReason {
    /// L'utente ha cliccato "Pausa"
    UserRequested,
    /// Gateway in shutdown (graceful)
    GatewayShutdown,
    /// Budget esaurito, in attesa di estensione
    BudgetExhausted,
    /// Errore recuperabile (network timeout), aspetta retry
    TransientError { retry_at: DateTime<Utc> },
}
```

#### Resume Cross-Device

Il resume funziona da qualsiasi canale/dispositivo perche lo stato e nel DB:

```
Scenario: Utente inizia task da Web UI, vuole continuare da Telegram

Web UI (ore 14:00):
  Utente: "Trova tutti i ristoranti vegani in Italia"
  Sistema: Piano creato (5 chunk, ~2 ore). [Approva]
  Utente: [Approva]
  Sistema: Esecuzione... Chunk 1/5 completato (340 record)

  (ore 14:30 — utente chiude il browser)

  Il task CONTINUA in background (gateway mode).
  Ogni checkpoint aggiorna task_state nel DB.

Telegram (ore 16:00, dal telefono):
  Utente: "Stato dei miei task"
  Sistema: (usa tool `task_status` implicito o slash command /tasks)

  "📋 Task attivi:
   1. Ristoranti vegani Italia — RUNNING
      Chunk 3/5 | 1247 record | 1h 45min
      [⏸️ Pausa] [📊 Anteprima] [⏹️ Stop + Export]"

  Utente: "Fammi vedere un'anteprima"
  Sistema: (legge DataBuffer dal DB, genera summary)

  "Anteprima (1247 record):
   - Roma: 187 ristoranti
   - Milano: 143 ristoranti
   - Torino: 98 ristoranti
   - Firenze: 76 ristoranti
   ... (altre 15 citta)

   [📥 Esporta parziale ora] [▶️ Continua]"
```

#### Resume Dopo Restart

```rust
/// Al gateway startup: cerca task da riprendere
async fn resume_interrupted_tasks(
    db: &Database,
    registry: &AgentRegistry,
) -> Result<()> {
    // 1. Task RUNNING che il gateway non sta piu eseguendo (crash recovery)
    let orphan_running = db.find_tasks_by_status("running").await?;
    for task in orphan_running {
        let age = Utc::now() - task.updated_at;
        if age > Duration::minutes(5) {
            // Sicuramente orfano (non aggiornato da 5+ min)
            db.update_task_status(&task.id, "paused",
                PauseReason::GatewayShutdown).await?;
            notify_user(&task.session_key, &format!(
                "Il task '{}' e stato interrotto per riavvio del sistema.\n\
                 Progresso salvato: step {}/{}, {} record.\n\
                 [▶️ Riprendi] [📥 Esporta parziale] [❌ Annulla]",
                task.understanding, task.current_step, task.total_steps,
                task.records_count
            )).await?;
        }
    }

    // 2. Task SLEEPING il cui wake_at e passato → riavvia
    let sleeping = db.find_tasks_by_status("sleeping").await?;
    for task in sleeping {
        if task.wake_at <= Utc::now() {
            tracing::info!(task_id = %task.id, "Resuming sleeping task");
            spawn_task_resume(task, registry).await?;
        }
    }

    // 3. Task BLOCKED da piu di 24h → notifica di nuovo l'utente
    let blocked = db.find_tasks_by_status("blocked").await?;
    for task in blocked {
        let blocked_duration = Utc::now() - task.blocked_since;
        if blocked_duration > Duration::hours(24) {
            notify_user(&task.session_key, &format!(
                "Reminder: il task '{}' attende una tua risposta da {}.\n\
                 Domanda: {}\n\
                 [Rispondi] [❌ Annulla task]",
                task.understanding,
                humanize_duration(blocked_duration),
                task.blocked_question
            )).await?;
        }
    }

    Ok(())
}
```

#### Staleness Check al Resume

Quando un task viene ripreso dopo ore/giorni, il sistema verifica se i dati raccolti sono ancora validi:

```rust
async fn pre_resume_check(task: &TaskState) -> ResumeDecision {
    let buffer = DataBuffer::from_checkpoint(&task.buffer_json)?;
    let pause_duration = Utc::now() - task.paused_at;

    // Controlla tipi di dati
    let is_time_sensitive = task.plan.steps.iter().any(|s| {
        s.description.to_lowercase().contains("prezzo")
        || s.description.to_lowercase().contains("disponibilit")
        || s.description.to_lowercase().contains("stock")
        || s.description.to_lowercase().contains("price")
    });

    if is_time_sensitive && pause_duration > Duration::hours(4) {
        return ResumeDecision::WarnStale {
            message: format!(
                "Il task e stato in pausa per {}. I dati sui prezzi/disponibilita \
                 potrebbero essere obsoleti. Vuoi ricominciare da zero o continuare \
                 con i dati esistenti?",
                humanize_duration(pause_duration)
            ),
            options: vec!["Continua con dati esistenti", "Ricomincia da zero", "Annulla"],
        };
    }

    if pause_duration > Duration::days(7) {
        return ResumeDecision::WarnStale {
            message: format!(
                "Il task e in pausa da {}. Consiglio di ricominciare — \
                 molti siti potrebbero essere cambiati.",
                humanize_duration(pause_duration)
            ),
            options: vec!["Continua comunque", "Ricomincia", "Esporta parziale"],
        };
    }

    ResumeDecision::ResumeImmediately
}
```

---

## 15. Concorrenza e Messaggi Durante l'Esecuzione

### COSA

L'utente puo inviare messaggi MENTRE un task e in esecuzione. Il sistema deve gestire:
- Comandi relativi al task in corso (pausa, stato, modifica)
- Nuove richieste indipendenti dal task
- Contraddizioni ("non fare piu quello, fai quest'altro")
- Task multipli in parallelo

### PERCHE

Un assistant personale non puo bloccarsi su un task. Se l'utente sta aspettando i "ristoranti vegani" e nel frattempo vuole chiedere "che tempo fa domani?", deve poter farlo. Se invece vuole dire "aggiungi anche i ristoranti vegetariani, non solo vegani", il sistema deve capire che sta parlando del task in corso.

### COME

#### Message Classification Durante Task Attivi

```rust
/// Quando arriva un messaggio e c'e un task attivo, classifica il messaggio
enum MessageIntent {
    /// Comando per il task in corso
    TaskCommand {
        task_id: Uuid,
        command: InteractiveCommand,
    },
    /// Feedback/modifica per il task in corso
    TaskFeedback {
        task_id: Uuid,
        feedback: String,
    },
    /// Nuova richiesta indipendente
    NewRequest {
        message: String,
    },
    /// Ambiguo — chiedi all'utente
    Ambiguous {
        possible_task_command: String,
        possible_new_request: String,
    },
}

/// Classificazione rapida (euristica + LLM se ambiguo)
async fn classify_during_task(
    message: &str,
    active_tasks: &[TaskState],
) -> MessageIntent {
    // Pattern matching rapido per comandi espliciti
    let lower = message.to_lowercase();

    // Comandi espliciti → TaskCommand
    if lower.starts_with("pausa") || lower.starts_with("stop")
       || lower.starts_with("pause") {
        return MessageIntent::TaskCommand {
            task_id: active_tasks[0].id,
            command: InteractiveCommand::Pause,
        };
    }
    if lower.starts_with("stato") || lower.starts_with("status")
       || lower.starts_with("come va") || lower.starts_with("a che punto") {
        return MessageIntent::TaskCommand {
            task_id: active_tasks[0].id,
            command: InteractiveCommand::ShowStatus,
        };
    }
    if lower.starts_with("esporta") || lower.starts_with("export")
       || lower.starts_with("dammi quello che hai") {
        return MessageIntent::TaskCommand {
            task_id: active_tasks[0].id,
            command: InteractiveCommand::StopAndExport,
        };
    }

    // Se il messaggio menziona concetti del task → TaskFeedback
    // (usa keyword matching veloce, non LLM)
    let task_keywords = extract_keywords(&active_tasks[0].understanding);
    let message_keywords = extract_keywords(message);
    let overlap = keyword_overlap(&task_keywords, &message_keywords);

    if overlap > 0.3 {
        // Probabilmente parla del task
        return MessageIntent::TaskFeedback {
            task_id: active_tasks[0].id,
            feedback: message.to_string(),
        };
    }

    // Chiaramente una nuova richiesta
    if overlap < 0.05 {
        return MessageIntent::NewRequest {
            message: message.to_string(),
        };
    }

    // Ambiguo — chiedi (costa meno di sbagliare)
    MessageIntent::Ambiguous {
        possible_task_command: format!(
            "Stai parlando del task '{}'?", active_tasks[0].understanding
        ),
        possible_new_request: message.to_string(),
    }
}
```

#### Quando il Messaggio e Ambiguo

```
Utente: "Aggiungi anche quelli con terrazza"

Task attivo: "Trova ristoranti vegani Roma"

Sistema:
  "Stai parlando del task 'Ristoranti vegani Roma'?
   [Si, aggiungi filtro terrazza] [No, e una nuova richiesta]"
```

#### Task Multipli in Parallelo

L'utente puo avere piu task attivi contemporaneamente:

```rust
struct TaskManager {
    /// Task attivi per sessione
    active_tasks: HashMap<String, Vec<TaskHandle>>,
    /// Limite per sessione
    max_concurrent_per_session: u8,  // default: 3
}

impl TaskManager {
    async fn handle_new_request(
        &self,
        session_key: &str,
        message: &str,
    ) -> Result<TaskResponse> {
        let active = self.active_tasks.get(session_key)
            .map(|v| v.len())
            .unwrap_or(0);

        if active >= self.max_concurrent_per_session as usize {
            return Ok(TaskResponse::TooManyTasks {
                active_count: active,
                message: format!(
                    "Hai gia {} task attivi. Vuoi:\n\
                     [📋 Vedere lo stato dei task]\n\
                     [⏹️ Fermare un task per fare spazio]\n\
                     [⏸️ Mettere in coda questo task]",
                    active
                ),
            });
        }

        // Procedi normalmente
        Ok(TaskResponse::StartNew)
    }
}
```

#### Slash Commands per Task Management

```
/tasks                      — Lista task attivi
/tasks pause <id>           — Pausa un task
/tasks resume <id>          — Riprendi un task
/tasks status <id>          — Stato dettagliato
/tasks export <id>          — Esporta risultati parziali
/tasks cancel <id>          — Annulla un task
/tasks list-all             — Tutti i task (anche completati/falliti)
/tasks budget <id> +100k    — Estendi budget token
```

Questi comandi bypassano la cognition — sono gestiti direttamente dal TaskManager.

---

## 16. Filosofia di Design e Problemi Aperti

> Questa sezione corregge e completa le sezioni precedenti. Dove c'e contraddizione, questa sezione prevale.

### Il Principio Fondamentale: Struttura, Non Controllo

Le sezioni 1-10 hanno un difetto di fondo: assumono che il sistema debba **controllare** il modello. Liste di domini bloccati, override deterministici, dispatch hardcoded. Questo approccio e fragile e controproducente:

- Una lista `SEARCH_ENGINE_DOMAINS` invecchia il giorno dopo che Google lancia un nuovo dominio
- Un `validate_browser_navigation()` che blocca URL e un guardrail che un modello migliore non avrebbe mai triggerato
- Un dispatch "deterministico" StepAction → Tool toglie al modello la possibilita di fare la scelta giusta quando le nostre regole sono sbagliate

**Il principio corretto e: il sistema fornisce STRUTTURA, il modello fornisce INTELLIGENZA.**

Cosa significa in pratica:

| Approccio sbagliato (controllo) | Approccio giusto (struttura) |
|--------------------------------|------------------------------|
| Lista di domini bloccati per il browser | Prompt chiaro che spiega QUANDO usare browser vs search |
| `resolve_tool()` deterministico che forza web_search | Il modello sceglie il tool, ma vede solo quelli rilevanti per lo step |
| Regex per estrarre dati dal tool result | Un tool `add_data` che il modello chiama con dati strutturati |
| Hard cap "max 5 competitor" nel codice | Prompt: "limita a 5 a meno che l'utente non chieda diversamente" |
| Override post-cognition delle scelte del modello | Prompt di cognition migliore con esempi chiari |

**La ragione e semplice**: tra 6 mesi i modelli saranno molto piu performanti. Ogni riga di codice di controllo che scriviamo oggi sara o inutile (il modello non ne ha bisogno) o dannosa (limita un modello che saprebbe fare meglio). La struttura invece scala: un DataBuffer ben progettato serve sia a un 7B che a Claude Opus. Un micro-context pulito aiuta qualsiasi modello.

### Conseguenza: Cosa Cambia nelle Sezioni Precedenti

#### §3 Tool Dispatch — DA RIVEDERE

La sezione 3 dice "il sistema decide quale tool usare, non il modello". Questo e SBAGLIATO come principio assoluto.

**Cosa resta vero**: il modello non dovrebbe vedere 20+ tool contemporaneamente. Il contesto ridotto aiuta.

**Cosa cambia**: dentro un micro-task, il modello PUO scegliere tra i 2-3 tool disponibili per quello step. Il sistema non forza un tool — filtra il set disponibile e lascia scegliere al modello.

```
PRIMA (sezione 3 originale):
  StepAction::WebSearch → sistema forza web_search → modello esegue

DOPO (corretto):
  Step "cerca informazioni" → sistema rende disponibili: web_search, web_fetch
  → modello sceglie quale usare e come → esegue

  Step "interagisci con sito" → sistema rende disponibili: browser, web_fetch
  → modello sceglie → esegue
```

Il dispatch non e deterministico — e **curativo**. Riduce il set di tool per dare focus, non per togliere scelta.

#### §5 Browser Scope — DA RIVEDERE

La sezione 5 ha una lista `SEARCH_ENGINE_DOMAINS` e un `validate_browser_navigation()` che blocca la navigazione. Questo e codice di controllo fragile.

**Cosa resta vero**: il modello dovrebbe preferire `web_search` per cercare e `browser` per interagire. Questo e un pattern che va insegnato, non forzato.

**Cosa cambia**: niente liste di domini, niente blocchi. Il prompt del micro-task spiega:

```
Hai a disposizione: web_search, web_fetch, browser

Linee guida:
- Per CERCARE informazioni (es. "negozi Diesel Italia") usa web_search — e 10x piu veloce del browser
- Per LEGGERE una pagina statica (articolo, wiki) usa web_fetch
- Per INTERAGIRE con un sito (form, mappa, SPA, login) usa browser
- Se web_fetch fallisce (sito vuoto = probabilmente JS-only), prova con browser
```

Se il modello sceglie di usare il browser per cercare su Google, lo fara. Sara lento, costera di piu, ma non crashera. E con un modello migliore, non succedera piu. Nessun codice nostro da mantenere.

La SOLA eccezione e `evaluate()` — quella va rimossa non come "controllo" ma perche e tecnicamente rotta (Playwright la blocca sempre). E un bug, non un guardrail.

### Problema Aperto 1: Come i Dati Entrano nel DataBuffer

Il DataBuffer e il concetto piu forte del documento. Ma il meccanismo di inserimento manca.

**La soluzione e un tool `add_data`** disponibile in ogni micro-task che raccoglie dati:

```rust
/// Tool disponibile durante l'esecuzione quando il piano ha un data_schema
struct AddDataTool {
    buffer: Arc<Mutex<DataBuffer>>,
    schema: DataSchema,
}

impl Tool for AddDataTool {
    fn name(&self) -> &str { "add_data" }

    fn description(&self) -> &str {
        "Aggiungi dati strutturati al buffer di raccolta. \
         Usa questo tool ogni volta che trovi dati rilevanti per il task."
    }

    fn parameters(&self) -> Value {
        // Schema generato dinamicamente dal DataSchema del piano
        json!({
            "type": "object",
            "properties": {
                "records": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": self.schema_to_json_properties(),
                    },
                    "description": format!(
                        "Lista di record. Ogni record deve avere i campi: {}",
                        self.schema.columns.join(", ")
                    )
                }
            },
            "required": ["records"]
        })
    }

    async fn execute(&self, args: Value, _ctx: &ToolContext) -> Result<ToolResult> {
        let records: Vec<HashMap<String, String>> =
            serde_json::from_value(args["records"].clone())?;

        let mut buffer = self.buffer.lock().await;
        let added = buffer.append_records_from_json(records);

        Ok(ToolResult::success(format!(
            "Aggiunti {} record al buffer. Totale: {} record.",
            added, buffer.records.len()
        )))
    }
}
```

**Perche questa e la soluzione giusta**:
- Il modello decide COSA estrarre (intelligenza)
- Il sistema fornisce DOVE metterlo (struttura)
- Lo schema viene dal piano della cognition — il modello sa quali colonne riempire
- Funziona con qualsiasi modello che supporta tool calling
- Nessun parsing regex, nessun LLM aggiuntivo
- I dati entrano nel buffer GIA strutturati
- Se il modello non chiama `add_data`, i dati non si perdono nel contesto — ma il modello e incentivato a usarlo perche il prompt dice "usa add_data ogni volta che trovi dati"

**Per i task senza schema** (testo libero, report, analisi):

```rust
/// Variante per testo libero
struct AddNoteTool {
    buffer: Arc<Mutex<DataBuffer>>,
}

// tool "add_note" con parametro "text: string"
// Per report, analisi, riassunti — non strutturato
```

**Il flusso completo diventa:**

```
Step 2: "Cerca negozi Diesel via directory"
  Tool disponibili: web_search, add_data

  Modello:
    1. Chiama web_search("negozi Diesel Italia elenco indirizzi")
    2. Riceve risultati testuali
    3. Chiama add_data({ records: [
         { nome: "Diesel Torino", citta: "Torino", indirizzo: "Via Roma 1" },
         { nome: "Diesel Milano", citta: "Milano", indirizzo: "Corso Buenos Aires" }
       ]})
    4. Riceve: "Aggiunti 2 record. Totale: 12 record."
    5. Chiama web_search("Diesel store Italy addresses")
    6. Chiama add_data(...)
    7. Fine step (budget 4 iterazioni esaurito)
```

Il modello fa il lavoro di estrazione. Il sistema accumula. Nessuna magia.

### Problema Aperto 2: Qualita della Cognition

La cognition e il singolo punto critico: se il piano e sbagliato, tutto e sbagliato.

**La soluzione NON e validazione post-cognition** (sarebbe codice di controllo). La soluzione e:

**a) Prompt migliore con few-shot examples**

```
Il prompt di cognition include 3-5 esempi concreti di piani buoni:

Esempio 1:
  Input: "Trova negozi Diesel in Italia e fai un CSV"
  Piano:
    Step 1: WebSearch "Diesel store locator Italy site:diesel.com"
    Step 2: WebSearch "elenco negozi Diesel Italia indirizzi"
    Step 3: BrowseInteractive diesel.com/store-locator (sito interattivo con mappa)
    Step 4: WriteOutput negozi_diesel.csv

Esempio 2:
  Input: "Qual e la capitale della Francia?"
  Piano: Direct answer "Parigi"

Esempio 3:
  Input: "Compra un biglietto per Roma"
  Piano:
    Step 1: AskUser "Quale tipo di trasporto? Aereo, treno, bus?"
    ...
```

I few-shot examples insegnano il pattern senza hardcodare regole. Funzionano con qualsiasi modello che capisce il format.

**b) Un loop di self-check nella cognition stessa**

Dopo aver generato il piano, il modello lo rilegge:

```
Il prompt include:
"Dopo aver generato il piano, rileggilo e verifica:
 - Ogni step e realizzabile con i tool disponibili?
 - Ci sono step che potrebbero essere fatti in modo piu semplice?
 - Manca qualche step critico?
 Se trovi problemi, correggi il piano."
```

Questo usa il modello per validare se stesso — non aggiunge codice Rust.

**c) Feedback loop dai risultati passati**

Quando un piano fallisce (step falliti, dati scarsi), il sistema salva il pattern:

```rust
/// Salvato in memory dopo un task
struct PlanOutcome {
    /// Il tipo di richiesta
    request_pattern: String,  // "cerca [entity] in [luogo]"
    /// Il piano usato
    plan_summary: String,
    /// Come e andata
    outcome: OutcomeQuality,  // Good, Partial, Failed
    /// Lezione appresa
    lesson: String,  // "web_search era sufficiente, il browser non serviva"
}
```

Alla prossima cognition, i PlanOutcome rilevanti vengono iniettati:

```
Esperienza precedente per task simili:
- "Cerca negozi X in Italia": web_search + browser store locator ha funzionato
  Lezione: lo store locator era necessario perche il sito aveva mappa interattiva
```

Questo e **apprendimento strutturale** — il sistema migliora nel tempo senza codice di controllo.

### Problema Aperto 3: Task Semplici e Overhead

Il 90% delle richieste non ha bisogno di un TaskPlan con DataBuffer. Servono due percorsi:

```rust
enum CognitionOutcome {
    /// Risposta diretta — nessun tool necessario
    /// "Ciao", "che ore sono", "qual e la capitale del Portogallo"
    Direct { answer: String },

    /// Task semplice — 1-2 tool call, nessun dato da accumulare
    /// "Cerca il meteo a Roma", "manda un messaggio a Marco"
    /// USA IL REACT LOOP V1 (gia funzionante per questi casi)
    SimpleReact {
        tools_needed: Vec<String>,
        max_iterations: u8,  // 3-5
    },

    /// Task complesso — piano strutturato con DataBuffer
    /// "Trova tutti i negozi Diesel in Italia e fai un CSV"
    StructuredPlan {
        plan: TaskPlan,
    },
}
```

**Il punto chiave**: il ReAct loop v1 funziona BENE per task semplici. Non dobbiamo buttarlo via — dobbiamo usarlo dove e appropriato. La cognition decide quale percorso prendere:

- `complexity: simple` → Direct (niente tool)
- `complexity: standard` → SimpleReact (ReAct loop v1 con tool filtrati)
- `complexity: complex` → StructuredPlan (pipeline v2 completa)

Questo e meno radicale della riscrittura totale proposta nelle sezioni 1-10, ma e piu **onesto**: il ReAct loop non e rotto per task semplici. E rotto per task complessi con accumulo dati.

### Problema Aperto 4: Varianza dei Modelli

Non cerchiamo di far funzionare un 7B. Non scriviamo codice di controllo per compensare modelli deboli.

**La strategia e pragmatica**:

```rust
/// Requisiti minimi per le diverse funzionalita
enum ModelTier {
    /// Qualsiasi modello con tool calling
    /// Supporta: Direct, SimpleReact
    /// NON supporta: StructuredPlan (cognition troppo complessa)
    Basic,

    /// Modelli 30B+ o cloud tier 2 (Sonnet, GPT-4o-mini)
    /// Supporta: tutto tranne verification LLM-based
    Standard,

    /// Modelli cloud tier 1 (Opus, GPT-4o, Sonnet 3.5+)
    /// Supporta: tutto incluso verification e self-check
    Advanced,
}

fn detect_model_tier(model_name: &str) -> ModelTier {
    // Basato sulle capabilities gia rilevate dal provider
    // Non una lista hardcoded — usa il sistema capabilities esistente
    if capabilities.has_tool_use && capabilities.has_vision {
        ModelTier::Advanced
    } else if capabilities.has_tool_use {
        ModelTier::Standard
    } else {
        ModelTier::Basic
    }
}
```

**Cosa succede per tier**:
- `Basic`: cognition disabilitata, ReAct loop v1 puro con tutti i tool. Funziona come oggi.
- `Standard`: cognition attiva, SimpleReact per standard, StructuredPlan per complex. Senza self-check.
- `Advanced`: tutto attivo incluso verification LLM-based e feedback loop.

Non c'e codice extra per compensare modelli deboli. C'e codice in meno (feature disabilitate).

**Il test dei modelli Ollama**: dobbiamo testare quale modello e il minimo che fa funzionare la cognition. Probabilmente:
- `llama3.2:3b` → Basic (no cognition)
- `gemma3:12b` → probabilmente Standard (ha tool calling, va testato)
- `qwen2.5:32b` → Standard
- `llama3.3:70b` → Advanced (se il server lo supporta)

Il testing definisce i tier, non il codice.

### Problema Aperto 5: Continuita nel Browser

Dentro un micro-task browser, il contesto deve accumularsi normalmente. Il "contesto fresco" vale SOLO tra step diversi, non dentro lo stesso step.

```
Step 3: BrowseInteractive "diesel.com/store-locator"

  Dentro questo step, il modello ha:
  - System prompt ridotto (identita + goal dello step)
  - Tool: browser, add_data
  - Budget: 12 iterazioni
  - STORIA CHE CRESCE: ogni azione browser + snapshot si accumula
    (come nella v1, dentro lo step)

  Iterazione 1: navigate diesel.com → snapshot 1
  Iterazione 2: click "Store Locator" → snapshot 2
  Iterazione 3: select "Italia" → snapshot 3
  ...tutti gli snapshot sono nel contesto...
  Iterazione 8: add_data({ records: [...15 negozi trovati...] })
```

La differenza con v1: alla fine dello step, gli snapshot vengono BUTTATI. Lo step successivo parte pulito. Ma dentro lo step, il browser funziona come oggi.

Questo risolve il problema senza aggiungere complessita.

### Problema Aperto 6: Mid-Plan Correction

Se i risultati dello step 1 sono sbagliati (Roma Texas invece di Roma Italia), il modello deve poter correggere.

**Soluzione semplice**: il summary del DataBuffer nel micro-context dello step successivo mostra cosa c'e. Se il modello vede "Record: Diesel Austin TX, Diesel Houston TX" nel buffer summary, capisce che qualcosa e sbagliato e adatta la query.

Non serve un meccanismo di "replanning" esplicito. Il modello nel prossimo step vede i dati e reagisce. Se il prompt dice:

```
Dati raccolti finora:
  12 record — ultimi 3: "Diesel Austin TX", "Diesel Houston TX", "Diesel Dallas TX"

Step corrente: Cerca negozi Diesel via directory italiana

Se i dati raccolti finora non sono pertinenti (es. paese sbagliato),
adatta la tua ricerca di conseguenza.
```

Il modello corregge da solo — perche e intelligente. Non abbiamo bisogno di un sistema di detection automatica "Roma Texas vs Roma Italia". Quello sarebbe codice di controllo fragile.

**L'unico caso dove serve replanning esplicito** e quando piu della meta degli step falliscono. In quel caso, la cognition viene ri-invocata con:
- Il messaggio originale
- I dati raccolti finora
- Gli step falliti con motivo

E produce un piano nuovo. Ma questo non e "correzione mid-plan" — e "il piano era sbagliato, rifacciamolo".

### Problema Aperto 7: Testing

Servono test REALI, non unit test di struct.

```
Test Plan:

1. SMOKE TEST (automatizzabile, CI):
   - 10 task semplici → verifica che il fast-path Direct funziona
   - 5 task standard → verifica che SimpleReact produce risultati
   - 2 task complessi → verifica che StructuredPlan produce un piano valido
   - Metriche: latenza, token consumati, risultato presente

2. COMPARATIVE TEST (manuale, pre/post deploy):
   - Stesso task eseguito con v1 e v2
   - Task: "Trova negozi Diesel in Italia, fai CSV"
   - Misura: iterazioni, token, tempo, righe CSV, dati corretti
   - Il v2 deve essere MIGLIORE su almeno 3/5 metriche

3. MODEL TIER TEST (manuale, una volta):
   - Stessi 5 task eseguiti con modelli diversi
   - Identifica tier minimo per ogni funzionalita
   - Documenta: "gemma3:12b funziona per Standard ma non per self-check"

4. RESILIENCE TEST (automatizzabile):
   - Avvia task complesso
   - Kill del processo dopo 30 secondi
   - Restart, verifica che resume funziona
   - Verifica che i dati nel buffer sono integri
```

Non serve una test suite da 200 test. Servono 20 test che coprono i casi reali.

### Riepilogo: Cosa Cambia nel Documento

| Sezione | Cosa era | Cosa diventa |
|---------|---------|-------------|
| §3 Tool Dispatch | Deterministico, il sistema forza | Curativo: riduce il set, il modello sceglie |
| §5 Browser Scope | Lista domini bloccati, validate_browser_navigation | Prompt con linee guida, nessun blocco |
| §6 Micro-Task | Solo StructuredPlan | Tri-path: Direct / SimpleReact / StructuredPlan |
| §4 DataBuffer | "Il sistema parsa i dati" (come?) | Tool `add_data` chiamato dal modello |
| §2 Cognition | Piano prescrittivo rigido | Piano prescrittivo + few-shot + self-check |
| Appendice D | Riscrittura totale | Riscrittura incrementale: prima add_data e tri-path, poi il resto |

---

### Componenti che Restano

| Componente | Motivo |
|-----------|--------|
| `provider/` (tutti) | Infrastruttura LLM invariata |
| `channels/` (tutti) | Contratto channel→bus→agent invariato |
| `contacts/` (tutti) | CRUD + perimeter + context injection invariati |
| `profiles/` (tutti) | Profile scoping invariato |
| `skills/` (tutti) | Loader/executor/installer invariati |
| `tools/mcp.rs` | MCP tool dispatch invariato |
| `storage/db.rs` | DB operations invariate |
| `web/` (tutti) | Web UI invariata (nuovi stream events) |
| `rag/` (tutti) | RAG engine invariato |
| `security/` (tutti) | Security infra invariata |
| `browser/` | MCP bridge, tab session, site memory invariati |

### Componenti da Riscrivere

| Componente | Cosa Cambia |
|-----------|-------------|
| `agent/agent_loop.rs` | Da ReAct loop monolitico a pipeline 6 fasi |
| `agent/cognition/engine.rs` | Da piano suggestivo a piano prescrittivo (StepAction tipizzato) |
| `agent/cognition/types.rs` | Nuovi tipi: TaskPlan, PlanStep, StepAction, DataBuffer |
| `agent/cognition/mod.rs` | Nuovo: `build_micro_context()`, selective tool per step |
| `agent/execution_plan.rs` | Da checkpoint/rotation a micro-task loop |
| `agent/iteration_budget.rs` | Da budget globale a budget per step |
| `agent/context_compactor.rs` | Semplificato: il micro-context e gia piccolo |
| `tools/browser.rs` | Rimuovi `evaluate()`, aggiungi `validate_browser_navigation()` |
| Nuovo: `agent/data_buffer.rs` | DataBuffer struct + operations |
| Nuovo: `agent/tool_dispatch.rs` | Dispatch deterministico StepAction → Tool |
| Nuovo: `agent/synthesis.rs` | Fase 5: assembla risposta da DataBuffer |
| Migration | `task_state` table (sostituisce `task_checkpoints`) |

### Componenti Rimossi

| Componente | Motivo |
|-----------|--------|
| `agent/browser_task_plan.rs` | Sostituito dal TaskPlan prescrittivo |
| Cycle detection in `iteration_budget.rs` | Non serve: il micro-task ha budget 2-12 |
| Stall detection in `iteration_budget.rs` | Non serve: il sistema controlla i progressi |
| `execution_plan.rs` strategy rotation | Non serve: retry gestito dal sistema |

---

## Appendice B: Backward Compatibility

### Richieste Semplici (chat, saluti, domande)

Il fast-path `TaskComplexity::Direct` gestisce tutto cio che non richiede tool. Il comportamento e identico a v1: cognition risponde direttamente, nessun tool coinvolto.

### Tool Manuali (utente chiede esplicitamente "usa il browser")

Se l'utente richiede esplicitamente un tool, la cognition lo rispetta:

```
Utente: "Apri diesel.com nel browser"
Cognition: step con BrowseInteractive { url: "diesel.com", ... }
```

La regola "mai browser per search engine" vale solo per il dispatch automatico, non per richieste esplicite.

### Orchestrator Multi-Agent

L'orchestratore esistente (`agent/orchestrator/`) continua a funzionare. Se un task viene classificato come "orchestrated" (multi-source), ogni subtask riceve il proprio TaskPlan v2. Il synthesizer assembla i risultati dai DataBuffer dei subtask.

### Skills con /slash Command

L'invocazione manuale di skill (`/market-monitor BTC`) bypassa la cognition e va direttamente all'attivazione skill. Il comportamento e identico a v1.

---

## Appendice C: Metriche di Successo

| Metrica | v1 (attuale) | v2 (target) |
|---------|-------------|-------------|
| Iterazioni per task "trova negozi + CSV" | 34-67 | 8-15 (4 step × 2-4 iter) |
| Token consumati per task complesso | 150-300K | 30-60K |
| write_file con dati troncati | Frequente | Mai (sistema scrive da buffer) |
| Browser usato per Google search | Sempre | Mai |
| Dati persi per compaction contesto | Frequente | Mai (buffer in memoria) |
| evaluate() fallite | 100% | N/A (rimossa) |
| Click ripetuti sullo stesso elemento | 6+ | Max 2 (poi retry/skip) |
| Tempo per task "trova 100 negozi" | 15-25 min | 3-8 min |
| Crash recovery con dati preservati | No | Si (task_state + DataBuffer) |

---

## Appendice D: Sequenza di Implementazione

### Fase 1: Fondamenta (prerequisiti)

1. **`agent/data_buffer.rs`** — DataBuffer struct, append, deduplicate, summary, export, checkpoint
2. **`agent/cognition/types.rs`** — Nuovi tipi: TaskPlan, PlanStep, StepAction, ExpectedOutput
3. **`agent/tool_dispatch.rs`** — resolve_tool() deterministico
4. Migration `task_state`

### Fase 2: Pipeline

5. **`agent/cognition/engine.rs`** — Nuovo prompt cognition prescrittivo
6. **`agent/agent_loop.rs`** — Pipeline 6 fasi (mantenere v1 come fallback via config flag)
7. **`agent/micro_task.rs`** — build_micro_context(), execute_micro_task()

### Fase 3: Integration

8. **`tools/browser.rs`** — Rimuovi evaluate(), aggiungi validate_browser_navigation()
9. **`agent/synthesis.rs`** — Assembla risposta da DataBuffer
10. **Stream events** — Nuovi UserEvent per comunicazione in tempo reale

### Fase 4: Hardening

11. Test E2E con task reali (negozi Diesel, ricerca ristoranti, etc.)
12. Benchmark token consumption v1 vs v2
13. Rimuovi v1 code path dopo stabilizzazione

### Fase 5: Real-World Scenarios

14. **`agent/task_manager.rs`** — TaskManager, concurrency, task lifecycle
15. **`agent/autonomy.rs`** — AutonomyMode, plan negotiation, step-by-step approval
16. **`agent/verification.rs`** — VerificationLayer, file checks, semantic verification
17. **`agent/budget.rs`** — TaskBudget, rate limiting, cost tracking
18. **Slash commands** — /tasks, /tasks pause, /tasks resume, etc.

---

## Appendice E: Scenari Edge Case Estremi

Scenari pensati per rompere il sistema. Se l'architettura li gestisce, gestisce tutto.

### Scenario 1: "Trova TUTTI i ristoranti in Italia"

**Input**: "Trova tutti i ristoranti in Italia con nome, indirizzo, telefono. Salvali in un CSV."

**Problemi**:
- ~330.000 ristoranti in Italia. Il task e impossibile da completare in una sessione.
- Budget token: servirebbe ~50M token (~$150).
- Rate limit: Brave API ha 1000 query/mese.
- DataBuffer: 330K record = ~50MB in memoria.

**Come il sistema reagisce**:
1. La cognition stima la portata: "~330.000 ristoranti. Budget stimato: ~$150, ~40 ore."
2. Mostra un avviso all'utente:
   ```
   ⚠️ Task molto grande
   Stima: 330.000+ risultati, $150+ in API, ~40 ore

   Suggerisco di restringere:
   [🏙️ Solo Roma] [📍 Solo una regione] [🥗 Solo vegani]
   [▶️ Procedi comunque (piano chunked)]
   [❌ Annulla]
   ```
3. Se l'utente insiste, crea un piano chunked per regione (20 chunk).
4. Ogni chunk ha il suo budget. Se il budget globale finisce, pausa + chiedi.
5. DataBuffer usa disk-backed storage per >10K record (SQLite temp table invece di Vec in memoria).

**Lezione**: il sistema deve saper dire "questo e troppo" PRIMA di iniziare, non dopo aver sprecato $50.

### Scenario 2: "Prenota un volo e un hotel per il mio viaggio"

**Input**: "Prenota un volo Roma-Tokyo il 15 aprile e un hotel 4 stelle vicino a Shinjuku per 5 notti."

**Problemi**:
- Task transazionale: comporta spesa reale ($$$)
- Richiede navigazione browser su siti di booking (interattivi, CAPTCHA)
- Richiede inserimento dati personali e carta di credito
- L'utente deve approvare il prezzo PRIMA del pagamento
- Se crasha dopo aver prenotato il volo ma prima dell'hotel → stato inconsistente

**Come il sistema reagisce**:
1. Cognition classifica: `intent_type: transactional` → forza `StepByStep` mode
2. Piano:
   ```
   Step 1: 🔍 Cerca voli Roma-Tokyo 15 aprile (web_search)
   Step 2: 🌐 Compara prezzi su Skyscanner (browser)
   Step 3: ⚠️ CONFERMA: Mostra opzioni volo all'utente
   Step 4: 🌐 Procedi con prenotazione volo (browser) ← RICHIEDE APPROVAZIONE
   Step 5: 🔍 Cerca hotel 4★ Shinjuku (web_search)
   Step 6: 🌐 Compara prezzi hotel su Booking (browser)
   Step 7: ⚠️ CONFERMA: Mostra opzioni hotel all'utente
   Step 8: 🌐 Procedi con prenotazione hotel (browser) ← RICHIEDE APPROVAZIONE
   ```
3. Step 3 e 7 sono `StepAction::AskUser` — il sistema si FERMA e mostra le opzioni
4. Step 4 e 8 richiedono approvazione esplicita perche sono transazionali
5. Se crasha dopo step 4: al resume, il sistema sa che il volo e prenotato (checkpoint) e propone di continuare con l'hotel

**Limiti del sistema**: Homun NON inserisce dati di carta di credito. L'utente deve completare il pagamento manualmente. Il browser naviga fino alla pagina di pagamento e poi dice: "Sono sulla pagina di pagamento. Completa tu l'inserimento della carta. Dimmi quando hai finito."

### Scenario 3: "Monitora il prezzo del BTC e avvisami"

**Input**: "Monitora il prezzo del Bitcoin ogni ora. Se scende sotto 60K avvisami su Telegram."

**Problemi**:
- Task INFINITO: non ha una fine naturale
- Deve girare come cron job, non come task singolo
- Deve sopravvivere a restart
- L'utente non vuole 24 messaggi al giorno se non succede nulla

**Come il sistema reagisce**:
1. La cognition riconosce: `intent_type: monitoring` → converte in automation/cron
2. NON crea un TaskPlan con step — crea un'automazione:
   ```
   Questo task e meglio gestito come automazione ricorrente.
   Creo un cron job che:
   - Ogni ora: chiama web_search "BTC price USD"
   - Se prezzo < 60000: invia messaggio su Telegram
   - Altrimenti: log silenzioso

   [✅ Crea automazione] [✏️ Modifica parametri] [❌ No, fai manualmente]
   ```
3. Se l'utente approva, crea un `cron_job` (sistema esistente) con la logica
4. Il task NON usa il TaskPlan/DataBuffer — usa il sistema automazioni esistente

**Lezione**: non tutto e un TaskPlan. Alcuni task sono cron job. La cognition deve riconoscere la differenza.

### Scenario 4: L'Utente Cambia Idea a Meta

**Input iniziale**: "Trova i negozi Diesel in Italia"
**Dopo 5 minuti**: "No aspetta, non Diesel. Cerca i negozi Gucci."

**Problemi**:
- Il DataBuffer ha 50 record di Diesel — inutili per Gucci
- 3 step su 4 sono completati — il lavoro fatto e sprecato
- L'utente si aspetta che il sistema NON mischi dati Diesel e Gucci

**Come il sistema reagisce**:
1. Il messaggio viene classificato come `TaskFeedback` (keyword overlap con "negozi")
2. Il sistema rileva una CONTRADDIZIONE con il task in corso
3. Presenta le opzioni:
   ```
   Hai cambiato il target da Diesel a Gucci.

   Il task attuale ha raccolto 50 negozi Diesel.

   [🔄 Ricomincia da zero per Gucci]
   [📥 Salva i dati Diesel, poi cerca Gucci]
   [🔀 Cerca entrambi (Diesel + Gucci)]
   [❌ Annulla tutto]
   ```
4. Se l'utente sceglie "Ricomincia":
   - Il DataBuffer viene archiviato (non cancellato — potrebbe servire)
   - Un nuovo TaskPlan viene generato per Gucci
   - Il vecchio task va in stato `Superseded`

### Scenario 5: Sito Web che Cambia Durante il Task

**Input**: "Estrai tutti i prodotti dalla pagina X"
**Durante l'esecuzione**: il sito ha un A/B test, la struttura HTML cambia tra richieste

**Problemi**:
- Lo step 2 usa CSS selectors che funzionavano nello step 1
- Il browser trova elementi diversi ad ogni refresh
- I dati sono inconsistenti (alcune pagine hanno 5 colonne, altre 6)

**Come il sistema reagisce**:
1. La verifica post-step nota inconsistenza nello schema:
   ```
   ⚠️ I dati dello step 2 hanno un campo extra ("sconto") che lo step 1 non aveva.
   8 record su 24 hanno questo campo.

   [Ignora il campo extra] [Aggiungi il campo a tutti (vuoto per i vecchi)] [Pausa per investigare]
   ```
2. Il DataBuffer supporta schema flessibile: nuove colonne vengono aggiunte, i vecchi record hanno `null`
3. Se la struttura e COMPLETAMENTE diversa (il sito e down, redirect, CAPTCHA), lo step fallisce e il retry escalation entra in gioco

### Scenario 6: L'Utente Non Risponde per Giorni

**Stato**: Task in `Blocked` — attende conferma dell'utente da 3 giorni.

**Come il sistema reagisce**:
1. **Dopo 24h**: reminder gentile sul canale originale
2. **Dopo 48h**: reminder su TUTTI i canali dell'utente (Telegram, WhatsApp, Email)
3. **Dopo 7 giorni**: il task viene auto-esportato come parziale e archiviato
   ```
   Il task "Negozi Diesel" era in attesa da 7 giorni.
   Ho esportato i risultati parziali: 50 negozi su ~150 stimati.
   File: negozi_diesel_parziale.csv

   Il task e stato archiviato. Puoi ripristinarlo con /tasks restore <id>
   ```

### Scenario 7: Budget Token Finito a Meta di un Task Critico

**Stato**: Task "Prepara presentazione per il meeting di domani" — ha raccolto dati, ha scritto 5 slide su 10. Budget: 0 token rimanenti.

**Come il sistema reagisce**:
1. NON termina silenziosamente. Mostra:
   ```
   ⚠️ Budget token esaurito per il task "Presentazione meeting"

   Completato: 5/10 slide (dati tutti raccolti, manca la scrittura)

   Opzioni:
   [➕ Aggiungi 50K token ($0.15) — dovrebbe bastare per finire]
   [📄 Esporta le 5 slide completate + outline delle rimanenti]
   [✏️ Scrivi le slide rimanenti tu (ti do i bullet point)]
   ```
2. Il sistema stima QUANTI token servono per finire (non chiede un'estensione arbitraria)
3. Se l'utente aggiunge budget, il task riprende ESATTAMENTE da dove era (slide 6)

### Scenario 8: Task con Dipendenze Esterne Non Disponibili

**Input**: "Sincronizza il mio calendario Google con i contatti"
**Problema**: il token OAuth di Google Calendar e scaduto.

**Come il sistema reagisce**:
1. La cognition include `McpToolCall { server: "google-calendar" }` nel piano
2. Al dispatch, il sistema tenta la connessione MCP
3. Fallisce con `401 Unauthorized`
4. Il `McpTokenRefreshTool` tenta il refresh → fallisce (refresh token scaduto)
5. Il task va in `Blocked`:
   ```
   Per continuare serve ri-autorizzare Google Calendar.
   [🔗 Ri-autorizza Google] [⏭️ Salta gli step calendario] [❌ Annulla]
   ```
6. Se l'utente ri-autorizza, il task riprende
7. Se salta, il sistema adatta il piano escludendo gli step dipendenti

### Scenario 9: Task Ricorsivo ("Trova task simili e comparali")

**Input**: "Cerca cosa fanno i concorrenti di Homun e crea un report comparativo"

**Problemi**:
- Task aperto: non si sa quanti concorrenti ci siano
- Ogni concorrente richiede un sub-task di ricerca
- I sub-task possono a loro volta richiedere sotto-ricerche
- Rischio di esplosione combinatoria

**Come il sistema reagisce**:
1. La cognition crea un piano a 2 livelli:
   ```
   Step 1: web_search "personal AI assistant competitors"
   Step 2: Per ogni competitor trovato (max 5):
     Step 2.N.1: web_search "competitor_name features pricing"
     Step 2.N.2: web_fetch homepage
     Step 2.N.3: Estrai feature/pricing nel DataBuffer
   Step 3: Assembla report comparativo
   ```
2. Il `max 5` e un hard cap della cognition — evita esplosione
3. Se i risultati web suggeriscono 15 competitor, il sistema chiede:
   ```
   Ho trovato 15 competitor. Il piano ne analizza 5.
   [▶️ Analizza i top 5] [📊 Analizza tutti i 15 (+tempo)] [✏️ Scegli quali]
   ```
4. Il DataBuffer ha schema multi-livello per dati comparativi

### Scenario 10: Task che Richiede Informazioni Sensibili

**Input**: "Accedi al mio account bancario e scarica gli estratti conto"

**Come il sistema reagisce**:
1. La cognition classifica: task con dati sensibili + autenticazione
2. Il piano include steps con flag `sensitive`:
   ```
   ⚠️ Questo task richiede accesso a dati finanziari sensibili.

   Non posso inserire credenziali bancarie per te.
   Posso:
   - Guidarti step-by-step nell'accesso (tu inserisci la password)
   - Scaricare i PDF una volta che sei autenticato
   - Organizzare i file scaricati

   [▶️ Guida assistita] [❌ Troppo rischioso]
   ```
3. In modalita "guida assistita": il browser si apre in modalita VISIBILE (`show`), l'utente vede lo schermo, l'agente guida ma non tocca campi password
4. I file scaricati vengono salvati nella workspace con naming strutturato

---

## 17. Reality Check: Come Funzionano i Sistemi che Funzionano

> Questa sezione e stata scritta dopo un'analisi approfondita del codice sorgente di Claude Code, OpenClaw, Codex CLI, Nanobot, OpenManus, OpenHands, SWE-agent, e Manus AI. Dove le sezioni 1-16 contraddicono questa sezione, **questa sezione prevale**.

### La Scoperta Fondamentale

**Nessun sistema agentico di successo in produzione usa un planner separato.**

| Sistema | Planner separato? | Core pattern |
|---------|-------------------|-------------|
| Claude Code | No | `while stop_reason == "tool_use"` |
| OpenClaw | No | ReAct loop + retry/failover outer shell |
| Codex CLI | No | ReAct loop + sandbox |
| Nanobot | No | ReAct loop (40 iter max) |
| Cursor | Si (opzionale) | Plan model + build model (unico con 2 modelli espliciti) |
| Manus | Si | Planner + CodeAct + todo.md |
| OpenManus (clone) | No | ReAct loop puro (il planner NON e stato implementato) |
| Browser-use | No | ReAct puro (reagisci a cio che vedi) |
| OpenHands | No | Event-driven ReAct + StuckDetector |

Il pattern dominante e: **dai i tool al modello, lascia che ragioni, comprimi il contesto quando cresce**.

### Cosa Fanno Diversamente da Noi

Il nostro `agent_loop.rs` e strutturalmente identico a tutti questi sistemi — un ReAct loop. Allora perche loro funzionano e noi abbiamo i problemi documentati in `AGENT-REDESIGN-CONTEXT.md`?

La differenza e in 4 aree specifiche, nessuna delle quali richiede riscrivere il loop:

#### 1. Context Compression Aggressiva (noi: quasi assente)

**Claude Code** ha 3 livelli di compressione:
- **Micro-compact**: vecchi tool result (>3 turni fa) sostituiti con `"[Previous: used {tool_name}]"`. MA preserva `read_file` output perche e materiale di riferimento.
- **Auto-compact**: quando token > 50K, LLM riassume tutto → 1 messaggio summary.
- **Context collapse**: su errore 413 del provider, compressione reattiva d'emergenza.

**OpenClaw**: compaction LLM-based quando token > soglia, + troncamento tool result. Retry automatico dopo compaction.

**Nanobot**: troncamento tool result a 16K char. Consolidamento in MEMORY.md quando context > budget.

**Noi**: `auto_compact_context` con soglia 150K char, tronca tool result > 500 char a 200 char. Ma i browser snapshot da 70K char restano nel contesto per turni e turni. Questo e IL problema: con 90K di contesto, il modello perde focus e inizia a fare scelte insensate.

**Fix necessario**: compressione a 3 livelli come Claude Code. I vecchi browser snapshot DEVONO essere compressi aggressivamente. Solo l'ultimo snapshot conta.

#### 2. Tool `add_data` / `TodoWrite` per Stato Esplicito (noi: assente)

**Claude Code** ha `TodoWrite` — un tool che il modello chiama per organizzare il suo lavoro:
```python
class TodoManager:
    items: list  # max 20, solo 1 in_progress alla volta
    # statuses: pending, in_progress, completed
```
Il modello SCEGLIE di usarlo. Il sistema inietta un reminder se il modello non lo aggiorna da 3 turni.

**Manus** ha `todo.md` — un file sul filesystem che il modello aggiorna come piano. Iniettato nel contesto ad ogni turno.

**Noi**: non abbiamo niente di simile. Il modello non ha modo di "prendere appunti" o tracciare il suo progresso. Tutto e nel context window che poi viene compattato e i dati si perdono.

**Fix necessario**: un tool `task_notes` (o `todo`/`add_data`) che il modello chiama per:
- Salvare dati strutturati (record trovati, progressi)
- Tracciare cosa ha fatto e cosa resta
- Questi dati vivono FUORI dal context window (DB o file)
- Vengono iniettati come summary ad ogni turno

Questo e il DataBuffer della sezione 4, ma implementato come TOOL che il modello chiama volontariamente, non come sistema di intercettazione esterno.

#### 3. Retry/Failover Outer Shell (noi: parziale)

**OpenClaw** ha il pattern piu pulito — un loop esterno che wrappa il ReAct loop:
```
while true:
    result = run_react_attempt()
    match result:
        context_overflow → compact session → retry
        auth_error → rotate API key → retry
        timeout → compact → retry
        rate_limit → failover to another provider
        ok → break
```

**Noi**: abbiamo `ReliableProvider` per failover provider e `extract_partial_args` per JSON troncato, ma NON abbiamo un outer loop che fa compact-and-retry quando il contesto e troppo grande. Quando il contesto esplode, il modello degenera — non c'e recovery.

**Fix necessario**: outer shell che rileva quando il contesto e troppo grande e compatta PRIMA di ri-invocare, non durante.

#### 4. Prompt Chiaro su Tool Usage (noi: delegato alla cognition)

**Tutti i sistemi** hanno regole nel system prompt che guidano il modello:
- Claude Code: regole precise su quando usare Read vs Grep vs Agent
- Nanobot: tool descriptions dettagliate con quando-usare
- OpenClaw: tool policy per profilo

**Noi**: abbiamo la cognition che pre-seleziona i tool. Ma quando la cognition suggerisce "usa web_search" e il modello vede anche `browser` nel tool set, il modello ignora il suggerimento.

**Fix possibile (senza riscrittura)**: quando la cognition identifica i tool rilevanti, NON passare gli altri al modello. Questo gia lo facciamo con `build_selective_tool_defs()` — ma la cognition deve essere piu precisa nella selezione. Se il task e "cerca informazioni", il browser NON deve essere nel set di tool. Non come blocco hardcoded, ma come selezione intelligente della cognition.

### La Strategia Corretta: Evoluzione, Non Rivoluzione

Le sezioni 1-10 proponevano una riscrittura radicale: nuovo pipeline a 6 fasi, micro-task, DataBuffer, tool dispatch deterministico. Alla luce di come funzionano i sistemi reali, la strategia corretta e:

**Non riscrivere il loop. Migliorare cio che lo circonda.**

```
Priorita 1 (impatto maggiore, sforzo minore):
  ┌─────────────────────────────────────────────────┐
  │ CONTEXT COMPRESSION a 3 livelli                  │
  │ - Micro: vecchi tool result → placeholder        │
  │ - Auto: LLM summary quando > 50K token           │
  │ - Emergency: su errore 413                       │
  │ IMPATTO: elimina il 90% dei problemi di focus    │
  └─────────────────────────────────────────────────┘

Priorita 2 (risolve il problema dati):
  ┌─────────────────────────────────────────────────┐
  │ TOOL add_data / task_notes                       │
  │ - Il modello salva dati strutturati fuori context│
  │ - Summary iniettato ad ogni turno               │
  │ - write_file legge dal buffer alla fine          │
  │ IMPATTO: elimina CSV troncati e dati persi       │
  └─────────────────────────────────────────────────┘

Priorita 3 (stabilita):
  ┌─────────────────────────────────────────────────┐
  │ RETRY OUTER SHELL                                │
  │ - Detect context overflow → compact → retry      │
  │ - Auth error → rotate → retry                    │
  │ - Rate limit → failover provider                 │
  │ IMPATTO: recovery automatico da stati degenerati │
  └─────────────────────────────────────────────────┘

Priorita 4 (miglioramento cognition):
  ┌─────────────────────────────────────────────────┐
  │ COGNITION PIU PRECISA nella selezione tool       │
  │ - Se intent=search → NO browser nel tool set     │
  │ - Se intent=browse → NO web_search nel tool set  │
  │ - Few-shot examples nel prompt cognition         │
  │ IMPATTO: il modello non puo scegliere male       │
  │          se non vede il tool sbagliato            │
  └─────────────────────────────────────────────────┘
```

### Cosa Resta Valido delle Sezioni 1-16

| Concetto | Resta? | Come |
|----------|--------|------|
| DataBuffer (§4) | **Si** | Ma come TOOL (`add_data`), non come sistema esterno |
| Cognition prescrittiva (§2) | **Parziale** | La cognition seleziona tool, non prescrive step rigidi |
| Tool dispatch deterministico (§3) | **No** | Il modello sceglie tra il set ridotto dalla cognition |
| Micro-task execution (§6) | **No** | ReAct loop unico, compressione aggressiva |
| Browser scope (§5) | **Parziale** | Via cognition (non passare browser se non serve), non via blocchi |
| Autonomy modes (§11) | **Si** | Utile per task transazionali, implementabile come approval gates |
| Long-running tasks (§12) | **Si** | Budget, chunking, background execution |
| Verification (§13) | **Si** | Post-task file check, utile |
| Pause/Resume (§14) | **Si** | Checkpoint DB, resume cross-device |
| Concurrency (§15) | **Si** | Message classification durante task attivi |
| Filosofia §16 (struttura non controllo) | **Si** | Confermata al 100% dalla ricerca |

### Diagramma: L'Architettura Reale v2

```
Messaggio Utente
       │
       ▼
┌─────────────────────────────────────────────────┐
│ INGRESS (invariato)                              │
│ Debounce, contatto, profilo, modello, storia     │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│ COGNITION (migliorata, non riscritta)            │
│ - Analizza intent                                │
│ - Direct → rispondi subito                       │
│ - Simple/Complex → seleziona SUBSET di tool      │
│   (se search: web_search+web_fetch, NO browser)  │
│   (se browse: browser+web_fetch, NO web_search)  │
│ - Inietta understanding nel system prompt         │
│ - Se data_schema → attiva tool add_data           │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│ OUTER SHELL (nuovo)                              │
│ while true:                                      │
│   result = run_react_loop(messages, tools)        │
│   if ok → break                                  │
│   if context_overflow → compress → retry          │
│   if auth_error → rotate → retry                 │
│   if rate_limit → failover → retry               │
│   if timeout → compress → retry                  │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│ REACT LOOP (invariato nel core)                  │
│ while stop_reason == "tool_use":                 │
│   response = llm.chat(messages, selected_tools)   │
│   for tool_call in response:                     │
│     result = execute(tool_call)                   │
│     if tool == "add_data":                       │
│       → salva in DataBuffer (fuori context)      │
│       → inietta summary nel prossimo turno       │
│     messages.append(tool_result)                  │
│   compress_old_results(messages)  ← NUOVO        │
│   checkpoint_if_needed()          ← NUOVO        │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│ POST-PROCESSING (invariato + verify)             │
│ - Se DataBuffer ha dati → scrivi file            │
│ - Verifica output (file esiste? valido?)         │
│ - Memory consolidation                           │
│ - Token tracking                                 │
│ - Salva PlanOutcome per feedback loop            │
└─────────────────────────────────────────────────┘
```

### Quantificazione dello Sforzo

| Intervento | File toccati | LOC stimate | Rischio |
|-----------|-------------|-------------|---------|
| Context compression 3 livelli | `context_compactor.rs` | ~200 | Basso (estendi esistente) |
| Tool `add_data` + DataBuffer | `tools/add_data.rs`, `agent/data_buffer.rs` | ~300 | Basso (nuovo tool, pattern noto) |
| Outer retry shell | `agent/agent_loop.rs` | ~100 | Medio (tocca il loop) |
| Cognition tool selection migliorata | `cognition/engine.rs`, `cognition/mod.rs` | ~100 | Basso (migliora prompt + selezione) |
| Rimuovi `evaluate()` dal browser | `tools/browser.rs` | ~20 | Basso |
| Task checkpoint + resume | `agent/execution_plan.rs`, `storage/db.rs` | ~200 | Medio |
| **Totale** | **~8 file** | **~920 LOC** | |

Confronto con la riscrittura proposta nelle sezioni 1-10: ~15 file, ~3000+ LOC, rischio alto.

**920 LOC che risolvono i problemi reali vs 3000+ LOC che reinventano la ruota.**
