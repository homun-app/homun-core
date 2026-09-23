# Proposta di design — MCP e Skill in Homun (da analisi Hermes, 23/09/2026)

> Stato: opzioni raccomandate assunte (l'utente ha detto «procedi»), analisi di
> riferimento: `2026-09-23-hermes-mcp-skill-analysis.md`. Principi invariati:
> dichiarazione esplicita, mai attivazione silenziosa, l'agente propone e la
> persona conferma.

## MCP

1. **`ExternalServer`** (entità motore, revisionata): nome, trasporto
   (`stdio`: command+args+env dichiarate / `http`: url+headers), allowlist
   `tools_include` / `tools_exclude` (glob), stato `enabled|disabled`.
   Comandi `external.create/update/remove` — **solo persona** (policy).
2. **Client MCP minimale a motore** (JSON-RPC 2.0 su stdio e HTTP, senza SDK
   esterni): `probe` = initialize + `tools/list` con timeout; l'ambiente del
   sottoprocesso riceve **solo** le variabili dichiarate (regola Hermes:
   mai l'ambiente shell completo). Il probe è l'unica azione automatica:
   scopre, non esegue.
3. **Fetta 1**: dichiarazioni + probe reale + lista strumenti scoperti in
   Impostazioni → Plugin e capacità. L'esecuzione degli strumenti esterni
   (capacity bridging) è fetta 2: entra nel registro come capacità e passa
   dalla pipeline supervisionata esistente.

## Skill

1. **`Skill`** (entità motore): nome, descrizione (≤60 caratteri), corpo
   markdown, tag, stato `staged|approved|archived`, autore (persona|agente).
2. **Staging obbligatorio per l'agente**: ogni skill scritta dall'agente nasce
   `staged` e viene approvata esplicitamente (`skill.approve/reject` dalla
   persona). La persona può crearle già approvate. Mai cancellare: `archived`.
3. **Indice progressivo (L0)**: l'elenco economico (nome+descrizione) è ciò che
   si vede sempre; il corpo si legge su richiesta (`skill.view` come capacità
   di lettura in fetta 2, quando entra nel contesto del modello).
4. **Fetta 1 UI**: «Salva come procedura» sui messaggi dell'agente in chat
   (nasce staged) + sezione Impostazioni → Skill (elenco, approvazione,
   archiviazione).

## Fuori dalla fetta 1

Esecuzione strumenti MCP (capacity bridge, per fasi/lavori), OAuth/mTLS,
caricamento skill nel contesto del modello, `/learn` da materiali, curatore
automatico, hub/condivisione.

## Realizzazione fetta 1 (23/09/2026, verificato dal vivo)

Motore:
- `ExternalServer` + `external.create/update/remove` (solo persona, validazioni
  trasporto) e client MCP minimale senza SDK: JSON-RPC 2.0 su stdio/HTTP,
  initialize + `tools/list`, timeout 10 s, ambiente del sottoprocesso limitato
  alle variabili dichiarate + baseline sicura (regola Hermes). `probe_server`
  scopre, non esegue; allowlist `tools_include` vince su `tools_exclude`.
- `Skill` + `skill.create/patch/approve/reject/archive`: **invariante di
  staging** — una skill creata/patchata dall'agente nasce sempre `staged`
  (nemmeno `status: approved` la promuove; solo `skill.approve` della
  persona); archiviate immutabili; descrizione ≤60 caratteri validata dal
  dominio. 5 test offline (probe con server echo inline, allowlist, failure
  onesta 503, staging, capi).
- Route: `GET/POST /mcp/servers`, `POST /mcp/servers/{id}/test|remove`,
  `GET/POST /skills`, `POST /skills/{id}/approve|reject|archive`.

Web:
- Impostazioni → **Plugin e capacità** ora apre con «Server MCP» (dichiara
  stdio/HTTP con allowlist, **Prova connessione** che elenca gli strumenti
  reali scoperti e quelli ammessi) sopra il catalogo capacità; nuova sezione
  **Skill** con badge «N procedure attendono la tua approvazione»,
  Approva/Respingi/Archivia e contenuto a scomparsa.
- In chat, sui messaggi dell'agente, «**Salva come procedura**» accanto a
  «Salva in memoria»: nasce staged e la notifica rimanda all'approvazione.
- Verificato dal vivo: server «Echo di prova» dichiarato con allowlist →
  probe reale «Collegato a echo-live: 2 strumenti ammessi su 3 scoperti»;
  messaggio agente salvato come procedura → staged → approvato (rev 2).

## Realizzazione fetta 2 (23/09/2026, verificato dal vivo)

- **Esecuzione supervisionata degli strumenti MCP**: `call_tool` nel client
  (initialize + `tools/call` in un roundtrip fresco, allowlist onorata anche
  in esecuzione, testo del risultato per la revisione) e flusso applicativo
  propose → approve → execute: proposta durabile `external_tool.call`
  (digest che lega l'approvazione a server+strumento+argomenti esatti),
  approvazione **solo persona**, esecuzione fuori transazione, artifact
  tramite `work.submit_artifact` (con bootstrap piano+start per lavori in
  bozza) e messaggio onesto in chat. Un solo strumento attivo per lavoro.
- Route: `POST /mcp/tools/propose`, `POST /mcp/tools/{id}/approve`,
  `GET /works/{id}/mcp/tools`. Test e2e (server echo che risponde a
  tools/call): artifact con il testo dello strumento, lavoro in REVIEW,
  digest alterato rifiutato, strumento fuori allowlist rifiutato.
- **Skill nel contesto del modello (L0)**: il payload dell'intake ora include
  l'indice delle sole skill approvate (nome+descrizione, max 40); il prompt
  cita in rationale le procedure pertinenti senza inventarne altre.
- **Web**: sezione «Strumenti esterni (MCP)» nel pannello del lavoro —
  scelta server (probe reale per gli strumenti), argomenti JSON, «Prepara la
  proposta» (non esegue) e «Approva ed esegui» che porta il risultato in
  revisione. Verificato dal vivo: echo server → list_issues con
  `{"stato":"aperto"}` → «Strumento eseguito: il risultato è in revisione
  nella conversazione», lavoro in REVIEW con artifact a motore.

## Realizzazione fetta 2b — catalogo curato (23/09/2026, verificato dal vivo)

- **Catalogo nel repository** (`application/mcp_catalog.py`): cinque voci
  verificate (filesystem, git, fetch, sqlite, memory) con trasporto, comando,
  prefisso argomenti, allowlist/esclusioni e **sorgente sempre visibile**
  (npm/pypi). La presenza nel catalogo è vetting, non installazione: la voce
  resta inerte finché la persona non la dichiara. Le esclusioni sono parte
  del contratto (sqlite ammette read ma esclude `write_query`).
- **Route** `GET /mcp/catalog` (sola lettura, forma pubblica senza campi
  interni). **Web**: sezione «Catalogo curato» in cima a Plugin e capacità —
  comando e sorgente visibili prima di qualunque esecuzione, campo percorso
  obbligatorio per le voci che lo richiedono (Dichiara disabilitato finché
  è vuoto), bottone «Dichiara» → dichiarazione normale sotto «Server MCP»,
  stato «Dichiarato» per le voci già presenti.
- Verificato dal vivo: fetch dichiarato dal catalogo → appare sotto Server
  MCP con «strumenti ammessi: fetch»; le voci con percorso restano
  disabilitate senza percorso. Probe/meccanica di esecuzione già coperti
  dalle fette 1–2 (suite 488 verdi, +2 test catalogo).
