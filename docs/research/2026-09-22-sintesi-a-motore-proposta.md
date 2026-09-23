# Proposta — Sintesi a motore (la fetta che accende il modello per agente)

> Stato: proposta accettata in conversazione («procedi»), 22/09/2026.
> Contesto: gap analysis 22/9 — «il legame agente↔modello è dormiente
> nell'esecuzione perché le fasi eseguibili sono deterministiche. Diventa
> operativo con la fetta sintesi a motore».

## 1. Il problema

Oggi il motore sa eseguire due attività deterministiche (confronto CSV,
lettura materiale) e tutto il resto è `general`: preparazione in chat, con
rifiuto onesto («creare un catalogo non diventa un price comparison»). Il
risultato promesso dal prodotto — delegare lavoro scritto vero a un
collaboratore — non esiste ancora. Il modello per agente
(`preferred_connection_id`) è persistito e validato ma mai usato
nell'esecuzione.

## 2. Il principio

Una **fase di sintesi** è una fase esegubile come le altre, con una
differenza dichiarata: l'esecutore è il **modello del collaboratore
assegnato a quella fase**, non un algoritmo deterministico. Tutto il resto
resta identico al contratto già validato:

- proposta durabile con digest (materiali scelti, fase, versione);
- **approvazione solo persona** (il via della fase è supervisionato);
- esecuzione fuori transazione, artifact tramite `work.submit_artifact`,
  lavoro in REVIEW (mai auto-accettato);
- budget e tentativi registrati come per interpret/intake;
- provenienza sempre visibile: quale modello, quale connessione (del
  collaboratore o fallback dichiarato dello spazio), quali materiali.

Nessuna esecuzione in silenzio: identica alla lettura materiale, cambia
solo il motore dell'atto (modello invece di parser).

## 3. La capability `synthesize`

Nuova voce nel registro (`domain/capabilities.py`), kind executable:

- id `synthesize`, tool_version `model-synthesis-v1`;
- summary: sintesi/redazione scritta dal modello del collaboratore assegnato;
- input: lavoro con materiali attivi (opzionali) + procedure approvate (L0);
- output: artifact Markdown in revisione umana;
- effects: chiama il modello del collaboratore; nessun invio esterno;
- limiti: max 6 materiali, 24.000 caratteri di contesto, 8.000 caratteri
  di output, 2 tentativi;
- fallback_collaborator: un profilo di redazione (es. Elena), come Aurora
  per il confronto.

Conseguenze oneste sull'intake: la mappa dei rifiuti cambia. «Prepara il
catalogo per Acme» oggi è `general` con rammarico; con `synthesize` diventa
una scala reale (raccolta/lettura → sintesi). `general` resta per il lavoro
davvero di sola coordinazione. Il prompt dell'intake va aggiornato in
questo senso (it + en), senza gonfiare le promesse: la sintesi produce una
**bozza in revisione**, non un risultato inviato.

## 4. Esecuzione (application/synthesis.py, pattern material_read)

1. **propose** (persona o agente owner): ammissione per fase
   (`require_confirmed_intake_for_tool` con capability `synthesize`),
   scelta dei materiali (estratti, attivi, entro i limiti), pin versione
   (`propose_pin_version`), digest su id+lavoro+versione+tool+materiali.
2. **approve** (solo persona, owner/reviewer): digest + versione correnti,
   `approve_starts_phase` (il via della fase).
