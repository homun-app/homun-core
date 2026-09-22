# UX audit con Computer Use — 2026-09-22

## Superficie testata e fonte

- **Superficie**: web app su http://127.0.0.1:4183, viewport 1280×800, browser in-app.
  Servita da `npm run dev` (vite, codice sorgente live). NOTA: all'avvio la porta era
  occupata da un avanzo di sessione precedente (static server di `apps/web/dist`): chiuso
  quello, avviato vite.
- **Fonte dati**: **motore** (non simulazione). Il client web in dev punta di default a
  `http://127.0.0.1:8765`, dove era in esecuzione il motore reale dell'utente con modello
  collegato (interpretazioni 15–60 s, nomi generati dal modello). L'app lo ha usato **senza
  alcuna etichetta visibile** «Fonte: simulazione | motore» → G6 violato (D4), ed è proprio
  la mescolanza silenziosa che le regole di repo vietano.
- **Nota ambiente**: la shell Electron (`npm run desktop:dev`) è stata avviata ma non era
  automatizzabile: l'helper Computer Use di ZCode non ha il permesso *Accessibilità* di macOS
  (concessione solo da System Settings, intervento utente). Sessione proseguita sulla
  superficie web prevista dalla procedura.
- Durante la sessione il motore su 8765 è stato **riavviato** (stesso profilo, stessa porta)
  per rendere effettivo il fix D1 descritto sotto.

## Missione

Percorso guida «primo collaboratore» dalla A alla Z senza consultare la documentazione:
bisogno in linguaggio naturale → proposta collaboratore → primo incarico → risultato → chiusura.

**Esito: COMPLETATA SINO AL RISULTATO VISIBILE; chiusura dell'incarico non disponibile
nell'app** per lavori di sola preparazione (nessuna azione «chiudi/completa» in chat,
menu Azioni, vista Compiti o pannello dettagli — vedi D7). La missione è arrivata a:
bisogno descritto → Elena proposta e confermata → dati forniti in chat → revisione
dell'accordo che mantiene Elena → accordo confermato «Report preventivi attivi e scaduti»
(Concordato · in preparazione, responsabile Elena coerente ovunque).

Variante con dati parziali/sbagliati: eseguita (input ambiguo «prevented») → risposta
onesta in chat, nessun lavoro forzato (G5 ok).

## Diario UX

### Interazione 0 — Avvio, Panoramica iniziale
- [COSA VEDO] Panoramica «Il tuo spazio»: un solo invito centrale («Scrivi cosa vuoi ottenere.
  Decidiamo insieme come farlo.»), esempio pratico, casella di messaggio in basso con invio
  disabilitato, nota «Archivio locale», campanella notifiche (badge 2), toggle sidebar e
  impostazioni. Gerarchia visiva chiara, nessun rumore.
- [COSA PROVO / ATTRITO] Nessuno: l'azione primaria è l'unica cosa da fare (G1 ok). L'etichetta
  «Fonte: simulazione | motore» NON è visibile nella schermata principale (sidebar chiusa) —
  da verificare in fase esplorativa per G6.
- [GIUDIZIO] **Eccellente** — un'unica azione possibile, ben spiegata.
- Evidenza: `assets/2026-09-22-ux-audit/step-00-panoramica-iniziale.png`

### Interazione 1 — Invio del bisogno
- [COSA VEDO] Dopo l'invio: casella svuotata, invio di nuovo disabilitato, stato
  «Homun sta elaborando…» con pulsante «Annulla». Il messaggio inviato NON appare in chat
  durante l'attesa; l'hero resta finché l'interpretazione non arriva.
- [COSA PROVO / ATTRITO] Attesa totale ~15–20 s con feedback presente e annullabile ma
  generico: non dice cosa sta aspettando l'app né un avanzamento (G2 borderline). Il mancato
  echo immediato del messaggio è un micro-attrito («è partito?») mitigato dallo stato attivo.
