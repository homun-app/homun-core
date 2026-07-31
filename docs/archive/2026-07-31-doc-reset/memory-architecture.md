# Architettura della memoria di Homun — la logica

> Design di riferimento. La memoria è **una cosa con tre facce**: dati strutturati
> (canonici), un **grafo** di relazioni, una **wiki** markdown leggibile — tutto in un
> unico SQLite che le unisce e le tiene in sync. Modello **ibrido**: lo strutturato è
> canonico, la wiki è editabile a mano e le modifiche rientrano (re-ingest).

## I tre layer (un solo DB)

```
                         ┌───────────────────────────┐
   scrittura  ─────────► │   SQL · SPINA / VERITÀ      │
 (estrazione,            │  memories · entities ·      │
  record_decision)       │  relations · wiki_pages ·   │
                         │  FTS                        │
                         └───────┬───────────┬─────────┘
                                 │           │
                  proiezione     │           │   proiezione
                                 ▼           ▼
                    ┌───────────────┐   ┌───────────────────┐
                    │ GRAFO         │   │ WIKI (markdown)    │
                    │ entità+arichi │   │ pagine per topic:  │
                    │ decis→tocca→  │   │ Decisioni,         │
                    │ file, scarta, │   │ Architettura,      │
                    │ supera        │   │ per entità/cliente │
                    └───────────────┘   └─────────┬─────────┘
                          ▲                        │ modifica umana
                          └──── re-ingest ─────────┘ (import_wiki_correction)
```

- **SQL = fonte di verità.** Ogni unità di conoscenza è una riga canonica
  (`memories`: fact/preference/decision/episode con `metadata` = rationale,
  alternatives, affects). Entità e relazioni sono righe. FTS indicizza tutto.
- **Grafo = faccia relazionale.** `entities` + `relations` + archi tipizzati derivati
  dalle decisioni (decisione→`tocca`→file, decisione→`scarta`→alternativa,
  X→`supera`→Y). Serve a navigare (tab Memoria) e al recall per-relazione.
- **Wiki = faccia leggibile.** Pagine markdown (`wiki_pages` + file) **generate** dallo
  strutturato e **editabili a mano**. Aggregate per topic (una pagina *Decisioni*, una
  *Architettura*, una per entità/cliente), non una nota per record.

## Modello ibrido (la regola di verità)

1. **Scrittura** (estrazione del turno o `record_decision`): crea/conferma le righe
   strutturate → nello stesso atto **materializza** (a) i nodi/archi del grafo per
   `affects`/`alternatives`, (b) la sezione nella pagina wiki del topic. Una scrittura
   logica, tre facce.
