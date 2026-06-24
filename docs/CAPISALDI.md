# Capisaldi Homun — principi fissi che OGNI modifica deve rispettare

Data: 2026-06-22. Documento di riferimento. Si parte dal motore di memoria (il
differenziatore), poi i principi di sistema. Tutte le modifiche future devono
averli presenti. Il contratto operativo corrente della memoria è
[MEMORIA.md](MEMORIA.md).

---

## Parte 1 — Il motore di memoria: com'è fatto e PERCHÉ

### Cosa memorizza (modello dati — `~/.homun/memory.sqlite`, crate `local-first-memory`)

- **`memories`** — gli atomi richiamabili. `memory_type` ∈ `fact | preference |
  decision | goal | episode | open_loop | artifact`; `status` ∈ `Candidate |
  Confirmed | Rejected | Stale | Deleted`; `confidence`; `privacy_domain` +
  `sensitivity`; versioning/autocorrezione via
  `supersedes_json` / `superseded_by` / `correction_of`; `created/updated/last_seen`.
- **`entities`** — persone, progetti, cose, simboli di codice, artifact, step di
  piano, outcome (`entity_type`, `canonical_key`, `aliases`). I simboli di codice
  oggi entrano tramite **Graphify** e sono marcati con `metadata.source="graphify"`;
  lo stesso principio di graphification va esteso agli altri domini strutturati.
- **`relations`** — il **grafo**: `source_ref →(relation_type)→ target_ref`
  (es. `works_as`, `partner_of`, `imports`, `calls`, `rationale_for`).
- **`memory_events`** — log **episodico** (timeline degli eventi).
- **`memory_embeddings`** — vettori densi per il recall semantico.
- **`memory_evidence`** — collega una memoria alla sua **prova** (`evidence_ref` =
  thread, artifact o altra memoria collegata).
- **`wiki_pages`** — pagine di conoscenza derivate (proiezione leggibile/editabile):
  `brief.md`, `decisioni.md`, `profilo.md`, futuro `stato-lavori.md`.
- **`routines` / `automation_candidates`** — pattern→automazioni apprese.
- **`access_audit`** — chi ha letto cosa e perché (governance).
- **`tombstones`** — cancellazioni tracciate.

Tutto è **scoped per `workspace_id` (progetto) + `user_id`**.

### Come funziona (il ciclo, ogni turno)

1. **Recall ibrido** (`relevant_memory_for_prompt`): pass **lessicale** (FTS5/bm25)
   + pass **semantico** (embedding cosine), fusi con **RRF** (reciprocal rank
   fusion, K=60) + boost di **importanza** + **recency** (decay esponenziale ~30g).
   Scoped al **workspace attivo** (isolamento progetto: "di cosa abbiamo discusso?"
   resta su QUESTO progetto).
2. **Briefing sempre-attivo** (`gather_profile_memory` + `gather_open_loops`):
   identità + preferenze
   stabili dell'utente raggiungono il modello ogni turno (separato dal RAG
   per-prompt) e gli `open_loop` hanno priorità di budget — il sistema sa
   "chi è l'utente" e "cosa non è ancora chiuso".
3. **Iniezione** nel prompt (`format_memory_block`) entro un budget di contesto.
4. **Estrazione post-turn**: dopo il turno un modello estrae nuovi
   fatti/decisioni/goal/open_loop/finding salienti → salvati come `Candidate`.
5. **Consolidamento** in background (`spawn_memory_consolidation_tick` →
   `consolidate_scope`): dedup (Jaccard), supersede/correzione,
   `Candidate → Confirmed`.

### Perché è strutturata così

- **Ibrido FTS + denso + RRF**: il lessicale prende le corrispondenze esatte, il
  denso le parafrasi; RRF li fonde senza che uno domini → recall robusto **anche
  con modelli/embedding deboli** (coerente col motore cross-modello).
- **Tipi di memoria**: politiche diverse — le **preferenze** sono sempre-attive, le
  **decisioni** portano il "perché", gli **open_loop** tengono vivo il lavoro non
  chiuso, gli **artifact** rendono richiamabili i deliverable, gli **episodi** sono
  timeline.
- **Grafo (entità + relazioni)**: la conoscenza è **interrogabile**, non testo piatto.
  Graphify è oggi il primo adapter maturo per estrarre/importare struttura
  soprattutto dal codice; l'obiettivo è graphificare anche artifact, decisioni,
  piano, esiti e loop aperti. Ogni output/cache esterna resta derivata: la verità
  vive nello stesso store memoria.
- **Scope per workspace + privacy/sensitivity + audit**: **local-first e governato**;
  niente fuga di dati personali nei progetti.
- **Candidate→Confirmed + supersede/correction + tombstones**: la memoria **si
  autocorregge e versiona**, non accumula spazzatura.

---

## Parte 2 — I CAPISALDI (vincolanti per ogni modifica)

