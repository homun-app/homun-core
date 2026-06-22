# Memoria di Homun — come funziona

> Documento di riferimento sul funzionamento della memoria. Tieni questo file
> allineato quando cambia il comportamento (è il "perché" della memoria stessa).

## North star

La memoria deve ricordare **tutto** ciò che è durevole — fatti, preferenze, persone,
e soprattutto le **DECISIONI** prese durante il lavoro con il loro **PERCHÉ** — e farlo
con **la stessa logica per qualsiasi dominio**: codice, documenti (es. il preventivo di
un cliente), dati personali. Obiettivo concreto: **ricordare il perché di una scelta
invece di ri-scandagliare i file** a ogni turno.

## Architettura (cosa esiste)

- **Store**: un unico DB SQLite (`SQLiteMemoryStore`, `crates/memory/src/store.rs`),
  avvolto da `MemoryFacade` (`facade.rs`). Il gateway tiene un
  `Arc<Mutex<MemoryFacade>>`. Tabelle principali: `memories` (i nodi di conoscenza),
  `memory_search_fts` (FTS5 per la ricerca), `entities`, `relations`, `memory_events`,
  `tombstones`, `access_audit` (ogni lettura è loggata).
- **Scope** (`MemoryScope`, `crates/memory/src/types`): **Personale** (`__personal__`) ·
  **Progetto** (l'id del workspace attivo) · **Thread** (episodi, `__threads__`). Lo
  scope mappa sulla coppia `(user_id, workspace_id)`.
- **Sensibilità**: Public < Internal < Private < Confidential < Secret. Il profilo
  auto-iniettato non espone mai Confidential/Secret.

### Le DECISIONI (layer M3b — il "perché")

Una decisione è un `MemoryRecord` con `memory_type = "decision"` il cui `metadata`
porta una struttura `DecisionDetails` (`crates/memory/src/schema.rs`):

```rust
DecisionDetails {
    rationale: String,                  // il perché della scelta
    alternatives: Vec<Alternative>,     // { option, rejected_because }
    objective_ref: Option<MemoryRef>,   // l'obiettivo che serve
    affects: Vec<MemoryRef>,            // gli artefatti/oggetti toccati
}
```

Le decisioni vanno di default in scope **Progetto** e si auto-confermano se a basso
rischio (sensibilità ≤ Internal, confidenza ≥ 0.8).

## I tre meccanismi (memoria del "perché")

### A — Cattura automatica, generica (`learn_from_exchange`, main.rs)

Dopo ogni turno non banale (fire-and-forget, non blocca la risposta):
- si raccoglie una **traccia delle AZIONI consequenziali** del turno — `summarize_tool_action`
  (modifica file, `run_in_project`/`run_in_sandbox`, create/save artifact, schedule,
  + write su servizi collegati Composio/MCP). Le letture pure sono escluse;
- la traccia + il prompt + la risposta vanno all'**estrattore** (modello del ruolo
  `memory`, temperatura 0, JSON), che produce fatti/preferenze/**decisioni**;
- se ci sono azioni, si **bypassa il gate di salienza** (un "sistemalo" che fa un
  refactor viene comunque ricordato);
- routing per scope: le decisioni → Progetto; i fatti personali/persone → Personale;
  l'episodio (riassunto 1 frase) → Thread.

Vale per **ogni dominio**: un file di codice, un preventivo, un contatto passano dallo
stesso produttore al livello del dispatch dei tool.

### B — Cattura esplicita (tool `record_decision`, main.rs)

L'agente può registrare una scelta deliberata: `summary`, `rationale`, `alternatives`,
`affects`. Salva una decisione confermata in scope Progetto (`create_memory_candidate`
+ `confirm_memory`), col perché anche nel testo. Direttiva di sistema: **prima** di
modificare codice/documenti → `recall_memory`; **dopo** una scelta non banale →
`record_decision`.

### C — Lettura / richiamo

- **M1 — profilo sempre iniettato**: a ogni turno `gather_profile_memory` →
  `context_pack` (scope Personale + Progetto attivo, solo Confirmed, max sensibilità
  Private, budget ~1500 char) → blocco "Personale/Progetto" nel system prompt.
- **M3 — tool `recall_memory`**: FTS5 + traversata del grafo (relazioni → nomi entità)
  su Personale + Progetto + episodi.
- **Strong reader** (rifinitura): il recall espone i **campi strutturati** della
  decisione (rationale + alternative scartate), non solo il testo.
- **Richiamo per-file**: leggendo un file di progetto, le decisioni che lo `affect`-ano
  vengono richiamate automaticamente (così "ricordo perché" senza ri-leggere tutto).

## Ruoli / modelli

- L'**estrattore** usa il ruolo `memory` (`extractor_openai_config`) — meglio un modello
  veloce/economico. Verificato: i modelli Ollama `:cloud` sul demone locale funzionano
  (con `ollama signin`), quindi l'estrazione gira.

## Stato

- A (cattura azioni → estrattore) — FATTO.
- B (`record_decision` + direttive) — FATTO.
- C (lettore) — FATTO:
  - **Strong reader**: `MemorySearchResult` ora porta `metadata`; `recall_memory`
    rende il "perché" STRUTTURATO via `format_recall_entry` (rationale + alternative
    scartate), non solo il riassunto.
  - **Richiamo per-file**: `record_decision` salva gli oggetti toccati (`affects`)
    come ALIAS (indicizzati FTS); leggendo un file (`read_file`) `decisions_for_path`
    cerca per basename e appende "📌 Decisioni passate su questo file" al risultato.

## Recall affidabile (fix importanti)

- **Scope per-thread**: a inizio turno l'active workspace è sincronizzato da
  `workspace_for_thread(thread_id)` → profilo, recall, per-file ed estrazione usano il
  progetto DELLA conversazione (non un global stale).
- **Ricerca FTS in OR**: `search_memory_refs` passa i termini significativi in OR
  (`fts_or_query`), non più la frase grezza in AND implicito (che dava 0 risultati alle
  domande in linguaggio naturale). Vale per OGNI recall (tool, RAG, per-file).
- **RAG**: a ogni turno `relevant_memory_for_prompt` cerca in memoria col prompt
  dell'utente e inietta i match (decisioni/fatti) nel system prompt → risponde dalla
  decisione senza dover chiamare il tool.

## Grafo navigabile + tab Memoria

- **Endpoint** `GET /api/memory/graph?thread=…` (o `?workspace=…`): assembla un grafo
  decision-centric del progetto — nodo progetto → DECISIONI → file toccati
  (`affects_labels`) + alternative scartate (`decision.alternatives`), più
  fatti/preferenze e relazioni entità↔entità. Costruito dai dati esistenti.
- **Tab "Memoria"** nel Workbench: SVG self-rendered (layout force deterministico,
  pan/zoom, click→dettaglio con rationale/alternative). Identico per ogni progetto.

## Piano operativo

- Tool `update_plan(steps)` (pattern TodoWrite): l'agente emette/aggiorna gli step →
  marker `‹‹PLAN››` → pannello "Piano". Direttiva: per compiti multi-step pianifica e
  aggiorna gli stati.

## HomunCoder (metodologia di coding)

- Le skill HomunCoder (evidence-first) sono installabili in Homun via
  `scripts/sync-homuncoder-skills.sh` (stesso formato SKILL.md). L'agente le scopre
  (L1) e le carica con `use_skill`. Le abitudini centrali sono già native qui:
  memoria del perché, `update_plan`, recall-before-edit, verifica eseguendo.

## Come collaudarla

1. In un progetto (o cartella cliente): compi un intervento ("aggiorna il preventivo /
   sistema questa funzione") spiegando il **perché**.
2. In una **chat nuova** (stesso progetto, senza scrollback) chiedi *"perché abbiamo
   fatto così?"* → se risponde col perché, la memoria funziona (non poteva leggerlo
   altrove). Verifica anche nella vista **Memoria** che la decisione sia salvata.