- [GIUDIZIO] **Accettabile** — feedback onesto ma poco informativo per un'attesa > 15 s.
- Evidenza: `assets/2026-09-22-ux-audit/step-01b-elaborazione.png`

### Interazione 2 — Proposta di lavoro
- [COSA VEDO] Conversazione creata e intitolata «Monitoraggio preventivi e risposte»; mio
  messaggio riportato in chat; regione «Proposta di lavoro» con riepilogo, attività prevista,
  risultato atteso, responsabile proposto (Elena · Coordinatore Preventivi), motivazione
  onesta (dati non ancora disponibili), prerequisiti («Prima dell'esecuzione serviranno…»),
  CTA «Crea il collaboratore e affida» + «Modifica la proposta». Pannello destro di riepilogo
  con stato «In attesa della tua conferma» e stesso CTA. Badge notifiche 2 → 3.
- [COSA PROVO / ATTRITO] Zero click extra: la proposta contiene già i tre elementi della
  missione (riepilogo, responsabilità, risultato atteso). Il CTA duplicato chat/pannello
  aiuta. L'avviso onesto sui dati mancanti è un punto di forza.
- [GIUDIZIO] **Eccellente**.
- Evidenza: `assets/2026-09-22-ux-audit/step-02-proposta-post-refresh.png`

### Test G7 — Refresh a metà flusso
- [COSA VEDO] F5 con proposta in attesa di conferma: la conversazione torna identica
  (messaggio, proposta, CTA, pannello riepilogo, badge 3). Nessuna perdita, nessun avviso
  necessario perché lo stato è integro.
- [GIUDIZIO] **Eccellente** — G7 superato su refresh a metà flusso (prima della conferma).

### Interazione 3 — Conferma: «Crea il collaboratore e affida»
- [COSA VEDO] La proposta diventa «ACCORDO DI LAVORO», stato «Concordato · in preparazione»,
  responsabile Elena attiva. Compare la scheda «Cosa serve ora» con i prerequisiti e i
  pulsanti «Aggiungi file»/«Aggiungi cartella», più la guida: «rivedi l'accordo in chat
  dicendo cosa fare». Badge notifiche 3 → 2.
- [COSA PROVO / ATTRITO] Nessuno: l'attesa successiva è chiaramente sul mio intervento.
- [GIUDIZIO] **Eccellente**.
- Evidenza: `assets/2026-09-22-ux-audit/step-03-accordo-cosa-serve-ora.png`

### Interazione 4 — Invio dei dati in chat (come suggerito dall'app)
- [COSA VEDO] Messaggio riportato subito in chat; attese oneste e a fasi («sta leggendo il
  messaggio…» → «sta preparando la proposta di accordo…») con contatore dei secondi;
  pulsanti del pannello disabilitati durante l'invio. MA dopo ~55 s l'accordo sparisce e
  compare una NUOVA proposta «PRIMA DI COMINCIARE» con titolo cambiato e un NUOVO
  collaboratore (Bruno · Coordinatore Preventivi, duplicato del ruolo di Elena); stato
  torna a «In attesa della tua conferma». Un box «Cosa cambia rispetto alla proposta
  precedente» mostra il diff.
- [COSA PROVO / ATTRITO] Ho seguito l'istruzione dell'app («rivedi l'accordo in chat
  dicendo cosa fare») e il lavoro concordato è ripartito da capo con un'altra persona.
  I dati incollati non vengono riconosciuti come materiali forniti. Perdita percepita
  dello stato di lavoro (G7 percepito, G1: percorso allungato).
- [GIUDIZIO] **Frustrante** — il percorso guida non arriva al risultato: l'invio dei
  dati riavvia l'intake invece di aggiornare il lavoro concordato. → RIPARAZIONE (D1).

### Interazione 5 — Recupero via chat («non creare Bruno, usa Elena»)
- [COSA VEDO] La proposta aggiornata rimuove Bruno («Collaboratore: Bruno → —», «Nessun
  collaboratore selezionato»); il pannello destro però continua a indicare
  «Responsabile: Elena». Al click su «Conferma il riepilogo» compare l'avviso tipizzato:
  «Qualcun altro ha aggiornato lo stesso oggetto. Ricarica e riprova.» (409).
- [COSA PROVO / ATTRITO] Il rimedio suggerito dall'app funziona a metà: toglie il doppione
  ma non riassocia Elena; la conferma fallisce con 409 (possibile causa: due schede aperte
  sullo stesso archivio locale durante la sessione — non riprodotto a scheda singola).
- [GIUDIZIO] **Accettabile** — recupero possibile ma contorto.

### Interazione 6 — Refresh dopo 409, riconferma, menzione @
- [COSA VEDO] Dopo F5 lo stato è intatto e l'avviso è scomparso (G7 ok); la riconferma
  funziona: accordo «Report preventivi attivi e scaduti», «Concordato · in preparazione».
  Però in chat l'accordo dice «Responsabile: Nessun collaboratore selezionato» mentre il
  pannello dice «Elena» (incoerenza D3). La scheda «Cosa serve ora» chiede ancora i dati
  già forniti due volte. La menzione «@Elena» — pur esistendo Elena in Squadra (1) —
  restituisce «Riferimenti disponibili: Nessun risultato» (D2), nonostante l'aiuto
  a schermo dica «Usa @ per un collaboratore».
- [GIUDIZIO] **Frustrante** — il collaboratore creato dall'app non è indirizzabile e il
  percorso non sblocca il risultato. → RIPARAZIONE.
- Evidenza: `assets/2026-09-22-ux-audit/step-04-stato-blocco-accordo.png`

### Verifica G6 — Etichetta «Fonte: simulazione | motore»
- [COSA VEDO] In nessuna schermata visitata (principale, sidebar aperta, impostazioni →
  Spazio e profilo / Modelli e budget / Dati della demo) compare l'etichetta
  «Fonte: simulazione | motore». Presenti solo indicatori indiretti («Sessione locale»,
  «Archivio locale», «Le richieste chat (Fonte motore) usano questo collegamento»).
  Su questa superficie web il selettore non è raggiungibile nemmeno in 3+ click.
- [GIUDIZIO] **Goal G6 violato** sulla superficie web (D4) — e la sessione era di fatto
  «Fonte: motore» senza dichiararlo.
- Nota: contatori incoerenti in «Dati della demo» (0 lavori / 0 progetti / 0 materiali)
  contro sidebar con 19-20 compiti e 15 conversazioni (D6).

## Riparazioni (modalità RIPARAZIONE)

### D1 — La revisione post-accordo scartava il collaboratore in carica
- **Sintomo**: dopo l'accordo con Elena, l'invio in chat dei materiali (come suggerito
  dall'app) generava una NUOVA proposta «PRIMA DI COMINCIARE» con un nuovo collaboratore
  (Bruno, duplicato del ruolo), tornando a «In attesa della tua conferma». Il percorso
  guida non sboccava.
- **Causa**: `stabilize` preserva solo title/objective/output/constraints/capability;
  `preserve_staffing` preservava lo staffing solo per `compare_csv` senza proposte. Per
  capability `general` il modello poteva inventare un profilo gemello (il prompt stesso
  dice «Scegli un nome non già presente nel catalogo»).
- **Fix** (2 file motore + test):
  - `engine/src/homun/application/intake_brief.py` — `preserve_staffing` esteso: una
    revisione che non dichiara `staffing` in `changed_fields` non può cambiare il
    collaboratore responsabile; il collaboratore in carica è risolto dall'ancora
    (agente suggerito, oppure new_agent confermato ritrovato per nome) con fallback sul
    `work.owner_id`. La vecchia regola «brief eseguibile svuotato resta confermabile»
    ora vale per ogni capability.
  - `engine/src/homun/application/intake.py` — passa `owner_id=work.owner_id`.
  - `engine/tests/test_intake.py` — 2 test nuovi
    (`test_undeclared_staffing_swap_keeps_standing_collaborator`,
    `test_declared_staffing_swap_is_honored_after_new_agent_confirmation`).
- **Verifica**: suite motore 456 passati / 1 skip; riesecuzione del percorso in app →
  revisione con «Collaboratore: — → Elena», «Ti propongo: Elena», CTA «Conferma e affida»,
  conferma riuscita con responsabile Elena coerente in chat e pannello.
- Evidenza prima: `step-04-stato-blocco-accordo.png`; dopo: `step-05-dopo-fix-revisione-elena.png`.

### D2 — La menzione @ non trovava i membri della squadra del motore
- **Sintomo**: «@Elena» → «Riferimenti disponibili: Nessun risultato» pur esistendo Elena
  in Squadra; l'aiuto a schermo promette «Usa @ per un collaboratore».
- **Causa**: i riferimenti del composer derivavano solo dagli scenari demo (simulazione);
  gli agenti creati via motore non erano inclusi.
- **Fix** (2 file web):
  - `apps/web/src/components/builder/ConversationWorkspaceChatStage.tsx` — `mentionRefs`
    esteso con gli agenti attivi del motore (deduplicati per nome contro gli scenari).
  - `apps/web/src/components/builder/ConversationWorkspace.tsx` — passa
    `engineAgents={engine.backend === "engine" ? engine.agents : undefined}`.
- **Verifica**: digitato «@Elena» → il menu propone Elena; invio con menzione funzionante.

Verifica complessiva: `npm run check` verde (typecheck, 193 test, build, build prototipo);
`cd engine && .venv/bin/pytest -q` verde (456 passati, 1 skip). Motore riavviato sul profilo
esistente. Nessun commit eseguito (non richiesto).

## Diario UX (dopo le riparazioni)

### Interazione 7 — Ripresa dal punto d'interruzione (post-fix)
- [COSA VEDO] «@Elena» ora propone Elena nel menu menzioni; il messaggio con dati viene
  riportato subito in chat; attese a fasi con contatore; dopo ~40 s la revisione mostra
  «Cosa cambia»: Vincoli aggiunti e «Collaboratore: — → Elena»; «Ti propongo: Elena»;
  CTA «Conferma e affida»; pannello e chat dicono la stessa cosa.
- [GIUDIZIO] **Eccellente** — il percorso guida ora prosegue senza perdere il collaboratore.
- Evidenza: `step-05-dopo-fix-revisione-elena.png`

### Interazione 8 — Chiusura dell'incarico (tentativo)
- [COSA VEDO] Menu Azioni della chat: Rinomina / Sposta in un progetto / Crea progetto /
  Rendi ricorrente — **nessuna chiusura**. Vista Compiti: filtro di ricerca efficace
  (1 risultato), pannello dettagli con scadenza e solo «Apri conversazione». Nessuna
  azione per chiudere un lavoro di sola preparazione.
- [COSA PROVO / ATTRITO] Il «titolare» che ha finito non ha modo di dichiararlo; lo stato
  resta «Concordato · in preparazione» per sempre. G1/G5 sul passaggio finale.
- [GIUDIZIO] **Accettabile** per questa build (limite di prodotto noto: chiusura legata
  alla verifica dei risultati eseguibili) → D7 in backlog.
- Nota: nella sidebar lo stesso lavoro è comparso sia «Concordato · in preparazione» sia
  «Da concordare» in momenti diversi della navigazione (D9).

### Interazione 9 — Variante: input volutamente sbagliato/parziale
- [COSA VEDO] Inviato «prevented» (vago, errato). Homun risponde in chat: «Il messaggio
  'prevented' è ambiguo… ho bisogno di sapere esattamente cosa è stato prevenuto e in
  quale contesto», spiegando che nessun lavoro è stato avviato e nessun collaboratore
  assegnato. Pannello coerente («Da concordare», «Obiettivo da concordare», «Homun
  coordina finché non confermi un collaboratore»).
- [COSA PROVO / ATTRITO] Recupero onesto e guidato (G5 ok). Neo: la risposta mostra ID
  interni grezzi («Candidati: @Fabio: Fabio (person_fabio); @Elena: Elena
  (agent_DrvpyLtpiNJ-yQ)») — gergo interno esposto all'utente (D10, P2).
- [GIUDIZIO] **Eccellente** (a parte la fuga di ID).
- Evidenza: `step-06-variante-input-ambiguo.png`

## Seconda sessione (stessa data): risoluzione del backlog

Su richiesta del titolare, tutti i difetti in backlog sono stati corretti e verificati in app
(motore su 8765 riavviato con `SO_REUSEADDR` per eliminare anche l'attrito dei restart in
TIME_WAIT — `[Errno 48] Address already in use` incontrato due volte in sessione).

### D7 — Chiusura dei lavori di sola preparazione
- Scoperta: il comando **`work.cancel` esisteva già nel motore** (handler, policy, transizione
  DRAFT→CANCELLED, test dedicati) — era la web a non esporlo mai.
- Fix (web): nuovo `apps/web/src/lib/engine-work-lifecycle.ts` (`closeEngineWork` →
  `work.cancel` con `expected_version`); `closeWork` in `useEngineWorkspace`; sezione
  «Chiudi il lavoro» con conferma in due passaggi ed errori tipizzati in
  `EngineWorkspaceWorkPanel.tsx` (visibile per accordi confermati e stati pausable/failed);
  etichetta stato `cancelled` → «Chiuso» e messaggio pannello/chat coerenti
  (`engine-work-status.ts`, `engine-project-projection.ts`, `ConversationWorkspaceChatStage.tsx`).
- Verificato in app: chiuso «Report preventivi attivi e scaduti» → sidebar e pannello
  «Chiuso», nota «Lavoro chiuso senza eseguirlo: l'accordo resta nello storico».

### D4 — Etichetta Fonte sempre visibile
- Fix: la topbar ora dichiara «Fonte: motore · Sessione locale · Fabio» in modalità motore e
  «Fonte: simulazione · Vista demo…» in simulazione (`ConversationWorkspaceTopbar.tsx`).
- Verificato in app su ogni schermata (la topbar è comune a tutte le viste).

### D5 — 409 senza recupero guidato
- Fix: `useWorkIntake.confirm` estende il recupero già esistente per il 404 anche al
  `version_conflict`: ricarica la proposta fresca invece dell'errore secco; testo dell'errore
  riscritto in modo onesto per il contesto locale (`homun-errors.ts`).

### D9 — Stato sidebar oscillante
- Causa: `engineIntakeConfirmed` era derivato solo dall'intake caricato per il lavoro attivo.
- Fix (motore): `has_confirmed_intake` in `policy/intake.py`; la lista e il dettaglio lavori
  espongono `intake_confirmed` (`routes/reads.py`); il bridge web lo riporta su ogni lavoro
  (`conversation-engine-bridge.ts`). Test nuovo
  `test_works_list_reports_intake_confirmed_for_stable_labels`.
- Verificato in app: «Concordato · in preparazione» stabile già al primo caricamento,
  senza regressioni navigando.

### D10 — ID interni in chat
- Fix: `format_interpretation_for_chat` (`models/interpret.py`) non include più gli id grezzi
  nei «Candidati» — solo nomi visibili. (I messaggi storici già salvati restano come erano.)

### D6 — Contatori «Dati della demo»
- Fix: i contatori contano la sorgente viva (`visibleWorks`, progetti proiettati); in modalità
  motore il conteggio materiali dice «nei progetti» invece di uno zero falso
  (`ConversationWorkspace.tsx`, `ConversationSettings.tsx`).
- Verificato in app: «20 lavori · 5 progetti · nei progetti materiali».

### D8+D11 — Primo messaggio senza eco, attese mute
- Fix: il primo invio dalla Panoramica ora crea il lavoro-bozza, **apre subito la
  conversazione** e affida il messaggio a `postMessage` (nuovo helper
  `engine-first-send.ts`; `createWork(..., draftOnly)` in `useEngineWorkspace`): eco immediato
  e attese a fasi con contatore («sta leggendo… → sta preparando la proposta di accordo…»).
  Corretta in corsa una gara scoperta nei test: il cambio lavoro cancellava l'overlay
  dell'eco durante il turno in flight (`useEngineTranscript.ts` ora lo preserva se contiene
  messaggi parziali). Testo del residuo stato del composer reso onesto
  («Homun sta aspettando la risposta del modello…», `ConversationWorkspaceChatStage.tsx`).
- Verificato in app end-to-end: eco → attesa a fasi → proposta «Organizzazione manutenzione
  officina» arrivata.

### D12 — «Nuovo» profilo con lo stesso nome del collaboratore in carica (residuo di D1, trovato su desktop)
- **Sintomo**: sulla shell desktop, la revisione post-accordo proponeva Elena come
  new_agent (stesso nome) dichiarando lo staffing cambiato: il guard D1 onorava la
  dichiarazione e confermando si sarebbe creato un duplicato in squadra.
- **Fix**: `preserve_staffing` tratta un new_agent il cui nome coincide (casefold) col
  collaboratore in carica come la stessa persona e lo ri-ancora come agente esistente,
  anche con `staffing` dichiarato; la dichiarazione vince solo per un cambio reale (nome
  diverso). Test nuovi:
  `test_same_name_new_agent_reproposal_is_reanchored_not_duplicated`.
- **Verifica**: percorso desktop — revisione con «Conferma e affida» e «Collaboratore»
  tra i campi invariati; store con un solo agente Elena dopo la conferma.

Vincoli rispettati: `ConversationWorkspace.tsx` **sotto** il budget architettura (1429 ≤ 1431,
baseline abbassato come richiesto dal checker); nessun commit eseguito.
Verifica finale: `npm run check` verde (193 test), suite motore 458 passati / 1 skip,
test desktop 8/8.

## Tabella dei difetti (aggiornata a fine seconda sessione)

| ID | Descrizione | Goal violato | Priorità | Stato | Evidenza |
|----|-------------|--------------|----------|-------|----------|
| D1 | Revisione post-accordo con collaboratore gemello | G1, G7 percepito | P1 | **Corretto** (prima sessione) | step-04 → step-05 |
| D2 | Menzione @ senza agenti motore | G1, G5 | P1 | **Corretto** (prima sessione) | step-05 |
| D3 | Responsabile incoerente chat/pannello | coerenza | P2 | **Corretto** (da D1) | step-05 |
| D4 | Etichetta «Fonte» assente | **G6** | P1 | **Corretto** (topbar esplicita) | step-07 |
| D5 | 409 senza recupero guidato | G7 | P2 | **Corretto** (ricarica guidata + testo onesto) | — |
| D6 | Contatori demo incoerenti | coerenza | P2 | **Corretto** (sorgente viva) | — |
| D7 | Nessuna chiusura per lavori di preparazione | G1, G5 | P1 | **Corretto** (`work.cancel` esposto in UI) | step-07 |
| D8 | Primo messaggio non ecoato | G2 | P2 | **Corretto** (apertura immediata + eco) | — |
| D9 | Stato sidebar oscillante | coerenza | P2 | **Corretto** (`intake_confirmed` dal motore) | — |
| D10 | ID interni in chat | G4/G5 | P2 | **Corretto** (nomi soltanto) | — |
| D11 | Attese mute/monolitiche | G2 | P2 | **Corretto** (fasi + testo onesto ovunque) | — |
| D12 | new_agent con nome uguale al collaboratore in carica → duplicato in squadra | G1, coerenza | P1 | **Corretto** (ri-ancoraggio stesso-nome; trovato e verificato su desktop) | step-08 |

Con D7 corretto e la shell Electron verificata (sezione sotto), il percorso guida
«primo collaboratore» risulta completabile dalla A alla Z su **entrambe** le superfici
(web e desktop).

## Verifica sulla shell Electron (dopo concessione del permesso Accessibilità)

Condizioni: permesso Accessibilità concesso all'helper ZCode Computer Use; helper riavviato
per farglielo rileggere (due processi helper erano antecedenti alla concessione).

**Esito della verifica automatica dello stack (verde)** — smoke test integrato su profili
temporanei dedicati (`HOMUN_DESKTOP_PROFILE`/`HOMUN_DESKTOP_DATA_DIR`, come da regole del
repo: il profilo reale non è stato toccato):

```
HOMUN_DESKTOP_SMOKE {"rendered":true,"nodeHidden":true,"sessionHidden":true,
"health":200,"unauthenticated":401,"keychainAvailable":true,"syntheticRoundtrip":true}
```

Il renderer raggiunge il proprio motore tramite il proxy stesso-origine `homun://app/engine`
(Bearer iniettato dal main), il token è richiesto esternamente, la keychain cifra.

**Esito della verifica interattiva UX (COMPLETATA dopo il flag di accessibilità).**
Aggiunta `app.setAccessibilitySupportEnabled(true)` nel `whenReady` del main Electron
(vere test desktop 8/8): il contenuto web diventa leggibile/azionabile via accessibilità
(vedi `apps/desktop/src/main.cjs`). Nota diagnostica utile anche al sviluppo:
`engine-process.cjs` ora salva lo stderr del motore figlio su file quando è impostata
la variabile `HOMUN_ENGINE_DEBUG_LOG` (opt-in; in questa sessione ha escluso subito
un falso «motore non avviato» causato in realtà da un lancio con directory di lavoro
sbagliata).

Percorso guida A→Z eseguito sulla shell vera (profilo motore temporaneo, provider
Ollama locale, primo avvio pulito), con verifica a terra a ogni passo sullo store
SQLite del motore di test:

- bisogno in linguaggio naturale → **eco immediato** e attese a fasi con contatore
  («Homun sta leggendo il messaggio… N s») — D8/D11 su desktop;
- topbar **«Fonte: motore · Sessione locale · Fabio»** su ogni schermata — D4 su desktop;
- proposta (Elena · Analista Tracciamento Preventivi) con capability `general` onesta →
  conferma → accordo; store: 1 agente creato;
- dati in chat → revisione che **mantiene Elena** e CTA «Conferma e affida» — D1 su
  desktop (dopo il perfezionamento stesso-nome, vedi D12);
- conferma revisione → ACCORDO «Report preventivi clienti» («Concordato · in preparazione»);
- **«Chiudi il lavoro» → conferma → stato «Chiuso»** — D7 su desktop; store: 12 comandi,
  lavoro `cancelled`, **un solo agente Elena** (nessun duplicato).

Durante il percorso è emerso e stato corretto un residuo di D1 (D12 sotto).
Evidenza: `assets/2026-09-22-ux-audit/step-08-desktop-chiuso.png`.

## Le 3 cose da fare dopo (aggiornate)

1. **Leggere la Fonte anche nel pannello Impostazioni e nelle viste Studio** (la topbar ora
   copre tutte le viste del workspace; gli spazi Studio hanno chrome propri).
2. **Chiusura con esito**: oggi «Chiudi» archivia senza esecuzione; il passo successivo di
   prodotto è la chiusura con risultato visibile per i lavori general (bozza/riepilogo
   prodotto dal collaboratore), collegata al piano multi-fase già in roadmap.
3. **Decidere la wording di produzione per la Fonte**: la regola di repo vieta la parola
   «motore» nell'UI di produzione; l'etichetta attuale è da prototipo e andrà mappata su
   un nome di prodotto prima del rilascio.