1. **La memoria è IL differenziatore ed è il layer condiviso.** Ogni capacità —
   chat, canali, automazioni, sub-agent, **artefatti**, **piano** — fa **recall +
   write-back attraverso l'UNICO `MemoryFacade`**. **Mai** uno store parallelo.
2. **L'orchestrazione è proprietà dell'HARNESS, non del modello.** Deve funzionare
   sul **tier locale** (Gemma/7B): il **motore è il prodotto**, niente stampella
   cloud. Qualità scadente da modello debole = ok; piano non creato/seguito = bug
   di design. (ADR 0016)
3. **Local-first + privacy-by-design.** Scope per workspace; `privacy_domain` /
   `sensitivity` / `access_audit`. Default locale; il cloud è **scelta** dell'utente,
   mai un requisito.
4. **Ciclo di vita dei deliverable ≠ ciclo di vita della chat.** Gli **artefatti**
   sono valore di prodotto: vivono e si gestiscono per conto loro **e** sono
   **entità di memoria** (recall del deliverable). Cancellare un artefatto deve, a
   regime, pulire **file + memoria**.
5. **Un solo motore / un solo grafo / un solo store.** Non riscrivere gli stessi
   pezzi (engine, piano, memoria): convergere, non duplicare. **Graphify** e gli
   adapter futuri sono estrattori di struttura, non store alternativi: il risultato
   canonico vive comunque in `MemoryFacade` (`entities`/`relations`). Read-model
   operativi come `contact_relationships` sono ammessi solo se mirrorati/convergenti:
   non devono diventare una seconda verità semantica.
6. **Stato e control-flow sono di CODICE; il modello riempie slot vincolati.** Le 3
   invarianti del piano: **monotonìa** (un `done` verificato non si riapre),
   **limitatezza** (un avanzamento non gonfia il piano), **identità non inferita**
   (l'id è del runtime, mai dedotto dal testo). Output strutturato imposto dove il
   backend lo supporta + parsing tollerante ovunque.
7. **Capability activation da registry unico, non keyword sparse.** Workflow nativi
   (`make_*`), MCP, skills/addon, connector tools e strumenti atomici interni stanno
   nello stesso registry logico interrogabile. Il turno fa retrieval/decisione
   strutturata sulle capability e carica nel toolset live solo il set minimo
   necessario. Euristiche/keyword locali sono ammesse solo come prefilter,
   fallback offline o guardrail di sicurezza, **non** come verità primaria di
   routing. Esempio: “voglio creare un pitch per Homun” deve poter recuperare
   `make_deck` dal registry anche senza parole come `slide` o `pptx`.
8. **Design system deliverable condiviso, non proliferazione di tool.** Documenti,
   presentazioni e futuri deliverable devono consumare un unico sistema
   dichiarativo di temi, layout, componenti, template e controlli qualità. Il
   modello fa da composer: sceglie struttura, narrativa e blocchi dal registry;
   il renderer deterministico materializza `.pptx`, `.docx`, `.pdf`/HTML e la QA
   verifica overflow, tabelle, immagini e leggibilità. `make_deck` e
   `make_document` sono capability/plugin che usano questa grammatica comune, non
   sistemi separati; aggiungere un template non deve creare un nuovo `make_*` né
   un routing euristico parallelo. Cataloghi esterni tipo Monet sono provider/
   adapter di `template_ref` dentro il registry unico, non renderer o store
   paralleli.
9. **Homun è un workspace agentico operativo con chat al centro.** La chat è il
   comando naturale e la timeline narrativa, ma non l'unico contenitore dello
   stato. Piano, computer/tool activity, artifact, template e capability devono
   avere superfici contestuali, per-thread, spiegabili e verificabili. Il prodotto
   deve comportarsi come un action engine local-first: obiettivo → piano →
   capability dal registry unico → esecuzione → evidenza → artifact → ripresa/
   correzione. Vedi
   [Homun Agentic Workspace UX Design](superpowers/specs/2026-06-24-agentic-workspace-ux-design.md).
10. **Comprensione senza keyword/regex; verità verificabile.** Il core non capisce le
   richieste con regex/keyword (de-gemma/capable-first); la verifica è deterministica
   dove possibile.
11. **La memoria cattura il PERCHÉ e i LOOP APERTI, non solo i fatti, e collega TUTTO
   nel grafo** (codice, decisioni, artefatti, piano), con archi causali. Il lavoro
   incompiuto resta richiamabile finché non è chiuso. Obiettivo: un cervello che
   sopravvive alle chat e sa sempre il perché — **verificabile via eval**. Vedi
   [MEMORIA.md](MEMORIA.md) e [memory-vision.md](memory-vision.md).

> Questi capisaldi sono il filtro di ogni decisione nel
> [backlog](plans/2026-06-22-batch-1042-artifacts-memory.md) e nella
> [ADR 0016](decisions/0016-harness-owned-task-engine-cross-model.md). Se una
> modifica li viola, va ridiscussa, non spedita.