3. **execute** (fuori transazione, ripetibile):
   - contesto: obiettivo, vincoli, output atteso della fase, estratti dei
     materiali con riga di provenienza, indice L0 delle procedure approvate;
   - prompt di sistema `synthesis/compose.{it,en}.txt`: identità
     professionale dell'assegnatario (responsabilità, specializzazioni,
     metodo, tono, istruzioni), divieto di inventare dati fuori dai
     materiali, lingua della richiesta;
   - chiamata `registry.complete(..., connection_id=...)`: la connessione
     **preferita dell'agente assegnato**, fallback onesto alla connessione
     attiva dello spazio (dichiarato nella provenienza dell'artifact);
   - artifact: intestazione di provenienza (modello, connessione usata e
     perché, materiali, limiti) + testo del modello, troncato con avviso
     esplicito se supera il limite;
   - messaggio onesto in chat («Sintesi pronta: bozza in revisione»);
   - tentativo registrato (`UsageAttempt`, purpose `synthesize`) e budget
     del lavoro riservato/rianalizzato attorno alla chiamata.
4. Fallimento modello: proposta `failed` con codice, lavoro FAILED come per
   la lettura; la persona riprova con una nuova proposta.

## 5. Prima fetta (motore, end-to-end)

- [x] Capability `synthesize` + TRANSPORT_IDS (fatto, 22/9).
- [x] Letterali intake (`capability`, `PlanStepDraft`, route) + prompt intake
  onesto (it+en): scrivere/redigere/sintetizzare da materiali → synthesize;
  `general` resta per azioni fuori dal motore (fatto, 22/9).
- [x] Prompt `synthesis/compose` it+en (identità dell'assegnatario, regole
  anti-invenzione, lingua della richiesta) (fatto, 22/9).
- [x] `application/synthesis.py` + `synthesis_execution.py` +
  `routes/synthesis.py` + workflow DBOS `synthesis` collegato a pump e
  dispatcher (fatto, 22/9).
- [x] Test (8): flusso completo con provider fake; connessione preferita
  onorata e dichiarata; fallback onesto; digest alterato rifiutato;
  ammissione per fase su piano multi-fase (capability general con fase
  synthesize); artifact in REVIEW con provenienza; fallimento modello onesto;
  budget del lavoro conta il tentativo. Suite: 496 verdi.

## 6. Seconda fetta (web + verifica dal vivo)

- Sezione «Sintesi» nel pannello del lavoro (pattern sezione strumenti):
  scelta materiali (riuso del selettore esistente), «Prepara la sintesi»
  (non esegue), «Approva ed esegui», esito in revisione.
- La fase nella scala del piano mostra l'esecuzione con la stessa onestà
  delle altre (attesa, esito, revisione).

## 7. Fuori da questa fetta

- Iterazioni automatiche (cicli richiesta-modifiche senza persona): ogni
  esecuzione è sempre un atto approvato.
- Skill L1/L2 (corpi completi nel contesto): qui resta l'indice L0.
- Strumenti MCP dentro la sintesi (agente che chiama tool in loop): fetta
  «ponte strumento→fase», separata.
- Scelta del modello per singola esecuzione: la connessione è quella del
  collaboratore, cambiata dalla sua scheda, non per lavoro.

## 8. Realizzazione fetta 2 — web e verifica dal vivo (22/09/2026)

- **Web**: sezione «Scrivi la sintesi» (pattern Lettura materiali, riuso di
  `EngineMaterialSelection` e `useConflictRecovery`): scelta documenti (0-6,
  anche nessuno — la bozza nasce da obiettivo e vincoli), «Prepara la
  sintesi» (proposta durabile, non esegue), «Approva ed esegui sintesi»,
  attesa onesta «il modello sta scrivendo la bozza», esito con modello e
  connessione dichiarati. Montata per capability (`synthesize`) e per fase
  corrente nel pannello; etichette capacità aggiornate ovunque (intake
  display, attività prevista, prossimo passo, tipo fase aggiungibile).
- Verificato dal vivo (modello reale qwen3.5:4b su Ollama): richiesta
  «Prepara il catalogo prodotti per Acme» → intake sceglie `synthesize`
  (rationale onesto, collaboratore proposto Elena) → conferma → due listini
  selezionati → proposta → approvazione → attesa → bozza reale in REVIEW
  con provenienza («Sintesi di Elena · modello qwen3.5:4b · connessione
  attiva dello spazio (nessuna dedicata) · materiali: 2») → revisione
  approvata → lavoro completato. Chat: «Sintesi pronta… Fonte: motore» e
  «Lavoro completato». Budget del lavoro conteggiato.
- Fix collaterali: lista fasi del pannello ora impila titolo e stato
  (span/small inline facevano collassare la riga), bug pre-esistente.
