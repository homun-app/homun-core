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
