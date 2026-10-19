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

# Cloud: connessione OpenAI-compatibile dalle variabili d'ambiente
cd engine && \
  HOMUN_GOLDEN_PROVIDER=cloud \
  HOMUN_GOLDEN_CLOUD_BASE_URL="https://api.openai.com/v1" \
  HOMUN_GOLDEN_CLOUD_MODEL="gpt-4o-mini" \
  HOMUN_GOLDEN_CLOUD_API_KEY="…" \
  .venv/bin/pytest -m golden -q
```

Variabili:

| Variabile                     | Significato                          | Predefinito            |
| ----------------------------- | ------------------------------------ | ---------------------- |
| `HOMUN_GOLDEN_PROVIDER`       | `local` (Ollama) oppure `cloud`      | obbligatorio           |
| `HOMUN_GOLDEN_LOCAL_MODEL`    | modello Ollama da usare              | `qwen3.5:4b`           |
| `HOMUN_GOLDEN_CLOUD_BASE_URL` | endpoint OpenAI-compatibile          | obbligatorio per cloud |
| `HOMUN_GOLDEN_CLOUD_MODEL`    | modello cloud                        | obbligatorio per cloud |
| `HOMUN_GOLDEN_CLOUD_API_KEY`  | chiave (mai nei log né nei rapporti) | obbligatorio per cloud |
| `HOMUN_GOLDEN_RUNS`           | ripetizioni per scenario             | `3`                    |

Se il provider scelto non è raggiungibile (Ollama spento, modello mancante,
endpoint cloud irraggiungibile) la sessione **si salta** con un messaggio
chiaro: non è un fallimento.

La chiave cloud viaggia solo nella richiesta HTTP verso il motore, che la
conserva nel suo archivio segreti dentro la data dir temporanea della
sessione, distrutta a fine esecuzione. Non viene mai scritta dalla suite,
nei log o nei rapporti.

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

| Scenario | Cosa misura                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------- |
| M0       | La connessione modello si configura e si verifica (Impostazioni → Modelli)                        |
| A1       | Una domanda semplice («Cosa sai fare?») riceve risposta in chat e non crea lavori                 |
| A2       | Tre messaggi di fila nella stessa conversazione: tutti accettati, nell'ordine giusto              |
| A3       | Dopo un errore provocato (connessione modello rotta) il messaggio successivo è accettato          |
| A4       | La conversazione si ritrova nell'elenco e si riprende dopo il riavvio del motore                  |
| B1       | La richiesta operativa (nota «Rossi / 30 novembre / 12.000») produce la proposta di lavoro        |
| B2       | La conferma della proposta porta il lavoro in esecuzione fino al risultato                        |
| B3       | Il risultato contiene i fatti dati e non ne inventa altri                                         |
| B4       | Una correzione motivata produce una nuova versione del risultato                                  |
| B5       | Il lavoro sta fra i Compiti e il risultato approvato fra i Documenti                              |
| C1       | Un progetto con 2 file di prova (`.md` e `.pdf` generati in `fixtures/`) diventa leggibile        |
| C2       | «Trova scadenze e responsabili nei materiali»: il risultato cita i contenuti veri dei file        |
| C3       | Il riassunto di un file ne presenta i punti chiave                                                |
| D1       | «Ogni lunedì alle 9»: la routine si salva con la pianificazione giusta (`0 9 * * 1`, Europe/Rome) |
| D2       | L'esecuzione della routine produce il suo lavoro ricorrente supervisionato                        |
| D3       | Dopo il riavvio del motore la routine esiste ancora ed è attiva                                   |

Precisazioni oneste:

- **B4** passa quando la correzione produce una **nuova versione**; se il
  modello recepisce davvero la motivazione («sezione Rischi») si vede
  nell'estratto del rapporto, ma non è criterio di fallimento.
- **D2**: non esiste un endpoint «esegui ora» per le routine (né in UI né in
  API). L'esecuzione forzata usa una routine con cadenza al minuto e attende
  l'occorrenza reale dello scheduler del motore. L'occorrenza crea un lavoro
  supervisionato con le fasi del modello: quello è il risultato della
  routine, come da guida d'uso.
- **A3**: dopo l'errore la conversazione può restare occupata per la
  finestra di retry del motore (~40-60 s): la suite aspetta quella finestra
  prima di dichiarare la conversazione bloccata.

## Come si legge il rapporto

A fine sessione la suite scrive in `reports/`:

- `<data>-<provider>.md` — il rapporto leggibile;
- `<data>-<provider>.json` — gli stessi dati in forma strutturata.

Ogni riga della tabella è uno scenario: **successo N/M**, tentati, durata
media. Sotto, ogni fallimento riporta lo scenario, il run, il **passo** in
cui è fallito, il `code` e il `reason` dell'errore e un estratto della
risposta (senza dati sensibili). «Non tentato» significa che la storia si è
interrotta prima: per quello scenario il run non è riuscito.

I rapporti si committano: sono la storia della misura.

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
├── harness.py          # avvio `homun serve`, client HTTP del percorso d'oro
├── reporting.py        # registrazione dei passi e rapporti (md + json)
├── fixtures/materials.py  # i due file di prova (.md e .pdf) generati dal test
├── test_chat.py        # A1–A4
├── test_work.py        # B1–B5
├── test_materials.py   # C1–C3
├── test_routines.py    # D1–D3
└── reports/            # rapporti committati (md + json)
```
