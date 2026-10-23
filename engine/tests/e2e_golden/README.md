# Banco di prova del «percorso d'oro» (marcatore `golden`)

Questa suite misura, con **modelli veri**, il flusso base che una persona sola
deve poter compiere ogni giorno: chiedere in chat, affidare un lavoro,
usare materiali, programmare una routine. Non corregge i bug che trova: li
registra in un rapporto, perché sono la situazione di partenza da migliorare.

È **esclusa** dalla suite normale e dalla CI (in `engine/pyproject.toml`
`addopts = "-m \"not golden\""`); si lancia solo a mano e costa tempo — e con
il provider cloud anche denaro.

## Come si lancia

```bash
# Locale: Ollama attivo su http://127.0.0.1:11434/v1
cd engine && HOMUN_GOLDEN_PROVIDER=local .venv/bin/pytest -m golden -q

# Cloud via Ollama (modelli «:cloud», stesso demone locale, nessuna chiave):
cd engine && \
  HOMUN_GOLDEN_PROVIDER=cloud \
  HOMUN_GOLDEN_CLOUD_MODEL="glm-5.3-flash:cloud" \
  .venv/bin/pytest -m golden -q

# Cloud con endpoint OpenAI-compatibile qualsiasi (serve la chiave):
cd engine && \
  HOMUN_GOLDEN_PROVIDER=cloud \
  HOMUN_GOLDEN_CLOUD_BASE_URL="https://api.openai.com/v1" \
  HOMUN_GOLDEN_CLOUD_MODEL="gpt-4o-mini" \
  HOMUN_GOLDEN_CLOUD_API_KEY="…" \
  .venv/bin/pytest -m golden -q
```

Variabili:

| Variabile                     | Significato                               | Predefinito               |
| ----------------------------- | ----------------------------------------- | ------------------------- |
| `HOMUN_GOLDEN_PROVIDER`       | `local` (Ollama) oppure `cloud`           | obbligatorio              |
| `HOMUN_GOLDEN_LOCAL_MODEL`    | modello Ollama da usare                   | `qwen3.5:4b`              |
| `HOMUN_GOLDEN_CLOUD_BASE_URL` | endpoint OpenAI-compatibile               | Ollama locale (`…/v1`)    |
| `HOMUN_GOLDEN_CLOUD_MODEL`    | modello cloud                             | obbligatorio per cloud    |
| `HOMUN_GOLDEN_CLOUD_API_KEY`  | chiave (mai nei log né nei rapporti)      | richiesta solo per remoto |
| `HOMUN_GOLDEN_RUNS`           | ripetizioni per scenario                  | `3`                       |
| `HOMUN_GOLDEN_REPORTS_DIR`    | dove scrivere i rapporti (prove parziali) | `reports/`                |

Se il provider scelto non è raggiungibile (Ollama spento, modello mancante,
endpoint cloud irraggiungibile) la sessione **si salta** con un messaggio
chiaro: non è un fallimento.

### Quale modello cloud

