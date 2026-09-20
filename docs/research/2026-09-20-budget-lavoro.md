# Budget per lavoro con riserve atomiche — consegna e verifica

**Data:** 20 settembre 2026, tranche successiva a [lettura materiale](2026-09-20-lettura-materiale.md); prima slice del passo D della [specifica di passaggio](../handoff/2026-09-19-ripresa-sviluppo-homun.md), con le raffinature della [ricognizione aggiornata](2026-09-20-ricognizione-hermes-altri.md).
**Branch:** `fabio/production-foundations`, working tree con tutta l'implementazione precedente intatta più questa tranche.

## Cosa è stato costruito

1. **Budget persistito per lavoro** (`domain/models.py`: `WorkBudget` con `caps`, `reserved`, `spent`, `unknown`, `pending`; nuova entità `work_budget` nel repository SQLite, creazione pigra al primo uso). Assi: tentativi di modello (cap di default 40) e token input/output (cap opzionali). **L'uso sconosciuto resta sconosciuto**: contatori separati, mai azzerati per convenienza (lezione Hermes confermata).
2. **Riserve atomiche prima della chiamata** (`application/budgets.py`): `reserve` committe in una propria transazione **prima** della chiamata al provider — un crash non può spendere oltre il cap senza traccia; `reconcile` sposta la riserva in `spent` (con token riportati) o in `unknown` (chiamata fallita o uso non riportato); `release` annulla prima della chiamata restituendo la stima; il cap conteggia `spent + unknown + reserved` (conservativo: l'incognito può essere stato speso).
3. **Recupero dei pendini** (`recover_pending`): le riserve più vecchie di 15 minuti di un processo morto vengono caricato come incognito all'avvio (in `runtime_lifespan`), con log del numero.
4. **Comando esplicito `work.set_budget`**: aggiorna i cap con concorrenza ottimistica sulla versione del budget, autorità di scrittura sul lavoro, evento `work.budget_set`. L'esaurimento non si risolve mai da solo: si alza solo con un comando esplicito.
5. **Collegamento all'intake**: `propose` riserva prima della sintesi (esaurimento → proposta duratura `failed`/`budget_exhausted`, distinguibile e recuperabile) e riconcilia con i token riportati dal provider (o come incognito in caso di fallimento); `classify_message` riserva e riconcilia allo stesso modo (esaurimento → HTTP 429 tipizzato `budget_exhausted`). `synthesize`/`classify_request` espongono l'uso tramite `usage_out` opzionale senza rompere i fake dei test.
6. **Lettura**: `GET /works/{id}` include `budget` (caps, reserved, spent, unknown, pendini). Scheda UI: messaggio dedicato per l'esaurimento.

## Prove eseguite (distinte per tipo)

**Deterministici motore** (408 passati, 1 saltato; 8 nuovi in `test_budgets.py`): riserva→riconciliazione persistita con token; esaurimento tipizzato e atomico (due riserve entro cap, terza rifiutata; rilascio che restituisce la stima; incognito che conta nel cap); uso sconosciuto mai azzerato; recupero pendini scaduti come incognito (e idempotente); attore negato non riserva (lavoro in progetto privato); proposta duratura `budget_exhausted` con ripristino via `work.set_budget`; classify con esaurimento; conflitto di versione sul comando. Confine architetturale rispettato (il primo tentativo importava application dal dominio: corretto spostando la creazione nel comando; suite architettura verde).

**Frontend** (160 passati): nessuna regressione; typecheck, build web/prototipo, architettura 0 errori/29 avvisi, `git diff --check` pulito, OpenAPI rigenerata e verificata.

**Modello reale (Qwen3.5:4b, profilo temporaneo):** proposta → budget con **token reali** (`spent: attempts 1, input 2303, output 203`); cap portato a 1 → proposta successiva `failed`/`budget_exhausted` e classify → **HTTP 429** `budget_exhausted`; `work.set_budget` a 5 → flusso ripristinato e secondo tentativo contabilizzato (`attempts 2, input 4929, output 383`). Con il provider locale l'uso è sempre riportato: il percorso incognito è provato dai test deterministici.

**Pacchetto:** bundle ricostruito, **8/8 test desktop** col motore incorporato.

## Build di riferimento

- App: `dist/desktop/2026-09-20T11-21-42-690Z/Homun-darwin-arm64/Homun.app`
- ZIP: `dist/desktop/2026-09-20T11-21-42-690Z/Homun-0.1.0-macos-arm64.zip`
- SHA-256: `cc315b34c68f7dede24f25a86890784900f3fd6cc3bc8f0dd75a35365fa87f72`
- Non firmata e non notarizzata: candidato locale, non una release. Le build precedenti restano come prove storiche.

## Accettazione della slice (dal passaggio) e stato

- «Concorrenza su budget»: riserve in transazioni proprie con controllo `spent+unknown+reserved` (test di sequenza oltre cap).
- «Esaurimento»: tipizzato (`budget_exhausted`, HTTP 429), duraturo sulla proposta intake, mai silente.
- «Cancellazione»: `release` prima della chiamata restituisce la stima (test).
- «Retry/restart»: recovery all'avvio dei pendini scaduti come incognito (test con timestamp invecchiato); replay dei comandi invariato.
- «Usage sconosciuto resta sconosciuto»: contatori `unknown` separati, mai azzerati (test).

## Limiti rimasti

- Il budget copre oggi le chiamate dell'intake (sintesi e classificazione); l'interpretazione dei messaggi e l'estrazione del piano usano ancora il solo ledger in memoria: il collegamento è il passo naturale successivo di D.
- Stima fissa a un tentativo per chiamata: nessuna stima token preventiva (le cap token contano l'uso riconciliato, non prenotato).
- Niente ancora budget distinti per delegati (lezione Hermes: cap propri inferiori) — arriva con la delega operativa.
- Contatori senza assi di cache (il provider locale non li riporta; l'asse esiste nel modello per quando un provider li darà).
- UI: solo il messaggio di esaurimento; il budget non è ancora mostrato nel riepilogo (leggibile via API).
- Restano i limiti storici (contesto autorizzato esteso, delega, skill portabili, cifratura, firma/notarizzazione, i18n UI).

## Riproduzione della prova con modello reale

Ollama `qwen3.5:4b`, `HOMUN_DATA_DIR` temporaneo, `--dev-insecure`: proposta di confronto → `GET /works/{id}` mostra `budget.spent` con token reali; `work.set_budget` con `model_attempts: 1` → nuova proposta/classificazione → `budget_exhausted` duraturo e 429; rialzo del cap → flusso ripristinato. Il profilo reale in `~/Library/Application Support/Homun/engine` non è stato toccato.

## Seguito (D2): interpretazione e piano nel budget

Stessa giornata, incremento successivo: le chiamate di **interpretazione dei messaggi** ed **estrazione del piano** sono ora sotto lo stesso budget per lavoro.

- `application/interpretation.py` avvolge entrambe (`_budgeted_interpret`, `_budgeted_plan_draft`): riserva prima della chiamata — **fuori da ogni transazione di repository**, come richiede il modello di delivery — e riconcilia dopo usando i `UsageAttempt` registrati dal ciclo di retry (tentativi reali, token sommati quando il provider li riporta; uso non riportato → incognito). Una richiesta che diventa proposta di piano consuma due tentativi (interpret + estrazione), una semplice risposta uno. Le conversazioni senza lavoro collegato restano fuori dal budget.
- L'esaurimento sul percorso messaggi è tipizzato (HTTP 429 `budget_exhausted`), il messaggio utente resta committato e il followup **non viene ritentato automaticamente** (`budget_exhausted` aggiunto ai codici non-ritentabili in `command_delivery.fail`): si sblocca solo alzando il cap con `work.set_budget`.

**Prove D2:** 411 test motore passati (3 nuovi: risposta=1 tentativo e proposta di piano=2 attraverso il flusso HTTP reale; esaurimento 429 con messaggio conservato e recupero dopo rialzo; estrazione piano riservata), 160 frontend, OpenAPI/architettura/typecheck verdi. Modello reale: messaggio in conversazione di lavoro → budget con token reali (`input 440, output 114`); cap a 1 → messaggio successivo 429 tipizzato. Pacchetto: 8/8 test desktop; build `dist/desktop/2026-09-20T11-35-55-128Z/`, SHA-256 `b2bf88713fe5615936bd590c92bfcc08d7d5d7f2b786b0f2eed28cfd83d0e106`.

**Limiti D2:** l'interpretazione riconcilia i tentativi registrati dal ciclo di retry del registro in memoria — un ritento può superare la stima prenotata di un'unità (documentato); i token di cache restano non tracciati (il provider locale non li riporta). Il budget copre ora intake, interpretazione e piano; restano fuori le chiamate di stream presentazionale (`stream_known_text`, nessun costo aggiuntivo).