2. **Modifica umana** (l'utente edita una sezione wiki nella tab Memoria):
   `import_wiki_correction` la riparsa → crea **candidati di correzione** sulle righe
   linkate → confermati → grafo e FTS si riallineano. Nessuna divergenza silenziosa.
3. **Lettura/recall**: FTS su `memories`+`wiki` + traversata del grafo → la **RAG**
   inietta la fetta pertinente; la tab Memoria mostra grafo + wiki.

## Cosa esiste già (e cosa è dormiente)

| Primitiva | Stato |
|---|---|
| `memories` + FTS, scope per-thread, RAG, recall (FTS-OR) | ✅ attivo |
| `supersedes` / `superseded_by` / `correction_of` su `memories` | ✅ schema c'è, **non usato** per dedup |
| `entities` / `relations` (grafo) | ⚠️ popolato debolmente; archi decis→file solo *derivati a lettura* |
| `WikiFileStore`, `record_wiki_page`, `project_to_wiki`, `MemoryWikiProjection` | ✅ esistono; cablati **solo** nel salva-messaggio manuale (M5) |
| `import_wiki_correction` + `parse_wiki_markdown` (re-ingest) | ✅ esiste, **mai chiamato** dal gateway/UI |
| endpoint `/api/memory/graph` + tab Memoria (viz) | ✅ nuovo (questa sessione) |

**Conclusione**: la memoria non va riscritta — va **attivata e unificata**. Il layer
wiki è morto solo perché l'estrazione automatica non chiama `project_to_wiki`; il grafo
è debole perché gli archi non sono persistiti e le decisioni non sono deduplicate.

## Piano di attivazione (per layer)

**1 · Dedup (spina + grafo).** In scrittura, deduplica le decisioni near-identiche per
chiave normalizzata (summary normalizzato + `affects`): invece di inserirne una nuova,
**aggiorna/supersede** la precedente (`superseded_by`). Effetto a cascata: grafo e wiki
non duplicano. Risolve i nodi `Scelto JSON…` ripetuti.

**2 · Grafo reale.** Persisti gli archi decisione→`affects`→entità ed entità→progetto
alla scrittura (non solo derivati). `/api/memory/graph` legge gli archi persistiti.

**3 · Wiki viva (markdown↔SQL).** Dopo l'estrazione/`record_decision`, **proietta**
nelle pagine aggregate (`Decisioni.md`, `Architettura.md`, per-entità). Endpoint
`GET/PUT /api/memory/wiki` per leggerle/editarle; `PUT` → `import_wiki_correction`
(re-ingest). La tab Memoria mostra le pagine accanto al grafo.

**4 · Tab Memoria = vista generale.** Grafo (deduplicato, responsive in fullscreen) +
elenco pagine wiki + ricerca: la rappresentazione navigabile di **tutta** la memoria
del progetto.

**5 · Pulizia / oblio.** Cancellare informazioni è un layer di prima classe.
- *Item-level* (esiste): `delete_memory`/`reject_memory` + `tombstone` + endpoint
  `memory_decide` (confirm/reject/delete/edit). La tab Memoria deve poter **eliminare un
  nodo** (decisione/fatto/entità) → `memory_decide delete`.
- *Agente* (da aggiungere): tool **`forget_memory(query|ref, reason)`** → trova e
  soft-elimina le memorie che corrispondono ("dimentica che…", "questa decisione non
  vale più").
- *Cascade*: alla cancellazione di una memoria, **ri-proietta** la pagina wiki del topic
  (la sezione sparisce) e il grafo la esclude (già filtra `Deleted`/`Rejected`); se
  aveva archi persistiti, vanno rimossi.
- *Dedup come pulizia preventiva*: vedi punto 1 — superseding evita l'accumulo.
- *Bulk* (opzionale): "svuota la memoria di questo progetto" → tombstone di massa sullo
  scope.

## Fuori dalla memoria, stessa sessione (collegati)

- **Skill grouping**: le skill di metodologia portano `source="homuncoder"` → raggruppate
  sotto "HomunCoder" nei Settings.
- **HomunCoder mode**: nelle chat di **progetto** si attivano metodologia + skill di
  metodologia (niente flood nelle chat personali).

## Stato implementazione (sessione notturna)

- **1 · Dedup** — FATTO. Lessicale language-agnostic (Jaccard 0.55, no stopword) +
  **semantico** (embeddings nomic-embed-text-v2-moe, coseno 0.85, tarato su dati reali),
  in scrittura e a lettura nel grafo. Grafo taskline 39→29 nodi.
- **2 · Grafo reale + responsive** — grafo navigabile + dedup a lettura; tab responsive
  (ResizeObserver). Archi decisione→file **derivati** (persistenza degli archi = TODO).
- **3 · Wiki viva (markdown↔SQL)** — FATTO in lettura/scrittura: `rebuild_decisions_wiki`
  proietta le decisioni in `wiki_pages.decisioni.md` (verificato: 6601 char in SQL);
  tab Memoria toggle Grafo/Wiki. Editing wiki→re-ingest (`import_wiki_correction`) =
  TODO (la primitiva esiste, manca l'endpoint PUT + il bottone edit).
- **4 · Tab Memoria** — grafo + wiki + elimina-nodo. FATTO.
- **5 · Pulizia/oblio** — FATTO: tool `forget_memory` + elimina-nodo + cascade wiki.
- **Recall semantico** — FATTO: embeddings nel recall (cross-lingua).
- **HomunCoder mode** — FATTO: skill metodologia solo nelle chat di progetto (manifest).
- **Multilingua** — embeddings multilingua + dedup/recall language-agnostic.
- **Residui — COMPLETATI**:
  - *Editing wiki + re-ingest* — FATTO: PUT `/api/memory/wiki` salva il markdown editato,
    marca la pagina (`wiki-edited.json`, niente auto-overwrite) e ri-ingesta via
    estrattore (le correzioni rientrano nello strutturato). UI: Modifica/Salva nella tab.
  - *Soppressione duplicati alla fonte* — FATTO: le decisioni note sono iniettate nel
    prompt dell'estrattore ("estrai solo NUOVE/aggiornamenti").
  - *Skill grouping Settings* — FATTO: gruppo "HomunCoder · metodologia" nella rail
    (source="homuncoder" dal manifest).
  - *Persistenza archi grafo* — SCELTA: restano **derivati a lettura** (più pulito: niente
    archi stale o relazioni duplicate; il viz e la navigazione funzionano già). Non un TODO.

## Riferimenti codice

- Spina/wiki: `crates/memory/src/{store.rs,facade.rs,wiki.rs,types.rs}`
  (`record_wiki_page`, `project_to_wiki`, `import_wiki_correction`, `WikiPage`,
  `MemoryWikiProjection`, `supersedes_json`).
- Gateway: `crates/desktop-gateway/src/main.rs` (`learn_from_exchange`,
  `record_decision`, `persist_graph`, `memory_graph`, il salva-messaggio M5 ~riga 874).
- Frontend: `apps/desktop/src/components/ChatView.tsx` (`MemoryGraphPanel`).