I modelli Ollama «:cloud» si usano dallo stesso demone locale e si pagano a
token ([prezzi](https://ollama.com/pricing)). Per questa suite servono buon
italiano e rigore nel JSON strutturato (l'interpretazione della chat); i più
economici adatti (ottobre 2026, $ per milione di token in/out):

- `glm-5.3-flash:cloud` — 0,15 / 0,50 — la scelta predefinita
- `gpt-oss:120b-cloud` — 0,15 / 0,60 — alternativa altrettanto economica
- `deepseek-v4.1-flash` — 0,30 / 1,20 (la metà fuori picco)

Una sessione completa (3 run per scenario) consuma dell'ordine di 200–400 K
token in entrata e 50–100 K in uscita: **~0,05–0,15 $** con i modelli sopra.
Un modello mancante si registra al volo: `ollama pull gpt-oss:120b-cloud`.

Con un endpoint remoto la chiave viaggia solo nella richiesta HTTP verso il
motore, che la conserva nel suo archivio segreti dentro la data dir temporanea
della sessione, distrutta a fine esecuzione. Non viene mai scritta dalla
suite, nei log o nei rapporti. Lo scenario **B7** misura proprio il caso di una
connessione creata dalla persona con un nome suo: finché resta rosso, con un
endpoint remoto i run adattivi (agente) finiscono «blocked» anche negli altri
scenari; con Ollama, modelli `:cloud` inclusi, la suite passa dal preset
(connessione `openai_compatible`) e il percorso resta misurabile.

## Come lavora la suite

- Ogni esecuzione avvia il **motore come processo reale**
  (`python -m homun serve`) su una porta libera di loopback, con data dir
  temporanea nuova (mai `~/Library/Application Support/`) e token di sessione
  generato. Parlare con lui avviene **solo via HTTP**, con gli stessi
  endpoint della UI web (`apps/web/src/lib`): niente scorciatoie nel proceso.
- Ogni scenario gira **N volte** (`HOMUN_GOLDEN_RUNS`): il risultato è il
  **tasso di successo**, non un singolo passa/fallisce, perché i modelli non
  sono deterministici.
- I test verificano **gli effetti** tramite API (lavoro creato, stato,
  risultato presente, messaggio successivo accettato), non la formulazione
  dei testi. Dove serve giudicare un testo, i controlli sono robusti: la nota
  deve contenere «30 novembre» e «12.000»; i riassunti devono citare fatti
  che esistono **solo** dentro i file di prova.
- Ogni storia è una sequenza di **passi** (`A2.messaggio-2`, `B2.conferma`);
  un passo che fallisce interrompe quel run e i passi successivi risultano
  «non tentati». Le **sonde** (`run.probe`) misurano un aspetto senza
  interrompere la storia: contano nel tasso dello scenario, ma lasciano
  correre il resto (es. il preview delle prossime esecuzioni in D1).

## Cosa misura ogni scenario

| Scenario | Cosa misura                                                                                                                                                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0       | La connessione modello si configura e si verifica (Impostazioni → Modelli)                                                                                                                                                               |
| A1       | Una domanda semplice («Cosa sai fare?») riceve una **risposta testuale** (nessun chiarimento, nessuna proposta: il solo «nessun lavoro creato» non basta) e non crea lavori                                                              |
| A2       | Tre messaggi di fila nella stessa conversazione: tutti accettati, nell'ordine giusto                                                                                                                                                     |
| A3       | Dopo un errore provocato (connessione modello rotta) il messaggio successivo è accettato                                                                                                                                                 |
| A4       | La conversazione si ritrova nell'elenco e si riprende dopo il riavvio del motore                                                                                                                                                         |
| A5       | Dopo una proposta di accordo, «grazie» riceve una risposta testuale e non crea né cambia proposte                                                                                                                                        |
| A6       | Una risposta **vuota** del modello (stub OpenAI-compatibile in `fixtures/empty_model.py`) produce un errore tipizzato e chiaro (`model.empty_response`), e il messaggio successivo è accettato **subito**, senza finestra di tentativi   |
| B2       | La conferma della proposta porta il lavoro in esecuzione fino al risultato                                                                                                                                                               |
| B3       | Il risultato contiene i fatti dati e non ne inventa altri                                                                                                                                                                                |
| B4       | Una correzione motivata produce una nuova versione del risultato                                                                                                                                                                         |
| B5       | Il lavoro sta fra i Compiti e il risultato approvato fra i Documenti                                                                                                                                                                     |
| B6       | La stessa richiesta mandata come **messaggio successivo** di una conversazione esistente (dopo «Cosa sai fare?») è accettata e produce una proposta di lavoro o un chiarimento, non un errore; un terzo messaggio («grazie») è accettato |
| B7       | Un lavoro eseguito con una **connessione creata dalla persona con un nome suo** (Impostazioni → Modelli) arriva al risultato; la chat con l'agente sulla stessa connessione risponde                                                     |
| B8       | Una richiesta **vaga** («Crea una relazione sui fornitori 2027») produce un chiarimento o una proposta con `missing_information` non vuoto; il lavoro resta in bozza, senza piano, senza accordo confermato                              |
| B9       | La richiesta di lavoro come **primo messaggio** inviata con `conversation.post_message` produce una proposta di accordo in attesa di conferma; è anche l'apertura del percorso B (B2–B5 partono da qui)                                  |
| B10      | La **modifica di un accordo confermato** chiesta in chat («sposta la scadenza al 15 dicembre») produce una proposta di revisione con il diff dell'accordo; confermandola, l'accordo riflette la modifica                                 |
| C1       | Un progetto con 2 file di prova (`.md` e `.pdf` generati in `fixtures/`) diventa leggibile                                                                                                                                               |
| C2       | «Trova scadenze e responsabili nei materiali»: il risultato cita i contenuti veri dei file                                                                                                                                               |
| C3       | Il riassunto di un file ne presenta i punti chiave                                                                                                                                                                                       |
| D1       | «Ogni lunedì alle 9»: la routine si salva con la pianificazione giusta (`0 9 * * 1`, Europe/Rome); il suo `next_run_at` e lo `scheduled_for` dell'esecuzione reale (D2) coincidono con occorrenze dell'anteprima                         |
| D2       | L'esecuzione della routine produce il suo lavoro ricorrente supervisionato                                                                                                                                                               |
| D3       | Dopo il riavvio del motore la routine esiste ancora ed è attiva                                                                                                                                                                          |

Precisazioni oneste:

- **B4** passa quando la correzione produce una **nuova versione**; se il
  modello recepisce davvero la motivazione («sezione Rischi») si vede
  nell'estratto del rapporto, ma non è criterio di fallimento.
- **D1** ha tre sonde oltre ai passi di creazione: la prossima occorrenza
  dell'anteprima è lunedì alle 9; `next_run_at` della routine è una delle
  occorrenze dell'anteprima; dopo D2, lo `scheduled_for` del lavoro reale è
  una delle occorrenze che l'anteprima della routine al minuto mostrava
  **prima** di crearla. Anteprima ed esecuzione devono usare lo stesso calcolo
  (`routine_schedule.next_occurrences`): la sonda misura proprio questo.
- **D2**: non esiste un endpoint «esegui ora» per le routine (né in UI né in
  API). L'esecuzione forzata usa una routine con cadenza al minuto e attende
  l'occorrenza reale del battito del motore (lo schedule unico
  `homun-routine-tick`, ogni minuto in UTC, che avvia le routine con
  `next_run_at` scaduto). L'occorrenza crea un lavoro supervisionato con le
  fasi del modello: quello è il risultato della routine, come da guida d'uso.
- **A3**: dopo un errore di trasporto (connessione irraggiungibile) il motore
  programma tentativi automatici; con la porta d'ingresso un messaggio nuovo
  non viene più rifiutato per questo (ha la precedenza e annulla i tentativi),
  ma la suite continua a tollerare la finestra di retry del motore (~40-60 s)
  per misurare onestamente anche i motori precedenti.
- **A6** usa uno stub OpenAI-compatibile che risponde sempre vuoto
  (`fixtures/empty_model.py`, porta libera di loopback, non 11434): la risposta
  vuota riceve UN promemoria e un nuovo tentativo, poi il turno finisce con
  `model.empty_response`; il messaggio successivo deve passare al primo colpo.
- **B1 non esiste più**: misurava la coppia classifica → proposta intake via
  API (`POST …/intake/classify` + `POST …/intake`), la strada che la UI non
  percorre più da quando ogni messaggio passa dalla porta d'ingresso
  (`conversation.post_message`, turno nativo a strumenti in
  `application/sessions/front_door`). Portata su `post_message`, B1 diventava
  identica a B9: sono state **unificate** — il percorso B apre con i passi di
  B9 (primo messaggio → proposta di accordo) e prosegue con B2–B5; B9 resta
  anche scenario autonomo come segnale veloce, separato dai fallimenti
  d'esecuzione. B6 misura la stessa strada come messaggio successivo (dopo
  «Cosa sai fare?», con il passo «richiesta» da sonda: se viene rifiutato, il
  rapporto ne registra `code` e `reason` e «grazie» si misura comunque), B8 con
  una richiesta vaga.
- **B10** misura la revisione di un accordo confermato chiesta in chat: prima
  la UI la otteneva con `classify` + `POST /intake`; ora la chiede la persona
  con un messaggio («sposta la scadenza al 15 dicembre»), il turno di ingresso
  richiama `propose_work` con `changed_fields` e il motore produce la proposta
  di revisione con il diff (`changes`); la conferma applica la modifica
  all'accordo.
- **B7** crea la connessione come il modale Modelli (`POST /models/connections`
  con id e nome scelti dalla persona, poi attivazione e verifica) e usa un
  lavoro con un passo adattivo esplicito (`plan.propose` con capability
  `agent_run`, come fa il motore per i lavori chat e le routine) perché la
  capability scelta dall'intake non è deterministica. Esecuzione e chat sono
  sonde: si misurano entrambe.

## Come si legge il rapporto

A fine sessione la suite scrive in `reports/`:

- `<data>-<provider>.md` — il rapporto leggibile;
- `<data>-<provider>.json` — gli stessi dati in forma strutturata.

Una seconda misura nello stesso giorno non sovrascrive la prima: prende il
suffisso `-2`, `-3`… (`<data>-<provider>-2.md`), così il prima/dopo di una
correzione resta leggibile in `reports/`.

Ogni riga della tabella è uno scenario: **successo N/M**, tentati, durata
media. Un run la cui storia si è fermata in uno scenario precedente (per
esempio C3 quando C2 fallisce) conta come **tentato e fallito** per lo scenario
mai raggiunto — la colonna «Tentati» dice quanti sono gli «interrotti prima» —
e il suo fallimento riporta il passo che ha interrotto la storia. Se un run non
è stato proprio eseguito (sessione interrotta), la riga lo dice («run non
eseguiti»). La durata media considera solo i run che hanno eseguito passi dello
scenario.

Sotto la tabella, **«Difetti del motore»** riporta per ogni scenario fallito
una riga con il punto del codice coinvolto (modulo `defects.py`): la suite gira
con modelli locali e cloud, e **un fallimento con il modello locale è un difetto
del motore da correggere**, non una debolezza del modello. Quando il punto del
codice non è noto, la riga lo dice. Poi «Fallimenti» elenca scenario, run,
**passo**, `code`, `reason` ed estratto della risposta (senza dati sensibili).

I rapporti si committano: sono la storia della misura.

### Il banco fa solo le chiamate che fa l'interfaccia

Ogni scenario usa **esclusivamente** le chiamate HTTP che la UI fa per lo
stesso gesto della persona: il banco non sceglie nulla che la UI non sappia
scegliere. In particolare, dopo la conferma di un accordo, il lavoro parte
con `POST …/works/{id}/start` (la modalità predefinita della UI, «Con
guardrail») e si legge con `GET …/works/{id}/execution`, come la scheda in
chat: è il motore a scegliere l'esecutore (sintesi, lettura, confronto, run
adattivo) e i materiali del progetto. Se uno scenario ha bisogno di una
chiamata nuova, prima la deve fare la UI.

Il motivo è un difetto vero: il banco segnava il 100% sul percorso B mentre
nell'interfaccia un lavoro confermato non partiva mai, perché dopo la
conferma il banco chiamava da sé le API dell'esecutore giusto e la UI no.

### Regola d'ingresso per il nucleo del motore

D'ora in poi, una modifica al nucleo del motore — modelli, interpretazione,
turni, recupero — si unisce solo se **non peggiora** il rapporto rispetto
all'ultimo committato su `main` (a parità di provider e modello). Confronta
la tabella dei tassi del tuo rapporto con quella dell'ultimo rapporto in
`main` per il medesimo provider; in caso di peggioramento, la modifica va
sistemata prima del merge.

## Struttura

```
e2e_golden/
├── conftest.py         # provider, motori, facciata «golden», scrittura rapporti
├── common.py           # costanti UI/workspace, tempi, scenari, GoldenError, helper
├── harness.py          # configurazione del provider, avvio reale `homun serve`
├── client.py           # client HTTP del percorso d'oro (gli endpoint della UI)
├── reporting.py        # registrazione dei passi e rapporti (md + json)
├── defects.py          # fallimento → difetto del motore e punto del codice
├── fixtures/materials.py  # i due file di prova (.md e .pdf) generati dal test
├── fixtures/empty_model.py # stub OpenAI-compatibile che risponde vuoto (A6)
├── test_chat.py        # A1–A6
├── test_work.py        # B2–B10
├── test_materials.py   # C1–C3
├── test_routines.py    # D1–D3
└── reports/            # rapporti committati (md + json)
```
